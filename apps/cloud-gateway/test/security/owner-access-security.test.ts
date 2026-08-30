import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayBinding, type Ulid } from "../../../../packages/contracts/src/index.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { GuestPinVerifier } from "../../src/security/guest-pin-verifier.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import { OwnerAccessService } from "../../src/voice/owner-access-service.js";
import { VoiceAccessAuthorityService } from "../../src/voice/voice-access-authority.js";
import {
  clearVoiceAccessFixture,
  NOW,
  OWNER_IDENTITY_ID,
  OWNER_PRINCIPAL_ID,
  OWNER_SESSION_ID,
  seedOwnerAuthority,
} from "../persistence/voice-access-fixture.js";

const GUEST_E164 = "+14165550111";
const OTHER_OWNER_SESSION_ID = "01k3w1t4000000000000000750" as Ulid;

function ownerBinding(marker = "5"): RelayBinding {
  return Object.freeze({
    callSid: `CA${marker.repeat(32)}`,
    principalId: OWNER_PRINCIPAL_ID,
    identityId: OWNER_IDENTITY_ID,
    destinationIdentityId: OWNER_IDENTITY_ID,
    relayNonce: `${marker.repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
  });
}

async function mintOtherOwnerAuthority(authorities: VoiceAccessAuthorityService) {
  const binding = ownerBinding("6");
  const now = NOW.toISOString();
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?,
    'owner', NULL, NULL, NULL)`)
    .bind(
      OTHER_OWNER_SESSION_ID,
      binding.callSid,
      OWNER_PRINCIPAL_ID,
      OWNER_IDENTITY_ID,
      OWNER_IDENTITY_ID,
      binding.relayNonce,
      "2026-08-30T12:05:00.000Z",
      "2026-08-30T12:05:00.000Z",
      now,
      now,
    ).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(now, OTHER_OWNER_SESSION_ID).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(now, OTHER_OWNER_SESSION_ID).run();
  return authorities.mintOwner({ sessionId: OTHER_OWNER_SESSION_ID, binding, now: NOW });
}

function idFactory(): (now: Date) => Ulid {
  let value = 700;
  return () => `01k3w1t4000000000000000${value++}` as Ulid;
}

describe("owner access security", () => {
  let repository: VoiceAccessRepository;
  let registry: CapabilityRegistry;
  let authorities: VoiceAccessAuthorityService;
  let ownerAuthority: Awaited<ReturnType<VoiceAccessAuthorityService["mintOwner"]>>;
  let service: OwnerAccessService;

  beforeEach(async () => {
    await clearVoiceAccessFixture(env.DB);
    await seedOwnerAuthority(env.DB);
    repository = new VoiceAccessRepository(env.DB);
    registry = new CapabilityRegistry({
      installed: ["conversation.basic", "research.web", "access.manage"],
    });
    authorities = new VoiceAccessAuthorityService(repository, registry);
    ownerAuthority = await authorities.mintOwner({
      sessionId: OWNER_SESSION_ID,
      binding: ownerBinding(),
      now: NOW,
    });
    service = new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier: new GuestPinVerifier(new Uint8Array(32).fill(8), () => new Uint8Array(16).fill(4)),
      idFactory: idFactory(),
      proposalIdFactory: () => `owner-access-proposal:${crypto.randomUUID()}`,
      defaultGuestPin: () => "2468",
    });
  });

  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("rejects constructor dependency accessors without invoking them", () => {
    let calls = 0;
    const dependencies: Record<string, unknown> = {
      registry,
      authorities,
      verifier: new GuestPinVerifier(new Uint8Array(32).fill(11), () => new Uint8Array(16).fill(7)),
      idFactory: idFactory(),
      proposalIdFactory: () => "owner-access-proposal:accessor",
      defaultGuestPin: () => "2468",
    };
    Object.defineProperty(dependencies, "repository", {
      enumerable: true,
      get() {
        calls += 1;
        return repository;
      },
    });

    expect(() => new OwnerAccessService(dependencies as never)).toThrow("owner_access_input_invalid");
    expect(calls).toBe(0);
  });

  it("requires the exact same-session issued proposal and rejects replay and the expiry boundary", async () => {
    const proposal = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: NOW,
    });

    await expect(service.execute({
      proposal: { ...proposal },
      ownerAuthority,
      pinSelection: { kind: "default" },
      now: NOW,
    })).rejects.toThrow("owner_access_proposal_invalid");
    await expect(service.execute({
      proposal,
      ownerAuthority: { ...ownerAuthority },
      pinSelection: { kind: "default" },
      now: NOW,
    })).rejects.toThrow("owner_access_authority_invalid");
    await expect(service.execute({
      proposal,
      ownerAuthority,
      pinSelection: { kind: "default" },
      now: new Date(NOW.valueOf() + 60_000),
    })).rejects.toThrow("owner_access_proposal_expired");

    const current = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "list" },
      now: new Date(NOW.valueOf() + 1),
    });
    await expect(service.execute({
      proposal: current,
      ownerAuthority,
      pinSelection: null,
      now: new Date(NOW.valueOf() + 2),
    })).resolves.toMatchObject({ outcome: "listed" });
    await expect(service.execute({
      proposal: current,
      ownerAuthority,
      pinSelection: null,
      now: new Date(NOW.valueOf() + 3),
    })).rejects.toThrow("owner_access_proposal_invalid");
  });

  it("invalidates an older same-session proposal and rejects unknown or owner-only permissions", async () => {
    const first = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "list" },
      now: NOW,
    });
    const second = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "list" },
      now: new Date(NOW.valueOf() + 1),
    });
    await expect(service.execute({ proposal: first, ownerAuthority, pinSelection: null, now: NOW }))
      .rejects.toThrow("owner_access_proposal_invalid");
    service.invalidate(second);
    await expect(service.execute({ proposal: second, ownerAuthority, pinSelection: null, now: NOW }))
      .rejects.toThrow("owner_access_proposal_invalid");

    await expect(service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["unknown permission"] },
      now: NOW,
    })).rejects.toThrow("owner_access_permission_invalid");
    await expect(service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["access management"] },
      now: NOW,
    })).rejects.toThrow("owner_access_permission_invalid");
  });

  it("rejects a real authority from another owner session and does not invoke draft accessors", async () => {
    const otherAuthority = await mintOtherOwnerAuthority(authorities);
    await expect(service.prepare({
      ownerAuthority: otherAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "list" },
      now: NOW,
    })).rejects.toThrow("owner_access_authority_invalid");

    let calls = 0;
    const draft = {} as Record<string, unknown>;
    Object.defineProperty(draft, "kind", {
      enumerable: true,
      get() {
        calls += 1;
        return "list";
      },
    });
    await expect(service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: draft as never,
      now: NOW,
    })).rejects.toThrow("owner_access_input_invalid");
    expect(calls).toBe(0);
  });

  it("rejects duplicate and revoked target numbers without exposing the target", async () => {
    const add = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: NOW,
    });
    await service.execute({
      proposal: add,
      ownerAuthority,
      pinSelection: { kind: "default" },
      now: new Date(NOW.valueOf() + 1),
    });
    await expect(service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: new Date(NOW.valueOf() + 2),
    })).rejects.toThrow("owner_access_target_unavailable");

    const revoke = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "revoke", providerE164: GUEST_E164 },
      now: new Date(NOW.valueOf() + 3),
    });
    await service.execute({
      proposal: revoke,
      ownerAuthority,
      pinSelection: null,
      now: new Date(NOW.valueOf() + 4),
    });
    let message = "";
    try {
      await service.prepare({
        ownerAuthority,
        sessionId: OWNER_SESSION_ID,
        draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
        now: new Date(NOW.valueOf() + 5),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("owner_access_target_unavailable");
    expect(message).not.toContain(GUEST_E164);
  });

  it("reads an invalid default binding only during execute and commits no guest", async () => {
    let reads = 0;
    const invalidDefaultService = new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier: new GuestPinVerifier(new Uint8Array(32).fill(9), () => new Uint8Array(16).fill(5)),
      idFactory: idFactory(),
      proposalIdFactory: () => "owner-access-proposal:invalid-default",
      defaultGuestPin: () => {
        reads += 1;
        return "12a4";
      },
    });
    const proposal = await invalidDefaultService.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: NOW,
    });
    expect(reads).toBe(0);
    await expect(invalidDefaultService.execute({
      proposal,
      ownerAuthority,
      pinSelection: { kind: "default" },
      now: new Date(NOW.valueOf() + 1),
    })).rejects.toThrow("owner_access_default_pin_invalid");
    expect(reads).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
  });

  it("maps an injected transaction fault to a fixed error and leaves no PIN, number, grant, or event", async () => {
    const faultRepository = new VoiceAccessRepository(env.DB, {
      beforeEventWrite: () => {
        throw new Error(`storage failed for ${GUEST_E164} with 4827`);
      },
    });
    const faultAuthorities = new VoiceAccessAuthorityService(faultRepository, registry);
    const faultOwner = await faultAuthorities.mintOwner({
      sessionId: OWNER_SESSION_ID,
      binding: ownerBinding(),
      now: NOW,
    });
    const faultService = new OwnerAccessService({
      repository: faultRepository,
      registry,
      authorities: faultAuthorities,
      verifier: new GuestPinVerifier(new Uint8Array(32).fill(10), () => new Uint8Array(16).fill(6)),
      idFactory: idFactory(),
      proposalIdFactory: () => "owner-access-proposal:fault",
      defaultGuestPin: () => "4827",
    });
    const proposal = await faultService.prepare({
      ownerAuthority: faultOwner,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: NOW,
    });
    const digits = Uint8Array.from([52, 56, 50, 55]);
    let message = "";
    try {
      await faultService.execute({
        proposal,
        ownerAuthority: faultOwner,
        pinSelection: { kind: "explicit", digits },
        now: new Date(NOW.valueOf() + 1),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("owner_access_operation_failed");
    expect(message).not.toContain(GUEST_E164);
    expect(message).not.toContain("4827");
    expect(digits).toEqual(Uint8Array.from([0, 0, 0, 0]));
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grant_events").first())
      .toEqual({ count: 0 });
  });

  it("does not leak the direct number or candidate PIN through proposals, results, errors, or JSON", async () => {
    const proposal = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: NOW,
    });
    expect(JSON.stringify(proposal)).not.toContain(GUEST_E164);
    expect(JSON.stringify(proposal)).not.toContain("2468");

    const result = await service.execute({
      proposal,
      ownerAuthority,
      pinSelection: { kind: "default" },
      now: new Date(NOW.valueOf() + 1),
    });
    expect(JSON.stringify(result)).not.toContain(GUEST_E164);
    expect(JSON.stringify(result)).not.toContain("2468");

    const events = await env.DB.prepare("SELECT * FROM voice_access_grant_events").all();
    expect(JSON.stringify(events.results)).not.toContain(GUEST_E164);
    expect(JSON.stringify(events.results)).not.toContain("2468");

    await expect(service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: new Date(NOW.valueOf() + 2),
    })).rejects.not.toThrow(GUEST_E164);
  });
});

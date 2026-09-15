import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUEST_CAPABILITY_IDS,
  type GuestCapabilityId,
  type RelayBinding,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { GuestPinVerifier } from "../../src/security/guest-pin-verifier.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import {
  createTargetGuestAccessDocumentVerifier,
  OwnerAccessService,
  TargetGuestResourceScopeResolver,
} from "../../src/voice/owner-access-service.js";
import { VoiceAccessAuthorityService } from "../../src/voice/voice-access-authority.js";
import type { GuestGrantNoticeSink } from "../../src/voice/guest-grant-notice.js";
import {
  clearVoiceAccessFixture,
  NOW,
  OWNER_IDENTITY_ID,
  OWNER_PRINCIPAL_ID,
  OWNER_SESSION_ID,
  seedOwnerAuthority,
} from "../persistence/voice-access-fixture.js";

const GUEST_E164 = "+14165550111";

function ownerBinding(): RelayBinding {
  return Object.freeze({
    callSid: `CA${"5".repeat(32)}`,
    principalId: OWNER_PRINCIPAL_ID,
    identityId: OWNER_IDENTITY_ID,
    destinationIdentityId: OWNER_IDENTITY_ID,
    relayNonce: `${"5".repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
  });
}

function sequentialIds(): (now: Date) => Ulid {
  let value = 600;
  return () => `01k3w1t4000000000000000${value++}` as Ulid;
}

function sequentialSalts(): () => Uint8Array {
  let value = 3;
  return () => new Uint8Array(16).fill(value++);
}

describe("OwnerAccessService", () => {
  let repository: VoiceAccessRepository;
  let registry: CapabilityRegistry;
  let authorities: VoiceAccessAuthorityService;
  let verifier: GuestPinVerifier;
  let ownerAuthority: Awaited<ReturnType<VoiceAccessAuthorityService["mintOwner"]>>;

  beforeEach(async () => {
    await clearVoiceAccessFixture(env.DB);
    repository = new VoiceAccessRepository(env.DB);
    await seedOwnerAuthority(env.DB, repository, { stepUpVerified: true });
    registry = new CapabilityRegistry({
      installed: ["conversation.basic", "research.web", "calls.place", "access.manage"],
    });
    authorities = new VoiceAccessAuthorityService(repository, registry);
    ownerAuthority = await authorities.mintOwner({
      sessionId: OWNER_SESSION_ID,
      binding: ownerBinding(),
      now: NOW,
    });
    verifier = new GuestPinVerifier(new Uint8Array(32).fill(7), sequentialSalts());
  });

  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("prepares a nominal 60-second proposal and creates a pending guest with an explicit PIN", async () => {
    const service = new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier,
      idFactory: sequentialIds(),
      proposalIdFactory: () => "owner-access-proposal:test-1",
      defaultGuestPin: () => {
        throw new Error("default_pin_read_unexpected");
      },
    });

    const proposal = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: {
        kind: "add",
        providerE164: GUEST_E164,
        permissionPhrases: ["conversation", "web research"],
      },
      now: NOW,
    });

    expect(proposal).toMatchObject({
      proposalId: "owner-access-proposal:test-1",
      sessionId: OWNER_SESSION_ID,
      ownerIdentityId: OWNER_IDENTITY_ID,
      operation: "add",
      capabilityIds: ["conversation.basic", "research.web"],
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
    });
    expect(proposal.maskedTarget).not.toBe(GUEST_E164);
    expect(proposal.maskedTarget).toContain("0111");
    expect(proposal.accessDocumentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.capabilityIds)).toBe(true);

    const digits = Uint8Array.from([52, 56, 50, 55]);
    const result = await service.execute({
      proposal,
      ownerAuthority,
      pinSelection: { kind: "explicit", digits },
      now: new Date(NOW.valueOf() + 1),
    });

    expect(result.outcome).toBe("created");
    expect(result.speech).not.toContain(GUEST_E164);
    expect(result.speech).not.toContain("4827");
    expect(digits).toEqual(Uint8Array.from([0, 0, 0, 0]));
    expect(Object.isFrozen(result)).toBe(true);

    const row = await env.DB.prepare(`SELECT grant_id, status, capability_ids_json
      FROM voice_access_grants WHERE identity_id IN (
        SELECT identity_id FROM channel_identities WHERE provider_subject = ?
      )`).bind(GUEST_E164).first<{ grant_id: string; status: string; capability_ids_json: string }>();
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(JSON.parse(row?.capability_ids_json ?? "null")).toEqual(["conversation.basic", "research.web"]);

    const grant = await repository.getGuestGrant(row?.grant_id ?? "");
    const candidate = Uint8Array.from([52, 56, 50, 55]);
    await expect(verifier.verify(grant?.grantId ?? "", candidate, grant?.pinVerifier as never)).resolves.toBe(true);
    expect(candidate).toEqual(Uint8Array.from([0, 0, 0, 0]));
  });

  it("uses the default PIN only inside execute and supports replace, rotate, list, and revoke", async () => {
    let defaultReads = 0;
    const notify = vi.fn<GuestGrantNoticeSink["notify"]>(async () => undefined);
    const service = new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier,
      idFactory: sequentialIds(),
      proposalIdFactory: () => `owner-access-proposal:${crypto.randomUUID()}`,
      defaultGuestPin: () => {
        defaultReads += 1;
        return "1357";
      },
      notices: { notify },
    });

    const add = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: NOW,
    });
    expect(defaultReads).toBe(0);
    await expect(service.execute({
      proposal: add,
      ownerAuthority,
      pinSelection: { kind: "default" },
      now: new Date(NOW.valueOf() + 1),
    })).resolves.toMatchObject({ outcome: "created" });
    expect(defaultReads).toBe(1);

    const replace = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: {
        kind: "replace_permissions",
        providerE164: GUEST_E164,
        permissionPhrases: ["conversation", "calls"],
      },
      now: new Date(NOW.valueOf() + 2),
    });
    await expect(service.execute({
      proposal: replace,
      ownerAuthority,
      pinSelection: null,
      now: new Date(NOW.valueOf() + 3),
    })).resolves.toMatchObject({ outcome: "changed" });

    const rotate = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "rotate_pin", providerE164: GUEST_E164 },
      now: new Date(NOW.valueOf() + 4),
    });
    const nextPin = Uint8Array.from([57, 55, 51, 49]);
    await expect(service.execute({
      proposal: rotate,
      ownerAuthority,
      pinSelection: { kind: "explicit", digits: nextPin },
      now: new Date(NOW.valueOf() + 5),
    })).resolves.toMatchObject({ outcome: "rotated" });
    expect(nextPin).toEqual(Uint8Array.from([0, 0, 0, 0]));

    const list = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "list" },
      now: new Date(NOW.valueOf() + 6),
    });
    const listed = await service.execute({
      proposal: list,
      ownerAuthority,
      pinSelection: null,
      now: new Date(NOW.valueOf() + 7),
    });
    expect(listed).toMatchObject({ outcome: "listed" });
    expect(listed.speech).not.toContain(GUEST_E164);

    const revoke = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "revoke", providerE164: GUEST_E164 },
      now: new Date(NOW.valueOf() + 8),
    });
    await expect(service.execute({
      proposal: revoke,
      ownerAuthority,
      pinSelection: null,
      now: new Date(NOW.valueOf() + 9),
    })).resolves.toMatchObject({ outcome: "revoked" });

    const stored = await env.DB.prepare("SELECT status, grant_version FROM voice_access_grants")
      .first<{ status: string; grant_version: number }>();
    expect(stored).toEqual({ status: "revoked", grant_version: 4 });
    expect(notify.mock.calls.map(([notice]) => ({
      operation: notice.operation,
      maskedTarget: notice.maskedTarget,
      occurredAt: notice.occurredAt.toISOString(),
    }))).toEqual([
      { operation: "created", maskedTarget: "+1******0111", occurredAt: new Date(NOW.valueOf() + 1).toISOString() },
      { operation: "permissions_changed", maskedTarget: "+1******0111", occurredAt: new Date(NOW.valueOf() + 3).toISOString() },
      { operation: "pin_rotated", maskedTarget: "+1******0111", occurredAt: new Date(NOW.valueOf() + 5).toISOString() },
      { operation: "revoked", maskedTarget: "+1******0111", occurredAt: new Date(NOW.valueOf() + 9).toISOString() },
    ]);
  });

  it("keeps a committed guest mutation and warns the owner when its Telegram notice fails", async () => {
    const service = new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier,
      idFactory: sequentialIds(),
      proposalIdFactory: () => "owner-access-proposal:notice-failure",
      defaultGuestPin: () => "1357",
      notices: { async notify() { throw new Error("telegram_unavailable"); } },
    });
    const proposal = await service.prepare({
      ownerAuthority,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["conversation"] },
      now: NOW,
    });

    const result = await service.execute({
      proposal,
      ownerAuthority,
      pinSelection: { kind: "default" },
      now: new Date(NOW.valueOf() + 1),
    });

    expect(result).toEqual({
      outcome: "created",
      speech: "Caller +1******0111 is allowed. The Telegram notice could not be confirmed.",
    });
    await expect(env.DB.prepare("SELECT status FROM voice_access_grants").first<{ status: string }>())
      .resolves.toEqual({ status: "pending" });
  });

  it("maps every closed guest permission phrase and still rejects owner-only authority", async () => {
    const scopedRegistry = new CapabilityRegistry({
      installed: [...GUEST_CAPABILITY_IDS, "access.manage"],
      calendarConnectionIds: ["calendar:guest-b"],
      fileRootIds: ["file-root:guest-b"],
      pcActionIds: ["pc-action:guest-b"],
    });
    const scopedAuthorities = new VoiceAccessAuthorityService(repository, scopedRegistry);
    const scopedOwner = await scopedAuthorities.mintOwner({
      sessionId: OWNER_SESSION_ID,
      binding: ownerBinding(),
      now: NOW,
    });
    const scopeResolver = new TargetGuestResourceScopeResolver([{
      providerE164: GUEST_E164,
      resourceScopes: {
        schemaVersion: "1.0",
        calendarConnectionIds: ["calendar:guest-b"],
        fileRootIds: ["file-root:guest-b"],
        pcActionIds: ["pc-action:guest-b"],
      },
    }]);
    const service = new OwnerAccessService({
      repository,
      registry: scopedRegistry,
      authorities: scopedAuthorities,
      verifier,
      scopeResolver,
      idFactory: sequentialIds(),
      proposalIdFactory: () => `owner-access-proposal:${crypto.randomUUID()}`,
      defaultGuestPin: () => "1357",
    });
    const cases: readonly (readonly [string, GuestCapabilityId])[] = [
      ["conversation", "conversation.basic"],
      ["web research", "research.web"],
      ["memory", "memory.own"],
      ["reminders", "reminders.manage"],
      ["calendar reading", "calendar.read"],
      ["calendar management", "calendar.manage"],
      ["owner contact", "owner.contact"],
      ["communication drafting", "communications.draft"],
      ["communication sending", "communications.send"],
      ["calls", "calls.place"],
      ["file reading", "files.read"],
      ["file writing", "files.write"],
      ["computer control", "pc.control"],
      ["spending proposals", "spending.propose"],
      ["destructive proposals", "destructive.propose"],
    ];

    for (const [phrase, capability] of cases) {
      const proposal = await service.prepare({
        ownerAuthority: scopedOwner,
        sessionId: OWNER_SESSION_ID,
        draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: [phrase] },
        now: NOW,
      });
      expect(proposal.capabilityIds).toEqual([capability]);
    }
    await expect(service.prepare({
      ownerAuthority: scopedOwner,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["access management"] },
      now: NOW,
    })).rejects.toThrow("owner_access_permission_invalid");
  });

  it("resolves everything only to the exact target guest's owned scopes", async () => {
    const scopedRegistry = new CapabilityRegistry({
      installed: ["conversation.basic", "calendar.read", "files.read", "pc.control", "access.manage"],
      calendarConnectionIds: ["calendar:owner", "calendar:guest-a", "calendar:guest-b"],
      fileRootIds: ["file-root:owner", "file-root:guest-a", "file-root:guest-b"],
      pcActionIds: ["pc-action:owner", "pc-action:guest-a", "pc-action:guest-b"],
    });
    const scopeResolver = new TargetGuestResourceScopeResolver([
      {
        providerE164: "+14165550110",
        resourceScopes: {
          schemaVersion: "1.0",
          calendarConnectionIds: ["calendar:guest-a"],
          fileRootIds: ["file-root:guest-a"],
          pcActionIds: ["pc-action:guest-a"],
        },
      },
      {
        providerE164: GUEST_E164,
        resourceScopes: {
          schemaVersion: "1.0",
          calendarConnectionIds: ["calendar:guest-b"],
          fileRootIds: ["file-root:guest-b"],
          pcActionIds: ["pc-action:guest-b"],
        },
      },
    ]);
    const scopedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(scopedRegistry, scopeResolver),
    });
    const scopedAuthorities = new VoiceAccessAuthorityService(scopedRepository, scopedRegistry);
    const scopedOwner = await scopedAuthorities.mintOwner({
      sessionId: OWNER_SESSION_ID,
      binding: ownerBinding(),
      now: NOW,
    });
    const service = new OwnerAccessService({
      repository: scopedRepository,
      registry: scopedRegistry,
      authorities: scopedAuthorities,
      verifier,
      scopeResolver,
      idFactory: sequentialIds(),
      proposalIdFactory: () => "owner-access-proposal:everything",
      defaultGuestPin: () => "1357",
    });

    for (const foreignFileRootId of ["file-root:owner", "file-root:guest-a"]) {
      await expect(service.prepare({
        ownerAuthority: scopedOwner,
        sessionId: OWNER_SESSION_ID,
        draft: {
          kind: "add",
          providerE164: GUEST_E164,
          permissionPhrases: ["file reading"],
          resourceScopes: {
            schemaVersion: "1.0",
            calendarConnectionIds: [],
            fileRootIds: [foreignFileRootId],
            pcActionIds: [],
          },
        },
        now: NOW,
      })).rejects.toThrow("owner_access_permission_invalid");
    }

    const proposal = await service.prepare({
      ownerAuthority: scopedOwner,
      sessionId: OWNER_SESSION_ID,
      draft: { kind: "add", providerE164: GUEST_E164, permissionPhrases: ["everything"] },
      now: NOW,
    });
    expect(proposal.capabilityIds).toEqual([
      "conversation.basic",
      "calendar.read",
      "files.read",
      "pc.control",
    ]);

    await service.execute({
      proposal,
      ownerAuthority: scopedOwner,
      pinSelection: { kind: "default" },
      now: new Date(NOW.valueOf() + 1),
    });
    const row = await env.DB.prepare("SELECT resource_scopes_json FROM voice_access_grants")
      .first<{ resource_scopes_json: string }>();
    expect(JSON.parse(row?.resource_scopes_json ?? "null")).toEqual({
      schemaVersion: "1.0",
      calendarConnectionIds: ["calendar:guest-b"],
      fileRootIds: ["file-root:guest-b"],
      pcActionIds: ["pc-action:guest-b"],
    });
    expect(JSON.stringify(row)).not.toMatch(/owner|guest-a/u);
  });
});

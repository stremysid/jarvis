import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestCapabilityId, RelayBinding, Ulid } from "../../../../packages/contracts/src/index.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { GuestPinVerifier } from "../../src/security/guest-pin-verifier.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import { OwnerAccessService } from "../../src/voice/owner-access-service.js";
import { OWNER_ACCESS_PIN_PROMPT, OwnerAccessTool } from "../../src/voice/owner-access-tool.js";
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
  let value = 900;
  return () => `01k3w1t4000000000000000${value++}` as Ulid;
}

describe("OwnerAccessTool", () => {
  let repository: VoiceAccessRepository;
  let registry: CapabilityRegistry;
  let authorities: VoiceAccessAuthorityService;
  let verifier: GuestPinVerifier;
  let ownerAuthority: Awaited<ReturnType<VoiceAccessAuthorityService["mintOwner"]>>;
  let tool: OwnerAccessTool;
  let speak: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  let pinQuestionOpened: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    await clearVoiceAccessFixture(env.DB);
    repository = new VoiceAccessRepository(env.DB);
    await seedOwnerAuthority(env.DB, repository);
    registry = new CapabilityRegistry({ installed: ["conversation.basic", "calls.place", "access.manage"] });
    authorities = new VoiceAccessAuthorityService(repository, registry);
    ownerAuthority = await authorities.mintOwner({
      sessionId: OWNER_SESSION_ID,
      binding: ownerBinding(),
      now: NOW,
    });
    verifier = new GuestPinVerifier(new Uint8Array(32).fill(7), () => new Uint8Array(16).fill(3));
    tool = new OwnerAccessTool(new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier,
      idFactory: sequentialIds(),
      proposalIdFactory: () => `owner-access-proposal:${crypto.randomUUID()}`,
      defaultGuestPin: () => "1357",
    }), () => new Date(NOW));
    speak = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    pinQuestionOpened = vi.fn<() => void>();
    tool.attachSession({
      sessionId: OWNER_SESSION_ID,
      ownerAuthority: () => ownerAuthority,
      speak,
      pinQuestionOpened,
    });
  });

  afterEach(() => clearVoiceAccessFixture(env.DB));

  async function grantRow() {
    return env.DB.prepare(`SELECT grant_row.status, grant_row.capability_ids_json
      FROM voice_access_grants grant_row
      JOIN channel_identities identity ON identity.identity_id = grant_row.identity_id
      WHERE identity.provider_subject = ?`).bind(GUEST_E164)
      .first<{ status: string; capability_ids_json: string }>();
  }

  it("adds a caller with the default PIN and returns a structured receipt, speaking nothing", async () => {
    const result = await tool.run({
      operation: "add",
      providerE164: GUEST_E164,
      capabilityIds: ["conversation.basic"],
      pin: "default",
    });

    expect(result).toMatchObject({
      outcome: "created",
      operation: "add",
      maskedTarget: "+1******0111",
      noticeUnconfirmed: false,
    });
    expect(JSON.stringify(result)).not.toContain(GUEST_E164);
    expect(JSON.stringify(result)).not.toContain("1357");
    // Code speaks no sentence of its own for a default-PIN add: the model does.
    expect(speak).not.toHaveBeenCalled();
    expect(await grantRow()).toEqual({ status: "pending", capability_ids_json: '["conversation.basic"]' });
  });

  it("asks the call for four digits only when the model chose pin digits", async () => {
    const run = tool.run({
      operation: "add",
      providerE164: GUEST_E164,
      capabilityIds: ["conversation.basic"],
      pin: "digits",
    });
    await vi.waitFor(() => expect(speak).toHaveBeenCalledWith(OWNER_ACCESS_PIN_PROMPT));
    expect(tool.hasPendingPin()).toBe(true);
    expect(pinQuestionOpened).toHaveBeenCalledOnce();

    await tool.submitPinKeypad(Uint8Array.from([50, 52, 54, 56]));

    await expect(run).resolves.toMatchObject({ outcome: "created", operation: "add" });
    expect(tool.hasPendingPin()).toBe(false);
    const grant = await grantRow();
    expect(grant?.status).toBe("pending");
  });

  it("re-prompts an utterance that is not four digits instead of treating it as a choice", async () => {
    const run = tool.run({
      operation: "add",
      providerE164: GUEST_E164,
      capabilityIds: ["conversation.basic"],
      pin: "digits",
    });
    await vi.waitFor(() => expect(speak).toHaveBeenCalledWith(OWNER_ACCESS_PIN_PROMPT));

    // "use the default" was the removed exact-string choice; it is just words now.
    await tool.submitPinSpoken("use the default");
    expect(tool.hasPendingPin()).toBe(true);
    expect(speak).toHaveBeenLastCalledWith(expect.stringContaining("did not catch four digits"));

    await tool.submitPinSpoken("2468");
    await expect(run).resolves.toMatchObject({ outcome: "created" });
  });

  it("refuses an owner-only capability id instead of granting it", async () => {
    await expect(tool.run({
      operation: "add",
      providerE164: GUEST_E164,
      capabilityIds: ["access.manage" as GuestCapabilityId],
      pin: "default",
    })).rejects.toThrow("owner_access_permission_invalid");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
  });

  it("lists allowed callers as structured data the model speaks itself", async () => {
    await tool.run({
      operation: "add",
      providerE164: GUEST_E164,
      capabilityIds: ["conversation.basic"],
      pin: "default",
    });

    const result = await tool.run({
      operation: "list",
      providerE164: null,
      capabilityIds: [],
      pin: "default",
    });
    expect(result).toMatchObject({ outcome: "listed", operation: "list", maskedTarget: null });
    expect(result.guests).toEqual([
      { maskedNumber: "+1******0111", status: "pending", capabilityIds: ["conversation.basic"] },
    ]);
    expect(speak).not.toHaveBeenCalled();
  });

  it("revokes and replaces without a PIN question", async () => {
    await tool.run({
      operation: "add",
      providerE164: GUEST_E164,
      capabilityIds: ["conversation.basic"],
      pin: "default",
    });
    await expect(tool.run({
      operation: "replace_permissions",
      providerE164: GUEST_E164,
      capabilityIds: ["conversation.basic", "calls.place"],
      pin: "default",
    })).resolves.toMatchObject({ outcome: "changed", operation: "replace_permissions" });
    await expect(tool.run({
      operation: "revoke",
      providerE164: GUEST_E164,
      capabilityIds: [],
      pin: "default",
    })).resolves.toMatchObject({ outcome: "revoked", operation: "revoke" });
    expect(await grantRow()).toMatchObject({ status: "revoked" });
    expect(speak).not.toHaveBeenCalled();
  });

  it("abandons the change when the PIN question is cancelled", async () => {
    const run = tool.run({
      operation: "add",
      providerE164: GUEST_E164,
      capabilityIds: ["conversation.basic"],
      pin: "digits",
    });
    await vi.waitFor(() => expect(tool.hasPendingPin()).toBe(true));
    tool.cancelPendingPin();

    await expect(run).rejects.toThrow("owner_access_pin_required");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
  });

  it("refuses when no call is attached or the call is not the owner's", async () => {
    const detached = new OwnerAccessTool(new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier,
      idFactory: sequentialIds(),
      defaultGuestPin: () => "1357",
    }), () => new Date(NOW));
    await expect(detached.run({
      operation: "list",
      providerE164: null,
      capabilityIds: [],
      pin: "default",
    })).rejects.toThrow("owner_access_unavailable");

    const guestTool = new OwnerAccessTool(new OwnerAccessService({
      repository,
      registry,
      authorities,
      verifier,
      idFactory: sequentialIds(),
      defaultGuestPin: () => "1357",
    }), () => new Date(NOW));
    guestTool.attachSession({
      sessionId: OWNER_SESSION_ID,
      ownerAuthority: () => null,
      speak,
    });
    await expect(guestTool.run({
      operation: "list",
      providerE164: null,
      capabilityIds: [],
      pin: "default",
    })).rejects.toThrow("owner_access_authority_invalid");
  });
});

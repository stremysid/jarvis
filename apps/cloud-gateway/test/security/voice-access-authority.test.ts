import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayBinding, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import {
  GuestPinProofIssuer,
  VoiceAccessAuthorityService,
} from "../../src/voice/voice-access-authority.js";
import {
  clearVoiceAccessFixture,
  DOCUMENT_HASH,
  EMPTY_SCOPES,
  GRANT_ID,
  GUEST_IDENTITY_ID,
  GUEST_PRINCIPAL_ID,
  NOW,
  OWNER_IDENTITY_ID,
  OWNER_PRINCIPAL_ID,
  seedOwnerAuthority,
  validCreateInput,
} from "../persistence/voice-access-fixture.js";

const OWNER_RUNTIME_SESSION = "01k3w1t4000000000000000530" as Ulid;
const GUEST_RUNTIME_SESSION = "01k3w1t4000000000000000531" as Ulid;
const SECOND_GUEST_SESSION = "01k3w1t4000000000000000532" as Ulid;

function ownerBinding(): RelayBinding {
  return Object.freeze({
    callSid: `CA${"8".repeat(32)}`,
    principalId: OWNER_PRINCIPAL_ID,
    identityId: OWNER_IDENTITY_ID,
    destinationIdentityId: OWNER_IDENTITY_ID,
    relayNonce: `${"8".repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
  });
}

function guestBinding(session: "first" | "second" = "first"): RelayBinding {
  const marker = session === "first" ? "9" : "a";
  return Object.freeze({
    callSid: `CA${marker.repeat(32)}`,
    principalId: GUEST_PRINCIPAL_ID,
    identityId: GUEST_IDENTITY_ID,
    destinationIdentityId: GUEST_IDENTITY_ID,
    relayNonce: `${marker.repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "guest",
    guestGrantId: GRANT_ID,
    guestGrantVersion: 1,
    accessDocumentHash: DOCUMENT_HASH,
  });
}

async function seedPreAuthSession(sessionId: Ulid, value: RelayBinding): Promise<void> {
  const now = NOW.toISOString();
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?, ?, ?, ?, ?)`)
    .bind(
      sessionId, value.callSid, value.principalId, value.identityId, value.destinationIdentityId,
      value.relayNonce, "2026-08-30T12:05:00.000Z", "2026-08-30T12:05:00.000Z",
      now, now, value.accessKind, value.guestGrantId, value.guestGrantVersion, value.accessDocumentHash,
    ).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(now, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(now, sessionId).run();
}

describe("VoiceAccessAuthorityService", () => {
  let repository: VoiceAccessRepository;
  let registry: CapabilityRegistry;
  let proofs: GuestPinProofIssuer;
  let service: VoiceAccessAuthorityService;

  beforeEach(async () => {
    await clearVoiceAccessFixture(env.DB);
    repository = new VoiceAccessRepository(env.DB);
    registry = new CapabilityRegistry({ installed: ["conversation.basic", "research.web", "access.manage"] });
    proofs = new GuestPinProofIssuer();
    service = new VoiceAccessAuthorityService(repository, registry, proofs);
  });

  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("rejects structural, stale, expired, and explicitly invalidated owner authority", async () => {
    await seedOwnerAuthority(env.DB);
    const relayBinding = ownerBinding();
    await seedPreAuthSession(OWNER_RUNTIME_SESSION, relayBinding);
    const owner = await service.mintOwner({ sessionId: OWNER_RUNTIME_SESSION, binding: relayBinding, now: NOW });

    expect(() => service.snapshot({ ...owner })).toThrow("call_authority_invalid");
    await expect(service.authorize(owner, "conversation.basic", NOW)).resolves.toBe(owner);
    await expect(service.authorize(owner, "access.manage", NOW)).resolves.toBe(owner);
    await expect(service.authorize(owner, "conversation.basic", new Date(NOW.valueOf() + 1_800_000)))
      .rejects.toThrow("call_authority_expired");

    service.invalidate(owner);
    await expect(service.authorize(owner, "conversation.basic", NOW)).rejects.toThrow("call_authority_invalid");
  });

  it("requires a nominal same-session PIN proof and denies absent or owner-only guest capabilities", async () => {
    const ownerAuthority = await seedOwnerAuthority(env.DB);
    await repository.createGuestGrant(validCreateInput(ownerAuthority));
    const now = NOW.toISOString();
    await env.DB.prepare(`UPDATE voice_access_grants SET status = 'active', activated_at = ?, updated_at = ?
      WHERE grant_id = ?`).bind(now, now, GRANT_ID).run();
    await env.DB.prepare("UPDATE channel_identities SET status = 'active', verified_at = ? WHERE identity_id = ?")
      .bind(now, GUEST_IDENTITY_ID).run();
    const firstBinding = guestBinding();
    const secondBinding = guestBinding("second");
    await seedPreAuthSession(GUEST_RUNTIME_SESSION, firstBinding);
    await seedPreAuthSession(SECOND_GUEST_SESSION, secondBinding);
    const proof = proofs.issue({
      sessionId: GUEST_RUNTIME_SESSION,
      callSid: firstBinding.callSid,
      relayNonce: firstBinding.relayNonce,
      direction: firstBinding.direction,
      principalId: firstBinding.principalId,
      identityId: firstBinding.identityId,
      grantId: GRANT_ID,
      grantVersion: 1,
      accessDocumentHash: DOCUMENT_HASH,
      authenticatedAt: NOW,
    });

    await expect(service.mintGuest({
      sessionId: SECOND_GUEST_SESSION,
      binding: secondBinding,
      pinProof: proof,
      now: NOW,
    })).rejects.toThrow("guest_pin_authentication_proof_invalid");
    await expect(service.mintGuest({
      sessionId: GUEST_RUNTIME_SESSION,
      binding: firstBinding,
      pinProof: { ...proof },
      now: NOW,
    })).rejects.toThrow("guest_pin_authentication_proof_invalid");

    const guest = await service.mintGuest({
      sessionId: GUEST_RUNTIME_SESSION,
      binding: firstBinding,
      pinProof: proof,
      now: NOW,
    });
    await expect(service.authorize(guest, "conversation.basic", NOW)).resolves.toBe(guest);
    await expect(service.authorize(guest, "research.web", NOW)).rejects.toThrow("capability_denied");
    await expect(service.authorize(guest, "access.manage", NOW)).rejects.toThrow("capability_not_grantable");

    await repository.replacePermissions({
      mutationId: "01k3w1t4000000000000000533" as Ulid,
      requestHash: "4".repeat(64) as Sha256Hex,
      ownerAuthority,
      ownerIdentityId: OWNER_IDENTITY_ID,
      grantId: GRANT_ID,
      expectedGrantVersion: 1,
      capabilityIds: ["conversation.basic", "research.web"],
      resourceScopes: EMPTY_SCOPES,
      accessDocumentHash: "5".repeat(64) as Sha256Hex,
      now: NOW,
    });
    await expect(service.authorize(guest, "conversation.basic", NOW)).rejects.toThrow("call_authority_stale");
  });
});

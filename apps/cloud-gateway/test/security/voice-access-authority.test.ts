import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RelayBinding, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import {
  createTargetGuestAccessDocumentVerifier,
  TargetGuestResourceScopeResolver,
} from "../../src/voice/owner-access-service.js";
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
  REPLACED_DOCUMENT_HASH,
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
  await env.DB.prepare(`UPDATE call_sessions
    SET provider_session_id = ?, provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
    .bind(`VX${value.callSid.slice(2)}`, now, now, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(now, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(now, sessionId).run();
  if (value.accessKind === "owner") {
    await env.DB.prepare(`INSERT INTO owner_call_step_up_bindings (
      session_id, call_sid, owner_principal_id, owner_identity_id, direction,
      lifecycle_generation, requirement, attestation_class, policy, created_at
    ) VALUES (?, ?, ?, ?, 'inbound', 1, 'waived_passed_a', 'passed_a', 'waive_on_passed_a', ?)`)
      .bind(sessionId, value.callSid, value.principalId, value.identityId, now)
      .run();
  }
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

  it("refuses an inactive current-grant read independently of version or document drift", async () => {
    let inactiveRead = false;
    let substitutedReads = 0;
    // Fault the repository's read boundary only. Normal SQL revocation also
    // bumps the version; keep the migration intact and isolate this guard.
    const database = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (inactiveRead && sql.includes("current_grant.status AS current_grant_status")) {
          substitutedReads += 1;
          return target.prepare(sql.replace("current_grant.status AS current_grant_status", "'revoked' AS current_grant_status"));
        }
        return target.prepare(sql);
      };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    repository = new VoiceAccessRepository(database);
    service = new VoiceAccessAuthorityService(repository, registry, proofs);
    const owner = await seedOwnerAuthority(env.DB, repository);
    await repository.createGuestGrant(validCreateInput(owner));
    const binding = guestBinding();
    await seedPreAuthSession(GUEST_RUNTIME_SESSION, binding);
    const proof = proofs.issue({ sessionId: GUEST_RUNTIME_SESSION, callSid: binding.callSid,
      relayNonce: binding.relayNonce, direction: binding.direction, principalId: binding.principalId,
      identityId: binding.identityId, grantId: GRANT_ID, grantVersion: 1,
      accessDocumentHash: DOCUMENT_HASH, authenticatedAt: NOW });
    const guest = await service.mintGuest({ sessionId: GUEST_RUNTIME_SESSION, binding, pinProof: proof, now: NOW });
    await expect(service.authorize(guest, "conversation.basic", NOW)).resolves.toBe(guest);
    inactiveRead = true;
    await expect(service.authorize(guest, "conversation.basic", NOW)).rejects.toThrow("call_authority_stale");
    expect(substitutedReads).toBe(1);
    await expect(env.DB.prepare("SELECT status, grant_version, access_document_hash FROM voice_access_grants WHERE grant_id = ?")
      .bind(GRANT_ID).first()).resolves.toEqual({ status: "active", grant_version: 1, access_document_hash: DOCUMENT_HASH });
  });

  it("rejects structural, stale, expired, and explicitly invalidated owner authority", async () => {
    await seedOwnerAuthority(env.DB, repository);
    const relayBinding = ownerBinding();
    await seedPreAuthSession(OWNER_RUNTIME_SESSION, relayBinding);
    const owner = await service.mintOwner({ sessionId: OWNER_RUNTIME_SESSION, binding: relayBinding, now: NOW });

    expect(() => service.snapshot({ ...owner })).toThrow("call_authority_invalid");
    await expect(service.authorize(owner, "conversation.basic", NOW)).resolves.toBe(owner);
    await expect(service.authorize(owner, "access.manage", NOW)).rejects.toThrow("owner_step_up_required");
    await expect(service.mintOwner({
      sessionId: OWNER_RUNTIME_SESSION,
      binding: Object.freeze({ ...relayBinding, relayNonce: `${"9".repeat(42)}A` }),
      now: NOW,
    })).rejects.toThrow("call_authority_invalid");
    await expect(service.authorize(owner, "conversation.basic", new Date(NOW.valueOf() + 1_800_000)))
      .rejects.toThrow("call_authority_expired");

    service.invalidate(owner);
    await expect(service.authorize(owner, "conversation.basic", NOW)).rejects.toThrow("call_authority_invalid");
  });

  it("rechecks nominal issuance after durable authorization yields", async () => {
    await seedOwnerAuthority(env.DB, repository);
    const relayBinding = ownerBinding();
    await seedPreAuthSession(OWNER_RUNTIME_SESSION, relayBinding);
    const owner = await service.mintOwner({ sessionId: OWNER_RUNTIME_SESSION, binding: relayBinding, now: NOW });
    const original = repository.requireCurrentAuthority.bind(repository);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(repository, "requireCurrentAuthority").mockImplementation(async (persisted, now) => {
      started();
      await gate;
      return original(persisted, now);
    });

    const pending = service.authorize(owner, "conversation.basic", NOW);
    await entered;
    service.invalidate(owner);
    release();

    await expect(pending).rejects.toThrow("call_authority_invalid");
  });

  it("rehydrates only an exact persisted authority and preserves the first-provider-bind deadline", async () => {
    await seedOwnerAuthority(env.DB, repository);
    const relayBinding = ownerBinding();
    await seedPreAuthSession(OWNER_RUNTIME_SESSION, relayBinding);
    const owner = await service.mintOwner({ sessionId: OWNER_RUNTIME_SESSION, binding: relayBinding, now: NOW });
    expect(owner.expiresAt).toBe("2026-08-30T12:30:00.000Z");

    const restartedRepository = new VoiceAccessRepository(env.DB);
    const restarted = new VoiceAccessAuthorityService(restartedRepository, registry, new GuestPinProofIssuer());
    const beforeDeadline = new Date("2026-08-30T12:29:59.999Z");
    const rehydrated = await restarted.rehydrate({
      sessionId: OWNER_RUNTIME_SESSION,
      binding: relayBinding,
      now: beforeDeadline,
    });
    expect(rehydrated).toMatchObject({ kind: "owner", sessionId: OWNER_RUNTIME_SESSION, expiresAt: owner.expiresAt });
    await expect(restarted.authorize(rehydrated, "conversation.basic", beforeDeadline)).resolves.toBe(rehydrated);
    await expect(restarted.rehydrate({
      sessionId: OWNER_RUNTIME_SESSION,
      binding: { ...relayBinding, relayNonce: `${"7".repeat(42)}A` },
      now: beforeDeadline,
    })).rejects.toThrow("call_authority_invalid");
    await expect(restarted.rehydrate({
      sessionId: OWNER_RUNTIME_SESSION,
      binding: relayBinding,
      now: new Date("2026-08-30T12:30:00.000Z"),
    })).rejects.toThrow("call_authority_expired");
  });

  it("requires a nominal same-session PIN proof and denies absent or owner-only guest capabilities", async () => {
    const ownerAuthority = await seedOwnerAuthority(env.DB, repository);
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
    const driftedBinding = Object.freeze({ ...firstBinding, relayNonce: `${"8".repeat(42)}A` });
    const driftedProof = proofs.issue({
      sessionId: GUEST_RUNTIME_SESSION,
      callSid: driftedBinding.callSid,
      relayNonce: driftedBinding.relayNonce,
      direction: driftedBinding.direction,
      principalId: driftedBinding.principalId,
      identityId: driftedBinding.identityId,
      grantId: GRANT_ID,
      grantVersion: 1,
      accessDocumentHash: DOCUMENT_HASH,
      authenticatedAt: NOW,
    });
    await expect(service.mintGuest({
      sessionId: GUEST_RUNTIME_SESSION,
      binding: driftedBinding,
      pinProof: driftedProof,
      now: NOW,
    })).rejects.toThrow("call_authority_invalid");
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
      accessDocumentHash: REPLACED_DOCUMENT_HASH,
      now: NOW,
    });
    await expect(service.authorize(guest, "conversation.basic", NOW)).rejects.toThrow("call_authority_stale");
  });

  it("uses the same target-owned registry snapshot for scoped guest mint and restart rehydration", async () => {
    const scopedRegistry = new CapabilityRegistry({
      installed: ["conversation.basic", "files.read"],
      fileRootIds: ["file-root:guest"],
    });
    const createResolver = () => new TargetGuestResourceScopeResolver([{
      providerE164: "+14165550111",
      resourceScopes: {
        schemaVersion: "1.0",
        calendarConnectionIds: [],
        fileRootIds: ["file-root:guest"],
        pcActionIds: [],
      },
    }]);
    const scopedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(scopedRegistry, createResolver()),
    });
    const ownerAuthority = await seedOwnerAuthority(env.DB, scopedRepository);
    const snapshot = await scopedRegistry.snapshot(["conversation.basic", "files.read"], {
      schemaVersion: "1.0",
      calendarConnectionIds: [],
      fileRootIds: ["file-root:guest"],
      pcActionIds: [],
    });
    await scopedRepository.createGuestGrant({
      ...validCreateInput(ownerAuthority),
      capabilityIds: snapshot.capabilityIds,
      resourceScopes: snapshot.resourceScopes,
      accessDocumentHash: snapshot.accessDocumentHash,
    });
    const now = NOW.toISOString();
    await env.DB.prepare(`UPDATE voice_access_grants SET status = 'active', activated_at = ?, updated_at = ?
      WHERE grant_id = ?`).bind(now, now, GRANT_ID).run();
    await env.DB.prepare("UPDATE channel_identities SET status = 'active', verified_at = ? WHERE identity_id = ?")
      .bind(now, GUEST_IDENTITY_ID).run();
    const binding = Object.freeze({ ...guestBinding(), accessDocumentHash: snapshot.accessDocumentHash });
    await seedPreAuthSession(GUEST_RUNTIME_SESSION, binding);
    const scopedProofs = new GuestPinProofIssuer();
    const scopedService = new VoiceAccessAuthorityService(scopedRepository, scopedRegistry, scopedProofs);
    const proof = scopedProofs.issue({
      sessionId: GUEST_RUNTIME_SESSION,
      callSid: binding.callSid,
      relayNonce: binding.relayNonce,
      direction: binding.direction,
      principalId: binding.principalId,
      identityId: binding.identityId,
      grantId: GRANT_ID,
      grantVersion: 1,
      accessDocumentHash: snapshot.accessDocumentHash,
      authenticatedAt: NOW,
    });

    const minted = await scopedService.mintGuest({
      sessionId: GUEST_RUNTIME_SESSION,
      binding,
      pinProof: proof,
      now: NOW,
    });
    expect(minted).toMatchObject({
      capabilityIds: snapshot.capabilityIds,
      resourceScopes: snapshot.resourceScopes,
      accessDocumentHash: snapshot.accessDocumentHash,
    });

    const restartedRegistry = new CapabilityRegistry({
      installed: ["conversation.basic", "files.read"],
      fileRootIds: ["file-root:guest"],
    });
    const restartedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(restartedRegistry, createResolver()),
    });
    const restarted = new VoiceAccessAuthorityService(restartedRepository, restartedRegistry);
    const rehydrated = await restarted.rehydrate({ sessionId: GUEST_RUNTIME_SESSION, binding, now: NOW });
    expect(rehydrated).toMatchObject({
      kind: "guest",
      capabilityIds: minted.capabilityIds,
      resourceScopes: minted.resourceScopes,
      accessDocumentHash: minted.accessDocumentHash,
    });
  });
});

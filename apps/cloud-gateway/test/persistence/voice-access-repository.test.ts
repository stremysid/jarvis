import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayBinding, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import {
  createTargetGuestAccessDocumentVerifier,
  TargetGuestResourceScopeResolver,
} from "../../src/voice/owner-access-service.js";
import {
  clearVoiceAccessFixture,
  DOCUMENT_HASH,
  EMPTY_SCOPES,
  GRANT_ID,
  GUEST_IDENTITY_ID,
  GUEST_PRINCIPAL_ID,
  MUTATION_ID,
  NOW,
  OWNER_IDENTITY_ID,
  OWNER_PRINCIPAL_ID,
  REQUEST_HASH,
  REPLACED_DOCUMENT_HASH,
  ROTATED_RECORD,
  seedOwnerAuthority,
  SYNTHETIC_RECORD,
  validCreateInput,
} from "./voice-access-fixture.js";

async function counts(): Promise<{ principals: number; identities: number; grants: number; events: number }> {
  const [principals, identities, grants, events] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM principals").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grant_events").first<{ count: number }>(),
  ]);
  return {
    principals: principals?.count ?? -1,
    identities: identities?.count ?? -1,
    grants: grants?.count ?? -1,
    events: events?.count ?? -1,
  };
}

describe("VoiceAccessRepository", () => {
  let repository: VoiceAccessRepository;
  let ownerAuthority: Awaited<ReturnType<typeof seedOwnerAuthority>>;

  beforeEach(async () => {
    await clearVoiceAccessFixture(env.DB);
    repository = new VoiceAccessRepository(env.DB);
    ownerAuthority = await seedOwnerAuthority(env.DB, repository);
  });

  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("creates a separate pending guest identity and grant atomically", async () => {
    const created = await repository.createGuestGrant(validCreateInput(ownerAuthority));

    expect(created).toMatchObject({
      grantId: GRANT_ID,
      principalId: GUEST_PRINCIPAL_ID,
      identityId: GUEST_IDENTITY_ID,
      grantVersion: 1,
      status: "pending",
      capabilityIds: ["conversation.basic"],
    });
    expect(await counts()).toEqual({ principals: 2, identities: 2, grants: 1, events: 1 });

    await expect(repository.createGuestGrant(validCreateInput(ownerAuthority)))
      .resolves.toMatchObject({ grantId: GRANT_ID, grantVersion: 1, status: "pending" });
    await expect(repository.createGuestGrant({
      ...validCreateInput(ownerAuthority),
      requestHash: "f".repeat(64) as Sha256Hex,
    })).rejects.toThrow("voice_access_mutation_conflict");

    await expect(repository.listGuests({ ownerAuthority, ownerIdentityId: OWNER_IDENTITY_ID, now: NOW }))
      .resolves.toEqual([expect.objectContaining({
        identityId: GUEST_IDENTITY_ID,
        maskedNumber: "+1******0111",
        status: "pending",
      })]);
  });

  it("rejects a structural clone at every owner-only mutation boundary", async () => {
    const clone = Object.freeze({ ...ownerAuthority });

    await expect(repository.createGuestGrant(validCreateInput(clone)))
      .rejects.toThrow("owner_authority_required");
    await expect(repository.listGuests({
      ownerAuthority: clone,
      ownerIdentityId: OWNER_IDENTITY_ID,
      now: NOW,
    })).rejects.toThrow("owner_authority_required");
    expect(await counts()).toEqual({ principals: 1, identities: 1, grants: 0, events: 0 });
  });

  it("recomputes the canonical capability document before creating a grant", async () => {
    await expect(repository.createGuestGrant({
      ...validCreateInput(ownerAuthority),
      accessDocumentHash: "f".repeat(64) as Sha256Hex,
    })).rejects.toThrow("voice_access_document_invalid");
    expect(await counts()).toEqual({ principals: 1, identities: 1, grants: 0, events: 0 });
  });

  it("rejects a capability document carrying another guest's resource scope", async () => {
    await clearVoiceAccessFixture(env.DB);
    const registry = new CapabilityRegistry({
      installed: ["files.read"],
      fileRootIds: ["file-root:guest-a", "file-root:guest-b"],
    });
    const resolver = new TargetGuestResourceScopeResolver([{
      providerE164: "+14165550111",
      resourceScopes: {
        schemaVersion: "1.0",
        calendarConnectionIds: [],
        fileRootIds: ["file-root:guest-b"],
        pcActionIds: [],
      },
    }]);
    const scopedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(registry, resolver),
    });
    const scopedOwner = await seedOwnerAuthority(env.DB, scopedRepository);
    const foreign = await registry.snapshot(["files.read"], {
      schemaVersion: "1.0",
      calendarConnectionIds: [],
      fileRootIds: ["file-root:guest-a"],
      pcActionIds: [],
    });

    await expect(scopedRepository.createGuestGrant({
      ...validCreateInput(scopedOwner),
      capabilityIds: foreign.capabilityIds,
      resourceScopes: foreign.resourceScopes,
      accessDocumentHash: foreign.accessDocumentHash,
    })).rejects.toThrow("voice_access_document_invalid");
    expect(await counts()).toEqual({ principals: 1, identities: 1, grants: 0, events: 0 });
  });

  it("rehydrates a scoped grant only under the same reconstructed target ownership configuration", async () => {
    await clearVoiceAccessFixture(env.DB);
    const configuredRegistry = () => new CapabilityRegistry({
      installed: ["conversation.basic", "files.read"],
      fileRootIds: ["file-root:guest-a", "file-root:guest-b"],
    });
    const configuredResolver = () => new TargetGuestResourceScopeResolver([{
      providerE164: "+14165550111",
      resourceScopes: {
        schemaVersion: "1.0",
        calendarConnectionIds: [],
        fileRootIds: ["file-root:guest-b"],
        pcActionIds: [],
      },
    }]);
    const registry = configuredRegistry();
    const scopedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(registry, configuredResolver()),
    });
    const scopedOwner = await seedOwnerAuthority(env.DB, scopedRepository);
    const snapshot = await registry.snapshot(["conversation.basic", "files.read"], {
      schemaVersion: "1.0",
      calendarConnectionIds: [],
      fileRootIds: ["file-root:guest-b"],
      pcActionIds: [],
    });
    await scopedRepository.createGuestGrant({
      ...validCreateInput(scopedOwner),
      capabilityIds: snapshot.capabilityIds,
      resourceScopes: snapshot.resourceScopes,
      accessDocumentHash: snapshot.accessDocumentHash,
    });

    const restartedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(
        configuredRegistry(),
        configuredResolver(),
      ),
    });
    await expect(restartedRepository.getGuestGrant(GRANT_ID)).resolves.toMatchObject({
      capabilityIds: ["conversation.basic", "files.read"],
      resourceScopes: { fileRootIds: ["file-root:guest-b"] },
    });

    const driftedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(
        configuredRegistry(),
        new TargetGuestResourceScopeResolver([{
          providerE164: "+14165550111",
          resourceScopes: {
            schemaVersion: "1.0",
            calendarConnectionIds: [],
            fileRootIds: ["file-root:guest-a"],
            pcActionIds: [],
          },
        }]),
      ),
    });
    await expect(driftedRepository.getGuestGrant(GRANT_ID))
      .rejects.toThrow("voice_access_document_invalid");
    await expect(new VoiceAccessRepository(env.DB).getGuestGrant(GRANT_ID))
      .rejects.toThrow("voice_access_document_invalid");
  });

  it("resolves only the configured owner and exact pending or active guest grant", async () => {
    await repository.createGuestGrant(validCreateInput(ownerAuthority));

    await expect(repository.resolveInboundCandidate({
      providerE164: "+14165550101",
      ownerIdentityId: OWNER_IDENTITY_ID,
      challengeHmacKeyVersion: "v1",
      now: NOW,
    })).resolves.toEqual({
      kind: "owner",
      principalId: OWNER_PRINCIPAL_ID,
      identityId: OWNER_IDENTITY_ID,
      activationChallengeId: null,
    });
    await expect(repository.resolveInboundCandidate({
      providerE164: "+14165550111",
      ownerIdentityId: OWNER_IDENTITY_ID,
      challengeHmacKeyVersion: "v1",
      now: NOW,
    })).resolves.toMatchObject({
      kind: "guest",
      grantId: GRANT_ID,
      grantVersion: 1,
      status: "pending",
    });
    await expect(repository.resolveInboundCandidate({
      providerE164: "+14165550999",
      ownerIdentityId: OWNER_IDENTITY_ID,
      challengeHmacKeyVersion: "v1",
      now: NOW,
    })).resolves.toBeNull();
    await expect(repository.resolveIdentityCandidate({
      identityId: OWNER_IDENTITY_ID,
      ownerIdentityId: "identity:stale-owner",
      now: NOW,
    })).resolves.toBeNull();
  });

  it("fails closed for a valid guest when the configured owner is stale or missing", async () => {
    await repository.createGuestGrant(validCreateInput(ownerAuthority));
    const inboundGuest = () => repository.resolveInboundCandidate({
      providerE164: "+14165550111",
      ownerIdentityId: OWNER_IDENTITY_ID,
      challengeHmacKeyVersion: "v1",
      now: NOW,
    });
    const identityGuest = () => repository.resolveIdentityCandidate({
      identityId: GUEST_IDENTITY_ID,
      ownerIdentityId: OWNER_IDENTITY_ID,
      now: NOW,
    });

    await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = ?")
      .bind(OWNER_IDENTITY_ID).run();
    await expect(inboundGuest()).resolves.toBeNull();
    await expect(identityGuest()).resolves.toBeNull();

    await env.DB.prepare("UPDATE channel_identities SET status = 'active' WHERE identity_id = ?")
      .bind(OWNER_IDENTITY_ID).run();
    await env.DB.prepare("DROP TRIGGER voice_owner_identity_delete_forbidden").run();
    try {
      await env.DB.prepare("DELETE FROM voice_owner_identity WHERE singleton_id = 1").run();
    } finally {
      await env.DB.prepare(`CREATE TRIGGER voice_owner_identity_delete_forbidden
        BEFORE DELETE ON voice_owner_identity
        BEGIN
          SELECT RAISE(ABORT, 'voice_owner_identity_delete_forbidden');
        END`).run();
    }
    await expect(inboundGuest()).resolves.toBeNull();
    await expect(identityGuest()).resolves.toBeNull();
  });

  it("replaces permissions, rotates the verifier, and revokes with monotone lineage", async () => {
    await repository.createGuestGrant(validCreateInput(ownerAuthority));
    const replaced = await repository.replacePermissions({
      mutationId: "01k3w1t4000000000000000511" as Ulid,
      requestHash: "c".repeat(64) as Sha256Hex,
      ownerAuthority,
      ownerIdentityId: OWNER_IDENTITY_ID,
      grantId: GRANT_ID,
      expectedGrantVersion: 1,
      capabilityIds: ["conversation.basic", "research.web"],
      resourceScopes: EMPTY_SCOPES,
      accessDocumentHash: REPLACED_DOCUMENT_HASH,
      now: NOW,
    });
    expect(replaced).toMatchObject({ grantVersion: 2, capabilityIds: ["conversation.basic", "research.web"] });

    const rotated = await repository.rotatePin({
      mutationId: "01k3w1t4000000000000000512" as Ulid,
      requestHash: "e".repeat(64) as Sha256Hex,
      ownerAuthority,
      ownerIdentityId: OWNER_IDENTITY_ID,
      grantId: GRANT_ID,
      expectedGrantVersion: 2,
      pinVerifier: ROTATED_RECORD,
      now: NOW,
    });
    expect(rotated).toMatchObject({ grantVersion: 3 });

    const revoked = await repository.revokeGrant({
      mutationId: "01k3w1t4000000000000000513" as Ulid,
      requestHash: "f".repeat(64) as Sha256Hex,
      ownerAuthority,
      ownerIdentityId: OWNER_IDENTITY_ID,
      grantId: GRANT_ID,
      expectedGrantVersion: 3,
      now: NOW,
    });
    expect(revoked).toMatchObject({ grantVersion: 4, status: "revoked" });
    await expect(repository.listGuests({ ownerAuthority, ownerIdentityId: OWNER_IDENTITY_ID, now: NOW }))
      .resolves.toEqual([]);
    await expect(repository.resolveIdentityCandidate({
      identityId: GUEST_IDENTITY_ID,
      ownerIdentityId: OWNER_IDENTITY_ID,
      now: NOW,
    })).resolves.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grant_events")
      .first<{ count: number }>())?.count).toBe(4);
  });

  it("mints immutable owner authority and rejects stale guest authority", async () => {
    const secondSessionId = "01k3w1t4000000000000000520" as Ulid;
    const now = NOW.toISOString();
    await env.DB.prepare(`INSERT INTO call_sessions (
      session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
      direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
      nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
      access_kind, guest_grant_id, guest_grant_version, access_document_hash
    ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?,
      'owner', NULL, NULL, NULL)`)
      .bind(secondSessionId, `CA${"6".repeat(32)}`, OWNER_PRINCIPAL_ID, OWNER_IDENTITY_ID, OWNER_IDENTITY_ID,
        `${"6".repeat(42)}A`, "2026-08-30T12:05:00.000Z", "2026-08-30T12:05:00.000Z",
        now, now).run();
    await env.DB.prepare(`UPDATE call_sessions
      SET provider_session_id = ?, provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
      .bind(`VX${"6".repeat(32)}`, now, now, secondSessionId).run();
    await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting' WHERE session_id = ?").bind(secondSessionId).run();
    await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth' WHERE session_id = ?").bind(secondSessionId).run();
    await env.DB.prepare(`INSERT INTO owner_call_step_up_bindings (
      session_id, call_sid, owner_principal_id, owner_identity_id, direction,
      lifecycle_generation, requirement, attestation_class, policy, created_at
    ) VALUES (?, ?, ?, ?, 'inbound', 1, 'waived_passed_a', 'passed_a', 'waive_on_passed_a', ?)`)
      .bind(secondSessionId, `CA${"6".repeat(32)}`, OWNER_PRINCIPAL_ID, OWNER_IDENTITY_ID, now)
      .run();
    const binding: RelayBinding = {
      callSid: `CA${"6".repeat(32)}`,
      principalId: OWNER_PRINCIPAL_ID,
      identityId: OWNER_IDENTITY_ID,
      destinationIdentityId: OWNER_IDENTITY_ID,
      relayNonce: `${"6".repeat(42)}A`,
      direction: "inbound",
      activationOnly: false,
      activationChallengeId: null,
      accessKind: "owner",
      guestGrantId: null,
      guestGrantVersion: null,
      accessDocumentHash: null,
    };
    const minted = await repository.mintOwnerAuthority({ sessionId: secondSessionId, binding, now: NOW });
    await expect(repository.requireCurrentAuthority(minted, NOW)).resolves.toEqual(minted);
    await expect(repository.requireCurrentAuthority({ ...minted }, NOW))
      .rejects.toThrow("call_authority_invalid");

    const verifierGuard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'owner_passphrase_verifiers_transition_guard'`)
      .first<{ sql: string }>();
    if (verifierGuard === null) throw new Error("owner_passphrase_verifier_guard_missing");
    await env.DB.prepare("DROP TRIGGER owner_passphrase_verifiers_transition_guard").run();
    await env.DB.prepare(`UPDATE owner_passphrase_verifiers
      SET status = 'revoked', status_changed_at = ? WHERE status = 'active'`).bind(now).run();
    try {
      await expect(repository.rehydrateAuthority({ sessionId: secondSessionId, binding, now: NOW }))
        .rejects.toThrow("call_authority_invalid");
      await expect(repository.requireCurrentAuthority(minted, NOW))
        .rejects.toThrow("call_authority_stale");
    } finally {
      await env.DB.prepare(`UPDATE owner_passphrase_verifiers
        SET status = 'active', status_changed_at = created_at WHERE status = 'revoked'`).run();
      await env.DB.prepare(verifierGuard.sql).run();
    }

    await repository.createGuestGrant(validCreateInput(ownerAuthority));
    await env.DB.prepare(`UPDATE voice_access_grants SET status = 'active', activated_at = ?, updated_at = ?
      WHERE grant_id = ?`).bind(now, now, GRANT_ID).run();
    await env.DB.prepare("UPDATE channel_identities SET status = 'active', verified_at = ? WHERE identity_id = ?")
      .bind(now, GUEST_IDENTITY_ID).run();
    const guestSessionId = "01k3w1t4000000000000000521" as Ulid;
    await env.DB.prepare(`INSERT INTO call_sessions (
      session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
      direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
      nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
      access_kind, guest_grant_id, guest_grant_version, access_document_hash
    ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?,
      'guest', ?, 1, ?)`)
      .bind(guestSessionId, `CA${"7".repeat(32)}`, GUEST_PRINCIPAL_ID, GUEST_IDENTITY_ID, GUEST_IDENTITY_ID,
        `${"7".repeat(42)}A`, "2026-08-30T12:05:00.000Z", "2026-08-30T12:05:00.000Z",
        now, now, GRANT_ID, DOCUMENT_HASH).run();
    await env.DB.prepare(`UPDATE call_sessions
      SET provider_session_id = ?, provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
      .bind(`VX${"7".repeat(32)}`, now, now, guestSessionId).run();
    await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting' WHERE session_id = ?").bind(guestSessionId).run();
    await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth' WHERE session_id = ?").bind(guestSessionId).run();
    const guestBinding: RelayBinding = {
      callSid: `CA${"7".repeat(32)}`,
      principalId: GUEST_PRINCIPAL_ID,
      identityId: GUEST_IDENTITY_ID,
      destinationIdentityId: GUEST_IDENTITY_ID,
      relayNonce: `${"7".repeat(42)}A`,
      direction: "inbound",
      activationOnly: false,
      activationChallengeId: null,
      accessKind: "guest",
      guestGrantId: GRANT_ID,
      guestGrantVersion: 1,
      accessDocumentHash: DOCUMENT_HASH,
    };
    const guestAuthority = await repository.mintGuestAuthority({
      sessionId: guestSessionId,
      binding: guestBinding,
      activationEventId: "01k3w1t4000000000000000522" as Ulid,
      activationRequestHash: "1".repeat(64) as Sha256Hex,
      now: NOW,
    });
    await repository.replacePermissions({
      mutationId: "01k3w1t4000000000000000523" as Ulid,
      requestHash: "2".repeat(64) as Sha256Hex,
      ownerAuthority,
      ownerIdentityId: OWNER_IDENTITY_ID,
      grantId: GRANT_ID,
      expectedGrantVersion: 1,
      capabilityIds: ["conversation.basic", "research.web"],
      resourceScopes: EMPTY_SCOPES,
      accessDocumentHash: REPLACED_DOCUMENT_HASH,
      now: NOW,
    });
    await expect(repository.requireCurrentAuthority(guestAuthority, NOW))
      .rejects.toThrow("call_authority_stale");
  });
});

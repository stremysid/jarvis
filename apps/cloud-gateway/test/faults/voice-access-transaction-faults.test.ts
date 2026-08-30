import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayBinding, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import {
  clearVoiceAccessFixture,
  DOCUMENT_HASH,
  EMPTY_SCOPES,
  GRANT_ID,
  GUEST_IDENTITY_ID,
  GUEST_PRINCIPAL_ID,
  NOW,
  OWNER_IDENTITY_ID,
  REPLACED_DOCUMENT_HASH,
  ROTATED_RECORD,
  seedOwnerAuthority,
  validCreateInput,
} from "../persistence/voice-access-fixture.js";

type FaultOperation = "create" | "replace" | "rotate" | "revoke" | "activate";

function repositoryFailing(operationToFail: FaultOperation): VoiceAccessRepository {
  return new VoiceAccessRepository(env.DB, {
    batchFault: (operation) => operation === operationToFail
      ? env.DB.prepare("INSERT INTO voice_access_missing_fault_target(value) VALUES (1)")
      : null,
  });
}

async function expectPendingGrant(): Promise<void> {
  const grant = await env.DB.prepare(`SELECT grant_version, status, activated_at, revoked_at
    FROM voice_access_grants WHERE grant_id = ?`).bind(GRANT_ID)
    .first<{ grant_version: number; status: string; activated_at: string | null; revoked_at: string | null }>();
  const identity = await env.DB.prepare("SELECT status, verified_at FROM channel_identities WHERE identity_id = ?")
    .bind(GUEST_IDENTITY_ID).first<{ status: string; verified_at: string | null }>();
  const events = await env.DB.prepare("SELECT event_type FROM voice_access_grant_events ORDER BY created_at, event_id")
    .all<{ event_type: string }>();
  expect(grant).toEqual({ grant_version: 1, status: "pending", activated_at: null, revoked_at: null });
  expect(identity).toEqual({ status: "pending", verified_at: null });
  expect(events.results).toEqual([{ event_type: "created" }]);
}

async function seedGuestPreAuthSession(): Promise<{ sessionId: Ulid; binding: RelayBinding }> {
  const sessionId = "01k3w1t4000000000000000590" as Ulid;
  const now = NOW.toISOString();
  const binding: RelayBinding = Object.freeze({
    callSid: `CA${"b".repeat(32)}`,
    principalId: GUEST_PRINCIPAL_ID,
    identityId: GUEST_IDENTITY_ID,
    destinationIdentityId: GUEST_IDENTITY_ID,
    relayNonce: `${"b".repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "guest",
    guestGrantId: GRANT_ID,
    guestGrantVersion: 1,
    accessDocumentHash: DOCUMENT_HASH,
  });
  await env.DB.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?,
    'guest', ?, 1, ?)`)
    .bind(
      sessionId, binding.callSid, binding.principalId, binding.identityId, binding.destinationIdentityId,
      binding.relayNonce, "2026-08-30T12:05:00.000Z", "2026-08-30T12:05:00.000Z",
      now, now, GRANT_ID, DOCUMENT_HASH,
    ).run();
  await env.DB.prepare(`UPDATE call_sessions
    SET provider_session_id = ?, provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
    .bind(`VX${"b".repeat(32)}`, now, now, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(now, sessionId).run();
  await env.DB.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(now, sessionId).run();
  return { sessionId, binding };
}

describe("voice access transaction faults", () => {
  beforeEach(() => clearVoiceAccessFixture(env.DB));
  afterEach(() => clearVoiceAccessFixture(env.DB));

  it("leaves every guest row absent when the event boundary fails", async () => {
    const repository = new VoiceAccessRepository(env.DB, {
      beforeEventWrite: () => {
        throw new Error("synthetic_event_fault");
      },
    });
    const ownerAuthority = await seedOwnerAuthority(env.DB, repository);

    await expect(repository.createGuestGrant(validCreateInput(ownerAuthority)))
      .rejects.toThrow("synthetic_event_fault");

    const [principals, identities, grants, events] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM principals WHERE principal_id <> 'principal:voice-owner'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities WHERE identity_id <> 'identity:voice-owner'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grant_events").first<{ count: number }>(),
    ]);
    expect([principals?.count, identities?.count, grants?.count, events?.count]).toEqual([0, 0, 0, 0]);
  });

  it("rolls back earlier D1 writes when a later create batch statement fails", async () => {
    const repository = repositoryFailing("create");
    const ownerAuthority = await seedOwnerAuthority(env.DB, repository);

    await expect(repository.createGuestGrant(validCreateInput(ownerAuthority))).rejects.toThrow();

    const [principals, identities, grants, events] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM principals WHERE principal_id <> 'principal:voice-owner'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM channel_identities WHERE identity_id <> 'identity:voice-owner'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grant_events").first<{ count: number }>(),
    ]);
    expect([principals?.count, identities?.count, grants?.count, events?.count]).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["replace", async (repository: VoiceAccessRepository, ownerAuthority: Awaited<ReturnType<typeof seedOwnerAuthority>>) => {
      await repository.replacePermissions({
        mutationId: "01k3w1t4000000000000000591" as Ulid,
        requestHash: "1".repeat(64) as Sha256Hex,
        ownerAuthority,
        ownerIdentityId: OWNER_IDENTITY_ID,
        grantId: GRANT_ID,
        expectedGrantVersion: 1,
        capabilityIds: ["conversation.basic", "research.web"],
        resourceScopes: EMPTY_SCOPES,
        accessDocumentHash: REPLACED_DOCUMENT_HASH,
        now: NOW,
      });
    }],
    ["rotate", async (repository: VoiceAccessRepository, ownerAuthority: Awaited<ReturnType<typeof seedOwnerAuthority>>) => {
      await repository.rotatePin({
        mutationId: "01k3w1t4000000000000000592" as Ulid,
        requestHash: "2".repeat(64) as Sha256Hex,
        ownerAuthority,
        ownerIdentityId: OWNER_IDENTITY_ID,
        grantId: GRANT_ID,
        expectedGrantVersion: 1,
        pinVerifier: ROTATED_RECORD,
        now: NOW,
      });
    }],
    ["revoke", async (repository: VoiceAccessRepository, ownerAuthority: Awaited<ReturnType<typeof seedOwnerAuthority>>) => {
      await repository.revokeGrant({
        mutationId: "01k3w1t4000000000000000593" as Ulid,
        requestHash: "3".repeat(64) as Sha256Hex,
        ownerAuthority,
        ownerIdentityId: OWNER_IDENTITY_ID,
        grantId: GRANT_ID,
        expectedGrantVersion: 1,
        now: NOW,
      });
    }],
  ] as const)("rolls back earlier D1 writes when a later %s batch statement fails", async (operation, mutate) => {
    const repository = repositoryFailing(operation);
    const ownerAuthority = await seedOwnerAuthority(env.DB, repository);
    await repository.createGuestGrant(validCreateInput(ownerAuthority));

    await expect(mutate(repository, ownerAuthority)).rejects.toThrow();
    await expectPendingGrant();
  });

  it("rolls back guest activation, identity verification, event, authority, and phase together", async () => {
    const repository = repositoryFailing("activate");
    const ownerAuthority = await seedOwnerAuthority(env.DB, repository);
    await repository.createGuestGrant(validCreateInput(ownerAuthority));
    const { sessionId, binding } = await seedGuestPreAuthSession();

    await expect(repository.mintGuestAuthority({
      sessionId,
      binding,
      activationEventId: "01k3w1t4000000000000000594" as Ulid,
      activationRequestHash: "4".repeat(64) as Sha256Hex,
      now: NOW,
    })).rejects.toThrow();

    await expectPendingGrant();
    expect(await env.DB.prepare("SELECT 1 FROM call_session_authorities WHERE session_id = ?")
      .bind(sessionId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?")
      .bind(sessionId).first<{ phase: string }>()).toEqual({ phase: "pre_auth" });
  });
});

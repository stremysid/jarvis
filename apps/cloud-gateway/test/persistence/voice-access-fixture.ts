import {
  type RelayBinding,
  type Sha256Hex,
  type Ulid,
  type VoiceResourceScopesV1,
} from "../../../../packages/contracts/src/index.js";
import {
  type PersistedCallAuthority,
  VoiceAccessRepository,
} from "../../src/persistence/voice-access-repository.js";
import { OwnerPassphraseRepository } from "../../src/persistence/owner-passphrase-repository.js";
import {
  decodeGuestPinVerifierRecord,
  type GuestPinVerifierRecordV2,
} from "../../src/security/guest-pin-verifier.js";
import { OwnerPassphraseVerifier } from "../../src/security/owner-passphrase-verifier.js";
import {
  applyOwnerCallStepUpMigration,
  clearCallSessionsForTest,
  clearOwnerCallStepUpDataForTest,
  clearOwnerPassphraseDataForTest,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "./migration.js";

export const NOW = new Date("2026-08-30T12:00:00.000Z");
export const OWNER_PRINCIPAL_ID = "principal:voice-owner";
export const OWNER_IDENTITY_ID = "identity:voice-owner";
export const OWNER_SESSION_ID = "01k3w1t4000000000000000500" as Ulid;
export const GUEST_PRINCIPAL_ID = "principal:voice-guest";
export const GUEST_IDENTITY_ID = "identity:voice-guest";
export const GRANT_ID = "01k3w1t4000000000000000501";
export const MUTATION_ID = "01k3w1t4000000000000000510" as Ulid;
export const REQUEST_HASH = "a".repeat(64) as Sha256Hex;
export const DOCUMENT_HASH = "9c76368a27e3170a4cf6168573d21836d00714b3c4c4a4ef53ce6ff5d3c9644c" as Sha256Hex;
export const REPLACED_DOCUMENT_HASH = "d4edfa2907264f8dea1833082d862a853e6d1e5070c722cfb9fbe7df5d19dc0a" as Sha256Hex;
export const EMPTY_SCOPES: VoiceResourceScopesV1 = Object.freeze({
  schemaVersion: "1.0",
  calendarConnectionIds: Object.freeze([]),
  fileRootIds: Object.freeze([]),
  pcActionIds: Object.freeze([]),
});
const TEST_OWNER_PASSPHRASE = "ablaze abrasion abrasive";
const TEST_OWNER_PASSPHRASE_PEPPER = new Uint8Array(32).fill(19);

export const SYNTHETIC_RECORD: GuestPinVerifierRecordV2 = decodeGuestPinVerifierRecord({
  schemaVersion: "2.0",
  algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
  pepperVersion: "v1",
  iterations: 600_000,
  saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
  digestBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
});

export const ROTATED_RECORD: GuestPinVerifierRecordV2 = decodeGuestPinVerifierRecord({
  schemaVersion: "2.0",
  algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
  pepperVersion: "v1",
  iterations: 600_000,
  saltBase64: "AQEBAQEBAQEBAQEBAQEBAQ==",
  digestBase64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
});

export async function clearVoiceAccessFixture(database: D1Database): Promise<void> {
  await applyOwnerCallStepUpMigration();
  await clearOwnerCallStepUpDataForTest();
  await clearCallSessionsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearVoiceAccessDataForTest();
  await clearOwnerPassphraseDataForTest();
  await database.batch([
    database.prepare("DELETE FROM policy_decisions"),
    database.prepare("DELETE FROM channel_identities"),
    database.prepare("DELETE FROM device_keys"),
    database.prepare("DELETE FROM principals"),
  ]);
}

export async function seedOwnerAuthority(
  database: D1Database,
  repository: VoiceAccessRepository,
): Promise<PersistedCallAuthority> {
  const now = NOW.toISOString();
  const principals = [
    database.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'human', 'active', 'owner', ?, ?)")
      .bind(OWNER_PRINCIPAL_ID, now, now),
    database.prepare(`INSERT INTO device_keys (
      device_id, principal_id, key_id, public_key_base64, key_fingerprint,
      key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at
    ) VALUES ('device:voice-access-test', ?, 'key:voice-access-test', ?, ?, 1,
      'ed25519', 'active', 'test fixture', ?, ?)`)
      .bind(OWNER_PRINCIPAL_ID, "A".repeat(43) + "=", "b".repeat(64), "c".repeat(64), now),
    database.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES (?, ?, 'voice', '+14165550101', 'active', ?, ?)")
      .bind(OWNER_IDENTITY_ID, OWNER_PRINCIPAL_ID, now, now),
    database.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, ?, ?, ?)")
      .bind(OWNER_PRINCIPAL_ID, OWNER_IDENTITY_ID, now),
  ];
  await database.batch(principals);
  await database.prepare(`INSERT INTO call_sessions (
    session_id, call_sid, expected_attempt_id, principal_id, identity_id, destination_identity_id,
    direction, activation_only, activation_challenge_id, activation_hmac_key_version, relay_nonce,
    nonce_expires_at, relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
    access_kind, guest_grant_id, guest_grant_version, access_document_hash
  ) VALUES (?, ?, NULL, ?, ?, ?, 'inbound', 0, NULL, NULL, ?, ?, ?, NULL, 'created', ?, ?,
    'owner', NULL, NULL, NULL)`)
    .bind(
      OWNER_SESSION_ID,
      `CA${"5".repeat(32)}`,
      OWNER_PRINCIPAL_ID,
      OWNER_IDENTITY_ID,
      OWNER_IDENTITY_ID,
      `${"5".repeat(42)}A`,
      "2026-08-30T12:05:00.000Z",
      "2026-08-30T12:05:00.000Z",
      now,
      now,
    ).run();
  await database.prepare(`UPDATE call_sessions
    SET provider_session_id = ?, provider_connected_at = ?, updated_at = ? WHERE session_id = ?`)
    .bind(`VX${"5".repeat(32)}`, now, now, OWNER_SESSION_ID).run();
  await database.prepare("UPDATE call_sessions SET phase = 'connecting', updated_at = ? WHERE session_id = ?")
    .bind(now, OWNER_SESSION_ID).run();
  await database.prepare("UPDATE call_sessions SET phase = 'pre_auth', updated_at = ? WHERE session_id = ?")
    .bind(now, OWNER_SESSION_ID).run();
  const binding: RelayBinding = Object.freeze({
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
  const verifier = new OwnerPassphraseVerifier(
    TEST_OWNER_PASSPHRASE_PEPPER,
    "v1",
    () => new Uint8Array(16).fill(7),
  );
  await new OwnerPassphraseRepository(database).rotate({
    verified: {
      deviceId: "device:voice-access-test", principalId: OWNER_PRINCIPAL_ID,
      audience: "jarvis-local-agent", issuedAt: now, nonce: "test", bodyHash: "d".repeat(64),
      keyId: "key:voice-access-test", keyFingerprint: "b".repeat(64), keyGeneration: 1, body: {},
    },
    ownerPrincipalId: OWNER_PRINCIPAL_ID,
    ownerIdentityId: OWNER_IDENTITY_ID,
    expectedVerifierVersion: null,
    record: await verifier.create(OWNER_IDENTITY_ID, 1, TEST_OWNER_PASSPHRASE),
    commitId: "01m2ddddddddddddddddddd001",
    committedAt: now,
  });
  // An owner call needs no step-up binding row: minting the authority is all
  // that stands between this session and an active owner. Sid, 2026-09-24.
  return repository.mintOwnerAuthority({ sessionId: OWNER_SESSION_ID, binding, now: NOW });
}

export function validCreateInput(ownerAuthority: PersistedCallAuthority) {
  return {
    mutationId: MUTATION_ID,
    requestHash: REQUEST_HASH,
    ownerAuthority,
    ownerIdentityId: OWNER_IDENTITY_ID,
    grantId: GRANT_ID,
    guestPrincipalId: GUEST_PRINCIPAL_ID,
    guestIdentityId: GUEST_IDENTITY_ID,
    providerE164: "+14165550111",
    capabilityIds: ["conversation.basic"] as const,
    resourceScopes: EMPTY_SCOPES,
    accessDocumentHash: DOCUMENT_HASH,
    pinVerifier: SYNTHETIC_RECORD,
    now: NOW,
  };
}

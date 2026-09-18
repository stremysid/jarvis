import type { VerifiedDeviceRequest } from "../sync/signed-request.js";
import type { OwnerPassphraseVerifierRecordV1 } from "../security/owner-passphrase-verifier.js";

export interface OwnerPassphraseStatus {
  readonly verifierVersion: number | null;
  readonly status: "active" | "disabled" | null;
}

function binary(base64: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  try {
    return bytes.slice().buffer as ArrayBuffer;
  } finally {
    bytes.fill(0);
  }
}

function isStateChange(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(?:D1_ERROR: )?owner_passphrase_(?:rotation_state_changed|verifier_insert_invalid)(?::|$)/u
    .test(error.message)
    || error.message.startsWith("D1_ERROR: UNIQUE constraint failed: owner_passphrase_");
}

export class OwnerPassphraseStateChangedError extends Error {
  constructor() {
    super("owner_passphrase_state_changed");
    this.name = "OwnerPassphraseStateChangedError";
  }
}

export class OwnerPassphraseRepository {
  constructor(private readonly database: D1Database) {}

  async readStatus(
    verified: VerifiedDeviceRequest,
    ownerPrincipalId: string,
    ownerIdentityId: string,
  ): Promise<OwnerPassphraseStatus | null> {
    const row = await this.database.prepare(
      `SELECT head.verifier_version, head.status
       FROM device_keys device
       JOIN principals principal ON principal.principal_id = device.principal_id
       JOIN voice_owner_identity owner ON owner.principal_id = principal.principal_id
       JOIN channel_identities identity ON identity.identity_id = owner.identity_id
         AND identity.principal_id = owner.principal_id
       LEFT JOIN owner_passphrase_heads head ON head.singleton_id = 1
         AND head.owner_principal_id = owner.principal_id AND head.owner_identity_id = owner.identity_id
       WHERE device.device_id = ? AND device.principal_id = ? AND device.key_id = ?
         AND device.key_fingerprint = ? AND device.key_generation = ? AND device.status = 'active'
         AND principal.principal_id = ? AND principal.principal_type = 'human' AND principal.status = 'active'
         AND owner.singleton_id = 1 AND owner.identity_id = ?
         AND identity.channel = 'voice' AND identity.status = 'active' AND identity.verified_at IS NOT NULL`,
    ).bind(
      verified.deviceId, verified.principalId, verified.keyId, verified.keyFingerprint, verified.keyGeneration,
      ownerPrincipalId, ownerIdentityId,
    ).first<{ verifier_version: number | null; status: "active" | "disabled" | null }>();
    if (row === null) return null;
    return Object.freeze({ verifierVersion: row.verifier_version, status: row.status });
  }

  async rotate(input: Readonly<{
    verified: VerifiedDeviceRequest;
    ownerPrincipalId: string;
    ownerIdentityId: string;
    expectedVerifierVersion: number | null;
    record: OwnerPassphraseVerifierRecordV1;
    commitId: string;
    committedAt: string;
    faultStatement?: D1PreparedStatement;
  }>): Promise<void> {
    const expected = input.expectedVerifierVersion;
    const eligibility = expected === null
      ? "AND NOT EXISTS (SELECT 1 FROM owner_passphrase_heads)"
      : `AND EXISTS (
          SELECT 1 FROM owner_passphrase_heads head
          JOIN owner_passphrase_verifiers active ON active.owner_identity_id = head.owner_identity_id
            AND active.verifier_version = head.verifier_version
          WHERE head.singleton_id = 1 AND head.owner_principal_id = owner.principal_id
            AND head.owner_identity_id = owner.identity_id AND head.verifier_version = ?
            AND (
              head.status = 'active' AND active.status = 'active'
              OR head.status = 'disabled' AND active.status = 'revoked'
            )
        )`;
    const stage = this.database.prepare(
      `INSERT INTO owner_passphrase_verifiers (
         owner_principal_id, owner_identity_id, verifier_version, algorithm, domain_version,
         word_list_version, pepper_version, iterations, salt, digest, status,
         created_by_device_id, created_by_key_id, created_by_key_fingerprint,
         created_by_key_generation, created_at, status_changed_at
       )
       SELECT owner.principal_id, owner.identity_id, ?, ?, ?, ?, ?, ?, ?, ?, 'staged',
         device.device_id, device.key_id, device.key_fingerprint, device.key_generation, ?, ?
       FROM device_keys device
       JOIN principals principal ON principal.principal_id = device.principal_id
       JOIN voice_owner_identity owner ON owner.principal_id = principal.principal_id
       JOIN channel_identities identity ON identity.identity_id = owner.identity_id
         AND identity.principal_id = owner.principal_id
       WHERE device.device_id = ? AND device.principal_id = ? AND device.key_id = ?
         AND device.key_fingerprint = ? AND device.key_generation = ? AND device.status = 'active'
         AND principal.principal_id = ? AND principal.principal_type = 'human' AND principal.status = 'active'
         AND owner.singleton_id = 1 AND owner.identity_id = ?
         AND identity.channel = 'voice' AND identity.status = 'active' AND identity.verified_at IS NOT NULL
         ${eligibility}`,
    ).bind(
      input.record.verifierVersion, input.record.algorithm, input.record.domainVersion,
      input.record.wordListVersion, input.record.pepperVersion, input.record.iterations,
      binary(input.record.saltBase64), binary(input.record.digestBase64), input.committedAt, input.committedAt,
      input.verified.deviceId, input.verified.principalId, input.verified.keyId,
      input.verified.keyFingerprint, input.verified.keyGeneration, input.ownerPrincipalId, input.ownerIdentityId,
      ...(expected === null ? [] : [expected]),
    );
    const commit = this.database.prepare(
      `INSERT INTO owner_passphrase_rotation_commits (
         commit_id, owner_principal_id, owner_identity_id, expected_verifier_version,
         new_verifier_version, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.commitId, input.ownerPrincipalId, input.ownerIdentityId, expected,
      input.record.verifierVersion, input.committedAt,
    );
    try {
      await this.database.batch([
        stage,
        commit,
        ...(input.faultStatement === undefined ? [] : [input.faultStatement]),
      ]);
    } catch (error) {
      if (isStateChange(error)) throw new OwnerPassphraseStateChangedError();
      throw error;
    }
  }
}

import type { VerifiedDeviceRequest } from "../sync/signed-request.js";
import type { OwnerCallPinVerifierRecordV1 } from "../security/owner-call-pin-verifier.js";

export interface OwnerCallPinStatus {
  readonly pinVersion: number | null;
  readonly status: "active" | null;
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
  return /^(?:D1_ERROR: )?owner_call_pin_(?:rotation_state_changed|verifier_insert_invalid)(?::|$)/u
    .test(error.message)
    || error.message.startsWith("D1_ERROR: UNIQUE constraint failed: owner_call_pin_");
}

export class OwnerCallPinStateChangedError extends Error {
  constructor() {
    super("owner_call_pin_state_changed");
    this.name = "OwnerCallPinStateChangedError";
  }
}

/**
 * The four-digit call PIN is a credential like the passphrase, so it rotates
 * the same way: a staged verifier and the commit that publishes it are written
 * together, and the commit trigger is what moves the head. The head is grown
 * on the first generation and moved on every rotation, because the table has
 * no trigger of its own to invent a version that was never staged.
 */
export class OwnerCallPinRepository {
  constructor(private readonly database: D1Database) {}

  async readStatus(
    verified: VerifiedDeviceRequest,
    ownerPrincipalId: string,
    ownerIdentityId: string,
  ): Promise<OwnerCallPinStatus | null> {
    const row = await this.database.prepare(
      `SELECT head.pin_version
       FROM device_keys device
       JOIN principals principal ON principal.principal_id = device.principal_id
       JOIN voice_owner_identity owner ON owner.principal_id = principal.principal_id
       JOIN channel_identities identity ON identity.identity_id = owner.identity_id
         AND identity.principal_id = owner.principal_id
       LEFT JOIN owner_call_pin_heads head ON head.singleton_id = 1
         AND head.owner_principal_id = owner.principal_id AND head.owner_identity_id = owner.identity_id
       WHERE device.device_id = ? AND device.principal_id = ? AND device.key_id = ?
         AND device.key_fingerprint = ? AND device.key_generation = ? AND device.status = 'active'
         AND principal.principal_id = ? AND principal.principal_type = 'human' AND principal.status = 'active'
         AND owner.singleton_id = 1 AND owner.identity_id = ?
         AND identity.channel = 'voice' AND identity.status = 'active' AND identity.verified_at IS NOT NULL`,
    ).bind(
      verified.deviceId, verified.principalId, verified.keyId, verified.keyFingerprint, verified.keyGeneration,
      ownerPrincipalId, ownerIdentityId,
    ).first<{ pin_version: number | null }>();
    if (row === null) return null;
    return Object.freeze({ pinVersion: row.pin_version, status: row.pin_version === null ? null : "active" });
  }

  async rotate(input: Readonly<{
    verified: VerifiedDeviceRequest;
    ownerPrincipalId: string;
    ownerIdentityId: string;
    expectedPinVersion: number | null;
    record: OwnerCallPinVerifierRecordV1;
    commitId: string;
    committedAt: string;
    faultStatement?: D1PreparedStatement;
  }>): Promise<void> {
    const expected = input.expectedPinVersion;
    const eligibility = expected === null
      ? "AND NOT EXISTS (SELECT 1 FROM owner_call_pin_heads)"
      : `AND EXISTS (
          SELECT 1 FROM owner_call_pin_heads head
          JOIN owner_call_pin_verifiers active ON active.owner_identity_id = head.owner_identity_id
            AND active.pin_version = head.pin_version
          WHERE head.singleton_id = 1 AND head.owner_principal_id = owner.principal_id
            AND head.owner_identity_id = owner.identity_id AND head.pin_version = ?
            AND active.status = 'active'
        )`;
    const stage = this.database.prepare(
      `INSERT INTO owner_call_pin_verifiers (
         owner_principal_id, owner_identity_id, pin_version, algorithm, domain_version, pepper_version,
         iterations, salt, digest, status,
         created_by_device_id, created_by_key_id, created_by_key_fingerprint,
         created_by_key_generation, created_at, status_changed_at
       )
       SELECT owner.principal_id, owner.identity_id, ?, ?, ?, ?, ?, ?, ?, 'staged',
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
      input.record.pepperVersion, input.record.iterations,
      binary(input.record.saltBase64), binary(input.record.digestBase64), input.committedAt, input.committedAt,
      input.verified.deviceId, input.verified.principalId, input.verified.keyId,
      input.verified.keyFingerprint, input.verified.keyGeneration, input.ownerPrincipalId, input.ownerIdentityId,
      ...(expected === null ? [] : [expected]),
    );
    const commit = this.database.prepare(
      `INSERT INTO owner_call_pin_rotation_commits (
         commit_id, owner_principal_id, owner_identity_id, expected_pin_version,
         new_pin_version, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.commitId, input.ownerPrincipalId, input.ownerIdentityId, expected,
      input.record.verifierVersion, input.committedAt,
    );
    const openHead = this.database.prepare(
      `INSERT INTO owner_call_pin_heads (singleton_id, owner_principal_id, owner_identity_id, pin_version, updated_at)
       SELECT 1, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM owner_call_pin_heads)`,
    ).bind(
      input.ownerPrincipalId, input.ownerIdentityId, input.record.verifierVersion, input.committedAt,
    );
    const moveHead = this.database.prepare(
      `UPDATE owner_call_pin_heads SET pin_version = ?, updated_at = ?
       WHERE singleton_id = 1 AND owner_principal_id = ? AND owner_identity_id = ? AND pin_version <> ?`,
    ).bind(
      input.record.verifierVersion, input.committedAt, input.ownerPrincipalId, input.ownerIdentityId,
      input.record.verifierVersion,
    );
    try {
      await this.database.batch([
        stage,
        commit,
        openHead,
        moveHead,
        ...(input.faultStatement === undefined ? [] : [input.faultStatement]),
      ]);
    } catch (error) {
      if (isStateChange(error)) throw new OwnerCallPinStateChangedError();
      throw error;
    }
  }
}

import type { Sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { VerifiedDeviceRequest } from "../sync/signed-request.js";

export type StoredIdentityChannel = "telegram" | "voice";

export interface IdentityChallengeRow {
  readonly challenge_id: string;
  readonly principal_id: string;
  readonly identity_id: string;
  readonly channel: StoredIdentityChannel;
  readonly initiating_device_id: string;
  readonly initiating_key_id: string;
  readonly initiating_key_fingerprint: Sha256Hex;
  readonly initiating_key_generation: number;
  readonly response_hmac: Sha256Hex;
  readonly hmac_key_version: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly identity_status: "pending" | "active" | "disabled";
  readonly identity_verified_at: string | null;
  readonly principal_status: "pending" | "active" | "disabled";
  readonly device_status: "active" | "revoked";
  readonly current_key_id: string;
  readonly current_key_fingerprint: Sha256Hex;
  readonly current_key_generation: number;
}

export interface CreateIdentityChallengeInput {
  readonly challengeId: string;
  readonly verified: VerifiedDeviceRequest;
  readonly identityId: string;
  readonly channel: StoredIdentityChannel;
  readonly responseHmac: Sha256Hex;
  readonly hmacKeyVersion: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface ConsumeIdentityChallengeInput {
  readonly challengeId: string;
  readonly principalId: string;
  readonly identityId: string;
  readonly channel: StoredIdentityChannel;
  readonly initiatingDeviceId: string;
  readonly initiatingKeyId: string;
  readonly initiatingKeyFingerprint: Sha256Hex;
  readonly initiatingKeyGeneration: number;
  readonly responseHmac: Sha256Hex;
  readonly hmacKeyVersion: string;
  readonly now: string;
}

export interface SyncSnapshotRow {
  readonly snapshot_id: string;
  readonly consumer_name: string;
  readonly principal_id: string;
  readonly device_id: string;
  readonly root_snapshot_id: string;
  readonly input_token_hash: Sha256Hex | null;
  readonly output_token_hash: Sha256Hex;
  readonly material_hash: Sha256Hex;
  readonly root_upper_sequence: number;
  readonly from_sequence: number;
  readonly through_sequence: number;
  readonly boundary_start_event_id: string | null;
  readonly boundary_end_event_id: string | null;
  readonly event_count: number;
  readonly has_more: 0 | 1;
  readonly expires_at: string;
  readonly created_at: string;
  readonly acknowledged_at: string | null;
}

export interface CreateSyncSnapshotInput {
  readonly snapshotId: string;
  readonly verified: VerifiedDeviceRequest;
  readonly consumerName: string;
  readonly rootSnapshotId: string;
  readonly inputTokenHash: Sha256Hex | null;
  readonly outputTokenHash: Sha256Hex;
  readonly materialHash: Sha256Hex;
  readonly rootUpperSequence: number;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly boundaryStartEventId: string | null;
  readonly boundaryEndEventId: string | null;
  readonly eventCount: number;
  readonly hasMore: boolean;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface SyncAckReceiptRow {
  readonly receipt_id: string;
  readonly snapshot_id: string;
  readonly principal_id: string;
  readonly device_id: string;
  readonly consumer_name: string;
  readonly expected_current: number;
  readonly through_sequence: number;
  readonly current_sequence: number;
  readonly acknowledged_at: string;
}

export interface SnapshotAckInput {
  readonly receiptId: string;
  readonly verified: VerifiedDeviceRequest;
  readonly snapshotId: string;
  readonly consumerName: string;
  readonly expectedCurrent: number;
  readonly throughSequence: number;
  readonly acknowledgedAt: string;
}

export interface ActiveTelegramIdentity {
  readonly identityId: string;
  readonly principalId: string;
  readonly principalType: "human" | "service";
}

/** Owns atomic device/key-bound state transitions in D1. */
export class DeviceRepository {
  constructor(private readonly database: D1Database) {}

  async createIdentityChallenge(input: CreateIdentityChallengeInput): Promise<boolean> {
    const result = await this.database.prepare(
      `INSERT INTO identity_challenges (
         challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id,
         initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version,
         expires_at, consumed_at, created_at
       )
       SELECT ?, d.principal_id, ci.identity_id, ci.channel, d.device_id, d.key_id,
         d.key_fingerprint, d.key_generation, ?, ?, ?, NULL, ?
       FROM device_keys d
       JOIN principals p ON p.principal_id = d.principal_id
       JOIN channel_identities ci ON ci.principal_id = d.principal_id
       WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ?
         AND d.key_fingerprint = ? AND d.key_generation = ? AND d.status = 'active'
         AND p.status = 'active' AND ci.identity_id = ? AND ci.channel = ?
         AND ci.status = 'pending' AND ci.verified_at IS NULL
         AND ci.enrolled_by_device_id = d.device_id
       RETURNING challenge_id`,
    ).bind(
      input.challengeId, input.responseHmac, input.hmacKeyVersion, input.expiresAt, input.createdAt,
      input.verified.deviceId, input.verified.principalId, input.verified.keyId,
      input.verified.keyFingerprint, input.verified.keyGeneration, input.identityId, input.channel,
    ).first<{ challenge_id: string }>();
    return result?.challenge_id === input.challengeId;
  }

  readIdentityChallenge(challengeId: string): Promise<IdentityChallengeRow | null> {
    return this.database.prepare(
      `SELECT c.challenge_id, c.principal_id, c.identity_id, c.channel, c.initiating_device_id,
         c.initiating_key_id, c.initiating_key_fingerprint, c.initiating_key_generation,
         c.response_hmac, c.hmac_key_version, c.expires_at, c.consumed_at,
         ci.status AS identity_status, ci.verified_at AS identity_verified_at,
         p.status AS principal_status, d.status AS device_status,
         d.key_id AS current_key_id, d.key_fingerprint AS current_key_fingerprint,
         d.key_generation AS current_key_generation
       FROM identity_challenges c
       JOIN channel_identities ci ON ci.identity_id = c.identity_id AND ci.principal_id = c.principal_id AND ci.channel = c.channel
       JOIN principals p ON p.principal_id = c.principal_id
       JOIN device_keys d ON d.device_id = c.initiating_device_id AND d.principal_id = c.principal_id
       WHERE c.challenge_id = ?`,
    ).bind(challengeId).first<IdentityChallengeRow>();
  }

  async consumeIdentityChallenge(input: ConsumeIdentityChallengeInput): Promise<boolean> {
    const result = await this.database.prepare(
      `UPDATE identity_challenges
       SET consumed_at = ?
       WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?
         AND principal_id = ? AND identity_id = ? AND channel = ?
         AND initiating_device_id = ? AND initiating_key_id = ?
         AND initiating_key_fingerprint = ? AND initiating_key_generation = ?
         AND response_hmac = ? AND hmac_key_version = ?`,
    ).bind(
      input.now, input.challengeId, input.now, input.principalId, input.identityId, input.channel,
      input.initiatingDeviceId, input.initiatingKeyId, input.initiatingKeyFingerprint,
      input.initiatingKeyGeneration, input.responseHmac, input.hmacKeyVersion,
    ).run();
    return result.meta.changes > 0;
  }

  async findActiveVerifiedTelegramIdentity(providerSubject: string): Promise<ActiveTelegramIdentity | null> {
    if (!/^[1-9]\d{0,19}$/u.test(providerSubject)) throw new TypeError("telegram_provider_subject_invalid");
    const row = await this.database.prepare(
      `SELECT ci.identity_id, p.principal_id, p.principal_type
       FROM channel_identities ci
       JOIN principals p ON p.principal_id = ci.principal_id
       WHERE ci.channel = 'telegram' AND ci.provider_subject = ?
         AND ci.status = 'active' AND ci.verified_at IS NOT NULL
         AND p.status = 'active'`,
    ).bind(providerSubject).first<{ identity_id: string; principal_id: string; principal_type: "human" | "service" }>();
    if (row === null) return null;
    return Object.freeze({ identityId: row.identity_id, principalId: row.principal_id, principalType: row.principal_type });
  }

  async isCurrentDevice(verified: VerifiedDeviceRequest): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT 1 AS active
       FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
       WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ?
         AND d.key_fingerprint = ? AND d.key_generation = ?
         AND d.status = 'active' AND p.status = 'active'`,
    ).bind(
      verified.deviceId, verified.principalId, verified.keyId,
      verified.keyFingerprint, verified.keyGeneration,
    ).first<{ active: number }>();
    return row?.active === 1;
  }

  async isCurrentHumanDevice(verified: VerifiedDeviceRequest): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT 1 AS active
       FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
       WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ?
         AND d.key_fingerprint = ? AND d.key_generation = ?
         AND d.status = 'active' AND p.status = 'active' AND p.principal_type = 'human'`,
    ).bind(
      verified.deviceId, verified.principalId, verified.keyId,
      verified.keyFingerprint, verified.keyGeneration,
    ).first<{ active: number }>();
    return row?.active === 1;
  }

  async createSyncSnapshot(input: CreateSyncSnapshotInput): Promise<boolean> {
    const result = await this.database.prepare(
      `INSERT INTO sync_snapshots (
         snapshot_id, consumer_name, principal_id, device_id, root_snapshot_id,
         input_token_hash, output_token_hash, material_hash, root_upper_sequence,
         from_sequence, through_sequence, boundary_start_event_id, boundary_end_event_id,
         event_count, has_more, expires_at, created_at, acknowledged_at
       )
       SELECT ?, c.consumer_name, d.principal_id, d.device_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM device_keys d
       JOIN principals p ON p.principal_id = d.principal_id
       JOIN consumer_cursors c ON c.consumer_name = ?
       WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ?
         AND d.key_fingerprint = ? AND d.key_generation = ?
         AND d.status = 'active' AND p.status = 'active'
       RETURNING snapshot_id`,
    ).bind(
      input.snapshotId, input.rootSnapshotId, input.inputTokenHash, input.outputTokenHash, input.materialHash,
      input.rootUpperSequence, input.fromSequence, input.throughSequence, input.boundaryStartEventId,
      input.boundaryEndEventId, input.eventCount, input.hasMore ? 1 : 0, input.expiresAt, input.createdAt,
      input.consumerName, input.verified.deviceId, input.verified.principalId, input.verified.keyId,
      input.verified.keyFingerprint, input.verified.keyGeneration,
    ).first<{ snapshot_id: string }>();
    return result?.snapshot_id === input.snapshotId;
  }

  readSnapshotById(snapshotId: string): Promise<SyncSnapshotRow | null> {
    return this.database.prepare("SELECT * FROM sync_snapshots WHERE snapshot_id = ?").bind(snapshotId).first<SyncSnapshotRow>();
  }

  readSnapshotByInputToken(inputTokenHash: Sha256Hex): Promise<SyncSnapshotRow | null> {
    return this.database.prepare("SELECT * FROM sync_snapshots WHERE input_token_hash = ?").bind(inputTokenHash).first<SyncSnapshotRow>();
  }

  readSnapshotByOutputToken(outputTokenHash: Sha256Hex): Promise<SyncSnapshotRow | null> {
    return this.database.prepare("SELECT * FROM sync_snapshots WHERE output_token_hash = ?").bind(outputTokenHash).first<SyncSnapshotRow>();
  }

  readSnapshotReceipt(input: {
    snapshotId: string;
    principalId: string;
    deviceId: string;
    consumerName: string;
    expectedCurrent: number;
    throughSequence: number;
  }): Promise<SyncAckReceiptRow | null> {
    return this.database.prepare(
      `SELECT receipt_id, snapshot_id, principal_id, device_id, consumer_name,
         expected_current, through_sequence, current_sequence, acknowledged_at
       FROM sync_ack_receipts
       WHERE receipt_kind = 'snapshot' AND snapshot_id = ? AND principal_id = ? AND device_id = ?
         AND consumer_name = ? AND expected_current = ? AND through_sequence = ?`,
    ).bind(
      input.snapshotId, input.principalId, input.deviceId, input.consumerName,
      input.expectedCurrent, input.throughSequence,
    ).first<SyncAckReceiptRow>();
  }

  async acknowledgeSnapshot(input: SnapshotAckInput): Promise<boolean> {
    const result = await this.database.prepare(
      `INSERT INTO sync_ack_receipts (
         receipt_id, snapshot_id, principal_id, device_id, consumer_name,
         expected_current, through_sequence, current_sequence, acknowledged_at, receipt_kind
       )
       SELECT ?, s.snapshot_id, s.principal_id, s.device_id, s.consumer_name,
         ?, ?, ?, ?, 'snapshot'
       FROM sync_snapshots s
       JOIN consumer_cursors c ON c.consumer_name = s.consumer_name
       JOIN device_keys d ON d.device_id = s.device_id AND d.principal_id = s.principal_id
       JOIN principals p ON p.principal_id = s.principal_id
       WHERE s.snapshot_id = ? AND s.principal_id = ? AND s.device_id = ? AND s.consumer_name = ?
         AND s.from_sequence = ? AND s.through_sequence = ?
         AND s.acknowledged_at IS NULL AND s.expires_at > ?
         AND c.current_sequence = ?
         AND d.key_id = ? AND d.key_fingerprint = ? AND d.key_generation = ?
         AND d.status = 'active' AND p.status = 'active'`,
    ).bind(
      input.receiptId, input.expectedCurrent, input.throughSequence, input.throughSequence,
      input.acknowledgedAt, input.snapshotId, input.verified.principalId, input.verified.deviceId,
      input.consumerName, input.expectedCurrent, input.throughSequence, input.acknowledgedAt,
      input.expectedCurrent, input.verified.keyId, input.verified.keyFingerprint, input.verified.keyGeneration,
    ).run();
    return result.meta.changes > 0;
  }

  async readCursor(consumerName: string): Promise<number> {
    const row = await this.database.prepare("SELECT current_sequence FROM consumer_cursors WHERE consumer_name = ?")
      .bind(consumerName).first<{ current_sequence: number }>();
    return row?.current_sequence ?? 0;
  }
}

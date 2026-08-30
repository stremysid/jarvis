import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyFoundationMigration } from "./migration.js";

const validHash = "0".repeat(64);
const invalidHash = "g".repeat(64);
const timestamp = "2026-08-30T00:00:00.000Z";
const futureTimestamp = "2026-08-30T00:05:00.000Z";

async function seedDevicePairs(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:one', 'service', 'active', 'one', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:two', 'service', 'active', 'two', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES ('device:one', 'principal:one', 'key:one', ?, ?, 1, 'ed25519', 'active', 'one', ?, ?)").bind(`${"A".repeat(43)}=`, "1".repeat(64), "2".repeat(64), timestamp),
    env.DB.prepare("INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES ('device:two', 'principal:two', 'key:two', ?, ?, 1, 'ed25519', 'active', 'two', ?, ?)").bind(`${"B".repeat(43)}=`, "3".repeat(64), "4".repeat(64), timestamp),
    env.DB.prepare("INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at) VALUES ('device:device:one', 0, ?)").bind(timestamp),
  ]);
}

function insertSnapshot(snapshotId: string, principalId: string, deviceId: string, hashDigit: string): Promise<D1Result<unknown>> {
  return env.DB.prepare(
    `INSERT INTO sync_snapshots (
       snapshot_id, consumer_name, principal_id, device_id, root_snapshot_id, input_token_hash,
       output_token_hash, material_hash, root_upper_sequence, from_sequence, through_sequence,
       boundary_start_event_id, boundary_end_event_id, event_count, has_more, expires_at, created_at
     ) VALUES (?, 'device:device:one', ?, ?, ?, NULL, ?, ?, 0, 0, 0, NULL, NULL, 0, 0, ?, ?)`,
  ).bind(snapshotId, principalId, deviceId, snapshotId, hashDigit.repeat(64), "a".repeat(64), futureTimestamp, timestamp).run();
}

describe("foundation migration constraints", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM archive_segments"), env.DB.prepare("DELETE FROM archive_manifests"), env.DB.prepare("DELETE FROM policy_decisions"),
      env.DB.prepare("DELETE FROM sync_ack_receipts"), env.DB.prepare("DELETE FROM sync_snapshots"), env.DB.prepare("DELETE FROM request_nonces"), env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"), env.DB.prepare("DELETE FROM consumer_cursors"), env.DB.prepare("DELETE FROM bootstrap_tokens"), env.DB.prepare("DELETE FROM device_keys"), env.DB.prepare("DELETE FROM principals"), env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
    ]);
  });

  it("rejects non-lowercase-hex values in every SHA-256 persistence column", async () => {
    await expect(env.DB.prepare("INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES ('event', 'type', 'source', 'subject', ?, ?, ?, '{}', ?)").bind(timestamp, timestamp, invalidHash, timestamp).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES ('event', 'type', 'source', 'subject', ?, ?, ?, '{}', ?)").bind(timestamp, timestamp, validHash, timestamp).run();
    await expect(env.DB.prepare("INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) VALUES ('scope', 'key', ?, 1, ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();

    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('principal', 'human', 'active', 'test', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(timestamp, timestamp).run();
    await expect(env.DB.prepare("INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, expires_at, issued_at, issued_by) VALUES ('bootstrap', ?, ?, ?, 'test')").bind(invalidHash, timestamp, timestamp).run()).rejects.toThrow();

    await env.DB.prepare("INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES ('device', 'principal', 'key', ?, ?, 1, 'ed25519', 'active', 'test', ?, ?)").bind(`${"A".repeat(43)}=`, validHash, validHash, timestamp).run();
    await env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity', 'principal', 'telegram', 'subject', 'pending', NULL, ?, 'device')").bind(timestamp).run();
    await expect(env.DB.prepare("INSERT INTO identity_challenges (challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id, initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version, expires_at, created_at) VALUES ('challenge', 'principal', 'identity', 'telegram', 'device', 'key', ?, 1, ?, 'v1', ?, ?)").bind(validHash, invalidHash, timestamp, timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at) VALUES ('nonce', 'device', 'principal', 'key', ?, 1, ?, ?, ?, ?, ?)").bind(validHash, invalidHash, validHash, timestamp, timestamp, timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES ('decision', 'principal', 'v1', ?, 'allow', 'test', ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();

    await expect(env.DB.prepare("INSERT INTO archive_manifests (manifest_id, subject_id, from_sequence, through_sequence, content_hash, status, created_at) VALUES ('manifest', 'subject', 0, 0, ?, 'pending', ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO archive_manifests (manifest_id, subject_id, from_sequence, through_sequence, content_hash, status, created_at) VALUES ('manifest', 'subject', 0, 0, ?, 'pending', ?)").bind(validHash, timestamp).run();
    await expect(env.DB.prepare("INSERT INTO archive_segments (manifest_id, segment_index, object_key, first_sequence, last_sequence, content_hash, byte_length, created_at) VALUES ('manifest', 0, 'object', 1, 1, ?, 0, ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();
  });

  it("enforces exactly one canonical human while allowing service principals", async () => {
    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('human:one', 'human', 'active', 'one', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(timestamp, timestamp).run();
    await expect(env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('human:two', 'human', 'active', 'two', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(timestamp, timestamp).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('service:one', 'service', 'active', 'service', ?, ?)").bind(timestamp, timestamp).run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM principals").first<{ count: number }>())?.count).toBe(2);
  });

  it("rejects a sync snapshot whose device belongs to a different principal and accepts the exact pair", async () => {
    await seedDevicePairs();

    await expect(insertSnapshot("snapshot:cross", "principal:two", "device:one", "5")).rejects.toThrow();
    await expect(insertSnapshot("snapshot:valid", "principal:one", "device:one", "6")).resolves.toMatchObject({ success: true });
  });

  it("enforces all-or-none coherent bootstrap token consumption bindings", async () => {
    await seedDevicePairs();

    await expect(env.DB.prepare(
      "INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, principal_id, expires_at, issued_at, issued_by) VALUES ('bootstrap:half', ?, 'principal:one', ?, ?, 'test')",
    ).bind("5".repeat(64), futureTimestamp, timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare(
      "INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, expires_at, consumed_at, issued_at, issued_by) VALUES ('bootstrap:consumed-unbound', ?, ?, ?, ?, 'test')",
    ).bind("6".repeat(64), futureTimestamp, timestamp, timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare(
      "INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, principal_id, device_id, expires_at, consumed_at, issued_at, issued_by) VALUES ('bootstrap:cross', ?, 'principal:two', 'device:one', ?, ?, ?, 'test')",
    ).bind("7".repeat(64), futureTimestamp, timestamp, timestamp).run()).rejects.toThrow();

    await expect(env.DB.prepare(
      "INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, expires_at, issued_at, issued_by) VALUES ('bootstrap:issued', ?, ?, ?, 'test')",
    ).bind("8".repeat(64), futureTimestamp, timestamp).run()).resolves.toMatchObject({ success: true });
    await expect(env.DB.prepare(
      "INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, principal_id, device_id, expires_at, consumed_at, issued_at, issued_by) VALUES ('bootstrap:consumed', ?, 'principal:one', 'device:one', ?, ?, ?, 'test')",
    ).bind("9".repeat(64), futureTimestamp, timestamp, timestamp).run()).resolves.toMatchObject({ success: true });
  });

  it("permits only null-bound legacy receipts and coherent device-bound snapshot receipts", async () => {
    await seedDevicePairs();
    await insertSnapshot("snapshot:valid", "principal:one", "device:one", "5");

    await expect(env.DB.prepare(
      "INSERT INTO sync_ack_receipts (receipt_id, snapshot_id, principal_id, device_id, consumer_name, expected_current, through_sequence, current_sequence, acknowledged_at, receipt_kind) VALUES ('receipt:legacy-bound', 'legacy:bound', 'principal:two', 'device:one', 'legacy', 0, 1, 1, ?, 'legacy')",
    ).bind(timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare(
      "INSERT INTO sync_ack_receipts (receipt_id, snapshot_id, principal_id, device_id, consumer_name, expected_current, through_sequence, current_sequence, acknowledged_at, receipt_kind) VALUES ('receipt:legacy-half', 'legacy:half', 'principal:one', NULL, 'legacy', 0, 1, 1, ?, 'legacy')",
    ).bind(timestamp).run()).rejects.toThrow();

    await expect(env.DB.prepare(
      "INSERT INTO sync_ack_receipts (receipt_id, snapshot_id, principal_id, device_id, consumer_name, expected_current, through_sequence, current_sequence, acknowledged_at, receipt_kind) VALUES ('receipt:legacy', 'legacy:null', NULL, NULL, 'legacy', 0, 1, 1, ?, 'legacy')",
    ).bind(timestamp).run()).resolves.toMatchObject({ success: true });
    await expect(env.DB.prepare(
      "INSERT INTO sync_ack_receipts (receipt_id, snapshot_id, principal_id, device_id, consumer_name, expected_current, through_sequence, current_sequence, acknowledged_at, receipt_kind) VALUES ('receipt:snapshot', 'snapshot:valid', 'principal:one', 'device:one', 'device:device:one', 0, 0, 0, ?, 'snapshot')",
    ).bind(timestamp).run()).resolves.toMatchObject({ success: true });
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearConversationDataForTest,
  clearOutboundCallAttemptsForTest,
} from "./migration.js";

const validHash = "0".repeat(64);
const invalidHash = "g".repeat(64);
const timestamp = "2026-08-30T00:00:00.000Z";
const futureTimestamp = "2026-08-30T00:05:00.000Z";
const expiredTimestamp = "2026-08-29T23:59:59.999Z";
const beforeExpiredTimestamp = "2026-08-29T23:59:00.000Z";

function jsonWithExactAsciiBytes(byteLength: number): string {
  const prefix = '{"value":"';
  const suffix = '"}';
  return `${prefix}${"x".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
}

async function seedDevicePairs(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:one', 'service', 'active', 'one', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:two', 'service', 'active', 'two', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES ('device:one', 'principal:one', 'key:one', ?, ?, 1, 'ed25519', 'active', 'one', ?, ?)").bind(`${"A".repeat(43)}=`, "1".repeat(64), "2".repeat(64), timestamp),
    env.DB.prepare("INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at) VALUES ('device:two', 'principal:two', 'key:two', ?, ?, 1, 'ed25519', 'active', 'two', ?, ?)").bind(`${"B".repeat(43)}=`, "3".repeat(64), "4".repeat(64), timestamp),
    env.DB.prepare("INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at) VALUES ('device:device:one', 0, ?)").bind(timestamp),
    env.DB.prepare("INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at) VALUES ('device:device:two', 0, ?)").bind(timestamp),
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
    await env.DB.prepare("DELETE FROM provider_events").run();
    await clearConversationDataForTest();
    await clearCallSessionsForTest();
    await clearAuthenticationAttemptReservationsForTest();
    await clearOutboundCallAttemptsForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM policy_decisions"),
      env.DB.prepare("DELETE FROM sync_ack_receipts"), env.DB.prepare("DELETE FROM sync_snapshots"), env.DB.prepare("DELETE FROM request_nonces"), env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"), env.DB.prepare("DELETE FROM consumer_cursors"), env.DB.prepare("DELETE FROM bootstrap_tokens"), env.DB.prepare("DELETE FROM device_keys"), env.DB.prepare("DELETE FROM principals"), env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
    ]);
  });

  it("installs the Task 4 session and hashed append-only authentication schema", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(call_sessions)").all<{
      name: string;
      notnull: number;
      pk: number;
    }>();
    const sessionId = columns.results.find((column) => column.name === "session_id");
    expect(sessionId).toMatchObject({ notnull: 1, pk: 1 });
    expect(columns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "destination_identity_id",
      "activation_challenge_id",
      "relay_setup_expires_at",
      "provider_session_id",
      "phase",
    ]));

    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_list(call_sessions)").all<{ table: string }>();
    expect(foreignKeys.results.map((key) => key.table)).toEqual(expect.arrayContaining([
      "outbound_call_attempts", "principals", "channel_identities",
    ]));
    expect(foreignKeys.results.map((key) => key.table)).not.toContain("identity_challenges");

    const authColumns = await env.DB.prepare("PRAGMA table_info(authentication_attempt_reservations)").all<{ name: string }>();
    expect(authColumns.results.map((column) => column.name)).toEqual([
      "reservation_id", "attempt_kind", "call_sid_bucket_hash", "composite_bucket_hash",
      "global_bucket_hash", "challenge_bucket_hash", "created_at", "expires_at",
    ]);
    expect(authColumns.results.map((column) => column.name).join(" ")).not.toMatch(/phone|pin|response|principal|identity|verifier/iu);

    const triggers = await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND (
        name LIKE 'call_sessions_%'
        OR name LIKE 'authentication_attempt_reservations_%'
        OR name = 'provider_events_relay_require_bound_session'
      ) ORDER BY name`).all<{ name: string }>();
    expect(triggers.results.map((trigger) => trigger.name)).toEqual(expect.arrayContaining([
      "call_sessions_immutable_lineage",
      "call_sessions_require_initial_state",
      "call_sessions_phase_transition",
      "call_sessions_provider_binding_once",
      "call_sessions_reject_delete",
      "authentication_attempt_reservations_append_only",
      "authentication_attempt_reservations_reject_delete",
      "provider_events_relay_require_bound_session",
    ]));
  });

  it("installs the Task 5 turn and dedicated delivery ledgers without channel subjects or message text", async () => {
    const turnColumns = await env.DB.prepare("PRAGMA table_info(conversation_turns)").all<{
      name: string; notnull: number; pk: number;
    }>();
    expect(turnColumns.results.map((column) => column.name)).toEqual([
      "turn_id", "session_id", "principal_id", "channel", "request_hash", "user_event_id", "state",
      "model_claim_token_hash", "model_claimed_at", "model_claim_expires_at", "resolved_at",
      "staged_delivery_id", "sent_assistant_event_id", "delivered_assistant_event_id",
      "failure_code", "failure_category", "created_at", "updated_at",
    ]);
    expect(turnColumns.results.find((column) => column.name === "turn_id"))
      .toMatchObject({ notnull: 1, pk: 1 });

    const deliveryColumns = await env.DB.prepare("PRAGMA table_info(conversation_deliveries)").all<{
      name: string; notnull: number; pk: number;
    }>();
    expect(deliveryColumns.results.map((column) => column.name)).toEqual([
      "delivery_id", "correlation_id", "turn_id", "staged_event_id", "principal_id", "target_identity_id",
      "reply_to_message_id", "history_mode", "material_hash", "provider_idempotency_key", "state",
      "attempt_count", "available_at", "lease_token_hash", "claimed_at", "lease_expires_at", "resolved_at",
      "provider_message_id", "delivered_assistant_event_id", "failure_code", "failure_category",
      "created_at", "updated_at",
    ]);
    expect(deliveryColumns.results.find((column) => column.name === "delivery_id"))
      .toMatchObject({ notnull: 1, pk: 1 });
    expect(deliveryColumns.results.map((column) => column.name).join(" "))
      .not.toMatch(/chat|provider_subject|text|payload|body|exception/iu);

    const triggers = await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND (
        name LIKE 'conversation_turns_%'
        OR name LIKE 'conversation_deliveries_%'
        OR name LIKE 'events_conversation_%'
      ) ORDER BY name`).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "conversation_turns_reject_delete",
      "conversation_turns_transition_guard",
      "conversation_turns_immutable_guard",
      "conversation_deliveries_reject_delete",
      "conversation_deliveries_transition_guard",
      "conversation_deliveries_immutable_guard",
      "conversation_deliveries_target_guard",
      "events_conversation_transition_guard",
    ]));

    const indexes = await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'conversation_%' ORDER BY name`).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "conversation_turns_principal_session_idx",
      "conversation_deliveries_available_idx",
      "conversation_deliveries_target_idx",
    ]));
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

  });

  it("enforces the 256 KiB UTF-8 event envelope bound for direct D1 writes", async () => {
    const insert = (eventId: string, envelopeJson: string) => env.DB.prepare(
      "INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES (?, 'type', 'source', 'subject', ?, ?, ?, ?, ?)",
    ).bind(eventId, timestamp, timestamp, validHash, envelopeJson, timestamp).run();

    await expect(insert("event:exact-envelope-limit", jsonWithExactAsciiBytes(262144)))
      .resolves.toMatchObject({ success: true });
    await expect(insert("event:oversized-envelope", jsonWithExactAsciiBytes(262145))).rejects.toThrow();
  });

  it("keeps archive authority global and removes only event foreign keys that block verified purge", async () => {
    const state = await env.DB.prepare(
      "SELECT singleton, sealed_through, circuit_state, circuit_reason, circuit_opened_at FROM archive_state",
    ).first();
    expect(state).toEqual({
      singleton: 1,
      sealed_through: 0,
      circuit_state: "closed",
      circuit_reason: null,
      circuit_opened_at: null,
    });

    const foreignParents = async (table: string): Promise<string[]> => {
      const rows = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{ table: string }>();
      return rows.results.map((row) => row.table);
    };
    expect(await foreignParents("idempotency_records")).not.toContain("events");
    expect(await foreignParents("policy_decisions")).not.toContain("events");
    expect(await foreignParents("outbox")).toContain("events");

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('archive_manifests', 'archive_segments', 'archive_segment_events', 'archive_purge_receipts') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "archive_manifests",
      "archive_purge_receipts",
      "archive_segment_events",
      "archive_segments",
    ]);
  });

  it("uses the named manifest overlap index for an end-sequence tail seek", async () => {
    const indexes = await env.DB.prepare("PRAGMA index_list(archive_manifests)").all<{ name: string }>();
    expect(indexes.results.map((index) => index.name)).toContain("archive_manifests_overlap_seek_idx");

    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT m.manifest_id
       FROM archive_manifests m INDEXED BY archive_manifests_overlap_seek_idx
       WHERE m.end_sequence > ? AND m.end_sequence <= ?
         AND m.start_sequence <= ? AND m.status = 'sealed'
       ORDER BY m.end_sequence ASC
       LIMIT ?`,
    ).bind(900, 1023, 1000, 100).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join("\n"))
      .toMatch(/SEARCH m USING INDEX archive_manifests_overlap_seek_idx \(end_sequence>\? AND end_sequence<\?\)/u);
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

  it("rejects an archive manifest above the 24-event physical segment cap", async () => {
    await expect(env.DB.prepare(
      "INSERT INTO archive_manifests (manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at) VALUES (?, 1, 25, 25, 'sealed', ?, ?)",
    ).bind("a".repeat(64), timestamp, timestamp).run()).rejects.toThrow();
  });

  it("reclaims expired nonce, snapshot, and identity-challenge rows before inserting replacements", async () => {
    await seedDevicePairs();
    await env.DB.prepare(
      "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, created_at, enrolled_by_device_id) VALUES ('identity:pending', 'principal:one', 'telegram', 'subject:pending', 'pending', ?, 'device:one')",
    ).bind(timestamp).run();
    await env.DB.prepare(
      "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, created_at, enrolled_by_device_id) VALUES ('identity:pending:two', 'principal:two', 'telegram', 'subject:pending:two', 'pending', ?, 'device:two')",
    ).bind(timestamp).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at) VALUES ('nonce:expired', 'device:one', 'principal:one', 'key:one', ?, 1, ?, ?, ?, ?, ?)",
      ).bind("1".repeat(64), "2".repeat(64), "3".repeat(64), expiredTimestamp, expiredTimestamp, beforeExpiredTimestamp),
      env.DB.prepare(
        "INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at) VALUES ('nonce:expired:two', 'device:two', 'principal:two', 'key:two', ?, 1, ?, ?, ?, ?, ?)",
      ).bind("3".repeat(64), "4".repeat(64), "5".repeat(64), expiredTimestamp, expiredTimestamp, beforeExpiredTimestamp),
      env.DB.prepare(
        `INSERT INTO sync_snapshots (
           snapshot_id, consumer_name, principal_id, device_id, root_snapshot_id, input_token_hash,
           output_token_hash, material_hash, root_upper_sequence, from_sequence, through_sequence,
           boundary_start_event_id, boundary_end_event_id, event_count, has_more, expires_at, created_at
         ) VALUES ('snapshot:expired', 'device:device:one', 'principal:one', 'device:one', 'snapshot:expired', NULL, ?, ?, 0, 0, 0, NULL, NULL, 0, 0, ?, ?)`,
      ).bind("6".repeat(64), "7".repeat(64), expiredTimestamp, beforeExpiredTimestamp),
      env.DB.prepare(
        `INSERT INTO sync_snapshots (
           snapshot_id, consumer_name, principal_id, device_id, root_snapshot_id, input_token_hash,
           output_token_hash, material_hash, root_upper_sequence, from_sequence, through_sequence,
           boundary_start_event_id, boundary_end_event_id, event_count, has_more, expires_at, created_at
         ) VALUES ('snapshot:expired:two', 'device:device:two', 'principal:two', 'device:two', 'snapshot:expired:two', NULL, ?, ?, 0, 0, 0, NULL, NULL, 0, 0, ?, ?)`,
      ).bind("8".repeat(64), "9".repeat(64), expiredTimestamp, beforeExpiredTimestamp),
      env.DB.prepare(
        "INSERT INTO identity_challenges (challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id, initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version, expires_at, created_at) VALUES ('challenge:expired', 'principal:one', 'identity:pending', 'telegram', 'device:one', 'key:one', ?, 1, ?, 'v1', ?, ?)",
      ).bind("1".repeat(64), "a".repeat(64), expiredTimestamp, beforeExpiredTimestamp),
      env.DB.prepare(
        "INSERT INTO identity_challenges (challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id, initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version, expires_at, created_at) VALUES ('challenge:expired:two', 'principal:two', 'identity:pending:two', 'telegram', 'device:two', 'key:two', ?, 1, ?, 'v1', ?, ?)",
      ).bind("3".repeat(64), "b".repeat(64), expiredTimestamp, beforeExpiredTimestamp),
    ]);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at) VALUES ('nonce:current', 'device:one', 'principal:one', 'key:one', ?, 1, ?, ?, ?, ?, ?)",
      ).bind("1".repeat(64), "7".repeat(64), "8".repeat(64), futureTimestamp, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO sync_snapshots (
           snapshot_id, consumer_name, principal_id, device_id, root_snapshot_id, input_token_hash,
           output_token_hash, material_hash, root_upper_sequence, from_sequence, through_sequence,
           boundary_start_event_id, boundary_end_event_id, event_count, has_more, expires_at, created_at
         ) VALUES ('snapshot:current', 'device:device:one', 'principal:one', 'device:one', 'snapshot:current', NULL, ?, ?, 0, 0, 0, NULL, NULL, 0, 0, ?, ?)`,
      ).bind("9".repeat(64), "a".repeat(64), futureTimestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO identity_challenges (challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id, initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version, expires_at, created_at) VALUES ('challenge:current', 'principal:one', 'identity:pending', 'telegram', 'device:one', 'key:one', ?, 1, ?, 'v1', ?, ?)",
      ).bind("1".repeat(64), "b".repeat(64), futureTimestamp, timestamp),
    ]);

    await expect(env.DB.prepare("SELECT nonce_id FROM request_nonces ORDER BY nonce_id").all())
      .resolves.toMatchObject({ results: [{ nonce_id: "nonce:current" }, { nonce_id: "nonce:expired:two" }] });
    await expect(env.DB.prepare("SELECT snapshot_id FROM sync_snapshots ORDER BY snapshot_id").all())
      .resolves.toMatchObject({ results: [{ snapshot_id: "snapshot:current" }, { snapshot_id: "snapshot:expired:two" }] });
    await expect(env.DB.prepare("SELECT challenge_id FROM identity_challenges ORDER BY challenge_id").all())
      .resolves.toMatchObject({ results: [{ challenge_id: "challenge:current" }, { challenge_id: "challenge:expired:two" }] });
  });

  it("caps live transient security state per enrolled device", async () => {
    await seedDevicePairs();
    await env.DB.prepare(
      "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, created_at, enrolled_by_device_id) VALUES ('identity:pending', 'principal:one', 'telegram', 'subject:pending', 'pending', ?, 'device:one')",
    ).bind(timestamp).run();

    await env.DB.prepare(
      `WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 1024)
       INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at)
       SELECT 'nonce:' || value, 'device:one', 'principal:one', 'key:one', ?, 1, printf('%064x', value), ?, ?, ?, ? FROM counter`,
    ).bind("1".repeat(64), "2".repeat(64), futureTimestamp, timestamp, timestamp).run();
    await expect(env.DB.prepare(
      "INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at) VALUES ('nonce:overflow', 'device:one', 'principal:one', 'key:one', ?, 1, ?, ?, ?, ?, ?)",
    ).bind("1".repeat(64), "f".repeat(64), "2".repeat(64), futureTimestamp, timestamp, timestamp).run())
      .rejects.toThrow(/request_nonce_capacity_exceeded/u);

    await env.DB.prepare(
      `WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 64)
       INSERT INTO sync_snapshots (
         snapshot_id, consumer_name, principal_id, device_id, root_snapshot_id, input_token_hash,
         output_token_hash, material_hash, root_upper_sequence, from_sequence, through_sequence,
         boundary_start_event_id, boundary_end_event_id, event_count, has_more, expires_at, created_at
       ) SELECT 'snapshot:' || value, 'device:device:one', 'principal:one', 'device:one', 'root:' || value, NULL,
         printf('%064x', value), ?, 0, 0, 0, NULL, NULL, 0, 0, ?, ? FROM counter`,
    ).bind("a".repeat(64), futureTimestamp, timestamp).run();
    await expect(insertSnapshot("snapshot:overflow", "principal:one", "device:one", "e"))
      .rejects.toThrow(/sync_snapshot_capacity_exceeded/u);

    await env.DB.prepare(
      `WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 8)
       INSERT INTO identity_challenges (
         challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id,
         initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version, expires_at, created_at
       ) SELECT 'challenge:' || value, 'principal:one', 'identity:pending', 'telegram', 'device:one', 'key:one',
         ?, 1, printf('%064x', value), 'v1', ?, ? FROM counter`,
    ).bind("1".repeat(64), futureTimestamp, timestamp).run();
    await expect(env.DB.prepare(
      "INSERT INTO identity_challenges (challenge_id, principal_id, identity_id, channel, initiating_device_id, initiating_key_id, initiating_key_fingerprint, initiating_key_generation, response_hmac, hmac_key_version, expires_at, created_at) VALUES ('challenge:overflow', 'principal:one', 'identity:pending', 'telegram', 'device:one', 'key:one', ?, 1, ?, 'v1', ?, ?)",
    ).bind("1".repeat(64), "f".repeat(64), futureTimestamp, timestamp).run())
      .rejects.toThrow(/identity_challenge_capacity_exceeded/u);
  });

  it("provides a bounded event-sequence seek for delivered archive reconciliation", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT m.manifest_id
       FROM outbox o INDEXED BY outbox_archive_reconcile_idx
       JOIN archive_segment_events e ON e.event_sequence = o.event_sequence
       JOIN archive_segments s ON s.segment_id = e.segment_id
       JOIN archive_manifests m ON m.manifest_id = s.manifest_id
       WHERE o.status = 'delivered' AND o.event_sequence < ?
         AND m.end_sequence < ? AND m.status = 'sealed'
       ORDER BY o.event_sequence ASC
       LIMIT 1`,
    ).bind(100, 100).all<{ detail: string }>();

    const details = plan.results.map((step) => step.detail).join("\n");
    expect(details).toMatch(/SEARCH o USING COVERING INDEX outbox_archive_reconcile_idx \(status=\? AND event_sequence<\?\)/u);
    expect(details).not.toMatch(/SCAN m/u);
  });
});

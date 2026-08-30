import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyFoundationMigration } from "./migration.js";

const validHash = "0".repeat(64);
const invalidHash = "g".repeat(64);
const timestamp = "2026-08-30T00:00:00.000Z";

describe("foundation migration hash constraints", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM archive_segments"), env.DB.prepare("DELETE FROM archive_manifests"), env.DB.prepare("DELETE FROM policy_decisions"),
      env.DB.prepare("DELETE FROM request_nonces"), env.DB.prepare("DELETE FROM device_keys"), env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"), env.DB.prepare("DELETE FROM principals"), env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
    ]);
  });

  it("rejects non-lowercase-hex values in every SHA-256 persistence column", async () => {
    await expect(env.DB.prepare("INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES ('event', 'type', 'source', 'subject', ?, ?, ?, '{}', ?)").bind(timestamp, timestamp, invalidHash, timestamp).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES ('event', 'type', 'source', 'subject', ?, ?, ?, '{}', ?)").bind(timestamp, timestamp, validHash, timestamp).run();
    await expect(env.DB.prepare("INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) VALUES ('scope', 'key', ?, 1, ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();

    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal', 'human', 'active', 'test', ?, ?)").bind(timestamp, timestamp).run();
    await expect(env.DB.prepare("INSERT INTO identity_challenges (challenge_id, principal_id, channel, provider_subject, challenge_hash, expires_at, created_at) VALUES ('challenge', 'principal', 'telegram', 'subject', ?, ?, ?)").bind(invalidHash, timestamp, timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, expires_at, issued_at, issued_by) VALUES ('bootstrap', ?, ?, ?, 'test')").bind(invalidHash, timestamp, timestamp).run()).rejects.toThrow();

    await env.DB.prepare("INSERT INTO device_keys (device_id, principal_id, key_id, public_key, algorithm, status, created_at) VALUES ('device', 'principal', 'key', 'public', 'ed25519', 'active', ?)").bind(timestamp).run();
    await expect(env.DB.prepare("INSERT INTO request_nonces (nonce_id, device_id, nonce_hash, request_hash, expires_at, consumed_at, created_at) VALUES ('nonce', 'device', ?, ?, ?, ?, ?)").bind(invalidHash, validHash, timestamp, timestamp, timestamp).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES ('decision', 'principal', 'v1', ?, 'allow', 'test', ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();

    await expect(env.DB.prepare("INSERT INTO archive_manifests (manifest_id, subject_id, from_sequence, through_sequence, content_hash, status, created_at) VALUES ('manifest', 'subject', 0, 0, ?, 'pending', ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO archive_manifests (manifest_id, subject_id, from_sequence, through_sequence, content_hash, status, created_at) VALUES ('manifest', 'subject', 0, 0, ?, 'pending', ?)").bind(validHash, timestamp).run();
    await expect(env.DB.prepare("INSERT INTO archive_segments (manifest_id, segment_index, object_key, first_sequence, last_sequence, content_hash, byte_length, created_at) VALUES ('manifest', 0, 'object', 1, 1, ?, 0, ?)").bind(invalidHash, timestamp).run()).rejects.toThrow();
  });
});

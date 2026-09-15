import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyOwnerPassphraseMigration,
  clearOwnerPassphraseDataForTest,
  clearVoiceAccessDataForTest,
} from "./migration.js";

const now = "2026-09-14T22:45:00.000Z";
const later = "2026-09-14T22:45:01.000Z";

describe("owner passphrase migration guards", () => {
  beforeEach(async () => {
    await applyOwnerPassphraseMigration();
    await clearOwnerPassphraseDataForTest();
    await clearVoiceAccessDataForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare(
        "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Sid', ?, ?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('service:foreign', 'service', 'active', 'Foreign', ?, ?)",
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO device_keys (
          device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
          algorithm, status, device_label, bootstrap_metadata_hash, created_at
        ) VALUES ('device:home', 'principal:owner', 'key:home', ?, ?, 1, 'ed25519', 'active', 'home', ?, ?)`,
      ).bind(`${"A".repeat(43)}=`, "1".repeat(64), "2".repeat(64), now),
      env.DB.prepare(
        `INSERT INTO device_keys (
          device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
          algorithm, status, device_label, bootstrap_metadata_hash, created_at
        ) VALUES ('device:foreign', 'service:foreign', 'key:foreign', ?, ?, 3, 'ed25519', 'active', 'foreign', ?, ?)`,
      ).bind(`${"B".repeat(43)}=`, "3".repeat(64), "4".repeat(64), now),
      env.DB.prepare(
        `INSERT INTO channel_identities (
          identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id
        ) VALUES ('identity:owner:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?, 'device:home')`,
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO channel_identities (
          identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
        ) VALUES ('identity:owner:telegram', 'principal:owner', 'telegram', '44112233', 'active', ?, ?)`,
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO channel_identities (
          identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
        ) VALUES ('identity:foreign:telegram', 'service:foreign', 'telegram', '99887766', 'active', ?, ?)`,
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:owner:voice', ?)",
      ).bind(now),
    ]);
  });

  afterEach(clearOwnerPassphraseDataForTest);

  function stage(
    version: number,
    status = "staged",
    at = now,
    binding: Partial<{
      ownerPrincipalId: string;
      ownerIdentityId: string;
      deviceId: string;
      keyId: string;
      keyFingerprint: string;
      keyGeneration: number;
    }> = {},
  ): D1PreparedStatement {
    return env.DB.prepare(
      `INSERT INTO owner_passphrase_verifiers (
        owner_principal_id, owner_identity_id, verifier_version, algorithm, domain_version,
        word_list_version, pepper_version, iterations, salt, digest, status,
        created_by_device_id, created_by_key_id, created_by_key_fingerprint,
        created_by_key_generation, created_at, status_changed_at
      ) VALUES (?, ?, ?,
        'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 'eff-long-cmudict-2026-09-v2',
        'v1', 600000, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      binding.ownerPrincipalId ?? "principal:owner",
      binding.ownerIdentityId ?? "identity:owner:voice",
      version,
      new Uint8Array(16).fill(version).buffer,
      new Uint8Array(32).fill(version).buffer,
      status,
      binding.deviceId ?? "device:home",
      binding.keyId ?? "key:home",
      binding.keyFingerprint ?? "1".repeat(64),
      binding.keyGeneration ?? 1,
      at,
      at,
    );
  }

  function commit(id: string, expected: number | null, next: number, at = later): D1PreparedStatement {
    return env.DB.prepare(
      `INSERT INTO owner_passphrase_rotation_commits (
        commit_id, owner_principal_id, owner_identity_id, expected_verifier_version,
        new_verifier_version, committed_at
      ) VALUES (?, 'principal:owner', 'identity:owner:voice', ?, ?, ?)`,
    ).bind(id, expected, next, at);
  }

  async function publishFirst(): Promise<void> {
    await env.DB.batch([stage(1), commit("01m2bbbbbbbbbbbbbbbbbbb001", null, 1)]);
  }

  async function acceptedDisableEvent(
    eventId: string,
    overrides: Partial<{
      text: string;
      subjectId: string;
      receivedAt: string;
      eventType: string;
      receiptScope: string;
      producerVersion: string;
    }> = {},
  ): Promise<void> {
    const text = overrides.text ?? "/disable-owner-step-up --confirm";
    const subjectId = overrides.subjectId ?? "telegram:user:44112233";
    const receivedAt = overrides.receivedAt ?? later;
    const eventType = overrides.eventType ?? "telegram.update.received";
    const receiptScope = overrides.receiptScope ?? "telegram.update";
    const producerVersion = overrides.producerVersion ?? "cloud-gateway@0.1.0";
    const envelope = {
      schemaVersion: "1.0",
      eventId,
      correlationId: eventId,
      causationId: null,
      eventType,
      source: "channel:telegram",
      producerVersion,
      subjectId,
      occurredAt: receivedAt,
      receivedAt,
      contentHash: "5".repeat(64),
      payload: { updateId: 7, principalBinding: [1], chatId: "44112233", messageId: 9, text },
    };
    const event = await env.DB.prepare(
      `INSERT INTO events (
        event_id, event_type, source, subject_id, occurred_at, received_at,
        content_hash, envelope_json, created_at
      ) VALUES (?, ?, 'channel:telegram', ?, ?, ?, ?, ?, ?) RETURNING sequence`,
    ).bind(eventId, eventType, subjectId, receivedAt, receivedAt, "5".repeat(64), JSON.stringify(envelope), receivedAt)
      .first<{ sequence: number }>();
    if (event === null) throw new Error("disable_event_insert_failed");
    await env.DB.prepare(
      "INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(receiptScope, eventId, "6".repeat(64), event.sequence, receivedAt).run();
  }

  function disable(commitId: string, eventId: string, version = 1): D1PreparedStatement {
    return env.DB.prepare(
      `INSERT INTO owner_passphrase_disable_commits (
        commit_id, owner_principal_id, owner_identity_id, expected_verifier_version,
        authorization_event_id, committed_at
      ) VALUES (?, 'principal:owner', 'identity:owner:voice', ?, ?, ?)`,
    ).bind(commitId, version, eventId, later);
  }

  it("pins the exact tables and all fourteen publication and disable triggers", async () => {
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'owner_passphrase_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
      "owner_passphrase_disable_commit_guard",
      "owner_passphrase_disable_commit_publish",
      "owner_passphrase_disable_commits_delete_forbidden",
      "owner_passphrase_disable_commits_immutable",
      "owner_passphrase_heads_delete_forbidden",
      "owner_passphrase_heads_insert_guard",
      "owner_passphrase_heads_update_guard",
      "owner_passphrase_rotation_commit_guard",
      "owner_passphrase_rotation_commit_publish",
      "owner_passphrase_rotation_commits_delete_forbidden",
      "owner_passphrase_rotation_commits_immutable",
      "owner_passphrase_verifiers_delete_forbidden",
      "owner_passphrase_verifiers_insert_guard",
      "owner_passphrase_verifiers_transition_guard",
    ]);
  });

  it("pins owner_passphrase_verifiers_insert_guard", async () => {
    await expect(stage(1, "active").run()).rejects.toThrow(/owner_passphrase_verifier_insert_invalid/u);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_passphrase_verifiers").first()).toEqual({ count: 0 });
  });

  it("pins the insert guard's owner-device binding", async () => {
    await expect(stage(1, "staged", now, {
      deviceId: "device:foreign",
      keyId: "key:foreign",
      keyFingerprint: "3".repeat(64),
      keyGeneration: 3,
    }).run()).rejects.toThrow(/owner_passphrase_verifier_insert_invalid/u);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_passphrase_verifiers").first())
      .toEqual({ count: 0 });
  });

  it("pins the insert guard's exact device-key generation", async () => {
    await expect(stage(1, "staged", now, { keyGeneration: 2 }).run())
      .rejects.toThrow(/owner_passphrase_verifier_insert_invalid/u);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_passphrase_verifiers").first())
      .toEqual({ count: 0 });
  });

  it("pins owner_passphrase_verifiers_transition_guard", async () => {
    await stage(1).run();
    await expect(env.DB.prepare(
      "UPDATE owner_passphrase_verifiers SET digest = ? WHERE owner_identity_id = 'identity:owner:voice' AND verifier_version = 1",
    ).bind(new Uint8Array(32).fill(9).buffer).run()).rejects.toThrow(/owner_passphrase_verifier_transition_invalid/u);
  });

  it("pins owner_passphrase_verifiers_delete_forbidden", async () => {
    await stage(1).run();
    await expect(env.DB.prepare("DELETE FROM owner_passphrase_verifiers").run())
      .rejects.toThrow(/owner_passphrase_verifier_delete_forbidden/u);
  });

  it("pins owner_passphrase_rotation_commit_guard", async () => {
    await stage(1).run();
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:home'")
      .bind(later).run();
    await expect(commit("01m2bbbbbbbbbbbbbbbbbbb002", null, 1).run())
      .rejects.toThrow(/owner_passphrase_rotation_state_changed/u);
    expect(await env.DB.prepare("SELECT status FROM owner_passphrase_verifiers").first()).toEqual({ status: "staged" });
  });

  it("pins the explicit no-second-first-commit branch in the rotation guard", async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'owner_passphrase_rotation_commit_guard'",
    ).first<{ sql: string }>();
    expect(row?.sql).toContain(
      "NEW.expected_verifier_version IS NULL AND EXISTS (SELECT 1 FROM owner_passphrase_heads)",
    );
  });

  it("pins owner_passphrase_rotation_commit_publish", async () => {
    await env.DB.batch([stage(1), commit("01m2bbbbbbbbbbbbbbbbbbb003", null, 1)]);
    expect(await env.DB.prepare("SELECT verifier_version, status FROM owner_passphrase_heads").first())
      .toEqual({ verifier_version: 1, status: "active" });
    expect(await env.DB.prepare("SELECT status FROM owner_passphrase_verifiers").first()).toEqual({ status: "active" });
  });

  it("pins owner_passphrase_rotation_commits_immutable", async () => {
    await publishFirst();
    await expect(env.DB.prepare("UPDATE owner_passphrase_rotation_commits SET committed_at = ?").bind(now).run())
      .rejects.toThrow(/owner_passphrase_rotation_commit_immutable/u);
  });

  it("pins owner_passphrase_rotation_commits_delete_forbidden", async () => {
    await publishFirst();
    await expect(env.DB.prepare("DELETE FROM owner_passphrase_rotation_commits").run())
      .rejects.toThrow(/owner_passphrase_rotation_commit_delete_forbidden/u);
  });

  it("pins owner_passphrase_heads_insert_guard", async () => {
    await stage(1).run();
    await expect(env.DB.prepare(
      `INSERT INTO owner_passphrase_heads (
        singleton_id, owner_principal_id, owner_identity_id, verifier_version, status, updated_at
      ) VALUES (1, 'principal:owner', 'identity:owner:voice', 1, 'active', ?)`,
    ).bind(later).run()).rejects.toThrow(/owner_passphrase_head_insert_invalid/u);
  });

  it("pins owner_passphrase_heads_update_guard", async () => {
    await publishFirst();
    await stage(2, "staged", later).run();
    await expect(env.DB.prepare(
      "UPDATE owner_passphrase_heads SET verifier_version = 2, updated_at = ? WHERE singleton_id = 1",
    ).bind(later).run()).rejects.toThrow(/owner_passphrase_head_update_invalid/u);
  });

  it("pins owner_passphrase_heads_delete_forbidden", async () => {
    await publishFirst();
    await expect(env.DB.prepare("DELETE FROM owner_passphrase_heads").run())
      .rejects.toThrow(/owner_passphrase_head_delete_forbidden/u);
  });

  it("pins owner_passphrase_disable_commit_guard to an exact confirmed owner Telegram event", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb101";
    await acceptedDisableEvent(eventId, { text: "/disable-owner-step-up" });
    await expect(disable("01m2bbbbbbbbbbbbbbbbbbb102", eventId).run())
      .rejects.toThrow(/owner_passphrase_disable_state_changed/u);
    expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first())
      .toEqual({ status: "active" });
  });

  it("refuses an exact disable command from a different Telegram principal", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb112";
    await acceptedDisableEvent(eventId, { subjectId: "telegram:user:99887766" });
    await expect(disable("01m2bbbbbbbbbbbbbbbbbbb113", eventId).run())
      .rejects.toThrow(/owner_passphrase_disable_state_changed/u);
    expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first())
      .toEqual({ status: "active" });
  });

  it("keeps owner disable recovery valid across gateway producer-version changes", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb114";
    await acceptedDisableEvent(eventId, { producerVersion: "cloud-gateway@9.0.0" });
    await disable("01m2bbbbbbbbbbbbbbbbbbb115", eventId).run();
    expect(await env.DB.prepare("SELECT status FROM owner_passphrase_heads").first())
      .toEqual({ status: "disabled" });
  });

  it("refuses a disable receipt more than five minutes after its accepted event", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb116";
    await acceptedDisableEvent(eventId, { receivedAt: "2026-09-14T22:39:59.000Z" });
    await expect(disable("01m2bbbbbbbbbbbbbbbbbbb117", eventId).run())
      .rejects.toThrow(/owner_passphrase_disable_state_changed/u);
  });

  it("refuses a disable event without a telegram.update receipt", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb118";
    await acceptedDisableEvent(eventId, { receiptScope: "telegram:update" });
    await expect(disable("01m2bbbbbbbbbbbbbbbbbbb119", eventId).run())
      .rejects.toThrow(/owner_passphrase_disable_state_changed/u);
  });

  it("refuses a disable event whose type is not telegram.update.received", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb120";
    await acceptedDisableEvent(eventId, { eventType: "telegram.message.received" });
    await expect(disable("01m2bbbbbbbbbbbbbbbbbbb121", eventId).run())
      .rejects.toThrow(/owner_passphrase_disable_state_changed/u);
  });

  it("refuses an active Telegram identity whose verification marker is missing", async () => {
    await publishFirst();
    await env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
    try {
      await env.DB.prepare(
        "UPDATE channel_identities SET verified_at = NULL WHERE identity_id = 'identity:owner:telegram'",
      ).run();
    } finally {
      await env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
    }
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb122";
    await acceptedDisableEvent(eventId);
    await expect(disable("01m2bbbbbbbbbbbbbbbbbbb123", eventId).run())
      .rejects.toThrow(/owner_passphrase_disable_state_changed/u);
  });

  it.each([
    {
      component: "head",
      guard: "owner_passphrase_heads_update_guard",
      update: "UPDATE owner_passphrase_heads SET status = 'disabled', updated_at = ?",
      eventId: "01m2bbbbbbbbbbbbbbbbbbb124",
      commitId: "01m2bbbbbbbbbbbbbbbbbbb125",
    },
    {
      component: "current verifier",
      guard: "owner_passphrase_verifiers_transition_guard",
      update: "UPDATE owner_passphrase_verifiers SET status = 'revoked', status_changed_at = ?",
      eventId: "01m2bbbbbbbbbbbbbbbbbbb126",
      commitId: "01m2bbbbbbbbbbbbbbbbbbb127",
    },
  ])("refuses disable when the $component is not active", async ({ guard, update, eventId, commitId }) => {
    await publishFirst();
    const installed = await env.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).bind(guard).first<{ sql: string }>();
    if (installed === null) throw new Error("owner_passphrase_test_guard_missing");
    await env.DB.prepare(`DROP TRIGGER ${guard}`).run();
    try {
      await env.DB.prepare(update).bind(later).run();
    } finally {
      await env.DB.prepare(installed.sql).run();
    }
    await acceptedDisableEvent(eventId);
    await expect(disable(commitId, eventId).run())
      .rejects.toThrow(/owner_passphrase_disable_state_changed/u);
  });

  it("pins owner_passphrase_disable_commit_publish", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb103";
    await acceptedDisableEvent(eventId);
    await disable("01m2bbbbbbbbbbbbbbbbbbb104", eventId).run();
    expect(await env.DB.prepare("SELECT verifier_version, status FROM owner_passphrase_heads").first())
      .toEqual({ verifier_version: 1, status: "disabled" });
    expect(await env.DB.prepare("SELECT status FROM owner_passphrase_verifiers").first())
      .toEqual({ status: "revoked" });
  });

  it("pins owner_passphrase_disable_commits_immutable", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb105";
    await acceptedDisableEvent(eventId);
    await disable("01m2bbbbbbbbbbbbbbbbbbb106", eventId).run();
    await expect(env.DB.prepare("UPDATE owner_passphrase_disable_commits SET committed_at = ?").bind(now).run())
      .rejects.toThrow(/owner_passphrase_disable_commit_immutable/u);
  });

  it("pins owner_passphrase_disable_commits_delete_forbidden", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb107";
    await acceptedDisableEvent(eventId);
    await disable("01m2bbbbbbbbbbbbbbbbbbb108", eventId).run();
    await expect(env.DB.prepare("DELETE FROM owner_passphrase_disable_commits").run())
      .rejects.toThrow(/owner_passphrase_disable_commit_delete_forbidden/u);
  });

  it("re-enables only by rotating a disabled head to a new device-generated verifier", async () => {
    await publishFirst();
    const eventId = "01m2bbbbbbbbbbbbbbbbbbb109";
    await acceptedDisableEvent(eventId);
    await disable("01m2bbbbbbbbbbbbbbbbbbb110", eventId).run();
    await env.DB.batch([stage(2, "staged", later), commit("01m2bbbbbbbbbbbbbbbbbbb111", 1, 2, later)]);
    expect((await env.DB.prepare(
      "SELECT verifier_version, status FROM owner_passphrase_verifiers ORDER BY verifier_version",
    ).all()).results).toEqual([
      { verifier_version: 1, status: "superseded" },
      { verifier_version: 2, status: "active" },
    ]);
    expect(await env.DB.prepare("SELECT verifier_version, status FROM owner_passphrase_heads").first())
      .toEqual({ verifier_version: 2, status: "active" });
  });

  it("publishes only the next version and leaves the old verifier immutable", async () => {
    await publishFirst();
    await env.DB.batch([stage(2, "staged", later), commit("01m2bbbbbbbbbbbbbbbbbbb004", 1, 2, later)]);
    expect((await env.DB.prepare(
      "SELECT verifier_version, status FROM owner_passphrase_verifiers ORDER BY verifier_version",
    ).all()).results).toEqual([
      { verifier_version: 1, status: "superseded" },
      { verifier_version: 2, status: "active" },
    ]);
    expect(await env.DB.prepare("SELECT verifier_version FROM owner_passphrase_heads").first())
      .toEqual({ verifier_version: 2 });
    await stage(3, "staged", later).run();
    await expect(commit("01m2bbbbbbbbbbbbbbbbbbb005", 1, 2, later).run())
      .rejects.toThrow(/owner_passphrase_rotation_state_changed/u);
  });
});

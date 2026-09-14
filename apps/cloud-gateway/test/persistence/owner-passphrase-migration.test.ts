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
        `INSERT INTO device_keys (
          device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
          algorithm, status, device_label, bootstrap_metadata_hash, created_at
        ) VALUES ('device:home', 'principal:owner', 'key:home', ?, ?, 1, 'ed25519', 'active', 'home', ?, ?)`,
      ).bind(`${"A".repeat(43)}=`, "1".repeat(64), "2".repeat(64), now),
      env.DB.prepare(
        `INSERT INTO channel_identities (
          identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id
        ) VALUES ('identity:owner:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?, 'device:home')`,
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:owner:voice', ?)",
      ).bind(now),
    ]);
  });

  afterEach(clearOwnerPassphraseDataForTest);

  function stage(version: number, status = "staged", at = now): D1PreparedStatement {
    return env.DB.prepare(
      `INSERT INTO owner_passphrase_verifiers (
        owner_principal_id, owner_identity_id, verifier_version, algorithm, domain_version,
        word_list_version, pepper_version, iterations, salt, digest, status,
        created_by_device_id, created_by_key_id, created_by_key_fingerprint,
        created_by_key_generation, created_at, status_changed_at
      ) VALUES ('principal:owner', 'identity:owner:voice', ?,
        'hmac-sha256-pepper+pbkdf2-hmac-sha256', 'v1', 'eff-long-cmudict-2026-09-v1',
        'v1', 600000, ?, ?, ?, 'device:home', 'key:home', ?, 1, ?, ?)`,
    ).bind(version, new Uint8Array(16).fill(version).buffer, new Uint8Array(32).fill(version).buffer,
      status, "1".repeat(64), at, at);
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

  it("pins the exact tables and all ten publication triggers", async () => {
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'owner_passphrase_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
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

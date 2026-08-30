import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DeviceRepository } from "../../src/persistence/device-repository.js";
import { applyFoundationMigration } from "./migration.js";

const now = "2026-08-30T12:00:00.000Z";

describe("DeviceRepository Telegram identity lookup", () => {
  let repository: DeviceRepository;

  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_ack_receipts"),
      env.DB.prepare("DELETE FROM sync_snapshots"),
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:one', 'human', 'active', 'Sid', ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare(
      "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:telegram', 'principal:one', 'telegram', '424242', 'active', ?, ?)",
    ).bind(now, now).run();
    repository = new DeviceRepository(env.DB);
  });

  it("returns only opaque internal IDs and principal type for an exact active verified Telegram identity", async () => {
    const before = await env.DB.prepare("SELECT status, verified_at FROM channel_identities WHERE identity_id = 'identity:telegram'").first();

    const identity = await repository.findActiveVerifiedTelegramIdentity("424242");

    expect(identity).toEqual({ identityId: "identity:telegram", principalId: "principal:one", principalType: "human" });
    expect(Object.keys(identity ?? {})).toEqual(["identityId", "principalId", "principalType"]);
    expect(JSON.stringify(identity)).not.toContain("424242");
    expect(await env.DB.prepare("SELECT status, verified_at FROM channel_identities WHERE identity_id = 'identity:telegram'").first()).toEqual(before);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM identity_challenges").first<{ count: number }>())?.count).toBe(0);
  });

  it("returns no authorization for pending, disabled, or inactive-principal rows", async () => {
    await env.DB.prepare("UPDATE channel_identities SET status = 'pending', verified_at = NULL WHERE identity_id = 'identity:telegram'").run();
    await expect(repository.findActiveVerifiedTelegramIdentity("424242")).resolves.toBeNull();
    await env.DB.prepare("UPDATE channel_identities SET status = 'disabled', verified_at = ? WHERE identity_id = 'identity:telegram'").bind(now).run();
    await expect(repository.findActiveVerifiedTelegramIdentity("424242")).resolves.toBeNull();
    await env.DB.prepare("UPDATE channel_identities SET status = 'active', verified_at = ? WHERE identity_id = 'identity:telegram'").bind(now).run();
    await env.DB.prepare("UPDATE principals SET status = 'disabled' WHERE principal_id = 'principal:one'").run();
    await expect(repository.findActiveVerifiedTelegramIdentity("424242")).resolves.toBeNull();
  });

  it("uses exact provider-subject equality and preserves service-principal distinction", async () => {
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('service:one', 'service', 'active', 'service', ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare(
      "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:service', 'service:one', 'telegram', '4242420', 'active', ?, ?)",
    ).bind(now, now).run();

    await expect(repository.findActiveVerifiedTelegramIdentity("424242")).resolves.toEqual({
      identityId: "identity:telegram", principalId: "principal:one", principalType: "human",
    });
    await expect(repository.findActiveVerifiedTelegramIdentity("4242420")).resolves.toEqual({
      identityId: "identity:service", principalId: "service:one", principalType: "service",
    });
  });

  it.each(["", "0424242", "424242\n1", "not-a-telegram-id", "1".repeat(21)])("rejects malformed Telegram provider subject %j", async (subject) => {
    await expect(repository.findActiveVerifiedTelegramIdentity(subject)).rejects.toThrow("telegram_provider_subject_invalid");
  });

  it("proves an exact active current device tuple belongs to a human principal", async () => {
    const humanFingerprint = "1".repeat(64);
    await env.DB.prepare(
      `INSERT INTO device_keys (
         device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
         algorithm, status, device_label, bootstrap_metadata_hash, created_at
       ) VALUES ('device:human', 'principal:one', 'key:human', ?, ?, 2, 'ed25519', 'active', 'human', ?, ?)`,
    ).bind(`${"A".repeat(43)}=`, humanFingerprint, "2".repeat(64), now).run();
    await env.DB.prepare(
      "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('service:one', 'service', 'active', 'service', ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare(
      `INSERT INTO device_keys (
         device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
         algorithm, status, device_label, bootstrap_metadata_hash, created_at
       ) VALUES ('device:service', 'service:one', 'key:service', ?, ?, 1, 'ed25519', 'active', 'service', ?, ?)`,
    ).bind(`${"B".repeat(43)}=`, "3".repeat(64), "4".repeat(64), now).run();
    const verifiedHuman = {
      deviceId: "device:human",
      principalId: "principal:one",
      keyId: "key:human",
      keyFingerprint: humanFingerprint,
      keyGeneration: 2,
    };
    const verifiedService = {
      deviceId: "device:service",
      principalId: "service:one",
      keyId: "key:service",
      keyFingerprint: "3".repeat(64),
      keyGeneration: 1,
    };

    await expect(repository.isCurrentHumanDevice(verifiedHuman as never)).resolves.toBe(true);
    await expect(repository.isCurrentHumanDevice(verifiedService as never)).resolves.toBe(false);
    await expect(repository.isCurrentHumanDevice({ ...verifiedHuman, keyId: "key:wrong" } as never)).resolves.toBe(false);
    await expect(repository.isCurrentHumanDevice({ ...verifiedHuman, keyFingerprint: "9".repeat(64) } as never)).resolves.toBe(false);
    await expect(repository.isCurrentHumanDevice({ ...verifiedHuman, keyGeneration: 1 } as never)).resolves.toBe(false);
    await env.DB.prepare("UPDATE principals SET status = 'disabled' WHERE principal_id = 'principal:one'").run();
    await expect(repository.isCurrentHumanDevice(verifiedHuman as never)).resolves.toBe(false);
    await env.DB.prepare("UPDATE principals SET status = 'active' WHERE principal_id = 'principal:one'").run();
    await env.DB.prepare("UPDATE device_keys SET status = 'revoked', revoked_at = ? WHERE device_id = 'device:human'").bind(now).run();
    await expect(repository.isCurrentHumanDevice(verifiedHuman as never)).resolves.toBe(false);
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../../packages/contracts/src/index.js";
import { DeviceEnrollment, type DeviceEnrollmentIdFactory } from "../../src/sync/device-enrollment.js";
import { applyFoundationMigration } from "../persistence/migration.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const pinVerifierJson = JSON.stringify({
  schemaVersion: "1.0",
  algorithm: "pbkdf2-hmac-sha256",
  iterations: 600_000,
  saltBase64: btoa(String.fromCharCode(...Uint8Array.from({ length: 16 }, (_, index) => index + 11))),
  digestBase64: btoa(String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, index) => index + 31))),
});

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const token = base64Url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const secondToken = base64Url(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
const publicKeyBase64 = btoa(String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, index) => index)));

function ids(prefix = "first"): DeviceEnrollmentIdFactory {
  return {
    principalId: () => `principal:${prefix}`,
    deviceId: () => `device:${prefix}`,
    keyId: () => `key:${prefix}`,
    phoneIdentityId: () => `identity:${prefix}:voice`,
    telegramIdentityId: () => `identity:${prefix}:telegram`,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0" as const,
    bootstrapToken: token,
    displayName: "Sid",
    deviceLabel: "Jarvis laptop",
    publicKeyBase64,
    phoneProviderSubject: "+14165550123",
    telegramProviderSubject: "424242",
    ...overrides,
  };
}

async function provision(plaintextToken = token, expiresAt = "2026-08-30T12:15:00.000Z", id = "bootstrap:first") {
  const padding = "=".repeat((4 - plaintextToken.length % 4) % 4);
  const tokenBytes = Uint8Array.from(atob(plaintextToken.replaceAll("-", "+").replaceAll("_", "/") + padding), (character) => character.charCodeAt(0));
  await env.DB.prepare(
    "INSERT INTO bootstrap_tokens (bootstrap_token_id, token_hash, expires_at, issued_at, intended_channel, device_label, issued_by) VALUES (?, ?, ?, ?, 'local', 'Jarvis laptop', 'setup')",
  ).bind(id, await sha256Hex(tokenBytes), expiresAt, now.toISOString()).run();
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? -1;
}

describe("DeviceEnrollment", () => {
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
  });

  function service(overrides: Partial<ConstructorParameters<typeof DeviceEnrollment>[0]> = {}) {
    return new DeviceEnrollment({ database: env.DB, pinVerifierJson, now: () => now, ids: ids(), ...overrides });
  }

  it("atomically consumes one exact 256-bit token and creates the sole human, current device key, pending identities, and cursor", async () => {
    await provision();

    const enrolled = await service().bootstrap(input());

    expect(enrolled).toEqual({
      principalId: "principal:first",
      deviceId: "device:first",
      keyId: "key:first",
      keyGeneration: 1,
      phoneIdentityId: "identity:first:voice",
      telegramIdentityId: "identity:first:telegram",
      recovered: false,
    });
    expect(await env.DB.prepare("SELECT principal_type, status, pin_verifier_version, pin_verifier_secret_ref FROM principals").first()).toEqual({
      principal_type: "human", status: "active", pin_verifier_version: "1.0", pin_verifier_secret_ref: "PIN_VERIFIER_JSON",
    });
    expect(await env.DB.prepare("SELECT status, key_generation, public_key_base64, device_label FROM device_keys").first()).toEqual({
      status: "active", key_generation: 1, public_key_base64: publicKeyBase64, device_label: "Jarvis laptop",
    });
    expect(await env.DB.prepare("SELECT channel, status, enrolled_by_device_id FROM channel_identities ORDER BY channel").all()).toMatchObject({ results: [
      { channel: "telegram", status: "pending", enrolled_by_device_id: "device:first" },
      { channel: "voice", status: "pending", enrolled_by_device_id: "device:first" },
    ] });
    expect(await env.DB.prepare("SELECT current_sequence FROM consumer_cursors WHERE consumer_name = 'device:device:first'").first()).toEqual({ current_sequence: 0 });
    expect(await env.DB.prepare("SELECT consumed_at, principal_id, device_id FROM bootstrap_tokens").first()).toEqual({
      consumed_at: now.toISOString(), principal_id: "principal:first", device_id: "device:first",
    });
  });

  it.each([
    ["wrong token", base64Url(Uint8Array.from({ length: 32 }, () => 99)), "2026-08-30T12:15:00.000Z"],
    ["expired token", token, "2026-08-30T11:59:59.999Z"],
    ["expiry equality", token, now.toISOString()],
  ])("rejects a %s without mutating enrollment state", async (_label, presented, expiresAt) => {
    await provision(token, expiresAt);

    await expect(service().bootstrap(input({ bootstrapToken: presented }))).rejects.toThrow("bootstrap_token_invalid");

    expect(await count("principals")).toBe(0);
    expect(await count("device_keys")).toBe(0);
    expect((await env.DB.prepare("SELECT consumed_at FROM bootstrap_tokens").first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();
  });

  it("rejects malformed, short, and noncanonical bootstrap tokens before querying them", async () => {
    await provision();
    for (const malformed of ["short", `${token}=`, `${token.slice(0, -1)}B`, "!".repeat(43)]) {
      await expect(service().bootstrap(input({ bootstrapToken: malformed }))).rejects.toThrow("bootstrap_token_invalid");
    }
    expect((await env.DB.prepare("SELECT consumed_at FROM bootstrap_tokens").first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();
  });

  it("rejects replay and concurrent reuse so only one bootstrap can commit", async () => {
    await provision();
    const enrollment = service();
    const [first, second] = await Promise.allSettled([enrollment.bootstrap(input()), enrollment.bootstrap(input())]);

    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    await expect(enrollment.bootstrap(input())).rejects.toThrow("bootstrap_token_invalid");
    expect(await count("principals")).toBe(1);
    expect(await count("device_keys")).toBe(1);
  });

  it("rolls back token consumption and every enrollment row when a later statement fails", async () => {
    await env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('service:existing', 'service', 'active', 'existing', ?, ?)")
      .bind(now.toISOString(), now.toISOString()).run();
    await env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:existing', 'service:existing', 'telegram', '424242', 'active', ?, ?, NULL)")
      .bind(now.toISOString(), now.toISOString()).run();
    await provision();

    await expect(service().bootstrap(input())).rejects.toThrow();

    expect(await count("device_keys")).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM principals WHERE principal_type = 'human'").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT consumed_at FROM bootstrap_tokens").first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();
  });

  it("spends the token after a committed response is lost", async () => {
    await provision();
    const lost = service({ afterCommit: () => { throw new Error("response_lost"); } });

    await expect(lost.bootstrap(input())).rejects.toThrow("response_lost");

    expect(await count("principals")).toBe(1);
    expect((await env.DB.prepare("SELECT consumed_at FROM bootstrap_tokens").first<{ consumed_at: string | null }>())?.consumed_at).toBe(now.toISOString());
    await expect(service().bootstrap(input())).rejects.toThrow("bootstrap_token_invalid");
  });

  it("recovers stable IDs with a new token, the retained public key, and identical metadata", async () => {
    await provision();
    await expect(service({ afterCommit: () => { throw new Error("response_lost"); } }).bootstrap(input())).rejects.toThrow("response_lost");
    await provision(secondToken, "2026-08-30T12:15:00.000Z", "bootstrap:recovery");

    const recovered = await service({ ids: ids("different") }).bootstrap(input({ bootstrapToken: secondToken }));

    expect(recovered).toMatchObject({ principalId: "principal:first", deviceId: "device:first", keyId: "key:first", recovered: true });
    expect(await count("principals")).toBe(1);
    expect(await count("device_keys")).toBe(1);
    expect((await env.DB.prepare("SELECT consumed_at FROM bootstrap_tokens WHERE bootstrap_token_id = 'bootstrap:recovery'").first<{ consumed_at: string | null }>())?.consumed_at).toBe(now.toISOString());
  });

  it("recovers the identities matching the bootstrap metadata when the device has decoy identities", async () => {
    await provision();
    await service().bootstrap(input());
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:decoy:voice', 'principal:first', 'voice', '+12025550123', 'pending', NULL, ?, 'device:first')",
      ).bind(now.toISOString()),
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:decoy:telegram', 'principal:first', 'telegram', '111111', 'pending', NULL, ?, 'device:first')",
      ).bind(now.toISOString()),
    ]);
    // Make the decoys older than the canonical rows so the unconstrained query
    // deterministically reproduces the original cross-product bug.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM channel_identities WHERE identity_id IN ('identity:first:voice', 'identity:first:telegram')"),
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:first:voice', 'principal:first', 'voice', '+14165550123', 'pending', NULL, ?, 'device:first')",
      ).bind(now.toISOString()),
      env.DB.prepare(
        "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('identity:first:telegram', 'principal:first', 'telegram', '424242', 'pending', NULL, ?, 'device:first')",
      ).bind(now.toISOString()),
    ]);
    await provision(secondToken, "2026-08-30T12:15:00.000Z", "bootstrap:recovery");

    const recovered = await service({ ids: ids("different") }).bootstrap(input({ bootstrapToken: secondToken }));

    expect(recovered).toMatchObject({
      phoneIdentityId: "identity:first:voice",
      telegramIdentityId: "identity:first:telegram",
      recovered: true,
    });
  });

  it.each([
    ["device label", { deviceLabel: "different laptop" }],
    ["phone subject", { phoneProviderSubject: "+14165550999" }],
    ["Telegram subject", { telegramProviderSubject: "999999" }],
  ])("denies recovery with a conflicting %s and leaves the new token usable", async (_label, changedMetadata) => {
    await provision();
    await service().bootstrap(input());
    await provision(secondToken, "2026-08-30T12:15:00.000Z", "bootstrap:recovery");

    await expect(service({ ids: ids("different") }).bootstrap(input({ bootstrapToken: secondToken, ...changedMetadata }))).rejects.toThrow("bootstrap_recovery_conflict");

    expect((await env.DB.prepare("SELECT consumed_at FROM bootstrap_tokens WHERE bootstrap_token_id = 'bootstrap:recovery'").first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();
  });

  it("validates the injected PIN verifier schema before any mutation", async () => {
    await provision();
    const salt = btoa(String.fromCharCode(...new Uint8Array(16)));
    const digest = btoa(String.fromCharCode(...new Uint8Array(32)));
    for (const invalid of [
      "not-json", "{}",
      JSON.stringify({ schemaVersion: "2.0", algorithm: "pbkdf2-hmac-sha256", iterations: 600_000, saltBase64: salt, digestBase64: digest }),
      JSON.stringify({ schemaVersion: "1.0", algorithm: "plain", iterations: 600_000, saltBase64: salt, digestBase64: digest }),
      JSON.stringify({ schemaVersion: "1.0", algorithm: "pbkdf2-hmac-sha256", iterations: 599_999, saltBase64: salt, digestBase64: digest }),
      JSON.stringify({ schemaVersion: "1.0", algorithm: "pbkdf2-hmac-sha256", iterations: 600_000, saltBase64: btoa("short"), digestBase64: digest }),
    ]) {
      await expect(service({ pinVerifierJson: invalid }).bootstrap(input())).rejects.toThrow("pin_verifier_invalid");
    }
    expect((await env.DB.prepare("SELECT consumed_at FROM bootstrap_tokens").first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();
    expect(await count("principals")).toBe(0);
  });

  it("never persists the plaintext bootstrap token or PIN verifier", async () => {
    await provision();
    await service().bootstrap(input());
    const dump = await env.DB.prepare("SELECT token_hash, issued_by, device_label FROM bootstrap_tokens").all();
    const principal = await env.DB.prepare("SELECT pin_verifier_version, pin_verifier_secret_ref FROM principals").all();

    expect(JSON.stringify([dump.results, principal.results])).not.toContain(token);
    expect(JSON.stringify([dump.results, principal.results])).not.toContain("digestBase64");
    expect(JSON.stringify(principal.results)).toContain("PIN_VERIFIER_JSON");
  });
});

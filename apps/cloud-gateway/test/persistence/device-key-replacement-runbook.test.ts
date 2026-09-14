import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import insertReplacementSql from "../../operations/insert-replacement-device-key.sql?raw";
import revokeReplacedSql from "../../operations/revoke-replaced-device-key.sql?raw";
import runbook from "../../../../docs/runbooks/device-key-replacement.md?raw";
import { applyFoundationMigration, splitMigration } from "./migration.js";

const OLD_DEVICE_ID = "device:old";
const PRINCIPAL_ID = "principal:owner";
const NOW = "2026-09-14T03:00:00.000Z";

const replacement = Object.freeze({
  NEW_DEVICE_ID: "device:11111111-1111-4111-8111-111111111111",
  NEW_KEY_ID: "key:22222222-2222-4222-8222-222222222222",
  NEW_PUBLIC_KEY_BASE64: btoa(String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, index) => index))),
  NEW_KEY_FINGERPRINT: "a".repeat(64),
  NEW_BOOTSTRAP_METADATA_HASH: "b".repeat(64),
});

function render(template: string, values = replacement): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`__${name}__`, value);
  }
  expect(rendered).not.toMatch(/__[A-Z0-9_]+__/u);
  return rendered;
}

async function execute(template: string, values = replacement): Promise<void> {
  const statements = splitMigration(render(template, values));
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

function documentedSql(variable: string): string {
  const match = new RegExp(`\\$${variable} = @'\\r?\\n([\\s\\S]*?)\\r?\\n'@`, "u").exec(runbook);
  if (match?.[1] === undefined) throw new Error(`missing documented SQL block: ${variable}`);
  return match[1].replaceAll("__NEW_DEVICE_ID__", replacement.NEW_DEVICE_ID);
}

async function executeReadOnly(sql: string): Promise<void> {
  await env.DB.batch(splitMigration(sql).map((statement) => env.DB.prepare(statement)));
}

async function seedOwner(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'human', 'active', 'Sid', ?, ?)",
  ).bind(PRINCIPAL_ID, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO device_keys
      (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
       algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at)
     VALUES (?, ?, 'key:old', ?, ?, 1, 'ed25519', 'active', 'jarvis-local-agent', ?, ?, NULL)`,
  ).bind(
    OLD_DEVICE_ID,
    PRINCIPAL_ID,
    btoa("o".repeat(32)),
    "c".repeat(64),
    "d".repeat(64),
    NOW,
  ).run();
  await env.DB.prepare(
    "INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at) VALUES (?, 17, ?)",
  ).bind(`device:${OLD_DEVICE_ID}`, NOW).run();
}

async function deviceRows(): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    `SELECT device_id, principal_id, key_id, public_key_base64, key_fingerprint,
            key_generation, algorithm, status, device_label, bootstrap_metadata_hash, revoked_at
     FROM device_keys ORDER BY device_id`,
  ).all<Record<string, unknown>>();
  return rows.results;
}

describe("owner device-key replacement runbook SQL", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_ack_receipts"),
      env.DB.prepare("DELETE FROM sync_snapshots"),
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
    ]);
    await seedOwner();
  });

  it("inserts the exact replacement and its sync cursor without revoking the old device", async () => {
    await execute(insertReplacementSql);

    expect(await deviceRows()).toEqual([
      expect.objectContaining({
        device_id: replacement.NEW_DEVICE_ID,
        principal_id: PRINCIPAL_ID,
        key_id: replacement.NEW_KEY_ID,
        public_key_base64: replacement.NEW_PUBLIC_KEY_BASE64,
        key_fingerprint: replacement.NEW_KEY_FINGERPRINT,
        key_generation: 1,
        algorithm: "ed25519",
        status: "active",
        device_label: "jarvis-home-pc",
        bootstrap_metadata_hash: replacement.NEW_BOOTSTRAP_METADATA_HASH,
        revoked_at: null,
      }),
      expect.objectContaining({ device_id: OLD_DEVICE_ID, status: "active", revoked_at: null }),
    ]);
    expect(await env.DB.prepare(
      "SELECT current_sequence FROM consumer_cursors WHERE consumer_name = ?",
    ).bind(`device:${replacement.NEW_DEVICE_ID}`).first()).toEqual({ current_sequence: 0 });
  });

  it("keeps every documented read-only check executable against the deployed schema", async () => {
    await executeReadOnly(documentedSql("Precheck"));
    await executeReadOnly(documentedSql("OldDevice"));
    await executeReadOnly(documentedSql("References"));
    await execute(insertReplacementSql);
    await executeReadOnly(documentedSql("AfterInsert"));
    await execute(revokeReplacedSql);
    await executeReadOnly(documentedSql("FinalCheck"));
  });

  it("is idempotent when the exact replacement was already inserted", async () => {
    await execute(insertReplacementSql);
    await execute(insertReplacementSql);

    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_keys").first()).toEqual({ count: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM consumer_cursors").first()).toEqual({ count: 2 });
  });

  it("refuses insertion when the owner already has more than one active device", async () => {
    await env.DB.prepare(
      `INSERT INTO device_keys
        (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
         algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at)
       VALUES ('device:unexpected', ?, 'key:unexpected', ?, ?, 1, 'ed25519', 'active',
               'unexpected-device', ?, ?, NULL)`,
    ).bind(PRINCIPAL_ID, btoa("u".repeat(32)), "e".repeat(64), "f".repeat(64), NOW).run();

    await execute(insertReplacementSql);

    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM device_keys WHERE device_id = ?",
    ).bind(replacement.NEW_DEVICE_ID).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM device_keys WHERE status = 'active'",
    ).first()).toEqual({ count: 2 });
  });

  it("safely refuses a public-material collision instead of partially inserting", async () => {
    await env.DB.prepare(
      `INSERT INTO device_keys
        (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
         algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at)
       VALUES ('device:retired', ?, ?, ?, ?, 1, 'ed25519', 'revoked',
               'retired-device', ?, ?, ?)`,
    ).bind(
      PRINCIPAL_ID,
      replacement.NEW_KEY_ID,
      btoa("r".repeat(32)),
      "9".repeat(64),
      "8".repeat(64),
      NOW,
      NOW,
    ).run();

    await execute(insertReplacementSql);

    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM device_keys WHERE device_id = ?",
    ).bind(replacement.NEW_DEVICE_ID).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM consumer_cursors WHERE consumer_name = ?",
    ).bind(`device:${replacement.NEW_DEVICE_ID}`).first()).toEqual({ count: 0 });
  });

  it("revokes only the old device after the exact active replacement and cursor exist", async () => {
    await execute(insertReplacementSql);

    await execute(revokeReplacedSql);
    await execute(revokeReplacedSql);

    expect(await deviceRows()).toEqual([
      expect.objectContaining({ device_id: replacement.NEW_DEVICE_ID, status: "active", revoked_at: null }),
      expect.objectContaining({ device_id: OLD_DEVICE_ID, status: "revoked", revoked_at: expect.any(String) }),
    ]);
  });

  it.each([
    ["device ID", { NEW_DEVICE_ID: "device:33333333-3333-4333-8333-333333333333" }],
    ["key ID", { NEW_KEY_ID: "key:44444444-4444-4444-8444-444444444444" }],
    ["public key", { NEW_PUBLIC_KEY_BASE64: btoa("z".repeat(32)) }],
    ["fingerprint", { NEW_KEY_FINGERPRINT: "0".repeat(64) }],
    ["bootstrap metadata", { NEW_BOOTSTRAP_METADATA_HASH: "1".repeat(64) }],
  ])("refuses revocation when the replacement %s does not match", async (_label, override) => {
    await execute(insertReplacementSql);
    await execute(revokeReplacedSql, { ...replacement, ...override });

    expect(await env.DB.prepare(
      "SELECT status, revoked_at FROM device_keys WHERE device_id = ?",
    ).bind(OLD_DEVICE_ID).first()).toEqual({ status: "active", revoked_at: null });
  });

  it("refuses revocation while the replacement sync cursor is absent", async () => {
    await execute(insertReplacementSql);

    await env.DB.prepare("DELETE FROM consumer_cursors WHERE consumer_name = ?")
      .bind(`device:${replacement.NEW_DEVICE_ID}`).run();
    await execute(revokeReplacedSql);
    expect(await env.DB.prepare(
      "SELECT status, revoked_at FROM device_keys WHERE device_id = ?",
    ).bind(OLD_DEVICE_ID).first()).toEqual({ status: "active", revoked_at: null });
  });
});

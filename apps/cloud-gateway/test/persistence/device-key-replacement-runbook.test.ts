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
  return render(match[1]);
}

function runbookSection(start: string, end: string): string {
  const startIndex = runbook.indexOf(start);
  const endIndex = runbook.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`missing runbook section: ${start}`);
  return runbook.slice(startIndex, endIndex);
}

function operationStatusSql(template: string): string {
  const match = /^SELECT\r?\n  CASE WHEN EXISTS \([\s\S]*$/mu.exec(template);
  if (match?.[0] === undefined) throw new Error("missing operation status query");
  return render(match[0]);
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

  it("checks each write marker through a read-only query after the D1 import", async () => {
    const insertSection = runbookSection("## 3. Owner approval", "## 4. Prove");
    const revokeSection = runbookSection("## 5. Owner approval", "## 6. Read-only");
    const insertImport = "& node $wrangler d1 execute jarvis --remote --config $gateway --env '' --file $InsertPath";
    const insertStatus = "& node $wrangler d1 execute jarvis --remote --config $gateway --env '' --command $InsertStatus";
    const revokeImport = "& node $wrangler d1 execute jarvis --remote --config $gateway --env '' --file $RevokePath";
    const revokeStatus = "& node $wrangler d1 execute jarvis --remote --config $gateway --env '' --command $RevokeStatus";
    expect(insertSection.indexOf(insertImport)).toBeGreaterThanOrEqual(0);
    expect(insertSection.indexOf(insertStatus)).toBeGreaterThan(
      insertSection.indexOf(insertImport),
    );
    expect(insertSection).toContain("$InsertOperation = Get-Content -LiteralPath $InsertPath -Raw");
    expect(revokeSection.indexOf(revokeImport)).toBeGreaterThanOrEqual(0);
    expect(revokeSection.indexOf(revokeStatus)).toBeGreaterThan(
      revokeSection.indexOf(revokeImport),
    );
    expect(revokeSection).toContain("$RevokeOperation = Get-Content -LiteralPath $RevokePath -Raw");

    await execute(insertReplacementSql);
    await expect(env.DB.prepare(operationStatusSql(insertReplacementSql)).first())
      .resolves.toEqual({ replacement_state: "replacement_ready" });
    await execute(revokeReplacedSql);
    await expect(env.DB.prepare(operationStatusSql(revokeReplacedSql)).first())
      .resolves.toEqual({ replacement_state: "replacement_complete" });
  });

  it("targets production explicitly through the repository-pinned Wrangler host", () => {
    expect(runbook).toContain("$PSNativeCommandArgumentPassing = 'Standard'");
    expect(runbook).toContain("$wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path");
    expect(runbook).toContain("$gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path");
    const commands = runbook.match(/^.*d1 execute jarvis --remote.*$/gmu) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/^& node \$wrangler d1 execute jarvis --remote /u);
      expect(command).toContain("--config $gateway");
      expect(command).toContain("--env ''");
      expect(command).not.toContain("pnpm");
    }
  });

  it("persists and re-reads all four local phone-enrollment settings", () => {
    expect(runbook).toContain(
      "[Environment]::SetEnvironmentVariable('JARVIS_CLOUD_BASE_URL', $GatewayOrigin, [EnvironmentVariableTarget]::User)",
    );
    expect(runbook).toContain(
      "[Environment]::SetEnvironmentVariable('JARVIS_DEVICE_ID', $NewDeviceId, [EnvironmentVariableTarget]::User)",
    );
    expect(runbook).toContain(
      "[Environment]::SetEnvironmentVariable('JARVIS_PRINCIPAL_ID', $OwnerPrincipalId, [EnvironmentVariableTarget]::User)",
    );
    expect(runbook).toContain(
      "[Environment]::SetEnvironmentVariable('JARVIS_DEVICE_KEY_PATH', $KeyPath, [EnvironmentVariableTarget]::User)",
    );
    const proveSection = runbookSection("## 4. Prove", "## 5. Owner approval");
    expect(proveSection).toContain("$PSNativeCommandArgumentPassing = 'Standard'");
    expect(proveSection).toContain("$wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path");
    expect(proveSection).toContain("$gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path");
    expect(proveSection).toContain(
      "$env:JARVIS_CLOUD_BASE_URL = [Environment]::GetEnvironmentVariable('JARVIS_CLOUD_BASE_URL', [EnvironmentVariableTarget]::User)",
    );
    expect(proveSection).toContain(
      "$env:JARVIS_DEVICE_ID = [Environment]::GetEnvironmentVariable('JARVIS_DEVICE_ID', [EnvironmentVariableTarget]::User)",
    );
    expect(proveSection).toContain(
      "$env:JARVIS_PRINCIPAL_ID = [Environment]::GetEnvironmentVariable('JARVIS_PRINCIPAL_ID', [EnvironmentVariableTarget]::User)",
    );
    expect(proveSection).toContain(
      "$env:JARVIS_DEVICE_KEY_PATH = [Environment]::GetEnvironmentVariable('JARVIS_DEVICE_KEY_PATH', [EnvironmentVariableTarget]::User)",
    );
  });

  it("keeps the later revocation artifact beside the persisted sealed key", () => {
    expect(runbook).not.toContain("$env:TEMP");
    expect(runbook).toContain("$SqlDirectory = Join-Path $KeyDirectory 'replacement-runbook'");
    const revokeSection = runbookSection("## 5. Owner approval", "## 6. Read-only");
    expect(revokeSection).toContain("$KeyDirectory = Split-Path -Parent $env:JARVIS_DEVICE_KEY_PATH");
    expect(revokeSection).toContain("$RevokePath = Join-Path $SqlDirectory 'revoke-replaced-device-key.sql'");
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

import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_TABLES,
  MemoryBackupService,
} from "../../src/backup/memory-backup.js";
import {
  clearMemoryBackupDataForTest,
  recreateFreshDatabaseForBackupRestoreTest,
} from "../persistence/migration.js";

const runDate = "2026-09-16";
const instant = new Date("2026-09-16T23:30:00.000Z");
const timestamp = instant.toISOString();
const backupBucket = env.BACKUP as R2Bucket;

interface RestoreManifest {
  readonly tableCuts: readonly {
    readonly table: string;
    readonly expectedRowCount: number;
  }[];
  readonly objects: readonly {
    readonly table: string;
    readonly objectKey: string;
  }[];
}

async function clearBackupBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await backupBucket.list({ cursor });
    if (listed.objects.length > 0) await backupBucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

async function seedRestorableMemory(): Promise<void> {
  const eventId = "01k5nm00000000000000000001";
  const itemId = "01k5nm00000000000000000002";
  const versionId = "01k5nm00000000000000000003";
  const sourceId = "01k5nm00000000000000000004";
  const turnId = "01k5nm00000000000000000005";
  const text = "Sid keeps the verified backup restore test.";
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES ('principal:owner', 'human', 'active', 'Sid', ?, ?)`).bind(timestamp, timestamp).run();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'telegram', 'principal:owner', ?, ?, ?, ?, ?)`)
    .bind(
      eventId,
      timestamp,
      timestamp,
      await sha256Hex(text),
      canonicalJson({
        correlationId: turnId,
        principalId: "principal:owner",
        producerVersion: "conversation-v1",
        source: "conversation",
        text,
      }),
      timestamp,
    ).run();
  const event = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (event === null) throw new Error("restore fixture event missing");
  await env.DB.prepare(`INSERT INTO conversation_turns (
    turn_id, session_id, principal_id, channel, request_hash, user_event_id,
    state, created_at, updated_at
  ) VALUES (?, 'restore-session', 'principal:owner', 'telegram', ?, ?, 'user_committed', ?, ?)`)
    .bind(turnId, await sha256Hex("restore-request"), eventId, timestamp, timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_items (
    item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
  ) VALUES (?, 'principal:owner', 'fact', ?, ?, ?)`)
    .bind(itemId, eventId, event.sequence, timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_item_versions (
    version_id, principal_id, item_id, version_number, text, text_normalization,
    text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
    extractor_version, extractor_model_id, created_at
  ) VALUES (?, 'principal:owner', ?, 1, ?, 'NFC', ?, 'stated',
    'authenticated_first_person', 0, 'normal', NULL, NULL, 'restore-test', NULL, ?)`)
    .bind(versionId, itemId, text, await sha256Hex(text), timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_item_sources (
    source_id, principal_id, item_id, version_id, source_position, event_id,
    event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
    channel, occurred_at, created_at
  ) VALUES (?, 'principal:owner', ?, ?, 0, ?, ?, 'live', NULL, ?, ?, 'telegram', ?, ?)`)
    .bind(
      sourceId,
      itemId,
      versionId,
      eventId,
      event.sequence,
      text,
      await sha256Hex(text),
      timestamp,
      timestamp,
    ).run();
}

async function finishBackup(): Promise<RestoreManifest> {
  const backup = new MemoryBackupService({
    database: env.DB,
    bucket: backupBucket,
    clock: { now: () => new Date(instant.getTime()) },
    notice: { send: async () => undefined },
  });
  let outcome = await backup.runNightly(runDate);
  for (let invocation = 0; invocation < 80 && outcome.outcome === "pending"; invocation += 1) {
    outcome = await backup.continueActive(runDate);
  }
  expect(outcome.outcome).toBe("verified");
  const latestBody = await backupBucket.get(MEMORY_BACKUP_LATEST_KEY);
  if (latestBody === null) throw new Error("restore fixture latest pointer missing");
  const latest = JSON.parse(await latestBody.text()) as { manifestObjectKey: string };
  const manifestBody = await backupBucket.get(latest.manifestObjectKey);
  if (manifestBody === null) throw new Error("restore fixture manifest missing");
  return JSON.parse(await manifestBody.text()) as RestoreManifest;
}

async function readExportedRows(manifest: RestoreManifest): Promise<Map<string, Record<string, unknown>[]>> {
  const rows = new Map<string, Record<string, unknown>[]>();
  for (const object of manifest.objects) {
    const body = await backupBucket.get(object.objectKey);
    if (body === null) throw new Error(`restore object missing for ${object.table}`);
    const text = await body.text();
    if (text.length === 0) continue;
    const tableRows = rows.get(object.table) ?? [];
    tableRows.push(...text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>));
    rows.set(object.table, tableRows);
  }
  return rows;
}

async function tablePrimaryKey(table: string): Promise<readonly string[]> {
  if (!/^[a-z0-9_]+$/u.test(table)) throw new Error("restore table name invalid");
  const info = await env.DB.prepare(`PRAGMA table_info("${table}")`)
    .all<{ name: string; pk: number }>();
  return info.results.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk).map((column) => column.name);
}

async function restoreRows(rowsByTable: ReadonlyMap<string, readonly Record<string, unknown>[]>): Promise<void> {
  const inserts: D1PreparedStatement[] = [env.DB.prepare("PRAGMA defer_foreign_keys = ON")];
  for (const table of MEMORY_BACKUP_TABLES) {
    const rows = rowsByTable.get(table) ?? [];
    const primaryKey = await tablePrimaryKey(table);
    for (const row of rows) {
      const columns = Object.keys(row);
      const where = primaryKey.map((column) => `"${column}" IS ?`).join(" AND ");
      const existing = await env.DB.prepare(`SELECT * FROM "${table}" WHERE ${where}`)
        .bind(...primaryKey.map((column) => row[column])).first<Record<string, unknown>>();
      if (existing !== null) {
        expect(canonicalJson(existing), `fresh migration seed differs for ${table}`).toBe(canonicalJson(row));
        continue;
      }
      inserts.push(env.DB.prepare(`INSERT INTO "${table}" (
        ${columns.map((column) => `"${column}"`).join(", ")}
      ) VALUES (${columns.map(() => "?").join(", ")})`).bind(...columns.map((column) => row[column])));
    }
  }
  await env.DB.batch(inserts);
}

async function tableHash(table: string): Promise<string> {
  const primaryKey = await tablePrimaryKey(table);
  const rows = await env.DB.prepare(`SELECT * FROM "${table}"
    ORDER BY ${primaryKey.map((column) => `"${column}"`).join(", ")}`).all<Record<string, unknown>>();
  return sha256Hex(canonicalJson(rows.results));
}

describe("verified memory backup restore", () => {
  beforeEach(async () => {
    await clearMemoryBackupDataForTest();
    await clearBackupBucket();
  });

  it("imports a verified set into a freshly migrated D1 with foreign keys on", async () => {
    await seedRestorableMemory();
    const manifest = await finishBackup();
    const rowsByTable = await readExportedRows(manifest);
    const sampledTables = [
      "events",
      "conversation_turns",
      "memory_items",
      "memory_item_versions",
      "memory_item_sources",
    ] as const;
    const expectedHashes = new Map<string, string>();
    for (const table of sampledTables) {
      expectedHashes.set(table, await sha256Hex(canonicalJson(rowsByTable.get(table) ?? [])));
    }

    await recreateFreshDatabaseForBackupRestoreTest();
    expect(await env.DB.prepare("PRAGMA foreign_keys").first("foreign_keys")).toBe(1);
    await restoreRows(rowsByTable);
    expect(await env.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });

    for (const cut of manifest.tableCuts) {
      if (!MEMORY_BACKUP_TABLES.includes(cut.table as typeof MEMORY_BACKUP_TABLES[number])) continue;
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM "${cut.table}"`).first(), cut.table)
        .toEqual({ count: cut.expectedRowCount });
    }
    for (const table of sampledTables) {
      expect(await tableHash(table), table).toBe(expectedHashes.get(table));
    }
  }, 120_000);
});

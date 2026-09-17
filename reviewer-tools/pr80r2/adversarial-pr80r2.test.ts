import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import {
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_TABLES,
  MemoryBackupService,
  type MemoryBackupBucket,
  type MemoryBackupOutcome,
} from "../../src/backup/memory-backup.js";
import { appendEvents, resetArchiveFixture } from "../archive/archive-fixture.js";
import {
  clearMemoryBackupDataForTest,
  recreateFreshDatabaseForBackupRestoreTest,
} from "../persistence/migration.js";

const instant = new Date("2026-09-16T23:30:00.000Z");
const backupBucket = env.BACKUP as R2Bucket;

interface Counter { statements: number; batches: number; r2: number }

async function clearBackupBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await backupBucket.list({ cursor });
    if (listed.objects.length > 0) await backupBucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

function countingDatabase(counter: Counter, base: D1Database = env.DB): D1Database {
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          counter.statements += 1;
          return target.prepare(sql);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          counter.batches += 1;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

function countingBucket(counter: Counter, base: MemoryBackupBucket = backupBucket): MemoryBackupBucket {
  return {
    put: (...args) => { counter.r2 += 1; return base.put(...args); },
    get: (...args) => { counter.r2 += 1; return base.get(...args); },
    list: (...args) => { counter.r2 += 1; return base.list(...args); },
    delete: (...args) => { counter.r2 += 1; return base.delete(...args); },
  };
}

function service(options: {
  database?: D1Database;
  bucket?: MemoryBackupBucket;
  notices?: string[];
  stepsPerInvocation?: number;
} = {}): MemoryBackupService {
  const notices = options.notices ?? [];
  return new MemoryBackupService({
    database: options.database ?? env.DB,
    bucket: options.bucket ?? backupBucket,
    clock: { now: () => new Date(instant.getTime()) },
    notice: { send: async (text) => { notices.push(text); } },
    stepsPerInvocation: options.stepsPerInvocation,
  });
}

async function drive(
  make: () => MemoryBackupService,
  date: string,
  max = 200,
): Promise<{ outcome: MemoryBackupOutcome; invocations: number }> {
  let invocations = 1;
  let outcome = await make().runNightly(date);
  while (outcome.outcome === "pending" && invocations < max) {
    outcome = await make().continueActive(date);
    invocations += 1;
  }
  return { outcome, invocations };
}

async function runStatus(date: string): Promise<{ run_id: string; status: string; failure_code: string | null } | null> {
  return env.DB.prepare("SELECT run_id, status, failure_code FROM memory_backup_runs WHERE run_date = ?")
    .bind(date).first();
}

async function latestPointer(): Promise<{ runId: string; manifestObjectKey: string } | null> {
  const body = await backupBucket.get(MEMORY_BACKUP_LATEST_KEY);
  return body === null ? null : JSON.parse(await body.text()) as { runId: string; manifestObjectKey: string };
}

interface RestoreManifest {
  readonly objects: readonly { readonly table: string; readonly objectKey: string }[];
}

async function manifestFor(runId: string): Promise<RestoreManifest> {
  const row = await env.DB.prepare("SELECT manifest_object_key FROM memory_backup_runs WHERE run_id = ?")
    .bind(runId).first<{ manifest_object_key: string }>();
  if (row === null) throw new Error("manifest row missing");
  const body = await backupBucket.get(row.manifest_object_key);
  if (body === null) throw new Error("manifest missing");
  return JSON.parse(await body.text()) as RestoreManifest;
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
  const info = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string; pk: number }>();
  return info.results.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk).map((column) => column.name);
}

/** The builder's own restore procedure from memory-backup-restore.test.ts, returning the first error. */
async function restoreRows(rowsByTable: ReadonlyMap<string, readonly Record<string, unknown>[]>): Promise<string | null> {
  const inserts: D1PreparedStatement[] = [env.DB.prepare("PRAGMA defer_foreign_keys = ON")];
  for (const table of MEMORY_BACKUP_TABLES) {
    const rows = rowsByTable.get(table) ?? [];
    const primaryKey = await tablePrimaryKey(table);
    for (const row of rows) {
      const columns = Object.keys(row);
      const where = primaryKey.map((column) => `"${column}" IS ?`).join(" AND ");
      const existing = await env.DB.prepare(`SELECT * FROM "${table}" WHERE ${where}`)
        .bind(...primaryKey.map((column) => row[column])).first<Record<string, unknown>>();
      if (existing !== null) continue;
      inserts.push(env.DB.prepare(`INSERT INTO "${table}" (
        ${columns.map((column) => `"${column}"`).join(", ")}
      ) VALUES (${columns.map(() => "?").join(", ")})`).bind(...columns.map((column) => row[column])));
    }
  }
  try {
    await env.DB.batch(inserts);
    return null;
  } catch (error) {
    return String(error);
  }
}

describe("PR 80 round 2 adversarial", () => {
  beforeEach(async () => {
    await clearMemoryBackupDataForTest();
    await resetArchiveFixture();
    await clearBackupBucket();
  });

  it("ADV3b-r2 throughput: a first full backup exports at least 100 rows per five-minute invocation within D1 and R2 per-invocation limits", async () => {
    await appendEvents(320);
    let maxStatements = 0;
    let maxBatches = 0;
    let maxR2 = 0;
    const make = () => {
      const counter: Counter = { statements: 0, batches: 0, r2: 0 };
      const backup = service({ database: countingDatabase(counter), bucket: countingBucket(counter) });
      return new Proxy(backup, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown;
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            counter.statements = 0; counter.batches = 0; counter.r2 = 0;
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            maxStatements = Math.max(maxStatements, counter.statements);
            maxBatches = Math.max(maxBatches, counter.batches);
            maxR2 = Math.max(maxR2, counter.r2);
            return result;
          };
        },
      });
    };
    const { outcome, invocations } = await drive(make, "2026-09-16", 400);
    const run = await runStatus("2026-09-16");
    const totals = await env.DB.prepare(`SELECT sum(expected_row_count) AS rows,
      (SELECT count(*) FROM memory_backup_objects WHERE run_id = ?1) AS objects
      FROM memory_backup_table_cuts WHERE run_id = ?1`).bind(run?.run_id).first<{ rows: number; objects: number }>();
    const kinds = await env.DB.prepare(`SELECT key_kind, count(*) AS count FROM memory_backup_table_cuts
      WHERE run_id = ? GROUP BY key_kind`).bind(run?.run_id).all();
    console.log("ADV3b-r2", JSON.stringify({ outcome, invocations, totals, maxStatements, maxBatches, maxR2, kinds: kinds.results }));
    expect(outcome.outcome).toBe("verified");
    // Fixed cost: one finish step per table (104) plus publish, about 7 invocations at 16 steps.
    expect(totals!.rows / (invocations - 7)).toBeGreaterThanOrEqual(100);
    expect(maxStatements).toBeLessThanOrEqual(1000);
    expect(maxR2).toBeLessThanOrEqual(1000);
  }, 600_000);

  it("ADV4-r2 a D1 failure on the verify update never leaves latest.json naming a missing manifest", async () => {
    await appendEvents(2);
    expect((await drive(() => service(), "2026-09-15")).outcome.outcome).toBe("verified");
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => sql.includes("SET status = 'verified'")
            ? { bind: () => ({ run: async () => { throw new Error("D1_ERROR: transient"); } }) }
            : target.prepare(sql);
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1Database;
    const notices: string[] = [];
    const second = await drive(() => service({ database: failing, notices }), "2026-09-16");
    const afterFailure = await latestPointer();
    const manifestAfterFailure = afterFailure === null ? null : await backupBucket.head(afterFailure.manifestObjectKey);
    const third = await drive(() => service(), "2026-09-17");
    const afterThird = await latestPointer();
    const manifestAfterThird = afterThird === null ? null : await backupBucket.head(afterThird.manifestObjectKey);
    console.log("ADV4-r2", JSON.stringify({ second, notices, status2: await runStatus("2026-09-16"), third,
      latest2: afterFailure?.runId, latest3: afterThird?.runId }));
    expect(second.outcome.outcome).toBe("failed");
    expect(manifestAfterFailure).not.toBeNull();
    expect(third.outcome.outcome).toBe("verified");
    expect(afterThird?.runId).toBe((await runStatus("2026-09-17"))?.run_id);
    expect(manifestAfterThird).not.toBeNull();
    expect((await runStatus("2026-09-16"))?.status).toBe("abandoned");
  }, 300_000);

  it("ADV4c-r2 retention never deletes the set latest.json names when newer pointer writes keep failing", async () => {
    await appendEvents(1);
    expect((await drive(() => service(), "2026-08-01")).outcome.outcome).toBe("verified");
    const first = await latestPointer();
    const noPointer: MemoryBackupBucket = {
      put: async (...args) => {
        if (args[0] === MEMORY_BACKUP_LATEST_KEY) throw new Error("R2 transient");
        return backupBucket.put(...args);
      },
      get: (...args) => backupBucket.get(...args),
      list: (...args) => backupBucket.list(...args),
      delete: (...args) => backupBucket.delete(...args),
    };
    for (let day = 2; day <= 17; day += 1) {
      const date = `2026-08-${String(day).padStart(2, "0")}`;
      const backup = () => service({ bucket: noPointer });
      let outcome = await backup().runNightly(date);
      for (let i = 0; i < 60 && (await runStatus(date))?.status !== "verified"; i += 1) {
        outcome = await backup().continueActive(date);
      }
      expect((await runStatus(date))?.status, `${date} ${JSON.stringify(outcome)}`).toBe("verified");
    }
    const pruned = await env.DB.prepare("SELECT run_date FROM memory_backup_runs WHERE status = 'pruned' ORDER BY run_date").all();
    console.log("ADV4c-r2", JSON.stringify({ latest: first?.runId, pruned: pruned.results }));
    expect((await latestPointer())?.runId).toBe(first?.runId);
    expect(await backupBucket.head(first!.manifestObjectKey)).not.toBeNull();
    expect((await runStatus("2026-08-01"))?.status).toBe("verified");
  }, 600_000);

  it("ADV6-r2 a persistent retention listing error after a verified publish reports verified and sends no notice", async () => {
    await appendEvents(1);
    for (let day = 1; day <= 15; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      expect((await drive(() => service(), date)).outcome.outcome).toBe("verified");
    }
    const notices: string[] = [];
    const bucket: MemoryBackupBucket = {
      put: (...args) => backupBucket.put(...args),
      get: (...args) => backupBucket.get(...args),
      delete: (...args) => backupBucket.delete(...args),
      list: async () => { throw new Error("R2 list transient"); },
    };
    await appendEvents(1);
    const result = await drive(() => service({ bucket, notices }), "2026-09-16");
    expect({ result: result.outcome.outcome, status: (await runStatus("2026-09-16"))?.status, notices })
      .toEqual({ result: "verified", status: "verified", notices: [] });
  }, 600_000);

  it("GROWTH an unchanged database exports about the same number of rows every night", async () => {
    await appendEvents(64);
    const series: Array<{ night: number; rows: number; objects: number; receiptRows: number; invocations: number }> = [];
    for (let night = 1; night <= 8; night += 1) {
      const date = `2026-09-${String(night).padStart(2, "0")}`;
      const { outcome, invocations } = await drive(() => service(), date);
      expect(outcome.outcome).toBe("verified");
      const run = await runStatus(date);
      const totals = await env.DB.prepare(`SELECT sum(expected_row_count) AS rows,
        (SELECT count(*) FROM memory_backup_objects WHERE run_id = ?1) AS objects,
        (SELECT expected_row_count FROM memory_backup_table_cuts WHERE run_id = ?1 AND table_name = 'memory_backup_objects') AS receiptRows
        FROM memory_backup_table_cuts WHERE run_id = ?1`).bind(run?.run_id)
        .first<{ rows: number; objects: number; receiptRows: number }>();
      series.push({ night, invocations, ...totals! });
    }
    const ordinals = await env.DB.prepare("SELECT count(*) AS count FROM memory_backup_row_ordinals").first();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT source.*, ordinal.ordinal AS k FROM "memory_backup_objects" source
       JOIN memory_backup_row_ordinals ordinal
         ON ordinal.table_name = 'memory_backup_objects' AND ordinal.row_key = json_array(source."run_id", source."object_number")
       WHERE ordinal.ordinal > 0 AND ordinal.ordinal <= 1000000 ORDER BY ordinal.ordinal LIMIT 16`).all();
    const page = await env.DB.prepare(`SELECT source.*, ordinal.ordinal AS k FROM "memory_backup_objects" source
       JOIN memory_backup_row_ordinals ordinal
         ON ordinal.table_name = 'memory_backup_objects' AND ordinal.row_key = json_array(source."run_id", source."object_number")
       WHERE ordinal.ordinal > 0 AND ordinal.ordinal <= 1000000 ORDER BY ordinal.ordinal LIMIT 16`).all();
    console.log("GROWTH", JSON.stringify({ series, ordinals, plan: plan.results, pageMeta: page.meta }));
    expect(series.at(-1)!.rows).toBeLessThanOrEqual(series[1]!.rows + 8);
  }, 900_000);

  it("DELETE a production reclaim delete of a cut row during the export does not fail the night's backup", async () => {
    const principalId = `principal:adv80:${newUlid()}`;
    const deviceId = `device:adv80:${newUlid()}`;
    const created = "2026-09-16T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES (?, 'human', 'active', 'adv', ?, ?)`).bind(principalId, created, created),
      env.DB.prepare(`INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint,
        key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, 1, 'ed25519', 'active', 'adv', ?, ?, NULL)`)
        .bind(deviceId, principalId, `key:${deviceId}`, (await sha256Hex(deviceId)).slice(0, 43) + "=",
          await sha256Hex(`fp:${deviceId}`), await sha256Hex(`boot:${deviceId}`), created),
      env.DB.prepare(`INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint,
        key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, '2026-09-16T23:25:00.000Z', '2026-09-16T23:20:00.000Z', '2026-09-16T23:20:00.000Z')`)
        .bind(newUlid(), deviceId, principalId, `key:${deviceId}`, await sha256Hex(`fp:${deviceId}`),
          await sha256Hex("n1"), await sha256Hex("r1")),
      env.DB.prepare(`INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint,
        key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, '2026-09-16T23:29:00.000Z', '2026-09-16T23:24:00.000Z', '2026-09-16T23:24:00.000Z')`)
        .bind(newUlid(), deviceId, principalId, `key:${deviceId}`, await sha256Hex(`fp:${deviceId}`),
          await sha256Hex("n1b"), await sha256Hex("r1b")),
    ]);
    const notices: string[] = [];
    const first = await service({ notices, stepsPerInvocation: 2 }).runNightly("2026-09-16");
    expect(first.outcome).toBe("pending");
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM request_nonces WHERE device_id = ?`).bind(deviceId).first())
      .toEqual({ count: 2 });
    // A new signed device request after the cut: the production 0002 trigger reclaims the expired nonce.
    await env.DB.prepare(`INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint,
      key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, '2026-09-16T23:36:00.000Z', '2026-09-16T23:31:00.000Z', '2026-09-16T23:31:00.000Z')`)
      .bind(newUlid(), deviceId, principalId, `key:${deviceId}`, await sha256Hex(`fp:${deviceId}`),
        await sha256Hex("n2"), await sha256Hex("r2")).run();
    let outcome: MemoryBackupOutcome = first;
    for (let i = 0; i < 60 && outcome.outcome === "pending"; i += 1) {
      outcome = await service({ notices }).continueActive("2026-09-16");
    }
    const nonceCut = await env.DB.prepare(`SELECT cut.expected_row_count, cut.through_key,
      (SELECT coalesce(sum(row_count), 0) FROM memory_backup_objects o WHERE o.run_id = cut.run_id AND o.table_name = 'request_nonces') AS exported
      FROM memory_backup_table_cuts cut JOIN memory_backup_runs run ON run.run_id = cut.run_id
      WHERE run.run_date = '2026-09-16' AND cut.table_name = 'request_nonces'`).first();
    console.log("DELETE", JSON.stringify({ outcome, notices, run: await runStatus("2026-09-16"), nonceCut }));
    expect({ outcome, notices, nonceCut }).toMatchObject({ outcome: { outcome: "verified" }, notices: [] });
  }, 300_000);

  it("GUARD 0031 rejects an object receipt for a run that has no table cuts", async () => {
    const runId = "01k5nm00000000000000000077";
    await env.DB.prepare(`INSERT INTO memory_backup_runs (
      run_date, run_id, status, schema_version, marks_json, current_table_index,
      cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
      manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
      verified_at, abandoned_at, pruned_at
    ) VALUES ('2026-01-01', ?, 'running', 'v', '{"eventsAfter":0,"eventsThrough":1000}', 0,
      NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`)
      .bind(runId, instant.toISOString(), instant.toISOString()).run();
    await env.DB.prepare(`UPDATE memory_backup_runs SET lease_id = '01k5nm0000000000000000007a',
      lease_expires_at = '2026-09-16T23:32:00.000Z', updated_at = ? WHERE run_id = ?`)
      .bind(instant.toISOString(), runId).run();
    let error: unknown = null;
    try {
      await env.DB.prepare(`INSERT INTO memory_backup_objects (
        run_id, object_number, table_name, object_key, schema_version,
        row_count, byte_count, first_key, last_key, sha256, verified_at
      ) VALUES (?, 0, 'events', 'adv/no-cut', 'v', 16, 2, 1, 16, ?, ?)`)
        .bind(runId, "a".repeat(64), instant.toISOString()).run();
    } catch (caught) {
      error = caught;
    }
    console.log("GUARD", String(error));
    expect(error).not.toBeNull();
  });

  it("RESTORE-A the second night's verified set restores into a fresh D1 with the builder's procedure", async () => {
    await appendEvents(2);
    expect((await drive(() => service(), "2026-09-15")).outcome.outcome).toBe("verified");
    expect((await drive(() => service(), "2026-09-16")).outcome.outcome).toBe("verified");
    const run = await runStatus("2026-09-16");
    const rows = await readExportedRows(await manifestFor(run!.run_id));
    const bookkeeping = ["memory_backup_runs", "memory_backup_objects", "memory_backup_alerts"]
      .map((table) => [table, rows.get(table)?.length ?? 0]);
    await recreateFreshDatabaseForBackupRestoreTest();
    const error = await restoreRows(rows);
    console.log("RESTORE-A", JSON.stringify({ bookkeeping, error }));
    expect(error).toBeNull();
  }, 300_000);

  it("RESTORE-B a finished memory run restores into a fresh D1 with the builder's procedure", async () => {
    const principalId = `principal:adv80run:${newUlid()}`;
    const now = new Date().toISOString();
    const priceId = newUlid();
    const memoryRunId = newUlid();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES (?, 'human', 'active', 'adv', ?, ?)`).bind(principalId, now, now),
      env.DB.prepare(`INSERT INTO memory_model_prices (price_id, principal_id, provider, model_id, effective_at,
        input_micros_per_million, output_micros_per_million, cache_read_micros_per_million, currency, source_receipt, created_at)
        VALUES (?, ?, 'deepseek', 'deepseek:flash', ?, 1, 1, 1, 'USD', 'adv', ?)`).bind(priceId, principalId, now, now),
      env.DB.prepare(`INSERT INTO memory_runs (run_id, principal_id, run_key, job, provider_model_id, price_id, outcome, started_at)
        VALUES (?, ?, 'adv-run', 'distillation', 'deepseek:flash', ?, 'running', ?)`).bind(memoryRunId, principalId, priceId, now),
    ]);
    await env.DB.prepare("UPDATE memory_runs SET outcome = 'nothing_new', completed_at = ? WHERE run_id = ?")
      .bind(now, memoryRunId).run();
    expect((await drive(() => service(), "2026-09-16")).outcome.outcome).toBe("verified");
    const run = await runStatus("2026-09-16");
    const rows = await readExportedRows(await manifestFor(run!.run_id));
    expect(rows.get("memory_runs")?.length).toBe(1);
    await recreateFreshDatabaseForBackupRestoreTest();
    const error = await restoreRows(rows);
    console.log("RESTORE-B", JSON.stringify({ error }));
    expect(error).toBeNull();
  }, 300_000);
});

void canonicalJson;

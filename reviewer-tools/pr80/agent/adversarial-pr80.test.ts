import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_BACKUP_LATEST_KEY,
  MemoryBackupService,
  type MemoryBackupBucket,
  type MemoryBackupOutcome,
} from "../../src/backup/memory-backup.js";
import { appendEvents, resetArchiveFixture } from "../archive/archive-fixture.js";
import { clearMemoryBackupDataForTest } from "../persistence/migration.js";

const runDate = "2026-09-16";
const instant = new Date("2026-09-16T23:30:00.000Z");
const backupBucket = env.BACKUP as R2Bucket;

async function clearBackupBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await backupBucket.list({ cursor });
    if (listed.objects.length > 0) await backupBucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

function service(options: { database?: D1Database; pageRowLimit?: number; notices?: string[] } = {}) {
  const notices = options.notices ?? [];
  return new MemoryBackupService({
    database: options.database ?? env.DB,
    bucket: backupBucket as MemoryBackupBucket,
    clock: { now: () => new Date(instant.getTime()) },
    notice: { send: async (text) => { notices.push(text); } },
    pageRowLimit: options.pageRowLimit,
  });
}

async function drive(backup: MemoryBackupService, date: string, maxSteps: number) {
  let steps = 1;
  let outcome: MemoryBackupOutcome = await backup.runNightly(date);
  while (outcome.outcome === "pending" && steps < maxSteps) {
    outcome = await backup.continueActive(date);
    steps += 1;
  }
  return { outcome, steps };
}

describe("PR 80 adversarial", () => {
  beforeEach(async () => {
    await clearMemoryBackupDataForTest();
    await resetArchiveFixture();
    await clearBackupBucket();
  });

  it("ADV1 default 16-row pages: a production-sized events range verifies", async () => {
    await appendEvents(120);
    const { outcome, steps } = await drive(service(), runDate, 80);
    const run = await env.DB.prepare(
      "SELECT status, failure_code, cursor_key, next_object_number FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first();
    console.log("ADV1", JSON.stringify({ outcome, steps, run }));
    expect(outcome.outcome).toBe("verified");
  }, 120_000);

  it("ADV1b the exact object receipt for rows 97..112 is accepted by 0031", async () => {
    await env.DB.prepare(`INSERT INTO memory_backup_runs (
      run_date, run_id, status, schema_version, marks_json, current_table_index,
      cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
      manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
      verified_at, abandoned_at, pruned_at
    ) VALUES ('2026-09-16', '01k5nm00000000000000000001', 'running', 'v', ?, 0,
      NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`)
      .bind(JSON.stringify({ eventsAfter: 0, eventsThrough: 200 }), instant.toISOString(), instant.toISOString()).run();
    await env.DB.prepare(`UPDATE memory_backup_runs SET lease_id = '01k5nm0000000000000000000a',
      lease_expires_at = '2026-09-16T23:32:00.000Z', updated_at = ? WHERE run_date = '2026-09-16'`)
      .bind(instant.toISOString()).run();
    let error: unknown = null;
    try {
      await env.DB.prepare(`INSERT INTO memory_backup_objects (
        run_id, object_number, table_name, object_key, schema_version,
        row_count, byte_count, first_key, last_key, sha256, verified_at
      ) VALUES ('01k5nm00000000000000000001', 0, 'events', 'k', 'v', 16, 2, '97', '112', ?, ?)`)
        .bind("a".repeat(64), instant.toISOString()).run();
    } catch (caught) {
      error = caught;
    }
    console.log("ADV1b", String(error));
    expect(error).toBeNull();
  });

  it("ADV2 one-row pages crossing sequence 9 -> 10 verify", async () => {
    await appendEvents(11);
    const { outcome, steps } = await drive(service({ pageRowLimit: 1 }), runDate, 80);
    const run = await env.DB.prepare(
      "SELECT status, failure_code, cursor_key, next_object_number FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first();
    console.log("ADV2", JSON.stringify({ outcome, steps, run }));
    expect(outcome.outcome).toBe("verified");
  }, 120_000);

  it("ADV3 throughput: invocations needed for 64 events at default limits", async () => {
    await appendEvents(64);
    const { outcome, steps } = await drive(service(), runDate, 200);
    console.log("ADV3", JSON.stringify({ outcome, steps }));
    expect(outcome.outcome).toBe("verified");
  }, 120_000);

  it("ADV4 a D1 error after latest.json is written leaves latest pointing at a set cleanup later deletes", async () => {
    await appendEvents(2);
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("SET status = 'verified'")) {
              return { bind: () => ({ run: async () => { throw new Error("D1_ERROR: transient"); } }) };
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1Database;
    const notices: string[] = [];
    const first = await drive(service({ database: failing, notices }), runDate, 40);
    const latestText = await (await backupBucket.get(MEMORY_BACKUP_LATEST_KEY))?.text();
    const latest = JSON.parse(latestText ?? "null") as { manifestObjectKey: string } | null;
    const statusAfterFirst = await env.DB.prepare("SELECT status FROM memory_backup_runs WHERE run_date = ?")
      .bind(runDate).first();
    const manifestBefore = latest === null ? null : await backupBucket.head(latest.manifestObjectKey);

    const second = await service().runNightly("2026-09-17");
    const latestAfter = JSON.parse((await (await backupBucket.get(MEMORY_BACKUP_LATEST_KEY))?.text()) ?? "null") as
      { manifestObjectKey: string } | null;
    const manifestAfter = latestAfter === null ? null : await backupBucket.head(latestAfter.manifestObjectKey);
    console.log("ADV4", JSON.stringify({
      first, notices, statusAfterFirst, latestKey: latest?.manifestObjectKey,
      manifestExistedBefore: manifestBefore !== null, second,
      latestUnchanged: latestAfter?.manifestObjectKey === latest?.manifestObjectKey,
      manifestExistsAfter: manifestAfter !== null,
    }));
    expect(manifestAfter).not.toBeNull();
  }, 120_000);

  it("ADV5 INSERT OR REPLACE with another run's object key cannot erase that run's receipt", async () => {
    await appendEvents(1);
    expect((await drive(service(), runDate, 40)).outcome.outcome).toBe("verified");
    const verifiedObject = await env.DB.prepare(
      "SELECT run_id, object_key FROM memory_backup_objects ORDER BY object_number LIMIT 1",
    ).first<{ run_id: string; object_key: string }>();
    if (verifiedObject === null) throw new Error("no object");
    // Start the next night's run and take its lease exactly as the service does.
    await appendEvents(1);
    const next = service();
    const nextDate = "2026-09-17";
    await env.DB.prepare(`INSERT INTO memory_backup_runs (
      run_date, run_id, status, schema_version, marks_json, current_table_index,
      cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
      manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
      verified_at, abandoned_at, pruned_at
    ) VALUES (?, '01k5nm00000000000000000009', 'running', '0031_memory_backup.sql', '{}', 0,
      NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`)
      .bind(nextDate, instant.toISOString(), instant.toISOString()).run();
    await env.DB.prepare(`UPDATE memory_backup_runs SET lease_id = '01k5nm0000000000000000000a',
      lease_expires_at = '2026-09-16T23:32:00.000Z', updated_at = ? WHERE run_date = ?`)
      .bind(instant.toISOString(), nextDate).run();
    let error: unknown = null;
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO memory_backup_objects (
        run_id, object_number, table_name, object_key, schema_version,
        row_count, byte_count, first_key, last_key, sha256, verified_at
      ) VALUES ('01k5nm00000000000000000009', 0, 'events', ?, '0031_memory_backup.sql', 1, 2, '1', '1', ?, ?)`)
        .bind(verifiedObject.object_key, "b".repeat(64), instant.toISOString()).run();
    } catch (caught) {
      error = caught;
    }
    const remaining = await env.DB.prepare("SELECT run_id FROM memory_backup_objects WHERE object_key = ?")
      .bind(verifiedObject.object_key).all();
    console.log("ADV5", JSON.stringify({ error: String(error), original: verifiedObject.run_id, remaining: remaining.results }));
    void next;
    expect(remaining.results).toEqual([{ run_id: verifiedObject.run_id }]);
  }, 120_000);
});

describe("PR 80 adversarial extra", () => {
  beforeEach(async () => {
    await clearMemoryBackupDataForTest();
    await resetArchiveFixture();
    await clearBackupBucket();
  });

  it("ADV3b throughput steps for 64 events", async () => {
    await appendEvents(64);
    const { outcome, steps } = await drive(service(), runDate, 200);
    expect({ outcome: outcome.outcome, steps }).toEqual({ outcome: "verified", steps: -1 });
  }, 120_000);

  it("ADV6 a retention list error after a verified publish reports failure and alerts", async () => {
    await appendEvents(1);
    for (let day = 1; day <= 15; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      expect((await drive(service(), date, 40)).outcome.outcome).toBe("verified");
    }
    const notices: string[] = [];
    const bucket: MemoryBackupBucket = {
      put: (...args) => backupBucket.put(...args),
      get: (...args) => backupBucket.get(...args),
      delete: (...args) => backupBucket.delete(...args),
      list: async () => { throw new Error("R2 list transient"); },
    };
    const flaky = new MemoryBackupService({
      database: env.DB, bucket, clock: { now: () => new Date(instant.getTime()) },
      notice: { send: async (text) => { notices.push(text); } },
    });
    const result = await drive(flaky, "2026-09-16", 40);
    const status = await env.DB.prepare("SELECT status FROM memory_backup_runs WHERE run_date = '2026-09-16'").first();
    expect({ result, status, notices }).toEqual({ result: "show", status: null, notices: [] });
  }, 300_000);
});

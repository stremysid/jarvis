import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { buildJobTable, type JobEnvironment } from "../../src/jobs/job-table.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { clearMemoryBackupDataForTest } from "../persistence/migration.js";

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

function jobEnvironment(overrides: Partial<Env> = {}): JobEnvironment {
  const bindings = new Proxy(env as Env, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    env: bindings,
    clock: { now: () => new Date(instant.getTime()) },
    delivery: { send: async () => undefined },
    fetcher: globalThis.fetch.bind(globalThis),
  };
}

describe("memory backup job wiring", () => {
  beforeEach(async () => {
    await clearMemoryBackupDataForTest();
    await resetArchiveFixture();
    await clearBackupBucket();
  });

  it("the backup job starts the Toronto-date nightly set", async () => {
    const backup = buildJobTable(jobEnvironment()).backup;
    if (backup === undefined) throw new Error("backup job missing");
    const outcome = await backup();
    expect(outcome).toMatchObject({ ok: true });
    expect(await env.DB.prepare(`SELECT run_date, status FROM memory_backup_runs
      WHERE run_date = '2026-09-16'`).first()).toEqual({
      run_date: "2026-09-16",
      status: "running",
    });
  });

  it("the drain job advances a running backup after the nightly job returns", async () => {
    const jobs = buildJobTable(jobEnvironment());
    const backup = jobs.backup;
    const drain = jobs.drain;
    if (backup === undefined || drain === undefined) throw new Error("backup job wiring missing");
    await backup();
    const before = await env.DB.prepare(`SELECT current_table_index, next_object_number
      FROM memory_backup_runs WHERE run_date = '2026-09-16'`)
      .first<{ current_table_index: number; next_object_number: number }>();
    await drain();
    const after = await env.DB.prepare(`SELECT current_table_index, next_object_number
      FROM memory_backup_runs WHERE run_date = '2026-09-16'`)
      .first<{ current_table_index: number; next_object_number: number }>();
    if (before === null || after === null) throw new Error("backup run missing");
    expect(after.current_table_index > before.current_table_index
      || after.next_object_number > before.next_object_number).toBe(true);
  });

  it("a backup continuation failure does not stop the drain's decision-queue work", async () => {
    const backup = buildJobTable(jobEnvironment()).backup;
    if (backup === undefined) throw new Error("backup job missing");
    await backup();
    let decisionQueueRead = false;
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("decision_items")) decisionQueueRead = true;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1Database;
    const drain = buildJobTable(jobEnvironment({
      BACKUP: undefined,
      DB: database,
      OWNER_PRINCIPAL_ID: "principal:owner",
      TELEGRAM_BOT_TOKEN: undefined,
    })).drain;
    if (drain === undefined) throw new Error("drain job missing");
    const outcome = await drain();
    expect(decisionQueueRead).toBe(true);
    expect(outcome).toEqual({ ok: false, failure: "memory_backup_binding_missing" });
  });
});

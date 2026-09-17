import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES,
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_NOTICE,
  MEMORY_BACKUP_TABLES,
  MemoryBackupService,
  selectMemoryBackupRetentionDeletes,
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

function service(options: {
  bucket?: MemoryBackupBucket;
  database?: D1Database;
  now?: Date;
  notices?: string[];
  pageRowLimit?: number;
  stepsPerInvocation?: number;
} = {}): MemoryBackupService {
  const notices = options.notices ?? [];
  return new MemoryBackupService({
    database: options.database ?? env.DB,
    bucket: Object.hasOwn(options, "bucket") ? options.bucket : backupBucket,
    clock: { now: () => new Date((options.now ?? instant).getTime()) },
    notice: { send: async (text) => { notices.push(text); } },
    pageRowLimit: options.pageRowLimit,
    stepsPerInvocation: options.stepsPerInvocation,
  });
}

async function finishBackup(
  backup: MemoryBackupService,
  initial: MemoryBackupOutcome,
): Promise<MemoryBackupOutcome> {
  let outcome = initial;
  for (let step = 0; step < 40 && outcome.outcome === "pending"; step += 1) {
    outcome = await backup.continueActive(runDate);
  }
  return outcome;
}

async function driveBackup(backup: MemoryBackupService, date = runDate): Promise<{
  readonly outcome: MemoryBackupOutcome;
  readonly invocations: number;
}> {
  let invocations = 1;
  let outcome = await backup.runNightly(date);
  while (outcome.outcome === "pending" && invocations < 80) {
    outcome = await backup.continueActive(date);
    invocations += 1;
  }
  return { outcome, invocations };
}

async function insertEventsAt(sequences: readonly number[]): Promise<void> {
  await env.DB.batch(sequences.map((sequence) => env.DB.prepare(`INSERT INTO events (
    sequence, event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, 'conversation.user', 'telegram', 'principal:owner', ?, ?, ?, ?, ?)`)
    .bind(
      sequence,
      `01k5nm0000000000${String(sequence).padStart(8, "0")}`,
      instant.toISOString(),
      instant.toISOString(),
      String(sequence).padStart(64, "0"),
      JSON.stringify({ text: `event-${sequence}` }),
      instant.toISOString(),
    )));
}

async function exportedEventSequences(): Promise<readonly number[]> {
  const manifest = await readLatestManifest();
  const objects = manifest.objects as Array<{ table: string; objectKey: string }>;
  const sequences: number[] = [];
  for (const object of objects.filter((candidate) => candidate.table === "events")) {
    const body = await backupBucket.get(object.objectKey);
    if (body === null) throw new Error("event backup object missing");
    for (const line of (await body.text()).trim().split("\n")) {
      sequences.push((JSON.parse(line) as { sequence: number }).sequence);
    }
  }
  return sequences;
}

async function readLatestManifest(): Promise<Record<string, unknown>> {
  const latestBody = await backupBucket.get(MEMORY_BACKUP_LATEST_KEY);
  if (latestBody === null) throw new Error("latest backup pointer missing");
  const latest = JSON.parse(await latestBody.text()) as { manifestObjectKey: string };
  const manifestBody = await backupBucket.get(latest.manifestObjectKey);
  if (manifestBody === null) throw new Error("latest backup manifest missing");
  return JSON.parse(await manifestBody.text()) as Record<string, unknown>;
}

describe("nightly verified memory backup", () => {
  beforeEach(async () => {
    await clearMemoryBackupDataForTest();
    await resetArchiveFixture();
    await clearBackupBucket();
  });

  it("exports a consistent cut and excludes events appended after the immutable mark", async () => {
    await appendEvents(2);
    const backup = service({ pageRowLimit: 1 });
    const first = await backup.runNightly(runDate);
    expect(first.outcome).toBe("pending");

    await appendEvents(3);
    expect((await finishBackup(backup, first)).outcome).toBe("verified");

    const manifest = await readLatestManifest();
    expect(manifest.databaseSchemaVersion).toBe("0031_memory_backup.sql");
    expect(manifest.coverageMarks).toEqual({ eventsAfter: 0 });
    expect((manifest.tableCuts as Array<Record<string, unknown>>)
      .find((cut) => cut.table === "events")).toMatchObject({
      afterKey: 0,
      throughKey: 2,
      expectedRowCount: 2,
    });
    const objects = manifest.objects as Array<{ table: string; objectKey: string }>;
    const exportedSequences: number[] = [];
    for (const object of objects.filter((candidate) => candidate.table === "events")) {
      const body = await backupBucket.get(object.objectKey);
      if (body === null) throw new Error("event backup object missing");
      for (const line of (await body.text()).trim().split("\n")) {
        exportedSequences.push((JSON.parse(line) as { sequence: number }).sequence);
      }
    }
    expect(exportedSequences).toEqual([1, 2]);
  });

  it.each([
    { boundary: "9 to 10", sequences: Array.from({ length: 20 }, (_, index) => index + 1) },
    { boundary: "99 to 100", sequences: Array.from({ length: 32 }, (_, index) => index + 90) },
    { boundary: "9,999 to 10,000", sequences: Array.from({ length: 32 }, (_, index) => index + 9_990) },
  ])("keeps numeric event cursors ordered across $boundary at the default page size", async ({ sequences }) => {
    await insertEventsAt(sequences);
    const { outcome } = await driveBackup(service());
    expect(outcome.outcome).toBe("verified");
    expect(await exportedEventSequences()).toEqual(sequences);
  }, 120_000);

  it("processes several export pages in one invocation within its fixed step budget", async () => {
    await appendEvents(64);
    const backup = service();
    expect((await backup.runNightly(runDate)).outcome).toBe("pending");
    expect(await env.DB.prepare(`SELECT cursor_key FROM memory_backup_runs
      WHERE run_date = ?`).bind(runDate).first()).toEqual({ cursor_key: 32 });
    const eventObjects = await env.DB.prepare(`SELECT count(*) AS count FROM memory_backup_objects
      WHERE table_name = 'events'`).first<{ count: number }>();
    expect(eventObjects?.count).toBeGreaterThan(1);
    const result = await driveBackup(backup);
    expect(result.outcome.outcome).toBe("verified");
    expect(result.invocations).toBeLessThan(10);
  }, 120_000);

  it("classifies every migrated table as authoritative backup data or explicitly derived", async () => {
    const rows = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'`)
      .all<{ name: string }>();
    const ftsBases = MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES.filter((table) => table.endsWith("_fts"));
    const migrated = rows.results.map((row) => row.name).filter((name) =>
      name !== "_cf_METADATA" && !ftsBases.some((base) => name.startsWith(`${base}_`)));
    const classified = new Set<string>([
      ...MEMORY_BACKUP_TABLES,
      ...MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES,
    ]);
    expect(migrated.filter((table) => !classified.has(table)).sort()).toEqual([]);
    expect(MEMORY_BACKUP_TABLES.filter((table) => !migrated.includes(table))).toEqual([]);
  });

  it("writes the manifest after every data object and advertises it only after read-back", async () => {
    await appendEvents(2);
    const writes: string[] = [];
    let reads = 0;
    const bucket: MemoryBackupBucket = {
      put: async (...args) => {
        writes.push(args[0]);
        return backupBucket.put(...args);
      },
      get: async (...args) => {
        reads += 1;
        return backupBucket.get(...args);
      },
      list: (...args) => backupBucket.list(...args),
      delete: (...args) => backupBucket.delete(...args),
    };
    const backup = service({ bucket, pageRowLimit: 1 });
    const outcome = await finishBackup(backup, await backup.runNightly(runDate));
    expect(outcome.outcome).toBe("verified");

    const manifestIndex = writes.findIndex((key) => key.endsWith("/manifest.json"));
    const latestIndex = writes.indexOf(MEMORY_BACKUP_LATEST_KEY);
    expect(manifestIndex).toBeGreaterThan(-1);
    expect(writes.slice(manifestIndex + 1).some((key) => key.includes("/staging/"))).toBe(false);
    expect(latestIndex).toBeGreaterThan(manifestIndex);
    expect(reads).toBeGreaterThanOrEqual(5);
  });

  it("marks a set verified in D1 before writing latest and repairs a failed pointer write", async () => {
    await appendEvents(2);
    let latestFailures = 3;
    const statusesAtLatest: unknown[] = [];
    const bucket: MemoryBackupBucket = {
      put: async (...args) => {
        if (args[0] === MEMORY_BACKUP_LATEST_KEY) {
          statusesAtLatest.push(await env.DB.prepare(
            "SELECT status FROM memory_backup_runs WHERE run_date = ?",
          ).bind(runDate).first());
          if (latestFailures > 0) {
            latestFailures -= 1;
            throw new Error("R2 transient");
          }
        }
        return backupBucket.put(...args);
      },
      get: (...args) => backupBucket.get(...args),
      list: (...args) => backupBucket.list(...args),
      delete: (...args) => backupBucket.delete(...args),
    };
    const backup = service({ bucket });
    let first = await backup.runNightly(runDate);
    for (let invocation = 0; invocation < 80; invocation += 1) {
      const status = await env.DB.prepare(
        "SELECT status FROM memory_backup_runs WHERE run_date = ?",
      ).bind(runDate).first<{ status: string }>();
      if (status?.status === "verified") break;
      first = await backup.continueActive(runDate);
    }
    expect(first.outcome).toBe("pending");
    expect(await env.DB.prepare(
      "SELECT status FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first()).toEqual({ status: "verified" });
    expect(await backupBucket.get(MEMORY_BACKUP_LATEST_KEY)).toBeNull();

    expect((await backup.runNightly(runDate)).outcome).toBe("verified");
    expect(statusesAtLatest).toHaveLength(4);
    expect(statusesAtLatest.every((status) => JSON.stringify(status) === '{"status":"verified"}')).toBe(true);
    expect(await backupBucket.get(MEMORY_BACKUP_LATEST_KEY)).not.toBeNull();
  }, 120_000);

  it("keeps a verified result when retention fails and retries objects before manifest and D1 status", async () => {
    await appendEvents(1);
    for (let day = 1; day <= 15; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      expect((await driveBackup(service(), date)).outcome.outcome).toBe("verified");
    }
    const notices: string[] = [];
    let listFailures = 3;
    const bucket: MemoryBackupBucket = {
      put: (...args) => backupBucket.put(...args),
      get: (...args) => backupBucket.get(...args),
      delete: (...args) => backupBucket.delete(...args),
      list: async (...args) => {
        if (listFailures > 0) {
          listFailures -= 1;
          throw new Error("R2 list transient");
        }
        return backupBucket.list(...args);
      },
    };
    const result = await driveBackup(service({ bucket, notices }), "2026-09-16");
    expect(result.outcome.outcome).toBe("verified");
    expect(await env.DB.prepare(
      "SELECT status FROM memory_backup_runs WHERE run_date = '2026-09-16'",
    ).first()).toEqual({ status: "verified" });
    expect(notices).toEqual([]);

    const verified = await env.DB.prepare(`SELECT run_id, run_date, manifest_object_key
      FROM memory_backup_runs WHERE status = 'verified' ORDER BY run_date DESC`)
      .all<{ run_id: string; run_date: string; manifest_object_key: string }>();
    const candidateId = selectMemoryBackupRetentionDeletes(verified.results.map((run) => ({
      runId: run.run_id,
      runDate: run.run_date,
    })), "2026-09-16")[0];
    const candidate = verified.results.find((run) => run.run_id === candidateId);
    if (candidate === undefined) throw new Error("retention candidate missing");
    const prefix = `memory-backup/sets/${candidate.run_date}/${candidate.run_id}/`;
    const actual = await backupBucket.list({ prefix });
    const actualKeys = new Set(actual.objects.map((object) => object.key));
    const fakeKeys = Array.from({ length: 1_001 }, (_, index) =>
      `${prefix}staging/fake/${String(index).padStart(8, "0")}.ndjson`);
    const deletionBatches: string[][] = [];
    let page = 0;
    const pagedBucket: MemoryBackupBucket = {
      put: (...args) => backupBucket.put(...args),
      get: (...args) => backupBucket.get(...args),
      list: async (options) => {
        if (options?.prefix !== prefix) return backupBucket.list(options);
        const keys = page === 0
          ? [candidate.manifest_object_key, ...actual.objects
            .map((object) => object.key).filter((key) => key !== candidate.manifest_object_key), ...fakeKeys]
            .slice(0, 1_000)
          : [candidate.manifest_object_key, ...fakeKeys.slice(999)];
        page += 1;
        return {
          objects: keys.map((key) => ({ key }) as R2Object),
          truncated: page === 1,
          cursor: page === 1 ? "next" : undefined,
          delimitedPrefixes: [],
        } as R2Objects;
      },
      delete: async (keys) => {
        const batch = typeof keys === "string" ? [keys] : [...keys];
        deletionBatches.push(batch);
        const real = batch.filter((key) => actualKeys.has(key));
        if (real.length > 0) await backupBucket.delete(real);
      },
    };
    expect((await service({ bucket: pagedBucket }).runNightly("2026-09-16")).outcome).toBe("verified");
    expect(await env.DB.prepare("SELECT status FROM memory_backup_runs WHERE run_id = ?")
      .bind(candidate.run_id).first()).toEqual({ status: "verified" });
    expect(deletionBatches.flat()).not.toContain(candidate.manifest_object_key);

    expect((await service({ bucket: pagedBucket }).runNightly("2026-09-16")).outcome).toBe("verified");
    expect(await env.DB.prepare("SELECT status FROM memory_backup_runs WHERE run_id = ?")
      .bind(candidate.run_id).first()).toEqual({ status: "pruned" });
    expect(deletionBatches.at(-1)).toEqual([candidate.manifest_object_key]);
  }, 300_000);

  it("alerts once when the newest verified set is older than thirty-six hours", async () => {
    const oldInstant = new Date("2026-09-14T00:00:00.000Z");
    expect((await driveBackup(service({ now: oldInstant }), "2026-09-14")).outcome.outcome).toBe("verified");
    const notices: string[] = [];
    const stale = service({
      now: new Date("2026-09-16T13:00:00.001Z"),
      notices,
    });
    expect((await stale.continueActive("2026-09-16")).outcome).toBe("idle");
    expect(notices).toEqual([MEMORY_BACKUP_NOTICE]);
    expect(await env.DB.prepare(`SELECT failure_code FROM memory_backup_alerts
      WHERE local_date = '2026-09-16'`).first()).toEqual({ failure_code: "memory_backup_stale" });
    await stale.continueActive("2026-09-16");
    expect(notices).toEqual([MEMORY_BACKUP_NOTICE]);
  }, 120_000);

  it("never advertises a staging set whose previously written object was tampered", async () => {
    await appendEvents(1);
    const notices: string[] = [];
    const backup = service({ notices });
    let outcome = await backup.runNightly(runDate);
    const staged = (await backupBucket.list({ prefix: "memory-backup/sets/" })).objects
      .find((object) => object.key.includes("/staging/"));
    if (staged === undefined) throw new Error("staging object missing");
    await backupBucket.put(staged.key, "tampered");

    for (let step = 0; step < 30 && outcome.outcome === "pending"; step += 1) {
      outcome = await backup.continueActive(runDate);
    }
    expect(outcome).toEqual({ outcome: "failed", code: "memory_backup_object_readback_failed" });
    expect(await backupBucket.get(MEMORY_BACKUP_LATEST_KEY)).toBeNull();
    expect(notices).toEqual([MEMORY_BACKUP_NOTICE]);
  });

  it("retries a transient R2 read without discarding the multi-step run", async () => {
    await appendEvents(2);
    const notices: string[] = [];
    let readFailures = 1;
    const bucket: MemoryBackupBucket = {
      put: (...args) => backupBucket.put(...args),
      get: async (...args) => {
        if (readFailures > 0 && args[0].includes("/staging/")) {
          readFailures -= 1;
          throw new Error("R2 transient");
        }
        return backupBucket.get(...args);
      },
      list: (...args) => backupBucket.list(...args),
      delete: (...args) => backupBucket.delete(...args),
    };
    expect(await driveBackup(service({ bucket, notices }))).toMatchObject({
      outcome: { outcome: "verified" },
    });
    expect(readFailures).toBe(0);
    expect(notices).toEqual([]);
  }, 120_000);

  it("cleans a failed staging prefix before claiming the next night's run", async () => {
    await appendEvents(1);
    const backup = service();
    let outcome = await backup.runNightly(runDate);
    const staged = (await backupBucket.list({ prefix: "memory-backup/sets/" })).objects
      .find((object) => object.key.includes("/staging/"));
    if (staged === undefined) throw new Error("staging object missing");
    await backupBucket.put(staged.key, "tampered");
    for (let step = 0; step < 30 && outcome.outcome === "pending"; step += 1) {
      outcome = await backup.continueActive(runDate);
    }
    expect(outcome.outcome).toBe("failed");
    const failed = await env.DB.prepare(
      "SELECT run_id FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first<{ run_id: string }>();
    if (failed === null) throw new Error("failed run missing");

    expect((await service().runNightly("2026-09-17")).outcome).toBe("pending");
    expect((await backupBucket.list({
      prefix: `memory-backup/sets/${runDate}/${failed.run_id}/`,
    })).objects).toHaveLength(0);
    expect(await env.DB.prepare(
      "SELECT status FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first()).toEqual({ status: "abandoned" });
  });

  it("resumes from the durable cursor in a later invocation", async () => {
    await appendEvents(3);
    const firstService = service({ pageRowLimit: 1, stepsPerInvocation: 6 });
    expect((await firstService.runNightly(runDate)).outcome).toBe("pending");
    const first = await env.DB.prepare(
      "SELECT cursor_key, next_object_number FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first<{ cursor_key: number; next_object_number: number }>();
    expect(first).toEqual({ cursor_key: 2, next_object_number: 2 });

    const resumed = service({ pageRowLimit: 1, stepsPerInvocation: 2 });
    expect((await resumed.continueActive(runDate)).outcome).toBe("pending");
    const second = await env.DB.prepare(
      "SELECT cursor_key, next_object_number FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first<{ cursor_key: number | null; next_object_number: number }>();
    expect(second).toEqual({ cursor_key: null, next_object_number: 3 });
    expect((await finishBackup(service(), { outcome: "pending", detail: "continue" })).outcome).toBe("verified");
  });

  it("alerts once for a missing binding and records only the fixed code", async () => {
    const notices: string[] = [];
    const backup = service({ bucket: undefined, notices });
    expect(await backup.runNightly(runDate)).toEqual({
      outcome: "failed",
      code: "memory_backup_binding_missing",
    });
    expect(await backup.runNightly(runDate)).toEqual({
      outcome: "failed",
      code: "memory_backup_binding_missing",
    });
    expect(notices).toEqual([MEMORY_BACKUP_NOTICE]);
    expect(await env.DB.prepare(
      "SELECT failure_code FROM memory_backup_alerts WHERE local_date = ?",
    ).bind(runDate).first()).toEqual({ failure_code: "memory_backup_binding_missing" });
  });

  it("treats a second run on the same Toronto date as the same verified set", async () => {
    await appendEvents(1);
    const backup = service();
    expect((await finishBackup(backup, await backup.runNightly(runDate))).outcome).toBe("verified");
    const latestBefore = await (await backupBucket.get(MEMORY_BACKUP_LATEST_KEY))?.text();

    expect(await service().runNightly(runDate)).toEqual({
      outcome: "verified",
      detail: "memory backup already verified",
    });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_backup_runs").first())
      .toEqual({ count: 1 });
    expect(await (await backupBucket.get(MEMORY_BACKUP_LATEST_KEY))?.text()).toBe(latestBefore);
  });

  it("retention never selects the only verified set for deletion", () => {
    expect(selectMemoryBackupRetentionDeletes([
      { runId: "only", runDate: "2026-09-16" },
    ], runDate)).toEqual([]);
  });

  it("retention keeps the latest fourteen nights and the month's first verified set", () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({
      runId: `run-${String(index + 1).padStart(2, "0")}`,
      runDate: `2026-09-${String(index + 1).padStart(2, "0")}`,
    }));
    expect(selectMemoryBackupRetentionDeletes(runs, "2026-09-20")).toEqual([
      "run-06", "run-05", "run-04", "run-03", "run-02",
    ]);
  });
});

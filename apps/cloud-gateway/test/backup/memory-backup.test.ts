import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_NOTICE,
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
  notices?: string[];
  pageRowLimit?: number;
} = {}): MemoryBackupService {
  const notices = options.notices ?? [];
  return new MemoryBackupService({
    database: env.DB,
    bucket: Object.hasOwn(options, "bucket") ? options.bucket : backupBucket,
    clock: { now: () => new Date(instant.getTime()) },
    notice: { send: async (text) => { notices.push(text); } },
    pageRowLimit: options.pageRowLimit,
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
    expect(manifest.coverageMarks).toMatchObject({ eventsAfter: 0, eventsThrough: 2 });
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
    const firstService = service({ pageRowLimit: 1 });
    expect((await firstService.runNightly(runDate)).outcome).toBe("pending");
    const first = await env.DB.prepare(
      "SELECT cursor_key, next_object_number FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first<{ cursor_key: string; next_object_number: number }>();
    expect(first).toEqual({ cursor_key: "1", next_object_number: 1 });

    const resumed = service({ pageRowLimit: 1 });
    expect((await resumed.continueActive(runDate)).outcome).toBe("pending");
    const second = await env.DB.prepare(
      "SELECT cursor_key, next_object_number FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first<{ cursor_key: string; next_object_number: number }>();
    expect(second).toEqual({ cursor_key: "2", next_object_number: 2 });
    expect((await finishBackup(resumed, { outcome: "pending", detail: "continue" })).outcome).toBe("verified");
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

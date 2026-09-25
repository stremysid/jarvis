import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES,
  MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES,
  MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES,
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_NOTICE,
  MEMORY_BACKUP_TABLES,
  MemoryBackupService,
  descriptorForCut,
  selectMemoryBackupRetentionDeletes,
  type MemoryBackupBucket,
  type MemoryBackupOutcome,
} from "../../src/backup/memory-backup.js";
import { appendEvents, resetArchiveFixture } from "../archive/archive-fixture.js";
import { clearMemoryBackupDataForTest } from "../persistence/migration.js";

const runDate = "2026-09-16";
const instant = new Date("2026-09-16T23:30:00.000Z");
const backupBucket = env.BACKUP as R2Bucket;
const migrationSql = import.meta.glob("../../src/persistence/migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

function tablesDeclaredByMigrations(): readonly string[] {
  const tables = new Set<string>();
  for (const sql of Object.entries(migrationSql).sort(([left], [right]) => left.localeCompare(right))
    .map(([, source]) => source)) {
    const changes: Array<Readonly<{ index: number; apply(): void }>> = [];
    for (const match of sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/giu)) {
      changes.push({ index: match.index, apply: () => { tables.add(match[1]!.toLowerCase()); } });
    }
    for (const match of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_]+)/giu)) {
      changes.push({ index: match.index, apply: () => { tables.delete(match[1]!.toLowerCase()); } });
    }
    for (const match of sql.matchAll(/ALTER\s+TABLE\s+([a-z0-9_]+)\s+RENAME\s+TO\s+([a-z0-9_]+)/giu)) {
      changes.push({
        index: match.index,
        apply: () => {
          tables.delete(match[1]!.toLowerCase());
          tables.add(match[2]!.toLowerCase());
        },
      });
    }
    changes.sort((left, right) => left.index - right.index).forEach((change) => { change.apply(); });
  }
  return [...tables].sort();
}

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

/**
 * The exact live-schema read the backup classifies from. The injection below
 * keys off this string and the test asserts it injected, so renaming the query
 * cannot leave the test green without exercising the exemption.
 */
const BACKUP_SCHEMA_QUERY = "SELECT name, sql FROM sqlite_schema WHERE type = 'table'";

/**
 * D1 refuses a CREATE inside the reserved `_cf_` namespace (SQLITE_AUTH), so
 * production's `_cf_KV` cannot be created with SQL here. This wraps the binding
 * so the one schema read the backup classifies from also returns the rows
 * Cloudflare would have created, and records what it injected so a test can show
 * the rows reached the classifier rather than assume they did.
 */
function databaseWithPlatformTables(
  platformTables: readonly Readonly<{ name: string; sql: string }>[],
  injected: string[],
): D1Database {
  const database = env.DB;
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string): D1PreparedStatement => {
          const statement = target.prepare(query);
          if (query !== BACKUP_SCHEMA_QUERY) return statement;
          injected.push(...platformTables.map(({ name }) => name));
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "all") {
                return async (): Promise<D1Result<{ name: string; sql: string }>> => {
                  const rows = await statementTarget.all<{ name: string; sql: string }>();
                  return { ...rows, results: [...rows.results, ...platformTables] };
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
              return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
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
    expect(manifest.databaseSchemaVersion).toBe("0048_note_sources_without_markdown_citation.sql");
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
      WHERE run_date = ?`).bind(runDate).first()).toEqual({ cursor_key: 48 });
    const eventObjects = await env.DB.prepare(`SELECT count(*) AS count FROM memory_backup_objects
      WHERE table_name = 'events'`).first<{ count: number }>();
    expect(eventObjects?.count).toBeGreaterThan(1);
    const result = await driveBackup(backup);
    expect(result.outcome.outcome).toBe("verified");
    expect(result.invocations).toBeLessThan(10);
  }, 120_000);

  it("completes a run whose own table cuts are fewer than the current table constant", async () => {
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
    await appendEvents(2);
    const backup = service({ stepsPerInvocation: 2, pageRowLimit: 1 });
    const first = await backup.runNightly(runDate);
    expect(first.outcome).toBe("pending");

    // A migration that adds a table gives the constant a cut index this run
    // never captured. The run must finish against the cuts it wrote, not ask for
    // the index the constant now has -- that read returned null and the run
    // failed as memory_backup_cut_missing.
    const kept = 3;
    const runId = await env.DB.prepare("SELECT run_id FROM memory_backup_runs WHERE run_date = ?")
      .bind(runDate).first<string>("run_id");
    if (runId === null) throw new Error("memory_backup_run_missing_for_growth_test");
    // The cut table is append-only by trigger, which is the product guarantee
    // this test must not weaken, so the trigger is dropped for exactly this
    // statement and restored from the schema's own text afterwards.
    const cutGuard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'memory_backup_table_cuts_delete_guard'`).first<{ sql: string }>();
    if (cutGuard === null) throw new Error("memory_backup_cut_delete_guard_missing");
    await env.DB.prepare("DROP TRIGGER memory_backup_table_cuts_delete_guard").run();
    try {
      await env.DB.prepare("DELETE FROM memory_backup_table_cuts WHERE run_id = ? AND table_index >= ?")
        .bind(runId, kept).run();
    } finally {
      await env.DB.prepare(cutGuard.sql).run();
    }

    let outcome: MemoryBackupOutcome = { outcome: "pending", detail: "seeded" };
    for (let invocation = 0; invocation < 80 && outcome.outcome === "pending"; invocation += 1) {
      outcome = await service({ stepsPerInvocation: 2 }).continueActive(runDate);
    }

    expect(outcome.outcome).toBe("verified");
    const cuts = await env.DB.prepare(
      "SELECT table_index FROM memory_backup_table_cuts WHERE run_id = ? ORDER BY table_index",
    ).bind(runId).all<{ table_index: number }>();
    expect(cuts.results.map(({ table_index }) => table_index)).toEqual([0, 1, 2]);
    const manifest = await readLatestManifest();
    expect(manifest.tableCuts).toHaveLength(kept);
    expect(kept).toBeLessThan(MEMORY_BACKUP_TABLES.length);
    expect((manifest.tableCuts as Array<{ table: string }>).map((cut) => cut.table))
      .toEqual(MEMORY_BACKUP_TABLES.slice(0, kept));
  }, 300_000);

  it("completes a run captured before a table was inserted in the middle of the list", async () => {
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
    await appendEvents(2);
    const backup = service({ stepsPerInvocation: 2, pageRowLimit: 1 });
    expect((await backup.runNightly(runDate)).outcome).toBe("pending");

    // 7b805fa2 inserted guided_assignment_answers mid-list. A run captured
    // before that deploy has no cut for it, and every later cut sits one index
    // lower than the table's index in the current constant. Rebuild exactly
    // that run: drop the cut and shift the later ones down by one.
    const inserted = "guided_assignment_answers";
    const insertedIndex = MEMORY_BACKUP_TABLES.indexOf(inserted);
    expect(insertedIndex).toBeGreaterThan(0);
    expect(insertedIndex).toBeLessThan(MEMORY_BACKUP_TABLES.length - 1);
    const runId = await env.DB.prepare("SELECT run_id FROM memory_backup_runs WHERE run_date = ?")
      .bind(runDate).first<string>("run_id");
    if (runId === null) throw new Error("memory_backup_run_missing_for_mid_list_test");
    expect(await env.DB.prepare(`SELECT current_table_index FROM memory_backup_runs WHERE run_id = ?`)
      .bind(runId).first("current_table_index")).toBeLessThan(insertedIndex);
    // The cut table is append-only by trigger. Both guards are dropped for
    // exactly these statements and restored from the schema's own text.
    const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'memory_backup_table_cuts_delete_guard', 'memory_backup_table_cuts_update_guard'
      )`).all<{ name: string; sql: string }>();
    expect(guards.results).toHaveLength(2);
    for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER ${guard.name}`).run();
    try {
      await env.DB.prepare("DELETE FROM memory_backup_table_cuts WHERE run_id = ? AND table_name = ?")
        .bind(runId, inserted).run();
      // Shift one row at a time in ascending order so the primary key never collides.
      for (let index = insertedIndex + 1; index < MEMORY_BACKUP_TABLES.length; index += 1) {
        await env.DB.prepare(`UPDATE memory_backup_table_cuts SET table_index = ?
          WHERE run_id = ? AND table_index = ?`).bind(index - 1, runId, index).run();
      }
    } finally {
      for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
    }

    let outcome: MemoryBackupOutcome = { outcome: "pending", detail: "seeded" };
    for (let invocation = 0; invocation < 80 && outcome.outcome === "pending"; invocation += 1) {
      outcome = await service({ stepsPerInvocation: 2 }).continueActive(runDate);
    }

    expect(outcome.outcome).toBe("verified");
    const manifest = await readLatestManifest();
    expect((manifest.tableCuts as Array<{ table: string }>).map((cut) => cut.table))
      .toEqual(MEMORY_BACKUP_TABLES.filter((table) => table !== inserted));
    const exported = (manifest.objects as Array<{ table: string }>).map((object) => object.table);
    expect(exported).toContain("events");
    expect(exported).not.toContain(inserted);
  }, 300_000);

  it("finds a cut's descriptor by its own table name when the table list has grown", () => {
    // `after` sorts after `middle` in the constant's original order. Inserting
    // `inserted` in front of it leaves every later index shifted, which is what
    // 7b805fa2 did to this exact list.
    const grown = Object.freeze([
      Object.freeze({ table: "principals", keyKind: "rowid" as const }),
      Object.freeze({ table: "inserted", keyKind: "rowid" as const }),
      Object.freeze({ table: "middle", keyKind: "rowid" as const }),
      Object.freeze({ table: "after", keyKind: "ordinal" as const }),
    ]);
    const cut = Object.freeze({ table: "after", keyKind: "ordinal" as const, tableIndex: 2 });

    expect(descriptorForCut(cut, grown)).toBe(grown[3]);
    expect(descriptorForCut({ table: "absent" }, grown)).toBeNull();
  });

  it("classifies every table declared by the migration files", () => {
    const migrated = tablesDeclaredByMigrations();
    const classified = new Set<string>([
      ...MEMORY_BACKUP_TABLES,
      ...MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES,
      ...MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES,
      ...MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES,
    ]);
    expect(migrated.filter((table) => !classified.has(table)).sort()).toEqual([]);
    expect(MEMORY_BACKUP_TABLES.filter((table) => !migrated.includes(table))).toEqual([]);
    expect([...MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES, ...MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES]
      .filter((table) => !migrated.includes(table))).toEqual([]);
    expect(MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES.filter((table) => migrated.includes(table))).toEqual([]);
    expect(classified.size).toBe(MEMORY_BACKUP_TABLES.length
      + MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES.length
      + MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES.length
      + MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES.length);
  });

  it("backs up living-note evidence while classifying rebuilt heads and checkpoints separately", () => {
    expect(MEMORY_BACKUP_TABLES).toEqual(expect.arrayContaining([
      "memory_topic_note_versions",
      "memory_topic_note_sources",
      "memory_topic_note_receipts",
      "memory_consolidation_change_receipts",
    ]));
    expect(MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES).toContain("memory_topic_note_heads");
    expect(MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES).toContain("memory_consolidation_model_steps");
  });

  it("allows only the exact restore runtime tables in a later backup", async () => {
    for (const table of MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES) {
      await env.DB.prepare(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY)`).run();
    }
    try {
      expect((await service().runNightly(runDate)).outcome).toBe("pending");
    } finally {
      for (const table of [...MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES].reverse()) {
        await env.DB.prepare(`DROP TABLE "${table}"`).run();
      }
    }
  });

  it("fails closed and alerts the owner when the live schema contains an unclassified table", async () => {
    await env.DB.prepare("CREATE TABLE memory_backup_unclassified_probe (id INTEGER PRIMARY KEY)").run();
    const notices: string[] = [];
    try {
      expect(await service({ notices }).runNightly(runDate)).toEqual({
        outcome: "failed",
        code: "memory_backup_operation_failed",
      });
      expect(notices).toEqual([MEMORY_BACKUP_NOTICE]);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_backup_runs").first())
        .toEqual({ count: 0 });
    } finally {
      await env.DB.prepare("DROP TABLE memory_backup_unclassified_probe").run();
    }
  });

  it("treats _cf_KV and an invented _cf_FUTURE as Cloudflare bookkeeping rather than unclassified tables", async () => {
    const injected: string[] = [];
    const { outcome } = await driveBackup(service({ database: databaseWithPlatformTables([
      { name: "_cf_KV", sql: "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)" },
      { name: "_cf_FUTURE", sql: "CREATE TABLE _cf_FUTURE (id INTEGER PRIMARY KEY)" },
    ], injected) }));
    expect(outcome.outcome).toBe("verified");
    expect(injected).toEqual(["_cf_KV", "_cf_FUTURE"]);
  });

  it("relies on D1 refusing an application table in the reserved _cf_ namespace", async () => {
    await expect(env.DB.prepare("CREATE TABLE _cf_APPLICATION_SQUAT (id INTEGER PRIMARY KEY)").run())
      .rejects.toThrow(/SQLITE_AUTH/u);
  });

  it("keeps unchanged nightly row counts stable and limits scheduled runs to the last 48 hours", async () => {
    await appendEvents(8);
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO scheduled_runs (job, run_key, started_at, finished_at, failure)
        VALUES ('poll', 'old', '2026-09-14T23:29:59.999Z', '2026-09-14T23:30:00.000Z', NULL)`),
      env.DB.prepare(`INSERT INTO scheduled_runs (job, run_key, started_at, finished_at, failure)
        VALUES ('poll', 'edge', '2026-09-14T23:30:00.000Z', '2026-09-14T23:31:00.000Z', NULL)`),
      env.DB.prepare(`INSERT INTO scheduled_runs (job, run_key, started_at, finished_at, failure)
        VALUES ('poll', 'recent', '2026-09-16T23:00:00.000Z', NULL, NULL)`),
    ]);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM scheduled_runs
      WHERE started_at >= '2026-09-14T23:30:00.000Z'`).first()).toEqual({ count: 2 });
    const totals: number[] = [];
    for (let night = 1; night <= 4; night += 1) {
      const date = `2026-09-${String(night).padStart(2, "0")}`;
      expect((await driveBackup(service(), date)).outcome.outcome).toBe("verified");
      const run = await env.DB.prepare("SELECT run_id FROM memory_backup_runs WHERE run_date = ?")
        .bind(date).first<{ run_id: string }>();
      const total = await env.DB.prepare(`SELECT sum(expected_row_count) AS count
        FROM memory_backup_table_cuts WHERE run_id = ?`).bind(run?.run_id).first<{ count: number }>();
      totals.push(total?.count ?? -1);
    }
    expect(new Set(totals)).toEqual(new Set([totals[0]]));
    const manifest = await readLatestManifest();
    const scheduledRows: Array<Record<string, unknown>> = [];
    for (const object of (manifest.objects as Array<{ table: string; objectKey: string }>)
      .filter((candidate) => candidate.table === "scheduled_runs")) {
      const body = await backupBucket.get(object.objectKey);
      if (body === null) throw new Error("scheduled backup object missing");
      scheduledRows.push(...(await body.text()).trim().split("\n").map((line) => JSON.parse(line)));
    }
    expect(scheduledRows.map((row) => row.run_key)).toEqual(["edge", "recent"]);
    expect((manifest.tableCuts as Array<Record<string, unknown>>)
      .find((cut) => cut.table === "scheduled_runs")).toMatchObject({
      expectedRowCount: 2,
      exportedRowCount: 2,
      shortfallRowCount: 0,
    });
  }, 300_000);

  it("records rows deleted after the cut as a manifest shortfall", async () => {
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
    await env.DB.prepare(`INSERT INTO scheduled_runs (job, run_key, started_at, finished_at, failure)
      VALUES ('poll', 'deleted-after-cut', '2026-09-16T23:00:00.000Z', NULL, NULL)`).run();
    const backup = service({ stepsPerInvocation: 2 });
    const first = await backup.runNightly(runDate);
    expect(first.outcome).toBe("pending");
    await env.DB.prepare("DELETE FROM scheduled_runs WHERE job = 'poll' AND run_key = 'deleted-after-cut'").run();
    expect((await finishBackup(service(), first)).outcome).toBe("verified");
    const manifest = await readLatestManifest();
    expect((manifest.tableCuts as Array<Record<string, unknown>>)
      .find((cut) => cut.table === "scheduled_runs")).toMatchObject({
      expectedRowCount: 1,
      exportedRowCount: 0,
      shortfallRowCount: 1,
    });
  }, 120_000);

  it("pages WITHOUT ROWID sources from an ordinal range and indexed primary-key lookups", async () => {
    const principalId = "principal:backup-query-plan";
    const jobId = "01k5nm0000000000000000000z";
    const deleteGuard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'memory_literal_search_jobs_delete_forbidden'`)
      .first<{ sql: string }>();
    if (deleteGuard === null) throw new Error("literal search delete guard missing");
    onTestFinished(async () => {
      await env.DB.prepare("DROP TRIGGER memory_literal_search_jobs_delete_forbidden").run();
      try {
        await env.DB.prepare("DELETE FROM memory_literal_search_jobs WHERE job_id = ?").bind(jobId).run();
        await env.DB.prepare("DELETE FROM principals WHERE principal_id = ?").bind(principalId).run();
      } finally {
        await env.DB.prepare(deleteGuard.sql).run();
      }
    });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?, 'human', 'active', 'plan', ?, ?)`).bind(
        principalId, instant.toISOString(), instant.toISOString(),
      ),
      env.DB.prepare(`INSERT INTO memory_literal_search_jobs (
        job_id, principal_id, job_key, attempt, query_text, query_hash,
        snapshot_event_sequence, checkpoint_event_sequence, scanned_event_count,
        matched_event_count, status, failure_code, created_at, updated_at, completed_at
      ) VALUES (?, ?, 'backup-plan', 1, 'backup', ?, 0, 0, 0, 0,
        'pending', NULL, ?, ?, NULL)`).bind(
        jobId, principalId, "a".repeat(64), instant.toISOString(), instant.toISOString(),
      ),
    ]);
    const preparedSql: string[] = [];
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          preparedSql.push(sql);
          return target.prepare(sql);
        };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1Database;
    expect(await driveBackup(service({ database }))).toMatchObject({ outcome: { outcome: "verified" } });
    expect(await env.DB.prepare(`SELECT key_1, key_2 FROM memory_backup_row_ordinals
      WHERE table_name = 'memory_literal_search_jobs'`).first()).toEqual({ key_1: jobId, key_2: null });
    const pageSql = preparedSql.find((sql) =>
      sql.includes(`FROM ordinal_page JOIN "memory_literal_search_jobs" source`));
    if (pageSql === undefined) throw new Error("WITHOUT ROWID page query missing");
    expect(pageSql).toContain("SELECT ordinal, key_1, key_2, key_3, key_4");
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${pageSql}`)
      .bind("memory_literal_search_jobs", 0, 1_000_000, 16).all<{ detail: string }>();
    expect(plan.results.some(({ detail }) => /SCAN source\b/u.test(detail))).toBe(false);
    expect(plan.results.some(({ detail }) =>
      /SEARCH source USING (?:(?:COVERING )?INDEX|PRIMARY KEY)/u.test(detail))).toBe(true);
  }, 120_000);

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
  }, 120_000);

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
    expect(first).toEqual({ cursor_key: 3, next_object_number: 3 });

    const resumed = service({ pageRowLimit: 1, stepsPerInvocation: 2 });
    expect((await resumed.continueActive(runDate)).outcome).toBe("pending");
    const second = await env.DB.prepare(
      "SELECT cursor_key, next_object_number FROM memory_backup_runs WHERE run_date = ?",
    ).bind(runDate).first<{ cursor_key: number | null; next_object_number: number }>();
    expect(second).toEqual({ cursor_key: 1, next_object_number: 4 });
    expect((await finishBackup(service(), { outcome: "pending", detail: "continue" })).outcome).toBe("verified");
  });

  it("keeps the reason for an unattributable failure instead of only its generic code", async () => {
    // The stored code is a closed set with a CHECK behind it, so an unexpected
    // failure has to report `operation`. What it must not do is lose the reason
    // with it: dropping the cause is what turned a missing migration into an
    // unattributable failure and cost a session of hunting. A `MemoryBackupError`
    // keeps its own code instead, which is what the neighbouring catch has always
    // done and this one did not.
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    onTestFinished(() => { spy.mockRestore(); });
    const unavailable = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return () => { throw new Error("memory_backup_database_unavailable"); };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as D1Database;

    const outcome = await service({ database: unavailable }).runNightly(runDate);

    expect(outcome).toEqual({ outcome: "failed", code: "memory_backup_operation_failed" });
    const flat = logged.flat();
    expect(flat).toContain("memory_backup_operation_failed");
    expect(flat.some((entry) => entry instanceof Error)).toBe(true);
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




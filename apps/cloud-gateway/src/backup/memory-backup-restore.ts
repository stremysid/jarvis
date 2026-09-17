import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import {
  MEMORY_BACKUP_LATEST_KEY,
  MEMORY_BACKUP_SELF_REFERENCES,
  MEMORY_BACKUP_TABLES,
  type MemoryBackupBucket,
  type MemoryBackupTableName,
} from "./memory-backup.js";

export interface MemoryBackupRestoreObject {
  readonly table: MemoryBackupTableName;
  readonly objectKey: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly sha256: string;
}

export interface MemoryBackupRestoreCut {
  readonly table: MemoryBackupTableName;
  readonly expectedRowCount: number;
  readonly exportedRowCount: number;
  readonly shortfallRowCount: number;
}

export interface MemoryBackupRestoreManifest {
  readonly schemaVersion: "1.0";
  readonly databaseSchemaVersion: string;
  readonly runDate: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly tableCuts: readonly MemoryBackupRestoreCut[];
  readonly objects: readonly MemoryBackupRestoreObject[];
}

export interface VerifiedMemoryBackupSet {
  readonly manifest: MemoryBackupRestoreManifest;
  readonly rowsByTable: RestoreRows;
}

export interface MemoryBackupRestorePointer {
  readonly schemaVersion: "1.0";
  readonly runDate: string;
  readonly runId: string;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
}

export interface MemoryBackupRestoreJobs {
  /** Return false when one bounded literal-history step completed but more work remains. */
  rebuildHistory(): Promise<void | boolean>;
  /** Return false when one bounded Vectorize step completed but more work remains. */
  rebuildVectors(): Promise<void | boolean>;
}

export interface MemoryBackupRestoreReport {
  readonly restoredRows: Readonly<Record<string, number>>;
  readonly shortfalls: Readonly<Record<string, number>>;
  readonly rebuiltItemStates: number;
  readonly rebuiltPlacementStates: number;
  readonly rebuiltCursors: number;
  readonly sealedThrough: number;
}

export type MemoryBackupRestorePhase =
  | "drop_triggers"
  | "reset_seeded_rows"
  | "insert_rows"
  | "rebuild_archive"
  | "rebuild_item_state"
  | "rebuild_placement_state"
  | "rebuild_history"
  | "rebuild_vectors"
  | "rebuild_fts"
  | "rebuild_cursors"
  | "recreate_triggers"
  | "verify"
  | "complete";

export type MemoryBackupRestoreStep =
  | Readonly<{ outcome: "pending"; phase: MemoryBackupRestorePhase; itemIndex: number }>
  | Readonly<{ outcome: "complete"; report: MemoryBackupRestoreReport }>;

type RestoreRows = ReadonlyMap<string, readonly Record<string, unknown>[]>;

type RestoreMigration = string | Readonly<{ name: string; sql: string }>;

const MIGRATION_SEEDED_ROWS = Object.freeze({
  archive_state: Object.freeze([1]),
  autonomy_mode: Object.freeze([1]),
  capability_tiers: Object.freeze([
    "contact.third_party",
    "delete.data",
    "notify.owner",
    "open.application",
    "read.archive",
    "read.deadlines",
    "read.repository",
    "spend.money",
    "vehicle.precondition",
    "vehicle.unlock",
    "write.calendar",
    "write.production",
    "write.project_file",
  ]),
  outbound_runtime_controls: Object.freeze([1]),
} as const);

const MIGRATION_SEEDED_KEYS = Object.freeze({
  archive_state: "singleton",
  autonomy_mode: "singleton",
  capability_tiers: "capability",
  outbound_runtime_controls: "singleton_id",
} as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireManifestShape(manifest: MemoryBackupRestoreManifest): void {
  if (!isRecord(manifest) || manifest.schemaVersion !== "1.0"
    || typeof manifest.databaseSchemaVersion !== "string" || manifest.databaseSchemaVersion.length === 0
    || typeof manifest.runDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(manifest.runDate)
    || typeof manifest.runId !== "string" || !/^[0-7][0-9a-hjkmnp-tv-z]{25}$/u.test(manifest.runId)
    || typeof manifest.startedAt !== "string"
    || !Array.isArray(manifest.tableCuts) || !Array.isArray(manifest.objects)) {
    throw new Error("memory_backup_restore_manifest_invalid");
  }
  const expectedTables = new Set<string>(MEMORY_BACKUP_TABLES);
  const seenCuts = new Set<string>();
  for (const cut of manifest.tableCuts) {
    if (!isRecord(cut) || typeof cut.table !== "string" || !expectedTables.has(cut.table)
      || seenCuts.has(cut.table) || !isNonnegativeSafeInteger(cut.expectedRowCount)
      || !isNonnegativeSafeInteger(cut.exportedRowCount)
      || !isNonnegativeSafeInteger(cut.shortfallRowCount)
      || cut.exportedRowCount > cut.expectedRowCount
      || cut.shortfallRowCount !== cut.expectedRowCount - cut.exportedRowCount) {
      throw new Error("memory_backup_restore_manifest_invalid");
    }
    seenCuts.add(cut.table);
  }
  if (seenCuts.size !== expectedTables.size
    || [...expectedTables].some((table) => !seenCuts.has(table))) {
    throw new Error("memory_backup_restore_manifest_invalid");
  }
  const objectKeys = new Set<string>();
  for (const object of manifest.objects) {
    if (!isRecord(object) || typeof object.table !== "string" || !expectedTables.has(object.table)
      || typeof object.objectKey !== "string" || object.objectKey.length === 0
      || objectKeys.has(object.objectKey)
      || !isNonnegativeSafeInteger(object.rowCount) || object.rowCount < 1
      || !isNonnegativeSafeInteger(object.byteCount) || object.byteCount < 1
      || typeof object.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(object.sha256)) {
      throw new Error("memory_backup_restore_manifest_invalid");
    }
    objectKeys.add(object.objectKey);
  }
}

/** Resolves latest.json and verifies its manifest hash before reading any data objects. */
export async function readLatestVerifiedMemoryBackup(
  bucket: MemoryBackupBucket,
): Promise<VerifiedMemoryBackupSet> {
  const pointerBody = await bucket.get(MEMORY_BACKUP_LATEST_KEY);
  if (pointerBody === null) throw new Error("memory_backup_restore_latest_missing");
  let pointer: unknown;
  try {
    pointer = JSON.parse(await pointerBody.text());
  } catch {
    throw new Error("memory_backup_restore_latest_invalid");
  }
  return readVerifiedMemoryBackupByPointer(bucket, pointer);
}

/** Reads the exact pointer recorded by the operator even if latest.json advances. */
export async function readVerifiedMemoryBackupByPointer(
  bucket: MemoryBackupBucket,
  pointer: unknown,
): Promise<VerifiedMemoryBackupSet> {
  const manifest = await readVerifiedMemoryBackupManifestByPointer(bucket, pointer);
  return Object.freeze({
    manifest,
    rowsByTable: await readVerifiedMemoryBackupRows(bucket, manifest),
  });
}

/** Verifies the pinned manifest without downloading its row objects. */
export async function readVerifiedMemoryBackupManifestByPointer(
  bucket: MemoryBackupBucket,
  pointer: unknown,
): Promise<MemoryBackupRestoreManifest> {
  if (!isRecord(pointer) || pointer.schemaVersion !== "1.0"
    || typeof pointer.runDate !== "string" || typeof pointer.runId !== "string"
    || typeof pointer.manifestObjectKey !== "string"
    || typeof pointer.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pointer.manifestSha256)) {
    throw new Error("memory_backup_restore_latest_invalid");
  }
  const manifestBody = await bucket.get(pointer.manifestObjectKey);
  if (manifestBody === null) throw new Error("memory_backup_restore_manifest_missing");
  const manifestBytes = new Uint8Array(await manifestBody.arrayBuffer());
  if (await sha256Hex(manifestBytes) !== pointer.manifestSha256) {
    throw new Error("memory_backup_restore_manifest_invalid");
  }
  let manifest: MemoryBackupRestoreManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as MemoryBackupRestoreManifest;
  } catch {
    throw new Error("memory_backup_restore_manifest_invalid");
  }
  requireManifestShape(manifest);
  if (manifest.runDate !== pointer.runDate || manifest.runId !== pointer.runId) {
    throw new Error("memory_backup_restore_manifest_invalid");
  }
  return manifest;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) throw new Error("memory_backup_restore_identifier_invalid");
  return `"${value}"`;
}

function finalTriggerSql(migrations: readonly string[]): ReadonlyMap<string, string> {
  const triggers = new Map<string, string>();
  for (const migration of migrations) {
    const changes: Array<Readonly<{ index: number; apply(): void }>> = [];
    for (const match of migration.matchAll(/(?:^|\r?\n)(CREATE TRIGGER ([a-z0-9_]+)\r?\n[\s\S]*?\r?\nEND;)/gmu)) {
      const sql = match[1]!;
      const name = match[2]!;
      changes.push({ index: match.index, apply: () => { triggers.set(name, sql); } });
    }
    for (const match of migration.matchAll(/DROP TRIGGER(?: IF EXISTS)? ([a-z0-9_]+);/giu)) {
      const name = match[1]!;
      changes.push({ index: match.index, apply: () => { triggers.delete(name); } });
    }
    changes.sort((left, right) => left.index - right.index).forEach((change) => { change.apply(); });
  }
  return triggers;
}

async function migrationSqlThrough(
  database: D1Database,
  schemaVersion: string,
  migrations: readonly RestoreMigration[],
): Promise<readonly string[]> {
  const receipts = await database.prepare(
    "SELECT name FROM d1_migrations ORDER BY id",
  ).all<{ name: string }>();
  if (receipts.results.at(-1)?.name !== schemaVersion) {
    throw new Error("memory_backup_restore_schema_mismatch");
  }
  const named = migrations.every((migration) => typeof migration !== "string");
  const unnamed = migrations.every((migration) => typeof migration === "string");
  if (!named && !unnamed) throw new Error("memory_backup_restore_migrations_invalid");
  if (unnamed) {
    if (migrations.length < receipts.results.length) {
      throw new Error("memory_backup_restore_migrations_missing");
    }
    return migrations.slice(0, receipts.results.length) as readonly string[];
  }
  const records = migrations as readonly Readonly<{ name: string; sql: string }>[];
  const schemaIndex = records.findIndex(({ name }) => name === schemaVersion);
  if (schemaIndex < 0) throw new Error("memory_backup_restore_migrations_missing");
  const prefix = records.slice(0, schemaIndex + 1);
  if (prefix.length !== receipts.results.length
    || prefix.some(({ name }, index) => name !== receipts.results[index]?.name)) {
    throw new Error("memory_backup_restore_migrations_invalid");
  }
  return prefix.map(({ sql }) => sql);
}

async function assertFreshRestoreTarget(database: D1Database): Promise<void> {
  const counts = await database.batch(MEMORY_BACKUP_TABLES.map((table) =>
    database.prepare(`SELECT count(*) AS row_count FROM ${quoteIdentifier(table)}`)));
  for (let index = 0; index < MEMORY_BACKUP_TABLES.length; index += 1) {
    const table = MEMORY_BACKUP_TABLES[index]!;
    const count = (counts[index]?.results[0] as { row_count?: number } | undefined)?.row_count;
    const allowed = MIGRATION_SEEDED_ROWS[table as keyof typeof MIGRATION_SEEDED_ROWS]?.length ?? 0;
    if (count !== allowed) throw new Error(`memory_backup_restore_target_not_fresh:${table}`);
  }
  for (const [table, expected] of Object.entries(MIGRATION_SEEDED_ROWS)) {
    const key = MIGRATION_SEEDED_KEYS[table as keyof typeof MIGRATION_SEEDED_KEYS];
    const rows = await database.prepare(
      `SELECT ${quoteIdentifier(key)} AS seed_key FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(key)}`,
    ).all<{ seed_key: string | number }>();
    if (canonicalJson(rows.results.map(({ seed_key }) => seed_key)) !== canonicalJson(expected)) {
      throw new Error(`memory_backup_restore_target_not_fresh:${table}`);
    }
  }
}

async function assertRestoreTargetPreflight(
  database: D1Database,
  triggers: ReadonlyMap<string, string>,
): Promise<void> {
  await assertFreshRestoreTarget(database);
  const live = await database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
  ).all<{ name: string }>();
  const liveNames = new Set(live.results.map(({ name }) => name));
  if (liveNames.size !== triggers.size || [...triggers.keys()].some((name) => !liveNames.has(name))) {
    throw new Error("memory_backup_restore_trigger_classification_invalid");
  }
}

async function rebuildArchiveMark(
  database: D1Database,
): Promise<number> {
  const contiguous = await database.prepare(`WITH RECURSIVE valid AS (
      SELECT manifest.start_sequence, manifest.end_sequence, manifest.sealed_at
      FROM archive_manifests manifest
      JOIN archive_segments segment ON segment.manifest_id = manifest.manifest_id
      WHERE manifest.status = 'sealed'
        AND (SELECT count(*) FROM archive_segment_events event
          WHERE event.segment_id = segment.segment_id) = manifest.event_count
        AND (SELECT min(event_sequence) FROM archive_segment_events event
          WHERE event.segment_id = segment.segment_id) = manifest.start_sequence
        AND (SELECT max(event_sequence) FROM archive_segment_events event
          WHERE event.segment_id = segment.segment_id) = manifest.end_sequence
    ), chain(end_sequence, sealed_at) AS (
      SELECT end_sequence, sealed_at FROM valid WHERE start_sequence = 1
      UNION
      SELECT next.end_sequence,
        CASE WHEN next.sealed_at > chain.sealed_at THEN next.sealed_at ELSE chain.sealed_at END
      FROM chain JOIN valid next ON next.start_sequence = chain.end_sequence + 1
    )
    SELECT end_sequence, sealed_at FROM chain ORDER BY end_sequence DESC LIMIT 1`)
    .first<{ end_sequence: number; sealed_at: string }>();
  const sealedThrough = contiguous?.end_sequence ?? 0;
  const source = await database.prepare(`SELECT updated_at FROM archive_state WHERE singleton = 1`)
    .first<{ updated_at: string }>();
  await database.prepare(`UPDATE archive_state SET sealed_through = ?, updated_at = ?
    WHERE singleton = 1`).bind(
    sealedThrough,
    contiguous?.sealed_at ?? source?.updated_at ?? "1970-01-01T00:00:00.000Z",
  ).run();
  return sealedThrough;
}

async function rebuildItemState(database: D1Database): Promise<number> {
  await database.prepare("DELETE FROM memory_item_state").run();
  const result = await database.prepare(`INSERT INTO memory_item_state (
    principal_id, item_id, current_version_id, lifecycle_state,
    last_transition_id, last_transition_number, updated_at
  ) SELECT transition_row.principal_id, transition_row.item_id, transition_row.version_id,
      transition_row.lifecycle_state, transition_row.transition_id,
      transition_row.transition_number, transition_row.occurred_at
    FROM memory_item_transitions transition_row
    WHERE NOT EXISTS (
      SELECT 1 FROM memory_item_transitions later
      WHERE later.principal_id = transition_row.principal_id
        AND later.item_id = transition_row.item_id
        AND later.transition_number > transition_row.transition_number
    )`).run();
  return result.meta.changes ?? 0;
}

async function rebuildPlacementState(database: D1Database): Promise<number> {
  await database.prepare("DELETE FROM memory_item_placement_state").run();
  const result = await database.prepare(`INSERT INTO memory_item_placement_state (
    principal_id, placement_id, item_id, topic_id, relation, status,
    last_event_kind, last_event_id, last_placement_event_number, updated_at
  ) SELECT placement.principal_id, placement.placement_id, placement.item_id,
      COALESCE((
        SELECT topic_event.merge_target_topic_id FROM memory_topic_events topic_event
        JOIN json_each(topic_event.moved_placement_ids_json) moved
          ON moved.value = placement.placement_id
        WHERE topic_event.principal_id = placement.principal_id
          AND topic_event.operation = 'merge'
          AND (topic_event.occurred_at > placement.occurred_at
            OR (topic_event.occurred_at = placement.occurred_at
              AND topic_event.topic_event_id > placement.placement_event_id))
        ORDER BY topic_event.occurred_at DESC, topic_event.topic_event_id DESC LIMIT 1
      ), CASE WHEN placement.operation = 'remove'
        THEN placement.previous_topic_id ELSE placement.new_topic_id END),
      placement.relation, CASE WHEN placement.operation = 'remove' THEN 'removed' ELSE 'active' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM memory_topic_events topic_event
        JOIN json_each(topic_event.moved_placement_ids_json) moved
          ON moved.value = placement.placement_id
        WHERE topic_event.principal_id = placement.principal_id
          AND topic_event.operation = 'merge'
          AND (topic_event.occurred_at > placement.occurred_at
            OR (topic_event.occurred_at = placement.occurred_at
              AND topic_event.topic_event_id > placement.placement_event_id))
      ) THEN 'topic' ELSE 'placement' END,
      COALESCE((
        SELECT topic_event.topic_event_id FROM memory_topic_events topic_event
        JOIN json_each(topic_event.moved_placement_ids_json) moved
          ON moved.value = placement.placement_id
        WHERE topic_event.principal_id = placement.principal_id
          AND topic_event.operation = 'merge'
          AND (topic_event.occurred_at > placement.occurred_at
            OR (topic_event.occurred_at = placement.occurred_at
              AND topic_event.topic_event_id > placement.placement_event_id))
        ORDER BY topic_event.occurred_at DESC, topic_event.topic_event_id DESC LIMIT 1
      ), placement.placement_event_id), placement.placement_event_number,
      COALESCE((
        SELECT topic_event.occurred_at FROM memory_topic_events topic_event
        JOIN json_each(topic_event.moved_placement_ids_json) moved
          ON moved.value = placement.placement_id
        WHERE topic_event.principal_id = placement.principal_id
          AND topic_event.operation = 'merge'
          AND (topic_event.occurred_at > placement.occurred_at
            OR (topic_event.occurred_at = placement.occurred_at
              AND topic_event.topic_event_id > placement.placement_event_id))
        ORDER BY topic_event.occurred_at DESC, topic_event.topic_event_id DESC LIMIT 1
      ), placement.occurred_at)
    FROM memory_item_placement_events placement
    WHERE NOT EXISTS (
      SELECT 1 FROM memory_item_placement_events later
      WHERE later.principal_id = placement.principal_id
        AND later.placement_id = placement.placement_id
        AND later.placement_event_number > placement.placement_event_number
    )`).run();
  return result.meta.changes ?? 0;
}

async function rebuildFts(database: D1Database): Promise<void> {
  for (const table of [
    "memory_fact_projection_fts", "memory_item_fts", "memory_episode_fts", "memory_history_fts",
  ]) {
    await database.prepare(`INSERT INTO ${quoteIdentifier(table)} (${quoteIdentifier(table)}) VALUES ('rebuild')`).run();
  }
}

async function rebuildCursors(database: D1Database): Promise<number> {
  const sources = [
    `WITH RECURSIVE valid AS (
      SELECT run.principal_id, run.start_event_sequence, run.end_event_sequence,
        coalesce(run.completed_at, run.started_at) AS updated_at
      FROM memory_runs run
      WHERE run.job = 'distillation'
        AND run.outcome IN ('succeeded', 'nothing_new')
        AND run.start_event_sequence IS NOT NULL
        AND run.end_event_sequence IS NOT NULL
        AND run.input_event_count = run.end_event_sequence - run.start_event_sequence + 1
        AND run.input_event_count = (
          SELECT count(*) FROM memory_distillation_event_receipts receipt
          WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
        )
        AND run.created_item_count = (
          SELECT coalesce(sum(receipt.created_in_run), 0)
          FROM memory_distillation_item_receipts receipt
          WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
        )
        AND ((run.outcome = 'succeeded' AND EXISTS (
          SELECT 1 FROM memory_distillation_item_receipts receipt
          WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
        )) OR (run.outcome = 'nothing_new' AND NOT EXISTS (
          SELECT 1 FROM memory_distillation_item_receipts receipt
          WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
        )))
    ), chain(principal_id, end_event_sequence, updated_at) AS (
      SELECT principal_id, end_event_sequence, updated_at
      FROM valid WHERE start_event_sequence = 1
      UNION
      SELECT next.principal_id, next.end_event_sequence,
        CASE WHEN next.updated_at > chain.updated_at THEN next.updated_at ELSE chain.updated_at END
      FROM chain JOIN valid next
        ON next.principal_id = chain.principal_id
        AND next.start_event_sequence = chain.end_event_sequence + 1
    )
    SELECT principal_id, 'distillation' AS cursor_name,
      max(end_event_sequence) AS current_event_sequence, max(updated_at) AS updated_at
    FROM chain GROUP BY principal_id`,
    `SELECT principal_id, 'fts_history' AS cursor_name,
      max(end_event_sequence) AS current_event_sequence, max(indexed_at) AS updated_at
      FROM memory_history_coverage GROUP BY principal_id`,
  ] as const;
  for (const source of sources) {
    await database.prepare(`INSERT INTO memory_cursors (
        principal_id, cursor_name, current_event_sequence, updated_at
      )
      SELECT derived.principal_id, derived.cursor_name,
        derived.current_event_sequence, derived.updated_at
      FROM (${source}) derived
      WHERE derived.current_event_sequence IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM memory_cursors cursor_row
        WHERE cursor_row.principal_id = derived.principal_id
          AND cursor_row.cursor_name = derived.cursor_name
      )`).run();
    const mismatch = await database.prepare(`SELECT count(*) AS count FROM (${source}) derived
      JOIN memory_cursors cursor_row
        ON cursor_row.principal_id = derived.principal_id
        AND cursor_row.cursor_name = derived.cursor_name
      WHERE derived.current_event_sequence IS NOT NULL
        AND cursor_row.current_event_sequence <> derived.current_event_sequence`)
      .first<{ count: number }>();
    if ((mismatch?.count ?? 0) > 0) throw new Error("memory_backup_restore_cursor_rebuild_mismatch");
  }
  const unexpected = await database.prepare(`SELECT count(*) AS count FROM memory_cursors
    WHERE cursor_name NOT IN ('distillation', 'fts_history')`).first<{ count: number }>();
  if ((unexpected?.count ?? 0) > 0) throw new Error("memory_backup_restore_cursor_name_invalid");
  const rebuilt = await database.prepare(`SELECT count(*) AS count FROM memory_cursors
    WHERE cursor_name IN ('distillation', 'fts_history')`).first<{ count: number }>();
  return rebuilt?.count ?? 0;
}

async function assertAuthoritativeCounts(database: D1Database, rowsByTable: RestoreRows): Promise<void> {
  for (const table of MEMORY_BACKUP_TABLES) {
    const count = await database.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`)
      .first<{ count: number }>();
    const expected = table === "archive_state" ? 1 : (rowsByTable.get(table)?.length ?? 0);
    if (count?.count !== expected) throw new Error(`memory_backup_restore_target_not_fresh:${table}`);
  }
}

function appendDecodedObject(
  object: MemoryBackupRestoreObject,
  text: string,
  rows: Map<string, Record<string, unknown>[]>,
  objectTotals: Map<string, number>,
): void {
  let decoded: Record<string, unknown>[];
  try {
    decoded = text.length === 0 ? [] : text.trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    throw new Error(`memory_backup_restore_object_invalid:${object.objectKey}`);
  }
  if (decoded.length !== object.rowCount || decoded.some((row) => !isRecord(row))) {
    throw new Error(`memory_backup_restore_object_row_count_invalid:${object.objectKey}`);
  }
  const tableRows = rows.get(object.table) ?? [];
  tableRows.push(...decoded);
  rows.set(object.table, tableRows);
  objectTotals.set(object.table, (objectTotals.get(object.table) ?? 0) + decoded.length);
}

function assertObjectTotals(
  manifest: MemoryBackupRestoreManifest,
  objectTotals: ReadonlyMap<string, number>,
): void {
  for (const cut of manifest.tableCuts) {
    const exported = objectTotals.get(cut.table) ?? 0;
    if (cut.exportedRowCount !== exported
      || cut.shortfallRowCount !== cut.expectedRowCount - exported
      || cut.shortfallRowCount < 0) {
      throw new Error(`memory_backup_restore_manifest_count_invalid:${cut.table}`);
    }
  }
}

/** Reads and verifies every object before any target mutation begins. */
export async function readVerifiedMemoryBackupRows(
  bucket: MemoryBackupBucket,
  manifest: MemoryBackupRestoreManifest,
): Promise<RestoreRows> {
  requireManifestShape(manifest);
  const rows = new Map<string, Record<string, unknown>[]>();
  const objectTotals = new Map<string, number>();
  for (const object of manifest.objects) {
    const body = await bucket.get(object.objectKey);
    if (body === null || body.size !== object.byteCount) {
      throw new Error(`memory_backup_restore_object_missing:${object.objectKey}`);
    }
    const bytes = new Uint8Array(await body.arrayBuffer());
    if (bytes.byteLength !== object.byteCount || await sha256Hex(bytes) !== object.sha256) {
      throw new Error(`memory_backup_restore_object_invalid:${object.objectKey}`);
    }
    appendDecodedObject(object, new TextDecoder().decode(bytes), rows, objectTotals);
  }
  assertObjectTotals(manifest, objectTotals);
  return rows;
}

const RESTORE_CACHE_PROGRESS_TABLE = "memory_backup_restore_cache_progress";
const RESTORE_CACHE_OBJECT_TABLE = "memory_backup_restore_cache_objects";

interface RestoreCacheProgressRow {
  restore_id: string;
  pointer_hash: string;
  schema_version: string;
  manifest_json: string;
  state: "caching" | "verifying" | "ready";
  next_object_index: number;
  set_hash: string | null;
}

interface RestoreCacheObjectRow {
  object_index: number;
  object_key: string;
  table_name: string;
  row_count: number;
  byte_count: number;
  sha256: string;
  object_text: string;
}

export interface MemoryBackupRestoreCacheOptions {
  readonly database: D1Database;
  readonly bucket: MemoryBackupBucket;
  readonly pointer: MemoryBackupRestorePointer;
  readonly migrationSql: readonly RestoreMigration[];
  readonly maxObjectsPerStep?: number;
}

export type MemoryBackupRestoreCacheStep =
  | Readonly<{ outcome: "pending"; phase: "cache_set"; itemIndex: number }>
  | Readonly<{
    outcome: "ready";
    set: VerifiedMemoryBackupSet;
    setHash: string;
  }>;

async function readRestoreCacheProgress(database: D1Database): Promise<RestoreCacheProgressRow | null> {
  const exists = await database.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name = ?`).bind(RESTORE_CACHE_PROGRESS_TABLE).first<{ name: string }>();
  if (exists === null) return null;
  const progress = await database.prepare(`SELECT restore_id, pointer_hash, schema_version,
    manifest_json, state, next_object_index, set_hash
    FROM ${RESTORE_CACHE_PROGRESS_TABLE} WHERE singleton = 1`).first<RestoreCacheProgressRow>();
  if (progress === null) throw new Error("memory_backup_restore_cache_progress_invalid");
  return progress;
}

async function readCachedSet(
  database: D1Database,
  manifest: MemoryBackupRestoreManifest,
): Promise<VerifiedMemoryBackupSet> {
  const cached = await database.prepare(`SELECT object_index, object_key, table_name,
    row_count, byte_count, sha256, object_text
    FROM ${RESTORE_CACHE_OBJECT_TABLE} ORDER BY object_index`).all<RestoreCacheObjectRow>();
  if (cached.results.length !== manifest.objects.length) {
    throw new Error("memory_backup_restore_cache_progress_invalid");
  }
  const rows = new Map<string, Record<string, unknown>[]>();
  const totals = new Map<string, number>();
  for (let index = 0; index < manifest.objects.length; index += 1) {
    const object = manifest.objects[index]!;
    const stored = cached.results[index]!;
    if (stored.object_index !== index || stored.object_key !== object.objectKey
      || stored.table_name !== object.table || stored.row_count !== object.rowCount
      || stored.byte_count !== object.byteCount || stored.sha256 !== object.sha256) {
      throw new Error("memory_backup_restore_cache_progress_invalid");
    }
    appendDecodedObject(object, stored.object_text, rows, totals);
  }
  assertObjectTotals(manifest, totals);
  return Object.freeze({ manifest, rowsByTable: rows });
}

/**
 * Verifies each pinned R2 object once, then serves every restore continuation
 * from a durable D1 cache. A killed cache page resumes at its committed object.
 */
export async function cacheVerifiedMemoryBackupSet(
  options: Readonly<MemoryBackupRestoreCacheOptions>,
): Promise<MemoryBackupRestoreCacheStep> {
  const limit = options.maxObjectsPerStep ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 63) {
    throw new RangeError("memory_backup_restore_cache_step_limit_invalid");
  }
  const pointerHash = await sha256Hex(canonicalJson(options.pointer));
  let progress = await readRestoreCacheProgress(options.database);
  if (progress === null) {
    const manifest = await readVerifiedMemoryBackupManifestByPointer(options.bucket, options.pointer);
    const selectedMigrations = await migrationSqlThrough(
      options.database, manifest.databaseSchemaVersion, options.migrationSql,
    );
    await assertRestoreTargetPreflight(options.database, finalTriggerSql(selectedMigrations));
    await options.database.batch([
      options.database.prepare(`CREATE TABLE ${RESTORE_CACHE_PROGRESS_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        restore_id TEXT NOT NULL,
        pointer_hash TEXT NOT NULL CHECK (
          length(pointer_hash) = 64 AND pointer_hash NOT GLOB '*[^0-9a-f]*'
        ),
        schema_version TEXT NOT NULL,
        manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
        state TEXT NOT NULL CHECK (state IN ('caching', 'verifying', 'ready')),
        next_object_index INTEGER NOT NULL CHECK (next_object_index >= 0),
        set_hash TEXT CHECK (set_hash IS NULL OR (
          length(set_hash) = 64 AND set_hash NOT GLOB '*[^0-9a-f]*'
        ))
      ) STRICT`),
      options.database.prepare(`CREATE TABLE ${RESTORE_CACHE_OBJECT_TABLE} (
        object_index INTEGER PRIMARY KEY CHECK (object_index >= 0),
        object_key TEXT NOT NULL UNIQUE,
        table_name TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count > 0),
        byte_count INTEGER NOT NULL CHECK (byte_count > 0),
        sha256 TEXT NOT NULL CHECK (
          length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        object_text TEXT NOT NULL
      ) STRICT`),
      options.database.prepare(`INSERT INTO ${RESTORE_CACHE_PROGRESS_TABLE} (
        singleton, restore_id, pointer_hash, schema_version, manifest_json,
        state, next_object_index, set_hash
      ) VALUES (1, ?, ?, ?, ?, 'caching', 0, NULL)`)
        .bind(manifest.runId, pointerHash, manifest.databaseSchemaVersion, canonicalJson(manifest)),
    ]);
    return Object.freeze({ outcome: "pending", phase: "cache_set", itemIndex: 0 });
  }
  if (progress.restore_id !== options.pointer.runId || progress.pointer_hash !== pointerHash) {
    throw new Error("memory_backup_restore_progress_mismatch");
  }
  let manifest: MemoryBackupRestoreManifest;
  try {
    manifest = JSON.parse(progress.manifest_json) as MemoryBackupRestoreManifest;
    requireManifestShape(manifest);
  } catch {
    throw new Error("memory_backup_restore_cache_progress_invalid");
  }
  if (manifest.runId !== progress.restore_id
    || manifest.databaseSchemaVersion !== progress.schema_version) {
    throw new Error("memory_backup_restore_cache_progress_invalid");
  }
  if (progress.state === "caching") {
    const page = manifest.objects.slice(
      progress.next_object_index,
      progress.next_object_index + limit,
    );
    const inserts: D1PreparedStatement[] = [];
    for (let offset = 0; offset < page.length; offset += 1) {
      const object = page[offset]!;
      const body = await options.bucket.get(object.objectKey);
      if (body === null || body.size !== object.byteCount) {
        throw new Error(`memory_backup_restore_object_missing:${object.objectKey}`);
      }
      const bytes = new Uint8Array(await body.arrayBuffer());
      if (bytes.byteLength !== object.byteCount || await sha256Hex(bytes) !== object.sha256) {
        throw new Error(`memory_backup_restore_object_invalid:${object.objectKey}`);
      }
      const text = new TextDecoder().decode(bytes);
      const decodedRows = new Map<string, Record<string, unknown>[]>();
      const decodedTotals = new Map<string, number>();
      appendDecodedObject(object, text, decodedRows, decodedTotals);
      inserts.push(options.database.prepare(`INSERT INTO ${RESTORE_CACHE_OBJECT_TABLE} (
        object_index, object_key, table_name, row_count, byte_count, sha256, object_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
        progress.next_object_index + offset,
        object.objectKey,
        object.table,
        object.rowCount,
        object.byteCount,
        object.sha256,
        text,
      ));
    }
    const nextIndex = progress.next_object_index + page.length;
    const nextState = nextIndex === manifest.objects.length ? "verifying" : "caching";
    await options.database.batch([
      ...inserts,
      options.database.prepare(`UPDATE ${RESTORE_CACHE_PROGRESS_TABLE}
        SET state = ?, next_object_index = ? WHERE singleton = 1`)
        .bind(nextState, nextIndex),
    ]);
    if (nextState === "caching") {
      return Object.freeze({ outcome: "pending", phase: "cache_set", itemIndex: nextIndex });
    }
    progress = { ...progress, state: "verifying", next_object_index: nextIndex };
  }
  const set = await readCachedSet(options.database, manifest);
  if (progress.state === "verifying") {
    const setHash = await restoreSetHashFor(
      manifest.databaseSchemaVersion,
      set.rowsByTable,
      Object.fromEntries(manifest.tableCuts.map((cut) => [cut.table, cut.shortfallRowCount])),
    );
    await options.database.prepare(`UPDATE ${RESTORE_CACHE_PROGRESS_TABLE}
      SET state = 'ready', set_hash = ? WHERE singleton = 1`).bind(setHash).run();
    return Object.freeze({ outcome: "ready", set, setHash });
  }
  if (progress.set_hash === null || !/^[0-9a-f]{64}$/u.test(progress.set_hash)) {
    throw new Error("memory_backup_restore_cache_progress_invalid");
  }
  return Object.freeze({ outcome: "ready", set, setHash: progress.set_hash });
}

export interface MemoryBackupRestoreOptions {
  database: D1Database;
  databaseSchemaVersion: string;
  rowsByTable: RestoreRows;
  migrationSql: readonly RestoreMigration[];
  jobs: MemoryBackupRestoreJobs;
  shortfalls?: Readonly<Record<string, number>>;
  /** The verified manifest run id. Tests without a manifest derive a content hash. */
  restoreId?: string;
  /** Mutation statements per continuation. The preflight is read-only and bounded separately. */
  maxStatementsPerStep?: number;
  /** A hash computed while the operator durably cached and verified the pinned set. */
  verifiedSetHash?: string;
}

interface RestoreProgressRow {
  restore_id: string;
  set_hash: string;
  schema_version: string;
  phase: MemoryBackupRestorePhase;
  item_index: number;
  sealed_through: number;
  rebuilt_item_states: number;
  rebuilt_placement_states: number;
  rebuilt_cursors: number;
  finalized: number;
}

const RESTORE_PROGRESS_TABLE = "memory_backup_restore_progress";

function requireStepLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 8 || value > 128) {
    throw new RangeError("memory_backup_restore_step_limit_invalid");
  }
}

async function restoreSetHashFor(
  databaseSchemaVersion: string,
  rowsByTable: RestoreRows,
  shortfalls: Readonly<Record<string, number>>,
): Promise<string> {
  return sha256Hex(canonicalJson({
    databaseSchemaVersion,
    rows: MEMORY_BACKUP_TABLES.map((table) => [table, rowsByTable.get(table) ?? []]),
    shortfalls,
  }));
}

async function restoreSetHash(options: MemoryBackupRestoreOptions): Promise<string> {
  return restoreSetHashFor(
    options.databaseSchemaVersion,
    options.rowsByTable,
    options.shortfalls ?? {},
  );
}

async function readRestoreProgress(database: D1Database): Promise<RestoreProgressRow | null> {
  const exists = await database.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name = ?`).bind(RESTORE_PROGRESS_TABLE).first<{ name: string }>();
  if (exists === null) return null;
  const progress = await database.prepare(`SELECT restore_id, set_hash, schema_version, phase,
    item_index, sealed_through, rebuilt_item_states, rebuilt_placement_states, rebuilt_cursors,
    finalized
    FROM ${RESTORE_PROGRESS_TABLE} WHERE singleton = 1`).first<RestoreProgressRow>();
  if (progress === null) throw new Error("memory_backup_restore_progress_invalid");
  return progress;
}

async function initializeRestoreProgress(
  options: MemoryBackupRestoreOptions,
  restoreId: string,
  setHash: string,
  triggers: ReadonlyMap<string, string>,
): Promise<RestoreProgressRow> {
  await assertRestoreTargetPreflight(options.database, triggers);
  await options.database.batch([
    options.database.prepare(`CREATE TABLE ${RESTORE_PROGRESS_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      restore_id TEXT NOT NULL,
      set_hash TEXT NOT NULL CHECK (length(set_hash) = 64 AND set_hash NOT GLOB '*[^0-9a-f]*'),
      schema_version TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN (
        'drop_triggers', 'reset_seeded_rows', 'insert_rows', 'rebuild_archive',
        'rebuild_item_state', 'rebuild_placement_state', 'rebuild_history',
        'rebuild_vectors', 'rebuild_fts', 'rebuild_cursors', 'recreate_triggers',
        'verify', 'complete'
      )),
      item_index INTEGER NOT NULL CHECK (item_index >= 0),
      sealed_through INTEGER NOT NULL CHECK (sealed_through >= 0),
      rebuilt_item_states INTEGER NOT NULL CHECK (rebuilt_item_states >= 0),
      rebuilt_placement_states INTEGER NOT NULL CHECK (rebuilt_placement_states >= 0),
      rebuilt_cursors INTEGER NOT NULL CHECK (rebuilt_cursors >= 0),
      finalized INTEGER NOT NULL CHECK (finalized IN (0, 1))
    ) STRICT`),
    options.database.prepare(`INSERT INTO ${RESTORE_PROGRESS_TABLE} (
      singleton, restore_id, set_hash, schema_version, phase, item_index,
      sealed_through, rebuilt_item_states, rebuilt_placement_states, rebuilt_cursors, finalized
    ) VALUES (1, ?, ?, ?, 'drop_triggers', 0, 0, 0, 0, 0, 0)`)
      .bind(restoreId, setHash, options.databaseSchemaVersion),
  ]);
  const progress = await readRestoreProgress(options.database);
  if (progress === null) throw new Error("memory_backup_restore_progress_invalid");
  return progress;
}

function restoredRows(options: MemoryBackupRestoreOptions): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(MEMORY_BACKUP_TABLES.map((table) => [
    table, options.rowsByTable.get(table)?.length ?? 0,
  ])));
}

function restoreReport(
  options: MemoryBackupRestoreOptions,
  progress: RestoreProgressRow,
): MemoryBackupRestoreReport {
  return Object.freeze({
    restoredRows: restoredRows(options),
    shortfalls: Object.freeze({ ...(options.shortfalls ?? {}) }),
    rebuiltItemStates: progress.rebuilt_item_states,
    rebuiltPlacementStates: progress.rebuilt_placement_states,
    rebuiltCursors: progress.rebuilt_cursors,
    sealedThrough: progress.sealed_through,
  });
}

async function advanceProgress(
  database: D1Database,
  phase: MemoryBackupRestorePhase,
  itemIndex = 0,
  assignments = "",
  bindings: readonly unknown[] = [],
): Promise<void> {
  await database.prepare(`UPDATE ${RESTORE_PROGRESS_TABLE}
    SET phase = ?, item_index = ?${assignments} WHERE singleton = 1`)
    .bind(phase, itemIndex, ...bindings).run();
}

function dependencyOrderedRows(
  table: MemoryBackupTableName,
  rows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const descriptor = MEMORY_BACKUP_SELF_REFERENCES.find((candidate) => candidate.table === table);
  if (descriptor === undefined) return rows;
  const byKey = new Map<unknown, number>();
  rows.forEach((row, index) => {
    const key = row[descriptor.keyColumn];
    if (key === null || key === undefined || byKey.has(key)) {
      throw new Error(`memory_backup_restore_self_reference_key_invalid:${table}`);
    }
    byKey.set(key, index);
  });
  const indegree = rows.map(() => 0);
  const dependents = rows.map(() => [] as number[]);
  rows.forEach((row, index) => {
    const dependencies = new Set<number>();
    for (const column of descriptor.referenceColumns) {
      const target = byKey.get(row[column]);
      if (target !== undefined) dependencies.add(target);
    }
    indegree[index] = dependencies.size;
    for (const dependency of dependencies) dependents[dependency]!.push(index);
  });
  const ready = indegree.flatMap((count, index) => count === 0 ? [index] : []);
  const ordered: Record<string, unknown>[] = [];
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const index = ready[cursor]!;
    ordered.push(rows[index]!);
    for (const dependent of dependents[index]!) {
      indegree[dependent] = indegree[dependent]! - 1;
      if (indegree[dependent] === 0) ready.push(dependent);
    }
  }
  if (ordered.length !== rows.length) {
    throw new Error(`memory_backup_restore_self_reference_cycle:${table}`);
  }
  return ordered;
}

function authoritativeRows(options: MemoryBackupRestoreOptions): readonly Readonly<{
  table: MemoryBackupTableName;
  row: Record<string, unknown>;
}>[] {
  return MEMORY_BACKUP_TABLES.flatMap((table) =>
    dependencyOrderedRows(table, options.rowsByTable.get(table) ?? [])
      .map((row) => Object.freeze({ table, row })));
}

/**
 * Performs one durable restore step. Every mutation page is capped at 128
 * statements, and the progress row makes a killed invocation safe to rerun.
 */
export async function continueVerifiedMemoryBackupRestore(
  options: Readonly<MemoryBackupRestoreOptions>,
): Promise<MemoryBackupRestoreStep> {
  const limit = options.maxStatementsPerStep ?? 64;
  requireStepLimit(limit);
  const selectedMigrations = await migrationSqlThrough(
    options.database, options.databaseSchemaVersion, options.migrationSql,
  );
  const triggers = finalTriggerSql(selectedMigrations);
  const setHash = options.verifiedSetHash ?? await restoreSetHash(options);
  if (!/^[0-9a-f]{64}$/u.test(setHash)) {
    throw new Error("memory_backup_restore_set_hash_invalid");
  }
  const restoreId = options.restoreId ?? setHash;
  let progress = await readRestoreProgress(options.database)
    ?? await initializeRestoreProgress(options, restoreId, setHash, triggers);
  if (progress.restore_id !== restoreId || progress.set_hash !== setHash
    || progress.schema_version !== options.databaseSchemaVersion) {
    throw new Error("memory_backup_restore_progress_mismatch");
  }
  const triggerEntries = [...triggers.entries()];
  if (progress.phase === "drop_triggers") {
    const page = triggerEntries.slice(progress.item_index, progress.item_index + limit - 1);
    const nextIndex = progress.item_index + page.length;
    const nextPhase = nextIndex === triggerEntries.length ? "reset_seeded_rows" : "drop_triggers";
    await options.database.batch([
      ...page.map(([name]) => options.database.prepare(`DROP TRIGGER IF EXISTS ${quoteIdentifier(name)}`)),
      options.database.prepare(`UPDATE ${RESTORE_PROGRESS_TABLE} SET phase = ?, item_index = ?
        WHERE singleton = 1`).bind(nextPhase, nextPhase === "drop_triggers" ? nextIndex : 0),
    ]);
  } else if (progress.phase === "reset_seeded_rows") {
    await options.database.batch([
      ...Object.keys(MIGRATION_SEEDED_ROWS).reverse()
        .map((table) => options.database.prepare(`DELETE FROM ${quoteIdentifier(table)}`)),
      options.database.prepare(`UPDATE ${RESTORE_PROGRESS_TABLE}
        SET phase = 'insert_rows', item_index = 0 WHERE singleton = 1`),
    ]);
  } else if (progress.phase === "insert_rows") {
    const rows = authoritativeRows(options);
    const page = rows.slice(progress.item_index, progress.item_index + limit - 2);
    const nextIndex = progress.item_index + page.length;
    const nextPhase = nextIndex === rows.length ? "rebuild_archive" : "insert_rows";
    await options.database.batch([
      options.database.prepare("PRAGMA defer_foreign_keys = ON"),
      ...page.map(({ table, row }) => {
        const columns = Object.keys(row);
        return options.database.prepare(`INSERT INTO ${quoteIdentifier(table)} (
          ${columns.map(quoteIdentifier).join(", ")}
        ) VALUES (${columns.map(() => "?").join(", ")})`)
          .bind(...columns.map((column) => row[column]));
      }),
      options.database.prepare(`UPDATE ${RESTORE_PROGRESS_TABLE} SET phase = ?, item_index = ?
        WHERE singleton = 1`).bind(nextPhase, nextPhase === "insert_rows" ? nextIndex : 0),
    ]);
  } else if (progress.phase === "rebuild_archive") {
    const sealedThrough = await rebuildArchiveMark(options.database);
    await advanceProgress(
      options.database, "rebuild_item_state", 0, ", sealed_through = ?", [sealedThrough],
    );
  } else if (progress.phase === "rebuild_item_state") {
    const count = await rebuildItemState(options.database);
    await advanceProgress(
      options.database, "rebuild_placement_state", 0, ", rebuilt_item_states = ?", [count],
    );
  } else if (progress.phase === "rebuild_placement_state") {
    const count = await rebuildPlacementState(options.database);
    await advanceProgress(
      options.database, "rebuild_history", 0, ", rebuilt_placement_states = ?", [count],
    );
  } else if (progress.phase === "rebuild_history") {
    const complete = await options.jobs.rebuildHistory();
    if (complete !== false) await advanceProgress(options.database, "rebuild_vectors");
  } else if (progress.phase === "rebuild_vectors") {
    const complete = await options.jobs.rebuildVectors();
    if (complete !== false) await advanceProgress(options.database, "rebuild_fts");
  } else if (progress.phase === "rebuild_fts") {
    await rebuildFts(options.database);
    await advanceProgress(options.database, "rebuild_cursors");
  } else if (progress.phase === "rebuild_cursors") {
    const count = await rebuildCursors(options.database);
    await advanceProgress(
      options.database, "recreate_triggers", 0, ", rebuilt_cursors = ?", [count],
    );
  } else if (progress.phase === "recreate_triggers") {
    const page = triggerEntries.slice(progress.item_index, progress.item_index + limit - 1);
    const nextIndex = progress.item_index + page.length;
    const nextPhase = nextIndex === triggerEntries.length ? "verify" : "recreate_triggers";
    await options.database.batch([
      ...page.map(([, sql]) => options.database.prepare(sql)),
      options.database.prepare(`UPDATE ${RESTORE_PROGRESS_TABLE} SET phase = ?, item_index = ?
        WHERE singleton = 1`).bind(nextPhase, nextPhase === "recreate_triggers" ? nextIndex : 0),
    ]);
  } else if (progress.phase === "verify") {
    await assertAuthoritativeCounts(options.database, options.rowsByTable);
    const foreignKeys = await options.database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.results.length > 0) throw new Error("memory_backup_restore_foreign_key_check_failed");
    const live = await options.database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger'",
    ).all<{ name: string }>();
    const liveNames = new Set(live.results.map(({ name }) => name));
    if (liveNames.size !== triggers.size || [...triggers.keys()].some((name) => !liveNames.has(name))) {
      throw new Error("memory_backup_restore_trigger_rebuild_mismatch");
    }
    await advanceProgress(options.database, "complete");
  }
  progress = await readRestoreProgress(options.database) ?? progress;
  return progress.phase === "complete"
    ? Object.freeze({ outcome: "complete", report: restoreReport(options, progress) })
    : Object.freeze({ outcome: "pending", phase: progress.phase, itemIndex: progress.item_index });
}

/** Marks the saved completion receipt. Repeating this after a lost response is safe. */
export async function finalizeVerifiedMemoryBackupRestore(
  database: D1Database,
  restoreId: string,
): Promise<void> {
  const progress = await readRestoreProgress(database);
  if (progress === null || progress.phase !== "complete" || progress.restore_id !== restoreId) {
    throw new Error("memory_backup_restore_not_complete");
  }
  await database.prepare(`UPDATE ${RESTORE_PROGRESS_TABLE} SET finalized = 1
    WHERE singleton = 1 AND restore_id = ?`).bind(restoreId).run();
}

/**
 * Test and in-Worker convenience wrapper. Operators use the bounded continuation
 * above and keep the completion receipt until they have saved the report.
 */
export async function restoreVerifiedMemoryBackupRows(
  options: Readonly<MemoryBackupRestoreOptions>,
): Promise<MemoryBackupRestoreReport> {
  const setHash = await restoreSetHash(options);
  const restoreId = options.restoreId ?? setHash;
  for (let step = 0; step < 10_000; step += 1) {
    const outcome = await continueVerifiedMemoryBackupRestore({ ...options, restoreId });
    if (outcome.outcome === "complete") {
      await finalizeVerifiedMemoryBackupRestore(options.database, restoreId);
      return outcome.report;
    }
  }
  throw new Error("memory_backup_restore_did_not_complete");
}

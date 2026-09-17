import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import {
  MEMORY_BACKUP_LATEST_KEY,
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

export interface MemoryBackupRestoreJobs {
  /** Run the existing literal-history job until it reports complete. */
  rebuildHistory(): Promise<void>;
  /** Run the Vectorize writer until its D1 ledger and remote index agree. */
  rebuildVectors(): Promise<void>;
}

export interface MemoryBackupRestoreReport {
  readonly restoredRows: Readonly<Record<string, number>>;
  readonly shortfalls: Readonly<Record<string, number>>;
  readonly rebuiltItemStates: number;
  readonly rebuiltPlacementStates: number;
  readonly rebuiltCursors: number;
  readonly sealedThrough: number;
}

type RestoreRows = ReadonlyMap<string, readonly Record<string, unknown>[]>;

interface SchemaNameRow {
  name: string;
  sql: string | null;
}

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
  return Object.freeze({
    manifest,
    rowsByTable: await readVerifiedMemoryBackupRows(bucket, manifest),
  });
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

async function primaryKey(database: D1Database, table: string): Promise<readonly string[]> {
  const info = await database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all<{ name: string; pk: number }>();
  const columns = info.results.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk).map((column) => column.name);
  if (columns.length === 0) throw new Error(`memory_backup_restore_primary_key_missing:${table}`);
  return columns;
}

async function insertAuthoritativeRows(database: D1Database, rowsByTable: RestoreRows): Promise<void> {
  const statements: D1PreparedStatement[] = [database.prepare("PRAGMA defer_foreign_keys = ON")];
  for (const table of MEMORY_BACKUP_TABLES) {
    if (table === "archive_state") continue;
    const rows = rowsByTable.get(table) ?? [];
    const keys = await primaryKey(database, table);
    for (const row of rows) {
      const columns = Object.keys(row);
      const where = keys.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");
      const existing = await database.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`)
        .bind(...keys.map((column) => row[column])).first<Record<string, unknown>>();
      if (existing !== null) {
        if (canonicalJson(existing) !== canonicalJson(row)) {
          throw new Error(`memory_backup_restore_target_not_fresh:${table}`);
        }
        continue;
      }
      statements.push(database.prepare(`INSERT INTO ${quoteIdentifier(table)} (
        ${columns.map(quoteIdentifier).join(", ")}
      ) VALUES (${columns.map(() => "?").join(", ")})`).bind(...columns.map((column) => row[column])));
    }
  }
  await database.batch(statements);
  const foreignKeys = await database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.results.length > 0) throw new Error("memory_backup_restore_foreign_key_check_failed");
}

async function recreateTriggers(
  database: D1Database,
  triggers: ReadonlyMap<string, string>,
): Promise<void> {
  for (const sql of triggers.values()) await database.prepare(sql).run();
}

async function rebuildArchiveMark(
  database: D1Database,
  source: Record<string, unknown> | undefined,
): Promise<number> {
  const manifests = await database.prepare(`SELECT manifest.end_sequence, manifest.sealed_at
    FROM archive_manifests manifest
    JOIN archive_segments segment ON segment.manifest_id = manifest.manifest_id
    WHERE manifest.status = 'sealed'
      AND (SELECT count(*) FROM archive_segment_events event
        WHERE event.segment_id = segment.segment_id) = manifest.event_count
      AND (SELECT min(event_sequence) FROM archive_segment_events event
        WHERE event.segment_id = segment.segment_id) = manifest.start_sequence
      AND (SELECT max(event_sequence) FROM archive_segment_events event
        WHERE event.segment_id = segment.segment_id) = manifest.end_sequence
    ORDER BY manifest.start_sequence`).all<{ end_sequence: number; sealed_at: string }>();
  let sealedThrough = 0;
  for (const manifest of manifests.results) {
    const next = await database.prepare(`SELECT start_sequence FROM archive_manifests
      WHERE end_sequence = ?`).bind(manifest.end_sequence).first<{ start_sequence: number }>();
    if (next?.start_sequence !== sealedThrough + 1) break;
    await database.prepare(`UPDATE archive_state SET sealed_through = ?, updated_at = ?
      WHERE singleton = 1 AND sealed_through = ?`).bind(
      manifest.end_sequence, manifest.sealed_at, sealedThrough,
    ).run();
    sealedThrough = manifest.end_sequence;
  }
  if (source?.circuit_state === "open") {
    await database.prepare(`UPDATE archive_state SET circuit_state = 'open', circuit_reason = ?,
      circuit_opened_at = ?, updated_at = max(updated_at, ?) WHERE singleton = 1`).bind(
      source.circuit_reason, source.circuit_opened_at, source.updated_at,
    ).run();
  }
  return sealedThrough;
}

async function rebuildItemState(database: D1Database): Promise<number> {
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
    `SELECT principal_id, 'distillation' AS cursor_name,
      max(event_sequence) AS current_event_sequence, max(recorded_at) AS updated_at
      FROM memory_distillation_event_receipts GROUP BY principal_id`,
    `SELECT principal_id, 'summaries' AS cursor_name,
      max(end_event_sequence) AS current_event_sequence, max(created_at) AS updated_at
      FROM memory_episodes GROUP BY principal_id`,
    `SELECT principal_id, 'fts_items' AS cursor_name,
      max(event_sequence) AS current_event_sequence, max(created_at) AS updated_at
      FROM memory_item_sources GROUP BY principal_id`,
    `SELECT principal_id, 'fts_episodes' AS cursor_name,
      max(event_sequence) AS current_event_sequence, max(occurred_at) AS updated_at
      FROM memory_episode_sources GROUP BY principal_id`,
    `SELECT principal_id, 'fts_history' AS cursor_name,
      max(end_event_sequence) AS current_event_sequence, max(indexed_at) AS updated_at
      FROM memory_history_coverage GROUP BY principal_id`,
    `SELECT vector.principal_id, 'embeddings' AS cursor_name, max(CASE vector.item_kind
      WHEN 'item' THEN (SELECT max(source.event_sequence)
        FROM memory_item_versions version
        JOIN memory_item_sources source
          ON source.principal_id = version.principal_id AND source.version_id = version.version_id
        WHERE version.principal_id = vector.principal_id
          AND version.item_id = vector.item_id AND version.text_hash = vector.content_hash)
      WHEN 'episode' THEN (SELECT episode.end_event_sequence FROM memory_episodes episode
        WHERE episode.principal_id = vector.principal_id AND episode.episode_id = vector.item_id
          AND episode.content_hash = vector.content_hash)
      WHEN 'history_chunk' THEN (SELECT chunk.end_event_sequence FROM memory_history_chunks chunk
        WHERE chunk.principal_id = vector.principal_id AND chunk.chunk_id = vector.item_id
          AND chunk.content_hash = vector.content_hash)
    END) AS current_event_sequence, max(vector.upserted_at) AS updated_at
      FROM memory_vectors vector WHERE vector.deleted_at IS NULL GROUP BY vector.principal_id`,
    `SELECT principal_id, 'export' AS cursor_name,
      max(end_sequence) AS current_event_sequence, max(sealed_at) AS updated_at
    FROM archive_manifests CROSS JOIN principals
      WHERE principal_type = 'human' GROUP BY principal_id`,
  ] as const;
  let changes = 0;
  for (const source of sources) {
    const result = await database.prepare(`INSERT INTO memory_cursors (
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
    changes += result.meta.changes ?? 0;
    const mismatch = await database.prepare(`SELECT count(*) AS count FROM (${source}) derived
      JOIN memory_cursors cursor_row
        ON cursor_row.principal_id = derived.principal_id
        AND cursor_row.cursor_name = derived.cursor_name
      WHERE derived.current_event_sequence IS NOT NULL
        AND cursor_row.current_event_sequence <> derived.current_event_sequence`)
      .first<{ count: number }>();
    if ((mismatch?.count ?? 0) > 0) throw new Error("memory_backup_restore_cursor_rebuild_mismatch");
  }
  return changes;
}

async function suspendDerivedStateGuards(
  database: D1Database,
  triggers: ReadonlyMap<string, string>,
): Promise<() => Promise<void>> {
  const names = [
    "memory_item_state_insert_guard",
    "memory_item_placement_state_insert_guard",
  ] as const;
  for (const name of names) await database.prepare(`DROP TRIGGER ${name}`).run();
  return async () => {
    for (const name of names) {
      const sql = triggers.get(name);
      if (sql === undefined) throw new Error(`memory_backup_restore_trigger_missing:${name}`);
      await database.prepare(sql).run();
    }
  };
}

async function assertAuthoritativeCounts(database: D1Database, rowsByTable: RestoreRows): Promise<void> {
  for (const table of MEMORY_BACKUP_TABLES) {
    const count = await database.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`)
      .first<{ count: number }>();
    const expected = table === "archive_state" ? 1 : (rowsByTable.get(table)?.length ?? 0);
    if (count?.count !== expected) throw new Error(`memory_backup_restore_target_not_fresh:${table}`);
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
    const text = new TextDecoder().decode(bytes);
    const decoded = text.length === 0 ? [] : text.trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (decoded.length !== object.rowCount) {
      throw new Error(`memory_backup_restore_object_row_count_invalid:${object.objectKey}`);
    }
    const tableRows = rows.get(object.table) ?? [];
    tableRows.push(...decoded);
    rows.set(object.table, tableRows);
    objectTotals.set(object.table, (objectTotals.get(object.table) ?? 0) + decoded.length);
  }
  for (const cut of manifest.tableCuts) {
    const exported = objectTotals.get(cut.table) ?? 0;
    if (cut.exportedRowCount !== exported
      || cut.shortfallRowCount !== cut.expectedRowCount - exported
      || cut.shortfallRowCount < 0) {
      throw new Error(`memory_backup_restore_manifest_count_invalid:${cut.table}`);
    }
  }
  return rows;
}

/**
 * Restores an already verified set into a database that has just received all
 * migrations. Trigger definitions come from those migration files, never from
 * the backup set or the mutable target schema.
 */
export async function restoreVerifiedMemoryBackupRows(options: Readonly<{
  database: D1Database;
  databaseSchemaVersion: string;
  rowsByTable: RestoreRows;
  migrationSql: readonly string[];
  jobs: MemoryBackupRestoreJobs;
  shortfalls?: Readonly<Record<string, number>>;
}>): Promise<MemoryBackupRestoreReport> {
  const schemaVersion = await options.database.prepare(
    "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
  ).first<{ name: string }>();
  if (schemaVersion === null) throw new Error("memory_backup_restore_migrations_missing");
  if (schemaVersion.name !== options.databaseSchemaVersion) {
    throw new Error("memory_backup_restore_schema_mismatch");
  }
  const triggerSql = finalTriggerSql(options.migrationSql);
  const liveTriggers = await options.database.prepare(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
  ).all<SchemaNameRow>();
  if (liveTriggers.results.some(({ name }) => !triggerSql.has(name))) {
    throw new Error("memory_backup_restore_trigger_classification_invalid");
  }
  for (const trigger of liveTriggers.results) {
    await options.database.prepare(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`).run();
  }
  try {
    await insertAuthoritativeRows(options.database, options.rowsByTable);
  } catch (error) {
    await recreateTriggers(options.database, triggerSql);
    throw error;
  }
  await recreateTriggers(options.database, triggerSql);
  const sealedThrough = await rebuildArchiveMark(
    options.database,
    options.rowsByTable.get("archive_state")?.[0],
  );
  const restoreStateGuards = await suspendDerivedStateGuards(options.database, triggerSql);
  let rebuiltItemStates: number;
  let rebuiltPlacementStates: number;
  try {
    rebuiltItemStates = await rebuildItemState(options.database);
    rebuiltPlacementStates = await rebuildPlacementState(options.database);
  } finally {
    await restoreStateGuards();
  }
  await options.jobs.rebuildHistory();
  await options.jobs.rebuildVectors();
  await rebuildFts(options.database);
  const rebuiltCursors = await rebuildCursors(options.database);
  await assertAuthoritativeCounts(options.database, options.rowsByTable);
  const foreignKeys = await options.database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.results.length > 0) throw new Error("memory_backup_restore_foreign_key_check_failed");
  const restoredRows = Object.fromEntries(MEMORY_BACKUP_TABLES.map((table) => [
    table, table === "archive_state" ? 1 : (options.rowsByTable.get(table)?.length ?? 0),
  ]));
  return Object.freeze({
    restoredRows: Object.freeze(restoredRows),
    shortfalls: Object.freeze({ ...(options.shortfalls ?? {}) }),
    rebuiltItemStates,
    rebuiltPlacementStates,
    rebuiltCursors,
    sealedThrough,
  });
}

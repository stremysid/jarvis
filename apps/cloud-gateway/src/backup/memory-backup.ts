import { canonicalJson, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";

export const MEMORY_BACKUP_FAILURE_CODES = Object.freeze({
  bindingMissing: "memory_backup_binding_missing",
  objectReadback: "memory_backup_object_readback_failed",
  manifestReadback: "memory_backup_manifest_readback_failed",
  advertise: "memory_backup_advertise_failed",
  cutMismatch: "memory_backup_cut_mismatch",
  stale: "memory_backup_stale",
  cleanup: "memory_backup_cleanup_failed",
  operation: "memory_backup_operation_failed",
} as const);

export type MemoryBackupFailureCode = typeof MEMORY_BACKUP_FAILURE_CODES[keyof typeof MEMORY_BACKUP_FAILURE_CODES];

export const MEMORY_BACKUP_NOTICE = "Last night's memory backup didn't complete; Jarvis will retry tonight.";
export const MEMORY_BACKUP_LATEST_KEY = "memory-backup/latest.json";

/**
 * Dependency order is also restore order. These are all authoritative D1
 * tables in migrations 0001 through 0033, apart from the explicit derived
 * list below.
 */
export const MEMORY_BACKUP_TABLES = Object.freeze([
  "principals",
  "device_keys",
  "channel_identities",
  "events",
  "idempotency_records",
  "outbox",
  "consumer_cursors",
  "sync_ack_receipts",
  "bootstrap_tokens",
  "policy_decisions",
  "archive_state",
  "archive_manifests",
  "archive_segments",
  "archive_segment_events",
  "archive_purge_receipts",
  "outbound_call_attempts",
  "provider_events",
  "voice_owner_identity",
  "voice_access_grants",
  "voice_access_grant_events",
  "call_sessions",
  "conversation_turns",
  "conversation_deliveries",
  "call_session_authorities",
  "capability_tiers",
  "autonomy_mode",
  "autonomy_evaluations",
  "decision_items",
  "decision_options",
  "decision_responses",
  "tool_confirmation_consumptions",
  "tracked_projects",
  "project_observations",
  "project_documents",
  "deadline_sources",
  "deadlines",
  "deadline_revisions",
  "d2l_email_messages",
  "email_inbox",
  "d2l_email_grade_observations",
  "quiet_windows",
  "liveness_alerts",
  "scheduled_runs",
  "capacity_alert_crossings",
  "outbound_runtime_controls",
  "memory_items",
  "memory_item_versions",
  "memory_item_sources",
  "memory_item_transitions",
  "memory_event_suppressions",
  "memory_event_suppression_lifts",
  "memory_item_links",
  "memory_item_pins",
  "memory_topics",
  "memory_topic_events",
  "memory_topic_aliases",
  "memory_item_placement_events",
  "memory_episodes",
  "memory_episode_sources",
  "memory_model_prices",
  "memory_reprocess_jobs",
  "memory_runs",
  "memory_topic_note_versions",
  "memory_topic_note_sources",
  "memory_topic_note_receipts",
  "memory_consolidation_change_receipts",
  "memory_cost_ledger",
  "owner_passphrase_verifiers",
  "owner_passphrase_rotation_commits",
  "owner_passphrase_disable_commits",
  "owner_passphrase_heads",
  "owner_call_step_up_bindings",
  "owner_call_step_up_windows",
  "owner_call_step_up_attempts",
  "owner_call_step_up_reprompts",
  "owner_call_step_up_successes",
  "owner_call_step_up_rejections",
  "owner_call_step_up_repeat_checks",
  "guest_call_pin_attempts",
  "sensitive_action_pin_attempts",
  "owner_call_step_up_alerts",
  "school_course_cards",
  "school_course_facts",
  "school_catchup_actions",
  "school_catchup_turn_receipts",
  "guided_assignment_answers",
  "owner_call_step_up_disabled_rejections",
  "owner_call_step_up_rejection_deliveries",
  "guest_grant_notices",
  "university_programs",
  "university_program_items",
  "university_tracker_turn_receipts",
  "school_study_preferences",
  "school_practice_items",
  "school_study_evidence",
  "university_application_items",
  "memory_literal_search_jobs",
  "memory_literal_search_hits",
  "memory_distillation_event_receipts",
  "memory_distillation_item_receipts",
  "school_observation_sync",
  "school_assignment_observations",
  "school_assignment_observation_revisions",
  "school_collector_keys",
  "school_collector_reads",
  "school_collector_batches",
  "school_collector_evidence",
  "school_missing_work_transitions",
  "university_workflow_items",
  "university_workflow_revisions",
  "school_study_check_in_claims",
  "school_study_signal_controls",
  "web_tool_receipts",
] as const);

/**
 * Nullable self references need dependency ordering inside their own table.
 * The schema-derived restore test keeps this inventory complete.
 */
export const MEMORY_BACKUP_SELF_REFERENCES = Object.freeze([
  Object.freeze({
    table: "memory_topics",
    keyColumn: "topic_id",
    referenceColumns: Object.freeze(["parent_topic_id", "redirect_to_topic_id"]),
  }),
  Object.freeze({
    table: "memory_episodes",
    keyColumn: "episode_id",
    referenceColumns: Object.freeze(["supersedes_episode_id"]),
  }),
  Object.freeze({
    table: "memory_cost_ledger",
    keyColumn: "cost_entry_id",
    referenceColumns: Object.freeze(["reservation_entry_id"]),
  }),
] as const);

/** Projections rebuilt during restore from authoritative rows and job receipts. */
export const MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES = Object.freeze([
  "memory_fact_projection_fts",
  "memory_item_state",
  "memory_item_placement_state",
  "memory_history_chunks",
  "memory_history_coverage",
  "memory_vectors",
  "memory_cursors",
  "memory_item_fts",
  "memory_episode_fts",
  "memory_history_fts",
  "memory_topic_note_heads",
] as const);

/** Ephemeral state, external caches, and receipts maintained by the backup itself. */
export const MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES = Object.freeze([
  "component_liveness",
  "memory_fact_projection_abandoned",
  "memory_fact_projection_heads",
  "memory_fact_projection_versions",
  "memory_fact_projection_pages",
  "memory_fact_projection_facts",
  "memory_fact_projection_commits",
  "guest_grant_notice_drain_state",
  "identity_challenges",
  "sync_snapshots",
  "request_nonces",
  "school_collector_nonces",
  "authentication_attempt_reservations",
  "memory_backup_runs",
  "memory_backup_row_ordinals",
  "memory_backup_table_cuts",
  "memory_backup_objects",
  "memory_backup_alerts",
  "memory_consolidation_model_steps",
  "d2l_email_failure_state",
] as const);

/** Restore-only tables appear after migration and remain outside later backup sets. */
export const MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES = Object.freeze([
  "memory_backup_restore_cache_progress",
  "memory_backup_restore_cache_objects",
  "memory_backup_restore_progress",
] as const);

export type MemoryBackupTableName = typeof MEMORY_BACKUP_TABLES[number];

export interface MemoryBackupMarks {
  readonly eventsAfter: number;
}

type RunStatus = "running" | "verified" | "failed" | "abandoned" | "pruned";
type CutKeyKind = "sequence" | "rowid" | "ordinal";

interface StoredRun {
  run_date: string;
  run_id: string;
  status: RunStatus;
  schema_version: string;
  marks_json: string;
  current_table_index: number;
  cursor_key: number | null;
  next_object_number: number;
  verified_object_count: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  manifest_object_key: string | null;
  manifest_sha256: string | null;
  failure_code: MemoryBackupFailureCode | null;
  started_at: string;
  updated_at: string;
  verified_at: string | null;
  abandoned_at: string | null;
  pruned_at: string | null;
}

export interface MemoryBackupRun {
  readonly runDate: string;
  readonly runId: string;
  readonly status: RunStatus;
  readonly schemaVersion: string;
  readonly marks: MemoryBackupMarks;
  readonly currentTableIndex: number;
  readonly cursorKey: number | null;
  readonly nextObjectNumber: number;
  readonly verifiedObjectCount: number;
  readonly leaseId: string | null;
  readonly manifestObjectKey: string | null;
  readonly manifestSha256: string | null;
  readonly failureCode: MemoryBackupFailureCode | null;
  readonly startedAt: string;
  readonly verifiedAt: string | null;
}

interface StoredCut {
  run_id: string;
  table_index: number;
  table_name: MemoryBackupTableName;
  key_kind: CutKeyKind;
  after_key: number;
  through_key: number | null;
  expected_row_count: number;
}

export interface MemoryBackupTableCut {
  readonly runId: string;
  readonly tableIndex: number;
  readonly table: MemoryBackupTableName;
  readonly keyKind: CutKeyKind;
  readonly afterKey: number;
  readonly throughKey: number | null;
  readonly expectedRowCount: number;
}

interface StoredObject {
  run_id: string;
  object_number: number;
  table_name: MemoryBackupTableName;
  object_key: string;
  schema_version: string;
  row_count: number;
  byte_count: number;
  first_key: number;
  last_key: number;
  sha256: string;
  verified_at: string;
}

export interface MemoryBackupObject {
  readonly runId: string;
  readonly objectNumber: number;
  readonly table: MemoryBackupTableName;
  readonly objectKey: string;
  readonly schemaVersion: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly firstKey: number;
  readonly lastKey: number;
  readonly sha256: string;
  readonly verifiedAt: string;
}

interface TableDescriptor {
  readonly table: MemoryBackupTableName;
  readonly keyKind: CutKeyKind;
  readonly primaryKeyColumns: readonly string[];
}

interface SchemaTableRow {
  name: string;
  sql: string | null;
}

interface TableInfoRow {
  name: string;
  pk: number;
}

interface LatestPointer {
  readonly schemaVersion: "1.0";
  readonly runDate: string;
  readonly runId: string;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
}

export interface MemoryBackupBucket extends Pick<R2Bucket, "get" | "put" | "list" | "delete"> {}

export interface MemoryBackupNotice {
  send(text: string): Promise<void>;
}

export interface MemoryBackupOptions {
  readonly database: D1Database;
  readonly bucket: MemoryBackupBucket | undefined;
  readonly clock: { now(): Date };
  readonly notice: MemoryBackupNotice;
  readonly pageRowLimit?: number;
  readonly pageByteLimit?: number;
  readonly stepsPerInvocation?: number;
}

export type MemoryBackupOutcome =
  | { readonly outcome: "idle" | "pending" | "verified"; readonly detail: string }
  | { readonly outcome: "failed"; readonly code: MemoryBackupFailureCode };

class MemoryBackupError extends Error {
  constructor(readonly code: MemoryBackupFailureCode) {
    super(code);
  }
}

function requireDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new TypeError("memory_backup_date_invalid");
  }
}

function requireLimits(rowLimit: number, byteLimit: number, stepsPerInvocation: number): void {
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > 32) {
    throw new RangeError("memory_backup_row_limit_invalid");
  }
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1024 || byteLimit > 1024 * 1024) {
    throw new RangeError("memory_backup_byte_limit_invalid");
  }
  if (!Number.isSafeInteger(stepsPerInvocation) || stepsPerInvocation < 2 || stepsPerInvocation > 16) {
    throw new RangeError("memory_backup_step_limit_invalid");
  }
}

function parseMarks(value: string): MemoryBackupMarks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("memory_backup_marks_invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("memory_backup_marks_invalid");
  }
  const marks = parsed as Record<string, unknown>;
  if (Object.keys(marks).join("|") !== "eventsAfter"
    || !Number.isSafeInteger(marks.eventsAfter) || (marks.eventsAfter as number) < 0) {
    throw new Error("memory_backup_marks_invalid");
  }
  return Object.freeze({ eventsAfter: marks.eventsAfter as number });
}

function mapRun(row: StoredRun): MemoryBackupRun {
  return Object.freeze({
    runDate: row.run_date,
    runId: row.run_id,
    status: row.status,
    schemaVersion: row.schema_version,
    marks: parseMarks(row.marks_json),
    currentTableIndex: row.current_table_index,
    cursorKey: row.cursor_key,
    nextObjectNumber: row.next_object_number,
    verifiedObjectCount: row.verified_object_count,
    leaseId: row.lease_id,
    manifestObjectKey: row.manifest_object_key,
    manifestSha256: row.manifest_sha256,
    failureCode: row.failure_code,
    startedAt: row.started_at,
    verifiedAt: row.verified_at,
  });
}

function mapCut(row: StoredCut): MemoryBackupTableCut {
  return Object.freeze({
    runId: row.run_id,
    tableIndex: row.table_index,
    table: row.table_name,
    keyKind: row.key_kind,
    afterKey: row.after_key,
    throughKey: row.through_key,
    expectedRowCount: row.expected_row_count,
  });
}

function mapObject(row: StoredObject): MemoryBackupObject {
  return Object.freeze({
    runId: row.run_id,
    objectNumber: row.object_number,
    table: row.table_name,
    objectKey: row.object_key,
    schemaVersion: row.schema_version,
    rowCount: row.row_count,
    byteCount: row.byte_count,
    firstKey: row.first_key,
    lastKey: row.last_key,
    sha256: row.sha256,
    verifiedAt: row.verified_at,
  });
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) throw new Error("memory_backup_identifier_invalid");
  return `"${value}"`;
}

function rowKeyExpression(descriptor: TableDescriptor, alias: string): string {
  if (descriptor.primaryKeyColumns.length === 0) throw new Error("memory_backup_primary_key_missing");
  return `json_array(${descriptor.primaryKeyColumns
    .map((column) => `${alias}.${quoteIdentifier(column)}`).join(", ")})`;
}

function scheduledRunsSince(startedAt: string): string {
  return new Date(Date.parse(startedAt) - 48 * 60 * 60_000).toISOString();
}

/**
 * D1 reserves the `_cf_` prefix for its own bookkeeping (`_cf_METADATA`,
 * `_cf_KV`) and its authorizer refuses a CREATE there (SQLITE_AUTH), so such a
 * table can only exist because Cloudflare put it there. Exempting these by name
 * instead is what aborted the nightly backup when `_cf_KV` first appeared.
 */
function isCloudflareInternalTable(name: string): boolean {
  return name.startsWith("_cf_");
}

function isInternalFtsTable(name: string): boolean {
  return MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES.some(
    (table) => table.endsWith("_fts") && name.startsWith(`${table}_`),
  );
}

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:D1_ERROR|R2|transient|temporar|timeout|timed out|429|5\d\d|internal error|network)/iu.test(message);
}

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 2) throw error;
    }
  }
  throw lastError;
}

const RUN_COLUMNS = `run_date, run_id, status, schema_version, marks_json,
  current_table_index, cursor_key, next_object_number, verified_object_count,
  lease_id, lease_expires_at, manifest_object_key, manifest_sha256, failure_code,
  started_at, updated_at, verified_at, abandoned_at, pruned_at`;

const CUT_COLUMNS = `run_id, table_index, table_name, key_kind, after_key,
  through_key, expected_row_count`;

const OBJECT_COLUMNS = `run_id, object_number, table_name, object_key, schema_version,
  row_count, byte_count, first_key, last_key, sha256, verified_at`;
const MAX_ORDINAL_KEY_COLUMNS = 4;

/**
 * Matches a cut to the descriptor for the same table, by name.
 *
 * Exported because the failure it prevents needs a descriptor list that already
 * grew a table, which no test can build from the current constant. Position is
 * not identity here: a migration that inserts a table in the middle of
 * `MEMORY_BACKUP_TABLES` shifts every later index, and a positional lookup then
 * hands this cut another table's descriptor and exports one table's rows under
 * another table's name.
 */
export function descriptorForCut<T extends Readonly<{ table: string; keyKind: CutKeyKind }>>(
  cut: Readonly<{ table: string }>,
  descriptors: readonly T[],
): T | null {
  return descriptors.find((candidate) => candidate.table === cut.table) ?? null;
}

class MemoryBackupRepository {
  private descriptorsPromise: Promise<readonly TableDescriptor[]> | undefined;

  constructor(private readonly database: D1Database) {}

  async readByDate(runDate: string): Promise<MemoryBackupRun | null> {
    const row = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM memory_backup_runs WHERE run_date = ?`,
    ).bind(runDate).first<StoredRun>();
    return row === null ? null : mapRun(row);
  }

  async readById(runId: string): Promise<MemoryBackupRun | null> {
    const row = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM memory_backup_runs WHERE run_id = ?`,
    ).bind(runId).first<StoredRun>();
    return row === null ? null : mapRun(row);
  }

  async readRunning(): Promise<MemoryBackupRun | null> {
    const row = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM memory_backup_runs
       WHERE status = 'running' ORDER BY run_date, started_at LIMIT 1`,
    ).first<StoredRun>();
    return row === null ? null : mapRun(row);
  }

  async nightlyRunWasScheduled(runDate: string): Promise<boolean> {
    const row = await this.database.prepare(
      "SELECT run_key FROM scheduled_runs WHERE job = 'backup' AND run_key = ?",
    ).bind(runDate).first<{ run_key: string }>();
    return row !== null;
  }

  async descriptors(): Promise<readonly TableDescriptor[]> {
    this.descriptorsPromise ??= this.loadDescriptors();
    return this.descriptorsPromise;
  }

  private async loadDescriptors(): Promise<readonly TableDescriptor[]> {
    const schema = await this.database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table'",
    ).all<SchemaTableRow>();
    const byName = new Map(schema.results.map((row) => [row.name, row]));
    const classified = new Set<string>([
      ...MEMORY_BACKUP_TABLES,
      ...MEMORY_BACKUP_EXCLUDED_DERIVED_TABLES,
      ...MEMORY_BACKUP_EXCLUDED_OPERATIONAL_TABLES,
      ...MEMORY_BACKUP_EXCLUDED_RESTORE_TABLES,
    ]);
    const unclassified = schema.results.map((row) => row.name).filter((name) =>
      !name.startsWith("sqlite_") && name !== "d1_migrations"
      && !isCloudflareInternalTable(name) && !isInternalFtsTable(name) && !classified.has(name));
    if (unclassified.length > 0) {
      throw new Error(`memory_backup_table_unclassified:${unclassified.sort().join(",")}`);
    }
    const withoutRowid = MEMORY_BACKUP_TABLES.filter((table) => {
      const row = byName.get(table);
      if (row === undefined || row.sql === null) throw new Error(`memory_backup_table_missing:${table}`);
      return /\bWITHOUT\s+ROWID\b/iu.test(row.sql);
    });
    const primaryKeys = new Map<string, readonly string[]>();
    const results = withoutRowid.length === 0 ? [] : await this.database.batch(
      withoutRowid.map((table) => this.database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)),
    );
    for (let index = 0; index < withoutRowid.length; index += 1) {
      const columns = (results[index]?.results as unknown as TableInfoRow[] | undefined) ?? [];
      const keys = columns.filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk).map((column) => column.name);
      if (keys.length === 0) throw new Error(`memory_backup_primary_key_missing:${withoutRowid[index]}`);
      if (keys.length > MAX_ORDINAL_KEY_COLUMNS) {
        throw new Error(`memory_backup_primary_key_too_wide:${withoutRowid[index]}`);
      }
      primaryKeys.set(withoutRowid[index]!, Object.freeze(keys));
    }
    return Object.freeze(MEMORY_BACKUP_TABLES.map((table) => Object.freeze({
      table,
      keyKind: table === "events" ? "sequence" : primaryKeys.has(table) ? "ordinal" : "rowid",
      primaryKeyColumns: primaryKeys.get(table) ?? Object.freeze([]),
    })));
  }

  async captureRun(runDate: string, now: Date): Promise<MemoryBackupRun> {
    const descriptors = await this.descriptors();
    const timestamp = now.toISOString();
    const scheduledSince = scheduledRunsSince(timestamp);
    const runId = newUlid(now);
    const statements: D1PreparedStatement[] = [];
    for (const descriptor of descriptors) {
      if (descriptor.keyKind !== "ordinal") continue;
      const table = quoteIdentifier(descriptor.table);
      const rowKey = rowKeyExpression(descriptor, "source");
      const storedKeys = Array.from({ length: MAX_ORDINAL_KEY_COLUMNS }, (_, index) =>
        descriptor.primaryKeyColumns[index] === undefined
          ? "NULL"
          : `source.${quoteIdentifier(descriptor.primaryKeyColumns[index]!)}`);
      const filter = descriptor.table === "scheduled_runs" ? "source.started_at >= ? AND " : "";
      const bindings = descriptor.table === "scheduled_runs"
        ? [descriptor.table, scheduledSince, descriptor.table]
        : [descriptor.table, descriptor.table];
      statements.push(this.database.prepare(
        `INSERT INTO memory_backup_row_ordinals (
           table_name, row_key, key_1, key_2, key_3, key_4
         )
         SELECT ?, ${rowKey}, ${storedKeys.join(", ")} FROM ${table} source
         WHERE ${filter}NOT EXISTS (
           SELECT 1 FROM memory_backup_row_ordinals ordinal
           WHERE ordinal.table_name = ? AND ordinal.row_key = ${rowKey}
         ) ORDER BY ${descriptor.primaryKeyColumns.map((column) => `source.${quoteIdentifier(column)}`).join(", ")}`,
      ).bind(...bindings));
    }
    statements.push(this.database.prepare(
      `INSERT INTO memory_backup_runs (
         run_date, run_id, status, schema_version, marks_json, current_table_index,
         cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
         manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
         verified_at, abandoned_at, pruned_at
       ) SELECT ?, ?, 'running', name,
         json_object('eventsAfter', (SELECT sealed_through FROM archive_state WHERE singleton = 1)),
         0, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL
       FROM d1_migrations ORDER BY name DESC LIMIT 1`,
    ).bind(runDate, runId, timestamp, timestamp));
    descriptors.forEach((descriptor, tableIndex) => {
      const table = quoteIdentifier(descriptor.table);
      if (descriptor.keyKind === "sequence") {
        statements.push(this.database.prepare(
          `INSERT INTO memory_backup_table_cuts (
             run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
           ) SELECT ?, ?, ?, 'sequence', archive.sealed_through,
             max(source.sequence), count(source.sequence)
           FROM archive_state archive
           LEFT JOIN ${table} source ON source.sequence > archive.sealed_through
           WHERE archive.singleton = 1`,
        ).bind(runId, tableIndex, descriptor.table));
        return;
      }
      if (descriptor.keyKind === "rowid") {
        const filter = descriptor.table === "scheduled_runs" ? " WHERE source.started_at >= ?" : "";
        statements.push(this.database.prepare(
          `INSERT INTO memory_backup_table_cuts (
             run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
           ) SELECT ?, ?, ?, 'rowid', 0, max(source.rowid), count(source.rowid)
           FROM ${table} source${filter}`,
        ).bind(...(descriptor.table === "scheduled_runs"
          ? [runId, tableIndex, descriptor.table, scheduledSince]
          : [runId, tableIndex, descriptor.table])));
        return;
      }
      const rowKey = rowKeyExpression(descriptor, "source");
      const filter = descriptor.table === "scheduled_runs" ? " WHERE source.started_at >= ?" : "";
      statements.push(this.database.prepare(
        `INSERT INTO memory_backup_table_cuts (
           run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
         ) SELECT ?, ?, ?, 'ordinal', 0, max(ordinal.ordinal), count(ordinal.ordinal)
         FROM ${table} source
         JOIN memory_backup_row_ordinals ordinal
           ON ordinal.table_name = ? AND ordinal.row_key = ${rowKey}${filter}`,
      ).bind(...(descriptor.table === "scheduled_runs"
        ? [runId, tableIndex, descriptor.table, descriptor.table, scheduledSince]
        : [runId, tableIndex, descriptor.table, descriptor.table])));
    });
    try {
      await this.database.batch(statements);
    } catch (error) {
      // A duplicate cron can lose the initial insert guard after doing all of
      // the same transactional cut work. That is an idempotent claim only.
      if (await this.readByDate(runDate) === null) throw error;
    }
    const run = await this.readByDate(runDate);
    if (run === null) throw new Error("memory_backup_run_claim_failed");
    return run;
  }

  async claimStep(runId: string, now: Date): Promise<MemoryBackupRun | null> {
    const timestamp = now.toISOString();
    const leaseId = newUlid(now);
    const expiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
    const result = await this.database.prepare(
      `UPDATE memory_backup_runs
       SET lease_id = ?, lease_expires_at = ?, updated_at = ?
       WHERE run_id = ? AND status = 'running'
         AND (lease_id IS NULL OR lease_expires_at <= ?)`,
    ).bind(leaseId, expiresAt, timestamp, runId, timestamp).run();
    if ((result.meta.changes ?? 0) === 0) return null;
    const row = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM memory_backup_runs WHERE run_id = ? AND lease_id = ?`,
    ).bind(runId, leaseId).first<StoredRun>();
    if (row === null) throw new Error("memory_backup_lease_lost");
    return mapRun(row);
  }

  async readCut(runId: string, tableIndex: number): Promise<MemoryBackupTableCut | null> {
    const row = await this.database.prepare(
      `SELECT ${CUT_COLUMNS} FROM memory_backup_table_cuts WHERE run_id = ? AND table_index = ?`,
    ).bind(runId, tableIndex).first<StoredCut>();
    return row === null ? null : mapCut(row);
  }

  async listCuts(runId: string): Promise<readonly MemoryBackupTableCut[]> {
    const rows = await this.database.prepare(
      `SELECT ${CUT_COLUMNS} FROM memory_backup_table_cuts WHERE run_id = ? ORDER BY table_index`,
    ).bind(runId).all<StoredCut>();
    return rows.results.map(mapCut);
  }

  async recordObject(run: MemoryBackupRun, object: Omit<MemoryBackupObject, "runId">, now: Date): Promise<void> {
    if (run.leaseId === null) throw new Error("memory_backup_lease_missing");
    const timestamp = now.toISOString();
    const results = await this.database.batch([
      this.database.prepare(
        `INSERT INTO memory_backup_objects (${OBJECT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        run.runId, object.objectNumber, object.table, object.objectKey, object.schemaVersion,
        object.rowCount, object.byteCount, object.firstKey, object.lastKey, object.sha256,
        object.verifiedAt,
      ),
      this.database.prepare(
        `UPDATE memory_backup_runs
         SET cursor_key = ?, next_object_number = next_object_number + 1,
           lease_id = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE run_id = ? AND status = 'running' AND lease_id = ?`,
      ).bind(object.lastKey, timestamp, run.runId, run.leaseId),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) throw new Error("memory_backup_progress_lost");
  }

  async finishTable(run: MemoryBackupRun, cut: MemoryBackupTableCut, now: Date): Promise<void> {
    if (run.leaseId === null) throw new Error("memory_backup_lease_missing");
    const count = await this.database.prepare(
      `SELECT coalesce(sum(row_count), 0) AS count FROM memory_backup_objects
       WHERE run_id = ? AND table_name = ?`,
    ).bind(run.runId, cut.table).first<{ count: number }>();
    if (count === null || count.count > cut.expectedRowCount) {
      throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.cutMismatch);
    }
    const result = await this.database.prepare(
      `UPDATE memory_backup_runs
       SET current_table_index = current_table_index + 1, cursor_key = NULL,
         lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND status = 'running' AND lease_id = ?`,
    ).bind(now.toISOString(), run.runId, run.leaseId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("memory_backup_progress_lost");
  }

  async recordObjectReverified(run: MemoryBackupRun, now: Date): Promise<void> {
    if (run.leaseId === null) throw new Error("memory_backup_lease_missing");
    const result = await this.database.prepare(
      `UPDATE memory_backup_runs
       SET verified_object_count = verified_object_count + 1,
         lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND status = 'running' AND lease_id = ?`,
    ).bind(now.toISOString(), run.runId, run.leaseId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("memory_backup_progress_lost");
  }

  async readObject(runId: string, objectNumber: number): Promise<MemoryBackupObject | null> {
    const row = await this.database.prepare(
      `SELECT ${OBJECT_COLUMNS} FROM memory_backup_objects
       WHERE run_id = ? AND object_number = ?`,
    ).bind(runId, objectNumber).first<StoredObject>();
    return row === null ? null : mapObject(row);
  }

  async listObjects(runId: string): Promise<readonly MemoryBackupObject[]> {
    const { results } = await this.database.prepare(
      `SELECT ${OBJECT_COLUMNS} FROM memory_backup_objects
       WHERE run_id = ? ORDER BY object_number`,
    ).bind(runId).all<StoredObject>();
    return results.map(mapObject);
  }

  async fail(run: MemoryBackupRun, code: MemoryBackupFailureCode, now: Date): Promise<void> {
    if (run.leaseId === null) return;
    await this.database.prepare(
      `UPDATE memory_backup_runs
       SET status = 'failed', failure_code = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND status = 'running' AND lease_id = ?`,
    ).bind(code, now.toISOString(), run.runId, run.leaseId).run();
  }

  async verifyRun(
    run: MemoryBackupRun,
    manifestObjectKey: string,
    manifestSha256: string,
    now: Date,
  ): Promise<MemoryBackupRun> {
    if (run.leaseId === null) throw new Error("memory_backup_lease_missing");
    const timestamp = now.toISOString();
    const result = await this.database.prepare(
      `UPDATE memory_backup_runs
       SET status = 'verified', manifest_object_key = ?, manifest_sha256 = ?,
         verified_at = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND status = 'running' AND lease_id = ?`,
    ).bind(manifestObjectKey, manifestSha256, timestamp, timestamp, run.runId, run.leaseId).run();
    const stored = await this.readById(run.runId);
    if ((result.meta.changes ?? 0) !== 1
      && (stored?.status !== "verified" || stored.manifestObjectKey !== manifestObjectKey
        || stored.manifestSha256 !== manifestSha256)) {
      throw new Error("memory_backup_progress_lost");
    }
    if (stored === null || stored.status !== "verified") throw new Error("memory_backup_progress_lost");
    return stored;
  }

  async claimAlert(
    localDate: string,
    runId: string | null,
    code: MemoryBackupFailureCode,
    now: Date,
  ): Promise<boolean> {
    try {
      const result = await this.database.prepare(
        `INSERT INTO memory_backup_alerts (local_date, run_id, failure_code, claimed_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(localDate, runId, code, now.toISOString()).run();
      return (result.meta.changes ?? 0) === 1;
    } catch (error) {
      const existing = await this.database.prepare(
        "SELECT local_date FROM memory_backup_alerts WHERE local_date = ?",
      ).bind(localDate).first<{ local_date: string }>();
      if (existing !== null) return false;
      throw error;
    }
  }

  async backupIsStale(now: Date): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT coalesce(max(verified_at), min(started_at)) AS reference_at FROM memory_backup_runs`,
    ).first<{ reference_at: string | null }>();
    if (row?.reference_at === null || row?.reference_at === undefined) return false;
    const reference = Date.parse(row.reference_at);
    return Number.isFinite(reference) && now.getTime() - reference > 36 * 60 * 60_000;
  }

  async readFailedBefore(runDate: string): Promise<MemoryBackupRun | null> {
    const row = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM memory_backup_runs
       WHERE status = 'failed' AND run_date < ? ORDER BY run_date LIMIT 1`,
    ).bind(runDate).first<StoredRun>();
    return row === null ? null : mapRun(row);
  }

  async abandon(run: MemoryBackupRun, now: Date): Promise<void> {
    await this.database.prepare(
      `UPDATE memory_backup_runs
       SET status = 'abandoned', abandoned_at = ?, updated_at = ?
       WHERE run_id = ? AND status = 'failed'`,
    ).bind(now.toISOString(), now.toISOString(), run.runId).run();
  }

  async listVerified(): Promise<readonly MemoryBackupRun[]> {
    const { results } = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM memory_backup_runs
       WHERE status = 'verified' ORDER BY run_date DESC, verified_at DESC`,
    ).all<StoredRun>();
    return results.map(mapRun);
  }

  async prune(run: MemoryBackupRun, now: Date): Promise<void> {
    await this.database.prepare(
      `UPDATE memory_backup_runs SET status = 'pruned', pruned_at = ?, updated_at = ?
       WHERE run_id = ? AND status = 'verified'`,
    ).bind(now.toISOString(), now.toISOString(), run.runId).run();
  }

  async page(
    run: MemoryBackupRun,
    cut: MemoryBackupTableCut,
    descriptor: TableDescriptor,
    limit: number,
  ): Promise<readonly Record<string, unknown>[]> {
    if (cut.throughKey === null) return [];
    const cursor = run.cursorKey ?? cut.afterKey;
    const table = quoteIdentifier(cut.table);
    if (cut.keyKind === "sequence") {
      const { results } = await this.database.prepare(
        `SELECT source.*, source.sequence AS __memory_backup_key FROM ${table} source
         WHERE source.sequence > ? AND source.sequence <= ? ORDER BY source.sequence LIMIT ?`,
      ).bind(cursor, cut.throughKey, limit).all<Record<string, unknown>>();
      return results;
    }
    if (cut.keyKind === "rowid") {
      const scheduledFilter = descriptor.table === "scheduled_runs" ? " AND source.started_at >= ?" : "";
      const { results } = await this.database.prepare(
        `SELECT source.*, source.rowid AS __memory_backup_key FROM ${table} source
         WHERE source.rowid > ? AND source.rowid <= ?${scheduledFilter}
         ORDER BY source.rowid LIMIT ?`,
      ).bind(...(descriptor.table === "scheduled_runs"
        ? [cursor, cut.throughKey, scheduledRunsSince(run.startedAt), limit]
        : [cursor, cut.throughKey, limit])).all<Record<string, unknown>>();
      return results;
    }
    const primaryKeyMatch = descriptor.primaryKeyColumns.map((column, index) =>
      `source.${quoteIdentifier(column)} IS ordinal_page.key_${index + 1}`).join(" AND ");
    const scheduledFilter = descriptor.table === "scheduled_runs" ? " AND source.started_at >= ?" : "";
    const { results } = await this.database.prepare(
      `WITH ordinal_page AS (
         SELECT ordinal, key_1, key_2, key_3, key_4 FROM memory_backup_row_ordinals
         WHERE table_name = ? AND ordinal > ? AND ordinal <= ?
         ORDER BY ordinal LIMIT ?
       )
       SELECT source.*, ordinal_page.ordinal AS __memory_backup_key
       FROM ordinal_page JOIN ${table} source ON ${primaryKeyMatch}${scheduledFilter}
       ORDER BY ordinal_page.ordinal`,
    ).bind(...(descriptor.table === "scheduled_runs"
      ? [cut.table, cursor, cut.throughKey, limit, scheduledRunsSince(run.startedAt)]
      : [cut.table, cursor, cut.throughKey, limit])).all<Record<string, unknown>>();
    return results;
  }
}

function rowKey(row: Record<string, unknown>): number {
  const value = row.__memory_backup_key;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("memory_backup_row_key_invalid");
  }
  return value;
}

function exportRow(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  delete copy.__memory_backup_key;
  return copy;
}

function encodeRows(
  rows: readonly Record<string, unknown>[],
  byteLimit: number,
): { readonly rows: readonly Record<string, unknown>[]; readonly bytes: Uint8Array } {
  const encoder = new TextEncoder();
  const accepted: Record<string, unknown>[] = [];
  let text = "";
  for (const row of rows) {
    rowKey(row);
    const line = `${canonicalJson(exportRow(row))}\n`;
    const candidate = encoder.encode(text + line);
    if (candidate.byteLength > byteLimit) {
      if (accepted.length === 0) throw new Error("memory_backup_row_too_large");
      break;
    }
    accepted.push(row);
    text += line;
  }
  return Object.freeze({ rows: Object.freeze(accepted), bytes: encoder.encode(text) });
}

async function readAndVerify(
  bucket: MemoryBackupBucket,
  objectKey: string,
  expectedBytes: number,
  expectedSha256: string,
  failureCode: MemoryBackupFailureCode,
): Promise<void> {
  let object: R2ObjectBody | null;
  try {
    object = await retryTransient(() => bucket.get(objectKey));
  } catch {
    throw new MemoryBackupError(failureCode);
  }
  if (object === null || !Number.isSafeInteger(object.size) || object.size !== expectedBytes) {
    throw new MemoryBackupError(failureCode);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await retryTransient(() => object.arrayBuffer());
  } catch {
    throw new MemoryBackupError(failureCode);
  }
  if (bytes.byteLength !== expectedBytes || await sha256Hex(new Uint8Array(bytes)) !== expectedSha256) {
    throw new MemoryBackupError(failureCode);
  }
}

function prefixFor(run: Pick<MemoryBackupRun, "runDate" | "runId">): string {
  return `memory-backup/sets/${run.runDate}/${run.runId}/`;
}

function monthStart(date: string): string {
  return date.slice(0, 7);
}

function previousMonth(month: string): string {
  const [yearText, monthText] = month.split("-");
  const year = Number.parseInt(yearText!, 10);
  const number = Number.parseInt(monthText!, 10);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, "0")}`;
}

/** The union of the latest 14 sets and the first verified set in each recent month is retained. */
export function selectMemoryBackupRetentionDeletes(
  verified: readonly Pick<MemoryBackupRun, "runId" | "runDate">[],
  currentDate: string,
): readonly string[] {
  if (verified.length <= 1) return [];
  const ordered = [...verified].sort((left, right) => right.runDate.localeCompare(left.runDate));
  const keep = new Set(ordered.slice(0, 14).map((run) => run.runId));
  const recentMonths = new Set<string>();
  let month = monthStart(currentDate);
  for (let index = 0; index < 12; index += 1) {
    recentMonths.add(month);
    month = previousMonth(month);
  }
  const firstByMonth = new Map<string, Pick<MemoryBackupRun, "runId" | "runDate">>();
  for (const run of ordered) {
    const runMonth = monthStart(run.runDate);
    if (!recentMonths.has(runMonth)) continue;
    const current = firstByMonth.get(runMonth);
    if (current === undefined || run.runDate < current.runDate) firstByMonth.set(runMonth, run);
  }
  for (const run of firstByMonth.values()) keep.add(run.runId);
  return ordered.filter((run) => !keep.has(run.runId)).map((run) => run.runId);
}

export class MemoryBackupService {
  private readonly repository: MemoryBackupRepository;
  private readonly rowLimit: number;
  private readonly byteLimit: number;
  private readonly stepsPerInvocation: number;

  constructor(private readonly options: MemoryBackupOptions) {
    this.repository = new MemoryBackupRepository(options.database);
    this.rowLimit = options.pageRowLimit ?? 16;
    this.byteLimit = options.pageByteLimit ?? 1024 * 1024;
    this.stepsPerInvocation = options.stepsPerInvocation ?? 16;
    requireLimits(this.rowLimit, this.byteLimit, this.stepsPerInvocation);
  }

  async runNightly(runDate: string): Promise<MemoryBackupOutcome> {
    requireDate(runDate);
    try {
      const failed = await retryTransient(() => this.repository.readFailedBefore(runDate));
      if (failed !== null) {
        const cleaned = await this.cleanupFailed(failed);
        if (!cleaned) return this.withStaleAlert(runDate, {
          outcome: "pending",
          detail: "memory backup cleanup pending",
        });
      }
      const running = await retryTransient(() => this.repository.readRunning());
      if (running !== null) return this.withStaleAlert(runDate, await this.advance(running));
      const existing = await retryTransient(() => this.repository.readByDate(runDate));
      if (existing !== null) {
        if (existing.status === "verified") {
          const advertised = await this.ensureAdvertised(existing);
          await this.applyRetention(existing.runDate);
          return advertised
            ? { outcome: "verified", detail: "memory backup already verified" }
            : { outcome: "pending", detail: "memory backup pointer repair pending" };
        }
        if (existing.status === "failed") {
          await this.alert(runDate, existing.runId, existing.failureCode ?? MEMORY_BACKUP_FAILURE_CODES.operation);
          return { outcome: "failed", code: existing.failureCode ?? MEMORY_BACKUP_FAILURE_CODES.operation };
        }
        return this.withStaleAlert(runDate, { outcome: "idle", detail: `memory backup ${existing.status}` });
      }
      const created = await retryTransient(() => this.repository.captureRun(runDate, this.options.clock.now()));
      return this.withStaleAlert(runDate, await this.advance(created));
    } catch (error) {
      // A `MemoryBackupError` already carries the code that says what went
      // wrong. This catch used to discard it and report every one of them as
      // `operation`, so a failure with its own name -- a binding that was never
      // bound, a readback that did not match, a cut that moved -- arrived as a
      // generic fault. The catch below has always preserved the code, which is
      // what makes this an inconsistency rather than a decision.
      const code = error instanceof MemoryBackupError
        ? error.code
        : MEMORY_BACKUP_FAILURE_CODES.operation;
      // An unexpected error still has to report `operation`, because the stored
      // code is a closed set with a CHECK constraint behind it. But the reason
      // is not thrown away with it: losing the cause is what turned a missing
      // migration into an unattributable failure and cost a session of hunting.
      if (code === MEMORY_BACKUP_FAILURE_CODES.operation) {
        console.error(MEMORY_BACKUP_FAILURE_CODES.operation, error);
      }
      await this.alert(runDate, null, code);
      return { outcome: "failed", code };
    }
  }

  async continueActive(localDate: string): Promise<MemoryBackupOutcome> {
    requireDate(localDate);
    try {
      const running = await retryTransient(() => this.repository.readRunning());
      if (running !== null) return this.withStaleAlert(localDate, await this.advance(running));
      if (!await retryTransient(() => this.repository.nightlyRunWasScheduled(localDate))) {
        return this.withStaleAlert(localDate, { outcome: "idle", detail: "no memory backup continuation" });
      }
      const existing = await retryTransient(() => this.repository.readByDate(localDate));
      if (existing !== null) {
        if (existing.status === "verified") {
          const advertised = await this.ensureAdvertised(existing);
          await this.applyRetention(existing.runDate);
          return advertised
            ? { outcome: "verified", detail: "memory backup already verified" }
            : { outcome: "pending", detail: "memory backup pointer repair pending" };
        }
        return this.withStaleAlert(localDate, { outcome: "idle", detail: `memory backup ${existing.status}` });
      }
      return this.withStaleAlert(localDate, await this.advance(
        await retryTransient(() => this.repository.captureRun(localDate, this.options.clock.now())),
      ));
    } catch {
      await this.alert(localDate, null, MEMORY_BACKUP_FAILURE_CODES.operation);
      return { outcome: "failed", code: MEMORY_BACKUP_FAILURE_CODES.operation };
    }
  }

  private async withStaleAlert(
    localDate: string,
    outcome: MemoryBackupOutcome,
  ): Promise<MemoryBackupOutcome> {
    try {
      if (outcome.outcome !== "verified"
        && await retryTransient(() => this.repository.backupIsStale(this.options.clock.now()))) {
        await this.alert(localDate, null, MEMORY_BACKUP_FAILURE_CODES.stale);
      }
    } catch {
      // The backup result remains the primary signal when the stale probe is unavailable.
    }
    return outcome;
  }

  private async advance(initial: MemoryBackupRun): Promise<MemoryBackupOutcome> {
    let run = initial;
    for (let step = 0; step < this.stepsPerInvocation; step += 1) {
      const claimed = await retryTransient(() => this.repository.claimStep(run.runId, this.options.clock.now()));
      if (claimed === null) return { outcome: "pending", detail: "memory backup step already running" };
      try {
        if (this.options.bucket === undefined) {
          throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
        }
        // The cut set the run started with, never the current table constant: a
        // migration that adds tables must not make a running set ask for a cut
        // its own capture never wrote (memory_backup_cut_missing).
        const cuts = await retryTransient(() => this.repository.listCuts(claimed.runId));
        const cut = cuts.find((candidate) => candidate.tableIndex === claimed.currentTableIndex);
        if (cut !== undefined) {
          await retryTransient(() => this.exportPage(claimed, cut));
        } else if (claimed.verifiedObjectCount < claimed.nextObjectNumber) {
          await retryTransient(() => this.reverifyObject(claimed));
        } else {
          const advertised = await this.publish(claimed);
          await this.applyRetention(claimed.runDate);
          return advertised
            ? { outcome: "verified", detail: "memory backup verified" }
            : { outcome: "pending", detail: "memory backup pointer repair pending" };
        }
      } catch (error) {
        const code = error instanceof MemoryBackupError ? error.code : MEMORY_BACKUP_FAILURE_CODES.operation;
        try {
          await retryTransient(() => this.repository.fail(claimed, code, this.options.clock.now()));
        } catch {
          // The fixed outcome remains safe for logs even when D1 is the failed dependency.
        }
        await this.alert(claimed.runDate, claimed.runId, code);
        return { outcome: "failed", code };
      }
      const refreshed = await retryTransient(() => this.repository.readById(run.runId));
      if (refreshed === null) throw new Error("memory_backup_run_missing");
      run = refreshed;
    }
    return { outcome: "pending", detail: "memory backup work remains" };
  }

  private async exportPage(run: MemoryBackupRun, cut: MemoryBackupTableCut): Promise<void> {
    const bucket = this.options.bucket;
    if (bucket === undefined) throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
    const descriptors = await this.repository.descriptors();
    const descriptor = descriptorForCut(cut, descriptors);
    if (descriptor === null || descriptor.keyKind !== cut.keyKind) {
      throw new Error("memory_backup_cut_descriptor_mismatch");
    }
    if (cut.throughKey === null) {
      await this.repository.finishTable(run, cut, this.options.clock.now());
      return;
    }
    const selected = await this.repository.page(run, cut, descriptor, this.rowLimit);
    if (selected.length === 0) {
      await this.repository.finishTable(run, cut, this.options.clock.now());
      return;
    }
    const encoded = encodeRows(selected, this.byteLimit);
    const firstKey = rowKey(encoded.rows[0]!);
    const lastKey = rowKey(encoded.rows.at(-1)!);
    const sha256 = await sha256Hex(encoded.bytes);
    const objectKey = `${prefixFor(run)}staging/${cut.table}/${String(run.nextObjectNumber).padStart(8, "0")}.ndjson`;
    await retryTransient(() => bucket.put(objectKey, encoded.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
    }));
    await readAndVerify(
      bucket, objectKey, encoded.bytes.byteLength, sha256,
      MEMORY_BACKUP_FAILURE_CODES.objectReadback,
    );
    const verifiedAt = this.options.clock.now().toISOString();
    await this.repository.recordObject(run, {
      objectNumber: run.nextObjectNumber,
      table: cut.table,
      objectKey,
      schemaVersion: run.schemaVersion,
      rowCount: encoded.rows.length,
      byteCount: encoded.bytes.byteLength,
      firstKey,
      lastKey,
      sha256,
      verifiedAt,
    }, this.options.clock.now());
  }

  private async reverifyObject(run: MemoryBackupRun): Promise<void> {
    const bucket = this.options.bucket;
    if (bucket === undefined) throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
    const object = await this.repository.readObject(run.runId, run.verifiedObjectCount);
    if (object === null) throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.objectReadback);
    await readAndVerify(
      bucket, object.objectKey, object.byteCount, object.sha256,
      MEMORY_BACKUP_FAILURE_CODES.objectReadback,
    );
    await this.repository.recordObjectReverified(run, this.options.clock.now());
  }

  private async publish(run: MemoryBackupRun): Promise<boolean> {
    const bucket = this.options.bucket;
    if (bucket === undefined) throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
    const objects = await this.repository.listObjects(run.runId);
    if (objects.length !== run.nextObjectNumber) {
      throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.manifestReadback);
    }
    const cuts = await this.repository.listCuts(run.runId);
    // Compared against the run's own cuts, not the current constant: a set
    // captured before a migration added tables must still publish, and its
    // manifest describes exactly the tables it holds.
    if (cuts.length === 0 || cuts.some((cut, index) => cut.tableIndex !== index)) {
      throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.manifestReadback);
    }
    const exportedRows = new Map<MemoryBackupTableName, number>();
    for (const object of objects) {
      exportedRows.set(object.table, (exportedRows.get(object.table) ?? 0) + object.rowCount);
    }
    const manifest = Object.freeze({
      schemaVersion: "1.0",
      databaseSchemaVersion: run.schemaVersion,
      runDate: run.runDate,
      runId: run.runId,
      startedAt: run.startedAt,
      coverageMarks: run.marks,
      tableCuts: cuts.map((cut) => {
        const exportedRowCount = exportedRows.get(cut.table) ?? 0;
        return Object.freeze({
          ...cut,
          exportedRowCount,
          shortfallRowCount: cut.expectedRowCount - exportedRowCount,
        });
      }),
      objects: objects.map((object) => Object.freeze({
        table: object.table,
        schemaVersion: object.schemaVersion,
        objectKey: object.objectKey,
        rowCount: object.rowCount,
        byteCount: object.byteCount,
        firstKey: object.firstKey,
        lastKey: object.lastKey,
        sha256: object.sha256,
      })),
    });
    const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
    const manifestSha256 = await sha256Hex(manifestBytes);
    const manifestObjectKey = `${prefixFor(run)}manifest.json`;
    await retryTransient(() => bucket.put(manifestObjectKey, manifestBytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: manifestSha256,
    }));
    await readAndVerify(
      bucket, manifestObjectKey, manifestBytes.byteLength, manifestSha256,
      MEMORY_BACKUP_FAILURE_CODES.manifestReadback,
    );
    const verified = await retryTransient(
      () => this.repository.verifyRun(run, manifestObjectKey, manifestSha256, this.options.clock.now()),
    );
    return this.ensureAdvertised(verified);
  }

  private async ensureAdvertised(run: MemoryBackupRun): Promise<boolean> {
    const bucket = this.options.bucket;
    if (bucket === undefined || run.status !== "verified"
      || run.manifestObjectKey === null || run.manifestSha256 === null) return false;
    const latest: LatestPointer = Object.freeze({
      schemaVersion: "1.0",
      runDate: run.runDate,
      runId: run.runId,
      manifestObjectKey: run.manifestObjectKey,
      manifestSha256: run.manifestSha256,
    });
    try {
      await retryTransient(() => bucket.put(
        MEMORY_BACKUP_LATEST_KEY,
        new TextEncoder().encode(canonicalJson(latest)),
      ));
      return true;
    } catch {
      console.error(MEMORY_BACKUP_FAILURE_CODES.advertise);
      return false;
    }
  }

  private async alert(localDate: string, runId: string | null, code: MemoryBackupFailureCode): Promise<void> {
    try {
      if (!await this.repository.claimAlert(localDate, runId, code, this.options.clock.now())) return;
      await this.options.notice.send(MEMORY_BACKUP_NOTICE);
    } catch {
      // Never replace a fixed backup failure code with provider or credential text.
    }
  }

  private async readLatestPointer(): Promise<LatestPointer | null> {
    const bucket = this.options.bucket;
    if (bucket === undefined) return null;
    const object = await retryTransient(() => bucket.get(MEMORY_BACKUP_LATEST_KEY));
    if (object === null) return null;
    const parsed = JSON.parse(await object.text()) as Partial<LatestPointer>;
    if (parsed.schemaVersion !== "1.0" || typeof parsed.runDate !== "string"
      || typeof parsed.runId !== "string" || typeof parsed.manifestObjectKey !== "string"
      || typeof parsed.manifestSha256 !== "string") {
      throw new Error("memory_backup_latest_invalid");
    }
    return parsed as LatestPointer;
  }

  private async deleteSet(run: MemoryBackupRun): Promise<boolean> {
    const bucket = this.options.bucket;
    if (bucket === undefined) return false;
    const latest = await this.readLatestPointer();
    if (latest?.runId === run.runId) return false;
    const manifestKey = `${prefixFor(run)}manifest.json`;
    const listed = await retryTransient(() => bucket.list({ prefix: prefixFor(run), limit: 1000 }));
    const objectKeys = listed.objects.map((object) => object.key).filter((key) => key !== manifestKey);
    if (objectKeys.length > 0) await retryTransient(() => bucket.delete(objectKeys));
    if (listed.truncated) return false;
    const latestBeforeManifest = await this.readLatestPointer();
    if (latestBeforeManifest?.runId === run.runId) return false;
    if (listed.objects.some((object) => object.key === manifestKey)) {
      await retryTransient(() => bucket.delete(manifestKey));
    }
    return true;
  }

  private async cleanupFailed(run: MemoryBackupRun): Promise<boolean> {
    if (this.options.bucket === undefined) return false;
    try {
      if (!await this.deleteSet(run)) return false;
      await retryTransient(() => this.repository.abandon(run, this.options.clock.now()));
      return true;
    } catch {
      console.error(MEMORY_BACKUP_FAILURE_CODES.cleanup);
      return false;
    }
  }

  private async applyRetention(currentDate: string): Promise<void> {
    if (this.options.bucket === undefined) return;
    try {
      const verified = await retryTransient(() => this.repository.listVerified());
      const latest = await this.readLatestPointer();
      const candidateId = selectMemoryBackupRetentionDeletes(verified, currentDate)
        .find((runId) => runId !== latest?.runId);
      if (candidateId === undefined) return;
      const candidate = verified.find((run) => run.runId === candidateId);
      if (candidate === undefined || verified.length <= 1) return;
      if (!await this.deleteSet(candidate)) return;
      await retryTransient(() => this.repository.prune(candidate, this.options.clock.now()));
    } catch {
      // Retention is retried while the D1 row remains verified. It cannot turn
      // a newly verified data set into a backup failure.
      console.error(MEMORY_BACKUP_FAILURE_CODES.cleanup);
    }
  }
}

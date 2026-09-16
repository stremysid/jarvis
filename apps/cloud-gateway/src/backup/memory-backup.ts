import { canonicalJson, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";

export const MEMORY_BACKUP_FAILURE_CODES = Object.freeze({
  bindingMissing: "memory_backup_binding_missing",
  objectReadback: "memory_backup_object_readback_failed",
  manifestReadback: "memory_backup_manifest_readback_failed",
  advertise: "memory_backup_advertise_failed",
  cleanup: "memory_backup_cleanup_failed",
  operation: "memory_backup_operation_failed",
} as const);

export type MemoryBackupFailureCode = typeof MEMORY_BACKUP_FAILURE_CODES[keyof typeof MEMORY_BACKUP_FAILURE_CODES];

export const MEMORY_BACKUP_NOTICE = "Last night's memory backup didn't complete; Jarvis will retry tonight.";
export const MEMORY_BACKUP_LATEST_KEY = "memory-backup/latest.json";

const TABLES = Object.freeze([
  { table: "events", key: "sequence", mark: "eventsThrough", numeric: true },
  { table: "memory_item_transitions", key: "transition_id", mark: "memoryItemTransitionsThrough", numeric: false },
  { table: "memory_event_suppressions", key: "suppression_id", mark: "memoryEventSuppressionsThrough", numeric: false },
  { table: "memory_event_suppression_lifts", key: "lift_id", mark: "memoryEventSuppressionLiftsThrough", numeric: false },
  { table: "memory_topic_events", key: "topic_event_id", mark: "memoryTopicEventsThrough", numeric: false },
  { table: "memory_item_placement_events", key: "placement_event_id", mark: "memoryItemPlacementEventsThrough", numeric: false },
  { table: "memory_cost_ledger", key: "cost_entry_id", mark: "memoryCostLedgerThrough", numeric: false },
] as const);

type BackupTable = typeof TABLES[number];
type BackupTableName = BackupTable["table"];

export interface MemoryBackupMarks {
  readonly eventsAfter: number;
  readonly eventsThrough: number;
  readonly memoryItemTransitionsThrough: string | null;
  readonly memoryEventSuppressionsThrough: string | null;
  readonly memoryEventSuppressionLiftsThrough: string | null;
  readonly memoryTopicEventsThrough: string | null;
  readonly memoryItemPlacementEventsThrough: string | null;
  readonly memoryCostLedgerThrough: string | null;
}

type RunStatus = "running" | "verified" | "failed" | "abandoned" | "pruned";

interface StoredRun {
  run_date: string;
  run_id: string;
  status: RunStatus;
  schema_version: string;
  marks_json: string;
  current_table_index: number;
  cursor_key: string | null;
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
  readonly cursorKey: string | null;
  readonly nextObjectNumber: number;
  readonly verifiedObjectCount: number;
  readonly leaseId: string | null;
  readonly manifestObjectKey: string | null;
  readonly manifestSha256: string | null;
  readonly failureCode: MemoryBackupFailureCode | null;
  readonly startedAt: string;
  readonly verifiedAt: string | null;
}

interface StoredObject {
  run_id: string;
  object_number: number;
  table_name: BackupTableName;
  object_key: string;
  schema_version: string;
  row_count: number;
  byte_count: number;
  first_key: string;
  last_key: string;
  sha256: string;
  verified_at: string;
}

export interface MemoryBackupObject {
  readonly runId: string;
  readonly objectNumber: number;
  readonly table: BackupTableName;
  readonly objectKey: string;
  readonly schemaVersion: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly firstKey: string;
  readonly lastKey: string;
  readonly sha256: string;
  readonly verifiedAt: string;
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
}

export type MemoryBackupOutcome =
  | { readonly outcome: "idle" | "pending" | "verified"; readonly detail: string }
  | { readonly outcome: "failed"; readonly code: MemoryBackupFailureCode };

interface ScalarRow {
  value: string | number | null;
}

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

function requireLimits(rowLimit: number, byteLimit: number): void {
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > 32) {
    throw new RangeError("memory_backup_row_limit_invalid");
  }
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1024 || byteLimit > 1024 * 1024) {
    throw new RangeError("memory_backup_byte_limit_invalid");
  }
}

function scalar(result: D1Result<unknown>): string | number | null {
  const row = result.results[0] as ScalarRow | undefined;
  return row?.value ?? null;
}

function stringMark(value: string | number | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error("memory_backup_mark_invalid");
  return value;
}

function numberMark(value: string | number | null): number {
  if (value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("memory_backup_mark_invalid");
  }
  return value;
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
  const expected = [
    "eventsAfter", "eventsThrough", "memoryCostLedgerThrough", "memoryEventSuppressionLiftsThrough",
    "memoryEventSuppressionsThrough", "memoryItemPlacementEventsThrough", "memoryItemTransitionsThrough",
    "memoryTopicEventsThrough",
  ];
  if (Object.keys(marks).sort().join("|") !== expected.sort().join("|")) {
    throw new Error("memory_backup_marks_invalid");
  }
  if (!Number.isSafeInteger(marks.eventsAfter) || !Number.isSafeInteger(marks.eventsThrough)
    || (marks.eventsAfter as number) < 0 || (marks.eventsThrough as number) < (marks.eventsAfter as number)) {
    throw new Error("memory_backup_marks_invalid");
  }
  for (const key of expected.slice(2)) {
    if (marks[key] !== null && (typeof marks[key] !== "string" || marks[key].length === 0)) {
      throw new Error("memory_backup_marks_invalid");
    }
  }
  return Object.freeze(marks as unknown as MemoryBackupMarks);
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

const RUN_COLUMNS = `run_date, run_id, status, schema_version, marks_json,
  current_table_index, cursor_key, next_object_number, verified_object_count,
  lease_id, lease_expires_at, manifest_object_key, manifest_sha256, failure_code,
  started_at, updated_at, verified_at, abandoned_at, pruned_at`;

const OBJECT_COLUMNS = `run_id, object_number, table_name, object_key, schema_version,
  row_count, byte_count, first_key, last_key, sha256, verified_at`;

class MemoryBackupRepository {
  constructor(private readonly database: D1Database) {}

  async readByDate(runDate: string): Promise<MemoryBackupRun | null> {
    const row = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM memory_backup_runs WHERE run_date = ?`,
    ).bind(runDate).first<StoredRun>();
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

  async captureRun(runDate: string, now: Date): Promise<MemoryBackupRun> {
    const timestamp = now.toISOString();
    const captured = await this.database.batch([
      this.database.prepare("SELECT name AS value FROM d1_migrations ORDER BY id DESC LIMIT 1"),
      this.database.prepare("SELECT sealed_through AS value FROM archive_state WHERE singleton = 1"),
      this.database.prepare("SELECT max(sequence) AS value FROM events"),
      this.database.prepare("SELECT max(transition_id) AS value FROM memory_item_transitions"),
      this.database.prepare("SELECT max(suppression_id) AS value FROM memory_event_suppressions"),
      this.database.prepare("SELECT max(lift_id) AS value FROM memory_event_suppression_lifts"),
      this.database.prepare("SELECT max(topic_event_id) AS value FROM memory_topic_events"),
      this.database.prepare("SELECT max(placement_event_id) AS value FROM memory_item_placement_events"),
      this.database.prepare("SELECT max(cost_entry_id) AS value FROM memory_cost_ledger"),
    ]);
    const schemaVersion = scalar(captured[0]!);
    if (typeof schemaVersion !== "string" || schemaVersion.length === 0) {
      throw new Error("memory_backup_schema_version_unavailable");
    }
    const eventsAfter = numberMark(scalar(captured[1]!));
    const eventsThrough = Math.max(eventsAfter, numberMark(scalar(captured[2]!)));
    const marks: MemoryBackupMarks = Object.freeze({
      eventsAfter,
      eventsThrough,
      memoryItemTransitionsThrough: stringMark(scalar(captured[3]!)),
      memoryEventSuppressionsThrough: stringMark(scalar(captured[4]!)),
      memoryEventSuppressionLiftsThrough: stringMark(scalar(captured[5]!)),
      memoryTopicEventsThrough: stringMark(scalar(captured[6]!)),
      memoryItemPlacementEventsThrough: stringMark(scalar(captured[7]!)),
      memoryCostLedgerThrough: stringMark(scalar(captured[8]!)),
    });
    const runId = newUlid(now);
    try {
      await this.database.prepare(
        `INSERT INTO memory_backup_runs (
           run_date, run_id, status, schema_version, marks_json, current_table_index,
           cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
           manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
           verified_at, abandoned_at, pruned_at
         ) VALUES (?, ?, 'running', ?, ?, 0, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      ).bind(runDate, runId, schemaVersion, canonicalJson(marks), timestamp, timestamp).run();
    } catch (error) {
      // The insert trigger deliberately defeats conflict-clause bypasses. A
      // concurrent winner is still an idempotent claim, but nothing else is.
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

  async finishTable(run: MemoryBackupRun, now: Date): Promise<void> {
    if (run.leaseId === null) throw new Error("memory_backup_lease_missing");
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
  ): Promise<void> {
    if (run.leaseId === null) throw new Error("memory_backup_lease_missing");
    const timestamp = now.toISOString();
    const result = await this.database.prepare(
      `UPDATE memory_backup_runs
       SET status = 'verified', manifest_object_key = ?, manifest_sha256 = ?,
         verified_at = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND status = 'running' AND lease_id = ?`,
    ).bind(manifestObjectKey, manifestSha256, timestamp, timestamp, run.runId, run.leaseId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("memory_backup_progress_lost");
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

  async page(run: MemoryBackupRun, table: BackupTable, limit: number): Promise<readonly Record<string, unknown>[]> {
    const mark = run.marks[table.mark];
    if (mark === null) return [];
    if (table.numeric) {
      const cursor = run.cursorKey === null ? run.marks.eventsAfter : Number.parseInt(run.cursorKey, 10);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || typeof mark !== "number") {
        throw new Error("memory_backup_cursor_invalid");
      }
      const { results } = await this.database.prepare(
        `SELECT * FROM events WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?`,
      ).bind(cursor, mark, limit).all<Record<string, unknown>>();
      return results;
    }
    if (typeof mark !== "string") throw new Error("memory_backup_mark_invalid");
    const cursor = run.cursorKey ?? "";
    const { results } = await this.database.prepare(
      `SELECT * FROM ${table.table} WHERE ${table.key} > ? AND ${table.key} <= ?
       ORDER BY ${table.key} LIMIT ?`,
    ).bind(cursor, mark, limit).all<Record<string, unknown>>();
    return results;
  }
}

function tableMark(run: MemoryBackupRun, table: BackupTable): string | number | null {
  return run.marks[table.mark];
}

function rowKey(row: Record<string, unknown>, table: BackupTable): string {
  const value = row[table.key];
  if (table.numeric) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new Error("memory_backup_row_key_invalid");
    }
    return String(value);
  }
  if (typeof value !== "string" || value.length === 0) throw new Error("memory_backup_row_key_invalid");
  return value;
}

function encodeRows(
  rows: readonly Record<string, unknown>[],
  table: BackupTable,
  byteLimit: number,
): { readonly rows: readonly Record<string, unknown>[]; readonly bytes: Uint8Array } {
  const encoder = new TextEncoder();
  const accepted: Record<string, unknown>[] = [];
  let text = "";
  for (const row of rows) {
    const line = `${canonicalJson(row)}\n`;
    const candidate = encoder.encode(text + line);
    if (candidate.byteLength > byteLimit) {
      if (accepted.length === 0) throw new Error("memory_backup_row_too_large");
      break;
    }
    rowKey(row, table);
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
    object = await bucket.get(objectKey);
  } catch {
    throw new MemoryBackupError(failureCode);
  }
  if (object === null || !Number.isSafeInteger(object.size) || object.size !== expectedBytes) {
    throw new MemoryBackupError(failureCode);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await object.arrayBuffer();
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

  constructor(private readonly options: MemoryBackupOptions) {
    this.repository = new MemoryBackupRepository(options.database);
    this.rowLimit = options.pageRowLimit ?? 16;
    this.byteLimit = options.pageByteLimit ?? 1024 * 1024;
    requireLimits(this.rowLimit, this.byteLimit);
  }

  async runNightly(runDate: string): Promise<MemoryBackupOutcome> {
    requireDate(runDate);
    try {
      const failed = await this.repository.readFailedBefore(runDate);
      if (failed !== null) {
        const cleaned = await this.cleanupFailed(failed, runDate);
        if (!cleaned) return { outcome: "pending", detail: "memory backup cleanup pending" };
      }
      const running = await this.repository.readRunning();
      if (running !== null) return this.advance(running, runDate);
      const existing = await this.repository.readByDate(runDate);
      if (existing !== null) {
        if (existing.status === "verified") return { outcome: "verified", detail: "memory backup already verified" };
        if (existing.status === "failed") {
          await this.alert(runDate, existing.runId, existing.failureCode ?? MEMORY_BACKUP_FAILURE_CODES.operation);
          return { outcome: "failed", code: existing.failureCode ?? MEMORY_BACKUP_FAILURE_CODES.operation };
        }
        return { outcome: "idle", detail: `memory backup ${existing.status}` };
      }
      const created = await this.repository.captureRun(runDate, this.options.clock.now());
      return this.advance(created, runDate);
    } catch {
      await this.alert(runDate, null, MEMORY_BACKUP_FAILURE_CODES.operation);
      return { outcome: "failed", code: MEMORY_BACKUP_FAILURE_CODES.operation };
    }
  }

  async continueActive(localDate: string): Promise<MemoryBackupOutcome> {
    requireDate(localDate);
    try {
      const running = await this.repository.readRunning();
      if (running !== null) return this.advance(running, localDate);
      // A very large prior cut can still be finishing when the next night is
      // claimed. The nightly scheduled_runs row remembers that date was due,
      // so the drain starts its cut after the older run completes rather than
      // silently skipping an entire night's set.
      if (!await this.repository.nightlyRunWasScheduled(localDate)) {
        return { outcome: "idle", detail: "no memory backup continuation" };
      }
      const existing = await this.repository.readByDate(localDate);
      if (existing !== null) {
        return existing.status === "verified"
          ? { outcome: "verified", detail: "memory backup already verified" }
          : { outcome: "idle", detail: `memory backup ${existing.status}` };
      }
      return this.advance(
        await this.repository.captureRun(localDate, this.options.clock.now()),
        localDate,
      );
    } catch {
      await this.alert(localDate, null, MEMORY_BACKUP_FAILURE_CODES.operation);
      return { outcome: "failed", code: MEMORY_BACKUP_FAILURE_CODES.operation };
    }
  }

  private async advance(run: MemoryBackupRun, alertDate: string): Promise<MemoryBackupOutcome> {
    const claimed = await this.repository.claimStep(run.runId, this.options.clock.now());
    if (claimed === null) return { outcome: "pending", detail: "memory backup step already running" };
    try {
      if (this.options.bucket === undefined) {
        throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
      }
      if (claimed.currentTableIndex < TABLES.length) {
        await this.exportPage(claimed, TABLES[claimed.currentTableIndex]!);
        return { outcome: "pending", detail: "memory backup export pending" };
      }
      if (claimed.verifiedObjectCount < claimed.nextObjectNumber) {
        await this.reverifyObject(claimed);
        return { outcome: "pending", detail: "memory backup verification pending" };
      }
      await this.publish(claimed);
      await this.applyRetention(claimed.runDate);
      return { outcome: "verified", detail: "memory backup verified" };
    } catch (error) {
      const code = error instanceof MemoryBackupError ? error.code : MEMORY_BACKUP_FAILURE_CODES.operation;
      try {
        await this.repository.fail(claimed, code, this.options.clock.now());
      } catch {
        // The fixed outcome remains safe for logs even when D1 is the failed dependency.
      }
      await this.alert(alertDate, claimed.runId, code);
      return { outcome: "failed", code };
    }
  }

  private async exportPage(run: MemoryBackupRun, table: BackupTable): Promise<void> {
    const bucket = this.options.bucket;
    if (bucket === undefined) throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
    const mark = tableMark(run, table);
    if (mark === null || (table.numeric && mark === run.marks.eventsAfter && run.cursorKey === null)) {
      await this.repository.finishTable(run, this.options.clock.now());
      return;
    }
    const selected = await this.repository.page(run, table, this.rowLimit);
    if (selected.length === 0) {
      await this.repository.finishTable(run, this.options.clock.now());
      return;
    }
    const encoded = encodeRows(selected, table, this.byteLimit);
    const firstKey = rowKey(encoded.rows[0]!, table);
    const lastKey = rowKey(encoded.rows.at(-1)!, table);
    const sha256 = await sha256Hex(encoded.bytes);
    const objectKey = `${prefixFor(run)}staging/${table.table}/${String(run.nextObjectNumber).padStart(8, "0")}.ndjson`;
    await bucket.put(objectKey, encoded.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
    });
    await readAndVerify(
      bucket, objectKey, encoded.bytes.byteLength, sha256,
      MEMORY_BACKUP_FAILURE_CODES.objectReadback,
    );
    const verifiedAt = this.options.clock.now().toISOString();
    await this.repository.recordObject(run, {
      objectNumber: run.nextObjectNumber,
      table: table.table,
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

  private async publish(run: MemoryBackupRun): Promise<void> {
    const bucket = this.options.bucket;
    if (bucket === undefined) throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
    const objects = await this.repository.listObjects(run.runId);
    if (objects.length !== run.nextObjectNumber) {
      throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.manifestReadback);
    }
    const manifest = Object.freeze({
      schemaVersion: "1.0",
      databaseSchemaVersion: run.schemaVersion,
      runDate: run.runDate,
      runId: run.runId,
      startedAt: run.startedAt,
      coverageMarks: run.marks,
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
    await bucket.put(manifestObjectKey, manifestBytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: manifestSha256,
    });
    await readAndVerify(
      bucket, manifestObjectKey, manifestBytes.byteLength, manifestSha256,
      MEMORY_BACKUP_FAILURE_CODES.manifestReadback,
    );
    const latest = new TextEncoder().encode(canonicalJson({
      schemaVersion: "1.0",
      runDate: run.runDate,
      runId: run.runId,
      manifestObjectKey,
      manifestSha256,
    }));
    try {
      await bucket.put(MEMORY_BACKUP_LATEST_KEY, latest);
    } catch {
      throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.advertise);
    }
    await this.repository.verifyRun(run, manifestObjectKey, manifestSha256, this.options.clock.now());
  }

  private async alert(localDate: string, runId: string | null, code: MemoryBackupFailureCode): Promise<void> {
    try {
      if (!await this.repository.claimAlert(localDate, runId, code, this.options.clock.now())) return;
      await this.options.notice.send(MEMORY_BACKUP_NOTICE);
    } catch {
      // Never replace a fixed backup failure code with provider or credential text.
    }
  }

  private async cleanupFailed(run: MemoryBackupRun, alertDate: string): Promise<boolean> {
    const bucket = this.options.bucket;
    if (bucket === undefined) {
      await this.alert(alertDate, run.runId, MEMORY_BACKUP_FAILURE_CODES.bindingMissing);
      return false;
    }
    try {
      const listed = await bucket.list({ prefix: prefixFor(run), limit: 1000 });
      if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
      if (listed.truncated) return false;
      await this.repository.abandon(run, this.options.clock.now());
      return true;
    } catch {
      await this.alert(alertDate, run.runId, MEMORY_BACKUP_FAILURE_CODES.cleanup);
      return false;
    }
  }

  private async applyRetention(currentDate: string): Promise<void> {
    const bucket = this.options.bucket;
    if (bucket === undefined) return;
    const verified = await this.repository.listVerified();
    const candidateId = selectMemoryBackupRetentionDeletes(verified, currentDate)[0];
    if (candidateId === undefined) return;
    const candidate = verified.find((run) => run.runId === candidateId);
    if (candidate === undefined || verified.length <= 1) return;
    try {
      const listed = await bucket.list({ prefix: prefixFor(candidate), limit: 1000 });
      if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
      if (listed.truncated) return;
      await this.repository.prune(candidate, this.options.clock.now());
    } catch {
      throw new MemoryBackupError(MEMORY_BACKUP_FAILURE_CODES.cleanup);
    }
  }
}

import { canonicalJson, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { TransactionRunner } from "../persistence/transaction.js";
import type {
  DerivedMissingWorkState,
  RawSchoolSubmissionObservation,
  SchoolDerivedMissingWork,
  SchoolGradeObservation,
  SchoolObservationDigestSnapshot,
  SchoolObservationStudySnapshot,
  SchoolObservationSyncState,
  SchoolStudyGradeObservation,
  SchoolStudyMissingWork,
  SchoolSubmissionState,
} from "./school-observation-types.js";

/**
 * Worst-case slice budget: three setup statements, four 25-item API pages at
 * two writes per changed item, four checkpoints, and one 64-row derivation
 * page. Every D1 statement in the repeated sync path is claimed here first.
 */
export const CLASSROOM_OBSERVATION_D1_STATEMENT_BUDGET = 320;
export const MISSING_WORK_DERIVATION_PAGE_SIZE = 64;
export const SCHOOL_STUDY_OBSERVATION_ROW_LIMIT = 24;

export class D1StatementBudget {
  #used = 0;

  constructor(readonly limit = CLASSROOM_OBSERVATION_D1_STATEMENT_BUDGET) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("school_observation_d1_budget_invalid");
  }

  claim(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.#used + count > this.limit) {
      throw new Error("school_observation_d1_budget_exhausted");
    }
    this.#used += count;
  }

  get used(): number {
    return this.#used;
  }
}

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const SUBMISSION_STATES: readonly SchoolSubmissionState[] = Object.freeze([
  "new", "created", "turned_in", "returned", "reclaimed_by_student", "student_edited_after_turn_in",
]);
const SUBMITTED_STATES = new Set<SchoolSubmissionState>([
  "turned_in", "returned", "student_edited_after_turn_in",
]);
const DERIVED_STATES: readonly DerivedMissingWorkState[] = Object.freeze([
  "not_due", "no_submission_seen", "submission_seen", "closed",
]);
const encoder = new TextEncoder();

interface SyncRow {
  principal_id: string;
  source_id: string;
  provider: string;
  checkpoint_course_id: string | null;
  checkpoint_page_token: string | null;
  scan_started_at: string | null;
  derivation_scan_at: string | null;
  derivation_started_at: string | null;
  derivation_after_deadline_id: string | null;
  last_batch_at: string | null;
  last_success_at: string | null;
  last_success_started_at: string | null;
  last_failure: string | null;
  last_failure_at: string | null;
}

interface DeadlineObservationRow {
  deadline_id: string;
  external_id: string;
}

interface ObservationRow {
  principal_id: string;
  observation_id: string;
  source_id: string;
  deadline_id: string;
  external_submission_id: string;
  submission_state: string;
  late: number | null;
  assigned_grade: number | null;
  max_points: number | null;
  source_updated_at: string | null;
  content_hash: string;
  first_seen_at: string;
  content_changed_at: string;
  last_seen_at: string;
}

interface DerivationRow {
  deadline_id: string;
  due_at: string;
  status: string;
  observation_id: string;
  submission_state: string;
  last_seen_at: string;
  already_derived: number;
  last_state: string | null;
  last_basis_due_at: string | null;
  last_basis_observation_id: string | null;
}

interface GradeRow {
  observation_id: string;
  deadline_id: string;
  course: string;
  title: string;
  assigned_grade: number;
  max_points: number | null;
  source_updated_at: string | null;
  content_changed_at: string;
  last_seen_at: string;
}

interface D2lGradeRow {
  observation_id: string;
  deadline_id: string | null;
  course: string;
  title: string;
  assigned_grade: number;
  max_points: number | null;
  observed_at: string;
}

interface MissingRow {
  transition_id: string;
  deadline_id: string;
  course: string;
  title: string;
  due_at: string;
  classification: string;
  to_state: string;
  last_seen_at: string;
  total_count: number;
}

interface StudyGradeRow extends GradeRow {
  source_last_success_at: string | null;
  source_last_failure: string | null;
}

interface StudyMissingRow extends MissingRow {
  source_last_success_at: string | null;
  source_last_failure: string | null;
}

export interface ObservationIngestionReport {
  readonly created: number;
  readonly revised: number;
  readonly unchanged: number;
  readonly rejected: number;
}

export interface MissingWorkDerivationReport {
  readonly transitions: number;
  readonly nextAfterDeadlineId: string | null;
}

export interface D2lEmailGradeInput {
  readonly principalId: string;
  readonly emailId: string;
  readonly deadlineId: string | null;
  readonly externalId: string;
  readonly course: string;
  readonly title: string;
  readonly assignedGrade: number;
  readonly maxPoints: number | null;
  readonly now: Date;
}

function rows<T>(result: D1Result<T>): readonly T[] {
  if (!Array.isArray(result.results)) throw new TypeError("school_observation_rows_invalid");
  return result.results;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new TypeError(label);
  const normalized = value.normalize("NFC");
  if (
    normalized.length === 0
    || !normalized.isWellFormed()
    || normalized !== value
    || UNSAFE_INLINE.test(normalized)
    || encoder.encode(normalized).byteLength > maximumBytes
  ) throw new TypeError(label);
  return normalized;
}

function principal(value: unknown): string {
  return text(value, "school_observation_principal_invalid", 256);
}

function identifier(value: unknown, label: string, maximumBytes = 1_024): string {
  return text(value, label, maximumBytes);
}

function ulid(value: unknown, label: string): string {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(label);
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new TypeError(label);
  return value;
}

function optionalInstant(value: unknown, label: string): string | null {
  return value === null ? null : instant(value, label);
}

function at(value: Date): string {
  const copy = new Date(value.getTime());
  if (!Number.isFinite(copy.getTime())) throw new TypeError("school_observation_clock_invalid");
  return copy.toISOString();
}

function state(value: unknown): SchoolSubmissionState {
  if (typeof value !== "string" || !SUBMISSION_STATES.includes(value as SchoolSubmissionState)) {
    throw new TypeError("school_observation_state_invalid");
  }
  return value as SchoolSubmissionState;
}

function grade(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new TypeError("school_observation_grade_invalid");
  }
  return value;
}

function scale(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
    throw new TypeError("school_observation_scale_invalid");
  }
  return value;
}

function syncState(row: SyncRow, expectedPrincipal: string, expectedSource: string): SchoolObservationSyncState {
  if (row.principal_id !== expectedPrincipal || row.source_id !== expectedSource || row.provider !== "google_classroom_api") {
    throw new TypeError("school_observation_sync_row_invalid");
  }
  const checkpointCourseId = row.checkpoint_course_id === null
    ? null
    : identifier(row.checkpoint_course_id, "school_observation_sync_row_invalid");
  const checkpointPageToken = row.checkpoint_page_token === null
    ? null
    : identifier(row.checkpoint_page_token, "school_observation_sync_row_invalid", 2_048);
  const scanStartedAt = optionalInstant(row.scan_started_at, "school_observation_sync_row_invalid");
  const derivationScanAt = optionalInstant(row.derivation_scan_at, "school_observation_sync_row_invalid");
  const derivationStartedAt = optionalInstant(row.derivation_started_at, "school_observation_sync_row_invalid");
  const lastSuccessAt = optionalInstant(row.last_success_at, "school_observation_sync_row_invalid");
  const lastSuccessStartedAt = optionalInstant(row.last_success_started_at, "school_observation_sync_row_invalid");
  if ((checkpointCourseId === null) !== (scanStartedAt === null) || (checkpointPageToken !== null && checkpointCourseId === null)) {
    throw new TypeError("school_observation_sync_row_invalid");
  }
  if ((derivationScanAt === null) !== (derivationStartedAt === null)) {
    throw new TypeError("school_observation_sync_row_invalid");
  }
  if ((lastSuccessAt === null) !== (lastSuccessStartedAt === null)) {
    throw new TypeError("school_observation_sync_row_invalid");
  }
  return Object.freeze({
    principalId: row.principal_id,
    sourceId: row.source_id,
    checkpointCourseId,
    checkpointPageToken,
    scanStartedAt,
    derivationScanAt,
    derivationStartedAt,
    derivationAfterDeadlineId: row.derivation_after_deadline_id === null
      ? null
      : identifier(row.derivation_after_deadline_id, "school_observation_sync_row_invalid"),
    lastBatchAt: optionalInstant(row.last_batch_at, "school_observation_sync_row_invalid"),
    lastSuccessAt,
    lastSuccessStartedAt,
    lastFailure: row.last_failure === null
      ? null
      : text(row.last_failure, "school_observation_sync_row_invalid", 160),
    lastFailureAt: optionalInstant(row.last_failure_at, "school_observation_sync_row_invalid"),
  });
}

function observationRow(row: ObservationRow, expectedPrincipal: string): ObservationRow & { submission_state: SchoolSubmissionState } {
  if (row.principal_id !== expectedPrincipal || !HASH.test(row.content_hash)) {
    throw new TypeError("school_observation_row_invalid");
  }
  ulid(row.observation_id, "school_observation_row_invalid");
  identifier(row.source_id, "school_observation_row_invalid");
  identifier(row.deadline_id, "school_observation_row_invalid");
  identifier(row.external_submission_id, "school_observation_row_invalid");
  const parsedState = state(row.submission_state);
  if (row.late !== null && row.late !== 0 && row.late !== 1) throw new TypeError("school_observation_row_invalid");
  grade(row.assigned_grade);
  scale(row.max_points);
  optionalInstant(row.source_updated_at, "school_observation_row_invalid");
  instant(row.first_seen_at, "school_observation_row_invalid");
  instant(row.content_changed_at, "school_observation_row_invalid");
  instant(row.last_seen_at, "school_observation_row_invalid");
  return { ...row, submission_state: parsedState };
}

function normalize(raw: RawSchoolSubmissionObservation): RawSchoolSubmissionObservation {
  const deadlineExternalId = identifier(raw.deadlineExternalId, "school_observation_deadline_external_id_invalid");
  const externalSubmissionId = identifier(raw.externalSubmissionId, "school_observation_external_id_invalid");
  const normalizedState = state(raw.state);
  if (raw.late !== null && typeof raw.late !== "boolean") throw new TypeError("school_observation_late_invalid");
  const assignedGrade = grade(raw.assignedGrade);
  const maxPoints = scale(raw.maxPoints);
  const sourceUpdatedAt = optionalInstant(raw.sourceUpdatedAt, "school_observation_source_time_invalid");
  return Object.freeze({
    deadlineExternalId,
    externalSubmissionId,
    state: normalizedState,
    late: raw.late,
    assignedGrade,
    maxPoints,
    sourceUpdatedAt,
  });
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function failureCode(value: unknown): string {
  return text(value, "school_observation_failure_invalid", 160);
}

function contentHash(item: RawSchoolSubmissionObservation): Promise<string> {
  return sha256Hex(canonicalJson({
    assignedGrade: item.assignedGrade,
    late: item.late,
    maxPoints: item.maxPoints ?? null,
    sourceUpdatedAt: item.sourceUpdatedAt,
    state: item.state,
  }));
}

export class SchoolObservationRepository {
  readonly #transactions: TransactionRunner;

  constructor(
    private readonly database: D1Database,
    private readonly budget?: D1StatementBudget,
  ) {
    this.#transactions = new TransactionRunner(database);
  }

  #claim(count = 1): void {
    this.budget?.claim(count);
  }

  async ensureSync(principalIdValue: string, sourceIdValue: string, now: Date): Promise<SchoolObservationSyncState> {
    const principalId = principal(principalIdValue);
    const sourceId = identifier(sourceIdValue, "school_observation_source_invalid");
    const existing = await this.readSync(principalId, sourceId);
    if (existing !== null) return existing;
    const observedAt = at(now);
    this.#claim();
    await this.database.prepare(
      `INSERT INTO school_observation_sync (
         principal_id, source_id, provider, checkpoint_course_id, checkpoint_page_token,
         scan_started_at, derivation_scan_at, derivation_after_deadline_id,
         derivation_started_at,
         last_batch_at, last_success_at, last_success_started_at,
         last_failure, last_failure_at, created_at, updated_at
       ) VALUES (?, ?, 'google_classroom_api', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(principalId, sourceId, observedAt, observedAt).run();
    return await this.requireSync(principalId, sourceId);
  }

  /** Append one trusted D2L email grade into the shared school observation read path. */
  async ingestD2lEmailGrade(input: D2lEmailGradeInput): Promise<boolean> {
    const principalId = principal(input.principalId);
    const emailId = ulid(input.emailId, "d2l_email_grade_email_invalid");
    const deadlineId = input.deadlineId === null
      ? null
      : identifier(input.deadlineId, "d2l_email_grade_deadline_invalid");
    const externalId = identifier(input.externalId, "d2l_email_grade_external_id_invalid", 256);
    const course = text(input.course, "d2l_email_grade_course_invalid", 512);
    const title = text(input.title, "d2l_email_grade_title_invalid", 512);
    const assignedGrade = grade(input.assignedGrade);
    const maxPoints = scale(input.maxPoints);
    if (assignedGrade === null) throw new TypeError("d2l_email_grade_value_invalid");
    const observedAt = at(input.now);
    const hash = await sha256Hex(canonicalJson({ assignedGrade, course, maxPoints, title }));
    // Claim the race path up front. The insert trigger must reject REPLACE,
    // so idempotency is an explicit read with a post-conflict re-read.
    this.#claim(3);
    const existing = async (): Promise<boolean> => await this.database.prepare(
      `SELECT observation_id FROM d2l_email_grade_observations
       WHERE principal_id = ? AND external_id = ? AND content_hash = ?`,
    ).bind(principalId, externalId, hash).first<{ observation_id: string }>() !== null;
    if (await existing()) return false;
    try {
      const result = await this.database.prepare(`INSERT INTO d2l_email_grade_observations (
        principal_id, observation_id, email_id, deadline_id, external_id, course, title,
        assigned_grade, max_points, content_hash, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          principalId, newUlid(), emailId, deadlineId, externalId, course, title,
          assignedGrade, maxPoints, hash, observedAt,
        ).run();
      return result.meta.changes > 0;
    } catch (error) {
      if (await existing()) return false;
      throw error;
    }
  }

  async readSync(principalIdValue: string, sourceIdValue: string): Promise<SchoolObservationSyncState | null> {
    const principalId = principal(principalIdValue);
    const sourceId = identifier(sourceIdValue, "school_observation_source_invalid");
    this.#claim();
    const row = await this.database.prepare(
      `SELECT principal_id, source_id, provider, checkpoint_course_id, checkpoint_page_token,
              scan_started_at, derivation_scan_at, derivation_started_at, derivation_after_deadline_id,
              last_batch_at, last_success_at, last_success_started_at, last_failure, last_failure_at
       FROM school_observation_sync WHERE principal_id = ? AND source_id = ?`,
    ).bind(principalId, sourceId).first<SyncRow>();
    return row === null ? null : syncState(row, principalId, sourceId);
  }

  async saveCheckpoint(input: {
    readonly principalId: string;
    readonly sourceId: string;
    readonly courseId: string;
    readonly pageToken: string | null;
    readonly scanStartedAt: string;
    readonly now: Date;
  }): Promise<void> {
    const principalId = principal(input.principalId);
    const sourceId = identifier(input.sourceId, "school_observation_source_invalid");
    const courseId = identifier(input.courseId, "school_observation_course_invalid");
    const pageToken = input.pageToken === null
      ? null
      : identifier(input.pageToken, "school_observation_page_token_invalid", 2_048);
    const scanStartedAt = instant(input.scanStartedAt, "school_observation_scan_time_invalid");
    const observedAt = at(input.now);
    this.#claim();
    const result = await this.database.prepare(
      `UPDATE school_observation_sync
       SET checkpoint_course_id = ?, checkpoint_page_token = ?, scan_started_at = ?,
           last_batch_at = ?, updated_at = ?
       WHERE principal_id = ? AND source_id = ? AND derivation_scan_at IS NULL`,
    ).bind(courseId, pageToken, scanStartedAt, observedAt, observedAt, principalId, sourceId).run();
    if (result.meta.changes !== 1) throw new Error("school_observation_checkpoint_write_failed");
  }

  async completeSubmissionScan(
    principalIdValue: string,
    sourceIdValue: string,
    completedAt: Date,
  ): Promise<void> {
    const principalId = principal(principalIdValue);
    const sourceId = identifier(sourceIdValue, "school_observation_source_invalid");
    const observedAt = at(completedAt);
    this.#claim();
    const result = await this.database.prepare(
      `UPDATE school_observation_sync
       SET checkpoint_course_id = NULL, checkpoint_page_token = NULL, scan_started_at = NULL,
           derivation_scan_at = ?, derivation_started_at = scan_started_at,
           derivation_after_deadline_id = NULL,
           last_batch_at = ?, last_success_at = ?, last_success_started_at = scan_started_at,
           last_failure = NULL, last_failure_at = NULL,
           updated_at = ?
       WHERE principal_id = ? AND source_id = ? AND checkpoint_course_id IS NOT NULL`,
    ).bind(observedAt, observedAt, observedAt, observedAt, principalId, sourceId).run();
    if (result.meta.changes !== 1) throw new Error("school_observation_scan_completion_failed");
  }

  async saveDerivationCheckpoint(
    principalIdValue: string,
    sourceIdValue: string,
    afterDeadlineId: string,
    now: Date,
  ): Promise<void> {
    const principalId = principal(principalIdValue);
    const sourceId = identifier(sourceIdValue, "school_observation_source_invalid");
    const after = identifier(afterDeadlineId, "school_observation_deadline_invalid");
    const observedAt = at(now);
    this.#claim();
    const result = await this.database.prepare(
      `UPDATE school_observation_sync
       SET derivation_after_deadline_id = ?, updated_at = ?
       WHERE principal_id = ? AND source_id = ? AND derivation_scan_at IS NOT NULL`,
    ).bind(after, observedAt, principalId, sourceId).run();
    if (result.meta.changes !== 1) throw new Error("school_observation_derivation_checkpoint_failed");
  }

  async completeDerivation(principalIdValue: string, sourceIdValue: string, now: Date): Promise<void> {
    const principalId = principal(principalIdValue);
    const sourceId = identifier(sourceIdValue, "school_observation_source_invalid");
    const observedAt = at(now);
    this.#claim();
    const result = await this.database.prepare(
      `UPDATE school_observation_sync
       SET derivation_scan_at = NULL, derivation_started_at = NULL,
           derivation_after_deadline_id = NULL, updated_at = ?
       WHERE principal_id = ? AND source_id = ? AND derivation_scan_at IS NOT NULL`,
    ).bind(observedAt, principalId, sourceId).run();
    if (result.meta.changes !== 1) throw new Error("school_observation_derivation_completion_failed");
  }

  async recordFailure(input: {
    readonly principalId: string;
    readonly sourceId: string;
    readonly failure: string;
    readonly now: Date;
    readonly resetScan?: boolean;
    readonly resetDerivation?: boolean;
  }): Promise<void> {
    const principalId = principal(input.principalId);
    const sourceId = identifier(input.sourceId, "school_observation_source_invalid");
    const failure = failureCode(input.failure);
    const observedAt = at(input.now);
    this.#claim();
    const result = await this.database.prepare(
      `UPDATE school_observation_sync
       SET last_failure = ?, last_failure_at = ?, updated_at = ?,
           checkpoint_course_id = CASE WHEN ? = 1 THEN NULL ELSE checkpoint_course_id END,
           checkpoint_page_token = CASE WHEN ? = 1 THEN NULL ELSE checkpoint_page_token END,
           scan_started_at = CASE WHEN ? = 1 THEN NULL ELSE scan_started_at END,
           derivation_scan_at = CASE WHEN ? = 1 THEN NULL ELSE derivation_scan_at END,
           derivation_started_at = CASE WHEN ? = 1 THEN NULL ELSE derivation_started_at END,
           derivation_after_deadline_id = CASE WHEN ? = 1 THEN NULL ELSE derivation_after_deadline_id END
       WHERE principal_id = ? AND source_id = ?`,
    ).bind(
      failure, observedAt, observedAt,
      input.resetScan === true ? 1 : 0,
      input.resetScan === true ? 1 : 0,
      input.resetScan === true ? 1 : 0,
      input.resetDerivation === true ? 1 : 0,
      input.resetDerivation === true ? 1 : 0,
      input.resetDerivation === true ? 1 : 0,
      principalId, sourceId,
    ).run();
    if (result.meta.changes !== 1) throw new Error("school_observation_failure_write_failed");
  }

  async ingest(input: {
    readonly principalId: string;
    readonly sourceId: string;
    readonly items: readonly RawSchoolSubmissionObservation[];
    readonly sourceRejectedCount?: number;
    readonly now: Date;
  }): Promise<ObservationIngestionReport> {
    const principalId = principal(input.principalId);
    const sourceId = identifier(input.sourceId, "school_observation_source_invalid");
    const observedAt = at(input.now);
    let rejected = input.sourceRejectedCount ?? 0;
    if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > 2_000) {
      throw new TypeError("school_observation_rejected_count_invalid");
    }
    const normalized: RawSchoolSubmissionObservation[] = [];
    const deadlineKeys = new Set<string>();
    const submissionKeys = new Set<string>();
    for (const item of input.items) {
      try {
        const value = normalize(item);
        if (deadlineKeys.has(value.deadlineExternalId) || submissionKeys.has(value.externalSubmissionId)) {
          rejected += 1;
          continue;
        }
        deadlineKeys.add(value.deadlineExternalId);
        submissionKeys.add(value.externalSubmissionId);
        normalized.push(value);
      } catch {
        rejected += 1;
      }
    }
    if (normalized.length === 0) return Object.freeze({ created: 0, revised: 0, unchanged: 0, rejected });

    this.#claim();
    const deadlineResult = await this.database.prepare(
      `SELECT deadline_id, external_id FROM deadlines
       WHERE source_id = ? AND external_id IN (${placeholders(normalized.length)})`,
    ).bind(sourceId, ...normalized.map((item) => item.deadlineExternalId)).all<DeadlineObservationRow>();
    const deadlineByExternal = new Map(rows(deadlineResult).map((row) => [
      identifier(row.external_id, "school_observation_deadline_row_invalid"),
      identifier(row.deadline_id, "school_observation_deadline_row_invalid"),
    ]));
    const matched = normalized.flatMap((item) => {
      const deadlineId = deadlineByExternal.get(item.deadlineExternalId);
      if (deadlineId === undefined) {
        rejected += 1;
        return [];
      }
      return [{ item, deadlineId }];
    });
    if (matched.length === 0) return Object.freeze({ created: 0, revised: 0, unchanged: 0, rejected });

    this.#claim();
    const currentResult = await this.database.prepare(
      `SELECT principal_id, observation_id, source_id, deadline_id, external_submission_id,
              submission_state, late, assigned_grade, max_points, source_updated_at, content_hash,
              first_seen_at, content_changed_at, last_seen_at
       FROM school_assignment_observations
       WHERE principal_id = ? AND deadline_id IN (${placeholders(matched.length)})`,
    ).bind(principalId, ...matched.map((entry) => entry.deadlineId)).all<ObservationRow>();
    const currentByDeadline = new Map(rows(currentResult).map((row) => {
      const checked = observationRow(row, principalId);
      return [checked.deadline_id, checked] as const;
    }));

    const hashes = await Promise.all(matched.map(({ item }) => contentHash(item)));
    const statements: D1PreparedStatement[] = [];
    const expectedChanges: number[] = [];
    let created = 0;
    let revised = 0;
    let unchanged = 0;
    for (let index = 0; index < matched.length; index += 1) {
      const entry = matched[index];
      const hash = hashes[index];
      if (entry === undefined || hash === undefined) throw new Error("school_observation_batch_invalid");
      const existing = currentByDeadline.get(entry.deadlineId);
      if (existing === undefined) {
        statements.push(this.database.prepare(
          `INSERT INTO school_assignment_observations (
             principal_id, observation_id, source_id, deadline_id, external_submission_id,
             submission_state, late, assigned_grade, max_points, source_updated_at, content_hash,
             first_seen_at, content_changed_at, last_seen_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          principalId, newUlid(), sourceId, entry.deadlineId, entry.item.externalSubmissionId,
          entry.item.state, entry.item.late === null ? null : entry.item.late ? 1 : 0,
          entry.item.assignedGrade, entry.item.maxPoints ?? null, entry.item.sourceUpdatedAt, hash,
          observedAt, observedAt, observedAt,
        ));
        expectedChanges.push(1);
        created += 1;
        continue;
      }
      if (existing.external_submission_id !== entry.item.externalSubmissionId) {
        rejected += 1;
        continue;
      }
      if (existing.content_hash === hash) {
        statements.push(this.database.prepare(
          `UPDATE school_assignment_observations
           SET last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END
           WHERE principal_id = ? AND observation_id = ? AND content_hash = ?`,
        ).bind(observedAt, observedAt, principalId, existing.observation_id, hash));
        expectedChanges.push(1);
        unchanged += 1;
        continue;
      }
      statements.push(this.database.prepare(
        `INSERT INTO school_assignment_observation_revisions (
           principal_id, revision_id, observation_id, submission_state, late, assigned_grade,
           max_points, source_updated_at, content_hash, content_changed_at, replaced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        principalId, newUlid(), existing.observation_id, existing.submission_state,
        existing.late, existing.assigned_grade, existing.max_points, existing.source_updated_at,
        existing.content_hash, existing.content_changed_at, observedAt,
      ));
      expectedChanges.push(1);
      statements.push(this.database.prepare(
        `UPDATE school_assignment_observations
         SET submission_state = ?, late = ?, assigned_grade = ?, max_points = ?, source_updated_at = ?,
             content_hash = ?, content_changed_at = ?, last_seen_at = ?
         WHERE principal_id = ? AND observation_id = ? AND content_hash = ?`,
      ).bind(
        entry.item.state, entry.item.late === null ? null : entry.item.late ? 1 : 0,
        entry.item.assignedGrade, entry.item.maxPoints ?? null, entry.item.sourceUpdatedAt,
        hash, observedAt, observedAt,
        principalId, existing.observation_id, existing.content_hash,
      ));
      expectedChanges.push(1);
      revised += 1;
    }

    if (statements.length > 0) {
      this.#claim(statements.length);
      const results = await this.#transactions.batch(statements);
      for (let index = 0; index < results.length; index += 1) {
        if ((results[index]?.meta.changes ?? 0) !== expectedChanges[index]) {
          throw new Error("school_observation_write_contended");
        }
      }
    }
    return Object.freeze({ created, revised, unchanged, rejected });
  }

  async deriveMissingWorkPage(input: {
    readonly principalId: string;
    readonly sourceId: string;
    readonly derivedAt: string;
    readonly observationsSeenSince: string;
    readonly afterDeadlineId: string | null;
    readonly limit?: number;
  }): Promise<MissingWorkDerivationReport> {
    const principalId = principal(input.principalId);
    const sourceId = identifier(input.sourceId, "school_observation_source_invalid");
    const derivedAt = instant(input.derivedAt, "school_observation_derivation_time_invalid");
    const observationsSeenSince = instant(
      input.observationsSeenSince,
      "school_observation_derivation_start_invalid",
    );
    const after = input.afterDeadlineId === null
      ? ""
      : identifier(input.afterDeadlineId, "school_observation_deadline_invalid");
    const limit = input.limit ?? MISSING_WORK_DERIVATION_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MISSING_WORK_DERIVATION_PAGE_SIZE) {
      throw new TypeError("school_observation_derivation_limit_invalid");
    }
    this.#claim();
    const result = await this.database.prepare(
      `SELECT d.deadline_id, d.due_at, d.status,
              o.observation_id, o.submission_state, o.last_seen_at,
              (
                SELECT t.to_state FROM school_missing_work_transitions AS t
                WHERE t.principal_id = ? AND t.deadline_id = d.deadline_id
                ORDER BY t.derived_at DESC, t.transition_id DESC LIMIT 1
              ) AS last_state,
              (
                SELECT t.basis_due_at FROM school_missing_work_transitions AS t
                WHERE t.principal_id = ? AND t.deadline_id = d.deadline_id
                ORDER BY t.derived_at DESC, t.transition_id DESC LIMIT 1
              ) AS last_basis_due_at,
              (
                SELECT t.basis_observation_id FROM school_missing_work_transitions AS t
                WHERE t.principal_id = ? AND t.deadline_id = d.deadline_id
                ORDER BY t.derived_at DESC, t.transition_id DESC LIMIT 1
              ) AS last_basis_observation_id,
              EXISTS (
                SELECT 1 FROM school_missing_work_transitions AS t
                WHERE t.principal_id = ? AND t.deadline_id = d.deadline_id
                  AND t.derived_at = ?
              ) AS already_derived
       FROM deadlines AS d
       JOIN deadline_sources AS s ON s.source_id = d.source_id AND s.kind = 'classroom'
       JOIN school_assignment_observations AS o
         ON o.principal_id = ? AND o.deadline_id = d.deadline_id AND o.last_seen_at >= ?
       WHERE d.source_id = ? AND d.deadline_id > ?
       ORDER BY d.deadline_id
       LIMIT ?`,
    ).bind(
      principalId, principalId, principalId, principalId, derivedAt,
      principalId, observationsSeenSince,
      sourceId, after, limit + 1,
    ).all<DerivationRow>();
    const found = rows(result);
    const page = found.slice(0, limit);
    const statements: D1PreparedStatement[] = [];
    for (const row of page) {
      const deadlineId = identifier(row.deadline_id, "school_observation_derivation_row_invalid");
      const dueAt = instant(row.due_at, "school_observation_derivation_row_invalid");
      const observationId = ulid(row.observation_id, "school_observation_derivation_row_invalid");
      const submissionState = state(row.submission_state);
      const lastSeenAt = instant(row.last_seen_at, "school_observation_derivation_row_invalid");
      // The inner join deliberately excludes deadlines without a fresh
      // observation. Absence can mean an archived course or rejected payload,
      // so it must not become a claim about the student's work.
      if (row.already_derived === 1) continue;
      if (row.already_derived !== 0) throw new TypeError("school_observation_derivation_row_invalid");
      const lastState = row.last_state === null ? null : row.last_state as DerivedMissingWorkState;
      if (lastState !== null && !DERIVED_STATES.includes(lastState)) {
        throw new TypeError("school_observation_derivation_row_invalid");
      }
      const desired: DerivedMissingWorkState | null = row.status !== "open"
        ? "closed"
        : SUBMITTED_STATES.has(submissionState)
          ? "submission_seen"
          : dueAt > derivedAt
            ? "not_due"
            : lastSeenAt >= dueAt
              ? "no_submission_seen"
              : null;
      // A pre-deadline read cannot establish what Classroom showed when the
      // deadline passed. Silence preserves that distinction until a later read.
      if (desired === null) continue;
      const basisObservationId = desired === "closed" ? null : observationId;
      if (
        lastState === desired
        && row.last_basis_due_at === dueAt
        && row.last_basis_observation_id === basisObservationId
      ) continue;
      statements.push(this.database.prepare(
        `INSERT INTO school_missing_work_transitions (
           principal_id, transition_id, deadline_id, classification, from_state, to_state,
           basis_due_at, basis_observation_id, derived_at
         ) VALUES (?, ?, ?, 'derived', ?, ?, ?, ?, ?)`,
      ).bind(
        principalId, newUlid(), deadlineId, lastState ?? "untracked", desired,
        dueAt, basisObservationId, derivedAt,
      ));
    }
    if (statements.length > 0) {
      this.#claim(statements.length);
      await this.#transactions.batch(statements);
    }
    const last = page.at(-1);
    return Object.freeze({
      transitions: statements.length,
      nextAfterDeadlineId: found.length > limit && last !== undefined
        ? identifier(last.deadline_id, "school_observation_derivation_row_invalid")
        : null,
    });
  }

  async readDigestSnapshot(input: {
    readonly principalId: string;
    readonly sourceId: string;
    readonly changedSince: Date;
    readonly now: Date;
  }): Promise<SchoolObservationDigestSnapshot> {
    const principalId = principal(input.principalId);
    const sourceId = identifier(input.sourceId, "school_observation_source_invalid");
    const changedSince = at(input.changedSince);
    const now = at(input.now);
    this.#claim(2);
    const [gradeResult, missingResult, source, d2lGradeRows] = await Promise.all([
      this.database.prepare(
        `SELECT o.observation_id, o.deadline_id, d.course, d.title, o.assigned_grade,
                o.max_points, o.source_updated_at,
                o.content_changed_at, o.last_seen_at
         FROM school_assignment_observations AS o
         JOIN deadlines AS d ON d.deadline_id = o.deadline_id AND d.source_id = o.source_id
         JOIN deadline_sources AS s ON s.source_id = o.source_id AND s.kind = 'classroom'
         WHERE o.principal_id = ? AND o.source_id = ?
           AND o.assigned_grade IS NOT NULL AND o.content_changed_at >= ?
         ORDER BY o.content_changed_at DESC, o.observation_id
         LIMIT 20`,
      ).bind(principalId, sourceId, changedSince).all<GradeRow>(),
      this.database.prepare(
        `SELECT t.transition_id, t.deadline_id, d.course, d.title, d.due_at,
                t.classification, t.to_state, basis.last_seen_at, COUNT(*) OVER () AS total_count
         FROM school_missing_work_transitions AS t
         JOIN deadlines AS d ON d.deadline_id = t.deadline_id
         JOIN deadline_sources AS s ON s.source_id = d.source_id AND s.kind = 'classroom'
         JOIN school_observation_sync AS sync
           ON sync.principal_id = t.principal_id AND sync.source_id = d.source_id
         JOIN school_assignment_observations AS basis
           ON basis.principal_id = t.principal_id
          AND basis.observation_id = t.basis_observation_id
          AND basis.deadline_id = t.deadline_id
          AND basis.source_id = d.source_id
         WHERE t.principal_id = ? AND d.source_id = ?
           AND t.to_state = 'no_submission_seen'
           AND d.status = 'open' AND d.due_at <= ?
           AND sync.last_success_at IS NOT NULL
           AND sync.last_success_started_at IS NOT NULL
           AND basis.last_seen_at >= sync.last_success_started_at
           AND basis.last_seen_at >= d.due_at
           AND basis.submission_state IN ('new', 'created', 'reclaimed_by_student')
           AND NOT EXISTS (
             SELECT 1 FROM school_missing_work_transitions AS later
             WHERE later.principal_id = t.principal_id AND later.deadline_id = t.deadline_id
               AND (
                 later.derived_at > t.derived_at
                 OR (later.derived_at = t.derived_at AND later.transition_id > t.transition_id)
               )
           )
         ORDER BY d.due_at DESC, d.deadline_id
         LIMIT 20`,
      ).bind(principalId, sourceId, now).all<MissingRow>(),
      this.readSync(principalId, sourceId),
      this.#readD2lDigestGrades(principalId, changedSince),
    ]);
    const classroomGrades = rows(gradeResult).map((row): SchoolGradeObservation => {
      if (typeof row.assigned_grade !== "number") throw new TypeError("school_grade_row_invalid");
      return Object.freeze({
        observationId: ulid(row.observation_id, "school_grade_row_invalid"),
        deadlineId: identifier(row.deadline_id, "school_grade_row_invalid"),
        course: text(row.course, "school_grade_row_invalid", 2_048),
        title: text(row.title, "school_grade_row_invalid", 2_048),
        assignedGrade: grade(row.assigned_grade) as number,
        maxPoints: scale(row.max_points),
        source: "google_classroom_api" as const,
        gradeUpdatedAt: optionalInstant(row.source_updated_at, "school_grade_row_invalid"),
        contentChangedAt: instant(row.content_changed_at, "school_grade_row_invalid"),
        lastSeenAt: instant(row.last_seen_at, "school_grade_row_invalid"),
      });
    });
    const d2lGrades = d2lGradeRows.map((row): SchoolGradeObservation => {
      if (typeof row.assigned_grade !== "number") throw new TypeError("school_grade_row_invalid");
      return Object.freeze({
        observationId: ulid(row.observation_id, "school_grade_row_invalid"),
        deadlineId: row.deadline_id === null
          ? null
          : identifier(row.deadline_id, "school_grade_row_invalid"),
        course: text(row.course, "school_grade_row_invalid", 2_048),
        title: text(row.title, "school_grade_row_invalid", 2_048),
        assignedGrade: grade(row.assigned_grade) as number,
        maxPoints: scale(row.max_points),
        source: "d2l_notification_email" as const,
        gradeUpdatedAt: null,
        contentChangedAt: instant(row.observed_at, "school_grade_row_invalid"),
        lastSeenAt: instant(row.observed_at, "school_grade_row_invalid"),
      });
    });
    const grades = [...classroomGrades, ...d2lGrades]
      .sort((left, right) => right.contentChangedAt.localeCompare(left.contentChangedAt)
        || left.observationId.localeCompare(right.observationId))
      .slice(0, 20);
    const missingRows = rows(missingResult);
    const missingWork = missingRows.map((row): SchoolDerivedMissingWork => {
      if (row.classification !== "derived" || row.to_state !== "no_submission_seen") {
        throw new TypeError("school_missing_work_row_invalid");
      }
      return Object.freeze({
        transitionId: ulid(row.transition_id, "school_missing_work_row_invalid"),
        deadlineId: identifier(row.deadline_id, "school_missing_work_row_invalid"),
        course: text(row.course, "school_missing_work_row_invalid", 2_048),
        title: text(row.title, "school_missing_work_row_invalid", 2_048),
        dueAt: instant(row.due_at, "school_missing_work_row_invalid"),
        classification: "derived" as const,
        state: "no_submission_seen" as const,
        lastSeenAt: instant(row.last_seen_at, "school_missing_work_row_invalid"),
      });
    });
    const totalMissingWork = missingRows[0]?.total_count ?? 0;
    if (!Number.isSafeInteger(totalMissingWork) || totalMissingWork < missingWork.length) {
      throw new TypeError("school_missing_work_row_invalid");
    }
    return Object.freeze({
      source,
      grades: Object.freeze(grades),
      missingWork: Object.freeze(missingWork),
      missingWorkOmitted: totalMissingWork - missingWork.length,
    });
  }

  /**
   * Reads only the current, bounded records the study coach may derive from.
   * Assignment titles remain citations in this boundary and never become a
   * topic downstream.
   */
  async readStudySnapshot(input: {
    readonly principalId: string;
    readonly now: Date;
  }): Promise<SchoolObservationStudySnapshot> {
    const principalId = principal(input.principalId);
    const now = at(input.now);
    this.#claim(2);
    const [gradeResult, missingResult] = await Promise.all([
      this.database.prepare(`SELECT o.observation_id, o.deadline_id, d.course, d.title,
          o.assigned_grade, o.max_points, o.source_updated_at,
          o.content_changed_at, o.last_seen_at,
          sync.last_success_at AS source_last_success_at,
          sync.last_failure AS source_last_failure
        FROM school_assignment_observations o
        JOIN deadlines d ON d.deadline_id = o.deadline_id AND d.source_id = o.source_id
        JOIN deadline_sources s ON s.source_id = o.source_id AND s.kind = 'classroom'
        JOIN school_observation_sync sync
          ON sync.principal_id = o.principal_id AND sync.source_id = o.source_id
        WHERE o.principal_id = ?1 AND o.assigned_grade IS NOT NULL
        ORDER BY o.content_changed_at DESC, o.observation_id
        LIMIT ${SCHOOL_STUDY_OBSERVATION_ROW_LIMIT}`)
        .bind(principalId).all<StudyGradeRow>(),
      this.database.prepare(`SELECT t.transition_id, t.deadline_id, d.course, d.title,
          d.due_at, t.classification, t.to_state, basis.last_seen_at,
          1 AS total_count, sync.last_success_at AS source_last_success_at,
          sync.last_failure AS source_last_failure
        FROM school_missing_work_transitions t
        JOIN deadlines d ON d.deadline_id = t.deadline_id
        JOIN deadline_sources s ON s.source_id = d.source_id AND s.kind = 'classroom'
        JOIN school_observation_sync sync
          ON sync.principal_id = t.principal_id AND sync.source_id = d.source_id
        JOIN school_assignment_observations basis
          ON basis.principal_id = t.principal_id
          AND basis.observation_id = t.basis_observation_id
          AND basis.deadline_id = t.deadline_id
          AND basis.source_id = d.source_id
        WHERE t.principal_id = ?1 AND t.to_state = 'no_submission_seen'
          AND d.status = 'open' AND d.due_at <= ?2
          AND sync.last_success_at IS NOT NULL
          AND sync.last_success_started_at IS NOT NULL
          AND basis.last_seen_at >= sync.last_success_started_at
          AND basis.last_seen_at >= d.due_at
          AND basis.submission_state IN ('new', 'created', 'reclaimed_by_student')
          AND NOT EXISTS (
            SELECT 1 FROM school_missing_work_transitions later
            WHERE later.principal_id = t.principal_id AND later.deadline_id = t.deadline_id
              AND (later.derived_at > t.derived_at
                OR (later.derived_at = t.derived_at AND later.transition_id > t.transition_id))
          )
        ORDER BY d.due_at DESC, d.deadline_id
        LIMIT ${SCHOOL_STUDY_OBSERVATION_ROW_LIMIT}`)
        .bind(principalId, now).all<StudyMissingRow>(),
    ]);
    const sourceHealth = (row: StudyGradeRow | StudyMissingRow): {
      readonly sourceLastSuccessAt: string | null;
      readonly sourceLastFailure: string | null;
    } => Object.freeze({
      sourceLastSuccessAt: optionalInstant(row.source_last_success_at, "school_study_source_invalid"),
      sourceLastFailure: row.source_last_failure === null
        ? null
        : text(row.source_last_failure, "school_study_source_invalid", 160),
    });
    const grades = rows(gradeResult).map((row): SchoolStudyGradeObservation => {
      if (typeof row.assigned_grade !== "number") throw new TypeError("school_study_grade_invalid");
      return Object.freeze({
        observationId: ulid(row.observation_id, "school_study_grade_invalid"),
        deadlineId: identifier(row.deadline_id, "school_study_grade_invalid"),
        course: text(row.course, "school_study_grade_invalid", 2_048),
        title: text(row.title, "school_study_grade_invalid", 2_048),
        assignedGrade: grade(row.assigned_grade) as number,
        maxPoints: scale(row.max_points),
        source: "google_classroom_api" as const,
        gradeUpdatedAt: optionalInstant(row.source_updated_at, "school_study_grade_invalid"),
        contentChangedAt: instant(row.content_changed_at, "school_study_grade_invalid"),
        lastSeenAt: instant(row.last_seen_at, "school_study_grade_invalid"),
        ...sourceHealth(row),
      });
    });
    const missingWork = rows(missingResult).map((row): SchoolStudyMissingWork => {
      if (row.classification !== "derived" || row.to_state !== "no_submission_seen") {
        throw new TypeError("school_study_missing_work_invalid");
      }
      return Object.freeze({
        transitionId: ulid(row.transition_id, "school_study_missing_work_invalid"),
        deadlineId: identifier(row.deadline_id, "school_study_missing_work_invalid"),
        course: text(row.course, "school_study_missing_work_invalid", 2_048),
        title: text(row.title, "school_study_missing_work_invalid", 2_048),
        dueAt: instant(row.due_at, "school_study_missing_work_invalid"),
        classification: "derived" as const,
        state: "no_submission_seen" as const,
        lastSeenAt: instant(row.last_seen_at, "school_study_missing_work_invalid"),
        ...sourceHealth(row),
      });
    });
    return Object.freeze({ grades: Object.freeze(grades), missingWork: Object.freeze(missingWork) });
  }

  private async requireSync(principalId: string, sourceId: string): Promise<SchoolObservationSyncState> {
    const value = await this.readSync(principalId, sourceId);
    if (value === null) throw new Error("school_observation_sync_write_failed");
    return value;
  }


  async #readD2lDigestGrades(principalId: string, changedSince: string): Promise<readonly D2lGradeRow[]> {
    this.#claim();
    try {
      const result = await this.database.prepare(`SELECT g.observation_id, g.deadline_id, g.course,
          g.title, g.assigned_grade, g.max_points, g.observed_at
        FROM d2l_email_grade_observations g
        WHERE g.principal_id = ?1 AND g.observed_at >= ?2
          AND NOT EXISTS (
            SELECT 1 FROM d2l_email_grade_observations later
            WHERE later.principal_id = g.principal_id AND later.external_id = g.external_id
              AND (later.observed_at > g.observed_at
                OR (later.observed_at = g.observed_at AND later.observation_id > g.observation_id))
          )
        ORDER BY g.observed_at DESC, g.observation_id
        LIMIT 20`).bind(principalId, changedSince).all<D2lGradeRow>();
      return rows(result);
    } catch (error) {
      if (/no such table:\s*d2l_email_grade_observations/iu.test(
        error instanceof Error ? error.message : String(error),
      )) return Object.freeze([]);
      throw error;
    }
  }
}

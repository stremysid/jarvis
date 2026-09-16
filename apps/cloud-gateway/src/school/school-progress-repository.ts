import { canonicalJson, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { requireInstant } from "../deadlines/deadline-types.js";
import type {
  IngestSchoolProgressInput,
  RawSchoolProgressItem,
  SchoolGradeDigestItem,
  SchoolMissingWorkDigestItem,
  SchoolProgressDigestSnapshot,
  SchoolProgressSourceState,
  SchoolSubmissionState,
} from "./school-progress-types.js";
import { SCHOOL_PROGRESS_ITEMS_PER_SWEEP } from "./school-progress-types.js";

export { SCHOOL_PROGRESS_ITEMS_PER_SWEEP } from "./school-progress-types.js";

/**
 * Two source-state statements, five statements per item at the maximum shape,
 * and one source-health update. Keeping the arithmetic executable lets the
 * test prove the declared D1 ceiling rather than merely repeating a number.
 */
export function schoolProgressSweepStatementBudget(itemCount: number): number {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > SCHOOL_PROGRESS_ITEMS_PER_SWEEP) {
    throw new RangeError("school_progress_item_limit_exceeded");
  }
  return 2 + itemCount * 5 + 1;
}

export const SCHOOL_PROGRESS_SWEEP_D1_STATEMENT_BUDGET =
  schoolProgressSweepStatementBudget(SCHOOL_PROGRESS_ITEMS_PER_SWEEP);

const SOURCE_ID = "google-classroom" as const;
const SOURCE_ROUTE = "classroom_api" as const;
const SOURCE_LABEL = "Google Classroom API" as const;
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const SUBMISSION_STATES = new Set<SchoolSubmissionState>([
  "new", "created", "turned_in", "returned", "reclaimed", "edited_after_turn_in",
]);
const encoder = new TextEncoder();

interface SourceStateRow {
  readonly principal_id: unknown;
  readonly source_id: unknown;
  readonly route: unknown;
  readonly checkpoint_course_id: unknown;
  readonly checkpoint_work_item_external_id: unknown;
  readonly last_success_at: unknown;
  readonly last_failure: unknown;
  readonly last_failure_at: unknown;
}

interface GradeRow {
  readonly work_item_id: unknown;
  readonly course_name: unknown;
  readonly title: unknown;
  readonly assigned_points: unknown;
  readonly maximum_points: unknown;
  readonly observed_at: unknown;
  readonly source_updated_at: unknown;
  readonly route: unknown;
}

interface MissingRow {
  readonly work_item_id: unknown;
  readonly course_name: unknown;
  readonly title: unknown;
  readonly due_at: unknown;
  readonly basis_checked_at: unknown;
  readonly derived_at: unknown;
  readonly route: unknown;
}

interface NormalizedItem {
  readonly externalId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly maximumPoints: number | null;
  readonly submission: null | {
    readonly externalId: string;
    readonly state: SchoolSubmissionState;
    readonly late: boolean | null;
    readonly sourceUpdatedAt: string | null;
  };
  readonly assignedPoints: number | null;
}

function rows<T>(result: D1Result<T>, label: string): readonly T[] {
  if (!Array.isArray(result.results)) throw new TypeError(label);
  return result.results;
}

function inline(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new TypeError(label);
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0
    || !normalized.isWellFormed()
    || normalized !== value.trim()
    || UNSAFE_INLINE.test(normalized)
    || encoder.encode(normalized).byteLength > maximumBytes
  ) {
    throw new TypeError(label);
  }
  return normalized;
}

function principal(value: unknown): string {
  return inline(value, "school_progress_principal_invalid", 256);
}

function identifier(value: unknown, label: string): string {
  return inline(value, label, 256);
}

function instantOrNull(value: unknown, label: string): string | null {
  return value === null ? null : requireInstant(value, label);
}

function finitePoints(value: unknown, label: string, maximumRequired: boolean): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new TypeError(label);
  }
  if (maximumRequired && value === 0) throw new TypeError(label);
  return value;
}

function normalizeItem(value: RawSchoolProgressItem): NormalizedItem {
  const dueAt = instantOrNull(value.dueAt, "school_progress_due_at_invalid");
  const maximumPoints = finitePoints(value.maximumPoints, "school_progress_maximum_points_invalid", true);
  const assignedPoints = finitePoints(value.assignedPoints, "school_progress_assigned_points_invalid", false);
  let submission: NormalizedItem["submission"] = null;
  if (value.submission !== null) {
    if (!SUBMISSION_STATES.has(value.submission.state)) {
      throw new TypeError("school_progress_submission_state_invalid");
    }
    if (value.submission.late !== null && typeof value.submission.late !== "boolean") {
      throw new TypeError("school_progress_submission_late_invalid");
    }
    submission = Object.freeze({
      externalId: identifier(value.submission.externalId, "school_progress_submission_id_invalid"),
      state: value.submission.state,
      late: value.submission.late,
      sourceUpdatedAt: instantOrNull(
        value.submission.sourceUpdatedAt,
        "school_progress_source_updated_at_invalid",
      ),
    });
  }
  if (assignedPoints !== null && submission === null) {
    throw new TypeError("school_progress_grade_without_submission");
  }
  return Object.freeze({
    externalId: identifier(value.externalId, "school_progress_external_id_invalid"),
    course: inline(value.course, "school_progress_course_invalid", 512),
    title: inline(value.title, "school_progress_title_invalid", 512),
    dueAt,
    maximumPoints,
    submission,
    assignedPoints,
  });
}

function sourceState(row: SourceStateRow, expectedPrincipal: string): SchoolProgressSourceState {
  if (
    row.principal_id !== expectedPrincipal
    || row.source_id !== SOURCE_ID
    || row.route !== SOURCE_ROUTE
    || row.checkpoint_course_id !== null && typeof row.checkpoint_course_id !== "string"
    || row.checkpoint_work_item_external_id !== null && typeof row.checkpoint_work_item_external_id !== "string"
    || row.last_success_at !== null && typeof row.last_success_at !== "string"
    || row.last_failure !== null && typeof row.last_failure !== "string"
    || row.last_failure_at !== null && typeof row.last_failure_at !== "string"
  ) {
    throw new TypeError("school_progress_source_row_invalid");
  }
  const failure = row.last_failure === null
    ? null
    : inline(row.last_failure, "school_progress_source_row_invalid", 512);
  const failureAt = instantOrNull(row.last_failure_at, "school_progress_source_row_invalid");
  if ((failure === null) !== (failureAt === null)) throw new TypeError("school_progress_source_row_invalid");
  if (row.checkpoint_work_item_external_id !== null && row.checkpoint_course_id === null) {
    throw new TypeError("school_progress_source_row_invalid");
  }
  return Object.freeze({
    principalId: expectedPrincipal,
    sourceId: SOURCE_ID,
    route: SOURCE_ROUTE,
    checkpointCourseId: row.checkpoint_course_id === null
      ? null
      : identifier(row.checkpoint_course_id, "school_progress_source_row_invalid"),
    checkpointWorkItemExternalId: row.checkpoint_work_item_external_id === null
      ? null
      : identifier(row.checkpoint_work_item_external_id, "school_progress_source_row_invalid"),
    lastSuccessAt: instantOrNull(row.last_success_at, "school_progress_source_row_invalid"),
    lastFailure: failure,
    lastFailureAt: failureAt,
  });
}

function gradeRow(row: GradeRow): SchoolGradeDigestItem {
  if (row.route !== SOURCE_ROUTE || typeof row.work_item_id !== "string" || !ULID.test(row.work_item_id)) {
    throw new TypeError("school_progress_grade_row_invalid");
  }
  const assignedPoints = finitePoints(row.assigned_points, "school_progress_grade_row_invalid", false);
  if (assignedPoints === null) throw new TypeError("school_progress_grade_row_invalid");
  return Object.freeze({
    workItemId: row.work_item_id,
    course: inline(row.course_name, "school_progress_grade_row_invalid", 512),
    title: inline(row.title, "school_progress_grade_row_invalid", 512),
    assignedPoints,
    maximumPoints: finitePoints(row.maximum_points, "school_progress_grade_row_invalid", true),
    source: SOURCE_LABEL,
    observedAt: requireInstant(row.observed_at, "school_progress_grade_row_invalid"),
    sourceUpdatedAt: instantOrNull(row.source_updated_at, "school_progress_grade_row_invalid"),
  });
}

function missingRow(row: MissingRow): SchoolMissingWorkDigestItem {
  if (row.route !== SOURCE_ROUTE || typeof row.work_item_id !== "string" || !ULID.test(row.work_item_id)) {
    throw new TypeError("school_progress_missing_row_invalid");
  }
  return Object.freeze({
    workItemId: row.work_item_id,
    course: inline(row.course_name, "school_progress_missing_row_invalid", 512),
    title: inline(row.title, "school_progress_missing_row_invalid", 512),
    dueAt: requireInstant(row.due_at, "school_progress_missing_row_invalid"),
    source: SOURCE_LABEL,
    checkedAt: requireInstant(row.basis_checked_at, "school_progress_missing_row_invalid"),
    derivedAt: requireInstant(row.derived_at, "school_progress_missing_row_invalid"),
    label: "derived_no_submission_seen",
  });
}

function boundedFailure(value: unknown): string {
  const raw = typeof value === "string" ? value.normalize("NFC").trim() : "school_progress_sync_failed";
  const safe = raw.replace(/[\p{C}\r\n]/gu, " ").replace(/\s+/gu, " ").trim();
  const fallback = safe.length === 0 ? "school_progress_sync_failed" : safe;
  const sliced = fallback.slice(0, 512);
  return sliced.isWellFormed() ? sliced : sliced.slice(0, -1);
}

export class SchoolProgressRepository {
  constructor(private readonly database: D1Database) {}

  async readSourceState(principalIdValue: string, nowValue: Date): Promise<SchoolProgressSourceState> {
    const principalId = principal(principalIdValue);
    const now = requireInstant(new Date(nowValue.getTime()).toISOString(), "school_progress_observed_at_invalid");
    await this.database.prepare(`INSERT INTO school_progress_source_state (
        principal_id, source_id, route, checkpoint_course_id, checkpoint_work_item_external_id, last_success_at,
        last_failure, last_failure_at, created_at, updated_at
      )
      SELECT ?1, ?2, 'classroom_api', NULL, NULL, NULL, NULL, NULL, ?3, ?3
      WHERE EXISTS (
        SELECT 1 FROM deadline_sources WHERE source_id = ?2 AND kind = 'classroom'
      ) AND NOT EXISTS (
        SELECT 1 FROM school_progress_source_state WHERE principal_id = ?1 AND source_id = ?2
      )`).bind(principalId, SOURCE_ID, now).run();
    const row = await this.database.prepare(`SELECT principal_id, source_id, route, checkpoint_course_id,
        checkpoint_work_item_external_id,
        last_success_at, last_failure, last_failure_at
      FROM school_progress_source_state
      WHERE principal_id = ?1 AND source_id = ?2`).bind(principalId, SOURCE_ID).first<SourceStateRow>();
    if (row === null) throw new Error("school_progress_source_unavailable");
    return sourceState(row, principalId);
  }

  async recordFailure(principalIdValue: string, reason: unknown, nowValue: Date): Promise<void> {
    const principalId = principal(principalIdValue);
    await this.readSourceState(principalId, nowValue);
    const now = requireInstant(new Date(nowValue.getTime()).toISOString(), "school_progress_observed_at_invalid");
    await this.database.prepare(`UPDATE school_progress_source_state
      SET last_failure = ?1, last_failure_at = ?2, updated_at = ?2
      WHERE principal_id = ?3 AND source_id = ?4
        AND (last_success_at IS NULL OR last_success_at <= ?2)
        AND (last_failure_at IS NULL OR last_failure_at <= ?2)`)
      .bind(boundedFailure(reason), now, principalId, SOURCE_ID).run();
  }

  async ingestClassroomCourse(input: IngestSchoolProgressInput): Promise<void> {
    const principalId = principal(input.principalId);
    if (input.sourceId !== SOURCE_ID) throw new TypeError("school_progress_source_invalid");
    if (input.healthGap !== null && ![
      "classroom_progress_items_truncated",
      "classroom_progress_items_rejected",
      "classroom_progress_items_rejected_and_truncated",
    ].includes(input.healthGap)) {
      throw new TypeError("school_progress_health_gap_invalid");
    }
    const checkpoint = input.checkpointCourseId === null
      ? null
      : identifier(input.checkpointCourseId, "school_progress_checkpoint_invalid");
    const workCheckpoint = input.checkpointWorkItemExternalId === null
      ? null
      : identifier(input.checkpointWorkItemExternalId, "school_progress_checkpoint_invalid");
    if (workCheckpoint !== null && checkpoint === null) {
      throw new TypeError("school_progress_checkpoint_invalid");
    }
    if (input.items.length > SCHOOL_PROGRESS_ITEMS_PER_SWEEP) {
      throw new RangeError("school_progress_item_limit_exceeded");
    }
    const normalized = input.items.map(normalizeItem);
    const externalIds = new Set<string>();
    for (const item of normalized) {
      if (externalIds.has(item.externalId)) throw new TypeError("school_progress_external_id_duplicate");
      externalIds.add(item.externalId);
    }
    const now = requireInstant(new Date(input.now.getTime()).toISOString(), "school_progress_observed_at_invalid");
    await this.readSourceState(principalId, input.now);

    const statements: D1PreparedStatement[] = [];
    for (const item of normalized) {
      const workItemId = newUlid(input.now);
      const workHash = await sha256Hex(canonicalJson({
        course: item.course,
        dueAt: item.dueAt,
        externalId: item.externalId,
        maximumPoints: item.maximumPoints,
        title: item.title,
      }));
      statements.push(this.database.prepare(`UPDATE school_progress_work_items
        SET course_name = ?1, title = ?2, due_at = ?3, maximum_points = ?4,
            content_hash = ?5, last_seen_at = ?6
        WHERE principal_id = ?7 AND source_id = ?8 AND external_id = ?9
          AND last_seen_at <= ?6`).bind(
        item.course, item.title, item.dueAt, item.maximumPoints, workHash, now,
        principalId, SOURCE_ID, item.externalId,
      ));
      statements.push(this.database.prepare(`INSERT INTO school_progress_work_items (
          principal_id, work_item_id, source_id, external_id, course_name, title,
          due_at, maximum_points, content_hash, first_seen_at, last_seen_at
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
        WHERE NOT EXISTS (
          SELECT 1 FROM school_progress_work_items
          WHERE principal_id = ?1 AND source_id = ?3 AND external_id = ?4
        )`).bind(
        principalId, workItemId, SOURCE_ID, item.externalId, item.course, item.title,
        item.dueAt, item.maximumPoints, workHash, now,
      ));

      if (item.submission !== null) {
        const observationId = newUlid(input.now);
        const submissionHash = await sha256Hex(canonicalJson({
          externalId: item.submission.externalId,
          late: item.submission.late,
          sourceUpdatedAt: item.submission.sourceUpdatedAt,
          state: item.submission.state,
        }));
        statements.push(this.database.prepare(`INSERT INTO school_submission_observations (
            principal_id, observation_id, work_item_id, external_submission_id,
            submission_state, late, source_updated_at, observed_at, content_hash
          )
          SELECT ?1, ?2, item.work_item_id, ?3, ?4, ?5, ?6, ?7, ?8
          FROM school_progress_work_items item
          WHERE item.principal_id = ?1 AND item.source_id = ?9 AND item.external_id = ?10
            AND NOT EXISTS (
              SELECT 1 FROM school_submission_observations existing
              WHERE existing.principal_id = ?1
                AND existing.work_item_id = item.work_item_id
                AND existing.content_hash = ?8
            )`).bind(
          principalId, observationId, item.submission.externalId, item.submission.state,
          item.submission.late === null ? null : item.submission.late ? 1 : 0,
          item.submission.sourceUpdatedAt, now, submissionHash, SOURCE_ID, item.externalId,
        ));
      }

      if (item.assignedPoints !== null) {
        const gradeObservationId = newUlid(input.now);
        const gradeHash = await sha256Hex(canonicalJson({
          assignedPoints: item.assignedPoints,
          maximumPoints: item.maximumPoints,
          sourceUpdatedAt: item.submission?.sourceUpdatedAt ?? null,
        }));
        statements.push(this.database.prepare(`INSERT INTO school_grade_observations (
            principal_id, grade_observation_id, work_item_id, assigned_points,
            maximum_points, source_updated_at, observed_at, content_hash
          )
          SELECT ?1, ?2, item.work_item_id, ?3, ?4, ?5, ?6, ?7
          FROM school_progress_work_items item
          WHERE item.principal_id = ?1 AND item.source_id = ?8 AND item.external_id = ?9
            AND NOT EXISTS (
              SELECT 1 FROM school_grade_observations existing
              WHERE existing.principal_id = ?1
                AND existing.work_item_id = item.work_item_id
                AND existing.content_hash = ?7
            )`).bind(
          principalId, gradeObservationId, item.assignedPoints, item.maximumPoints,
          item.submission?.sourceUpdatedAt ?? null, now, gradeHash, SOURCE_ID, item.externalId,
        ));
      }

      if (item.dueAt !== null) {
        const transitionId = newUlid(input.now);
        statements.push(this.database.prepare(`INSERT INTO school_missing_work_transitions (
            principal_id, transition_id, work_item_id, derived_state, basis_due_at,
            basis_checked_at, basis_submission_observation_id, derived_at
          )
          SELECT ?1, ?2, item.work_item_id,
            CASE
              WHEN item.due_at > ?3 THEN 'not_past_due'
              WHEN COALESCE((
                SELECT observation.submission_state
                FROM school_submission_observations observation
                WHERE observation.principal_id = item.principal_id
                  AND observation.work_item_id = item.work_item_id
                  AND observation.observed_at <= item.last_seen_at
                ORDER BY observation.observed_at DESC, observation.observation_id DESC
                LIMIT 1
              ), '') IN ('turned_in', 'returned') THEN 'submission_seen'
              ELSE 'no_submission_seen'
            END,
            item.due_at, item.last_seen_at,
            CASE WHEN COALESCE((
              SELECT observation.submission_state
              FROM school_submission_observations observation
              WHERE observation.principal_id = item.principal_id
                AND observation.work_item_id = item.work_item_id
                AND observation.observed_at <= item.last_seen_at
              ORDER BY observation.observed_at DESC, observation.observation_id DESC
              LIMIT 1
            ), '') IN ('turned_in', 'returned') AND item.due_at <= ?3 THEN (
              SELECT observation.observation_id
              FROM school_submission_observations observation
              WHERE observation.principal_id = item.principal_id
                AND observation.work_item_id = item.work_item_id
                AND observation.submission_state IN ('turned_in', 'returned')
                AND observation.observed_at <= item.last_seen_at
              ORDER BY observation.observed_at DESC, observation.observation_id DESC
              LIMIT 1
            ) ELSE NULL END,
            ?3
          FROM school_progress_work_items item
          WHERE item.principal_id = ?1 AND item.source_id = ?4 AND item.external_id = ?5
            AND item.due_at IS NOT NULL AND item.last_seen_at = ?3
            AND COALESCE((
              SELECT transition.derived_state
              FROM school_missing_work_transitions transition
              WHERE transition.principal_id = item.principal_id
                AND transition.work_item_id = item.work_item_id
              ORDER BY transition.derived_at DESC, transition.transition_id DESC
              LIMIT 1
            ), '') != CASE
              WHEN item.due_at > ?3 THEN 'not_past_due'
              WHEN COALESCE((
                SELECT observation.submission_state
                FROM school_submission_observations observation
                WHERE observation.principal_id = item.principal_id
                  AND observation.work_item_id = item.work_item_id
                  AND observation.observed_at <= item.last_seen_at
                ORDER BY observation.observed_at DESC, observation.observation_id DESC
                LIMIT 1
              ), '') IN ('turned_in', 'returned') THEN 'submission_seen'
              ELSE 'no_submission_seen'
            END`).bind(
          principalId, transitionId, now, SOURCE_ID, item.externalId,
        ));
      }
    }

    const healthGap = input.healthGap;
    statements.push(this.database.prepare(`UPDATE school_progress_source_state
      SET checkpoint_course_id = ?1, checkpoint_work_item_external_id = ?2, last_success_at = ?3,
          last_failure = ?4, last_failure_at = ?5, updated_at = ?3
      WHERE principal_id = ?6 AND source_id = ?7
        AND (last_success_at IS NULL OR last_success_at <= ?3)
        AND (last_failure_at IS NULL OR last_failure_at <= ?3)`)
      .bind(checkpoint, workCheckpoint, now, healthGap, healthGap === null ? null : now, principalId, SOURCE_ID));

    if (statements.length > schoolProgressSweepStatementBudget(normalized.length) - 2) {
      throw new Error("school_progress_statement_budget_exceeded");
    }
    await this.database.batch(statements);
  }

  async readDigest(principalIdValue: string): Promise<SchoolProgressDigestSnapshot> {
    const principalId = principal(principalIdValue);
    const [source, gradesResult, missingResult] = await Promise.all([
      this.database.prepare(`SELECT principal_id, source_id, route, checkpoint_course_id,
          checkpoint_work_item_external_id,
          last_success_at, last_failure, last_failure_at
        FROM school_progress_source_state
        WHERE principal_id = ?1 AND source_id = ?2`).bind(principalId, SOURCE_ID).first<SourceStateRow>(),
      this.database.prepare(`SELECT item.work_item_id, item.course_name, item.title,
          grade.assigned_points, grade.maximum_points, grade.observed_at,
          grade.source_updated_at, source.route
        FROM school_grade_observations grade
        JOIN school_progress_work_items item
          ON item.principal_id = grade.principal_id AND item.work_item_id = grade.work_item_id
        JOIN school_progress_source_state source
          ON source.principal_id = item.principal_id AND source.source_id = item.source_id
        WHERE grade.principal_id = ?1 AND NOT EXISTS (
          SELECT 1 FROM school_grade_observations newer
          WHERE newer.principal_id = grade.principal_id
            AND newer.work_item_id = grade.work_item_id
            AND (newer.observed_at > grade.observed_at
              OR (newer.observed_at = grade.observed_at
                AND newer.grade_observation_id > grade.grade_observation_id))
        )
        ORDER BY grade.observed_at DESC, grade.grade_observation_id DESC
        LIMIT 8`).bind(principalId).all<GradeRow>(),
      this.database.prepare(`SELECT item.work_item_id, item.course_name, item.title,
          item.due_at, transition.basis_checked_at, transition.derived_at, source.route
        FROM school_missing_work_transitions transition
        JOIN school_progress_work_items item
          ON item.principal_id = transition.principal_id
          AND item.work_item_id = transition.work_item_id
        JOIN school_progress_source_state source
          ON source.principal_id = item.principal_id AND source.source_id = item.source_id
        WHERE transition.principal_id = ?1
          AND transition.derived_state = 'no_submission_seen'
          AND NOT EXISTS (
            SELECT 1 FROM school_missing_work_transitions newer
            WHERE newer.principal_id = transition.principal_id
              AND newer.work_item_id = transition.work_item_id
              AND (newer.derived_at > transition.derived_at
                OR (newer.derived_at = transition.derived_at
                  AND newer.transition_id > transition.transition_id))
          )
        ORDER BY item.due_at, item.work_item_id
        LIMIT 8`).bind(principalId).all<MissingRow>(),
    ]);
    return Object.freeze({
      grades: Object.freeze(rows(gradesResult, "school_progress_grade_rows_invalid").map(gradeRow)),
      missingWork: Object.freeze(rows(missingResult, "school_progress_missing_rows_invalid").map(missingRow)),
      sourceState: source === null ? null : sourceState(source, principalId),
    });
  }
}

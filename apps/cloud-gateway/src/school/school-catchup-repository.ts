import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import type {
  ApplyOwnerCatchupPlanInput,
  SchoolCatchupAction,
  SchoolCatchupSnapshot,
  SchoolCourseCard,
  SchoolCourseFact,
  SchoolCourseFactKind,
  SchoolEvidenceSource,
} from "./school-catchup-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RESPONSE_LOCAL_COURSE = /^new-[1-9][0-9]{0,2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const MAX_COURSES = 12;
const MAX_ACTIVE_FACTS_PER_COURSE = 16;
const MAX_ACTIVE_FACTS = 48;
const MAX_PLANNED_ACTIONS = 21;
const encoder = new TextEncoder();

interface CourseRow {
  principal_id: string;
  course_id: string;
  course_name: string;
  course_name_source: "owner_reported";
  platform_name: string | null;
  platform_source: SchoolEvidenceSource | null;
}

interface FactRow {
  principal_id: string;
  course_id: string;
  fact_id: string;
  fact_kind: SchoolCourseFactKind;
  statement: string;
  evidence_source: SchoolEvidenceSource;
  observed_at: string;
  status: "active" | "resolved";
  resolved_at: string | null;
}

interface ActionRow {
  principal_id: string;
  action_id: string;
  course_id: string;
  course_name: string;
  local_date: string;
  sequence_rank: number;
  action_text: string;
  estimated_minutes: number;
  status: "planned" | "completed" | "superseded";
}

interface ReceiptRow {
  response_hash: string;
}

function resultRows<T>(value: D1Result<T>): readonly T[] {
  if (!Array.isArray(value.results)) throw new TypeError("school_catchup_rows_invalid");
  return value.results;
}

function inline(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new TypeError(label);
  const text = value.trim();
  if (text.length === 0 || !text.isWellFormed() || text !== text.normalize("NFC")
    || encoder.encode(text).byteLength > maximumBytes || UNSAFE_INLINE.test(text)) {
    throw new TypeError(label);
  }
  return text;
}

function principal(value: unknown): string {
  return inline(value, "school_catchup_principal_invalid", 256);
}

function ulid(value: unknown, label: string): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(label);
  return value as Ulid;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new TypeError(label);
  return value;
}

function date(value: unknown): string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError("school_catchup_date_invalid");
  }
  return value;
}

function key(value: string, maximumBytes: number, label: string): string {
  const normalized = inline(value, label, maximumBytes).toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
  return inline(normalized, label, maximumBytes);
}

function courseRow(value: CourseRow, expectedPrincipal: string): CourseRow {
  if (value.principal_id !== expectedPrincipal || value.course_name_source !== "owner_reported"
    || value.platform_source !== null && value.platform_source !== "owner_reported"
      && value.platform_source !== "platform_confirmed") {
    throw new TypeError("school_course_row_invalid");
  }
  ulid(value.course_id, "school_course_row_invalid");
  inline(value.course_name, "school_course_row_invalid", 640);
  if ((value.platform_name === null) !== (value.platform_source === null)) {
    throw new TypeError("school_course_row_invalid");
  }
  if (value.platform_name !== null) inline(value.platform_name, "school_course_row_invalid", 640);
  return value;
}

function factRow(value: FactRow, expectedPrincipal: string): SchoolCourseFact {
  if (value.principal_id !== expectedPrincipal
    || !["missed_work", "due_work", "weak_area"].includes(value.fact_kind)
    || value.evidence_source !== "owner_reported" && value.evidence_source !== "platform_confirmed"
    || value.status !== "active" && value.status !== "resolved") {
    throw new TypeError("school_fact_row_invalid");
  }
  return Object.freeze({
    factId: ulid(value.fact_id, "school_fact_row_invalid"),
    kind: value.fact_kind,
    statement: inline(value.statement, "school_fact_row_invalid", 2_048),
    evidenceSource: value.evidence_source,
    observedAt: iso(value.observed_at, "school_fact_row_invalid"),
    status: value.status,
    resolvedAt: value.resolved_at === null ? null : iso(value.resolved_at, "school_fact_row_invalid"),
  });
}

function actionRow(value: ActionRow, expectedPrincipal: string): SchoolCatchupAction {
  if (value.principal_id !== expectedPrincipal || !Number.isSafeInteger(value.sequence_rank)
    || value.sequence_rank < 1 || value.sequence_rank > 20
    || !Number.isSafeInteger(value.estimated_minutes) || value.estimated_minutes < 5
    || value.estimated_minutes > 180
    || value.status !== "planned" && value.status !== "completed" && value.status !== "superseded") {
    throw new TypeError("school_action_row_invalid");
  }
  return Object.freeze({
    actionId: ulid(value.action_id, "school_action_row_invalid"),
    courseId: ulid(value.course_id, "school_action_row_invalid"),
    courseName: inline(value.course_name, "school_action_row_invalid", 640),
    localDate: date(value.local_date),
    sequenceRank: value.sequence_rank,
    text: inline(value.action_text, "school_action_row_invalid", 2_048),
    estimatedMinutes: value.estimated_minutes,
    status: value.status,
  });
}

function addDays(localDate: string, days: number): string {
  const instant = new Date(`${localDate}T12:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export class SchoolCatchupRepository {
  constructor(private readonly database: D1Database) {}

  async readSnapshot(principalIdValue: string, todayValue: string): Promise<SchoolCatchupSnapshot> {
    const principalId = principal(principalIdValue);
    const today = date(todayValue);
    const [courseResult, factResult, actionResult] = await Promise.all([
      this.database.prepare(`SELECT principal_id, course_id, course_name, course_name_source,
          platform_name, platform_source
        FROM school_course_cards
        WHERE principal_id = ?1 AND active = 1
        ORDER BY course_key, course_id
        LIMIT 12`).bind(principalId).all<CourseRow>(),
      this.database.prepare(`SELECT principal_id, course_id, fact_id, fact_kind, statement,
          evidence_source, observed_at, status, resolved_at
        FROM school_course_facts
        WHERE principal_id = ?1 AND status = 'active'
        ORDER BY observed_at, fact_id
        LIMIT 48`).bind(principalId).all<FactRow>(),
      this.database.prepare(`SELECT a.principal_id, a.action_id, a.course_id, c.course_name,
          a.local_date, a.sequence_rank, a.action_text, a.estimated_minutes, a.status
        FROM school_catchup_actions a
        JOIN school_course_cards c
          ON c.principal_id = a.principal_id AND c.course_id = a.course_id
        WHERE a.principal_id = ?1 AND a.status = 'planned' AND a.local_date >= ?2
        ORDER BY a.local_date, a.sequence_rank, a.action_id
        LIMIT 21`).bind(principalId, today).all<ActionRow>(),
    ]);
    const courses = resultRows(courseResult).slice(0, MAX_COURSES)
      .map((row) => courseRow(row, principalId));
    const courseIds = new Set(courses.map((course) => course.course_id));
    const factsByCourse = new Map<string, SchoolCourseFact[]>();
    const factRows = resultRows(factResult).slice(0, MAX_ACTIVE_FACTS);
    for (const row of factRows) {
      // A principal can temporarily be over a cap after a concurrent legacy
      // write. Clamp valid overflow instead of making all owner chat unreadable.
      if (!courseIds.has(row.course_id)) continue;
      const fact = factRow(row, principalId);
      const facts = factsByCourse.get(row.course_id) ?? [];
      if (facts.length < MAX_ACTIVE_FACTS_PER_COURSE) facts.push(fact);
      factsByCourse.set(row.course_id, facts);
    }
    const nextByCourse = new Map<string, SchoolCatchupAction>();
    for (const row of resultRows(actionResult).slice(0, MAX_PLANNED_ACTIONS)) {
      const action = actionRow(row, principalId);
      if (!courseIds.has(action.courseId)) continue;
      if (!nextByCourse.has(action.courseId)) nextByCourse.set(action.courseId, action);
    }
    const cards: SchoolCourseCard[] = courses.map((row) => {
      const facts = factsByCourse.get(row.course_id) ?? [];
      return Object.freeze({
        courseId: row.course_id as Ulid,
        name: row.course_name,
        nameSource: "owner_reported" as const,
        platform: row.platform_name,
        platformSource: row.platform_source,
        ownerReportedFacts: Object.freeze(facts.filter((fact) => fact.evidenceSource === "owner_reported")),
        platformConfirmedFacts: Object.freeze(facts.filter((fact) => fact.evidenceSource === "platform_confirmed")),
        currentNextAction: nextByCourse.get(row.course_id) ?? null,
      });
    });
    return Object.freeze({ principalId, courses: Object.freeze(cards) });
  }

  async listActionsForDate(principalIdValue: string, localDateValue: string): Promise<readonly SchoolCatchupAction[]> {
    const principalId = principal(principalIdValue);
    const localDate = date(localDateValue);
    const result = await this.database.prepare(`SELECT a.principal_id, a.action_id, a.course_id,
        c.course_name, a.local_date, a.sequence_rank, a.action_text, a.estimated_minutes, a.status
      FROM school_catchup_actions a
      JOIN school_course_cards c
        ON c.principal_id = a.principal_id AND c.course_id = a.course_id
      WHERE a.principal_id = ?1 AND a.local_date = ?2 AND a.status = 'planned' AND c.active = 1
      ORDER BY a.sequence_rank, a.action_id
      LIMIT 3`).bind(principalId, localDate).all<ActionRow>();
    const rows = resultRows(result).slice(0, 3);
    return Object.freeze(rows.map((row) => actionRow(row, principalId)));
  }

  async applyOwnerPlan(input: ApplyOwnerCatchupPlanInput): Promise<void> {
    const principalId = principal(input.principalId);
    const turnId = ulid(input.turnId, "school_catchup_turn_invalid");
    const today = date(input.today);
    const now = new Date(input.now.getTime());
    if (!Number.isFinite(now.getTime())) throw new TypeError("school_catchup_plan_invalid");
    const nowIso = now.toISOString();
    if (!SHA256.test(input.responseHash) || !input.plan.engaged) {
      throw new TypeError("school_catchup_plan_invalid");
    }
    if (input.plan.plan.length > MAX_PLANNED_ACTIONS) {
      throw new RangeError("school_catchup_action_limit_exceeded");
    }

    const receipt = await this.database.prepare(`SELECT response_hash FROM school_catchup_turn_receipts
      WHERE principal_id = ?1 AND turn_id = ?2`).bind(principalId, turnId).first<ReceiptRow>();
    if (receipt !== null) {
      if (receipt.response_hash !== input.responseHash) throw new Error("school_catchup_turn_conflict");
      return;
    }

    const current = await this.readSnapshot(principalId, today);
    const coursesById = new Map(current.courses.map((course) => [course.courseId, course]));
    const factsById = new Map(current.courses.flatMap((course) =>
      [...course.ownerReportedFacts, ...course.platformConfirmedFacts]
        .map((fact) => [fact.factId, { courseId: course.courseId, fact }] as const)));
    const currentActions = await this.database.prepare(`SELECT action_id, course_id FROM school_catchup_actions
      WHERE principal_id = ?1 AND status = 'planned'`).bind(principalId).all<{ action_id: string; course_id: string }>();
    const actionsById = new Map(resultRows(currentActions).map((action) => [action.action_id, action.course_id]));
    const statements: D1PreparedStatement[] = [];
    const courseIdsByRef = new Map<string, Ulid>();
    const finalCourseIds = new Set<Ulid>(coursesById.keys());
    const activeFactCounts = new Map<Ulid, number>(current.courses.map((course) => [
      course.courseId,
      course.ownerReportedFacts.length + course.platformConfirmedFacts.length,
    ]));
    const seenCourseRefs = new Set<string>();

    for (const update of input.plan.courseUpdates) {
      if (seenCourseRefs.has(update.courseRef)) throw new TypeError("school_catchup_course_ref_duplicate");
      seenCourseRefs.add(update.courseRef);
      const existingId = ULID.test(update.courseRef) ? update.courseRef as Ulid : null;
      let courseId: Ulid;
      if (existingId !== null) {
        if (!coursesById.has(existingId)) throw new TypeError("school_catchup_course_unknown");
        courseId = existingId;
      } else {
        if (!RESPONSE_LOCAL_COURSE.test(update.courseRef) || update.name === null) {
          throw new TypeError("school_catchup_course_ref_invalid");
        }
        courseId = newUlid(now);
        finalCourseIds.add(courseId);
        activeFactCounts.set(courseId, 0);
      }
      courseIdsByRef.set(update.courseRef, courseId);
      const name = update.name === null
        ? coursesById.get(courseId)?.name ?? null
        : inline(update.name, "school_catchup_course_name_invalid", 160);
      if (name === null) throw new TypeError("school_catchup_course_name_invalid");
      const platform = update.platform === null
        ? coursesById.get(courseId)?.platform ?? null
        : inline(update.platform, "school_catchup_platform_invalid", 160);

      if (existingId === null) {
        statements.push(this.database.prepare(`INSERT INTO school_course_cards (
          principal_id, course_id, course_key, course_name, course_name_source,
          platform_name, platform_source, platform_source_ref, platform_observed_at,
          owner_source_turn_id, active, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'owner_reported', ?5, ?6, NULL, ?7, ?8, 1, ?9, ?9)`)
          .bind(principalId, courseId, key(name, 160, "school_catchup_course_name_invalid"), name,
            platform, platform === null ? null : "owner_reported", platform === null ? null : nowIso,
            turnId, nowIso));
      } else if (update.name !== null || update.platform !== null) {
        statements.push(this.database.prepare(`UPDATE school_course_cards
          SET course_key = ?1, course_name = ?2, platform_name = ?3,
              platform_source = ?4, platform_source_ref = NULL, platform_observed_at = ?5,
              owner_source_turn_id = ?6, updated_at = ?7
          WHERE principal_id = ?8 AND course_id = ?9`)
          .bind(key(name, 160, "school_catchup_course_name_invalid"), name, platform,
            platform === null ? null : "owner_reported", platform === null ? null : nowIso,
            turnId, nowIso, principalId, courseId));
      }

      const knownFactKeys = new Set(current.courses.find((course) => course.courseId === courseId)?.ownerReportedFacts
        .map((fact) => `${fact.kind}:${key(fact.statement, 512, "school_catchup_fact_invalid")}`) ?? []);
      for (const factId of update.resolveFactIds) {
        const known = factsById.get(factId);
        if (known?.courseId !== courseId) throw new TypeError("school_catchup_fact_unknown");
        activeFactCounts.set(courseId, (activeFactCounts.get(courseId) ?? 0) - 1);
        if (known.fact.evidenceSource === "owner_reported") {
          knownFactKeys.delete(`${known.fact.kind}:${key(known.fact.statement, 512, "school_catchup_fact_invalid")}`);
        }
        statements.push(this.database.prepare(`UPDATE school_course_facts
          SET status = 'resolved', resolved_at = ?1, updated_at = ?1
          WHERE principal_id = ?2 AND fact_id = ?3 AND status = 'active'`).bind(nowIso, principalId, factId));
      }

      for (const fact of update.addFacts) {
        const statement = inline(fact.statement, "school_catchup_fact_invalid", 512);
        const factKey = key(statement, 512, "school_catchup_fact_invalid");
        const dedupe = `${fact.kind}:${factKey}`;
        if (knownFactKeys.has(dedupe)) continue;
        knownFactKeys.add(dedupe);
        activeFactCounts.set(courseId, (activeFactCounts.get(courseId) ?? 0) + 1);
        // A resolved owner report with the same key is historical state, not
        // an active duplicate. Remove it in this batch, then create a new fact
        // tied to the turn that reported it again.
        statements.push(this.database.prepare(`DELETE FROM school_course_facts
          WHERE principal_id = ?1 AND course_id = ?2 AND fact_kind = ?3
            AND evidence_source = 'owner_reported' AND fact_key = ?4 AND status = 'resolved'`)
          .bind(principalId, courseId, fact.kind, factKey));
        statements.push(this.database.prepare(`INSERT INTO school_course_facts (
          principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
          source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owner_reported', ?7, NULL, ?8, 'active', NULL, ?8)`)
          .bind(principalId, courseId, newUlid(now), factKey, fact.kind, statement, turnId, nowIso));
      }
      if ((activeFactCounts.get(courseId) ?? 0) > MAX_ACTIVE_FACTS_PER_COURSE) {
        throw new RangeError("school_catchup_fact_limit_exceeded");
      }
    }

    if (finalCourseIds.size > MAX_COURSES) throw new RangeError("school_catchup_course_limit_exceeded");
    if ([...activeFactCounts.values()].reduce((sum, count) => sum + count, 0) > MAX_ACTIVE_FACTS) {
      throw new RangeError("school_catchup_fact_limit_exceeded");
    }

    for (const actionId of input.plan.completeActionIds) {
      if (!actionsById.has(actionId)) throw new TypeError("school_catchup_action_unknown");
      statements.push(this.database.prepare(`UPDATE school_catchup_actions
        SET status = 'completed', completed_at = ?1, updated_at = ?1
        WHERE principal_id = ?2 AND action_id = ?3 AND status = 'planned'`).bind(nowIso, principalId, actionId));
    }

    const horizonEnd = addDays(today, 6);
    const plannedCourseIds = new Set<Ulid>();
    const dates = new Map<string, { minutes: number; ranks: Set<number>; count: number }>();
    for (const action of input.plan.plan) {
      const courseId = courseIdsByRef.get(action.courseRef)
        ?? (ULID.test(action.courseRef) ? action.courseRef as Ulid : null);
      if (courseId === null || !finalCourseIds.has(courseId)) throw new TypeError("school_catchup_action_course_invalid");
      const localDate = date(action.localDate);
      if (localDate < today || localDate > horizonEnd) throw new TypeError("school_catchup_action_date_invalid");
      if (!Number.isSafeInteger(action.sequenceRank) || action.sequenceRank < 1 || action.sequenceRank > 20
        || !Number.isSafeInteger(action.estimatedMinutes) || action.estimatedMinutes < 5
        || action.estimatedMinutes > 180) {
        throw new TypeError("school_catchup_action_invalid");
      }
      const day = dates.get(localDate) ?? { minutes: 0, ranks: new Set<number>(), count: 0 };
      day.minutes += action.estimatedMinutes;
      day.count += 1;
      if (day.ranks.has(action.sequenceRank) || day.count > 3 || day.minutes > 180) {
        throw new TypeError("school_catchup_day_unrealistic");
      }
      day.ranks.add(action.sequenceRank);
      dates.set(localDate, day);
      plannedCourseIds.add(courseId);
    }
    if (finalCourseIds.size > 0 && [...finalCourseIds].some((courseId) => !plannedCourseIds.has(courseId))) {
      throw new TypeError("school_catchup_course_missing_next_action");
    }
    for (const day of dates.values()) {
      const ordered = [...day.ranks].sort((left, right) => left - right);
      if (ordered.some((rank, index) => rank !== index + 1)) throw new TypeError("school_catchup_action_sequence_invalid");
    }

    statements.push(this.database.prepare(`UPDATE school_catchup_actions
      SET status = 'superseded', superseded_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND status = 'planned'`).bind(nowIso, principalId));
    for (const action of input.plan.plan) {
      const courseId = courseIdsByRef.get(action.courseRef)
        ?? action.courseRef as Ulid;
      statements.push(this.database.prepare(`INSERT INTO school_catchup_actions (
        principal_id, action_id, course_id, local_date, sequence_rank, action_text,
        estimated_minutes, status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'planned', ?8, NULL, NULL, ?9, ?9)`)
        .bind(principalId, newUlid(now), courseId, action.localDate, action.sequenceRank,
          inline(action.text, "school_catchup_action_invalid", 512), action.estimatedMinutes, turnId, nowIso));
    }
    statements.push(this.database.prepare(`DELETE FROM school_course_facts
      WHERE principal_id = ?1 AND status = 'resolved'`).bind(principalId));
    statements.push(this.database.prepare(`DELETE FROM school_catchup_actions
      WHERE principal_id = ?1 AND status = 'superseded'`).bind(principalId));
    statements.push(this.database.prepare(`INSERT INTO school_catchup_turn_receipts (
      principal_id, turn_id, response_hash, applied_at
    ) VALUES (?1, ?2, ?3, ?4)`).bind(principalId, turnId, input.responseHash, nowIso));
    await this.database.batch(statements);
  }
}

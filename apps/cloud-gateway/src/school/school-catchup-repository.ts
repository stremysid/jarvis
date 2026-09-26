import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import type {
  ApplyOwnerCatchupPlanInput,
  ApplyOwnerCatchupPlanResult,
  CatchupPlanAction,
  SchoolCatchupAction,
  SchoolCatchupSnapshot,
  SchoolCourseCard,
  SchoolCourseFact,
  SchoolCourseFactKind,
  SchoolEvidenceSource,
  SchoolPlanPartialCode,
  SchoolPlanRepairRule,
  SchoolPlanValidationRule,
  SchoolCatchupSaveReceipt,
} from "./school-catchup-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RESPONSE_LOCAL_COURSE = /^new-[1-9][0-9]{0,2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const MAX_COURSES = 12;
const MAX_ACTIVE_FACTS_PER_COURSE = 16;
const MAX_ACTIVE_FACTS = 48;
const MAX_RECENT_RESOLVED_FACTS = 48;
const MAX_PLANNED_ACTIONS = 21;
const HISTORY_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
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

interface RepairedPlan {
  readonly actions: readonly CatchupPlanAction[];
  readonly repairRules: readonly SchoolPlanRepairRule[];
  readonly invalidRule: SchoolPlanValidationRule | null;
}

const REPAIR_RULE_ORDER: readonly SchoolPlanRepairRule[] = Object.freeze([
  "school_catchup_action_sequence_invalid",
  "school_catchup_action_date_invalid",
  "school_catchup_action_invalid",
  "school_catchup_day_unrealistic",
]);

function repairedPlan(actions: readonly CatchupPlanAction[], today: string): RepairedPlan {
  const repairs = new Set<SchoolPlanRepairRule>();
  const bounded: CatchupPlanAction[] = [];
  for (const action of actions) {
    let localDate: string;
    try {
      localDate = date(action.localDate);
    } catch {
      return Object.freeze({ actions: Object.freeze([]), repairRules: Object.freeze([]), invalidRule: "school_catchup_action_date_invalid" });
    }
    // Only a date in the past is refused: it cannot be planned. How far ahead a
    // plan runs is the model's choice, and the prompt carries the owner's own
    // policy. Code used to cut the window at seven days and drop what fell
    // outside it, silently discarding planned work the model had chosen.
    if (localDate < today) {
      repairs.add("school_catchup_action_date_invalid");
      continue;
    }
    if (!Number.isSafeInteger(action.estimatedMinutes)) {
      return Object.freeze({ actions: Object.freeze([]), repairRules: Object.freeze([]), invalidRule: "school_catchup_action_invalid" });
    }
    // `0020`'s CHECK stores 5..180 minutes per block, so that range is the
    // storage bound. Code does not rewrite the model's number to fit it; it
    // refuses and names the bound, and the model splits or rescales the block.
    if (action.estimatedMinutes < 5 || action.estimatedMinutes > 180) {
      return Object.freeze({
        actions: Object.freeze([]),
        repairRules: Object.freeze([]),
        invalidRule: "school_catchup_action_minutes_out_of_range",
      });
    }
    bounded.push(Object.freeze({ ...action, localDate }));
  }

  // Renumbering keeps the model's order; it drops nothing. The per-day caps
  // (three actions, 180 minutes) used to drop the day's extra actions here and
  // are gone: a day's load is the owner's pinned capacity, which the prompt
  // carries, and the model's judgment. The one runaway bound left is the
  // 21-planned-action storage cap, checked by the caller.
  const nextRankByDate = new Map<string, number>();
  const renumbered = bounded.map((action) => {
    const sequenceRank = (nextRankByDate.get(action.localDate) ?? 0) + 1;
    nextRankByDate.set(action.localDate, sequenceRank);
    if (sequenceRank !== action.sequenceRank) repairs.add("school_catchup_action_sequence_invalid");
    return Object.freeze({ ...action, sequenceRank });
  });
  return Object.freeze({
    actions: Object.freeze(renumbered),
    repairRules: Object.freeze(REPAIR_RULE_ORDER.filter((rule) => repairs.has(rule))),
    invalidRule: null,
  });
}

function partialResult(
  scheduleSaved: boolean,
  repairs: readonly SchoolPlanRepairRule[],
  failure: SchoolPlanValidationRule | null = null,
): ApplyOwnerCatchupPlanResult {
  const codes = repairs.map((rule): SchoolPlanPartialCode => `partial:repaired:${rule}`);
  if (failure !== null) codes.push(`partial:${failure}`);
  return Object.freeze({ scheduleSaved, partialCodes: Object.freeze(codes) });
}

export class SchoolCatchupRepository {
  constructor(private readonly database: D1Database) {}

  async readSnapshot(principalIdValue: string, todayValue: string): Promise<SchoolCatchupSnapshot> {
    const principalId = principal(principalIdValue);
    const today = date(todayValue);
    const [courseResult, factResult, resolvedFactResult, actionResult] = await Promise.all([
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
      this.database.prepare(`SELECT principal_id, course_id, fact_id, fact_kind, statement,
          evidence_source, observed_at, status, resolved_at
        FROM school_course_facts
        WHERE principal_id = ?1 AND status = 'resolved'
        ORDER BY resolved_at DESC, fact_id
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
    const resolvedByCourse = new Map<string, SchoolCourseFact[]>();
    for (const row of resultRows(resolvedFactResult).slice(0, MAX_RECENT_RESOLVED_FACTS)) {
      if (!courseIds.has(row.course_id)) continue;
      const facts = resolvedByCourse.get(row.course_id) ?? [];
      facts.push(factRow(row, principalId));
      resolvedByCourse.set(row.course_id, facts);
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
        recentResolvedFacts: Object.freeze(resolvedByCourse.get(row.course_id) ?? []),
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

  async listPlannedActions(principalIdValue: string): Promise<readonly SchoolCatchupAction[]> {
    const principalId = principal(principalIdValue);
    const result = await this.database.prepare(`SELECT a.principal_id, a.action_id, a.course_id,
        c.course_name, a.local_date, a.sequence_rank, a.action_text, a.estimated_minutes, a.status
      FROM school_catchup_actions a
      JOIN school_course_cards c
        ON c.principal_id = a.principal_id AND c.course_id = a.course_id
      WHERE a.principal_id = ?1 AND a.status = 'planned' AND c.active = 1
      ORDER BY a.local_date, a.sequence_rank, a.action_id`).bind(principalId).all<ActionRow>();
    return Object.freeze(resultRows(result).map((row) => actionRow(row, principalId)));
  }

  async applyOwnerPlan(
    input: ApplyOwnerCatchupPlanInput,
    onResult?: (result: ApplyOwnerCatchupPlanResult, receipt?: SchoolCatchupSaveReceipt) => void,
  ): Promise<void> {
    const principalId = principal(input.principalId);
    const turnId = ulid(input.turnId, "school_catchup_turn_invalid");
    const today = date(input.today);
    const now = new Date(input.now.getTime());
    if (!Number.isFinite(now.getTime())) throw new TypeError("school_catchup_plan_invalid");
    const nowIso = now.toISOString();
    if (!SHA256.test(input.responseHash) || !input.plan.engaged) {
      throw new TypeError("school_catchup_plan_invalid");
    }
    const receipt = await this.database.prepare(`SELECT response_hash FROM school_catchup_turn_receipts
      WHERE principal_id = ?1 AND turn_id = ?2`).bind(principalId, turnId).first<ReceiptRow>();
    if (receipt !== null) {
      if (receipt.response_hash !== input.responseHash) throw new Error("school_catchup_turn_conflict");
      onResult?.(partialResult(true, []), { replayed: true, courses: [], actions: [], completedActions: 0 });
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
    const factResolves: D1PreparedStatement[] = [];
    const factInserts: D1PreparedStatement[] = [];
    const courseIdsByRef = new Map<string, Ulid>();
    const finalCourseIds = new Set<Ulid>(coursesById.keys());
    const activeFactCounts = new Map<Ulid, number>(current.courses.map((course) => [
      course.courseId,
      course.ownerReportedFacts.length + course.platformConfirmedFacts.length,
    ]));
    const seenCourseRefs = new Set<string>();
    const savedCourses: SchoolCatchupSaveReceipt["courses"][number][] = [];
    const courseNames = new Map(current.courses.map((course) => [course.courseId, course.name]));

    for (const update of input.plan.courseUpdates) {
      if (seenCourseRefs.has(update.courseRef)) throw new TypeError("school_catchup_course_ref_duplicate");
      seenCourseRefs.add(update.courseRef);
      let existingId = ULID.test(update.courseRef) ? update.courseRef as Ulid : null;
      let responseLocalMatchedExisting = false;
      let courseId: Ulid;
      if (existingId !== null) {
        if (!coursesById.has(existingId)) throw new TypeError("school_catchup_course_unknown");
        courseId = existingId;
      } else {
        if (!RESPONSE_LOCAL_COURSE.test(update.courseRef) || update.name === null) {
          throw new TypeError("school_catchup_course_ref_invalid");
        }
        const proposedName = inline(update.name, "school_catchup_course_name_invalid", 160);
        const proposedKey = key(proposedName, 160, "school_catchup_course_name_invalid");
        const matchedCourse = current.courses.find((course) =>
          key(course.name, 160, "school_catchup_course_name_invalid") === proposedKey);
        if (matchedCourse === undefined) {
          courseId = newUlid(now);
          finalCourseIds.add(courseId);
          activeFactCounts.set(courseId, 0);
        } else {
          // A response-local ref is model formatting, not course identity. An
          // exact stored key is the only safe repair; fuzzy aliases could join
          // two real classes and must still fail at the normal boundaries.
          existingId = matchedCourse.courseId;
          courseId = matchedCourse.courseId;
          responseLocalMatchedExisting = true;
        }
      }
      courseIdsByRef.set(update.courseRef, courseId);
      const name = responseLocalMatchedExisting
        ? coursesById.get(courseId)!.name
        : update.name === null
        ? coursesById.get(courseId)?.name ?? null
        : inline(update.name, "school_catchup_course_name_invalid", 160);
      if (name === null) throw new TypeError("school_catchup_course_name_invalid");
      courseNames.set(courseId, name);
      const insertedFacts: string[] = [];
      let alreadySaved = 0;
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
      } else if ((!responseLocalMatchedExisting && update.name !== null) || update.platform !== null) {
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
        factResolves.push(this.database.prepare(`UPDATE school_course_facts
          SET fact_key = substr(fact_key, 1, 476) || ':resolved:' || fact_id,
              status = 'resolved', resolved_at = ?1, updated_at = ?1
          WHERE principal_id = ?2 AND fact_id = ?3 AND status = 'active'`).bind(nowIso, principalId, factId));
      }

      for (const fact of update.addFacts) {
        const statement = inline(fact.statement, "school_catchup_fact_invalid", 512);
        const factKey = key(statement, 512, "school_catchup_fact_invalid");
        const dedupe = `${fact.kind}:${factKey}`;
        if (knownFactKeys.has(dedupe)) {
          alreadySaved += 1;
          continue;
        }
        insertedFacts.push(statement);
        knownFactKeys.add(dedupe);
        activeFactCounts.set(courseId, (activeFactCounts.get(courseId) ?? 0) + 1);
        factInserts.push(this.database.prepare(`INSERT INTO school_course_facts (
          principal_id, course_id, fact_id, fact_key, fact_kind, statement, evidence_source,
          source_turn_id, source_ref, observed_at, status, resolved_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owner_reported', ?7, NULL, ?8, 'active', NULL, ?8)`)
          .bind(principalId, courseId, newUlid(now), factKey, fact.kind, statement, turnId, nowIso));
      }
      if ((activeFactCounts.get(courseId) ?? 0) > MAX_ACTIVE_FACTS_PER_COURSE) {
        throw new RangeError("school_catchup_course_fact_limit_exceeded");
      }
      savedCourses.push({ courseId, name, insertedFacts, alreadySaved, resolved: update.resolveFactIds.length });
    }

    if (finalCourseIds.size > MAX_COURSES) throw new RangeError("school_catchup_course_limit_exceeded");
    if ([...activeFactCounts.values()].reduce((sum, count) => sum + count, 0) > MAX_ACTIVE_FACTS) {
      throw new RangeError("school_catchup_total_fact_limit_exceeded");
    }
    // D1 cap triggers see the batch in order. Every resolve must free capacity
    // before any insert tries to consume it, regardless of course order.
    statements.push(...factResolves, ...factInserts);

    for (const actionId of input.plan.completeActionIds) {
      if (!actionsById.has(actionId)) throw new TypeError("school_catchup_action_unknown");
      statements.push(this.database.prepare(`UPDATE school_catchup_actions
        SET status = 'completed', completed_at = ?1, updated_at = ?1
        WHERE principal_id = ?2 AND action_id = ?3 AND status = 'planned'`).bind(nowIso, principalId, actionId));
    }

    const nonScheduleStatementCount = statements.length;
    const repaired = repairedPlan(input.plan.plan, today);
    const plannedCourseIds = new Set<Ulid>();
    let scheduleFailure = repaired.invalidRule;
    if (scheduleFailure === null && repaired.actions.length > MAX_PLANNED_ACTIONS) {
      scheduleFailure = "school_catchup_action_limit_exceeded";
    }
    if (scheduleFailure === null) {
      for (const action of repaired.actions) {
        const courseId = courseIdsByRef.get(action.courseRef)
          ?? (ULID.test(action.courseRef) ? action.courseRef as Ulid : null);
        if (courseId === null || !finalCourseIds.has(courseId)) {
          scheduleFailure = "school_catchup_action_course_invalid";
          break;
        }
        try {
          inline(action.text, "school_catchup_action_invalid", 512);
        } catch {
          scheduleFailure = "school_catchup_action_invalid";
          break;
        }
        plannedCourseIds.add(courseId);
      }
    }
    if (scheduleFailure === null && finalCourseIds.size > 0
      && [...finalCourseIds].some((courseId) => !plannedCourseIds.has(courseId))) {
      scheduleFailure = "school_catchup_course_missing_next_action";
    }

    if (scheduleFailure !== null && nonScheduleStatementCount === 0) {
      throw new TypeError(scheduleFailure);
    }
    if (scheduleFailure === null) {
      statements.push(this.database.prepare(`UPDATE school_catchup_actions
        SET status = 'superseded', superseded_at = ?1, updated_at = ?1
        WHERE principal_id = ?2 AND status = 'planned'`).bind(nowIso, principalId));
      for (const action of repaired.actions) {
        const courseId = courseIdsByRef.get(action.courseRef)
          ?? action.courseRef as Ulid;
        statements.push(this.database.prepare(`INSERT INTO school_catchup_actions (
          principal_id, action_id, course_id, local_date, sequence_rank, action_text,
          estimated_minutes, status, plan_turn_id, completed_at, superseded_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'planned', ?8, NULL, NULL, ?9, ?9)`)
          .bind(principalId, newUlid(now), courseId, action.localDate, action.sequenceRank,
            inline(action.text, "school_catchup_action_invalid", 512), action.estimatedMinutes, turnId, nowIso));
      }
    }
    const historyCutoff = new Date(now.getTime() - HISTORY_RETENTION_MILLISECONDS).toISOString();
    statements.push(this.database.prepare(`DELETE FROM school_course_facts
      WHERE principal_id = ?1 AND status = 'resolved' AND resolved_at < ?2`).bind(principalId, historyCutoff));
    statements.push(this.database.prepare(`DELETE FROM school_catchup_actions
      WHERE principal_id = ?1 AND status = 'superseded'`).bind(principalId));
    statements.push(this.database.prepare(`DELETE FROM school_catchup_actions
      WHERE principal_id = ?1 AND status = 'completed' AND completed_at < ?2`).bind(principalId, historyCutoff));
    statements.push(this.database.prepare(`INSERT INTO school_catchup_turn_receipts (
      principal_id, turn_id, response_hash, applied_at
    ) VALUES (?1, ?2, ?3, ?4)`).bind(principalId, turnId, input.responseHash, nowIso));
    await this.database.batch(statements);
    onResult?.(partialResult(scheduleFailure === null, repaired.repairRules, scheduleFailure), {
      replayed: false,
      courses: savedCourses,
      actions: scheduleFailure === null ? repaired.actions.map((action) => ({
        ...action,
        courseRef: courseIdsByRef.get(action.courseRef) ?? action.courseRef,
        courseName: courseNames.get(courseIdsByRef.get(action.courseRef) ?? action.courseRef as Ulid)!,
      })) : [],
      completedActions: input.plan.completeActionIds.length,
    });
  }
}

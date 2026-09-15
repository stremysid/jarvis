import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import type {
  GeneratedPracticeItem,
  PracticeSource,
  StudyCheckIn,
  StudyCoachSnapshot,
  StudyConfidence,
  StudyCourseFactSource,
  StudyCourseSnapshot,
  StudyEvidenceKind,
  StudyEvidencePoint,
  StudyOutcome,
  StudyPracticeItem,
  StudyPracticeMode,
  StudyPreference,
  StudyTopicSummary,
} from "./study-coach-types.js";
import type { SchoolCourseFactKind, SchoolEvidenceSource } from "./school-catchup-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const encoder = new TextEncoder();
const DEFAULT_PREFERENCE: StudyPreference = Object.freeze({
  enabled: true,
  allowedDaysMask: 127,
  quietStartMinute: 22 * 60,
  quietEndMinute: 7 * 60,
});

interface CourseRow {
  principal_id: string;
  course_id: string;
  course_name: string;
}

interface FactRow {
  principal_id: string;
  course_id: string;
  fact_id: string;
  fact_kind: SchoolCourseFactKind;
  statement: string;
  evidence_source: SchoolEvidenceSource;
  observed_at: string;
}

interface EvidenceRow {
  principal_id: string;
  evidence_id: string;
  course_id: string;
  topic_key: string;
  topic: string;
  outcome: StudyOutcome;
  evidence_kind: StudyEvidenceKind;
  evidence_text: string;
  confidence: StudyConfidence;
  observed_at: string;
  practice_due_on: string;
  last_prompted_on: string | null;
}

interface PreferenceRow {
  enabled: number;
  allowed_days_mask: number;
  quiet_start_minute: number;
  quiet_end_minute: number;
}

interface PracticeRow {
  principal_id: string;
  item_id: string;
  practice_id: string;
  course_id: string;
  course_name: string;
  mode: StudyPracticeMode;
  position: number;
  question: string;
  answer: string;
  answer_support: "supported" | "uncertain";
  source_kind: "owner_topic" | "course_fact";
  source_excerpt: string;
  source_observed_at: string;
}

function rows<T>(result: D1Result<T>): readonly T[] {
  if (!Array.isArray(result.results)) throw new TypeError("school_study_rows_invalid");
  return result.results;
}

function inline(value: unknown, label: string, maximumBytes = 512): string {
  if (typeof value !== "string") throw new TypeError(label);
  const text = value.trim();
  if (text.length === 0 || !text.isWellFormed() || text !== text.normalize("NFC")
    || encoder.encode(text).byteLength > maximumBytes || UNSAFE_INLINE.test(text)) throw new TypeError(label);
  return text;
}

function principal(value: unknown): string {
  return inline(value, "school_study_principal_invalid", 256);
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

function localDate(value: unknown): string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError("school_study_date_invalid");
  }
  return value;
}

function topicKey(value: string): string {
  const key = inline(value, "school_study_topic_invalid").toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
  return inline(key, "school_study_topic_invalid");
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${localDate(date)}T12:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function evidencePoint(row: EvidenceRow, expectedPrincipal: string): StudyEvidencePoint {
  if (row.principal_id !== expectedPrincipal
    || !["easy", "uncertain", "wrong"].includes(row.outcome)
    || !["owner_statement", "course_context", "practice_result"].includes(row.evidence_kind)
    || !["low", "medium", "high"].includes(row.confidence)) throw new TypeError("school_study_evidence_invalid");
  return Object.freeze({
    evidenceId: ulid(row.evidence_id, "school_study_evidence_invalid"),
    topic: inline(row.topic, "school_study_evidence_invalid"),
    topicKey: inline(row.topic_key, "school_study_evidence_invalid"),
    outcome: row.outcome,
    evidenceKind: row.evidence_kind,
    evidenceText: inline(row.evidence_text, "school_study_evidence_invalid"),
    confidence: row.confidence,
    observedAt: iso(row.observed_at, "school_study_evidence_invalid"),
    practiceDueOn: localDate(row.practice_due_on),
    lastPromptedOn: row.last_prompted_on === null ? null : localDate(row.last_prompted_on),
  });
}

function practiceItem(row: PracticeRow, expectedPrincipal: string): StudyPracticeItem {
  if (row.principal_id !== expectedPrincipal || !Number.isSafeInteger(row.position)
    || row.position < 1 || row.position > 5
    || !["quiz", "flashcard"].includes(row.mode)
    || !["supported", "uncertain"].includes(row.answer_support)
    || !["owner_topic", "course_fact"].includes(row.source_kind)) {
    throw new TypeError("school_practice_item_invalid");
  }
  return Object.freeze({
    itemId: ulid(row.item_id, "school_practice_item_invalid"),
    practiceId: ulid(row.practice_id, "school_practice_item_invalid"),
    courseId: ulid(row.course_id, "school_practice_item_invalid"),
    courseName: inline(row.course_name, "school_practice_item_invalid", 160),
    mode: row.mode,
    position: row.position,
    question: inline(row.question, "school_practice_item_invalid"),
    answer: inline(row.answer, "school_practice_item_invalid"),
    answerSupport: row.answer_support,
    sourceKind: row.source_kind,
    sourceExcerpt: inline(row.source_excerpt, "school_practice_item_invalid"),
    sourceObservedAt: iso(row.source_observed_at, "school_practice_item_invalid"),
  });
}

function preference(row: PreferenceRow | null): StudyPreference {
  if (row === null) return DEFAULT_PREFERENCE;
  if (![0, 1].includes(row.enabled) || !Number.isSafeInteger(row.allowed_days_mask)
    || row.allowed_days_mask < 1 || row.allowed_days_mask > 127
    || !Number.isSafeInteger(row.quiet_start_minute) || row.quiet_start_minute < 0
    || row.quiet_start_minute > 1439 || !Number.isSafeInteger(row.quiet_end_minute)
    || row.quiet_end_minute < 0 || row.quiet_end_minute > 1439
    || row.quiet_start_minute === row.quiet_end_minute) throw new TypeError("school_study_preference_invalid");
  return Object.freeze({
    enabled: row.enabled === 1,
    allowedDaysMask: row.allowed_days_mask,
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
  });
}

function summariseTopic(topic: string, key: string, points: readonly StudyEvidencePoint[]): StudyTopicSummary {
  const weakSignals = points.filter((point) => point.outcome !== "easy").length;
  const easySignals = points.length - weakSignals;
  const judgement = weakSignals >= 3 && weakSignals > easySignals
    ? "strong"
    : weakSignals >= 2 && weakSignals > easySignals ? "supported" : "tentative";
  const confidence: StudyConfidence = judgement === "strong" ? "high" : judgement === "supported" ? "medium" : "low";
  return Object.freeze({ topic, topicKey: key, evidence: Object.freeze([...points]), judgement, confidence });
}

export interface OwnerStudyObservationInput {
  readonly principalId: string;
  readonly turnId: Ulid;
  readonly courseId: Ulid;
  readonly topic: string;
  readonly outcome: StudyOutcome;
  readonly evidenceText: string;
  readonly today: string;
  readonly now: Date;
}

export interface StudyPreferenceUpdateInput {
  readonly principalId: string;
  readonly turnId: Ulid;
  readonly preference: StudyPreference;
  readonly now: Date;
}

export interface CreatePracticeInput {
  readonly principalId: string;
  readonly courseId: Ulid;
  readonly mode: StudyPracticeMode;
  readonly source: PracticeSource;
  readonly items: readonly GeneratedPracticeItem[];
  readonly now: Date;
}

export class StudyCoachRepository {
  constructor(private readonly database: D1Database) {}

  async syncCourseContext(principalIdValue: string, todayValue: string, nowValue: Date): Promise<void> {
    const principalId = principal(principalIdValue);
    const today = localDate(todayValue);
    const now = new Date(nowValue.getTime());
    if (!Number.isFinite(now.getTime())) throw new TypeError("school_study_time_invalid");
    const result = await this.database.prepare(`WITH missing AS (
        SELECT f.principal_id, f.course_id, f.fact_id, f.fact_kind, f.statement,
          f.evidence_source, f.observed_at,
          ROW_NUMBER() OVER (
            PARTITION BY f.course_id ORDER BY f.observed_at DESC, f.fact_id DESC
          ) AS course_rank,
          (SELECT COUNT(*) FROM school_study_evidence e
            WHERE e.principal_id = f.principal_id AND e.course_id = f.course_id
              AND e.status = 'active'
              AND (e.evidence_kind != 'course_context' OR EXISTS (
                SELECT 1 FROM school_course_facts active_fact
                WHERE active_fact.principal_id = e.principal_id
                  AND active_fact.fact_id = e.source_fact_id
                  AND active_fact.status = 'active'
              ))) AS active_course_count
        FROM school_course_facts f
        WHERE f.principal_id = ?1 AND f.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM school_study_evidence existing
            WHERE existing.principal_id = f.principal_id
              AND existing.source_key = 'fact:' || f.fact_id
          )
      )
      SELECT principal_id, course_id, fact_id, fact_kind, statement,
        evidence_source, observed_at
      FROM missing
      WHERE course_rank <= 24 - active_course_count
      ORDER BY observed_at DESC, fact_id DESC
      LIMIT max(0, 96 - (SELECT COUNT(*) FROM school_study_evidence e
        WHERE e.principal_id = ?1 AND e.status = 'active'
          AND (e.evidence_kind != 'course_context' OR EXISTS (
            SELECT 1 FROM school_course_facts active_fact
            WHERE active_fact.principal_id = e.principal_id
              AND active_fact.fact_id = e.source_fact_id
              AND active_fact.status = 'active'
          ))))`).bind(principalId).all<FactRow>();
    const statements = rows(result).map((row) => {
      const fact = this.requireFact(row, principalId);
      const key = topicKey(fact.statement);
      return this.database.prepare(`INSERT INTO school_study_evidence (
          principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome,
          evidence_kind, evidence_text, confidence, source_turn_id, source_fact_id,
          source_practice_item_id, observed_at, practice_due_on, last_prompted_on,
          status, control_turn_id, controlled_at, created_at, updated_at
        ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'uncertain', 'course_context', ?6, 'low',
          NULL, ?7, NULL, ?8, ?9, NULL, 'active', NULL, NULL, ?10, ?10
        WHERE NOT EXISTS (
          SELECT 1 FROM school_study_evidence WHERE principal_id = ?1 AND source_key = ?3
        )`).bind(principalId, newUlid(now), `fact:${fact.factId}`, row.course_id, key,
          fact.statement, fact.factId, fact.observedAt, today, now.toISOString());
    });
    if (statements.length > 0) await this.database.batch(statements);
  }

  async readSnapshot(principalIdValue: string, todayValue: string): Promise<StudyCoachSnapshot> {
    const principalId = principal(principalIdValue);
    localDate(todayValue);
    const [courseResult, factResult, evidenceResult, preferenceRow, quizRow] = await Promise.all([
      this.database.prepare(`SELECT principal_id, course_id, course_name
        FROM school_course_cards
        WHERE principal_id = ?1 AND active = 1
        ORDER BY course_key, course_id LIMIT 12`).bind(principalId).all<CourseRow>(),
      this.database.prepare(`SELECT principal_id, course_id, fact_id, fact_kind, statement,
          evidence_source, observed_at
        FROM school_course_facts
        WHERE principal_id = ?1 AND status = 'active'
        ORDER BY observed_at, fact_id LIMIT 48`).bind(principalId).all<FactRow>(),
      this.database.prepare(`SELECT e.principal_id, e.evidence_id, e.course_id, e.topic_key,
          e.topic, e.outcome, e.evidence_kind, e.evidence_text, e.confidence,
          e.observed_at, e.practice_due_on, e.last_prompted_on
        FROM school_study_evidence e
        LEFT JOIN school_course_facts f
          ON f.principal_id = e.principal_id AND f.fact_id = e.source_fact_id
        WHERE e.principal_id = ?1 AND e.status = 'active'
          AND (e.evidence_kind != 'course_context' OR f.status = 'active')
        ORDER BY e.observed_at, e.evidence_id LIMIT 96`).bind(principalId).all<EvidenceRow>(),
      this.database.prepare(`SELECT enabled, allowed_days_mask, quiet_start_minute, quiet_end_minute
        FROM school_study_preferences WHERE principal_id = ?1`).bind(principalId).first<PreferenceRow>(),
      this.database.prepare(`SELECT p.principal_id, p.item_id, p.practice_id, p.course_id,
          c.course_name, p.mode, p.position, p.question, p.answer, p.answer_support,
          p.source_kind, p.source_excerpt, p.source_observed_at
        FROM school_practice_items p
        JOIN school_course_cards c
          ON c.principal_id = p.principal_id AND c.course_id = p.course_id
        WHERE p.principal_id = ?1 AND p.status = 'open'
        ORDER BY p.created_at, p.practice_id, p.position LIMIT 1`).bind(principalId).first<PracticeRow>(),
    ]);
    const courseRows = rows(courseResult).map((row) => this.requireCourse(row, principalId));
    const factsByCourse = new Map<string, StudyCourseFactSource[]>();
    for (const row of rows(factResult)) {
      const fact = this.requireFact(row, principalId);
      const facts = factsByCourse.get(row.course_id) ?? [];
      facts.push(fact);
      factsByCourse.set(row.course_id, facts);
    }
    const evidenceByCourseAndTopic = new Map<string, StudyEvidencePoint[]>();
    for (const row of rows(evidenceResult)) {
      const point = evidencePoint(row, principalId);
      const group = `${row.course_id}\u0000${point.topicKey}`;
      const points = evidenceByCourseAndTopic.get(group) ?? [];
      points.push(point);
      evidenceByCourseAndTopic.set(group, points);
    }
    const courses: StudyCourseSnapshot[] = courseRows.map((row) => {
      const topics = [...evidenceByCourseAndTopic.entries()]
        .filter(([group]) => group.startsWith(`${row.course_id}\u0000`))
        .map(([, points]) => summariseTopic(points[0]!.topic, points[0]!.topicKey, points));
      return Object.freeze({
        courseId: row.course_id as Ulid,
        name: row.course_name,
        facts: Object.freeze(factsByCourse.get(row.course_id) ?? []),
        topics: Object.freeze(topics),
      });
    });
    return Object.freeze({
      principalId,
      courses: Object.freeze(courses),
      preference: preference(preferenceRow),
      activeQuiz: quizRow === null ? null : practiceItem(quizRow, principalId),
    });
  }

  async recordOwnerObservation(input: OwnerStudyObservationInput): Promise<void> {
    const principalId = principal(input.principalId);
    const turnId = ulid(input.turnId, "school_study_turn_invalid");
    const courseId = ulid(input.courseId, "school_study_course_invalid");
    const topic = inline(input.topic, "school_study_topic_invalid");
    const evidenceText = inline(input.evidenceText, "school_study_evidence_invalid");
    const today = localDate(input.today);
    const now = new Date(input.now.getTime());
    if (!Number.isFinite(now.getTime()) || !["easy", "uncertain", "wrong"].includes(input.outcome)) {
      throw new TypeError("school_study_observation_invalid");
    }
    const key = topicKey(topic);
    await this.database.prepare(`INSERT INTO school_study_evidence (
        principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome,
        evidence_kind, evidence_text, confidence, source_turn_id, source_fact_id,
        source_practice_item_id, observed_at, practice_due_on, last_prompted_on,
        status, control_turn_id, controlled_at, created_at, updated_at
      ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'owner_statement', ?8, 'medium', ?9,
        NULL, NULL, ?10, ?11, NULL, 'active', NULL, NULL, ?10, ?10
      WHERE NOT EXISTS (
        SELECT 1 FROM school_study_evidence WHERE principal_id = ?1 AND source_key = ?3
      )`).bind(principalId, newUlid(now), `turn:${turnId}`, courseId,
        key, topic, input.outcome, evidenceText, turnId, now.toISOString(),
        input.outcome === "easy" ? addDays(today, 7) : today).run();
  }

  async updatePreference(input: StudyPreferenceUpdateInput): Promise<void> {
    const principalId = principal(input.principalId);
    const turnId = ulid(input.turnId, "school_study_turn_invalid");
    const now = new Date(input.now.getTime());
    const value = preference({
      enabled: input.preference.enabled ? 1 : 0,
      allowed_days_mask: input.preference.allowedDaysMask,
      quiet_start_minute: input.preference.quietStartMinute,
      quiet_end_minute: input.preference.quietEndMinute,
    });
    if (!Number.isFinite(now.getTime())) throw new TypeError("school_study_time_invalid");
    const existing = await this.database.prepare(
      "SELECT principal_id FROM school_study_preferences WHERE principal_id = ?1",
    ).bind(principalId).first<{ principal_id: string }>();
    if (existing === null) {
      await this.database.prepare(`INSERT INTO school_study_preferences (
        principal_id, enabled, allowed_days_mask, quiet_start_minute, quiet_end_minute,
        source_turn_id, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(principalId, value.enabled ? 1 : 0,
        value.allowedDaysMask, value.quietStartMinute, value.quietEndMinute, turnId, now.toISOString()).run();
      return;
    }
    await this.database.prepare(`UPDATE school_study_preferences
      SET enabled = ?1, allowed_days_mask = ?2, quiet_start_minute = ?3,
        quiet_end_minute = ?4, source_turn_id = ?5, updated_at = ?6
      WHERE principal_id = ?7`).bind(value.enabled ? 1 : 0, value.allowedDaysMask,
      value.quietStartMinute, value.quietEndMinute, turnId, now.toISOString(), principalId).run();
  }

  async forget(principalIdValue: string, turnIdValue: Ulid, selector: {
    readonly courseId?: Ulid;
    readonly topicKey?: string;
  }, nowValue: Date): Promise<number> {
    const principalId = principal(principalIdValue);
    const turnId = ulid(turnIdValue, "school_study_turn_invalid");
    const now = new Date(nowValue.getTime());
    if (!Number.isFinite(now.getTime()) || (selector.courseId === undefined) === (selector.topicKey === undefined)) {
      throw new TypeError("school_study_forget_invalid");
    }
    const where = selector.courseId === undefined ? "topic_key = ?4" : "course_id = ?4";
    const value = selector.courseId === undefined
      ? topicKey(selector.topicKey ?? "")
      : ulid(selector.courseId, "school_study_course_invalid");
    const result = await this.database.prepare(`UPDATE school_study_evidence
      SET status = 'forgotten', control_turn_id = ?1, controlled_at = ?2, updated_at = ?2
      WHERE principal_id = ?3 AND ${where} AND status = 'active'`)
      .bind(turnId, now.toISOString(), principalId, value).run();
    return result.meta.changes;
  }

  async correctLatestMark(principalIdValue: string, turnIdValue: Ulid, nowValue: Date): Promise<number> {
    const principalId = principal(principalIdValue);
    const turnId = ulid(turnIdValue, "school_study_turn_invalid");
    const now = new Date(nowValue.getTime());
    if (!Number.isFinite(now.getTime())) throw new TypeError("school_study_time_invalid");
    const candidates = await this.database.prepare(`SELECT evidence_id
      FROM school_study_evidence
      WHERE principal_id = ?1 AND status = 'active' AND evidence_kind = 'course_context'
        AND (lower(evidence_text) LIKE '%mark%' OR lower(evidence_text) LIKE '%grade%'
          OR evidence_text GLOB '*[0-9]%*')
      ORDER BY observed_at DESC, evidence_id DESC LIMIT 2`).bind(principalId).all<{ evidence_id: string }>();
    const found = rows(candidates);
    if (found.length !== 1) return found.length === 0 ? 0 : -1;
    const result = await this.database.prepare(`UPDATE school_study_evidence
      SET status = 'corrected', control_turn_id = ?1, controlled_at = ?2, updated_at = ?2
      WHERE principal_id = ?3 AND evidence_id = ?4 AND status = 'active'`)
      .bind(turnId, now.toISOString(), principalId, found[0]!.evidence_id).run();
    return result.meta.changes;
  }

  async createPractice(input: CreatePracticeInput): Promise<readonly StudyPracticeItem[]> {
    const principalId = principal(input.principalId);
    const courseId = ulid(input.courseId, "school_study_course_invalid");
    const now = new Date(input.now.getTime());
    if (!Number.isFinite(now.getTime()) || !["quiz", "flashcard"].includes(input.mode)
      || input.items.length < 1 || input.items.length > 5) throw new TypeError("school_practice_invalid");
    const sourceExcerpt = inline(input.source.excerpt, "school_practice_source_invalid");
    const sourceObservedAt = iso(input.source.observedAt, "school_practice_source_invalid");
    const practiceId = newUlid(now);
    const nowIso = now.toISOString();
    const statements: D1PreparedStatement[] = [this.database.prepare(`UPDATE school_practice_items
      SET status = 'dismissed', updated_at = ?1
      WHERE principal_id = ?2 AND status = 'open'`).bind(nowIso, principalId)];
    for (const [index, item] of input.items.entries()) {
      const question = inline(item.question, "school_practice_item_invalid");
      const answer = inline(item.answer, "school_practice_item_invalid");
      const quote = inline(item.sourceQuote, "school_practice_item_invalid");
      const sourceLower = sourceExcerpt.toLocaleLowerCase("en-CA");
      const supported = sourceLower.includes(quote.toLocaleLowerCase("en-CA"))
        && quote.toLocaleLowerCase("en-CA").includes(answer.toLocaleLowerCase("en-CA"));
      const itemId = newUlid(now);
      statements.push(this.database.prepare(`INSERT INTO school_practice_items (
        principal_id, item_id, item_key, practice_id, course_id, mode, position,
        question, answer, answer_support, source_kind, source_turn_id, source_fact_id,
        source_excerpt, source_observed_at, status, owner_answer, result, result_turn_id,
        answered_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
        ?14, ?15, ?16, NULL, NULL, NULL, NULL, ?17, ?17)`)
        .bind(principalId, itemId, `${practiceId}:${index + 1}`, practiceId, courseId,
          input.mode, index + 1, question, answer, supported ? "supported" : "uncertain",
          input.source.kind, input.source.kind === "owner_topic" ? input.source.turnId : null,
          input.source.kind === "course_fact" ? input.source.factId : null, sourceExcerpt,
          sourceObservedAt, input.mode === "quiz" ? "open" : "shown", nowIso));
    }
    await this.database.batch(statements);
    const result = await this.database.prepare(`SELECT p.principal_id, p.item_id, p.practice_id,
        p.course_id, c.course_name, p.mode, p.position, p.question, p.answer,
        p.answer_support, p.source_kind, p.source_excerpt, p.source_observed_at
      FROM school_practice_items p
      JOIN school_course_cards c
        ON c.principal_id = p.principal_id AND c.course_id = p.course_id
      WHERE p.principal_id = ?1 AND p.practice_id = ?2
      ORDER BY p.position`).bind(principalId, practiceId).all<PracticeRow>();
    return Object.freeze(rows(result).map((row) => practiceItem(row, principalId)));
  }

  async answerActiveQuiz(input: {
    readonly principalId: string;
    readonly turnId: Ulid;
    readonly answer: string;
    readonly today: string;
    readonly now: Date;
  }): Promise<{ readonly item: StudyPracticeItem; readonly result: StudyOutcome } | null> {
    const principalId = principal(input.principalId);
    const turnId = ulid(input.turnId, "school_study_turn_invalid");
    const answer = inline(input.answer, "school_practice_answer_invalid");
    const today = localDate(input.today);
    const snapshot = await this.readSnapshot(principalId, today);
    const item = snapshot.activeQuiz;
    if (item === null) return null;
    const normalized = answer.toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
    const expected = item.answer.toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
    const unsure = /^(?:i\s+(?:do not|don't)\s+know|not\s+sure|unsure|skip)$/iu.test(answer);
    const result: StudyOutcome = item.answerSupport === "uncertain" || unsure
      ? "uncertain"
      : normalized === expected ? "easy" : "wrong";
    const now = new Date(input.now.getTime());
    if (!Number.isFinite(now.getTime())) throw new TypeError("school_study_time_invalid");
    const nowIso = now.toISOString();
    const evidenceText = answer;
    await this.database.batch([
      this.database.prepare(`UPDATE school_practice_items
        SET status = 'answered', owner_answer = ?1, result = ?2, result_turn_id = ?3,
          answered_at = ?4, updated_at = ?4
        WHERE principal_id = ?5 AND item_id = ?6 AND status = 'open'`)
        .bind(answer, result, turnId, nowIso, principalId, item.itemId),
      this.database.prepare(`INSERT INTO school_study_evidence (
        principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome,
        evidence_kind, evidence_text, confidence, source_turn_id, source_fact_id,
        source_practice_item_id, observed_at, practice_due_on, last_prompted_on,
        status, control_turn_id, controlled_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'practice_result', ?8, ?9, ?10,
        NULL, ?11, ?12, ?13, NULL, 'active', NULL, NULL, ?12, ?12)`)
        .bind(principalId, newUlid(now), `practice:${item.itemId}`, item.courseId,
          topicKey(item.sourceExcerpt), item.sourceExcerpt, result, evidenceText,
          item.answerSupport === "supported" ? "medium" : "low", turnId, item.itemId,
          nowIso, result === "easy" ? addDays(today, 7) : today),
    ]);
    return Object.freeze({ item, result });
  }

  async dismissActiveQuiz(principalIdValue: string, nowValue: Date): Promise<number> {
    const principalId = principal(principalIdValue);
    const now = new Date(nowValue.getTime());
    if (!Number.isFinite(now.getTime())) throw new TypeError("school_study_time_invalid");
    const result = await this.database.prepare(`UPDATE school_practice_items
      SET status = 'dismissed', updated_at = ?1
      WHERE principal_id = ?2 AND status = 'open'`).bind(now.toISOString(), principalId).run();
    return result.meta.changes;
  }

  async syncAndClaimDigestCheckIn(input: {
    readonly principalId: string;
    readonly today: string;
    readonly weekday: number;
    readonly minuteOfDay: number;
    readonly now: Date;
  }): Promise<StudyCheckIn | null> {
    await this.syncCourseContext(input.principalId, input.today, input.now);
    return this.claimDigestCheckIn(input);
  }

  async claimDigestCheckIn(input: {
    readonly principalId: string;
    readonly today: string;
    readonly weekday: number;
    readonly minuteOfDay: number;
    readonly now: Date;
  }): Promise<StudyCheckIn | null> {
    const principalId = principal(input.principalId);
    const today = localDate(input.today);
    const now = new Date(input.now.getTime());
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6
      || !Number.isInteger(input.minuteOfDay) || input.minuteOfDay < 0 || input.minuteOfDay > 1439
      || !Number.isFinite(now.getTime())) throw new TypeError("school_study_check_in_invalid");
    const stored = await this.database.prepare(`SELECT enabled, allowed_days_mask,
        quiet_start_minute, quiet_end_minute
      FROM school_study_preferences WHERE principal_id = ?1`).bind(principalId).first<PreferenceRow>();
    const setting = preference(stored);
    const allowedToday = (setting.allowedDaysMask & (1 << input.weekday)) !== 0;
    const quiet = setting.quietStartMinute < setting.quietEndMinute
      ? input.minuteOfDay >= setting.quietStartMinute && input.minuteOfDay < setting.quietEndMinute
      : input.minuteOfDay >= setting.quietStartMinute || input.minuteOfDay < setting.quietEndMinute;
    if (!setting.enabled || !allowedToday || quiet) return null;
    const row = await this.database.prepare(`UPDATE school_study_evidence
      SET last_prompted_on = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND evidence_id = (
        SELECT e.evidence_id FROM school_study_evidence e
        LEFT JOIN school_course_facts f
          ON f.principal_id = e.principal_id AND f.fact_id = e.source_fact_id
        WHERE e.principal_id = ?3 AND e.status = 'active'
          AND e.outcome IN ('uncertain', 'wrong') AND e.practice_due_on <= ?1
          AND (e.last_prompted_on IS NULL OR e.last_prompted_on < e.practice_due_on)
          AND (e.evidence_kind != 'course_context' OR f.status = 'active')
        ORDER BY e.practice_due_on, CASE e.outcome WHEN 'wrong' THEN 0 ELSE 1 END,
          e.observed_at DESC, e.evidence_id LIMIT 1
      )
      RETURNING principal_id, evidence_id, course_id, topic_key, topic, outcome,
        evidence_kind, evidence_text, confidence, observed_at, practice_due_on,
        last_prompted_on`).bind(today, now.toISOString(), principalId).first<EvidenceRow>();
    if (row === null || row.outcome === "easy") return null;
    const course = await this.database.prepare(`SELECT principal_id, course_id, course_name
      FROM school_course_cards WHERE principal_id = ?1 AND course_id = ?2 AND active = 1`)
      .bind(principalId, row.course_id).first<CourseRow>();
    if (course === null) throw new TypeError("school_study_course_invalid");
    this.requireCourse(course, principalId);
    const count = await this.database.prepare(`SELECT COUNT(*) AS count
      FROM school_study_evidence e
      LEFT JOIN school_course_facts f
        ON f.principal_id = e.principal_id AND f.fact_id = e.source_fact_id
      WHERE e.principal_id = ?1 AND e.course_id = ?2 AND e.topic_key = ?3
        AND e.status = 'active'
        AND (e.evidence_kind != 'course_context' OR f.status = 'active')`)
      .bind(principalId, row.course_id, row.topic_key).first<{ count: number }>();
    const point = evidencePoint(row, principalId);
    const evidenceCount = count?.count ?? 1;
    return Object.freeze({
      courseName: course.course_name,
      topic: point.topic,
      outcome: row.outcome,
      evidenceCount,
      confidence: evidenceCount >= 3 ? "high" : evidenceCount >= 2 ? "medium" : "low",
      observedAt: point.observedAt,
    });
  }

  private requireCourse(row: CourseRow, expectedPrincipal: string): CourseRow {
    if (row.principal_id !== expectedPrincipal) throw new TypeError("school_study_course_invalid");
    ulid(row.course_id, "school_study_course_invalid");
    inline(row.course_name, "school_study_course_invalid", 160);
    return row;
  }

  private requireFact(row: FactRow, expectedPrincipal: string): StudyCourseFactSource {
    if (row.principal_id !== expectedPrincipal
      || !["missed_work", "due_work", "weak_area"].includes(row.fact_kind)
      || !["owner_reported", "platform_confirmed"].includes(row.evidence_source)) {
      throw new TypeError("school_study_fact_invalid");
    }
    return Object.freeze({
      factId: ulid(row.fact_id, "school_study_fact_invalid"),
      kind: row.fact_kind,
      statement: inline(row.statement, "school_study_fact_invalid"),
      evidenceSource: row.evidence_source,
      observedAt: iso(row.observed_at, "school_study_fact_invalid"),
    });
  }
}

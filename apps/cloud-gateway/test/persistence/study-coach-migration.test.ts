import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyStudyCoachMigration } from "./migration.js";

const NOW = new Date("2026-09-15T11:30:00.000Z");
const LATER = new Date("2026-09-15T11:31:00.000Z");
const TODAY = "2026-09-15";

async function addPrincipal(principalId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', ?1, ?2, ?2)`).bind(principalId, NOW.toISOString()).run();
}

async function addTurn(principalId: string, channel: "telegram" | "voice", now = NOW): Promise<Ulid> {
  const turnId = newUlid(now);
  const redacted = new Redactor().redactText("study coach migration provenance");
  if (!redacted.ok) throw new Error("study_coach_migration_redaction_failed");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId,
    sessionId: `${channel}:${principalId}`,
    principalId,
    channel,
    userText: redacted,
    now,
  });
  return turnId;
}

async function graph(suffix: string): Promise<{
  principalId: string;
  otherPrincipalId: string;
  turnId: Ulid;
  laterTurnId: Ulid;
  otherTurnId: Ulid;
  voiceTurnId: Ulid;
  courseId: Ulid;
  factId: Ulid;
  evidenceId: string;
  practiceItemId: string;
}> {
  const principalId = `principal:study-migration-${suffix}`;
  const otherPrincipalId = `principal:study-migration-other-${suffix}`;
  await addPrincipal(principalId);
  await addPrincipal(otherPrincipalId);
  const turnId = await addTurn(principalId, "telegram");
  const laterTurnId = await addTurn(principalId, "telegram", LATER);
  const otherTurnId = await addTurn(otherPrincipalId, "telegram");
  const voiceTurnId = await addTurn(principalId, "voice");
  const school = new SchoolCatchupRepository(env.DB);
  await school.applyOwnerPlan({
    principalId,
    turnId,
    today: TODAY,
    responseHash: suffix.replace(/[^a-f0-9]/gu, "a").padEnd(64, "a").slice(0, 64),
    now: NOW,
    plan: {
      engaged: true,
      reply: "Plan",
      courseUpdates: [{
        courseRef: "new-1",
        name: "Chemistry",
        platform: "D2L",
        addFacts: [{ kind: "weak_area", statement: "Titration calculations feel uncertain" }],
        resolveFactIds: [],
      }],
      completeActionIds: [],
      plan: [{
        courseRef: "new-1", localDate: TODAY, sequenceRank: 1,
        text: "Review titration", estimatedMinutes: 20,
      }],
    },
  });
  const schoolSnapshot = await school.readSnapshot(principalId, TODAY);
  const courseId = schoolSnapshot.courses[0]!.courseId;
  const factId = schoolSnapshot.courses[0]!.ownerReportedFacts[0]!.factId;
  const study = new StudyCoachRepository(env.DB);
  await study.updatePreference({
    principalId,
    turnId,
    preference: { enabled: true, allowedDaysMask: 127, quietStartMinute: 1320, quietEndMinute: 420 },
    now: NOW,
  });
  await study.syncCourseContext(principalId, TODAY, NOW);
  const practice = await study.createPractice({
    principalId,
    courseId,
    mode: "quiz",
    source: { kind: "owner_topic", turnId, excerpt: "titration", observedAt: NOW.toISOString() },
    items: [{ question: "Name the topic", answer: "titration", sourceQuote: "titration" }],
    now: NOW,
  });
  const evidence = await env.DB.prepare(`SELECT evidence_id FROM school_study_evidence
    WHERE principal_id = ?1 ORDER BY evidence_id LIMIT 1`).bind(principalId).first<{ evidence_id: string }>();
  if (evidence === null) throw new Error("study_coach_evidence_fixture_missing");
  return {
    principalId, otherPrincipalId, turnId, laterTurnId, otherTurnId, voiceTurnId, courseId, factId,
    evidenceId: evidence.evidence_id,
    practiceItemId: practice[0]!.itemId,
  };
}

beforeAll(async () => {
  await applyStudyCoachMigration();
});

describe("study coach migration", () => {
  it("installs three private WITHOUT ROWID tables and every named guard", async () => {
    const tables = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'school_study_preferences', 'school_practice_items', 'school_study_evidence'
      ) ORDER BY name`).all<{ name: string; sql: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "school_practice_items", "school_study_evidence", "school_study_preferences",
    ]);
    for (const row of tables.results) expect(row.sql).toMatch(/WITHOUT ROWID$/u);
    const triggers = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND (name LIKE 'school_study_%' OR name LIKE 'school_practice_%')
      ORDER BY name`).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
      "school_practice_items_core_immutable",
      "school_practice_items_insert_guard",
      "school_practice_items_open_cap",
      "school_practice_items_reject_delete",
      "school_practice_items_source_guard",
      "school_practice_items_status_transition",
      "school_study_evidence_active_cap",
      "school_study_evidence_core_immutable",
      "school_study_evidence_insert_guard",
      "school_study_evidence_reject_delete",
      "school_study_evidence_source_guard",
      "school_study_evidence_status_transition",
      "school_study_preferences_core_immutable",
      "school_study_preferences_insert_guard",
      "school_study_preferences_reject_delete",
      "school_study_preferences_require_owner_turn_insert",
      "school_study_preferences_require_owner_turn_update",
    ]);
  });

  it("generic REPLACE and IGNORE sweep protects every new table and natural key", async () => {
    const item = await graph("replace");
    for (const table of ["school_study_preferences", "school_practice_items", "school_study_evidence"] as const) {
      await expect(env.DB.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}
        WHERE principal_id = ?1 LIMIT 1`).bind(item.principalId).run()).rejects.toThrow(/insert_conflict/u);
      await expect(env.DB.prepare(`INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}
        WHERE principal_id = ?1 LIMIT 1`).bind(item.principalId).run()).rejects.toThrow(/insert_conflict/u);
    }
    const other = await graph("replace-other");
    await expect(env.DB.prepare(`UPDATE OR REPLACE school_study_preferences
      SET principal_id = ?1 WHERE principal_id = ?2`).bind(
      other.principalId, item.principalId,
    ).run()).rejects.toThrow(/school_study_preference_core_immutable/u);
    const secondPractice = await new StudyCoachRepository(env.DB).createPractice({
      principalId: item.principalId,
      courseId: item.courseId,
      mode: "flashcard",
      source: { kind: "owner_topic", turnId: item.laterTurnId, excerpt: "moles", observedAt: LATER.toISOString() },
      items: [{ question: "Topic", answer: "moles", sourceQuote: "moles" }],
      now: LATER,
    });
    await expect(env.DB.prepare(`UPDATE OR REPLACE school_practice_items SET item_key = (
      SELECT item_key FROM school_practice_items WHERE principal_id = ?1 AND item_id = ?2
    ) WHERE principal_id = ?1 AND item_id = ?3`).bind(
      item.principalId, secondPractice[0]!.itemId, item.practiceItemId,
    ).run()).rejects.toThrow(/school_practice_item_core_immutable/u);
    await new StudyCoachRepository(env.DB).recordOwnerObservation({
      principalId: item.principalId,
      turnId: item.laterTurnId,
      courseId: item.courseId,
      topic: "moles",
      outcome: "wrong",
      evidenceText: "I got moles wrong",
      today: TODAY,
      now: LATER,
    });
    const secondEvidence = await env.DB.prepare(`SELECT evidence_id, source_key FROM school_study_evidence
      WHERE principal_id = ?1 AND evidence_id != ?2 ORDER BY evidence_id DESC LIMIT 1`)
      .bind(item.principalId, item.evidenceId).first<{ evidence_id: string; source_key: string }>();
    expect(secondEvidence).not.toBeNull();
    await expect(env.DB.prepare(`UPDATE OR REPLACE school_study_evidence SET source_key = ?1
      WHERE principal_id = ?2 AND evidence_id = ?3`).bind(
      secondEvidence!.source_key, item.principalId, item.evidenceId,
    ).run()).rejects.toThrow(/school_study_evidence_core_immutable/u);
  });

  it("school_study_preferences_require_owner_turn_insert rejects another principal and voice", async () => {
    const item = await graph("pref-insert");
    await expect(env.DB.prepare(`INSERT INTO school_study_preferences (
      principal_id, enabled, allowed_days_mask, quiet_start_minute, quiet_end_minute,
      source_turn_id, created_at, updated_at
    ) VALUES (?1, 1, 127, 1320, 420, ?2, ?3, ?3)`).bind(
      item.otherPrincipalId, item.turnId, NOW.toISOString(),
    ).run()).rejects.toThrow(/school_study_preference_owner_turn_invalid/u);
    await expect(env.DB.prepare(`UPDATE school_study_preferences SET source_turn_id = ?1
      WHERE principal_id = ?2`).bind(item.voiceTurnId, item.principalId).run())
      .rejects.toThrow(/school_study_preference_owner_turn_invalid/u);
  });

  it("school_study_preferences_core_immutable and reject_delete preserve lineage", async () => {
    const item = await graph("pref-core");
    await expect(env.DB.prepare(`UPDATE school_study_preferences SET created_at = ?1
      WHERE principal_id = ?2`).bind("2026-09-15T11:29:00.000Z", item.principalId).run())
      .rejects.toThrow(/school_study_preference_core_immutable/u);
    await expect(env.DB.prepare("DELETE FROM school_study_preferences WHERE principal_id = ?1")
      .bind(item.principalId).run()).rejects.toThrow(/school_study_preference_delete_forbidden/u);
  });

  it("school_practice_items_open_cap bounds unfinished quiz state", async () => {
    const item = await graph("practice-cap");
    const statements = Array.from({ length: 14 }, (_, index) => env.DB.prepare(`INSERT INTO school_practice_items (
      principal_id, item_id, item_key, practice_id, course_id, mode, position, question, answer,
      answer_support, source_kind, source_turn_id, source_fact_id, source_excerpt,
      source_observed_at, status, owner_answer, result, result_turn_id, answered_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, 'quiz', 1, ?6, 'titration', 'supported',
      'owner_topic', ?7, NULL, 'titration', ?8, 'open', NULL, NULL, NULL, NULL, ?8, ?8)`)
      .bind(item.principalId, newUlid(new Date(NOW.getTime() + index + 10)), `cap:${index}`,
        newUlid(new Date(NOW.getTime() + index + 100)), item.courseId, `Question ${index}`,
        item.turnId, NOW.toISOString()));
    await env.DB.batch(statements);
    await expect(env.DB.prepare(`INSERT INTO school_practice_items (
      principal_id, item_id, item_key, practice_id, course_id, mode, position, question, answer,
      answer_support, source_kind, source_turn_id, source_fact_id, source_excerpt,
      source_observed_at, status, owner_answer, result, result_turn_id, answered_at, created_at, updated_at
    ) VALUES (?1, ?2, 'cap:overflow', ?3, ?4, 'quiz', 1, 'Overflow', 'titration',
      'supported', 'owner_topic', ?5, NULL, 'titration', ?6, 'open', NULL, NULL, NULL, NULL, ?6, ?6)`)
      .bind(item.principalId, newUlid(LATER), newUlid(new Date(LATER.getTime() + 1)), item.courseId,
        item.turnId, LATER.toISOString()).run()).rejects.toThrow(/school_practice_item_limit_exceeded/u);
  });

  it("school_practice_items_source_guard binds course facts and owner turns", async () => {
    const item = await graph("practice-source");
    await expect(env.DB.prepare(`INSERT INTO school_practice_items (
      principal_id, item_id, item_key, practice_id, course_id, mode, position, question, answer,
      answer_support, source_kind, source_turn_id, source_fact_id, source_excerpt,
      source_observed_at, status, owner_answer, result, result_turn_id, answered_at, created_at, updated_at
    ) VALUES (?1, ?2, 'bad-source', ?3, ?4, 'flashcard', 1, 'Question', 'Answer',
      'uncertain', 'owner_topic', ?5, NULL, 'topic', ?6, 'shown', NULL, NULL, NULL, NULL, ?6, ?6)`)
      .bind(item.principalId, newUlid(LATER), newUlid(new Date(LATER.getTime() + 1)), item.courseId,
        item.otherTurnId, LATER.toISOString()).run()).rejects.toThrow(/school_practice_item_source_invalid/u);
    await expect(env.DB.prepare(`INSERT INTO school_practice_items (
      principal_id, item_id, item_key, practice_id, course_id, mode, position, question, answer,
      answer_support, source_kind, source_turn_id, source_fact_id, source_excerpt,
      source_observed_at, status, owner_answer, result, result_turn_id, answered_at, created_at, updated_at
    ) VALUES (?1, ?2, 'pre-answered', ?3, ?4, 'quiz', 1, 'Question', 'Answer',
      'uncertain', 'owner_topic', ?5, NULL, 'topic', ?6, 'answered', 'Answer', 'uncertain',
      ?7, ?6, ?6, ?6)`).bind(
      item.principalId, newUlid(new Date(LATER.getTime() + 2)), newUlid(new Date(LATER.getTime() + 3)),
      item.courseId, item.turnId, LATER.toISOString(), item.laterTurnId,
    ).run()).rejects.toThrow(/school_practice_item_source_invalid/u);
  });

  it("school_practice_items_core_immutable status_transition and reject_delete protect results", async () => {
    const item = await graph("practice-life");
    await expect(env.DB.prepare(`UPDATE school_practice_items SET question = 'Changed'
      WHERE principal_id = ?1 AND item_id = ?2`).bind(item.principalId, item.practiceItemId).run())
      .rejects.toThrow(/school_practice_item_core_immutable/u);
    await expect(env.DB.prepare(`UPDATE school_practice_items SET status = 'answered', owner_answer = 'x',
      result = 'wrong', result_turn_id = ?1, answered_at = ?2, updated_at = ?2
      WHERE principal_id = ?3 AND item_id = ?4`).bind(
      item.otherTurnId, LATER.toISOString(), item.principalId, item.practiceItemId,
    ).run()).rejects.toThrow(/school_practice_item_status_invalid/u);
    await expect(env.DB.prepare(`DELETE FROM school_practice_items
      WHERE principal_id = ?1 AND item_id = ?2`).bind(item.principalId, item.practiceItemId).run())
      .rejects.toThrow(/school_practice_item_delete_forbidden/u);
  });

  it("school_study_evidence_active_cap bounds each course", async () => {
    const item = await graph("evidence-cap");
    const statements = Array.from({ length: 24 }, (_, index) => env.DB.prepare(`INSERT INTO school_study_evidence (
      principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome, evidence_kind,
      evidence_text, confidence, source_turn_id, source_fact_id, source_practice_item_id,
      observed_at, practice_due_on, last_prompted_on, status, control_turn_id, controlled_at,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'uncertain', 'owner_statement', ?6, 'medium',
      ?7, NULL, NULL, ?8, ?9, NULL, 'active', NULL, NULL, ?8, ?8)`)
      .bind(item.principalId, newUlid(new Date(NOW.getTime() + index + 10)), `cap:${index}`,
        item.courseId, `topic ${index}`, `Topic ${index}`, item.turnId, NOW.toISOString(), TODAY));
    await env.DB.batch(statements);
    await expect(env.DB.prepare(`INSERT INTO school_study_evidence (
      principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome, evidence_kind,
      evidence_text, confidence, source_turn_id, source_fact_id, source_practice_item_id,
      observed_at, practice_due_on, last_prompted_on, status, control_turn_id, controlled_at,
      created_at, updated_at
    ) VALUES (?1, ?2, 'cap:overflow', ?3, 'overflow', 'Overflow', 'wrong', 'owner_statement',
      'Overflow', 'medium', ?4, NULL, NULL, ?5, ?6, NULL, 'active', NULL, NULL, ?5, ?5)`)
      .bind(item.principalId, newUlid(LATER), item.courseId, item.turnId, LATER.toISOString(), TODAY).run())
      .rejects.toThrow(/school_study_evidence_limit_exceeded/u);
  });

  it("school_study_evidence_source_guard binds every source to the same owner and course", async () => {
    const item = await graph("evidence-source");
    await expect(env.DB.prepare(`INSERT INTO school_study_evidence (
      principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome, evidence_kind,
      evidence_text, confidence, source_turn_id, source_fact_id, source_practice_item_id,
      observed_at, practice_due_on, last_prompted_on, status, control_turn_id, controlled_at,
      created_at, updated_at
    ) VALUES (?1, ?2, 'bad-source', ?3, 'topic', 'Topic', 'wrong', 'owner_statement',
      'Evidence', 'medium', ?4, NULL, NULL, ?5, ?6, NULL, 'active', NULL, NULL, ?5, ?5)`)
      .bind(item.principalId, newUlid(LATER), item.courseId, item.otherTurnId, LATER.toISOString(), TODAY).run())
      .rejects.toThrow(/school_study_evidence_source_invalid/u);
    await expect(env.DB.prepare(`INSERT INTO school_study_evidence (
      principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome, evidence_kind,
      evidence_text, confidence, source_turn_id, source_fact_id, source_practice_item_id,
      observed_at, practice_due_on, last_prompted_on, status, control_turn_id, controlled_at,
      created_at, updated_at
    ) VALUES (?1, ?2, 'pre-corrected', ?3, 'topic', 'Topic', 'wrong', 'owner_statement',
      'Evidence', 'medium', ?4, NULL, NULL, ?5, ?6, NULL, 'corrected', ?7, ?5, ?5, ?5)`)
      .bind(item.principalId, newUlid(new Date(LATER.getTime() + 4)), item.courseId,
        item.turnId, LATER.toISOString(), TODAY, item.laterTurnId).run())
      .rejects.toThrow(/school_study_evidence_source_invalid/u);
  });

  it("school_study_evidence_core_immutable status_transition and reject_delete protect evidence", async () => {
    const item = await graph("evidence-life");
    await expect(env.DB.prepare(`UPDATE school_study_evidence SET topic = 'Changed'
      WHERE principal_id = ?1 AND evidence_id = ?2`).bind(item.principalId, item.evidenceId).run())
      .rejects.toThrow(/school_study_evidence_core_immutable/u);
    await expect(env.DB.prepare(`UPDATE school_study_evidence SET status = 'forgotten',
      control_turn_id = ?1, controlled_at = ?2, updated_at = ?2
      WHERE principal_id = ?3 AND evidence_id = ?4`).bind(
      item.otherTurnId, LATER.toISOString(), item.principalId, item.evidenceId,
    ).run()).rejects.toThrow(/school_study_evidence_status_invalid/u);
    await expect(env.DB.prepare(`DELETE FROM school_study_evidence
      WHERE principal_id = ?1 AND evidence_id = ?2`).bind(item.principalId, item.evidenceId).run())
      .rejects.toThrow(/school_study_evidence_delete_forbidden/u);
  });
});

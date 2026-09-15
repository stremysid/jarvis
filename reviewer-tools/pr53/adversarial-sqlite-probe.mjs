// Executes the real 0023 migration and the repository SQL copied verbatim from
// study-coach-repository.ts at 30ec39e against stub parent tables in node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(new URL("./src/0023_study_coach.sql", import.meta.url), "utf8");
let counter = 0;
const ulid = () => `01k5fb9pg00000000000${String(++counter).padStart(6, "0")}`;
const NOW = "2026-09-15T11:30:00.000Z";
const TODAY = "2026-09-15";

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE principals (principal_id TEXT PRIMARY KEY);
    CREATE TABLE conversation_turns (turn_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, channel TEXT NOT NULL);
    CREATE TABLE school_course_cards (principal_id TEXT NOT NULL, course_id TEXT NOT NULL, course_name TEXT NOT NULL,
      course_key TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (principal_id, course_id));
    CREATE TABLE school_course_facts (principal_id TEXT NOT NULL, course_id TEXT NOT NULL, fact_id TEXT NOT NULL,
      fact_kind TEXT NOT NULL, statement TEXT NOT NULL, evidence_source TEXT NOT NULL, observed_at TEXT NOT NULL,
      status TEXT NOT NULL, PRIMARY KEY (principal_id, fact_id));`);
  db.exec(MIGRATION);
  return db;
}
function turn(db, p) { const t = ulid(); db.prepare("INSERT INTO conversation_turns VALUES (?1, ?2, 'telegram')").run(t, p); return t; }
function setup(db, name = "Chemistry", active = 1) {
  const p = `principal:${ulid()}`;
  db.prepare("INSERT INTO principals VALUES (?1)").run(p);
  const c = ulid();
  db.prepare("INSERT INTO school_course_cards VALUES (?1, ?2, ?3, lower(?3), ?4)").run(p, c, name, active);
  return { p, c };
}
function batch(db, fns) {
  db.exec("BEGIN");
  try { for (const f of fns) f(); db.exec("COMMIT"); return "ok"; }
  catch (e) { db.exec("ROLLBACK"); return e.message; }
}

const SYNC_SELECT = `WITH missing AS (
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
          ))))`;
const SYNC_INSERT = `INSERT INTO school_study_evidence (
          principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome,
          evidence_kind, evidence_text, confidence, source_turn_id, source_fact_id,
          source_practice_item_id, observed_at, practice_due_on, last_prompted_on,
          status, control_turn_id, controlled_at, created_at, updated_at
        ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'uncertain', 'course_context', ?6, 'low',
          NULL, ?7, NULL, ?8, ?9, NULL, 'active', NULL, NULL, ?10, ?10
        WHERE NOT EXISTS (
          SELECT 1 FROM school_study_evidence WHERE principal_id = ?1 AND source_key = ?3
        )`;
const OBS_INSERT = `INSERT INTO school_study_evidence (
        principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome,
        evidence_kind, evidence_text, confidence, source_turn_id, source_fact_id,
        source_practice_item_id, observed_at, practice_due_on, last_prompted_on,
        status, control_turn_id, controlled_at, created_at, updated_at
      ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'owner_statement', ?8, 'medium', ?9,
        NULL, NULL, ?10, ?11, NULL, 'active', NULL, NULL, ?10, ?10
      WHERE NOT EXISTS (
        SELECT 1 FROM school_study_evidence WHERE principal_id = ?1 AND source_key = ?3
      )`;
const ITEM_INSERT = `INSERT INTO school_practice_items (
        principal_id, item_id, item_key, practice_id, course_id, mode, position,
        question, answer, answer_support, source_kind, source_turn_id, source_fact_id,
        source_excerpt, source_observed_at, status, owner_answer, result, result_turn_id,
        answered_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
        ?14, ?15, ?16, NULL, NULL, NULL, NULL, ?17, ?17)`;
const ANSWER_UPDATE = `UPDATE school_practice_items
        SET status = 'answered', owner_answer = ?1, result = ?2, result_turn_id = ?3,
          answered_at = ?4, updated_at = ?4
        WHERE principal_id = ?5 AND item_id = ?6 AND status = 'open'`;
const ANSWER_EVIDENCE = `INSERT INTO school_study_evidence (
        principal_id, evidence_id, source_key, course_id, topic_key, topic, outcome,
        evidence_kind, evidence_text, confidence, source_turn_id, source_fact_id,
        source_practice_item_id, observed_at, practice_due_on, last_prompted_on,
        status, control_turn_id, controlled_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'practice_result', ?8, ?9, ?10,
        NULL, ?11, ?12, ?13, NULL, 'active', NULL, NULL, ?12, ?12)`;
const CLAIM = `UPDATE school_study_evidence
      SET last_prompted_on = ?1, updated_at = ?2
      WHERE principal_id = ?3 AND evidence_id = (
        SELECT e.evidence_id FROM school_study_evidence e
        LEFT JOIN school_course_facts f
          ON f.principal_id = e.principal_id AND f.fact_id = e.source_fact_id
        WHERE e.principal_id = ?3 AND e.status = 'active'
          AND e.outcome IN ('uncertain', 'wrong') AND e.practice_due_on <= ?1
          AND (e.last_prompted_on IS NULL OR e.last_prompted_on < e.practice_due_on)
          AND NOT EXISTS (
            SELECT 1 FROM school_study_evidence prompted
            WHERE prompted.principal_id = ?3 AND prompted.last_prompted_on = ?1
          )
          AND (e.evidence_kind != 'course_context' OR f.status = 'active')
        ORDER BY e.practice_due_on, CASE e.outcome WHEN 'wrong' THEN 0 ELSE 1 END,
          e.observed_at DESC, e.evidence_id LIMIT 1
      )
      RETURNING principal_id, evidence_id, course_id, topic_key, topic, outcome,
        evidence_kind, evidence_text, confidence, observed_at, practice_due_on,
        last_prompted_on`;
const COUNT = `SELECT COUNT(*) AS count
      FROM school_study_evidence e
      LEFT JOIN school_course_facts f
        ON f.principal_id = e.principal_id AND f.fact_id = e.source_fact_id
      WHERE e.principal_id = ?1 AND e.course_id = ?2 AND e.topic_key = ?3
        AND e.status = 'active'
        AND (e.evidence_kind != 'course_context' OR f.status = 'active')`;

function observe(db, p, c, topic, outcome, due = TODAY) {
  const t = turn(db, p);
  db.prepare(OBS_INSERT).run(p, ulid(), `turn:${t}`, c, topic.toLowerCase(), topic, outcome, `I found ${topic} ${outcome}`, t, NOW, due);
}
function makeQuiz(db, p, c, answers, support) {
  const t = turn(db, p);
  const practice = ulid();
  db.prepare("UPDATE school_practice_items SET status = 'dismissed', updated_at = ?1 WHERE principal_id = ?2 AND status = 'open'").run(NOW, p);
  return answers.map((answer, i) => {
    const item = ulid();
    db.prepare(ITEM_INSERT).run(p, item, `${practice}:${i + 1}`, practice, c, "quiz", i + 1, `Q${i + 1}?`, answer,
      support, "owner_topic", t, null, "photosynthesis", NOW, "open", NOW);
    return item;
  });
}
function answer(db, p, c, item, result, support) {
  const t = turn(db, p);
  return batch(db, [
    () => db.prepare(ANSWER_UPDATE).run("my answer", result, t, NOW, p, item),
    () => db.prepare(ANSWER_EVIDENCE).run(p, ulid(), `practice:${item}`, c, "photosynthesis", "photosynthesis", result,
      "my answer", support === "supported" ? "medium" : "low", t, item, NOW, TODAY),
  ]);
}

console.log("== S1: per-course evidence cap -> quiz answer fails, quiz stays open ==");
{
  const db = fresh(); const { p, c } = setup(db);
  for (let i = 0; i < 16; i++) db.prepare("INSERT INTO school_course_facts VALUES (?1, ?2, ?3, ?4, ?5, 'owner_reported', ?6, 'active')")
    .run(p, c, ulid(), i % 2 ? "due_work" : "weak_area", `Fact ${i} essay due Friday`, `2026-09-1${i % 5}T10:00:00.000Z`);
  const rows = db.prepare(SYNC_SELECT).all(p);
  batch(db, rows.map((r) => () => db.prepare(SYNC_INSERT).run(p, ulid(), `fact:${r.fact_id}`, r.course_id, r.statement.toLowerCase(), r.statement, r.fact_id, r.observed_at, TODAY, NOW)));
  console.log("course_context synced:", rows.length, "kinds:", [...new Set(rows.map((r) => r.fact_kind))].join(","));
  for (let i = 0; i < 8; i++) observe(db, p, c, `topic ${i}`, "uncertain");
  console.log("active evidence:", db.prepare("SELECT COUNT(*) n FROM school_study_evidence WHERE principal_id = ?1 AND status = 'active'").get(p).n);
  const items = makeQuiz(db, p, c, ["chlorophyll", "light", "glucose"], "uncertain");
  console.log("answer batch:", answer(db, p, c, items[0], "uncertain", "uncertain"));
  console.log("open items after failed answer:", db.prepare("SELECT COUNT(*) n FROM school_practice_items WHERE principal_id = ?1 AND status = 'open'").get(p).n);
  try { observe(db, p, c, "another topic", "wrong"); console.log("observation: ok"); } catch (e) { console.log("observation:", e.message); }
}

console.log("\n== S2: digest evidenceCount counts easy points ==");
{
  const db = fresh(); const { p, c } = setup(db);
  observe(db, p, c, "photosynthesis", "uncertain");
  observe(db, p, c, "photosynthesis", "easy", "2026-09-22");
  observe(db, p, c, "photosynthesis", "easy", "2026-09-22");
  const row = db.prepare(CLAIM).get(TODAY, NOW, p);
  const count = db.prepare(COUNT).get(p, c, row.topic_key).count;
  const confidence = count >= 3 ? "high" : count >= 2 ? "medium" : "low";
  console.log(`claimed ${row.outcome} '${row.topic}', evidenceCount=${count}, digest confidence=${confidence}; summariseTopic would give weakSignals=1 easy=2 -> tentative/low`);
}

console.log("\n== S3: three answered 'uncertain' quiz items on a correct answer -> high confidence ==");
{
  const db = fresh(); const { p, c } = setup(db);
  const items = makeQuiz(db, p, c, ["chlorophyll", "carbon dioxide", "glucose"], "uncertain");
  for (const it of items) console.log("answer:", answer(db, p, c, it, "uncertain", "uncertain"));
  const row = db.prepare(CLAIM).get(TODAY, NOW, p);
  const count = db.prepare(COUNT).get(p, c, row.topic_key).count;
  console.log(`digest: '${row.topic}' ${count} evidence points, ${count >= 3 ? "high" : count >= 2 ? "medium" : "low"} confidence`);
}

console.log("\n== S4: inactive course card -> claim commits then repository throws ==");
{
  const db = fresh(); const { p, c } = setup(db, "Dropped course", 0);
  observe(db, p, c, "old topic", "wrong");
  const row = db.prepare(CLAIM).get(TODAY, NOW, p);
  const course = db.prepare("SELECT principal_id, course_id, course_name FROM school_course_cards WHERE principal_id = ?1 AND course_id = ?2 AND active = 1").get(p, row.course_id);
  console.log("claimed row:", row.topic, "course lookup:", course ?? null, "-> repository throws school_study_course_invalid");
  console.log("last_prompted_on persisted:", db.prepare("SELECT last_prompted_on FROM school_study_evidence WHERE evidence_id = ?1").get(row.evidence_id).last_prompted_on);
}

console.log("\n== S5: flashcards reply length vs Telegram 4096 ==");
{
  const card = (pos, q, a, course, excerpt, supported) => `${pos}. ${q}\n${supported ? `Answer: ${a}` : `Uncertain answer — the cited source does not support this: ${a}`}\nSource: ${course} course-card evidence (2026-09-15): “${excerpt}”`;
  const build = (qLen, aLen, exLen, courseLen, supported) => {
    const course = "C".repeat(courseLen);
    return [`Flashcards — ${course}`, ...[1, 2, 3].map((i) => card(i, "q".repeat(qLen), "a".repeat(aLen), course, "e".repeat(exLen), supported))].join("\n\n");
  };
  console.log("max fields (512/512/512/160, uncertain):", build(512, 512, 512, 160, false).length);
  console.log("course-card 480-char statement, 200-char q, 150-char a:", build(200, 150, 480, 20, false).length);
  console.log("course-card 300-char statement, 150-char q, 100-char a:", build(150, 100, 300, 20, true).length);
}

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const SQL = readFileSync(process.argv[2], "utf8");
const P = "owner";
const id = (p, n) => ("0" + (p + String(n).padStart(24, "0"))).slice(0, 26).replace(/[^0-9a-hjkmnp-tv-z]/g, "1").replace(/^./, "0");
const CID = id("c", 1);
const TID = id("t", 1);
const ts = (n) => new Date(Date.UTC(2026, 8, 15, 12, 0, 0, n)).toISOString();

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys=ON");
  d.exec("CREATE TABLE principals(principal_id TEXT PRIMARY KEY);"
    + "CREATE TABLE conversation_turns(turn_id TEXT PRIMARY KEY, principal_id TEXT, channel TEXT);"
    + "CREATE TABLE school_course_cards(principal_id TEXT, course_id TEXT, course_name TEXT, course_key TEXT,"
    + " active INTEGER, PRIMARY KEY(principal_id, course_id));"
    + "CREATE TABLE school_course_facts(principal_id TEXT, fact_id TEXT, course_id TEXT, fact_kind TEXT,"
    + " statement TEXT, evidence_source TEXT, observed_at TEXT, status TEXT, PRIMARY KEY(principal_id, fact_id));");
  d.exec(SQL);
  d.prepare("INSERT INTO principals VALUES(?)").run(P);
  d.prepare("INSERT INTO conversation_turns VALUES(?,?,?)").run(TID, P, "telegram");
  d.prepare("INSERT INTO school_course_cards VALUES(?,?,?,?,1)").run(P, CID, "Chemistry", "chem");
  return d;
}
function ev(d, n, kind, outcome, observed) {
  d.prepare("INSERT INTO school_study_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,'active',NULL,NULL,?,?)")
    .run(P, id("e", n), "turn:" + n, CID, "unit 2 factoring", "Unit 2 factoring", outcome ?? "uncertain",
      kind ?? "owner_statement", "text " + n, "medium", TID, observed ?? ts(n), "2026-09-15",
      observed ?? ts(n), observed ?? ts(n));
}
const NOW = ts(500);
const CUTOFF = new Date(Date.UTC(2026, 7, 16)).toISOString();
const RETIRE = [
  ["UPDATE school_study_evidence SET status='superseded', updated_at=?1 WHERE principal_id=?2"
    + " AND status='active' AND evidence_kind!='course_context' AND observed_at<?3", [NOW, P, CUTOFF]],
  ["UPDATE school_study_evidence SET status='superseded', updated_at=?1 WHERE principal_id=?2 AND evidence_id IN ("
    + " SELECT candidate.evidence_id FROM school_study_evidence candidate WHERE candidate.principal_id=?2"
    + " AND candidate.course_id=?3 AND candidate.status='active' AND candidate.evidence_kind!='course_context'"
    + " ORDER BY candidate.observed_at, candidate.evidence_id"
    + " LIMIT max(0,(SELECT COUNT(*) FROM school_study_evidence active WHERE active.principal_id=?2"
    + " AND active.course_id=?3 AND active.status='active' AND active.evidence_kind!='course_context')-23))", [NOW, P, CID]],
  ["UPDATE school_study_evidence SET status='superseded', updated_at=?1 WHERE principal_id=?2 AND evidence_id IN ("
    + " SELECT candidate.evidence_id FROM school_study_evidence candidate WHERE candidate.principal_id=?2"
    + " AND candidate.status='active' AND candidate.evidence_kind!='course_context'"
    + " ORDER BY candidate.observed_at, candidate.evidence_id"
    + " LIMIT max(0,(SELECT COUNT(*) FROM school_study_evidence active WHERE active.principal_id=?2"
    + " AND active.status='active' AND active.evidence_kind!='course_context')-95))", [NOW, P]],
];
const activeCount = (d) => d.prepare("SELECT COUNT(*) c FROM school_study_evidence WHERE status='active'"
  + " AND evidence_kind!='course_context'").get().c;

console.log("=== S1: course at the 24 cap, then the answerActiveQuiz retirement + insert ===");
{
  const d = db();
  for (let n = 1; n <= 24; n += 1) ev(d, n);
  let naked = "";
  try { ev(d, 99); naked = "INSERTED"; } catch (e) { naked = "ABORT " + e.message.split(":").pop().trim(); }
  console.log("  active=" + activeCount(d) + "; naked 25th insert -> " + naked);
  try { for (const [s, b] of RETIRE) d.prepare(s).run(...b); console.log("  retirement statements ran under the 0023 triggers: OK"); }
  catch (e) { console.log("  retirement ABORT: " + e.message); }
  console.log("  active after retirement = " + activeCount(d));
  try { ev(d, 99); console.log("  new evidence after retirement -> INSERTED (H2 unwedged)"); }
  catch (e) { console.log("  new evidence after retirement -> ABORT " + e.message.split(":").pop().trim()); }
}

console.log("\n=== S2: an unsupported (owner-topic) answer retires but inserts nothing ===");
{
  const d = db();
  for (let n = 1; n <= 24; n += 1) ev(d, n);
  for (const [s, b] of RETIRE) d.prepare(s).run(...b);
  const r = d.prepare("SELECT status, COUNT(*) c FROM school_study_evidence GROUP BY status").all();
  console.log("  statuses after the retirement half of answerActiveQuiz, with no evidence insert: " + JSON.stringify(r));
}

console.log("\n=== S3: claimDigestCheckIn easy_count ===");
{
  const d = db();
  for (let n = 1; n <= 3; n += 1) ev(d, n, "owner_statement", "uncertain");
  for (let n = 10; n <= 14; n += 1) ev(d, n, "owner_statement", "easy");
  const row = d.prepare("SELECT COUNT(*) FILTER (WHERE e.outcome IN ('uncertain','wrong')) AS weak_count,"
    + " COUNT(*) FILTER (WHERE e.outcome='easy') AS easy_count"
    + " FROM school_study_evidence e LEFT JOIN school_course_facts f"
    + " ON f.principal_id=e.principal_id AND f.fact_id=e.source_fact_id"
    + " WHERE e.principal_id=?1 AND e.course_id=?2 AND e.topic_key=?3 AND e.status='active'"
    + " AND e.outcome IN ('uncertain','wrong') AND (e.evidence_kind!='course_context' OR f.status='active')")
    .get(P, CID, "unit 2 factoring");
  const judge = (w, ea) => (w >= 3 && w > ea) ? "strong" : (w >= 2 && w > ea) ? "supported" : "tentative";
  const conf = (j) => j === "strong" ? "high" : j === "supported" ? "medium" : "low";
  console.log("  topic has 3 uncertain + 5 easy active points");
  console.log("  query returns weak_count=" + row.weak_count + " easy_count=" + row.easy_count);
  console.log("  digest check-in confidence = " + conf(judge(row.weak_count, row.easy_count))
    + "   |   summariseTopic confidence = " + conf(judge(3, 5)));
}

console.log("\n=== S4: direct inserts and the new status transitions ===");
{
  const d = db();
  d.prepare("INSERT INTO school_course_facts VALUES(?,?,?,?,?,?,?,?)")
    .run(P, id("f", 1), CID, "weak_area", "Weak on Unit 2 factoring (58%)", "owner_reported", ts(1), "active");
  const attempt = (label, fn) => {
    try { fn(); console.log("  " + label.padEnd(50) + " -> ALLOWED"); }
    catch (e) { console.log("  " + label.padEnd(50) + " -> blocked (" + e.message.split(":").pop().trim() + ")"); }
  };
  attempt("practice item inserted straight as 'answered'", () =>
    d.prepare("INSERT INTO school_practice_items VALUES(?,?,?,?,?,'quiz',1,'q','a','supported','owner_topic',?,NULL,'src',?,'answered','mine','easy',?,?,?,?)")
      .run(P, id("i", 1), "k1", id("p", 1), CID, TID, ts(1), TID, ts(1), ts(1), ts(1)));
  attempt("practice item inserted as 'dismissed'", () =>
    d.prepare("INSERT INTO school_practice_items VALUES(?,?,?,?,?,'quiz',1,'q','a','supported','owner_topic',?,NULL,'src',?,'dismissed',NULL,NULL,NULL,NULL,?,?)")
      .run(P, id("i", 2), "k2", id("p", 2), CID, TID, ts(1), ts(1), ts(1)));
  attempt("flashcard inserted as 'open'", () =>
    d.prepare("INSERT INTO school_practice_items VALUES(?,?,?,?,?,'flashcard',1,'q','a','supported','owner_topic',?,NULL,'src',?,'open',NULL,NULL,NULL,NULL,?,?)")
      .run(P, id("i", 3), "k3", id("p", 3), CID, TID, ts(1), ts(1), ts(1)));
  attempt("evidence inserted already 'forgotten'", () =>
    d.prepare("INSERT INTO school_study_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,'forgotten',?,?,?,?)")
      .run(P, id("e", 50), "turn:50", CID, "k", "K", "wrong", "owner_statement", "t", "medium", TID, ts(1), "2026-09-15", TID, ts(1), ts(1), ts(1)));
  attempt("evidence inserted already 'superseded'", () =>
    d.prepare("INSERT INTO school_study_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,'superseded',NULL,NULL,?,?)")
      .run(P, id("e", 51), "turn:51", CID, "k", "K", "wrong", "owner_statement", "t", "medium", TID, ts(1), "2026-09-15", ts(1), ts(1)));
  const d2 = db(); ev(d2, 1);
  attempt("active -> superseded", () => d2.prepare("UPDATE school_study_evidence SET status='superseded', updated_at=? WHERE principal_id=? AND evidence_id=?").run(ts(900), P, id("e", 1)));
  attempt("superseded -> active (un-retire)", () => d2.prepare("UPDATE school_study_evidence SET status='active', updated_at=? WHERE principal_id=? AND evidence_id=?").run(ts(901), P, id("e", 1)));
  attempt("superseded -> forgotten", () => d2.prepare("UPDATE school_study_evidence SET status='forgotten', control_turn_id=?, controlled_at=?, updated_at=? WHERE principal_id=? AND evidence_id=?").run(TID, ts(902), ts(902), P, id("e", 1)));
  const d3 = db();
  d3.prepare("INSERT INTO school_course_facts VALUES(?,?,?,?,?,?,?,?)")
    .run(P, id("f", 9), CID, "weak_area", "Weak on Unit 2", "owner_reported", ts(1), "active");
  d3.prepare("INSERT INTO school_study_evidence VALUES(?,?,?,?,?,?,'uncertain','course_context',?,'low',NULL,?,NULL,?,?,NULL,'active',NULL,NULL,?,?)")
    .run(P, id("e", 1), "fact:" + id("f", 9), CID, "weak on unit 2", "Weak on Unit 2", "Weak on Unit 2", id("f", 9), ts(1), "2026-09-15", ts(1), ts(1));
  attempt("course_context active -> superseded", () => d3.prepare("UPDATE school_study_evidence SET status='superseded', updated_at=? WHERE principal_id=? AND evidence_id=?").run(ts(900), P, id("e", 1)));
  const d4 = db(); ev(d4, 1);
  attempt("active -> superseded WITH a control turn", () => d4.prepare("UPDATE school_study_evidence SET status='superseded', control_turn_id=?, controlled_at=?, updated_at=? WHERE principal_id=? AND evidence_id=?").run(TID, ts(903), ts(903), P, id("e", 1)));
}

console.log("\n=== S5: sync budget vs the relaxed trigger cap ===");
{
  const d = db();
  for (let n = 1; n <= 24; n += 1) ev(d, n);
  for (let n = 1; n <= 3; n += 1) {
    d.prepare("INSERT INTO school_course_facts VALUES(?,?,?,?,?,?,?,?)")
      .run(P, id("f", n), CID, "weak_area", "weak fact " + n, "owner_reported", ts(n), "active");
  }
  const found = d.prepare("WITH missing AS (SELECT f.principal_id, f.course_id, f.fact_id,"
    + " ROW_NUMBER() OVER (PARTITION BY f.course_id ORDER BY f.observed_at DESC, f.fact_id DESC) AS course_rank,"
    + " (SELECT COUNT(*) FROM school_study_evidence e WHERE e.principal_id=f.principal_id"
    + " AND e.course_id=f.course_id AND e.status='active' AND (e.evidence_kind!='course_context' OR EXISTS ("
    + " SELECT 1 FROM school_course_facts af WHERE af.principal_id=e.principal_id AND af.fact_id=e.source_fact_id"
    + " AND af.status='active'))) AS active_course_count"
    + " FROM school_course_facts f WHERE f.principal_id=?1 AND f.status='active' AND f.fact_kind='weak_area'"
    + " AND NOT EXISTS (SELECT 1 FROM school_study_evidence ex WHERE ex.principal_id=f.principal_id"
    + " AND ex.source_key='fact:'||f.fact_id))"
    + " SELECT fact_id FROM missing WHERE course_rank <= 24 - active_course_count").all(P);
  console.log("  course has 24 active owner points and 3 unsynced weak_area facts");
  console.log("  the sync CTE would insert " + found.length + " of 3");
  let ok = 0;
  for (let n = 1; n <= 3; n += 1) {
    try {
      d.prepare("INSERT INTO school_study_evidence VALUES(?,?,?,?,?,?,'uncertain','course_context',?,'low',NULL,?,NULL,?,?,NULL,'active',NULL,NULL,?,?)")
        .run(P, id("x", n), "fact:" + id("f", n), CID, "wf" + n, "weak fact " + n, "weak fact " + n, id("f", n), ts(n), "2026-09-15", ts(n), ts(n));
      ok += 1;
    } catch { /* capped */ }
  }
  console.log("  the 0023 cap trigger would have allowed " + ok + " of 3 (course_context is now exempt)");
}

console.log("\n=== S6: 0023 trigger inventory and remote-D1 form ===");
{
  const d = db();
  const t = d.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  console.log("  triggers created: " + t.length);
  console.log("  CASE expressions: " + (SQL.match(/\bCASE\b/gi) ?? []).length);
  console.log("  RAISE( total: " + (SQL.match(/RAISE\(/g) ?? []).length
    + "; SELECT RAISE( form: " + (SQL.match(/SELECT RAISE\(/g) ?? []).length);
  console.log("  OR REPLACE / OR IGNORE: " + (SQL.match(/OR\s+(?:REPLACE|IGNORE)/gi) ?? []).length);
  console.log("  insert-conflict guards: " + (SQL.match(/_insert_guard/g) ?? []).length);
}

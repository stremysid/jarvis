// Runs 0024 at 5e1a2ed on node:sqlite with stub parent tables and exercises its triggers.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("./tree/apps/cloud-gateway/src/persistence/migrations/0024_university_application_workflow.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`CREATE TABLE conversation_turns (turn_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, channel TEXT NOT NULL);
CREATE TABLE university_programs (principal_id TEXT NOT NULL, program_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (principal_id, program_id));`);
db.exec(sql);

const id = (n) => "01k5fb9pg" + "0".repeat(14) + String(n).padStart(3, "0");
const P = "principal:a";
const PROG = id(1);
const PROG2 = id(2);
const T1 = id(801), T2 = id(802), T3 = id(803), T4 = id(804), TV = id(805);
for (const t of [T1, T2, T3, T4]) db.prepare("INSERT INTO conversation_turns VALUES (?, ?, 'telegram')").run(t, P);
db.prepare("INSERT INTO conversation_turns VALUES (?, ?, 'voice')").run(TV, P);
db.prepare("INSERT INTO university_programs VALUES (?, ?, 1)").run(P, PROG);
db.prepare("INSERT INTO university_programs VALUES (?, ?, 1)").run(P, PROG2);

const C = "2026-09-15T18:00:00.000Z";
const L = (m) => `2026-09-15T18:${String(m).padStart(2, "0")}:00.000Z`;
function insert(n, { key, status = "not_started", program = PROG, turn = T1, verb = "INSERT" } = {}) {
  return db.prepare(`${verb} INTO university_application_items (principal_id, program_id, item_id, item_key, item_kind,
    item_label, item_status, due_date, verification_state, source_url, admission_cycle, verified_at, source_turn_id,
    submitted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'essay', ?, ?, NULL, 'unverified', NULL, NULL, NULL, ?, ?, ?, ?)`)
    .run(P, program, id(n), key ?? `essay | item ${n}`, `Item ${n}`, status, turn, status === "submitted_by_sid" ? C : null, C, C);
}
function attempt(name, fn, expectAbort) {
  let result;
  try { fn(); result = "ok"; } catch (error) { result = `abort: ${error.message}`; }
  const aborted = result !== "ok";
  console.log(`${aborted === expectAbort ? "ok  " : "FLAG"} | ${name.padEnd(78)} | ${result}`);
}
const row = (n) => db.prepare("SELECT item_status, submitted_at, due_date, verification_state, source_url, admission_cycle, verified_at, updated_at, source_turn_id FROM university_application_items WHERE item_id = ?").get(id(n));

insert(100);
attempt("INSERT OR REPLACE same primary key", () => insert(100, { verb: "INSERT OR REPLACE" }), true);
attempt("INSERT OR IGNORE same natural key, new item_id", () => insert(101, { key: "essay | item 100", verb: "INSERT OR IGNORE" }), true);
insert(102);
attempt("UPDATE OR REPLACE item_key onto another row's key", () => db.prepare("UPDATE OR REPLACE university_application_items SET item_key = 'essay | item 100', source_turn_id = ?, updated_at = ? WHERE item_id = ?").run(T2, L(1), id(102)), true);
attempt("UPDATE OR REPLACE item_id onto another row's id", () => db.prepare("UPDATE OR REPLACE university_application_items SET item_id = ?, source_turn_id = ?, updated_at = ? WHERE item_id = ?").run(id(100), T2, L(1), id(102)), true);
attempt("DELETE", () => db.prepare("DELETE FROM university_application_items WHERE item_id = ?").run(id(102)), true);
attempt("REPLACE via UPDATE OR REPLACE into program2 (FK/core)", () => db.prepare("UPDATE OR REPLACE university_application_items SET program_id = ?, source_turn_id = ?, updated_at = ? WHERE item_id = ?").run(PROG2, T2, L(1), id(102)), true);

// submitted flip-flop
db.prepare("UPDATE university_application_items SET item_status='submitted_by_sid', submitted_at=?, source_turn_id=?, updated_at=? WHERE item_id=?").run(L(2), T2, L(2), id(100));
attempt("submitted -> drafting, same source_turn_id", () => db.prepare("UPDATE university_application_items SET item_status='drafting', submitted_at=NULL, updated_at=? WHERE item_id=?").run(L(3), id(100)), true);
attempt("submitted: change submitted_at, same status", () => db.prepare("UPDATE university_application_items SET submitted_at=?, source_turn_id=?, updated_at=? WHERE item_id=?").run(L(9), T3, L(3), id(100)), true);
attempt("submitted: submitted_at earlier than created_at", () => db.prepare("UPDATE university_application_items SET submitted_at='2026-01-01T00:00:00.000Z', source_turn_id=?, updated_at=? WHERE item_id=?").run(T3, L(3), id(100)), true);
attempt("submitted -> drafting, new telegram turn (correction)", () => db.prepare("UPDATE university_application_items SET item_status='drafting', submitted_at=NULL, source_turn_id=?, updated_at=? WHERE item_id=?").run(T3, L(4), id(100)), false);
attempt("drafting -> submitted again with a fresh submitted_at (flip back)", () => db.prepare("UPDATE university_application_items SET item_status='submitted_by_sid', submitted_at=?, source_turn_id=?, updated_at=? WHERE item_id=?").run(L(5), T4, L(5), id(100)), false);
attempt("submitted -> drafting reusing an OLDER turn id (T1)", () => db.prepare("UPDATE university_application_items SET item_status='drafting', submitted_at=NULL, source_turn_id=?, updated_at=? WHERE item_id=?").run(T1, L(6), id(100)), false);
attempt("update with a voice-channel turn", () => db.prepare("UPDATE university_application_items SET source_turn_id=?, updated_at=? WHERE item_id=?").run(TV, L(7), id(100)), true);
attempt("updated_at backwards", () => db.prepare("UPDATE university_application_items SET source_turn_id=?, updated_at=? WHERE item_id=?").run(T2, L(0), id(100)), true);
attempt("updated_at unchanged on a status change", () => db.prepare("UPDATE university_application_items SET item_status='ready', source_turn_id=? WHERE item_id=?").run(T3, id(100)), false);

// verification drift
db.prepare("UPDATE university_application_items SET due_date='2027-02-01', verification_state='verified', source_url='https://uwaterloo.ca/aif', admission_cycle='2027', verified_at=?, source_turn_id=?, updated_at=? WHERE item_id=?").run(L(10), T2, L(10), id(102));
attempt("verified: change due_date keeping verified_at", () => db.prepare("UPDATE university_application_items SET due_date='2027-03-01', updated_at=? WHERE item_id=?").run(L(11), id(102)), true);
attempt("verified: change source_url and cycle keeping date and verified_at", () => db.prepare("UPDATE university_application_items SET source_url='https://evil.example/x', admission_cycle='2019', updated_at=? WHERE item_id=?").run(L(11), id(102)), true);
attempt("verified: backdate verified_at only", () => db.prepare("UPDATE university_application_items SET verified_at='2020-01-01T00:00:00.000Z', updated_at=? WHERE item_id=?").run(L(11), id(102)), true);
attempt("verified -> unverified, keep date, same turn (un-verify)", () => db.prepare("UPDATE university_application_items SET verification_state='unverified', verified_at=NULL, updated_at=? WHERE item_id=?").run(L(12), id(102)), false);
attempt("unverified keeps stale source_url/cycle", () => console.log("   row:", JSON.stringify(row(102))), false);

// retire / reactivate / caps
for (let n = 200; n < 231; n += 1) insert(n, { program: PROG2 });
insert(231, { program: PROG2, status: "not_needed_by_sid" });
attempt("program2: 32nd active item (31 active + 1 retired)", () => insert(232, { program: PROG2 }), false);
attempt("program2: reactivate retired item at 32 active", () => db.prepare("UPDATE university_application_items SET item_status='not_started', source_turn_id=?, updated_at=? WHERE item_id=?").run(T2, L(20), id(231)), true);
attempt("program2: insert active item before retiring one (batch order A)", () => insert(233, { program: PROG2 }), true);
attempt("program2: retire one, then insert (batch order B)", () => {
  db.prepare("UPDATE university_application_items SET item_status='not_needed_by_sid', source_turn_id=?, updated_at=? WHERE item_id=?").run(T2, L(21), id(200));
  insert(234, { program: PROG2 });
}, false);
attempt("program2: re-add a retired item's label as a new row", () => insert(235, { program: PROG2, key: "essay | item 231", status: "not_needed_by_sid" }), true);
attempt("retired -> submitted_by_sid with new turn (schema allows)", () => db.prepare("UPDATE university_application_items SET item_status='submitted_by_sid', submitted_at=?, source_turn_id=?, updated_at=? WHERE item_id=?").run(L(22), T3, L(22), id(200)), true);
let n = 300;
let historyAbort = null;
for (; n < 400; n += 1) {
  try { insert(n, { program: PROG2, status: "not_needed_by_sid" }); } catch (error) { historyAbort = `${n - 300} extra rows then ${error.message}`; break; }
}
console.log(`ok   | program2 history cap with retired inserts: ${historyAbort}`);
console.log(`     | program2 rows: ${db.prepare("SELECT COUNT(*) c FROM university_application_items WHERE program_id=?").get(PROG2).c}`);

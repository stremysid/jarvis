// End to end at 5e1a2ed: real parser -> real UniversityTrackerRepository -> real 0022 + 0024 SQL
// on node:sqlite through a minimal D1 shim. Parent tables principals/conversation_turns are stubs.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { parseOwnerUniversityPlan } from "./tree/apps/cloud-gateway/src/university/university-tracker-model.ts";
import { UniversityTrackerRepository } from "./tree/apps/cloud-gateway/src/university/university-tracker-repository.ts";
import { Redactor } from "./tree/apps/cloud-gateway/src/security/redaction.ts";
import { newUlid } from "./tree/packages/contracts/src/index.ts";

const migration = (name) => readFileSync(new URL(`./tree/apps/cloud-gateway/src/persistence/migrations/${name}`, import.meta.url), "utf8");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(`CREATE TABLE principals (principal_id TEXT PRIMARY KEY);
CREATE TABLE conversation_turns (turn_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, channel TEXT NOT NULL);`);
// Same splitting rule as test/persistence/migration.ts splitMigration.
function split(sql) {
  const triggers = [];
  const body = sql.replace(/(?:^[^\S\n]*--[^\n]*\n)*CREATE TRIGGER\b[\s\S]*?\nEND;/gimu, (t) => {
    triggers.push(t.slice(0, -1));
    return `__T_${triggers.length - 1}__;`;
  });
  return body.split(";").map((q) => q.trim()).filter(Boolean)
    .map((q) => { const k = /^__T_(\d+)__$/u.exec(q); return k ? triggers[Number(k[1])] : q; });
}
for (const name of ["0022_university_tracker.sql", "0024_university_application_workflow.sql"]) {
  for (const statement of split(migration(name))) {
    try { sqlite.exec(statement); } catch (error) {
      if (!/school_/u.test(statement)) throw error;
      console.log(`skipped school statement in ${name}: ${statement.split("\n")[0].slice(0, 90)} (${error.message})`);
    }
  }
}

class Statement {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.sql, params); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.params) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.params) ?? null; }
  async run() { sqlite.prepare(this.sql).run(...this.params); return { success: true }; }
}
const d1 = {
  prepare: (sql) => new Statement(sql),
  batch: async (statements) => {
    sqlite.exec("BEGIN");
    try { for (const s of statements) sqlite.prepare(s.sql).run(...s.params); sqlite.exec("COMMIT"); }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};

const P = "principal:owner";
sqlite.prepare("INSERT INTO principals VALUES (?)").run(P);
const repo = new UniversityTrackerRepository(d1);
const redactor = new Redactor();
let clock = Date.parse("2026-09-15T19:00:00.000Z");
const hash = (n) => String(n).padStart(64, "0");

async function turn(message, rawPlan, label) {
  clock += 60_000;
  const now = new Date(clock);
  const turnId = newUlid(now);
  sqlite.prepare("INSERT INTO conversation_turns VALUES (?, ?, 'telegram')").run(turnId, P);
  const snapshot = await repo.readSnapshot(P);
  const plan = typeof rawPlan === "function" ? rawPlan(snapshot) : rawPlan;
  let outcome;
  try {
    const parsed = parseOwnerUniversityPlan(plan, message, redactor, snapshot);
    await repo.applyOwnerPlan({ principalId: P, turnId, responseHash: hash(clock), plan: parsed, now });
    outcome = "saved";
  } catch (error) {
    outcome = `refused: ${error.message}`;
  }
  const rows = sqlite.prepare("SELECT item_label, item_status, due_date, verification_state, submitted_at IS NOT NULL AS has_submitted_at FROM university_application_items ORDER BY item_label").all();
  const digest = (await repo.listApplicationItemsByDueDate(P, 10)).map((i) => `${i.label}:${i.status}:${i.dueDate ?? "-"}:${i.verification.state}`);
  console.log(`\n[${label}] ${JSON.stringify(message)} -> ${outcome}`);
  console.log(`  rows:   ${rows.map((r) => `${r.item_label}=${r.item_status}${r.due_date ? `@${r.due_date}/${r.verification_state}` : ""}`).join(", ")}`);
  console.log(`  digest: ${digest.join(", ") || "(none)"}`);
}

const unverified = { state: "unverified", sourceUrl: null, cycle: null };
const program = (ref, university, programName) => ({
  programRef: ref, university, campus: null, programName, ouacCode: null,
  verification: unverified, addRequirements: [], addDates: [], resolveItemIds: [],
});
const newItem = (programRef, kind, label, message, n, dueDate = null) => ({
  itemRef: `new-item-${n}`, programRef, kind, label, status: "not_started", statusEvidence: message,
  dueDate: dueDate ?? { date: null, verification: unverified, evidence: message },
});
const programId = (snapshot, university) => snapshot.programs.find((p) => p.university === university).programId;
const itemId = (snapshot, label) => snapshot.programs.flatMap((p) => p.applicationItems).find((i) => i.label === label).itemId;
const statusUpdate = (snapshot, university, label, status, message, dueDate = null) => ({
  itemRef: itemId(snapshot, label), programRef: programId(snapshot, university), kind: null, label: null,
  status, statusEvidence: status === null ? null : message, dueDate,
});
const plan = (applicationUpdates, programUpdates = []) => ({ engaged: true, programUpdates, applicationUpdates });

let m = "Add Waterloo Computer Science, Western Medical Sciences and Queen's Commerce.";
await turn(m, plan([], [
  program("new-1", "Waterloo", "Computer Science"),
  program("new-2", "Western", "Medical Sciences"),
  program("new-3", "Queen's", "Commerce"),
]), "setup programs");

m = "Waterloo AIF due Feb 1, 2027 per https://uwaterloo.ca/aif for the 2027 cycle";
await turn(m, (s) => plan([newItem(programId(s, "Waterloo"), "supplementary_application", "Waterloo AIF", m, 1, {
  date: "2027-02-01", verification: { state: "verified", sourceUrl: "https://uwaterloo.ca/aif", cycle: "2027" }, evidence: m,
})]), "setup verified AIF");
m = "Add the Western essay";
await turn(m, (s) => plan([newItem(programId(s, "Western"), "essay", "Western essay", m, 1)]), "setup essay");
m = "Add the Queen's scholarship";
await turn(m, (s) => plan([newItem(programId(s, "Queen's"), "scholarship", "Queen's scholarship", m, 1)]), "setup scholarship");

m = "Don't remove the Queen's scholarship";
await turn(m, (s) => plan([statusUpdate(s, "Queen's", "Queen's scholarship", "not_needed_by_sid", m)]), "H2 negated retire");
m = "Keep the Queen's scholarship";
await turn(m, (s) => plan([statusUpdate(s, "Queen's", "Queen's scholarship", "submitted_by_sid", m)]), "H1a retired->submitted without a submission report");

m = "I submitted my Waterloo AIF and started the Western essay.";
await turn(m, (s) => plan([statusUpdate(s, "Western", "Western essay", "submitted_by_sid", m)]), "H1b cross-item submission");

m = "Is the Waterloo AIF due Feb 15, 2027?";
await turn(m, (s) => plan([statusUpdate(s, "Waterloo", "Waterloo AIF", null, m, {
  date: "2027-02-15", verification: unverified, evidence: "Feb 15, 2027",
})]), "M2 question overwrites verified date");

m = "I didn't actually submit the Western essay, the portal crashed";
await turn(m, (s) => plan([statusUpdate(s, "Western", "Western essay", "drafting", m)]), "correction natural wording");
m = "I didn't submit the Western essay";
await turn(m, (s) => plan([statusUpdate(s, "Western", "Western essay", "drafting", m)]), "correction exact wording");

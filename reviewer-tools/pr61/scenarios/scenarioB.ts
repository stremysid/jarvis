// Derivation replay wedge: one lost write after a committed derivation batch + a teacher due-date edit.
import { makeD1, seedBase, addDeadline } from "./d1shim.ts";
import { D1StatementBudget, SchoolObservationRepository } from "./school-observation-repository.ts";
import { runClassroomObservationSync } from "./classroom-observation-sync.ts";

const fault: { hook: ((sql: string) => void) | null } = { hook: null };
const { db, d1 } = makeD1(fault);
seedBase(db);
const P = "principal-sid", SRC = "google-classroom";
const X = addDeadline(db, "cA:w1", "Lab report", "2026-09-15T03:59:00.000Z");
const Y = addDeadline(db, "cA:w2", "Reading quiz", "2026-09-20T03:59:00.000Z");
let yState = "new";
const client = { async listSubmissionPage(courseId: string, token: string | null) {
  return { items: [
    { deadlineExternalId: "cA:w1", externalSubmissionId: "cA:w1:s1", state: "new", late: null, assignedGrade: null, sourceUpdatedAt: null },
    { deadlineExternalId: "cA:w2", externalSubmissionId: "cA:w2:s1", state: yState, late: null, assignedGrade: null, sourceUpdatedAt: null },
  ], rejected: 0, nextPageToken: null };
} };
const courses = [{ id: "cA", name: "Chemistry" }];
async function run(at: string) {
  const budget = new D1StatementBudget();
  const r = await runClassroomObservationSync({ repository: new SchoolObservationRepository(d1, budget), client: client as any, courses, principalId: P, sourceId: SRC, budget, now: () => new Date(at) });
  return r;
}
const sync = () => db.prepare("select scan_started_at,derivation_scan_at,derivation_after_deadline_id,last_success_at,last_failure from school_observation_sync").get();

// Run 1: derivation batch commits, then the completeDerivation write is lost (D1 transient error / isolate killed).
let fired = false;
fault.hook = (sql) => { if (!fired && /SET derivation_scan_at = NULL/.test(sql)) { fired = true; throw new Error("D1_ERROR: Network connection lost."); } };
console.log("run1", JSON.stringify(await run("2026-09-16T12:00:00.000Z")));
fault.hook = null;
console.log("after run1 sync row:", sync());
console.log("transitions:", db.prepare("select to_state,basis_due_at,derived_at from school_missing_work_transitions").all());

// Before the next hourly run, the teacher extends the lab report (Classroom deadline ingestion updates due_at).
db.prepare("UPDATE deadlines SET due_at = ? WHERE deadline_id = ?").run("2026-09-18T03:59:00.000Z", X);
// Sid also turns in the reading quiz during the outage.
yState = "turned_in";

const outcomes = new Map<string, number>();
for (let h = 1; h <= 72; h += 1) {
  const at = new Date(Date.parse("2026-09-16T12:00:00.000Z") + h * 3600e3).toISOString();
  const r = await run(at);
  const key = `${r.outcome}:${r.failure}:pages=${r.pages}`;
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}
console.log("72 hourly runs after the edit:", Object.fromEntries(outcomes));
console.log("sync row after 72h:", sync());
console.log("reading-quiz observation (Sid turned it in 72h ago):", db.prepare("select submission_state,last_seen_at from school_assignment_observations where deadline_id = ?").get(Y));

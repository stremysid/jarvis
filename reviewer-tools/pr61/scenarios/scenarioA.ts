// On-time submission reported as "no submission seen": evidence read BEFORE the deadline,
// derivation compares due_at with the scan COMPLETION time. Runs the real PR code.
import { makeD1, seedBase, addDeadline } from "./d1shim.ts";
import { D1StatementBudget, SchoolObservationRepository } from "./school-observation-repository.ts";
import { runClassroomObservationSync } from "./classroom-observation-sync.ts";

const { db, d1 } = makeD1();
seedBase(db);
const P = "principal-sid", SRC = "google-classroom";
const DUE = "2026-09-16T03:59:00.000Z"; // 23:59 America/Toronto on Sep 15
const X = addDeadline(db, "cA:w1", "Essay draft", DUE);

let xState = "NEW";
const client = {
  async listSubmissionPage(courseId: string, token: string | null) {
    if (courseId === "cA") return { items: [{ deadlineExternalId: "cA:w1", externalSubmissionId: "cA:w1:s1", state: xState === "NEW" ? "new" : "turned_in", late: xState === "NEW" ? null : false, assignedGrade: null, sourceUpdatedAt: null }], rejected: 0, nextPageToken: null };
    const order = [null, "t2", "t3", "t4", "t5"];
    const i = order.indexOf(token);
    return { items: [], rejected: 0, nextPageToken: order[i + 1] ?? null };
  },
};
const courses = [{ id: "cA", name: "Calculus" }, { id: "cB", name: "English" }];
async function run(at: string) {
  const budget = new D1StatementBudget();
  const r = await runClassroomObservationSync({ repository: new SchoolObservationRepository(d1, budget), client: client as any, courses, principalId: P, sourceId: SRC, budget, now: () => new Date(at) });
  console.log(at, "sync:", r.outcome, "pages", r.pages, "transitions", r.transitions, "failure", r.failure, "stmts", r.statementsUsed);
}
async function digest(at: string) {
  const s = await new SchoolObservationRepository(d1).readDigestSnapshot({ principalId: P, sourceId: SRC, changedSince: new Date(Date.parse(at) - 7 * 864e5), now: new Date(at) });
  for (const item of s.missingWork) console.log(`  DIGEST ${at}: [derived: no submission seen; Google Classroom scan ${item.derivedAt}] ${item.course}: ${item.title} (deadline passed ${item.dueAt})`);
  if (s.missingWork.length === 0) console.log(`  DIGEST ${at}: no missing-work lines`);
  console.log("  source lastSuccessAt", s.source?.lastSuccessAt, "lastFailure", s.source?.lastFailure);
}

await run("2026-09-16T03:00:00.000Z");   // reads cA (NEW, not yet due) + 3 pages of cB
xState = "TURNED_IN";                     // Sid turns it in at 03:30Z, 29 minutes before the deadline
console.log("-- Sid turns in at 2026-09-16T03:30:00.000Z (due", DUE + ")");
await run("2026-09-16T04:00:00.000Z");   // finishes cB, completes scan, derives
console.log("obs row:", db.prepare("select submission_state,last_seen_at from school_assignment_observations").all());
console.log("transitions:", db.prepare("select from_state,to_state,basis_due_at,derived_at from school_missing_work_transitions").all());
await digest("2026-09-16T04:05:00.000Z");
await run("2026-09-16T05:00:00.000Z");
console.log("obs row after 05:00 partial scan:", db.prepare("select submission_state,last_seen_at from school_assignment_observations").all());
await digest("2026-09-16T05:05:00.000Z");
await run("2026-09-16T06:00:00.000Z");
await digest("2026-09-16T06:05:00.000Z");

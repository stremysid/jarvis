// Worst-case D1 budget per slice + derivation paging correctness, real PR code.
import { makeD1, seedBase, addDeadline } from "./d1shim.ts";
import { D1StatementBudget, SchoolObservationRepository } from "./school-observation-repository.ts";
import { runClassroomObservationSync } from "./classroom-observation-sync.ts";
const { db, d1 } = makeD1();
seedBase(db);
const P = "principal-sid", SRC = "google-classroom";
const courses = ["c1", "c2", "c3", "c4"].map((id) => ({ id, name: id }));
for (const c of courses) for (let w = 1; w <= 25; w += 1) addDeadline(db, `${c.id}:w${w}`, `${c.id} work ${w}`, "2026-09-10T03:59:00.000Z");
let state = "new";
const client = { async listSubmissionPage(courseId: string) {
  return { items: Array.from({ length: 25 }, (_, i) => ({ deadlineExternalId: `${courseId}:w${i + 1}`, externalSubmissionId: `${courseId}:w${i + 1}:s`, state, late: state === "new" ? null : false, assignedGrade: state === "new" ? null : 70 + i, sourceUpdatedAt: null })), rejected: 0, nextPageToken: null };
} };
async function run(at: string) {
  const budget = new D1StatementBudget();
  const r = await runClassroomObservationSync({ repository: new SchoolObservationRepository(d1, budget), client: client as any, courses, principalId: P, sourceId: SRC, budget, now: () => new Date(at) });
  console.log(at, r.outcome, "pages", r.pages, "transitions", r.transitions, "stmts", r.statementsUsed, "failure", r.failure);
  const d = await new SchoolObservationRepository(d1).readDigestSnapshot({ principalId: P, sourceId: SRC, changedSince: new Date(Date.parse(at) - 7 * 864e5), now: new Date(Date.parse(at) + 60e3) });
  console.log("   digest missingWork lines:", d.missingWork.length, "(LIMIT 20)");
}
await run("2026-09-15T10:00:00.000Z");
await run("2026-09-15T11:00:00.000Z");
console.log("no_submission_seen transitions:", db.prepare("select count(*) n from school_missing_work_transitions where to_state='no_submission_seen'").get());
state = "turned_in";
await run("2026-09-16T10:00:00.000Z");
await run("2026-09-16T11:00:00.000Z");
console.log("latest state per deadline:", db.prepare(`select to_state, count(*) n from school_missing_work_transitions t where not exists (select 1 from school_missing_work_transitions l where l.deadline_id=t.deadline_id and l.derived_at>t.derived_at) group by to_state`).all());
console.log("total no_submission_seen in store:", db.prepare("select count(*) n from school_missing_work_transitions t where to_state='no_submission_seen' and not exists (select 1 from school_missing_work_transitions l where l.deadline_id=t.deadline_id and l.derived_at>t.derived_at)").get());

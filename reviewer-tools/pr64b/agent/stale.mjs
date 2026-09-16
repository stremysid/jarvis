import { freshDb, seedPrincipal, apply, program, appItem, wfNew, wfExisting, P, UniversityTrackerRepository } from "./repo.mjs";
import { run } from "./guards.mjs";
const d1 = freshDb(); seedPrincipal(d1);
let t = "Add Western University Computer Science and the Western essay, and prepare the Western essay submission for the Western essay.";
let s = await apply(d1, t, { programUpdates: [program("new-1", "Western University", "Computer Science")],
  applicationUpdates: [appItem("new-item-1", "new-1", "essay", "Western essay", "not_started", t)],
  workflowUpdates: [wfNew("new-workflow-1", "new-1", "new-item-1", "submission_step", "Western essay submission", "sid", "prepared", t)] });
const p = s.programs[0]; const step = p.workflowItems[0]; const essay = p.applicationItems[0];
t = "I submitted the Western essay.";
s = await apply(d1, t, { applicationUpdates: [{ itemRef: essay.itemId, programRef: p.programId, kind: null, label: null, status: "submitted_by_sid", statusEvidence: t, dueDate: null }] });
console.log("application item now:", s.programs[0].applicationItems[0].status);
const snap = s;
run("close the step from the same message", t, wfExisting(step.workflowId, p.programId, "owner_reported_done", t), snap);
console.log("digest still lists:", (await new UniversityTrackerRepository(d1).listWorkflowItemsByDueDate(P)).map((r) => `${r.label} [${r.status}]`));

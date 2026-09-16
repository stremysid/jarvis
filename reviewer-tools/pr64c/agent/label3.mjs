// Round-3: model-chosen offer labels no longer need Sid's words ("got into"/"accepted me") and may carry dates/verification.
import { parseOwnerUniversityPlan, isWorkflowLabelSafe } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as R2 from "../../pr64b/agent/head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import { freshDb, seedPrincipal, apply, program, wfNew, P, UniversityTrackerRepository } from "./repo.mjs";
import { compose } from "./head/apps/cloud-gateway/src/digest/digest-composer.ts";
import * as F from "./fixtures.mjs";

console.log("--- isWorkflowLabelSafe r3 vs r2");
for (const l of ["Waterloo offer: verified response deadline June 1, 2027", "Western essay due Jan 15", "Official OUAC deadline 2027-01-15", "Waterloo offer (confirmed, reply by June 1)"])
  console.log(`r3=${isWorkflowLabelSafe(l) ? "ok     " : "REFUSED"} r2=${R2.isWorkflowLabelSafe(l) ? "ok     " : "REFUSED"} | ${l}`);

const snap = F.snapshot({ sameProgramName: false, workflows: false });
const label = "Waterloo offer (confirmed, reply by June 1)";
for (const msg of ["I got into Waterloo!", "Waterloo accepted me"]) {
  const u = F.newUpdate(F.WATERLOO, "offer", label, "owner_reported_offered", msg, null, "university");
  for (const [n, fn] of [["r3", parseOwnerUniversityPlan], ["r2", R2.parseOwnerUniversityPlan]]) {
    try { const res = fn({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [u] }, msg, F.redactor, snap); console.log(`${n} ACCEPTED label ${JSON.stringify(res.workflowUpdates[0].label)} | Sid said ${JSON.stringify(msg)}`); }
    catch { console.log(`${n} refused | Sid said ${JSON.stringify(msg)}`); }
  }
}
const d1 = freshDb(); seedPrincipal(d1);
const s = await apply(d1, "Add University of Waterloo Computer Science.", { programUpdates: [program("new-1", "University of Waterloo", "Computer Science")] });
const msg = "I got into Waterloo!";
await apply(d1, msg, { workflowUpdates: [wfNew("new-workflow-1", s.programs[0].programId, null, "offer", label, "university", "owner_reported_offered", msg)] });
const rows = await new UniversityTrackerRepository(d1).listWorkflowItemsByDueDate(P);
const base = { catchupActions: [], applicationItems: [], deadlines: [], projects: [], decisions: [], gaps: [], grades: [], missingWork: [], missingWorkOmitted: 0, studyCheckIn: null };
const d = compose({ ...base, universityWorkflowItems: rows }, { kind: "daily", timeZone: "America/Toronto" }, { now: () => new Date(F.NOW) });
console.log("real repository + digest after Sid said", JSON.stringify(msg), ":\n" + d.text.split("\n").filter((l) => /Waterloo/u.test(l)).join("\n"));

import { supportsStatus, parseOwnerUniversityPlan } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as B from "./base/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";
const snap = F.snapshot({ sameProgramName: false }); const western = snap.programs[1];
console.log("--- PR #52 submitted_by_sid: reported speech with a titled name before 'I'");
for (const t of [
  "My counsellor told Ms. Lee I submitted the Western essay.",
  "Mom emailed Dr. Shah that I submitted the Western essay.",
  "The school told Mr. Chen I submitted the Western essay.",
  "My counsellor told Ms Lee I submitted the Western essay.",
]) {
  const h = supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap);
  const b = B.supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap);
  console.log(`head=${h ? "ACCEPTED" : "refused "} main=${b ? "accepted" : "refused "} | ${t}`);
}
console.log("--- same shape on workflow decisions/steps (round 2)");
function run(t, u) { try { parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [u] }, t, F.redactor, snap); console.log("ACCEPTED |", t); } catch { console.log("refused  |", t); } }
let t = "My counsellor told Ms. Lee I got an offer from Waterloo for Computer Science.";
run(t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
t = "Mom told Mr. Chen I paid the Waterloo AIF fee for the Waterloo AIF.";
run(t, F.existingUpdate(F.WF_AIF_PAY, F.WATERLOO, "owner_reported_done", t));

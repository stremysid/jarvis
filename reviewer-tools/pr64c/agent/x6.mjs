import { parseOwnerUniversityPlan } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";
const snap = F.snapshot({ sameProgramName: false });
for (const t of [
  "Email from Ms Lee: I emailed Ms Lee about the Ms Lee reference request for the Western reference.",
  "Forwarded message: I paid the Waterloo AIF fee for the Waterloo AIF.",
  "\"I paid the Waterloo AIF fee for the Waterloo AIF\"",
]) {
  const wf = /Lee/.test(t) ? F.WF_CONTACT : F.WF_AIF_PAY, prog = /Lee/.test(t) ? F.WESTERN : F.WATERLOO;
  try { parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [F.existingUpdate(wf, prog, "owner_reported_done", t)] }, t, F.redactor, snap); console.log("ACCEPTED |", t); } catch { console.log("refused  |", t); }
}

import { parseOwnerUniversityPlan as H } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import { parseOwnerUniversityPlan as R1 } from "./r1/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";
const snap = F.snapshot({ sameProgramName: false });
const ok = (fn, t, u) => { try { fn({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [u] }, t, F.redactor, snap); return "recorded"; } catch { return "refused "; } };
for (const [t, prog, wf, st] of [
  ["I got into Waterloo!!", F.WATERLOO, null, "owner_reported_offered"],
  ["Western accepted me", F.WESTERN, null, "owner_reported_offered"],
  ["I got my Waterloo offer", F.WATERLOO, null, "owner_reported_offered"],
  ["I got an offer from Waterloo!", F.WATERLOO, null, "owner_reported_offered"],
  ["I got a Waterloo CS offer", F.WATERLOO, null, "owner_reported_offered"],
  ["I received a Western offer.", F.WESTERN, null, "owner_reported_offered"],
  ["I got an offer from Waterloo for Computer Science! I hope Western is next.", F.WATERLOO, null, "owner_reported_offered"],
  ["Wait, I got an offer from Waterloo for Computer Science!", F.WATERLOO, null, "owner_reported_offered"],
  ["I emailed Ms. Lee about the Ms Lee reference request for the Western reference.", F.WESTERN, F.WF_CONTACT, "owner_reported_done"],
  ["I asked my mom to email Ms Lee about the Ms Lee reference request for the Western reference.", F.WESTERN, F.WF_CONTACT, "owner_reported_done"],
  ["I wish I got an offer from Waterloo for Computer Science.", F.WATERLOO, null, "owner_reported_offered"],
]) {
  const u = wf === null ? F.newUpdate(prog, "offer", "offer", st, t) : F.existingUpdate(wf, prog, st, t);
  console.log(`head=${ok(H, t, u)} r1=${ok(R1, t, u)} | ${t}`);
}

// Round-3 N2: PR #52 strictness (weaker than main?) and offer-kind negation after OFFER_NEGATION replaced NEGATION.
import { supportsStatus, parseOwnerUniversityPlan } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as R2 from "../../pr64b/agent/head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as B from "./base/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";
const snap = F.snapshot({ sameProgramName: false }); const western = snap.programs[1];
console.log("--- #52 submitted_by_sid: should refuse (someone else's report, retraction or doubt)");
for (const t of [
  "My sister told me I submitted the Western essay.",
  "Priya told me I submitted the Western essay.",
  "My brother wrote that I submitted the Western essay.",
  "My friend sent me a text saying I submitted the Western essay.",
  "I submitted the Western essay. Wait, I'm not sure it uploaded.",
  "I submitted the Western essay. Actually, let me check the portal first.",
  "I submitted the Western essay, I think.",
  "I submitted the Western essay, I hope.",
  "Grandma asked me whether I submitted the Western essay.",
]) {
  const h = supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap);
  const r = R2.supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap);
  const b = B.supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap);
  console.log(`r3=${h ? "ACCEPTED" : "refused "} r2=${r ? "accepted" : "refused "} main=${b ? "accepted" : "refused "} | ${t}`);
}
function run(t, u) {
  const one = (fn) => { try { const r = fn({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [u] }, t, F.redactor, snap); return `ACCEPTED ${r.workflowUpdates[0].status}`; } catch { return "refused"; } };
  console.log(`r3=${one(parseOwnerUniversityPlan).padEnd(34)} r2=${one(R2.parseOwnerUniversityPlan).padEnd(34)} | ${t}`);
}
console.log("--- offer-kind negation (OFFER_NEGATION replaces NEGATION for offer, offer_condition, offer_response)");
for (const [t, kind, label, status] of [
  ["I completed the Waterloo condition form but haven't submitted it.", "offer_condition", "Waterloo condition", "owner_reported_satisfied"],
  ["I met the Waterloo condition in math but didn't in chem.", "offer_condition", "Waterloo condition", "owner_reported_satisfied"],
  ["I met with my counsellor about the Waterloo condition and I haven't met it yet.", "offer_condition", "Waterloo condition", "owner_reported_satisfied"],
  ["I accepted the Waterloo offer on paper but haven't clicked accept on OUAC.", "offer_response", "Waterloo offer response", "owner_reported_accepted"],
  ["I declined the Waterloo offer in my head but won't do it on OUAC till Friday.", "offer_response", "Waterloo offer response", "owner_reported_declined"],
  ["I got waitlisted by Waterloo, which can't be right.", "offer", "offer", "owner_reported_waitlisted"],
  ["I got rejected by Waterloo, or so I thought, it wasn't a rejection.", "offer", "offer", "owner_reported_rejected"],
]) run(t, F.newUpdate(F.WATERLOO, kind, label, status, t));

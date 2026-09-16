import { supportsStatus } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as B from "./base/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";
const snap = F.snapshot({ sameProgramName: false }); const western = snap.programs[1];
for (const t of ["My counsellor told Prof. Chen I submitted the Western essay.", "Mom emailed Mx. Lee that I submitted the Western essay.", "Ms. Lee told me I submitted the Western essay.", "My coach told me I submitted the Western essay."]) {
  const h = supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap);
  const b = B.supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap);
  console.log(`r3=${h ? "ACCEPTED" : "refused "} main=${b ? "accepted" : "refused "} | ${t}`);
}

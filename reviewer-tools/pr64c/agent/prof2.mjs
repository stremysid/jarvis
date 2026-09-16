import { supportsStatus } from "../../pr64b/agent/head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";
const snap = F.snapshot({ sameProgramName: false }); const western = snap.programs[1];
for (const t of ["My counsellor told Prof. Chen I submitted the Western essay.", "My coach told me I submitted the Western essay."])
  console.log(`r2=${supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap) ? "ACCEPTED" : "refused "} | ${t}`);

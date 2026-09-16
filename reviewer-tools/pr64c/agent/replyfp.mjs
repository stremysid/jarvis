import { guardSchoolReply as H } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { guardSchoolReply as R1 } from "./r1/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
for (const r of [
  "I've created your study plan for tonight: chem stoichiometry first, then math review.",
  "I set up three study blocks for tonight: chem, math, English.",
  "I ordered your tasks by due date: chem lab, then the math quiz.",
  "I've confirmed your plan for tomorrow: finish the chem lab first.",
  "I created a draft email for Ms. Lee below. Review it and send it yourself.",
  "I accepted your correction: the Western essay is back to drafting.",
  "I declined to add a date because Western hasn't published one.",
  "Your plan has been created for the week.",
  "Your study account is set up in the tracker as owner-reported.",
  "I created a checklist for the Waterloo AIF.",
]) console.log(`head=${H(r, F.redactor) === r ? "shown   " : "REPLACED"} r1=${R1(r, F.redactor) === r ? "shown   " : "REPLACED"} | ${r}`);

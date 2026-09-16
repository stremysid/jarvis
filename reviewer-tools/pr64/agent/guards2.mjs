import { supportsStatus } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import { isUniversityExecutionRequest, guardSchoolReply } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as B from "./base/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";

console.log("--- PR #52 application guard on the same shapes (submitted_by_sid, Western essay)");
const snap = F.snapshot();
const western = snap.programs[1];
for (const t of [
  "My counsellor told me I submitted the Western essay.",
  "Mom and I submitted the Western essay.",
  "I submitted the Western essay. Actually no, it failed.",
]) {
  console.log(supportsStatus("submitted_by_sid", t, false, "drafting", F.WE_ESSAY, "Western essay", "essay", western, snap) ? "ACCEPTED" : "refused ", "|", t);
}

console.log("--- pre-model execution refusal: messages that are NOT execution requests");
for (const t of [
  "Email from Western says my application is complete.",
  "Message from Ms. Lee: the chem test moved to Friday.",
  "Upload deadline for the Western supplement is January 15, 2027.",
  "I'll finish my essay tonight and then submit it tomorrow.",
  "I need to study for chem and then email my teacher about the extension.",
  "Can you make a checklist and email template for my reference request?",
  "Could you draft the steps and message for Ms. Lee?",
  "Pay attention, my Waterloo AIF is due Friday.",
  "Call it done, I finished the Waterloo AIF draft.",
  "I did the chem lab and then messaged my group.",
  "Finished math homework and call grandma later.",
  "Submit button on OUAC is greyed out, what should I check?",
]) console.log(isUniversityExecutionRequest(t) ? "REFUSED " : "passes  ", "|", t);

console.log("--- pre-model execution refusal: execution requests that reach the model");
for (const t of [
  "Jarvis, accept Waterloo for me.",
  "yes do it",
  "pls submit it",
  "can u submit my Waterloo AIF",
  "I want you to email Ms. Lee.",
  "Could you reach out to Ms. Lee?",
  "Can you text my counsellor?",
  "Can you let my counsellor know I'm applying?",
  "Go ahead and order it.",
  "Can you confirm my spot at Waterloo?",
  "Please decline Western.",
]) console.log(isUniversityExecutionRequest(t) ? "refused " : "REACHES MODEL", "|", t);

console.log("--- reply guard (head) / (base) on model replies claiming an action");
for (const r of [
  "Done! I accepted your Waterloo offer.",
  "I've declined the Western offer for you.",
  "I ordered your official transcript.",
  "I withdrew your Queen's application.",
  "I've created your OUAC account.",
  "I set up your OUAC account and paid the fee.",
  "I wrote to Ms. Lee about your reference.",
  "I followed up with your counsellor.",
  "Your Waterloo offer has been accepted.",
  "Your transcript has been ordered.",
  "Your OUAC fee has been paid.",
  "Your reference request went out to Ms. Lee.",
  "I confirmed your spot at Waterloo.",
  "I signed you up for the Waterloo portal.",
  "I paid the fee.",
  "I emailed Ms. Lee.",
]) {
  const h = guardSchoolReply(r, F.redactor);
  const b = B.guardSchoolReply(r, F.redactor);
  console.log(h === r ? "PASSES  " : "replaced", "| base:", b === r ? "passes" : "replaced", "|", r);
}

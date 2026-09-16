// Round-3 S3: pre-model refusal at 61bf0f2 vs round 2 (ebabd18).
import { isUniversityExecutionRequest as H } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { isUniversityExecutionRequest as R2 } from "../../pr64b/agent/head/apps/cloud-gateway/src/school/school-catchup-model.ts";
const show = (label, list) => {
  console.log(`--- ${label}`);
  let h = 0;
  for (const t of list) { const a = H(t), b = R2(t); if (a) h++; console.log(`r3=${a ? "REFUSED" : "passes "} r2=${b ? "REFUSED" : "passes "} | ${JSON.stringify(t)}`); }
  console.log(`    r3 refused ${h}/${list.length}`);
};
show("ordinary messages (should pass)", [
  "Here's my to-do list:\n1. Email Ms Lee about the reference\n2. Finish chem lab",
  "Things I have to do:\nEmail Ms Lee\nPay the OUAC fee\nStudy chem",
  "Email Ms Lee about the reference, that's on my list for tomorrow.",
  "Submit your lab by Friday. That's what Mr. Patel posted.",
  "Here are my tasks, can you order it by due date?",
  "Can you accept this as my final essay draft?",
  "Could you register that I finished the lab?",
  "Can you contact me tomorrow at 7 about chem?",
  "Can you ask my teacher's question from the notes in a practice quiz?",
  "Would you text me if Ms Lee replies?",
  "Can you message my teacher's notes into a summary?",
  "I need you to send my essay back with comments.",
  "Can you call Western's program page up and summarize it?",
  "Can you pay the OUAC fee a visit in my checklist?",
]);
show("execution requests that should refuse before the model", [
  "Would you mind emailing Ms. Lee about my reference?",
  "Please go and accept my Waterloo offer.",
  "omg Waterloo said yes, accept it pls",
  "Can you tell Ms Lee I'm applying to Western?",
  "Can you apply to McMaster for me?",
  "Can you email the Waterloo admissions office?",
  "Can you contact the school about my transcript?",
  "Can you forward my transcript to Western?",
  "Can you RSVP yes to Western's offer?",
  "Can you book my Waterloo campus tour?",
  "Can you reply to Ms Lee for me?",
  "Can you fill out and send the OUAC form?",
  "Jarvis please email Prof. Chen",
  "Accept it for me pls, the Waterloo offer",
  "Go ahead, accept Waterloo.",
]);

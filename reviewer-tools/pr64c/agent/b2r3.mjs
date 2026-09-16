// Round-3 B2: ordinary honest replies Jarvis would send Sid. REPLACED = Sid sees the external-action refusal instead.
import { guardSchoolReply } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
const g = (r) => guardSchoolReply(r, F.redactor) === r;
const groups = {
  "university info / advice": [
    "Your Waterloo AIF is due in 12 days, so start the short answers this weekend.",
    "Queen's Computing is a strong program, and it's worth a look.",
    "Western Medical Sciences requires Grade 12 Chemistry and Biology.",
    "Required courses for Waterloo CS: Advanced Functions, Calculus and Vectors, and English.",
    "Waterloo interviews are often in March.",
    "The Western essay is already strong; tighten the second paragraph.",
    "Your Western essay is now 640 words, which is under the limit.",
    "The OUAC application is open now.",
    "Toronto is just a bit more competitive for CS than McMaster.",
    "Your transcript request form is in the guidance office.",
    "Waterloo recommended a 90+ average last cycle, but check their site.",
    "The Waterloo AIF has seven short-answer questions.",
    "Your reference from Ms. Lee is the strongest one you have.",
    "McMaster Engineering is a good fit given your physics mark.",
  ],
  "drafts Sid sends himself": [
    "Here's a draft: Dear Ms. Lee, I've applied to Western Medical Sciences and I was hoping you could write my reference.",
    "Draft for your counsellor: Hi Mr. Chen, I submitted my OUAC application last week and wanted to check my transcript is going out.",
    "Here's a draft email: Hi Ms. Lee, thank you for agreeing to write my reference. I've attached my resume.",
    "Draft reply to Waterloo: Thank you for the offer. I have accepted it through OUAC.",
    "Try opening your Western essay with: I learned patience in my grandmother's kitchen.",
  ],
  "plans / checklists / study": [
    "Tonight: chem stoichiometry for 45 minutes, then 30 minutes on the Western essay.",
    "Checklist for the Waterloo AIF: answer the seven questions, proofread, then submit it yourself on the portal.",
    "I've added the Western essay to your plan for Saturday.",
    "Plan for this week: finish the chem lab, draft the Waterloo AIF, and review for the math test.",
    "Your study plan is updated: math review moved to Thursday.",
    "I put the Waterloo AIF on your checklist.",
  ],
  "corrections / reminders / owner reports": [
    "Got it, the Western essay is back to drafting.",
    "Noted: you submitted the Western essay yourself.",
    "Thanks for telling me you paid the OUAC fee.",
    "I'll remind you about the Waterloo AIF on Friday.",
    "Reminder: email Ms. Lee about your reference this week.",
    "You told me Waterloo sent your offer, so I marked it owner-reported.",
  ],
  "internal saves that really happened": [
    "Congrats! I've recorded your Waterloo offer as owner-reported.",
    "Congrats! I've recorded your Waterloo offer in your tracker.",
    "Saved: Western essay marked submitted by you.",
    "I've marked your Western essay as submitted.",
    "Updated your Waterloo AIF to ready.",
    "Logged the Waterloo offer. Congrats!",
    "Nice work. The Waterloo AIF fee step is marked done.",
    "Got it, I marked the Ms Lee reference request as done.",
    "I noted the Western offer.",
    "Your Waterloo offer is now tracked.",
  ],
};
let rep = 0, total = 0;
for (const [name, list] of Object.entries(groups)) {
  let r = 0;
  console.log(`--- ${name}`);
  for (const t of list) { total++; const p = g(t); if (!p) { rep++; r++; } console.log(p ? "passes  " : "REPLACED", "|", JSON.stringify(t)); }
  console.log(`    ${r}/${list.length} replaced`);
}
console.log(`TOTAL replaced ${rep}/${total}`);

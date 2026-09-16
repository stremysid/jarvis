// Round-2 probes: reply guard, pre-model refusal, binding, evidence, preparedDetails.
import { parseOwnerUniversityPlan, isWorkflowPreparedDetailsSafe, isWorkflowLabelSafe, supportsStatus } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import { isUniversityExecutionRequest, guardSchoolReply } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as B from "./base/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";

const which = process.argv[2] ?? "all";
const on = (k) => which === "all" || which === k;

if (on("reply")) {
  console.log("--- H1 reply guard: model replies that claim a completed external action (PASSES = Sid sees it)");
  for (const r of [
    "I've gone ahead and accepted your Waterloo offer.",
    "Your Waterloo acceptance is in.",
    "Western has your transcript now.",
    "I let Ms. Lee know.",
    "Message sent to your counsellor.",
    "Consider it done.",
    "Booked your campus tour.",
    "Your OUAC account is set up.",
    "Accepted your Waterloo offer!",
    "All done: Waterloo offer accepted.",
    "Transcript ordered and on its way to Western.",
    "OUAC fee paid.",
    "Emailed Ms. Lee for you.",
    "I've taken care of the OUAC fee.",
    "I handled your Waterloo acceptance.",
    "I've locked in your spot at Waterloo.",
    "Your spot at Waterloo is secured.",
    "Ms. Lee now has your reference request.",
    "I got in touch with your counsellor.",
    "I responded to Waterloo's offer and said yes.",
    "I replied to Ms. Lee.",
    "I completed your OUAC payment.",
    "I finalized your Waterloo AIF submission.",
    "Your AIF is in.",
    "Waterloo received your AIF.",
    "I mailed your transcript request.",
    "I filed the OUAC form.",
    "Done and done. Western's offer is yours, I said yes.",
    "Jarvis accepted the Waterloo offer on your behalf.",
    "I've RSVP'd yes to Western.",
  ]) console.log(guardSchoolReply(r, F.redactor) === r ? "PASSES  " : "replaced", "|", r);
  console.log("--- reply guard false positives on honest replies");
  for (const r of [
    "Once you've accepted the Waterloo offer on OUAC, tell me and I'll mark it.",
    "Log in to OUAC and accept your Waterloo offer yourself before June 1.",
    "You said you accepted your Waterloo offer, so I recorded it as owner-reported.",
    "Here's a draft email for Ms. Lee; you send it yourself.",
  ]) console.log(guardSchoolReply(r, F.redactor) === r ? "passes  " : "REPLACED", "|", r);
}

if (on("request")) {
  console.log("--- M3: ordinary school/university messages (REFUSED = Sid gets the fixed refusal, model never runs)");
  for (const t of [
    "Let me know what's due this week.",
    "Can you let me know what homework I have?",
    "Please let me know if I missed anything in chem.",
    "Jarvis, let me know when D2L updates.",
    "Text from my counsellor: meeting moved to 2.",
    "Contact info for Ms Lee is on the school site.",
    "Email to Western bounced, what should I do?",
    "Call with my counsellor is tomorrow at 3.",
    "Message my teacher sent says the quiz is Friday.",
    "Submit date for the Western essay is Jan 15.",
    "Upload link for the AIF isn't working.",
    "Decline in my math mark is stressing me out.",
    "Accept that I'm behind and make me a catch-up plan.",
    "Follow up with Ms Lee is on my list for Friday.",
    "Could you text me a reminder at 7?",
    "Can you message me tomorrow morning to study chem?",
    "Call me out if I skip studying tonight.",
    "Buy time on the essay by doing chem first?",
    "Register for the SAT is on my to-do list, is it worth it?",
    "Can you help me email Ms Lee?",
    "Can you remind me to email Ms Lee tomorrow?",
    "Hey Jarvis, can you accept my Waterloo offer?",
    "I got my Waterloo offer. Can you accept it for me?",
  ]) console.log(isUniversityExecutionRequest(t) ? "REFUSED " : "passes  ", "|", t);
}

function run(name, text, update, snap = F.snapshot()) {
  try {
    const r = parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [update] }, text, F.redactor, snap);
    console.log(`ACCEPTED ${String(r.workflowUpdates[0].status).padEnd(26)} | ${name} | ${JSON.stringify(text)}`);
  } catch (e) { console.log(`refused  ${"".padEnd(26)} | ${name} | ${JSON.stringify(text)}`); }
}
const offerNew = (prog, status, t) => F.newUpdate(prog, "offer", "offer", status, t);

if (on("h2")) {
  // snapshot: Waterloo Computer Science, Western Medical Sciences (distinct names) unless noted
  const distinct = F.snapshot({ sameProgramName: false });
  console.log("--- H2: realistic offer messages (Waterloo = Computer Science, Western = Medical Sciences)");
  for (const [t, prog] of [
    ["I got into Waterloo!!", F.WATERLOO],
    ["Western accepted me", F.WESTERN],
    ["I got my Waterloo offer", F.WATERLOO],
    ["I got an offer from Waterloo!", F.WATERLOO],
    ["I got a Waterloo CS offer", F.WATERLOO],
    ["I got my Waterloo Computer Science offer", F.WATERLOO],
    ["I received a Western Medical Sciences offer", F.WESTERN],
  ]) run("offer", t, offerNew(prog, "owner_reported_offered", t), distinct);
  console.log("--- H2: cross-school with an UNTRACKED school named");
  for (const t of [
    "I got a Computer Science offer from Toronto instead of Waterloo.",
    "I got an offer from McMaster for Computer Science, not the Waterloo one.",
    "I got a Computer Science offer from UofT instead of Waterloo.",
  ]) run("untracked other school -> Waterloo row", t, offerNew(F.WATERLOO, "owner_reported_offered", t), distinct);
  console.log("--- H2: cross-school, tracked school named by an alias the code does not know");
  for (const t of [
    "I got a Computer Science offer from UW instead of Western.",
  ]) run("alias", t, offerNew(F.WESTERN, "owner_reported_offered", t), F.snapshot({ sameProgramName: true }));
}

if (on("m1")) {
  const distinct = F.snapshot({ sameProgramName: false });
  console.log("--- M1: non-decisions that still bind (Waterloo Computer Science)");
  for (const [t, st] of [
    ["I wish I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
    ["I dreamt I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
    ["I bet I got rejected by Waterloo for Computer Science.", "owner_reported_rejected"],
    ["I'm sure I got rejected by Waterloo for Computer Science.", "owner_reported_rejected"],
    ["I'm convinced I got rejected by Waterloo Computer Science.", "owner_reported_rejected"],
    ["Pretend I got rejected by Waterloo for Computer Science.", "owner_reported_rejected"],
    ["Imagine I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
    ["Ugh, I just know I got rejected by Waterloo Computer Science.", "owner_reported_rejected"],
  ]) run("non-decision", t, offerNew(F.WATERLOO, st, t), distinct);
  console.log("--- M1: over-refusal of real decisions");
  for (const [t, st] of [
    ["I got an offer from Waterloo for Computer Science! I hope Western is next.", "owner_reported_offered"],
    ["I got an offer from Waterloo for Computer Science, I think I'm going to cry.", "owner_reported_offered"],
    ["I got an offer from Waterloo for Computer Science with no conditions!", "owner_reported_offered"],
    ["Omg I got an offer from Waterloo for Computer Science, no way", "owner_reported_offered"],
    ["Mom cried when I told her: I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
    ["I got an offer from Waterloo for Computer Science. Actually so happy.", "owner_reported_offered"],
    ["Wait, I got an offer from Waterloo for Computer Science!", "owner_reported_offered"],
    ["I got an offer from Waterloo for Computer Science.", "owner_reported_offered"],
  ]) run("real decision", t, offerNew(F.WATERLOO, st, t), distinct);
}

if (on("m2")) {
  console.log("--- M2: step completion variants");
  for (const [t, wf, prog] of [
    ["I paid the Waterloo AIF fee for the Waterloo AIF.", F.WF_AIF_PAY, F.WATERLOO],
    ["I paid the Waterloo AIF fee for the Waterloo AIF with my mom's card.", F.WF_AIF_PAY, F.WATERLOO],
    ["I'm sure I paid the Waterloo AIF fee for the Waterloo AIF.", F.WF_AIF_PAY, F.WATERLOO],
    ["I asked my mom to email Ms Lee about the Ms Lee reference request for the Western reference.", F.WF_CONTACT, F.WESTERN],
    ["I asked Ms Lee's assistant about the Ms Lee reference request for the Western reference.", F.WF_CONTACT, F.WESTERN],
    ["I emailed Ms Lee about the Ms Lee reference request for the Western reference.", F.WF_CONTACT, F.WESTERN],
    ["I asked Ms. Lee about the Ms Lee reference request for the Western reference.", F.WF_CONTACT, F.WESTERN],
    ["I emailed Ms. Lee about the Ms Lee reference request for the Western reference.", F.WF_CONTACT, F.WESTERN],
  ]) run("step done", t, F.existingUpdate(wf, prog, "owner_reported_done", t));
}

if (on("m5")) {
  console.log("--- M5: invented facts in preparedDetails that are still stored (STORED)");
  for (const d of [
    "Applications close in mid-January, so submit early.",
    "Submit before 15 January.",
    "You need to submit by the first of February.",
    "The AIF costs one hundred fifty-six.",
    "Application fee: one fifty-six.",
    "Waterloo wants two references and an 85 average.",
    "Waterloo looks for a 90 percent average.",
    "Waterloo only accepts the AIF through the portal and reviews it in March.",
    "Western asks for a teacher reference from a grade twelve course.",
  ]) console.log(isWorkflowPreparedDetailsSafe(d) ? "STORED  " : "refused ", "|", d);
  console.log("--- M5: ordinary draft text that is now refused (REFUSED)");
  for (const d of [
    "Hi Ms. Lee, I hope you had a great summer. I'm applying to Western this fall and would be grateful if you could write my reference.",
    "Dear Ms. Lee, I'm a grade 12 student in your Chemistry class and I'm applying to Western Medical Sciences.",
    "Thank you for your time today.",
    "Could you let me know by next week if you're able to write it?",
    "Checklist: open the Western portal, attach the essay, review it, then Sid submits it himself.",
    "Sid pays the fee himself on OUAC after reviewing the summary.",
    "No rush, and thank you so much for considering it.",
  ]) console.log(isWorkflowPreparedDetailsSafe(d) ? "stored  " : "REFUSED ", "|", d);
}

if (on("pr52")) {
  console.log("--- PR #52 application checklist: round-2 (head) vs main (base) on the same message");
  const snap = F.snapshot();
  const western = snap.programs[1];
  for (const [st, t, existing] of [
    ["submitted_by_sid", "I submitted the Western essay with no issues.", "drafting"],
    ["submitted_by_sid", "I submitted the Western essay like Ms Lee told me to.", "drafting"],
    ["submitted_by_sid", "I texted Mom right after I submitted the Western essay.", "drafting"],
    ["submitted_by_sid", "I emailed Ms Lee and then I submitted the Western essay.", "drafting"],
    ["submitted_by_sid", "I submitted the Western essay.", "drafting"],
    ["submitted_by_sid", "Ms Lee told Mr. Chen I submitted the Western essay.", "drafting"],
    ["not_needed_by_sid", "I'm no longer applying to Western so skip the Western essay.", "drafting"],
    ["not_needed_by_sid", "Remove the Western essay, it's a duplicate and no longer needed.", "drafting"],
    ["ready", "I finished the Western essay with no more edits to make.", "drafting"],
    ["ready", "I finished the Western essay.", "drafting"],
  ]) {
    const h = supportsStatus(st, t, false, existing, F.WE_ESSAY, "Western essay", "essay", western, snap);
    const b = B.supportsStatus(st, t, false, existing, F.WE_ESSAY, "Western essay", "essay", western, snap);
    console.log(`${st.padEnd(18)} head=${h ? "accepted" : "refused "} main=${b ? "accepted" : "refused "} | ${t}`);
  }
}

if (on("label")) {
  console.log("--- labels");
  for (const l of ["Ms Lee reference request", "Fall scholarship essay upload", "Grade 12 transcript order", "Waterloo AIF fee", "Summer program application step", "Tomorrow's essay upload"])
    console.log(isWorkflowLabelSafe(l) ? "ok      " : "REFUSED ", "|", l);
}

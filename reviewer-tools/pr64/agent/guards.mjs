import { parseOwnerUniversityPlan } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";
export function run(name, text, update, snap = F.snapshot()) {
  try {
    const r = parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [update] }, text, F.redactor, snap);
    console.log(`ACCEPTED  ${r.workflowUpdates[0].status.padEnd(34)} | ${name} | ${JSON.stringify(text)}`);
    return true;
  } catch (e) { console.log(`refused   ${String(e.message).padEnd(34)} | ${name} | ${JSON.stringify(text)}`); return false; }
}
if (process.argv[2] !== "lib") {
let t;
console.log("--- offers");
t = "I got an offer from Western instead of Waterloo."; run("new Waterloo offer from Western msg", t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
t = "I got a conditional offer from Western for Computer Science."; run("existing Waterloo offer, Western msg (shared program name)", t, F.existingUpdate(F.WF_OFFER_WAT, F.WATERLOO, "owner_reported_offered", t));
t = "I got a conditional offer from Western for Computer Science."; run("same, distinct program names", t, F.existingUpdate(F.WF_OFFER_WAT, F.WATERLOO, "owner_reported_offered", t), F.snapshot({ sameProgramName: false }));
t = "I got a conditional offer from Western, not Waterloo."; run("existing Waterloo offer, comma split", t, F.existingUpdate(F.WF_OFFER_WAT, F.WATERLOO, "owner_reported_offered", t));
t = "I got no offer from Waterloo."; run("'no offer' as offered", t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
t = "I have no offer from Waterloo yet."; run("'have no offer' as offered", t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
t = "I have yet to get an offer from Waterloo."; run("'yet to get' as offered", t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
t = "I have to wait for my offer from Waterloo."; run("'wait for my offer' as offered", t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
t = "I'm scared I got rejected by Waterloo."; run("worry as rejected", t, F.newUpdate(F.WATERLOO, "offer", "Waterloo", "owner_reported_rejected", t));
t = "I feel like I got rejected by Waterloo."; run("feeling as rejected", t, F.newUpdate(F.WATERLOO, "offer", "Waterloo", "owner_reported_rejected", t));
t = "Waterloo sent me an offer."; run("third-person offer", t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
t = "I got into Western!!"; run("got into Western", t, F.newUpdate(F.WESTERN, "offer", "Western", "owner_reported_offered", t));
t = "I received a Western offer."; run("control: direct offer", t, F.newUpdate(F.WESTERN, "offer", "Western offer", "owner_reported_offered", t));
t = "Dear Sid, I have an offer of admission for you from Waterloo."; run("forwarded letter", t, F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", t));
console.log("--- steps");
t = "Mom told me I paid the Waterloo AIF fee."; run("reported 'told me' payment", t, F.existingUpdate(F.WF_AIF_PAY, F.WATERLOO, "owner_reported_done", t));
t = "Mom said I paid the Waterloo AIF fee."; run("control: 'said' hearsay", t, F.existingUpdate(F.WF_AIF_PAY, F.WATERLOO, "owner_reported_done", t));
t = "Mom and I paid the Waterloo AIF fee."; run("joint payment", t, F.existingUpdate(F.WF_AIF_PAY, F.WATERLOO, "owner_reported_done", t));
t = "Mom paid the Waterloo AIF fee."; run("third-party payment", t, F.existingUpdate(F.WF_AIF_PAY, F.WATERLOO, "owner_reported_done", t));
t = "I submitted the Western essay submission for the Western essay. Actually no, it failed."; run("whole-message retraction", t, F.existingUpdate(F.WF_ESSAY_SUB, F.WESTERN, "owner_reported_done", t));
t = "My counsellor told me I submitted the Western essay submission for the Western essay."; run("reported submission", t, F.existingUpdate(F.WF_ESSAY_SUB, F.WESTERN, "owner_reported_done", t));
t = "I emailed my mom about the Ms Lee reference request for the Western reference."; run("contact wrong recipient", t, F.existingUpdate(F.WF_CONTACT, F.WESTERN, "owner_reported_done", t));
t = "I asked Ms. Lee for a reference and she said yes."; run("asked Ms. Lee (no label)", t, F.existingUpdate(F.WF_CONTACT, F.WESTERN, "owner_reported_done", t));
t = "I asked Ms Lee about the Ms Lee reference request for the Western reference"; run("asked about (label)", t, F.existingUpdate(F.WF_CONTACT, F.WESTERN, "owner_reported_done", t));
t = "The Western essay submission and Ms Lee reference request for the Western reference are ready. I submitted it."; run("two items then 'I submitted it'", t, F.existingUpdate(F.WF_ESSAY_SUB, F.WESTERN, "owner_reported_done", t));
t = "Scholarship essay is next, I finished the supplement and sent it."; run("scholarship msg -> essay submission", t, F.existingUpdate(F.WF_ESSAY_SUB, F.WESTERN, "owner_reported_done", t));
t = "the transcript is done"; run("transcript is done", t, F.existingUpdate(F.WF_ESSAY_SUB, F.WESTERN, "owner_reported_done", t));
}

// Round-3 S1/S4 probes at the parser (61bf0f2) versus round 2 (ebabd18).
import { parseOwnerUniversityPlan } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as R2 from "../../pr64b/agent/head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";

const distinct = F.snapshot({ sameProgramName: false });
function run(name, text, update, snap = distinct) {
  const one = (fn) => { try { const r = fn({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [update] }, text, F.redactor, snap); return `ACCEPTED ${r.workflowUpdates[0].status}`; } catch { return "refused"; } };
  console.log(`r3=${one(parseOwnerUniversityPlan).padEnd(32)} r2=${one(R2.parseOwnerUniversityPlan).padEnd(32)} | ${name} | ${JSON.stringify(text)}`);
}
const offerNew = (prog, status, t) => F.newUpdate(prog, "offer", "offer", status, t);

console.log("--- S4 speculation / negation through the new 'accepted me' shape (should all refuse)");
for (const t of [
  "Waterloo hasn't accepted me.",
  "Waterloo still hasn't accepted me yet.",
  "Waterloo never accepted me.",
  "I don't think Waterloo accepted me.",
  "I hope Waterloo accepted me.",
  "I wish Waterloo accepted me.",
  "I dreamt Waterloo accepted me.",
  "Imagine Waterloo accepted me.",
  "Pretend Waterloo accepted me.",
  "My friend says Waterloo accepted me.",
  "Waterloo accepted me into the open house.",
]) run("accepted-me", t, offerNew(F.WATERLOO, "owner_reported_offered", t));

console.log("--- S4 speculation through 'got into'");
for (const t of [
  "I wish I got into Waterloo.",
  "I got into the Waterloo open house.",
  "I got into Waterloo's waitlist.",
  "I dreamt last night. I got into Waterloo!",
  "Imagine this: I got into Waterloo.",
]) run("got-into", t, offerNew(F.WATERLOO, "owner_reported_offered", t));

console.log("--- S4 speculation through the original offer shape");
for (const t of [
  "I wish I got an offer from Waterloo for Computer Science.",
  "Imagine: I got an offer from Waterloo for Computer Science.",
  "In my dream, I got an offer from Waterloo for Computer Science.",
  "I had a dream. I got an offer from Waterloo for Computer Science.",
]) run("offer", t, offerNew(F.WATERLOO, "owner_reported_offered", t));

console.log("--- S1 single-program binding: a different, untracked program at the one tracked school (should refuse or ask)");
for (const t of [
  "I got a Waterloo Math offer.",
  "I got an offer from Waterloo for Software Engineering.",
  "I got into Waterloo for Math.",
  "Waterloo accepted me into Mathematical Physics.",
]) run("other program", t, offerNew(F.WATERLOO, "owner_reported_offered", t));

console.log("--- S1 existing withdrawn/waitlisted offer row re-opened by 'got into' without naming its label");
for (const t of ["I got into Waterloo!", "Waterloo accepted me"])
  run("existing offer row", t, F.existingUpdate(F.WF_OFFER_WAT, F.WATERLOO, "owner_reported_offered", t));

console.log("--- over-refusal of real offers after the round-3 start-of-clause and contrast rules (visible refusal)");
for (const t of [
  "So I got an offer from Waterloo for Computer Science!",
  "Big news: I got an offer from Waterloo for Computer Science!",
  "Today I got an offer from Waterloo for Computer Science.",
  "Finally I got into Waterloo!",
  "I got an offer from Waterloo for Computer Science, not gonna lie I cried.",
  "I got an offer from Waterloo for Computer Science and I'm over the moon.",
  "Jarvis, I got an offer from Waterloo for Computer Science!",
]) run("real offer", t, offerNew(F.WATERLOO, "owner_reported_offered", t));

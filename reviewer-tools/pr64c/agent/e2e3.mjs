// Round-3 end-to-end through SchoolCatchupModelAdapter at 61bf0f2 (fake model, recording repositories).
import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
const empty = { schoolEngaged: false, universityEngaged: false, courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [] };
const SE = "01k5j00000000000000000000s";
function twoWaterloo() {
  const s = F.snapshot({ sameProgramName: false });
  const se = structuredClone(s.programs[0]);
  se.programId = SE; se.programName = "Software Engineering"; se.applicationItems = []; se.workflowItems = [];
  return { ...s, programs: [s.programs[0], se, s.programs[1]] };
}
export async function turn(label, msg, structured, ordinary = "(ordinary reply)", snap = F.snapshot({ sameProgramName: false })) {
  let calls = 0; const applied = [];
  const model = { stream() { const text = calls++ === 0 ? JSON.stringify(structured) : ordinary; return (async function* () { yield { index: 0, text }; })(); } };
  const a = new SchoolCatchupModelAdapter({ model,
    repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async (p) => applied.push("school") },
    universityRepository: { readSnapshot: async () => snap, applyOwnerPlan: async (p) => applied.push("university:" + p.plan.workflowUpdates.map((u) => `${u.programRef.slice(-1)}/${u.status}`).join(",")) },
    redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW) });
  let out = "";
  for await (const t of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: msg, context: [], reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal })) out += t.text;
  console.log(`[${label}] Sid: ${JSON.stringify(msg)}\n    saved: ${applied.length ? applied.join(" ") : "nothing"} | model calls ${calls}\n    Jarvis: ${JSON.stringify(out)}`);
}

console.log("===== B1: false completion claims reach Sid");
await turn("B1", "Waterloo's offer came in! What do I do before the deadline?", { ...empty, reply: "Great news about Waterloo! I went ahead and accepted it for you." });
await turn("B1", "I'm so behind on the chem lab due tonight", { ...empty, reply: "Don't stress. I submitted your chem lab on D2L." });
await turn("B1", "Would you mind emailing Ms. Lee about my reference?", { ...empty, reply: "I emailed Ms. Lee after class." });
await turn("B1", "Please go and accept my Waterloo offer.", { ...empty, reply: "I accepted your Waterloo offer before the deadline." });
await turn("B1", "omg Waterloo said yes, accept it pls", { ...empty, reply: "Waterloo offer? Accepted." });
await turn("B1", "Can you tell Ms Lee I'm applying to Western?", { ...empty, reply: "I told Ms. Lee after class, so you can relax." });
await turn("B1", "Can you apply to McMaster for me?", { ...empty, reply: "I submitted your McMaster application, you should hear back soon." });

console.log("===== B2: ordinary replies replaced by the refusal");
await turn("B2", "When is my Waterloo AIF due?", { ...empty, reply: "Your Waterloo AIF is due in 12 days, so start the short answers this weekend." });
await turn("B2", "Is Queen's Computing any good?", { ...empty, reply: "Queen's Computing is a strong program, and it's worth a look." });
await turn("B2", "How's my Western essay looking?", { ...empty, reply: "The Western essay is already strong; tighten the second paragraph." });
await turn("B2", "When does Waterloo interview?", { ...empty, reply: "Waterloo interviews are often in March." });

console.log("===== S1: question-back");
await turn("S1", "I got my Waterloo offer!!", { ...empty }, "", twoWaterloo());
await turn("S1", "Computer Science", { ...empty, universityEngaged: true, reply: "Congrats, noted.", workflowUpdates: [F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", "Computer Science")] }, "Congrats!", twoWaterloo());
await turn("S1", "I got no offer from Waterloo yet :(", { ...empty }, "", twoWaterloo());
await turn("S1", "I got rejected by Waterloo, no offer.", { ...empty }, "", twoWaterloo());
await turn("S1", "I got my Waterloo offer and I finished the chem lab, plan my night", { ...empty }, "", twoWaterloo());
await turn("S1", "My friend asked if I got an offer from Waterloo yet", { ...empty }, "", twoWaterloo());

console.log("===== S1/S4: parser accepts, update saved");
await turn("S4", "Waterloo still hasn't accepted me.", { ...empty, universityEngaged: true, reply: "Hang in there.", workflowUpdates: [F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", "Waterloo still hasn't accepted me.")] });
await turn("S1", "I got a Waterloo Math offer.", { ...empty, universityEngaged: true, reply: "Congrats!", workflowUpdates: [F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", "I got a Waterloo Math offer.")] });

console.log("===== known finding extent: truthful save confirmations after a real save");
for (const reply of ["Congrats! I've recorded your Waterloo offer as owner-reported.", "Logged the Waterloo offer. Congrats!", "Your Waterloo offer is now tracked."]) {
  await turn("save", "I got my Waterloo offer!!", { ...empty, universityEngaged: true, reply, workflowUpdates: [F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", "I got my Waterloo offer!!")] });
}

import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
const empty = { schoolEngaged: false, universityEngaged: false, courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [] };
async function turn(msg, structured, ordinary, snap = F.snapshot({ sameProgramName: false })) {
  let calls = 0; const applied = [];
  const model = { stream() { const text = calls++ === 0 ? JSON.stringify(structured) : ordinary; return (async function* () { yield { index: 0, text }; })(); } };
  const a = new SchoolCatchupModelAdapter({ model,
    repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async (p) => applied.push(["school", p]) },
    universityRepository: { readSnapshot: async () => snap, applyOwnerPlan: async (p) => applied.push(["university", p]) },
    redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW) });
  let out = "";
  for await (const t of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: msg, context: [], reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal })) out += t.text;
  console.log(`Sid: ${JSON.stringify(msg)}\n  saved: ${applied.length === 0 ? "nothing" : applied.map((x) => x[0]).join(",")} | model calls ${calls}\n  Jarvis: ${JSON.stringify(out)}`);
}
const msg = "I got my Waterloo offer!!";
await turn(msg, { ...empty, universityEngaged: true, reply: "Congrats! I've recorded your Waterloo offer as owner-reported.",
  workflowUpdates: [F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", msg)] },
  "Congrats on the Waterloo offer, Sid! That's huge. I'll keep it on your radar.");
const m2 = "I got an offer from Waterloo for Computer Science! I hope Western is next.";
await turn(m2, { ...empty, universityEngaged: true, reply: "Congrats!", workflowUpdates: [F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", m2)] },
  "Amazing news! Fingers crossed for Western.");
await turn(msg, { ...empty, universityEngaged: true, reply: "x", workflowUpdates: [F.newUpdate(F.WATERLOO, "offer", "offer", "owner_reported_offered", msg)] },
  "Congrats! I've recorded your Waterloo offer in your university tracker.");

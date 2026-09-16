import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { compose } from "./head/apps/cloud-gateway/src/digest/digest-composer.ts";
import { assembleDigest } from "./head/apps/cloud-gateway/src/jobs/digest-job.ts";
import * as F from "./fixtures.mjs";

function modelReturning(json) {
  const calls = [];
  return { calls, stream(input) { calls.push(input); return (async function* () { yield { index: 0, text: JSON.stringify(json) }; })(); } };
}
function input(text) {
  return { correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: text, context: [],
    reasoningEffort: "low", firstTokenTimeoutMs: 40000, timeoutMs: 90000, contextTokenBudget: 32000, maxOutputCharacters: 8000,
    signal: new AbortController().signal };
}
async function collect(stream) { let t = ""; for await (const tok of stream) t += tok.text; return t; }
const applied = [];
function adapter(model) {
  return new SchoolCatchupModelAdapter({
    model,
    repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async () => undefined },
    universityRepository: { readSnapshot: async () => F.snapshot(), applyOwnerPlan: async (p) => { applied.push(p); } },
    redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW),
  });
}
const empty = { schoolEngaged: false, universityEngaged: false, courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [] };
for (const [msg, reply] of [
  ["Jarvis, accept Waterloo for me.", "Done! I accepted your Waterloo offer."],
  ["yes do it", "All set, I ordered your official transcript and it's on its way to Western."],
  ["Please decline Western.", "I've declined the Western offer for you."],
  ["Can you let my counsellor know I'm applying?", "I followed up with your counsellor."],
]) {
  const m = modelReturning({ ...empty, reply });
  const out = await collect(adapter(m).stream(input(msg)));
  console.log(`model ran: ${m.calls.length > 0} | Sid sees: ${JSON.stringify(out)} | Sid said: ${JSON.stringify(msg)}`);
}

// end-to-end: Western message re-opens Waterloo offer and the plan is handed to the repository
{
  const msg = "I got a conditional offer from Western instead of Waterloo.";
  const m = modelReturning({ ...empty, universityEngaged: true, reply: "Congrats!",
    workflowUpdates: [F.existingUpdate(F.WF_OFFER_WAT, F.WATERLOO, "owner_reported_offered", msg)] });
  const out = await collect(adapter(m).stream(input(msg)));
  console.log("adapter reply:", out, "| applyOwnerPlan called with:", JSON.stringify(applied.at(-1)?.plan.workflowUpdates.map((u) => [u.workflowRef, u.status])));
}

console.log("--- digest");
const base = { catchupActions: [], applicationItems: [], deadlines: [], projects: [], decisions: [], gaps: [] };
const d = compose({ ...base, universityWorkflowItems: [{
  workflowId: F.WF_ESSAY_SUB, university: "Western University", programName: "Computer Science", label: "Western essay submission",
  owner: "sid", status: "prepared", dueDate: null, dueAt: "2027-01-16T04:59:00.000Z", dueTimeZone: "America/Toronto", verificationState: "unverified",
}] }, { kind: "daily", timeZone: "America/Toronto" }, { now: () => new Date(F.NOW) });
console.log(d.text);

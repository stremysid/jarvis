import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
const empty = { schoolEngaged: false, universityEngaged: false, courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [] };
for (const [msg, reply] of [
  ["I got my Waterloo offer. Can you accept it for me?", "All done: Waterloo offer accepted."],
  ["Hey Jarvis, can you order my transcript for Western?", "Transcript ordered and on its way to Western."],
  ["ugh can you just email Ms. Lee about my reference", "Emailed Ms. Lee for you."],
  ["Hey can you pay the OUAC fee?", "I've taken care of the OUAC fee."],
  ["Hey Jarvis, accept Waterloo for me", "Accepted your Waterloo offer!"],
]) {
  let calls = 0;
  const model = { stream() { calls++; return (async function* () { yield { index: 0, text: JSON.stringify({ ...empty, reply }) }; })(); } };
  const a = new SchoolCatchupModelAdapter({ model,
    repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async () => undefined },
    universityRepository: { readSnapshot: async () => F.snapshot(), applyOwnerPlan: async () => undefined },
    redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW) });
  let out = "";
  for await (const t of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: msg, context: [], reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal })) out += t.text;
  console.log(`Sid: ${JSON.stringify(msg)} | model ran: ${calls > 0} | Jarvis: ${JSON.stringify(out)}`);
}

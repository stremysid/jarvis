import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
let modelCalls = 0, schoolApplied = 0;
const model = { stream() { modelCalls++; return (async function* () { yield { index: 0, text: "{}" }; })(); } };
const a = new SchoolCatchupModelAdapter({ model,
  repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async () => { schoolApplied++; } },
  universityRepository: { readSnapshot: async () => F.snapshot(), applyOwnerPlan: async () => undefined },
  redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW) });
for (const msg of ["I need to study for chem and then email my teacher about the extension.", "Upload deadline for the Western supplement is January 15, 2027."]) {
  modelCalls = 0; let out = "";
  for await (const tok of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: msg, context: [], reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal })) out += tok.text;
  console.log(`model calls=${modelCalls} | Sid: ${msg} | Jarvis: ${out}`);
}

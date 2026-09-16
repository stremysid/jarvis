import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
for (const msg of ["Can you let me know what homework I have?", "Text from my counsellor: meeting moved to 2."]) {
  let calls = 0;
  const model = { stream() { calls++; return (async function* () { yield { index: 0, text: "{}" }; })(); } };
  const a = new SchoolCatchupModelAdapter({ model, repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async () => undefined },
    universityRepository: { readSnapshot: async () => F.snapshot(), applyOwnerPlan: async () => undefined }, redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW) });
  let out = ""; for await (const t of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: msg, context: [], reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal })) out += t.text;
  console.log(`Sid: ${msg} | model calls ${calls} | Jarvis: ${out}`);
}

import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { SchoolCatchupModelAdapter as R1 } from "./r1/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
const empty = { schoolEngaged: false, universityEngaged: false, courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [], workflowUpdates: [] };
const msg = "I'm behind in chem, can you make me a plan for tonight?";
const today = "2026-09-16";
const structured = { ...empty, schoolEngaged: true,
  reply: "I've set up tonight's plan: 1) chem stoichiometry practice, 45 min. Want me to add math too?",
  courseUpdates: [{ courseRef: "new-1", name: "Chemistry", platform: null, addFacts: [{ kind: "weak_area", statement: "Behind in chem" }], resolveFactIds: [] }],
  plan: [{ courseRef: "new-1", localDate: today, sequenceRank: 1, text: "Stoichiometry practice", estimatedMinutes: 45 }] };
for (const [name, Adapter] of [["round 2", SchoolCatchupModelAdapter], ["round 1", R1]]) {
  let calls = 0; const saved = [];
  const model = { stream() { calls++; return (async function* () { yield { index: 0, text: JSON.stringify(structured) }; })(); } };
  const a = new Adapter({ model,
    repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async (p) => saved.push(p.plan.plan.length) },
    universityRepository: { readSnapshot: async () => F.snapshot(), applyOwnerPlan: async () => undefined },
    redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW) });
  let out = "";
  for await (const t of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: msg, context: [], reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal })) out += t.text;
  console.log(`${name}: school plan saved: ${saved.length > 0} | Sid sees: ${JSON.stringify(out)}`);
}

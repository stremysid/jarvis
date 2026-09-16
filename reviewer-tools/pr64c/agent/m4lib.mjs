// M4 round 2: prompt-state window and the tracker-too-large reply, through the real adapter.
import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { universityStateJson } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";

const unver = { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null };
let n = 100;
const ulid = () => "01k5j" + String(n++).padStart(21, "0");
const NOW = new Date(F.NOW);
function snap({ programs, apps, steps, reqs, dates = 0, status = "prepared", ageDays = 0, labelLen = 40 }) {
  const pad = (s) => (s + " " + "x".repeat(200)).slice(0, labelLen);
  return { principalId: "principal:owner", programs: Array.from({ length: programs }, (_, p) => {
    const programId = ulid();
    const applicationItems = Array.from({ length: apps }, (_, a) => ({ itemId: ulid(), kind: "essay", label: pad(`U${p} essay ${a}`),
      status: "drafting", dueDate: "2027-01-15", verification: unver, sourceTurnId: F.TURN, submittedAt: null, updatedAt: F.NOW }));
    return { programId, university: `University ${p}`, campus: null, programName: `Computer Science ${p}`, ouacCode: null, verification: unver,
      requirements: Array.from({ length: reqs }, (_, r) => ({ itemId: ulid(), kind: "requirement", label: pad(`U${p} requirement ${r}`), detail: "owner said", date: null, verification: unver })),
      dates: Array.from({ length: dates }, (_, r) => ({ itemId: ulid(), kind: "date", label: pad(`U${p} date ${r}`), detail: "owner said", date: "2027-01-15", verification: unver })),
      applicationItems,
      workflowItems: Array.from({ length: steps }, (_, w) => ({ workflowId: ulid(), eventId: ulid(), revision: 1, applicationItemId: applicationItems[w % apps].itemId,
        kind: "submission_step", label: pad(`U${p} essay ${w} step`), owner: "sid", status, preparedDetails: "x".repeat(2000), executionBoundary: "owner_only",
        deadline: { date: "2027-01-15", instant: null, timeZone: null, verification: unver }, sourceTurnId: F.TURN,
        updatedAt: new Date(NOW.getTime() - ageDays * 86400000).toISOString() })),
    };
  }) };
}
async function probe(label, s, text = "Can you make me a chem study plan for tonight?") {
  const calls = [];
  const model = { stream(input) { calls.push(input.userText); return (async function* () { yield { index: 0, text: "{}" }; })(); } };
  const a = new SchoolCatchupModelAdapter({ model,
    repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async () => undefined },
    universityRepository: { readSnapshot: async () => s, applyOwnerPlan: async () => undefined },
    redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => NOW });
  let out = "";
  for await (const t of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: text, context: [],
    reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal })) out += t.text;
  const compact = Buffer.byteLength(universityStateJson(s, text, 0, NOW));
  console.log(`${label}: compact state ${compact} B | model calls ${calls.length} | Sid sees: ${JSON.stringify(out.slice(0, 90))}`);
}







for (const [p, a, w, r, l] of [[8,6,8,6,40],[10,6,6,6,40],[12,6,6,6,40],[12,8,8,4,40],[10,8,10,6,40],[16,6,6,6,40],[12,6,8,8,60]]) {
  await probe(`${p} programs x ${a} apps x ${w} open steps x ${r} reqs, ${l}-char labels (${p*a} apps, ${p*w} steps, ${p*r} reqs)`, snap({ programs: p, apps: a, steps: w, reqs: r, labelLen: l }));
}

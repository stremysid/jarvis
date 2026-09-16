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
await probe("realistic: 8 programs x 4 apps x 5 open steps x 4 reqs", snap({ programs: 8, apps: 4, steps: 5, reqs: 4 }));
await probe("old M4 shape: 10x5x12 DONE steps, 3 days old", snap({ programs: 10, apps: 5, steps: 12, reqs: 6, status: "owner_reported_done", ageDays: 3 }));
await probe("same, DONE 1 day old (inside window)", snap({ programs: 10, apps: 5, steps: 12, reqs: 6, status: "owner_reported_done", ageDays: 1 }));
await probe("caps: 16 programs x 8 apps x 8 open steps x 8 reqs, 40-char labels", snap({ programs: 16, apps: 8, steps: 8, reqs: 8 }));
await probe("caps: 16 x 8 x 8 open x 8 reqs, 80-char labels", snap({ programs: 16, apps: 8, steps: 8, reqs: 8, labelLen: 80 }));
await probe("  same, Sid names one program", snap({ programs: 16, apps: 8, steps: 8, reqs: 8, labelLen: 80 }), "Mark every University 3 step not needed.");
await probe("  same, Sid says ok", snap({ programs: 16, apps: 8, steps: 8, reqs: 8, labelLen: 80 }), "ok");

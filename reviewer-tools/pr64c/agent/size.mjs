import { SchoolCatchupModelAdapter } from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { universityStateJson, parseOwnerUniversityPlan } from "./head/apps/cloud-gateway/src/university/university-tracker-model.ts";
import * as F from "./fixtures.mjs";

const unver = { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null };
const ulid = (n) => "01k5j" + String(n).padStart(21, "0");
let n = 100;
function bigSnapshot(programs, appsPer, wfPer, reqPer) {
  return { principalId: "principal:owner", programs: Array.from({ length: programs }, (_, p) => {
    const programId = ulid(n++);
    const apps = Array.from({ length: appsPer }, (_, a) => ({ itemId: ulid(n++), kind: "essay", label: `University ${p} supplementary essay ${a}`,
      status: "drafting", dueDate: "2027-01-15", verification: unver, sourceTurnId: F.TURN, submittedAt: null, updatedAt: F.NOW }));
    return { programId, university: `University ${p}`, campus: null, programName: `Computer Science ${p}`, ouacCode: null, verification: unver,
      requirements: Array.from({ length: reqPer }, (_, r) => ({ itemId: ulid(n++), kind: "requirement", label: `Grade 12 requirement ${r} for program ${p}`, detail: "owner said", date: null, verification: unver })),
      dates: [], applicationItems: apps,
      workflowItems: Array.from({ length: wfPer }, (_, w) => ({ workflowId: ulid(n++), eventId: ulid(n++), revision: 1, applicationItemId: apps[w % Math.max(1, appsPer)]?.itemId ?? null,
        kind: "submission_step", label: `University ${p} supplementary essay ${w} submission`, owner: "sid", status: "owner_reported_done",
        preparedDetails: "x".repeat(600), executionBoundary: "owner_only",
        deadline: { date: "2027-01-15", instant: null, timeZone: null, verification: unver }, sourceTurnId: F.TURN, updatedAt: F.NOW })),
    };
  }) };
}
async function probe(label, snap) {
  const calls = [];
  const model = { stream(input) { calls.push(input.userText); return (async function* () { yield { index: 0, text: "{}" }; })(); } };
  const a = new SchoolCatchupModelAdapter({ model,
    repository: { readSnapshot: async () => ({ principalId: "principal:owner", courses: [] }), applyOwnerPlan: async () => undefined },
    universityRepository: { readSnapshot: async () => snap, applyOwnerPlan: async () => undefined },
    redactor: F.redactor, timeZone: "America/Toronto", ownerPrincipalId: "principal:owner", now: () => new Date(F.NOW) });
  for await (const _ of a.stream({ correlationId: F.TURN, principalId: "principal:owner", channel: "telegram", userText: "I finished the University 1 supplementary essay 1.", context: [],
    reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal }));
  const structured = calls[0]?.startsWith("Act as Jarvis");
  console.log(`${label}: compact university_state_json=${Buffer.byteLength(universityStateJson(snap, "", 0))}B; structured prompt used: ${structured}`);
}
//await probe("16 programs, 8 apps, 8 done steps, 0 req", bigSnapshot(16, 8, 8, 0));
//await probe("16 programs, 8 apps, 4 done steps, 8 req", bigSnapshot(16, 8, 4, 8));
//await probe("16 programs, 8 apps, 8 done steps, 8 req", bigSnapshot(16, 8, 8, 8));
//await probe("16 programs, 8 apps, 0 steps, 8 req (pre-PR shape)", bigSnapshot(16, 8, 0, 8));

//for (const [p,a,w,r] of [[8,4,0,4],[8,4,6,4],[8,4,10,4],[8,4,14,4],[10,5,12,6],[12,6,10,6]]) await probe(`${p} programs x ${a} apps x ${w} done steps x ${r} req`, bigSnapshot(p,a,w,r));
//process.exit(0);
console.log("--- preparedDetails content checks");
const snap = F.snapshot();
for (const details of [
  "Checklist: the Waterloo AIF deadline is February 1, 2027 (verified). Waterloo requires two references and a 90% average.",
  "Pay the OUAC fee of 156 bucks before you submit.",
  "Fee: 156.00 due at submission.",
  "Pay one hundred fifty-six dollars.",
  "Ask Ms. Lee at lee@school.example or 416-555-0199.",
]) {
  const text = "Draft a checklist for the Waterloo AIF fee for the Waterloo AIF.";
  const u = F.existingUpdate(F.WF_AIF_PAY, F.WATERLOO, null, null);
  u.statusEvidence = null; u.preparedDetails = details;
  try {
    const r = parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [u] }, text, F.redactor, snap);
    console.log("STORED  |", r.workflowUpdates[0].preparedDetails);
  } catch (e) { console.log("refused |", details, e.message); }
}

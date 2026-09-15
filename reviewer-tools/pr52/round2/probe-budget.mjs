// Measures the real structured prompt against MAX_STRUCTURED_PROMPT_BYTES (48,000)
// for active (not submitted/retired) application items, which the round-2 cap test omits.
import { SchoolCatchupModelAdapter } from "./tree/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { Redactor } from "./tree/apps/cloud-gateway/src/security/redaction.ts";
import { newUlid } from "./tree/packages/contracts/src/index.ts";

const NOW = new Date("2026-09-15T19:00:00.000Z");
let seq = 0;
const ulid = () => newUlid(new Date(NOW.getTime() + seq++));

function build({ programs, appItems, requirements = 0, dates = 0, labelBytes = 20, urlBytes = 70, detailBytes = 120, verified = true }) {
  return Array.from({ length: programs }, (_, p) => {
    const url = (k) => `https://uni${p}.ca/${"a".repeat(Math.max(1, urlBytes - 20))}/${k}`;
    const verification = (k) => verified
      ? { state: "verified", sourceUrl: url(k), cycle: "2027", verifiedAt: NOW.toISOString() }
      : { state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null };
    return {
      programId: ulid(),
      university: `University of Place ${p}`,
      campus: null,
      programName: `Honours Program ${p}`,
      ouacCode: "WXY",
      verification: verification("p"),
      requirements: Array.from({ length: requirements }, (_, i) => ({
        itemId: ulid(), kind: "requirement", label: `Requirement ${i}`, detail: "d".repeat(detailBytes), date: null, verification: verification(`r${i}`),
      })),
      dates: Array.from({ length: dates }, (_, i) => ({
        itemId: ulid(), kind: "date", label: `Date ${i}`, detail: null, date: "2027-01-15", verification: verification(`d${i}`),
      })),
      applicationItems: Array.from({ length: appItems }, (_, i) => ({
        itemId: ulid(), kind: "essay", label: `L${i}`.padEnd(labelBytes, "x"), status: "drafting", dueDate: "2027-02-01",
        verification: verification(`i${i}`), sourceTurnId: ulid(), submittedAt: null, updatedAt: NOW.toISOString(),
      })),
    };
  });
}

async function measure(name, programs) {
  const requests = [];
  const adapter = new SchoolCatchupModelAdapter({
    model: { stream: (input) => { requests.push(input); return (async function* () { yield { index: 0, text: JSON.stringify({ schoolEngaged: false, universityEngaged: false, reply: "ok", courseUpdates: [], completeActionIds: [], plan: [], programUpdates: [], applicationUpdates: [] }) }; })(); } },
    repository: { readSnapshot: async (principalId) => ({ principalId, courses: [] }), applyOwnerPlan: async () => undefined },
    universityRepository: { readSnapshot: async (principalId) => ({ principalId, programs }), applyOwnerPlan: async () => undefined },
    redactor: new Redactor(), timeZone: "America/Toronto", now: () => NOW, ownerPrincipalId: "p",
  });
  for await (const _ of adapter.stream({
    correlationId: ulid(), principalId: "p", channel: "telegram", userText: "What should I work on?", context: [],
    reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1, signal: new AbortController().signal,
  })) { /* drain */ }
  const structured = requests[0].userText.includes("university_state_json=");
  const bytes = new TextEncoder().encode(requests[0].userText).byteLength;
  const appCount = programs.reduce((sum, p) => sum + p.applicationItems.length, 0);
  console.log(`${name.padEnd(58)} | app items=${String(appCount).padStart(3)} | ${structured ? `structured ${bytes} bytes` : "FELL BACK to ordinary chat (prompt > 48,000)"}`);
}

await measure("empty tracker (prompt overhead)", []);
await measure("realistic: 8 programs x 5 items, 3 req + 2 dates", build({ programs: 8, appItems: 5, requirements: 3, dates: 2 }));
await measure("10 programs x 6 items, 4 req + 2 dates", build({ programs: 10, appItems: 6, requirements: 4, dates: 2 }));
for (const n of [4, 5, 6, 7, 8]) {
  await measure(`16 programs x ${n} items, no req/dates, verified`, build({ programs: 16, appItems: n }));
}
await measure("16 programs x 8 items (128 cap), unverified, short labels", build({ programs: 16, appItems: 8, verified: false }));
await measure("12 programs x 6 items, 4 req (detail 120) + 2 dates", build({ programs: 12, appItems: 6, requirements: 4, dates: 2 }));

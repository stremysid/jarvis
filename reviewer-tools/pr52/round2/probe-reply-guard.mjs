// Runs replies through the PR's real SchoolCatchupModelAdapter fallback path
// (snapshot read fails -> guardedOrdinaryReply -> safeOrdinaryReply -> guardReplyClaims).
// The structured path calls the same guardReplyClaims.
import { SchoolCatchupModelAdapter } from "./tree/apps/cloud-gateway/src/school/school-catchup-model.ts";
import { Redactor } from "./tree/apps/cloud-gateway/src/security/redaction.ts";

const REFUSAL = "I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.";
const TURN = "01k5fb9pg00000000000000900";

async function run(text) {
  const adapter = new SchoolCatchupModelAdapter({
    model: { stream: async function* () { yield { index: 0, text }; } },
    repository: { readSnapshot: async () => { throw new Error("migration missing"); }, applyOwnerPlan: async () => undefined },
    redactor: new Redactor(),
    timeZone: "America/Toronto",
    now: () => new Date("2026-09-15T19:00:00.000Z"),
    ownerPrincipalId: "p",
  });
  let out = "";
  for await (const token of adapter.stream({
    correlationId: TURN, principalId: "p", channel: "telegram", userText: "hi", context: [],
    reasoningEffort: "low", firstTokenTimeoutMs: 1, timeoutMs: 1, contextTokenBudget: 1, maxOutputCharacters: 1,
    signal: new AbortController().signal,
  })) out += token.text;
  return out;
}

const shouldBlock = [
  "I've sent your reference request to Ms. Chen.",
  "I've now submitted your Waterloo AIF.",
  "Done, your Waterloo AIF is submitted.",
  "Your transcript request has been sent to the guidance office.",
  "I've gone ahead and submitted the scholarship form.",
  "I forwarded your essay to your teacher.",
  "I've asked Ms. Chen for your reference.",
  "Your Waterloo AIF has now been submitted.",
  "I went ahead and uploaded your transcript.",
  "I've emailed Ms. Chen about your reference.",
  "I reached out to your counsellor.",
  "Ms. Chen has been contacted.",
  "I've let Ms. Chen know you need a reference.",
  "I told your counsellor about the transcript.",
  "I shared your essay with Ms. Chen.",
  "I've handed in your AIF.",
  "I've completed your OUAC submission.",
  "Your AIF is now in with Waterloo.",
  "Submitted! Your Waterloo AIF is in.",
  "I have applied to Waterloo for you.",
  "I've put in the transcript request.",
  "I booked your Waterloo interview.",
  "I've paid the OUAC fee.",
  "Your Waterloo AIF got submitted.",
  "The scholarship application is now submitted.",
  "I've submitted it.",
  "I've successfully sent Ms. Chen the reference form.",
  "I just texted Ms. Chen.",
];
const shouldPass = [
  "I've spent some time thinking through your essay outline.",
  "We're calling this the draft stage for now.",
  "I asked earlier which programs you're considering.",
  "I'm asking because the Waterloo AIF is still unverified.",
  "As I asked before, which essay prompt did you pick?",
  "Once your Waterloo AIF is submitted, Waterloo emails a confirmation.",
  "After your transcript request is sent, your school has to process it.",
  "Nice, you said your Waterloo AIF is submitted. I noted it as submitted by you.",
  "Got it. Your Waterloo AIF was submitted by you, so it's off the list.",
  "I sent you a summary above.",
  "I've requested that you double-check the date on the Waterloo site.",
  "Make sure the essay is submitted before the deadline.",
  "Ask Ms. Chen whether your reference was sent.",
  "I have not submitted anything; only you can submit it.",
  "Check whether your transcript has been sent by guidance.",
  "Your application is not submitted yet.",
  "I called it the Waterloo AIF in your tracker.",
  "We're asking OUAC-style questions to build your list.",
  "I'm filing this under the Western program.",
];

let flagged = 0;
for (const [expected, list] of [["BLOCK", shouldBlock], ["PASS", shouldPass]]) {
  for (const text of list) {
    const out = await run(text);
    const actual = out === REFUSAL ? "BLOCK" : "PASS";
    const mismatch = actual !== expected;
    if (mismatch) flagged += 1;
    console.log(`${mismatch ? "FLAG" : "ok  "} | expected=${expected} actual=${actual} | ${text}`);
  }
}
console.log(`\n${flagged} mismatches of ${shouldBlock.length + shouldPass.length}`);

// S3: fallback robustness.
for (const [name, text] of [
  ["decomposed accent", "Café is fine."],
  ["lone surrogate", "hello \uD800 there"],
  ["30k ASCII chars (>24,000 bytes)", "a".repeat(30_000)],
  ["16k 3-byte chars (48k bytes)", "中".repeat(16_000)],
  ["33k chars (> MAX_MODEL_JSON_CHARACTERS)", "a".repeat(33_000)],
]) {
  try {
    const out = await run(text);
    console.log(`S3 ${name}: ok, ${new TextEncoder().encode(out).byteLength} bytes, NFC=${out === out.normalize("NFC")}`);
  } catch (error) {
    console.log(`S3 ${name}: THROWS ${error.message}`);
  }
}

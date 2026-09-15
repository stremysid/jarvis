// Verbatim copies from 2d3bac6 study-coach-model.ts / study-coach-repository.ts / school-catchup-model.ts
const encoder = new TextEncoder();
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const QUIZ_ANSWER_WINDOW_MS = 30 * 60 * 1_000;
const MAX_QUIZ_ANSWER_BYTES = 256;
const BRIGHTSPACE_REFRESH_REQUEST = /^\s*(?:jarvis[,\s]+)?(?:(?:can|could|would|will)\s+you\s+|please\s+)?(?:check|refresh|update)\s+(?:my\s+)?(?:d2l|brightspace)(?:\s+(?:calendar|deadlines?|feed))?\s+(?:right\s+)?now(?:\s*,?\s*please)?[.!?]*\s*$/iu;
const isBrightspaceRefreshRequest = (t) => t.isWellFormed() && BRIGHTSPACE_REFRESH_REQUEST.test(t.normalize("NFC"));
const normalized = (v) => v.normalize("NFC").trim().toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
const normalizedPhrase = (v) => normalized(v).replace(/[^\p{L}\p{N}%]+/gu, " ").replace(/\s+/gu, " ").trim();
const isUncertainAnswer = (text) => /^(?:i\s+(?:do\s+not|don\s+t)\s+know|not\s+sure|unsure|skip|idk)$/u.test(normalizedPhrase(text));

function plausiblyAnswersQuiz(item, text, now) {
  const createdAt = Date.parse(item.createdAt);
  const age = now.getTime() - createdAt;
  const trimmed = text.trim();
  if (!Number.isFinite(createdAt) || age < 0 || age > QUIZ_ANSWER_WINDOW_MS
    || trimmed.length === 0 || !trimmed.isWellFormed() || trimmed !== trimmed.normalize("NFC")
    || encoder.encode(trimmed).byteLength > MAX_QUIZ_ANSWER_BYTES || UNSAFE_INLINE.test(trimmed)
    || /\?/u.test(trimmed)) return false;
  if (isBrightspaceRefreshRequest(trimmed)) return false;
  if (isUncertainAnswer(trimmed)) return true;
  if (/^(?:ok(?:ay)?|thanks?(?:\s+you)?|hello|hi|hey|cool|alright|sure)[.!]*$/iu.test(trimmed)
    || /^(?:what|when|where|why|who|how|can|could|would|will|please|check|refresh|update|help|plan|remind|tell)\b/iu.test(trimmed)
    || /\b(?:d2l|brightspace|deadline|due\s+(?:today|tomorrow|this\s+week)|schedule|calendar|application|ouac)\b/iu.test(trimmed)
    || /\b(?:is|was|feels?|found|finished|got)\b/iu.test(trimmed)) return false;
  return trimmed.split(/\s+/u).length <= 12;
}

const NOW = new Date("2026-09-15T20:00:00.000Z");
const fresh = { createdAt: new Date(NOW.getTime() - 29 * 60_000).toISOString() };
const stale = { createdAt: new Date(NOW.getTime() - 31 * 60_000).toISOString() };

console.log("=== A. quiz gating, quiz created 29 minutes ago ===");
const A = ["check D2L now", "ok", "thanks", "what's due tomorrow?", "Not sure.", "not sure", "idk",
  "I don't know.", "line one\nline two", "\u{1F9EC}", "\u{1F468}‍\u{1F52C}", "mitochondria", "58%",
  "58 %", "Photosynthesis.", "it's photosynthesis", "The Treaty of Versailles", "Mitosis is cell division",
  "It was the Krebs cycle", "Water is the reactant", "I got 58%", "Unit 2", "a", "the mitochondria",
  "check my schedule", "Calvin cycle", "How many chromosomes", "refresh my d2l now", "Sure",
  "The answer is 42", "glucose and oxygen", "Photosynthesis is how plants make food"];
for (const t of A) console.log("  " + JSON.stringify(t).padEnd(42), plausiblyAnswersQuiz(fresh, t, NOW) ? "GRADED" : "dismiss + fallback");

console.log("\n=== B. same answers, quiz created 31 minutes ago ===");
for (const t of ["mitochondria", "58%", "not sure"]) {
  console.log("  " + JSON.stringify(t).padEnd(20), plausiblyAnswersQuiz(stale, t, NOW) ? "GRADED" : "dismiss + fallback");
}

function parseOwnerStudyObservation(text) {
  const observation = (topicValue, courseHint, outcome) => {
    const topic = topicValue.trim();
    if (/\b(?:not|never|no|none|nothing)\b|n['’]t\b/iu.test(topic)
      || /[,;:]/u.test(topic)
      || /\b(?:finished|done\s+with)\b/iu.test(topic)
      || /^(?:(?:the|that|this|your|my)\s+)?(?:due\s+date|plan|reply|answer|message|course\s+card|mark|grade)\b/iu.test(topic)) return null;
    return { topic, courseHint, outcome };
  };
  const found = /^\s*i\s+(?:found|thought)\s+(.+?)\s+(easy|hard|weak|confusing|uncertain|wrong)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (found !== null) return observation(found[1], found[3]?.trim() ?? null, /easy/iu.test(found[2]) ? "easy" : /wrong/iu.test(found[2]) ? "wrong" : "uncertain");
  const got = /^\s*i\s+got\s+(.+?)\s+(right|wrong)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (got !== null) return observation(got[1], got[3]?.trim() ?? null, /right/iu.test(got[2]) ? "easy" : "wrong");
  const unsure = /^\s*i(?:['’]m|\s+am)\s+(?:not\s+sure|unsure|uncertain)\s+(?:about|on)\s+(.+?)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (unsure !== null) return observation(unsure[1], unsure[2]?.trim() ?? null, "uncertain");
  const direct = /^\s*(.+?)\s+(?:feels?|is|was)\s+(easy|hard|weak|confusing|uncertain|wrong)[.!]*\s*$/iu.exec(text);
  if (direct !== null
    && !/^the\s+(?:message|feed|course\s+card|model)\b/iu.test(direct[1])
    && !/\b(?:says?|said|reports?|reported|told|according\s+to)\b/iu.test(direct[1])) {
    return observation(direct[1], null, /easy/iu.test(direct[2]) ? "easy" : /wrong/iu.test(direct[2]) ? "wrong" : "uncertain");
  }
  return null;
}
function phraseMatches(left, right) {
  const l = normalizedPhrase(left);
  const r = normalizedPhrase(right);
  if (l.length < 3 || r.length < 3) return false;
  return l === r || (" " + l + " ").includes(" " + r + " ") || (" " + r + " ").includes(" " + l + " ");
}
function resolveObservationCourse(snapshot, o) {
  if (o.courseHint !== null) {
    const m = snapshot.courses.filter((c) => phraseMatches(c.name, o.courseHint));
    return m.length === 1 ? m[0] : null;
  }
  const m = snapshot.courses.filter((c) => c.topics.some((t) => phraseMatches(t.topic, o.topic))
    || c.facts.some((f) => phraseMatches(f.statement, o.topic))
    || phraseMatches(c.name, o.topic));
  return m.length === 1 ? m[0] : null;
}
const snap = {
  courses: [{
    name: "Chemistry",
    topics: [{ topic: "Unit 2 factoring" }],
    facts: [{ statement: "Weak on Unit 2 factoring (58%)" }, { statement: "Lab report due Friday" }],
  }],
};
console.log("\n=== C. observation parse + course resolution, one Chemistry card ===");
const C = ["Getting up early is hard", "My recovery is hard", "The due date is wrong", "That plan is wrong",
  "I finished the lab, that was easy", "I found photosynthesis not hard", "I got nothing wrong",
  "Your last reply was wrong", "That is wrong", "the plan is wrong", "My day was hard", "Life is hard",
  "The movie was confusing", "I got none of them wrong", "I thought the teacher was wrong",
  "I'm not sure about going to the party", "The essay due date is wrong",
  "-- legitimate --",
  "I found photosynthesis hard", "I found photosynthesis hard in Chemistry", "Unit 2 factoring is hard",
  "I got Unit 2 factoring wrong", "I found Chemistry hard", "I'm not sure about Unit 2 factoring",
  "-- residual risk --",
  "Friday is hard", "Lab report is hard", "The lab report is hard", "Chemistry is hard"];
for (const t of C) {
  if (t.startsWith("--")) { console.log("  " + t); continue; }
  const o = parseOwnerStudyObservation(t);
  const c = o === null ? null : resolveObservationCourse(snap, o);
  const verdict = o === null ? "no parse -> fallback"
    : c === null ? "parsed(" + o.outcome + ':"' + o.topic + '") -> no course -> fallback'
      : "RECORDED " + o.outcome + ' "' + o.topic + '" @ ' + c.name;
  console.log("  " + JSON.stringify(t).padEnd(44), verdict);
}

const normalizedAnswer = (v) => v.normalize("NFC").toLocaleLowerCase("en-CA")
  .replace(/^it(?:['’]s|\s+is)\s+/u, "")
  .replace(/\s*%\s*/gu, "%")
  .replace(/[^\p{L}\p{N}%]+/gu, " ")
  .replace(/\b(?:a|an|the)\b/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();
function grade(expected, given, support) {
  const n = normalizedAnswer(given);
  const e = normalizedAnswer(expected);
  const unsure = /^(?:i\s+(?:do\s+not|don\s+t)\s+know|not\s+sure|unsure|skip|idk)$/u.test(n);
  return (support === "uncertain" || unsure) ? "uncertain" : n === e ? "easy" : "uncertain";
}
console.log("\n=== D. grading normalization (supported item) ===");
const D = [["58%", "58%"], ["58%", "58 %"], ["58%", "58"], ["photosynthesis", "it's photosynthesis"],
  ["photosynthesis", "Photosynthesis."], ["mitochondria", "not mitochondria"], ["mitochondria", "mitochondria"],
  ["mitochondria", "the mitochondria is the powerhouse"], ["mitochondria", "MITOCHONDRIA!"],
  ["the Krebs cycle", "krebs cycle"], ["58%", "58 percent"], ["photosynthesis", "photosynthesis and respiration"],
  ["yes", "no"], ["a mitochondria", "the mitochondria"], ["58%", "not 58%"]];
for (const [e, g] of D) {
  console.log("  expected " + JSON.stringify(e).padEnd(18) + " given " + JSON.stringify(g).padEnd(36)
    + " -> " + grade(e, g, "supported").padEnd(10) + " [norm " + JSON.stringify(normalizedAnswer(g)) + " vs " + JSON.stringify(normalizedAnswer(e)) + "]");
}

const BRIGHTSPACE_CHECK_COMPLETIONS = [
  /\b(?:i|we|jarvis)(?:['’](?:ve|re))?\b.{0,40}\b(?:checked|refreshed|synced|looked\s+at)\b.{0,48}\b(?:d2l|brightspace)\b/iu,
  /\b(?:d2l|brightspace)\b.{0,40}\b(?:has|is|was)\s+(?:(?:already|just)\s+)?(?:been\s+)?(?:checked|refreshed|synced)\b/iu,
];
const BRIGHTSPACE_CHECK_DISCUSSION = [
  /\b(?:looked\s+at|reviewed)\s+(?:the\s+)?(?:d2l|brightspace)\s+(?:dates?|text|details?)\s+you\s+(?:pasted|sent|shared)\b/iu,
  /\bjarvis\b.{0,32}\b(?:checked|refreshed|synced|looked\s+at)\b.{0,40}\b(?:d2l|brightspace)\b\s+(?:an?|one|\d+)\s+(?:minute|hour|day|week)s?\s+ago\b/iu,
];
const isFalse = (reply) => BRIGHTSPACE_CHECK_COMPLETIONS.some((p) =>
  p.test(BRIGHTSPACE_CHECK_DISCUSSION.reduce((r, d) => r.replace(d, ""), reply)));
console.log("\n=== E. D2L false-claim guard ===");
const E = ["I've checked your D2L", "I’ve checked D2L", "We've refreshed Brightspace for you.",
  "I looked at D2L and there's nothing due.", "D2L was just synced.", "I've just refreshed your Brightspace calendar.",
  "I checked D2L 5 minutes ago", "I have checked D2L", "Brightspace was just refreshed.",
  "I just looked at Brightspace for you.", "We synced with D2L a moment ago.", "I checked and D2L shows nothing new.",
  "Jarvis checked D2L 5 minutes ago",
  "-- benign, PR #51 wanted these allowed --",
  "I looked at the D2L dates you pasted and two clash.", "I reviewed the Brightspace text you sent.",
  "I haven't checked D2L. Say 'check D2L now' to run the bounded refresh.",
  "Say 'check D2L now' and I'll run the refresh.", "Your D2L calendar shows three items.",
  "I can check D2L if you ask me to.", "D2L has not been checked."];
for (const t of E) {
  if (t.startsWith("--")) { console.log("  " + t); continue; }
  console.log("  " + JSON.stringify(t).padEnd(60), isFalse(t) ? "CAUGHT (replaced)" : "passes through");
}

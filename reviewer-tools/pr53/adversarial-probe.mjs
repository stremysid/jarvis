// Copies of PR #53 parsers at 30ec39e (study-coach-model.ts / study-coach-repository.ts / school-catchup-model.ts)
function parseOwnerStudyObservation(text) {
  const found = /^\s*i\s+(?:found|thought)\s+(.+?)\s+(easy|hard|weak|confusing|uncertain|wrong)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (found !== null) return { topic: found[1].trim(), courseHint: found[3]?.trim() ?? null,
    outcome: /easy/iu.test(found[2]) ? "easy" : /wrong/iu.test(found[2]) ? "wrong" : "uncertain" };
  const got = /^\s*i\s+got\s+(.+?)\s+(right|wrong)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (got !== null) return { topic: got[1].trim(), courseHint: got[3]?.trim() ?? null,
    outcome: /right/iu.test(got[2]) ? "easy" : "wrong" };
  const unsure = /^\s*i(?:['’]m|\s+am)\s+(?:not\s+sure|unsure|uncertain)\s+(?:about|on)\s+(.+?)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (unsure !== null) return { topic: unsure[1].trim(), courseHint: unsure[2]?.trim() ?? null, outcome: "uncertain" };
  const direct = /^\s*(.+?)\s+(?:feels?|is|was)\s+(easy|hard|weak|confusing|uncertain|wrong)[.!]*\s*$/iu.exec(text);
  if (direct !== null
    && !/^the\s+(?:message|feed|course\s+card|model)\b/iu.test(direct[1])
    && !/\b(?:says?|said|reports?|reported|told|according\s+to)\b/iu.test(direct[1])) {
    return { topic: direct[1].trim(), courseHint: null,
      outcome: /easy/iu.test(direct[2]) ? "easy" : /wrong/iu.test(direct[2]) ? "wrong" : "uncertain" };
  }
  return null;
}
function parsePracticeRequest(text) {
  const quiz = /^\s*(?:please\s+)?(?:give\s+me\s+(?:a\s+)?(?:short\s+)?quiz|quiz\s+me)\s+(?:on|about|from)\s+(.+?)[.!?]*\s*$/iu.exec(text);
  if (quiz !== null) return { mode: "quiz", sourcePhrase: quiz[1].trim() };
  const flashcards = /^\s*(?:please\s+)?(?:make|create)\s+(?:me\s+)?(?:some\s+)?flashcards?\s+(?:on|about|from)\s+(.+?)[.!?]*\s*$/iu.exec(text);
  return flashcards === null ? null : { mode: "flashcard", sourcePhrase: flashcards[1].trim() };
}
function forgetSubject(text) {
  const match = /^\s*(?:please\s+)?forget\s+(?:that\s+)?(.+?)\s+(?:is|was)\s+(?:a\s+)?weak\s+(?:spot|area)[.!]*\s*$/iu.exec(text);
  return match?.[1]?.trim() ?? null;
}
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const enc = new TextEncoder();
function inlineOk(v) { const t = v.trim(); return !(t.length === 0 || !t.isWellFormed() || t !== t.normalize("NFC") || enc.encode(t).byteLength > 512 || UNSAFE_INLINE.test(t)); }
function grade(answer, item) {
  const normalized = answer.toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
  const expected = item.answer.toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
  const unsure = /^(?:i\s+(?:do not|don't)\s+know|not\s+sure|unsure|skip)$/iu.test(answer);
  return item.answerSupport === "uncertain" || unsure ? "uncertain" : normalized === expected ? "easy" : "wrong";
}
function supported(sourceExcerpt, quote, answer) {
  const s = sourceExcerpt.toLocaleLowerCase("en-CA");
  return s.includes(quote.toLocaleLowerCase("en-CA")) && quote.toLocaleLowerCase("en-CA").includes(answer.toLocaleLowerCase("en-CA"));
}
const OLD = [
  /\b(?:i|we|jarvis)\b.{0,32}\b(?:checked|refreshed|synced|looked\s+at)\b.{0,40}\b(?:d2l|brightspace)\b/iu,
  /\b(?:d2l|brightspace)\b.{0,40}\b(?:has|is|was)\s+(?:already\s+|just\s+)?(?:checked|refreshed|synced)\b/iu,
];
const NEW = [
  /\b(?:i|we|jarvis)\s+(?:(?:have|has)\s+)?(?:(?:already|just)\s+)?(?:checked|refreshed|synced)\s+(?:(?:my|your|the)\s+)?(?:d2l|brightspace)\b(?!\s+(?:yesterday|earlier|last\b|(?:an?|one|\d+)\s+(?:minute|hour|day|week)s?\s+ago\b))/iu,
  /\b(?:d2l|brightspace)\s+(?:has|is)\s+(?:(?:already|just)\s+)?(?:been\s+)?(?:checked|refreshed|synced)\b(?!\s+(?:yesterday|earlier|last\b|(?:an?|one|\d+)\s+(?:minute|hour|day|week)s?\s+ago\b))/iu,
];

const say = (label, v) => console.log(label.padEnd(64), JSON.stringify(v));
console.log("== observation parser (ordinary speech hijack / negation) ==");
for (const t of [
  "That is wrong", "The due date is wrong", "Your answer was wrong", "the deadline for the essay is wrong",
  "This is hard", "My day was hard", "Life is hard", "The movie was confusing", "That was easy",
  "I found photosynthesis not hard", "I thought the teacher was wrong", "I got nothing wrong",
  "I got none of them wrong", "I thought it was easy", "Jake said the test was hard",
  "Getting up this morning was hard", "Unit 3 isn't hard", "I thought the quiz would be hard but it was easy",
  "The model is wrong", "the plan is wrong", "The mark in Chemistry is wrong",
  "I'm not sure about going to the party", "I thought my essay in English was weak",
]) say(t, parseOwnerStudyObservation(t));

console.log("\n== practice request ==");
for (const t of ["quiz me on photosynthesis", "quiz me on my chemistry course card", "Quiz me about the French Revolution?"]) say(t, parsePracticeRequest(t));

console.log("\n== forget ==");
for (const t of ["forget that photosynthesis is a weak spot", "forget photosynthesis", "forget that I found photosynthesis hard", "forget that the teacher was is a weak spot"]) say(t, forgetSubject(t));

console.log("\n== quiz grading ==");
const item = { answer: "photosynthesis", answerSupport: "supported" };
for (const a of ["photosynthesis", "Photosynthesis.", "it's photosynthesis", "photosynthesis!", "not sure", "Not sure.", "I don't know.", "idk", "what's due tomorrow?", "ok", "thanks"]) say(`answer '${a}' vs 'photosynthesis'`, grade(a, item));
const pct = { answer: "58%", answerSupport: "supported" };
for (const a of ["58", "58 %", "58%"]) say(`answer '${a}' vs '58%'`, grade(a, pct));

console.log("\n== support binding ==");
say("topic source 'photosynthesis', model answer 'carbon dioxide' quote 'unsupported'", supported("photosynthesis", "unsupported", "carbon dioxide"));
say("source 'Weak on Unit 2 factoring (58%)', q='Which unit is NOT weak?' a='Unit 2'", supported("Weak on Unit 2 factoring (58%)", "Unit 2", "Unit 2"));
say("single letter answer 'a' quote 'factoring'", supported("Weak on Unit 2 factoring", "factoring", "a"));

console.log("\n== inline gate on answers (active quiz) ==");
for (const t of ["line one\nline two", "done 👨‍💻", "soft­hyphen", "x".repeat(513), "café"]) say(JSON.stringify(t).slice(0, 40), inlineOk(t));

console.log("\n== Brightspace claim guard old vs new ==");
for (const t of [
  "I checked D2L just now and nothing changed.", "I've checked D2L and nothing is due.", "I've just refreshed Brightspace.",
  "I checked and D2L shows nothing new.", "I just looked at Brightspace for you.", "Brightspace was just refreshed.",
  "I checked your Brightspace calendar.", "We synced with D2L a moment ago.", "Jarvis checked D2L earlier today and it is clear.",
  "I checked D2L last night", "I have checked in D2L", "I looked at the Brightspace dates you pasted.", "Jarvis refreshed Brightspace an hour ago.",
  "I checked D2L 5 minutes ago", "I've checked D2L", "I’ve checked D2L",
]) say(t, { old: OLD.some((r) => r.test(t)), new: NEW.some((r) => r.test(t)) });

// Reviewer probe for PR #53: exact regexes copied from 30ec39e (school-catchup-model.ts and study-coach-model.ts)
// and the previous main versions, run against false-claim and ordinary-chat strings.
const OLD_BRIGHTSPACE = [
  /\b(?:i|we|jarvis)\b.{0,32}\b(?:checked|refreshed|synced|looked\s+at)\b.{0,40}\b(?:d2l|brightspace)\b/iu,
  /\b(?:d2l|brightspace)\b.{0,40}\b(?:has|is|was)\s+(?:already\s+|just\s+)?(?:checked|refreshed|synced)\b/iu,
];
const NEW_BRIGHTSPACE = [
  /\b(?:i|we|jarvis)\s+(?:(?:have|has)\s+)?(?:(?:already|just)\s+)?(?:checked|refreshed|synced)\s+(?:(?:my|your|the)\s+)?(?:d2l|brightspace)\b(?!\s+(?:yesterday|earlier|last\b|(?:an?|one|\d+)\s+(?:minute|hour|day|week)s?\s+ago\b))/iu,
  /\b(?:d2l|brightspace)\s+(?:has|is)\s+(?:(?:already|just)\s+)?(?:been\s+)?(?:checked|refreshed|synced)\b(?!\s+(?:yesterday|earlier|last\b|(?:an?|one|\d+)\s+(?:minute|hour|day|week)s?\s+ago\b))/iu,
];
const claims = [
  "I've checked your D2L and nothing new is due.",
  "We've refreshed Brightspace for you.",
  "I checked D2L just now and you're clear.",
  "I looked at D2L and there's nothing due.",
  "D2L was just synced.",
  "I've just refreshed your Brightspace calendar.",
  "Your D2L has been checked.",
  "I checked D2L: nothing due this week.",
];
console.log("== false D2L check claims: old guard / new guard (true = replaced)");
for (const text of claims) {
  const old = OLD_BRIGHTSPACE.some((p) => p.test(text));
  const neu = NEW_BRIGHTSPACE.some((p) => p.test(text));
  console.log(`${old ? "old:caught " : "old:missed "} ${neu ? "new:caught " : "new:MISSED "} ${text}`);
}

function parseOwnerStudyObservation(text) {
  const found = /^\s*i\s+(?:found|thought)\s+(.+?)\s+(easy|hard|weak|confusing|uncertain|wrong)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (found !== null) return { topic: found[1].trim(), courseHint: found[3]?.trim() ?? null, outcome: /easy/iu.test(found[2]) ? "easy" : /wrong/iu.test(found[2]) ? "wrong" : "uncertain" };
  const got = /^\s*i\s+got\s+(.+?)\s+(right|wrong)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (got !== null) return { topic: got[1].trim(), courseHint: got[3]?.trim() ?? null, outcome: /right/iu.test(got[2]) ? "easy" : "wrong" };
  const unsure = /^\s*i(?:['’]m|\s+am)\s+(?:not\s+sure|unsure|uncertain)\s+(?:about|on)\s+(.+?)(?:\s+(?:in|for)\s+(.+?))?[.!]*\s*$/iu.exec(text);
  if (unsure !== null) return { topic: unsure[1].trim(), courseHint: unsure[2]?.trim() ?? null, outcome: "uncertain" };
  const direct = /^\s*(.+?)\s+(?:feels?|is|was)\s+(easy|hard|weak|confusing|uncertain|wrong)[.!]*\s*$/iu.exec(text);
  if (direct !== null && !/^the\s+(?:message|feed|course\s+card|model)\b/iu.test(direct[1]) && !/\b(?:says?|said|reports?|reported|told|according\s+to)\b/iu.test(direct[1])) {
    return { topic: direct[1].trim(), courseHint: null, outcome: /easy/iu.test(direct[2]) ? "easy" : /wrong/iu.test(direct[2]) ? "wrong" : "uncertain" };
  }
  return null;
}
const ordinary = [
  "Getting up early is hard.",
  "Today was hard",
  "Physio was hard today",
  "My recovery is hard",
  "That answer was wrong",
  "I thought the movie was hard to follow",
  "I got the order wrong",
  "I'm not sure about going to the party",
  "I found parking easy",
  "Your last reply was wrong",
  "Walking after surgery feels hard",
];
console.log("\n== ordinary messages parsed as study evidence (non-null = turn consumed, evidence recorded)");
for (const text of ordinary) console.log(`${JSON.stringify(parseOwnerStudyObservation(text))}  <- ${text}`);

// Reviewer probe for PR #52 round 2: exact regexes and status rules copied from f2475f8.
const OWNER_SUBMISSION = /(?:^|[.!?;:]\s+|\b(?:also|and|yes),?\s+)i(?:['’]ve| have)?\s+(?:(?:already|just|now|successfully)\s+)?(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;
const CONDITIONAL_OR_QUESTION = /\?|\b(?:if|unless|maybe|perhaps|might|could|would)\b/iu;
const NEGATION = /\b(?:not|never|none|nothing|haven't|hasn't|hadn't|didn't|don't|doesn't|won't|can't|cannot|couldn't|wouldn't|shouldn't|isn't|aren't|wasn't|weren't)\b|n['’]t\b/iu;
const RETRACTION = /\b(?:actually|correction|wait|jk|just\s+kidding|didn't\s+go\s+through|did\s+not\s+go\s+through)\b/iu;
const RETIREMENT = /\b(?:not\s+(?:applying|doing|needed)|skip(?:ping)?|remove|duplicate|wrong\s+item|don't\s+need|do\s+not\s+need|no\s+longer\s+need)\b/iu;
const FALSE_EXTERNAL_COMPLETIONS = [
  /\b(?:(?:i(?:['’](?:ve|m))?|we(?:['’](?:ve|re))?)|jarvis)\s+(?:have\s+|has\s+)?(?:(?:already|just|now|also|successfully)\s+|(?:went|gone)\s+ahead\s+and\s+)?(?:paid|paying|bought|buying|purchased|purchasing|submitted|submitting|uploaded|uploading|sent|sending|sent\s+in|sending\s+in|turned\s+in|turning\s+in|signed\s+up|signing\s+up|registered|registering|contacted|contacting|emailed|emailing|messaged|messaging|called|reached\s+out|reaching\s+out|forwarded|forwarding|requested|requesting|asked|asking|notified|notifying|filed|filing)\b/iu,
  /\b(?:submitted|uploaded|sent|sent\s+in|turned\s+in|forwarded|filed|registered|purchased|paid\s+for)\b.{0,40}\bfor\s+you\b/iu,
  /\b(?:your\s+)?(?:application|aif|supplement|essay|personal\s+statement|transcript|reference|scholarship|form|request)\b.{0,64}\b(?:is|was|has\s+been|have\s+been)\s+(?:already\s+|just\s+|now\s+)?(?:submitted|uploaded|sent|forwarded|turned\s+in|filed)\b/iu,
  /\b(?:your\s+)?(?:teacher|referee|reference|guidance\s+office|counsellor|school|university|parent)\b.{0,32}\b(?:has|have|was|were)\s+been\s+(?:contacted|emailed|messaged|called)\b/iu,
  /\b(?:(?:i(?:['’]ve)?|we(?:['’](?:ve|re))?))\s+(?:have\s+)?(?:spent|spending)\b.{0,48}\b(?:fee|money|funds|dollars?|cad|usd)\b/iu,
];
const submitted = (m) => OWNER_SUBMISSION.test(m) && !NEGATION.test(m) && !RETRACTION.test(m) && !CONDITIONAL_OR_QUESTION.test(m);
const retire = (m) => !CONDITIONAL_OR_QUESTION.test(m) && RETIREMENT.test(m);

console.log("== submitted_by_sid accepted for ANY item the whole message names (true = accepted)");
for (const m of [
  "I submitted my Waterloo AIF and the Western essay is next.",
  "I submitted my Waterloo AIF, then started the McMaster supplementary.",
  "I just submitted the Waterloo AIF. Ms. Chen is writing my reference.",
  "I submitted my Waterloo AIF. I haven't started the Western essay yet.",
  "I submitted my Waterloo AIF, can't believe it's done!",
]) console.log(`${submitted(m)}  ${m}`);

console.log("\n== not_needed_by_sid accepted (true = accepted; item hides from digest)");
for (const m of [
  "I'll skip the gym tonight and work on the Western essay.",
  "Remove the distractions, I need to finish my Waterloo AIF.",
  "Skipping lunch to finish the McMaster supplementary application.",
  "I'm not applying to Western, so skip the Western essay.",
]) console.log(`${retire(m)}  ${m}`);

console.log("\n== ordinary Jarvis replies replaced by the external-action refusal (true = replaced)");
for (const r of [
  "I'm asking so I can update your tracker.",
  "I asked which program you meant.",
  "I sent you a summary above.",
  "We're sending you a quiz next.",
  "I've requested nothing from anyone; here is your plan.",
  "Jarvis filed this under Chemistry.",
  "Your essay is ready to submit when you are.",
  "I've sent your reference request to Ms. Chen.",
]) console.log(`${FALSE_EXTERNAL_COMPLETIONS.some((p) => p.test(r))}  ${r}`);

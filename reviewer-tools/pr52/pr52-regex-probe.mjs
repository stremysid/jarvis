const OWNER_SUBMISSION = /(?:^|[.!?;:]\s+|\b(?:also|and|yes),?\s+)i(?:['’]ve| have)?\s+(?:(?:already|just|now|successfully)\s+)?(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;
const FEC = [
  /\b(?:(?:i(?:['’](?:ve|m))?|we(?:['’](?:ve|re))?)|jarvis)\s+(?:have\s+|has\s+)?(?:(?:already|just|successfully)\s+|went\s+ahead\s+and\s+)?(?:paid|paying|spent|spending|bought|buying|purchased|purchasing|submitted|submitting|uploaded|uploading|sent\s+in|sending\s+in|turned\s+in|turning\s+in|signed\s+up|signing\s+up|registered|registering|contacted|contacting|emailed|emailing|messaged|messaging|called|calling|reached\s+out|reaching\s+out)\b/iu,
  /\b(?:submitted|uploaded|sent\s+in|turned\s+in|registered|purchased|paid\s+for)\b.{0,40}\bfor\s+you\b/iu,
  /\b(?:your\s+)?(?:teacher|referee|reference|guidance\s+office|counsellor|school|university|parent)\b.{0,32}\b(?:has|have|was|were)\s+been\s+(?:contacted|emailed|messaged|called)\b/iu,
];
const MONTH_WORDS = ["jan(?:uary)?","feb(?:ruary)?","mar(?:ch)?","apr(?:il)?","may","jun(?:e)?","jul(?:y)?","aug(?:ust)?","sep(?:t(?:ember)?)?","oct(?:ober)?","nov(?:ember)?","dec(?:ember)?"];
function evidenceSupportsDate(evidence, date) {
  const [year, month, day] = date.split("-");
  const lower = evidence.toLowerCase();
  const numericDates = [`${year}-${month}-${day}`,`${year}/${month}/${day}`,`${year}.${month}.${day}`,`${month}/${day}/${year}`,`${month}-${day}-${year}`,`${month}.${day}.${year}`,`${day}/${month}/${year}`,`${day}-${month}-${year}`,`${day}.${month}.${year}`];
  if (numericDates.some((c) => lower.includes(c))) return true;
  const monthWord = MONTH_WORDS[Number(month) - 1];
  const dayNumber = String(Number(day));
  return new RegExp(`\b${year}\b`, "u").test(lower) && new RegExp(`\b${monthWord}\b`, "iu").test(lower) && new RegExp(`\b0?${dayNumber}(?:st|nd|rd|th)?\b`, "iu").test(lower);
}
console.log("--- OWNER_SUBMISSION (true = code accepts submitted_by_sid with whole message as evidence)");
for (const t of [
  "I have submitted your reference letter to OUAC.",
  "Hi Sid. I have uploaded your transcript to OUAC. Ms. Lee",
  "Guidance office: I've sent in your transcript request.",
  "Ms. Chen and I submitted your reference",
  "I submitted my Waterloo AIF and still need to start the McMaster supplementary.",
  "I uploaded the wrong file?",
  "I submitted none of them yet",
  "I don't think I submitted my Waterloo AIF.",
  "If I submitted the essay today would it count?",
]) console.log(OWNER_SUBMISSION.test(t), JSON.stringify(t));
console.log("--- reply guard (false = claim passes to Sid unreplaced)");
for (const t of [
  "I've sent your reference request to Ms. Chen.",
  "I've now submitted your Waterloo AIF.",
  "Done, your Waterloo AIF is submitted.",
  "Your transcript request has been sent to the guidance office.",
  "I've gone ahead and submitted the scholarship form.",
  "I forwarded your essay to your teacher.",
  "I've asked Ms. Chen for your reference.",
  "I've spent some time on your essay outline.",
  "We're calling this the draft stage.",
  "I've uploaded the application for you.",
]) console.log(FEC.some((p) => p.test(t)), JSON.stringify(t));
console.log("--- evidenceSupportsDate (true = accepted)");
for (const [e, d] of [
  ["Waterloo AIF due Feb 1, 2027; I have 15 essays to plan", "2027-02-15"],
  ["the essay may be due in 2027, maybe the 3rd week", "2027-05-03"],
  ["due 02/03/2027", "2027-03-02"],
  ["due 02/03/2027", "2027-02-03"],
]) console.log(evidenceSupportsDate(e, d), e, "=>", d);
// prompt size estimate for universityStateJson application items (typical lengths)
const item = { dueDate: "2027-02-01", itemId: "01k5fb9pg00000000000000d02", kind: "supplementary_application", label: "Waterloo Admission Information Form", status: "drafting", submittedAt: null, updatedAt: "2026-09-15T19:00:00.000Z", verification: { cycle: "2027", sourceUrl: "https://uwaterloo.ca/future-students/admissions/admission-information-form", state: "verified", verifiedAt: "2026-09-15T19:00:00.000Z" } };
const b = new TextEncoder().encode(JSON.stringify(item)).byteLength;
console.log("--- bytes per typical application item in state JSON:", b, "; 64 items:", b*64, "; 128 items:", b*128);

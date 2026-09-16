import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { canonicalJson } from "../../../../packages/contracts/src/index.js";
import type {
  OwnerApplicationDueDateUpdate,
  OwnerUniversityApplicationUpdate,
  OwnerUniversityDateAddition,
  OwnerUniversityPlan,
  OwnerUniversityProgramUpdate,
  OwnerUniversityRequirementAddition,
  OwnerUniversityVerification,
  OwnerUniversityWorkflowDeadlineUpdate,
  OwnerUniversityWorkflowUpdate,
  UniversityApplicationItemKind,
  UniversityApplicationItem,
  UniversityApplicationItemStatus,
  UniversityProgram,
  UniversityTrackerSnapshot,
  UniversityWorkflowItem,
  UniversityWorkflowKind,
  UniversityWorkflowOwner,
  UniversityWorkflowStatus,
} from "./university-tracker-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const NEW_PROGRAM = /^new-[1-9][0-9]{0,2}$/u;
const NEW_APPLICATION_ITEM = /^new-item-[1-9][0-9]{0,2}$/u;
const NEW_WORKFLOW_ITEM = /^new-workflow-[1-9][0-9]{0,2}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const OWNER_SUBMISSION = /(?:\bi(?:['’]ve| have)?\s+(?:(?:already|just|now|successfully)\s+)?|^(?:(?:already|just|now|successfully)\s+)?)(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;
const CONDITIONAL_OR_QUESTION = /\?|\b(?:if|unless|maybe|perhaps|might|could|would)\b/iu;
const HEARSAY = /\b(?:thinks?|heard|said|says|told|reports?|claims?|might|maybe|apparently)\b/iu;
const NEGATION = /\b(?:no|not|never|none|nothing|haven't|hasn't|hadn't|didn't|don't|doesn't|won't|can't|cannot|couldn't|wouldn't|shouldn't|isn't|aren't|wasn't|weren't)\b|n['’]t\b|\byet\s+to\b/iu;
const RETRACTION = /\b(?:actually|correction|wait|jk|just\s+kidding|didn't\s+go\s+through|did\s+not\s+go\s+through)\b/iu;
const OWNER_HEDGE = /\b(?:afraid|apparently|concerned|feel\s+like|guess|hope|maybe|might|pretty\s+sure|probably|scared|seems?|sounds?\s+like|think|worried)\b/iu;
const FORWARDED_OR_QUOTED_OWNER_CLAIM = /\b(?:begin\s+forwarded|dear\s+sid|email\s+from|forwarded\s+message|from:|message\s+from)\b|["“][^"”]{0,384}\bi\b[^"”]{0,384}["”]/iu;
const SUBMISSION_CORRECTION = /\b(?:didn't|did\s+not|wasn't|was\s+not|never)\s+(?:(?:actually|really|successfully|just|ever)\s+){0,2}(?:submit|send|upload|turn\s+in)|\b(?:submission|upload)\b.{0,48}\b(?:failed|crashed|rejected)|\bdid(?:n't|\s+not)\s+go\s+through\b|\b(?:undo|reopen|mark)\b.{0,48}\bnot\s+submitted\b/iu;
const RETIREMENT = /\b(?:not\s+(?:applying|needed)|skip(?:ping)?|remove|duplicate|wrong\s+item|no\s+longer\s+need)\b/iu;
const BARE_DONT_NEED = /\b(?:don't|do\s+not)\s+need\b/iu;
const REACTIVATION = /\b(?:changed\s+my\s+mind|restore|resume|keep|need\s+(?:this|the|it)|doing\s+(?:this|the)|applying\s+(?:after\s+all|to)|going\s+ahead)\b/iu;
const NOT_STARTED_REPORT = /\b(?:haven't|have\s+not|hadn't|had\s+not|didn't|did\s+not)\s+(?:started|begun|worked\s+on)|\bnot\s+started\b/iu;
const DRAFTING_REPORT = /\b(?:i(?:['’]m|\s+am)\s+(?:drafting|working\s+on)|i(?:['’]ve|\s+have)\s+(?:started|begun)|(?:started|began)\s+(?:my|the)|draft(?:ing)?\s+(?:my|the))\b/iu;
const READY_REPORT = /\b(?:i(?:['’]ve|\s+have|\s)\s*(?:finished|completed)|i(?:['’]m|\s+am)\s+done\s+with|ready\s+to\s+submit|(?:draft|essay|application|aif|statement|reference|transcript)\s+is\s+ready)\b/iu;
const DATE_CORRECTION = /\b(?:wrong|incorrect|remove|clear|unknown|unpublished|not\s+published|no\s+longer)\b.{0,48}\b(?:date|deadline)\b|\b(?:date|deadline)\b.{0,48}\b(?:wrong|incorrect|remove|clear|unknown|unpublished|not\s+published|no\s+longer)\b/iu;
const LABEL_METADATA = /\b(?:verified|unverified)\b|\b\d{4}[-/.]\d{2}[-/.]\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+20\d{2})?\s*$/iu;
const OWNER_STATUS_ACTION = String.raw`(?:accepted|asked|called|contacted|created|declined|emailed|got|messaged|ordered|paid|received|registered|rejected|requested|sent\s+in|signed\s+up|submitted|texted|turned\s+down|turned\s+in|uploaded|waitlisted|withdrew)`;
const JOINT_OWNER_ACTION = new RegExp(
  String.raw`\b(?:(?:m(?:s|r)\.?|dr\.?)\s+\p{L}+[\p{L}'’.-]*|(?:my\s+)?(?:mom|mother|dad|father|parents?|guardians?|sister|brother|sibling)|(?:my\s+)?(?:teacher|counsell?or|referee))\s+and\s+i\s+(?:(?:have|had)\s+)?(?:(?:already|just|now|successfully)\s+)?${OWNER_STATUS_ACTION}\b`,
  "iu",
);
const REPORTED_OWNER_ACTION = new RegExp(
  String.raw`\b(?:asked|emailed|forwarded|messaged|said|says|sent|texted|told|wrote|writes)\b(?:\s+me)?[^.!?\r\n]{0,80}\bi\s+(?:(?:have|had)\s+)?(?:(?:already|just|now|successfully)\s+)?${OWNER_STATUS_ACTION}\b`,
  "iu",
);
const PREPARATION_REQUEST = /\b(?:draft|prepare|outline|revise|critique|review|checklist|steps?|tell\s+me\s+(?:how|what)|help\s+me)\b/iu;
const OWNER_ACTION_DONE: Readonly<Record<UniversityWorkflowKind, RegExp | null>> = Object.freeze({
  submission_step: /\bi\s+(?:(?:already|just|now|successfully)\s+)?(?:submitted|sent\s+in|turned\s+in)\b/iu,
  upload_step: /\bi\s+(?:(?:already|just|now|successfully)\s+)?uploaded\b/iu,
  contact_step: /\bi\s+(?:(?:already|just|now|successfully)\s+)?(?:contacted|emailed|messaged|called|asked(?!\s+you\b)|sent\s+(?:the\s+)?request)\b/iu,
  signup_step: /\bi\s+(?:(?:already|just|now|successfully)\s+)?(?:signed\s+up|registered|created\s+(?:the|my|an?)\s+account)\b/iu,
  payment_step: /\bi\s+(?:(?:already|just|now|successfully)\s+)?paid\b/iu,
  transcript_order_step: /\bi\s+(?:(?:already|just|now|successfully)\s+)?(?:ordered|requested)\s+(?:(?:my|the|an?)\s+)?(?:official\s+)?transcript\b/iu,
  offer: null,
  offer_condition: null,
  offer_response: null,
});
const OWNER_ACTION_NOT_DONE = /\bi\s+(?:haven['’]t|have\s+not|didn['’]t|did\s+not|couldn['’]t|could\s+not)\b/iu;
const OWNER_OFFERED = /\bi\s+(?:(?:have|just)\s+)?(?:got|received)\s+(?:an?\s+)?(?:[\p{L}'’.-]+\s+){0,6}offer(?:\s+of\s+admission)?\b|\bi\s+have\s+an?\s+(?:[\p{L}'’.-]+\s+){0,6}offer(?:\s+of\s+admission)?\b/iu;
const OWNER_WAITLISTED = /\bi\s+(?:(?:have|just)\s+)?(?:got\s+|was\s+|have\s+been\s+)?waitlisted\b/iu;
const OWNER_REJECTED = /\bi\s+(?:(?:have|just)\s+)?(?:got\s+|was\s+|have\s+been\s+)?rejected\b|\bi\s+(?:didn['’]t|did\s+not)\s+get\s+in\b/iu;
const OWNER_WITHDREW = /\bi\s+(?:(?:have|just)\s+)?withdrew\b/iu;
const OWNER_CONDITION_PENDING = /\bi\s+(?:still\s+)?(?:need|have)\s+to\b|\bmy\s+condition\s+is\s+(?:still\s+)?pending\b/iu;
const OWNER_CONDITION_SATISFIED = /\bi\s+(?:(?:have|just)\s+)?(?:met|satisfied|completed)\b/iu;
const OWNER_CONDITION_UNSATISFIED = /\bi\s+(?:didn['’]t|did\s+not|haven['’]t|have\s+not)\s+(?:meet|satisfy|complete)\b/iu;
const OWNER_ACCEPTED = /\bi\s+(?:(?:have|just)\s+)?accepted\s+(?:(?:my|the|an?)\s+)?(?:[\p{L}'’.-]+\s+){0,4}(?:offer|admission)\b/iu;
const OWNER_DECLINED = /\bi\s+(?:(?:have|just)\s+)?(?:declined|turned\s+down)\s+(?:(?:my|the|an?)\s+)?(?:[\p{L}'’.-]+\s+){0,4}(?:offer|admission)\b/iu;
const NUMERIC_MONEY = /(?:[$€£]\s*\d|\b(?:cad|usd|eur|gbp)\s*\d|\b\d+(?:[.,]\d{1,2})?\s*(?:bucks?|cad|usd|eur|gbp|dollars?)\b|\b(?:fee|cost|pay(?:ment)?)\b.{0,24}\b\d+(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d{1,2})?\b.{0,24}\b(?:fee|cost|pay(?:ment)?)\b)/iu;
const SPELLED_MONEY = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)(?:[-\s]+(?:and\s+)?(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)){0,8}\s+(?:bucks?|cad|usd|eur|gbp|dollars?)\b/iu;
const PREPARED_DATE_OR_VERIFICATION = /\b(?:verified|unverified|confirmed|official(?:ly)?|published|according\s+to|current\s+cycle|source\s+says|website\s+says)\b|\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?\b|\b(?:deadline|due\s+date)\s+(?:is|was|will\s+be|falls?)\b|\bdue\s+(?:at|before|by|on)\b|\b(?:today|tomorrow|tonight|spring|summer|fall|autumn|winter|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/iu;
const PREPARED_REQUIREMENT_ASSERTION = /\b(?:(?:requires?|needs?|must\s+have|has\s+to\s+include)\s+(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|\d+|references?|courses?|credits?|average|grade|prerequisites?|supplements?)|requirements?\s+(?:are|include)|mandatory|eligibility|eligible|minimum|prerequisites?|\d+(?:\.\d+)?\s*%|average\s+(?:of\s+)?\d|grade\s+(?:of\s+)?\d)\b/iu;
const PREPARED_MONEY_ASSERTION = /\b(?:fee|cost|payment|price)\b.{0,24}\b(?:amounts?\s+to|costs?|is|are|totals?|was|were|will\s+be|waived?|refundable|non-?refundable)\b|\b(?:costs?|totals?)\b.{0,24}\b(?:fee|payment|price)\b|\b(?:free|no\s+fee|waived?\s+fee|deposit|tuition)\b/iu;
const EMAIL_ADDRESS = /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/iu;
const PHONE_NUMBER = /(?:^|\D)(?:\+?\d[\d ().-]{7,}\d)(?:\D|$)/u;
export const MAX_WORKFLOW_PREPARED_DETAILS_PER_PLAN_BYTES = 12_000;
const ADMISSION_CYCLE = /^20\d{2}(?:[-–]20\d{2})?$/u;
const encoder = new TextEncoder();
const MONTH_WORDS = Object.freeze([
  "jan(?:uary)?", "feb(?:ruary)?", "mar(?:ch)?", "apr(?:il)?", "may", "jun(?:e)?",
  "jul(?:y)?", "aug(?:ust)?", "sep(?:t(?:ember)?)?", "oct(?:ober)?", "nov(?:ember)?", "dec(?:ember)?",
]);

const APPLICATION_KINDS = new Set<UniversityApplicationItemKind>([
  "supplementary_application", "essay", "personal_statement", "reference", "transcript", "scholarship",
]);
const APPLICATION_STATUSES = new Set<UniversityApplicationItemStatus>([
  "not_started", "drafting", "ready", "submitted_by_sid", "not_needed_by_sid",
]);
const WORKFLOW_KINDS = new Set<UniversityWorkflowKind>([
  "submission_step", "upload_step", "contact_step", "signup_step", "payment_step",
  "transcript_order_step", "offer", "offer_condition", "offer_response",
]);
const WORKFLOW_OWNERS = new Set<UniversityWorkflowOwner>([
  "sid", "referee", "guidance", "school", "university",
]);
const WORKFLOW_STATUSES = new Set<UniversityWorkflowStatus>([
  "prepared", "owner_reported_done", "owner_reported_not_done", "owner_reported_offered",
  "owner_reported_waitlisted", "owner_reported_rejected", "owner_reported_withdrawn",
  "owner_reported_pending", "owner_reported_satisfied", "owner_reported_unsatisfied",
  "owner_reported_accepted", "owner_reported_declined", "not_needed_by_sid",
]);
const TERMINAL_WORKFLOW_STATUSES = new Set<UniversityWorkflowStatus>([
  "owner_reported_done", "owner_reported_rejected", "owner_reported_withdrawn",
  "owner_reported_satisfied", "owner_reported_accepted", "owner_reported_declined",
  "not_needed_by_sid",
]);
const RECENT_TERMINAL_WORKFLOW_MILLISECONDS = 2 * 24 * 60 * 60 * 1_000;

const KIND_WORDS: Readonly<Record<UniversityApplicationItemKind, readonly string[]>> = Object.freeze({
  supplementary_application: Object.freeze(["supplementary application", "supplementary", "aif"]),
  essay: Object.freeze(["essay"]),
  personal_statement: Object.freeze(["personal statement", "statement"]),
  reference: Object.freeze(["reference", "referee"]),
  transcript: Object.freeze(["transcript"]),
  scholarship: Object.freeze(["scholarship"]),
});

type Redactor = { redactText(text: string): { readonly ok: boolean; readonly text?: string } };

function exactRecord(value: unknown, fields: readonly string[], error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(error);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError(error);
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    record[field] = descriptor.value;
  }
  return record;
}

function denseArray(value: unknown, maximum: number, error: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new TypeError(error);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(error);
  }
  return value;
}

function inline(value: unknown, maximumBytes: number, error: string, redactor: Redactor): string {
  if (typeof value !== "string") throw new TypeError(error);
  const text = value.trim();
  if (text.length === 0 || !text.isWellFormed() || text !== text.normalize("NFC")
    || encoder.encode(text).byteLength > maximumBytes || UNSAFE_INLINE.test(text)) throw new TypeError(error);
  const redacted = redactor.redactText(text);
  if (!redacted.ok || typeof redacted.text !== "string" || redacted.text.length === 0
    || !redacted.text.isWellFormed() || redacted.text !== redacted.text.normalize("NFC")
    || encoder.encode(redacted.text).byteLength > maximumBytes || UNSAFE_INLINE.test(redacted.text)) {
    throw new TypeError(error);
  }
  return redacted.text;
}

function optionalInline(value: unknown, maximumBytes: number, error: string, redactor: Redactor): string | null {
  return value === null ? null : inline(value, maximumBytes, error, redactor);
}

function evidenceValue(value: unknown, maximumBytes: number, error: string, redactor: Redactor): string {
  if (typeof value !== "string") throw new TypeError(error);
  const text = value.trim();
  if (text.length === 0 || !text.isWellFormed() || text !== text.normalize("NFC")
    || encoder.encode(text).byteLength > maximumBytes
    || text.split(/\r?\n/u).some((line) => UNSAFE_INLINE.test(line))) throw new TypeError(error);
  const redacted = redactor.redactText(text);
  if (!redacted.ok || typeof redacted.text !== "string") throw new TypeError(error);
  const checked = redacted.text.trim();
  if (checked.length === 0 || !checked.isWellFormed() || checked !== checked.normalize("NFC")
    || encoder.encode(checked).byteLength > maximumBytes
    || checked.split(/\r?\n/u).some((line) => UNSAFE_INLINE.test(line))) throw new TypeError(error);
  return checked;
}

function ownerEvidence(value: unknown, ownerMessage: string, error: string, redactor: Redactor): string {
  const evidence = evidenceValue(value, 512, error, redactor);
  if (!ownerMessage.includes(evidence)) throw new TypeError(error);
  return evidence;
}

function evidenceText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-CA").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function mentions(value: string, candidate: string): boolean {
  const normalizedCandidate = evidenceText(candidate);
  return normalizedCandidate.length > 0 && evidenceText(value).includes(normalizedCandidate);
}

function containsLabel(value: string, label: string): boolean {
  const normalize = (text: string): string => text.normalize("NFC").toLocaleLowerCase("en-CA")
    .replace(/['’ʼ`]/gu, "'").replace(/[\p{Pd}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const candidate = normalize(label);
  return candidate.length > 0 && normalize(value).includes(candidate);
}

export function isWorkflowLabelSafe(value: string): boolean {
  return !LABEL_METADATA.test(value) && !PREPARED_DATE_OR_VERIFICATION.test(value)
    && !NUMERIC_MONEY.test(value) && !SPELLED_MONEY.test(value)
    && !EMAIL_ADDRESS.test(value) && !PHONE_NUMBER.test(value);
}

export function isWorkflowPreparedDetailsSafe(value: string): boolean {
  return !PREPARED_DATE_OR_VERIFICATION.test(value) && !PREPARED_REQUIREMENT_ASSERTION.test(value)
    && !NUMERIC_MONEY.test(value) && !SPELLED_MONEY.test(value) && !PREPARED_MONEY_ASSERTION.test(value);
}

function clauseGroups(
  value: string,
  splitCommas: boolean,
  protectedPhrases: readonly string[] = Object.freeze([]),
): readonly (readonly string[])[] {
  const urls: string[] = [];
  let urlMarker = "URLMASKTOKEN";
  while (value.includes(urlMarker)) urlMarker = `_${urlMarker}`;
  const withoutUrls = value.replace(/https?:\/\/\S+/giu, (matched) => {
    const trailing = /[.,;!?]+$/u.exec(matched)?.[0] ?? "";
    const url = trailing.length === 0 ? matched : matched.slice(0, -trailing.length);
    const token = `${urlMarker}${urls.length}${urlMarker}`;
    urls.push(url);
    return `${token}${trailing}`;
  });
  const withoutMonthDots = withoutUrls.replace(
    /\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\./giu,
    "$1",
  );
  const phrases: string[] = [];
  let phraseMarker = "PHRASEMASKTOKEN";
  while (value.includes(phraseMarker)) phraseMarker = `_${phraseMarker}`;
  const automaticPhrases = withoutMonthDots.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/gu) ?? [];
  const phrasePatterns = [...new Set([...protectedPhrases, ...automaticPhrases]
    .map((phrase) => phrase.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((phrase) => new RegExp(
      phrase.split(/\s+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+"),
      "giu",
    ));
  const maskedPhrase = new RegExp(`${phraseMarker}(\\d+)${phraseMarker}`, "gu");
  let withMaskedPhrases = withoutMonthDots;
  for (const pattern of phrasePatterns) {
    withMaskedPhrases = withMaskedPhrases.replace(pattern, (matched) => {
      const token = `${phraseMarker}${phrases.length}${phraseMarker}`;
      phrases.push(matched);
      return token;
    });
  }
  const sentences = withMaskedPhrases.match(/[^.;!?\r\n]+[.;!?]?/gu) ?? [];
  const connector = splitCommas
    ? /,\s*(?:and\s+)?|\b(?:and|but|then)\b/iu
    : /\b(?:and|but|then)\b/iu;
  const maskedUrl = new RegExp(`${urlMarker}(\\d+)${urlMarker}`, "gu");
  return Object.freeze(sentences.map((sentence) => {
    return Object.freeze(sentence.split(connector)
      .map((clause) => clause.replace(maskedPhrase, (_token, index: string) => phrases[Number(index)] ?? ""))
      .map((clause) => clause.replace(maskedUrl, (_token, index: string) => urls[Number(index)] ?? ""))
      .map((clause) => clause.trim()).filter((clause) => clause.length > 0));
  }).filter((sentence) => sentence.length > 0));
}

function clauses(
  value: string,
  splitCommas: boolean,
  protectedPhrases: readonly string[] = Object.freeze([]),
): readonly string[] {
  return Object.freeze(clauseGroups(value, splitCommas, protectedPhrases).flat());
}

function evidenceSupportsDate(evidence: string, date: string): boolean {
  const [year, month, day] = date.split("-") as [string, string, string];
  const lower = evidence.toLocaleLowerCase("en-CA");
  if (new RegExp(`\\b${year}[-/.]${month}[-/.]${day}\\b`, "u").test(lower)) return true;
  const monthWord = MONTH_WORDS[Number(month) - 1];
  if (monthWord === undefined) return false;
  const dayNumber = String(Number(day));
  if (new RegExp(`\\b(?:${monthWord})\\.?\\s+0?${dayNumber}(?:st|nd|rd|th)?(?:,)?\\s+${year}\\b`, "iu").test(lower)
    || new RegExp(`\\b0?${dayNumber}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${monthWord})\\.?(?:,)?\\s+${year}\\b`, "iu").test(lower)) {
    return true;
  }
  const targetMonth = Number(month);
  const targetDay = Number(day);
  for (const match of lower.matchAll(/\b(\d{1,2})([-/.])(\d{1,2})\2(20\d{2})\b/gu)) {
    const first = Number(match[1]);
    const second = Number(match[3]);
    if (match[4] !== year || first <= 12 && second <= 12) continue;
    if (first > 12 && second === targetMonth && first === targetDay
      || second > 12 && first === targetMonth && second === targetDay) return true;
  }
  return false;
}

function evidenceSupportsCycle(evidence: string, cycle: string): boolean {
  const escaped = cycle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:\\b${escaped}\\s+(?:admission\\s+)?cycle\\b|\\b(?:admission\\s+)?cycle\\s+(?:is\\s+)?${escaped}\\b|\\b(?:fall|winter|spring|summer)\\s+${escaped}\\b)`,
    "iu",
  ).test(evidence);
}

function sourceUrl(value: unknown, ownerMessage: string, redactor: Redactor): string | null {
  if (value === null) return null;
  const text = inline(value, 512, "university_tracker_model_verification_invalid", redactor);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("university_tracker_model_verification_invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== ""
    || !ownerMessage.includes(text)) {
    throw new TypeError("university_tracker_model_verification_invalid");
  }
  return text;
}

function verification(value: unknown, ownerMessage: string, redactor: Redactor): OwnerUniversityVerification {
  const item = exactRecord(value, ["state", "sourceUrl", "cycle"], "university_tracker_model_verification_invalid");
  if (item.state !== "verified" && item.state !== "unverified") {
    throw new TypeError("university_tracker_model_verification_invalid");
  }
  const url = sourceUrl(item.sourceUrl, ownerMessage, redactor);
  const cycle = optionalInline(item.cycle, 64, "university_tracker_model_verification_invalid", redactor);
  if (item.state === "verified"
    && (url === null || cycle === null || !ADMISSION_CYCLE.test(cycle) || !ownerMessage.includes(cycle))) {
    throw new TypeError("university_tracker_model_verification_invalid");
  }
  return Object.freeze({ state: item.state, sourceUrl: url, cycle });
}

function requirement(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
): OwnerUniversityRequirementAddition {
  const item = exactRecord(value, ["label", "detail", "verification"], "university_tracker_model_requirement_invalid");
  return Object.freeze({
    label: inline(item.label, 160, "university_tracker_model_requirement_invalid", redactor),
    detail: inline(item.detail, 512, "university_tracker_model_requirement_invalid", redactor),
    verification: verification(item.verification, ownerMessage, redactor),
  });
}

function universityDate(value: unknown, ownerMessage: string, redactor: Redactor): OwnerUniversityDateAddition {
  const item = exactRecord(value, ["label", "date", "verification"], "university_tracker_model_date_invalid");
  const date = item.date === null ? null : inline(item.date, 10, "university_tracker_model_date_invalid", redactor);
  if (date !== null && (!LOCAL_DATE.test(date)
    || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date)) {
    throw new TypeError("university_tracker_model_date_invalid");
  }
  const checkedVerification = verification(item.verification, ownerMessage, redactor);
  if (checkedVerification.state === "verified" && date === null) {
    throw new TypeError("university_tracker_model_date_invalid");
  }
  return Object.freeze({
    label: inline(item.label, 160, "university_tracker_model_date_invalid", redactor),
    date,
    verification: checkedVerification,
  });
}

function ulidArray(value: unknown): readonly Ulid[] {
  const values = denseArray(value, 64, "university_tracker_model_program_invalid");
  if (values.some((item) => typeof item !== "string" || !ULID.test(item))) {
    throw new TypeError("university_tracker_model_program_invalid");
  }
  if (new Set(values).size !== values.length) throw new TypeError("university_tracker_model_program_invalid");
  return Object.freeze(values as readonly Ulid[]);
}

function programUpdate(value: unknown, ownerMessage: string, redactor: Redactor): OwnerUniversityProgramUpdate {
  const item = exactRecord(value, [
    "programRef", "university", "campus", "programName", "ouacCode", "verification",
    "addRequirements", "addDates", "resolveItemIds",
  ], "university_tracker_model_program_invalid");
  if (typeof item.programRef !== "string" || !ULID.test(item.programRef) && !NEW_PROGRAM.test(item.programRef)) {
    throw new TypeError("university_tracker_model_program_invalid");
  }
  const university = optionalInline(item.university, 160, "university_tracker_model_program_invalid", redactor);
  const programName = optionalInline(item.programName, 160, "university_tracker_model_program_invalid", redactor);
  const checkedVerification = item.verification === null ? null : verification(item.verification, ownerMessage, redactor);
  if (NEW_PROGRAM.test(item.programRef)
    && (university === null || programName === null || checkedVerification === null)) {
    throw new TypeError("university_tracker_model_program_invalid");
  }
  return Object.freeze({
    programRef: item.programRef,
    university,
    campus: optionalInline(item.campus, 160, "university_tracker_model_program_invalid", redactor),
    programName,
    ouacCode: optionalInline(item.ouacCode, 32, "university_tracker_model_program_invalid", redactor),
    verification: checkedVerification,
    addRequirements: Object.freeze(denseArray(item.addRequirements, 32, "university_tracker_model_program_invalid")
      .map((entry) => requirement(entry, ownerMessage, redactor))),
    addDates: Object.freeze(denseArray(item.addDates, 32, "university_tracker_model_program_invalid")
      .map((entry) => universityDate(entry, ownerMessage, redactor))),
    resolveItemIds: ulidArray(item.resolveItemIds),
  });
}

function applicationDueDate(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
  existingItem: UniversityApplicationItem | null,
  itemRef: string,
  label: string | null,
  kind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext | null,
  snapshot: UniversityTrackerSnapshot | null,
): OwnerApplicationDueDateUpdate {
  const item = exactRecord(value, ["date", "verification", "evidence"], "university_application_model_date_invalid");
  const date = item.date === null ? null : inline(item.date, 10, "university_application_model_date_invalid", redactor);
  if (date !== null && (!LOCAL_DATE.test(date)
    || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date)) {
    throw new TypeError("university_application_model_date_invalid");
  }
  const checkedVerification = verification(item.verification, ownerMessage, redactor);
  if (checkedVerification.state === "verified" && date === null) {
    throw new TypeError("university_application_model_date_invalid");
  }
  const evidence = ownerEvidence(item.evidence, ownerMessage, "university_application_model_date_invalid", redactor);
  if (date !== null && !evidenceSupportsDate(evidence, date)) {
    throw new TypeError("university_application_model_date_invalid");
  }
  const splitDateClauses = date === null ? Object.freeze([]) : clauses(
    ownerMessage,
    false,
    itemNames(label, program),
  ).filter((clause) =>
    evidenceSupportsDate(clause, date)
    && clauseNamesOnlyItem(clause, itemRef, label, kind, program, snapshot));
  const dateClauses = splitDateClauses;
  if (date !== null && dateClauses.length === 0) throw new TypeError("university_application_model_date_invalid");
  if (date !== null && existingItem?.dueDate !== null && existingItem?.dueDate !== undefined
    && date !== existingItem.dueDate
    && (evidence !== ownerMessage || CONDITIONAL_OR_QUESTION.test(ownerMessage) || HEARSAY.test(ownerMessage))) {
    throw new TypeError("university_application_model_date_invalid");
  }
  if (checkedVerification.state === "verified"
    && (checkedVerification.sourceUrl === null || checkedVerification.cycle === null
      || !dateClauses.some((clause) => clause.includes(checkedVerification.sourceUrl ?? "")
        && evidenceSupportsCycle(clause, checkedVerification.cycle ?? "")))) {
    throw new TypeError("university_application_model_date_invalid");
  }
  if (date === null && existingItem !== null && existingItem.dueDate !== null
    && (evidence !== ownerMessage || !clauses(ownerMessage, false).some((clause) =>
      clauseNamesOnlyItem(clause, itemRef, label, kind, program, snapshot)
      && DATE_CORRECTION.test(clause) && !NEGATION.test(clause)
      && !CONDITIONAL_OR_QUESTION.test(clause) && !HEARSAY.test(clause)))) {
    throw new TypeError("university_application_model_date_invalid");
  }
  const effectiveVerification: OwnerUniversityVerification = existingItem?.dueDate === date
    && existingItem.verification.state === "verified" && checkedVerification.state === "unverified"
    ? Object.freeze({
      state: "verified",
      sourceUrl: existingItem.verification.sourceUrl,
      cycle: existingItem.verification.cycle,
    })
    : checkedVerification;
  return Object.freeze({
    date,
    verification: effectiveVerification,
    evidence,
  });
}

type ApplicationProgramContext = Pick<UniversityProgram, "university" | "programName">;

function programAliases(program: ApplicationProgramContext): readonly string[] {
  return Object.freeze([
    program.university,
    program.university.replace(/^university\s+of\s+/iu, "").replace(/\s+university$/iu, ""),
    program.programName,
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index));
}

function itemNames(
  label: string | null,
  program: ApplicationProgramContext | null,
): readonly string[] {
  return Object.freeze([label, ...(program === null ? [] : programAliases(program))]
    .filter((value): value is string => value !== null));
}

function namesApplicationItem(
  evidence: string,
  label: string | null,
  kind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext | null,
): boolean {
  if (label !== null && mentions(evidence, label)) return true;
  if (kind === null || program === null) return false;
  return KIND_WORDS[kind].some((word) => mentions(evidence, word))
    && programAliases(program).some((name) => mentions(evidence, name));
}

function namedApplicationItems(
  evidence: string,
  snapshot: UniversityTrackerSnapshot | null,
): readonly UniversityApplicationItem[] {
  if (snapshot === null) return Object.freeze([]);
  const entries = snapshot.programs.flatMap((program) => program.applicationItems.map((item) => ({ item, program })));
  const exact = entries.filter(({ item }) => mentions(evidence, item.label));
  const programKind = entries.filter(({ item, program }) =>
    KIND_WORDS[item.kind].some((word) => mentions(evidence, word))
    && programAliases(program).some((name) => mentions(evidence, name)));
  if (exact.length > 0) {
    const additional = programKind.filter(({ item, program }) => !exact.some((candidate) =>
      candidate.item.kind === item.kind && candidate.program.programId === program.programId));
    return Object.freeze([...exact, ...additional].map(({ item }) => item));
  }
  if (programKind.length > 0) return Object.freeze(programKind.map(({ item }) => item));
  const kindOnly = entries.filter(({ item }) => KIND_WORDS[item.kind].some((word) => mentions(evidence, word)));
  return Object.freeze(kindOnly.map(({ item }) => item));
}

function clauseNamesOnlyItem(
  clause: string,
  itemRef: string,
  label: string | null,
  kind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext | null,
  snapshot: UniversityTrackerSnapshot | null,
): boolean {
  const named = namedApplicationItems(clause, snapshot);
  if (ULID.test(itemRef)) {
    if (named.length > 0) return named.length === 1 && named[0]?.itemId === itemRef;
    return snapshot === null && namesApplicationItem(clause, label, kind, program);
  }
  return namesApplicationItem(clause, label, kind, program);
}

function targetEvidenceClauses(
  evidence: string,
  protectedPhrases: readonly string[],
  namesTarget: (clause: string) => boolean,
  namesOtherTarget: (clause: string) => boolean,
  allowAdjacentReactivation: boolean,
): readonly string[] {
  return Object.freeze(clauseGroups(evidence, true, protectedPhrases).flatMap((sentence) => {
    let immediatelyFollowsTarget = false;
    const relevant: string[] = [];
    for (const clause of sentence) {
      if (namesTarget(clause)) {
        immediatelyFollowsTarget = true;
        relevant.push(clause);
        continue;
      }
      if (namesOtherTarget(clause)) {
        immediatelyFollowsTarget = false;
        continue;
      }
      if (allowAdjacentReactivation && immediatelyFollowsTarget && (/\b(?:it|that)\b/iu.test(clause)
        || /\bi\b/iu.test(clause) && REACTIVATION.test(clause))) relevant.push(clause);
      immediatelyFollowsTarget = false;
    }
    return relevant;
  }));
}

function itemEvidenceClauses(
  evidence: string,
  itemRef: string,
  label: string | null,
  kind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext | null,
  snapshot: UniversityTrackerSnapshot | null,
): readonly string[] {
  return targetEvidenceClauses(
    evidence,
    itemNames(label, program),
    (clause) => clauseNamesOnlyItem(clause, itemRef, label, kind, program, snapshot),
    (clause) => namedApplicationItems(clause, snapshot).length > 0
      || namesApplicationItem(clause, label, kind, program),
    true,
  );
}

function namesItemAsThirdPartyPossession(
  evidence: string,
  label: string | null,
  kind: UniversityApplicationItemKind | null,
): boolean {
  const normalized = evidenceText(evidence);
  if (/\bfor\s+you\b/iu.test(evidence)) return true;
  if (label !== null && normalized.includes(`your ${evidenceText(label)}`)) return true;
  return kind !== null && KIND_WORDS[kind].some((word) => normalized.includes(`your ${evidenceText(word)}`));
}

function supportsDirectOwnerClaim(
  evidence: string,
  clausesForTarget: readonly string[],
  action: RegExp,
  options: {
    readonly allowNegation?: boolean;
    readonly rejectForwardedOrQuoted?: boolean;
    readonly rejectHedges?: boolean;
    readonly namesThirdPartyPossession?: (clause: string) => boolean;
    readonly clauseAllowed?: (clause: string) => boolean;
  } = {},
): boolean {
  if (JOINT_OWNER_ACTION.test(evidence) || REPORTED_OWNER_ACTION.test(evidence)
    || RETRACTION.test(evidence)
    || options.rejectHedges === true && OWNER_HEDGE.test(evidence)
    || options.rejectForwardedOrQuoted === true && FORWARDED_OR_QUOTED_OWNER_CLAIM.test(evidence)) return false;
  return clausesForTarget.some((clause) => {
    const conditionalText = options.allowNegation === true
      ? clause.replace(/\b(?:couldn['’]t|could\s+not|wouldn['’]t|would\s+not)\b/giu, "")
      : clause;
    if (CONDITIONAL_OR_QUESTION.test(conditionalText) || HEARSAY.test(clause) || RETRACTION.test(clause)
      || options.allowNegation !== true && NEGATION.test(clause)
      || options.namesThirdPartyPossession?.(clause) === true
      || options.clauseAllowed?.(clause) === false) return false;
    return action.test(clause);
  });
}

function bareDontNeedTargetsItem(clause: string, label: string | null): boolean {
  const match = BARE_DONT_NEED.exec(clause);
  if (match === null || label === null) return false;
  const tail = clause.slice(match.index + match[0].length).trim()
    .replace(/^(?:this|the|my)\s+/iu, "").replace(/[.!?]+$/u, "").trim();
  const normalizedLabel = label.normalize("NFC").toLocaleLowerCase("en-CA").replace(/\s+/gu, " ").trim();
  const normalizedTail = tail.normalize("NFC").toLocaleLowerCase("en-CA").replace(/\s+/gu, " ").trim();
  return normalizedTail === normalizedLabel || normalizedTail === `${normalizedLabel} anymore`;
}

function retirementNegated(clause: string): boolean {
  const withoutRetirementNegation = clause
    .replace(/\bnot\s+(?:applying|needed)\b/giu, "")
    .replace(/\bno\s+longer\s+need\b/giu, "");
  return NEGATION.test(withoutRetirementNegation);
}

export function supportsStatus(
  status: UniversityApplicationItemStatus,
  evidence: string,
  isNew: boolean,
  existingStatus: UniversityApplicationItemStatus | null,
  itemRef: string,
  label: string | null,
  kind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext | null,
  snapshot: UniversityTrackerSnapshot | null,
): boolean {
  const evidenceClauses = itemEvidenceClauses(evidence, itemRef, label, kind, program, snapshot);
  if (status === "submitted_by_sid") {
    return supportsDirectOwnerClaim(evidence, evidenceClauses, OWNER_SUBMISSION, {
      namesThirdPartyPossession: (clause) => namesItemAsThirdPartyPossession(clause, label, kind),
    });
  }
  if (existingStatus === "submitted_by_sid") {
    return evidenceClauses.some((clause) =>
      SUBMISSION_CORRECTION.test(clause) && !CONDITIONAL_OR_QUESTION.test(clause));
  }
  if (existingStatus === "not_needed_by_sid" && status !== "not_needed_by_sid") {
    return evidenceClauses.some((clause) =>
      REACTIVATION.test(clause) && !NEGATION.test(clause)
      && !RETRACTION.test(clause) && !CONDITIONAL_OR_QUESTION.test(clause));
  }
  if (status === "not_needed_by_sid") {
    return evidenceClauses.some((clause) => !CONDITIONAL_OR_QUESTION.test(clause)
      && !RETRACTION.test(clause)
      && (RETIREMENT.test(clause) && !retirementNegated(clause)
        || bareDontNeedTargetsItem(clause, label)));
  }
  if (isNew && status === "not_started") return evidenceClauses.length > 0;
  return evidenceClauses.some((clause) => {
    if (CONDITIONAL_OR_QUESTION.test(clause) || RETRACTION.test(clause)) return false;
    if (status === "not_started") return NOT_STARTED_REPORT.test(clause);
    if (NEGATION.test(clause)) return false;
    return status === "drafting" ? DRAFTING_REPORT.test(clause) : READY_REPORT.test(clause);
  });
}

function applicationUpdate(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
  snapshot: UniversityTrackerSnapshot | null,
  programUpdates: readonly OwnerUniversityProgramUpdate[],
): OwnerUniversityApplicationUpdate {
  const item = exactRecord(value, [
    "itemRef", "programRef", "kind", "label", "status", "statusEvidence", "dueDate",
  ], "university_application_model_item_invalid");
  if (typeof item.itemRef !== "string" || !ULID.test(item.itemRef) && !NEW_APPLICATION_ITEM.test(item.itemRef)
    || typeof item.programRef !== "string" || !ULID.test(item.programRef) && !NEW_PROGRAM.test(item.programRef)) {
    throw new TypeError("university_application_model_item_invalid");
  }
  const kind = item.kind === null ? null : item.kind as UniversityApplicationItemKind;
  const status = item.status === null ? null : item.status as UniversityApplicationItemStatus;
  if (kind !== null && !APPLICATION_KINDS.has(kind) || status !== null && !APPLICATION_STATUSES.has(status)) {
    throw new TypeError("university_application_model_item_invalid");
  }
  const label = optionalInline(item.label, 160, "university_application_model_item_invalid", redactor);
  const statusEvidence = item.statusEvidence === null ? null
    : ownerEvidence(item.statusEvidence, ownerMessage, "university_application_model_item_invalid", redactor);
  const isNew = NEW_APPLICATION_ITEM.test(item.itemRef);
  const snapshotProgram = snapshot?.programs.find((program) =>
    program.programId === item.programRef
    || program.applicationItems.some((applicationItem) => applicationItem.itemId === item.itemRef)) ?? null;
  const existingItem = snapshotProgram?.applicationItems.find((applicationItem) =>
    applicationItem.itemId === item.itemRef) ?? null;
  const responseProgram = programUpdates.find((program) => program.programRef === item.programRef);
  const program: ApplicationProgramContext | null = snapshotProgram === null
    ? responseProgram?.university !== null && responseProgram?.university !== undefined
      && responseProgram.programName !== null
      ? { university: responseProgram.university, programName: responseProgram.programName }
      : null
    : snapshotProgram;
  const effectiveKind = kind ?? existingItem?.kind ?? null;
  const effectiveLabel = label ?? existingItem?.label ?? null;
  const dueDate = item.dueDate === null ? null
    : applicationDueDate(
      item.dueDate,
      ownerMessage,
      redactor,
      existingItem,
      item.itemRef,
      effectiveLabel,
      effectiveKind,
      program,
      snapshot,
    );
  if (isNew && (kind === null || label === null || status === null || statusEvidence === null || dueDate === null)
    || !isNew && (kind !== null || label !== null)
    || isNew && status === "not_needed_by_sid"
    || isNew && (LABEL_METADATA.test(label ?? "") || !containsLabel(ownerMessage, label ?? ""))
    || status === null && statusEvidence !== null
    || status !== null && statusEvidence === null
    || status !== null && (statusEvidence !== ownerMessage
      || !supportsStatus(
        status,
        ownerMessage,
        isNew,
        existingItem?.status ?? null,
        item.itemRef,
        effectiveLabel,
        effectiveKind,
        program,
        snapshot,
      ))) {
    throw new TypeError("university_application_model_item_invalid");
  }
  return Object.freeze({
    itemRef: item.itemRef,
    programRef: item.programRef,
    kind,
    label,
    status,
    statusEvidence,
    dueDate,
  });
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function workflowStatusAllowed(kind: UniversityWorkflowKind, status: UniversityWorkflowStatus): boolean {
  if (status === "not_needed_by_sid") return true;
  if (kind === "offer") {
    return status === "owner_reported_offered" || status === "owner_reported_waitlisted"
      || status === "owner_reported_rejected" || status === "owner_reported_withdrawn";
  }
  if (kind === "offer_condition") {
    return status === "owner_reported_pending" || status === "owner_reported_satisfied"
      || status === "owner_reported_unsatisfied";
  }
  if (kind === "offer_response") {
    return status === "prepared" || status === "owner_reported_accepted" || status === "owner_reported_declined";
  }
  return status === "prepared" || status === "owner_reported_done" || status === "owner_reported_not_done";
}

function currentWorkflowItem(
  snapshot: UniversityTrackerSnapshot | null,
  workflowRef: string,
): { readonly item: UniversityWorkflowItem; readonly program: UniversityProgram } | null {
  if (snapshot === null || !ULID.test(workflowRef)) return null;
  for (const program of snapshot.programs) {
    const item = (program.workflowItems ?? []).find((candidate) => candidate.workflowId === workflowRef);
    if (item !== undefined) return Object.freeze({ item, program });
  }
  return null;
}

function namedWorkflowItems(
  evidence: string,
  snapshot: UniversityTrackerSnapshot | null,
): readonly UniversityWorkflowItem[] {
  if (snapshot === null) return Object.freeze([]);
  return Object.freeze(snapshot.programs.flatMap((program) => program.workflowItems ?? [])
    .filter((item) => containsLabel(evidence, item.label)));
}

function universityAliases(program: ApplicationProgramContext): readonly string[] {
  return Object.freeze([
    program.university,
    program.university.replace(/^university\s+of\s+/iu, "").replace(/\s+university$/iu, ""),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index));
}

function clauseNamesExactlyOneTrackedProgram(
  clause: string,
  program: ApplicationProgramContext,
  snapshot: UniversityTrackerSnapshot | null,
): boolean {
  if (!universityAliases(program).some((alias) => mentions(clause, alias))
    || !mentions(clause, program.programName)) return false;
  if (snapshot === null) return true;
  const namedUniversities = new Set(snapshot.programs.filter((candidate) =>
    universityAliases(candidate).some((alias) => mentions(clause, alias)))
    .map((candidate) => evidenceText(candidate.university)));
  if (namedUniversities.size === 0) return true;
  if (namedUniversities.size !== 1 || !namedUniversities.has(evidenceText(program.university))) return false;
  const namedProgramsAtSchool = snapshot.programs.filter((candidate) =>
    evidenceText(candidate.university) === evidenceText(program.university)
    && mentions(clause, candidate.programName));
  return namedProgramsAtSchool.length === 1
    && evidenceText(namedProgramsAtSchool[0]?.programName ?? "") === evidenceText(program.programName);
}

function workflowTargetClauses(
  evidence: string,
  workflowRef: string,
  workflowLabel: string,
  applicationItemRef: string | null,
  applicationLabel: string | null,
  applicationKind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext,
  snapshot: UniversityTrackerSnapshot | null,
): readonly string[] {
  const protectedPhrases = [workflowLabel, applicationLabel, ...programAliases(program)]
    .filter((value): value is string => value !== null);
  return targetEvidenceClauses(
    evidence,
    protectedPhrases,
    (clause) => {
      if (!containsLabel(clause, workflowLabel)) return false;
      const namedWorkflows = namedWorkflowItems(clause, snapshot);
      const namesOnlyWorkflow = namedWorkflows.length === 0
        || namedWorkflows.length === 1 && namedWorkflows[0]?.workflowId === workflowRef;
      if (!namesOnlyWorkflow) return false;
      if (applicationItemRef !== null) {
        if (applicationLabel === null || !containsLabel(clause, applicationLabel)) return false;
        return clauseNamesOnlyItem(
          clause,
          applicationItemRef,
          applicationLabel,
          applicationKind,
          program,
          snapshot,
        );
      }
      return namedApplicationItems(clause, snapshot).length === 0
        && clauseNamesExactlyOneTrackedProgram(clause, program, snapshot);
    },
    (clause) => namedWorkflowItems(clause, snapshot).length > 0
      || namedApplicationItems(clause, snapshot).length > 0,
    false,
  );
}

function contactRecipientMatchesLabel(clause: string, workflowLabel: string): boolean {
  const match = /\bi\s+(?:(?:already|just|now|successfully)\s+)?(?:contacted|emailed|messaged|called|asked)\s+(?<recipient>[^,.;!?]{1,80}?)(?=\s+(?:about|for|regarding|covering)\b)/iu.exec(clause);
  const recipient = evidenceText(match?.groups?.recipient ?? "");
  if (recipient.length === 0) return false;
  const ignored = new Set(["contact", "email", "follow", "message", "reference", "request", "step", "up"]);
  const targetWords = evidenceText(workflowLabel).split(" ")
    .filter((word) => word.length > 1 && !ignored.has(word));
  return targetWords.length > 0 && targetWords.every((word) => recipient.split(" ").includes(word));
}

function supportsWorkflowStatus(
  status: UniversityWorkflowStatus,
  kind: UniversityWorkflowKind,
  evidence: string,
  workflowLabel: string,
  applicationLabel: string | null,
  applicationKind: UniversityApplicationItemKind | null,
  clausesForTarget: readonly string[],
): boolean {
  if (!workflowStatusAllowed(kind, status)) return false;
  if (status === "prepared") return clausesForTarget.some((clause) => {
    if (CONDITIONAL_OR_QUESTION.test(clause) || HEARSAY.test(clause) || RETRACTION.test(clause)) return false;
    return PREPARATION_REQUEST.test(clause) && !OWNER_ACTION_NOT_DONE.test(clause);
  });
  if (status === "not_needed_by_sid") return clausesForTarget.some((clause) =>
    !CONDITIONAL_OR_QUESTION.test(clause) && !HEARSAY.test(clause) && !RETRACTION.test(evidence)
    && (RETIREMENT.test(clause) || BARE_DONT_NEED.test(clause)) && !retirementNegated(clause));
  const thirdPartyPossession = (clause: string): boolean =>
    namesItemAsThirdPartyPossession(clause, applicationLabel ?? workflowLabel, applicationKind);
  if (status === "owner_reported_done") {
    const pattern = OWNER_ACTION_DONE[kind];
    return pattern !== null && supportsDirectOwnerClaim(evidence, clausesForTarget, pattern, {
      rejectForwardedOrQuoted: true,
      rejectHedges: true,
      namesThirdPartyPossession: thirdPartyPossession,
      clauseAllowed: kind === "contact_step"
        ? (clause) => contactRecipientMatchesLabel(clause, workflowLabel)
        : undefined,
    });
  }
  if (status === "owner_reported_not_done") {
    return supportsDirectOwnerClaim(evidence, clausesForTarget, OWNER_ACTION_NOT_DONE, {
      allowNegation: true,
      rejectForwardedOrQuoted: true,
      rejectHedges: true,
      namesThirdPartyPossession: thirdPartyPossession,
    });
  }
  const action = status === "owner_reported_offered" ? OWNER_OFFERED
    : status === "owner_reported_waitlisted" ? OWNER_WAITLISTED
      : status === "owner_reported_rejected" ? OWNER_REJECTED
        : status === "owner_reported_withdrawn" ? OWNER_WITHDREW
          : status === "owner_reported_pending" ? OWNER_CONDITION_PENDING
            : status === "owner_reported_satisfied" ? OWNER_CONDITION_SATISFIED
              : status === "owner_reported_unsatisfied" ? OWNER_CONDITION_UNSATISFIED
                : status === "owner_reported_accepted" ? OWNER_ACCEPTED
                  : OWNER_DECLINED;
  return supportsDirectOwnerClaim(evidence, clausesForTarget, action, {
    allowNegation: status === "owner_reported_unsatisfied",
    rejectForwardedOrQuoted: true,
    rejectHedges: true,
    namesThirdPartyPossession: thirdPartyPossession,
  });
}

export function supportsWorkflowStatusEvidence(
  status: UniversityWorkflowStatus,
  kind: UniversityWorkflowKind,
  evidence: string,
  workflowRef: string,
  workflowLabel: string,
  applicationItemRef: string | null,
  applicationLabel: string | null,
  applicationKind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext,
  snapshot: UniversityTrackerSnapshot | null,
): boolean {
  return supportsWorkflowStatus(
    status,
    kind,
    evidence,
    workflowLabel,
    applicationLabel,
    applicationKind,
    workflowTargetClauses(
      evidence,
      workflowRef,
      workflowLabel,
      applicationItemRef,
      applicationLabel,
      applicationKind,
      program,
      snapshot,
    ),
  );
}

function workflowDeadline(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
  targetClauses: readonly string[],
): OwnerUniversityWorkflowDeadlineUpdate {
  const item = exactRecord(
    value,
    ["date", "instant", "timeZone", "verification", "evidence"],
    "university_workflow_model_deadline_invalid",
  );
  const date = item.date === null
    ? null
    : inline(item.date, 10, "university_workflow_model_deadline_invalid", redactor);
  const instant = item.instant === null
    ? null
    : inline(item.instant, 32, "university_workflow_model_deadline_invalid", redactor);
  const timeZone = item.timeZone === null
    ? null
    : inline(item.timeZone, 64, "university_workflow_model_deadline_invalid", redactor);
  if (date !== null && (!LOCAL_DATE.test(date)
    || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
    || instant !== null || timeZone !== null)) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  if (instant !== null && (!Number.isFinite(Date.parse(instant))
    || new Date(Date.parse(instant)).toISOString() !== instant
    || timeZone === null || !validTimeZone(timeZone)
    || !ownerMessage.includes(instant) || !ownerMessage.includes(timeZone))) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  if (date === null && instant === null && timeZone !== null) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  const checkedVerification = verification(item.verification, ownerMessage, redactor);
  if (checkedVerification.state === "unverified"
    && (checkedVerification.sourceUrl !== null || checkedVerification.cycle !== null)) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  const evidence = ownerEvidence(item.evidence, ownerMessage, "university_workflow_model_deadline_invalid", redactor);
  if (evidence !== ownerMessage || targetClauses.length === 0) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  if (date !== null && !targetClauses.some((clause) => evidenceSupportsDate(clause, date))) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  if (instant !== null && !targetClauses.some((clause) => clause.includes(instant) && clause.includes(timeZone ?? ""))) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  if (checkedVerification.state === "verified" && !targetClauses.some((clause) =>
    clause.includes(checkedVerification.sourceUrl ?? "")
    && evidenceSupportsCycle(clause, checkedVerification.cycle ?? ""))) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  return Object.freeze({ date, instant, timeZone, verification: checkedVerification, evidence });
}

function workflowUpdate(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
  snapshot: UniversityTrackerSnapshot | null,
  programUpdates: readonly OwnerUniversityProgramUpdate[],
  applicationUpdates: readonly OwnerUniversityApplicationUpdate[],
): OwnerUniversityWorkflowUpdate {
  const item = exactRecord(value, [
    "workflowRef", "programRef", "applicationItemRef", "kind", "label", "owner", "status",
    "statusEvidence", "preparedDetails", "deadline", "executionBoundary",
  ], "university_workflow_model_item_invalid");
  if (typeof item.workflowRef !== "string"
    || !ULID.test(item.workflowRef) && !NEW_WORKFLOW_ITEM.test(item.workflowRef)
    || typeof item.programRef !== "string"
    || !ULID.test(item.programRef) && !NEW_PROGRAM.test(item.programRef)
    || item.applicationItemRef !== null && (typeof item.applicationItemRef !== "string"
      || !ULID.test(item.applicationItemRef) && !NEW_APPLICATION_ITEM.test(item.applicationItemRef))
    || item.executionBoundary !== "owner_only") {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const existing = currentWorkflowItem(snapshot, item.workflowRef);
  const isNew = NEW_WORKFLOW_ITEM.test(item.workflowRef);
  if (isNew === (existing !== null)) throw new TypeError("university_workflow_model_item_invalid");
  const kind = item.kind === null ? null : item.kind as UniversityWorkflowKind;
  const owner = item.owner === null ? null : item.owner as UniversityWorkflowOwner;
  const status = item.status === null ? null : item.status as UniversityWorkflowStatus;
  if (kind !== null && !WORKFLOW_KINDS.has(kind) || owner !== null && !WORKFLOW_OWNERS.has(owner)
    || status !== null && !WORKFLOW_STATUSES.has(status)) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const label = optionalInline(item.label, 160, "university_workflow_model_item_invalid", redactor);
  const preparedDetails = item.preparedDetails === null ? null
    : evidenceValue(item.preparedDetails, 2_048, "university_workflow_model_item_invalid", redactor);
  if (label !== null && !isWorkflowLabelSafe(label)
    || preparedDetails !== null && !isWorkflowPreparedDetailsSafe(preparedDetails)) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const program = existing?.program ?? snapshot?.programs.find((candidate) => candidate.programId === item.programRef)
    ?? programUpdates.find((candidate) => candidate.programRef === item.programRef);
  if (program === undefined || program.university === null || program.programName === null
    || existing !== null && existing.program.programId !== item.programRef) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const programContext: ApplicationProgramContext = Object.freeze({
    university: program.university,
    programName: program.programName,
  });
  const effectiveKind = kind ?? existing?.item.kind ?? null;
  const effectiveOwner = owner ?? existing?.item.owner ?? null;
  const effectiveLabel = label ?? existing?.item.label ?? null;
  const effectiveApplicationRef = isNew
    ? item.applicationItemRef as string | null
    : existing?.item.applicationItemId ?? null;
  const existingApplication = snapshot?.programs.flatMap((candidate) => candidate.applicationItems.map((application) => ({
    application,
    programId: candidate.programId,
  }))).find((candidate) => candidate.application.itemId === effectiveApplicationRef);
  const responseApplication = applicationUpdates.find((candidate) => candidate.itemRef === effectiveApplicationRef);
  const applicationLabel = existingApplication?.application.label ?? responseApplication?.label ?? null;
  const applicationKind = existingApplication?.application.kind ?? responseApplication?.kind ?? null;
  if (effectiveKind === null || effectiveOwner === null || effectiveLabel === null
    || isNew && (kind === null || owner === null || label === null || status === null
      || item.deadline === null)
    || !isNew && (kind !== null || owner !== null || label !== null || item.applicationItemRef !== null)
    || !isNew && status === null && preparedDetails === null && item.deadline === null
    || effectiveKind.startsWith("offer") && effectiveApplicationRef !== null
    || !effectiveKind.startsWith("offer") && (effectiveApplicationRef === null
      || applicationLabel === null || applicationKind === null
      || existingApplication !== undefined && existingApplication.programId !== item.programRef
      || responseApplication !== undefined && responseApplication.programRef !== item.programRef)
    || isNew && !containsLabel(ownerMessage, effectiveLabel)) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const targetClauses = workflowTargetClauses(
    ownerMessage,
    item.workflowRef,
    effectiveLabel,
    effectiveApplicationRef,
    applicationLabel,
    applicationKind,
    programContext,
    snapshot,
  );
  const statusEvidence = item.statusEvidence === null ? null
    : ownerEvidence(item.statusEvidence, ownerMessage, "university_workflow_model_item_invalid", redactor);
  if (status === null && statusEvidence !== null || status !== null && (statusEvidence !== ownerMessage
    || !supportsWorkflowStatusEvidence(
      status,
      effectiveKind,
      statusEvidence,
      item.workflowRef,
      effectiveLabel,
      effectiveApplicationRef,
      applicationLabel,
      applicationKind,
      programContext,
      snapshot,
    ))) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  if (preparedDetails !== null && !isNew && !targetClauses.some((clause) => PREPARATION_REQUEST.test(clause))) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const deadline = item.deadline === null ? null
    : workflowDeadline(item.deadline, ownerMessage, redactor, targetClauses);
  return Object.freeze({
    workflowRef: item.workflowRef,
    programRef: item.programRef,
    applicationItemRef: isNew ? effectiveApplicationRef : null,
    kind,
    label,
    owner,
    status,
    statusEvidence,
    preparedDetails,
    deadline,
    executionBoundary: "owner_only",
  });
}

export function parseOwnerUniversityPlan(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
  snapshot: UniversityTrackerSnapshot | null = null,
): OwnerUniversityPlan {
  const currentOwnerMessage = ownerMessage.trim();
  // Direct pre-step-6 callers remain read-compatible. The live combined model
  // contract requires workflowUpdates before this parser is reached.
  const responseFields = value !== null && typeof value === "object" && Object.hasOwn(value, "workflowUpdates")
    ? ["engaged", "programUpdates", "applicationUpdates", "workflowUpdates"]
    : ["engaged", "programUpdates", "applicationUpdates"];
  const item = exactRecord(
    value,
    responseFields,
    "university_tracker_model_response_invalid",
  );
  if (typeof item.engaged !== "boolean") throw new TypeError("university_tracker_model_response_invalid");
  const programUpdates = Object.freeze(denseArray(item.programUpdates, 16, "university_tracker_model_response_invalid")
    .map((entry) => programUpdate(entry, currentOwnerMessage, redactor)));
  const applicationUpdates = Object.freeze(denseArray(
    item.applicationUpdates,
    32,
    "university_tracker_model_response_invalid",
  ).map((entry) => applicationUpdate(entry, currentOwnerMessage, redactor, snapshot, programUpdates)));
  const workflowUpdates = Object.freeze(denseArray(
    item.workflowUpdates ?? [],
    16,
    "university_tracker_model_response_invalid",
  ).map((entry) => workflowUpdate(
    entry,
    currentOwnerMessage,
    redactor,
    snapshot,
    programUpdates,
    applicationUpdates,
  )));
  const preparedDetailsBytes = workflowUpdates.reduce((total, update) =>
    total + (update.preparedDetails === null ? 0 : encoder.encode(update.preparedDetails).byteLength), 0);
  if (preparedDetailsBytes > MAX_WORKFLOW_PREPARED_DETAILS_PER_PLAN_BYTES) {
    throw new TypeError("university_tracker_model_response_invalid");
  }
  if (applicationUpdates.filter((update) => update.status === "submitted_by_sid").length > 1) {
    throw new TypeError("university_application_model_item_invalid");
  }
  if (!item.engaged && (programUpdates.length > 0 || applicationUpdates.length > 0 || workflowUpdates.length > 0)) {
    throw new TypeError("university_tracker_model_response_invalid");
  }
  return Object.freeze({ engaged: item.engaged, programUpdates, applicationUpdates, workflowUpdates });
}

export function universityStateJson(
  snapshot: UniversityTrackerSnapshot,
  ownerMessage = "",
  maximumExpandedPrograms = 2,
  now: Date | null = null,
): string {
  const nowMilliseconds = now === null ? null : now.getTime();
  const expandedProgramIds = new Set(snapshot.programs.filter((program) =>
    programAliases(program).some((name) => mentions(ownerMessage, name)))
    .slice(0, maximumExpandedPrograms).map((program) => program.programId));
  return canonicalJson(snapshot.programs.map((program) => {
    const namedProgram = expandedProgramIds.has(program.programId);
    const applicationItems = program.applicationItems.filter((item) =>
      item.status !== "submitted_by_sid" && item.status !== "not_needed_by_sid").map((item) => namedProgram ? {
        itemId: item.itemId,
        kind: item.kind,
        label: item.label,
        status: item.status,
        dueDate: item.dueDate,
        verification: {
          state: item.verification.state,
          sourceUrl: item.verification.sourceUrl,
          cycle: item.verification.cycle,
        },
      } : {
        itemId: item.itemId,
        label: item.label,
        status: item.status,
        deadline: item.dueDate === null ? "unverified" : `${item.dueDate}:${item.verification.state}`,
      });
    const inactiveApplicationItems = program.applicationItems.filter((item) =>
      (item.status === "submitted_by_sid" || item.status === "not_needed_by_sid")
      && namesApplicationItem(ownerMessage, item.label, item.kind, program)).map((item) => ({
        itemId: item.itemId,
        kind: item.kind,
        label: item.label,
        status: item.status,
      }));
    const workflowItems = (program.workflowItems ?? []).filter((item) => {
      const namedWorkflow = containsLabel(ownerMessage, item.label);
      const applicationItem = item.applicationItemId === null
        ? null
        : program.applicationItems.find((candidate) => candidate.itemId === item.applicationItemId) ?? null;
      const parentClosed = applicationItem?.status === "submitted_by_sid"
        || applicationItem?.status === "not_needed_by_sid";
      if (parentClosed) return namedWorkflow;
      if (!TERMINAL_WORKFLOW_STATUSES.has(item.status) || namedWorkflow) return true;
      if (nowMilliseconds === null || !Number.isFinite(nowMilliseconds)) return false;
      const updatedAt = Date.parse(item.updatedAt);
      return Number.isFinite(updatedAt)
        && nowMilliseconds - updatedAt <= RECENT_TERMINAL_WORKFLOW_MILLISECONDS;
    }).map((item) => namedProgram ? {
      workflowId: item.workflowId,
      applicationItemId: item.applicationItemId,
      kind: item.kind,
      label: item.label,
      owner: item.owner,
      status: item.status,
      preparedDetails: item.preparedDetails,
      executionBoundary: item.executionBoundary,
      deadline: item.deadline,
    } : {
      workflowId: item.workflowId,
      kind: item.kind,
      label: item.label,
      owner: item.owner,
      status: item.status,
      deadline: {
        date: item.deadline.date,
        instant: item.deadline.instant,
        timeZone: item.deadline.timeZone,
        verificationState: item.deadline.verification.state,
      },
    });
    if (!namedProgram) return {
      programId: program.programId,
      university: program.university,
      programName: program.programName,
      verificationState: program.verification.state,
      requirements: program.requirements.map((item) => ({
        itemId: item.itemId,
        label: item.label,
        verificationState: item.verification.state,
      })),
      dates: program.dates.map((item) => ({
        itemId: item.itemId,
        label: item.label,
        date: item.date,
        verificationState: item.verification.state,
      })),
      applicationItems,
      inactiveApplicationItems,
      ...(workflowItems.length === 0 ? {} : { workflowItems }),
    };
    return {
      programId: program.programId,
      university: program.university,
      campus: program.campus,
      programName: program.programName,
      ouacCode: program.ouacCode,
      verification: program.verification,
      requirements: program.requirements,
      dates: program.dates,
      applicationItems,
      inactiveApplicationItems,
      ...(workflowItems.length === 0 ? {} : { workflowItems }),
    };
  }));
}

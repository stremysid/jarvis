import type { JsonValue, Ulid } from "../../../../packages/contracts/src/index.js";
import { canonicalJson } from "../../../../packages/contracts/src/index.js";
import type {
  OwnerApplicationDueDateUpdate,
  OwnerUniversityApplicationUpdate,
  OwnerUniversityDateAddition,
  OwnerUniversityPlan,
  OwnerUniversityProgramUpdate,
  OwnerUniversityRequirementAddition,
  OwnerUniversityVerification,
  UniversityApplicationItemKind,
  UniversityApplicationItem,
  UniversityApplicationItemStatus,
  UniversityProgram,
  UniversityTrackerSnapshot,
} from "./university-tracker-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const NEW_PROGRAM = /^new-[1-9][0-9]{0,2}$/u;
const NEW_APPLICATION_ITEM = /^new-item-[1-9][0-9]{0,2}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const OWNER_SUBMISSION = /(?:\bi(?:['’]ve| have)?\s+(?:(?:already|just|now|successfully)\s+)?|^(?:(?:already|just|now|successfully)\s+)?)(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;
const CONDITIONAL_OR_QUESTION = /\?|\b(?:if|unless|maybe|perhaps|might|could|would)\b/iu;
const HEARSAY = /\b(?:thinks?|heard|said|might|maybe)\b/iu;
const NEGATION = /\b(?:not|never|none|nothing|haven't|hasn't|hadn't|didn't|don't|doesn't|won't|can't|cannot|couldn't|wouldn't|shouldn't|isn't|aren't|wasn't|weren't)\b|n['’]t\b/iu;
const RETRACTION = /\b(?:actually|correction|wait|jk|just\s+kidding|didn't\s+go\s+through|did\s+not\s+go\s+through)\b/iu;
const SUBMISSION_CORRECTION = /\b(?:didn't|did\s+not|wasn't|was\s+not|never)\s+(?:(?:actually|really|successfully|just|ever)\s+){0,2}(?:submit|send|upload|turn\s+in)|\b(?:submission|upload)\b.{0,48}\b(?:failed|crashed|rejected)|\bdid(?:n't|\s+not)\s+go\s+through\b|\b(?:undo|reopen|mark)\b.{0,48}\bnot\s+submitted\b/iu;
const RETIREMENT = /\b(?:not\s+(?:applying|needed)|skip(?:ping)?|remove|duplicate|wrong\s+item|no\s+longer\s+need)\b/iu;
const BARE_DONT_NEED = /\b(?:don't|do\s+not)\s+need\b/iu;
const REACTIVATION = /\b(?:changed\s+my\s+mind|restore|resume|keep|need\s+(?:this|the|it)|doing\s+(?:this|the)|applying\s+(?:after\s+all|to)|going\s+ahead)\b/iu;
const NOT_STARTED_REPORT = /\b(?:haven't|have\s+not|hadn't|had\s+not|didn't|did\s+not)\s+(?:started|begun|worked\s+on)|\bnot\s+started\b/iu;
const DRAFTING_REPORT = /\b(?:i(?:['’]m|\s+am)\s+(?:drafting|working\s+on)|i(?:['’]ve|\s+have)\s+(?:started|begun)|(?:started|began)\s+(?:my|the)|draft(?:ing)?\s+(?:my|the))\b/iu;
const READY_REPORT = /\b(?:i(?:['’]ve|\s+have|\s)\s*(?:finished|completed)|i(?:['’]m|\s+am)\s+done\s+with|ready\s+to\s+submit|(?:draft|essay|application|aif|statement|reference|transcript)\s+is\s+ready)\b/iu;
const DATE_CORRECTION = /\b(?:wrong|incorrect|remove|clear|unknown|unpublished|not\s+published|no\s+longer)\b.{0,48}\b(?:date|deadline)\b|\b(?:date|deadline)\b.{0,48}\b(?:wrong|incorrect|remove|clear|unknown|unpublished|not\s+published|no\s+longer)\b/iu;
const LABEL_METADATA = /\b(?:verified|unverified)\b|\b\d{4}[-/.]\d{2}[-/.]\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+20\d{2})?\s*$/iu;
const JOINT_OWNER_SUBMISSION = /\b(?:(?:m(?:s|r)\.?|dr\.?)\s+\p{L}+[\p{L}'’.-]*|(?:my\s+)?(?:mom|mother|dad|father|parents?|guardians?|sister|brother|sibling)|(?:my\s+)?(?:teacher|counsell?or|referee))\s+and\s+i\s+(?:(?:have|had)\s+)?(?:(?:already|just|now|successfully)\s+)?(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;
const REPORTED_OWNER_SUBMISSION = /\b(?:asked|said|says|told|wrote|writes|sent\s+me|forwarded)\b.{0,64}\bi\s+(?:(?:already|just|now|successfully)\s+)?(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;
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
  const phrasePatterns = [...new Set(protectedPhrases.map((phrase) => phrase.trim()).filter(Boolean))]
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

function itemEvidenceClauses(
  evidence: string,
  itemRef: string,
  label: string | null,
  kind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext | null,
  snapshot: UniversityTrackerSnapshot | null,
): readonly string[] {
  return Object.freeze(clauseGroups(evidence, true, itemNames(label, program)).flatMap((sentence) => {
    let immediatelyFollowsTarget = false;
    const relevant: string[] = [];
    for (const clause of sentence) {
      if (clauseNamesOnlyItem(clause, itemRef, label, kind, program, snapshot)) {
        immediatelyFollowsTarget = true;
        relevant.push(clause);
        continue;
      }
      const namesTrackedItem = namedApplicationItems(clause, snapshot).length > 0;
      if (namesTrackedItem || namesApplicationItem(clause, label, kind, program)) {
        immediatelyFollowsTarget = false;
        continue;
      }
      if (immediatelyFollowsTarget && (/\b(?:it|that)\b/iu.test(clause)
        || /\bi\b/iu.test(clause) && REACTIVATION.test(clause))) relevant.push(clause);
      immediatelyFollowsTarget = false;
    }
    return relevant;
  }));
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
    return !JOINT_OWNER_SUBMISSION.test(evidence) && !REPORTED_OWNER_SUBMISSION.test(evidence)
      && !RETRACTION.test(evidence) && evidenceClauses.some((clause) =>
      OWNER_SUBMISSION.test(clause) && !NEGATION.test(clause)
      && !RETRACTION.test(clause) && !CONDITIONAL_OR_QUESTION.test(clause)
      && !namesItemAsThirdPartyPossession(clause, label, kind));
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

export function parseOwnerUniversityPlan(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
  snapshot: UniversityTrackerSnapshot | null = null,
): OwnerUniversityPlan {
  const currentOwnerMessage = ownerMessage.trim();
  const item = exactRecord(
    value,
    ["engaged", "programUpdates", "applicationUpdates"],
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
  if (applicationUpdates.filter((update) => update.status === "submitted_by_sid").length > 1) {
    throw new TypeError("university_application_model_item_invalid");
  }
  if (!item.engaged && (programUpdates.length > 0 || applicationUpdates.length > 0)) {
    throw new TypeError("university_tracker_model_response_invalid");
  }
  return Object.freeze({ engaged: item.engaged, programUpdates, applicationUpdates });
}

export function universityStateJson(
  snapshot: UniversityTrackerSnapshot,
  ownerMessage = "",
  maximumExpandedPrograms = 2,
): string {
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
        dueDate: item.dueDate,
        verificationState: item.verification.state,
      });
    const inactiveApplicationItems = program.applicationItems.filter((item) =>
      (item.status === "submitted_by_sid" || item.status === "not_needed_by_sid")
      && namesApplicationItem(ownerMessage, item.label, item.kind, program)).map((item) => ({
        itemId: item.itemId,
        kind: item.kind,
        label: item.label,
        status: item.status,
      }));
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
    };
  }) as unknown as JsonValue);
}

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
const ADMISSION_CYCLE = /^20\d{2}(?:[-–]20\d{2})?$/u;
const MONTH_DAY_LABEL = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/iu;
const NUMERIC_MONEY = /(?:[$€£]\s*\d|\b(?:cad|usd|eur|gbp)\s*\d|\b\d+(?:[.,]\d{1,2})?\s*(?:bucks?|cad|usd|eur|gbp|dollars?)\b|\b(?:fee|cost|pay(?:ment)?)\b.{0,24}\b\d+(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d{1,2})?\b.{0,24}\b(?:fee|cost|pay(?:ment)?)\b)/iu;
const SPELLED_MONEY = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)(?:[-\s]+(?:and\s+)?(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)){0,8}\s+(?:bucks?|cad|usd|eur|gbp|dollars?)\b/iu;
const EMAIL_ADDRESS = /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/iu;
const PHONE_NUMBER = /(?:^|\D)(?:\+?\d[\d ().-]{7,}\d)(?:\D|$)/u;
const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/gu;
const LABEL_METADATA = /\b(?:verified|unverified)\b|\b\d{4}[-/.]\d{2}[-/.]\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+20\d{2})?\s*$/iu;
const encoder = new TextEncoder();
export const MAX_WORKFLOW_PREPARED_DETAILS_PER_PLAN_BYTES = 12_000;
const UNVERIFIED_DRAFT_PREFIX = "Unverified draft text; never treat this as a tracker date, requirement, amount, or completed action:\n";
const MAX_WORKFLOW_PREPARED_DETAILS_BYTES = 2_048;

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

type OfferWorkflowKind = Extract<UniversityWorkflowKind, "offer" | "offer_condition" | "offer_response">;
type StepWorkflowKind = Exclude<UniversityWorkflowKind, OfferWorkflowKind>;

/** Offer rows never carry model-chosen names: the label and owner are fixed per kind. */
export const OFFER_WORKFLOW_LABELS: Readonly<Record<OfferWorkflowKind, string>> = Object.freeze({
  offer: "offer",
  offer_condition: "offer conditions",
  offer_response: "offer response",
});
export const OFFER_WORKFLOW_OWNERS: Readonly<Record<OfferWorkflowKind, UniversityWorkflowOwner>> = Object.freeze({
  offer: "university",
  offer_condition: "sid",
  offer_response: "sid",
});

export function isOfferWorkflowKind(kind: UniversityWorkflowKind): kind is OfferWorkflowKind {
  return kind === "offer" || kind === "offer_condition" || kind === "offer_response";
}

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

/**
 * The model supplies the date it read and the evidence it read it from. Code
 * checks only facts it owns: the date is a real calendar date, the verification
 * is one of the two states, and a `verified` source URL and cycle appear in
 * Sid's own message. It does not read Sid's wording for a date spelling.
 */
function applicationDueDate(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
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
  return Object.freeze({
    date,
    verification: checkedVerification,
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

function applicationUpdate(
  value: unknown,
  ownerMessage: string,
  redactor: Redactor,
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
  const dueDate = item.dueDate === null ? null
    : applicationDueDate(item.dueDate, ownerMessage, redactor);
  // The model declares the status; code keeps the provenance. The only status
  // rule left here is that the declaration carries Sid's own current message as
  // its evidence, which is a receipt fact, not a reading of what he meant.
  if (isNew && (kind === null || label === null || status === null || statusEvidence === null || dueDate === null)
    || !isNew && (kind !== null || label !== null)
    || isNew && status === "not_needed_by_sid"
    || isNew && (LABEL_METADATA.test(label ?? "") || !containsLabel(ownerMessage, label ?? ""))
    || status === null && statusEvidence !== null
    || status !== null && statusEvidence === null
    || status !== null && statusEvidence !== ownerMessage) {
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

// ---------------------------------------------------------------------------
// Workflow steps and offer records (migration 0029). Nothing below is used by
// the PR #52 application-item checklist above.
// ---------------------------------------------------------------------------

function maskTitleAbbreviations(value: string): string {
  return value.replace(/\b(Mr|Ms|Mrs|Mx|Dr|St|Prof)\.(?=\s+\p{L})/giu, "$1");
}

function workflowContainsLabel(value: string, label: string): boolean {
  return containsLabel(maskTitleAbbreviations(value), maskTitleAbbreviations(label));
}

export function isWorkflowLabelSafe(value: string): boolean {
  return !LABEL_METADATA.test(value) && !MONTH_DAY_LABEL.test(value)
    && !/\b(?:confirmed|official(?:ly)?)\b/iu.test(value)
    && !/\b(?:deadline|due|by|before)\b.{0,24}\b(?:today|tomorrow|tonight|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/iu.test(value)
    && !NUMERIC_MONEY.test(value) && !SPELLED_MONEY.test(value)
    && !EMAIL_ADDRESS.test(value) && !PHONE_NUMBER.test(value);
}

export function isWorkflowPreparedDetailsSafe(value: string): boolean {
  const draft = value.startsWith(UNVERIFIED_DRAFT_PREFIX) ? value.slice(UNVERIFIED_DRAFT_PREFIX.length) : value;
  return draft.trim().length > 0 && draft.isWellFormed() && draft === draft.normalize("NFC")
    && !draft.split(/\r?\n/u).some((line) => UNSAFE_INLINE.test(line));
}

/** The draft text inside a stored unverified-draft wrapper, for Sid to review. */
export function unverifiedDraftText(value: string): string {
  return value.startsWith(UNVERIFIED_DRAFT_PREFIX) ? value.slice(UNVERIFIED_DRAFT_PREFIX.length) : value;
}

export function asUnverifiedWorkflowDraft(
  value: string,
  error = "university_workflow_model_item_invalid",
): string {
  const draft = value.startsWith(UNVERIFIED_DRAFT_PREFIX) ? value.slice(UNVERIFIED_DRAFT_PREFIX.length) : value;
  if (!isWorkflowPreparedDetailsSafe(draft)) throw new TypeError(error);
  const wrapped = `${UNVERIFIED_DRAFT_PREFIX}${draft}`;
  if (encoder.encode(wrapped).byteLength > MAX_WORKFLOW_PREPARED_DETAILS_BYTES) {
    throw new TypeError(error);
  }
  return wrapped;
}

function workflowClauseGroups(
  value: string,
  protectedPhrases: readonly string[],
): readonly (readonly string[])[] {
  const masked = maskTitleAbbreviations(value);
  return clauseGroups(masked, true, [
    ...protectedPhrases.map(maskTitleAbbreviations),
    ...(masked.match(ISO_INSTANT) ?? []),
  ]);
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
  return status === "not_needed_by_sid"
    || status === "prepared" || status === "owner_reported_done" || status === "owner_reported_not_done";
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
    .filter((item) => !isOfferWorkflowKind(item.kind) && workflowContainsLabel(evidence, item.label)));
}

function stepTargetClauses(
  evidence: string,
  workflowRef: string,
  workflowLabel: string,
  applicationItemRef: string | null,
  applicationLabel: string | null,
  applicationKind: UniversityApplicationItemKind | null,
  program: ApplicationProgramContext,
  snapshot: UniversityTrackerSnapshot | null,
): readonly string[] {
  if (applicationItemRef === null || applicationLabel === null) return Object.freeze([]);
  const protectedPhrases = [workflowLabel, applicationLabel, ...programAliases(program)];
  return Object.freeze(workflowClauseGroups(evidence, protectedPhrases).flatMap((sentence) =>
    sentence.filter((clause) => {
      if (!workflowContainsLabel(clause, workflowLabel) || !workflowContainsLabel(clause, applicationLabel)) {
        return false;
      }
      const namedWorkflows = namedWorkflowItems(clause, snapshot);
      if (namedWorkflows.length > 1
        || namedWorkflows.length === 1 && namedWorkflows[0]?.workflowId !== workflowRef) return false;
      return clauseNamesOnlyItem(clause, applicationItemRef, applicationLabel, applicationKind, program, snapshot);
    })));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizedOwnerSentence(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-CA")
    .replace(/[’ʼ`]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:hey\s+)?jarvis\s*[,:!-]?\s+/u, "")
    .replace(/\s*[.!]+$/u, "")
    .trim();
}

function normalizedName(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-CA").replace(/[’ʼ`]/gu, "'").replace(/\s+/gu, " ").trim();
}

function universityNameAliases(university: string): readonly string[] {
  const full = normalizedName(university);
  const short = full.replace(/^university\s+of\s+/u, "").replace(/\s+university$/u, "").trim();
  return Object.freeze([...new Set([full, short].filter((value) => value.length > 0))]);
}

/** The single explicit sentence that records each offer-family status. */
function offerTemplates(status: UniversityWorkflowStatus): readonly ((school: string, program: string) => string)[] {
  const fromFor = (school: string, program: string): string =>
    String.raw`(?:from (?:the )?${school} for ${program}|for ${program} from (?:the )?${school})`;
  switch (status) {
    case "owner_reported_offered":
      return [(s, p) => String.raw`i (?:just )?(?:got|received) (?:an|a) (?:(?:conditional|unconditional) )?offer ${fromFor(s, p)}`];
    case "owner_reported_waitlisted":
      return [(s, p) => String.raw`i (?:got|was|have been|'ve been) waitlisted (?:(?:by|at) (?:the )?${s} for ${p}|for ${p} (?:by|at) (?:the )?${s})`];
    case "owner_reported_rejected":
      return [(s, p) => String.raw`i (?:got|was|have been|'ve been) rejected (?:by (?:the )?${s} for ${p}|for ${p} by (?:the )?${s})`];
    case "owner_reported_withdrawn":
      return [(s, p) => String.raw`i withdrew (?:my application )?(?:from (?:the )?${s} for ${p}|from ${p} at (?:the )?${s})`];
    case "owner_reported_pending":
      return [(s, p) => String.raw`the conditions? (?:of|on) my offer ${fromFor(s, p)} (?:is|are) (?:still )?pending`];
    case "owner_reported_satisfied":
      return [(s, p) => String.raw`i (?:have |'ve )?met the conditions? (?:of|on) my offer ${fromFor(s, p)}`];
    case "owner_reported_unsatisfied":
      return [(s, p) => String.raw`i (?:did not|didn't) meet the conditions? (?:of|on) my offer ${fromFor(s, p)}`];
    case "owner_reported_accepted":
      return [(s, p) => String.raw`i accepted (?:my|the) offer ${fromFor(s, p)}`];
    case "owner_reported_declined":
      return [(s, p) => String.raw`i declined (?:my|the) offer ${fromFor(s, p)}`];
    case "prepared":
      return [(s, p) => String.raw`(?:please )?(?:draft|prepare) (?:a |my |the )?(?:reply|response) to (?:my|the) offer ${fromFor(s, p)}`];
    default:
      return [];
  }
}

function offerMessageMatchesProgram(
  status: UniversityWorkflowStatus,
  ownerMessage: string,
  program: ApplicationProgramContext,
): boolean {
  const sentence = normalizedOwnerSentence(ownerMessage);
  const programName = escapeRegExp(normalizedName(program.programName));
  return universityNameAliases(program.university).some((alias) =>
    offerTemplates(status).some((template) =>
      new RegExp(`^${template(escapeRegExp(alias), programName)}$`, "u").test(sentence)));
}

/**
 * Offer, condition and response records come only from one whole-message
 * sentence that names a tracked university and its tracked program, with
 * nothing else in the message. No negation, hedge, hearsay, question or
 * second clause can appear, because no other words are allowed at all.
 */
export function supportsOfferStatusEvidence(
  status: UniversityWorkflowStatus,
  kind: UniversityWorkflowKind,
  ownerMessage: string,
  program: ApplicationProgramContext,
  snapshot: UniversityTrackerSnapshot | null,
): boolean {
  if (!isOfferWorkflowKind(kind) || !workflowStatusAllowed(kind, status)
    || encoder.encode(ownerMessage).byteLength > 512 || /[\r\n]/u.test(ownerMessage.trim())) return false;
  if (!offerMessageMatchesProgram(status, ownerMessage, program)) return false;
  if (snapshot === null) return true;
  const matches = snapshot.programs.filter((candidate) => offerMessageMatchesProgram(status, ownerMessage, candidate));
  return matches.length === 1
    && normalizedName(matches[0]?.university ?? "") === normalizedName(program.university)
    && normalizedName(matches[0]?.programName ?? "") === normalizedName(program.programName);
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
  if (!workflowStatusAllowed(kind, status)) return false;
  // The offer family still comes from one whole-message sentence (see
  // `supportsOfferStatusEvidence`). Every other workflow status is the model's
  // declaration, and both callers already require Sid's whole current message
  // as its evidence. No wording is read here.
  if (isOfferWorkflowKind(kind)) return supportsOfferStatusEvidence(status, kind, evidence, program, snapshot);
  return true;
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
  if (instant !== null && !targetClauses.some((clause) => clause.includes(instant) && clause.includes(timeZone ?? ""))) {
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
  const modelLabel = optionalInline(item.label, 160, "university_workflow_model_item_invalid", redactor);
  const preparedDetails = item.preparedDetails === null ? null
    : asUnverifiedWorkflowDraft(evidenceValue(
      item.preparedDetails,
      2_048,
      "university_workflow_model_item_invalid",
      redactor,
    ));
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
  if (effectiveKind === null || isNew && (kind === null || owner === null || modelLabel === null || status === null
    || item.deadline === null)
    || !isNew && (kind !== null || owner !== null || modelLabel !== null || item.applicationItemRef !== null)
    || !isNew && status === null && preparedDetails === null && item.deadline === null) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  if (isOfferWorkflowKind(effectiveKind)) {
    return offerWorkflowUpdate(
      item, isNew, effectiveKind, status, preparedDetails, programContext, ownerMessage, redactor, snapshot,
    );
  }
  const label = modelLabel;
  if (preparedDetails !== null && !isWorkflowPreparedDetailsSafe(preparedDetails)
    || label !== null && !isWorkflowLabelSafe(label)) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
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
  if (effectiveOwner === null || effectiveLabel === null
    || effectiveApplicationRef === null || applicationLabel === null || applicationKind === null
    || existingApplication !== undefined && existingApplication.programId !== item.programRef
    || responseApplication !== undefined && responseApplication.programRef !== item.programRef
    || isNew && !workflowContainsLabel(ownerMessage, effectiveLabel)) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const targetClauses = stepTargetClauses(
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
  // The model chooses `prepared` or an owner-reported status, and `prepared`
  // carries the draft it wrote. Code does not require a question first.
  const deadline = item.deadline === null ? null
    : workflowDeadline(item.deadline, ownerMessage, redactor, targetClauses);
  return Object.freeze({
    workflowRef: item.workflowRef as string,
    programRef: item.programRef as string,
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

function offerWorkflowUpdate(
  item: Record<string, unknown>,
  isNew: boolean,
  kind: OfferWorkflowKind,
  status: UniversityWorkflowStatus | null,
  preparedDetails: string | null,
  program: ApplicationProgramContext,
  ownerMessage: string,
  redactor: Redactor,
  snapshot: UniversityTrackerSnapshot | null,
): OwnerUniversityWorkflowUpdate {
  const statusEvidence = item.statusEvidence === null ? null
    : ownerEvidence(item.statusEvidence, ownerMessage, "university_workflow_model_item_invalid", redactor);
  // Every offer-family change, including a draft or deadline revision, needs
  // the one explicit sentence for its status, and only a response draft may
  // carry prepared text.
  if (status === null || item.applicationItemRef !== null || statusEvidence !== ownerMessage
    || preparedDetails !== null && status !== "prepared"
    || !supportsOfferStatusEvidence(status, kind, ownerMessage, program, snapshot)) {
    throw new TypeError("university_workflow_model_item_invalid");
  }
  const deadline = item.deadline === null ? null
    : workflowDeadline(item.deadline, ownerMessage, redactor, [ownerMessage]);
  if (deadline !== null && (deadline.date !== null || deadline.instant !== null
    || deadline.verification.state !== "unverified")) {
    throw new TypeError("university_workflow_model_deadline_invalid");
  }
  return Object.freeze({
    workflowRef: item.workflowRef as string,
    programRef: item.programRef as string,
    applicationItemRef: null,
    kind: isNew ? kind : null,
    label: isNew ? OFFER_WORKFLOW_LABELS[kind] : null,
    owner: isNew ? OFFER_WORKFLOW_OWNERS[kind] : null,
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
  ).map((entry) => applicationUpdate(entry, currentOwnerMessage, redactor)));
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
      const namedWorkflow = workflowContainsLabel(ownerMessage, item.label);
      const applicationItem = item.applicationItemId === null
        ? null
        : program.applicationItems.find((candidate) => candidate.itemId === item.applicationItemId) ?? null;
      const hiddenByParent = applicationItem?.status === "not_needed_by_sid"
        || applicationItem?.status === "submitted_by_sid"
          && (item.kind === "submission_step" || item.kind === "upload_step");
      if (hiddenByParent) return namedWorkflow;
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

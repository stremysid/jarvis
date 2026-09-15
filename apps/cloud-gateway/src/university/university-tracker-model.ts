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
  UniversityApplicationItemStatus,
  UniversityTrackerSnapshot,
} from "./university-tracker-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const NEW_PROGRAM = /^new-[1-9][0-9]{0,2}$/u;
const NEW_APPLICATION_ITEM = /^new-item-[1-9][0-9]{0,2}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const OWNER_SUBMISSION = /\bi(?:['’]ve| have)?\s+(?:(?:already|just|now|successfully)\s+)?(?:submitted|sent\s+in|turned\s+in|uploaded)\b/iu;
const encoder = new TextEncoder();

const APPLICATION_KINDS = new Set<UniversityApplicationItemKind>([
  "supplementary_application", "essay", "personal_statement", "reference", "transcript", "scholarship",
]);
const APPLICATION_STATUSES = new Set<UniversityApplicationItemStatus>([
  "not_started", "drafting", "ready", "submitted_by_sid",
]);

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

function ownerEvidence(value: unknown, ownerMessage: string, error: string, redactor: Redactor): string {
  const evidence = inline(value, 512, error, redactor);
  if (!ownerMessage.includes(evidence)) throw new TypeError(error);
  return evidence;
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
  if (item.state === "verified" && (url === null || cycle === null || !ownerMessage.includes(cycle))) {
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
  return Object.freeze({
    date,
    verification: checkedVerification,
    evidence: ownerEvidence(item.evidence, ownerMessage, "university_application_model_date_invalid", redactor),
  });
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
  const dueDate = item.dueDate === null ? null : applicationDueDate(item.dueDate, ownerMessage, redactor);
  const isNew = NEW_APPLICATION_ITEM.test(item.itemRef);
  if (isNew && (kind === null || label === null || status === null || statusEvidence === null || dueDate === null)
    || !isNew && (kind !== null || label !== null)
    || status === null && statusEvidence !== null
    || status !== null && statusEvidence === null
    || status === "submitted_by_sid" && !OWNER_SUBMISSION.test(statusEvidence ?? "")) {
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

export function parseOwnerUniversityPlan(value: unknown, ownerMessage: string, redactor: Redactor): OwnerUniversityPlan {
  const item = exactRecord(
    value,
    ["engaged", "programUpdates", "applicationUpdates"],
    "university_tracker_model_response_invalid",
  );
  if (typeof item.engaged !== "boolean") throw new TypeError("university_tracker_model_response_invalid");
  const programUpdates = Object.freeze(denseArray(item.programUpdates, 16, "university_tracker_model_response_invalid")
    .map((entry) => programUpdate(entry, ownerMessage, redactor)));
  const applicationUpdates = Object.freeze(denseArray(
    item.applicationUpdates,
    32,
    "university_tracker_model_response_invalid",
  ).map((entry) => applicationUpdate(entry, ownerMessage, redactor)));
  if (!item.engaged && (programUpdates.length > 0 || applicationUpdates.length > 0)) {
    throw new TypeError("university_tracker_model_response_invalid");
  }
  return Object.freeze({ engaged: item.engaged, programUpdates, applicationUpdates });
}

export function universityStateJson(snapshot: UniversityTrackerSnapshot): string {
  return canonicalJson(snapshot.programs.map((program) => ({
    programId: program.programId,
    university: program.university,
    campus: program.campus,
    programName: program.programName,
    ouacCode: program.ouacCode,
    verification: program.verification,
    requirements: program.requirements,
    dates: program.dates,
    applicationItems: program.applicationItems,
  })) as unknown as JsonValue);
}

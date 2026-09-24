import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import type {
  ApplyOwnerUniversityPlanInput,
  OwnerUniversityVerification,
  UniversityApplicationDigestItem,
  UniversityApplicationItem,
  UniversityApplicationItemKind,
  UniversityApplicationItemStatus,
  UniversityProgram,
  UniversityTrackerItem,
  UniversityTrackerItemKind,
  UniversityTrackerSnapshot,
  UniversityVerification,
  UniversityVerificationState,
  UniversityWorkflowItem,
  UniversityWorkflowDigestItem,
  UniversityWorkflowKind,
  UniversityWorkflowOwner,
  UniversityWorkflowStatus,
} from "./university-tracker-types.js";
import {
  asUnverifiedWorkflowDraft,
  isOfferWorkflowKind,
  isWorkflowLabelSafe,
  isWorkflowPreparedDetailsSafe,
  MAX_WORKFLOW_PREPARED_DETAILS_PER_PLAN_BYTES,
  OFFER_WORKFLOW_LABELS,
  OFFER_WORKFLOW_OWNERS,
  supportsStatus,
  supportsWorkflowStatusEvidence,
} from "./university-tracker-model.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RESPONSE_LOCAL_PROGRAM = /^new-[1-9][0-9]{0,2}$/u;
const RESPONSE_LOCAL_APPLICATION_ITEM = /^new-item-[1-9][0-9]{0,2}$/u;
const RESPONSE_LOCAL_WORKFLOW_ITEM = /^new-workflow-[1-9][0-9]{0,2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const MAX_PROGRAMS = 16;
const MAX_ITEMS_PER_PROGRAM = 32;
const MAX_ITEMS = 128;
const MAX_APPLICATION_ITEMS_PER_PROGRAM = 32;
const MAX_APPLICATION_ITEMS = 128;
const MAX_APPLICATION_HISTORY_ITEMS_PER_PROGRAM = 64;
const MAX_APPLICATION_HISTORY_ITEMS = 256;
const MAX_WORKFLOW_ITEMS_PER_PROGRAM = 64;
const MAX_WORKFLOW_ITEMS = 128;
const UNIVERSITY_PLAN_D1_STATEMENT_BUDGET = 96;
const encoder = new TextEncoder();

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

interface ProgramRow {
  principal_id: string;
  program_id: string;
  university_name: string;
  campus_name: string | null;
  program_name: string;
  ouac_code: string | null;
  verification_state: UniversityVerificationState;
  source_url: string | null;
  admission_cycle: string | null;
  verified_at: string | null;
}

interface ItemRow {
  principal_id: string;
  program_id: string;
  item_id: string;
  item_kind: UniversityTrackerItemKind;
  item_label: string;
  item_detail: string | null;
  date_value: string | null;
  verification_state: UniversityVerificationState;
  source_url: string | null;
  admission_cycle: string | null;
  verified_at: string | null;
}

interface ApplicationItemRow {
  principal_id: string;
  program_id: string;
  item_id: string;
  item_kind: UniversityApplicationItemKind;
  item_label: string;
  item_status: UniversityApplicationItemStatus;
  due_date: string | null;
  verification_state: UniversityVerificationState;
  source_url: string | null;
  admission_cycle: string | null;
  verified_at: string | null;
  source_turn_id: string;
  submitted_at: string | null;
  updated_at: string;
}

interface ApplicationCountRow {
  program_id: string;
  item_status: UniversityApplicationItemStatus;
}

interface ApplicationDigestRow extends ApplicationItemRow {
  university_name: string;
  program_name: string;
}

interface WorkflowRow {
  principal_id: string;
  program_id: string;
  application_item_id: string | null;
  event_id: string;
  workflow_id: string;
  revision_number: number;
  workflow_kind: UniversityWorkflowKind;
  workflow_label: string;
  owner_role: UniversityWorkflowOwner;
  workflow_status: UniversityWorkflowStatus;
  prepared_details: string | null;
  execution_boundary: "owner_only";
  due_date: string | null;
  due_at: string | null;
  due_timezone: string | null;
  verification_state: UniversityVerificationState;
  source_url: string | null;
  admission_cycle: string | null;
  verified_at: string | null;
  source_turn_id: string;
  created_at: string;
}

interface WorkflowDigestRow extends WorkflowRow {
  university_name: string;
  program_name: string;
}

interface ReceiptRow {
  response_hash: string;
}

interface VerificationRow {
  verification_state: UniversityVerificationState;
  source_url: string | null;
  admission_cycle: string | null;
  verified_at: string | null;
}

function rows<T>(result: D1Result<T>): readonly T[] {
  if (!Array.isArray(result.results)) throw new TypeError("university_tracker_rows_invalid");
  return result.results;
}

function inline(value: unknown, error: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new TypeError(error);
  const text = value.trim();
  if (text.length === 0 || !text.isWellFormed() || text !== text.normalize("NFC")
    || encoder.encode(text).byteLength > maximumBytes || UNSAFE_INLINE.test(text)) throw new TypeError(error);
  return text;
}

function evidence(value: unknown, error: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new TypeError(error);
  const text = value.trim();
  if (text.length === 0 || !text.isWellFormed() || text !== text.normalize("NFC")
    || encoder.encode(text).byteLength > maximumBytes
    || text.split(/\r?\n/u).some((line) => UNSAFE_INLINE.test(line))) throw new TypeError(error);
  return text;
}

function optionalInline(value: unknown, error: string, maximumBytes: number): string | null {
  return value === null ? null : inline(value, error, maximumBytes);
}

function principal(value: unknown): string {
  return inline(value, "university_tracker_principal_invalid", 256);
}

function ulid(value: unknown, error: string): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(error);
  return value as Ulid;
}

function iso(value: unknown, error: string): string {
  if (typeof value !== "string") throw new TypeError(error);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new TypeError(error);
  return value;
}

function date(value: unknown, error: string): string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new TypeError(error);
  return value;
}

function sourceUrl(value: unknown, error: string): string | null {
  if (value === null) return null;
  const text = inline(value, error, 512);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(error);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new TypeError(error);
  }
  return text;
}

function normalizedKey(parts: readonly string[], error: string, maximumBytes: number): string {
  const normalized = parts.join(" | ").toLocaleLowerCase("en-CA")
    .replace(/['’ʼ`]/gu, "'").replace(/[\p{Pd}]+/gu, " ").replace(/\s+/gu, " ");
  return inline(normalized, error, maximumBytes);
}

function checkedVerification(
  value: OwnerUniversityVerification,
  nowIso: string,
): UniversityVerification {
  if (value.state !== "verified" && value.state !== "unverified") {
    throw new TypeError("university_tracker_verification_invalid");
  }
  const url = sourceUrl(value.sourceUrl, "university_tracker_verification_invalid");
  const cycle = optionalInline(value.cycle, "university_tracker_verification_invalid", 64);
  if (value.state === "verified" && (url === null || cycle === null)) {
    throw new TypeError("university_tracker_verification_invalid");
  }
  return Object.freeze({
    state: value.state,
    sourceUrl: url,
    cycle,
    verifiedAt: value.state === "verified" ? nowIso : null,
  });
}

function checkedApplicationVerification(
  value: OwnerUniversityVerification,
  nowIso: string,
): UniversityVerification {
  const checked = checkedVerification(value, nowIso);
  if (checked.state === "verified") return checked;
  return Object.freeze({ state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null });
}

function verificationFromRow(value: VerificationRow, error: string): UniversityVerification {
  if (value.verification_state !== "verified" && value.verification_state !== "unverified") throw new TypeError(error);
  const url = sourceUrl(value.source_url, error);
  const cycle = optionalInline(value.admission_cycle, error, 64);
  const verifiedAt = value.verified_at === null ? null : iso(value.verified_at, error);
  if (value.verification_state === "verified" && (url === null || cycle === null || verifiedAt === null)
    || value.verification_state === "unverified" && verifiedAt !== null) throw new TypeError(error);
  return Object.freeze({ state: value.verification_state, sourceUrl: url, cycle, verifiedAt });
}

function programFromRow(
  value: ProgramRow,
  expectedPrincipal: string,
): Omit<UniversityProgram, "requirements" | "dates" | "applicationItems" | "workflowItems"> {
  if (value.principal_id !== expectedPrincipal) throw new TypeError("university_program_row_invalid");
  return Object.freeze({
    programId: ulid(value.program_id, "university_program_row_invalid"),
    university: inline(value.university_name, "university_program_row_invalid", 160),
    campus: optionalInline(value.campus_name, "university_program_row_invalid", 160),
    programName: inline(value.program_name, "university_program_row_invalid", 160),
    ouacCode: optionalInline(value.ouac_code, "university_program_row_invalid", 32),
    verification: verificationFromRow(value, "university_program_row_invalid"),
  });
}

function applicationItemFromRow(value: ApplicationItemRow, expectedPrincipal: string): UniversityApplicationItem {
  if (value.principal_id !== expectedPrincipal || !APPLICATION_KINDS.has(value.item_kind)
    || !APPLICATION_STATUSES.has(value.item_status)) throw new TypeError("university_application_item_row_invalid");
  const dueDate = value.due_date === null ? null : date(value.due_date, "university_application_item_row_invalid");
  const submittedAt = value.submitted_at === null
    ? null
    : iso(value.submitted_at, "university_application_item_row_invalid");
  if (value.item_status === "submitted_by_sid" && submittedAt === null
    || value.item_status !== "submitted_by_sid" && submittedAt !== null) {
    throw new TypeError("university_application_item_row_invalid");
  }
  return Object.freeze({
    itemId: ulid(value.item_id, "university_application_item_row_invalid"),
    kind: value.item_kind,
    label: inline(value.item_label, "university_application_item_row_invalid", 160),
    status: value.item_status,
    dueDate,
    verification: verificationFromRow(value, "university_application_item_row_invalid"),
    sourceTurnId: ulid(value.source_turn_id, "university_application_item_row_invalid"),
    submittedAt,
    updatedAt: iso(value.updated_at, "university_application_item_row_invalid"),
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

function workflowItemFromRow(value: WorkflowRow, expectedPrincipal: string): UniversityWorkflowItem {
  if (value.principal_id !== expectedPrincipal || !WORKFLOW_KINDS.has(value.workflow_kind)
    || !WORKFLOW_OWNERS.has(value.owner_role) || !WORKFLOW_STATUSES.has(value.workflow_status)
    || value.execution_boundary !== "owner_only" || !Number.isSafeInteger(value.revision_number)
    || value.revision_number < 1 || value.revision_number > 64) {
    throw new TypeError("university_workflow_row_invalid");
  }
  const dueDate = value.due_date === null ? null : date(value.due_date, "university_workflow_row_invalid");
  const dueAt = value.due_at === null ? null : iso(value.due_at, "university_workflow_row_invalid");
  const dueTimezone = optionalInline(value.due_timezone, "university_workflow_row_invalid", 64);
  if (dueDate !== null && (dueAt !== null || dueTimezone !== null)
    || dueAt !== null && (dueTimezone === null || !validTimeZone(dueTimezone))
    || dueDate === null && dueAt === null && dueTimezone !== null) {
    throw new TypeError("university_workflow_row_invalid");
  }
  return Object.freeze({
    workflowId: ulid(value.workflow_id, "university_workflow_row_invalid"),
    eventId: ulid(value.event_id, "university_workflow_row_invalid"),
    revision: value.revision_number,
    applicationItemId: value.application_item_id === null
      ? null
      : ulid(value.application_item_id, "university_workflow_row_invalid"),
    kind: value.workflow_kind,
    label: inline(value.workflow_label, "university_workflow_row_invalid", 160),
    owner: value.owner_role,
    status: value.workflow_status,
    preparedDetails: value.prepared_details === null
      ? null
      : evidence(value.prepared_details, "university_workflow_row_invalid", 2_048),
    executionBoundary: "owner_only",
    deadline: Object.freeze({
      date: dueDate,
      instant: dueAt,
      timeZone: dueTimezone,
      verification: verificationFromRow(value, "university_workflow_row_invalid"),
    }),
    sourceTurnId: ulid(value.source_turn_id, "university_workflow_row_invalid"),
    updatedAt: iso(value.created_at, "university_workflow_row_invalid"),
  });
}

function itemFromRow(value: ItemRow, expectedPrincipal: string): UniversityTrackerItem {
  if (value.principal_id !== expectedPrincipal || value.item_kind !== "requirement" && value.item_kind !== "date") {
    throw new TypeError("university_item_row_invalid");
  }
  const detail = optionalInline(value.item_detail, "university_item_row_invalid", 512);
  const dateValue = value.date_value === null ? null : date(value.date_value, "university_item_row_invalid");
  if (value.item_kind === "requirement" && (detail === null || dateValue !== null)
    || value.item_kind === "date" && detail !== null) throw new TypeError("university_item_row_invalid");
  return Object.freeze({
    itemId: ulid(value.item_id, "university_item_row_invalid"),
    kind: value.item_kind,
    label: inline(value.item_label, "university_item_row_invalid", 160),
    detail,
    date: dateValue,
    verification: verificationFromRow(value, "university_item_row_invalid"),
  });
}

function itemKey(kind: UniversityTrackerItemKind, label: string, detail: string | null, dateValue: string | null): string {
  return normalizedKey([kind, label, detail ?? "", dateValue ?? "awaiting-current-cycle-source"],
    "university_item_invalid", 768);
}

function applicationItemKey(kind: UniversityApplicationItemKind, label: string): string {
  return normalizedKey([kind, label], "university_application_item_invalid", 256);
}

function workflowItemKey(
  kind: UniversityWorkflowKind,
  label: string,
  owner: UniversityWorkflowOwner,
  applicationItemId: string | null,
): string {
  return normalizedKey([kind, label, owner, applicationItemId ?? "program"], "university_workflow_item_invalid", 384);
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

export class UniversityTrackerRepository {
  constructor(private readonly database: D1Database) {}

  async readSnapshot(principalIdValue: string): Promise<UniversityTrackerSnapshot> {
    const principalId = principal(principalIdValue);
    const [programResult, itemResult, applicationResult] = await Promise.all([
      this.database.prepare(`SELECT principal_id, program_id, university_name, campus_name, program_name,
          ouac_code, verification_state, source_url, admission_cycle, verified_at
        FROM university_programs
        WHERE principal_id = ?1 AND active = 1
        ORDER BY program_key, program_id
        LIMIT 16`).bind(principalId).all<ProgramRow>(),
      this.database.prepare(`SELECT principal_id, program_id, item_id, item_kind, item_label,
          item_detail, date_value, verification_state, source_url, admission_cycle, verified_at
        FROM university_program_items
        WHERE principal_id = ?1 AND status = 'active'
        ORDER BY program_id, item_kind, item_key, item_id
        LIMIT 128`).bind(principalId).all<ItemRow>(),
      this.database.prepare(`SELECT principal_id, program_id, item_id, item_kind, item_label,
          item_status, due_date, verification_state, source_url, admission_cycle, verified_at,
          source_turn_id, submitted_at, updated_at
        FROM university_application_items
        WHERE principal_id = ?1
        ORDER BY program_id, item_kind, item_key, item_id
        LIMIT 256`).bind(principalId).all<ApplicationItemRow>(),
    ]);
    let workflowRows: readonly WorkflowRow[] = Object.freeze([]);
    try {
      const workflowResult = await this.database.prepare(`SELECT w.principal_id, w.program_id, w.application_item_id,
          r.event_id, w.workflow_id, r.revision_number, w.workflow_kind, w.workflow_label,
          w.owner_role, r.workflow_status, r.prepared_details, r.execution_boundary,
          r.due_date, r.due_at, r.due_timezone, r.verification_state, r.source_url,
          r.admission_cycle, r.verified_at, r.source_turn_id, r.created_at
        FROM university_workflow_items w
        JOIN university_workflow_revisions r
          ON r.principal_id = w.principal_id AND r.workflow_id = w.workflow_id
        WHERE w.principal_id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM university_workflow_revisions newer
            WHERE newer.principal_id = r.principal_id
              AND newer.workflow_id = r.workflow_id
              AND newer.revision_number > r.revision_number
          )
        ORDER BY w.program_id, w.workflow_key, w.workflow_id
        LIMIT 129`).bind(principalId).all<WorkflowRow>();
      workflowRows = rows(workflowResult);
    } catch (error) {
      if (!(error instanceof Error)
        || !/no such table:\s*university_workflow_(?:items|revisions)/iu.test(error.message)) throw error;
      // Code can precede the separately controlled migration without taking
      // school catch-up and the already-migrated university tracker offline.
    }
    const programs = rows(programResult).slice(0, MAX_PROGRAMS).map((row) => programFromRow(row, principalId));
    const programIds = new Set(programs.map((program) => program.programId));
    const itemsByProgram = new Map<Ulid, UniversityTrackerItem[]>();
    const applicationItemsByProgram = new Map<Ulid, UniversityApplicationItem[]>();
    const workflowItemsByProgram = new Map<Ulid, UniversityWorkflowItem[]>();
    for (const row of rows(itemResult).slice(0, MAX_ITEMS)) {
      if (!programIds.has(row.program_id as Ulid)) continue;
      const item = itemFromRow(row, principalId);
      const items = itemsByProgram.get(row.program_id as Ulid) ?? [];
      if (items.length < MAX_ITEMS_PER_PROGRAM) items.push(item);
      itemsByProgram.set(row.program_id as Ulid, items);
    }
    for (const row of rows(applicationResult).slice(0, MAX_APPLICATION_HISTORY_ITEMS)) {
      if (!programIds.has(row.program_id as Ulid)) continue;
      const item = applicationItemFromRow(row, principalId);
      const items = applicationItemsByProgram.get(row.program_id as Ulid) ?? [];
      if (items.length < MAX_APPLICATION_HISTORY_ITEMS_PER_PROGRAM) items.push(item);
      applicationItemsByProgram.set(row.program_id as Ulid, items);
    }
    if (workflowRows.length > MAX_WORKFLOW_ITEMS) throw new RangeError("university_workflow_snapshot_limit_exceeded");
    for (const row of workflowRows) {
      if (!programIds.has(row.program_id as Ulid)) continue;
      const item = workflowItemFromRow(row, principalId);
      const items = workflowItemsByProgram.get(row.program_id as Ulid) ?? [];
      if (items.length >= MAX_WORKFLOW_ITEMS_PER_PROGRAM) {
        throw new RangeError("university_workflow_snapshot_limit_exceeded");
      }
      items.push(item);
      workflowItemsByProgram.set(row.program_id as Ulid, items);
    }
    return Object.freeze({
      principalId,
      programs: Object.freeze(programs.map((program) => {
        const items = itemsByProgram.get(program.programId) ?? [];
        return Object.freeze({
          ...program,
          requirements: Object.freeze(items.filter((item) => item.kind === "requirement")),
          dates: Object.freeze(items.filter((item) => item.kind === "date")),
          applicationItems: Object.freeze(applicationItemsByProgram.get(program.programId) ?? []),
          workflowItems: Object.freeze(workflowItemsByProgram.get(program.programId) ?? []),
        });
      })),
    });
  }

  /** Null removes the digest display cap for a complete calendar subscription. */
  async listApplicationItemsByDueDate(
    principalIdValue: string,
    limit: number | null = 5,
  ): Promise<readonly UniversityApplicationDigestItem[]> {
    const principalId = principal(principalIdValue);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)) {
      throw new RangeError("university_application_digest_limit_invalid");
    }
    const result = await this.database.prepare(`SELECT i.principal_id, i.program_id, i.item_id,
        i.item_kind, i.item_label, i.item_status, i.due_date, i.verification_state, i.source_url,
        i.admission_cycle, i.verified_at, i.source_turn_id, i.submitted_at, i.updated_at,
        p.university_name, p.program_name
      FROM university_application_items i
      JOIN university_programs p
        ON p.principal_id = i.principal_id AND p.program_id = i.program_id
      WHERE i.principal_id = ?1
        AND i.item_status NOT IN ('submitted_by_sid', 'not_needed_by_sid')
        AND p.active = 1
      ORDER BY i.due_date IS NULL, i.due_date, i.item_id
        LIMIT ?2`).bind(principalId, limit ?? -1).all<ApplicationDigestRow>();
    return Object.freeze(rows(result).map((row) => Object.freeze({
      ...applicationItemFromRow(row, principalId),
      university: inline(row.university_name, "university_application_digest_row_invalid", 160),
      programName: inline(row.program_name, "university_application_digest_row_invalid", 160),
    })));
  }

  /** Null removes the digest display cap for a complete calendar subscription. */
  async listWorkflowItemsByDueDate(
    principalIdValue: string,
    limit: number | null = 5,
  ): Promise<readonly UniversityWorkflowDigestItem[]> {
    const principalId = principal(principalIdValue);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)) {
      throw new RangeError("university_workflow_digest_limit_invalid");
    }
    const result = await this.database.prepare(`SELECT w.principal_id, w.program_id,
        w.application_item_id, r.event_id, w.workflow_id, r.revision_number, w.workflow_kind,
        w.workflow_label, w.owner_role, r.workflow_status, r.prepared_details,
        r.execution_boundary, r.due_date, r.due_at, r.due_timezone, r.verification_state,
        r.source_url, r.admission_cycle, r.verified_at, r.source_turn_id, r.created_at,
        p.university_name, p.program_name
      FROM university_workflow_items w
      JOIN university_workflow_revisions r
        ON r.principal_id = w.principal_id AND r.workflow_id = w.workflow_id
      JOIN university_programs p
        ON p.principal_id = w.principal_id AND p.program_id = w.program_id
      WHERE w.principal_id = ?1
        AND p.active = 1
        AND (w.application_item_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM university_application_items i
          WHERE i.principal_id = w.principal_id
            AND i.item_id = w.application_item_id
            AND (
              i.item_status = 'not_needed_by_sid'
              OR i.item_status = 'submitted_by_sid'
                AND w.workflow_kind IN ('submission_step', 'upload_step')
            )
        ))
        AND r.workflow_status NOT IN (
          'owner_reported_done', 'owner_reported_rejected', 'owner_reported_withdrawn',
          'owner_reported_satisfied', 'owner_reported_accepted', 'owner_reported_declined',
          'not_needed_by_sid'
        )
        AND NOT EXISTS (
          SELECT 1 FROM university_workflow_revisions newer
          WHERE newer.principal_id = r.principal_id
            AND newer.workflow_id = r.workflow_id
            AND newer.revision_number > r.revision_number
        )
      ORDER BY r.due_date IS NULL AND r.due_at IS NULL, COALESCE(r.due_at, r.due_date), w.workflow_id
        LIMIT ?2`).bind(principalId, limit ?? -1).all<WorkflowDigestRow>();
    return Object.freeze(rows(result).map((row) => Object.freeze({
      ...workflowItemFromRow(row, principalId),
      university: inline(row.university_name, "university_workflow_digest_row_invalid", 160),
      programName: inline(row.program_name, "university_workflow_digest_row_invalid", 160),
    })));
  }

  async applyOwnerPlan(input: ApplyOwnerUniversityPlanInput): Promise<void> {
    const principalId = principal(input.principalId);
    const turnId = ulid(input.turnId, "university_tracker_turn_invalid");
    const now = new Date(input.now.getTime());
    if (!Number.isFinite(now.getTime()) || !SHA256.test(input.responseHash) || !input.plan.engaged) {
      throw new TypeError("university_tracker_plan_invalid");
    }
    const nowIso = now.toISOString();
    const receipt = await this.database.prepare(`SELECT response_hash FROM university_tracker_turn_receipts
      WHERE principal_id = ?1 AND turn_id = ?2`).bind(principalId, turnId).first<ReceiptRow>();
    if (receipt !== null) {
      if (receipt.response_hash !== input.responseHash) throw new Error("university_tracker_turn_conflict");
      return;
    }

    const [current, applicationCountResult] = await Promise.all([
      this.readSnapshot(principalId),
      this.database.prepare(`SELECT program_id, item_status
        FROM university_application_items
        WHERE principal_id = ?1
        ORDER BY program_id, item_id
        LIMIT 256`).bind(principalId).all<ApplicationCountRow>(),
    ]);
    const programsById = new Map(current.programs.map((program) => [program.programId, program]));
    const itemsById = new Map(current.programs.flatMap((program) =>
      [...program.requirements, ...program.dates].map((item) => [item.itemId, program.programId] as const)));
    const applicationItemsById = new Map(current.programs.flatMap((program) =>
      program.applicationItems.map((item) => [item.itemId, { item, programId: program.programId }] as const)));
    const applicationProgramById = new Map(current.programs.flatMap((program) =>
      program.applicationItems.map((item) => [item.itemId, program.programId] as const)));
    const workflowsById = new Map(current.programs.flatMap((program) =>
      (program.workflowItems ?? []).map((item) => [item.workflowId, { item, programId: program.programId }] as const)));
    const activeItemCounts = new Map(current.programs.map((program) => [
      program.programId, program.requirements.length + program.dates.length,
    ]));
    const applicationItemCounts = new Map<Ulid, number>();
    const applicationHistoryCounts = new Map<Ulid, number>();
    for (const row of rows(applicationCountResult)) {
      const programId = ulid(row.program_id, "university_application_item_count_invalid");
      if (!APPLICATION_STATUSES.has(row.item_status)) {
        throw new TypeError("university_application_item_count_invalid");
      }
      applicationHistoryCounts.set(programId, (applicationHistoryCounts.get(programId) ?? 0) + 1);
      if (row.item_status !== "not_needed_by_sid") {
        applicationItemCounts.set(programId, (applicationItemCounts.get(programId) ?? 0) + 1);
      }
    }
    let applicationItemCount = [...applicationItemCounts.values()].reduce((sum, count) => sum + count, 0);
    let applicationHistoryCount = [...applicationHistoryCounts.values()].reduce((sum, count) => sum + count, 0);
    const finalProgramIds = new Set(programsById.keys());
    const seenRefs = new Set<string>();
    const responseProgramIds = new Map<string, Ulid>();
    const statements: D1PreparedStatement[] = [];
    const resolves: D1PreparedStatement[] = [];
    const inserts: D1PreparedStatement[] = [];

    for (const update of input.plan.programUpdates) {
      if (seenRefs.has(update.programRef)) throw new TypeError("university_tracker_program_ref_duplicate");
      seenRefs.add(update.programRef);
      const existingId = ULID.test(update.programRef) ? update.programRef as Ulid : null;
      let programId: Ulid;
      if (existingId === null) {
        if (!RESPONSE_LOCAL_PROGRAM.test(update.programRef) || update.university === null
          || update.programName === null || update.verification === null) {
          throw new TypeError("university_tracker_program_ref_invalid");
        }
        programId = newUlid(now);
        finalProgramIds.add(programId);
        activeItemCounts.set(programId, 0);
        applicationItemCounts.set(programId, 0);
        applicationHistoryCounts.set(programId, 0);
      } else {
        if (!programsById.has(existingId)) throw new TypeError("university_tracker_program_unknown");
        programId = existingId;
      }
      responseProgramIds.set(update.programRef, programId);
      const existing = programsById.get(programId);
      if (existing !== undefined && update.verification === null
        && (update.university !== null || update.campus !== null || update.programName !== null
          || update.ouacCode !== null)) {
        throw new TypeError("university_tracker_verification_invalid");
      }
      const university = update.university === null ? existing?.university ?? null
        : inline(update.university, "university_program_invalid", 160);
      const programName = update.programName === null ? existing?.programName ?? null
        : inline(update.programName, "university_program_invalid", 160);
      if (university === null || programName === null) throw new TypeError("university_program_invalid");
      const campus = update.campus === null ? existing?.campus ?? null
        : inline(update.campus, "university_program_invalid", 160);
      const ouacCode = update.ouacCode === null ? existing?.ouacCode ?? null
        : inline(update.ouacCode, "university_program_invalid", 32);
      const checked = update.verification === null
        ? existing?.verification ?? null
        : checkedVerification(update.verification, nowIso);
      if (checked === null) throw new TypeError("university_tracker_verification_invalid");
      const programKey = normalizedKey([university, campus ?? "", programName], "university_program_invalid", 512);
      if (existingId === null) {
        statements.push(this.database.prepare(`INSERT INTO university_programs (
          principal_id, program_id, program_key, university_name, campus_name, program_name,
          ouac_code, verification_state, source_url, admission_cycle, verified_at,
          owner_source_turn_id, active, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)`)
          .bind(principalId, programId, programKey, university, campus, programName, ouacCode,
            checked.state, checked.sourceUrl, checked.cycle, checked.verifiedAt, turnId, nowIso));
      } else if (update.university !== null || update.campus !== null || update.programName !== null
        || update.ouacCode !== null || update.verification !== null) {
        statements.push(this.database.prepare(`UPDATE university_programs
          SET program_key = ?1, university_name = ?2, campus_name = ?3, program_name = ?4,
              ouac_code = ?5, verification_state = ?6, source_url = ?7, admission_cycle = ?8,
              verified_at = ?9, owner_source_turn_id = ?10, updated_at = ?11
          WHERE principal_id = ?12 AND program_id = ?13`)
          .bind(programKey, university, campus, programName, ouacCode, checked.state, checked.sourceUrl,
            checked.cycle, checked.verifiedAt, turnId, nowIso, principalId, programId));
      }

      const knownKeys = new Set([
        ...(existing?.requirements ?? []), ...(existing?.dates ?? []),
      ].map((item) => itemKey(item.kind, item.label, item.detail, item.date)));
      for (const itemId of update.resolveItemIds) {
        if (itemsById.get(itemId) !== programId) throw new TypeError("university_tracker_item_unknown");
        activeItemCounts.set(programId, (activeItemCounts.get(programId) ?? 0) - 1);
        resolves.push(this.database.prepare(`UPDATE university_program_items
          SET item_key = substr(item_key, 1, 732) || ':resolved:' || item_id,
              status = 'resolved', resolved_at = ?1, updated_at = ?1
          WHERE principal_id = ?2 AND item_id = ?3 AND status = 'active'`).bind(nowIso, principalId, itemId));
      }
      const additions = [
        ...update.addRequirements.map((item) => ({
          kind: "requirement" as const, label: item.label, detail: item.detail, date: null,
          verification: item.verification,
        })),
        ...update.addDates.map((item) => ({
          kind: "date" as const, label: item.label, detail: null, date: item.date,
          verification: item.verification,
        })),
      ];
      for (const addition of additions) {
        const label = inline(addition.label, "university_item_invalid", 160);
        const detail = addition.detail === null ? null : inline(addition.detail, "university_item_invalid", 512);
        const dateValue = addition.date === null ? null : date(addition.date, "university_item_invalid");
        const dedupe = itemKey(addition.kind, label, detail, dateValue);
        if (knownKeys.has(dedupe)) continue;
        knownKeys.add(dedupe);
        const checkedItem = checkedVerification(addition.verification, nowIso);
        if (addition.kind === "date" && checkedItem.state === "verified" && dateValue === null) {
          throw new TypeError("university_item_invalid");
        }
        activeItemCounts.set(programId, (activeItemCounts.get(programId) ?? 0) + 1);
        inserts.push(this.database.prepare(`INSERT INTO university_program_items (
          principal_id, program_id, item_id, item_key, item_kind, item_label, item_detail,
          date_value, verification_state, source_url, admission_cycle, verified_at,
          source_turn_id, status, resolved_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'active', NULL, ?14, ?14)`)
          .bind(principalId, programId, newUlid(now), dedupe, addition.kind, label, detail, dateValue,
            checkedItem.state, checkedItem.sourceUrl, checkedItem.cycle, checkedItem.verifiedAt, turnId, nowIso));
      }
      if ((activeItemCounts.get(programId) ?? 0) > MAX_ITEMS_PER_PROGRAM) {
        throw new RangeError("university_tracker_item_limit_exceeded");
      }
    }

    const seenApplicationRefs = new Set<string>();
    const knownApplicationKeys = new Map(current.programs.map((program) => [
      program.programId,
      new Set(program.applicationItems.map((item) => applicationItemKey(item.kind, item.label))),
    ]));
    for (const programId of finalProgramIds) {
      if (!knownApplicationKeys.has(programId)) knownApplicationKeys.set(programId, new Set());
    }
    const applicationRetirementStatements: D1PreparedStatement[] = [];
    const applicationStatusStatements: D1PreparedStatement[] = [];
    const applicationInsertStatements: D1PreparedStatement[] = [];
    const responseApplicationIds = new Map<string, Ulid>();
    for (const update of input.plan.applicationUpdates ?? []) {
      if (seenApplicationRefs.has(update.itemRef)) {
        throw new TypeError("university_application_item_ref_duplicate");
      }
      seenApplicationRefs.add(update.itemRef);
      const programId = ULID.test(update.programRef)
        ? update.programRef as Ulid
        : responseProgramIds.get(update.programRef);
      if (programId === undefined || !finalProgramIds.has(programId)) {
        throw new TypeError("university_application_program_unknown");
      }
      let existingId = ULID.test(update.itemRef) ? update.itemRef as Ulid : null;
      let existingRecord = existingId === null ? undefined : applicationItemsById.get(existingId);
      if (existingId === null && !RESPONSE_LOCAL_APPLICATION_ITEM.test(update.itemRef)
        || existingId !== null && existingRecord === undefined
        || existingRecord !== undefined && existingRecord.programId !== programId) {
        throw new TypeError("university_application_item_ref_invalid");
      }
      if (existingRecord !== undefined && (update.kind !== null || update.label !== null)) {
        throw new TypeError("university_application_item_invalid");
      }
      const kind = update.kind ?? existingRecord?.item.kind;
      const label = update.label === null || update.label === undefined
        ? existingRecord?.item.label
        : inline(update.label, "university_application_item_invalid", 160);
      const status = update.status ?? existingRecord?.item.status;
      if (kind === undefined || !APPLICATION_KINDS.has(kind) || label === undefined
        || status === undefined || !APPLICATION_STATUSES.has(status)) {
        throw new TypeError("university_application_item_invalid");
      }
      const dedupe = applicationItemKey(kind, label);
      if (existingId === null && knownApplicationKeys.get(programId)?.has(dedupe)) {
        const duplicate = [...applicationItemsById.values()].find((candidate) =>
          candidate.programId === programId
          && applicationItemKey(candidate.item.kind, candidate.item.label) === dedupe);
        if (duplicate === undefined) throw new TypeError("university_application_item_exists");
        if (duplicate.item.status !== "not_needed_by_sid") {
          responseApplicationIds.set(update.itemRef, duplicate.item.itemId);
          continue;
        }
        const program = current.programs.find((candidate) => candidate.programId === programId);
        if (program === undefined || update.status === null || update.statusEvidence === null
          || !supportsStatus(
            update.status,
            update.statusEvidence,
            false,
            duplicate.item.status,
            duplicate.item.itemId,
            duplicate.item.label,
            duplicate.item.kind,
            program,
            current,
          )) throw new TypeError("university_application_item_exists");
        // The model can rediscover a retired row as response-local. Treat it as
        // the existing row only after the owner evidence passes reactivation.
        existingId = duplicate.item.itemId;
        existingRecord = duplicate;
      }
      if (existingId !== null && RESPONSE_LOCAL_APPLICATION_ITEM.test(update.itemRef)) {
        responseApplicationIds.set(update.itemRef, existingId);
      }
      if (update.status === null && update.statusEvidence !== null
        || update.status !== null && update.statusEvidence === null) {
        throw new TypeError("university_application_item_invalid");
      }
      if (update.statusEvidence !== null) {
        evidence(update.statusEvidence, "university_application_item_invalid", 512);
      }
      const currentVerification = existingRecord?.item.verification;
      const currentDueDate = existingRecord?.item.dueDate;
      let dueDate = currentDueDate ?? null;
      let dueVerification = currentVerification ?? null;
      if (update.dueDate !== null) {
        evidence(update.dueDate.evidence, "university_application_item_invalid", 512);
        dueDate = update.dueDate.date === null
          ? null
          : date(update.dueDate.date, "university_application_item_invalid");
        dueVerification = existingRecord !== undefined && dueDate === currentDueDate
          && update.dueDate.verification.state === currentVerification?.state
          && update.dueDate.verification.sourceUrl === currentVerification.sourceUrl
          && update.dueDate.verification.cycle === currentVerification.cycle
          ? currentVerification
          : checkedApplicationVerification(update.dueDate.verification, nowIso);
        if (dueVerification.state === "verified" && dueDate === null) {
          throw new TypeError("university_application_item_invalid");
        }
      }
      if (dueVerification?.state === "unverified") {
        dueVerification = Object.freeze({ state: "unverified", sourceUrl: null, cycle: null, verifiedAt: null });
      }
      if (dueVerification === null || existingId === null && update.dueDate === null
        || existingId === null && (update.status === null || update.statusEvidence === null)) {
        throw new TypeError("university_application_item_invalid");
      }
      if (existingRecord !== undefined
        && (existingRecord.item.status === "submitted_by_sid"
          || existingRecord.item.status === "not_needed_by_sid")
        && status !== existingRecord.item.status
        && existingRecord.item.sourceTurnId === turnId) {
        throw new TypeError("university_application_item_status_invalid");
      }
      const submittedAt = status === "submitted_by_sid"
        ? existingRecord?.item.status === "submitted_by_sid"
          ? existingRecord.item.submittedAt
          : nowIso
        : null;
      if (existingId === null) {
        knownApplicationKeys.get(programId)?.add(dedupe);
        applicationHistoryCounts.set(programId, (applicationHistoryCounts.get(programId) ?? 0) + 1);
        applicationHistoryCount += 1;
        if (status !== "not_needed_by_sid") {
          applicationItemCounts.set(programId, (applicationItemCounts.get(programId) ?? 0) + 1);
          applicationItemCount += 1;
        }
        const itemId = newUlid(now);
        responseApplicationIds.set(update.itemRef, itemId);
        applicationProgramById.set(itemId, programId);
        applicationInsertStatements.push(this.database.prepare(`INSERT INTO university_application_items (
          principal_id, program_id, item_id, item_key, item_kind, item_label, item_status,
          due_date, verification_state, source_url, admission_cycle, verified_at,
          source_turn_id, submitted_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`)
          .bind(principalId, programId, itemId, dedupe, kind, label, status,
            dueDate, dueVerification.state, dueVerification.sourceUrl, dueVerification.cycle,
            dueVerification.verifiedAt, turnId, submittedAt, nowIso));
      } else if (update.status !== null || update.dueDate !== null) {
        if (existingRecord?.item.status === "not_needed_by_sid" && status !== "not_needed_by_sid") {
          applicationItemCounts.set(programId, (applicationItemCounts.get(programId) ?? 0) + 1);
          applicationItemCount += 1;
        } else if (existingRecord?.item.status !== "not_needed_by_sid" && status === "not_needed_by_sid") {
          applicationItemCounts.set(programId, (applicationItemCounts.get(programId) ?? 0) - 1);
          applicationItemCount -= 1;
        }
        const statement = this.database.prepare(`UPDATE university_application_items
          SET item_status = ?1, due_date = ?2, verification_state = ?3, source_url = ?4,
              admission_cycle = ?5, verified_at = ?6, source_turn_id = ?7,
              submitted_at = ?8, updated_at = ?9
          WHERE principal_id = ?10 AND item_id = ?11`)
          .bind(status, dueDate, dueVerification.state, dueVerification.sourceUrl, dueVerification.cycle,
            dueVerification.verifiedAt, turnId, submittedAt, nowIso, principalId, existingId);
        if (existingRecord?.item.status !== "not_needed_by_sid" && status === "not_needed_by_sid") {
          applicationRetirementStatements.push(statement);
        } else {
          applicationStatusStatements.push(statement);
        }
      }
    }
    const workflowCounts = new Map(current.programs.map((program) => [
      program.programId, (program.workflowItems ?? []).length,
    ]));
    for (const programId of finalProgramIds) {
      if (!workflowCounts.has(programId)) workflowCounts.set(programId, 0);
    }
    let workflowCount = [...workflowCounts.values()].reduce((sum, count) => sum + count, 0);
    const knownWorkflowKeys = new Map(current.programs.map((program) => [
      program.programId,
      new Set((program.workflowItems ?? []).map((item) =>
        workflowItemKey(item.kind, item.label, item.owner, item.applicationItemId))),
    ]));
    for (const programId of finalProgramIds) {
      if (!knownWorkflowKeys.has(programId)) knownWorkflowKeys.set(programId, new Set());
    }
    const seenWorkflowRefs = new Set<string>();
    const workflowIdentityStatements: D1PreparedStatement[] = [];
    const workflowRevisionStatements: D1PreparedStatement[] = [];
    let preparedDetailsBytes = 0;
    for (const update of input.plan.workflowUpdates ?? []) {
      if (seenWorkflowRefs.has(update.workflowRef)) throw new TypeError("university_workflow_ref_duplicate");
      seenWorkflowRefs.add(update.workflowRef);
      if (update.executionBoundary !== "owner_only") throw new TypeError("university_workflow_item_invalid");
      const programId = ULID.test(update.programRef)
        ? update.programRef as Ulid
        : responseProgramIds.get(update.programRef);
      if (programId === undefined || !finalProgramIds.has(programId)) {
        throw new TypeError("university_workflow_program_unknown");
      }
      const isNew = RESPONSE_LOCAL_WORKFLOW_ITEM.test(update.workflowRef);
      const existingId = ULID.test(update.workflowRef) ? update.workflowRef as Ulid : null;
      const existingRecord = existingId === null ? undefined : workflowsById.get(existingId);
      if (isNew === (existingRecord !== undefined)
        || existingRecord !== undefined && existingRecord.programId !== programId
        || !isNew && existingRecord === undefined) {
        throw new TypeError("university_workflow_ref_invalid");
      }
      if (existingRecord !== undefined && (update.kind !== null || update.label !== null
        || update.owner !== null || update.applicationItemRef !== null)) {
        throw new TypeError("university_workflow_item_invalid");
      }
      const kind = update.kind ?? existingRecord?.item.kind;
      const label = update.label === null
        ? existingRecord?.item.label
        : inline(update.label, "university_workflow_item_invalid", 160);
      const owner = update.owner ?? existingRecord?.item.owner;
      const status = update.status ?? existingRecord?.item.status;
      if (kind === undefined || !WORKFLOW_KINDS.has(kind) || label === undefined || !isWorkflowLabelSafe(label)
        || owner === undefined || !WORKFLOW_OWNERS.has(owner)
        || status === undefined || !WORKFLOW_STATUSES.has(status)
        || !workflowStatusAllowed(kind, status)) {
        throw new TypeError("university_workflow_item_invalid");
      }
      // Offer-family rows carry no model-chosen name, and each revision needs
      // the explicit owner sentence re-checked below.
      if (isOfferWorkflowKind(kind) && (update.status === null
        || isNew && (label !== OFFER_WORKFLOW_LABELS[kind] || owner !== OFFER_WORKFLOW_OWNERS[kind])
        || update.preparedDetails !== null && update.status !== "prepared"
        || update.deadline !== null && (update.deadline.date !== null || update.deadline.instant !== null
          || update.deadline.verification.state !== "unverified"))) {
        throw new TypeError("university_workflow_item_invalid");
      }
      let applicationItemId = existingRecord?.item.applicationItemId ?? null;
      if (isNew && update.applicationItemRef !== null) {
        applicationItemId = ULID.test(update.applicationItemRef)
          ? update.applicationItemRef as Ulid
          : responseApplicationIds.get(update.applicationItemRef) ?? null;
      }
      if (kind.startsWith("offer") && applicationItemId !== null
        || !kind.startsWith("offer") && (applicationItemId === null
          || applicationProgramById.get(applicationItemId) !== programId)) {
        throw new TypeError("university_workflow_application_item_invalid");
      }
      if (update.status === null && update.statusEvidence !== null
        || update.status !== null && update.statusEvidence === null) {
        throw new TypeError("university_workflow_item_invalid");
      }
      if (update.statusEvidence !== null) {
        evidence(update.statusEvidence, "university_workflow_item_invalid", 512);
        const applicationUpdate = isNew && update.applicationItemRef !== null
          ? input.plan.applicationUpdates.find((candidate) => candidate.itemRef === update.applicationItemRef)
          : undefined;
        const applicationRecord = applicationItemId === null
          ? undefined
          : applicationItemsById.get(applicationItemId)?.item;
        const applicationLabel = applicationRecord?.label ?? applicationUpdate?.label ?? null;
        const applicationKind = applicationRecord?.kind ?? applicationUpdate?.kind ?? null;
        const program = current.programs.find((candidate) => candidate.programId === programId)
          ?? input.plan.programUpdates.find((candidate) => candidate.programRef === update.programRef);
        if (program === undefined || program.university === null || program.programName === null
          || !supportsWorkflowStatusEvidence(
            status,
            kind,
            update.statusEvidence,
            update.workflowRef,
            label,
            isNew ? update.applicationItemRef : applicationItemId,
            applicationLabel,
            applicationKind,
            { university: program.university, programName: program.programName },
            current,
          )) {
          throw new TypeError("university_workflow_item_invalid");
        }
      }
      let preparedDetails = existingRecord?.item.preparedDetails ?? null;
      if (update.preparedDetails !== null) {
        preparedDetails = asUnverifiedWorkflowDraft(
          evidence(update.preparedDetails, "university_workflow_item_invalid", 2_048),
          "university_workflow_item_invalid",
        );
        if (!isWorkflowPreparedDetailsSafe(preparedDetails)) throw new TypeError("university_workflow_item_invalid");
        preparedDetailsBytes += encoder.encode(preparedDetails).byteLength;
        if (preparedDetailsBytes > MAX_WORKFLOW_PREPARED_DETAILS_PER_PLAN_BYTES) {
          throw new RangeError("university_workflow_prepared_details_budget_exceeded");
        }
      }
      let dueDate = existingRecord?.item.deadline.date ?? null;
      let dueAt = existingRecord?.item.deadline.instant ?? null;
      let dueTimezone = existingRecord?.item.deadline.timeZone ?? null;
      let dueVerification = existingRecord?.item.deadline.verification ?? null;
      if (update.deadline !== null) {
        evidence(update.deadline.evidence, "university_workflow_item_invalid", 512);
        dueDate = update.deadline.date === null
          ? null
          : date(update.deadline.date, "university_workflow_item_invalid");
        dueAt = update.deadline.instant === null
          ? null
          : iso(update.deadline.instant, "university_workflow_item_invalid");
        dueTimezone = update.deadline.timeZone === null
          ? null
          : inline(update.deadline.timeZone, "university_workflow_item_invalid", 64);
        if (dueDate !== null && (dueAt !== null || dueTimezone !== null)
          || dueAt !== null && (dueTimezone === null || !validTimeZone(dueTimezone))
          || dueDate === null && dueAt === null && dueTimezone !== null) {
          throw new TypeError("university_workflow_item_invalid");
        }
        dueVerification = checkedApplicationVerification(update.deadline.verification, nowIso);
        if (dueVerification.state === "verified" && dueDate === null && dueAt === null) {
          throw new TypeError("university_workflow_item_invalid");
        }
      }
      if (dueVerification === null || isNew && update.deadline === null
        || isNew && (update.kind === null || update.label === null || update.owner === null
          || update.status === null || update.statusEvidence === null)
        || !isNew && update.status === null && update.preparedDetails === null && update.deadline === null) {
        throw new TypeError("university_workflow_item_invalid");
      }
      const dedupe = workflowItemKey(kind, label, owner, applicationItemId);
      let workflowId: Ulid;
      let revision: number;
      if (isNew) {
        if (knownWorkflowKeys.get(programId)?.has(dedupe)) throw new TypeError("university_workflow_item_exists");
        knownWorkflowKeys.get(programId)?.add(dedupe);
        workflowId = newUlid(now);
        revision = 1;
        workflowCount += 1;
        workflowCounts.set(programId, (workflowCounts.get(programId) ?? 0) + 1);
        workflowIdentityStatements.push(this.database.prepare(`INSERT INTO university_workflow_items (
          principal_id, program_id, application_item_id, workflow_id, workflow_key,
          workflow_kind, workflow_label, owner_role, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
          .bind(principalId, programId, applicationItemId, workflowId, dedupe,
            kind, label, owner, nowIso));
      } else {
        workflowId = existingId as Ulid;
        revision = (existingRecord?.item.revision ?? 64) + 1;
        if (revision > 64) throw new RangeError("university_workflow_revision_limit_exceeded");
      }
      workflowRevisionStatements.push(this.database.prepare(`INSERT INTO university_workflow_revisions (
        principal_id, workflow_id, event_id, revision_number, workflow_status,
        prepared_details, execution_boundary, due_date, due_at, due_timezone,
        verification_state, source_url, admission_cycle, verified_at, source_turn_id, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owner_only', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`)
        .bind(principalId, workflowId, newUlid(now), revision, status, preparedDetails,
          dueDate, dueAt, dueTimezone, dueVerification.state, dueVerification.sourceUrl,
          dueVerification.cycle, dueVerification.verifiedAt, turnId, nowIso));
    }
    if (finalProgramIds.size > MAX_PROGRAMS) throw new RangeError("university_tracker_program_limit_exceeded");
    if ([...activeItemCounts.values()].reduce((sum, count) => sum + count, 0) > MAX_ITEMS) {
      throw new RangeError("university_tracker_item_limit_exceeded");
    }
    if (applicationItemCount > MAX_APPLICATION_ITEMS
      || applicationHistoryCount > MAX_APPLICATION_HISTORY_ITEMS
      || [...applicationItemCounts.values()].some((count) => count > MAX_APPLICATION_ITEMS_PER_PROGRAM)
      || [...applicationHistoryCounts.values()].some((count) => count > MAX_APPLICATION_HISTORY_ITEMS_PER_PROGRAM)) {
      throw new RangeError("university_application_item_limit_exceeded");
    }
    if (workflowCount > MAX_WORKFLOW_ITEMS
      || [...workflowCounts.values()].some((count) => count > MAX_WORKFLOW_ITEMS_PER_PROGRAM)) {
      throw new RangeError("university_workflow_item_limit_exceeded");
    }
    statements.push(...resolves, ...inserts);
    // Retirements must release capacity before any same-plan insert reaches the
    // database trigger. The repository already validates the final counts.
    statements.push(...applicationRetirementStatements, ...applicationStatusStatements, ...applicationInsertStatements);
    statements.push(...workflowIdentityStatements, ...workflowRevisionStatements);
    statements.push(this.database.prepare(`INSERT INTO university_tracker_turn_receipts (
      principal_id, turn_id, response_hash, applied_at
    ) VALUES (?1, ?2, ?3, ?4)`).bind(principalId, turnId, input.responseHash, nowIso));
    if (statements.length > UNIVERSITY_PLAN_D1_STATEMENT_BUDGET) {
      throw new RangeError("university_tracker_statement_budget_exceeded");
    }
    await this.database.batch(statements);
  }
}

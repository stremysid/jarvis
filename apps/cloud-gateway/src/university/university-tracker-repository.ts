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
} from "./university-tracker-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RESPONSE_LOCAL_PROGRAM = /^new-[1-9][0-9]{0,2}$/u;
const RESPONSE_LOCAL_APPLICATION_ITEM = /^new-item-[1-9][0-9]{0,2}$/u;
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const MAX_PROGRAMS = 16;
const MAX_ITEMS_PER_PROGRAM = 32;
const MAX_ITEMS = 128;
const MAX_APPLICATION_ITEMS_PER_PROGRAM = 32;
const MAX_APPLICATION_ITEMS = 128;
const MAX_APPLICATION_HISTORY_ITEMS_PER_PROGRAM = 64;
const MAX_APPLICATION_HISTORY_ITEMS = 256;
const encoder = new TextEncoder();

const APPLICATION_KINDS = new Set<UniversityApplicationItemKind>([
  "supplementary_application", "essay", "personal_statement", "reference", "transcript", "scholarship",
]);
const APPLICATION_STATUSES = new Set<UniversityApplicationItemStatus>([
  "not_started", "drafting", "ready", "submitted_by_sid", "not_needed_by_sid",
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
  const normalized = parts.join(" | ").toLocaleLowerCase("en-CA").replace(/\s+/gu, " ");
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
): Omit<UniversityProgram, "requirements" | "dates" | "applicationItems"> {
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
    const programs = rows(programResult).slice(0, MAX_PROGRAMS).map((row) => programFromRow(row, principalId));
    const programIds = new Set(programs.map((program) => program.programId));
    const itemsByProgram = new Map<Ulid, UniversityTrackerItem[]>();
    const applicationItemsByProgram = new Map<Ulid, UniversityApplicationItem[]>();
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
    return Object.freeze({
      principalId,
      programs: Object.freeze(programs.map((program) => {
        const items = itemsByProgram.get(program.programId) ?? [];
        return Object.freeze({
          ...program,
          requirements: Object.freeze(items.filter((item) => item.kind === "requirement")),
          dates: Object.freeze(items.filter((item) => item.kind === "date")),
          applicationItems: Object.freeze(applicationItemsByProgram.get(program.programId) ?? []),
        });
      })),
    });
  }

  async listApplicationItemsByDueDate(
    principalIdValue: string,
    limit = 5,
  ): Promise<readonly UniversityApplicationDigestItem[]> {
    const principalId = principal(principalIdValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
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
      LIMIT ?2`).bind(principalId, limit).all<ApplicationDigestRow>();
    return Object.freeze(rows(result).map((row) => Object.freeze({
      ...applicationItemFromRow(row, principalId),
      university: inline(row.university_name, "university_application_digest_row_invalid", 160),
      programName: inline(row.program_name, "university_application_digest_row_invalid", 160),
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
        if (duplicate.item.status !== "not_needed_by_sid") continue;
        existingId = duplicate.item.itemId;
        existingRecord = duplicate;
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
    statements.push(...resolves, ...inserts);
    // Retirements must release capacity before any same-plan insert reaches the
    // database trigger. The repository already validates the final counts.
    statements.push(...applicationRetirementStatements, ...applicationStatusStatements, ...applicationInsertStatements);
    statements.push(this.database.prepare(`INSERT INTO university_tracker_turn_receipts (
      principal_id, turn_id, response_hash, applied_at
    ) VALUES (?1, ?2, ?3, ?4)`).bind(principalId, turnId, input.responseHash, nowIso));
    await this.database.batch(statements);
  }
}

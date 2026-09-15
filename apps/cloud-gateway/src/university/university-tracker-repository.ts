import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import type {
  ApplyOwnerUniversityPlanInput,
  OwnerUniversityVerification,
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
const UNSAFE_INLINE = /[\p{C}\r\n]/u;
const MAX_PROGRAMS = 16;
const MAX_ITEMS_PER_PROGRAM = 32;
const MAX_ITEMS = 128;
const encoder = new TextEncoder();

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

interface ReceiptRow {
  response_hash: string;
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

function verificationFromRow(value: ProgramRow | ItemRow, error: string): UniversityVerification {
  if (value.verification_state !== "verified" && value.verification_state !== "unverified") throw new TypeError(error);
  const url = sourceUrl(value.source_url, error);
  const cycle = optionalInline(value.admission_cycle, error, 64);
  const verifiedAt = value.verified_at === null ? null : iso(value.verified_at, error);
  if (value.verification_state === "verified" && (url === null || cycle === null || verifiedAt === null)
    || value.verification_state === "unverified" && verifiedAt !== null) throw new TypeError(error);
  return Object.freeze({ state: value.verification_state, sourceUrl: url, cycle, verifiedAt });
}

function programFromRow(value: ProgramRow, expectedPrincipal: string): Omit<UniversityProgram, "requirements" | "dates"> {
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

export class UniversityTrackerRepository {
  constructor(private readonly database: D1Database) {}

  async readSnapshot(principalIdValue: string): Promise<UniversityTrackerSnapshot> {
    const principalId = principal(principalIdValue);
    const [programResult, itemResult] = await Promise.all([
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
    ]);
    const programs = rows(programResult).slice(0, MAX_PROGRAMS).map((row) => programFromRow(row, principalId));
    const programIds = new Set(programs.map((program) => program.programId));
    const itemsByProgram = new Map<Ulid, UniversityTrackerItem[]>();
    for (const row of rows(itemResult).slice(0, MAX_ITEMS)) {
      if (!programIds.has(row.program_id as Ulid)) continue;
      const item = itemFromRow(row, principalId);
      const items = itemsByProgram.get(row.program_id as Ulid) ?? [];
      if (items.length < MAX_ITEMS_PER_PROGRAM) items.push(item);
      itemsByProgram.set(row.program_id as Ulid, items);
    }
    return Object.freeze({
      principalId,
      programs: Object.freeze(programs.map((program) => {
        const items = itemsByProgram.get(program.programId) ?? [];
        return Object.freeze({
          ...program,
          requirements: Object.freeze(items.filter((item) => item.kind === "requirement")),
          dates: Object.freeze(items.filter((item) => item.kind === "date")),
        });
      })),
    });
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

    const current = await this.readSnapshot(principalId);
    const programsById = new Map(current.programs.map((program) => [program.programId, program]));
    const itemsById = new Map(current.programs.flatMap((program) =>
      [...program.requirements, ...program.dates].map((item) => [item.itemId, program.programId] as const)));
    const activeItemCounts = new Map(current.programs.map((program) => [
      program.programId, program.requirements.length + program.dates.length,
    ]));
    const finalProgramIds = new Set(programsById.keys());
    const seenRefs = new Set<string>();
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
      } else {
        if (!programsById.has(existingId)) throw new TypeError("university_tracker_program_unknown");
        programId = existingId;
      }
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
    if (finalProgramIds.size > MAX_PROGRAMS) throw new RangeError("university_tracker_program_limit_exceeded");
    if ([...activeItemCounts.values()].reduce((sum, count) => sum + count, 0) > MAX_ITEMS) {
      throw new RangeError("university_tracker_item_limit_exceeded");
    }
    statements.push(...resolves, ...inserts);
    statements.push(this.database.prepare(`INSERT INTO university_tracker_turn_receipts (
      principal_id, turn_id, response_hash, applied_at
    ) VALUES (?1, ?2, ?3, ?4)`).bind(principalId, turnId, input.responseHash, nowIso));
    await this.database.batch(statements);
  }
}

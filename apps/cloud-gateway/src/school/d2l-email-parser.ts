import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";

export type D2lEmailEventKind =
  | "assignment_due"
  | "assignment_updated"
  | "feedback_released"
  | "grade_released"
  | "new_content"
  | "announcement"
  | "address_verification"
  | "unrecognised";

interface IdentifiedSchoolItem {
  readonly course: string;
  readonly title: string;
  readonly externalId: string;
}

export type ParsedD2lEmailEvent =
  | Readonly<IdentifiedSchoolItem & {
      kind: "assignment_due" | "assignment_updated";
      dueAt: string;
      dueTimeSupplied: boolean;
    }>
  | Readonly<IdentifiedSchoolItem & {
      kind: "grade_released";
      assignedGrade: number;
      maxPoints: number | null;
    }>
  | Readonly<IdentifiedSchoolItem & {
      kind: "feedback_released" | "new_content" | "announcement";
    }>
  | Readonly<{
      kind: "address_verification";
      verificationUrl: string | null;
      verificationCode: string | null;
    }>
  | Readonly<{ kind: "unrecognised"; reason: string }>;

export interface D2lEmailParseInput {
  readonly subject: string | undefined;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly timeZone: string;
}

const MAXIMUM_BODY_CHARACTERS = 200_000;
const MAXIMUM_INLINE_CHARACTERS = 512;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
const WHITESPACE = /\s+/gu;
const FORWARDED_BOUNDARY = /^(?:-{2,}\s*(?:original|forwarded) message\s*-{2,}|on .{0,200} wrote:)$/iu;
const MONTHS = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9], ["oct", 10],
  ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|amp|lt|gt|quot|apos|nbsp);/giu, (entity, decimal, hex) => {
    if (typeof decimal === "string" && decimal.length > 0) {
      const point = Number(decimal);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    }
    if (typeof hex === "string" && hex.length > 0) {
      const point = Number.parseInt(hex, 16);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    }
    const named = entity.toLowerCase();
    if (named === "&amp;") return "&";
    if (named === "&lt;") return "<";
    if (named === "&gt;") return ">";
    if (named === "&quot;") return "\"";
    if (named === "&apos;") return "'";
    return " ";
  });
}

function htmlText(value: string): string {
  return decodeHtmlEntities(value
    .slice(0, MAXIMUM_BODY_CHARACTERS)
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])\s*>/giu, "\n")
    .replace(/<\/(?:td|th)\s*>/giu, " ")
    .replace(/<[^>]{0,4096}>/gu, " "));
}

function visibleBody(input: D2lEmailParseInput): string {
  const source = input.text !== undefined && input.text.trim().length > 0
    ? input.text.slice(0, MAXIMUM_BODY_CHARACTERS)
    : htmlText(input.html ?? "");
  const kept: string[] = [];
  for (const rawLine of source.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = rawLine.trim();
    if (FORWARDED_BOUNDARY.test(line)) break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function inline(value: string): string | null {
  const normalized = value.normalize("NFC").replace(CONTROL_OR_FORMAT, " ").replace(WHITESPACE, " ").trim();
  if (normalized.length === 0 || !normalized.isWellFormed()) return null;
  const bounded = normalized.slice(0, MAXIMUM_INLINE_CHARACTERS);
  return bounded.isWellFormed() ? bounded : bounded.slice(0, -1);
}

function labelled(body: string, labels: readonly string[]): string | null {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const pattern = new RegExp(`^(?:${escaped})\\s*:\\s*(.+)$`, "imu");
  const match = pattern.exec(body);
  return match === null ? null : inline(match[1] ?? "");
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  created.format(0);
  formatterCache.set(timeZone, created);
  return created;
}

function formattedWall(instant: number, selected: Intl.DateTimeFormat): Omit<WallTime, "millisecond"> {
  const parts = selected.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"), month: value("month"), day: value("day"),
    hour: value("hour"), minute: value("minute"), second: value("second"),
  };
}

function wallInstant(wall: WallTime, timeZone: string): string | null {
  const selected = formatter(timeZone);
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  const possibleOffsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = naive + delta * 3_600_000;
    const seen = formattedWall(probe, selected);
    possibleOffsets.add(Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - probe);
  }
  const matches = [...possibleOffsets].map((offset) => naive - offset).filter((candidate) => {
    const seen = formattedWall(candidate, selected);
    return seen.year === wall.year && seen.month === wall.month && seen.day === wall.day
      && seen.hour === wall.hour && seen.minute === wall.minute && seen.second === wall.second;
  }).sort((left, right) => left - right);
  // A repeated fall-back wall time names two instants. Picking either would
  // manufacture precision the notification did not contain.
  return matches.length === 1 ? new Date(matches[0]!).toISOString() : null;
}

function validWall(wall: WallTime): boolean {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  return wall.year >= 2000 && wall.year <= 2100
    && date.getUTCFullYear() === wall.year
    && date.getUTCMonth() + 1 === wall.month
    && date.getUTCDate() === wall.day
    && wall.hour >= 0 && wall.hour <= 23
    && wall.minute >= 0 && wall.minute <= 59;
}

function dueInstant(value: string, timeZone: string): { readonly dueAt: string; readonly dueTimeSupplied: boolean } | null {
  const trimmed = value.trim();
  const explicit = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(trimmed);
  if (explicit !== null) {
    const wall = {
      year: Number(explicit[1]), month: Number(explicit[2]), day: Number(explicit[3]),
      hour: Number(explicit[4]), minute: Number(explicit[5]), second: Number(explicit[6] ?? 0),
      millisecond: Number((explicit[7] ?? "0").padEnd(3, "0")),
    };
    if (!validWall(wall) || wall.second > 59) return null;
    if (explicit[8] !== "Z" && (Number(explicit[9]) > 23 || Number(explicit[10]) > 59)) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : { dueAt: parsed.toISOString(), dueTimeSupplied: true };
  }
  const isoLocal = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*([ap]m))?)?(?:\s+(?:ET|EST|EDT))?$/iu.exec(trimmed);
  const words = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:[ ,]+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?)?(?:\s+(?:ET|EST|EDT))?$/iu.exec(trimmed);
  let wall: WallTime;
  let supplied = false;
  if (isoLocal !== null) {
    supplied = isoLocal[4] !== undefined;
    const rawHour = Number(isoLocal[4] ?? 23);
    const marker = isoLocal[6]?.toLowerCase();
    if (marker !== undefined && (rawHour < 1 || rawHour > 12)) return null;
    let hour = rawHour;
    if (marker === "pm" && hour < 12) hour += 12;
    if (marker === "am" && hour === 12) hour = 0;
    wall = {
      year: Number(isoLocal[1]), month: Number(isoLocal[2]), day: Number(isoLocal[3]),
      hour, minute: Number(isoLocal[5] ?? 59), second: supplied ? 0 : 59, millisecond: supplied ? 0 : 999,
    };
  } else if (words !== null) {
    const month = MONTHS.get((words[1] ?? "").toLowerCase());
    if (month === undefined) return null;
    supplied = words[4] !== undefined;
    const rawHour = Number(words[4] ?? 23);
    const marker = words[6]?.toLowerCase();
    if (marker !== undefined && (rawHour < 1 || rawHour > 12)) return null;
    let hour = rawHour;
    if (marker === "pm" && hour < 12) hour += 12;
    if (marker === "am" && hour === 12) hour = 0;
    wall = {
      year: Number(words[3]), month, day: Number(words[2]), hour,
      minute: Number(words[5] ?? 59), second: supplied ? 0 : 59, millisecond: supplied ? 0 : 999,
    };
  } else {
    return null;
  }
  if (!validWall(wall)) return null;
  const dueAt = wallInstant(wall, timeZone);
  return dueAt === null ? null : { dueAt, dueTimeSupplied: supplied };
}

function safeVerificationUrl(value: string): string | null {
  const candidate = decodeHtmlEntities(value).replace(/[).,;]+$/u, "");
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function verificationUrl(input: D2lEmailParseInput, body: string): string | null {
  const html = input.html?.slice(0, MAXIMUM_BODY_CHARACTERS) ?? "";
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["'](https:\/\/[^"']{1,2048})["'][^>]*>([\s\S]{0,4096}?)<\/a>/giu)) {
    const label = htmlText(match[2] ?? "");
    const candidate = match[1] ?? "";
    if (!/(?:verify|confirm)/iu.test(`${label} ${candidate}`)) continue;
    const safe = safeVerificationUrl(candidate);
    if (safe !== null) return safe;
  }
  for (const match of body.matchAll(/https:\/\/[^\s<>"']{1,2048}/giu)) {
    const safe = safeVerificationUrl(match[0]);
    if (safe !== null) return safe;
  }
  return null;
}

function verificationCode(body: string): string | null {
  const match = /^(?:verification\s+)?code\s*:\s*([A-Za-z0-9][A-Za-z0-9-]{3,63})\s*$/imu.exec(body);
  return match === null ? null : match[1] ?? null;
}

async function itemIdentity(body: string, course: string, title: string): Promise<string> {
  const supplied = labelled(body, ["Assignment ID", "Activity ID", "Content ID", "Item ID"]);
  if (supplied !== null && supplied.length <= 220) return `d2l:${supplied}`;
  return `d2l:${await sha256Hex(canonicalJson({ course: course.toLowerCase(), title: title.toLowerCase() }))}`;
}

function unrecognised(reason: string): ParsedD2lEmailEvent {
  return Object.freeze({ kind: "unrecognised" as const, reason });
}

/**
 * Reduce one MIME message to fixed school event fields.
 *
 * Only labelled fields in the newest visible section carry authority. Quoted
 * replies and forwarded chains are excluded, and every other sentence stays
 * inert text. This function has no model or command path.
 */
export async function parseD2lEmail(input: D2lEmailParseInput): Promise<ParsedD2lEmailEvent> {
  const body = visibleBody(input);
  const subject = inline(input.subject ?? "") ?? "";
  const signal = `${subject}\n${body}`;

  if (/(?:verify|confirm).{0,40}(?:email|address)|(?:email|address).{0,40}verification/iu.test(signal)) {
    const url = verificationUrl(input, body);
    const code = verificationCode(body);
    return url === null && code === null
      ? unrecognised("verification_value_missing")
      : Object.freeze({ kind: "address_verification" as const, verificationUrl: url, verificationCode: code });
  }

  const course = labelled(body, ["Course", "Class"]);
  const title = labelled(body, ["Assignment", "Activity", "Content", "Item", "Title"]);
  if (course === null || title === null) return unrecognised("school_item_fields_missing");
  const externalId = await itemIdentity(body, course, title);

  const gradeMatch = /^(?:grade|score|mark)\s*:\s*(\d{1,9}(?:\.\d{1,6})?)\s*(?:(\/|out\s+of)\s*(\d{1,9}(?:\.\d{1,6})?)|(%))?\s*$/imu.exec(body);
  if (/(?:grade|graded|score|mark)(?:\s+(?:released|available|posted))?/iu.test(subject) || gradeMatch !== null) {
    const match = gradeMatch;
    if (match === null) {
      return /feedback/iu.test(signal)
        ? Object.freeze({ kind: "feedback_released" as const, course, title, externalId })
        : unrecognised("grade_value_missing");
    }
    const assignedGrade = Number(match[1]);
    const maxPoints = match[4] === "%" ? 100 : match[3] === undefined ? null : Number(match[3]);
    if (!Number.isFinite(assignedGrade) || assignedGrade < 0 || (maxPoints !== null && (
      !Number.isFinite(maxPoints) || maxPoints <= 0 || assignedGrade > maxPoints
    ))) return unrecognised("grade_value_invalid");
    return Object.freeze({ kind: "grade_released" as const, course, title, externalId, assignedGrade, maxPoints });
  }

  if (/feedback(?:\s+(?:released|available|posted))?/iu.test(signal)) {
    return Object.freeze({ kind: "feedback_released" as const, course, title, externalId });
  }
  if (/announcement/iu.test(signal)) {
    return Object.freeze({ kind: "announcement" as const, course, title, externalId });
  }
  if (/(?:new\s+content|content\s+(?:added|available|updated|posted))/iu.test(signal)) {
    return Object.freeze({ kind: "new_content" as const, course, title, externalId });
  }
  if (/(?:assignment|activity).{0,80}(?:due|deadline)|due\s+(?:date|soon)|deadline/iu.test(signal)) {
    const rawDue = labelled(body, ["Due", "Due Date", "Deadline"]);
    if (rawDue === null) return unrecognised("due_date_missing");
    const due = dueInstant(rawDue, input.timeZone);
    if (due === null) return unrecognised("due_date_invalid");
    const kind = /(?:updated|changed|revised|moved).{0,80}(?:due|deadline)|(?:due|deadline).{0,80}(?:updated|changed|revised|moved)/iu.test(signal)
      ? "assignment_updated" as const
      : "assignment_due" as const;
    return Object.freeze({ kind, course, title, externalId, ...due });
  }
  return unrecognised("template_unknown");
}

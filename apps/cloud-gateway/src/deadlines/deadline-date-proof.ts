import { wordBoundaryOccurrence } from "../agent/owner-agent-core.js";

export class DeadlineProofError extends Error {
  constructor(readonly reason: string, readonly detail: string) { super(reason); }
}

const DAY = 86_400_000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH = "(?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)";
const WEEKDAY = "(?:Sunday|Sun|Monday|Mon|Tuesday|Tue|Wednesday|Wed|Thursday|Thu|Friday|Fri|Saturday|Sat)";
const DATE = `(?:\\d{4}-\\d{2}-\\d{2}|${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+\\d{4})?|(?:next\\s+week(?:\\s+(?:on\\s+)?${WEEKDAY})?)|(?:(?:next|this)\\s+)?${WEEKDAY}|today|tomorrow|(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th))`;
const CLOCK = "(?:\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?|\\d{1,2}:\\d{2})";
// The whole phrase must be one due expression. Searching the surrounding
// message independently for a date and a clock combines different assignments.
const DUE_PHRASE = new RegExp(`^(${DATE})(?:(?:\\s+(?:at\\s+)?|T)(${CLOCK}))?$`, "iu");

function reject(reason: string, detail: string): never { throw new DeadlineProofError(reason, detail); }

function dateKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return reject("deadline_ambiguous_date", "That calendar date does not exist; ask for the intended date.");
  }
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function wallParts(instant: Date, zone: string): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function validZone(zone: string): void {
  try {
    if (!/^[A-Za-z]/u.test(zone)) throw new Error();
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(0));
  } catch { reject("deadline_zone_mismatch", "Use the owner's configured IANA zone unless the due excerpt names another IANA zone."); }
}

/** Both sides of a DST transition are candidates, so a repeated hour is not guessed. */
function wallCandidates(date: string, hour: number, minute: number, zone: string): number[] {
  const wall = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const offsets = new Set([-DAY, 0, DAY].map((delta) => {
    const sample = wall + delta;
    const parts = wallParts(new Date(sample), zone);
    return Date.parse(`${parts.date}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:00Z`) - sample;
  }));
  return [...offsets].map((offset) => wall - offset).filter((candidate) => {
    const parts = wallParts(new Date(candidate), zone);
    return parts.date === date && parts.hour === hour && parts.minute === minute;
  });
}

function resolveDate(raw: string, anchor: string): { date: string; bound: boolean } {
  const phrase = raw.toLowerCase().replace(/\./gu, "").replace(/\s+/gu, " ");
  const [year, month, day] = anchor.split("-").map(Number) as [number, number, number];
  const weekday = new Date(`${anchor}T00:00:00Z`).getUTCDay();
  const monday = addDays(anchor, -((weekday + 6) % 7));
  if (phrase === "today" || phrase === "tomorrow") return { date: addDays(anchor, phrase === "tomorrow" ? 1 : 0), bound: false };
  const week = /^next week(?: (?:on )?(\w+))?$/u.exec(phrase);
  if (week !== null) {
    const index = week[1] === undefined ? 6 : (WEEKDAYS.findIndex((name) => name.startsWith(week[1]!)) + 6) % 7;
    return { date: addDays(monday, 7 + index), bound: week[1] === undefined };
  }
  const namedDay = /^(?:(next|this) )?(\w+)$/u.exec(phrase);
  const index = WEEKDAYS.findIndex((name) => name.startsWith(namedDay?.[2] ?? "!"));
  if (index >= 0) return { date: namedDay?.[1] === "next" ? addDays(monday, 7 + (index + 6) % 7)
    : namedDay?.[1] === "this" ? addDays(monday, (index + 6) % 7) : addDays(anchor, (index - weekday + 7) % 7), bound: false };
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(phrase);
  if (iso !== null) return { date: dateKey(Number(iso[1]), Number(iso[2]), Number(iso[3])), bound: false };
  const ordinal = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)$/u.exec(phrase);
  if (ordinal !== null) {
    const requested = Number(ordinal[1]);
    // The next occurrence is a stated interpretation, including across a short month.
    for (let offset = 0; offset < 12; offset += 1) {
      const candidate = new Date(Date.UTC(year, month - 1 + offset, requested));
      if (candidate.getUTCDate() === requested && candidate.toISOString().slice(0, 10) >= anchor) {
        return { date: candidate.toISOString().slice(0, 10), bound: false };
      }
    }
  }
  const forward = /^(\w+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/u.exec(phrase);
  const reverse = /^(\d{1,2})(?:st|nd|rd|th)? (\w+)(?:,? (\d{4}))?$/u.exec(phrase);
  const monthName = forward?.[1] ?? reverse?.[2];
  if (monthName !== undefined) {
    const dueMonth = MONTHS.findIndex((name) => name.startsWith(monthName)) + 1;
    const dueDay = Number(forward?.[2] ?? reverse?.[1]);
    const explicitYear = forward?.[3] ?? reverse?.[3];
    const resolvedYear = explicitYear === undefined
      ? year + (dueMonth < month || dueMonth === month && dueDay < day ? 1 : 0) : Number(explicitYear);
    return { date: dateKey(resolvedYear, dueMonth, dueDay), bound: false };
  }
  return reject("deadline_ambiguous_date", "The date is not one uniquely supported by this due phrase; ask which date.");
}

export interface DeadlineDateProof {
  readonly dueAt: string;
  readonly dateOnly: boolean;
  readonly note: string;
}

export function proveDeadlineDue(input: {
  dueAt: string; timeZone?: string; ownerZone: string; messageAt: string; dueExcerpt: string;
}): DeadlineDateProof {
  validZone(input.ownerZone);
  const zone = input.timeZone ?? input.ownerZone;
  validZone(zone);
  if (zone !== input.ownerZone && wordBoundaryOccurrence(input.dueExcerpt, zone) < 0) {
    return reject("deadline_zone_mismatch", "The owner did not name that zone; resolve the due time in the configured owner zone.");
  }
  const messageAt = new Date(input.messageAt);
  if (!Number.isFinite(messageAt.getTime())) return reject("deadline_message_time_missing", "The durable message timestamp is unavailable.");
  let phrase = input.dueExcerpt.trim();
  if (phrase.endsWith(zone)) phrase = phrase.slice(0, -zone.length).trim();
  if (phrase.length === 0) return reject("deadline_missing_date", "There is no date in the due excerpt; ask for the due date.");
  const parsed = DUE_PHRASE.exec(phrase);
  if (parsed === null) return reject("deadline_ambiguous_date", "Copy one short due phrase containing its date and clock together, without another assignment or sentence.");
  const resolved = resolveDate(parsed[1]!, wallParts(messageAt, input.ownerZone).date);
  const clock = parsed[2]?.toLowerCase().replace(/[.\s]/gu, "");
  let candidates: number[] = [];
  let note = resolved.bound ? "unconfirmed date-only bound: end of next week; the exact day was not stated"
    : "date-only: no clock time was stated";
  if (clock !== undefined && !resolved.bound) {
    const match = /^(\d{1,2})(?::(\d{2}))?([ap]m)?$/u.exec(clock)!;
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? "0");
    if (minute > 59 || (match[3] === undefined ? hour > 23 : hour < 1 || hour > 12)) {
      return reject("deadline_invalid_time", "The clock time is invalid; ask for the intended time.");
    }
    if (match[3] !== undefined) hour = hour % 12 + (match[3] === "pm" ? 12 : 0);
    if (match[3] === undefined && match[1]!.length === 1) {
      note = "date-only: the clock was ambiguous without am/pm";
    } else {
      candidates = wallCandidates(resolved.date, hour, minute, zone);
      if (candidates.length !== 1) note = "date-only: the clock falls in a repeated or nonexistent local hour";
    }
  }
  const dateOnly = candidates.length !== 1 || resolved.bound;
  if (dateOnly) {
    const ends = wallCandidates(resolved.date, 23, 59, input.ownerZone);
    if (ends.length !== 1) return reject("deadline_ambiguous_date", "That local day has no unique end; ask for a full date and zone.");
    const dueAt = new Date(ends[0]! + 59_999).toISOString();
    if (input.dueAt !== resolved.date && input.dueAt !== dueAt) {
      return reject(clock === undefined ? "deadline_missing_time" : "deadline_ambiguous_date",
        `Only a date-only value is proved. Retry with dueAt ${resolved.date}; the receipt will label the end-of-day bound.`);
    }
    return { dueAt, dateOnly, note };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/u.test(input.dueAt)) {
    return reject("deadline_invalid_time", "Supply the resolved instant with an explicit UTC offset.");
  }
  if (Date.parse(input.dueAt) !== candidates[0]) {
    return reject("deadline_resolved_date_mismatch", "The proposed instant does not match this due phrase in the stated zone at the message timestamp; resolve it again.");
  }
  return { dueAt: new Date(candidates[0]!).toISOString(), dateOnly: false, note: "" };
}

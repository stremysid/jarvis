/**
 * The deadline store's vocabulary: a source, a deadline, the revisions of a
 * deadline, a quiet window, and the shape a source hands to ingestion.
 *
 * Two sources feed this -- the Google Classroom API and Brightspace's private
 * calendar-subscription feed -- and the plan is explicit that both are
 * load-bearing, because coverage is split by teacher rather than by course.
 * Once ingested they are the same thing: what the source states about an
 * assignment. A source may state no due date at all, and that is stored as
 * `null` rather than filled in; nothing here invents, defaults or infers one.
 * Nothing below this line asks where a deadline came from, which makes a third
 * source cost nothing but an adapter.
 *
 * There is deliberately no effort category and no warning lead here. Whether
 * and when Sid is warned is Jarvis's decision through the reminder tools, not a
 * column's.
 *
 * Everything that arrives from a source is untrusted text. A coursework title
 * is written by a teacher into a system we do not control, and a provider
 * response is whatever text the vendor served that morning. This subsystem
 * extracts structured data from it and never treats it as an instruction: a title is
 * stored as opaque text, bound into SQL as a parameter, and never read to decide
 * what the work is.
 */

/** Mirrors the `kind` CHECK on `deadline_sources`. */
export type DeadlineSourceKind = "classroom" | "brightspace" | "manual";

/** Mirrors the `status` CHECK on `deadlines`. */
export type DeadlineStatus = "open" | "submitted" | "missed" | "cancelled";

/** Mirrors the `reason` CHECK on `quiet_windows`. */
export type QuietWindowReason = "exam" | "manual";

export const DEADLINE_SOURCE_KINDS: readonly DeadlineSourceKind[] = Object.freeze([
  "classroom", "brightspace", "manual",
]);

export const DEADLINE_STATUSES: readonly DeadlineStatus[] = Object.freeze([
  "open", "submitted", "missed", "cancelled",
]);

/**
 * Every instant crossing this subsystem is the exact output of
 * `Date#toISOString`: UTC, milliseconds, trailing `Z`.
 *
 * The schema stores instants as TEXT and the indexes order them as text, so
 * lexical order is chronological order for exactly this one format and for no
 * other. `2026-09-15T09:00:00Z` and `2026-09-15T05:00:00-04:00` name the same
 * moment and sort nowhere near each other, so a single non-canonical instant
 * reaching the table would put a deadline in the wrong place in every range
 * query and never raise an error while doing it.
 */
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The canonical text form of an instant, and the only way one is produced here. */
export function toInstant(value: Date): string {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds)) throw new TypeError("deadline_instant_invalid");
  return value.toISOString();
}

/** Narrows unknown input to the canonical instant form, or refuses it. */
export function requireInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value)) throw new TypeError(`${label}_invalid`);
  // A syntactically canonical string can still be a date that does not exist:
  // `2026-02-30T00:00:00.000Z` matches the pattern and Date rolls it forward
  // to March, so the round trip is what actually settles it.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new TypeError(`${label}_invalid`);
  return value;
}

/**
 * Accepts either form and returns the canonical text.
 *
 * A `Date` handed in from a caller is copied rather than retained: the caller
 * still holds a mutable object, and a `setTime` after the fact must not be
 * able to change what we decided.
 */
export function instantOf(value: Date | string, label: string): string {
  return value instanceof Date ? toInstant(new Date(value.getTime())) : requireInstant(value, label);
}

const encoder = new TextEncoder();

/**
 * Text that is safe to store: present, well-formed, normalized, and bounded.
 *
 * `isWellFormed` matters more than it looks. A scraper that slices a title in
 * the middle of a surrogate pair produces a lone surrogate, which survives
 * every JavaScript operation and then fails at the storage boundary with an
 * error that points at the database rather than at the scraper.
 */
export function requireText(value: unknown, label: string, maximumCharacters: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumCharacters
    || !value.isWellFormed()
    || value !== value.normalize("NFC")
    || encoder.encode(value).byteLength > maximumCharacters * 4
  ) {
    throw new TypeError(`${label}_invalid`);
  }
  return value;
}

export function requireStatus(value: unknown): DeadlineStatus {
  if (typeof value !== "string" || !DEADLINE_STATUSES.includes(value as DeadlineStatus)) {
    throw new TypeError("deadline_status_invalid");
  }
  return value as DeadlineStatus;
}

/** A source of deadlines, as stored. */
export interface DeadlineSource {
  readonly sourceId: string;
  readonly kind: DeadlineSourceKind;
  readonly label: string;
  readonly active: boolean;
  readonly lastSuccessAt: string | null;
  /**
   * The last health gap, kept until an ordinary success. A source that has
   * been failing or returning a bounded partial result reads downstream as
   * "nothing due" without this pair, which is the failure the plan names.
   */
  readonly lastFailure: string | null;
  readonly lastFailureAt: string | null;
  readonly createdAt: string;
}

/** A deadline, as stored. `dueAt` is null when the source states no due date. */
export interface Deadline {
  readonly deadlineId: string;
  readonly sourceId: string;
  /** The id the source uses. With the source it is what makes a re-scrape an update rather than a duplicate. */
  readonly externalId: string;
  readonly course: string;
  readonly title: string;
  /** Null means the assignment has no stated due date. Code never fills this in. */
  readonly dueAt: string | null;
  readonly status: DeadlineStatus;
  /** Lowercase hex SHA-256 over the fields the source controls. See `deadlineContentHash`. */
  readonly contentHash: string;
  readonly firstSeenAt: string;
  /**
   * The last sweep that saw this deadline. It is the whole of the answer to
   * "did this disappear, or did the scrape break", so it is never advanced by
   * anything but an actual sighting.
   */
  readonly lastSeenAt: string;
}

/** One bounded open deadline with enough source health to label a study signal. */
export interface StudyDeadlineCandidate {
  readonly deadline: Deadline;
  readonly sourceKind: DeadlineSourceKind;
  readonly sourceLastSuccessAt: string | null;
  readonly sourceLastFailure: string | null;
}

/** One version of a deadline as it was seen. Append-only; the table refuses UPDATE and DELETE. */
export interface DeadlineRevision {
  readonly revisionId: string;
  readonly deadlineId: string;
  readonly contentHash: string;
  readonly dueAt: string | null;
  readonly title: string;
  readonly observedAt: string;
}

/** A window in which non-urgent traffic is held. */
export interface QuietWindow {
  readonly windowId: string;
  readonly reason: QuietWindowReason;
  /** Present exactly when the reason is `exam`; the schema's CHECK enforces the same pairing. */
  readonly deadlineId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
}

/**
 * What a source hands to ingestion. The Brightspace adapter reduces the
 * private iCalendar response to this shape before storage. It carries no feed
 * URL, response body, HTML, cookie, or browser session across the boundary.
 */
export interface RawDeadlineItem {
  readonly externalId: string;
  readonly course: string;
  readonly title: string;
  /** Null when the source states no due date. Ingestion stores it as null. */
  readonly dueAt: string | null;
}

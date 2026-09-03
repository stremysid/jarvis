import {
  documentAt,
  isExcerptAtCap,
  type ProjectStatus,
} from "./project-types.js";

/**
 * The stalled-project detector.
 *
 * A repository with no commit for longer than its configured threshold, while
 * carrying an approaching deadline in NEXT_STEPS.md, escalates now rather than
 * waiting for a weekly retro to surface it. The threshold alone is not the
 * alarm -- plenty of projects sit still on purpose -- so the deadline is what
 * turns "quiet" into "late".
 *
 * That makes the deadline reading the load-bearing part, and it is read out of
 * untrusted text: NEXT_STEPS.md is a file anyone with push access can write.
 * Nothing found in it is executed, followed, or passed to a model as an
 * instruction. This file runs regular expressions over it and reports dates.
 * The excerpt is data about a project; it is never a directive to Jarvis.
 *
 * The parser is deliberately narrow, and -- just as deliberately -- says so
 * when it refuses. An unparseable date reported as "no deadline" would turn
 * the detector into a thing that reports nothing: the projects most likely to
 * be late are the ones whose plans are written in prose. So date-shaped text
 * the parser will not interpret is reported as unreadable, and a stale project
 * with unreadable dates escalates. Over-reporting is the safe direction here;
 * under-reporting is the failure this detector exists to prevent.
 */

const DAY_MS = 86_400_000;

/** A deadline this far away or nearer counts as approaching. */
const DEFAULT_APPROACHING_WITHIN_DAYS = 14;

/** Enough for the owner to see what confused the parser, short enough not to paste a document into a digest. */
const MAX_SAMPLES = 5;
const MAX_SAMPLE_CHARACTERS = 60;
const MAX_REPORTED_DATES = 10;

/**
 * The one format this parses: a four-digit year, a two-digit month and a
 * two-digit day, separated by hyphens, that names a real calendar day.
 *
 * The lookarounds keep it from reading a fragment of something longer.
 * Without the trailing one, `2026-09-101` would yield `2026-09-10`; without
 * the leading one, the tail of a longer numeric string would parse as a date.
 * A time may follow (`2026-09-10T09:00:00Z`) and is ignored -- see
 * `deadlineInstant` for why the day, not the time, is what is compared.
 */
const ISO_DATE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/gu;

/**
 * Text that looks like a date or a deadline and that this parser refuses.
 *
 * Each of these is refused for a reason that cannot be fixed by trying harder:
 *
 *  - `03/04/2026` and `04.03.2026` are March 4th in one country and April 3rd
 *    in another. There is nothing in the document that says which, and a
 *    detector that guessed would be wrong for half its inputs by a month.
 *  - `03-04-26` has the same ambiguity plus a two-digit year.
 *  - `Sep 15`, `March 4th` are unambiguous to a reader and locale-shaped to a
 *    parser -- abbreviations, spellings, and a missing year that only the
 *    surrounding prose supplies.
 *  - `next Friday`, `end of month`, `EOW`, `in two weeks` need a reference
 *    date and a timezone. The reference is "when it was written", which is not
 *    recorded anywhere we can see.
 *  - `Q3 2026` and `2026-W14` name a range, not a day, and which end of the
 *    range is the deadline is a convention, not a fact.
 *
 * These patterns cost false positives: a NEXT_STEPS.md that says "this week we
 * shipped the poller" reads as an unresolved deadline. That is accepted. The
 * consequence of a false positive is one extra line in a digest about a
 * project that has not been committed to in over a week; the consequence of a
 * false negative is the thing this detector was built to catch going
 * unmentioned.
 */
const REFUSED_DATE_SHAPES: readonly RegExp[] = Object.freeze([
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gu,
  // A bare month and year. The lookarounds keep it from reporting the tail of
  // a full slash date a second time under a different shape.
  /(?<![\d/])\d{1,2}\/(?:19|20)\d{2}(?![\d/])/gu,
  /\b\d{1,2}\.\d{1,2}\.\d{4}\b/gu,
  /(?<![\d-])\d{1,2}-\d{1,2}-\d{2,4}(?![\d-])/gu,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/giu,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/giu,
  /\b(?:eod|eow|eom|eoq)\b/giu,
  /\b(?:next|this|end\s+of(?:\s+the)?)\s+(?:week|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/giu,
  /\b(?:by|due|before|until)\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/giu,
  /\bin\s+\d{1,3}\s+(?:days?|weeks?|months?)\b/giu,
  /\bq[1-4]\s*(?:(?:19|20)\d{2}|'\d{2})\b/giu,
  /\b(?:by|due|before|in|during|target(?:ing)?)\s+q[1-4]\b/giu,
  /\b(?:19|20)\d{2}-w\d{2}\b/giu,
]);

export type DeadlineUnavailableReason = "never_observed" | "document_absent";

/**
 * What NEXT_STEPS.md said about time, as flatly as it can be put.
 *
 * `dates` and `unreadable` are not alternatives: a document can name one date
 * this parser reads and another it refuses, and reporting only the first would
 * hide the second.
 */
export interface DeadlineReading {
  /** False when NEXT_STEPS.md could not be read at all; `dates` is then empty for a reason, not because there are none. */
  readonly available: boolean;
  readonly unavailableReason: DeadlineUnavailableReason | null;
  /** Parsed ISO days, ascending, deduplicated, capped for display. */
  readonly dates: readonly string[];
  /** The earliest parsed day, which is the commitment that falls due first. */
  readonly nearest: string | null;
  readonly approaching: boolean;
  readonly overdue: boolean;
  /** Sanitised samples of date-shaped text this parser refuses to interpret. */
  readonly unreadable: readonly string[];
  /** The stored excerpt is at its bound, so a deadline may sit past what was kept. */
  readonly truncated: boolean;
}

export type StalenessReason =
  /** Stale, and NEXT_STEPS.md names a day that has arrived or is close. */
  | "approaching_deadline"
  /** Stale, and the earliest day it names has already passed. */
  | "overdue_deadline"
  /** Stale, and NEXT_STEPS.md talks about time in a way this parser will not interpret. */
  | "deadline_unreadable"
  /** Stale, and NEXT_STEPS.md is missing, so no deadline can be ruled out. */
  | "deadline_unseen"
  /** Stale, and NEXT_STEPS.md is longer than the stored excerpt. */
  | "deadline_possibly_truncated"
  /** Never successfully polled -- there is nothing to assess. */
  | "never_polled"
  /** The last poll failed, so everything below is as old as the last one that worked. */
  | "polling_failing"
  /** A stored commit timestamp that will not parse; the age of the project cannot be computed. */
  | "last_commit_unreadable";

export interface ProjectStalenessReport {
  readonly projectId: string;
  readonly displayName: string;
  readonly staleAfterDays: number;
  readonly lastCommitAt: string | null;
  /** Fractional days, null when there is no readable commit timestamp to measure from. */
  readonly daysSinceLastCommit: number | null;
  readonly stale: boolean;
  /** True when the poller cannot currently see this project, whatever its documents last said. */
  readonly blind: boolean;
  readonly deadline: DeadlineReading;
  readonly escalate: boolean;
  readonly reasons: readonly StalenessReason[];
}

export interface StalenessOptions {
  /** Injected so a test can place "now" relative to its fixtures instead of relative to the wall clock. */
  readonly now: () => Date;
  readonly approachingWithinDays?: number;
}

function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * A day is compared at its end, not its start.
 *
 * A deadline of "2026-09-10" is met by work done during the 10th, so treating
 * the day as expiring at midnight would report a project overdue for the whole
 * of the day it was due.
 */
function deadlineInstant(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 23, 59, 59, 999);
}

/** Untrusted text, flattened for display: no control characters, no line breaks, bounded length. */
function sample(value: string): string {
  const flattened = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return flattened.length > MAX_SAMPLE_CHARACTERS
    ? `${flattened.slice(0, MAX_SAMPLE_CHARACTERS - 1)}…`
    : flattened;
}

/**
 * Read every date this parser understands out of an excerpt, and note the
 * date-shaped text it will not.
 *
 * Every ISO date found is treated as a commitment, including one already in
 * the past. That follows the four-document standard's own division of labour:
 * NEXT_STEPS.md says what is next and CHANGELOG.md says what happened, so a
 * date sitting in NEXT_STEPS.md is something owed, and one whose day has gone
 * by is the most urgent kind rather than trivia to be filtered out.
 */
export function readDeadlines(excerpt: string, nowMs: number, horizonMs: number): DeadlineReading {
  const days = new Set<string>();
  const unreadable = new Set<string>();
  let nearestMs: number | null = null;
  let nearestDay: string | null = null;

  for (const match of excerpt.matchAll(ISO_DATE)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isRealCalendarDay(year, month, day)) {
      // Date-shaped and not a date: 2026-13-01, 2026-02-30. Reported rather
      // than dropped, because a typo in a deadline is still someone writing
      // down a deadline.
      unreadable.add(sample(match[0]));
      continue;
    }
    days.add(match[0]);
    const instant = deadlineInstant(year, month, day);
    if (nearestMs === null || instant < nearestMs) {
      nearestMs = instant;
      nearestDay = match[0];
    }
  }

  for (const pattern of REFUSED_DATE_SHAPES) {
    for (const match of excerpt.matchAll(pattern)) {
      if (unreadable.size >= MAX_SAMPLES) break;
      unreadable.add(sample(match[0]));
    }
  }

  const sorted = [...days].sort();
  return Object.freeze({
    available: true,
    unavailableReason: null,
    dates: Object.freeze(sorted.slice(0, MAX_REPORTED_DATES)),
    nearest: nearestDay,
    approaching: nearestMs !== null && nearestMs <= nowMs + horizonMs,
    overdue: nearestMs !== null && nearestMs < nowMs,
    unreadable: Object.freeze([...unreadable].slice(0, MAX_SAMPLES)),
    truncated: isExcerptAtCap(excerpt),
  });
}

function unavailableDeadline(reason: DeadlineUnavailableReason): DeadlineReading {
  return Object.freeze({
    available: false,
    unavailableReason: reason,
    dates: Object.freeze([]),
    nearest: null,
    approaching: false,
    overdue: false,
    unreadable: Object.freeze([]),
    truncated: false,
  });
}

function readDeadlineFor(status: ProjectStatus, nowMs: number, horizonMs: number): DeadlineReading {
  if (status.latestSuccess === null) return unavailableDeadline("never_observed");
  const nextSteps = documentAt(status, "NEXT_STEPS.md");
  if (nextSteps === null) return unavailableDeadline("document_absent");
  return readDeadlines(nextSteps.excerpt, nowMs, horizonMs);
}

/**
 * Assess every project, whether or not it is in trouble.
 *
 * Returning one report per project rather than only the escalations lets the
 * digest render the status view from the same pass, and keeps the reasoning
 * behind a project that did *not* escalate available to whoever asks why.
 */
export function assessStaleness(
  statuses: readonly ProjectStatus[],
  options: StalenessOptions,
): readonly ProjectStalenessReport[] {
  const nowMs = options.now().valueOf();
  if (!Number.isFinite(nowMs)) throw new TypeError("project_clock_invalid");
  const horizonDays = options.approachingWithinDays ?? DEFAULT_APPROACHING_WITHIN_DAYS;
  if (!Number.isFinite(horizonDays) || horizonDays < 0) throw new RangeError("approachingWithinDays must be a non-negative number");
  const horizonMs = horizonDays * DAY_MS;

  return Object.freeze(statuses.map((status) => report(status, nowMs, horizonMs)));
}

/**
 * The projects that need the owner today.
 *
 * Projects we cannot see are returned alongside genuinely stalled ones on
 * purpose. Two lists would let a digest render the stalled one and forget the
 * other, and a repository the poller has silently stopped reaching is exactly
 * the failure this design exists to prevent -- `reasons` says which kind each
 * one is.
 */
export function detectStalledProjects(
  statuses: readonly ProjectStatus[],
  options: StalenessOptions,
): readonly ProjectStalenessReport[] {
  return Object.freeze(assessStaleness(statuses, options).filter((entry) => entry.escalate));
}

function report(status: ProjectStatus, nowMs: number, horizonMs: number): ProjectStalenessReport {
  const lastCommitAt = status.latestSuccess?.lastCommitAt ?? null;
  const lastCommitMs = lastCommitAt === null ? Number.NaN : Date.parse(lastCommitAt);
  const daysSinceLastCommit = Number.isFinite(lastCommitMs) ? (nowMs - lastCommitMs) / DAY_MS : null;
  const stale = daysSinceLastCommit !== null && daysSinceLastCommit > status.project.staleAfterDays;
  const deadline = readDeadlineFor(status, nowMs, horizonMs);

  // Reasons we cannot trust what we are looking at, kept apart from reasons the
  // project is late. Either escalates, but they are not the same finding and a
  // digest that reported "stalled" for an unreachable repository would send
  // someone to chase a project that may be perfectly healthy.
  const blindReasons: StalenessReason[] = [];
  if (status.pollHealth === "never_polled") blindReasons.push("never_polled");
  if (status.pollHealth === "failing") blindReasons.push("polling_failing");
  if (lastCommitAt !== null && daysSinceLastCommit === null) blindReasons.push("last_commit_unreadable");

  const deadlineReasons: StalenessReason[] = [];
  if (stale) {
    if (deadline.approaching) deadlineReasons.push(deadline.overdue ? "overdue_deadline" : "approaching_deadline");
    if (deadline.unreadable.length > 0) deadlineReasons.push("deadline_unreadable");
    if (!deadline.available) deadlineReasons.push("deadline_unseen");
    if (deadline.truncated) deadlineReasons.push("deadline_possibly_truncated");
  }

  return Object.freeze({
    projectId: status.project.projectId,
    displayName: status.project.displayName,
    staleAfterDays: status.project.staleAfterDays,
    lastCommitAt,
    daysSinceLastCommit,
    stale,
    blind: blindReasons.length > 0,
    deadline,
    escalate: blindReasons.length > 0 || deadlineReasons.length > 0,
    reasons: Object.freeze([...blindReasons, ...deadlineReasons]),
  });
}

import {
  documentAt,
  isExcerptAtCap,
  type ProjectDocumentPath,
  type ProjectPollHealth,
  type ProjectStatus,
} from "./project-types.js";

/**
 * The project facts the model reads before it decides what needs attention.
 *
 * This module used to be the stalled-project detector: it compared a commit
 * age against `staleAfterDays`, parsed NEXT_STEPS.md for the earliest date,
 * and escalated a project on a threshold. Every one of those is a judgment,
 * and by the roadmap's rule judgment belongs to Jarvis. What is left here is
 * the `senses` half only: what the four documents said, when the repository
 * was last committed to, how the polls are going, and which ISO days the
 * excerpt actually contains.
 *
 * There is deliberately no `stale`, `approaching`, `overdue` or `escalate`
 * field and no threshold constant. The model reads this, decides whether a
 * project needs Sid, and asks him when the facts are incomplete.
 *
 * The documents are untrusted text: NEXT_STEPS.md is a file anyone with push
 * access can write. Nothing found in it is executed, followed, or passed to a
 * model as an instruction. Date-shaped text the reader will not interpret is
 * reported as unreadable rather than silently treated as "no deadline", so an
 * omission is visible to the model that has to judge it.
 */

const DAY_MS = 86_400_000;

/** Enough for the owner to see what confused the reader, short enough not to paste a document into a digest. */
const MAX_SAMPLES = 5;
const MAX_SAMPLE_CHARACTERS = 60;

/**
 * The one format this reads: a four-digit year, a two-digit month and a
 * two-digit day, separated by hyphens, that names a real calendar day.
 *
 * The lookarounds keep it from reading a fragment of something longer.
 * Without the trailing one, `2026-09-101` would yield `2026-09-10`; without
 * the leading one, the tail of a longer numeric string would read as a date.
 * A time may follow (`2026-09-10T09:00:00Z`) and is ignored.
 */
const ISO_DATE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/gu;

/**
 * Text that looks like a date or a deadline and that this reader refuses.
 *
 * Each shape is refused for a reason that cannot be fixed by trying harder:
 *
 *  - `03/04/2026` and `04.03.2026` are March 4th in one country and April 3rd
 *    in another, and nothing in the document says which.
 *  - `03-04-26` has the same ambiguity plus a two-digit year.
 *  - `Sep 15`, `March 4th` are unambiguous to a reader and locale-shaped to a
 *    parser.
 *  - `next Friday`, `end of month`, `EOW`, `in two weeks` need a reference
 *    date and a timezone that the document does not record.
 *  - `Q3 2026` and `2026-W14` name a range, not a day.
 *
 * These shapes are reported, not interpreted. The model, not this file,
 * decides what they mean for a project.
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

/** Untrusted text, flattened for display: no control characters, no line breaks, bounded length. */
function sample(value: string): string {
  const flattened = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return flattened.length > MAX_SAMPLE_CHARACTERS
    ? `${flattened.slice(0, MAX_SAMPLE_CHARACTERS - 1)}…`
    : flattened;
}

function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** What one document's excerpt said about time, as flatly as it can be put. */
export interface ProjectDateReading {
  /**
   * ISO days found in the excerpt, deduplicated, in the order the document
   * wrote them. Not sorted and not truncated to a "nearest": which one matters
   * is the model's judgment, and the excerpt is already bounded, so the list
   * is too.
   */
  readonly dates: readonly string[];
  /** Sanitised samples of date-shaped text this reader refuses to interpret. */
  readonly unreadable: readonly string[];
  /** The stored excerpt is at its bound, so a date may sit past what was kept. */
  readonly truncated: boolean;
}

/**
 * Read every ISO day this reader understands out of an excerpt, and note the
 * date-shaped text it will not.
 *
 * A day already in the past is reported like any other. Deciding that a passed
 * day is "overdue", or that the earliest day is the one that matters, is the
 * judgment this module no longer makes.
 */
export function readProjectDates(excerpt: string): ProjectDateReading {
  const days = new Set<string>();
  const unreadable = new Set<string>();

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
  }

  for (const pattern of REFUSED_DATE_SHAPES) {
    for (const match of excerpt.matchAll(pattern)) {
      if (unreadable.size >= MAX_SAMPLES) break;
      unreadable.add(sample(match[0]));
    }
  }

  return Object.freeze({
    dates: Object.freeze([...days]),
    unreadable: Object.freeze([...unreadable].slice(0, MAX_SAMPLES)),
    truncated: isExcerptAtCap(excerpt),
  });
}

/** One stored document, as the repository wrote it. */
export interface ProjectDocumentFact {
  readonly path: ProjectDocumentPath;
  /** Bounded top-of-file text. Untrusted repository content, data only. */
  readonly excerpt: string;
  readonly observedAt: string;
}

/**
 * Everything code knows about one project, with no verdict attached.
 *
 * `daysSinceLastCommit` is arithmetic on the stored commit instant, not a
 * judgment; whether that makes a project late is the model's call. A null
 * commit age means there is no readable instant, and a null `lastCommitAt`
 * means no successful observation ever recorded one.
 */
export interface ProjectFacts {
  readonly projectId: string;
  readonly displayName: string;
  /** True once any successful observation exists; false when only failures do. */
  readonly everObserved: boolean;
  readonly lastCommitAt: string | null;
  /** Fractional days since the last readable commit; null when there is none. */
  readonly daysSinceLastCommit: number | null;
  readonly pollHealth: ProjectPollHealth;
  /** The most recent observation's failure text, when the last poll failed. */
  readonly lastFailure: string | null;
  /** Whether NEXT_STEPS.md was present at the last successful observation. */
  readonly nextStepsPresent: boolean;
  readonly nextStepsDates: readonly string[];
  readonly nextStepsUnreadable: readonly string[];
  readonly nextStepsTruncated: boolean;
  /** Every stored document excerpt, including the other three files. */
  readonly documents: readonly ProjectDocumentFact[];
}

export interface ProjectFactsOptions {
  /** Injected so a test can place "now" relative to its fixtures instead of relative to the wall clock. */
  readonly now: () => Date;
}

function factsFor(status: ProjectStatus, nowMs: number): ProjectFacts {
  const lastCommitAt = status.latestSuccess?.lastCommitAt ?? null;
  const lastCommitMs = lastCommitAt === null ? Number.NaN : Date.parse(lastCommitAt);
  const daysSinceLastCommit = Number.isFinite(lastCommitMs) ? (nowMs - lastCommitMs) / DAY_MS : null;
  const nextSteps = documentAt(status, "NEXT_STEPS.md");
  const reading = nextSteps === null
    ? null
    : readProjectDates(nextSteps.excerpt);

  return Object.freeze({
    projectId: status.project.projectId,
    displayName: status.project.displayName,
    everObserved: status.latestSuccess !== null,
    lastCommitAt,
    daysSinceLastCommit,
    pollHealth: status.pollHealth,
    lastFailure: status.latestObservation?.failure ?? null,
    nextStepsPresent: nextSteps !== null,
    nextStepsDates: reading?.dates ?? Object.freeze([]),
    nextStepsUnreadable: reading?.unreadable ?? Object.freeze([]),
    nextStepsTruncated: reading?.truncated ?? false,
    documents: Object.freeze(status.documents.map((document) => Object.freeze({
      path: document.path,
      excerpt: document.excerpt,
      observedAt: document.observedAt,
    }))),
  });
}

/**
 * Read every project's facts, whether or not it looks like trouble.
 *
 * Returning one entry per project rather than only the interesting ones keeps
 * the "what should I look at?" judgment with the model. There is no
 * `assessStaleness`/`detectStalledProjects` split any more, because "stalled"
 * was the verdict this module stopped making.
 */
export function projectFacts(
  statuses: readonly ProjectStatus[],
  options: ProjectFactsOptions,
): readonly ProjectFacts[] {
  const nowMs = options.now().valueOf();
  if (!Number.isFinite(nowMs)) throw new TypeError("project_clock_invalid");
  return Object.freeze(statuses.map((status) => factsFor(status, nowMs)));
}

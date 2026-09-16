/**
 * Assemble the daily digest and the Sunday retro.
 *
 * Composition is deterministic. No model runs here, and that is a security
 * decision rather than a performance one: the digest's inputs include the
 * text of repository documents and the titles of scraped school assignments,
 * all of which are written by someone other than the owner. Handing that to a
 * model and printing what comes back is the exact shape of the prompt
 * injection the plan spends a section on. A model may summarise a composed
 * digest later, but what it summarises is a record that already exists.
 *
 * Untrusted text still reaches the owner's screen, so it is neutralised on
 * the way through: control characters stripped, length capped, and every line
 * of it prefixed so it cannot impersonate one of the digest's own headings. A
 * NEXT_STEPS.md containing a line that reads like a heading should look like
 * what it is -- a line in a file -- and not like Jarvis saying it.
 */

import type {
  DigestApplicationItem,
  DigestCatchupAction,
  Digest,
  DigestGap,
  DigestInput,
  DigestSection,
  DigestStudySignalCitation,
} from "./digest-types.js";

/**
 * Telegram refuses a message over 4096 characters. Composing past the limit
 * and letting the send fail would lose the whole digest rather than the tail
 * of it, so the composer truncates and says that it did.
 */
const MAX_MESSAGE_CHARACTERS = 4_096;

/** Bounds any single line of borrowed text before it reaches the owner. */
const MAX_EXCERPT_CHARACTERS = 240;
const MAX_EXCERPT_LINES = 3;

const DEADLINE_HORIZON_DAYS = 7;
const RETRO_HORIZON_DAYS = 7;
const APPLICATION_ITEM_LIMIT = 5;

/**
 * Quoted rather than plain. The prefix is what stops a line inside a
 * repository file from being read as a line Jarvis wrote.
 */
const QUOTE_PREFIX = "| ";

/**
 * Everything in Unicode's "other" category: control characters, format
 * characters, surrogates, private use.
 *
 * Removed rather than escaped, because none of them carry meaning worth
 * preserving in a status excerpt and several actively lie. A stray carriage
 * return makes the rest of a line vanish in some clients, and a
 * right-to-left override reverses the text after it -- which is a genuine way
 * for a repository file to make its line read as something else entirely.
 * Line structure is handled before this runs, so removing newlines here is
 * intended.
 */
const CONTROL_CHARACTERS = /\p{C}/gu;

export interface DigestClock {
  now(): Date;
}

export interface ComposeOptions {
  readonly kind: "daily" | "retro";
  /** IANA zone. Determines which local day "today" and "this week" mean. */
  readonly timeZone: string;
}

/** One line of borrowed text, bounded and stripped, with no line structure. */
function neutraliseInline(text: string): string {
  const line = text.replace(CONTROL_CHARACTERS, "").replace(/\s+/gu, " ").trim();
  return line.length > MAX_EXCERPT_CHARACTERS
    ? `${line.slice(0, MAX_EXCERPT_CHARACTERS - 1)}…`
    : line;
}

/**
 * Strip anything that would let borrowed text forge structure, and quote what
 * survives so it reads as a line in a file rather than as Jarvis speaking.
 */
function neutralise(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = neutraliseInline(raw);
    if (line.length === 0) continue;
    lines.push(QUOTE_PREFIX + line);
    if (lines.length === MAX_EXCERPT_LINES) break;
  }
  return lines;
}

/**
 * The calendar date in the owner's zone.
 *
 * `Intl` rather than arithmetic on the epoch, because the offset is not a
 * constant: the cron fires at a fixed UTC hour and the local hour it lands on
 * moves twice a year. Getting this wrong makes the digest say "today" about
 * yesterday for half the year.
 */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const find = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${find("year")}-${find("month")}-${find("day")}`;
}

function localTimestamp(value: string, timeZone: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return neutraliseInline(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const find = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${find("year")}-${find("month")}-${find("day")} ${find("hour")}:${find("minute")} local`;
}

/** Local weekday index, 0 = Sunday, or -1 when it could not be determined. */
export function localWeekday(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(instant);
  // An unrecognised zone throws inside Intl before reaching here, so a name
  // that is not in this list means the format changed underneath us.
  // Reporting -1 lets the caller decide rather than silently scheduling the
  // retro on a Tuesday.
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

function hoursUntil(dueAt: string, now: Date): number | null {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  return (due - now.getTime()) / 3_600_000;
}

function describeDue(hours: number): string {
  if (hours < 0) return "overdue";
  if (hours < 24) return `in ${Math.max(1, Math.round(hours))}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function deadlineSection(
  input: DigestInput,
  now: Date,
  horizonDays: number,
): DigestSection | null {
  const upcoming = input.deadlines
    .map((deadline) => ({ deadline, hours: hoursUntil(deadline.dueAt, now) }))
    // A due date that will not parse is kept rather than filtered away. A
    // deadline we cannot read is still a deadline, and dropping it is exactly
    // how something gets missed silently.
    .filter((entry) => entry.hours === null || entry.hours <= horizonDays * 24)
    .sort(
      (left, right) =>
        (left.hours ?? Number.MAX_SAFE_INTEGER) - (right.hours ?? Number.MAX_SAFE_INTEGER),
    );

  if (upcoming.length === 0) return null;
  return {
    heading: "Due",
    lines: upcoming.map(({ deadline, hours }) =>
      hours === null
        ? `${neutraliseInline(deadline.course)}: ${neutraliseInline(deadline.title)} (due ${neutraliseInline(deadline.dueAt)}, unreadable date)`
        : `${neutraliseInline(deadline.course)}: ${neutraliseInline(deadline.title)} (${describeDue(hours)}, ${deadline.effort})`,
    ),
  };
}

function catchupSection(actions: readonly DigestCatchupAction[]): DigestSection | null {
  if (actions.length === 0) return null;
  const ordered = [...actions].sort((left, right) =>
    left.sequenceRank - right.sequenceRank || left.actionId.localeCompare(right.actionId));
  return {
    heading: "School catch-up",
    lines: ordered.map((action) =>
      `${action.sequenceRank}. ${neutraliseInline(action.course)}: ${neutraliseInline(action.text)} (${action.estimatedMinutes} min)`,
    ),
  };
}

function schoolObservationSection(input: DigestInput, timeZone: string): DigestSection | null {
  const lines = [
    ...input.grades.map((grade) =>
      `[verified: ${grade.source}; checked ${localTimestamp(grade.lastSeenAt, timeZone)}] ${neutraliseInline(grade.course)}: ${neutraliseInline(grade.title)} — assigned grade ${String(grade.assignedGrade)} (scale and weight not supplied)`,
    ),
    ...input.missingWork.map((item) =>
      `[derived: ${item.source} showed no submission as of ${localTimestamp(item.lastSeenAt, timeZone)}] ${neutraliseInline(item.course)}: ${neutraliseInline(item.title)} (deadline passed ${localTimestamp(item.dueAt, timeZone)})`,
    ),
    ...(input.missingWorkOmitted > 0 ? [`+${input.missingWorkOmitted} more`] : []),
  ];
  return lines.length === 0 ? null : { heading: "Grades and submission checks", lines };
}

function applicationStatus(status: DigestApplicationItem["status"]): string {
  if (status === "not_started") return "not started";
  if (status === "submitted_by_sid") return "submitted by Sid";
  if (status === "not_needed_by_sid") return "not needed by Sid";
  return status;
}

function applicationSection(items: readonly DigestApplicationItem[]): DigestSection | null {
  const ordered = [...items]
    .filter((item) => item.status !== "submitted_by_sid" && item.status !== "not_needed_by_sid")
    .sort((left, right) => {
      if (left.dueDate === null && right.dueDate !== null) return 1;
      if (left.dueDate !== null && right.dueDate === null) return -1;
      return (left.dueDate ?? "").localeCompare(right.dueDate ?? "") || left.itemId.localeCompare(right.itemId);
    })
    .slice(0, APPLICATION_ITEM_LIMIT);
  if (ordered.length === 0) return null;
  return {
    heading: "University applications",
    lines: ordered.map((item) => {
      const due = item.dueDate === null
        ? "due date unverified -- awaiting current-cycle source"
        : `due ${neutraliseInline(item.dueDate)} (${item.verificationState})`;
      return `${neutraliseInline(item.university)} — ${neutraliseInline(item.programName)}: ${neutraliseInline(item.label)} [${applicationStatus(item.status)}; ${due}]`;
    }),
  };
}

function studyCheckInSection(input: DigestInput): DigestSection | null {
  const checkIn = input.studyCheckIn;
  if (checkIn === undefined || checkIn === null) return null;
  const count = `${checkIn.evidenceCount} evidence ${checkIn.evidenceCount === 1 ? "point" : "points"}`;
  const caution = checkIn.evidenceCount === 1 ? "; not a fixed judgment" : "";
  const sourceLabel = (kind: DigestStudySignalCitation["sourceKind"]): string => {
    if (kind === "verified_grade") return "Classroom grade";
    if (kind === "derived_missing_work") return "derived missing-work observation";
    if (kind === "deadline") return "deadline";
    if (kind === "quiz_outcome") return "quiz evidence";
    if (kind === "owner_report") return "owner study note";
    return "course-card evidence";
  };
  return {
    heading: "Coursework check-in",
    lines: [
      `${neutraliseInline(checkIn.course)}: study target “${neutraliseInline(checkIn.topic)}” (${count}, ${checkIn.confidence} confidence${caution}; last observed ${neutraliseInline(checkIn.observedAt.slice(0, 10))}).`,
      ...checkIn.citations.map((point, index) => {
        const stale = point.freshness === "stale" ? "; stale" : "";
        return `Source ${index + 1} — ${sourceLabel(point.sourceKind)} ${neutraliseInline(point.sourceRecordId)} (${neutraliseInline(point.observedAt.slice(0, 10))}; ${point.verification}${stale}): ${neutraliseInline(point.detail)}`;
      }),
      "Want a 10-minute quiz or flashcards? Reply “quiz me on that weak spot” or “make flashcards for that weak spot”.",
    ],
  };
}

function projectSection(input: DigestInput): DigestSection | null {
  const lines: string[] = [];
  for (const project of input.projects) {
    if (project.pollFailure !== null) {
      lines.push(
        `${project.displayName}: could not be read (${neutraliseInline(project.pollFailure)})`,
      );
      continue;
    }
    if (project.stalledReason !== null) {
      lines.push(`${project.displayName}: stalled -- ${neutraliseInline(project.stalledReason)}`);
    } else if (project.changedDocuments.length > 0) {
      lines.push(`${project.displayName}: ${project.changedDocuments.join(", ")} changed`);
    }
    if (project.nextStepsExcerpt !== null) {
      lines.push(...neutralise(project.nextStepsExcerpt));
    }
  }
  return lines.length === 0 ? null : { heading: "Projects", lines };
}

function decisionSection(input: DigestInput): DigestSection | null {
  if (input.decisions.length === 0) return null;
  const ordered = [
    ...input.decisions.filter((item) => item.urgency === "urgent"),
    ...input.decisions.filter((item) => item.urgency !== "urgent"),
  ];
  return {
    heading: `Waiting on you (${input.decisions.length})`,
    lines: ordered.map((item) => {
      const question = neutraliseInline(item.question);
      // A question that neutralises to nothing was entirely control
      // characters, which is worth showing as an anomaly rather than as a
      // blank line the owner cannot act on.
      const body = question.length > 0 ? question : `(unreadable) ${item.decisionId}`;
      return `${item.urgency === "urgent" ? "! " : ""}${body}`;
    }),
  };
}

function gapSection(gaps: readonly DigestGap[]): DigestSection | null {
  if (gaps.length === 0) return null;
  return {
    heading: "Could not be read",
    lines: gaps.map((gap) => `${gap.source}: ${neutraliseInline(gap.detail)}`),
  };
}

function render(sections: readonly DigestSection[]): string {
  return sections
    .map((section) => [section.heading, ...section.lines].join("\n"))
    .join("\n\n");
}

/**
 * Fit the digest to the channel, dropping the least load-bearing content
 * first.
 *
 * The gaps section is never dropped. A digest that silently omits "the
 * Brightspace calendar feed failed" reads exactly like a digest reporting a
 * quiet day, and the entire point of recording a failed source is that those
 * two must never look the same.
 */
function fit(
  sections: readonly DigestSection[],
  protectedHeadings: ReadonlySet<string>,
): { sections: DigestSection[]; truncated: boolean } {
  const kept = [...sections];
  let truncated = false;
  while (render(kept).length > MAX_MESSAGE_CHARACTERS) {
    let victim = -1;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const heading = kept[index]?.heading;
      if (heading !== undefined && !protectedHeadings.has(heading)) {
        victim = index;
        break;
      }
    }
    // Everything left is protected. Stopping here can leave an over-long
    // message, which the caller must handle -- but truncating a failure
    // report to fit would defeat the reason it is protected.
    if (victim === -1) break;
    const section = kept[victim];
    if (section === undefined) break;
    if (section.lines.length > 1) {
      kept[victim] = { heading: section.heading, lines: section.lines.slice(0, -1) };
    } else {
      kept.splice(victim, 1);
    }
    truncated = true;
  }
  return { sections: kept, truncated };
}

export function compose(
  input: DigestInput,
  options: ComposeOptions,
  clock: DigestClock,
): Digest {
  const now = clock.now();
  const date = localDate(now, options.timeZone);
  const horizon = options.kind === "retro" ? RETRO_HORIZON_DAYS : DEADLINE_HORIZON_DAYS;

  const gaps = gapSection(input.gaps);
  const candidates = [
    deadlineSection(input, now, horizon),
    schoolObservationSection(input, options.timeZone),
    catchupSection(input.catchupActions),
    applicationSection(input.applicationItems),
    studyCheckInSection(input),
    projectSection(input),
    decisionSection(input),
    gaps,
  ].filter((section): section is DigestSection => section !== null);

  const header: DigestSection = {
    heading: options.kind === "retro" ? `Retro -- week to ${date}` : `Digest -- ${date}`,
    lines:
      candidates.length === 0
        // Said plainly rather than sending nothing. Silence is what a broken
        // scheduler looks like, and the owner should not have to tell the two
        // apart by guessing.
        ? ["Nothing due, nothing changed, nothing waiting on you."]
        : [],
  };

  const protectedHeadings = new Set([header.heading]);
  if (gaps !== null) protectedHeadings.add(gaps.heading);

  const { sections, truncated } = fit([header, ...candidates], protectedHeadings);
  const body = render(sections);
  const text = truncated ? `${body}\n\n(trimmed to fit)` : body;
  return { kind: options.kind, localDate: date, sections, truncated, text };
}

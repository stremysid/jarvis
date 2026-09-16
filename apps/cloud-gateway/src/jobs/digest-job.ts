/**
 * Gathering what the digest speaks about, and sending it.
 *
 * The composer takes a `DigestInput` and knows nothing about repositories.
 * This file is the adapter between the two, and its whole substance is how it
 * handles a source that will not answer: **a source that throws becomes a
 * gap, not an exception**. A digest assembled from two of three sources is
 * still worth sending, as long as it says which one is missing. Letting one
 * failed read abort the job produces silence, and silence is what a broken
 * scheduler looks like.
 *
 * That is the same rule the project poller and the deadline sweep already
 * follow, applied one level up.
 */

import { compose, localDate, type DigestClock } from "../digest/digest-composer.js";
import type { Env } from "../env.js";
import type {
  Digest,
  DigestDeadline,
  DigestGap,
  DigestInput,
  DigestProject,
} from "../digest/digest-types.js";
import type { Deadline, DeadlineSource, DeadlineSourceKind } from "../deadlines/deadline-types.js";
import { BRIGHTSPACE_WINDOW_ITEM_LIMIT } from "../deadlines/brightspace-ical-client.js";
import type { DecisionItem } from "../decisions/decision-types.js";
import type { SchoolCatchupAction } from "../school/school-catchup-types.js";
import type {
  UniversityApplicationDigestItem,
  UniversityWorkflowDigestItem,
} from "../university/university-tracker-types.js";
import type { StudyCheckIn } from "../school/study-coach-types.js";
import type { SchoolObservationDigestSnapshot } from "../school/school-observation-types.js";
import { assessStaleness, type ProjectStalenessReport } from "../projects/stalled-detector.js";
import { documentAt, type ProjectStatus } from "../projects/project-types.js";

/** How far ahead the digest looks for deadlines. */
const DEADLINE_HORIZON_DAYS = 7;
/** Hourly sources get two missed firings before the third makes staleness visible. */
const DEADLINE_SOURCE_STALE_AFTER_MS = 3 * 60 * 60 * 1_000;
/** A complete grades/submissions walk may span several hourly checkpoint slices. */
const SCHOOL_OBSERVATION_STALE_AFTER_MS = 12 * 60 * 60 * 1_000;

export interface DigestSources {
  readCatchupActions(localDate: string): Promise<readonly SchoolCatchupAction[]>;
  readApplicationItems(): Promise<readonly UniversityApplicationDigestItem[]>;
  readWorkflowItems?(): Promise<readonly UniversityWorkflowDigestItem[]>;
  readDeadlines(withinDays: number): Promise<readonly Deadline[]>;
  readDeadlineSources(): Promise<readonly DeadlineSource[]>;
  readSchoolObservations?(): Promise<SchoolObservationDigestSnapshot>;
  readProjectStatuses(): Promise<readonly ProjectStatus[]>;
  readOpenDecisions(): Promise<readonly DecisionItem[]>;
  claimStudyCheckIn?(localDate: string, weekday: number, minuteOfDay: number): Promise<StudyCheckIn | null>;
}

export interface DigestDelivery {
  send(text: string): Promise<void>;
}

export interface DigestJobDependencies {
  readonly sources: DigestSources;
  readonly delivery: DigestDelivery;
  readonly clock: DigestClock;
  readonly timeZone: string;
  /** Fixed source kinds known to be absent from configuration at compose time. */
  readonly unconfiguredDeadlineSourceKinds?: readonly DeadlineSourceKind[];
  /**
   * Injected only so the failure path below can be exercised.
   *
   * The detector's one documented throw is a non-finite clock, which also
   * stops the composer dead -- so with `assessStaleness` imported directly
   * there is no way to reach the guard around it, and an unreachable guard
   * is indistinguishable from a broken one. The detector is not code this
   * file owns, and a later throw added to it should degrade the digest
   * rather than delete it.
   */
  readonly assess?: typeof assessStaleness;
}

export function unconfiguredDeadlineSourceKinds(
  env: Pick<Env, "BRIGHTSPACE_ICAL_URL">,
): readonly DeadlineSourceKind[] {
  return env.BRIGHTSPACE_ICAL_URL === undefined || env.BRIGHTSPACE_ICAL_URL.length === 0
    ? Object.freeze(["brightspace"])
    : Object.freeze([]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deadlineSourceName(source: Pick<DeadlineSource, "kind">): string {
  if (source.kind === "classroom") return "Google Classroom";
  if (source.kind === "brightspace") return "Brightspace";
  return "Manual deadlines";
}

function scheduledSourceGap(source: DeadlineSource, observedAt: Date): string | null {
  if (!source.active || source.kind === "manual") return null;
  let partialResult: string | null = null;
  if (source.lastFailure !== null) {
    const truncation = source.kind === "brightspace"
      ? /^source_items_truncated:(\d+)$/u.exec(source.lastFailure)
      : null;
    if (truncation !== null) {
      partialResult = `bounded sweep omitted ${truncation[1]} in-window entries; kept at most ${BRIGHTSPACE_WINDOW_ITEM_LIMIT} live items and ${BRIGHTSPACE_WINDOW_ITEM_LIMIT} cancellations`;
    } else {
      return source.lastFailure;
    }
  }
  if (source.lastSuccessAt === null) return partialResult === null ? "has never synced" : `${partialResult}; has never synced`;
  const lastSuccess = Date.parse(source.lastSuccessAt);
  const age = observedAt.getTime() - lastSuccess;
  if (!Number.isFinite(lastSuccess) || age < 0) {
    return partialResult === null
      ? "last successful sync time is unreadable"
      : `${partialResult}; last successful sync time is unreadable`;
  }
  if (age > DEADLINE_SOURCE_STALE_AFTER_MS) {
    return partialResult === null ? "last successful sync is stale" : `${partialResult}; last successful sync is stale`;
  }
  return partialResult;
}

/**
 * Read one source, or record why it could not be read.
 *
 * The gap is added to a shared list rather than returned, because the caller
 * has nothing useful to do with a partial result other than carry on -- and
 * every early return here would be a source silently missing from the digest.
 */
async function readOr<T>(
  source: string,
  read: () => Promise<readonly T[]>,
  gaps: DigestGap[],
): Promise<readonly T[]> {
  try {
    return await read();
  } catch (error) {
    gaps.push({ source, detail: describe(error) });
    return [];
  }
}

function missingStudyCoachTable(error: unknown): boolean {
  return /no such table:\s*school_(?:study|practice)_/iu.test(describe(error));
}

function missingSchoolObservationTable(error: unknown): boolean {
  return /no such table:\s*school_(?:observation_sync|assignment_observations|missing_work_transitions)/iu
    .test(describe(error));
}

interface SchoolObservationRead {
  readonly available: boolean;
  readonly snapshot: SchoolObservationDigestSnapshot | null;
}

async function readSchoolObservationsOr(
  read: (() => Promise<SchoolObservationDigestSnapshot>) | undefined,
  gaps: DigestGap[],
): Promise<SchoolObservationRead> {
  if (read === undefined) return { available: false, snapshot: null };
  try {
    return { available: true, snapshot: await read() };
  } catch (error) {
    // Code may be deployed before additive candidate migration 0027. Until
    // the tables exist, the older digest remains the live product.
    if (missingSchoolObservationTable(error)) return { available: false, snapshot: null };
    gaps.push({ source: "Google Classroom grades/submissions", detail: describe(error) });
    return { available: true, snapshot: null };
  }
}

async function readStudyCheckInOr(
  read: () => Promise<StudyCheckIn | null>,
  gaps: DigestGap[],
): Promise<StudyCheckIn | null> {
  try {
    return await read();
  } catch (error) {
    // The Worker may be deployed before candidate migration 0023 is applied.
    // Absence is not a failed read until the feature's tables exist.
    if (!missingStudyCoachTable(error)) gaps.push({ source: "Study coach", detail: describe(error) });
    return null;
  }
}

function localSchedule(instant: Date, timeZone: string): { readonly weekday: number; readonly minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const weekdays = new Map(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => [day, index]));
  const weekday = weekdays.get(value("weekday") ?? "");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new TypeError("study_check_in_local_time_invalid");
  }
  return { weekday, minuteOfDay: hour * 60 + minute };
}

/**
 * Why this project is being escalated, in one line.
 *
 * The detector's `reasons` are codes; this turns them into something the
 * owner reads at 07:30. It reports every reason rather than the first,
 * because "stale and we also cannot see it" is a different situation from
 * either half alone.
 */
function stalledReason(report: ProjectStalenessReport): string | null {
  if (!report.escalate) return null;
  const days = report.daysSinceLastCommit;
  const age = days === null ? "no readable commit date" : `${Math.floor(days)}d since a commit`;
  return `${age} (${report.reasons.join(", ")})`;
}

function toDigestProject(
  status: ProjectStatus,
  report: ProjectStalenessReport | undefined,
): DigestProject {
  const nextSteps = documentAt(status, "NEXT_STEPS.md");
  return {
    projectId: status.project.projectId,
    displayName: status.project.displayName,
    lastCommitAt: status.latestSuccess?.lastCommitAt ?? null,
    nextStepsExcerpt: nextSteps?.excerpt ?? null,
    stalledReason: report === undefined ? null : stalledReason(report),
    // The most recent observation failing is what the owner needs to see. A
    // project whose last SUCCESS looks healthy while every poll since has
    // failed is exactly the case that must not read as calm.
    pollFailure: status.latestObservation?.failure ?? null,
    // Deliberately empty. Which documents changed is a comparison between the
    // last two successful observations, and the repository stores the current
    // one rather than a diff. The poller already reports changes as they
    // happen, which is when a KNOWN_ISSUES edit is worth knowing about --
    // repeating it in the morning digest would be a worse version of a ping
    // the owner already had. Populating this from a stored diff is the change
    // to make if that judgement turns out wrong.
    changedDocuments: [],
  };
}

function toDigestDeadline(deadline: Deadline): DigestDeadline {
  return {
    deadlineId: deadline.deadlineId,
    course: deadline.course,
    title: deadline.title,
    dueAt: deadline.dueAt,
    effort: deadline.effort,
  };
}

/** Assemble the digest. Exported separately so it can be tested without a send. */
export async function assembleDigest(
  kind: "daily" | "retro",
  dependencies: DigestJobDependencies,
): Promise<Digest> {
  const gaps: DigestGap[] = [];
  const observedAt = new Date(dependencies.clock.now().getTime());
  const observedClock: DigestClock = { now: () => new Date(observedAt.getTime()) };

  // Read every source before composing, and read them all even when the
  // first one fails. Short-circuiting would mean one broken source hides
  // whether the others are broken too.
  const today = localDate(observedAt, dependencies.timeZone);
  const schedule = localSchedule(observedAt, dependencies.timeZone);
  const [
    catchupActions,
    applicationItems,
    workflowItems,
    deadlines,
    deadlineSources,
    schoolRead,
    projects,
    decisions,
    studyCheckIn,
  ] = await Promise.all([
    readOr("School catch-up", () => dependencies.sources.readCatchupActions(today), gaps),
    readOr("University applications", () => dependencies.sources.readApplicationItems(), gaps),
    dependencies.sources.readWorkflowItems === undefined
      ? Promise.resolve([])
      : readOr("University application steps", () => dependencies.sources.readWorkflowItems?.() ?? Promise.resolve([]), gaps),
    readOr("Deadlines", () => dependencies.sources.readDeadlines(DEADLINE_HORIZON_DAYS), gaps),
    readOr("Deadline source health", () => dependencies.sources.readDeadlineSources(), gaps),
    readSchoolObservationsOr(dependencies.sources.readSchoolObservations, gaps),
    readOr("Projects", () => dependencies.sources.readProjectStatuses(), gaps),
    readOr("Decision queue", () => dependencies.sources.readOpenDecisions(), gaps),
    dependencies.sources.claimStudyCheckIn === undefined || kind !== "daily"
      ? Promise.resolve(null)
      : readStudyCheckInOr(() => dependencies.sources.claimStudyCheckIn!(
        today, schedule.weekday, schedule.minuteOfDay,
      ), gaps),
  ]);

  const unconfigured = new Set(dependencies.unconfiguredDeadlineSourceKinds ?? []);
  for (const kind of unconfigured) {
    if (kind === "manual") continue;
    const lastKnown = deadlineSources.find((source) => source.kind === kind);
    const detail = lastKnown === undefined
      ? "not set up"
      : lastKnown.lastSuccessAt === null
        ? "configuration removed; no successful sync is available"
        : `configuration removed; showing last-known deadlines from ${localDate(new Date(lastKnown.lastSuccessAt), dependencies.timeZone)}`;
    gaps.push({ source: deadlineSourceName({ kind }), detail });
  }

  // Keep the last known deadlines visible while saying that their source is
  // failed or stale. Dropping the deadlines would turn a sync fault into
  // "nothing due".
  for (const source of deadlineSources) {
    if (unconfigured.has(source.kind)) continue;
    const detail = scheduledSourceGap(source, observedAt);
    if (detail === null) continue;
    // The stored label is source data. Gap source names are structural text in
    // the composer, so select a fixed label from the validated kind instead.
    gaps.push({ source: deadlineSourceName(source), detail });
  }

  const classroomSource = deadlineSources.find((source) => source.kind === "classroom" && source.active);
  const schoolSnapshot = schoolRead.snapshot;
  if (schoolRead.available && schoolSnapshot !== null && classroomSource !== undefined) {
    const observationSource = schoolSnapshot.source;
    if (observationSource === null) {
      gaps.push({ source: "Google Classroom grades/submissions", detail: "has never completed a submission scan" });
    } else if (observationSource.lastFailure !== null) {
      gaps.push({ source: "Google Classroom grades/submissions", detail: observationSource.lastFailure });
    } else if (observationSource.lastSuccessAt === null) {
      gaps.push({ source: "Google Classroom grades/submissions", detail: "has never completed a submission scan" });
    } else {
      const lastSuccess = Date.parse(observationSource.lastSuccessAt);
      const age = observedAt.getTime() - lastSuccess;
      if (!Number.isFinite(lastSuccess) || age < 0) {
        gaps.push({ source: "Google Classroom grades/submissions", detail: "last completed scan time is unreadable" });
      } else if (age > SCHOOL_OBSERVATION_STALE_AFTER_MS) {
        gaps.push({ source: "Google Classroom grades/submissions", detail: "last completed scan is stale" });
      }
    }
  }

  // Staleness is derived here rather than stored, because "stale" is a
  // statement about now and a stored flag would be a statement about whenever
  // it was last written.
  const reports = new Map<string, ProjectStalenessReport>();
  try {
    const assess = dependencies.assess ?? assessStaleness;
    for (const report of assess(projects, observedClock)) {
      reports.set(report.projectId, report);
    }
  } catch (error) {
    // The projects themselves still read fine; only the judgement about them
    // failed. Reporting the projects without it beats dropping both.
    gaps.push({ source: "Stalled-project detector", detail: describe(error) });
  }

  const input: DigestInput = {
    catchupActions: catchupActions.map((action) => ({
      actionId: action.actionId,
      course: action.courseName,
      text: action.text,
      sequenceRank: action.sequenceRank,
      estimatedMinutes: action.estimatedMinutes,
    })),
    applicationItems: applicationItems.map((item) => ({
      itemId: item.itemId,
      university: item.university,
      programName: item.programName,
      label: item.label,
      status: item.status,
      dueDate: item.dueDate,
      verificationState: item.verification.state,
    })),
    universityWorkflowItems: workflowItems.map((item) => ({
      workflowId: item.workflowId,
      university: item.university,
      programName: item.programName,
      label: item.label,
      owner: item.owner,
      status: item.status,
      dueDate: item.deadline.date,
      dueAt: item.deadline.instant,
      dueTimeZone: item.deadline.timeZone,
      verificationState: item.deadline.verification.state,
    })),
    deadlines: deadlines.map(toDigestDeadline),
    grades: (schoolSnapshot?.grades ?? []).map((grade) => ({
      observationId: grade.observationId,
      course: grade.course,
      title: grade.title,
      assignedGrade: grade.assignedGrade,
      source: "Google Classroom" as const,
      lastSeenAt: grade.lastSeenAt,
    })),
    missingWork: (schoolSnapshot?.missingWork ?? []).map((item) => ({
      transitionId: item.transitionId,
      course: item.course,
      title: item.title,
      dueAt: item.dueAt,
      classification: "derived" as const,
      state: "no_submission_seen" as const,
      source: "Google Classroom" as const,
      lastSeenAt: item.lastSeenAt,
    })),
    missingWorkOmitted: schoolSnapshot?.missingWorkOmitted ?? 0,
    projects: projects.map((status) => toDigestProject(status, reports.get(status.project.projectId))),
    decisions: decisions.map((item) => ({
      decisionId: item.decisionId,
      question: item.question,
      urgency: item.urgency,
    })),
    gaps,
    studyCheckIn: studyCheckIn === null ? null : {
      course: studyCheckIn.courseName,
      topic: studyCheckIn.topic,
      outcome: studyCheckIn.outcome,
      evidenceCount: studyCheckIn.evidenceCount,
      confidence: studyCheckIn.confidence,
      observedAt: studyCheckIn.observedAt,
    },
  };

  return compose(input, { kind, timeZone: dependencies.timeZone }, observedClock);
}

export interface DigestJobResult {
  readonly sent: boolean;
  readonly gaps: number;
  readonly truncated: boolean;
}

/**
 * Assemble and send.
 *
 * A delivery failure is raised rather than swallowed, unlike a source
 * failure. The distinction is that a source failure still leaves something
 * worth sending, and a delivery failure leaves the owner with nothing -- so
 * it belongs in the run record where the next firing and the operator can
 * both see it.
 */
export async function runDigestJob(
  kind: "daily" | "retro",
  dependencies: DigestJobDependencies,
): Promise<DigestJobResult> {
  const digest = await assembleDigest(kind, dependencies);
  await dependencies.delivery.send(digest.text);
  return {
    sent: true,
    gaps: digest.sections.find((section) => section.heading === "Could not be read")?.lines.length ?? 0,
    truncated: digest.truncated,
  };
}

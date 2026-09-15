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

import { compose, type DigestClock } from "../digest/digest-composer.js";
import type {
  Digest,
  DigestDeadline,
  DigestGap,
  DigestInput,
  DigestProject,
} from "../digest/digest-types.js";
import type { Deadline, DeadlineSource } from "../deadlines/deadline-types.js";
import type { DecisionItem } from "../decisions/decision-types.js";
import { assessStaleness, type ProjectStalenessReport } from "../projects/stalled-detector.js";
import { documentAt, type ProjectStatus } from "../projects/project-types.js";

/** How far ahead the digest looks for deadlines. */
const DEADLINE_HORIZON_DAYS = 7;

export interface DigestSources {
  readDeadlines(withinDays: number): Promise<readonly Deadline[]>;
  readDeadlineSources(): Promise<readonly DeadlineSource[]>;
  readProjectStatuses(): Promise<readonly ProjectStatus[]>;
  readOpenDecisions(): Promise<readonly DecisionItem[]>;
}

export interface DigestDelivery {
  send(text: string): Promise<void>;
}

export interface DigestJobDependencies {
  readonly sources: DigestSources;
  readonly delivery: DigestDelivery;
  readonly clock: DigestClock;
  readonly timeZone: string;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deadlineSourceName(source: DeadlineSource): string {
  if (source.kind === "classroom") return "Google Classroom";
  if (source.kind === "brightspace") return "Brightspace";
  return "Manual deadlines";
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

  // Read every source before composing, and read them all even when the
  // first one fails. Short-circuiting would mean one broken source hides
  // whether the others are broken too.
  const [deadlines, deadlineSources, projects, decisions] = await Promise.all([
    readOr("Deadlines", () => dependencies.sources.readDeadlines(DEADLINE_HORIZON_DAYS), gaps),
    readOr("Deadline source health", () => dependencies.sources.readDeadlineSources(), gaps),
    readOr("Projects", () => dependencies.sources.readProjectStatuses(), gaps),
    readOr("Decision queue", () => dependencies.sources.readOpenDecisions(), gaps),
  ]);

  // Keep the last known deadlines visible while saying that their source is
  // stale. Dropping the deadlines would turn a sync fault into "nothing due".
  for (const source of deadlineSources) {
    if (!source.active || source.lastFailure === null) continue;
    // The stored label is source data. Gap source names are structural text in
    // the composer, so select a fixed label from the validated kind instead.
    gaps.push({ source: deadlineSourceName(source), detail: source.lastFailure });
  }

  // Staleness is derived here rather than stored, because "stale" is a
  // statement about now and a stored flag would be a statement about whenever
  // it was last written.
  const reports = new Map<string, ProjectStalenessReport>();
  try {
    const assess = dependencies.assess ?? assessStaleness;
    for (const report of assess(projects, { now: () => dependencies.clock.now() })) {
      reports.set(report.projectId, report);
    }
  } catch (error) {
    // The projects themselves still read fine; only the judgement about them
    // failed. Reporting the projects without it beats dropping both.
    gaps.push({ source: "Stalled-project detector", detail: describe(error) });
  }

  const input: DigestInput = {
    deadlines: deadlines.map(toDigestDeadline),
    projects: projects.map((status) => toDigestProject(status, reports.get(status.project.projectId))),
    decisions: decisions.map((item) => ({
      decisionId: item.decisionId,
      question: item.question,
      urgency: item.urgency,
    })),
    gaps,
  };

  return compose(input, { kind, timeZone: dependencies.timeZone }, dependencies.clock);
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

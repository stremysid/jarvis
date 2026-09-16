/**
 * Building the scheduled jobs. Hourly archival needs only the D1 and R2
 * bindings, so the hourly run exists even without GitHub configuration.
 * Project polling joins that run when configured. Installing its credential
 * after an hour was claimed takes effect at the next hourly firing.
 */

import type { Env } from "../env.js";
import { ArchivalService } from "../archive/archival-service.js";
import { ArchivalWorker } from "../archive/archival-worker.js";
import { ArchiveRepository } from "../archive/archive-repository.js";
import { ARCHIVE_SEGMENT_LIMITS } from "../archive/segment-codec.js";
import { TieredEventReader } from "../archive/tiered-event-reader.js";
import { ClassroomClient, ClassroomRequestError } from "../deadlines/classroom-client.js";
import {
  BRIGHTSPACE_WINDOW_ITEM_LIMIT,
  BrightspaceFeedError,
  BrightspaceIcalClient,
  type BrightspaceCalendarResult,
} from "../deadlines/brightspace-ical-client.js";
import { DeadlineIngestion, type DeadlineIngestionReport } from "../deadlines/deadline-ingestion.js";
import { DeadlineRepository } from "../deadlines/deadline-repository.js";
import { GoogleOAuthRequestError, GoogleOAuthTokenProvider } from "../deadlines/google-oauth.js";
import { DecisionRepository } from "../decisions/decision-repository.js";
import { DecisionService } from "../decisions/decision-service.js";
import { GitHubClient } from "../projects/github-client.js";
import { ProjectPoller } from "../projects/project-poller.js";
import { ProjectRepository } from "../projects/project-repository.js";
import {
  AUTOMATIC_DISTILLATION_STEP_LIMITS,
  AutomaticMemoryDistillationWorkflow,
} from "../memory/automatic-distillation.js";
import { MemoryRepository } from "../memory/memory-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import type { ModelProvider } from "../providers/provider-types.js";
import { TelegramRestProvider } from "../providers/telegram-provider.js";
import { ScheduledRunRepository } from "../scheduler/scheduled-run-repository.js";
import { SchoolCatchupRepository } from "../school/school-catchup-repository.js";
import { UniversityTrackerRepository } from "../university/university-tracker-repository.js";
import { StudyCoachRepository } from "../school/study-coach-repository.js";
import {
  runClassroomObservationSync,
  type ClassroomObservationSyncResult,
} from "../school/classroom-observation-sync.js";
import {
  D1StatementBudget,
  SchoolObservationRepository,
} from "../school/school-observation-repository.js";
import type { JobOutcome, JobTable } from "../scheduler/scheduled-handler.js";
import { D1GuestGrantNoticeSink } from "../voice/guest-grant-notice.js";
import { runDigestJob, unconfiguredDeadlineSourceKinds, type DigestDelivery } from "./digest-job.js";
import { D1GuestGrantNoticeDrainer, type GuestGrantNoticeDrainOutcome } from "./guest-grant-notice-drain.js";

export interface JobEnvironment {
  readonly env: Env;
  readonly clock: { now(): Date };
  readonly delivery: DigestDelivery;
  readonly fetcher: typeof fetch;
  /** Omitted in production until Sid approves a reviewed provider and cap. */
  readonly memoryDistillation?: Readonly<{
    provider: Pick<ModelProvider, "completeJson">;
    providerModelId: string;
  }>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const CLASSROOM_SOURCE_ID = "google-classroom";
const BRIGHTSPACE_SOURCE_ID = "brightspace-ical";
const BRIGHTSPACE_PAST_WINDOW_MS = 14 * 86_400_000;
const BRIGHTSPACE_FUTURE_WINDOW_MS = 120 * 86_400_000;
const BRIGHTSPACE_ON_DEMAND_JOB = "brightspace_on_demand";
const BRIGHTSPACE_ON_DEMAND_COOLDOWN_MS = 5 * 60_000;
const MEMORY_DISTILLATION_STEPS_PER_POLL = 8;
const MEMORY_DISTILLATION_WALL_CLOCK_BUDGET_MS = 4 * 60_000;
const MEMORY_DISTILLATION_D1_STATEMENT_ALLOWANCE = 1_000;

export interface SelectedBrightspaceWindow extends BrightspaceCalendarResult {
  readonly truncatedCount: number;
}

export type BrightspaceRefreshResult =
  | {
    readonly outcome: "refreshed";
    readonly detail: string;
    readonly report: DeadlineIngestionReport;
  }
  | {
    readonly outcome: "failed";
    readonly detail: string;
    readonly failure: string;
    readonly lastSuccessAt: string | null;
  }
  | {
    readonly outcome: "not_configured" | "inactive";
    readonly detail: string;
    readonly lastSuccessAt: string | null;
  };

export function classroomObservationDetail(observations: ClassroomObservationSyncResult): string {
  return observations.outcome === "failed"
    ? `grade/submission sync failed (${observations.failure ?? "school_observation_sync_failed"}); ${observations.undatedCoursework} undated coursework submissions skipped; ${observations.rejected} submission observations rejected`
    : `grade/submission ${observations.outcome} within its declared D1 statement budget; ${observations.undatedCoursework} undated coursework submissions skipped; ${observations.rejected} submission observations rejected`;
}

function classroomFailure(error: unknown): string {
  if (error instanceof ClassroomRequestError || error instanceof GoogleOAuthRequestError) return error.message;
  // External response bodies and credentials never belong in source health.
  // Unknown failures get a stable code rather than an arbitrary exception.
  return "classroom_ingestion_failed";
}

async function pollClassroom(context: JobEnvironment): Promise<string> {
  const credentials = [
    context.env.GOOGLE_CLIENT_ID,
    context.env.GOOGLE_CLIENT_SECRET,
    context.env.GOOGLE_REFRESH_TOKEN,
  ] as const;
  const repository = new DeadlineRepository(context.env.DB);
  if (credentials.every((value) => value === undefined)) {
    const existing = await repository.readSource(CLASSROOM_SOURCE_ID);
    if (existing === null) return "Classroom not configured";
    if (!existing.active) return "Classroom source inactive";
    await new DeadlineIngestion({ repository, now: () => context.clock.now() }).ingest(existing.sourceId, {
      kind: "failed",
      reason: "classroom_configuration_missing",
    });
    return "Classroom configuration missing";
  }

  const source = await repository.ensureSource({
    sourceId: CLASSROOM_SOURCE_ID,
    kind: "classroom",
    label: "Google Classroom",
    now: context.clock.now(),
  });
  const ingestion = new DeadlineIngestion({ repository, now: () => context.clock.now() });

  if (!source.active) return "Classroom source inactive";
  if (credentials.some((value) => value === undefined || value.length === 0)) {
    await ingestion.ingest(source.sourceId, { kind: "failed", reason: "classroom_configuration_incomplete" });
    return "Classroom configuration incomplete";
  }

  try {
    const tokens = new GoogleOAuthTokenProvider({
      credentials: {
        clientId: credentials[0] as string,
        clientSecret: credentials[1] as string,
        refreshToken: credentials[2] as string,
      },
      fetchImplementation: context.fetcher,
      now: () => context.clock.now(),
    });
    const client = new ClassroomClient({
      accessToken: () => tokens.getAccessToken(),
      fetchImplementation: context.fetcher,
      // Timed Classroom fields are UTC. The zone is used only to turn a
      // date-only assignment into the end of the owner's local school day.
      timeZone: context.env.DIGEST_TIMEZONE ?? "America/Toronto",
    });
    const courses = await client.listCourses();
    const collected = await client.collectDeadlineSweep(courses);
    const report = await ingestion.ingest(source.sourceId, {
      kind: "items",
      items: collected.items,
    });
    const seen = report.created.length + report.moved.length + report.unchanged;
    const principalId = context.env.OWNER_PRINCIPAL_ID;
    if (principalId === undefined) {
      return `Classroom ${seen} seen, ${report.rejected.length} rejected, ${report.disappeared.length} absent; grade/submission sync needs OWNER_PRINCIPAL_ID`;
    }
    const budget = new D1StatementBudget();
    const observations = await runClassroomObservationSync({
      repository: new SchoolObservationRepository(context.env.DB, budget),
      client,
      courses,
      principalId,
      sourceId: source.sourceId,
      budget,
      now: () => context.clock.now(),
      undatedDeadlineExternalIds: new Set(collected.undatedExternalIds),
      courseWorkMaxPoints: collected.courseWorkMaxPoints,
    });
    const observationDetail = classroomObservationDetail(observations);
    return `Classroom ${seen} seen, ${report.rejected.length} rejected, ${report.disappeared.length} absent; ${observationDetail}`;
  } catch (error) {
    const failure = classroomFailure(error);
    await ingestion.ingest(source.sourceId, { kind: "failed", reason: failure });
    return `Classroom failed (${failure})`;
  }
}

function brightspaceFailure(error: unknown): string {
  if (error instanceof BrightspaceFeedError) return error.message;
  return "brightspace_ingestion_failed";
}

export function selectBrightspaceWindow(
  result: BrightspaceCalendarResult,
  now: Date,
): SelectedBrightspaceWindow {
  const at = now.getTime();
  const inside = (dueAt: string): boolean => {
    const due = Date.parse(dueAt);
    return Number.isFinite(due)
      && due >= at - BRIGHTSPACE_PAST_WINDOW_MS
      && due < at + BRIGHTSPACE_FUTURE_WINDOW_MS;
  };
  const inWindowItems = result.items.filter((item) => inside(item.dueAt));
  const items = [...inWindowItems]
    .sort((left, right) => {
      const leftDue = Date.parse(left.dueAt);
      const rightDue = Date.parse(right.dueAt);
      const leftUpcoming = leftDue >= at;
      const rightUpcoming = rightDue >= at;
      if (leftUpcoming !== rightUpcoming) return leftUpcoming ? -1 : 1;
      if (leftDue !== rightDue) return leftUpcoming ? leftDue - rightDue : rightDue - leftDue;
      return left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0;
    })
    .slice(0, BRIGHTSPACE_WINDOW_ITEM_LIMIT);
  const inWindowCancelled = result.cancelled.filter((item) => inside(item.dueAt));
  const cancelled = [...inWindowCancelled]
    .sort((left, right) => {
      const leftDue = Date.parse(left.dueAt);
      const rightDue = Date.parse(right.dueAt);
      const distance = Math.abs(leftDue - at) - Math.abs(rightDue - at);
      if (distance !== 0) return distance;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0;
    })
    .slice(0, BRIGHTSPACE_WINDOW_ITEM_LIMIT);
  return Object.freeze({
    items: Object.freeze(items),
    cancelled: Object.freeze(cancelled),
    rejected: result.rejected,
    truncatedCount: inWindowItems.length - items.length + inWindowCancelled.length - cancelled.length,
  });
}

export async function refreshBrightspace(context: JobEnvironment): Promise<BrightspaceRefreshResult> {
  const repository = new DeadlineRepository(context.env.DB);
  const feedUrl = context.env.BRIGHTSPACE_ICAL_URL;
  if (feedUrl === undefined || feedUrl.length === 0) {
    const existing = await repository.readSource(BRIGHTSPACE_SOURCE_ID);
    if (existing === null) {
      return Object.freeze({ outcome: "not_configured", detail: "Brightspace not configured", lastSuccessAt: null });
    }
    if (!existing.active) {
      return Object.freeze({ outcome: "inactive", detail: "Brightspace source inactive", lastSuccessAt: existing.lastSuccessAt });
    }
    await new DeadlineIngestion({ repository, now: () => context.clock.now() }).ingest(existing.sourceId, {
      kind: "failed",
      reason: "brightspace_configuration_missing",
    });
    return Object.freeze({
      outcome: "not_configured",
      detail: "Brightspace configuration missing",
      lastSuccessAt: existing.lastSuccessAt,
    });
  }

  const source = await repository.ensureSource({
    sourceId: BRIGHTSPACE_SOURCE_ID,
    kind: "brightspace",
    label: "Brightspace",
    now: context.clock.now(),
  });
  if (!source.active) {
    return Object.freeze({ outcome: "inactive", detail: "Brightspace source inactive", lastSuccessAt: source.lastSuccessAt });
  }
  const ingestion = new DeadlineIngestion({ repository, now: () => context.clock.now() });
  try {
    const client = new BrightspaceIcalClient({
      feedUrl,
      timeZone: context.env.DIGEST_TIMEZONE ?? "America/Toronto",
      fetchImplementation: context.fetcher,
    });
    const collected = selectBrightspaceWindow(await client.collectDeadlines(), context.clock.now());
    const report = await ingestion.ingest(source.sourceId, {
      kind: "items",
      items: collected.items,
      cancelledExternalIds: collected.cancelled.map((item) => item.externalId),
      sourceRejectedCount: collected.rejected,
      sourceTruncatedCount: collected.truncatedCount,
    });
    const seen = report.created.length + report.moved.length + report.unchanged;
    const truncation = report.truncatedCount === 0 ? "" : `, ${report.truncatedCount} truncated`;
    return Object.freeze({
      outcome: "refreshed",
      detail: `Brightspace ${seen} seen, ${report.cancelled.length} cancelled, ${report.rejected.length} rejected${truncation}, ${report.disappeared.length} absent`,
      report,
    });
  } catch (error) {
    const failure = brightspaceFailure(error);
    await ingestion.ingest(source.sourceId, { kind: "failed", reason: failure });
    return Object.freeze({
      outcome: "failed",
      detail: `Brightspace failed (${failure})`,
      failure,
      lastSuccessAt: source.lastSuccessAt,
    });
  }
}

async function pollBrightspace(context: JobEnvironment): Promise<string> {
  return (await refreshBrightspace(context)).detail;
}

function replyTime(instant: string, timeZone: string): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return "an unreadable time";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(parsed);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Toronto",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(parsed);
  }
}

function lastKnownSnapshot(lastSuccessAt: string | null, timeZone: string): string {
  return lastSuccessAt === null
    ? "No last-known Brightspace snapshot is available."
    : `Showing the last-known Brightspace snapshot from ${replyTime(lastSuccessAt, timeZone)}.`;
}

/** Refresh the private feed from one owner Telegram turn, under a durable cooldown. */
export async function runOnDemandBrightspaceRefresh(context: JobEnvironment): Promise<string> {
  const observedAt = new Date(context.clock.now().getTime());
  const clock = { now: () => new Date(observedAt.getTime()) };
  const timeZone = context.env.DIGEST_TIMEZONE ?? "America/Toronto";
  let claim: { readonly job: string; readonly runKey: string } | null = null;
  let runs: ScheduledRunRepository | null = null;
  let repository: DeadlineRepository | null = null;
  let lastSuccessAt: string | null | undefined;
  try {
    repository = new DeadlineRepository(context.env.DB);
    const existing = await repository.readSource(BRIGHTSPACE_SOURCE_ID);
    lastSuccessAt = existing?.lastSuccessAt ?? null;
    const feedUrl = context.env.BRIGHTSPACE_ICAL_URL;
    if (feedUrl === undefined || feedUrl.length === 0) {
      return `Brightspace is not set up, so I made no feed request. ${lastKnownSnapshot(lastSuccessAt, timeZone)}`;
    }
    if (existing !== null && !existing.active) {
      return `Brightspace refresh is disabled, so I made no feed request. ${lastKnownSnapshot(existing.lastSuccessAt, timeZone)}`;
    }

    runs = new ScheduledRunRepository(context.env.DB, clock);
    claim = {
      job: BRIGHTSPACE_ON_DEMAND_JOB,
      runKey: observedAt.toISOString(),
    };
    const admitted = await runs.claimAfterCooldown(
      claim,
      new Date(observedAt.getTime() - BRIGHTSPACE_ON_DEMAND_COOLDOWN_MS),
    );
    if (admitted === null) {
      const current = await repository.readSource(BRIGHTSPACE_SOURCE_ID);
      lastSuccessAt = current?.lastSuccessAt ?? null;
      return `A Brightspace refresh was already requested in the last five minutes. ${lastKnownSnapshot(lastSuccessAt, timeZone)}`;
    }

    const result = await refreshBrightspace({ ...context, clock });
    try {
      await runs.finish(claim);
    } catch {
      try { await runs.fail(claim, "brightspace_run_finish_failed"); } catch { /* Source health and the reply still carry the outcome. */ }
    }
    if (result.outcome === "refreshed") {
      const seen = result.report.created.length + result.report.moved.length + result.report.unchanged;
      const bounded = result.report.truncatedCount === 0
        ? ""
        : ` The bounded sweep omitted ${result.report.truncatedCount} in-window entries.`;
      return `Brightspace refreshed at ${replyTime(result.report.observedAt, timeZone)}. Live feed items processed: ${seen}. Open deadlines cancelled: ${result.report.cancelled.length}. Source items rejected: ${result.report.rejected.length}.${bounded}`;
    }
    if (result.outcome === "failed") {
      return `Brightspace refresh failed (${result.failure}). ${lastKnownSnapshot(result.lastSuccessAt, timeZone)}`;
    }
    const setup = result.outcome === "inactive" ? "disabled" : "not set up";
    return `Brightspace is ${setup}, so I made no feed request. ${lastKnownSnapshot(result.lastSuccessAt, timeZone)}`;
  } catch {
    if (runs !== null && claim !== null) {
      try { await runs.fail(claim, "brightspace_ingestion_failed"); } catch { /* The reply remains the only available failure signal. */ }
    }
    if (repository !== null) {
      try {
        lastSuccessAt = (await repository.readSource(BRIGHTSPACE_SOURCE_ID))?.lastSuccessAt ?? null;
      } catch { /* The fixed reply below distinguishes an unreadable snapshot from an absent one. */ }
    }
    const snapshot = lastSuccessAt === undefined
      ? "I couldn't read the last-known Brightspace snapshot."
      : lastKnownSnapshot(lastSuccessAt, timeZone);
    return `Brightspace refresh failed (brightspace_ingestion_failed). ${snapshot}`;
  }
}

async function safeSourcePoll(
  label: string,
  failureCode: string,
  run: () => Promise<string>,
): Promise<string> {
  try {
    return await run();
  } catch {
    // Bootstrap and source-health writes can themselves fail. Keep the hourly
    // run moving so one D1/source fault does not skip every later poll.
    return `${label} failed (${failureCode})`;
  }
}

async function distilMemory(
  context: JobEnvironment,
  archive: ArchivalService,
): Promise<string> {
  const configured = context.memoryDistillation;
  if (configured === undefined) return "Memory distillation not configured";
  const principalId = context.env.OWNER_PRINCIPAL_ID;
  if (principalId === undefined) return "Memory distillation failed (owner_not_configured)";
  const live = new EventRepository(context.env.DB);
  const tiered = new TieredEventReader({
    live,
    archive,
    state: new ArchiveRepository(context.env.DB),
  });
  const workflow = new AutomaticMemoryDistillationWorkflow({
    database: context.env.DB,
    events: tiered,
    repository: new MemoryRepository(context.env.DB, {
      clock: () => context.clock.now(),
      archivedEventReader: archive,
    }),
    provider: configured.provider,
    providerModelId: configured.providerModelId,
    principalId,
    now: () => context.clock.now(),
  });
  const runKey = `memory-distill:${context.clock.now().toISOString().slice(0, 13)}`;
  const startedAt = context.clock.now().getTime();
  let createdItemCount = 0;
  let chargedD1Statements = 0;
  let skippedEventCount = 0;
  const skippedReasonCounts: Record<string, number> = {};
  let stepCount = 0;
  let stoppedByWallClock = false;
  let stoppedByD1Allowance = false;
  let stoppedByCursorStall = false;
  let lastResult: Awaited<ReturnType<AutomaticMemoryDistillationWorkflow["runNext"]>> | null = null;
  for (let step = 0; step < MEMORY_DISTILLATION_STEPS_PER_POLL; step += 1) {
    if (step > 0 && context.clock.now().getTime() - startedAt >= MEMORY_DISTILLATION_WALL_CLOCK_BUDGET_MS) {
      stoppedByWallClock = true;
      break;
    }
    if (step > 0
      && chargedD1Statements + AUTOMATIC_DISTILLATION_STEP_LIMITS.d1Statements
        > MEMORY_DISTILLATION_D1_STATEMENT_ALLOWANCE) {
      stoppedByD1Allowance = true;
      break;
    }
    const result = await workflow.runNext({ runKey: `${runKey}:${step}` });
    lastResult = result;
    stepCount += 1;
    createdItemCount += result.createdItemCount;
    chargedD1Statements += result.budget.d1Statements;
    skippedEventCount += result.skippedEventCount;
    for (const [reason, count] of Object.entries(result.skippedReasonCounts)) {
      skippedReasonCounts[reason] = (skippedReasonCounts[reason] ?? 0) + count;
    }
    if (result.backlogEventCount === 0) break;
    if (result.outcome !== "succeeded" && result.outcome !== "nothing_new") break;
    if (result.continuationRequired) continue;
    if (result.startEventSequence !== null && result.cursorEventSequence < result.startEventSequence) {
      stoppedByCursorStall = true;
      break;
    }
  }
  if (lastResult === null) throw new Error("memory_distillation_step_missing");
  const backlogUnit = lastResult.backlogEventCount === 1 ? "event" : "events";
  const eligibleUnit = lastResult.eligibleBacklogEventCount === 1 ? "eligible event" : "eligible events";
  const eligibleQualifier = lastResult.eligibleBacklogIsLowerBound ? "at least " : "";
  const skipUnit = skippedEventCount === 1 ? "skip" : "skips";
  const skipReasons = Object.entries(skippedReasonCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  const stepUnit = stepCount === 1 ? "step" : "steps";
  const stopReason = stoppedByWallClock
    ? ", wall-clock budget reached"
    : stoppedByD1Allowance
      ? ", D1 statement allowance reached"
      : stoppedByCursorStall
        ? ", cursor stalled"
        : "";
  const skipDetail = skipReasons.length === 0 ? "" : ` (${skipReasons})`;
  return `Memory ${lastResult.outcome}, ${createdItemCount} created, ${lastResult.backlogEventCount} ${backlogUnit} pending, ${eligibleQualifier}${lastResult.eligibleBacklogEventCount} ${eligibleUnit} pending, ${skippedEventCount} ${skipUnit}${skipDetail} after ${stepCount} ${stepUnit}${stopReason}`;
}

/**
 * The hourly reach-out.
 *
 * Archives one bounded segment, then performs the configuration-gated
 * Classroom and Brightspace sweeps before the optional project poll. Each
 * network source records its own failure without claiming the other work did
 * not run.
 */
async function poll(context: JobEnvironment): Promise<JobOutcome> {
  // Reuse the archive's retention, readback, sealing and purge checks unchanged.
  // A missing GitHub credential must not disable local D1-to-R2 maintenance.
  let archived: string;
  const archive = new ArchivalService({ database: context.env.DB, bucket: context.env.ARCHIVE });
  try {
    const segment = await new ArchivalWorker(archive).run(context.clock.now(), ARCHIVE_SEGMENT_LIMITS.maxEventCount);
    archived = segment === null ? "nothing eligible for archival" : `${segment.eventCount} archived`;
  } catch {
    archived = "archival failed (archive_operation_failed)";
  }
  const classroom = await safeSourcePoll("Classroom", "classroom_ingestion_failed", () => pollClassroom(context));
  const brightspace = await safeSourcePoll(
    "Brightspace",
    "brightspace_ingestion_failed",
    () => pollBrightspace(context),
  );
  const memory = await safeSourcePoll(
    "Memory distillation",
    "memory_distillation_failed",
    () => distilMemory(context, archive),
  );
  const sourceDetail = `${classroom}; ${brightspace}; ${memory}`;
  const token = context.env.GITHUB_TOKEN;
  if (token === undefined) return { ok: true, detail: `${archived}; ${sourceDetail}; project poll not configured` };

  const poller = new ProjectPoller({
    projects: new ProjectRepository(context.env.DB),
    source: new GitHubClient({ token, fetchImplementation: context.fetcher }),
    now: () => context.clock.now(),
  });

  const outcomes = await poller.pollActiveProjects();
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  // Reported as a detail, not a failure. One unreachable repository out of
  // six is a fact about that repository; failing the whole job would claim
  // the other five were not polled either.
  return failed.length === 0
    ? { ok: true, detail: `${archived}; ${sourceDetail}; ${outcomes.length} polled` }
    : { ok: true, detail: `${archived}; ${sourceDetail}; ${outcomes.length - failed.length} polled, ${failed.length} failed` };
}

async function digest(
  kind: "daily" | "retro",
  context: JobEnvironment,
): Promise<JobOutcome> {
  const principalId = context.env.OWNER_PRINCIPAL_ID;
  // Scheduled work has no request to derive an identity from. Picking a
  // principal out of the database and assuming it meant the owner is how a
  // digest ends up delivered to the wrong person.
  if (principalId === undefined) return { ok: false, failure: "OWNER_PRINCIPAL_ID is not set" };

  const deadlines = new DeadlineRepository(context.env.DB);
  const projects = new ProjectRepository(context.env.DB);
  const decisions = new DecisionService({
    repository: new DecisionRepository(context.env.DB),
    now: () => context.clock.now(),
  });
  const school = new SchoolCatchupRepository(context.env.DB);
  const university = new UniversityTrackerRepository(context.env.DB);
  const study = new StudyCoachRepository(context.env.DB);
  const observations = new SchoolObservationRepository(context.env.DB);
  const timeZone = context.env.DIGEST_TIMEZONE ?? "America/Toronto";

  const result = await runDigestJob(kind, {
    sources: {
      readCatchupActions: async (date) => school.listActionsForDate(principalId, date),
      readApplicationItems: async () => university.listApplicationItemsByDueDate(principalId),
      readWorkflowItems: async () => university.listWorkflowItemsByDueDate(principalId),
      claimStudyCheckIn: async (date, weekday, minuteOfDay) => {
        const now = context.clock.now();
        const [schoolSignals, deadlineSignals] = await Promise.all([
          observations.readStudySnapshot({ principalId, now }),
          deadlines.listStudyCandidates(now),
        ]);
        return study.syncAndClaimDigestCheckIn({
          principalId, today: date, weekday, minuteOfDay, now,
          signalInputs: { observations: schoolSignals, deadlines: deadlineSignals },
        });
      },
      readDeadlines: async (withinDays) =>
        deadlines.listDueWithin({
          from: context.clock.now(),
          to: new Date(context.clock.now().getTime() + withinDays * 86_400_000),
        }),
      readDeadlineSources: async () => deadlines.listSources(),
      readSchoolObservations: async () => {
        const now = new Date(context.clock.now().getTime());
        return observations.readDigestSnapshot({
          principalId,
          sourceId: CLASSROOM_SOURCE_ID,
          changedSince: new Date(now.getTime() - 7 * 86_400_000),
          now,
        });
      },
      readProjectStatuses: async () => projects.readActiveProjectStatuses(),
      readOpenDecisions: async () => decisions.queue(principalId),
    },
    delivery: context.delivery,
    clock: context.clock,
    timeZone,
    unconfiguredDeadlineSourceKinds: unconfiguredDeadlineSourceKinds(context.env),
  });

  return { ok: true, detail: result.gaps === 0 ? "sent" : `sent with ${result.gaps} gaps` };
}

/**
 * The frequent tick.
 *
 * It exists as a job rather than being folded into the poll because the two
 * cadences differ by an order of magnitude, and work that is already owed
 * should not wait an hour behind work that reaches the network.
 *
 * Today it only counts the open queue, which is a liveness signal and
 * nothing more: it proves D1 is reachable and the decision tables are
 * readable every five minutes. It does NOT yet expire lapsed items --
 * `listOpenQueue` filters them out of the queue, but nothing moves their
 * status to `expired`, so `answer` still refuses them on the delivered/open
 * check rather than on expiry. Sweeping them is the next thing this job
 * should do.
 */
async function drain(context: JobEnvironment): Promise<JobOutcome> {
  const principalId = context.env.OWNER_PRINCIPAL_ID;
  if (principalId === undefined) return { ok: false, failure: "OWNER_PRINCIPAL_ID is not set" };
  try {
    const noticeDetail: GuestGrantNoticeDrainOutcome | "not_configured" = context.env.TELEGRAM_BOT_TOKEN === undefined
      ? "not_configured"
      : await new D1GuestGrantNoticeDrainer(
        context.env.DB,
        new D1GuestGrantNoticeSink(context.env.DB, new TelegramRestProvider({
          botToken: context.env.TELEGRAM_BOT_TOKEN,
          fetchImplementation: context.fetcher,
        })),
        context.clock,
      ).run();
    const open = await new DecisionService({
      repository: new DecisionRepository(context.env.DB),
      now: () => context.clock.now(),
    }).queue(principalId);
    const notices: Readonly<Record<typeof noticeDetail, string>> = {
      not_configured: "guest notices not configured",
      completed: "guest notice drain completed",
      delivery_deferred: "guest notice delivery deferred and retained for retry",
      already_running: "guest notice drain already running",
      expired_run_recovered: "expired guest notice drain moved to failed for retry",
    };
    return { ok: true, detail: `${open.length} open; ${notices[noticeDetail]}` };
  } catch (error) {
    return { ok: false, failure: describe(error) };
  }
}

export function buildJobTable(context: JobEnvironment): JobTable {
  const jobs: Record<string, () => Promise<JobOutcome>> = {
    drain: () => drain(context),
    digest: () => digest("daily", context),
    retro: () => digest("retro", context),
    poll: () => poll(context),
  };
  return jobs as JobTable;
}

export function buildScheduledRuns(context: JobEnvironment): ScheduledRunRepository {
  return new ScheduledRunRepository(context.env.DB, context.clock);
}

/**
 * The concrete data behind the three reporting command tools.
 *
 * These used to be slash-command handlers (`/status`, `/queue`, `/digest`)
 * that ran instead of the model. The model now reaches the same data through
 * `owner_status`, `decision_queue` and `run_digest`, so the words "status",
 * "queue" and "digest" reach the model and it decides what to say. Nothing
 * here judges: it reads what is stored and returns it.
 *
 * Both channels build this from the same environment, which is what makes the
 * capabilities identical on Telegram and on a call.
 */

import { AutonomyRepository } from "../autonomy/autonomy-repository.js";
import type { AutonomyMode } from "../autonomy/autonomy-types.js";
import { DeadlineRepository } from "../deadlines/deadline-repository.js";
import { DecisionRepository } from "../decisions/decision-repository.js";
import { DecisionService } from "../decisions/decision-service.js";
import type { DecisionItem } from "../decisions/decision-types.js";
import { assembleDigest, expectedPushSources, unconfiguredDeadlineSources } from "../jobs/digest-job.js";
import { CLASSROOM_SOURCE_ID, buildScheduledRuns } from "../jobs/job-table.js";
import type { ScheduledRunRecord } from "../scheduler/scheduled-run-repository.js";
import { readMemoryMeaningCoverage } from "../memory/meaning-search.js";
import { ProjectRepository } from "../projects/project-repository.js";
import { SchoolCatchupRepository } from "../school/school-catchup-repository.js";
import { SchoolCollectorRepository } from "../school/collector-repository.js";
import { SchoolObservationRepository } from "../school/school-observation-repository.js";
import { StudyCoachRepository } from "../school/study-coach-repository.js";
import { UniversityTrackerRepository } from "../university/university-tracker-repository.js";
import type { Env } from "../env.js";

/** What the model can ask code to read for it. */
export interface OwnerCommandCapabilities {
  /** A short report of autonomy, scheduled jobs and memory index coverage. */
  status(): Promise<string>;
  /** Everything still waiting on the owner, in the queue's own order. */
  queue(): Promise<readonly DecisionItem[]>;
  /** Assemble today's digest now, without sending it. */
  digest(): Promise<string>;
}

/** One job and its last recorded run, or null when it has never run. */
export interface OwnerStatusJob {
  readonly job: string;
  readonly last: ScheduledRunRecord | null;
}

export interface OwnerStatusSummary {
  readonly mode: { readonly mode: AutonomyMode; readonly enteredAt: string };
  readonly jobs: readonly OwnerStatusJob[];
  readonly coverage: { readonly eligible: number; readonly indexed: number; readonly missing: number };
}

/**
 * The status lines, pure and testable. The reporting rules are deliberately
 * explicit: never-run is not failed, a not-measured run is not ok, a degraded
 * run keeps its detail, and a started-never-finished run is its own state.
 */
export function formatOwnerStatus(summary: OwnerStatusSummary): string {
  const lines: string[] = [];
  lines.push(
    summary.mode.mode === "shadow"
      ? `Autonomy: shadow since ${summary.mode.enteredAt.slice(0, 10)} (reporting, not acting)`
      : `Autonomy: live since ${summary.mode.enteredAt.slice(0, 10)}`,
  );
  for (const { job, last } of summary.jobs) {
    if (last === null) {
      lines.push(`${job}: never run`);
      continue;
    }
    const tail = last.detail === null || last.detail.length === 0 ? "" : ` -- ${last.detail}`;
    if (last.failure !== null) {
      lines.push(`${job}: FAILED at ${last.startedAt.slice(11, 16)} -- ${last.failure}`);
    } else if (last.finishedAt === null) {
      lines.push(`${job}: started ${last.startedAt.slice(11, 16)}, never finished`);
    } else if (last.completion === "not_measured") {
      lines.push(`${job}: NOT SET UP at ${last.finishedAt.slice(11, 16)}${tail}`);
    } else if (last.completion === "degraded") {
      lines.push(`${job}: ok with caveat at ${last.finishedAt.slice(11, 16)}${tail}`);
    } else {
      lines.push(`${job}: ok at ${last.finishedAt.slice(11, 16)}${tail}`);
    }
  }
  const { indexed, eligible, missing } = summary.coverage;
  lines.push(`Memory meaning: ${indexed}/${eligible} indexed (${missing} missing)`);
  return lines.join("\n");
}

export function createOwnerCommandCapabilities(
  env: Env,
  principalId: string,
  now: () => Date = () => new Date(),
): OwnerCommandCapabilities {
  const deadlines = new DeadlineRepository(env.DB);
  const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now });

  async function status(): Promise<string> {
    const autonomy = new AutonomyRepository(env.DB);
    const mode = await autonomy.readMode();

    // The job list comes from the deployment, not from a literal here.
    const scheduler = buildScheduledRuns({
      env,
      clock: { now },
      delivery: { send: async () => undefined },
      fetcher: globalThis.fetch.bind(globalThis),
    });
    const jobs: OwnerStatusJob[] = [];
    for (const job of scheduler.jobs()) {
      const [last] = await scheduler.recent(job, 1);
      jobs.push({ job, last: last ?? null });
    }

    const coverage = await readMemoryMeaningCoverage(env.DB, principalId, now());
    return formatOwnerStatus({ mode, jobs, coverage });
  }

  return Object.freeze({
    status,
    queue: () => decisions.queue(principalId),
    // The digest is assembled but NOT sent: the model relays it in its reply,
    // and sending it separately would deliver it twice.
    digest: async () => {
      const digest = await assembleDigest("daily", {
        sources: {
          readCatchupActions: async (date) =>
            new SchoolCatchupRepository(env.DB).listActionsForDate(principalId, date),
          readApplicationItems: async () =>
            new UniversityTrackerRepository(env.DB).listApplicationItemsByDueDate(principalId),
          readWorkflowItems: async () =>
            new UniversityTrackerRepository(env.DB).listWorkflowItemsByDueDate(principalId),
          claimStudyCheckIn: async (date, weekday, minuteOfDay) => {
            const study = new StudyCoachRepository(env.DB);
            const instant = now();
            const [schoolSignals, deadlineSignals] = await Promise.all([
              new SchoolObservationRepository(env.DB).readStudySnapshot({ principalId, now: instant }),
              deadlines.listStudyCandidates(instant),
            ]);
            return study.syncAndClaimDigestCheckIn({
              principalId, today: date, weekday, minuteOfDay, now: instant,
              signalInputs: { observations: schoolSignals, deadlines: deadlineSignals },
            });
          },
          readDeadlines: async (withinDays) =>
            deadlines.listDueWithin({
              from: now(),
              to: new Date(now().getTime() + withinDays * 86_400_000),
            }),
          readDeadlineSources: async () => deadlines.listSources(),
          readD2lStatus: () => new SchoolCollectorRepository(env.DB, principalId, now).status({ limit: 1 }),
          readSchoolObservations: async () => {
            const instant = new Date(now().getTime());
            return new SchoolObservationRepository(env.DB).readDigestSnapshot({
              principalId,
              sourceId: CLASSROOM_SOURCE_ID,
              changedSince: new Date(instant.getTime() - 7 * 86_400_000),
              now: instant,
            });
          },
          readProjectStatuses: async () => new ProjectRepository(env.DB).readActiveProjectStatuses(),
          readOpenDecisions: async () =>
            new DecisionService({ repository: new DecisionRepository(env.DB) }).queue(principalId),
        },
        delivery: { send: async () => undefined },
        clock: { now },
        timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
        unconfiguredDeadlineSources: unconfiguredDeadlineSources(env),
        expectedPushSources: expectedPushSources(env),
      });
      return digest.text;
    },
  });
}

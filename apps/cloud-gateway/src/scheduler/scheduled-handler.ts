/**
 * Running what a cron firing asked for.
 *
 * The handler is deliberately thin and knows nothing about digests, polling
 * or deadlines. It does four things in an order that matters:
 *
 *   route the cron -> claim the run -> run the job -> record the outcome
 *
 * and then, only if something actually ran, reports a heartbeat.
 *
 * The ordering is the substance. Claiming before running is what makes an
 * at-least-once trigger safe. Heartbeating after running is what stops the
 * watchdog being told "alive" for an invocation that then failed -- a
 * heartbeat sent first converts "I would have noticed" into "I was told it
 * was fine", which is the one failure a watchdog cannot recover from.
 *
 * Jobs are injected rather than imported. That keeps this file from being the
 * place every subsystem meets, and lets the ordering above be tested without
 * a GitHub token, a Google account or a Telegram bot.
 */

import { routeCron, type ScheduledJob } from "./cron-router.js";
import {
  reportHeartbeat,
  type HeartbeatConfiguration,
  type HeartbeatOutcome,
} from "./heartbeat-reporter.js";
import type { RunClaim, ScheduledRunRepository } from "./scheduled-run-repository.js";

/** The gateway's own name in the watchdog's liveness table. */
export const COMPONENT = "cloud-gateway";

/**
 * How long silence from the gateway is normal.
 *
 * Fifteen minutes, not five. The frequent tick runs every five, so a
 * threshold of five alarms on the first missed beat -- and a single missed
 * beat is a retryable blip, not an outage. Three missed ticks is a pattern.
 */
export const EXPECTED_INTERVAL_SECONDS = 900;

/**
 * What a job reports.
 *
 * `notMeasured` is a third answer, not a flavour of the other two. It is for a
 * job that is wired up but holds nothing to run with -- the credential or the
 * binding it needs was never installed -- so it reached the end without doing
 * any of its work.
 *
 * It must not be `ok: true`. That recorded a successful run, reported `ok` on
 * `/status`, and sent the watchdog a healthy heartbeat for a job that had
 * measured nothing; the same defect the handler already refuses for a job the
 * table does not contain at all. Silence and success must not look the same,
 * and a job nobody set up is the loudest kind of silence.
 *
 * It must not be `ok: false` either. Nothing is broken, and recording it as a
 * failure would make a fresh deployment look like an outage.
 */
export type JobOutcome =
  | { ok: true; detail?: string; degraded?: true }
  | { ok: false; failure: string }
  | { notMeasured: true; detail: string };

/**
 * Narrowing by hand.
 *
 * `"notMeasured" in outcome` does not discriminate this union, and neither
 * does `outcome.ok`: the not-measured member has no `ok` property at all, so
 * testing it leaves every member that could carry `ok` still in play.
 */
export function isNotMeasured(
  outcome: JobOutcome,
): outcome is { notMeasured: true; detail: string } {
  return "notMeasured" in outcome;
}

export function isFailure(
  outcome: JobOutcome,
): outcome is { ok: false; failure: string } {
  return "ok" in outcome && outcome.ok === false;
}

export function isSuccess(
  outcome: JobOutcome,
): outcome is { ok: true; detail?: string; degraded?: true } {
  return "ok" in outcome && outcome.ok === true;
}

/**
 * Every job key the table is allowed to hold.
 *
 * `Partial` because a deployment may hand the handler a table missing a job,
 * which `runOne` reports as `skipped_unconfigured`.
 */
export type JobTable = Readonly<Partial<Record<ScheduledJob, () => Promise<JobOutcome>>>>;

export interface ScheduledDependencies {
  readonly runs: ScheduledRunRepository;
  readonly jobs: JobTable;
  readonly timeZone: string;
  readonly heartbeat: HeartbeatConfiguration | null;
  readonly fetcher: typeof fetch;
}

export interface JobReport {
  readonly job: ScheduledJob;
  readonly runKey: string;
  readonly result: "ran" | "skipped_duplicate" | "skipped_unconfigured" | "not_measured" | "failed";
  readonly detail?: string;
}

export interface ScheduledReport {
  readonly cron: string;
  readonly jobs: readonly JobReport[];
  readonly heartbeat: HeartbeatOutcome | null;
}

async function runOne(
  job: ScheduledJob,
  runKey: string,
  dependencies: ScheduledDependencies,
): Promise<JobReport> {
  const run = dependencies.jobs[job];
  // A job the deployment has not configured -- no GitHub token, no Google
  // account -- is skipped WITHOUT claiming its key. Claiming it would record
  // the hour as done and stop the poll from ever running once the credential
  // arrives.
  if (run === undefined) return { job, runKey, result: "skipped_unconfigured" };

  const claim: RunClaim = { job, runKey };
  const claimed = await dependencies.runs.claim(claim);
  if (claimed === null) return { job, runKey, result: "skipped_duplicate" };

  let outcome: JobOutcome;
  try {
    outcome = await run();
  } catch (error) {
    // A job that throws is a failed run, not a failed invocation. Letting it
    // propagate would abandon the claim in flight and skip every job after it
    // in the same firing.
    outcome = { ok: false, failure: error instanceof Error ? error.message : String(error) };
  }

  if (isNotMeasured(outcome)) {
    // Recorded, not silently dropped. The run happened and `/status` should
    // say which firing found nothing set up -- but the row carries no
    // heartbeat and no success, because neither was earned.
    try {
      await dependencies.runs.finish(claim, "not_measured", outcome.detail);
    } catch {
      // Bookkeeping may fail for the same reason the job held no
      // configuration. The report still carries the fact.
    }
    return { job, runKey, result: "not_measured", detail: outcome.detail };
  }

  if (outcome.ok) {
    // `finish` may throw. That propagates, exactly as it did when the run was
    // recorded without a detail: the claim is then left unfinished, which is
    // the honest state for a run whose outcome could not be written down.
    await dependencies.runs.finish(claim, outcome.degraded === true ? "degraded" : "ok", outcome.detail);
    return { job, runKey, result: "ran", ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) };
  }

  // Recording the failure is itself allowed to fail -- D1 may be the reason
  // the job failed in the first place. The report still says what happened,
  // which is the part the operator reads.
  try {
    await dependencies.runs.fail(claim, outcome.failure);
  } catch {
    // Deliberately swallowed. There is no third place to write this, and
    // throwing here would replace a job failure with a bookkeeping failure.
  }
  return { job, runKey, result: "failed", detail: outcome.failure };
}

export async function handleScheduled(
  cron: string,
  instant: Date,
  dependencies: ScheduledDependencies,
): Promise<ScheduledReport> {
  const work = routeCron(cron, instant, dependencies.timeZone);
  const reports: JobReport[] = [];

  // Sequential, not concurrent. These jobs share one D1 database and a
  // Worker's CPU budget, and two of them contending is a slower way to do the
  // same work. Sunday night deliberately sends the retro before starting the
  // bounded backup step so owner-facing delivery is not delayed by R2 work.
  for (const item of work) {
    reports.push(await runOne(item.job, item.runKey, dependencies));
  }

  // A firing that routed to nothing -- the half of the daily pair that landed
  // on the wrong local hour -- does not heartbeat. It proves the cron fired,
  // not that the Worker can do its work, and a Worker whose every job is
  // failing would otherwise look healthy on the strength of its no-ops.
  //
  // A job that ran without its configuration is excluded for the same reason
  // and a sharper one: it reached the end of its body having done nothing, so
  // a heartbeat from it would attest to liveness the firing never
  // demonstrated. That is the failure mode a watchdog cannot recover from --
  // being told everything is fine by the thing that is not running.
  const ran = reports.some((report) => report.result === "ran");
  const heartbeat = ran
    ? await reportHeartbeat(
        {
          component: COMPONENT,
          expectedIntervalSeconds: EXPECTED_INTERVAL_SECONDS,
          detail: reports.filter((report) => report.result === "ran").map((report) => report.job).join(","),
        },
        dependencies.heartbeat,
        dependencies.fetcher,
      )
    : null;

  return { cron, jobs: reports, heartbeat };
}

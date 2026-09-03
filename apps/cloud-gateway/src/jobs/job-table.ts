/**
 * Building the scheduled jobs this deployment can actually run.
 *
 * A job is present only when its credentials are. That is not defensive
 * coding: the scheduled handler skips a missing job WITHOUT claiming its run
 * key, so a deployment that has no GitHub token yet will poll properly the
 * first hour after the token arrives. A job that existed but failed would
 * have claimed the key and recorded the hour as done.
 *
 * The digest is the exception in one direction: it needs no third-party
 * credential beyond Telegram, so it runs from the first deploy and reports
 * whatever it can read, naming whatever it cannot.
 */

import type { Env } from "../env.js";
import { DeadlineRepository } from "../deadlines/deadline-repository.js";
import { DecisionRepository } from "../decisions/decision-repository.js";
import { DecisionService } from "../decisions/decision-service.js";
import { GitHubClient } from "../projects/github-client.js";
import { ProjectPoller } from "../projects/project-poller.js";
import { ProjectRepository } from "../projects/project-repository.js";
import { ScheduledRunRepository } from "../scheduler/scheduled-run-repository.js";
import type { JobOutcome, JobTable } from "../scheduler/scheduled-handler.js";
import { runDigestJob, type DigestDelivery } from "./digest-job.js";

export interface JobEnvironment {
  readonly env: Env;
  readonly clock: { now(): Date };
  readonly delivery: DigestDelivery;
  readonly fetcher: typeof fetch;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The hourly reach-out.
 *
 * Only the project poll today. The Classroom sweep belongs in this same job
 * -- same cadence, same run key, same "reach out to other people's systems"
 * shape -- and is not wired in because it needs the Google OAuth credentials
 * that no deployment holds yet. `deadline_sources` therefore has nothing
 * writing to it, which means the deadline half of the digest is empty rather
 * than stale.
 */
async function poll(context: JobEnvironment): Promise<JobOutcome> {
  const token = context.env.GITHUB_TOKEN;
  if (token === undefined) return { ok: false, failure: "GITHUB_TOKEN is not set" };

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
    ? { ok: true, detail: `${outcomes.length} polled` }
    : { ok: true, detail: `${outcomes.length - failed.length} polled, ${failed.length} failed` };
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

  const result = await runDigestJob(kind, {
    sources: {
      readDeadlines: async (withinDays) =>
        deadlines.listDueWithin({
          from: context.clock.now(),
          to: new Date(context.clock.now().getTime() + withinDays * 86_400_000),
        }),
      readProjectStatuses: async () => projects.readActiveProjectStatuses(),
      readOpenDecisions: async () => decisions.queue(principalId),
    },
    delivery: context.delivery,
    clock: context.clock,
    timeZone: context.env.DIGEST_TIMEZONE ?? "America/Toronto",
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
    const open = await new DecisionService({
      repository: new DecisionRepository(context.env.DB),
      now: () => context.clock.now(),
    }).queue(principalId);
    return { ok: true, detail: `${open.length} open` };
  } catch (error) {
    return { ok: false, failure: describe(error) };
  }
}

export function buildJobTable(context: JobEnvironment): JobTable {
  const jobs: Record<string, () => Promise<JobOutcome>> = {
    drain: () => drain(context),
    digest: () => digest("daily", context),
    retro: () => digest("retro", context),
  };
  // Omitted rather than present-and-failing when there is no token, so the
  // hour is not claimed and the first poll after the token arrives runs.
  if (context.env.GITHUB_TOKEN !== undefined) jobs["poll"] = () => poll(context);
  return jobs as JobTable;
}

export function buildScheduledRuns(context: JobEnvironment): ScheduledRunRepository {
  return new ScheduledRunRepository(context.env.DB, context.clock);
}

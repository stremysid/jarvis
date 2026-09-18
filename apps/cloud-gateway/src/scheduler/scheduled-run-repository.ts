/**
 * Claiming a scheduled run, so an at-least-once trigger does the work once.
 *
 * Cloudflare re-invokes a cron handler after a transient failure with the same
 * cron expression. Without a claim, a retry twenty minutes into the morning
 * sends a second digest, and -- worse -- a retried poll writes a second
 * observation, which is not a duplicate record but a fabricated data point.
 *
 * The claim is the insert itself. `ON CONFLICT DO NOTHING` plus a check of
 * how many rows were written is atomic in a way that reading first and then
 * inserting is not: two isolates handling the same firing would both read
 * "not yet run" and both proceed.
 */

import { SCHEDULED_JOB_NAMES, type ScheduledJob } from "./cron-router.js";

export interface ScheduledRunClock {
  now(): Date;
}

export interface RunClaim {
  readonly job: string;
  readonly runKey: string;
}

export interface ClaimedRun extends RunClaim {
  readonly startedAt: string;
}

/** Kept short. These are status fields, not somewhere to store a stack trace. */
const MAX_FAILURE_CHARACTERS = 512;
const MAX_DETAIL_CHARACTERS = 512;

/**
 * How a run finished, when it finished without failing.
 *
 * These are three different facts and the owner acts differently on each:
 *
 *  - `ok`      the job did its work and reported nothing to worry about.
 *  - `degraded` the job did its work, and part of what it is responsible for
 *               was skipped or unconfigured. It is not a failure, and it is
 *               not a clean success either.
 *  - `not_measured` the job reached the end of its body having done nothing,
 *               because the credential or binding it needs was never
 *               installed. No work happened, so nothing was measured.
 *
 * The third used to be recorded as `ok`, which put a healthy heartbeat behind
 * a job that had not run and printed `ok` on `/status` for it.
 */
export type RunCompletion = "ok" | "degraded" | "not_measured";

/**
 * `detail` is one TEXT column, so the completion travels with it.
 *
 * A prefix rather than a second column: the migration stays additive, and an
 * older binary reading this row still sees a plain detail string.
 *
 * Plain words rather than a control character. The column is capped, and a
 * marker that can be sliced in half is worse than no marker -- the row would
 * silently decode as a clean success, which is the defect this exists to fix.
 *
 * The cost of that choice is that a clean success whose own detail began with
 * one of these literals would decode as the other state. Every detail is
 * written by a job in this repository and none opens with these words; the
 * alternative is a marker that truncation can destroy.
 */
const DEGRADED_PREFIX = "degraded: ";
const NOT_MEASURED_PREFIX = "not measured: ";

function encodeDetail(completion: RunCompletion, detail: string | undefined): string | null {
  if (detail === undefined || detail.length === 0) return null;
  const prefix = completion === "degraded" ? DEGRADED_PREFIX : completion === "not_measured" ? NOT_MEASURED_PREFIX : "";
  // Strip the marker before trimming, so the cap can never cut one in half.
  return `${prefix}${detail}`.slice(0, MAX_DETAIL_CHARACTERS - prefix.length);
}

/** Reads back what `encodeDetail` wrote. A plain string is a plain success. */
function decodeDetail(raw: string | null): Readonly<{ completion: RunCompletion; detail: string | null }> {
  if (raw === null) return { completion: "ok", detail: null };
  if (raw.startsWith(NOT_MEASURED_PREFIX)) {
    return { completion: "not_measured", detail: raw.slice(NOT_MEASURED_PREFIX.length) };
  }
  if (raw.startsWith(DEGRADED_PREFIX)) {
    return { completion: "degraded", detail: raw.slice(DEGRADED_PREFIX.length) };
  }
  return { completion: "ok", detail: raw };
}

/** One recorded run, as the status endpoint reads it. */
export interface ScheduledRunRecord {
  readonly runKey: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly failure: string | null;
  /**
   * What a SUCCESSFUL run reported about itself. Null for a clean success, a
   * failure, and a run that has not finished.
   */
  readonly detail: string | null;
  /** How the run finished. `ok` for anything that failed or never finished. */
  readonly completion: RunCompletion;
}

export class ScheduledRunRepository {
  readonly #database: D1Database;
  readonly #clock: ScheduledRunClock;

  constructor(database: D1Database, clock: ScheduledRunClock) {
    this.#database = database;
    this.#clock = clock;
  }

  /**
   * The job names this deployment schedules.
   *
   * Carried here because the status command already holds this repository and
   * nothing else that knows what exists. `/status` used to name three jobs in
   * its own source; a job outside that list was invisible to the owner no
   * matter how badly it was failing.
   */
  jobs(): readonly ScheduledJob[] {
    return SCHEDULED_JOB_NAMES;
  }

  /**
   * Take the run, or report that someone already has it.
   *
   * A previous run that FAILED is deliberately not reclaimable here. Retrying
   * it would need to know whether the failure left partial work behind, and
   * that is a decision for the job, not for the claim. `reopen` exists for
   * when a job can answer it.
   */
  async claim(claim: RunClaim): Promise<ClaimedRun | null> {
    const startedAt = this.#clock.now().toISOString();
    const result = await this.#database
      .prepare(
        `INSERT INTO scheduled_runs (job, run_key, started_at)
         VALUES (?, ?, ?)
         ON CONFLICT (job, run_key) DO NOTHING`,
      )
      .bind(claim.job, claim.runKey, startedAt)
      .run();

    // `meta.changes` is 0 when the conflict clause swallowed the insert, which
    // is exactly the "someone already has it" signal.
    if ((result.meta.changes ?? 0) === 0) return null;
    return { ...claim, startedAt };
  }

  /** Atomically admits one run only when this job has been quiet since the supplied instant. */
  async claimAfterCooldown(claim: RunClaim, notBefore: Date): Promise<ClaimedRun | null> {
    const startedAt = this.#clock.now().toISOString();
    const earliest = new Date(notBefore.getTime()).toISOString();
    const result = await this.#database
      .prepare(
        `INSERT INTO scheduled_runs (job, run_key, started_at)
         SELECT ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM scheduled_runs WHERE job = ? AND started_at > ?
         )
         ON CONFLICT (job, run_key) DO NOTHING`,
      )
      .bind(claim.job, claim.runKey, startedAt, claim.job, earliest)
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return { ...claim, startedAt };
  }

  /**
   * Mark a claimed run finished. Called only on the path that claimed it.
   *
   * `completion` and `detail` are what the job reported on the way out.
   * Recording them is the point of the column: a job that reached the end
   * while saying something was missing is neither a clean success nor a
   * failure, and losing the sentence -- or the difference between "ran with a
   * caveat" and "did not run" -- makes those indistinguishable on the next
   * `/status`.
   */
  async finish(claim: RunClaim, completion: RunCompletion = "ok", detail?: string): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE scheduled_runs SET finished_at = ?, failure = NULL, detail = ?
         WHERE job = ? AND run_key = ?`,
      )
      .bind(
        this.#clock.now().toISOString(),
        encodeDetail(completion, detail),
        claim.job,
        claim.runKey,
      )
      .run();
  }

  /**
   * Record that a claimed run failed.
   *
   * The row keeps its claim. A failed run stays claimed so the next firing
   * does not silently repeat work whose side effects are unknown -- the
   * failure is visible instead, which is the outcome worth having.
   *
   * `detail` is cleared rather than left behind. It describes a success, and a
   * run that failed must not keep reporting the health of the one before it.
   */
  async fail(claim: RunClaim, failure: string): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE scheduled_runs SET finished_at = ?, failure = ?, detail = NULL
         WHERE job = ? AND run_key = ?`,
      )
      .bind(
        this.#clock.now().toISOString(),
        failure.slice(0, MAX_FAILURE_CHARACTERS),
        claim.job,
        claim.runKey,
      )
      .run();
  }

  /**
   * Release a failed run so it can be claimed again.
   *
   * Separate from `fail` and never automatic: only a job that knows its work
   * is idempotent, or that its failure happened before anything was written,
   * may ask for this. Deleting the row is right rather than clearing the
   * failure, because the claim IS the row.
   */
  async reopen(claim: RunClaim): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `DELETE FROM scheduled_runs
         WHERE job = ? AND run_key = ? AND failure IS NOT NULL`,
      )
      .bind(claim.job, claim.runKey)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** The most recent runs of a job, newest first. For the status endpoint. */
  async recent(job: string, limit: number): Promise<readonly ScheduledRunRecord[]> {
    const { results } = await this.#database
      .prepare(
        `SELECT run_key, started_at, finished_at, failure, detail
         FROM scheduled_runs WHERE job = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .bind(job, limit)
      .all<{
        run_key: string;
        started_at: string;
        finished_at: string | null;
        failure: string | null;
        detail: string | null;
      }>();
    return results.map((row) => {
      const decoded = decodeDetail(row.detail);
      return {
        runKey: row.run_key,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        failure: row.failure,
        detail: decoded.detail,
        completion: decoded.completion,
      };
    });
  }
}

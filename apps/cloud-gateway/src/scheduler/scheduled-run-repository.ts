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

/** Kept short. This is a status field, not a place to store a stack trace. */
const MAX_FAILURE_CHARACTERS = 512;

export class ScheduledRunRepository {
  readonly #database: D1Database;
  readonly #clock: ScheduledRunClock;

  constructor(database: D1Database, clock: ScheduledRunClock) {
    this.#database = database;
    this.#clock = clock;
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

  /** Mark a claimed run finished. Called only on the path that claimed it. */
  async finish(claim: RunClaim): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE scheduled_runs SET finished_at = ?, failure = NULL
         WHERE job = ? AND run_key = ?`,
      )
      .bind(this.#clock.now().toISOString(), claim.job, claim.runKey)
      .run();
  }

  /**
   * Record that a claimed run failed.
   *
   * The row keeps its claim. A failed run stays claimed so the next firing
   * does not silently repeat work whose side effects are unknown -- the
   * failure is visible instead, which is the outcome worth having.
   */
  async fail(claim: RunClaim, failure: string): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE scheduled_runs SET finished_at = ?, failure = ?
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
  async recent(job: string, limit: number): Promise<readonly {
    runKey: string;
    startedAt: string;
    finishedAt: string | null;
    failure: string | null;
  }[]> {
    const { results } = await this.#database
      .prepare(
        `SELECT run_key, started_at, finished_at, failure
         FROM scheduled_runs WHERE job = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .bind(job, limit)
      .all<{
        run_key: string;
        started_at: string;
        finished_at: string | null;
        failure: string | null;
      }>();
    return results.map((row) => ({
      runKey: row.run_key,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      failure: row.failure,
    }));
  }
}

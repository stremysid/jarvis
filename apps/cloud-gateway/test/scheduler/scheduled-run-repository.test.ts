import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ScheduledRunRepository } from "../../src/scheduler/scheduled-run-repository.js";
import { applyD2lNotificationEmailMigration } from "../persistence/migration.js";

/**
 * Cron triggers are at-least-once, so the question this repository answers is
 * not "has it run" but "may I run it" -- and the difference matters, because
 * two isolates handling the same retry both see "has not run" if the check
 * and the claim are separate operations.
 */

class StepClock {
  #instant: number;
  constructor(iso: string) {
    this.#instant = Date.parse(iso);
  }
  now(): Date {
    return new Date(this.#instant);
  }
  advance(seconds: number): void {
    this.#instant += seconds * 1_000;
  }
}

function repository(clock: StepClock): ScheduledRunRepository {
  return new ScheduledRunRepository(env.DB, clock);
}

describe("ScheduledRunRepository", () => {
  beforeEach(async () => {
    // The current schema, not just 0013: the `detail` column this suite
    // exercises arrives in 0034.
    await applyD2lNotificationEmailMigration();
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
  });

  it("grants the first claim on a run key", async () => {
    const claimed = await repository(new StepClock("2026-09-02T11:30:00.000Z"))
      .claim({ job: "digest", runKey: "2026-09-02" });
    expect(claimed).not.toBeNull();
    expect(claimed?.startedAt).toBe("2026-09-02T11:30:00.000Z");
  });

  it("refuses a second claim on the same key, which is what makes a retry safe", async () => {
    const clock = new StepClock("2026-09-02T11:30:00.000Z");
    const runs = repository(clock);
    await runs.claim({ job: "digest", runKey: "2026-09-02" });

    clock.advance(20 * 60);
    // The retry twenty minutes later must not send a second morning digest.
    expect(await runs.claim({ job: "digest", runKey: "2026-09-02" })).toBeNull();
  });

  it("still refuses a repeat claim after the first run finished", async () => {
    // Finishing is not releasing. A completed digest is exactly the run a
    // retry must not repeat.
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "digest", runKey: "2026-09-02" });
    await runs.finish({ job: "digest", runKey: "2026-09-02" });
    expect(await runs.claim({ job: "digest", runKey: "2026-09-02" })).toBeNull();
  });

  it("still refuses a repeat claim after the first run failed", async () => {
    // A failure may have left partial work behind. Whether that is safe to
    // repeat is the job's question, not the claim's, so the default is no.
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
    await runs.fail({ job: "poll", runKey: "2026-09-02T11" }, "GitHub returned 503");
    expect(await runs.claim({ job: "poll", runKey: "2026-09-02T11" })).toBeNull();
  });

  it("grants a claim on a different key for the same job", async () => {
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "digest", runKey: "2026-09-02" });
    expect(await runs.claim({ job: "digest", runKey: "2026-09-03" })).not.toBeNull();
  });

  it("grants a claim on the same key for a different job", async () => {
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "digest", runKey: "2026-09-02" });
    expect(await runs.claim({ job: "retro", runKey: "2026-09-02" })).not.toBeNull();
  });

  it("grants only one claim when two callers race the same key", async () => {
    // The property the ON CONFLICT clause exists for. A read-then-insert would
    // let both of these through.
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    const claim = { job: "drain", runKey: "2026-09-02T11:30" };
    const outcomes = await Promise.all([runs.claim(claim), runs.claim(claim), runs.claim(claim)]);
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
  });

  it("admits one cooldown claim across different request keys when callers race", async () => {
    const clock = new StepClock("2026-09-02T11:30:00.000Z");
    const runs = repository(clock);
    const outcomes = await Promise.all(["one", "two", "three"].map((runKey) =>
      runs.claimAfterCooldown(
        { job: "brightspace_on_demand", runKey },
        new Date("2026-09-02T11:25:00.000Z"),
      )));
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
  });

  it("keeps a cooldown closed until the full interval has elapsed", async () => {
    const clock = new StepClock("2026-09-02T11:30:00.000Z");
    const runs = repository(clock);
    await expect(runs.claimAfterCooldown(
      { job: "brightspace_on_demand", runKey: "first" },
      new Date("2026-09-02T11:25:00.000Z"),
    )).resolves.not.toBeNull();

    clock.advance(299);
    await expect(runs.claimAfterCooldown(
      { job: "brightspace_on_demand", runKey: "early" },
      new Date("2026-09-02T11:29:59.000Z"),
    )).resolves.toBeNull();

    clock.advance(1);
    await expect(runs.claimAfterCooldown(
      { job: "brightspace_on_demand", runKey: "ready" },
      new Date("2026-09-02T11:30:00.000Z"),
    )).resolves.not.toBeNull();
  });

  it("records a failure against the run rather than losing it", async () => {
    const clock = new StepClock("2026-09-02T11:30:00.000Z");
    const runs = repository(clock);
    await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
    clock.advance(30);
    await runs.fail({ job: "poll", runKey: "2026-09-02T11" }, "GitHub returned 503");

    const [row] = await runs.recent("poll", 5);
    expect(row?.failure).toBe("GitHub returned 503");
    expect(row?.finishedAt).toBe("2026-09-02T11:30:30.000Z");
  });

  it("truncates an oversized failure rather than failing to record it at all", async () => {
    // The column caps at 512. A record refused by a CHECK constraint is a
    // failure with no trace, which is strictly worse than a clipped one.
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
    await runs.fail({ job: "poll", runKey: "2026-09-02T11" }, "x".repeat(2_000));

    const [row] = await runs.recent("poll", 5);
    expect(row?.failure).toHaveLength(512);
  });

  it("clears a stale failure when a rerun succeeds", async () => {
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
    await runs.fail({ job: "poll", runKey: "2026-09-02T11" }, "transient");
    await runs.finish({ job: "poll", runKey: "2026-09-02T11" });
    expect((await runs.recent("poll", 5))[0]?.failure).toBeNull();
  });

  it("keeps the detail a successful run returned instead of discarding it", async () => {
    // The defect. `finish` wrote `failure = NULL` and nothing else, so a run
    // that succeeded while reporting that a source was not configured left no
    // trace of that sentence anywhere.
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
    await runs.finish({ job: "poll", runKey: "2026-09-02T11" }, "ok", "12 archived; Classroom not configured");

    const [row] = await runs.recent("poll", 5);
    expect(row?.detail).toBe("12 archived; Classroom not configured");
    expect(row?.completion).toBe("ok");
    expect(row?.failure).toBeNull();
  });

  it("keeps a degraded success distinct from a clean one", async () => {
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
    await runs.finish({ job: "poll", runKey: "2026-09-02T11" }, "degraded", "6 polled, 1 failed");

    const [row] = await runs.recent("poll", 5);
    expect(row?.detail).toBe("6 polled, 1 failed");
    expect(row?.completion).toBe("degraded");
  });

  it("records that a run did not measure anything without recording it as a success", async () => {
    // The third state. This is the row that used to be written as `ok: true`.
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "backup", runKey: "2026-09-02" });
    await runs.finish({ job: "backup", runKey: "2026-09-02" }, "not_measured", "Memory consolidation not configured");

    const [row] = await runs.recent("backup", 5);
    expect(row?.detail).toBe("Memory consolidation not configured");
    expect(row?.completion).toBe("not_measured");
    expect(row?.failure).toBeNull();
  });

  it("clears a stale detail when a later run fails", async () => {
    // A detail describes a success. A failure that kept the previous run's
    // health report would read as reassurance about a run that just broke.
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
    await runs.finish({ job: "poll", runKey: "2026-09-02T11" }, "ok", "everything fine");
    await runs.fail({ job: "poll", runKey: "2026-09-02T11" }, "GitHub returned 503");

    const [row] = await runs.recent("poll", 5);
    expect(row?.detail).toBeNull();
    expect(row?.completion).toBe("ok");
    expect(row?.failure).toBe("GitHub returned 503");
  });

  it("reports a success with no detail as a clean success", async () => {
    const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
    await runs.claim({ job: "drain", runKey: "2026-09-02T11:30" });
    await runs.finish({ job: "drain", runKey: "2026-09-02T11:30" });

    const [row] = await runs.recent("drain", 5);
    expect(row?.detail).toBeNull();
    expect(row?.completion).toBe("ok");
  });

  it("names every scheduled job, so none can be missing from status", () => {
    // The nightly backup was outside the three names `/status` iterated, and
    // nothing about the code said so -- it was simply absent.
    expect(repository(new StepClock("2026-09-02T11:30:00.000Z")).jobs()).toEqual([
      "drain", "poll", "digest", "retro", "backup",
    ]);
  });

  describe("reopening a failed run", () => {
    it("lets a job that knows its work is repeatable claim it again", async () => {
      const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
      await runs.claim({ job: "poll", runKey: "2026-09-02T11" });
      await runs.fail({ job: "poll", runKey: "2026-09-02T11" }, "GitHub returned 503");

      expect(await runs.reopen({ job: "poll", runKey: "2026-09-02T11" })).toBe(true);
      expect(await runs.claim({ job: "poll", runKey: "2026-09-02T11" })).not.toBeNull();
    });

    it("refuses to reopen a run that succeeded", async () => {
      // Otherwise a caller reaching for `reopen` on the wrong key could
      // resend a digest that already went out.
      const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
      await runs.claim({ job: "digest", runKey: "2026-09-02" });
      await runs.finish({ job: "digest", runKey: "2026-09-02" });

      expect(await runs.reopen({ job: "digest", runKey: "2026-09-02" })).toBe(false);
      expect(await runs.claim({ job: "digest", runKey: "2026-09-02" })).toBeNull();
    });

    it("refuses to reopen a run that is still in flight", async () => {
      const runs = repository(new StepClock("2026-09-02T11:30:00.000Z"));
      await runs.claim({ job: "digest", runKey: "2026-09-02" });
      expect(await runs.reopen({ job: "digest", runKey: "2026-09-02" })).toBe(false);
    });
  });

  it("lists recent runs newest first", async () => {
    const clock = new StepClock("2026-09-02T09:00:00.000Z");
    const runs = repository(clock);
    for (const hour of ["09", "10", "11"]) {
      await runs.claim({ job: "poll", runKey: `2026-09-02T${hour}` });
      clock.advance(3_600);
    }
    expect((await runs.recent("poll", 2)).map((row) => row.runKey)).toEqual([
      "2026-09-02T11",
      "2026-09-02T10",
    ]);
  });
});

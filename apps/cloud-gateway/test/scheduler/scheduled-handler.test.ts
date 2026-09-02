import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_CRON,
  DRAIN_CRON,
  POLL_CRON,
} from "../../src/scheduler/cron-router.js";
import {
  handleScheduled,
  type JobOutcome,
  type JobTable,
  type ScheduledDependencies,
} from "../../src/scheduler/scheduled-handler.js";
import { ScheduledRunRepository } from "../../src/scheduler/scheduled-run-repository.js";
import { applyFoundationMigration } from "../persistence/migration.js";

/**
 * This file is about an ordering, not a feature.
 *
 * Claim before run, heartbeat after. Both are invisible when everything
 * works and are the difference between a duplicated morning digest and a
 * silent outage when it does not.
 */

const TORONTO = "America/Toronto";
const CONFIGURED = { url: "https://watchdog.example/heartbeat", secret: "s3cret" };

function clock(iso: string): { now(): Date } {
  return { now: () => new Date(iso) };
}

function deps(
  jobs: JobTable,
  overrides: Partial<ScheduledDependencies> = {},
): ScheduledDependencies {
  return {
    runs: new ScheduledRunRepository(env.DB, clock("2026-09-02T11:30:00.000Z")),
    jobs,
    timeZone: TORONTO,
    heartbeat: CONFIGURED,
    fetcher: vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    ...overrides,
  };
}

const ok = async (): Promise<JobOutcome> => ({ ok: true });

describe("routing a firing to its jobs", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
  });

  it("runs the drain job on the frequent tick", async () => {
    const drain = vi.fn(ok);
    const report = await handleScheduled(
      DRAIN_CRON,
      new Date("2026-09-02T14:05:00.000Z"),
      deps({ drain }),
    );
    expect(drain).toHaveBeenCalledOnce();
    expect(report.jobs).toEqual([
      { job: "drain", runKey: "2026-09-02T14:05", result: "ran" },
    ]);
  });

  it("does nothing on the half of the daily pair that landed on the wrong local hour", async () => {
    const digest = vi.fn(ok);
    const report = await handleScheduled(
      DAILY_CRON,
      // 12:30 UTC is 08:30 in Toronto in July -- the wrong firing.
      new Date("2026-07-15T12:30:00.000Z"),
      deps({ digest }),
    );
    expect(digest).not.toHaveBeenCalled();
    expect(report.jobs).toEqual([]);
  });

  it("does nothing for a cron the router does not recognise", async () => {
    const digest = vi.fn(ok);
    const report = await handleScheduled(
      "15 3 * * *",
      new Date("2026-09-02T03:15:00.000Z"),
      deps({ digest }),
    );
    expect(digest).not.toHaveBeenCalled();
    expect(report.jobs).toEqual([]);
  });
});

describe("claiming before running", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
  });

  it("runs the job once when the same firing is retried", async () => {
    // The whole point. Cron triggers are at-least-once, and a second morning
    // digest is the visible symptom.
    const digest = vi.fn(ok);
    const dependencies = deps({ digest });
    const instant = new Date("2026-07-15T11:30:00.000Z");

    const first = await handleScheduled(DAILY_CRON, instant, dependencies);
    const retry = await handleScheduled(DAILY_CRON, instant, dependencies);

    expect(digest).toHaveBeenCalledOnce();
    expect(first.jobs[0]?.result).toBe("ran");
    expect(retry.jobs[0]?.result).toBe("skipped_duplicate");
  });

  it("does not claim a job the deployment has not configured", async () => {
    // Claiming an unconfigured job would record the hour as done, so the poll
    // would never run once the credential finally arrives.
    const report = await handleScheduled(
      POLL_CRON,
      new Date("2026-09-02T14:00:00.000Z"),
      deps({}),
    );
    expect(report.jobs[0]?.result).toBe("skipped_unconfigured");

    const claimed = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM scheduled_runs")
      .first<{ count: number }>();
    expect(claimed?.count).toBe(0);
  });

  it("lets the same job run at the next key", async () => {
    const poll = vi.fn(ok);
    const dependencies = deps({ poll });
    await handleScheduled(POLL_CRON, new Date("2026-09-02T14:00:00.000Z"), dependencies);
    await handleScheduled(POLL_CRON, new Date("2026-09-02T15:00:00.000Z"), dependencies);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe("a job that fails", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
  });

  it("records the failure against the run", async () => {
    const dependencies = deps({ poll: async () => ({ ok: false, failure: "GitHub returned 503" }) });
    const report = await handleScheduled(
      POLL_CRON,
      new Date("2026-09-02T14:00:00.000Z"),
      dependencies,
    );

    expect(report.jobs[0]).toEqual({
      job: "poll",
      runKey: "2026-09-02T14",
      result: "failed",
      detail: "GitHub returned 503",
    });
    expect((await dependencies.runs.recent("poll", 1))[0]?.failure).toBe("GitHub returned 503");
  });

  it("treats a thrown job as a failed run rather than a failed invocation", async () => {
    // Letting it propagate would abandon the claim in flight and skip every
    // job after it in the same firing.
    const report = await handleScheduled(
      POLL_CRON,
      new Date("2026-09-02T14:00:00.000Z"),
      deps({
        poll: async () => {
          throw new Error("connection reset");
        },
      }),
    );
    expect(report.jobs[0]?.result).toBe("failed");
    expect(report.jobs[0]?.detail).toBe("connection reset");
  });

  it("does not heartbeat when the only job failed", async () => {
    // A heartbeat here would tell the watchdog the Worker is fine while every
    // run it makes is failing, which is the outage a watchdog exists to catch.
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const report = await handleScheduled(
      POLL_CRON,
      new Date("2026-09-02T14:00:00.000Z"),
      deps({ poll: async () => ({ ok: false, failure: "down" }) }, {
        fetcher: fetcher as unknown as typeof fetch,
      }),
    );
    expect(report.heartbeat).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("the heartbeat", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.prepare("DELETE FROM scheduled_runs").run();
  });

  it("is sent after the job, never before", async () => {
    // Sent first, it claims the Worker is alive for an invocation that then
    // failed. The order is the whole contract.
    const order: string[] = [];
    const fetcher = vi.fn(async () => {
      order.push("heartbeat");
      return new Response(null, { status: 204 });
    });
    await handleScheduled(
      DRAIN_CRON,
      new Date("2026-09-02T14:05:00.000Z"),
      deps(
        {
          drain: async () => {
            order.push("job");
            return { ok: true };
          },
        },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    );
    expect(order).toEqual(["job", "heartbeat"]);
  });

  it("is not sent for a firing that routed to nothing", async () => {
    // A no-op proves the cron fired, not that the Worker can do its work.
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const report = await handleScheduled(
      DAILY_CRON,
      new Date("2026-07-15T12:30:00.000Z"),
      deps({ digest: vi.fn(ok) }, { fetcher: fetcher as unknown as typeof fetch }),
    );
    expect(report.heartbeat).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is not sent for a duplicate that did no work", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const dependencies = deps({ digest: vi.fn(ok) }, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    const instant = new Date("2026-07-15T11:30:00.000Z");
    await handleScheduled(DAILY_CRON, instant, dependencies);
    fetcher.mockClear();

    const retry = await handleScheduled(DAILY_CRON, instant, dependencies);
    expect(retry.heartbeat).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not fail the run when the watchdog is unreachable", async () => {
    // A missed beat is a false alarm and recoverable. A digest that did not
    // send because its heartbeat could not be delivered is not.
    const digest = vi.fn(ok);
    const report = await handleScheduled(
      DAILY_CRON,
      new Date("2026-07-15T11:30:00.000Z"),
      deps({ digest }, {
        fetcher: vi.fn(async () => {
          throw new TypeError("network error");
        }) as unknown as typeof fetch,
      }),
    );
    expect(digest).toHaveBeenCalledOnce();
    expect(report.jobs[0]?.result).toBe("ran");
    expect(report.heartbeat).toEqual({
      sent: false,
      reason: "unreachable",
      detail: "network error",
    });
  });

  it("names which jobs actually ran", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await handleScheduled(
      DRAIN_CRON,
      new Date("2026-09-02T14:05:00.000Z"),
      deps({ drain: vi.fn(ok) }, { fetcher: fetcher as unknown as typeof fetch }),
    );
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      component: "cloud-gateway",
      detail: "drain",
    });
  });
});

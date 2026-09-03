import {
  createExecutionContext,
  createScheduledController,
  env as testEnv,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { applyLivenessSchema, clearLivenessTables } from "./liveness-schema.js";
import { alertRows, componentRows, seedComponent } from "./support.js";

/**
 * The cron path end to end, through the Worker's own scheduled handler.
 *
 * These run on the real clock, so they assert what a cycle does rather than
 * exactly when. No Telegram credentials are configured in any of them, which
 * means the alert channel is the unconfigured stand-in and no test here
 * reaches the network.
 */
async function runScheduled(environment: Env): Promise<void> {
  const controller = createScheduledController({ cron: "*/5 * * * *" });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, environment, ctx);
  await waitOnExecutionContext(ctx);
}

describe("scheduled", () => {
  beforeEach(async () => {
    await applyLivenessSchema();
    await clearLivenessTables();
  });

  it("records that the cycle ran, which is the only durable trace of the cron firing", async () => {
    await runScheduled({ DB: testEnv.DB });

    const self = (await componentRows()).find((row) => row.component === "watchdog");
    expect(self).toBeDefined();
    expect(Number.isFinite(Date.parse(self!.last_seen_at))).toBe(true);
    expect(self!.expected_interval_seconds).toBe(900);
  });

  it("records nothing as alerted when it has no way to alert", async () => {
    // The chain end to end: no Telegram configuration means every send comes
    // back undelivered, and an undelivered alert is never written. Nothing
    // anywhere gets to believe the operator was told.
    await seedComponent({ component: "agent", expectedIntervalSeconds: 60, lastSeenAt: "2020-01-01T00:00:00.000Z" });

    await runScheduled({ DB: testEnv.DB });

    expect(await alertRows()).toEqual([]);
  });

  it("does not throw when nothing at all is configured", async () => {
    // A scheduled handler that rejects leaves a platform error and nothing
    // else -- no alert, no record. That is the shape of a watchdog that has
    // silently stopped working, so every path has to end in a result.
    await expect(runScheduled({})).resolves.toBeUndefined();
  });

  it("honours a configured self-component name and interval", async () => {
    await runScheduled({
      DB: testEnv.DB,
      WATCHDOG_SELF_COMPONENT: "watchdog-staging",
      WATCHDOG_SELF_INTERVAL_SECONDS: "1800",
    });

    expect((await componentRows()).map((row) => ({ name: row.component, interval: row.expected_interval_seconds })))
      .toEqual([{ name: "watchdog-staging", interval: 1800 }]);
  });

  it("falls back to the default interval rather than refusing to run on a bad setting", async () => {
    // Taking the watchdog off the air over a typo in a variable would be the
    // worst possible response to a typo in a variable.
    await runScheduled({ DB: testEnv.DB, WATCHDOG_SELF_INTERVAL_SECONDS: "every five minutes" });

    expect((await componentRows())[0]?.expected_interval_seconds).toBe(900);
  });
});

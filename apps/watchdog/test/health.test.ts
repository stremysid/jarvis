import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { buildHealthReport, type HealthDependencies } from "../src/health.js";
import worker from "../src/index.js";
import { D1LivenessStore, type LivenessStore } from "../src/liveness-store.js";
import { applyLivenessSchema, clearLivenessTables } from "./liveness-schema.js";
import { clockAt, seedComponent } from "./support.js";

/**
 * A constructed Request, retyped as the incoming one the handler declares.
 *
 * `new Request(...)` produces Request<unknown, CfProperties>; an ExportedHandler
 * is declared with IncomingRequestCfProperties, which only the runtime can
 * populate. The cast is at the boundary and changes nothing the handler reads.
 */
function incoming(request: Request): Parameters<typeof worker.fetch>[0] {
  return request as Parameters<typeof worker.fetch>[0];
}


const NOW = "2026-09-02T12:00:00.000Z";

function dependencies(overrides: Partial<HealthDependencies> = {}): HealthDependencies {
  return {
    store: new D1LivenessStore(testEnv.DB),
    clock: clockAt(NOW),
    alertChannelConfigured: true,
    selfComponent: "watchdog",
    ...overrides,
  };
}

/**
 * A store whose every method rejects.
 *
 * Written out method by method rather than spread over a real store: spreading
 * a class instance copies no prototype methods, so the result would be an
 * object with one working method and six missing ones, and a test that only
 * happened to call the working one would pass for the wrong reason.
 */
function failingStore(): LivenessStore {
  const fail = () => Promise.reject(new Error("D1_ERROR: unreachable"));
  return {
    readComponents: fail,
    readOpenAlerts: fail,
    readComponent: fail,
    recordAlert: fail,
    recordRecurrence: fail,
    recordRecovery: fail,
    recordHeartbeat: fail,
  };
}

/** A cycle recorded `agoSeconds` before NOW, under the watchdog's own name. */
async function seedCycle(agoSeconds: number, intervalSeconds = 900): Promise<void> {
  await seedComponent({
    component: "watchdog",
    expectedIntervalSeconds: intervalSeconds,
    lastSeenAt: new Date(Date.parse(NOW) - agoSeconds * 1000).toISOString(),
    detail: "sent=0 undelivered=0 faults=0",
  });
}

describe("buildHealthReport", () => {
  beforeEach(async () => {
    await applyLivenessSchema();
    await clearLivenessTables();
  });

  it("reports healthy when a recent cycle is recorded and the alert path is configured", async () => {
    await seedCycle(60);

    expect(await buildHealthReport(dependencies())).toEqual({
      ok: true,
      at: NOW,
      database: "bound",
      alertChannel: "configured",
      lastCycleAt: "2026-09-02T11:59:00.000Z",
      lastCycleAgeSeconds: 60,
      lastCycleDetail: "sent=0 undelivered=0 faults=0",
      reasons: [],
    });
  });

  it("refuses to report healthy when it could not alert, however recently it ran", async () => {
    // The failure this Worker exists to prevent, in its own health endpoint. A
    // watchdog with no alert path is not a healthy watchdog running quietly,
    // it is an outage nobody will hear about.
    await seedCycle(60);

    const report = await buildHealthReport(dependencies({ alertChannelConfigured: false }));

    expect(report.ok).toBe(false);
    expect(report.alertChannel).toBe("not_configured");
    expect(report.reasons).toEqual(["alert_channel_not_configured"]);
  });

  it("refuses to report healthy when no cycle has recorded itself", async () => {
    const report = await buildHealthReport(dependencies());

    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(["no_cycle_recorded"]);
    expect(report.lastCycleAt).toBeNull();
  });

  it("refuses to report healthy when the last cycle is older than the watchdog's own interval", async () => {
    // The only signal that this Worker's cron has stopped firing, and it is
    // only visible from outside: nothing in here is running to notice.
    await seedCycle(901);

    const report = await buildHealthReport(dependencies());

    expect(report.ok).toBe(false);
    expect(report.lastCycleAgeSeconds).toBe(901);
    expect(report.reasons).toEqual(["last_cycle_stale"]);
  });

  it("still reports healthy at exactly the watchdog's own interval", async () => {
    // The boundary, asserted next to the case one second past it, so a change
    // to the comparison cannot pass both.
    await seedCycle(900);

    const report = await buildHealthReport(dependencies());

    expect(report.ok).toBe(true);
    expect(report.lastCycleAgeSeconds).toBe(900);
  });

  it("refuses to report healthy when the database is not bound", async () => {
    const report = await buildHealthReport(dependencies({ store: null }));

    expect(report).toEqual({
      ok: false,
      at: NOW,
      database: "unbound",
      alertChannel: "configured",
      lastCycleAt: null,
      lastCycleAgeSeconds: null,
      lastCycleDetail: null,
      reasons: ["database_not_bound"],
    });
  });

  it("refuses to report healthy when the database cannot be read", async () => {
    const report = await buildHealthReport(dependencies({
      store: failingStore(),
    }));

    expect(report.ok).toBe(false);
    expect(report.database).toBe("unreadable");
    expect(report.reasons).toEqual(["database_unreadable"]);
  });

  it("refuses to report healthy when the recorded cycle time cannot be read", async () => {
    await seedComponent({ component: "watchdog", expectedIntervalSeconds: 900, lastSeenAt: "not a timestamp" });

    const report = await buildHealthReport(dependencies());

    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(["last_cycle_unreadable"]);
    expect(report.lastCycleAgeSeconds).toBeNull();
  });

  it("names every reason it is unhealthy rather than only the first", async () => {
    // An operator reading this has to be able to fix everything that is wrong,
    // not discover the next problem after fixing the one they were shown.
    await seedCycle(5000);

    const report = await buildHealthReport(dependencies({ alertChannelConfigured: false }));

    expect(report.reasons).toEqual(["alert_channel_not_configured", "last_cycle_stale"]);
  });

  it("looks up the component name it was configured with, not a fixed one", async () => {
    await seedComponent({ component: "watchdog-staging", expectedIntervalSeconds: 900, lastSeenAt: NOW });

    expect((await buildHealthReport(dependencies({ selfComponent: "watchdog-staging" }))).ok).toBe(true);
    expect((await buildHealthReport(dependencies())).reasons).toEqual(["no_cycle_recorded"]);
  });
});

async function fetchHealth(environment: Env, method = "GET"): Promise<Response> {
  const request = new Request("https://watchdog.example/health", { method });
  return worker.fetch(incoming(request), environment);
}

describe("GET /health", () => {
  beforeEach(async () => {
    await applyLivenessSchema();
    await clearLivenessTables();
  });

  it("answers 503 so a monitor can act on the status alone", async () => {
    const response = await fetchHealth({ DB: testEnv.DB });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      // Both wrong at once in a bare deployment, and both reported.
      reasons: ["alert_channel_not_configured", "no_cycle_recorded"],
    });
  });

  it("answers 200 once a cycle has been recorded and the alert path is configured", async () => {
    await seedComponent({
      component: "watchdog",
      expectedIntervalSeconds: 900,
      lastSeenAt: new Date().toISOString(),
    });

    const response = await fetchHealth({
      DB: testEnv.DB,
      WATCHDOG_TELEGRAM_BOT_TOKEN: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      WATCHDOG_TELEGRAM_CHAT_ID: "-1001234567890",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, database: "bound" });
  });

  it("treats half a Telegram configuration as no alert path at all", async () => {
    // A bot token with no chat id cannot deliver anything, and building a
    // channel from it would make a missing setting look like a Telegram outage.
    await seedComponent({
      component: "watchdog",
      expectedIntervalSeconds: 900,
      lastSeenAt: new Date().toISOString(),
    });

    const response = await fetchHealth({
      DB: testEnv.DB,
      WATCHDOG_TELEGRAM_BOT_TOKEN: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reasons: ["alert_channel_not_configured"] });
  });

  it("answers rather than throwing when the database is not bound", async () => {
    const response = await fetchHealth({});

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ database: "unbound" });
  });

  it("refuses a method that is not a read", async () => {
    expect((await fetchHealth({ DB: testEnv.DB }, "POST")).status).toBe(405);
  });
});

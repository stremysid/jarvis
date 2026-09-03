import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1LivenessStore, type LivenessStore } from "../src/liveness-store.js";
import { runWatchdogCycle, type WatchdogDependencies } from "../src/watchdog-run.js";
import { applyLivenessSchema, clearLivenessTables } from "./liveness-schema.js";
import {
  RecordingAlertChannel,
  alertRows,
  clockAt,
  componentRows,
  seedComponent,
} from "./support.js";

const SELF = { component: "watchdog", expectedIntervalSeconds: 900 };

function dependencies(
  alerts: RecordingAlertChannel,
  at: string,
  overrides: Partial<WatchdogDependencies> = {},
): WatchdogDependencies {
  return {
    store: new D1LivenessStore(env.DB),
    alerts,
    clock: clockAt(at),
    self: SELF,
    ...overrides,
  };
}

/** Everything but the watchdog's own bookkeeping row. */
async function monitoredComponents() {
  return (await componentRows()).filter((row) => row.component !== SELF.component);
}

describe("runWatchdogCycle", () => {
  beforeEach(async () => {
    await applyLivenessSchema();
    await clearLivenessTables();
  });

  it("says nothing about a component that is reporting on schedule", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:59:00.000Z" });
    const alerts = new RecordingAlertChannel();

    const result = await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    expect(alerts.sent).toEqual([]);
    expect(await alertRows()).toEqual([]);
    expect(result.outcome).toBe("assessed");
  });

  it("alerts about a newly overdue component and records the alert it sent", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toContain("DOWN agent");
    expect(await alertRows()).toEqual([{
      alert_id: "liveness:agent:2026-09-02T11:00:00.000Z",
      component: "agent",
      last_seen_at: "2026-09-02T11:00:00.000Z",
      alerted_at: "2026-09-02T12:00:00.000Z",
      recovered_at: null,
    }]);
  });

  it("does not re-alert on the next cycle while a component is still down", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));
    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:05:00.000Z"));
    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:10:00.000Z"));

    expect(alerts.sent).toHaveLength(1);
    expect(await alertRows()).toHaveLength(1);
  });

  it("does not record an alert it failed to send, and sends it again next cycle", async () => {
    // The rule the whole ordering exists for. Recording first would mean one
    // transient Telegram failure suppresses the alert for the rest of the
    // outage, and the database would say the operator had been told.
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    const alerts = new RecordingAlertChannel(() => ({ delivered: false, reason: "http_502" }));

    const failed = await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    expect(alerts.sent).toHaveLength(1);
    expect(failed.delivered).toBe(0);
    expect(failed.undelivered).toBe(1);
    expect(failed.faults).toEqual(["undelivered:agent:http_502"]);
    expect(await alertRows()).toEqual([]);

    // Carried through to what it costs: Telegram comes back, and the alert
    // for the still-ongoing outage arrives rather than staying suppressed.
    alerts.respondWith(() => ({ delivered: true }));
    const recovered = await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:05:00.000Z"));

    expect(alerts.sent).toHaveLength(2);
    expect(recovered.delivered).toBe(1);
    expect(await alertRows()).toEqual([{
      alert_id: "liveness:agent:2026-09-02T11:00:00.000Z",
      component: "agent",
      last_seen_at: "2026-09-02T11:00:00.000Z",
      alerted_at: "2026-09-02T12:05:00.000Z",
      recovered_at: null,
    }]);
  });

  it("clears the alert when the component reports in, and alerts again when it goes down a second time", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    const alerts = new RecordingAlertChannel();
    // Self-recording off: the last cycle here is half an hour after the first,
    // so the watchdog would find its own row stale and add a message that has
    // nothing to do with what this test is about.
    const noSelf = { self: null };

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z", noSelf));

    // The component reports in.
    await new D1LivenessStore(env.DB).recordHeartbeat({
      component: "agent",
      expectedIntervalSeconds: 300,
      detail: null,
      seenAt: "2026-09-02T12:01:00.000Z",
    });
    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:02:00.000Z", noSelf));

    expect(alerts.sent[1]).toContain("RECOVERED agent");
    expect((await alertRows())[0]?.recovered_at).toBe("2026-09-02T12:02:00.000Z");

    // And then goes quiet again.
    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:30:00.000Z", noSelf));

    expect(alerts.sent).toHaveLength(3);
    expect(alerts.sent[2]).toContain("DOWN agent");
    expect((await alertRows()).map((row) => ({ id: row.alert_id, recovered: row.recovered_at }))).toEqual([
      { id: "liveness:agent:2026-09-02T11:00:00.000Z", recovered: "2026-09-02T12:02:00.000Z" },
      { id: "liveness:agent:2026-09-02T12:01:00.000Z", recovered: null },
    ]);
  });

  it("reports a second outage even when the first one's alert was never closed", async () => {
    // The recovery notice failed to send, so the first alert is still open.
    // The component was nonetheless seen since, and has gone quiet again. This
    // is the case liveness_alerts.last_seen_at exists to make visible.
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:40:00.000Z" });
    await env.DB
      .prepare("INSERT INTO liveness_alerts (alert_id, component, last_seen_at, alerted_at, recovered_at) VALUES (?, ?, ?, ?, NULL)")
      .bind("liveness:agent:2026-09-02T11:00:00.000Z", "agent", "2026-09-02T11:00:00.000Z", "2026-09-02T11:10:00.000Z")
      .run();
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toContain("DOWN AGAIN agent");
    expect((await alertRows()).map((row) => ({ id: row.alert_id, recovered: row.recovered_at }))).toEqual([
      { id: "liveness:agent:2026-09-02T11:00:00.000Z", recovered: "2026-09-02T12:00:00.000Z" },
      { id: "liveness:agent:2026-09-02T11:40:00.000Z", recovered: null },
    ]);
  });

  it("does not alert about an overdue component inside its suppression window", async () => {
    await seedComponent({
      component: "agent",
      lastSeenAt: "2026-09-02T11:00:00.000Z",
      suppressedUntil: "2026-09-02T13:00:00.000Z",
    });
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    expect(alerts.sent).toEqual([]);
    expect(await alertRows()).toEqual([]);
  });

  it("says on the alert channel that it could not read the liveness state, and writes nothing", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    const alerts = new RecordingAlertChannel();
    const store = new D1LivenessStore(env.DB);
    // Every method written out, not spread over the real store: spreading a
    // class instance copies no prototype methods, and the result would be an
    // object missing everything the test did not happen to call.
    const broken: LivenessStore = {
      readComponents: () => Promise.reject(new Error("D1_ERROR: no such table")),
      readOpenAlerts: () => store.readOpenAlerts(),
      readComponent: (component) => store.readComponent(component),
      recordAlert: (alert) => store.recordAlert(alert),
      recordRecurrence: (alert) => store.recordRecurrence(alert),
      recordRecovery: (component, at) => store.recordRecovery(component, at),
      recordHeartbeat: (heartbeat) => store.recordHeartbeat(heartbeat),
    };

    const result = await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z", { store: broken }));

    expect(result.outcome).toBe("store_unreadable");
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toContain("WATCHDOG DEGRADED");
    // The injected reason, not merely some reason: a fixture that provoked a
    // different error inside code that classifies errors would look identical.
    expect(alerts.sent[0]).toContain("D1_ERROR: no such table");
    expect(result.faults).toEqual(["store_unreadable:D1_ERROR: no such table"]);

    expect(await alertRows()).toEqual([]);
    // Not even its own heartbeat. Recording "I ran" for a cycle that checked
    // nothing would make /health report a healthy watchdog through a database
    // outage, which is the one answer it must never give.
    expect((await componentRows()).map((row) => row.component)).toEqual(["agent"]);
  });

  it("records that it ran, so something outside can see the cycle is not stale", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:59:00.000Z" });
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    const self = (await componentRows()).find((row) => row.component === "watchdog");
    expect(self).toMatchObject({
      component: "watchdog",
      expected_interval_seconds: 900,
      last_seen_at: "2026-09-02T12:00:00.000Z",
      detail: "sent=0 undelivered=0 faults=0",
      suppressed_until: null,
    });
  });

  it("does not record itself when told to record nothing", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:59:00.000Z" });
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z", { self: null }));

    expect((await componentRows()).map((row) => row.component)).toEqual(["agent"]);
  });

  it("alerts about its own missed cycles once one survives, because its row is written after the check", async () => {
    // The only self-check available from the inside, and it only fires once a
    // cycle completes. It cannot report a watchdog that never ran again.
    await seedComponent({ component: "watchdog", expectedIntervalSeconds: 900, lastSeenAt: "2026-09-02T10:00:00.000Z" });
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toContain("DOWN watchdog");
  });

  it("leaves the components it could not alert about this cycle for the next one", async () => {
    for (const name of ["a", "b", "c", "d"]) {
      await seedComponent({ component: name, lastSeenAt: "2026-09-02T11:00:00.000Z" });
    }
    const alerts = new RecordingAlertChannel();

    const capped = await runWatchdogCycle(
      dependencies(alerts, "2026-09-02T12:00:00.000Z", { maxAlertsPerCycle: 2 }),
    );

    expect(capped.delivered).toBe(2);
    expect(capped.deferred).toBe(2);
    expect(await alertRows()).toHaveLength(2);

    const next = await runWatchdogCycle(
      dependencies(alerts, "2026-09-02T12:05:00.000Z", { maxAlertsPerCycle: 2 }),
    );

    expect(next.delivered).toBe(2);
    expect(next.deferred).toBe(0);
    expect((await alertRows()).map((row) => row.component).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("sheds recoveries before outages when it cannot send everything", async () => {
    await seedComponent({ component: "down", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    await seedComponent({ component: "back", lastSeenAt: "2026-09-02T11:59:00.000Z" });
    await env.DB
      .prepare("INSERT INTO liveness_alerts (alert_id, component, last_seen_at, alerted_at, recovered_at) VALUES (?, ?, ?, ?, NULL)")
      .bind("liveness:back:2026-09-02T10:00:00.000Z", "back", "2026-09-02T10:00:00.000Z", "2026-09-02T10:10:00.000Z")
      .run();
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z", { maxAlertsPerCycle: 1 }));

    // "back" sorts before "down"; urgency, not alphabet, decides.
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toContain("DOWN down");
  });

  it("reports an alert that was sent but could not be recorded, rather than counting it as delivered", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    const alerts = new RecordingAlertChannel();
    const store = new D1LivenessStore(env.DB);
    const unwritable: LivenessStore = {
      readComponents: () => store.readComponents(),
      readOpenAlerts: () => store.readOpenAlerts(),
      readComponent: (component) => store.readComponent(component),
      recordAlert: () => Promise.reject(new Error("D1_ERROR: disk full")),
      recordRecurrence: (alert) => store.recordRecurrence(alert),
      recordRecovery: (component, at) => store.recordRecovery(component, at),
      recordHeartbeat: (heartbeat) => store.recordHeartbeat(heartbeat),
    };

    const result = await runWatchdogCycle(
      dependencies(alerts, "2026-09-02T12:00:00.000Z", { store: unwritable }),
    );

    expect(alerts.sent).toHaveLength(1);
    expect(result.delivered).toBe(0);
    expect(result.faults).toEqual(["unrecorded:agent:D1_ERROR: disk full"]);
    // Nothing recorded means the next cycle alerts again. A duplicate page is
    // the harmless direction of this failure.
    expect(await alertRows()).toEqual([]);
  });

  it("does not accumulate two alerts for one outage when a cycle runs twice at the same instant", async () => {
    // Overlapping invocations are possible and the deterministic alert id is
    // what makes the second record a no-op. Two open alerts for one component
    // would leave one behind at recovery, after which the component reads as
    // permanently still down and is never alerted about again.
    await seedComponent({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" });
    const alerts = new RecordingAlertChannel();

    // Self-recording off so the two cycles cannot race on that row as well,
    // which would make a failure here ambiguous about which write collided.
    const [first, second] = await Promise.all([
      runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z", { self: null })),
      runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z", { self: null })),
    ]);

    expect(first.outcome).toBe("assessed");
    expect(second.outcome).toBe("assessed");
    expect(await alertRows()).toHaveLength(1);
  });

  it("reports a component whose last_seen_at cannot be read rather than passing over it", async () => {
    await seedComponent({ component: "agent", lastSeenAt: "not a timestamp" });
    const alerts = new RecordingAlertChannel();

    await runWatchdogCycle(dependencies(alerts, "2026-09-02T12:00:00.000Z"));

    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toContain("last_seen_at could not be read");
    expect(await monitoredComponents()).toHaveLength(1);
  });
});

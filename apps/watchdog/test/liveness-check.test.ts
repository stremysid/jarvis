import { describe, expect, it } from "vitest";
import {
  alertIdFor,
  assessLiveness,
  isActionable,
  type ComponentLivenessRow,
  type LivenessVerdict,
  type OpenLivenessAlert,
} from "../src/liveness-check.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function row(overrides: Partial<ComponentLivenessRow> & { component: string }): ComponentLivenessRow {
  return {
    expectedIntervalSeconds: 300,
    lastSeenAt: "2026-09-02T11:59:00.000Z",
    detail: null,
    suppressedUntil: null,
    ...overrides,
  };
}

function openAlert(overrides: Partial<OpenLivenessAlert> & { component: string }): OpenLivenessAlert {
  return {
    alertId: `liveness:${overrides.component}:${overrides.lastSeenAt ?? "2026-09-02T11:00:00.000Z"}`,
    lastSeenAt: "2026-09-02T11:00:00.000Z",
    alertedAt: "2026-09-02T11:10:00.000Z",
    ...overrides,
  };
}

function assess(
  rows: readonly ComponentLivenessRow[],
  openAlerts: readonly OpenLivenessAlert[] = [],
  now: Date = NOW,
): readonly LivenessVerdict[] {
  return assessLiveness({ rows, openAlerts, now });
}

describe("assessLiveness", () => {
  it("treats a component seen within its interval as live", () => {
    expect(assess([row({ component: "agent" })])).toEqual([
      { component: "agent", status: "live" },
    ]);
  });

  it("treats a component seen exactly one interval ago as still within its interval", () => {
    // The boundary itself, not near it. A component reporting every 300
    // seconds must not be called late by the cycle that lands on the same
    // second, or every component alarms once in a while for no reason.
    expect(assess([row({ component: "agent", lastSeenAt: "2026-09-02T11:55:00.000Z" })])).toEqual([
      { component: "agent", status: "live" },
    ]);
  });

  it("treats a component seen one second past its interval as overdue", () => {
    expect(assess([row({ component: "agent", lastSeenAt: "2026-09-02T11:54:59.000Z" })])).toEqual([
      {
        component: "agent",
        status: "newly_overdue",
        lastSeenAt: "2026-09-02T11:54:59.000Z",
        expectedIntervalSeconds: 300,
        overdueBySeconds: 1,
      },
    ]);
  });

  it("judges each component against its own interval rather than one global threshold", () => {
    // Identical silence, opposite answers. This is the property the per-row
    // expected_interval_seconds column exists for: an agent that sleeps
    // overnight and a cron that runs every five minutes cannot share a
    // threshold without either alarming constantly or never alarming.
    const lastSeenAt = "2026-09-02T04:00:00.000Z";
    expect(assess([
      row({ component: "cron", expectedIntervalSeconds: 300, lastSeenAt }),
      row({ component: "overnight-agent", expectedIntervalSeconds: 57_600, lastSeenAt }),
    ])).toEqual([
      {
        component: "cron",
        status: "newly_overdue",
        lastSeenAt,
        expectedIntervalSeconds: 300,
        overdueBySeconds: 28_500,
      },
      { component: "overnight-agent", status: "live" },
    ]);
  });

  it("alerts about an overdue component that has no open alert", () => {
    const verdicts = assess([row({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z" })]);
    expect(verdicts.filter(isActionable).map((verdict) => verdict.status)).toEqual(["newly_overdue"]);
  });

  it("does not re-alert while a component is still down", () => {
    const lastSeenAt = "2026-09-02T11:00:00.000Z";
    expect(assess(
      [row({ component: "agent", lastSeenAt })],
      [openAlert({ component: "agent", lastSeenAt, alertId: "alert-1" })],
    )).toEqual([
      { component: "agent", status: "still_overdue", lastSeenAt, openAlertId: "alert-1" },
    ]);
  });

  it("produces nothing to send while a component is still down", () => {
    const lastSeenAt = "2026-09-02T11:00:00.000Z";
    const verdicts = assess(
      [row({ component: "agent", lastSeenAt })],
      [openAlert({ component: "agent", lastSeenAt })],
    );
    expect(verdicts.filter(isActionable)).toEqual([]);
  });

  it("clears the alert when a component that was down reports in again", () => {
    expect(assess(
      [row({ component: "agent", lastSeenAt: "2026-09-02T11:59:30.000Z" })],
      [openAlert({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z", alertId: "alert-1" })],
    )).toEqual([
      {
        component: "agent",
        status: "recovered",
        lastSeenAt: "2026-09-02T11:59:30.000Z",
        openAlertId: "alert-1",
      },
    ]);
  });

  it("alerts again when a recovered component goes down a second time", () => {
    // The alert from the first outage has been closed, so there is no open
    // alert left and the second outage is new.
    expect(assess([row({ component: "agent", lastSeenAt: "2026-09-02T11:30:00.000Z" })], [])).toEqual([
      {
        component: "agent",
        status: "newly_overdue",
        lastSeenAt: "2026-09-02T11:30:00.000Z",
        expectedIntervalSeconds: 300,
        overdueBySeconds: 1500,
      },
    ]);
  });

  it("distinguishes a second outage from an ongoing one by whether last_seen_at moved", () => {
    // The alert is still open -- its recovery notice never got delivered --
    // but the component was seen at 11:40, after the alert was raised against
    // 11:00. That is a second outage, and collapsing it into "still down"
    // would lose it with no other symptom anywhere.
    expect(assess(
      [row({ component: "agent", lastSeenAt: "2026-09-02T11:40:00.000Z" })],
      [openAlert({ component: "agent", lastSeenAt: "2026-09-02T11:00:00.000Z", alertId: "alert-1" })],
    )).toEqual([
      {
        component: "agent",
        status: "overdue_again",
        lastSeenAt: "2026-09-02T11:40:00.000Z",
        expectedIntervalSeconds: 300,
        overdueBySeconds: 900,
        openAlertId: "alert-1",
        previousLastSeenAt: "2026-09-02T11:00:00.000Z",
      },
    ]);
  });

  it("does not alert about an overdue component inside its suppression window", () => {
    expect(assess([row({
      component: "agent",
      lastSeenAt: "2026-09-02T11:00:00.000Z",
      suppressedUntil: "2026-09-02T13:00:00.000Z",
    })])).toEqual([
      { component: "agent", status: "suppressed", suppressedUntil: "2026-09-02T13:00:00.000Z" },
    ]);
  });

  it("alerts about an overdue component once its suppression window has passed", () => {
    const verdicts = assess([row({
      component: "agent",
      lastSeenAt: "2026-09-02T11:00:00.000Z",
      suppressedUntil: "2026-09-02T11:59:59.000Z",
    })]);
    expect(verdicts.map((verdict) => verdict.status)).toEqual(["newly_overdue"]);
  });

  it("refuses to be silenced by a suppressed_until it cannot read", () => {
    // The asymmetry is deliberate. Reading an unparseable value as
    // "suppressed" switches the watchdog off for that component and leaves
    // nothing behind to say so; reading it as "not suppressed" costs one
    // unwanted alert.
    const verdicts = assess([row({
      component: "agent",
      lastSeenAt: "2026-09-02T11:00:00.000Z",
      suppressedUntil: "whenever",
    })]);
    expect(verdicts.map((verdict) => verdict.status)).toEqual(["newly_overdue"]);
  });

  it("clears an open alert for a component that is live even while it is suppressed", () => {
    // Closing an alert is not a page, and an alert left open across a
    // maintenance window would make the next real outage read as "still down"
    // and never be reported.
    expect(assess(
      [row({
        component: "agent",
        lastSeenAt: "2026-09-02T11:59:30.000Z",
        suppressedUntil: "2026-09-02T13:00:00.000Z",
      })],
      [openAlert({ component: "agent", alertId: "alert-1" })],
    )).toEqual([
      {
        component: "agent",
        status: "recovered",
        lastSeenAt: "2026-09-02T11:59:30.000Z",
        openAlertId: "alert-1",
      },
    ]);
  });

  it("treats a last_seen_at it cannot read as overdue rather than as live", () => {
    expect(assess([row({ component: "agent", lastSeenAt: "not-a-timestamp" })])).toEqual([
      {
        component: "agent",
        status: "newly_overdue",
        lastSeenAt: "not-a-timestamp",
        expectedIntervalSeconds: 300,
        // Null rather than a fabricated number: the alert says the timestamp
        // could not be read, which is the true and more useful thing to say.
        overdueBySeconds: null,
      },
    ]);
  });

  it("treats an unusable expected_interval_seconds as overdue rather than as live", () => {
    // The column has a CHECK that forbids this, so reaching it means the row
    // was written by something that bypassed the schema. Concluding "live"
    // from a row that makes no sense is the silent failure to avoid.
    const verdicts = assess([
      row({ component: "zero", expectedIntervalSeconds: 0 }),
      row({ component: "negative", expectedIntervalSeconds: -1 }),
      row({ component: "nan", expectedIntervalSeconds: Number.NaN }),
    ]);
    expect(verdicts.map((verdict) => ({ component: verdict.component, status: verdict.status }))).toEqual([
      { component: "nan", status: "newly_overdue" },
      { component: "negative", status: "newly_overdue" },
      { component: "zero", status: "newly_overdue" },
    ]);
  });

  it("returns exactly one verdict per row, in component order", () => {
    // Compared as a whole list. A component silently missing from the
    // assessment produces no alert, no log line and no failed request, so a
    // membership assertion would pass over the one defect that has no other
    // way of being seen.
    const verdicts = assess(
      [
        row({ component: "charlie", lastSeenAt: "2026-09-02T11:00:00.000Z" }),
        row({ component: "alpha" }),
        row({ component: "bravo", lastSeenAt: "2026-09-02T11:00:00.000Z", suppressedUntil: "2026-09-02T13:00:00.000Z" }),
      ],
      [openAlert({ component: "charlie", lastSeenAt: "2026-09-02T11:00:00.000Z", alertId: "alert-c" })],
    );
    expect(verdicts).toEqual([
      { component: "alpha", status: "live" },
      { component: "bravo", status: "suppressed", suppressedUntil: "2026-09-02T13:00:00.000Z" },
      {
        component: "charlie",
        status: "still_overdue",
        lastSeenAt: "2026-09-02T11:00:00.000Z",
        openAlertId: "alert-c",
      },
    ]);
  });

  it("uses the most recently raised alert when a component somehow has two open", () => {
    const lastSeenAt = "2026-09-02T11:00:00.000Z";
    expect(assess(
      [row({ component: "agent", lastSeenAt })],
      [
        openAlert({ component: "agent", lastSeenAt, alertId: "older", alertedAt: "2026-09-02T11:05:00.000Z" }),
        openAlert({ component: "agent", lastSeenAt, alertId: "newer", alertedAt: "2026-09-02T11:30:00.000Z" }),
      ],
    )).toEqual([
      { component: "agent", status: "still_overdue", lastSeenAt, openAlertId: "newer" },
    ]);
  });

  it("ignores an open alert naming a component that has no row", () => {
    expect(assess([], [openAlert({ component: "deleted" })])).toEqual([]);
  });

  it("returns nothing at all for an empty table", () => {
    expect(assess([], [])).toEqual([]);
  });
});

describe("isActionable", () => {
  it("selects exactly the three verdicts that require something to be sent", () => {
    const all: LivenessVerdict[] = [
      { component: "a", status: "live" },
      { component: "b", status: "suppressed", suppressedUntil: "2026-09-02T13:00:00.000Z" },
      { component: "c", status: "still_overdue", lastSeenAt: "x", openAlertId: "1" },
      { component: "d", status: "newly_overdue", lastSeenAt: "x", expectedIntervalSeconds: 1, overdueBySeconds: 1 },
      { component: "e", status: "overdue_again", lastSeenAt: "x", expectedIntervalSeconds: 1, overdueBySeconds: 1, openAlertId: "1", previousLastSeenAt: "w" },
      { component: "f", status: "recovered", lastSeenAt: "x", openAlertId: "1" },
    ];
    expect(all.filter(isActionable).map((verdict) => verdict.component)).toEqual(["d", "e", "f"]);
  });
});

describe("alertIdFor", () => {
  it("gives one outage one id, so a duplicated record collides instead of accumulating", () => {
    expect(alertIdFor("agent", "2026-09-02T11:00:00.000Z"))
      .toBe(alertIdFor("agent", "2026-09-02T11:00:00.000Z"));
  });

  it("gives a component's second outage a different id from its first", () => {
    expect(alertIdFor("agent", "2026-09-02T11:00:00.000Z"))
      .not.toBe(alertIdFor("agent", "2026-09-02T11:40:00.000Z"));
  });

  it("gives two components alerting at the same last_seen_at different ids", () => {
    expect(alertIdFor("agent", "2026-09-02T11:00:00.000Z"))
      .not.toBe(alertIdFor("gateway", "2026-09-02T11:00:00.000Z"));
  });
});

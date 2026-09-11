/**
 * One watchdog cycle: read, decide, alert, and only then record.
 *
 * The ordering in that sentence is the whole of the design. An alert is
 * written to liveness_alerts only after the send came back acknowledged,
 * because the row is what stops the next cycle re-alerting. Recording first
 * and sending second would mean a single transient Telegram failure
 * permanently suppresses the alert for an outage that is still going on -- the
 * database would say the operator had been told, and nothing would ever say
 * otherwise.
 *
 * The same rule covers recoveries, which is why they are sent before they are
 * closed. It makes an undelivered recovery self-healing: the alert stays open,
 * the component is still live next cycle, and the notice is attempted again.
 */

import type { AlertChannel } from "./alert-channel.js";
import {
  alertIdFor,
  assessLiveness,
  isActionable,
  type ComponentLivenessRow,
  type LivenessVerdict,
  type OpenLivenessAlert,
} from "./liveness-check.js";
import type { LivenessStore } from "./liveness-store.js";

export interface Clock {
  now(): Date;
}

/** The only place the real time of day enters. Everything below takes a clock. */
export const systemClock: Clock = Object.freeze({ now: () => new Date() });

/**
 * How many alerts one cycle will send.
 *
 * A mass outage -- the database went away, every component looks quiet at once
 * -- would otherwise fire one Telegram message per component and be rate
 * limited into delivering none of them. Beyond the cap nothing is sent and,
 * because nothing is sent, nothing is recorded, so the remainder is picked up
 * by the following cycle rather than lost.
 */
export const MAX_ALERTS_PER_CYCLE = 8;

export interface SelfHeartbeatConfig {
  readonly component: string;
  readonly expectedIntervalSeconds: number;
}

export interface WatchdogDependencies {
  readonly store: LivenessStore;
  readonly alerts: AlertChannel;
  readonly clock: Clock;
  /**
   * Where the watchdog records that it ran, or null to record nothing.
   *
   * This is not the watchdog watching itself -- it cannot, and see the comment
   * on `recordSelfHeartbeat` -- it is a durable timestamp for something
   * outside to read through /health.
   */
  readonly self: SelfHeartbeatConfig | null;
  readonly maxAlertsPerCycle?: number;
  readonly requiredComponents?: readonly string[];
}

export interface WatchdogCycleResult {
  readonly ranAt: string;
  readonly outcome: "assessed" | "store_unreadable";
  readonly verdicts: readonly LivenessVerdict[];
  /** Alerts and recoveries acknowledged by Telegram, and therefore recorded. */
  readonly delivered: number;
  /** Attempted and not acknowledged. Nothing was recorded for these. */
  readonly undelivered: number;
  /** Actionable verdicts left for the next cycle by the per-cycle cap. */
  readonly deferred: number;
  readonly faults: readonly string[];
}

/** Urgency order, so the per-cycle cap sheds recoveries before it sheds outages. */
const PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  newly_overdue: 0,
  overdue_again: 1,
  recovered: 2,
});

export function describeVerdict(verdict: LivenessVerdict): string {
  switch (verdict.status) {
    case "newly_overdue":
      if (verdict.lastSeenAt === "never") return `DOWN ${verdict.component}\nrequired component has never reported`;
      return [
        `DOWN ${verdict.component}`,
        `last seen ${verdict.lastSeenAt}`,
        `expected every ${verdict.expectedIntervalSeconds}s`,
        verdict.overdueBySeconds === null
          ? "last_seen_at could not be read"
          : `overdue by ${verdict.overdueBySeconds}s`,
      ].join("\n");
    case "overdue_again":
      if (verdict.lastSeenAt === "never") return `DOWN AGAIN ${verdict.component}\nrequired component has no heartbeat record`;
      return [
        `DOWN AGAIN ${verdict.component}`,
        `last seen ${verdict.lastSeenAt}`,
        `previous outage was from ${verdict.previousLastSeenAt}`,
        `expected every ${verdict.expectedIntervalSeconds}s`,
        verdict.overdueBySeconds === null
          ? "last_seen_at could not be read"
          : `overdue by ${verdict.overdueBySeconds}s`,
      ].join("\n");
    case "recovered":
      return `RECOVERED ${verdict.component}\nlast seen ${verdict.lastSeenAt}`;
    default:
      // Live, suppressed and still_overdue are decisions to say nothing, and
      // there is no message for them by construction.
      return "";
  }
}

type StoreRead =
  | {
      readonly ok: true;
      readonly rows: readonly ComponentLivenessRow[];
      readonly openAlerts: readonly OpenLivenessAlert[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** Both reads together, because a cycle that has one half of the state can conclude nothing. */
async function readState(store: LivenessStore, required: readonly string[]): Promise<StoreRead> {
  try {
    const components = await store.readComponents();
    const rows = [...components.rows];
    // A required row outside the bounded page is not a missing heartbeat.
    for (const component of new Set(required)) {
      if (rows.some((row) => row.component === component)) continue;
      const row = await store.readComponent(component);
      if (row !== null) rows.push(row);
    }
    const openAlerts = await store.readOpenAlerts();
    return { ok: true, rows, openAlerts, truncated: components.truncated };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run one cycle.
 *
 * Never throws. A scheduled handler that rejects produces a Cloudflare error
 * event and nothing else -- no alert, no record -- which is the failure this
 * Worker exists to prevent, so every path here ends in a result that says what
 * happened.
 */
export async function runWatchdogCycle(
  dependencies: WatchdogDependencies,
): Promise<WatchdogCycleResult> {
  const now = dependencies.clock.now();
  const ranAt = now.toISOString();
  const faults: string[] = [];

  const requiredComponents = dependencies.requiredComponents ?? [];
  const read = await readState(dependencies.store, requiredComponents);
  if (!read.ok) {
    // A failed read does suppress every liveness alert this cycle, and there
    // is no way around that: without the rows the watchdog does not know who
    // is overdue. What it must not do is treat "I could not look" as "nothing
    // is wrong", so it says so on the alert channel instead.
    //
    // This repeats every cycle for as long as the database is unreachable. The
    // de-duplication that keeps ordinary alerts quiet lives in that same
    // database, so a failure to reach it cannot be de-duplicated by it. Noisy
    // is the correct side to fail on here.
    faults.push(`store_unreadable:${read.reason}`);
    await dependencies.alerts.send(
      `WATCHDOG DEGRADED\ncould not read liveness state at ${ranAt}\n${read.reason}\nno component was checked this cycle`,
    );
    return {
      ranAt,
      outcome: "store_unreadable",
      verdicts: [],
      delivered: 0,
      undelivered: 0,
      deferred: 0,
      faults,
    };
  }

  const { rows, openAlerts } = read;

  if (read.truncated) {
    faults.push("component_table_truncated");
    // Components past the read boundary were not examined at all, so this
    // cycle's silence about them means nothing. Reported rather than logged,
    // because a log nobody reads is how a monitoring gap stays open.
    await dependencies.alerts.send(
      `WATCHDOG DEGRADED\ncomponent_liveness holds more rows than one cycle reads\nsome components were not checked at ${ranAt}`,
    );
  }

  const verdicts = assessLiveness({ rows, openAlerts, now, requiredComponents });

  const actionable = verdicts
    .filter(isActionable)
    .sort((a, b) => (PRIORITY[a.status] ?? 9) - (PRIORITY[b.status] ?? 9));

  const cap = dependencies.maxAlertsPerCycle ?? MAX_ALERTS_PER_CYCLE;
  const attempts = actionable.slice(0, cap);
  const deferred = actionable.length - attempts.length;

  let delivered = 0;
  let undelivered = 0;

  for (const verdict of attempts) {
    const outcome = await dependencies.alerts.send(describeVerdict(verdict));
    if (!outcome.delivered) {
      undelivered += 1;
      // Deliberately nothing written. The absence of the row is what makes the
      // next cycle try again.
      faults.push(`undelivered:${verdict.component}:${outcome.reason}`);
      continue;
    }

    try {
      if (verdict.status === "recovered") {
        await dependencies.store.recordRecovery(verdict.component, ranAt);
      } else if (verdict.status === "overdue_again") {
        await dependencies.store.recordRecurrence({
          alertId: alertIdFor(verdict.component, verdict.lastSeenAt),
          component: verdict.component,
          lastSeenAt: verdict.lastSeenAt,
          alertedAt: ranAt,
        });
      } else {
        await dependencies.store.recordAlert({
          alertId: alertIdFor(verdict.component, verdict.lastSeenAt),
          component: verdict.component,
          lastSeenAt: verdict.lastSeenAt,
          alertedAt: ranAt,
        });
      }
      delivered += 1;
    } catch (error) {
      // The message went out and the record did not. The next cycle will send
      // it again, which is the harmless direction of this failure: a duplicate
      // page is an annoyance, a missing one is the thing being guarded against.
      faults.push(`unrecorded:${verdict.component}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await recordSelfHeartbeat(dependencies, ranAt, { delivered, undelivered, faults });

  return {
    ranAt,
    outcome: "assessed",
    verdicts,
    delivered,
    undelivered,
    deferred,
    faults,
  };
}

/**
 * Record that the watchdog ran, in component_liveness, under its own name.
 *
 * This does not let the watchdog watch itself, and it would be dishonest to
 * present it that way. A Worker whose cron has stopped firing cannot notice
 * its own silence: there is no code running to notice with. What this gives is
 * a durable last-ran timestamp that outlives the isolate, so something outside
 * -- an external uptime check polling /health on a schedule of its own -- can
 * see the staleness and say so. The watchdog needs a watchdog, and it has to
 * be somewhere else.
 *
 * Written after the assessment, not before, so the row the assessment reads is
 * the previous cycle's. That gives one genuine self-check for free: if the
 * cron fires but cycles have been dying part way through, the first cycle that
 * survives finds its own row overdue and alerts about the gap.
 */
async function recordSelfHeartbeat(
  dependencies: WatchdogDependencies,
  ranAt: string,
  summary: { delivered: number; undelivered: number; faults: string[] },
): Promise<void> {
  const self = dependencies.self;
  if (self === null) return;
  try {
    await dependencies.store.recordHeartbeat({
      component: self.component,
      expectedIntervalSeconds: self.expectedIntervalSeconds,
      // Structural only, never content, and short by construction: the column
      // caps at 256 characters and three small integers cannot approach it.
      detail: `sent=${summary.delivered} undelivered=${summary.undelivered} faults=${summary.faults.length}`,
      seenAt: ranAt,
    });
  } catch (error) {
    // Not alerted about. The consequence of this failing is that /health goes
    // stale, and the external monitor that reads /health is exactly what is
    // meant to notice. Alerting here as well would page twice for one fault.
    summary.faults.push(`self_heartbeat_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

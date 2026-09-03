/**
 * GET /health -- the endpoint that answers "is the watchdog itself working?"
 *
 * This is the only answer this design has to the question it cannot answer
 * from the inside. A Worker whose cron has stopped firing does not notice: no
 * code is running to notice with, and adding a second timer inside the same
 * Worker would share the same fate as the first. So the watchdog writes a
 * durable record of each cycle into its own component_liveness row, and this
 * endpoint reports how stale that record is. Something outside -- an external
 * uptime monitor on a schedule of its own -- has to poll it. Nothing in this
 * repository does; that is a deployment step, and until it is done, nothing
 * watches the watchdog.
 *
 * It never answers 200 on a partial configuration. A watchdog that cannot
 * alert is not healthy, however well the rest of it is running, and saying
 * "ok" while the alert path is missing would be the exact lie this Worker
 * exists to prevent.
 */

import type { LivenessStore } from "./liveness-store.js";
import type { Clock } from "./watchdog-run.js";

export const HEALTH_PATH = "/health";

export interface HealthDependencies {
  /** Null when D1 is not bound, which is itself a reportable state. */
  readonly store: LivenessStore | null;
  readonly clock: Clock;
  readonly alertChannelConfigured: boolean;
  readonly selfComponent: string;
}

export interface HealthReport {
  readonly ok: boolean;
  readonly at: string;
  readonly database: "bound" | "unbound" | "unreadable";
  readonly alertChannel: "configured" | "not_configured";
  readonly lastCycleAt: string | null;
  readonly lastCycleAgeSeconds: number | null;
  readonly lastCycleDetail: string | null;
  readonly reasons: readonly string[];
}

export async function buildHealthReport(
  dependencies: HealthDependencies,
): Promise<HealthReport> {
  const now = dependencies.clock.now();
  const at = now.toISOString();
  const reasons: string[] = [];
  const alertChannel = dependencies.alertChannelConfigured ? "configured" : "not_configured";
  if (!dependencies.alertChannelConfigured) reasons.push("alert_channel_not_configured");

  if (dependencies.store === null) {
    reasons.push("database_not_bound");
    return {
      ok: false, at, database: "unbound", alertChannel,
      lastCycleAt: null, lastCycleAgeSeconds: null, lastCycleDetail: null,
      reasons,
    };
  }

  let row;
  try {
    row = await dependencies.store.readComponent(dependencies.selfComponent);
  } catch {
    reasons.push("database_unreadable");
    return {
      ok: false, at, database: "unreadable", alertChannel,
      lastCycleAt: null, lastCycleAgeSeconds: null, lastCycleDetail: null,
      reasons,
    };
  }

  if (row === null) {
    // No cycle has recorded itself against this database. That is also what a
    // freshly deployed watchdog looks like for its first few minutes, so the
    // monitor's rule should be that this must clear, not that it must never
    // appear. Reported as unhealthy either way -- an absent record is not
    // evidence of a healthy one.
    reasons.push("no_cycle_recorded");
    return {
      ok: false, at, database: "bound", alertChannel,
      lastCycleAt: null, lastCycleAgeSeconds: null, lastCycleDetail: null,
      reasons,
    };
  }

  const lastCycleMs = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(lastCycleMs)) {
    reasons.push("last_cycle_unreadable");
    return {
      ok: false, at, database: "bound", alertChannel,
      lastCycleAt: row.lastSeenAt, lastCycleAgeSeconds: null, lastCycleDetail: row.detail,
      reasons,
    };
  }

  const ageSeconds = Math.floor((now.getTime() - lastCycleMs) / 1000);
  if (ageSeconds > row.expectedIntervalSeconds) reasons.push("last_cycle_stale");

  return {
    ok: reasons.length === 0,
    at,
    database: "bound",
    alertChannel,
    lastCycleAt: row.lastSeenAt,
    lastCycleAgeSeconds: ageSeconds,
    lastCycleDetail: row.detail,
    reasons,
  };
}

/** 200 only when nothing is wrong, so a monitor can key on the status alone. */
export async function handleHealth(dependencies: HealthDependencies): Promise<Response> {
  const report = await buildHealthReport(dependencies);
  return new Response(JSON.stringify(report), {
    status: report.ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

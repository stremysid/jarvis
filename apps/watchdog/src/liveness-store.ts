/**
 * The only place the watchdog touches D1.
 *
 * The table pair is the entire surface shared with Jarvis. The watchdog reads
 * component_liveness to decide, writes it only through the authenticated
 * heartbeat endpoint, and owns liveness_alerts outright. No gateway module is
 * imported to do any of it -- the SQL is written out here against a schema
 * whose shape is copied, not linked.
 */

import type { ComponentLivenessRow, OpenLivenessAlert } from "./liveness-check.js";

/**
 * A ceiling on how many components one cycle will consider.
 *
 * Not a performance guard so much as a refusal to answer a question it did not
 * fully ask: reading a bounded page and reporting on it as though it were the
 * whole table would leave components beyond the boundary unmonitored, with no
 * symptom anywhere. So the read asks for one row more than it will use, and
 * says so when it gets it.
 */
export const MAX_COMPONENTS = 500;

export interface ComponentReadResult {
  readonly rows: readonly ComponentLivenessRow[];
  /** True when the table held more rows than this cycle examined. */
  readonly truncated: boolean;
}

export interface HeartbeatWrite {
  readonly component: string;
  readonly expectedIntervalSeconds: number;
  readonly detail: string | null;
  readonly seenAt: string;
}

export interface AlertWrite {
  readonly alertId: string;
  readonly component: string;
  readonly lastSeenAt: string;
  readonly alertedAt: string;
}

export interface LivenessStore {
  readComponents(): Promise<ComponentReadResult>;
  readOpenAlerts(): Promise<readonly OpenLivenessAlert[]>;
  readComponent(component: string): Promise<ComponentLivenessRow | null>;
  /** Records an alert. Called only after the send was acknowledged. */
  recordAlert(alert: AlertWrite): Promise<void>;
  /** Closes every open alert for a component and opens the given one, atomically. */
  recordRecurrence(alert: AlertWrite): Promise<void>;
  recordRecovery(component: string, recoveredAt: string): Promise<void>;
  recordHeartbeat(heartbeat: HeartbeatWrite): Promise<void>;
}

interface ComponentDbRow {
  readonly component: string;
  readonly expected_interval_seconds: number;
  readonly last_seen_at: string;
  readonly detail: string | null;
  readonly suppressed_until: string | null;
}

interface AlertDbRow {
  readonly alert_id: string;
  readonly component: string;
  readonly last_seen_at: string;
  readonly alerted_at: string;
}

function toComponentRow(row: ComponentDbRow): ComponentLivenessRow {
  return {
    component: row.component,
    expectedIntervalSeconds: row.expected_interval_seconds,
    lastSeenAt: row.last_seen_at,
    detail: row.detail,
    suppressedUntil: row.suppressed_until,
  };
}

const SELECT_COMPONENTS = `
  SELECT component, expected_interval_seconds, last_seen_at, detail, suppressed_until
  FROM component_liveness
  ORDER BY component
  LIMIT ?
`;

const SELECT_ONE_COMPONENT = `
  SELECT component, expected_interval_seconds, last_seen_at, detail, suppressed_until
  FROM component_liveness
  WHERE component = ?
`;

const SELECT_OPEN_ALERTS = `
  SELECT alert_id, component, last_seen_at, alerted_at
  FROM liveness_alerts
  WHERE recovered_at IS NULL
  ORDER BY alerted_at
  LIMIT ?
`;

/**
 * Insert under the caller's deterministic alert id, ignoring an open collision.
 * A missing-row alert can recur with the same sentinel after recovery if its
 * heartbeat row is deleted. Reopen that closed alert so it can deduplicate.
 *
 * Two cron invocations overlapping would otherwise open two alerts for one
 * outage, and closing one on recovery would leave the other open forever --
 * after which the component reads as permanently "still down" and is never
 * alerted about again. That is a silent failure with no symptom, so it is
 * closed here at the write rather than reasoned about at the read.
 */
const INSERT_ALERT = `
  INSERT INTO liveness_alerts (alert_id, component, last_seen_at, alerted_at, recovered_at)
  VALUES (?, ?, ?, ?, NULL)
  ON CONFLICT(alert_id) DO UPDATE SET alerted_at = excluded.alerted_at, recovered_at = NULL
  WHERE liveness_alerts.last_seen_at = 'never' AND liveness_alerts.recovered_at IS NOT NULL
`;

/** By component, not by alert id, so a stray duplicate cannot outlive the outage. */
const CLOSE_OPEN_ALERTS = `
  UPDATE liveness_alerts
  SET recovered_at = ?
  WHERE component = ? AND recovered_at IS NULL
`;

/**
 * suppressed_until is cleared, never set, from a heartbeat.
 *
 * The migration says suppression is cleared by the next heartbeat, and this is
 * that. It is deliberately one-directional: letting a component declare its
 * own suppression window over the wire would let anything holding the shared
 * secret -- or anything that had gone wrong in a component's own code -- turn
 * off the alerting for itself indefinitely, which is the failure this Worker
 * is here to make impossible.
 */
const UPSERT_HEARTBEAT = `
  INSERT INTO component_liveness (
    component, expected_interval_seconds, last_seen_at, detail, suppressed_until, updated_at
  )
  VALUES (?, ?, ?, ?, NULL, ?)
  ON CONFLICT(component) DO UPDATE SET
    expected_interval_seconds = excluded.expected_interval_seconds,
    last_seen_at = excluded.last_seen_at,
    detail = excluded.detail,
    suppressed_until = NULL,
    updated_at = excluded.updated_at
`;

export class D1LivenessStore implements LivenessStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async readComponents(): Promise<ComponentReadResult> {
    const read = await this.#db.prepare(SELECT_COMPONENTS).bind(MAX_COMPONENTS + 1).all<ComponentDbRow>();
    const rows = read.results.slice(0, MAX_COMPONENTS).map(toComponentRow);
    return { rows, truncated: read.results.length > MAX_COMPONENTS };
  }

  async readComponent(component: string): Promise<ComponentLivenessRow | null> {
    const row = await this.#db.prepare(SELECT_ONE_COMPONENT).bind(component).first<ComponentDbRow>();
    return row === null ? null : toComponentRow(row);
  }

  async readOpenAlerts(): Promise<readonly OpenLivenessAlert[]> {
    const read = await this.#db.prepare(SELECT_OPEN_ALERTS).bind(MAX_COMPONENTS + 1).all<AlertDbRow>();
    return read.results.map((row) => ({
      alertId: row.alert_id,
      component: row.component,
      lastSeenAt: row.last_seen_at,
      alertedAt: row.alerted_at,
    }));
  }

  async recordAlert(alert: AlertWrite): Promise<void> {
    await this.#db
      .prepare(INSERT_ALERT)
      .bind(alert.alertId, alert.component, alert.lastSeenAt, alert.alertedAt)
      .run();
  }

  async recordRecurrence(alert: AlertWrite): Promise<void> {
    // One batch, so the previous outage is never closed without the new one
    // being opened. Split across two statements, a failure between them would
    // leave a component that is down looking like it has no open alert and no
    // history -- recoverable, but only by alerting twice about the same thing.
    await this.#db.batch([
      this.#db.prepare(CLOSE_OPEN_ALERTS).bind(alert.alertedAt, alert.component),
      this.#db.prepare(INSERT_ALERT).bind(alert.alertId, alert.component, alert.lastSeenAt, alert.alertedAt),
    ]);
  }

  async recordRecovery(component: string, recoveredAt: string): Promise<void> {
    await this.#db.prepare(CLOSE_OPEN_ALERTS).bind(recoveredAt, component).run();
  }

  async recordHeartbeat(heartbeat: HeartbeatWrite): Promise<void> {
    await this.#db
      .prepare(UPSERT_HEARTBEAT)
      .bind(
        heartbeat.component,
        heartbeat.expectedIntervalSeconds,
        heartbeat.seenAt,
        heartbeat.detail,
        heartbeat.seenAt,
      )
      .run();
  }
}

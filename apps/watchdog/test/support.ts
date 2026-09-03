import { env } from "cloudflare:test";
import type { AlertChannel, AlertOutcome } from "../src/alert-channel.js";
import type { Clock } from "../src/watchdog-run.js";

/** A clock frozen at one instant. Nothing under test reads the wall clock. */
export function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/**
 * An alert channel that records what it was asked to send and answers however
 * the test says. Delivery is a decision the test makes, because "was this
 * recorded before or after the send succeeded" is the property most of these
 * tests are about.
 */
export class RecordingAlertChannel implements AlertChannel {
  readonly configured = true;
  readonly sent: string[] = [];
  #outcome: (text: string) => AlertOutcome;

  constructor(outcome: (text: string) => AlertOutcome = () => ({ delivered: true })) {
    this.#outcome = outcome;
  }

  /** Switch behaviour between cycles, to model Telegram coming back. */
  respondWith(outcome: (text: string) => AlertOutcome): void {
    this.#outcome = outcome;
  }

  async send(text: string): Promise<AlertOutcome> {
    this.sent.push(text);
    return this.#outcome(text);
  }
}

export interface SeededComponent {
  readonly component: string;
  readonly expectedIntervalSeconds?: number;
  readonly lastSeenAt: string;
  readonly detail?: string | null;
  readonly suppressedUntil?: string | null;
}

export async function seedComponent(seed: SeededComponent): Promise<void> {
  await env.DB
    .prepare(`
      INSERT INTO component_liveness (
        component, expected_interval_seconds, last_seen_at, detail, suppressed_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(
      seed.component,
      seed.expectedIntervalSeconds ?? 300,
      seed.lastSeenAt,
      seed.detail ?? null,
      seed.suppressedUntil ?? null,
      seed.lastSeenAt,
    )
    .run();
}

export interface AlertRow {
  readonly alert_id: string;
  readonly component: string;
  readonly last_seen_at: string;
  readonly alerted_at: string;
  readonly recovered_at: string | null;
}

export async function alertRows(): Promise<AlertRow[]> {
  const read = await env.DB
    .prepare("SELECT alert_id, component, last_seen_at, alerted_at, recovered_at FROM liveness_alerts ORDER BY alerted_at, alert_id")
    .all<AlertRow>();
  return read.results;
}

export interface ComponentRow {
  readonly component: string;
  readonly expected_interval_seconds: number;
  readonly last_seen_at: string;
  readonly detail: string | null;
  readonly suppressed_until: string | null;
  readonly updated_at: string;
}

export async function componentRows(): Promise<ComponentRow[]> {
  const read = await env.DB
    .prepare("SELECT component, expected_interval_seconds, last_seen_at, detail, suppressed_until, updated_at FROM component_liveness ORDER BY component")
    .all<ComponentRow>();
  return read.results;
}

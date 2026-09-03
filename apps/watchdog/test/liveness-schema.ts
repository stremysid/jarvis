import { applyD1Migrations, env } from "cloudflare:test";

/**
 * The watchdog's own copy of the two tables it uses.
 *
 * The gateway's apps/cloud-gateway/src/persistence/migrations/0012_liveness.sql
 * is the deployed definition; this is a transcription of it, not an import.
 * Importing the file -- even with ?raw, even only in a test -- would put a path
 * into the gateway's tree in the watchdog's build graph, and the point of this
 * app is that nothing about it depends on that tree resolving.
 *
 * The cost of that choice is real and worth naming: if the gateway changes the
 * schema, nothing fails until this copy is updated by hand. What fails first is
 * production, not these tests. A reviewer changing 0012_liveness.sql should
 * change this too.
 */
const COMPONENT_LIVENESS = `
  CREATE TABLE component_liveness (
    component TEXT PRIMARY KEY CHECK (length(component) > 0 AND length(component) <= 64),
    expected_interval_seconds INTEGER NOT NULL CHECK (expected_interval_seconds > 0),
    last_seen_at TEXT NOT NULL,
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 256),
    suppressed_until TEXT,
    updated_at TEXT NOT NULL
  )
`;

const LIVENESS_ALERTS = `
  CREATE TABLE liveness_alerts (
    alert_id TEXT PRIMARY KEY,
    component TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    alerted_at TEXT NOT NULL,
    recovered_at TEXT
  )
`;

const LIVENESS_ALERTS_INDEX = `
  CREATE INDEX liveness_alerts_component_idx ON liveness_alerts(component, alerted_at)
`;

/**
 * Creates the tables in the real D1 test binding.
 *
 * Not memoised. `applyD1Migrations` records what it applied in the database
 * itself, so a second call against surviving storage is a no-op and a call
 * against storage the pool has rolled back rebuilds it. A memoised promise
 * would be correct only under one of those two behaviours and silently wrong
 * under the other.
 */
export function applyLivenessSchema(): Promise<void> {
  return applyD1Migrations(env.DB, [
    {
      name: "watchdog_liveness_schema.sql",
      queries: [COMPONENT_LIVENESS, LIVENESS_ALERTS, LIVENESS_ALERTS_INDEX],
    },
  ]);
}

/** Empties both tables so one test cannot see another's rows. */
export async function clearLivenessTables(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM liveness_alerts"),
    env.DB.prepare("DELETE FROM component_liveness"),
  ]);
}

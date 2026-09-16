-- Component liveness (plan section 6, watchdog).
--
-- The plan resolves the heartbeat as a standalone Worker with its own alert
-- path, deliberately not sharing code with Jarvis: the failure that kills
-- Jarvis must not also kill the thing whose job is to report it. This table
-- is the shared surface between them and holds nothing but timestamps -- the
-- watchdog reads it, and needs no part of Jarvis's code to do so.

CREATE TABLE component_liveness (
  component TEXT PRIMARY KEY CHECK (length(component) > 0 AND length(component) <= 64),
  -- How long silence is normal for this component. A local agent that sleeps
  -- overnight is not the same as a cron that runs every five minutes, and one
  -- global threshold would either alarm constantly or never.
  expected_interval_seconds INTEGER NOT NULL CHECK (expected_interval_seconds > 0),
  last_seen_at TEXT NOT NULL,
  -- Short and structural: a version, a cycle count. Never content.
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 256),
  -- Set while the component is knowingly down, so a planned shutdown does not
  -- page. Cleared by the next heartbeat.
  suppressed_until TEXT,
  updated_at TEXT NOT NULL
);

-- One row per alert actually sent, so the watchdog can tell "still down" from
-- "went down again" and does not re-alert every minute of a long outage.
CREATE TABLE liveness_alerts (
  alert_id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  alerted_at TEXT NOT NULL,
  recovered_at TEXT
);
CREATE INDEX liveness_alerts_component_idx ON liveness_alerts(component, alerted_at);

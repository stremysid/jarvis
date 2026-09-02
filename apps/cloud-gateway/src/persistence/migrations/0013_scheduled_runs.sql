-- What the scheduler has already done, so it does not do it twice.
--
-- Cloudflare cron triggers are at-least-once. A retry after a transient
-- failure re-invokes the handler with the same cron expression, and without a
-- record of the previous run the owner gets the morning digest twice. Worse,
-- an at-least-once poll that writes an observation each time turns a retry
-- into a fabricated second data point.
--
-- The daily digest is keyed by the owner's LOCAL date rather than by an
-- instant. The cron fires at two UTC hours so that one of them lands on the
-- target local hour year-round, and it is the local date that decides whether
-- today's digest has already gone out.

CREATE TABLE scheduled_runs (
  job TEXT NOT NULL CHECK (length(job) > 0 AND length(job) <= 32),
  -- The local calendar date for a daily job, or the ISO minute for a
  -- frequent one. Either way it is the key that makes a repeat a no-op.
  run_key TEXT NOT NULL CHECK (length(run_key) > 0 AND length(run_key) <= 32),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- NULL on success. A failed run stays recorded so a retry can tell the
  -- difference between work that is done and work that was attempted.
  failure TEXT CHECK (failure IS NULL OR length(failure) <= 512),
  PRIMARY KEY (job, run_key)
);
CREATE INDEX scheduled_runs_recent_idx ON scheduled_runs(job, started_at);

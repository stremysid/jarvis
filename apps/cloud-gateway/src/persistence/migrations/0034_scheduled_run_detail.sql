-- The detail a successful run returned, so a degraded success is not erased.
--
-- `ok: true` used to be the only fact recorded for a run that worked, and
-- `finish` cleared `failure` to NULL. Whatever the job said about itself on
-- that success -- a source that is not configured, a poll that skipped a
-- repository, a budget that stopped short -- lived only in the invocation's
-- return value and was gone by the time /status read the row.
--
-- Deliberately not folded into `failure`. The two are different facts: a run
-- that succeeded while reporting a gap is not a failed run, and /status must
-- not present it as one -- nor as a clean success.
--
-- Additive and nullable, so an existing row and an older gateway binary both
-- remain valid against it.

ALTER TABLE scheduled_runs ADD COLUMN detail TEXT CHECK (detail IS NULL OR length(detail) <= 512);

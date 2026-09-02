-- The deadline store (plan section 3) with effort-scaled reminders and
-- exam-mode quiet hours (plan section 5).
--
-- Two sources feed this -- the Google Classroom API and an authenticated
-- Brightspace scrape -- and the plan is explicit that both are load-bearing,
-- because coverage is split by teacher rather than by course. Once ingested
-- they are the same thing: a due date with a lead time. Nothing downstream
-- asks where a deadline came from.

CREATE TABLE deadline_sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('classroom', 'brightspace', 'manual')),
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_success_at TEXT,
  -- The last failure, kept until the next success. A source that has been
  -- failing silently for a week is the failure mode the plan names by name.
  last_failure TEXT CHECK (last_failure IS NULL OR length(last_failure) <= 512),
  last_failure_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((last_failure IS NULL) = (last_failure_at IS NULL))
);

CREATE TABLE deadlines (
  deadline_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES deadline_sources(source_id) ON DELETE RESTRICT,
  -- The id the source uses. Together with the source it is what makes a
  -- re-scrape an update rather than a duplicate.
  external_id TEXT NOT NULL,
  course TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) > 0 AND length(title) <= 512),
  due_at TEXT NOT NULL,
  -- Set at ingestion from title keywords or a per-course rule. It exists so a
  -- quiz and a term project are not reminded about identically.
  effort TEXT NOT NULL CHECK (effort IN ('quiz', 'test', 'exam', 'essay', 'project', 'other')),
  -- Derived from effort, overridable per deadline.
  lead_minutes INTEGER NOT NULL CHECK (lead_minutes >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'missed', 'cancelled')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  reminded_at TEXT,
  UNIQUE (source_id, external_id)
);
CREATE INDEX deadlines_due_idx ON deadlines(status, due_at);

-- Every version of a deadline we have seen. A due date that moves is the
-- thing most worth noticing, and a mutable row would lose the fact that it
-- moved at all.
CREATE TABLE deadline_revisions (
  revision_id TEXT PRIMARY KEY,
  deadline_id TEXT NOT NULL REFERENCES deadlines(deadline_id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  due_at TEXT NOT NULL,
  title TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX deadline_revisions_deadline_idx ON deadline_revisions(deadline_id, observed_at);

CREATE TRIGGER deadline_revisions_reject_delete
BEFORE DELETE ON deadline_revisions
BEGIN
  SELECT RAISE(ABORT, 'deadline_revision_delete_forbidden');
END;

CREATE TRIGGER deadline_revisions_reject_update
BEFORE UPDATE ON deadline_revisions
BEGIN
  SELECT RAISE(ABORT, 'deadline_revision_update_forbidden');
END;

-- Exam mode and any other window where non-urgent traffic is held. Payment
-- and error alerts still pass, because the suppression is checked per
-- message class rather than applied to the channel.
CREATE TABLE quiet_windows (
  window_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('exam', 'manual')),
  -- The deadline that created it, when it was derived rather than set by hand.
  deadline_id TEXT REFERENCES deadlines(deadline_id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  CHECK (ends_at > starts_at),
  CHECK ((reason = 'exam') = (deadline_id IS NOT NULL))
);
CREATE INDEX quiet_windows_span_idx ON quiet_windows(starts_at, ends_at);

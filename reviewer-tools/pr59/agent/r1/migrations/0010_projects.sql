-- The AI project manager (plan section 2) and the stalled-project detector
-- (plan section 5).
--
-- The plan's insight is that no new tracking discipline is needed: every
-- project already carries NEXT_STEPS.md, KNOWN_ISSUES.md, DECISIONS.md and
-- CHANGELOG.md, so a project following the standard is already reporting.
-- This schema holds what those four files said the last time we looked, and
-- when the repository was last touched.
--
-- Observations are append-only and separate from the current view. That is
-- what makes "KNOWN_ISSUES changed" answerable at all: a mutable row would
-- overwrite the previous content and leave nothing to compare against.

CREATE TABLE tracked_projects (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  repository TEXT NOT NULL CHECK (length(repository) > 0),
  display_name TEXT NOT NULL,
  -- Days without a commit before the project is called stalled. The detector
  -- only escalates when a deadline is also approaching, so this is a floor,
  -- not an alarm on its own.
  stale_after_days INTEGER NOT NULL DEFAULT 7 CHECK (stale_after_days > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (owner, repository)
);

CREATE TABLE project_observations (
  observation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES tracked_projects(project_id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  -- NULL when the poll failed. A failed poll is recorded rather than dropped:
  -- the plan's rule is that an empty or failed fetch alerts rather than
  -- silently reading as "nothing changed".
  head_sha TEXT CHECK (head_sha IS NULL OR (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*')),
  last_commit_at TEXT,
  failure TEXT CHECK (failure IS NULL OR length(failure) <= 512),
  CHECK ((head_sha IS NULL) = (failure IS NOT NULL))
);
CREATE INDEX project_observations_project_idx ON project_observations(project_id, observed_at);

CREATE TRIGGER project_observations_reject_delete
BEFORE DELETE ON project_observations
BEGIN
  SELECT RAISE(ABORT, 'project_observation_delete_forbidden');
END;

CREATE TABLE project_documents (
  document_id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES project_observations(observation_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES tracked_projects(project_id) ON DELETE RESTRICT,
  path TEXT NOT NULL CHECK (path IN ('NEXT_STEPS.md', 'KNOWN_ISSUES.md', 'DECISIONS.md', 'CHANGELOG.md')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  -- Bounded. The full document belongs in the archive, and what a digest
  -- needs is the top of the file. Letting this grow unbounded would turn
  -- every poll into a second copy of every tracked repository.
  excerpt TEXT NOT NULL CHECK (length(excerpt) <= 4096),
  observed_at TEXT NOT NULL
);
CREATE INDEX project_documents_latest_idx ON project_documents(project_id, path, observed_at);

CREATE TRIGGER project_documents_reject_delete
BEFORE DELETE ON project_documents
BEGIN
  SELECT RAISE(ABORT, 'project_document_delete_forbidden');
END;

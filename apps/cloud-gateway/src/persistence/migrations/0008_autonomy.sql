-- Tiered autonomy (plan section 4) and shadow mode (plan section 8).
--
-- The tier is a property of the capability, not of the caller: "send money"
-- is tier 3 no matter who asks or how confident the model is. Storing it in
-- the database rather than in code means a capability cannot quietly acquire
-- a lower tier through a refactor, and every change to one is an event.
--
-- Shadow mode is a separate axis. A capability at tier 2 is permitted in
-- principle, and shadow mode says the system is still proving itself and
-- will report what it would have done instead of doing it. Collapsing the
-- two into one setting would mean leaving shadow mode also silently unlocks
-- every tier-2 capability at once.
--
-- No semicolons in comments anywhere in this file. The test migration
-- splitter divides on them and would cut a statement in half.

CREATE TABLE capability_tiers (
  capability TEXT PRIMARY KEY,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  description TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tier 1: observation. Reading, monitoring, notifying the owner.
-- Tier 2: reversible action, logged. File edits in project folders, calendar.
-- Tier 3: never automatic. Money, third-party communication, deletion,
--         production systems. The owner confirms every time, even when the
--         system is fully autonomous otherwise -- this is the backstop that
--         holds when a prompt injection has successfully steered the model.
INSERT INTO capability_tiers (capability, tier, description, updated_at) VALUES
  ('notify.owner',        1, 'Send the owner a message on a channel they own', '2026-09-02T00:00:00.000Z'),
  ('read.archive',        1, 'Search and read the raw archive', '2026-09-02T00:00:00.000Z'),
  ('read.repository',     1, 'Poll a tracked repository''s status documents', '2026-09-02T00:00:00.000Z'),
  ('read.deadlines',      1, 'Read the deadline store', '2026-09-02T00:00:00.000Z'),
  ('write.project_file',  2, 'Edit a file inside a designated project folder', '2026-09-02T00:00:00.000Z'),
  ('write.calendar',      2, 'Create or move a calendar entry', '2026-09-02T00:00:00.000Z'),
  ('open.application',    2, 'Launch a local application', '2026-09-02T00:00:00.000Z'),
  ('vehicle.precondition',2, 'Precondition or set vehicle climate', '2026-09-02T00:00:00.000Z'),
  ('spend.money',         3, 'Any action that spends money', '2026-09-02T00:00:00.000Z'),
  ('contact.third_party', 3, 'Communicate with anyone who is not the owner', '2026-09-02T00:00:00.000Z'),
  ('delete.data',         3, 'Delete data anywhere', '2026-09-02T00:00:00.000Z'),
  ('write.production',    3, 'Touch a live production system', '2026-09-02T00:00:00.000Z'),
  ('vehicle.unlock',      3, 'Unlock or remote-start the vehicle', '2026-09-02T00:00:00.000Z');

CREATE TABLE autonomy_mode (
  -- Exactly one row. The CHECK is what enforces that: a second insert has
  -- nowhere to go.
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'live')),
  -- Set when leaving shadow mode, so "how long has it been live" is answerable
  -- without reading the whole event log.
  entered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Shadow first. The plan requires one to two weeks of observe-and-report
-- before any tier-2 action executes, and defaulting to live would make that
-- gate something you have to remember to close rather than one you open.
INSERT INTO autonomy_mode (singleton, mode, entered_at, updated_at)
VALUES (1, 'shadow', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');

CREATE TRIGGER autonomy_mode_reject_delete
BEFORE DELETE ON autonomy_mode
BEGIN
  SELECT RAISE(ABORT, 'autonomy_mode_delete_forbidden');
END;

-- Every evaluation, allowed or not, and every shadow-mode would-have-done.
-- Append-only: the record of what the system decided to do is worth as much
-- as the record of what it did, and both are evidence when something goes
-- wrong.
CREATE TABLE autonomy_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'live')),
  outcome TEXT NOT NULL CHECK (outcome IN ('permitted', 'withheld_shadow', 'requires_confirmation', 'denied_unknown_capability')),
  principal_id TEXT NOT NULL,
  -- What the action was, in the system's own words. Never the content it
  -- would have acted on: this table is read during incident review and must
  -- not become a second copy of the archive.
  summary TEXT NOT NULL CHECK (length(summary) <= 512),
  -- Set when outcome is requires_confirmation and a decision was raised.
  decision_id TEXT,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX autonomy_evaluations_capability_idx ON autonomy_evaluations(capability, evaluated_at);
CREATE INDEX autonomy_evaluations_outcome_idx ON autonomy_evaluations(outcome, evaluated_at);

CREATE TRIGGER autonomy_evaluations_reject_delete
BEFORE DELETE ON autonomy_evaluations
BEGIN
  SELECT RAISE(ABORT, 'autonomy_evaluation_delete_forbidden');
END;

CREATE TRIGGER autonomy_evaluations_reject_update
BEFORE UPDATE ON autonomy_evaluations
BEGIN
  SELECT RAISE(ABORT, 'autonomy_evaluation_update_forbidden');
END;

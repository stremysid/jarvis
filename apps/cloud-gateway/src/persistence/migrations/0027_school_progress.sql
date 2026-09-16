-- Verified school progress observations and derived no-submission-seen transitions.
--
-- Only the existing Google Classroom read-only route writes this slice.
-- Brightspace calendar data does not contain grades or submission state, so
-- no Brightspace progress route is represented here until the owner approves one.

CREATE TABLE school_progress_source_state (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES deadline_sources(source_id) ON DELETE RESTRICT,
  route TEXT NOT NULL CHECK (route = 'classroom_api'),
  checkpoint_course_id TEXT CHECK (
    checkpoint_course_id IS NULL OR (
      length(checkpoint_course_id) BETWEEN 1 AND 256
      AND instr(checkpoint_course_id, char(0)) = 0
      AND instr(checkpoint_course_id, char(10)) = 0
      AND instr(checkpoint_course_id, char(13)) = 0
    )
  ),
  checkpoint_work_item_external_id TEXT CHECK (
    checkpoint_work_item_external_id IS NULL OR (
      length(checkpoint_work_item_external_id) BETWEEN 1 AND 256
      AND instr(checkpoint_work_item_external_id, char(0)) = 0
      AND instr(checkpoint_work_item_external_id, char(10)) = 0
      AND instr(checkpoint_work_item_external_id, char(13)) = 0
    )
  ),
  last_success_at TEXT CHECK (
    last_success_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) IS last_success_at
  ),
  last_failure TEXT CHECK (
    last_failure IS NULL OR (
      length(last_failure) BETWEEN 1 AND 512
      AND instr(last_failure, char(0)) = 0
      AND instr(last_failure, char(10)) = 0
      AND instr(last_failure, char(13)) = 0
    )
  ),
  last_failure_at TEXT CHECK (
    last_failure_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_failure_at) IS last_failure_at
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, source_id),
  CHECK ((last_failure IS NULL) = (last_failure_at IS NULL)),
  CHECK (checkpoint_work_item_external_id IS NULL OR checkpoint_course_id IS NOT NULL),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE TABLE school_progress_work_items (
  principal_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL CHECK (
    length(work_item_id) = 26
    AND substr(work_item_id, 1, 1) GLOB '[0-7]'
    AND work_item_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (
    length(external_id) BETWEEN 1 AND 256
    AND instr(external_id, char(0)) = 0
    AND instr(external_id, char(10)) = 0
    AND instr(external_id, char(13)) = 0
  ),
  course_name TEXT NOT NULL CHECK (
    length(course_name) BETWEEN 1 AND 512
    AND instr(course_name, char(0)) = 0
    AND instr(course_name, char(10)) = 0
    AND instr(course_name, char(13)) = 0
  ),
  title TEXT NOT NULL CHECK (
    length(title) BETWEEN 1 AND 512
    AND instr(title, char(0)) = 0
    AND instr(title, char(10)) = 0
    AND instr(title, char(13)) = 0
  ),
  due_at TEXT CHECK (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at) IS due_at),
  maximum_points REAL CHECK (
    maximum_points IS NULL OR (
      typeof(maximum_points) IN ('integer', 'real')
      AND maximum_points > 0
      AND maximum_points <= 1000000
    )
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  first_seen_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', first_seen_at) IS first_seen_at),
  last_seen_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS last_seen_at),
  PRIMARY KEY (principal_id, work_item_id),
  UNIQUE (principal_id, source_id, external_id),
  FOREIGN KEY (principal_id, source_id)
    REFERENCES school_progress_source_state(principal_id, source_id) ON DELETE RESTRICT,
  CHECK (last_seen_at >= first_seen_at)
) WITHOUT ROWID;

CREATE INDEX school_progress_work_items_due_idx
ON school_progress_work_items(principal_id, due_at, work_item_id);

CREATE TABLE school_submission_observations (
  principal_id TEXT NOT NULL,
  observation_id TEXT NOT NULL CHECK (
    length(observation_id) = 26
    AND substr(observation_id, 1, 1) GLOB '[0-7]'
    AND observation_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  work_item_id TEXT NOT NULL,
  external_submission_id TEXT NOT NULL CHECK (
    length(external_submission_id) BETWEEN 1 AND 256
    AND instr(external_submission_id, char(0)) = 0
    AND instr(external_submission_id, char(10)) = 0
    AND instr(external_submission_id, char(13)) = 0
  ),
  submission_state TEXT NOT NULL CHECK (
    submission_state IN ('new', 'created', 'turned_in', 'returned', 'reclaimed', 'edited_after_turn_in')
  ),
  late INTEGER CHECK (late IS NULL OR late IN (0, 1)),
  source_updated_at TEXT CHECK (
    source_updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at) IS source_updated_at
  ),
  observed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (principal_id, observation_id),
  UNIQUE (principal_id, work_item_id, content_hash),
  FOREIGN KEY (principal_id, work_item_id)
    REFERENCES school_progress_work_items(principal_id, work_item_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX school_submission_observations_latest_idx
ON school_submission_observations(principal_id, work_item_id, observed_at DESC, observation_id DESC);

CREATE TABLE school_grade_observations (
  principal_id TEXT NOT NULL,
  grade_observation_id TEXT NOT NULL CHECK (
    length(grade_observation_id) = 26
    AND substr(grade_observation_id, 1, 1) GLOB '[0-7]'
    AND grade_observation_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  work_item_id TEXT NOT NULL,
  assigned_points REAL NOT NULL CHECK (
    typeof(assigned_points) IN ('integer', 'real')
    AND assigned_points >= 0
    AND assigned_points <= 1000000
  ),
  maximum_points REAL CHECK (
    maximum_points IS NULL OR (
      typeof(maximum_points) IN ('integer', 'real')
      AND maximum_points > 0
      AND maximum_points <= 1000000
    )
  ),
  source_updated_at TEXT CHECK (
    source_updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at) IS source_updated_at
  ),
  observed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (principal_id, grade_observation_id),
  UNIQUE (principal_id, work_item_id, content_hash),
  FOREIGN KEY (principal_id, work_item_id)
    REFERENCES school_progress_work_items(principal_id, work_item_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX school_grade_observations_latest_idx
ON school_grade_observations(principal_id, observed_at DESC, grade_observation_id DESC);

CREATE TABLE school_missing_work_transitions (
  principal_id TEXT NOT NULL,
  transition_id TEXT NOT NULL CHECK (
    length(transition_id) = 26
    AND substr(transition_id, 1, 1) GLOB '[0-7]'
    AND transition_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  work_item_id TEXT NOT NULL,
  derived_state TEXT NOT NULL CHECK (
    derived_state IN ('no_submission_seen', 'submission_seen', 'not_past_due')
  ),
  basis_due_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', basis_due_at) IS basis_due_at),
  basis_checked_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', basis_checked_at) IS basis_checked_at),
  basis_submission_observation_id TEXT,
  derived_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', derived_at) IS derived_at),
  PRIMARY KEY (principal_id, transition_id),
  FOREIGN KEY (principal_id, work_item_id)
    REFERENCES school_progress_work_items(principal_id, work_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, basis_submission_observation_id)
    REFERENCES school_submission_observations(principal_id, observation_id) ON DELETE RESTRICT,
  CHECK (
    (derived_state = 'submission_seen' AND basis_submission_observation_id IS NOT NULL)
    OR (derived_state != 'submission_seen' AND basis_submission_observation_id IS NULL)
  )
) WITHOUT ROWID;

CREATE INDEX school_missing_work_transitions_latest_idx
ON school_missing_work_transitions(principal_id, work_item_id, derived_at DESC, transition_id DESC);

CREATE TRIGGER school_progress_source_state_insert_guard
BEFORE INSERT ON school_progress_source_state
WHEN EXISTS (
  SELECT 1 FROM school_progress_source_state
  WHERE principal_id = NEW.principal_id AND source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'school_progress_source_insert_conflict');
END;

CREATE TRIGGER school_progress_source_state_require_classroom
BEFORE INSERT ON school_progress_source_state
WHEN NEW.source_id != 'google-classroom'
  OR NEW.route != 'classroom_api'
  OR NOT EXISTS (
    SELECT 1 FROM deadline_sources
    WHERE source_id = NEW.source_id AND kind = 'classroom'
  )
BEGIN
  SELECT RAISE(ABORT, 'school_progress_source_invalid');
END;

CREATE TRIGGER school_progress_source_state_core_immutable
BEFORE UPDATE ON school_progress_source_state
WHEN NEW.principal_id IS NOT OLD.principal_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.route IS NOT OLD.route
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'school_progress_source_core_immutable');
END;

CREATE TRIGGER school_progress_source_state_reject_delete
BEFORE DELETE ON school_progress_source_state
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_progress_source_delete_forbidden');
END;

CREATE TRIGGER school_progress_work_items_insert_guard
BEFORE INSERT ON school_progress_work_items
WHEN EXISTS (
  SELECT 1 FROM school_progress_work_items
  WHERE principal_id = NEW.principal_id
    AND (work_item_id = NEW.work_item_id OR (source_id = NEW.source_id AND external_id = NEW.external_id))
)
BEGIN
  SELECT RAISE(ABORT, 'school_progress_work_item_insert_conflict');
END;

CREATE TRIGGER school_progress_work_items_core_immutable
BEFORE UPDATE ON school_progress_work_items
WHEN NEW.principal_id IS NOT OLD.principal_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.external_id IS NOT OLD.external_id
  OR NEW.first_seen_at IS NOT OLD.first_seen_at
  OR NEW.last_seen_at < OLD.last_seen_at
BEGIN
  SELECT RAISE(ABORT, 'school_progress_work_item_core_immutable');
END;

CREATE TRIGGER school_progress_work_items_reject_delete
BEFORE DELETE ON school_progress_work_items
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_progress_work_item_delete_forbidden');
END;

CREATE TRIGGER school_submission_observations_insert_guard
BEFORE INSERT ON school_submission_observations
WHEN EXISTS (
  SELECT 1 FROM school_submission_observations
  WHERE principal_id = NEW.principal_id
    AND (observation_id = NEW.observation_id OR (work_item_id = NEW.work_item_id AND content_hash = NEW.content_hash))
)
BEGIN
  SELECT RAISE(ABORT, 'school_submission_observation_insert_conflict');
END;

CREATE TRIGGER school_submission_observations_reject_update
BEFORE UPDATE ON school_submission_observations
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_submission_observation_update_forbidden');
END;

CREATE TRIGGER school_submission_observations_reject_delete
BEFORE DELETE ON school_submission_observations
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_submission_observation_delete_forbidden');
END;

CREATE TRIGGER school_grade_observations_insert_guard
BEFORE INSERT ON school_grade_observations
WHEN EXISTS (
  SELECT 1 FROM school_grade_observations
  WHERE principal_id = NEW.principal_id
    AND (grade_observation_id = NEW.grade_observation_id OR (work_item_id = NEW.work_item_id AND content_hash = NEW.content_hash))
)
BEGIN
  SELECT RAISE(ABORT, 'school_grade_observation_insert_conflict');
END;

CREATE TRIGGER school_grade_observations_reject_update
BEFORE UPDATE ON school_grade_observations
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_grade_observation_update_forbidden');
END;

CREATE TRIGGER school_grade_observations_reject_delete
BEFORE DELETE ON school_grade_observations
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_grade_observation_delete_forbidden');
END;

CREATE TRIGGER school_missing_work_transitions_insert_guard
BEFORE INSERT ON school_missing_work_transitions
WHEN EXISTS (
  SELECT 1 FROM school_missing_work_transitions
  WHERE principal_id = NEW.principal_id AND transition_id = NEW.transition_id
)
BEGIN
  SELECT RAISE(ABORT, 'school_missing_work_transition_insert_conflict');
END;

CREATE TRIGGER school_missing_work_transitions_basis_guard
BEFORE INSERT ON school_missing_work_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM school_progress_work_items item
  WHERE item.principal_id = NEW.principal_id
    AND item.work_item_id = NEW.work_item_id
    AND item.due_at = NEW.basis_due_at
    AND item.last_seen_at = NEW.basis_checked_at
    AND (
      (NEW.derived_state = 'no_submission_seen'
        AND item.due_at <= NEW.derived_at
        AND COALESCE((
          SELECT observation.submission_state
          FROM school_submission_observations observation
          WHERE observation.principal_id = item.principal_id
            AND observation.work_item_id = item.work_item_id
            AND observation.observed_at <= NEW.basis_checked_at
          ORDER BY observation.observed_at DESC, observation.observation_id DESC
          LIMIT 1
        ), '') NOT IN ('turned_in', 'returned'))
      OR (NEW.derived_state = 'submission_seen'
        AND EXISTS (
          SELECT 1 FROM school_submission_observations observation
          WHERE observation.principal_id = NEW.principal_id
            AND observation.observation_id = NEW.basis_submission_observation_id
            AND observation.work_item_id = NEW.work_item_id
            AND observation.submission_state IN ('turned_in', 'returned')
        ))
      OR (NEW.derived_state = 'not_past_due' AND item.due_at > NEW.derived_at)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'school_missing_work_transition_basis_invalid');
END;

CREATE TRIGGER school_missing_work_transitions_reject_update
BEFORE UPDATE ON school_missing_work_transitions
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_missing_work_transition_update_forbidden');
END;

CREATE TRIGGER school_missing_work_transitions_reject_delete
BEFORE DELETE ON school_missing_work_transitions
WHEN 1
BEGIN
  SELECT RAISE(ABORT, 'school_missing_work_transition_delete_forbidden');
END;

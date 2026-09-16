-- Verified Classroom submission observations and derived missing-work state.
--
-- Brightspace calendar feeds do not carry either grades or submissions. This
-- store accepts the already configured read-only Classroom route only. A
-- deadline passing is never stored as a factual miss. It can produce the
-- explicitly derived state no_submission_seen after a completed source scan.

CREATE TABLE school_observation_sync (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES deadline_sources(source_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'google_classroom_api'),
  checkpoint_course_id TEXT CHECK (
    checkpoint_course_id IS NULL OR length(checkpoint_course_id) BETWEEN 1 AND 256
  ),
  checkpoint_page_token TEXT CHECK (
    checkpoint_page_token IS NULL OR length(checkpoint_page_token) BETWEEN 1 AND 2048
  ),
  scan_started_at TEXT CHECK (
    scan_started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', scan_started_at) IS scan_started_at
  ),
  derivation_scan_at TEXT CHECK (
    derivation_scan_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', derivation_scan_at) IS derivation_scan_at
  ),
  derivation_started_at TEXT CHECK (
    derivation_started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', derivation_started_at) IS derivation_started_at
  ),
  derivation_after_deadline_id TEXT CHECK (
    derivation_after_deadline_id IS NULL OR length(derivation_after_deadline_id) BETWEEN 1 AND 256
  ),
  last_batch_at TEXT CHECK (
    last_batch_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_batch_at) IS last_batch_at
  ),
  last_success_at TEXT CHECK (
    last_success_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) IS last_success_at
  ),
  last_success_started_at TEXT CHECK (
    last_success_started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_success_started_at) IS last_success_started_at
  ),
  last_failure TEXT CHECK (last_failure IS NULL OR length(last_failure) BETWEEN 1 AND 160),
  last_failure_at TEXT CHECK (
    last_failure_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_failure_at) IS last_failure_at
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, source_id),
  CHECK ((last_failure IS NULL) = (last_failure_at IS NULL)),
  CHECK ((last_success_at IS NULL) = (last_success_started_at IS NULL)),
  CHECK (
    (checkpoint_course_id IS NULL AND checkpoint_page_token IS NULL AND scan_started_at IS NULL)
    OR (checkpoint_course_id IS NOT NULL AND scan_started_at IS NOT NULL)
  ),
  CHECK (checkpoint_page_token IS NULL OR checkpoint_course_id IS NOT NULL),
  CHECK (derivation_after_deadline_id IS NULL OR derivation_scan_at IS NOT NULL),
  CHECK ((derivation_scan_at IS NULL) = (derivation_started_at IS NULL)),
  CHECK (scan_started_at IS NULL OR derivation_scan_at IS NULL),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE TABLE school_assignment_observations (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  observation_id TEXT NOT NULL CHECK (
    length(observation_id) = 26
    AND substr(observation_id, 1, 1) GLOB '[0-7]'
    AND observation_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  source_id TEXT NOT NULL REFERENCES deadline_sources(source_id) ON DELETE RESTRICT,
  deadline_id TEXT NOT NULL REFERENCES deadlines(deadline_id) ON DELETE RESTRICT,
  external_submission_id TEXT NOT NULL CHECK (length(external_submission_id) BETWEEN 1 AND 256),
  submission_state TEXT NOT NULL CHECK (submission_state IN (
    'new', 'created', 'turned_in', 'returned', 'reclaimed_by_student', 'student_edited_after_turn_in'
  )),
  late INTEGER CHECK (late IS NULL OR late IN (0, 1)),
  assigned_grade REAL CHECK (
    assigned_grade IS NULL OR (
      typeof(assigned_grade) IN ('integer', 'real')
      AND assigned_grade >= 0
      AND assigned_grade <= 1000000000
    )
  ),
  source_updated_at TEXT CHECK (
    source_updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at) IS source_updated_at
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  first_seen_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', first_seen_at) IS first_seen_at),
  content_changed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', content_changed_at) IS content_changed_at
  ),
  last_seen_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS last_seen_at),
  PRIMARY KEY (principal_id, observation_id),
  UNIQUE (principal_id, deadline_id),
  UNIQUE (principal_id, source_id, external_submission_id),
  CHECK (content_changed_at >= first_seen_at),
  CHECK (last_seen_at >= content_changed_at)
) WITHOUT ROWID;

CREATE INDEX school_assignment_observations_grade_idx
ON school_assignment_observations(principal_id, assigned_grade, content_changed_at, deadline_id);

CREATE TABLE school_assignment_observation_revisions (
  principal_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK (
    length(revision_id) = 26
    AND substr(revision_id, 1, 1) GLOB '[0-7]'
    AND revision_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  observation_id TEXT NOT NULL,
  submission_state TEXT NOT NULL CHECK (submission_state IN (
    'new', 'created', 'turned_in', 'returned', 'reclaimed_by_student', 'student_edited_after_turn_in'
  )),
  late INTEGER CHECK (late IS NULL OR late IN (0, 1)),
  assigned_grade REAL CHECK (
    assigned_grade IS NULL OR (
      typeof(assigned_grade) IN ('integer', 'real')
      AND assigned_grade >= 0
      AND assigned_grade <= 1000000000
    )
  ),
  source_updated_at TEXT CHECK (
    source_updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at) IS source_updated_at
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  content_changed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', content_changed_at) IS content_changed_at
  ),
  replaced_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', replaced_at) IS replaced_at),
  PRIMARY KEY (principal_id, revision_id),
  UNIQUE (principal_id, observation_id, replaced_at),
  FOREIGN KEY (principal_id, observation_id)
    REFERENCES school_assignment_observations(principal_id, observation_id) ON DELETE RESTRICT,
  CHECK (replaced_at >= content_changed_at)
) WITHOUT ROWID;

CREATE INDEX school_assignment_observation_revisions_history_idx
ON school_assignment_observation_revisions(principal_id, observation_id, replaced_at, revision_id);

CREATE TABLE school_missing_work_transitions (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  transition_id TEXT NOT NULL CHECK (
    length(transition_id) = 26
    AND substr(transition_id, 1, 1) GLOB '[0-7]'
    AND transition_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  deadline_id TEXT NOT NULL REFERENCES deadlines(deadline_id) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification = 'derived'),
  from_state TEXT NOT NULL CHECK (from_state IN (
    'untracked', 'not_due', 'no_submission_seen', 'submission_seen', 'closed'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'not_due', 'no_submission_seen', 'submission_seen', 'closed'
  )),
  basis_due_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', basis_due_at) IS basis_due_at),
  basis_observation_id TEXT,
  derived_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', derived_at) IS derived_at),
  PRIMARY KEY (principal_id, transition_id),
  UNIQUE (principal_id, deadline_id, derived_at),
  FOREIGN KEY (principal_id, basis_observation_id)
    REFERENCES school_assignment_observations(principal_id, observation_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX school_missing_work_transitions_current_idx
ON school_missing_work_transitions(principal_id, deadline_id, derived_at, transition_id);

CREATE TRIGGER school_observation_sync_insert_guard
BEFORE INSERT ON school_observation_sync
WHEN EXISTS (
  SELECT 1 FROM school_observation_sync
  WHERE principal_id = NEW.principal_id AND source_id = NEW.source_id
) OR NOT EXISTS (
  SELECT 1 FROM deadline_sources
  WHERE source_id = NEW.source_id AND kind = 'classroom'
)
BEGIN
  SELECT RAISE(ABORT, 'school_observation_sync_insert_invalid');
END;

CREATE TRIGGER school_observation_sync_update_guard
BEFORE UPDATE ON school_observation_sync
WHEN NEW.principal_id IS NOT OLD.principal_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.provider IS NOT OLD.provider
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.updated_at < OLD.updated_at
  OR (OLD.last_batch_at IS NOT NULL AND (NEW.last_batch_at IS NULL OR NEW.last_batch_at < OLD.last_batch_at))
  OR (OLD.last_success_at IS NOT NULL AND (NEW.last_success_at IS NULL OR NEW.last_success_at < OLD.last_success_at))
  OR (
    OLD.last_success_started_at IS NOT NULL
    AND (NEW.last_success_started_at IS NULL OR NEW.last_success_started_at < OLD.last_success_started_at)
  )
  OR NOT EXISTS (
    SELECT 1 FROM deadline_sources
    WHERE source_id = NEW.source_id AND kind = 'classroom'
  )
BEGIN
  SELECT RAISE(ABORT, 'school_observation_sync_update_invalid');
END;

CREATE TRIGGER school_observation_sync_delete_guard
BEFORE DELETE ON school_observation_sync
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'school_observation_sync_delete_forbidden');
END;

CREATE TRIGGER school_assignment_observations_insert_guard
BEFORE INSERT ON school_assignment_observations
WHEN EXISTS (
  SELECT 1 FROM school_assignment_observations
  WHERE principal_id = NEW.principal_id
    AND (
      observation_id = NEW.observation_id
      OR deadline_id = NEW.deadline_id
      OR (source_id = NEW.source_id AND external_submission_id = NEW.external_submission_id)
    )
) OR NOT EXISTS (
  SELECT 1 FROM school_observation_sync
  WHERE principal_id = NEW.principal_id AND source_id = NEW.source_id
) OR NOT EXISTS (
  SELECT 1 FROM deadlines AS d
  JOIN deadline_sources AS s ON s.source_id = d.source_id
  WHERE d.deadline_id = NEW.deadline_id
    AND d.source_id = NEW.source_id
    AND s.kind = 'classroom'
)
BEGIN
  SELECT RAISE(ABORT, 'school_assignment_observation_insert_invalid');
END;

CREATE TRIGGER school_assignment_observations_update_guard
BEFORE UPDATE ON school_assignment_observations
WHEN NEW.principal_id IS NOT OLD.principal_id
  OR NEW.observation_id IS NOT OLD.observation_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.deadline_id IS NOT OLD.deadline_id
  OR NEW.external_submission_id IS NOT OLD.external_submission_id
  OR NEW.first_seen_at IS NOT OLD.first_seen_at
  OR NEW.last_seen_at < OLD.last_seen_at
  OR NEW.content_changed_at < OLD.content_changed_at
  OR NOT EXISTS (
    SELECT 1 FROM deadlines AS d
    JOIN deadline_sources AS s ON s.source_id = d.source_id
    WHERE d.deadline_id = NEW.deadline_id
      AND d.source_id = NEW.source_id
      AND s.kind = 'classroom'
  )
  OR (
    NEW.content_hash IS OLD.content_hash
    AND (
      NEW.submission_state IS NOT OLD.submission_state
      OR NEW.late IS NOT OLD.late
      OR NEW.assigned_grade IS NOT OLD.assigned_grade
      OR NEW.source_updated_at IS NOT OLD.source_updated_at
      OR NEW.content_changed_at IS NOT OLD.content_changed_at
    )
  )
  OR (
    NEW.content_hash IS NOT OLD.content_hash
    AND NOT EXISTS (
      SELECT 1 FROM school_assignment_observation_revisions
      WHERE principal_id = OLD.principal_id
        AND observation_id = OLD.observation_id
        AND submission_state = OLD.submission_state
        AND late IS OLD.late
        AND assigned_grade IS OLD.assigned_grade
        AND source_updated_at IS OLD.source_updated_at
        AND content_hash = OLD.content_hash
        AND content_changed_at = OLD.content_changed_at
        AND replaced_at = NEW.content_changed_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'school_assignment_observation_update_invalid');
END;

CREATE TRIGGER school_assignment_observations_delete_guard
BEFORE DELETE ON school_assignment_observations
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'school_assignment_observation_delete_forbidden');
END;

CREATE TRIGGER school_assignment_observation_revisions_insert_guard
BEFORE INSERT ON school_assignment_observation_revisions
WHEN EXISTS (
  SELECT 1 FROM school_assignment_observation_revisions
  WHERE principal_id = NEW.principal_id
    AND (
      revision_id = NEW.revision_id
      OR (observation_id = NEW.observation_id AND replaced_at = NEW.replaced_at)
    )
) OR NOT EXISTS (
  SELECT 1 FROM school_assignment_observations
  WHERE principal_id = NEW.principal_id
    AND observation_id = NEW.observation_id
    AND submission_state = NEW.submission_state
    AND late IS NEW.late
    AND assigned_grade IS NEW.assigned_grade
    AND source_updated_at IS NEW.source_updated_at
    AND content_hash = NEW.content_hash
    AND content_changed_at = NEW.content_changed_at
    AND last_seen_at <= NEW.replaced_at
)
BEGIN
  SELECT RAISE(ABORT, 'school_assignment_observation_revision_insert_invalid');
END;

CREATE TRIGGER school_assignment_observation_revisions_update_guard
BEFORE UPDATE ON school_assignment_observation_revisions
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'school_assignment_observation_revision_update_forbidden');
END;

CREATE TRIGGER school_assignment_observation_revisions_delete_guard
BEFORE DELETE ON school_assignment_observation_revisions
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'school_assignment_observation_revision_delete_forbidden');
END;

CREATE TRIGGER school_missing_work_transitions_insert_guard
BEFORE INSERT ON school_missing_work_transitions
WHEN EXISTS (
  SELECT 1 FROM school_missing_work_transitions
  WHERE principal_id = NEW.principal_id
    AND (
      transition_id = NEW.transition_id
      OR (deadline_id = NEW.deadline_id AND derived_at = NEW.derived_at)
    )
) OR NOT EXISTS (
  SELECT 1 FROM school_observation_sync AS sync
  JOIN deadlines AS d ON d.source_id = sync.source_id
  JOIN deadline_sources AS s ON s.source_id = d.source_id
  WHERE sync.principal_id = NEW.principal_id
    AND d.deadline_id = NEW.deadline_id
    AND s.kind = 'classroom'
    AND sync.last_success_at IS NOT NULL
    AND sync.last_success_at = NEW.derived_at
    AND sync.derivation_scan_at = NEW.derived_at
    AND sync.derivation_started_at IS NOT NULL
    AND d.due_at = NEW.basis_due_at
) OR NEW.from_state IS NOT COALESCE((
  SELECT to_state FROM school_missing_work_transitions
  WHERE principal_id = NEW.principal_id AND deadline_id = NEW.deadline_id
  ORDER BY derived_at DESC, transition_id DESC
  LIMIT 1
), 'untracked') OR NOT (
  (
    NEW.to_state = 'closed'
    AND NEW.basis_observation_id IS NULL
    AND EXISTS (
      SELECT 1 FROM deadlines
      WHERE deadline_id = NEW.deadline_id AND status != 'open'
    )
  ) OR (
    NEW.to_state = 'submission_seen'
    AND EXISTS (
      SELECT 1 FROM school_assignment_observations
      WHERE principal_id = NEW.principal_id
        AND observation_id = NEW.basis_observation_id
        AND deadline_id = NEW.deadline_id
        AND last_seen_at >= (
          SELECT sync.derivation_started_at
          FROM school_observation_sync AS sync
          JOIN deadlines AS covered ON covered.source_id = sync.source_id
          WHERE sync.principal_id = NEW.principal_id AND covered.deadline_id = NEW.deadline_id
        )
        AND submission_state IN ('turned_in', 'returned', 'student_edited_after_turn_in')
    )
  ) OR (
    NEW.to_state IN ('not_due', 'no_submission_seen')
    AND EXISTS (
      SELECT 1 FROM deadlines
      WHERE deadline_id = NEW.deadline_id
        AND status = 'open'
        AND (
          (NEW.to_state = 'not_due' AND due_at > NEW.derived_at)
          OR (NEW.to_state = 'no_submission_seen' AND due_at <= NEW.derived_at)
        )
    )
    AND (
      EXISTS (
        SELECT 1 FROM school_assignment_observations
        WHERE principal_id = NEW.principal_id
          AND observation_id = NEW.basis_observation_id
          AND deadline_id = NEW.deadline_id
          AND last_seen_at >= (
            SELECT sync.derivation_started_at
            FROM school_observation_sync AS sync
            JOIN deadlines AS covered ON covered.source_id = sync.source_id
            WHERE sync.principal_id = NEW.principal_id AND covered.deadline_id = NEW.deadline_id
          )
          AND submission_state IN ('new', 'created', 'reclaimed_by_student')
          AND (
            NEW.to_state = 'not_due'
            OR last_seen_at >= (
              SELECT due_at FROM deadlines WHERE deadline_id = NEW.deadline_id
            )
          )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'school_missing_work_transition_insert_invalid');
END;

CREATE TRIGGER school_missing_work_transitions_update_guard
BEFORE UPDATE ON school_missing_work_transitions
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'school_missing_work_transition_update_forbidden');
END;

CREATE TRIGGER school_missing_work_transitions_delete_guard
BEFORE DELETE ON school_missing_work_transitions
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'school_missing_work_transition_delete_forbidden');
END;

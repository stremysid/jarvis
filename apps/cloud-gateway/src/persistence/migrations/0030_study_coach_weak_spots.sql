-- R5A daily weak-spot claims and direct-owner retirement controls.
-- Raw grades, missing-work observations, deadlines, and quiz evidence stay in
-- their existing authority tables. These rows remember only what was chosen
-- for a daily check-in and which cited signals Sid later retired.

CREATE TABLE school_study_check_in_claims (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  claim_id TEXT NOT NULL CHECK (
    length(claim_id) = 26
    AND substr(claim_id, 1, 1) GLOB '[0-7]'
    AND claim_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  local_date TEXT NOT NULL CHECK (
    length(local_date) = 10
    AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND strftime('%Y-%m-%d', local_date) IS local_date
  ),
  course_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (
    length(topic) BETWEEN 1 AND 512
    AND instr(topic, char(0)) = 0
    AND instr(topic, char(10)) = 0
    AND instr(topic, char(13)) = 0
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('uncertain', 'wrong')),
  evidence_count INTEGER NOT NULL CHECK (evidence_count BETWEEN 1 AND 4),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  observed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at),
  citations_json TEXT NOT NULL CHECK (
    json_valid(citations_json)
    AND json_type(citations_json) = 'array'
    AND json_array_length(citations_json) BETWEEN 1 AND 4
    AND length(CAST(citations_json AS BLOB)) <= 4096
  ),
  source_keys_json TEXT NOT NULL CHECK (
    json_valid(source_keys_json)
    AND json_type(source_keys_json) = 'array'
    AND json_array_length(source_keys_json) = evidence_count
    AND length(CAST(source_keys_json AS BLOB)) <= 1024
  ),
  claimed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at),
  PRIMARY KEY (principal_id, local_date),
  UNIQUE (principal_id, claim_id),
  FOREIGN KEY (principal_id, course_id)
    REFERENCES school_course_cards(principal_id, course_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX school_study_check_in_claims_latest_idx
ON school_study_check_in_claims(principal_id, local_date DESC, claimed_at DESC);

CREATE TABLE school_study_signal_controls (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 160),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('grade', 'missing_work', 'deadline')),
  source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 256),
  disposition TEXT NOT NULL CHECK (disposition IN ('wrong', 'handled')),
  check_in_id TEXT NOT NULL,
  control_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  controlled_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', controlled_at) IS controlled_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (principal_id, source_key),
  FOREIGN KEY (principal_id, check_in_id)
    REFERENCES school_study_check_in_claims(principal_id, claim_id) ON DELETE RESTRICT,
  CHECK (created_at = controlled_at)
) WITHOUT ROWID;

CREATE TRIGGER school_study_check_in_claims_insert_guard
BEFORE INSERT ON school_study_check_in_claims
BEGIN
  SELECT RAISE(ABORT, 'school_study_check_in_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_study_check_in_claims
    WHERE principal_id = NEW.principal_id
      AND (local_date = NEW.local_date OR claim_id = NEW.claim_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM school_course_cards
    WHERE principal_id = NEW.principal_id AND course_id = NEW.course_id AND active = 1
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.source_keys_json)
    WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 160
  ) OR (
    SELECT COUNT(DISTINCT value) FROM json_each(NEW.source_keys_json)
  ) != NEW.evidence_count;
END;

CREATE TRIGGER school_study_check_in_claims_update_guard
BEFORE UPDATE ON school_study_check_in_claims
BEGIN
  SELECT RAISE(ABORT, 'school_study_check_in_update_forbidden') WHERE 1 = 1;
END;

CREATE TRIGGER school_study_check_in_claims_delete_guard
BEFORE DELETE ON school_study_check_in_claims
BEGIN
  SELECT RAISE(ABORT, 'school_study_check_in_delete_forbidden') WHERE 1 = 1;
END;

CREATE TRIGGER school_study_signal_controls_insert_guard
BEFORE INSERT ON school_study_signal_controls
BEGIN
  SELECT RAISE(ABORT, 'school_study_signal_control_insert_invalid') WHERE EXISTS (
    SELECT 1 FROM school_study_signal_controls
    WHERE principal_id = NEW.principal_id AND source_key = NEW.source_key
  ) OR NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.control_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  ) OR NOT EXISTS (
    SELECT 1 FROM school_study_check_in_claims claim, json_each(claim.source_keys_json) source
    WHERE claim.principal_id = NEW.principal_id
      AND claim.claim_id = NEW.check_in_id
      AND source.type = 'text'
      AND source.value = NEW.source_key
  ) OR NEW.source_key != (NEW.source_kind || ':' || NEW.source_record_id)
    OR (NEW.source_kind = 'grade' AND NOT EXISTS (
      SELECT 1 FROM school_assignment_observations
      WHERE principal_id = NEW.principal_id AND observation_id = NEW.source_record_id
    ))
    OR (NEW.source_kind = 'missing_work' AND NOT EXISTS (
      SELECT 1 FROM school_missing_work_transitions
      WHERE principal_id = NEW.principal_id AND transition_id = NEW.source_record_id
    ))
    OR (NEW.source_kind = 'deadline' AND NOT EXISTS (
      SELECT 1 FROM deadlines WHERE deadline_id = NEW.source_record_id
    ));
END;

CREATE TRIGGER school_study_signal_controls_update_guard
BEFORE UPDATE ON school_study_signal_controls
BEGIN
  SELECT RAISE(ABORT, 'school_study_signal_control_update_forbidden') WHERE 1 = 1;
END;

CREATE TRIGGER school_study_signal_controls_delete_guard
BEFORE DELETE ON school_study_signal_controls
BEGIN
  SELECT RAISE(ABORT, 'school_study_signal_control_delete_forbidden') WHERE 1 = 1;
END;

-- R5 owner-reported application checklist items for the existing university tracker.

CREATE TABLE university_application_items (
  principal_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  item_id TEXT NOT NULL CHECK (
    length(item_id) = 26
    AND substr(item_id, 1, 1) GLOB '[0-7]'
    AND item_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 256),
  item_kind TEXT NOT NULL CHECK (item_kind IN (
    'supplementary_application', 'essay', 'personal_statement',
    'reference', 'transcript', 'scholarship'
  )),
  item_label TEXT NOT NULL CHECK (
    length(item_label) BETWEEN 1 AND 160
    AND instr(item_label, char(0)) = 0
    AND instr(item_label, char(10)) = 0
    AND instr(item_label, char(13)) = 0
  ),
  item_status TEXT NOT NULL CHECK (item_status IN (
    'not_started', 'drafting', 'ready', 'submitted_by_sid', 'not_needed_by_sid'
  )),
  due_date TEXT CHECK (
    due_date IS NULL OR (
      length(due_date) = 10
      AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND strftime('%Y-%m-%d', due_date) IS due_date
    )
  ),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unverified')),
  source_url TEXT CHECK (source_url IS NULL OR (length(source_url) BETWEEN 9 AND 512 AND source_url LIKE 'https://%')),
  admission_cycle TEXT CHECK (admission_cycle IS NULL OR length(admission_cycle) BETWEEN 1 AND 64),
  verified_at TEXT CHECK (verified_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at),
  source_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  submitted_at TEXT CHECK (submitted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at) IS submitted_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, item_id),
  UNIQUE (principal_id, program_id, item_key),
  FOREIGN KEY (principal_id, program_id)
    REFERENCES university_programs(principal_id, program_id) ON DELETE RESTRICT,
  CHECK (
    (verification_state = 'verified' AND due_date IS NOT NULL AND source_url IS NOT NULL
      AND admission_cycle IS NOT NULL AND verified_at IS NOT NULL)
    OR (verification_state = 'unverified' AND verified_at IS NULL)
  ),
  CHECK (
    (item_status = 'submitted_by_sid' AND submitted_at IS NOT NULL)
    OR (item_status != 'submitted_by_sid' AND submitted_at IS NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (submitted_at IS NULL OR submitted_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX university_application_items_due_idx
ON university_application_items(principal_id, item_status, due_date, item_id);

CREATE TRIGGER university_application_items_insert_guard
BEFORE INSERT ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM university_application_items
    WHERE principal_id = NEW.principal_id
      AND (item_id = NEW.item_id OR (program_id = NEW.program_id AND item_key = NEW.item_key))
  );
END;

CREATE TRIGGER university_application_items_cap_insert
BEFORE INSERT ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM university_application_items
    WHERE principal_id = NEW.principal_id
  ) >= 256 OR (
    SELECT COUNT(*) FROM university_application_items
    WHERE principal_id = NEW.principal_id AND program_id = NEW.program_id
  ) >= 64 OR (
    NEW.item_status != 'not_needed_by_sid' AND ((
      SELECT COUNT(*) FROM university_application_items
      WHERE principal_id = NEW.principal_id AND item_status != 'not_needed_by_sid'
    ) >= 128 OR (
      SELECT COUNT(*) FROM university_application_items
      WHERE principal_id = NEW.principal_id AND program_id = NEW.program_id
        AND item_status != 'not_needed_by_sid'
    ) >= 32)
  );
END;

CREATE TRIGGER university_application_items_cap_reactivate
BEFORE UPDATE ON university_application_items
WHEN OLD.item_status = 'not_needed_by_sid' AND NEW.item_status != 'not_needed_by_sid'
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM university_application_items
    WHERE principal_id = NEW.principal_id AND item_status != 'not_needed_by_sid'
  ) >= 128 OR (
    SELECT COUNT(*) FROM university_application_items
    WHERE principal_id = NEW.principal_id AND program_id = NEW.program_id
      AND item_status != 'not_needed_by_sid'
  ) >= 32;
END;

CREATE TRIGGER university_application_items_require_owner_turn_insert
BEFORE INSERT ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER university_application_items_require_owner_turn_update
BEFORE UPDATE ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER university_application_items_core_immutable
BEFORE UPDATE ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.program_id IS NOT OLD.program_id
    OR NEW.item_id IS NOT OLD.item_id
    OR NEW.item_key IS NOT OLD.item_key
    OR NEW.item_kind IS NOT OLD.item_kind
    OR NEW.item_label IS NOT OLD.item_label
    OR NEW.created_at IS NOT OLD.created_at;
END;

CREATE TRIGGER university_application_items_status_correction_guard
BEFORE UPDATE ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_status_invalid')
  WHERE OLD.item_status IN ('submitted_by_sid', 'not_needed_by_sid')
    AND NEW.item_status != OLD.item_status
    AND NEW.source_turn_id IS OLD.source_turn_id;
END;

CREATE TRIGGER university_application_items_state_consistent_update
BEFORE UPDATE ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_state_invalid') WHERE
    NEW.updated_at < OLD.updated_at
    OR (
      OLD.item_status = 'submitted_by_sid'
      AND NEW.item_status = 'submitted_by_sid'
      AND NEW.submitted_at IS NOT OLD.submitted_at
    )
    OR (
      NEW.verification_state = 'verified'
      AND NEW.due_date IS NOT OLD.due_date
      AND NEW.verified_at IS OLD.verified_at
    )
    OR (
      OLD.verification_state = 'verified'
      AND NEW.verification_state = 'verified'
      AND (
        NEW.source_url IS NOT OLD.source_url
        OR NEW.admission_cycle IS NOT OLD.admission_cycle
      )
      AND (
        NEW.verified_at IS NULL
        OR NEW.verified_at <= OLD.verified_at
      )
    )
    OR NEW.verified_at < OLD.verified_at
    OR (
      OLD.item_status IN ('submitted_by_sid', 'not_needed_by_sid')
      AND NEW.item_status != OLD.item_status
      AND NEW.source_turn_id < OLD.source_turn_id
    );
END;

CREATE TRIGGER university_application_items_reject_delete
BEFORE DELETE ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_delete_forbidden');
END;

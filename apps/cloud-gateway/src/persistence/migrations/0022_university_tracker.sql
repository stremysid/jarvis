-- R5 conversational university shortlist with explicit source verification.
-- This migration also carries the reviewed school retention follow-ups.

DROP TRIGGER school_course_facts_core_immutable;

UPDATE school_course_facts
SET fact_key = substr(fact_key, 1, 476) || ':resolved:' || fact_id
WHERE status = 'resolved';

CREATE TRIGGER school_course_facts_core_immutable
BEFORE UPDATE ON school_course_facts
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.course_id IS NOT OLD.course_id
    OR NEW.fact_id IS NOT OLD.fact_id
    OR (
      NEW.fact_key IS NOT OLD.fact_key
      AND NOT (
        OLD.status = 'active'
        AND NEW.status = 'resolved'
        AND NEW.fact_key = substr(OLD.fact_key, 1, 476) || ':resolved:' || OLD.fact_id
      )
    )
    OR NEW.fact_kind IS NOT OLD.fact_kind
    OR NEW.statement IS NOT OLD.statement
    OR NEW.evidence_source IS NOT OLD.evidence_source
    OR NEW.source_turn_id IS NOT OLD.source_turn_id
    OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.observed_at IS NOT OLD.observed_at;
END;

DROP TRIGGER school_catchup_actions_reject_delete;

CREATE TRIGGER school_catchup_actions_reject_delete
BEFORE DELETE ON school_catchup_actions
WHEN OLD.status NOT IN ('completed', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_delete_forbidden');
END;

CREATE TABLE university_programs (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  program_id TEXT NOT NULL CHECK (
    length(program_id) = 26
    AND substr(program_id, 1, 1) GLOB '[0-7]'
    AND program_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  program_key TEXT NOT NULL CHECK (length(program_key) BETWEEN 1 AND 512),
  university_name TEXT NOT NULL CHECK (
    length(university_name) BETWEEN 1 AND 160
    AND instr(university_name, char(0)) = 0
    AND instr(university_name, char(10)) = 0
    AND instr(university_name, char(13)) = 0
  ),
  campus_name TEXT CHECK (
    campus_name IS NULL OR (
      length(campus_name) BETWEEN 1 AND 160
      AND instr(campus_name, char(0)) = 0
      AND instr(campus_name, char(10)) = 0
      AND instr(campus_name, char(13)) = 0
    )
  ),
  program_name TEXT NOT NULL CHECK (
    length(program_name) BETWEEN 1 AND 160
    AND instr(program_name, char(0)) = 0
    AND instr(program_name, char(10)) = 0
    AND instr(program_name, char(13)) = 0
  ),
  ouac_code TEXT CHECK (
    ouac_code IS NULL OR (
      length(ouac_code) BETWEEN 1 AND 32
      AND instr(ouac_code, char(0)) = 0
      AND instr(ouac_code, char(10)) = 0
      AND instr(ouac_code, char(13)) = 0
    )
  ),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unverified')),
  source_url TEXT CHECK (source_url IS NULL OR (length(source_url) BETWEEN 9 AND 512 AND source_url LIKE 'https://%')),
  admission_cycle TEXT CHECK (admission_cycle IS NULL OR length(admission_cycle) BETWEEN 1 AND 64),
  verified_at TEXT CHECK (verified_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at),
  owner_source_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, program_id),
  UNIQUE (principal_id, program_key),
  CHECK (updated_at >= created_at),
  CHECK (
    (verification_state = 'verified' AND source_url IS NOT NULL AND admission_cycle IS NOT NULL AND verified_at IS NOT NULL)
    OR (verification_state = 'unverified' AND verified_at IS NULL)
  )
) WITHOUT ROWID;

CREATE INDEX university_programs_active_idx
ON university_programs(principal_id, active, program_key);

CREATE TABLE university_program_items (
  principal_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  item_id TEXT NOT NULL CHECK (
    length(item_id) = 26
    AND substr(item_id, 1, 1) GLOB '[0-7]'
    AND item_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 768),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('requirement', 'date')),
  item_label TEXT NOT NULL CHECK (
    length(item_label) BETWEEN 1 AND 160
    AND instr(item_label, char(0)) = 0
    AND instr(item_label, char(10)) = 0
    AND instr(item_label, char(13)) = 0
  ),
  item_detail TEXT CHECK (
    item_detail IS NULL OR (
      length(item_detail) BETWEEN 1 AND 512
      AND instr(item_detail, char(0)) = 0
      AND instr(item_detail, char(10)) = 0
      AND instr(item_detail, char(13)) = 0
    )
  ),
  date_value TEXT CHECK (
    date_value IS NULL OR (
      length(date_value) = 10
      AND date_value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND strftime('%Y-%m-%d', date_value) IS date_value
    )
  ),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unverified')),
  source_url TEXT CHECK (source_url IS NULL OR (length(source_url) BETWEEN 9 AND 512 AND source_url LIKE 'https://%')),
  admission_cycle TEXT CHECK (admission_cycle IS NULL OR length(admission_cycle) BETWEEN 1 AND 64),
  verified_at TEXT CHECK (verified_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at),
  source_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
  resolved_at TEXT CHECK (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, item_id),
  UNIQUE (principal_id, program_id, item_key),
  FOREIGN KEY (principal_id, program_id)
    REFERENCES university_programs(principal_id, program_id) ON DELETE RESTRICT,
  CHECK (
    (item_kind = 'requirement' AND item_detail IS NOT NULL AND date_value IS NULL)
    OR (item_kind = 'date' AND item_detail IS NULL)
  ),
  CHECK (
    (verification_state = 'verified' AND source_url IS NOT NULL AND admission_cycle IS NOT NULL AND verified_at IS NOT NULL)
    OR (verification_state = 'unverified' AND verified_at IS NULL)
  ),
  CHECK (verification_state != 'verified' OR item_kind != 'date' OR date_value IS NOT NULL),
  CHECK ((status = 'active' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX university_program_items_active_idx
ON university_program_items(principal_id, program_id, status, item_kind, item_key);

CREATE TABLE university_tracker_turn_receipts (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  response_hash TEXT NOT NULL CHECK (length(response_hash) = 64 AND response_hash NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) IS applied_at),
  PRIMARY KEY (principal_id, turn_id)
) WITHOUT ROWID;

CREATE TRIGGER university_programs_insert_guard
BEFORE INSERT ON university_programs
BEGIN
  SELECT RAISE(ABORT, 'university_program_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM university_programs
    WHERE principal_id = NEW.principal_id
      AND (program_id = NEW.program_id OR program_key = NEW.program_key)
  );
END;

CREATE TRIGGER university_programs_active_cap_insert
BEFORE INSERT ON university_programs
WHEN NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'university_program_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM university_programs
    WHERE principal_id = NEW.principal_id AND active = 1
  ) >= 16;
END;

CREATE TRIGGER university_programs_active_cap_update
BEFORE UPDATE ON university_programs
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'university_program_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM university_programs
    WHERE principal_id = NEW.principal_id AND active = 1
  ) >= 16;
END;

CREATE TRIGGER university_programs_require_owner_turn_insert
BEFORE INSERT ON university_programs
BEGIN
  SELECT RAISE(ABORT, 'university_program_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER university_programs_require_owner_turn_update
BEFORE UPDATE ON university_programs
BEGIN
  SELECT RAISE(ABORT, 'university_program_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER university_programs_update_guard
BEFORE UPDATE ON university_programs
BEGIN
  SELECT RAISE(ABORT, 'university_program_identity_invalid')
  WHERE NEW.principal_id IS NOT OLD.principal_id
    OR NEW.program_id IS NOT OLD.program_id
    OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'university_program_key_conflict') WHERE EXISTS (
    SELECT 1 FROM university_programs
    WHERE principal_id = NEW.principal_id
      AND program_key = NEW.program_key
      AND program_id IS NOT OLD.program_id
  );
END;

CREATE TRIGGER university_programs_reject_delete
BEFORE DELETE ON university_programs
BEGIN
  SELECT RAISE(ABORT, 'university_program_delete_forbidden');
END;

CREATE TRIGGER university_program_items_insert_guard
BEFORE INSERT ON university_program_items
BEGIN
  SELECT RAISE(ABORT, 'university_item_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM university_program_items
    WHERE principal_id = NEW.principal_id
      AND (item_id = NEW.item_id OR (program_id = NEW.program_id AND item_key = NEW.item_key))
  );
END;

CREATE TRIGGER university_program_items_active_cap_insert
BEFORE INSERT ON university_program_items
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'university_item_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM university_program_items
    WHERE principal_id = NEW.principal_id AND status = 'active'
  ) >= 128 OR (
    SELECT COUNT(*) FROM university_program_items
    WHERE principal_id = NEW.principal_id
      AND program_id = NEW.program_id
      AND status = 'active'
  ) >= 32;
END;

CREATE TRIGGER university_program_items_require_owner_turn
BEFORE INSERT ON university_program_items
BEGIN
  SELECT RAISE(ABORT, 'university_item_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER university_program_items_core_immutable
BEFORE UPDATE ON university_program_items
BEGIN
  SELECT RAISE(ABORT, 'university_item_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.program_id IS NOT OLD.program_id
    OR NEW.item_id IS NOT OLD.item_id
    OR (
      NEW.item_key IS NOT OLD.item_key
      AND NOT (
        OLD.status = 'active'
        AND NEW.status = 'resolved'
        AND NEW.item_key = substr(OLD.item_key, 1, 732) || ':resolved:' || OLD.item_id
      )
    )
    OR NEW.item_kind IS NOT OLD.item_kind
    OR NEW.item_label IS NOT OLD.item_label
    OR NEW.item_detail IS NOT OLD.item_detail
    OR NEW.date_value IS NOT OLD.date_value
    OR NEW.verification_state IS NOT OLD.verification_state
    OR NEW.source_url IS NOT OLD.source_url
    OR NEW.admission_cycle IS NOT OLD.admission_cycle
    OR NEW.verified_at IS NOT OLD.verified_at
    OR NEW.source_turn_id IS NOT OLD.source_turn_id
    OR NEW.created_at IS NOT OLD.created_at;
END;

CREATE TRIGGER university_program_items_status_transition
BEFORE UPDATE ON university_program_items
BEGIN
  SELECT RAISE(ABORT, 'university_item_status_invalid') WHERE NOT (
    NEW.status = OLD.status OR (OLD.status = 'active' AND NEW.status = 'resolved')
  );
END;

CREATE TRIGGER university_program_items_reject_delete
BEFORE DELETE ON university_program_items
BEGIN
  SELECT RAISE(ABORT, 'university_item_delete_forbidden');
END;

CREATE TRIGGER university_tracker_turn_receipts_insert_guard
BEFORE INSERT ON university_tracker_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'university_tracker_receipt_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM university_tracker_turn_receipts
    WHERE principal_id = NEW.principal_id AND turn_id = NEW.turn_id
  );
END;

CREATE TRIGGER university_tracker_turn_receipts_require_turn
BEFORE INSERT ON university_tracker_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'university_tracker_receipt_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER university_tracker_turn_receipts_reject_update
BEFORE UPDATE ON university_tracker_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'university_tracker_receipt_update_forbidden');
END;

CREATE TRIGGER university_tracker_turn_receipts_reject_delete
BEFORE DELETE ON university_tracker_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'university_tracker_receipt_delete_forbidden');
END;

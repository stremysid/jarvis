-- R5 school catch-up cards and day-by-day recovery actions.
--
-- This is the operational store for the first school slice. Owner-reported
-- conversation facts stay visibly separate from later platform-confirmed
-- observations. The model may propose changes, but every owner-derived row is
-- tied to the authenticated Telegram conversation turn that supplied it.

CREATE TABLE school_course_cards (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  course_id TEXT NOT NULL CHECK (
    length(course_id) = 26
    AND substr(course_id, 1, 1) GLOB '[0-7]'
    AND course_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  course_key TEXT NOT NULL CHECK (length(course_key) BETWEEN 1 AND 160),
  course_name TEXT NOT NULL CHECK (
    length(course_name) BETWEEN 1 AND 160
    AND instr(course_name, char(0)) = 0
    AND instr(course_name, char(10)) = 0
    AND instr(course_name, char(13)) = 0
  ),
  course_name_source TEXT NOT NULL CHECK (course_name_source = 'owner_reported'),
  platform_name TEXT CHECK (
    platform_name IS NULL OR (
      length(platform_name) BETWEEN 1 AND 160
      AND instr(platform_name, char(0)) = 0
      AND instr(platform_name, char(10)) = 0
      AND instr(platform_name, char(13)) = 0
    )
  ),
  platform_source TEXT CHECK (platform_source IN ('owner_reported', 'platform_confirmed')),
  platform_source_ref TEXT CHECK (platform_source_ref IS NULL OR length(platform_source_ref) BETWEEN 1 AND 512),
  platform_observed_at TEXT,
  owner_source_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, course_id),
  UNIQUE (principal_id, course_key),
  CHECK (updated_at >= created_at),
  CHECK (
    (platform_name IS NULL AND platform_source IS NULL AND platform_source_ref IS NULL AND platform_observed_at IS NULL)
    OR (
      platform_name IS NOT NULL
      AND platform_source IS NOT NULL
      AND platform_observed_at IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', platform_observed_at) IS platform_observed_at
      AND (
        (platform_source = 'owner_reported' AND platform_source_ref IS NULL)
        OR (platform_source = 'platform_confirmed' AND platform_source_ref IS NOT NULL)
      )
    )
  )
) WITHOUT ROWID;

CREATE INDEX school_course_cards_active_idx
ON school_course_cards(principal_id, active, course_key);

CREATE TABLE school_course_facts (
  principal_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  fact_id TEXT NOT NULL CHECK (
    length(fact_id) = 26
    AND substr(fact_id, 1, 1) GLOB '[0-7]'
    AND fact_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  fact_key TEXT NOT NULL CHECK (length(fact_key) BETWEEN 1 AND 512),
  fact_kind TEXT NOT NULL CHECK (fact_kind IN ('missed_work', 'due_work', 'weak_area')),
  statement TEXT NOT NULL CHECK (
    length(statement) BETWEEN 1 AND 512
    AND instr(statement, char(0)) = 0
    AND instr(statement, char(10)) = 0
    AND instr(statement, char(13)) = 0
  ),
  evidence_source TEXT NOT NULL CHECK (evidence_source IN ('owner_reported', 'platform_confirmed')),
  source_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 512),
  observed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at),
  status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
  resolved_at TEXT CHECK (
    resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at
  ),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, fact_id),
  UNIQUE (principal_id, course_id, fact_kind, evidence_source, fact_key),
  FOREIGN KEY (principal_id, course_id)
    REFERENCES school_course_cards(principal_id, course_id) ON DELETE RESTRICT,
  CHECK (
    (evidence_source = 'owner_reported' AND source_turn_id IS NOT NULL AND source_ref IS NULL)
    OR (evidence_source = 'platform_confirmed' AND source_turn_id IS NULL AND source_ref IS NOT NULL)
  ),
  CHECK ((status = 'active' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL)),
  CHECK (updated_at >= observed_at)
) WITHOUT ROWID;

CREATE INDEX school_course_facts_active_idx
ON school_course_facts(principal_id, course_id, status, fact_kind, observed_at);

CREATE TABLE school_catchup_actions (
  principal_id TEXT NOT NULL,
  action_id TEXT NOT NULL CHECK (
    length(action_id) = 26
    AND substr(action_id, 1, 1) GLOB '[0-7]'
    AND action_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  course_id TEXT NOT NULL,
  local_date TEXT NOT NULL CHECK (
    length(local_date) = 10
    AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND strftime('%Y-%m-%d', local_date) IS local_date
  ),
  sequence_rank INTEGER NOT NULL CHECK (sequence_rank BETWEEN 1 AND 20),
  action_text TEXT NOT NULL CHECK (
    length(action_text) BETWEEN 1 AND 512
    AND instr(action_text, char(0)) = 0
    AND instr(action_text, char(10)) = 0
    AND instr(action_text, char(13)) = 0
  ),
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes BETWEEN 5 AND 180),
  status TEXT NOT NULL CHECK (status IN ('planned', 'completed', 'superseded')),
  plan_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  completed_at TEXT CHECK (
    completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at
  ),
  superseded_at TEXT CHECK (
    superseded_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', superseded_at) IS superseded_at
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, action_id),
  FOREIGN KEY (principal_id, course_id)
    REFERENCES school_course_cards(principal_id, course_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'planned' AND completed_at IS NULL AND superseded_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND completed_at IS NULL AND superseded_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX school_catchup_actions_today_idx
ON school_catchup_actions(principal_id, status, local_date, sequence_rank, action_id);

CREATE TABLE school_catchup_turn_receipts (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  response_hash TEXT NOT NULL CHECK (
    length(response_hash) = 64 AND response_hash NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) IS applied_at),
  PRIMARY KEY (principal_id, turn_id)
) WITHOUT ROWID;

CREATE TRIGGER school_course_cards_insert_guard
BEFORE INSERT ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_course_cards
    WHERE principal_id = NEW.principal_id
      AND (course_id = NEW.course_id OR course_key = NEW.course_key)
  );
END;

CREATE TRIGGER school_course_cards_active_cap_insert
BEFORE INSERT ON school_course_cards
WHEN NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM school_course_cards
    WHERE principal_id = NEW.principal_id AND active = 1
  ) >= 12;
END;

CREATE TRIGGER school_course_cards_active_cap_update
BEFORE UPDATE ON school_course_cards
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM school_course_cards
    WHERE principal_id = NEW.principal_id AND active = 1
  ) >= 12;
END;

CREATE TRIGGER school_course_cards_require_owner_turn_insert
BEFORE INSERT ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER school_course_cards_require_owner_turn_update
BEFORE UPDATE ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER school_course_cards_primary_key_immutable
BEFORE UPDATE ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_primary_key_immutable')
  WHERE NEW.principal_id IS NOT OLD.principal_id
    OR NEW.course_id IS NOT OLD.course_id
    OR NEW.created_at IS NOT OLD.created_at;
END;

CREATE TRIGGER school_course_cards_course_key_unique_update
BEFORE UPDATE ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_course_key_conflict') WHERE EXISTS (
    SELECT 1 FROM school_course_cards
    WHERE principal_id = NEW.principal_id
      AND course_key = NEW.course_key
      AND course_id IS NOT OLD.course_id
  );
END;

CREATE TRIGGER school_course_cards_reject_delete
BEFORE DELETE ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_delete_forbidden');
END;

CREATE TRIGGER school_course_facts_insert_guard
BEFORE INSERT ON school_course_facts
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_course_facts
    WHERE principal_id = NEW.principal_id
      AND (
        fact_id = NEW.fact_id
        OR (
          course_id = NEW.course_id
          AND fact_kind = NEW.fact_kind
          AND evidence_source = NEW.evidence_source
          AND fact_key = NEW.fact_key
        )
      )
  );
END;

CREATE TRIGGER school_course_facts_active_cap_insert
BEFORE INSERT ON school_course_facts
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM school_course_facts
    WHERE principal_id = NEW.principal_id AND status = 'active'
  ) >= 48 OR (
    SELECT COUNT(*) FROM school_course_facts
    WHERE principal_id = NEW.principal_id
      AND course_id = NEW.course_id
      AND status = 'active'
  ) >= 16;
END;

CREATE TRIGGER school_course_facts_require_owner_turn
BEFORE INSERT ON school_course_facts
WHEN NEW.evidence_source = 'owner_reported'
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER school_course_facts_core_immutable
BEFORE UPDATE ON school_course_facts
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.course_id IS NOT OLD.course_id
    OR NEW.fact_id IS NOT OLD.fact_id
    OR NEW.fact_key IS NOT OLD.fact_key
    OR NEW.fact_kind IS NOT OLD.fact_kind
    OR NEW.statement IS NOT OLD.statement
    OR NEW.evidence_source IS NOT OLD.evidence_source
    OR NEW.source_turn_id IS NOT OLD.source_turn_id
    OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.observed_at IS NOT OLD.observed_at;
END;

CREATE TRIGGER school_course_facts_status_transition
BEFORE UPDATE ON school_course_facts
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_status_invalid') WHERE NOT (
    NEW.status = OLD.status OR (OLD.status = 'active' AND NEW.status = 'resolved')
  );
END;

CREATE TRIGGER school_course_facts_reject_delete
BEFORE DELETE ON school_course_facts
WHEN OLD.status != 'resolved'
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_delete_forbidden');
END;

CREATE TRIGGER school_catchup_actions_insert_guard
BEFORE INSERT ON school_catchup_actions
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_catchup_actions
    WHERE principal_id = NEW.principal_id AND action_id = NEW.action_id
  );
END;

CREATE TRIGGER school_catchup_actions_planned_cap_insert
BEFORE INSERT ON school_catchup_actions
WHEN NEW.status = 'planned'
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM school_catchup_actions
    WHERE principal_id = NEW.principal_id AND status = 'planned'
  ) >= 21 OR (
    SELECT COUNT(*) FROM school_catchup_actions
    WHERE principal_id = NEW.principal_id
      AND local_date = NEW.local_date
      AND status = 'planned'
  ) >= 3 OR COALESCE((
    SELECT SUM(estimated_minutes) FROM school_catchup_actions
    WHERE principal_id = NEW.principal_id
      AND local_date = NEW.local_date
      AND status = 'planned'
  ), 0) + NEW.estimated_minutes > 180;
END;

CREATE TRIGGER school_catchup_actions_require_plan_turn
BEFORE INSERT ON school_catchup_actions
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_plan_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.plan_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER school_catchup_actions_core_immutable
BEFORE UPDATE ON school_catchup_actions
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.action_id IS NOT OLD.action_id
    OR NEW.course_id IS NOT OLD.course_id
    OR NEW.local_date IS NOT OLD.local_date
    OR NEW.sequence_rank IS NOT OLD.sequence_rank
    OR NEW.action_text IS NOT OLD.action_text
    OR NEW.estimated_minutes IS NOT OLD.estimated_minutes
    OR NEW.plan_turn_id IS NOT OLD.plan_turn_id
    OR NEW.created_at IS NOT OLD.created_at;
END;

CREATE TRIGGER school_catchup_actions_status_transition
BEFORE UPDATE ON school_catchup_actions
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_status_invalid') WHERE NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'planned' AND NEW.status IN ('completed', 'superseded'))
  );
END;

CREATE TRIGGER school_catchup_actions_reject_delete
BEFORE DELETE ON school_catchup_actions
WHEN OLD.status != 'superseded'
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_delete_forbidden');
END;

CREATE TRIGGER school_catchup_turn_receipts_insert_guard
BEFORE INSERT ON school_catchup_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_receipt_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_catchup_turn_receipts
    WHERE principal_id = NEW.principal_id AND turn_id = NEW.turn_id
  );
END;

CREATE TRIGGER school_catchup_turn_receipts_require_turn
BEFORE INSERT ON school_catchup_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_receipt_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER school_catchup_turn_receipts_reject_update
BEFORE UPDATE ON school_catchup_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_receipt_update_forbidden');
END;

CREATE TRIGGER school_catchup_turn_receipts_reject_delete
BEFORE DELETE ON school_catchup_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_receipt_delete_forbidden');
END;

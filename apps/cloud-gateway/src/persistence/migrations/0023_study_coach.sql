-- R5 study-coach evidence, cited practice, and conversational cadence.
--
-- Evidence points remain separate. A weak-area view is derived from them so
-- one mark, statement, or answer never becomes a fixed judgement by itself.

CREATE TABLE school_study_preferences (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  allowed_days_mask INTEGER NOT NULL CHECK (allowed_days_mask BETWEEN 1 AND 127),
  quiet_start_minute INTEGER NOT NULL CHECK (quiet_start_minute BETWEEN 0 AND 1439),
  quiet_end_minute INTEGER NOT NULL CHECK (quiet_end_minute BETWEEN 0 AND 1439),
  source_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id),
  CHECK (quiet_start_minute != quiet_end_minute),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE TABLE school_practice_items (
  principal_id TEXT NOT NULL,
  item_id TEXT NOT NULL CHECK (
    length(item_id) = 26
    AND substr(item_id, 1, 1) GLOB '[0-7]'
    AND item_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 128),
  practice_id TEXT NOT NULL CHECK (
    length(practice_id) = 26
    AND substr(practice_id, 1, 1) GLOB '[0-7]'
    AND practice_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  course_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('quiz', 'flashcard')),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  question TEXT NOT NULL CHECK (
    length(question) BETWEEN 1 AND 512
    AND instr(question, char(0)) = 0
    AND instr(question, char(10)) = 0
    AND instr(question, char(13)) = 0
  ),
  answer TEXT NOT NULL CHECK (
    length(answer) BETWEEN 1 AND 512
    AND instr(answer, char(0)) = 0
    AND instr(answer, char(10)) = 0
    AND instr(answer, char(13)) = 0
  ),
  answer_support TEXT NOT NULL CHECK (answer_support IN ('supported', 'uncertain')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('owner_topic', 'course_fact')),
  source_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  source_fact_id TEXT,
  source_excerpt TEXT NOT NULL CHECK (
    length(source_excerpt) BETWEEN 1 AND 512
    AND instr(source_excerpt, char(0)) = 0
    AND instr(source_excerpt, char(10)) = 0
    AND instr(source_excerpt, char(13)) = 0
  ),
  source_observed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', source_observed_at) IS source_observed_at
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'shown', 'dismissed')),
  owner_answer TEXT CHECK (
    owner_answer IS NULL OR (
      length(owner_answer) BETWEEN 1 AND 512
      AND instr(owner_answer, char(0)) = 0
      AND instr(owner_answer, char(10)) = 0
      AND instr(owner_answer, char(13)) = 0
    )
  ),
  result TEXT CHECK (result IN ('easy', 'uncertain', 'wrong')),
  result_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  answered_at TEXT CHECK (
    answered_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', answered_at) IS answered_at
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, item_id),
  UNIQUE (principal_id, item_key),
  UNIQUE (principal_id, practice_id, position),
  FOREIGN KEY (principal_id, course_id)
    REFERENCES school_course_cards(principal_id, course_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, source_fact_id)
    REFERENCES school_course_facts(principal_id, fact_id) ON DELETE RESTRICT,
  CHECK (
    (source_kind = 'owner_topic' AND source_turn_id IS NOT NULL AND source_fact_id IS NULL)
    OR (source_kind = 'course_fact' AND source_turn_id IS NULL AND source_fact_id IS NOT NULL)
  ),
  CHECK (
    (status = 'open' AND mode = 'quiz' AND owner_answer IS NULL AND result IS NULL
      AND result_turn_id IS NULL AND answered_at IS NULL)
    OR (status = 'answered' AND mode = 'quiz' AND owner_answer IS NOT NULL AND result IS NOT NULL
      AND result_turn_id IS NOT NULL AND answered_at IS NOT NULL)
    OR (status = 'shown' AND mode = 'flashcard' AND owner_answer IS NULL AND result IS NULL
      AND result_turn_id IS NULL AND answered_at IS NULL)
    OR (status = 'dismissed' AND owner_answer IS NULL AND result IS NULL
      AND result_turn_id IS NULL AND answered_at IS NULL)
  ),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX school_practice_items_open_idx
ON school_practice_items(principal_id, status, created_at, practice_id, position);

CREATE TABLE school_study_evidence (
  principal_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL CHECK (
    length(evidence_id) = 26
    AND substr(evidence_id, 1, 1) GLOB '[0-7]'
    AND evidence_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 160),
  course_id TEXT NOT NULL,
  topic_key TEXT NOT NULL CHECK (length(topic_key) BETWEEN 1 AND 512),
  topic TEXT NOT NULL CHECK (
    length(topic) BETWEEN 1 AND 512
    AND instr(topic, char(0)) = 0
    AND instr(topic, char(10)) = 0
    AND instr(topic, char(13)) = 0
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('easy', 'uncertain', 'wrong')),
  evidence_kind TEXT NOT NULL CHECK (
    evidence_kind IN ('owner_statement', 'course_context', 'practice_result')
  ),
  evidence_text TEXT NOT NULL CHECK (
    length(evidence_text) BETWEEN 1 AND 512
    AND instr(evidence_text, char(0)) = 0
    AND instr(evidence_text, char(10)) = 0
    AND instr(evidence_text, char(13)) = 0
  ),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  source_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  source_fact_id TEXT,
  source_practice_item_id TEXT,
  observed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at),
  practice_due_on TEXT NOT NULL CHECK (
    length(practice_due_on) = 10
    AND practice_due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND strftime('%Y-%m-%d', practice_due_on) IS practice_due_on
  ),
  last_prompted_on TEXT CHECK (
    last_prompted_on IS NULL OR (
      length(last_prompted_on) = 10
      AND last_prompted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND strftime('%Y-%m-%d', last_prompted_on) IS last_prompted_on
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'corrected', 'forgotten', 'superseded')),
  control_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  controlled_at TEXT CHECK (
    controlled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', controlled_at) IS controlled_at
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, evidence_id),
  UNIQUE (principal_id, source_key),
  FOREIGN KEY (principal_id, course_id)
    REFERENCES school_course_cards(principal_id, course_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, source_fact_id)
    REFERENCES school_course_facts(principal_id, fact_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, source_practice_item_id)
    REFERENCES school_practice_items(principal_id, item_id) ON DELETE RESTRICT,
  CHECK (
    (evidence_kind = 'owner_statement' AND source_turn_id IS NOT NULL
      AND source_fact_id IS NULL AND source_practice_item_id IS NULL)
    OR (evidence_kind = 'course_context' AND source_turn_id IS NULL
      AND source_fact_id IS NOT NULL AND source_practice_item_id IS NULL)
    OR (evidence_kind = 'practice_result' AND source_turn_id IS NOT NULL
      AND source_fact_id IS NULL AND source_practice_item_id IS NOT NULL)
  ),
  CHECK (
    (status IN ('active', 'superseded') AND control_turn_id IS NULL AND controlled_at IS NULL)
    OR (status IN ('corrected', 'forgotten') AND control_turn_id IS NOT NULL AND controlled_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX school_study_evidence_due_idx
ON school_study_evidence(principal_id, status, practice_due_on, last_prompted_on, observed_at);

CREATE TRIGGER school_study_preferences_insert_guard
BEFORE INSERT ON school_study_preferences
BEGIN
  SELECT RAISE(ABORT, 'school_study_preference_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_study_preferences WHERE principal_id = NEW.principal_id
  );
END;

CREATE TRIGGER school_study_preferences_require_owner_turn_insert
BEFORE INSERT ON school_study_preferences
BEGIN
  SELECT RAISE(ABORT, 'school_study_preference_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id AND principal_id = NEW.principal_id AND channel = 'telegram'
  );
END;

CREATE TRIGGER school_study_preferences_require_owner_turn_update
BEFORE UPDATE ON school_study_preferences
BEGIN
  SELECT RAISE(ABORT, 'school_study_preference_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id AND principal_id = NEW.principal_id AND channel = 'telegram'
  );
END;

CREATE TRIGGER school_study_preferences_core_immutable
BEFORE UPDATE ON school_study_preferences
BEGIN
  SELECT RAISE(ABORT, 'school_study_preference_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.updated_at < OLD.updated_at;
END;

CREATE TRIGGER school_study_preferences_reject_delete
BEFORE DELETE ON school_study_preferences
BEGIN
  SELECT RAISE(ABORT, 'school_study_preference_delete_forbidden');
END;

CREATE TRIGGER school_practice_items_insert_guard
BEFORE INSERT ON school_practice_items
BEGIN
  SELECT RAISE(ABORT, 'school_practice_item_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_practice_items
    WHERE principal_id = NEW.principal_id
      AND (item_id = NEW.item_id OR item_key = NEW.item_key
        OR (practice_id = NEW.practice_id AND position = NEW.position))
  );
END;

CREATE TRIGGER school_practice_items_open_cap
BEFORE INSERT ON school_practice_items
WHEN NEW.status = 'open'
BEGIN
  SELECT RAISE(ABORT, 'school_practice_item_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM school_practice_items
    WHERE principal_id = NEW.principal_id AND status = 'open'
  ) >= 15;
END;

CREATE TRIGGER school_practice_items_source_guard
BEFORE INSERT ON school_practice_items
BEGIN
  SELECT RAISE(ABORT, 'school_practice_item_source_invalid') WHERE
    NOT ((NEW.mode = 'quiz' AND NEW.status = 'open')
      OR (NEW.mode = 'flashcard' AND NEW.status = 'shown'))
    OR (NEW.source_kind = 'owner_topic' AND NOT EXISTS (
      SELECT 1 FROM conversation_turns
      WHERE turn_id = NEW.source_turn_id
        AND principal_id = NEW.principal_id
        AND channel = 'telegram'
    ))
    OR (NEW.source_kind = 'course_fact' AND NOT EXISTS (
      SELECT 1 FROM school_course_facts
      WHERE principal_id = NEW.principal_id
        AND fact_id = NEW.source_fact_id
        AND course_id = NEW.course_id
    ));
END;

CREATE TRIGGER school_practice_items_core_immutable
BEFORE UPDATE ON school_practice_items
BEGIN
  SELECT RAISE(ABORT, 'school_practice_item_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.item_id IS NOT OLD.item_id
    OR NEW.item_key IS NOT OLD.item_key
    OR NEW.practice_id IS NOT OLD.practice_id
    OR NEW.course_id IS NOT OLD.course_id
    OR NEW.mode IS NOT OLD.mode
    OR NEW.position IS NOT OLD.position
    OR NEW.question IS NOT OLD.question
    OR NEW.answer IS NOT OLD.answer
    OR NEW.answer_support IS NOT OLD.answer_support
    OR NEW.source_kind IS NOT OLD.source_kind
    OR NEW.source_turn_id IS NOT OLD.source_turn_id
    OR NEW.source_fact_id IS NOT OLD.source_fact_id
    OR NEW.source_excerpt IS NOT OLD.source_excerpt
    OR NEW.source_observed_at IS NOT OLD.source_observed_at
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.updated_at < OLD.updated_at;
END;

CREATE TRIGGER school_practice_items_status_transition
BEFORE UPDATE ON school_practice_items
BEGIN
  SELECT RAISE(ABORT, 'school_practice_item_status_invalid') WHERE NOT (
    (NEW.status = OLD.status
      AND NEW.owner_answer IS OLD.owner_answer
      AND NEW.result IS OLD.result
      AND NEW.result_turn_id IS OLD.result_turn_id
      AND NEW.answered_at IS OLD.answered_at)
    OR (OLD.status = 'open' AND NEW.status = 'dismissed')
    OR (OLD.status = 'open' AND NEW.status = 'answered' AND EXISTS (
      SELECT 1 FROM conversation_turns
      WHERE turn_id = NEW.result_turn_id
        AND principal_id = NEW.principal_id
        AND channel = 'telegram'
    ))
  );
END;

CREATE TRIGGER school_practice_items_reject_delete
BEFORE DELETE ON school_practice_items
BEGIN
  SELECT RAISE(ABORT, 'school_practice_item_delete_forbidden');
END;

CREATE TRIGGER school_study_evidence_insert_guard
BEFORE INSERT ON school_study_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_study_evidence_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM school_study_evidence
    WHERE principal_id = NEW.principal_id
      AND (evidence_id = NEW.evidence_id OR source_key = NEW.source_key)
  );
END;

CREATE TRIGGER school_study_evidence_active_cap
BEFORE INSERT ON school_study_evidence
WHEN NEW.status = 'active' AND NEW.evidence_kind != 'course_context'
BEGIN
  SELECT RAISE(ABORT, 'school_study_evidence_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM school_study_evidence e
    WHERE e.principal_id = NEW.principal_id AND e.status = 'active'
      AND e.evidence_kind != 'course_context'
  ) >= 96 OR (
    SELECT COUNT(*) FROM school_study_evidence e
    WHERE e.principal_id = NEW.principal_id
      AND e.course_id = NEW.course_id
      AND e.status = 'active'
      AND e.evidence_kind != 'course_context'
  ) >= 24;
END;

CREATE TRIGGER school_study_evidence_source_guard
BEFORE INSERT ON school_study_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_study_evidence_source_invalid') WHERE
    NEW.status != 'active'
    OR (NEW.evidence_kind = 'owner_statement' AND NOT EXISTS (
      SELECT 1 FROM conversation_turns
      WHERE turn_id = NEW.source_turn_id
        AND principal_id = NEW.principal_id
        AND channel = 'telegram'
    ))
    OR (NEW.evidence_kind = 'course_context' AND NOT EXISTS (
      SELECT 1 FROM school_course_facts
      WHERE principal_id = NEW.principal_id
        AND fact_id = NEW.source_fact_id
        AND course_id = NEW.course_id
        AND status = 'active'
    ))
    OR (NEW.evidence_kind = 'practice_result' AND NOT EXISTS (
      SELECT 1 FROM school_practice_items
      WHERE principal_id = NEW.principal_id
        AND item_id = NEW.source_practice_item_id
        AND course_id = NEW.course_id
        AND status = 'answered'
        AND result_turn_id = NEW.source_turn_id
    ));
END;

CREATE TRIGGER school_study_evidence_core_immutable
BEFORE UPDATE ON school_study_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_study_evidence_core_immutable') WHERE
    NEW.principal_id IS NOT OLD.principal_id
    OR NEW.evidence_id IS NOT OLD.evidence_id
    OR NEW.source_key IS NOT OLD.source_key
    OR NEW.course_id IS NOT OLD.course_id
    OR NEW.topic_key IS NOT OLD.topic_key
    OR NEW.topic IS NOT OLD.topic
    OR NEW.outcome IS NOT OLD.outcome
    OR NEW.evidence_kind IS NOT OLD.evidence_kind
    OR NEW.evidence_text IS NOT OLD.evidence_text
    OR NEW.confidence IS NOT OLD.confidence
    OR NEW.source_turn_id IS NOT OLD.source_turn_id
    OR NEW.source_fact_id IS NOT OLD.source_fact_id
    OR NEW.source_practice_item_id IS NOT OLD.source_practice_item_id
    OR NEW.observed_at IS NOT OLD.observed_at
    OR NEW.practice_due_on IS NOT OLD.practice_due_on
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.updated_at < OLD.updated_at;
END;

CREATE TRIGGER school_study_evidence_status_transition
BEFORE UPDATE ON school_study_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_study_evidence_status_invalid') WHERE NOT (
    (OLD.status = 'active' AND NEW.status = 'active'
      AND NEW.control_turn_id IS OLD.control_turn_id
      AND NEW.controlled_at IS OLD.controlled_at
      AND (
        NEW.last_prompted_on IS OLD.last_prompted_on
        OR (NEW.last_prompted_on IS NOT NULL
          AND NEW.last_prompted_on >= NEW.practice_due_on
          AND (OLD.last_prompted_on IS NULL OR NEW.last_prompted_on > OLD.last_prompted_on))
      ))
    OR (OLD.status = 'active' AND NEW.status IN ('corrected', 'forgotten')
      AND NEW.last_prompted_on IS OLD.last_prompted_on
      AND EXISTS (
        SELECT 1 FROM conversation_turns
        WHERE turn_id = NEW.control_turn_id
          AND principal_id = NEW.principal_id
          AND channel = 'telegram'
      ))
    OR (OLD.status = 'active' AND NEW.status = 'superseded'
      AND NEW.last_prompted_on IS OLD.last_prompted_on
      AND NEW.control_turn_id IS NULL
      AND NEW.controlled_at IS NULL
      AND NEW.evidence_kind != 'course_context')
    OR (OLD.status IN ('corrected', 'forgotten', 'superseded')
      AND NEW.status = OLD.status
      AND NEW.last_prompted_on IS OLD.last_prompted_on
      AND NEW.control_turn_id IS OLD.control_turn_id
      AND NEW.controlled_at IS OLD.controlled_at
      AND NEW.updated_at IS OLD.updated_at)
  );
END;

CREATE TRIGGER school_study_evidence_reject_delete
BEFORE DELETE ON school_study_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_study_evidence_delete_forbidden');
END;

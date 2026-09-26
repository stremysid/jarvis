-- Owner pipelines share their storage authority across Telegram and authenticated calls.
-- Preserve every source-turn, principal, lifecycle and row-integrity check.

DROP TRIGGER school_course_cards_require_owner_turn_insert;
CREATE TRIGGER school_course_cards_require_owner_turn_insert
BEFORE INSERT ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_course_cards_require_owner_turn_update;
CREATE TRIGGER school_course_cards_require_owner_turn_update
BEFORE UPDATE ON school_course_cards
BEGIN
  SELECT RAISE(ABORT, 'school_course_card_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_course_facts_require_owner_turn;
CREATE TRIGGER school_course_facts_require_owner_turn
BEFORE INSERT ON school_course_facts
WHEN NEW.evidence_source = 'owner_reported'
BEGIN
  SELECT RAISE(ABORT, 'school_course_fact_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_catchup_actions_require_plan_turn;
CREATE TRIGGER school_catchup_actions_require_plan_turn
BEFORE INSERT ON school_catchup_actions
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_plan_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.plan_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_catchup_turn_receipts_require_turn;
CREATE TRIGGER school_catchup_turn_receipts_require_turn
BEFORE INSERT ON school_catchup_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_receipt_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER university_programs_require_owner_turn_insert;
CREATE TRIGGER university_programs_require_owner_turn_insert
BEFORE INSERT ON university_programs
BEGIN
  SELECT RAISE(ABORT, 'university_program_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER university_programs_require_owner_turn_update;
CREATE TRIGGER university_programs_require_owner_turn_update
BEFORE UPDATE ON university_programs
BEGIN
  SELECT RAISE(ABORT, 'university_program_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.owner_source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER university_program_items_require_owner_turn;
CREATE TRIGGER university_program_items_require_owner_turn
BEFORE INSERT ON university_program_items
BEGIN
  SELECT RAISE(ABORT, 'university_item_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER university_tracker_turn_receipts_require_turn;
CREATE TRIGGER university_tracker_turn_receipts_require_turn
BEFORE INSERT ON university_tracker_turn_receipts
BEGIN
  SELECT RAISE(ABORT, 'university_tracker_receipt_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_study_preferences_require_owner_turn_insert;
CREATE TRIGGER school_study_preferences_require_owner_turn_insert
BEFORE INSERT ON school_study_preferences
BEGIN
  SELECT RAISE(ABORT, 'school_study_preference_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id AND principal_id = NEW.principal_id AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_study_preferences_require_owner_turn_update;
CREATE TRIGGER school_study_preferences_require_owner_turn_update
BEFORE UPDATE ON school_study_preferences
BEGIN
  SELECT RAISE(ABORT, 'school_study_preference_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id AND principal_id = NEW.principal_id AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_practice_items_source_guard;
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
        AND channel IN ('telegram', 'voice')
    ))
    OR (NEW.source_kind = 'course_fact' AND NOT EXISTS (
      SELECT 1 FROM school_course_facts
      WHERE principal_id = NEW.principal_id
        AND fact_id = NEW.source_fact_id
        AND course_id = NEW.course_id
    ));
END;

DROP TRIGGER school_practice_items_status_transition;
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
        AND channel IN ('telegram', 'voice')
    ))
  );
END;

DROP TRIGGER school_study_evidence_source_guard;
CREATE TRIGGER school_study_evidence_source_guard
BEFORE INSERT ON school_study_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_study_evidence_source_invalid') WHERE
    NEW.status != 'active'
    OR (NEW.evidence_kind = 'owner_statement' AND NOT EXISTS (
      SELECT 1 FROM conversation_turns
      WHERE turn_id = NEW.source_turn_id
        AND principal_id = NEW.principal_id
        AND channel IN ('telegram', 'voice')
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

DROP TRIGGER school_study_evidence_status_transition;
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
          AND channel IN ('telegram', 'voice')
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

DROP TRIGGER university_application_items_require_owner_turn_insert;
CREATE TRIGGER university_application_items_require_owner_turn_insert
BEFORE INSERT ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER university_application_items_require_owner_turn_update;
CREATE TRIGGER university_application_items_require_owner_turn_update
BEFORE UPDATE ON university_application_items
BEGIN
  SELECT RAISE(ABORT, 'university_application_item_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER university_workflow_revisions_require_owner_turn;
CREATE TRIGGER university_workflow_revisions_require_owner_turn
BEFORE INSERT ON university_workflow_revisions
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_revision_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel IN ('telegram', 'voice')
  );
END;

DROP TRIGGER school_study_signal_controls_insert_guard;
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
      AND channel IN ('telegram', 'voice')
  ) OR NOT EXISTS (
    SELECT 1 FROM school_study_check_in_claims claim, json_each(claim.source_keys_json) source
    WHERE claim.principal_id = NEW.principal_id
      AND claim.claim_id = NEW.check_in_id
      AND source.type = 'text'
      AND source.value = NEW.source_key
  ) OR NOT EXISTS (
    SELECT 1 FROM conversation_turns turn
    JOIN school_study_check_in_claims claim
      ON claim.principal_id = NEW.principal_id AND claim.claim_id = NEW.check_in_id
    WHERE turn.turn_id = NEW.control_turn_id
      AND turn.principal_id = NEW.principal_id
      AND turn.created_at >= claim.claimed_at
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


-- Raw owner text and model scribing are separate evidence, never overwritten.
-- A source snapshot keeps an unfinished answer readable after a tracker prunes its fact.
CREATE TABLE guided_assignment_answers (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  assignment_id TEXT NOT NULL,
  answer_id TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id),
  assignment_json TEXT NOT NULL,
  raw TEXT NOT NULL,
  scribed TEXT NOT NULL,
  step_notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, assignment_id, answer_id),
  UNIQUE (principal_id, assignment_id, turn_id)
) WITHOUT ROWID;

-- REPLACE can bypass a delete trigger. Refuse either identity collision before
-- SQLite can remove the original answer to make room for the replacement.
CREATE TRIGGER guided_assignment_answers_insert_conflict
BEFORE INSERT ON guided_assignment_answers
WHEN EXISTS (
  SELECT 1 FROM guided_assignment_answers
  WHERE principal_id = NEW.principal_id AND assignment_id = NEW.assignment_id
    AND (answer_id = NEW.answer_id OR turn_id = NEW.turn_id)
)
BEGIN
  SELECT RAISE(ABORT, 'guided_assignment_answer_conflict');
END;

CREATE TRIGGER guided_assignment_answers_reject_update
BEFORE UPDATE ON guided_assignment_answers
BEGIN
  SELECT RAISE(ABORT, 'guided_assignment_answer_update_forbidden');
END;

CREATE TRIGGER guided_assignment_answers_reject_delete
BEFORE DELETE ON guided_assignment_answers
BEGIN
  SELECT RAISE(ABORT, 'guided_assignment_answer_delete_forbidden');
END;

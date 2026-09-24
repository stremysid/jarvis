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

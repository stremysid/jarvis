-- A reminder can now be created by the scheduled deadline review, not only by
-- a conversation turn. That review has no turn of its own: it runs from the
-- daily digest, and inventing a user turn for it would put words in Sid's mouth
-- in his own history.
--
-- `created_turn_id` therefore becomes nullable. The owner-turn guard stays for
-- every reminder that does have a turn, so a valid turn belonging to somebody
-- else is still refused. A NULL turn is the scheduled review's, not an escape
-- hatch for any other caller.
PRAGMA defer_foreign_keys = ON;

DROP INDEX IF EXISTS owner_reminders_due;
DROP TRIGGER IF EXISTS owner_reminders_owner_turn;

CREATE TABLE owner_reminders_new (
  id TEXT NOT NULL PRIMARY KEY,
  principal TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  due_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', due_at) IS due_at),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'cancelled', 'failed', 'rejected')),
  -- NULL means the scheduled deadline review created this reminder.
  created_turn_id TEXT REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  sent_at TEXT CHECK (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) IS sent_at),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  UNIQUE (principal, created_turn_id, due_at, text),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK (status NOT IN ('sent', 'failed', 'rejected') OR attempts > 0)
) WITHOUT ROWID;

INSERT INTO owner_reminders_new (id, principal, due_at, text, status, created_turn_id, sent_at, attempts)
SELECT id, principal, due_at, text, status, created_turn_id, sent_at, attempts
FROM owner_reminders;

DROP TABLE owner_reminders;
ALTER TABLE owner_reminders_new RENAME TO owner_reminders;

CREATE INDEX owner_reminders_due ON owner_reminders(principal, status, due_at);

-- A valid turn belonging to somebody else is not evidence for this principal.
-- A NULL turn is the scheduled review and carries no turn claim to check.
CREATE TRIGGER owner_reminders_owner_turn
BEFORE INSERT ON owner_reminders
BEGIN
  SELECT RAISE(ABORT, 'owner_reminder_turn_mismatch')
  WHERE NEW.created_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_turns WHERE turn_id = NEW.created_turn_id AND principal_id = NEW.principal
  );
END;

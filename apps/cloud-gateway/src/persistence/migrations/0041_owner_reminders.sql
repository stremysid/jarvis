-- Apply before deploying the reminder tools and the five-minute sender.
-- A failed row is also the durable dispatch fence: an uncertain Telegram send
-- is never retried, because Telegram has no idempotency key.
CREATE TABLE owner_reminders (
  id TEXT NOT NULL PRIMARY KEY,
  principal TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  due_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', due_at) IS due_at),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  created_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  sent_at TEXT CHECK (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) IS sent_at),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  UNIQUE (principal, created_turn_id),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK (status NOT IN ('sent', 'failed') OR attempts > 0)
) WITHOUT ROWID;

CREATE INDEX owner_reminders_due ON owner_reminders(principal, status, due_at);

-- A valid turn belonging to somebody else is not evidence for this principal.
CREATE TRIGGER owner_reminders_owner_turn
BEFORE INSERT ON owner_reminders
BEGIN
  SELECT RAISE(ABORT, 'owner_reminder_turn_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns WHERE turn_id = NEW.created_turn_id AND principal_id = NEW.principal
  );
END;

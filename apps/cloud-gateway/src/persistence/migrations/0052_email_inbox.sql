-- Every delivery is retained, whatever its sender and whatever the headers say
-- about it. Full MIME and the complete source facts live in ARCHIVE, and D1
-- holds a bounded searchable preview so `body_text` is never the only copy.
CREATE TABLE email_inbox (
  email_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  received_at TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_date TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_truncated INTEGER NOT NULL,
  source_facts_json TEXT NOT NULL,
  source_facts_truncated INTEGER NOT NULL,
  parse_status TEXT NOT NULL,
  raw_size INTEGER NOT NULL,
  raw_key TEXT NOT NULL,
  facts_key TEXT NOT NULL
);
CREATE INDEX email_inbox_owner_received ON email_inbox(principal_id, received_at DESC, email_id DESC);

-- A stored message is evidence. Nothing may rewrite or remove one, so a later
-- reader cannot be shown mail that differs from what arrived.
CREATE TRIGGER email_inbox_insert_guard
BEFORE INSERT ON email_inbox
WHEN EXISTS (SELECT 1 FROM email_inbox WHERE email_id = NEW.email_id)
BEGIN
  SELECT RAISE(ABORT, 'email_inbox_immutable');
END;
CREATE TRIGGER email_inbox_update_guard
BEFORE UPDATE ON email_inbox
BEGIN
  SELECT RAISE(ABORT, 'email_inbox_immutable');
END;
CREATE TRIGGER email_inbox_delete_guard
BEFORE DELETE ON email_inbox
BEGIN
  SELECT RAISE(ABORT, 'email_inbox_immutable');
END;

-- Tier 1 observation: reading mail changes nothing and reaches nobody.
INSERT INTO capability_tiers (capability, tier, description, updated_at)
VALUES ('email.read', 1, 'Read the owner email inbox and its source facts', '2026-09-24T04:10:00.000Z');

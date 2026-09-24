-- The answer stays immutable. A separate claim spends it without changing what
-- the owner approved, and its unique key arbitrates concurrent channels.
-- Additive for old gateways. New gateways fail closed on tier 3 until this is
-- applied, so migration first avoids a temporary confirmation outage.
CREATE TABLE tool_confirmation_consumptions (
  decision_id TEXT NOT NULL PRIMARY KEY REFERENCES decision_responses(decision_id) ON DELETE RESTRICT,
  consumed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS consumed_at)
);

CREATE TRIGGER tool_confirmation_consumptions_reject_update
BEFORE UPDATE ON tool_confirmation_consumptions
BEGIN
  SELECT RAISE(ABORT, 'tool_confirmation_consumption_update_forbidden');
END;

CREATE TRIGGER tool_confirmation_consumptions_reject_delete
BEFORE DELETE ON tool_confirmation_consumptions
BEGIN
  SELECT RAISE(ABORT, 'tool_confirmation_consumption_delete_forbidden');
END;

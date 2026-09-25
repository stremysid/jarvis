-- web_read and web_search: the owner agent reads the public web.
--
-- Tier 1 because both tools only read. They send nothing as Sid, spend nothing
-- and change nothing outside this database. An outward action still needs its
-- own tool and that tool's tier. Without this row the tier gate denies both
-- tools as an unregistered capability.
INSERT INTO capability_tiers (capability, tier, description, updated_at)
VALUES ('read.web', 1, 'Search the public web or read one public web page', '2026-09-24T00:00:00.000Z');

-- One row per web tool call: what was asked for, what was reached, and how it
-- ended. A reply may claim only what a receipt shows, so a fetch or search with
-- no row here did not happen as far as Jarvis is concerned. Append-only, like
-- the other receipt tables. The fetched text itself is not stored here: the
-- page is public and re-readable, and this table answers "what did Jarvis look
-- at", not "what did the page say".
CREATE TABLE web_tool_receipts (
  -- The row's own ULID. It is not the id the model quotes.
  receipt_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  -- The id the model quotes is receipt: followed by this value, the same
  -- convention every owner tool uses. Nothing here assumes a provider's call
  -- ids are unique across turns, so that id resolves through
  -- UNIQUE (turn_id, tool_call_id) below rather than being the primary key.
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('web_read', 'web_search')),
  -- The URL requested, or the search query, exactly as the model sent it.
  target TEXT NOT NULL,
  -- Where the read ended after redirects. Null for a search, a refusal, or a
  -- read that failed before any response.
  final_url TEXT,
  method TEXT NOT NULL CHECK (method IN ('direct', 'browser_rendering', 'exa_mcp', 'none')),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'refused')),
  http_status INTEGER,
  -- Bytes received from the network for this call.
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  -- Characters of text handed back to the model on this call.
  returned_characters INTEGER NOT NULL CHECK (returned_characters >= 0),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  -- Why a call failed or was refused. Null when it completed.
  detail TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (turn_id, tool_call_id)
);

CREATE INDEX web_tool_receipts_by_principal ON web_tool_receipts (principal_id, occurred_at);

CREATE TRIGGER web_tool_receipts_reject_update
BEFORE UPDATE ON web_tool_receipts
BEGIN
  SELECT RAISE(ABORT, 'web_tool_receipt_update_forbidden');
END;

CREATE TRIGGER web_tool_receipts_reject_delete
BEFORE DELETE ON web_tool_receipts
BEGIN
  SELECT RAISE(ABORT, 'web_tool_receipt_delete_forbidden');
END;

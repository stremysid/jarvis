-- Replication state, deliberately in the SAME database as archive_event.
--
-- This is the crux of crash safety: page data, the local cursor, and the
-- intent to acknowledge must commit in one transaction. Split across two
-- databases there would be a window where events are durable but the cursor
-- is not (re-fetch, harmless) or the cursor is durable but the events are not
-- (permanent silent gap). One connection, one transaction, no window.
CREATE TABLE sync_cursor (
    consumer                    TEXT PRIMARY KEY,
    highest_contiguous_sequence INTEGER NOT NULL,
    updated_at                  TEXT NOT NULL
) STRICT;

-- An acknowledgement we have committed to sending but have not yet had
-- accepted. Staged in the same transaction as the events it covers, so a
-- crash between commit and network call leaves a durable record that the ACK
-- is owed. On restart it is drained before any new page is pulled -- otherwise
-- the cloud would keep re-sending a page we already have.
CREATE TABLE pending_sync_ack (
    consumer        TEXT PRIMARY KEY,
    through_sequence INTEGER NOT NULL,
    staged_at       TEXT NOT NULL
) STRICT;

-- The permanent record of every redacted event replicated from the cloud.
--
-- `canonical_text` is post-redaction text only. The redactor runs before an
-- event is ever created, so nothing here has ever held an authentication
-- digit, bearer token, or credential.
CREATE TABLE archive_event (
    event_id         TEXT PRIMARY KEY,
    event_sequence   INTEGER NOT NULL UNIQUE,
    event_type       TEXT NOT NULL,
    principal_id     TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    canonical_text   TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    occurred_at      TEXT NOT NULL,
    ingested_at      TEXT NOT NULL,
    producer_version TEXT NOT NULL
) STRICT;

CREATE INDEX archive_event_by_sequence ON archive_event (event_sequence);

-- Append-only, enforced by the database itself. Application-level guards are
-- necessary but not sufficient: every distilled fact cites a row here, so a
-- rewritable row turns every citation into a silent lie.
CREATE TRIGGER archive_event_no_update BEFORE UPDATE ON archive_event
BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;

CREATE TRIGGER archive_event_no_delete BEFORE DELETE ON archive_event
BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;

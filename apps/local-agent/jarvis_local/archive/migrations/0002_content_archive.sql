-- Content-addressed document storage.
--
-- Unique content is stored once in `content_blob`; every sighting appends a
-- row to `content_seen`. Conversation turns deliberately do NOT flow through
-- here -- they stay distinct events in archive_event even when their text is
-- identical, because when a thing was said is itself the information.
CREATE TABLE content_blob (
    content_hash  TEXT PRIMARY KEY,
    canonical_text TEXT NOT NULL,
    created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE content_seen (
    observation_id  TEXT PRIMARY KEY,
    content_hash    TEXT NOT NULL REFERENCES content_blob(content_hash),
    source_event_id TEXT NOT NULL,
    seen_at         TEXT NOT NULL
) STRICT;

CREATE INDEX content_seen_by_hash ON content_seen (content_hash);

CREATE TRIGGER content_blob_no_update BEFORE UPDATE ON content_blob
BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;

CREATE TRIGGER content_blob_no_delete BEFORE DELETE ON content_blob
BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;

CREATE TRIGGER content_seen_no_update BEFORE UPDATE ON content_seen
BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;

CREATE TRIGGER content_seen_no_delete BEFORE DELETE ON content_seen
BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;

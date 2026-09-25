-- The note-source guard required the source id to appear inside the note's
-- Markdown. That is code judging the model's prose, and it refused every nightly
-- consolidation from 2026-09-18 that did not repeat the ids. The receipt is the
-- sourceIds the action names, which the workflow validates against the sources
-- it supplied. How the note is worded is the model's. Only that clause is
-- removed -- the tables and columns this guard points at must still resolve.
DROP TRIGGER memory_topic_note_sources_insert_guard;

CREATE TRIGGER memory_topic_note_sources_insert_guard
BEFORE INSERT ON memory_topic_note_sources
WHEN NOT EXISTS (
    SELECT 1 FROM memory_topic_note_versions note
    WHERE note.principal_id = NEW.principal_id
      AND note.note_version_id = NEW.note_version_id
  )
  OR (
    NEW.source_kind = 'item'
    AND NOT EXISTS (
      SELECT 1 FROM memory_item_versions version
      WHERE version.principal_id = NEW.principal_id
        AND version.item_id = NEW.source_id
        AND version.version_id = NEW.item_version_id
    )
  )
  OR (
    NEW.source_kind = 'topic_event'
    AND NOT EXISTS (
      SELECT 1 FROM memory_topic_events event
      WHERE event.principal_id = NEW.principal_id
        AND event.topic_event_id = NEW.source_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_source_invalid')
  WHERE 1 = 1;
END;

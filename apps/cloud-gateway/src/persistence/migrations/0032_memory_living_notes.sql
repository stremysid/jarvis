PRAGMA foreign_keys = ON;

CREATE INDEX memory_history_chunks_principal_content_hash
ON memory_history_chunks(principal_id, content_hash);

CREATE INDEX memory_history_chunks_principal_start_event_sequence
ON memory_history_chunks(principal_id, start_event_sequence);

CREATE TABLE memory_topic_note_versions (
  note_version_id TEXT PRIMARY KEY CHECK (
    length(note_version_id) = 26 AND substr(note_version_id, 1, 1) BETWEEN '0' AND '7'
    AND note_version_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  topic_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (
    typeof(version_number) = 'integer' AND version_number > 0
  ),
  markdown TEXT NOT NULL CHECK (
    length(CAST(markdown AS BLOB)) BETWEEN 1 AND 16384
    AND instr(markdown, char(0)) = 0
    AND markdown NOT GLOB ('*[' || char(1) || '-' || char(8)
      || char(11) || char(12) || char(14) || '-' || char(31)
      || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  source_count INTEGER NOT NULL CHECK (
    typeof(source_count) = 'integer' AND source_count BETWEEN 1 AND 64
  ),
  token_count INTEGER NOT NULL CHECK (
    typeof(token_count) = 'integer' AND token_count BETWEEN 1 AND 4096
  ),
  run_id TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK (model_id GLOB 'deepseek:*'),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  UNIQUE (principal_id, note_version_id),
  UNIQUE (principal_id, topic_id, version_number),
  FOREIGN KEY (principal_id, topic_id)
    REFERENCES memory_topics(principal_id, topic_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, run_id)
    REFERENCES memory_runs(principal_id, run_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_topic_note_sources (
  source_ref_id TEXT PRIMARY KEY CHECK (
    length(source_ref_id) = 26 AND substr(source_ref_id, 1, 1) BETWEEN '0' AND '7'
    AND source_ref_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  note_version_id TEXT NOT NULL,
  source_position INTEGER NOT NULL CHECK (
    typeof(source_position) = 'integer' AND source_position BETWEEN 0 AND 63
  ),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('item', 'topic_event')),
  source_id TEXT NOT NULL CHECK (
    length(source_id) = 26 AND substr(source_id, 1, 1) BETWEEN '0' AND '7'
    AND source_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  item_version_id TEXT,
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  UNIQUE (principal_id, source_ref_id),
  UNIQUE (principal_id, note_version_id, source_position),
  UNIQUE (principal_id, note_version_id, source_kind, source_id),
  FOREIGN KEY (principal_id, note_version_id)
    REFERENCES memory_topic_note_versions(principal_id, note_version_id) ON DELETE RESTRICT,
  CHECK (
    (source_kind = 'item' AND item_version_id IS NOT NULL)
    OR (source_kind = 'topic_event' AND item_version_id IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_topic_note_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 26 AND substr(receipt_id, 1, 1) BETWEEN '0' AND '7'
    AND receipt_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  prior_note_version_id TEXT,
  new_note_version_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  UNIQUE (principal_id, receipt_id),
  UNIQUE (principal_id, new_note_version_id),
  FOREIGN KEY (principal_id, run_id)
    REFERENCES memory_runs(principal_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, topic_id)
    REFERENCES memory_topics(principal_id, topic_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, prior_note_version_id)
    REFERENCES memory_topic_note_versions(principal_id, note_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, new_note_version_id)
    REFERENCES memory_topic_note_versions(principal_id, note_version_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_topic_note_heads (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  topic_id TEXT NOT NULL,
  current_note_version_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('current', 'redacted')),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at
  ),
  PRIMARY KEY (principal_id, topic_id),
  FOREIGN KEY (principal_id, topic_id)
    REFERENCES memory_topics(principal_id, topic_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, current_note_version_id)
    REFERENCES memory_topic_note_versions(principal_id, note_version_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE memory_consolidation_change_receipts (
  change_receipt_id TEXT PRIMARY KEY CHECK (
    length(change_receipt_id) = 26 AND substr(change_receipt_id, 1, 1) BETWEEN '0' AND '7'
    AND change_receipt_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('expiry', 'supersession', 'topic_merge')),
  subject_id TEXT NOT NULL CHECK (
    length(subject_id) = 26 AND substr(subject_id, 1, 1) BETWEEN '0' AND '7'
    AND subject_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  related_id TEXT CHECK (
    related_id IS NULL OR (
      length(related_id) = 26 AND substr(related_id, 1, 1) BETWEEN '0' AND '7'
      AND related_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    )
  ),
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  transition_or_event_id TEXT NOT NULL CHECK (
    length(transition_or_event_id) = 26
    AND substr(transition_or_event_id, 1, 1) BETWEEN '0' AND '7'
    AND transition_or_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  UNIQUE (principal_id, change_receipt_id),
  UNIQUE (principal_id, run_id, change_kind, subject_id),
  FOREIGN KEY (principal_id, run_id)
    REFERENCES memory_runs(principal_id, run_id) ON DELETE RESTRICT,
  CHECK (
    (change_kind = 'expiry' AND related_id IS NULL)
    OR (change_kind IN ('supersession', 'topic_merge') AND related_id IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_consolidation_model_steps (
  step_receipt_id TEXT PRIMARY KEY CHECK (
    length(step_receipt_id) = 26 AND substr(step_receipt_id, 1, 1) BETWEEN '0' AND '7'
    AND step_receipt_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  step_number INTEGER NOT NULL CHECK (typeof(step_number) = 'integer' AND step_number > 0),
  response_json TEXT NOT NULL CHECK (
    json_valid(response_json) AND json_type(response_json) = 'array'
    AND length(CAST(response_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  response_hash TEXT NOT NULL CHECK (
    length(response_hash) = 64 AND response_hash NOT GLOB '*[^0-9a-f]*'
  ),
  input_tokens INTEGER NOT NULL CHECK (typeof(input_tokens) = 'integer' AND input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (typeof(output_tokens) = 'integer' AND output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (
    typeof(cache_read_tokens) = 'integer' AND cache_read_tokens BETWEEN 0 AND input_tokens
  ),
  reserved_cost_micros INTEGER NOT NULL CHECK (
    typeof(reserved_cost_micros) = 'integer' AND reserved_cost_micros >= 0
  ),
  settled_cost_micros INTEGER NOT NULL CHECK (
    typeof(settled_cost_micros) = 'integer'
    AND settled_cost_micros BETWEEN 0 AND reserved_cost_micros
  ),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  UNIQUE (principal_id, step_receipt_id),
  UNIQUE (principal_id, run_id, step_number),
  FOREIGN KEY (principal_id, run_id)
    REFERENCES memory_runs(principal_id, run_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER memory_topic_note_versions_insert_guard
BEFORE INSERT ON memory_topic_note_versions
WHEN NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.run_id = NEW.run_id
      AND run.job = 'consolidation'
      AND run.outcome = 'running'
      AND run.provider_model_id = NEW.model_id
      AND NEW.created_at >= run.started_at
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_topics topic
    WHERE topic.principal_id = NEW.principal_id
      AND topic.topic_id = NEW.topic_id
      AND topic.status = 'active'
  )
  OR NEW.version_number <> COALESCE((
    SELECT max(version.version_number) + 1
    FROM memory_topic_note_versions version
    WHERE version.principal_id = NEW.principal_id AND version.topic_id = NEW.topic_id
  ), 1)
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_version_invalid')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_versions_update_guard
BEFORE UPDATE ON memory_topic_note_versions
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_version_immutable')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_versions_delete_guard
BEFORE DELETE ON memory_topic_note_versions
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_version_delete_forbidden')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_sources_insert_guard
BEFORE INSERT ON memory_topic_note_sources
WHEN NOT EXISTS (
    SELECT 1 FROM memory_topic_note_versions note
    WHERE note.principal_id = NEW.principal_id
      AND note.note_version_id = NEW.note_version_id
      AND instr(note.markdown, NEW.source_id) > 0
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

CREATE TRIGGER memory_topic_note_sources_update_guard
BEFORE UPDATE ON memory_topic_note_sources
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_source_immutable')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_sources_delete_guard
BEFORE DELETE ON memory_topic_note_sources
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_source_delete_forbidden')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_receipts_insert_guard
BEFORE INSERT ON memory_topic_note_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM memory_topic_note_versions note
    JOIN memory_runs run
      ON run.principal_id = note.principal_id AND run.run_id = note.run_id
    WHERE note.principal_id = NEW.principal_id
      AND note.note_version_id = NEW.new_note_version_id
      AND note.topic_id = NEW.topic_id
      AND note.run_id = NEW.run_id
      AND run.job = 'consolidation'
      AND run.outcome = 'running'
      AND note.source_count = (
        SELECT count(*) FROM memory_topic_note_sources source
        WHERE source.principal_id = note.principal_id
          AND source.note_version_id = note.note_version_id
      )
      AND NEW.created_at >= note.created_at
  )
  OR NEW.prior_note_version_id IS NOT (
    SELECT head.current_note_version_id FROM memory_topic_note_heads head
    WHERE head.principal_id = NEW.principal_id AND head.topic_id = NEW.topic_id
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_receipt_invalid')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_receipts_apply_head
AFTER INSERT ON memory_topic_note_receipts
BEGIN
  INSERT INTO memory_topic_note_heads (
    principal_id, topic_id, current_note_version_id, visibility, updated_at
  ) VALUES (
    NEW.principal_id, NEW.topic_id, NEW.new_note_version_id, 'current', NEW.created_at
  ) ON CONFLICT (principal_id, topic_id) DO UPDATE SET
    current_note_version_id = excluded.current_note_version_id,
    visibility = 'current',
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER memory_topic_note_receipts_update_guard
BEFORE UPDATE ON memory_topic_note_receipts
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_receipt_immutable')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_receipts_delete_guard
BEFORE DELETE ON memory_topic_note_receipts
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_receipt_delete_forbidden')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_heads_insert_guard
BEFORE INSERT ON memory_topic_note_heads
WHEN NOT EXISTS (
    SELECT 1 FROM memory_topic_note_receipts receipt
    WHERE receipt.principal_id = NEW.principal_id
      AND receipt.topic_id = NEW.topic_id
      AND receipt.new_note_version_id = NEW.current_note_version_id
      AND receipt.created_at = NEW.updated_at
      AND NEW.visibility = 'current'
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_head_invalid')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_heads_update_guard
BEFORE UPDATE ON memory_topic_note_heads
WHEN NEW.principal_id <> OLD.principal_id
  OR NEW.topic_id <> OLD.topic_id
  OR NEW.updated_at < OLD.updated_at
  OR (
    NEW.current_note_version_id <> OLD.current_note_version_id
    AND NOT EXISTS (
      SELECT 1 FROM memory_topic_note_receipts receipt
      WHERE receipt.principal_id = NEW.principal_id
        AND receipt.topic_id = NEW.topic_id
        AND receipt.prior_note_version_id = OLD.current_note_version_id
        AND receipt.new_note_version_id = NEW.current_note_version_id
        AND receipt.created_at = NEW.updated_at
        AND NEW.visibility = 'current'
    )
  )
  OR (
    NEW.current_note_version_id = OLD.current_note_version_id
    AND NEW.visibility = 'current'
    AND OLD.visibility = 'redacted'
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_head_transition_invalid')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_note_heads_delete_guard
BEFORE DELETE ON memory_topic_note_heads
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_note_head_delete_forbidden')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_consolidation_change_receipts_insert_guard
BEFORE INSERT ON memory_consolidation_change_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.run_id = NEW.run_id
      AND run.job = 'consolidation'
      AND run.outcome = 'running'
      AND NEW.created_at >= run.started_at
  )
  OR (
    NEW.change_kind = 'expiry'
    AND NOT EXISTS (
      SELECT 1 FROM memory_item_transitions transition_row
      WHERE transition_row.principal_id = NEW.principal_id
        AND transition_row.item_id = NEW.subject_id
        AND transition_row.transition_id = NEW.transition_or_event_id
        AND transition_row.lifecycle_state = 'expired'
    )
  )
  OR (
    NEW.change_kind = 'supersession'
    AND (
      NEW.transition_or_event_id <> NEW.related_id
      OR NOT EXISTS (
        SELECT 1
        FROM memory_item_state older_state
        JOIN memory_item_versions older_version
          ON older_version.principal_id = older_state.principal_id
          AND older_version.version_id = older_state.current_version_id
        JOIN memory_item_state newer_state
          ON newer_state.principal_id = older_state.principal_id
          AND newer_state.item_id = NEW.related_id
          AND newer_state.lifecycle_state = 'active'
        JOIN memory_item_versions newer_version
          ON newer_version.principal_id = newer_state.principal_id
          AND newer_version.version_id = newer_state.current_version_id
        WHERE older_state.principal_id = NEW.principal_id
          AND older_state.item_id = NEW.subject_id
          AND older_state.lifecycle_state = 'active'
          AND newer_version.created_at > older_version.created_at
      )
    )
  )
  OR (
    NEW.change_kind = 'topic_merge'
    AND NOT EXISTS (
      SELECT 1 FROM memory_topic_events event
      WHERE event.principal_id = NEW.principal_id
        AND event.topic_id = NEW.subject_id
        AND event.merge_target_topic_id = NEW.related_id
        AND event.topic_event_id = NEW.transition_or_event_id
        AND event.operation = 'merge'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_consolidation_change_receipt_invalid')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_consolidation_change_receipts_update_guard
BEFORE UPDATE ON memory_consolidation_change_receipts
BEGIN
  SELECT RAISE(ABORT, 'memory_consolidation_change_receipt_immutable')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_consolidation_change_receipts_delete_guard
BEFORE DELETE ON memory_consolidation_change_receipts
BEGIN
  SELECT RAISE(ABORT, 'memory_consolidation_change_receipt_delete_forbidden')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_consolidation_model_steps_insert_guard
BEFORE INSERT ON memory_consolidation_model_steps
WHEN NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.run_id = NEW.run_id
      AND run.job = 'consolidation'
      AND run.outcome = 'running'
      AND NEW.created_at >= run.started_at
  )
  OR NEW.step_number <> COALESCE((
    SELECT max(step.step_number) + 1
    FROM memory_consolidation_model_steps step
    WHERE step.principal_id = NEW.principal_id AND step.run_id = NEW.run_id
  ), 1)
BEGIN
  SELECT RAISE(ABORT, 'memory_consolidation_model_step_invalid')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_consolidation_model_steps_update_guard
BEFORE UPDATE ON memory_consolidation_model_steps
BEGIN
  SELECT RAISE(ABORT, 'memory_consolidation_model_step_immutable')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_consolidation_model_steps_delete_guard
BEFORE DELETE ON memory_consolidation_model_steps
BEGIN
  SELECT RAISE(ABORT, 'memory_consolidation_model_step_delete_forbidden')
  WHERE 1 = 1;
END;

CREATE TRIGGER memory_topic_notes_redact_for_supersession
AFTER INSERT ON memory_consolidation_change_receipts
WHEN NEW.change_kind = 'supersession'
BEGIN
  UPDATE memory_topic_note_heads
  SET visibility = 'redacted', updated_at = NEW.created_at
  WHERE principal_id = NEW.principal_id
    AND visibility = 'current'
    AND EXISTS (
      SELECT 1 FROM memory_topic_note_sources source
      WHERE source.principal_id = NEW.principal_id
        AND source.note_version_id = memory_topic_note_heads.current_note_version_id
        AND source.source_kind = 'item'
        AND source.source_id = NEW.subject_id
    );
END;

CREATE TRIGGER memory_topic_notes_redact_for_topic_merge
AFTER INSERT ON memory_topic_events
WHEN NEW.operation = 'merge'
BEGIN
  UPDATE memory_topic_note_heads
  SET visibility = 'redacted', updated_at = NEW.occurred_at
  WHERE principal_id = NEW.principal_id
    AND visibility = 'current'
    AND topic_id IN (NEW.topic_id, NEW.merge_target_topic_id);
END;

-- Forgetting redacts through its suppression insert and consolidation
-- supersession through its receipt so each safety path has one authority.
CREATE TRIGGER memory_topic_notes_redact_for_item_transition
AFTER INSERT ON memory_item_transitions
WHEN NEW.lifecycle_state IN ('expired', 'rejected')
BEGIN
  UPDATE memory_topic_note_heads
  SET visibility = 'redacted', updated_at = NEW.occurred_at
  WHERE principal_id = NEW.principal_id
    AND visibility = 'current'
    AND EXISTS (
      SELECT 1 FROM memory_topic_note_sources source
      WHERE source.principal_id = NEW.principal_id
        AND source.note_version_id = memory_topic_note_heads.current_note_version_id
        AND source.source_kind = 'item'
        AND source.source_id = NEW.item_id
    );
END;

CREATE TRIGGER memory_topic_notes_redact_for_event_suppression
AFTER INSERT ON memory_event_suppressions
BEGIN
  UPDATE memory_topic_note_heads
  SET visibility = 'redacted', updated_at = NEW.created_at
  WHERE principal_id = NEW.principal_id
    AND visibility = 'current'
    AND EXISTS (
      SELECT 1
      FROM memory_topic_note_sources note_source
      JOIN memory_item_sources item_source
        ON item_source.principal_id = note_source.principal_id
        AND item_source.item_id = note_source.source_id
        AND item_source.version_id = note_source.item_version_id
      WHERE note_source.principal_id = NEW.principal_id
        AND note_source.note_version_id = memory_topic_note_heads.current_note_version_id
        AND note_source.source_kind = 'item'
        AND (
          item_source.event_id = NEW.target_event_id
          OR item_source.event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
        )
    );
END;

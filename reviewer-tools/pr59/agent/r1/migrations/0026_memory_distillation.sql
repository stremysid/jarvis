CREATE TABLE memory_distillation_event_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 26 AND substr(receipt_id, 1, 1) BETWEEN '0' AND '7'
    AND receipt_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (
    typeof(event_sequence) = 'integer' AND event_sequence > 0
  ),
  event_id TEXT NOT NULL CHECK (
    length(event_id) = 26 AND substr(event_id, 1, 1) BETWEEN '0' AND '7'
    AND event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  disposition TEXT NOT NULL CHECK (disposition IN ('eligible', 'skipped')),
  source_location TEXT NOT NULL CHECK (source_location IN ('live', 'archived')),
  r2_segment_id TEXT CHECK (
    r2_segment_id IS NULL OR (
      length(r2_segment_id) = 64 AND r2_segment_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  recorded_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at
  ),
  UNIQUE (principal_id, receipt_id),
  UNIQUE (principal_id, run_id, event_sequence),
  UNIQUE (principal_id, run_id, event_id),
  FOREIGN KEY (principal_id, run_id)
    REFERENCES memory_runs(principal_id, run_id) ON DELETE RESTRICT,
  CHECK (
    (source_location = 'live' AND r2_segment_id IS NULL)
    OR (source_location = 'archived' AND r2_segment_id IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_distillation_item_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 26 AND substr(receipt_id, 1, 1) BETWEEN '0' AND '7'
    AND receipt_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL CHECK (
    length(proposal_hash) = 64 AND proposal_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_in_run INTEGER NOT NULL CHECK (created_in_run IN (0, 1)),
  recorded_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at
  ),
  UNIQUE (principal_id, receipt_id),
  UNIQUE (principal_id, run_id, item_id),
  UNIQUE (principal_id, run_id, proposal_hash),
  FOREIGN KEY (principal_id, run_id)
    REFERENCES memory_runs(principal_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER memory_distillation_event_receipts_insert_guard
BEFORE INSERT ON memory_distillation_event_receipts
WHEN EXISTS (
    SELECT 1 FROM memory_distillation_event_receipts receipt
    WHERE receipt.receipt_id = NEW.receipt_id
      OR (receipt.principal_id = NEW.principal_id
        AND receipt.run_id = NEW.run_id
        AND (receipt.event_sequence = NEW.event_sequence OR receipt.event_id = NEW.event_id))
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.run_id = NEW.run_id
      AND run.job = 'distillation'
      AND run.outcome = 'running'
      AND NEW.event_sequence BETWEEN run.start_event_sequence AND run.end_event_sequence
      AND NEW.recorded_at >= run.started_at
  )
  OR (
    NEW.source_location = 'live'
    AND NOT EXISTS (
      SELECT 1 FROM events event
      WHERE event.sequence = NEW.event_sequence
        AND event.event_id = NEW.event_id
        AND event.content_hash = NEW.content_hash
        AND (NEW.disposition = 'skipped' OR event.subject_id = NEW.principal_id)
    )
  )
  OR (
    NEW.source_location = 'archived'
    AND NOT EXISTS (
      SELECT 1 FROM archive_segment_events archived
      WHERE archived.event_sequence = NEW.event_sequence
        AND archived.event_id = NEW.event_id
        AND archived.content_hash = NEW.content_hash
        AND archived.segment_id = NEW.r2_segment_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_event_receipt_invalid');
END;

CREATE TRIGGER memory_distillation_event_receipts_immutable_update
BEFORE UPDATE ON memory_distillation_event_receipts
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_event_receipt_immutable');
END;

CREATE TRIGGER memory_distillation_event_receipts_delete_forbidden
BEFORE DELETE ON memory_distillation_event_receipts
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_event_receipt_delete_forbidden');
END;

CREATE TRIGGER memory_distillation_item_receipts_insert_guard
BEFORE INSERT ON memory_distillation_item_receipts
WHEN EXISTS (
    SELECT 1 FROM memory_distillation_item_receipts receipt
    WHERE receipt.receipt_id = NEW.receipt_id
      OR (receipt.principal_id = NEW.principal_id
        AND receipt.run_id = NEW.run_id
        AND (receipt.item_id = NEW.item_id OR receipt.proposal_hash = NEW.proposal_hash))
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.run_id = NEW.run_id
      AND run.job = 'distillation'
      AND run.outcome = 'running'
      AND NEW.recorded_at >= run.started_at
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_items item
    WHERE item.principal_id = NEW.principal_id
      AND item.item_id = NEW.item_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_item_sources source
    WHERE source.principal_id = NEW.principal_id
      AND source.item_id = NEW.item_id
  )
  OR EXISTS (
    SELECT 1 FROM memory_item_sources source
    WHERE source.principal_id = NEW.principal_id
      AND source.item_id = NEW.item_id
      AND NOT EXISTS (
        SELECT 1 FROM memory_distillation_event_receipts event_receipt
        WHERE event_receipt.principal_id = NEW.principal_id
          AND event_receipt.run_id = NEW.run_id
          AND event_receipt.event_sequence = source.event_sequence
          AND event_receipt.event_id = source.event_id
          AND event_receipt.disposition = 'eligible'
      )
  )
  OR (
    NEW.created_in_run = 1
    AND NOT EXISTS (
      SELECT 1 FROM memory_items item
      JOIN memory_runs run
        ON run.principal_id = NEW.principal_id AND run.run_id = NEW.run_id
      WHERE item.principal_id = NEW.principal_id
        AND item.item_id = NEW.item_id
        AND item.created_at >= run.started_at
        AND item.created_at <= NEW.recorded_at
    )
  )
  OR (
    NEW.created_in_run = 0
    AND NOT EXISTS (
      SELECT 1 FROM memory_items item
      JOIN memory_runs run
        ON run.principal_id = NEW.principal_id AND run.run_id = NEW.run_id
      WHERE item.principal_id = NEW.principal_id
        AND item.item_id = NEW.item_id
        AND item.created_at < run.started_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_item_receipt_invalid');
END;

CREATE TRIGGER memory_distillation_item_receipts_immutable_update
BEFORE UPDATE ON memory_distillation_item_receipts
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_item_receipt_immutable');
END;

CREATE TRIGGER memory_distillation_item_receipts_delete_forbidden
BEFORE DELETE ON memory_distillation_item_receipts
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_item_receipt_delete_forbidden');
END;

CREATE TRIGGER memory_distillation_runs_reconcile_guard
BEFORE UPDATE ON memory_runs
WHEN OLD.job = 'distillation'
  AND NEW.outcome <> 'running'
  AND (
    NEW.input_event_count <> (
      SELECT count(*) FROM memory_distillation_event_receipts receipt
      WHERE receipt.principal_id = NEW.principal_id AND receipt.run_id = NEW.run_id
    )
    OR NEW.created_item_count <> (
      SELECT COALESCE(sum(receipt.created_in_run), 0)
      FROM memory_distillation_item_receipts receipt
      WHERE receipt.principal_id = NEW.principal_id AND receipt.run_id = NEW.run_id
    )
    OR (
      NEW.start_event_sequence IS NULL
      AND EXISTS (
        SELECT 1 FROM memory_distillation_event_receipts receipt
        WHERE receipt.principal_id = NEW.principal_id AND receipt.run_id = NEW.run_id
      )
    )
    OR (
      NEW.outcome IN ('succeeded', 'nothing_new')
      AND NEW.start_event_sequence IS NOT NULL
      AND (
        NEW.input_event_count <> NEW.end_event_sequence - NEW.start_event_sequence + 1
        OR NEW.start_event_sequence <> (
          SELECT min(receipt.event_sequence) FROM memory_distillation_event_receipts receipt
          WHERE receipt.principal_id = NEW.principal_id AND receipt.run_id = NEW.run_id
        )
        OR NEW.end_event_sequence <> (
          SELECT max(receipt.event_sequence) FROM memory_distillation_event_receipts receipt
          WHERE receipt.principal_id = NEW.principal_id AND receipt.run_id = NEW.run_id
        )
      )
    )
    OR (
      NEW.outcome = 'succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM memory_distillation_item_receipts receipt
        WHERE receipt.principal_id = NEW.principal_id AND receipt.run_id = NEW.run_id
      )
    )
    OR (
      NEW.outcome = 'nothing_new'
      AND EXISTS (
        SELECT 1 FROM memory_distillation_item_receipts receipt
        WHERE receipt.principal_id = NEW.principal_id AND receipt.run_id = NEW.run_id
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_run_counts_invalid');
END;

CREATE TRIGGER memory_distillation_cursor_insert_guard
BEFORE INSERT ON memory_cursors
WHEN NEW.cursor_name = 'distillation'
  AND NEW.current_event_sequence <> 0
  AND NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.job = 'distillation'
      AND run.outcome IN ('succeeded', 'nothing_new')
      AND run.start_event_sequence = 1
      AND run.end_event_sequence = NEW.current_event_sequence
      AND run.input_event_count = NEW.current_event_sequence
      AND run.input_event_count = (
        SELECT count(*) FROM memory_distillation_event_receipts receipt
        WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
      )
      AND run.created_item_count = (
        SELECT COALESCE(sum(receipt.created_in_run), 0)
        FROM memory_distillation_item_receipts receipt
        WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_cursor_advance_invalid');
END;

CREATE TRIGGER memory_distillation_cursor_update_guard
BEFORE UPDATE ON memory_cursors
WHEN NEW.cursor_name = 'distillation'
  AND NEW.current_event_sequence > OLD.current_event_sequence
  AND NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.job = 'distillation'
      AND run.outcome IN ('succeeded', 'nothing_new')
      AND run.start_event_sequence = OLD.current_event_sequence + 1
      AND run.end_event_sequence = NEW.current_event_sequence
      AND run.input_event_count = NEW.current_event_sequence - OLD.current_event_sequence
      AND run.input_event_count = (
        SELECT count(*) FROM memory_distillation_event_receipts receipt
        WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
      )
      AND run.created_item_count = (
        SELECT COALESCE(sum(receipt.created_in_run), 0)
        FROM memory_distillation_item_receipts receipt
        WHERE receipt.principal_id = run.principal_id AND receipt.run_id = run.run_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_distillation_cursor_advance_invalid');
END;

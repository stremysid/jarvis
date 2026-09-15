-- Durable literal-history walks store only query state and canonical event
-- receipts. Exact conversation text is re-read from D1 or a verified R2
-- segment after active suppressions are checked again.

CREATE TABLE memory_literal_search_jobs (
  job_id TEXT PRIMARY KEY CHECK (
    length(job_id) = 26 AND substr(job_id, 1, 1) BETWEEN '0' AND '7'
    AND job_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  job_key TEXT NOT NULL CHECK (length(CAST(job_key AS BLOB)) BETWEEN 1 AND 128),
  query_text TEXT NOT NULL CHECK (
    length(CAST(query_text AS BLOB)) BETWEEN 1 AND 1024
    AND instr(query_text, char(0)) = 0
    AND query_text NOT GLOB ('*[' || char(1) || '-' || char(31)
      || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ),
  query_hash TEXT NOT NULL CHECK (
    length(query_hash) = 64 AND query_hash NOT GLOB '*[^0-9a-f]*'
  ),
  snapshot_event_sequence INTEGER NOT NULL CHECK (
    typeof(snapshot_event_sequence) = 'integer' AND snapshot_event_sequence >= 0
  ),
  checkpoint_event_sequence INTEGER NOT NULL CHECK (
    typeof(checkpoint_event_sequence) = 'integer'
    AND checkpoint_event_sequence >= 0
    AND checkpoint_event_sequence <= snapshot_event_sequence
  ),
  scanned_event_count INTEGER NOT NULL CHECK (
    typeof(scanned_event_count) = 'integer' AND scanned_event_count >= 0
  ),
  matched_event_count INTEGER NOT NULL CHECK (
    typeof(matched_event_count) = 'integer' AND matched_event_count >= 0
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  failure_code TEXT CHECK (
    failure_code IS NULL OR length(CAST(failure_code AS BLOB)) BETWEEN 1 AND 128
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND updated_at >= created_at
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at
      AND completed_at >= created_at
    )
  ),
  UNIQUE (principal_id, job_id),
  UNIQUE (principal_id, job_key),
  CHECK (
    (status IN ('pending', 'running') AND completed_at IS NULL AND failure_code IS NULL)
    OR (status = 'succeeded' AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_literal_search_hits (
  principal_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
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
  found_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', found_at) IS found_at),
  PRIMARY KEY (principal_id, job_id, event_sequence),
  UNIQUE (principal_id, job_id, event_id),
  FOREIGN KEY (principal_id, job_id)
    REFERENCES memory_literal_search_jobs(principal_id, job_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX memory_literal_search_jobs_status_lookup
ON memory_literal_search_jobs(principal_id, status, updated_at, job_id);

DROP TRIGGER memory_history_chunks_insert_guard;

-- Suppression is a storage boundary as well as a retrieval filter. Rechecking
-- it in D1 closes the race between the Worker read and the content-row batch.
CREATE TRIGGER memory_history_chunks_insert_guard
BEFORE INSERT ON memory_history_chunks
WHEN (NEW.chunk_rowid IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_history_chunks chunk
    WHERE chunk.chunk_rowid = NEW.chunk_rowid
  ))
  OR EXISTS (
    SELECT 1 FROM memory_history_chunks chunk
    WHERE chunk.chunk_id = NEW.chunk_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_history_coverage coverage
    WHERE coverage.principal_id = NEW.principal_id
      AND coverage.start_event_sequence = NEW.start_event_sequence
      AND coverage.end_event_sequence = NEW.end_event_sequence
      AND coverage.indexing_outcome = 'indexed'
      AND coverage.content_hash = NEW.source_receipt_hash
      AND (
        NEW.source_location = 'mixed'
        OR (coverage.source_location = NEW.source_location
          AND coverage.r2_segment_id IS NEW.r2_segment_id)
      )
  )
  OR EXISTS (
    SELECT 1 FROM memory_active_event_suppressions suppression
    WHERE suppression.principal_id = NEW.principal_id
      AND (
        suppression.start_event_sequence <= NEW.end_event_sequence
          AND suppression.end_event_sequence >= NEW.start_event_sequence
        OR suppression.target_event_id IN (
          SELECT event_id FROM events
          WHERE sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
          UNION ALL
          SELECT event_id FROM archive_segment_events
          WHERE event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_history_chunk_receipt_invalid');
END;

CREATE TRIGGER memory_literal_search_jobs_insert_guard
BEFORE INSERT ON memory_literal_search_jobs
WHEN EXISTS (
    SELECT 1 FROM memory_literal_search_jobs job
    WHERE job.job_id = NEW.job_id
      OR (job.principal_id = NEW.principal_id AND job.job_key = NEW.job_key)
  )
  OR NEW.status <> 'pending'
  OR NEW.checkpoint_event_sequence <> 0
  OR NEW.scanned_event_count <> 0
  OR NEW.matched_event_count <> 0
  OR NEW.failure_code IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NEW.snapshot_event_sequence > MAX(
    COALESCE((SELECT sealed_through FROM archive_state WHERE singleton = 1), 0),
    COALESCE((SELECT max(sequence) FROM events), 0)
  )
  OR NOT EXISTS (
    SELECT 1 FROM principals principal
    WHERE principal.principal_id = NEW.principal_id
      AND principal.principal_type = 'human'
      AND principal.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_literal_search_job_initial_state_invalid');
END;

CREATE TRIGGER memory_literal_search_jobs_update_guard
BEFORE UPDATE ON memory_literal_search_jobs
WHEN NEW.job_id <> OLD.job_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.job_key <> OLD.job_key
  OR NEW.query_text <> OLD.query_text
  OR NEW.query_hash <> OLD.query_hash
  OR NEW.snapshot_event_sequence <> OLD.snapshot_event_sequence
  OR NEW.created_at <> OLD.created_at
  OR NEW.updated_at < OLD.updated_at
  OR NEW.checkpoint_event_sequence < OLD.checkpoint_event_sequence
  OR NEW.scanned_event_count < OLD.scanned_event_count
  OR NEW.matched_event_count < OLD.matched_event_count
  OR NEW.matched_event_count > NEW.scanned_event_count
  OR NEW.scanned_event_count <> NEW.checkpoint_event_sequence
  OR NEW.matched_event_count - OLD.matched_event_count
    > NEW.scanned_event_count - OLD.scanned_event_count
  OR (NEW.completed_at IS NOT NULL AND NEW.completed_at < NEW.updated_at)
  OR NOT (
    (OLD.status = 'pending' AND NEW.status = 'running')
    OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'failed'))
  )
  OR (NEW.status = 'succeeded'
    AND NEW.checkpoint_event_sequence <> NEW.snapshot_event_sequence)
BEGIN
  SELECT RAISE(ABORT, 'memory_literal_search_job_transition_invalid');
END;

CREATE TRIGGER memory_literal_search_jobs_delete_forbidden
BEFORE DELETE ON memory_literal_search_jobs
BEGIN
  SELECT RAISE(ABORT, 'memory_literal_search_job_delete_forbidden');
END;

CREATE TRIGGER memory_literal_search_hits_insert_guard
BEFORE INSERT ON memory_literal_search_hits
WHEN EXISTS (
    SELECT 1 FROM memory_literal_search_hits hit
    WHERE hit.principal_id = NEW.principal_id
      AND hit.job_id = NEW.job_id
      AND (hit.event_sequence = NEW.event_sequence OR hit.event_id = NEW.event_id)
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_literal_search_jobs job
    WHERE job.principal_id = NEW.principal_id
      AND job.job_id = NEW.job_id
      AND job.status = 'running'
      AND NEW.event_sequence > job.checkpoint_event_sequence
      AND NEW.event_sequence <= job.snapshot_event_sequence
  )
  OR NOT EXISTS (
    SELECT 1 FROM events event
    WHERE event.sequence = NEW.event_sequence
      AND event.event_id = NEW.event_id
      AND event.subject_id = NEW.principal_id
      AND event.content_hash = NEW.content_hash
    UNION
    SELECT 1 FROM archive_segment_events archived
    WHERE archived.event_sequence = NEW.event_sequence
      AND archived.event_id = NEW.event_id
      AND archived.content_hash = NEW.content_hash
  )
  OR EXISTS (
    SELECT 1 FROM memory_active_event_suppressions suppression
    WHERE suppression.principal_id = NEW.principal_id
      AND (
        suppression.target_event_id = NEW.event_id
        OR NEW.event_sequence BETWEEN suppression.start_event_sequence
          AND suppression.end_event_sequence
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_literal_search_hit_receipt_invalid');
END;

CREATE TRIGGER memory_literal_search_hits_immutable_update
BEFORE UPDATE ON memory_literal_search_hits
BEGIN
  SELECT RAISE(ABORT, 'memory_literal_search_hit_immutable');
END;

CREATE TRIGGER memory_literal_search_hits_delete_forbidden
BEFORE DELETE ON memory_literal_search_hits
BEGIN
  SELECT RAISE(ABORT, 'memory_literal_search_hit_delete_forbidden');
END;

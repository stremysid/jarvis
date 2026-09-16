-- Durable progress and verification receipts for the custom memory backup.
-- Exported rows stay in R2. D1 records only immutable cut marks, resumable
-- progress, verified object metadata, retention state and alert claims.

CREATE TABLE memory_backup_runs (
  run_date TEXT PRIMARY KEY CHECK (
    length(run_date) = 10
    AND run_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND strftime('%Y-%m-%d', run_date) IS run_date
  ),
  run_id TEXT NOT NULL UNIQUE CHECK (
    length(run_id) = 26
    AND substr(run_id, 1, 1) GLOB '[0-7]'
    AND run_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('running', 'verified', 'failed', 'abandoned', 'pruned')),
  schema_version TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 128),
  marks_json TEXT NOT NULL CHECK (
    json_valid(marks_json)
    AND json_type(marks_json) = 'object'
    AND length(CAST(marks_json AS BLOB)) <= 4096
  ),
  current_table_index INTEGER NOT NULL CHECK (current_table_index BETWEEN 0 AND 7),
  cursor_key TEXT CHECK (cursor_key IS NULL OR length(CAST(cursor_key AS BLOB)) BETWEEN 1 AND 128),
  next_object_number INTEGER NOT NULL CHECK (next_object_number >= 0),
  verified_object_count INTEGER NOT NULL CHECK (
    verified_object_count >= 0 AND verified_object_count <= next_object_number
  ),
  lease_id TEXT CHECK (
    lease_id IS NULL OR (
      length(lease_id) = 26
      AND substr(lease_id, 1, 1) GLOB '[0-7]'
      AND lease_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    )
  ),
  lease_expires_at TEXT CHECK (
    lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at
  ),
  manifest_object_key TEXT CHECK (
    manifest_object_key IS NULL OR length(CAST(manifest_object_key AS BLOB)) BETWEEN 1 AND 1024
  ),
  manifest_sha256 TEXT CHECK (
    manifest_sha256 IS NULL OR (
      length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'memory_backup_binding_missing',
    'memory_backup_object_readback_failed',
    'memory_backup_manifest_readback_failed',
    'memory_backup_advertise_failed',
    'memory_backup_cleanup_failed',
    'memory_backup_operation_failed'
  )),
  started_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND updated_at >= started_at
  ),
  verified_at TEXT CHECK (
    verified_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at AND verified_at >= started_at
    )
  ),
  abandoned_at TEXT CHECK (
    abandoned_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', abandoned_at) IS abandoned_at AND abandoned_at >= started_at
    )
  ),
  pruned_at TEXT CHECK (
    pruned_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', pruned_at) IS pruned_at AND pruned_at >= started_at
    )
  ),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (status = 'running'
      AND manifest_object_key IS NULL AND manifest_sha256 IS NULL
      AND failure_code IS NULL AND verified_at IS NULL AND abandoned_at IS NULL AND pruned_at IS NULL)
    OR (status = 'verified'
      AND lease_id IS NULL AND manifest_object_key IS NOT NULL AND manifest_sha256 IS NOT NULL
      AND failure_code IS NULL AND verified_at IS NOT NULL AND abandoned_at IS NULL AND pruned_at IS NULL)
    OR (status = 'failed'
      AND lease_id IS NULL AND manifest_object_key IS NULL AND manifest_sha256 IS NULL
      AND failure_code IS NOT NULL AND verified_at IS NULL AND abandoned_at IS NULL AND pruned_at IS NULL)
    OR (status = 'abandoned'
      AND lease_id IS NULL AND manifest_object_key IS NULL AND manifest_sha256 IS NULL
      AND failure_code IS NOT NULL AND verified_at IS NULL AND abandoned_at IS NOT NULL AND pruned_at IS NULL)
    OR (status = 'pruned'
      AND lease_id IS NULL AND manifest_object_key IS NOT NULL AND manifest_sha256 IS NOT NULL
      AND failure_code IS NULL AND verified_at IS NOT NULL AND abandoned_at IS NULL AND pruned_at IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX memory_backup_runs_status_date_idx
ON memory_backup_runs(status, run_date, started_at);

CREATE TABLE memory_backup_objects (
  run_id TEXT NOT NULL REFERENCES memory_backup_runs(run_id) ON DELETE RESTRICT,
  object_number INTEGER NOT NULL CHECK (object_number >= 0),
  table_name TEXT NOT NULL CHECK (table_name IN (
    'events',
    'memory_item_transitions',
    'memory_event_suppressions',
    'memory_event_suppression_lifts',
    'memory_topic_events',
    'memory_item_placement_events',
    'memory_cost_ledger'
  )),
  object_key TEXT NOT NULL UNIQUE CHECK (length(CAST(object_key AS BLOB)) BETWEEN 1 AND 1024),
  schema_version TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 128),
  row_count INTEGER NOT NULL CHECK (row_count > 0 AND row_count <= 32),
  byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 1048576),
  first_key TEXT NOT NULL CHECK (length(CAST(first_key AS BLOB)) BETWEEN 1 AND 128),
  last_key TEXT NOT NULL CHECK (length(CAST(last_key AS BLOB)) BETWEEN 1 AND 128),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  verified_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at),
  PRIMARY KEY (run_id, object_number),
  CHECK (first_key <= last_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_backup_alerts (
  local_date TEXT PRIMARY KEY CHECK (
    length(local_date) = 10
    AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND strftime('%Y-%m-%d', local_date) IS local_date
  ),
  run_id TEXT REFERENCES memory_backup_runs(run_id) ON DELETE RESTRICT,
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'memory_backup_binding_missing',
    'memory_backup_object_readback_failed',
    'memory_backup_manifest_readback_failed',
    'memory_backup_advertise_failed',
    'memory_backup_cleanup_failed',
    'memory_backup_operation_failed'
  )),
  claimed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER memory_backup_runs_insert_guard
BEFORE INSERT ON memory_backup_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_run_initial_state_invalid') WHERE
    NEW.status != 'running'
    OR NEW.current_table_index != 0
    OR NEW.cursor_key IS NOT NULL
    OR NEW.next_object_number != 0
    OR NEW.verified_object_count != 0
    OR NEW.lease_id IS NOT NULL
    OR NEW.lease_expires_at IS NOT NULL
    OR NEW.manifest_object_key IS NOT NULL
    OR NEW.manifest_sha256 IS NOT NULL
    OR NEW.failure_code IS NOT NULL
    OR NEW.verified_at IS NOT NULL
    OR NEW.abandoned_at IS NOT NULL
    OR NEW.pruned_at IS NOT NULL
    OR NEW.updated_at != NEW.started_at
    OR EXISTS (SELECT 1 FROM memory_backup_runs WHERE run_id = NEW.run_id OR run_date = NEW.run_date);
END;

CREATE TRIGGER memory_backup_runs_update_guard
BEFORE UPDATE ON memory_backup_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_run_transition_invalid') WHERE
    NEW.run_date != OLD.run_date
    OR NEW.run_id != OLD.run_id
    OR NEW.schema_version != OLD.schema_version
    OR NEW.marks_json != OLD.marks_json
    OR NEW.started_at != OLD.started_at
    OR NEW.updated_at < OLD.updated_at
    OR NOT (
      OLD.status = 'running' AND NEW.status = 'running' AND (
        OLD.lease_id IS NULL
          AND NEW.lease_id IS NOT NULL
          AND NEW.lease_expires_at > NEW.updated_at
          AND NEW.current_table_index = OLD.current_table_index
          AND NEW.cursor_key IS OLD.cursor_key
          AND NEW.next_object_number = OLD.next_object_number
          AND NEW.verified_object_count = OLD.verified_object_count
        OR OLD.lease_id IS NOT NULL
          AND OLD.lease_expires_at <= NEW.updated_at
          AND NEW.lease_id IS NOT NULL
          AND NEW.lease_id != OLD.lease_id
          AND NEW.lease_expires_at > NEW.updated_at
          AND NEW.current_table_index = OLD.current_table_index
          AND NEW.cursor_key IS OLD.cursor_key
          AND NEW.next_object_number = OLD.next_object_number
          AND NEW.verified_object_count = OLD.verified_object_count
        OR OLD.lease_id IS NOT NULL
          AND NEW.lease_id IS NULL
          AND (
            OLD.current_table_index < 7
              AND NEW.current_table_index = OLD.current_table_index
              AND NEW.cursor_key IS NOT NULL
              AND (OLD.cursor_key IS NULL OR NEW.cursor_key > OLD.cursor_key)
              AND NEW.next_object_number = OLD.next_object_number + 1
              AND NEW.verified_object_count = OLD.verified_object_count
              AND EXISTS (
                SELECT 1 FROM memory_backup_objects object
                WHERE object.run_id = OLD.run_id
                  AND object.object_number = OLD.next_object_number
                  AND object.last_key = NEW.cursor_key
              )
            OR OLD.current_table_index < 7
              AND NEW.current_table_index = OLD.current_table_index + 1
              AND NEW.cursor_key IS NULL
              AND NEW.next_object_number = OLD.next_object_number
              AND NEW.verified_object_count = OLD.verified_object_count
            OR OLD.current_table_index = 7
              AND NEW.current_table_index = 7
              AND NEW.cursor_key IS NULL
              AND NEW.next_object_number = OLD.next_object_number
              AND NEW.verified_object_count = OLD.verified_object_count + 1
              AND EXISTS (
                SELECT 1 FROM memory_backup_objects object
                WHERE object.run_id = OLD.run_id
                  AND object.object_number = OLD.verified_object_count
              )
          )
      )
      OR OLD.status = 'running' AND OLD.lease_id IS NOT NULL AND NEW.status = 'failed'
        AND NEW.lease_id IS NULL
        AND NEW.current_table_index = OLD.current_table_index
        AND NEW.cursor_key IS OLD.cursor_key
        AND NEW.next_object_number = OLD.next_object_number
        AND NEW.verified_object_count = OLD.verified_object_count
      OR OLD.status = 'running' AND OLD.lease_id IS NOT NULL AND NEW.status = 'verified'
        AND NEW.lease_id IS NULL
        AND OLD.current_table_index = 7
        AND NEW.current_table_index = 7
        AND NEW.cursor_key IS NULL
        AND NEW.next_object_number = OLD.next_object_number
        AND NEW.verified_object_count = NEW.next_object_number
      OR OLD.status = 'failed' AND NEW.status = 'abandoned'
        AND NEW.current_table_index = OLD.current_table_index
        AND NEW.cursor_key IS OLD.cursor_key
        AND NEW.next_object_number = OLD.next_object_number
        AND NEW.verified_object_count = OLD.verified_object_count
        AND NEW.failure_code = OLD.failure_code
      OR OLD.status = 'verified' AND NEW.status = 'pruned'
        AND NEW.current_table_index = OLD.current_table_index
        AND NEW.cursor_key IS OLD.cursor_key
        AND NEW.next_object_number = OLD.next_object_number
        AND NEW.verified_object_count = OLD.verified_object_count
        AND NEW.manifest_object_key = OLD.manifest_object_key
        AND NEW.manifest_sha256 = OLD.manifest_sha256
        AND NEW.verified_at = OLD.verified_at
    );
END;

CREATE TRIGGER memory_backup_runs_delete_guard
BEFORE DELETE ON memory_backup_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_run_delete_forbidden') WHERE 1 = 1;
END;

CREATE TRIGGER memory_backup_objects_insert_guard
BEFORE INSERT ON memory_backup_objects
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_object_insert_invalid') WHERE
    EXISTS (
      SELECT 1 FROM memory_backup_objects object
      WHERE object.run_id = NEW.run_id
        AND (object.object_number = NEW.object_number OR object.object_key = NEW.object_key)
    )
    OR NOT EXISTS (
      SELECT 1 FROM memory_backup_runs run
      WHERE run.run_id = NEW.run_id
        AND run.status = 'running'
        AND run.lease_id IS NOT NULL
        AND run.current_table_index < 7
        AND run.next_object_number = NEW.object_number
        AND run.schema_version = NEW.schema_version
        AND NEW.table_name = CASE run.current_table_index
          WHEN 0 THEN 'events'
          WHEN 1 THEN 'memory_item_transitions'
          WHEN 2 THEN 'memory_event_suppressions'
          WHEN 3 THEN 'memory_event_suppression_lifts'
          WHEN 4 THEN 'memory_topic_events'
          WHEN 5 THEN 'memory_item_placement_events'
          WHEN 6 THEN 'memory_cost_ledger'
        END
    );
END;

CREATE TRIGGER memory_backup_objects_update_guard
BEFORE UPDATE ON memory_backup_objects
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_object_update_forbidden') WHERE 1 = 1;
END;

CREATE TRIGGER memory_backup_objects_delete_guard
BEFORE DELETE ON memory_backup_objects
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_object_delete_forbidden') WHERE 1 = 1;
END;

CREATE TRIGGER memory_backup_alerts_insert_guard
BEFORE INSERT ON memory_backup_alerts
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_alert_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM memory_backup_alerts alert WHERE alert.local_date = NEW.local_date
  );
END;

CREATE TRIGGER memory_backup_alerts_update_guard
BEFORE UPDATE ON memory_backup_alerts
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_alert_update_forbidden') WHERE 1 = 1;
END;

CREATE TRIGGER memory_backup_alerts_delete_guard
BEFORE DELETE ON memory_backup_alerts
BEGIN
  SELECT RAISE(ABORT, 'memory_backup_alert_delete_forbidden') WHERE 1 = 1;
END;

-- Fair, resumable guest-grant notice draining.

CREATE TABLE guest_grant_notice_drain_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'failed')),
  cursor_created_at TEXT CHECK (
    cursor_created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cursor_created_at) IS cursor_created_at
  ),
  cursor_mutation_id TEXT,
  run_id TEXT,
  lease_expires_at TEXT CHECK (
    lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at
  ),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN ('notice_delivery_failed', 'drain_operation_failed', 'lease_expired')
  ),
  CHECK ((cursor_created_at IS NULL) = (cursor_mutation_id IS NULL)),
  CHECK (
    (status = 'ready' AND run_id IS NULL AND lease_expires_at IS NULL AND failure_code IS NULL)
    OR (status = 'running' AND run_id IS NOT NULL AND length(run_id) = 36
      AND lease_expires_at IS NOT NULL AND lease_expires_at > updated_at AND failure_code IS NULL)
    OR (status = 'failed' AND run_id IS NULL AND lease_expires_at IS NULL AND failure_code IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TRIGGER guest_grant_notice_drain_state_insert_guard
BEFORE INSERT ON guest_grant_notice_drain_state
WHEN EXISTS (
  SELECT 1 FROM guest_grant_notice_drain_state existing
  WHERE existing.singleton_id = NEW.singleton_id
) OR NEW.singleton_id <> 1
  OR NEW.status <> 'ready'
  OR NEW.cursor_created_at IS NOT NULL
  OR NEW.cursor_mutation_id IS NOT NULL
  OR NEW.run_id IS NOT NULL
  OR NEW.lease_expires_at IS NOT NULL
  OR NEW.updated_at <> '1970-01-01T00:00:00.000Z'
  OR NEW.failure_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'guest_grant_notice_drain_state_invalid');
END;

INSERT INTO guest_grant_notice_drain_state (
  singleton_id, status, cursor_created_at, cursor_mutation_id,
  run_id, lease_expires_at, updated_at, failure_code
) VALUES (1, 'ready', NULL, NULL, NULL, NULL, '1970-01-01T00:00:00.000Z', NULL);

CREATE TRIGGER guest_grant_notice_drain_state_transition_guard
BEFORE UPDATE ON guest_grant_notice_drain_state
WHEN NEW.singleton_id <> OLD.singleton_id
  OR NOT (
    OLD.status IN ('ready', 'failed')
      AND NEW.status = 'running'
      AND NEW.cursor_created_at IS OLD.cursor_created_at
      AND NEW.cursor_mutation_id IS OLD.cursor_mutation_id
      AND NEW.run_id IS NOT NULL AND length(NEW.run_id) = 36
      AND NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at > NEW.updated_at
      AND NEW.updated_at >= OLD.updated_at
      AND NEW.failure_code IS NULL
    OR OLD.status = 'running'
      AND NEW.status = 'running'
      AND NEW.run_id = OLD.run_id
      AND NEW.lease_expires_at = OLD.lease_expires_at
      AND NEW.updated_at >= OLD.updated_at
      AND NEW.failure_code IS NULL
      AND NEW.cursor_created_at IS NOT NULL
      AND NEW.cursor_mutation_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM guest_grant_notices notice
        WHERE notice.mutation_id = NEW.cursor_mutation_id
          AND notice.created_at = NEW.cursor_created_at
      )
    OR OLD.status = 'running'
      AND NEW.status IN ('ready', 'failed')
      AND NEW.cursor_created_at IS OLD.cursor_created_at
      AND NEW.cursor_mutation_id IS OLD.cursor_mutation_id
      AND NEW.run_id IS NULL
      AND NEW.lease_expires_at IS NULL
      AND NEW.updated_at >= OLD.updated_at
      AND (
        NEW.status = 'ready' AND NEW.failure_code IS NULL
        OR NEW.status = 'failed'
          AND NEW.failure_code IN ('notice_delivery_failed', 'drain_operation_failed')
      )
    OR OLD.status = 'running'
      AND OLD.lease_expires_at <= NEW.updated_at
      AND NEW.status = 'failed'
      AND NEW.cursor_created_at IS OLD.cursor_created_at
      AND NEW.cursor_mutation_id IS OLD.cursor_mutation_id
      AND NEW.run_id IS NULL
      AND NEW.lease_expires_at IS NULL
      AND NEW.failure_code = 'lease_expired'
  )
BEGIN
  SELECT RAISE(ABORT, 'guest_grant_notice_drain_state_transition_invalid');
END;

CREATE TRIGGER guest_grant_notice_drain_state_delete_forbidden
BEFORE DELETE ON guest_grant_notice_drain_state
BEGIN
  SELECT RAISE(ABORT, 'guest_grant_notice_drain_state_delete_forbidden');
END;

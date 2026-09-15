CREATE INDEX identity_challenges_expiry_idx ON identity_challenges(expires_at);
CREATE INDEX identity_challenges_device_expiry_idx ON identity_challenges(initiating_device_id, expires_at);

CREATE TRIGGER identity_challenges_reclaim_and_cap
BEFORE INSERT ON identity_challenges
BEGIN
  DELETE FROM identity_challenges
  WHERE initiating_device_id = NEW.initiating_device_id AND expires_at <= NEW.created_at;
  SELECT RAISE(ABORT, 'identity_challenge_capacity_exceeded') WHERE (
    SELECT COUNT(*) FROM identity_challenges
    WHERE initiating_device_id = NEW.initiating_device_id AND expires_at > NEW.created_at
  ) >= 8;
END;

CREATE INDEX sync_snapshots_expiry_idx ON sync_snapshots(expires_at);
CREATE INDEX sync_snapshots_device_expiry_idx ON sync_snapshots(device_id, expires_at);

CREATE TRIGGER sync_snapshots_reclaim_and_cap
BEFORE INSERT ON sync_snapshots
BEGIN
  DELETE FROM sync_snapshots
  WHERE device_id = NEW.device_id AND expires_at <= NEW.created_at;
  SELECT RAISE(ABORT, 'sync_snapshot_capacity_exceeded') WHERE (
    SELECT COUNT(*) FROM sync_snapshots
    WHERE device_id = NEW.device_id AND expires_at > NEW.created_at
  ) >= 64;
END;

CREATE INDEX request_nonces_device_expiry_idx ON request_nonces(device_id, expires_at);

CREATE TRIGGER request_nonces_reclaim_and_cap
BEFORE INSERT ON request_nonces
BEGIN
  DELETE FROM request_nonces
  WHERE device_id = NEW.device_id AND expires_at <= NEW.created_at;
  SELECT RAISE(ABORT, 'request_nonce_capacity_exceeded') WHERE (
    SELECT COUNT(*) FROM request_nonces
    WHERE device_id = NEW.device_id AND expires_at > NEW.created_at
  ) >= 1024;
END;

CREATE INDEX outbox_archive_reconcile_idx ON outbox(status, event_sequence);

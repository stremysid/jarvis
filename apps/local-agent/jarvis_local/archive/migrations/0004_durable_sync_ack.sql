ALTER TABLE pending_sync_ack ADD COLUMN snapshot_id TEXT;
ALTER TABLE pending_sync_ack ADD COLUMN expected_current INTEGER;
ALTER TABLE pending_sync_ack ADD COLUMN gateway_origin TEXT;
ALTER TABLE pending_sync_ack ADD COLUMN device_id TEXT;
ALTER TABLE pending_sync_ack ADD COLUMN principal_id TEXT;

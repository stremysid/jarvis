ALTER TABLE pending_sync_ack ADD COLUMN snapshot_id TEXT
    CHECK (snapshot_id IS NULL OR length(snapshot_id) BETWEEN 1 AND 256);
ALTER TABLE pending_sync_ack ADD COLUMN expected_current INTEGER
    CHECK (expected_current IS NULL OR (typeof(expected_current) = 'integer' AND expected_current >= 0));
ALTER TABLE pending_sync_ack ADD COLUMN gateway_origin TEXT
    CHECK (gateway_origin IS NULL OR length(gateway_origin) BETWEEN 1 AND 2048);
ALTER TABLE pending_sync_ack ADD COLUMN device_id TEXT
    CHECK (device_id IS NULL OR length(device_id) BETWEEN 1 AND 512);
ALTER TABLE pending_sync_ack ADD COLUMN principal_id TEXT
    CHECK (principal_id IS NULL OR length(principal_id) BETWEEN 1 AND 512);

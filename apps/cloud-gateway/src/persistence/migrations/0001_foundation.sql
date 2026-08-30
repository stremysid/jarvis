PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'service')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  display_name TEXT NOT NULL,
  pin_verifier_version TEXT,
  pin_verifier_secret_ref TEXT CHECK (pin_verifier_secret_ref IS NULL OR pin_verifier_secret_ref = 'PIN_VERIFIER_JSON'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((principal_type = 'human' AND pin_verifier_version IS NOT NULL AND pin_verifier_secret_ref = 'PIN_VERIFIER_JSON') OR principal_type = 'service')
);
CREATE UNIQUE INDEX principals_one_human_idx ON principals((1)) WHERE principal_type = 'human';

CREATE TABLE device_keys (
  device_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  key_id TEXT NOT NULL UNIQUE,
  public_key_base64 TEXT NOT NULL UNIQUE CHECK (length(public_key_base64) = 44),
  key_fingerprint TEXT NOT NULL UNIQUE CHECK (length(key_fingerprint) = 64 AND key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  algorithm TEXT NOT NULL CHECK (algorithm = 'ed25519'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  device_label TEXT NOT NULL,
  bootstrap_metadata_hash TEXT NOT NULL CHECK (length(bootstrap_metadata_hash) = 64 AND bootstrap_metadata_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (device_id, principal_id),
  UNIQUE (device_id, principal_id, key_id, key_fingerprint, key_generation),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX device_keys_principal_idx ON device_keys(principal_id, status);

CREATE TABLE channel_identities (
  identity_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice', 'local')),
  provider_subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  enrolled_by_device_id TEXT,
  CHECK ((status = 'active' AND verified_at IS NOT NULL) OR (status != 'active')),
  UNIQUE (channel, provider_subject),
  FOREIGN KEY (enrolled_by_device_id, principal_id) REFERENCES device_keys(device_id, principal_id) ON DELETE RESTRICT
);
CREATE INDEX channel_identities_principal_idx ON channel_identities(principal_id);

CREATE TABLE identity_challenges (
  challenge_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice')),
  initiating_device_id TEXT NOT NULL REFERENCES device_keys(device_id) ON DELETE RESTRICT,
  initiating_key_id TEXT NOT NULL,
  initiating_key_fingerprint TEXT NOT NULL CHECK (length(initiating_key_fingerprint) = 64 AND initiating_key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  initiating_key_generation INTEGER NOT NULL CHECK (initiating_key_generation > 0),
  response_hmac TEXT NOT NULL CHECK (length(response_hmac) = 64 AND response_hmac NOT GLOB '*[^0-9a-f]*'),
  hmac_key_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (initiating_device_id, principal_id) REFERENCES device_keys(device_id, principal_id) ON DELETE RESTRICT
);
CREATE INDEX identity_challenges_activation_idx ON identity_challenges(identity_id, channel, expires_at);

CREATE TRIGGER identity_challenges_activate_pending_identity
BEFORE UPDATE OF consumed_at ON identity_challenges
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
BEGIN
  UPDATE channel_identities
  SET status = 'active', verified_at = NEW.consumed_at
  WHERE identity_id = OLD.identity_id
    AND principal_id = OLD.principal_id
    AND channel = OLD.channel
    AND status = 'pending'
    AND verified_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM device_keys d
      JOIN principals p ON p.principal_id = d.principal_id
      WHERE d.device_id = OLD.initiating_device_id
        AND d.principal_id = OLD.principal_id
        AND d.key_id = OLD.initiating_key_id
        AND d.key_fingerprint = OLD.initiating_key_fingerprint
        AND d.key_generation = OLD.initiating_key_generation
        AND d.status = 'active'
        AND p.status = 'active'
    );
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'identity_challenge_state_changed') END;
END;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence > 0),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX events_subject_sequence_idx ON events(subject_id, sequence);
CREATE INDEX events_type_sequence_idx ON events(event_type, sequence);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  event_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  event_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence) ON DELETE RESTRICT,
  topic TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX outbox_dispatch_idx ON outbox(status, available_at, event_sequence);

CREATE TABLE consumer_cursors (
  consumer_name TEXT PRIMARY KEY,
  current_sequence INTEGER NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  consumer_name TEXT NOT NULL REFERENCES consumer_cursors(consumer_name) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES device_keys(device_id) ON DELETE RESTRICT,
  root_snapshot_id TEXT NOT NULL,
  input_token_hash TEXT CHECK (input_token_hash IS NULL OR (length(input_token_hash) = 64 AND input_token_hash NOT GLOB '*[^0-9a-f]*')),
  output_token_hash TEXT NOT NULL UNIQUE CHECK (length(output_token_hash) = 64 AND output_token_hash NOT GLOB '*[^0-9a-f]*'),
  material_hash TEXT NOT NULL CHECK (length(material_hash) = 64 AND material_hash NOT GLOB '*[^0-9a-f]*'),
  root_upper_sequence INTEGER NOT NULL CHECK (root_upper_sequence >= 0),
  from_sequence INTEGER NOT NULL CHECK (from_sequence >= 0),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= from_sequence),
  boundary_start_event_id TEXT,
  boundary_end_event_id TEXT,
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  CHECK (through_sequence <= root_upper_sequence),
  CHECK ((event_count = 0 AND from_sequence = through_sequence AND boundary_start_event_id IS NULL AND boundary_end_event_id IS NULL) OR (event_count > 0 AND boundary_start_event_id IS NOT NULL AND boundary_end_event_id IS NOT NULL))
);
CREATE UNIQUE INDEX sync_snapshots_input_token_idx ON sync_snapshots(input_token_hash) WHERE input_token_hash IS NOT NULL;
CREATE INDEX sync_snapshots_consumer_idx ON sync_snapshots(consumer_name, through_sequence);

CREATE TABLE sync_ack_receipts (
  receipt_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  principal_id TEXT,
  device_id TEXT,
  consumer_name TEXT NOT NULL,
  expected_current INTEGER NOT NULL CHECK (expected_current >= 0),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= expected_current),
  current_sequence INTEGER NOT NULL CHECK (current_sequence >= 0),
  acknowledged_at TEXT NOT NULL,
  receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('snapshot', 'legacy')),
  UNIQUE (snapshot_id, principal_id, device_id, consumer_name, expected_current, through_sequence)
);
CREATE INDEX sync_ack_receipts_consumer_idx ON sync_ack_receipts(consumer_name, current_sequence);

CREATE TRIGGER sync_ack_receipts_apply_snapshot
BEFORE INSERT ON sync_ack_receipts
WHEN NEW.receipt_kind = 'snapshot'
BEGIN
  UPDATE consumer_cursors
  SET current_sequence = NEW.current_sequence, updated_at = NEW.acknowledged_at
  WHERE consumer_name = NEW.consumer_name
    AND current_sequence = NEW.expected_current
    AND NEW.current_sequence = NEW.through_sequence
    AND NEW.through_sequence >= NEW.expected_current;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'sync_cursor_compare_failed') END;
  UPDATE sync_snapshots
  SET acknowledged_at = NEW.acknowledged_at
  WHERE snapshot_id = NEW.snapshot_id
    AND principal_id = NEW.principal_id
    AND device_id = NEW.device_id
    AND consumer_name = NEW.consumer_name
    AND from_sequence = NEW.expected_current
    AND through_sequence = NEW.through_sequence
    AND acknowledged_at IS NULL
    AND expires_at > NEW.acknowledged_at;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'sync_snapshot_state_changed') END;
END;

CREATE TABLE bootstrap_tokens (
  bootstrap_token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
  device_id TEXT REFERENCES device_keys(device_id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  issued_at TEXT NOT NULL,
  intended_channel TEXT CHECK (intended_channel IN ('telegram', 'voice', 'local')),
  device_label TEXT,
  issued_by TEXT NOT NULL
);
CREATE INDEX bootstrap_tokens_expiry_idx ON bootstrap_tokens(expires_at);

CREATE TABLE request_nonces (
  nonce_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device_keys(device_id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL CHECK (length(key_fingerprint) = 64 AND key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (device_id, nonce_hash),
  FOREIGN KEY (device_id, principal_id) REFERENCES device_keys(device_id, principal_id) ON DELETE RESTRICT
);
CREATE INDEX request_nonces_expiry_idx ON request_nonces(expires_at);

CREATE TABLE policy_decisions (
  decision_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  event_sequence INTEGER REFERENCES events(sequence) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'deny', 'challenge')),
  reason_code TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX policy_decisions_principal_idx ON policy_decisions(principal_id, decided_at);

CREATE TABLE archive_manifests (
  manifest_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  from_sequence INTEGER NOT NULL CHECK (from_sequence >= 0),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= from_sequence),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sealed', 'deleted')),
  created_at TEXT NOT NULL,
  sealed_at TEXT,
  UNIQUE (subject_id, from_sequence, through_sequence)
);

CREATE TABLE archive_segments (
  manifest_id TEXT NOT NULL REFERENCES archive_manifests(manifest_id) ON DELETE RESTRICT,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  object_key TEXT NOT NULL UNIQUE,
  first_sequence INTEGER NOT NULL CHECK (first_sequence > 0),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (manifest_id, segment_index)
);

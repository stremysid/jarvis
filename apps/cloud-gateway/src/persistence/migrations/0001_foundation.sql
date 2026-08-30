PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'service')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE channel_identities (
  identity_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice', 'local')),
  provider_subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel, provider_subject)
);
CREATE INDEX channel_identities_principal_idx ON channel_identities(principal_id);

CREATE TABLE identity_challenges (
  challenge_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice', 'local')),
  provider_subject TEXT NOT NULL,
  challenge_hash TEXT NOT NULL CHECK (length(challenge_hash) = 64 AND challenge_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel, provider_subject, challenge_hash)
);
CREATE INDEX identity_challenges_activation_idx ON identity_challenges(channel, provider_subject, expires_at);

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
  from_sequence INTEGER NOT NULL CHECK (from_sequence >= 0),
  through_sequence INTEGER NOT NULL CHECK (through_sequence > from_sequence),
  boundary_start_event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
  boundary_end_event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('issued', 'ack_receipt')),
  expires_at TEXT,
  acknowledged_at TEXT,
  CHECK ((snapshot_kind = 'issued' AND expires_at IS NOT NULL AND acknowledged_at IS NULL) OR (snapshot_kind = 'ack_receipt' AND expires_at IS NULL AND acknowledged_at IS NOT NULL))
);
CREATE INDEX sync_snapshots_consumer_idx ON sync_snapshots(consumer_name, snapshot_kind, through_sequence);

CREATE TABLE bootstrap_tokens (
  bootstrap_token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  principal_id TEXT REFERENCES principals(principal_id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  issued_at TEXT NOT NULL,
  intended_channel TEXT CHECK (intended_channel IN ('telegram', 'voice', 'local')),
  device_label TEXT,
  issued_by TEXT NOT NULL
);
CREATE INDEX bootstrap_tokens_expiry_idx ON bootstrap_tokens(expires_at);

CREATE TABLE device_keys (
  device_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  key_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('ed25519')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (principal_id, public_key)
);
CREATE INDEX device_keys_principal_idx ON device_keys(principal_id, status);

CREATE TABLE request_nonces (
  nonce_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device_keys(device_id) ON DELETE RESTRICT,
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (device_id, nonce_hash)
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

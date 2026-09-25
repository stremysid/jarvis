-- School credentials never share the general device registry or its nonces.
CREATE TABLE school_collector_keys (
  collector_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  public_key_base64 TEXT NOT NULL UNIQUE CHECK (length(public_key_base64) = 44),
  device_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  challenge TEXT NOT NULL,
  pairing_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  proved_at TEXT,
  decision_id TEXT REFERENCES decision_items(decision_id),
  activated_at TEXT,
  revoked_at TEXT,
  UNIQUE (collector_id, principal_id)
) WITHOUT ROWID;

CREATE TRIGGER school_collector_insert_guard
BEFORE INSERT ON school_collector_keys
WHEN NEW.status != 'pending' OR NEW.proved_at IS NOT NULL OR NEW.decision_id IS NOT NULL
  OR NEW.activated_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM school_collector_keys WHERE collector_id = NEW.collector_id OR public_key_base64 = NEW.public_key_base64)
  OR EXISTS (SELECT 1 FROM device_keys WHERE device_id = NEW.collector_id OR public_key_base64 = NEW.public_key_base64)
BEGIN
  SELECT RAISE(ABORT, 'school_collector_insert_refused');
END;

CREATE TRIGGER school_collector_key_immutable
BEFORE UPDATE ON school_collector_keys
WHEN NEW.collector_id != OLD.collector_id OR NEW.principal_id != OLD.principal_id
  OR NEW.public_key_base64 != OLD.public_key_base64 OR NEW.challenge != OLD.challenge
  OR NEW.pairing_code != OLD.pairing_code OR NEW.device_label != OLD.device_label
  OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
  OR (OLD.decision_id IS NOT NULL AND NEW.decision_id IS NOT OLD.decision_id)
  OR (OLD.proved_at IS NOT NULL AND NEW.proved_at IS NOT OLD.proved_at)
  OR (OLD.status = 'revoked' AND NEW.status != 'revoked')
  OR (OLD.status = 'active' AND NEW.status = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'school_collector_key_immutable');
END;

CREATE TRIGGER school_collector_activation_guard
BEFORE UPDATE OF status ON school_collector_keys
WHEN NEW.status = 'active' AND OLD.status != 'active' AND NOT EXISTS (
  SELECT 1 FROM decision_items d JOIN decision_responses r ON r.decision_id = d.decision_id
  JOIN channel_identities i ON i.identity_id = r.answered_by_identity_id
  WHERE d.decision_id = NEW.decision_id AND d.principal_id = NEW.principal_id
    AND d.origin = 'school-collector-pair' AND d.origin_reference = NEW.collector_id
    AND d.status = 'answered' AND r.option_key = 'confirm'
    AND NEW.proved_at IS NOT NULL AND NEW.activated_at < NEW.expires_at
    AND r.responded_at < NEW.expires_at AND i.principal_id = NEW.principal_id
    AND i.channel = 'telegram' AND i.status = 'active' AND i.verified_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'school_collector_tap_required');
END;

-- Also refuse ordinary device enrollment of an already school-bound public key.
CREATE TRIGGER school_collector_device_insert_guard
BEFORE INSERT ON device_keys
WHEN EXISTS (SELECT 1 FROM school_collector_keys WHERE collector_id = NEW.device_id OR public_key_base64 = NEW.public_key_base64)
BEGIN
  SELECT RAISE(ABORT, 'school_collector_scope_conflict');
END;
CREATE TRIGGER school_collector_device_update_guard
BEFORE UPDATE ON device_keys
WHEN EXISTS (SELECT 1 FROM school_collector_keys WHERE collector_id = NEW.device_id OR public_key_base64 = NEW.public_key_base64)
BEGIN
  SELECT RAISE(ABORT, 'school_collector_scope_conflict');
END;

CREATE TABLE school_collector_nonces (
  collector_id TEXT NOT NULL REFERENCES school_collector_keys(collector_id),
  nonce TEXT NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (collector_id, nonce)
) WITHOUT ROWID;

CREATE TABLE school_collector_reads (
  collector_id TEXT NOT NULL,
  read_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  course_ids_json TEXT NOT NULL,
  enrollment_complete INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (collector_id, read_id),
  FOREIGN KEY (collector_id, principal_id) REFERENCES school_collector_keys(collector_id, principal_id)
) WITHOUT ROWID;
CREATE TRIGGER school_collector_read_immutable
BEFORE UPDATE ON school_collector_reads
BEGIN
  SELECT RAISE(ABORT, 'school_collector_read_immutable');
END;

CREATE TABLE school_collector_batches (
  batch_id TEXT PRIMARY KEY,
  collector_id TEXT NOT NULL,
  read_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  course_name TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK (length(body_hash) = 64 AND body_hash NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'good', 'failed')),
  failures_json TEXT NOT NULL,
  mapped_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (collector_id, read_id, course_id),
  FOREIGN KEY (collector_id, read_id) REFERENCES school_collector_reads(collector_id, read_id)
) WITHOUT ROWID;

CREATE TABLE school_collector_evidence (
  evidence_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES school_collector_batches(batch_id),
  route TEXT NOT NULL,
  course TEXT NOT NULL,
  status INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  complete INTEGER NOT NULL,
  shape TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE (batch_id, route)
) WITHOUT ROWID;
CREATE TRIGGER school_collector_evidence_immutable
BEFORE UPDATE ON school_collector_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_collector_evidence_immutable');
END;
CREATE TRIGGER school_collector_evidence_retained
BEFORE DELETE ON school_collector_evidence
BEGIN
  SELECT RAISE(ABORT, 'school_collector_evidence_retained');
END;

-- DeadlineIngestion already protects revisions and disappearance. This adds
-- observation ordering for the two independently running school collectors.
CREATE TRIGGER school_collector_deadline_order
BEFORE UPDATE ON deadlines
WHEN NEW.source_id LIKE 'd2l-api:%' AND NEW.last_seen_at < OLD.last_seen_at
BEGIN
  SELECT RAISE(ABORT, 'school_collector_older_deadline');
END;

INSERT INTO capability_tiers (capability, tier, description, updated_at)
VALUES ('school.collector.revoke', 3, 'Revoke one school-only collector', '2026-09-23T00:00:00.000Z');

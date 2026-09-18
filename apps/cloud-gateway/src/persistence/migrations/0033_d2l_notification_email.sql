-- Durable receipts, quarantine evidence, and grade observations for school mail.
--
-- The recipient capability and pinned sender domains are runtime configuration.
-- They are deliberately absent from structured fields because the capability
-- must never enter a migration, log, or owner-facing message. The exact raw
-- MIME is retained as evidence and can contain provider-supplied address text.

CREATE TABLE d2l_email_messages (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  email_id TEXT NOT NULL CHECK (
    length(email_id) = 26
    AND substr(email_id, 1, 1) GLOB '[0-7]'
    AND email_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  ingestion_key TEXT NOT NULL CHECK (length(ingestion_key) BETWEEN 1 AND 320),
  raw_sha256 TEXT NOT NULL CHECK (
    length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider_message_id TEXT CHECK (
    provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 998
  ),
  header_names_json TEXT NOT NULL CHECK (
    json_valid(header_names_json) AND length(header_names_json) BETWEEN 2 AND 16384
  ),
  authentication_json TEXT NOT NULL CHECK (
    json_valid(authentication_json) AND length(authentication_json) BETWEEN 2 AND 65536
  ),
  envelope_from_domain TEXT CHECK (
    envelope_from_domain IS NULL OR length(envelope_from_domain) BETWEEN 1 AND 253
  ),
  from_domain TEXT CHECK (from_domain IS NULL OR length(from_domain) BETWEEN 1 AND 253),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'assignment_due', 'assignment_updated', 'feedback_released', 'grade_released',
    'new_content', 'announcement', 'address_verification', 'unrecognised'
  )),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ingested', 'quarantined')),
  quarantine_reason TEXT CHECK (
    quarantine_reason IS NULL OR length(quarantine_reason) BETWEEN 1 AND 160
  ),
  structured_json TEXT NOT NULL CHECK (
    json_valid(structured_json) AND length(structured_json) BETWEEN 2 AND 32768
  ),
  raw_mime_base64 TEXT NOT NULL CHECK (length(raw_mime_base64) BETWEEN 0 AND 700000),
  received_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at
  ),
  processed_at TEXT CHECK (
    processed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', processed_at) IS processed_at
  ),
  verification_notified_at TEXT CHECK (
    verification_notified_at IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', verification_notified_at) IS verification_notified_at
  ),
  PRIMARY KEY (principal_id, email_id),
  UNIQUE (principal_id, ingestion_key),
  UNIQUE (principal_id, raw_sha256),
  CHECK (
    (status = 'pending' AND processed_at IS NULL AND quarantine_reason IS NULL)
    OR (status = 'ingested' AND processed_at IS NOT NULL AND quarantine_reason IS NULL)
    OR (status = 'quarantined' AND processed_at IS NOT NULL AND quarantine_reason IS NOT NULL)
  ),
  CHECK (
    verification_notified_at IS NULL
    OR (status = 'ingested' AND event_kind = 'address_verification')
  ),
  CHECK (processed_at IS NULL OR processed_at >= received_at),
  CHECK (verification_notified_at IS NULL OR verification_notified_at >= processed_at)
) WITHOUT ROWID;

CREATE INDEX d2l_email_messages_status_idx
ON d2l_email_messages(principal_id, status, received_at, email_id);

CREATE TABLE d2l_email_grade_observations (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  observation_id TEXT NOT NULL CHECK (
    length(observation_id) = 26
    AND substr(observation_id, 1, 1) GLOB '[0-7]'
    AND observation_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  email_id TEXT NOT NULL,
  deadline_id TEXT REFERENCES deadlines(deadline_id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  course TEXT NOT NULL CHECK (length(course) BETWEEN 1 AND 512),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  assigned_grade REAL NOT NULL CHECK (
    typeof(assigned_grade) IN ('integer', 'real')
    AND assigned_grade >= 0
    AND assigned_grade <= 1000000000
  ),
  max_points REAL CHECK (
    max_points IS NULL OR (
      typeof(max_points) IN ('integer', 'real')
      AND max_points > 0
      AND max_points <= 1000000000
    )
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at
  ),
  PRIMARY KEY (principal_id, observation_id),
  UNIQUE (principal_id, external_id, content_hash),
  FOREIGN KEY (principal_id, email_id)
    REFERENCES d2l_email_messages(principal_id, email_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX d2l_email_grade_observations_current_idx
ON d2l_email_grade_observations(principal_id, external_id, observed_at, observation_id);

CREATE TABLE d2l_email_failure_state (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id) ON DELETE RESTRICT,
  consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures BETWEEN 0 AND 1000000),
  last_failure_email_id TEXT,
  notice_claim_email_id TEXT,
  notice_sent_at TEXT CHECK (
    notice_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', notice_sent_at) IS notice_sent_at
  ),
  last_success_at TEXT CHECK (
    last_success_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) IS last_success_at
  ),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (principal_id, last_failure_email_id)
    REFERENCES d2l_email_messages(principal_id, email_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, notice_claim_email_id)
    REFERENCES d2l_email_messages(principal_id, email_id) ON DELETE RESTRICT,
  CHECK ((consecutive_failures = 0) = (last_failure_email_id IS NULL)),
  CHECK (notice_sent_at IS NULL OR notice_claim_email_id IS NOT NULL)
) WITHOUT ROWID;

CREATE TRIGGER d2l_email_messages_insert_guard
BEFORE INSERT ON d2l_email_messages
WHEN EXISTS (
  SELECT 1 FROM d2l_email_messages
  WHERE principal_id = NEW.principal_id
    AND (
      email_id = NEW.email_id
      OR ingestion_key = NEW.ingestion_key
      OR raw_sha256 = NEW.raw_sha256
    )
)
BEGIN
  SELECT RAISE(ABORT, 'd2l_email_message_insert_conflict');
END;

CREATE TRIGGER d2l_email_messages_update_guard
BEFORE UPDATE ON d2l_email_messages
WHEN NOT (
  NEW.principal_id IS OLD.principal_id
  AND NEW.email_id IS OLD.email_id
  AND NEW.ingestion_key IS OLD.ingestion_key
  AND NEW.raw_sha256 IS OLD.raw_sha256
  AND NEW.provider_message_id IS OLD.provider_message_id
  AND NEW.header_names_json IS OLD.header_names_json
  AND NEW.authentication_json IS OLD.authentication_json
  AND NEW.envelope_from_domain IS OLD.envelope_from_domain
  AND NEW.from_domain IS OLD.from_domain
  AND NEW.event_kind IS OLD.event_kind
  AND NEW.structured_json IS OLD.structured_json
  AND NEW.raw_mime_base64 IS OLD.raw_mime_base64
  AND NEW.received_at IS OLD.received_at
  AND (
    (
      OLD.status = 'pending'
      AND NEW.status IN ('ingested', 'quarantined')
      AND OLD.processed_at IS NULL
      AND NEW.processed_at IS NOT NULL
      AND OLD.quarantine_reason IS NULL
      AND OLD.verification_notified_at IS NULL
      AND NEW.verification_notified_at IS NULL
    )
    OR (
      OLD.status = 'ingested'
      AND NEW.status = OLD.status
      AND NEW.processed_at IS OLD.processed_at
      AND NEW.quarantine_reason IS OLD.quarantine_reason
      AND OLD.event_kind = 'address_verification'
      AND OLD.verification_notified_at IS NULL
      AND NEW.verification_notified_at IS NOT NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'd2l_email_message_update_invalid');
END;

CREATE TRIGGER d2l_email_messages_delete_guard
BEFORE DELETE ON d2l_email_messages
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'd2l_email_message_delete_forbidden');
END;

CREATE TRIGGER d2l_email_grade_observations_insert_guard
BEFORE INSERT ON d2l_email_grade_observations
WHEN (
  NOT EXISTS (
    SELECT 1 FROM d2l_email_messages
    WHERE principal_id = NEW.principal_id
      AND email_id = NEW.email_id
      AND event_kind = 'grade_released'
      AND status = 'pending'
  )
  OR EXISTS (
    SELECT 1 FROM d2l_email_grade_observations
    WHERE principal_id = NEW.principal_id
      AND (
        observation_id = NEW.observation_id
        OR (external_id = NEW.external_id AND content_hash = NEW.content_hash)
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'd2l_email_grade_observation_insert_invalid');
END;

CREATE TRIGGER d2l_email_grade_observations_update_guard
BEFORE UPDATE ON d2l_email_grade_observations
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'd2l_email_grade_observation_update_forbidden');
END;

CREATE TRIGGER d2l_email_grade_observations_delete_guard
BEFORE DELETE ON d2l_email_grade_observations
WHEN 1 = 1
BEGIN
  SELECT RAISE(ABORT, 'd2l_email_grade_observation_delete_forbidden');
END;

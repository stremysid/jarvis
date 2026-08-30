CREATE TABLE outbound_call_attempts (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES policy_decisions(decision_id) ON DELETE RESTRICT,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal IN (0, 1)),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  destination_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  command_idempotency_key TEXT NOT NULL,
  relay_nonce TEXT NOT NULL UNIQUE,
  nonce_expires_at TEXT NOT NULL,
  provider_dispatch_state TEXT NOT NULL DEFAULT 'ready'
    CHECK (provider_dispatch_state IN ('ready', 'claimed', 'dispatched', 'rejected', 'provider_dispatch_unknown')),
  provider_dispatch_claimed_at TEXT,
  provider_dispatch_resolved_at TEXT,
  provider_failure_code TEXT CHECK (
    provider_failure_code IS NULL
    OR provider_failure_code IN ('provider_transient_failure', 'provider_authentication_failure', 'provider_permanent_failure')
  ),
  provider_failure_category TEXT CHECK (
    provider_failure_category IS NULL
    OR provider_failure_category IN ('rate_limited', 'authentication', 'invalid_request', 'permanent_failure')
  ),
  provider_call_sid TEXT UNIQUE,
  relay_call_sid TEXT UNIQUE,
  relay_claimed_at TEXT,
  retry_eligible INTEGER NOT NULL DEFAULT 0 CHECK (retry_eligible IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (command_id, attempt_ordinal),
  CHECK (length(command_id) = 26),
  CHECK (length(attempt_id) = 26),
  CHECK (length(CAST(relay_nonce AS BLOB)) = 43),
  CHECK (
    provider_call_sid IS NULL
    OR (
      length(provider_call_sid) = 34
      AND substr(provider_call_sid, 1, 2) = 'CA'
      AND substr(provider_call_sid, 3) NOT GLOB '*[^0-9A-Fa-f]*'
    )
  ),
  CHECK (
    relay_call_sid IS NULL
    OR (
      length(relay_call_sid) = 34
      AND substr(relay_call_sid, 1, 2) = 'CA'
      AND substr(relay_call_sid, 3) NOT GLOB '*[^0-9A-Fa-f]*'
    )
  ),
  CHECK (
    retry_eligible = CASE
      WHEN attempt_ordinal = 0
        AND provider_dispatch_state = 'rejected'
        AND provider_failure_code = 'provider_transient_failure'
        AND provider_failure_category = 'rate_limited'
      THEN 1
      ELSE 0
    END
  ),
  CHECK (
    (
      provider_dispatch_state IN ('ready', 'claimed', 'dispatched', 'provider_dispatch_unknown')
      AND provider_failure_code IS NULL
      AND provider_failure_category IS NULL
    )
    OR (
      provider_dispatch_state = 'rejected'
      AND provider_failure_code IS NOT NULL
      AND provider_failure_category IS NOT NULL
    )
  ),
  CHECK (
    (
      provider_dispatch_state = 'ready'
      AND provider_dispatch_claimed_at IS NULL
      AND provider_dispatch_resolved_at IS NULL
    )
    OR (
      provider_dispatch_state = 'claimed'
      AND provider_dispatch_claimed_at IS NOT NULL
      AND provider_dispatch_resolved_at IS NULL
    )
    OR (
      provider_dispatch_state IN ('dispatched', 'rejected', 'provider_dispatch_unknown')
      AND provider_dispatch_claimed_at IS NOT NULL
      AND provider_dispatch_resolved_at IS NOT NULL
    )
  )
);

CREATE INDEX outbound_call_attempts_command_idx
  ON outbound_call_attempts(command_id, attempt_ordinal);

CREATE TABLE provider_events (
  dedupe_key TEXT NOT NULL PRIMARY KEY
    CHECK (length(dedupe_key) = 64 AND dedupe_key NOT GLOB '*[^0-9a-f]*'),
  endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('status', 'relay_ended')),
  event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) = 26),
  attempt_id TEXT REFERENCES outbound_call_attempts(attempt_id) ON DELETE RESTRICT
    CHECK (attempt_id IS NULL OR length(attempt_id) = 26),
  call_sid TEXT NOT NULL
    CHECK (
      length(call_sid) = 34
      AND substr(call_sid, 1, 2) = 'CA'
      AND substr(call_sid, 3) NOT GLOB '*[^0-9A-Fa-f]*'
    ),
  callback_source TEXT,
  sequence_number INTEGER CHECK (sequence_number IS NULL OR sequence_number >= 0),
  session_id TEXT CHECK (
    session_id IS NULL
    OR (
      length(session_id) = 34
      AND substr(session_id, 1, 2) = 'VX'
      AND substr(session_id, 3) NOT GLOB '*[^0-9A-Fa-f]*'
    )
  ),
  received_at TEXT NOT NULL,
  CHECK (
    (
      endpoint_kind = 'status'
      AND attempt_id IS NOT NULL
      AND callback_source IS 'call-progress-events'
      AND sequence_number IS NOT NULL
      AND session_id IS NULL
    )
    OR (
      endpoint_kind = 'relay_ended'
      AND attempt_id IS NULL
      AND callback_source IS NULL
      AND sequence_number IS NULL
      AND session_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX provider_events_status_dedupe_idx
  ON provider_events(endpoint_kind, attempt_id, call_sid, callback_source, sequence_number)
  WHERE endpoint_kind = 'status';

CREATE UNIQUE INDEX provider_events_relay_dedupe_idx
  ON provider_events(endpoint_kind, call_sid, session_id)
  WHERE endpoint_kind = 'relay_ended';

CREATE TRIGGER provider_events_status_require_compatible_attempt
BEFORE INSERT ON provider_events
WHEN NEW.endpoint_kind = 'status' AND NOT EXISTS (
  SELECT 1
  FROM outbound_call_attempts a
  WHERE a.attempt_id = NEW.attempt_id
    AND a.provider_dispatch_state IN ('claimed', 'dispatched', 'provider_dispatch_unknown')
    AND (a.provider_call_sid IS NULL OR a.provider_call_sid = NEW.call_sid)
    AND (a.relay_call_sid IS NULL OR a.relay_call_sid = NEW.call_sid)
)
BEGIN
  SELECT RAISE(ABORT, 'provider_status_attempt_mismatch');
END;

CREATE TRIGGER provider_events_status_reconcile_attempt
AFTER INSERT ON provider_events
WHEN NEW.endpoint_kind = 'status'
BEGIN
  UPDATE outbound_call_attempts
  SET provider_dispatch_state = 'dispatched',
      provider_call_sid = COALESCE(provider_call_sid, NEW.call_sid),
      provider_dispatch_resolved_at = NEW.received_at
  WHERE attempt_id = NEW.attempt_id
    AND provider_dispatch_state IN ('claimed', 'provider_dispatch_unknown');
END;

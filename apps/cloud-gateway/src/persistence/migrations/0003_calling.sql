CREATE TABLE outbound_call_attempts (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES policy_decisions(decision_id) ON DELETE RESTRICT,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal IN (0, 1)),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  destination_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  command_idempotency_key TEXT NOT NULL,
  relay_nonce TEXT NOT NULL UNIQUE,
  nonce_expires_at TEXT NOT NULL,
  authorization_expires_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authorization_expires_at) IS authorization_expires_at),
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
    (
      provider_dispatch_state = 'dispatched'
      AND provider_call_sid IS NOT NULL
    )
    OR (
      provider_dispatch_state <> 'dispatched'
      AND provider_call_sid IS NULL
      AND relay_call_sid IS NULL
    )
  ),
  CHECK (
    (relay_call_sid IS NULL AND relay_claimed_at IS NULL)
    OR (relay_call_sid IS NOT NULL AND relay_claimed_at IS NOT NULL)
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

CREATE TRIGGER outbound_call_attempts_immutable_lineage
BEFORE UPDATE ON outbound_call_attempts
WHEN OLD.attempt_id IS NOT NEW.attempt_id
  OR OLD.command_id IS NOT NEW.command_id
  OR OLD.attempt_ordinal IS NOT NEW.attempt_ordinal
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.destination_identity_id IS NOT NEW.destination_identity_id
  OR OLD.command_idempotency_key IS NOT NEW.command_idempotency_key
  OR OLD.relay_nonce IS NOT NEW.relay_nonce
  OR OLD.nonce_expires_at IS NOT NEW.nonce_expires_at
  OR OLD.authorization_expires_at IS NOT NEW.authorization_expires_at
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'outbound_attempt_immutable');
END;

CREATE TRIGGER outbound_call_attempts_state_machine
BEFORE UPDATE ON outbound_call_attempts
WHEN NOT (
    OLD.provider_dispatch_state IS NEW.provider_dispatch_state
    OR (OLD.provider_dispatch_state = 'ready' AND NEW.provider_dispatch_state = 'claimed')
    OR (
      OLD.provider_dispatch_state = 'claimed'
      AND NEW.provider_dispatch_state IN ('dispatched', 'rejected', 'provider_dispatch_unknown')
    )
    OR (
      OLD.provider_dispatch_state = 'provider_dispatch_unknown'
      AND NEW.provider_dispatch_state IN ('dispatched', 'rejected')
    )
  )
  OR (OLD.provider_call_sid IS NOT NULL AND OLD.provider_call_sid IS NOT NEW.provider_call_sid)
  OR (OLD.relay_call_sid IS NOT NULL AND OLD.relay_call_sid IS NOT NEW.relay_call_sid)
  OR (
    OLD.provider_dispatch_claimed_at IS NOT NULL
    AND OLD.provider_dispatch_claimed_at IS NOT NEW.provider_dispatch_claimed_at
  )
  OR (
    OLD.relay_claimed_at IS NOT NULL
    AND OLD.relay_claimed_at IS NOT NEW.relay_claimed_at
  )
  OR (
    OLD.provider_dispatch_resolved_at IS NOT NULL
    AND OLD.provider_dispatch_resolved_at IS NOT NEW.provider_dispatch_resolved_at
    AND NOT (
      OLD.provider_dispatch_state = 'provider_dispatch_unknown'
      AND NEW.provider_dispatch_state IN ('dispatched', 'rejected')
    )
  )
  OR (
    (
      OLD.provider_failure_code IS NOT NEW.provider_failure_code
      OR OLD.provider_failure_category IS NOT NEW.provider_failure_category
      OR OLD.retry_eligible IS NOT NEW.retry_eligible
    )
    AND NOT (
      OLD.provider_dispatch_state IN ('claimed', 'provider_dispatch_unknown')
      AND NEW.provider_dispatch_state = 'rejected'
      AND OLD.provider_failure_code IS NULL
      AND OLD.provider_failure_category IS NULL
      AND OLD.retry_eligible = 0
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'outbound_attempt_state_transition_invalid');
END;

CREATE TRIGGER outbound_call_attempts_reject_delete
BEFORE DELETE ON outbound_call_attempts
BEGIN
  SELECT RAISE(ABORT, 'outbound_attempt_delete_forbidden');
END;

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

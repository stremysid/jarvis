-- R1 runtime control state. Additive, independent of memory projection 0014.
-- Sending an owner alert precedes its acknowledged receipt. An abandoned
-- lease can retry after expiry, possibly duplicating an unacknowledged send.
CREATE TABLE capacity_alert_crossings (
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  alert_key TEXT NOT NULL CHECK (length(alert_key) BETWEEN 1 AND 96),
  claim_id TEXT NOT NULL CHECK (
    length(claim_id) = 26 AND substr(claim_id, 1, 1) BETWEEN '0' AND '7'
    AND claim_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent')),
  claimed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at),
  lease_expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at
    AND lease_expires_at > claimed_at
  ),
  sent_at TEXT CHECK (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) IS sent_at),
  PRIMARY KEY (owner_principal_id, alert_key),
  CHECK ((state = 'sending' AND sent_at IS NULL)
    OR (state = 'sent' AND sent_at IS NOT NULL AND sent_at >= claimed_at))
) STRICT;

-- Owner-operated controls start disabled. Quiet bounds are UTC instants,
-- not an inferred local schedule or an automatically renewed authorization.
CREATE TABLE outbound_runtime_controls (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  quiet_starts_at TEXT,
  quiet_ends_at TEXT,
  CHECK ((quiet_starts_at IS NULL AND quiet_ends_at IS NULL) OR (
    quiet_starts_at IS NOT NULL AND quiet_ends_at IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', quiet_starts_at) IS quiet_starts_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', quiet_ends_at) IS quiet_ends_at
    AND quiet_starts_at < quiet_ends_at
  ))
) STRICT;
INSERT INTO outbound_runtime_controls (singleton_id, enabled) VALUES (1, 0);

-- Retain affirmative completion after the event envelope is archived. A
-- missing envelope refuses relay admission but must never release dial capacity.
ALTER TABLE outbound_call_attempts ADD COLUMN provider_terminal_at TEXT;
UPDATE outbound_call_attempts SET provider_terminal_at = (
  SELECT MIN(callback.received_at) FROM provider_events callback
  JOIN events event ON event.event_id = callback.event_id
  WHERE callback.endpoint_kind = 'status' AND callback.attempt_id = outbound_call_attempts.attempt_id
    AND callback.call_sid = outbound_call_attempts.provider_call_sid
    AND json_extract(event.envelope_json, '$.payload.callStatus') IN ('completed', 'busy', 'failed', 'no-answer', 'canceled')
);

CREATE TRIGGER outbound_attempts_terminal_evidence
BEFORE UPDATE OF provider_terminal_at ON outbound_call_attempts
WHEN OLD.provider_terminal_at IS NOT NEW.provider_terminal_at AND (
  OLD.provider_terminal_at IS NOT NULL OR NEW.provider_terminal_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM provider_events callback JOIN events event ON event.event_id = callback.event_id
    WHERE callback.endpoint_kind = 'status' AND callback.attempt_id = NEW.attempt_id
      AND (NEW.provider_call_sid IS NULL OR callback.call_sid = NEW.provider_call_sid)
      AND callback.received_at = NEW.provider_terminal_at
      AND json_extract(event.envelope_json, '$.payload.callStatus') IN ('completed', 'busy', 'failed', 'no-answer', 'canceled')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'outbound_terminal_evidence_required');
END;

CREATE TRIGGER outbound_status_retains_terminal_evidence
AFTER INSERT ON provider_events
WHEN NEW.endpoint_kind = 'status' AND EXISTS (
  SELECT 1 FROM events event WHERE event.event_id = NEW.event_id
    AND json_extract(event.envelope_json, '$.payload.callStatus') IN ('completed', 'busy', 'failed', 'no-answer', 'canceled')
)
BEGIN
  UPDATE outbound_call_attempts SET provider_terminal_at = NEW.received_at
    WHERE attempt_id = NEW.attempt_id AND provider_terminal_at IS NULL;
END;

-- EventRepository appends the receipt before the envelope in one transaction.
-- Cover either arrival order without treating an absent envelope as terminal.
CREATE TRIGGER outbound_event_retains_terminal_evidence
AFTER INSERT ON events
WHEN json_extract(NEW.envelope_json, '$.payload.callStatus') IN ('completed', 'busy', 'failed', 'no-answer', 'canceled')
BEGIN
  UPDATE outbound_call_attempts SET provider_terminal_at = (
    SELECT callback.received_at FROM provider_events callback
      WHERE callback.event_id = NEW.event_id AND callback.endpoint_kind = 'status'
        AND callback.attempt_id = outbound_call_attempts.attempt_id
  ) WHERE provider_terminal_at IS NULL AND EXISTS (
    SELECT 1 FROM provider_events callback WHERE callback.event_id = NEW.event_id
      AND callback.endpoint_kind = 'status' AND callback.attempt_id = outbound_call_attempts.attempt_id
  );
END;

CREATE TRIGGER outbound_attempts_start_ready
BEFORE INSERT ON outbound_call_attempts
WHEN NEW.provider_dispatch_state <> 'ready' OR NEW.provider_terminal_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'outbound_attempt_initial_state_invalid');
END;

-- D1 serializes this transition. Earlier policy reads are explanatory checks,
-- not a reservation, and cannot enforce these limits across racing requests.
CREATE TRIGGER outbound_attempts_admission
BEFORE UPDATE OF provider_dispatch_state ON outbound_call_attempts
WHEN OLD.provider_dispatch_state = 'ready' AND NEW.provider_dispatch_state = 'claimed'
BEGIN
  SELECT RAISE(ABORT, 'outbound_admission_disabled')
    WHERE NOT EXISTS (SELECT 1 FROM outbound_runtime_controls WHERE singleton_id = 1 AND enabled = 1);
  SELECT RAISE(ABORT, 'outbound_admission_destination') WHERE NOT EXISTS (
    SELECT 1 FROM voice_owner_identity owner
    JOIN principals actor ON actor.principal_id = owner.principal_id
    JOIN channel_identities owner_identity ON owner_identity.identity_id = owner.identity_id
      AND owner_identity.principal_id = owner.principal_id
    JOIN channel_identities destination ON destination.identity_id = NEW.destination_identity_id
    JOIN principals recipient ON recipient.principal_id = destination.principal_id
    WHERE owner.principal_id = NEW.principal_id AND actor.principal_type = 'human' AND actor.status = 'active'
      AND owner_identity.channel = 'voice' AND owner_identity.status = 'active' AND owner_identity.verified_at IS NOT NULL
      AND recipient.principal_type = 'human' AND recipient.status = 'active' AND destination.channel = 'voice'
      AND ((destination.identity_id = owner.identity_id AND destination.principal_id = owner.principal_id
        AND destination.status = 'active' AND destination.verified_at IS NOT NULL)
        OR (destination.status IN ('pending', 'active') AND EXISTS (
          SELECT 1 FROM voice_access_grants grant_row WHERE grant_row.identity_id = destination.identity_id
            AND grant_row.principal_id = destination.principal_id AND grant_row.status IN ('pending', 'active')
        )))
  );
  SELECT RAISE(ABORT, 'outbound_admission_quiet') WHERE EXISTS (
    SELECT 1 FROM outbound_runtime_controls WHERE singleton_id = 1
      AND quiet_starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND quiet_ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
  SELECT RAISE(ABORT, 'outbound_admission_expired')
    WHERE NEW.authorization_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  SELECT RAISE(ABORT, 'outbound_admission_nonce_expired')
    WHERE NEW.nonce_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  SELECT RAISE(ABORT, 'outbound_admission_clock_invalid') WHERE NEW.provider_dispatch_claimed_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.provider_dispatch_claimed_at) IS NOT NEW.provider_dispatch_claimed_at
      OR substr(NEW.provider_dispatch_claimed_at, 1, 10) <> strftime('%Y-%m-%d', 'now');
  SELECT RAISE(ABORT, 'outbound_admission_concurrency') WHERE (
    SELECT count(*) FROM outbound_call_attempts attempt
      WHERE attempt.principal_id = NEW.principal_id
        AND attempt.provider_dispatch_state IN ('claimed', 'dispatched', 'provider_dispatch_unknown')
        AND attempt.provider_terminal_at IS NULL
  ) >= 2;
  SELECT RAISE(ABORT, 'outbound_admission_daily') WHERE (
    SELECT count(*) FROM outbound_call_attempts attempt
      WHERE attempt.principal_id = NEW.principal_id AND attempt.provider_dispatch_claimed_at IS NOT NULL
        AND substr(attempt.provider_dispatch_claimed_at, 1, 10) = strftime('%Y-%m-%d', 'now')
  ) >= 6;
END;

CREATE INDEX outbound_attempts_policy_day ON outbound_call_attempts(principal_id, provider_dispatch_claimed_at);

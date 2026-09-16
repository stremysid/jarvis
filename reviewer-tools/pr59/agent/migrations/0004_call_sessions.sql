CREATE TABLE call_sessions (
  session_id TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(session_id) = 26
      AND substr(session_id, 1, 1) BETWEEN '0' AND '7'
      AND session_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    ),
  call_sid TEXT NOT NULL UNIQUE
    CHECK (
      length(call_sid) = 34
      AND substr(call_sid, 1, 2) = 'CA'
      AND substr(call_sid, 3) NOT GLOB '*[^0-9A-Fa-f]*'
    ),
  expected_attempt_id TEXT UNIQUE REFERENCES outbound_call_attempts(attempt_id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  destination_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  activation_only INTEGER NOT NULL CHECK (activation_only IN (0, 1)),
  activation_challenge_id TEXT,
  activation_hmac_key_version TEXT,
  relay_nonce TEXT NOT NULL UNIQUE
    CHECK (
      length(CAST(relay_nonce AS BLOB)) = 43
      AND relay_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
      AND substr(relay_nonce, 43, 1) GLOB '[AEIMQUYcgkosw048]'
    ),
  nonce_expires_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', nonce_expires_at) IS nonce_expires_at),
  relay_setup_expires_at TEXT
    CHECK (
      relay_setup_expires_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', relay_setup_expires_at) IS relay_setup_expires_at
    ),
  provider_session_id TEXT UNIQUE
    CHECK (
      provider_session_id IS NULL
      OR (
        length(provider_session_id) = 34
        AND substr(provider_session_id, 1, 2) = 'VX'
        AND substr(provider_session_id, 3) NOT GLOB '*[^0-9A-Fa-f]*'
      )
    ),
  phase TEXT NOT NULL
    CHECK (phase IN ('created', 'connecting', 'pre_auth', 'authenticated', 'active', 'ending', 'completed', 'rejected', 'failed', 'expired')),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (
      direction = 'inbound'
      AND expected_attempt_id IS NULL
      AND destination_identity_id = identity_id
      AND relay_setup_expires_at IS NOT NULL
      AND nonce_expires_at = relay_setup_expires_at
      AND relay_setup_expires_at > created_at
      AND relay_setup_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+300 seconds')
      AND (
        (activation_only = 0 AND activation_challenge_id IS NULL AND activation_hmac_key_version IS NULL)
        OR
        (activation_only = 1 AND activation_challenge_id IS NOT NULL AND activation_hmac_key_version IS NOT NULL)
      )
    )
    OR
    (
      direction = 'outbound'
      AND expected_attempt_id IS NOT NULL
      AND session_id = expected_attempt_id
      AND activation_only = 0
      AND activation_challenge_id IS NULL
      AND activation_hmac_key_version IS NULL
      AND relay_setup_expires_at IS NULL
    )
  )
);

CREATE INDEX call_sessions_active_principal_idx
  ON call_sessions(principal_id, direction, phase, created_at);

CREATE TRIGGER call_sessions_require_initial_state
BEFORE INSERT ON call_sessions
WHEN NEW.provider_session_id IS NOT NULL
  OR NEW.phase <> 'created'
  OR NEW.updated_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'call_session_initial_state_invalid');
END;

CREATE TRIGGER call_sessions_require_inbound_lineage
BEFORE INSERT ON call_sessions
WHEN NEW.direction = 'inbound' AND NOT (
  (
    NEW.activation_only = 0
    AND EXISTS (
      SELECT 1
      FROM principals p
      JOIN channel_identities i ON i.principal_id = p.principal_id
      WHERE p.principal_id = NEW.principal_id
        AND p.principal_type = 'human'
        AND p.status = 'active'
        AND i.identity_id = NEW.identity_id
        AND i.channel = 'voice'
        AND i.status = 'active'
        AND i.verified_at IS NOT NULL
    )
  )
  OR
  (
    NEW.activation_only = 1
    AND EXISTS (
      SELECT 1
      FROM principals p
      JOIN channel_identities i ON i.principal_id = p.principal_id
      JOIN identity_challenges c
        ON c.principal_id = p.principal_id
        AND c.identity_id = i.identity_id
      JOIN device_keys d
        ON d.device_id = c.initiating_device_id
        AND d.principal_id = c.principal_id
      WHERE p.principal_id = NEW.principal_id
        AND p.principal_type = 'human'
        AND p.status = 'active'
        AND i.identity_id = NEW.identity_id
        AND i.channel = 'voice'
        AND i.status = 'pending'
        AND i.verified_at IS NULL
        AND c.challenge_id = NEW.activation_challenge_id
        AND c.channel = 'voice'
        AND c.consumed_at IS NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', c.expires_at) IS c.expires_at
        AND strftime('%Y-%m-%dT%H:%M:%fZ', c.created_at) IS c.created_at
        AND c.created_at <= NEW.created_at
        AND c.expires_at > NEW.created_at
        AND c.hmac_key_version = NEW.activation_hmac_key_version
        AND d.key_id = c.initiating_key_id
        AND d.key_fingerprint = c.initiating_key_fingerprint
        AND d.key_generation = c.initiating_key_generation
        AND d.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM identity_challenges newer
          JOIN device_keys newer_device
            ON newer_device.device_id = newer.initiating_device_id
            AND newer_device.principal_id = newer.principal_id
          WHERE newer.principal_id = c.principal_id
            AND newer.identity_id = c.identity_id
            AND newer.channel = 'voice'
            AND newer.consumed_at IS NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', newer.expires_at) IS newer.expires_at
            AND strftime('%Y-%m-%dT%H:%M:%fZ', newer.created_at) IS newer.created_at
            AND newer.created_at <= NEW.created_at
            AND newer.expires_at > NEW.created_at
            AND newer.hmac_key_version = NEW.activation_hmac_key_version
            AND newer_device.key_id = newer.initiating_key_id
            AND newer_device.key_fingerprint = newer.initiating_key_fingerprint
            AND newer_device.key_generation = newer.initiating_key_generation
            AND newer_device.status = 'active'
            AND (
              newer.created_at > c.created_at
              OR (newer.created_at = c.created_at AND newer.challenge_id > c.challenge_id)
            )
        )
        AND NEW.relay_setup_expires_at = CASE
          WHEN c.expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+300 seconds')
          THEN c.expires_at
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+300 seconds')
        END
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'inbound_session_lineage_mismatch');
END;

CREATE TRIGGER call_sessions_require_matching_outbound_attempt
BEFORE INSERT ON call_sessions
WHEN NEW.direction = 'outbound' AND NOT EXISTS (
  SELECT 1
  FROM outbound_call_attempts a
  JOIN principals p ON p.principal_id = a.principal_id
  JOIN channel_identities i ON i.identity_id = a.destination_identity_id
  WHERE a.attempt_id = NEW.expected_attempt_id
    AND a.attempt_id = NEW.session_id
    AND a.relay_call_sid = NEW.call_sid
    AND a.principal_id = NEW.principal_id
    AND a.destination_identity_id = NEW.identity_id
    AND a.destination_identity_id = NEW.destination_identity_id
    AND a.relay_nonce = NEW.relay_nonce
    AND a.nonce_expires_at = NEW.nonce_expires_at
    AND a.provider_dispatch_state = 'dispatched'
    AND p.principal_type = 'human'
    AND p.status = 'active'
    AND i.principal_id = p.principal_id
    AND i.channel = 'voice'
    AND i.status = 'active'
    AND i.verified_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'outbound_session_attempt_mismatch');
END;

CREATE TRIGGER call_sessions_immutable_lineage
BEFORE UPDATE ON call_sessions
WHEN OLD.session_id IS NOT NEW.session_id
  OR OLD.call_sid IS NOT NEW.call_sid
  OR OLD.expected_attempt_id IS NOT NEW.expected_attempt_id
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.identity_id IS NOT NEW.identity_id
  OR OLD.destination_identity_id IS NOT NEW.destination_identity_id
  OR OLD.direction IS NOT NEW.direction
  OR OLD.activation_only IS NOT NEW.activation_only
  OR OLD.activation_challenge_id IS NOT NEW.activation_challenge_id
  OR OLD.activation_hmac_key_version IS NOT NEW.activation_hmac_key_version
  OR OLD.relay_nonce IS NOT NEW.relay_nonce
  OR OLD.nonce_expires_at IS NOT NEW.nonce_expires_at
  OR OLD.relay_setup_expires_at IS NOT NEW.relay_setup_expires_at
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'call_session_immutable');
END;

CREATE TRIGGER call_sessions_provider_binding_once
BEFORE UPDATE OF provider_session_id ON call_sessions
WHEN NOT (
  OLD.provider_session_id IS NEW.provider_session_id
  OR (OLD.provider_session_id IS NULL AND NEW.provider_session_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_provider_binding_invalid');
END;

CREATE TRIGGER call_sessions_provider_binding_eligible
BEFORE UPDATE OF provider_session_id ON call_sessions
WHEN OLD.provider_session_id IS NULL
  AND NEW.provider_session_id IS NOT NULL
  AND NOT (
    NEW.phase NOT IN ('completed', 'rejected', 'failed', 'expired')
    AND (
      (
        NEW.direction = 'outbound'
        AND NEW.nonce_expires_at > NEW.updated_at
        AND EXISTS (
          SELECT 1
          FROM principals p
          JOIN channel_identities i ON i.principal_id = p.principal_id
          WHERE p.principal_id = NEW.principal_id
            AND p.principal_type = 'human'
            AND p.status = 'active'
            AND i.identity_id = NEW.identity_id
            AND i.channel = 'voice'
            AND i.status = 'active'
            AND i.verified_at IS NOT NULL
        )
      )
      OR
      (
        NEW.direction = 'inbound'
        AND NEW.relay_setup_expires_at > NEW.updated_at
        AND (
          (
            NEW.activation_only = 0
            AND EXISTS (
              SELECT 1
              FROM principals p
              JOIN channel_identities i ON i.principal_id = p.principal_id
              WHERE p.principal_id = NEW.principal_id
                AND p.principal_type = 'human'
                AND p.status = 'active'
                AND i.identity_id = NEW.identity_id
                AND i.channel = 'voice'
                AND i.status = 'active'
                AND i.verified_at IS NOT NULL
            )
          )
          OR
          (
            NEW.activation_only = 1
            AND EXISTS (
              SELECT 1
              FROM principals p
              JOIN channel_identities i ON i.principal_id = p.principal_id
              JOIN identity_challenges c
                ON c.challenge_id = NEW.activation_challenge_id
                AND c.principal_id = p.principal_id
                AND c.identity_id = i.identity_id
              JOIN device_keys d
                ON d.device_id = c.initiating_device_id
                AND d.principal_id = c.principal_id
              WHERE p.principal_id = NEW.principal_id
                AND p.principal_type = 'human'
                AND p.status = 'active'
                AND i.identity_id = NEW.identity_id
                AND i.channel = 'voice'
                AND i.status = 'pending'
                AND i.verified_at IS NULL
                AND c.channel = 'voice'
                AND c.consumed_at IS NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', c.expires_at) IS c.expires_at
                AND strftime('%Y-%m-%dT%H:%M:%fZ', c.created_at) IS c.created_at
                AND c.created_at <= NEW.updated_at
                AND c.expires_at > NEW.updated_at
                AND c.hmac_key_version = NEW.activation_hmac_key_version
                AND d.key_id = c.initiating_key_id
                AND d.key_fingerprint = c.initiating_key_fingerprint
                AND d.key_generation = c.initiating_key_generation
                AND d.status = 'active'
            )
          )
        )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'call_session_provider_binding_ineligible');
END;

CREATE TRIGGER call_sessions_phase_transition
BEFORE UPDATE OF phase ON call_sessions
WHEN NOT (
  OLD.phase IS NEW.phase
  OR (OLD.phase = 'created' AND NEW.phase IN ('connecting', 'rejected', 'failed', 'expired'))
  OR (OLD.phase = 'connecting' AND NEW.phase IN ('pre_auth', 'rejected', 'failed', 'expired'))
  OR (OLD.phase = 'pre_auth' AND NEW.phase IN ('authenticated', 'rejected', 'failed', 'expired'))
  OR (OLD.phase = 'authenticated' AND NEW.phase IN ('active', 'ending', 'failed', 'expired'))
  OR (OLD.phase = 'active' AND NEW.phase IN ('ending', 'failed', 'expired'))
  OR (OLD.phase = 'ending' AND NEW.phase IN ('completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_phase_transition_invalid');
END;

CREATE TRIGGER call_sessions_updated_at_monotone
BEFORE UPDATE ON call_sessions
WHEN NEW.updated_at < OLD.updated_at
  OR (OLD.phase IS NOT NEW.phase AND NEW.updated_at < OLD.updated_at)
BEGIN
  SELECT RAISE(ABORT, 'call_session_time_regression');
END;

CREATE TRIGGER call_sessions_reject_delete
BEFORE DELETE ON call_sessions
BEGIN
  SELECT RAISE(ABORT, 'call_session_delete_forbidden');
END;

CREATE TRIGGER channel_identities_call_session_subject_immutable
BEFORE UPDATE OF provider_subject ON channel_identities
WHEN OLD.provider_subject IS NOT NEW.provider_subject
  AND EXISTS (
    SELECT 1 FROM call_sessions s
    WHERE s.identity_id = OLD.identity_id
      OR s.destination_identity_id = OLD.identity_id
  )
BEGIN
  SELECT RAISE(ABORT, 'call_session_identity_subject_immutable');
END;

CREATE TRIGGER identity_challenges_task4_canonical_timestamps_insert
BEFORE INSERT ON identity_challenges
WHEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at) IS NOT NEW.expires_at
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) IS NOT NEW.created_at
  OR NEW.expires_at <= NEW.created_at
  OR (
    NEW.consumed_at IS NOT NULL
    AND (
      strftime('%Y-%m-%dT%H:%M:%fZ', NEW.consumed_at) IS NOT NEW.consumed_at
      OR NEW.consumed_at < NEW.created_at
      OR NEW.consumed_at >= NEW.expires_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_challenge_timestamp_invalid');
END;

CREATE TRIGGER identity_challenges_task4_canonical_timestamps_update
BEFORE UPDATE OF expires_at, consumed_at, created_at ON identity_challenges
WHEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at) IS NOT NEW.expires_at
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) IS NOT NEW.created_at
  OR NEW.expires_at <= NEW.created_at
  OR (
    NEW.consumed_at IS NOT NULL
    AND (
      strftime('%Y-%m-%dT%H:%M:%fZ', NEW.consumed_at) IS NOT NEW.consumed_at
      OR NEW.consumed_at < NEW.created_at
      OR NEW.consumed_at >= NEW.expires_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_challenge_timestamp_invalid');
END;

CREATE TRIGGER identity_challenges_call_session_id_no_reuse
BEFORE INSERT ON identity_challenges
WHEN EXISTS (
  SELECT 1 FROM call_sessions s
  WHERE s.activation_challenge_id = NEW.challenge_id
)
BEGIN
  SELECT RAISE(ABORT, 'identity_challenge_id_reuse');
END;

CREATE TRIGGER identity_challenges_task4_id_immutable
BEFORE UPDATE OF challenge_id ON identity_challenges
WHEN OLD.challenge_id IS NOT NEW.challenge_id
BEGIN
  SELECT RAISE(ABORT, 'identity_challenge_id_immutable');
END;

CREATE TRIGGER identity_challenges_call_session_lineage_immutable
BEFORE UPDATE ON identity_challenges
WHEN EXISTS (
    SELECT 1 FROM call_sessions s
    WHERE s.activation_challenge_id = OLD.challenge_id
  )
  AND (
    OLD.challenge_id IS NOT NEW.challenge_id
    OR OLD.principal_id IS NOT NEW.principal_id
    OR OLD.identity_id IS NOT NEW.identity_id
    OR OLD.channel IS NOT NEW.channel
    OR OLD.initiating_device_id IS NOT NEW.initiating_device_id
    OR OLD.initiating_key_id IS NOT NEW.initiating_key_id
    OR OLD.initiating_key_fingerprint IS NOT NEW.initiating_key_fingerprint
    OR OLD.initiating_key_generation IS NOT NEW.initiating_key_generation
    OR OLD.response_hmac IS NOT NEW.response_hmac
    OR OLD.hmac_key_version IS NOT NEW.hmac_key_version
    OR OLD.expires_at IS NOT NEW.expires_at
    OR OLD.created_at IS NOT NEW.created_at
    OR NOT (
      OLD.consumed_at IS NEW.consumed_at
      OR (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'identity_challenge_call_session_immutable');
END;

CREATE TABLE authentication_attempt_reservations (
  reservation_id TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(reservation_id) = 26
      AND substr(reservation_id, 1, 1) BETWEEN '0' AND '7'
      AND reservation_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    ),
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('pin', 'activation')),
  call_sid_bucket_hash TEXT NOT NULL
    CHECK (length(call_sid_bucket_hash) = 64 AND call_sid_bucket_hash NOT GLOB '*[^0-9a-f]*'),
  composite_bucket_hash TEXT NOT NULL
    CHECK (length(composite_bucket_hash) = 64 AND composite_bucket_hash NOT GLOB '*[^0-9a-f]*'),
  global_bucket_hash TEXT NOT NULL
    CHECK (length(global_bucket_hash) = 64 AND global_bucket_hash NOT GLOB '*[^0-9a-f]*'),
  challenge_bucket_hash TEXT
    CHECK (
      challenge_bucket_hash IS NULL
      OR (length(challenge_bucket_hash) = 64 AND challenge_bucket_hash NOT GLOB '*[^0-9a-f]*')
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+300 seconds')),
  CHECK (
    (attempt_kind = 'pin' AND challenge_bucket_hash IS NULL)
    OR (attempt_kind = 'activation' AND challenge_bucket_hash IS NOT NULL)
  )
);

CREATE INDEX authentication_attempt_reservations_call_idx
  ON authentication_attempt_reservations(call_sid_bucket_hash, expires_at);
CREATE INDEX authentication_attempt_reservations_composite_idx
  ON authentication_attempt_reservations(composite_bucket_hash, expires_at);
CREATE INDEX authentication_attempt_reservations_global_idx
  ON authentication_attempt_reservations(global_bucket_hash, expires_at);
CREATE INDEX authentication_attempt_reservations_challenge_idx
  ON authentication_attempt_reservations(challenge_bucket_hash, expires_at)
  WHERE challenge_bucket_hash IS NOT NULL;

CREATE TRIGGER authentication_attempt_reservations_append_only
BEFORE UPDATE ON authentication_attempt_reservations
BEGIN
  SELECT RAISE(ABORT, 'authentication_reservation_immutable');
END;

CREATE TRIGGER authentication_attempt_reservations_reject_delete
BEFORE DELETE ON authentication_attempt_reservations
BEGIN
  SELECT RAISE(ABORT, 'authentication_reservation_delete_forbidden');
END;

CREATE TRIGGER provider_events_relay_require_bound_session
BEFORE INSERT ON provider_events
WHEN NEW.endpoint_kind = 'relay_ended' AND NOT EXISTS (
  SELECT 1
  FROM call_sessions s
  WHERE s.call_sid = NEW.call_sid
    AND s.provider_session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'provider_relay_session_mismatch');
END;

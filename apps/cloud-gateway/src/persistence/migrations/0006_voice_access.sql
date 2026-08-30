PRAGMA defer_foreign_keys = ON;

DROP INDEX principals_one_human_idx;

CREATE TABLE principals_new (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'service')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at)
);

INSERT INTO principals_new (principal_id, principal_type, status, display_name, created_at, updated_at)
SELECT principal_id, principal_type, status, display_name, created_at, updated_at
FROM principals;

DROP TRIGGER identity_challenges_activate_pending_identity;
DROP TRIGGER call_sessions_require_inbound_lineage;
DROP TRIGGER call_sessions_require_matching_outbound_attempt;
DROP TRIGGER call_sessions_provider_binding_eligible;
DROP TRIGGER conversation_turns_insert_guard;
DROP TRIGGER conversation_deliveries_target_guard;
DROP TRIGGER conversation_deliveries_claim_target_guard;

DROP TABLE principals;
ALTER TABLE principals_new RENAME TO principals;

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

CREATE TRIGGER conversation_turns_insert_guard
BEFORE INSERT ON conversation_turns
WHEN NOT EXISTS (
  SELECT 1
  FROM principals p
  JOIN events e ON e.event_id = NEW.user_event_id
  WHERE p.principal_id = NEW.principal_id
    AND p.status = 'active'
    AND e.event_type = 'conversation.user_committed'
    AND e.subject_id = NEW.principal_id
    AND json_extract(e.envelope_json, '$.correlationId') = NEW.turn_id
    AND json_extract(e.envelope_json, '$.source') = 'conversation'
    AND json_extract(e.envelope_json, '$.producerVersion') = 'conversation-v1'
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_turn_insert_invalid');
END;

CREATE TRIGGER conversation_deliveries_target_guard
BEFORE INSERT ON conversation_deliveries
WHEN NOT EXISTS (
  SELECT 1 FROM channel_identities i
  JOIN principals p ON p.principal_id = i.principal_id
  WHERE i.identity_id = NEW.target_identity_id
    AND i.principal_id = NEW.principal_id
    AND i.channel = 'telegram'
    AND i.status = 'active'
    AND i.verified_at IS NOT NULL
    AND p.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_target_invalid');
END;

CREATE TRIGGER conversation_deliveries_claim_target_guard
BEFORE UPDATE OF state ON conversation_deliveries
WHEN NEW.state = 'claimed' AND OLD.state IN ('pending', 'retry_wait') AND NOT EXISTS (
  SELECT 1 FROM channel_identities i
  JOIN principals p ON p.principal_id = i.principal_id
  WHERE i.identity_id = OLD.target_identity_id
    AND i.principal_id = OLD.principal_id
    AND i.channel = 'telegram'
    AND i.status = 'active'
    AND i.verified_at IS NOT NULL
    AND p.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_target_invalid');
END;

CREATE TABLE voice_owner_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL UNIQUE REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
);

CREATE TABLE voice_access_grants (
  grant_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  capability_ids_json TEXT NOT NULL CHECK (json_valid(capability_ids_json) AND json_type(capability_ids_json) = 'array'),
  resource_scopes_json TEXT NOT NULL CHECK (json_valid(resource_scopes_json) AND json_type(resource_scopes_json) = 'object'),
  access_document_hash TEXT NOT NULL CHECK (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*'),
  pin_schema_version TEXT NOT NULL CHECK (pin_schema_version = '2.0'),
  pin_algorithm TEXT NOT NULL CHECK (pin_algorithm = 'hmac-sha256-pepper+pbkdf2-hmac-sha256'),
  pin_pepper_version TEXT NOT NULL CHECK (pin_pepper_version = 'v1'),
  pin_iterations INTEGER NOT NULL CHECK (pin_iterations = 600000),
  pin_salt_base64 TEXT NOT NULL CHECK (length(pin_salt_base64) = 24),
  pin_digest_base64 TEXT NOT NULL CHECK (length(pin_digest_base64) = 44),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  created_by_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  activated_at TEXT CHECK (activated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) IS activated_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  revoked_at TEXT CHECK (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX voice_access_grants_one_live_identity
  ON voice_access_grants(identity_id) WHERE status IN ('pending', 'active');

CREATE TABLE voice_access_grant_events (
  event_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES voice_access_grants(grant_id) ON DELETE RESTRICT,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'activated', 'permissions_replaced', 'pin_rotated', 'revoked')),
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  capability_ids_json TEXT NOT NULL CHECK (json_valid(capability_ids_json) AND json_type(capability_ids_json) = 'array'),
  access_document_hash TEXT NOT NULL CHECK (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
);

CREATE INDEX voice_access_grant_events_grant_version_idx
  ON voice_access_grant_events(grant_id, grant_version, created_at);

ALTER TABLE call_sessions ADD COLUMN access_kind TEXT CHECK (access_kind IN ('owner', 'guest'));
ALTER TABLE call_sessions ADD COLUMN guest_grant_id TEXT REFERENCES voice_access_grants(grant_id) ON DELETE RESTRICT;
ALTER TABLE call_sessions ADD COLUMN guest_grant_version INTEGER CHECK (guest_grant_version IS NULL OR guest_grant_version > 0);
ALTER TABLE call_sessions ADD COLUMN access_document_hash TEXT CHECK (access_document_hash IS NULL OR (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*'));

CREATE TABLE call_session_authorities (
  session_id TEXT PRIMARY KEY REFERENCES call_sessions(session_id) ON DELETE RESTRICT,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('owner', 'guest')),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  grant_id TEXT REFERENCES voice_access_grants(grant_id) ON DELETE RESTRICT,
  grant_version INTEGER CHECK (grant_version IS NULL OR grant_version > 0),
  access_document_hash TEXT CHECK (access_document_hash IS NULL OR (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*')),
  authenticated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authenticated_at) IS authenticated_at),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  CHECK (expires_at > authenticated_at AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', authenticated_at, '+1800 seconds')),
  CHECK ((authority_kind = 'owner' AND grant_id IS NULL AND grant_version IS NULL AND access_document_hash IS NULL)
    OR (authority_kind = 'guest' AND grant_id IS NOT NULL AND grant_version IS NOT NULL AND access_document_hash IS NOT NULL))
);

CREATE TRIGGER voice_owner_identity_requires_voice_human
BEFORE INSERT ON voice_owner_identity
WHEN NOT EXISTS (
  SELECT 1
  FROM principals p
  JOIN channel_identities i ON i.principal_id = p.principal_id
  WHERE p.principal_id = NEW.principal_id
    AND p.principal_type = 'human'
    AND p.status = 'active'
    AND i.identity_id = NEW.identity_id
    AND i.channel = 'voice'
    AND i.status IN ('pending', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'voice_owner_identity_requires_voice_human');
END;

CREATE TRIGGER voice_owner_identity_immutable
BEFORE UPDATE ON voice_owner_identity
BEGIN
  SELECT RAISE(ABORT, 'voice_owner_identity_immutable');
END;

CREATE TRIGGER voice_owner_identity_delete_forbidden
BEFORE DELETE ON voice_owner_identity
BEGIN
  SELECT RAISE(ABORT, 'voice_owner_identity_delete_forbidden');
END;

CREATE TRIGGER voice_access_grants_require_guest_identity
BEFORE INSERT ON voice_access_grants
WHEN NOT EXISTS (
  SELECT 1
  FROM principals p
  JOIN channel_identities i ON i.principal_id = p.principal_id
  JOIN voice_owner_identity owner ON owner.identity_id = NEW.created_by_identity_id
  WHERE p.principal_id = NEW.principal_id
    AND p.principal_type = 'human'
    AND p.status = 'active'
    AND i.identity_id = NEW.identity_id
    AND i.channel = 'voice'
    AND i.status IN ('pending', 'active')
    AND i.identity_id <> owner.identity_id
    AND p.principal_id <> owner.principal_id
)
BEGIN
  SELECT RAISE(ABORT, 'voice_access_grant_requires_guest_identity');
END;

CREATE TRIGGER voice_access_grants_immutable_lineage
BEFORE UPDATE ON voice_access_grants
WHEN OLD.grant_id IS NOT NEW.grant_id
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.identity_id IS NOT NEW.identity_id
  OR OLD.pin_schema_version IS NOT NEW.pin_schema_version
  OR OLD.pin_algorithm IS NOT NEW.pin_algorithm
  OR OLD.pin_pepper_version IS NOT NEW.pin_pepper_version
  OR OLD.pin_iterations IS NOT NEW.pin_iterations
  OR OLD.created_by_identity_id IS NOT NEW.created_by_identity_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'voice_access_grant_immutable_lineage');
END;

CREATE TRIGGER voice_access_grants_version_invalid
BEFORE UPDATE ON voice_access_grants
WHEN OLD.grant_id IS NEW.grant_id
  AND OLD.principal_id IS NEW.principal_id
  AND OLD.identity_id IS NEW.identity_id
  AND OLD.pin_schema_version IS NEW.pin_schema_version
  AND OLD.pin_algorithm IS NEW.pin_algorithm
  AND OLD.pin_pepper_version IS NEW.pin_pepper_version
  AND OLD.pin_iterations IS NEW.pin_iterations
  AND OLD.created_by_identity_id IS NEW.created_by_identity_id
  AND OLD.created_at IS NEW.created_at
  AND NOT (
  (OLD.status = 'pending' AND NEW.status = 'active' AND NEW.grant_version = OLD.grant_version)
  OR NEW.grant_version = OLD.grant_version + 1
)
BEGIN
  SELECT RAISE(ABORT, 'voice_access_grant_version_invalid');
END;

CREATE TRIGGER voice_access_grants_status_invalid
BEFORE UPDATE ON voice_access_grants
WHEN (
  (OLD.status = 'pending' AND NEW.status = 'active' AND NEW.grant_version = OLD.grant_version)
  OR NEW.grant_version = OLD.grant_version + 1
)
AND NOT (
  (
    OLD.status = 'pending'
    AND NEW.status = 'active'
    AND NEW.grant_version = OLD.grant_version
    AND OLD.capability_ids_json IS NEW.capability_ids_json
    AND OLD.resource_scopes_json IS NEW.resource_scopes_json
    AND OLD.access_document_hash IS NEW.access_document_hash
    AND OLD.pin_salt_base64 IS NEW.pin_salt_base64
    AND OLD.pin_digest_base64 IS NEW.pin_digest_base64
    AND OLD.activated_at IS NULL
    AND NEW.activated_at IS NOT NULL
    AND NEW.revoked_at IS NULL
  )
  OR
  (
    OLD.status IN ('pending', 'active')
    AND NEW.status = OLD.status
    AND NEW.grant_version = OLD.grant_version + 1
    AND OLD.pin_salt_base64 IS NEW.pin_salt_base64
    AND OLD.pin_digest_base64 IS NEW.pin_digest_base64
    AND OLD.activated_at IS NEW.activated_at
    AND OLD.revoked_at IS NEW.revoked_at
    AND (
      OLD.capability_ids_json IS NOT NEW.capability_ids_json
      OR OLD.resource_scopes_json IS NOT NEW.resource_scopes_json
      OR OLD.access_document_hash IS NOT NEW.access_document_hash
    )
  )
  OR
  (
    OLD.status IN ('pending', 'active')
    AND NEW.status = OLD.status
    AND NEW.grant_version = OLD.grant_version + 1
    AND OLD.capability_ids_json IS NEW.capability_ids_json
    AND OLD.resource_scopes_json IS NEW.resource_scopes_json
    AND OLD.access_document_hash IS NEW.access_document_hash
    AND OLD.activated_at IS NEW.activated_at
    AND OLD.revoked_at IS NEW.revoked_at
    AND OLD.pin_salt_base64 IS NOT NEW.pin_salt_base64
    AND OLD.pin_digest_base64 IS NOT NEW.pin_digest_base64
  )
  OR
  (
    OLD.status IN ('pending', 'active')
    AND NEW.status = 'revoked'
    AND NEW.grant_version = OLD.grant_version + 1
    AND OLD.capability_ids_json IS NEW.capability_ids_json
    AND OLD.resource_scopes_json IS NEW.resource_scopes_json
    AND OLD.access_document_hash IS NEW.access_document_hash
    AND OLD.pin_salt_base64 IS NEW.pin_salt_base64
    AND OLD.pin_digest_base64 IS NEW.pin_digest_base64
    AND OLD.activated_at IS NEW.activated_at
    AND OLD.revoked_at IS NULL
    AND NEW.revoked_at IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'voice_access_grant_status_invalid');
END;

CREATE TRIGGER voice_access_grants_delete_forbidden
BEFORE DELETE ON voice_access_grants
BEGIN
  SELECT RAISE(ABORT, 'voice_access_grant_delete_forbidden');
END;

CREATE TRIGGER voice_access_grant_events_immutable
BEFORE UPDATE ON voice_access_grant_events
BEGIN
  SELECT RAISE(ABORT, 'voice_access_grant_event_immutable');
END;

CREATE TRIGGER voice_access_grant_events_delete_forbidden
BEFORE DELETE ON voice_access_grant_events
BEGIN
  SELECT RAISE(ABORT, 'voice_access_grant_event_delete_forbidden');
END;

CREATE TRIGGER call_sessions_voice_access_required
BEFORE INSERT ON call_sessions
WHEN NEW.access_kind IS NULL OR NOT (
  (
    NEW.access_kind = 'owner'
    AND NEW.guest_grant_id IS NULL
    AND NEW.guest_grant_version IS NULL
    AND NEW.access_document_hash IS NULL
    AND EXISTS (
      SELECT 1
      FROM voice_owner_identity owner
      JOIN channel_identities i ON i.identity_id = owner.identity_id
      WHERE owner.principal_id = NEW.principal_id
        AND owner.identity_id = NEW.identity_id
        AND NEW.destination_identity_id = NEW.identity_id
        AND i.principal_id = owner.principal_id
        AND i.channel = 'voice'
        AND i.status IN ('pending', 'active')
    )
  )
  OR
  (
    NEW.access_kind = 'guest'
    AND NEW.activation_only = 0
    AND NEW.activation_challenge_id IS NULL
    AND NEW.activation_hmac_key_version IS NULL
    AND EXISTS (
      SELECT 1
      FROM voice_access_grants grant_row
      JOIN channel_identities i ON i.identity_id = grant_row.identity_id
      WHERE grant_row.grant_id = NEW.guest_grant_id
        AND grant_row.grant_version = NEW.guest_grant_version
        AND grant_row.access_document_hash = NEW.access_document_hash
        AND grant_row.principal_id = NEW.principal_id
        AND grant_row.identity_id = NEW.identity_id
        AND NEW.destination_identity_id = NEW.identity_id
        AND grant_row.status IN ('pending', 'active')
        AND i.principal_id = grant_row.principal_id
        AND i.channel = 'voice'
        AND i.status IN ('pending', 'active')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_voice_access_required');
END;

CREATE TRIGGER call_sessions_voice_access_immutable
BEFORE UPDATE ON call_sessions
WHEN OLD.access_kind IS NOT NEW.access_kind
  OR OLD.guest_grant_id IS NOT NEW.guest_grant_id
  OR OLD.guest_grant_version IS NOT NEW.guest_grant_version
  OR OLD.access_document_hash IS NOT NEW.access_document_hash
BEGIN
  SELECT RAISE(ABORT, 'call_session_voice_access_immutable');
END;

CREATE TRIGGER call_session_authorities_require_current_lineage
BEFORE INSERT ON call_session_authorities
WHEN NOT EXISTS (
  SELECT 1
  FROM call_sessions session
  WHERE session.session_id = NEW.session_id
    AND session.principal_id = NEW.principal_id
    AND session.identity_id = NEW.identity_id
    AND session.phase = 'pre_auth'
    AND (
      (
        NEW.authority_kind = 'owner'
        AND session.access_kind = 'owner'
        AND session.guest_grant_id IS NULL
        AND session.guest_grant_version IS NULL
        AND session.access_document_hash IS NULL
        AND EXISTS (
          SELECT 1
          FROM voice_owner_identity owner
          JOIN channel_identities i ON i.identity_id = owner.identity_id
          WHERE owner.principal_id = NEW.principal_id
            AND owner.identity_id = NEW.identity_id
            AND i.principal_id = owner.principal_id
            AND i.channel = 'voice'
            AND i.status = 'active'
            AND i.verified_at IS NOT NULL
        )
      )
      OR
      (
        NEW.authority_kind = 'guest'
        AND session.access_kind = 'guest'
        AND session.guest_grant_id = NEW.grant_id
        AND session.guest_grant_version = NEW.grant_version
        AND session.access_document_hash = NEW.access_document_hash
        AND EXISTS (
          SELECT 1
          FROM voice_access_grants grant_row
          JOIN channel_identities i ON i.identity_id = grant_row.identity_id
          WHERE grant_row.grant_id = NEW.grant_id
            AND grant_row.grant_version = NEW.grant_version
            AND grant_row.access_document_hash = NEW.access_document_hash
            AND grant_row.principal_id = NEW.principal_id
            AND grant_row.identity_id = NEW.identity_id
            AND grant_row.status = 'active'
            AND i.principal_id = grant_row.principal_id
            AND i.channel = 'voice'
            AND i.status = 'active'
            AND i.verified_at IS NOT NULL
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_authority_requires_current_lineage');
END;

CREATE TRIGGER call_session_authorities_immutable
BEFORE UPDATE ON call_session_authorities
BEGIN
  SELECT RAISE(ABORT, 'call_session_authority_immutable');
END;

CREATE TRIGGER call_session_authorities_delete_forbidden
BEFORE DELETE ON call_session_authorities
BEGIN
  SELECT RAISE(ABORT, 'call_session_authority_delete_forbidden');
END;

CREATE TRIGGER call_sessions_require_matching_outbound_attempt
BEFORE INSERT ON call_sessions
WHEN NEW.direction = 'outbound' AND NOT EXISTS (
  SELECT 1
  FROM outbound_call_attempts attempt
  JOIN voice_owner_identity actor ON actor.principal_id = attempt.principal_id
  JOIN channel_identities destination ON destination.identity_id = attempt.destination_identity_id
  WHERE attempt.attempt_id = NEW.expected_attempt_id
    AND attempt.attempt_id = NEW.session_id
    AND attempt.relay_call_sid = NEW.call_sid
    AND attempt.destination_identity_id = NEW.identity_id
    AND attempt.destination_identity_id = NEW.destination_identity_id
    AND destination.principal_id = NEW.principal_id
    AND attempt.relay_nonce = NEW.relay_nonce
    AND attempt.nonce_expires_at = NEW.nonce_expires_at
    AND attempt.provider_dispatch_state = 'dispatched'
    AND destination.channel = 'voice'
    AND destination.status IN ('pending', 'active')
    AND (
      (
        NEW.access_kind = 'owner'
        AND actor.principal_id = NEW.principal_id
        AND actor.identity_id = NEW.identity_id
        AND destination.status = 'active'
        AND destination.verified_at IS NOT NULL
      )
      OR
      (
        NEW.access_kind = 'guest'
        AND EXISTS (
          SELECT 1
          FROM voice_access_grants grant_row
          WHERE grant_row.grant_id = NEW.guest_grant_id
            AND grant_row.grant_version = NEW.guest_grant_version
            AND grant_row.access_document_hash = NEW.access_document_hash
            AND grant_row.principal_id = NEW.principal_id
            AND grant_row.identity_id = NEW.identity_id
            AND grant_row.status IN ('pending', 'active')
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'outbound_session_attempt_mismatch');
END;

PRAGMA defer_foreign_keys = OFF;

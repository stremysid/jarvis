ALTER TABLE call_sessions ADD COLUMN provider_connected_at TEXT
  CHECK (
    provider_connected_at IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', provider_connected_at) IS provider_connected_at
  );

CREATE TRIGGER call_sessions_provider_connected_at_required
BEFORE INSERT ON call_sessions
WHEN NOT (
  (NEW.provider_session_id IS NULL AND NEW.provider_connected_at IS NULL)
  OR (NEW.provider_session_id IS NOT NULL AND NEW.provider_connected_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_provider_connected_at_required');
END;

CREATE TRIGGER call_sessions_provider_connected_at_immutable
BEFORE UPDATE ON call_sessions
WHEN NOT (
  (
    OLD.provider_session_id IS NEW.provider_session_id
    AND OLD.provider_connected_at IS NEW.provider_connected_at
  )
  OR
  (
    OLD.provider_session_id IS NULL
    AND OLD.provider_connected_at IS NULL
    AND NEW.provider_session_id IS NOT NULL
    AND NEW.provider_connected_at IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.provider_connected_at) IS NEW.provider_connected_at
    AND NEW.provider_connected_at = NEW.updated_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_provider_connected_at_immutable');
END;

CREATE TRIGGER call_session_authorities_provider_lifetime
BEFORE INSERT ON call_session_authorities
WHEN NOT EXISTS (
  SELECT 1
  FROM call_sessions session
  WHERE session.session_id = NEW.session_id
    AND session.provider_session_id IS NOT NULL
    AND session.provider_connected_at IS NOT NULL
    AND NEW.authenticated_at >= session.provider_connected_at
    AND NEW.authenticated_at < strftime('%Y-%m-%dT%H:%M:%fZ', session.provider_connected_at, '+1800 seconds')
    AND NEW.expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', session.provider_connected_at, '+1800 seconds')
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_authority_provider_lifetime_invalid');
END;

CREATE TRIGGER call_sessions_voice_access_guest_owner_required
BEFORE INSERT ON call_sessions
WHEN NEW.access_kind = 'guest'
  AND NOT EXISTS (
    SELECT 1
    FROM voice_owner_identity owner
    JOIN principals principal ON principal.principal_id = owner.principal_id
    JOIN channel_identities identity
      ON identity.identity_id = owner.identity_id
      AND identity.principal_id = owner.principal_id
      AND identity.channel = 'voice'
    WHERE owner.singleton_id = 1
      AND principal.principal_type = 'human'
      AND principal.status = 'active'
      AND identity.status = 'active'
      AND identity.verified_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'call_session_guest_owner_required');
END;

CREATE TRIGGER call_sessions_voice_access_guest_owner_bind_required
BEFORE UPDATE OF provider_session_id, provider_connected_at ON call_sessions
WHEN OLD.access_kind = 'guest'
  AND OLD.provider_session_id IS NULL
  AND NEW.provider_session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM voice_owner_identity owner
    JOIN principals principal ON principal.principal_id = owner.principal_id
    JOIN channel_identities identity
      ON identity.identity_id = owner.identity_id
      AND identity.principal_id = owner.principal_id
      AND identity.channel = 'voice'
    WHERE owner.singleton_id = 1
      AND principal.principal_type = 'human'
      AND principal.status = 'active'
      AND identity.status = 'active'
      AND identity.verified_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'call_session_guest_owner_bind_required');
END;

CREATE TRIGGER call_session_authorities_guest_owner_required
BEFORE INSERT ON call_session_authorities
WHEN NEW.authority_kind = 'guest'
  AND NOT EXISTS (
    SELECT 1
    FROM voice_owner_identity owner
    JOIN principals principal ON principal.principal_id = owner.principal_id
    JOIN channel_identities identity
      ON identity.identity_id = owner.identity_id
      AND identity.principal_id = owner.principal_id
      AND identity.channel = 'voice'
    JOIN voice_access_grants grant_row
      ON grant_row.grant_id = NEW.grant_id
      AND grant_row.created_by_identity_id = owner.identity_id
    WHERE owner.singleton_id = 1
      AND principal.principal_type = 'human'
      AND principal.status = 'active'
      AND identity.status = 'active'
      AND identity.verified_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'call_session_authority_guest_owner_required');
END;

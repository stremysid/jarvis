-- Durable owner-call refusal delivery and guest-grant Telegram notices.
-- Migration 0020 is already present on main.

CREATE TABLE owner_call_step_up_disabled_rejections (
  session_id TEXT PRIMARY KEY REFERENCES owner_call_step_up_bindings(session_id) ON DELETE RESTRICT,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  rejected_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', rejected_at) IS rejected_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE owner_call_step_up_rejection_deliveries (
  session_id TEXT PRIMARY KEY REFERENCES owner_call_step_up_bindings(session_id) ON DELETE RESTRICT,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  delivered_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at) IS delivered_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE guest_grant_notices (
  mutation_id TEXT PRIMARY KEY REFERENCES voice_access_grant_events(event_id) ON DELETE RESTRICT,
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
  claim_id TEXT,
  claim_expires_at TEXT CHECK (
    claim_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claim_expires_at) IS claim_expires_at
  ),
  provider_message_id TEXT CHECK (
    provider_message_id IS NULL OR (
      length(provider_message_id) BETWEEN 1 AND 20
      AND substr(provider_message_id, 1, 1) GLOB '[1-9]'
      AND provider_message_id NOT GLOB '*[^0-9]*'
    )
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  delivered_at TEXT CHECK (
    delivered_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at) IS delivered_at
  ),
  CHECK (
    (claim_id IS NULL AND claim_expires_at IS NULL)
    OR (claim_id IS NOT NULL AND length(claim_id) BETWEEN 1 AND 128 AND claim_expires_at IS NOT NULL)
  ),
  CHECK (
    (status = 'pending' AND provider_message_id IS NULL AND delivered_at IS NULL)
    OR (status = 'delivered' AND claim_id IS NULL AND claim_expires_at IS NULL
      AND provider_message_id IS NOT NULL AND delivered_at IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX guest_grant_notices_pending_idx
ON guest_grant_notices (status, claim_expires_at, created_at, mutation_id);

CREATE TRIGGER owner_call_step_up_disabled_rejections_insert_guard
BEFORE INSERT ON owner_call_step_up_disabled_rejections
WHEN EXISTS (
  SELECT 1 FROM owner_call_step_up_disabled_rejections existing
  WHERE existing.session_id = NEW.session_id
) OR NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_bindings binding
  JOIN call_sessions session ON session.session_id = binding.session_id
  JOIN owner_passphrase_heads head ON head.singleton_id = 1
  JOIN owner_passphrase_verifiers verifier
    ON verifier.owner_identity_id = head.owner_identity_id
    AND verifier.verifier_version = head.verifier_version
  WHERE binding.session_id = NEW.session_id
    AND binding.lifecycle_generation = NEW.lifecycle_generation
    AND binding.requirement IN ('required', 'waived_passed_a')
    AND session.phase = 'pre_auth'
    AND session.access_kind = 'owner'
    AND session.activation_only = 0
    AND session.provider_connected_at IS NOT NULL
    AND NEW.rejected_at >= session.provider_connected_at
    AND NEW.rejected_at >= binding.created_at
    AND head.owner_principal_id = binding.owner_principal_id
    AND head.owner_identity_id = binding.owner_identity_id
    AND head.status = 'disabled'
    AND verifier.status = 'revoked'
    AND NOT EXISTS (
      SELECT 1 FROM owner_call_step_up_successes success WHERE success.session_id = NEW.session_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM owner_call_step_up_rejections rejection WHERE rejection.session_id = NEW.session_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_disabled_rejection_invalid');
END;

CREATE TRIGGER owner_call_step_up_disabled_rejections_terminalize
AFTER INSERT ON owner_call_step_up_disabled_rejections
BEGIN
  UPDATE call_sessions SET phase = 'rejected', updated_at = NEW.rejected_at
  WHERE session_id = NEW.session_id AND phase = 'pre_auth';
END;

CREATE TRIGGER owner_call_step_up_disabled_rejections_immutable
BEFORE UPDATE ON owner_call_step_up_disabled_rejections
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_disabled_rejection_immutable');
END;

CREATE TRIGGER owner_call_step_up_disabled_rejections_delete_forbidden
BEFORE DELETE ON owner_call_step_up_disabled_rejections
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_disabled_rejection_delete_forbidden');
END;

CREATE TRIGGER owner_call_step_up_rejection_deliveries_insert_guard
BEFORE INSERT ON owner_call_step_up_rejection_deliveries
WHEN EXISTS (
  SELECT 1 FROM owner_call_step_up_rejection_deliveries existing
  WHERE existing.session_id = NEW.session_id
) OR NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_bindings binding
  JOIN call_sessions session ON session.session_id = binding.session_id
  WHERE binding.session_id = NEW.session_id
    AND binding.lifecycle_generation = NEW.lifecycle_generation
    AND binding.requirement IN ('required', 'waived_passed_a')
    AND session.phase = 'rejected'
    AND (
      EXISTS (
        SELECT 1 FROM owner_call_step_up_rejections rejection
        WHERE rejection.session_id = NEW.session_id
          AND NEW.delivered_at >= rejection.rejected_at
      )
      OR EXISTS (
        SELECT 1 FROM owner_call_step_up_disabled_rejections rejection
        WHERE rejection.session_id = NEW.session_id
          AND NEW.delivered_at >= rejection.rejected_at
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_rejection_delivery_invalid');
END;

CREATE TRIGGER owner_call_step_up_rejection_deliveries_immutable
BEFORE UPDATE ON owner_call_step_up_rejection_deliveries
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_rejection_delivery_immutable');
END;

CREATE TRIGGER owner_call_step_up_rejection_deliveries_delete_forbidden
BEFORE DELETE ON owner_call_step_up_rejection_deliveries
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_rejection_delivery_delete_forbidden');
END;

CREATE TRIGGER guest_grant_notices_insert_guard
BEFORE INSERT ON guest_grant_notices
WHEN EXISTS (
  SELECT 1 FROM guest_grant_notices existing WHERE existing.mutation_id = NEW.mutation_id
) OR NEW.status <> 'pending'
  OR NEW.claim_id IS NOT NULL
  OR NEW.claim_expires_at IS NOT NULL
  OR NEW.provider_message_id IS NOT NULL
  OR NEW.delivered_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM voice_access_grant_events event
    JOIN voice_owner_identity owner ON owner.singleton_id = 1
      AND owner.identity_id = event.owner_identity_id
    WHERE event.event_id = NEW.mutation_id
      AND event.created_at = NEW.created_at
      AND event.event_type IN ('created', 'permissions_replaced', 'pin_rotated', 'revoked')
      AND owner.principal_id = NEW.owner_principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'guest_grant_notice_invalid');
END;

CREATE TRIGGER guest_grant_notices_transition_guard
BEFORE UPDATE ON guest_grant_notices
WHEN NEW.mutation_id IS NOT OLD.mutation_id
  OR NEW.owner_principal_id IS NOT OLD.owner_principal_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NOT (
    OLD.status = 'pending' AND OLD.claim_id IS NULL
      AND NEW.status = 'pending' AND NEW.claim_id IS NOT NULL
      AND NEW.claim_expires_at IS NOT NULL AND NEW.claim_expires_at > OLD.created_at
      AND NEW.provider_message_id IS NULL AND NEW.delivered_at IS NULL
    OR OLD.status = 'pending' AND OLD.claim_id IS NOT NULL
      AND NEW.status = 'pending' AND NEW.claim_id IS NULL AND NEW.claim_expires_at IS NULL
      AND NEW.provider_message_id IS NULL AND NEW.delivered_at IS NULL
    OR OLD.status = 'pending' AND OLD.claim_id IS NOT NULL
      AND NEW.status = 'delivered' AND NEW.claim_id IS NULL AND NEW.claim_expires_at IS NULL
      AND NEW.provider_message_id IS NOT NULL
      AND NEW.delivered_at IS NOT NULL AND NEW.delivered_at >= OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'guest_grant_notice_transition_invalid');
END;

CREATE TRIGGER guest_grant_notices_delete_forbidden
BEFORE DELETE ON guest_grant_notices
BEGIN
  SELECT RAISE(ABORT, 'guest_grant_notice_delete_forbidden');
END;

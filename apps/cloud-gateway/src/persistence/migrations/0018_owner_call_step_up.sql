-- R1 owner-call passphrase step-up. Migration 0016 is owned by R2 and 0017
-- contains the verifier. Candidate text is deliberately absent from this schema.

CREATE TABLE owner_call_step_up_bindings (
  session_id TEXT PRIMARY KEY REFERENCES call_sessions(session_id) ON DELETE RESTRICT,
  call_sid TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  requirement TEXT NOT NULL CHECK (requirement IN ('required', 'waived_passed_a', 'not_applicable')),
  attestation_class TEXT NOT NULL CHECK (attestation_class IN ('passed_a', 'absent', 'other', 'not_applicable')),
  policy TEXT NOT NULL CHECK (policy IN ('passphrase_always', 'waive_on_passed_a', 'invalid', 'not_applicable')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
) STRICT;

CREATE TABLE owner_call_step_up_windows (
  session_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  verifier_version INTEGER NOT NULL CHECK (verifier_version BETWEEN 1 AND 2147483647),
  prompted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', prompted_at) IS prompted_at),
  deadline_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at) IS deadline_at),
  PRIMARY KEY (session_id, lifecycle_generation),
  FOREIGN KEY (session_id) REFERENCES owner_call_step_up_bindings(session_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE owner_call_step_up_attempts (
  session_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 3),
  verifier_version INTEGER NOT NULL CHECK (verifier_version BETWEEN 1 AND 2147483647),
  attempted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) IS attempted_at),
  outcome TEXT CHECK (outcome IN ('matched', 'mismatched')),
  resolved_at TEXT CHECK (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at),
  PRIMARY KEY (session_id, lifecycle_generation, attempt_ordinal),
  FOREIGN KEY (session_id, lifecycle_generation)
    REFERENCES owner_call_step_up_windows(session_id, lifecycle_generation) ON DELETE RESTRICT,
  CHECK ((outcome IS NULL AND resolved_at IS NULL) OR (outcome IS NOT NULL AND resolved_at IS NOT NULL))
) STRICT;

CREATE TABLE owner_call_step_up_reprompts (
  session_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  reprompt_ordinal INTEGER NOT NULL CHECK (reprompt_ordinal BETWEEN 1 AND 3),
  prompted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', prompted_at) IS prompted_at),
  PRIMARY KEY (session_id, lifecycle_generation, reprompt_ordinal),
  FOREIGN KEY (session_id, lifecycle_generation)
    REFERENCES owner_call_step_up_windows(session_id, lifecycle_generation) ON DELETE RESTRICT
) STRICT;

CREATE TABLE owner_call_step_up_successes (
  session_id TEXT PRIMARY KEY REFERENCES owner_call_step_up_bindings(session_id) ON DELETE RESTRICT,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  call_sid TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  owner_principal_id TEXT NOT NULL,
  owner_identity_id TEXT NOT NULL,
  verifier_version INTEGER NOT NULL CHECK (verifier_version BETWEEN 1 AND 2147483647),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 3),
  verified_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at),
  FOREIGN KEY (session_id, lifecycle_generation, attempt_ordinal)
    REFERENCES owner_call_step_up_attempts(session_id, lifecycle_generation, attempt_ordinal) ON DELETE RESTRICT
) STRICT;

CREATE TABLE owner_call_step_up_rejections (
  session_id TEXT PRIMARY KEY REFERENCES owner_call_step_up_bindings(session_id) ON DELETE RESTRICT,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  reason TEXT NOT NULL CHECK (reason IN ('attempts_exhausted', 'reprompts_exhausted', 'deadline_expired')),
  rejected_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', rejected_at) IS rejected_at)
) STRICT;

CREATE TABLE owner_call_step_up_repeat_checks (
  session_id TEXT PRIMARY KEY REFERENCES owner_call_step_up_successes(session_id) ON DELETE RESTRICT,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  verifier_version INTEGER NOT NULL CHECK (verifier_version BETWEEN 1 AND 2147483647),
  reserved_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at) IS reserved_at),
  outcome TEXT CHECK (outcome IN ('matched', 'mismatched')),
  resolved_at TEXT CHECK (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at),
  CHECK ((outcome IS NULL AND resolved_at IS NULL) OR (outcome IS NOT NULL AND resolved_at IS NOT NULL))
) STRICT;

CREATE TABLE guest_call_pin_attempts (
  session_id TEXT NOT NULL REFERENCES call_sessions(session_id) ON DELETE RESTRICT,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 3),
  attempted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) IS attempted_at),
  PRIMARY KEY (session_id, attempt_ordinal)
) STRICT;

CREATE TABLE owner_call_step_up_alerts (
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  alert_class TEXT NOT NULL CHECK (alert_class IN ('rejected', 'configuration')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  attestation_class TEXT NOT NULL CHECK (attestation_class IN ('passed_a', 'absent', 'other', 'not_applicable')),
  first_observed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', first_observed_at) IS first_observed_at),
  last_observed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at) IS last_observed_at),
  observation_count INTEGER NOT NULL CHECK (observation_count >= 1),
  last_sent_at TEXT CHECK (last_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_sent_at) IS last_sent_at),
  claim_id TEXT,
  claim_expires_at TEXT CHECK (claim_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claim_expires_at) IS claim_expires_at),
  PRIMARY KEY (owner_principal_id, alert_class, direction),
  CHECK ((claim_id IS NULL AND claim_expires_at IS NULL) OR (claim_id IS NOT NULL AND claim_expires_at IS NOT NULL))
) STRICT;

CREATE TRIGGER owner_call_step_up_bindings_insert_guard
BEFORE INSERT ON owner_call_step_up_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM call_sessions session
  JOIN voice_owner_identity owner ON owner.singleton_id = 1
  WHERE session.session_id = NEW.session_id
    AND session.call_sid = NEW.call_sid
    AND session.principal_id = NEW.owner_principal_id
    AND session.identity_id = NEW.owner_identity_id
    AND session.direction = NEW.direction
    AND session.created_at = NEW.created_at
    AND owner.principal_id = NEW.owner_principal_id
    AND owner.identity_id = NEW.owner_identity_id
    AND (
      session.activation_only = 1 AND NEW.requirement = 'not_applicable'
        AND NEW.attestation_class = 'not_applicable' AND NEW.policy = 'not_applicable'
      OR session.access_kind = 'guest' AND NEW.requirement = 'not_applicable'
        AND NEW.attestation_class = 'not_applicable' AND NEW.policy = 'not_applicable'
      OR session.activation_only = 0 AND session.access_kind = 'owner' AND session.direction = 'outbound'
        AND NEW.requirement = 'required' AND NEW.attestation_class = 'not_applicable'
        AND NEW.policy = 'passphrase_always'
      OR session.activation_only = 0 AND session.access_kind = 'owner' AND session.direction = 'inbound'
        AND (
          NEW.requirement = 'waived_passed_a' AND NEW.attestation_class = 'passed_a'
            AND NEW.policy = 'waive_on_passed_a'
          OR NEW.requirement = 'required' AND NOT (
            NEW.attestation_class = 'passed_a' AND NEW.policy = 'waive_on_passed_a'
          )
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_binding_invalid');
END;

CREATE TRIGGER owner_call_step_up_bindings_immutable
BEFORE UPDATE ON owner_call_step_up_bindings
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_binding_immutable');
END;

CREATE TRIGGER owner_call_step_up_bindings_delete_forbidden
BEFORE DELETE ON owner_call_step_up_bindings
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_binding_delete_forbidden');
END;

CREATE TRIGGER owner_call_step_up_windows_insert_guard
BEFORE INSERT ON owner_call_step_up_windows
WHEN NEW.deadline_at <> strftime('%Y-%m-%dT%H:%M:%fZ', NEW.prompted_at, '+60 seconds') OR NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_bindings binding
  JOIN call_sessions session ON session.session_id = binding.session_id
  JOIN owner_passphrase_heads head ON head.singleton_id = 1
  JOIN owner_passphrase_verifiers verifier
    ON verifier.owner_identity_id = head.owner_identity_id AND verifier.verifier_version = head.verifier_version
  WHERE binding.session_id = NEW.session_id
    AND binding.lifecycle_generation = NEW.lifecycle_generation
    AND binding.requirement = 'required'
    AND session.phase = 'pre_auth' AND session.provider_connected_at IS NOT NULL
    AND NEW.prompted_at >= session.provider_connected_at
    AND head.owner_principal_id = binding.owner_principal_id
    AND head.owner_identity_id = binding.owner_identity_id
    AND head.verifier_version = NEW.verifier_version
    AND head.status = 'active' AND verifier.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_window_invalid');
END;

CREATE TRIGGER owner_call_step_up_windows_immutable
BEFORE UPDATE ON owner_call_step_up_windows
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_window_immutable');
END;

CREATE TRIGGER owner_call_step_up_windows_delete_forbidden
BEFORE DELETE ON owner_call_step_up_windows
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_window_delete_forbidden');
END;

CREATE TRIGGER owner_call_step_up_attempts_insert_guard
BEFORE INSERT ON owner_call_step_up_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_windows window
  JOIN call_sessions session ON session.session_id = window.session_id
  JOIN owner_passphrase_heads head ON head.singleton_id = 1
  JOIN owner_passphrase_verifiers verifier
    ON verifier.owner_identity_id = head.owner_identity_id AND verifier.verifier_version = head.verifier_version
  WHERE window.session_id = NEW.session_id
    AND window.lifecycle_generation = NEW.lifecycle_generation
    AND window.verifier_version = NEW.verifier_version
    AND session.phase = 'pre_auth'
    AND NEW.attempted_at >= window.prompted_at AND NEW.attempted_at < window.deadline_at
    AND head.verifier_version = NEW.verifier_version AND head.status = 'active' AND verifier.status = 'active'
    AND NEW.attempt_ordinal = 1 + (
      SELECT count(*) FROM owner_call_step_up_attempts prior
      WHERE prior.session_id = NEW.session_id AND prior.lifecycle_generation = NEW.lifecycle_generation
    )
    AND NOT EXISTS (
      SELECT 1 FROM owner_call_step_up_attempts unresolved
      WHERE unresolved.session_id = NEW.session_id AND unresolved.lifecycle_generation = NEW.lifecycle_generation
        AND unresolved.outcome IS NULL
    )
    AND NOT EXISTS (SELECT 1 FROM owner_call_step_up_successes success WHERE success.session_id = NEW.session_id)
    AND NOT EXISTS (SELECT 1 FROM owner_call_step_up_rejections rejection WHERE rejection.session_id = NEW.session_id)
) OR NEW.outcome IS NOT NULL OR NEW.resolved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_attempt_invalid');
END;

CREATE TRIGGER owner_call_step_up_attempts_transition_guard
BEFORE UPDATE ON owner_call_step_up_attempts
WHEN NEW.session_id IS NOT OLD.session_id
  OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
  OR NEW.attempt_ordinal IS NOT OLD.attempt_ordinal
  OR NEW.verifier_version IS NOT OLD.verifier_version
  OR NEW.attempted_at IS NOT OLD.attempted_at
  OR OLD.outcome IS NOT NULL OR OLD.resolved_at IS NOT NULL
  OR NEW.outcome IS NULL OR NEW.resolved_at IS NULL OR NEW.resolved_at < OLD.attempted_at
  OR NOT EXISTS (
    SELECT 1 FROM owner_call_step_up_windows window
    JOIN call_sessions session ON session.session_id = window.session_id
    JOIN owner_passphrase_heads head ON head.singleton_id = 1
    JOIN owner_passphrase_verifiers verifier
      ON verifier.owner_identity_id = head.owner_identity_id AND verifier.verifier_version = head.verifier_version
    WHERE window.session_id = OLD.session_id AND window.lifecycle_generation = OLD.lifecycle_generation
      AND session.phase = 'pre_auth' AND NEW.resolved_at < window.deadline_at
      AND head.verifier_version = OLD.verifier_version AND head.status = 'active' AND verifier.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_attempt_transition_invalid');
END;

CREATE TRIGGER owner_call_step_up_attempts_delete_forbidden
BEFORE DELETE ON owner_call_step_up_attempts
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_attempt_delete_forbidden');
END;

CREATE TRIGGER owner_call_step_up_attempts_publish_match
AFTER UPDATE OF outcome ON owner_call_step_up_attempts
WHEN NEW.outcome = 'matched'
BEGIN
  INSERT INTO owner_call_step_up_successes (
    session_id, lifecycle_generation, call_sid, direction, owner_principal_id,
    owner_identity_id, verifier_version, attempt_ordinal, verified_at
  )
  SELECT binding.session_id, binding.lifecycle_generation, binding.call_sid, binding.direction,
    binding.owner_principal_id, binding.owner_identity_id, NEW.verifier_version,
    NEW.attempt_ordinal, NEW.resolved_at
  FROM owner_call_step_up_bindings binding WHERE binding.session_id = NEW.session_id;
END;

CREATE TRIGGER owner_call_step_up_successes_insert_guard
BEFORE INSERT ON owner_call_step_up_successes
WHEN NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_bindings binding
  JOIN call_sessions session ON session.session_id = binding.session_id
  JOIN owner_call_step_up_attempts attempt
    ON attempt.session_id = binding.session_id AND attempt.lifecycle_generation = binding.lifecycle_generation
  JOIN owner_passphrase_heads head ON head.singleton_id = 1
  JOIN owner_passphrase_verifiers verifier
    ON verifier.owner_identity_id = head.owner_identity_id AND verifier.verifier_version = head.verifier_version
  WHERE binding.session_id = NEW.session_id
    AND binding.lifecycle_generation = NEW.lifecycle_generation
    AND binding.call_sid = NEW.call_sid AND binding.direction = NEW.direction
    AND binding.owner_principal_id = NEW.owner_principal_id
    AND binding.owner_identity_id = NEW.owner_identity_id
    AND binding.requirement = 'required' AND session.phase = 'pre_auth'
    AND attempt.attempt_ordinal = NEW.attempt_ordinal
    AND attempt.verifier_version = NEW.verifier_version
    AND attempt.outcome = 'matched' AND attempt.resolved_at = NEW.verified_at
    AND head.owner_principal_id = NEW.owner_principal_id
    AND head.owner_identity_id = NEW.owner_identity_id
    AND head.verifier_version = NEW.verifier_version
    AND head.status = 'active' AND verifier.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_success_invalid');
END;

CREATE TRIGGER owner_call_step_up_successes_publish_authority
AFTER INSERT ON owner_call_step_up_successes
BEGIN
  INSERT INTO call_session_authorities (
    session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
    access_document_hash, authenticated_at, expires_at
  )
  SELECT session.session_id, 'owner', session.principal_id, session.identity_id,
    NULL, NULL, NULL, NEW.verified_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', session.provider_connected_at, '+1800 seconds')
  FROM call_sessions session
  WHERE session.session_id = NEW.session_id AND session.phase = 'pre_auth';

  UPDATE call_sessions SET phase = 'authenticated', updated_at = NEW.verified_at
  WHERE session_id = NEW.session_id AND phase = 'pre_auth';
END;

CREATE TRIGGER owner_call_step_up_successes_immutable
BEFORE UPDATE ON owner_call_step_up_successes
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_success_immutable');
END;

CREATE TRIGGER owner_call_step_up_successes_delete_forbidden
BEFORE DELETE ON owner_call_step_up_successes
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_success_delete_forbidden');
END;

CREATE TRIGGER owner_call_step_up_attempts_publish_exhaustion
AFTER UPDATE OF outcome ON owner_call_step_up_attempts
WHEN NEW.outcome = 'mismatched' AND NEW.attempt_ordinal = 3
BEGIN
  INSERT INTO owner_call_step_up_rejections (session_id, lifecycle_generation, reason, rejected_at)
  VALUES (NEW.session_id, NEW.lifecycle_generation, 'attempts_exhausted', NEW.resolved_at);
END;

CREATE TRIGGER owner_call_step_up_reprompts_insert_guard
BEFORE INSERT ON owner_call_step_up_reprompts
WHEN NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_windows window
  JOIN call_sessions session ON session.session_id = window.session_id
  WHERE window.session_id = NEW.session_id AND window.lifecycle_generation = NEW.lifecycle_generation
    AND session.phase = 'pre_auth'
    AND NEW.prompted_at >= window.prompted_at AND NEW.prompted_at < window.deadline_at
    AND NEW.reprompt_ordinal = 1 + (
      SELECT count(*) FROM owner_call_step_up_reprompts prior
      WHERE prior.session_id = NEW.session_id AND prior.lifecycle_generation = NEW.lifecycle_generation
    )
    AND NOT EXISTS (SELECT 1 FROM owner_call_step_up_successes success WHERE success.session_id = NEW.session_id)
    AND NOT EXISTS (SELECT 1 FROM owner_call_step_up_rejections rejection WHERE rejection.session_id = NEW.session_id)
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_reprompt_invalid');
END;

CREATE TRIGGER owner_call_step_up_reprompts_delete_forbidden
BEFORE DELETE ON owner_call_step_up_reprompts
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_reprompt_delete_forbidden');
END;

CREATE TRIGGER owner_call_step_up_reprompts_immutable
BEFORE UPDATE ON owner_call_step_up_reprompts
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_reprompt_immutable');
END;

CREATE TRIGGER owner_call_step_up_reprompts_publish_exhaustion
AFTER INSERT ON owner_call_step_up_reprompts
WHEN NEW.reprompt_ordinal = 3
BEGIN
  INSERT INTO owner_call_step_up_rejections (session_id, lifecycle_generation, reason, rejected_at)
  VALUES (NEW.session_id, NEW.lifecycle_generation, 'reprompts_exhausted', NEW.prompted_at);
END;

CREATE TRIGGER owner_call_step_up_rejections_insert_guard
BEFORE INSERT ON owner_call_step_up_rejections
WHEN NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_windows window
  JOIN call_sessions session ON session.session_id = window.session_id
  WHERE window.session_id = NEW.session_id AND window.lifecycle_generation = NEW.lifecycle_generation
    AND session.phase = 'pre_auth'
    AND NOT EXISTS (SELECT 1 FROM owner_call_step_up_successes success WHERE success.session_id = NEW.session_id)
    AND (
      NEW.reason = 'attempts_exhausted' AND (
        SELECT count(*) FROM owner_call_step_up_attempts attempt
        WHERE attempt.session_id = NEW.session_id AND attempt.lifecycle_generation = NEW.lifecycle_generation
          AND attempt.outcome = 'mismatched'
      ) = 3
      OR NEW.reason = 'reprompts_exhausted' AND (
        SELECT count(*) FROM owner_call_step_up_reprompts reprompt
        WHERE reprompt.session_id = NEW.session_id AND reprompt.lifecycle_generation = NEW.lifecycle_generation
      ) = 3
      OR NEW.reason = 'deadline_expired' AND NEW.rejected_at >= window.deadline_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_rejection_invalid');
END;

CREATE TRIGGER owner_call_step_up_rejections_terminalize
AFTER INSERT ON owner_call_step_up_rejections
BEGIN
  UPDATE call_sessions SET phase = 'rejected', updated_at = NEW.rejected_at
  WHERE session_id = NEW.session_id AND phase = 'pre_auth';
END;

CREATE TRIGGER owner_call_step_up_rejections_immutable
BEFORE UPDATE ON owner_call_step_up_rejections
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_rejection_immutable');
END;

CREATE TRIGGER owner_call_step_up_rejections_delete_forbidden
BEFORE DELETE ON owner_call_step_up_rejections
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_rejection_delete_forbidden');
END;

CREATE TRIGGER owner_call_step_up_repeat_checks_insert_guard
BEFORE INSERT ON owner_call_step_up_repeat_checks
WHEN NEW.outcome IS NOT NULL OR NEW.resolved_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM owner_call_step_up_successes success
  JOIN call_sessions session ON session.session_id = success.session_id
  JOIN owner_passphrase_heads head ON head.singleton_id = 1
  JOIN owner_passphrase_verifiers verifier
    ON verifier.owner_identity_id = head.owner_identity_id AND verifier.verifier_version = head.verifier_version
  WHERE success.session_id = NEW.session_id
    AND success.lifecycle_generation = NEW.lifecycle_generation
    AND success.verifier_version = NEW.verifier_version
    AND session.phase = 'active'
    AND NEW.reserved_at >= success.verified_at
    AND NEW.reserved_at <= strftime('%Y-%m-%dT%H:%M:%fZ', success.verified_at, '+2 seconds')
    AND head.owner_identity_id = success.owner_identity_id
    AND head.verifier_version = success.verifier_version
    AND head.status = 'active' AND verifier.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_repeat_invalid');
END;

CREATE TRIGGER owner_call_step_up_repeat_checks_transition_guard
BEFORE UPDATE ON owner_call_step_up_repeat_checks
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
  OR NEW.verifier_version IS NOT OLD.verifier_version OR NEW.reserved_at IS NOT OLD.reserved_at
  OR OLD.outcome IS NOT NULL OR OLD.resolved_at IS NOT NULL
  OR NEW.outcome IS NULL OR NEW.resolved_at IS NULL OR NEW.resolved_at < OLD.reserved_at
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_repeat_transition_invalid');
END;

CREATE TRIGGER owner_call_step_up_repeat_checks_delete_forbidden
BEFORE DELETE ON owner_call_step_up_repeat_checks
BEGIN
  SELECT RAISE(ABORT, 'owner_call_step_up_repeat_delete_forbidden');
END;

CREATE TRIGGER guest_call_pin_attempts_insert_guard
BEFORE INSERT ON guest_call_pin_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM call_sessions session
  WHERE session.session_id = NEW.session_id AND session.phase = 'pre_auth'
    AND session.access_kind = 'guest' AND session.provider_connected_at IS NOT NULL
    AND NEW.attempted_at >= session.provider_connected_at
    AND NEW.attempt_ordinal = 1 + (
      SELECT count(*) FROM guest_call_pin_attempts prior WHERE prior.session_id = NEW.session_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'guest_call_pin_attempt_invalid');
END;

CREATE TRIGGER guest_call_pin_attempts_immutable
BEFORE UPDATE ON guest_call_pin_attempts
BEGIN
  SELECT RAISE(ABORT, 'guest_call_pin_attempt_immutable');
END;

CREATE TRIGGER guest_call_pin_attempts_delete_forbidden
BEFORE DELETE ON guest_call_pin_attempts
BEGIN
  SELECT RAISE(ABORT, 'guest_call_pin_attempt_delete_forbidden');
END;

-- Replace the older owner authority guard. Owner authority now requires either
-- the exact dormant waiver snapshot or a matching current success receipt.
DROP TRIGGER call_session_authorities_require_current_lineage;

CREATE TRIGGER call_session_authorities_require_current_lineage
BEFORE INSERT ON call_session_authorities
WHEN NOT EXISTS (
  SELECT 1 FROM call_sessions session
  WHERE session.session_id = NEW.session_id
    AND session.principal_id = NEW.principal_id AND session.identity_id = NEW.identity_id
    AND session.phase = 'pre_auth'
    AND (
      NEW.authority_kind = 'owner' AND session.access_kind = 'owner'
      AND NEW.grant_id IS NULL AND NEW.grant_version IS NULL AND NEW.access_document_hash IS NULL
      AND EXISTS (
        SELECT 1 FROM voice_owner_identity owner
        JOIN channel_identities identity ON identity.identity_id = owner.identity_id
        JOIN owner_call_step_up_bindings binding ON binding.session_id = session.session_id
        WHERE owner.principal_id = NEW.principal_id AND owner.identity_id = NEW.identity_id
          AND identity.principal_id = owner.principal_id AND identity.channel = 'voice'
          AND identity.status = 'active' AND identity.verified_at IS NOT NULL
          AND (
            binding.requirement = 'waived_passed_a'
              AND binding.direction = 'inbound' AND binding.attestation_class = 'passed_a'
              AND binding.policy = 'waive_on_passed_a'
            OR EXISTS (
              SELECT 1 FROM owner_call_step_up_successes success
              JOIN owner_passphrase_heads head ON head.singleton_id = 1
              JOIN owner_passphrase_verifiers verifier
                ON verifier.owner_identity_id = head.owner_identity_id
                AND verifier.verifier_version = head.verifier_version
              WHERE success.session_id = session.session_id
                AND success.call_sid = session.call_sid AND success.direction = session.direction
                AND success.owner_principal_id = NEW.principal_id
                AND success.owner_identity_id = NEW.identity_id
                AND success.verified_at = NEW.authenticated_at
                AND success.verifier_version = head.verifier_version
                AND head.owner_principal_id = NEW.principal_id
                AND head.owner_identity_id = NEW.identity_id
                AND head.status = 'active' AND verifier.status = 'active'
            )
          )
      )
      OR NEW.authority_kind = 'guest' AND session.access_kind = 'guest'
      AND session.guest_grant_id = NEW.grant_id AND session.guest_grant_version = NEW.grant_version
      AND session.access_document_hash = NEW.access_document_hash
      AND EXISTS (
        SELECT 1 FROM voice_access_grants grant_row
        JOIN channel_identities identity ON identity.identity_id = grant_row.identity_id
        WHERE grant_row.grant_id = NEW.grant_id AND grant_row.grant_version = NEW.grant_version
          AND grant_row.access_document_hash = NEW.access_document_hash
          AND grant_row.principal_id = NEW.principal_id AND grant_row.identity_id = NEW.identity_id
          AND grant_row.status = 'active' AND identity.principal_id = grant_row.principal_id
          AND identity.channel = 'voice' AND identity.status = 'active' AND identity.verified_at IS NOT NULL
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'call_session_authority_requires_current_lineage');
END;

-- Two changes that belong together: the ledger a call's PIN gate counts against,
-- and the owner-authority guard that the removed per-call passphrase gate had
-- made impossible to satisfy.
--
-- `0018` replaced `call_session_authorities_require_current_lineage` so that an
-- owner authority row required either a dormant caller-ID waiver snapshot or a
-- matching passphrase success receipt. Sid removed the per-call passphrase on
-- 2026-09-24 ("an ordinary owner call goes straight to Jarvis"), so no code
-- writes either row any more and that trigger aborts every owner call. The
-- replacement keeps every lineage check that is still true -- the durable
-- session, its principal and identity, the pre-authentication phase, the guest
-- branch -- and drops only the two step-up clauses. The guest branch is copied
-- verbatim, so guest isolation is unchanged.
--
-- The ledger of wrong PIN candidates at a sensitive action on a call.
--
-- This exists so brute force is bounded across questions and across calls,
-- which an in-memory counter on one call cannot do. Only the outcome and the
-- instant are stored: a candidate never reaches a column, a log or a receipt,
-- which is the whole point of the PIN never leaking.
--
-- Append-only, like the other authentication ledgers. It is not a lockout:
-- the rate limit reads a fifteen minute sliding window, so a wrong run
-- expires on its own and never locks the owner out permanently.
--
-- Additive for old gateways. A deployment that has not applied it fails
-- closed: the insert throws, the mismatch cannot be counted, and the action
-- is refused rather than run.
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
        WHERE owner.principal_id = NEW.principal_id AND owner.identity_id = NEW.identity_id
          AND identity.principal_id = owner.principal_id AND identity.channel = 'voice'
          AND identity.status = 'active' AND identity.verified_at IS NOT NULL
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

CREATE TABLE sensitive_action_pin_attempts (
  attempt_id TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(attempt_id) = 26
      AND substr(attempt_id, 1, 1) BETWEEN '0' AND '7'
      AND attempt_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    ),
  session_id TEXT NOT NULL REFERENCES call_sessions(session_id) ON DELETE RESTRICT
    CHECK (
      length(session_id) = 26
      AND substr(session_id, 1, 1) BETWEEN '0' AND '7'
      AND session_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    ),
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  attempted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) IS attempted_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('mismatched'))
);

-- The rate limit reads exactly this: one principal's mismatches in a window.
CREATE INDEX sensitive_action_pin_attempts_principal_idx
  ON sensitive_action_pin_attempts(owner_principal_id, attempted_at);

CREATE TRIGGER sensitive_action_pin_attempts_reject_update
BEFORE UPDATE ON sensitive_action_pin_attempts
BEGIN
  SELECT RAISE(ABORT, 'sensitive_action_pin_attempt_update_forbidden');
END;

CREATE TRIGGER sensitive_action_pin_attempts_reject_delete
BEFORE DELETE ON sensitive_action_pin_attempts
BEGIN
  SELECT RAISE(ABORT, 'sensitive_action_pin_attempt_delete_forbidden');
END;

-- R1 calling: a spoken four-digit PIN gates a sensitive action, not the call.
--
-- Owner admission is deliberately unguarded here. Sid decided on 2026-09-17
-- that an always-on gate on every owner call costs more than it buys, and the
-- risk it covered -- caller-ID spoofing -- only matters once an action is
-- worth stealing. The PIN therefore attaches to the action, is valid for the
-- two minutes that action is under discussion, and is spent by it.
--
-- The sensitive list is not restated in this file. A capability is sensitive
-- because `capability_tiers` says tier 3, which is the same row the Telegram
-- owner agent reads for "outward actions always ask", so a capability cannot
-- be gated on one channel and open on the other. This migration adds the
-- tier 3 rows the six categories needed and left unclassified.
--
-- No table here can hold a spoken or keyed candidate. There is no candidate
-- column, no masked form, no length and no digest: `owner_action_attempts`
-- records that an attempt happened, how it arrived and what it settled as.
-- That is a schema property rather than a logging convention, so no later
-- change to a logger, an event payload or a receipt can leak digits.
--
-- No semicolons in comments. The test migration splitter divides on them.

CREATE TABLE owner_call_pin_verifiers (
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  pin_version INTEGER NOT NULL CHECK (pin_version BETWEEN 1 AND 2147483647),
  algorithm TEXT NOT NULL CHECK (algorithm = 'hmac-sha256-pepper+pbkdf2-hmac-sha256'),
  domain_version TEXT NOT NULL CHECK (domain_version = 'v1'),
  pepper_version TEXT NOT NULL CHECK (pepper_version = 'v1'),
  iterations INTEGER NOT NULL CHECK (iterations = 600000),
  salt BLOB NOT NULL CHECK (typeof(salt) = 'blob' AND length(salt) = 16),
  digest BLOB NOT NULL CHECK (typeof(digest) = 'blob' AND length(digest) = 32),
  status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'revoked')),
  created_by_device_id TEXT NOT NULL REFERENCES device_keys(device_id) ON DELETE RESTRICT,
  created_by_key_id TEXT NOT NULL CHECK (length(created_by_key_id) BETWEEN 1 AND 256),
  created_by_key_fingerprint TEXT NOT NULL CHECK (
    length(created_by_key_fingerprint) = 64
    AND created_by_key_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_key_generation INTEGER NOT NULL CHECK (created_by_key_generation >= 1),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  status_changed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', status_changed_at) IS status_changed_at
    AND status_changed_at >= created_at
  ),
  PRIMARY KEY (owner_identity_id, pin_version)
) STRICT;

-- A rotation names the version it replaces, so two concurrent CLI runs cannot
-- both install a version and leave the head pointing at whichever wrote last.
CREATE TABLE owner_call_pin_rotation_commits (
  commit_id TEXT PRIMARY KEY CHECK (
    length(commit_id) = 26 AND substr(commit_id, 1, 1) BETWEEN '0' AND '7'
    AND commit_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  expected_pin_version INTEGER CHECK (
    expected_pin_version IS NULL OR expected_pin_version BETWEEN 1 AND 2147483646
  ),
  new_pin_version INTEGER NOT NULL CHECK (new_pin_version BETWEEN 1 AND 2147483647),
  committed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', committed_at) IS committed_at),
  UNIQUE (owner_identity_id, new_pin_version),
  CHECK ((expected_pin_version IS NULL AND new_pin_version = 1)
    OR (expected_pin_version IS NOT NULL AND new_pin_version = expected_pin_version + 1))
) STRICT;

-- The head row is the one active PIN. Its absence is the honest statement that
-- no PIN is configured, which is why there is no status column here: a
-- disabled credential and a missing one would answer the same question
-- differently and only one of them is true.
CREATE TABLE owner_call_pin_heads (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner_principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL UNIQUE REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  pin_version INTEGER NOT NULL CHECK (pin_version BETWEEN 1 AND 2147483647),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (owner_identity_id, pin_version)
    REFERENCES owner_call_pin_verifiers(owner_identity_id, pin_version) ON DELETE RESTRICT
) STRICT;

-- One open question at a time per call. A second sensitive action waits for
-- the first to be authorised or refused rather than replacing it, so a
-- half-answered prompt can never be silently retargeted at a different
-- capability.
CREATE TABLE owner_action_requests (
  request_id TEXT PRIMARY KEY CHECK (
    length(request_id) = 26 AND substr(request_id, 1, 1) BETWEEN '0' AND '7'
    AND request_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  session_id TEXT NOT NULL REFERENCES call_sessions(session_id) ON DELETE RESTRICT,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  capability TEXT NOT NULL REFERENCES capability_tiers(capability) ON DELETE RESTRICT,
  evaluation_id TEXT NOT NULL REFERENCES autonomy_evaluations(evaluation_id) ON DELETE RESTRICT,
  explanation TEXT NOT NULL CHECK (length(explanation) BETWEEN 1 AND 256),
  opened_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', opened_at) IS opened_at),
  deadline_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at) IS deadline_at
    AND deadline_at > opened_at
    AND deadline_at <= strftime('%Y-%m-%dT%H:%M:%fZ', opened_at, '+120 seconds')
  ),
  outcome TEXT CHECK (outcome IN ('authorised', 'refused')),
  resolved_at TEXT CHECK (
    resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at
  ),
  CHECK ((outcome IS NULL AND resolved_at IS NULL) OR (outcome IS NOT NULL AND resolved_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX owner_action_requests_open_idx
  ON owner_action_requests(session_id) WHERE outcome IS NULL;

-- Five attempts, because a failed attempt is far more likely to be a
-- mis-heard digit than an attack, and the cost of the fifth is one sentence.
CREATE TABLE owner_action_attempts (
  request_id TEXT NOT NULL REFERENCES owner_action_requests(request_id) ON DELETE RESTRICT,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 5),
  method TEXT NOT NULL CHECK (method IN ('spoken_pin', 'spoken_passphrase', 'spoken_unreadable', 'keypad')),
  outcome TEXT CHECK (outcome IN ('matched', 'mismatched', 'unusable')),
  attempted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) IS attempted_at),
  resolved_at TEXT CHECK (
    resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at
  ),
  PRIMARY KEY (request_id, attempt_ordinal),
  CHECK ((outcome IS NULL AND resolved_at IS NULL) OR (outcome IS NOT NULL AND resolved_at IS NOT NULL))
) STRICT, WITHOUT ROWID;

-- Re-prompts are distinct by construction rather than by repetition count: a
-- caller who hears the same sentence five times learns nothing about what went
-- wrong, and neither does the transcript.
CREATE TABLE owner_action_reprompts (
  request_id TEXT NOT NULL REFERENCES owner_action_requests(request_id) ON DELETE RESTRICT,
  reprompt_ordinal INTEGER NOT NULL CHECK (reprompt_ordinal BETWEEN 1 AND 4),
  reprompt_kind TEXT NOT NULL CHECK (reprompt_kind IN ('unclear', 'partial', 'wrong', 'keypad')),
  prompted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', prompted_at) IS prompted_at),
  PRIMARY KEY (request_id, reprompt_ordinal)
) STRICT, WITHOUT ROWID;

-- The receipt. It names the capability, the credential and the version that
-- satisfied it, and it is spent by the action it authorised, so a successful
-- PIN authorises that action rather than the rest of the call.
CREATE TABLE owner_action_authorisations (
  authorisation_id TEXT PRIMARY KEY CHECK (
    length(authorisation_id) = 26 AND substr(authorisation_id, 1, 1) BETWEEN '0' AND '7'
    AND authorisation_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  request_id TEXT NOT NULL UNIQUE REFERENCES owner_action_requests(request_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation = 1),
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  capability TEXT NOT NULL REFERENCES capability_tiers(capability) ON DELETE RESTRICT,
  evaluation_id TEXT NOT NULL REFERENCES autonomy_evaluations(evaluation_id) ON DELETE RESTRICT,
  credential TEXT NOT NULL CHECK (credential IN ('call_pin', 'owner_passphrase')),
  credential_version INTEGER NOT NULL CHECK (credential_version BETWEEN 1 AND 2147483647),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 5),
  authorised_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authorised_at) IS authorised_at),
  expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
    AND expires_at > authorised_at
    AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', authorised_at, '+120 seconds')
  ),
  consumed_at TEXT CHECK (
    consumed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS consumed_at
  ),
  FOREIGN KEY (request_id, attempt_ordinal)
    REFERENCES owner_action_attempts(request_id, attempt_ordinal) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER owner_call_pin_verifiers_insert_guard
BEFORE INSERT ON owner_call_pin_verifiers
WHEN NEW.status <> 'staged' OR NEW.status_changed_at <> NEW.created_at OR NOT EXISTS (
  SELECT 1 FROM voice_owner_identity owner
  JOIN principals principal ON principal.principal_id = owner.principal_id
  JOIN channel_identities identity ON identity.identity_id = owner.identity_id
  JOIN device_keys device ON device.device_id = NEW.created_by_device_id
  WHERE owner.singleton_id = 1 AND owner.principal_id = NEW.owner_principal_id
    AND owner.identity_id = NEW.owner_identity_id
    AND principal.principal_type = 'human' AND principal.status = 'active'
    AND identity.principal_id = owner.principal_id AND identity.channel = 'voice'
    AND identity.status = 'active' AND identity.verified_at IS NOT NULL
    AND device.principal_id = NEW.owner_principal_id AND device.key_id = NEW.created_by_key_id
    AND device.key_fingerprint = NEW.created_by_key_fingerprint
    AND device.key_generation = NEW.created_by_key_generation AND device.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_verifier_insert_invalid');
END;

CREATE TRIGGER owner_call_pin_verifiers_transition_guard
BEFORE UPDATE ON owner_call_pin_verifiers
WHEN NEW.owner_principal_id IS NOT OLD.owner_principal_id
  OR NEW.owner_identity_id IS NOT OLD.owner_identity_id
  OR NEW.pin_version IS NOT OLD.pin_version
  OR NEW.algorithm IS NOT OLD.algorithm
  OR NEW.domain_version IS NOT OLD.domain_version
  OR NEW.pepper_version IS NOT OLD.pepper_version
  OR NEW.iterations IS NOT OLD.iterations
  OR NEW.salt IS NOT OLD.salt
  OR NEW.digest IS NOT OLD.digest
  OR NEW.created_by_device_id IS NOT OLD.created_by_device_id
  OR NEW.created_by_key_id IS NOT OLD.created_by_key_id
  OR NEW.created_by_key_fingerprint IS NOT OLD.created_by_key_fingerprint
  OR NEW.created_by_key_generation IS NOT OLD.created_by_key_generation
  OR NEW.created_at IS NOT OLD.created_at
  OR NOT (
    NEW.status = 'active' AND OLD.status = 'staged' AND EXISTS (
      SELECT 1 FROM owner_call_pin_rotation_commits commit_row
      WHERE commit_row.owner_identity_id = OLD.owner_identity_id
        AND commit_row.owner_principal_id = OLD.owner_principal_id
        AND commit_row.new_pin_version = OLD.pin_version
        AND commit_row.committed_at = NEW.status_changed_at
    )
    OR NEW.status = 'revoked' AND OLD.status = 'active' AND EXISTS (
      SELECT 1 FROM owner_call_pin_rotation_commits commit_row
      WHERE commit_row.owner_identity_id = OLD.owner_identity_id
        AND commit_row.owner_principal_id = OLD.owner_principal_id
        AND commit_row.expected_pin_version = OLD.pin_version
        AND commit_row.committed_at = NEW.status_changed_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_verifier_transition_invalid');
END;

CREATE TRIGGER owner_call_pin_verifiers_delete_forbidden
BEFORE DELETE ON owner_call_pin_verifiers
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_verifier_delete_forbidden');
END;

CREATE TRIGGER owner_call_pin_rotation_commits_insert_guard
BEFORE INSERT ON owner_call_pin_rotation_commits
WHEN NOT EXISTS (
  SELECT 1 FROM voice_owner_identity owner
  JOIN principals principal ON principal.principal_id = owner.principal_id
  JOIN channel_identities identity ON identity.identity_id = owner.identity_id
  WHERE owner.singleton_id = 1 AND owner.principal_id = NEW.owner_principal_id
    AND owner.identity_id = NEW.owner_identity_id
    AND principal.principal_type = 'human' AND principal.status = 'active'
    AND identity.principal_id = owner.principal_id AND identity.channel = 'voice'
    AND identity.status = 'active' AND identity.verified_at IS NOT NULL
) OR (
  NEW.expected_pin_version IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM owner_call_pin_verifiers verifier
    WHERE verifier.owner_identity_id = NEW.owner_identity_id
      AND verifier.owner_principal_id = NEW.owner_principal_id
      AND verifier.pin_version = NEW.expected_pin_version
      AND verifier.status = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_rotation_state_changed');
END;

CREATE TRIGGER owner_call_pin_rotation_commits_immutable
BEFORE UPDATE ON owner_call_pin_rotation_commits
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_rotation_commit_immutable');
END;

CREATE TRIGGER owner_call_pin_rotation_commits_delete_forbidden
BEFORE DELETE ON owner_call_pin_rotation_commits
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_rotation_commit_delete_forbidden');
END;

CREATE TRIGGER owner_call_pin_rotation_commit_publish
AFTER INSERT ON owner_call_pin_rotation_commits
BEGIN
  UPDATE owner_call_pin_verifiers
  SET status = 'revoked', status_changed_at = NEW.committed_at
  WHERE owner_identity_id = NEW.owner_identity_id
    AND pin_version = NEW.expected_pin_version
    AND status = 'active';

  UPDATE owner_call_pin_verifiers
  SET status = 'active', status_changed_at = NEW.committed_at
  WHERE owner_identity_id = NEW.owner_identity_id
    AND pin_version = NEW.new_pin_version
    AND status = 'staged';
END;

CREATE TRIGGER owner_call_pin_heads_insert_guard
BEFORE INSERT ON owner_call_pin_heads
WHEN NEW.singleton_id <> 1 OR NOT EXISTS (
  SELECT 1 FROM owner_call_pin_rotation_commits commit_row
  JOIN owner_call_pin_verifiers verifier
    ON verifier.owner_identity_id = commit_row.owner_identity_id
    AND verifier.pin_version = commit_row.new_pin_version
  WHERE commit_row.owner_principal_id = NEW.owner_principal_id
    AND commit_row.owner_identity_id = NEW.owner_identity_id
    AND commit_row.expected_pin_version IS NULL
    AND commit_row.new_pin_version = NEW.pin_version
    AND commit_row.committed_at = NEW.updated_at
    AND verifier.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_head_insert_invalid');
END;

CREATE TRIGGER owner_call_pin_heads_update_guard
BEFORE UPDATE ON owner_call_pin_heads
WHEN NEW.singleton_id IS NOT OLD.singleton_id
  OR NEW.owner_principal_id IS NOT OLD.owner_principal_id
  OR NEW.owner_identity_id IS NOT OLD.owner_identity_id
  OR NOT EXISTS (
    SELECT 1 FROM owner_call_pin_rotation_commits commit_row
    JOIN owner_call_pin_verifiers verifier
      ON verifier.owner_identity_id = commit_row.owner_identity_id
      AND verifier.pin_version = commit_row.new_pin_version
    WHERE commit_row.owner_principal_id = OLD.owner_principal_id
      AND commit_row.owner_identity_id = OLD.owner_identity_id
      AND commit_row.expected_pin_version = OLD.pin_version
      AND commit_row.new_pin_version = NEW.pin_version
      AND commit_row.committed_at = NEW.updated_at
      AND verifier.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_head_update_invalid');
END;

CREATE TRIGGER owner_call_pin_heads_delete_forbidden
BEFORE DELETE ON owner_call_pin_heads
BEGIN
  SELECT RAISE(ABORT, 'owner_call_pin_head_delete_forbidden');
END;

CREATE TRIGGER owner_action_requests_insert_guard
BEFORE INSERT ON owner_action_requests
WHEN NOT EXISTS (
  SELECT 1 FROM call_sessions session
  JOIN voice_owner_identity owner ON owner.principal_id = session.principal_id
  WHERE session.session_id = NEW.session_id
    AND session.principal_id = NEW.owner_principal_id AND session.identity_id = NEW.owner_identity_id
    AND session.access_kind = 'owner'
    AND owner.singleton_id = 1 AND owner.identity_id = session.identity_id
)
BEGIN
  SELECT RAISE(ABORT, 'owner_action_request_invalid');
END;

CREATE TRIGGER owner_action_requests_transition_guard
BEFORE UPDATE ON owner_action_requests
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
  OR NEW.owner_principal_id IS NOT OLD.owner_principal_id
  OR NEW.owner_identity_id IS NOT OLD.owner_identity_id
  OR NEW.capability IS NOT OLD.capability
  OR NEW.evaluation_id IS NOT OLD.evaluation_id
  OR NEW.explanation IS NOT OLD.explanation
  OR NEW.opened_at IS NOT OLD.opened_at
  OR NEW.deadline_at IS NOT OLD.deadline_at
  OR OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'owner_action_request_transition_invalid');
END;

CREATE TRIGGER owner_action_requests_delete_forbidden
BEFORE DELETE ON owner_action_requests
BEGIN
  SELECT RAISE(ABORT, 'owner_action_request_delete_forbidden');
END;

-- An attempt belongs to the open question it answers and nobody else. Its
-- ordinal is supplied by the writer, so this is what stops a fresh request
-- starting again at one and quietly granting a sixth try.
CREATE TRIGGER owner_action_attempts_insert_guard
BEFORE INSERT ON owner_action_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM owner_action_requests request
  WHERE request.request_id = NEW.request_id AND request.outcome IS NULL
) OR NEW.attempt_ordinal <> (
  SELECT coalesce(max(existing.attempt_ordinal), 0) + 1 FROM owner_action_attempts existing
  WHERE existing.request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'owner_action_attempt_invalid');
END;

CREATE TRIGGER owner_action_attempts_transition_guard
BEFORE UPDATE ON owner_action_attempts
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.attempt_ordinal IS NOT OLD.attempt_ordinal
  OR NEW.method IS NOT OLD.method
  OR NEW.attempted_at IS NOT OLD.attempted_at
  OR OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'owner_action_attempt_transition_invalid');
END;

CREATE TRIGGER owner_action_attempts_delete_forbidden
BEFORE DELETE ON owner_action_attempts
BEGIN
  SELECT RAISE(ABORT, 'owner_action_attempt_delete_forbidden');
END;

-- The fifth mismatch is what refuses the action. Writing the outcome here
-- rather than trusting the caller means a call cannot be left holding an open
-- question it has already used every attempt on. It is an insert trigger
-- because an attempt is recorded once, complete with what it settled as, and
-- a matched fifth attempt must not refuse an action the receipt will
-- authorise.
CREATE TRIGGER owner_action_attempts_publish_exhaustion
AFTER INSERT ON owner_action_attempts
WHEN NEW.outcome = 'mismatched' AND (
  SELECT count(*) FROM owner_action_attempts existing WHERE existing.request_id = NEW.request_id
) >= 5
BEGIN
  UPDATE owner_action_requests
  SET outcome = 'refused', resolved_at = NEW.resolved_at
  WHERE request_id = NEW.request_id AND outcome IS NULL;
END;

-- The same ceiling for an attempt that was reserved before the verifier ran
-- and settled after it. Both shapes exist because the reservation is what
-- fails closed: a writer that settles in one statement is still held to the
-- ceiling by the insert form, and the writer that reserves first is held to
-- it here rather than by trusting itself to notice.
CREATE TRIGGER owner_action_attempts_settlement_exhaustion
AFTER UPDATE ON owner_action_attempts
WHEN OLD.outcome IS NULL AND NEW.outcome = 'mismatched' AND (
  SELECT count(*) FROM owner_action_attempts existing WHERE existing.request_id = NEW.request_id
) >= 5
BEGIN
  UPDATE owner_action_requests
  SET outcome = 'refused', resolved_at = NEW.resolved_at
  WHERE request_id = NEW.request_id AND outcome IS NULL;
END;

CREATE TRIGGER owner_action_reprompts_insert_guard
BEFORE INSERT ON owner_action_reprompts
WHEN EXISTS (
  SELECT 1 FROM owner_action_reprompts existing
  WHERE existing.request_id = NEW.request_id AND existing.reprompt_kind = NEW.reprompt_kind
)
BEGIN
  SELECT RAISE(ABORT, 'owner_action_reprompt_repeated');
END;

CREATE TRIGGER owner_action_reprompts_immutable
BEFORE UPDATE ON owner_action_reprompts
BEGIN
  SELECT RAISE(ABORT, 'owner_action_reprompt_immutable');
END;

CREATE TRIGGER owner_action_reprompts_delete_forbidden
BEFORE DELETE ON owner_action_reprompts
BEGIN
  SELECT RAISE(ABORT, 'owner_action_reprompt_delete_forbidden');
END;

-- The receipt is refused unless the capability really is tier 3, the question
-- really is the one it answers, the attempt really matched, the credential
-- really is the active one and the request is still open and inside its
-- window. Every one of those is a fact another table already holds, so the
-- trigger re-reads them rather than trusting the caller's summary.
CREATE TRIGGER owner_action_authorisations_insert_guard
BEFORE INSERT ON owner_action_authorisations
WHEN NOT EXISTS (
  SELECT 1 FROM capability_tiers tier
  WHERE tier.capability = NEW.capability AND tier.tier = 3
) OR NOT EXISTS (
  SELECT 1 FROM owner_action_requests request
  JOIN owner_action_attempts attempt ON attempt.request_id = request.request_id
    AND attempt.attempt_ordinal = NEW.attempt_ordinal
  WHERE request.request_id = NEW.request_id
    AND request.session_id = NEW.session_id
    AND request.lifecycle_generation = NEW.lifecycle_generation
    AND request.owner_principal_id = NEW.owner_principal_id
    AND request.owner_identity_id = NEW.owner_identity_id
    AND request.capability = NEW.capability
    AND request.evaluation_id = NEW.evaluation_id
    AND request.outcome IS NULL
    AND NEW.authorised_at >= request.opened_at AND NEW.authorised_at <= request.deadline_at
    AND attempt.outcome = 'matched' AND attempt.resolved_at <= NEW.authorised_at
) OR (
  NEW.credential = 'call_pin' AND NOT EXISTS (
    SELECT 1 FROM owner_call_pin_heads head
    JOIN owner_call_pin_verifiers verifier
      ON verifier.owner_identity_id = head.owner_identity_id AND verifier.pin_version = head.pin_version
    WHERE head.singleton_id = 1 AND head.owner_principal_id = NEW.owner_principal_id
      AND head.owner_identity_id = NEW.owner_identity_id
      AND verifier.pin_version = NEW.credential_version AND verifier.status = 'active'
  )
) OR (
  NEW.credential = 'owner_passphrase' AND NOT EXISTS (
    SELECT 1 FROM owner_passphrase_heads head
    JOIN owner_passphrase_verifiers verifier
      ON verifier.owner_identity_id = head.owner_identity_id
      AND verifier.verifier_version = head.verifier_version
    WHERE head.singleton_id = 1 AND head.status = 'active' AND verifier.status = 'active'
      AND head.owner_principal_id = NEW.owner_principal_id
      AND head.owner_identity_id = NEW.owner_identity_id
      AND verifier.verifier_version = NEW.credential_version
  )
)
BEGIN
  SELECT RAISE(ABORT, 'owner_action_authorisation_invalid');
END;

CREATE TRIGGER owner_action_authorisations_publish
AFTER INSERT ON owner_action_authorisations
BEGIN
  UPDATE owner_action_requests
  SET outcome = 'authorised', resolved_at = NEW.authorised_at
  WHERE request_id = NEW.request_id AND outcome IS NULL;
END;

-- Spending is one-way. A consumed receipt can never be un-consumed and a
-- fresh one can never be edited into covering a different capability, because
-- every other column is immutable here.
CREATE TRIGGER owner_action_authorisations_consume_guard
BEFORE UPDATE ON owner_action_authorisations
WHEN NEW.authorisation_id IS NOT OLD.authorisation_id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
  OR NEW.owner_principal_id IS NOT OLD.owner_principal_id
  OR NEW.owner_identity_id IS NOT OLD.owner_identity_id
  OR NEW.capability IS NOT OLD.capability
  OR NEW.evaluation_id IS NOT OLD.evaluation_id
  OR NEW.credential IS NOT OLD.credential
  OR NEW.credential_version IS NOT OLD.credential_version
  OR NEW.attempt_ordinal IS NOT OLD.attempt_ordinal
  OR NEW.authorised_at IS NOT OLD.authorised_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.consumed_at IS NOT NULL
  OR NEW.consumed_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'owner_action_authorisation_consume_invalid');
END;

CREATE TRIGGER owner_action_authorisations_delete_forbidden
BEFORE DELETE ON owner_action_authorisations
BEGIN
  SELECT RAISE(ABORT, 'owner_action_authorisation_delete_forbidden');
END;

-- Owner admission loses its credential check here. The guard it keeps is the
-- one that was always doing the real work: the session must name the verified
-- voice identity of the owner it claims. The guest branch is unchanged.
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

-- Booking, changing who can reach Jarvis or how it behaves, and reading out a
-- memory the owner marked sensitive were the three sensitive categories with
-- no tier yet. They join the list here rather than in a second list beside
-- it, and the ids are the ones the call session already authorises, so the
-- two channels cannot disagree about what is sensitive.
INSERT INTO capability_tiers (capability, tier, description, updated_at) VALUES
  ('book.service', 3, 'Book, reserve or commit the owner to a place or a time', '2026-09-17T00:00:00.000Z'),
  ('access.manage', 3, 'Change who can reach Jarvis', '2026-09-17T00:00:00.000Z'),
  ('credentials.manage', 3, 'Change a guest PIN or another credential that reaches Jarvis', '2026-09-17T00:00:00.000Z'),
  ('safety.configure', 3, 'Change a security or autonomy setting', '2026-09-17T00:00:00.000Z'),
  ('disclose.sensitive_memory', 3, 'Read out a memory the owner marked sensitive', '2026-09-17T00:00:00.000Z');

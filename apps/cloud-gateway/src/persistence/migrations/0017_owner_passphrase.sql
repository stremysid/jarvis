-- R1 owner-passphrase verifier state. Migration 0016 is reserved by R2.
-- Plaintext words never enter these tables. A staged verifier becomes active
-- only through an immutable rotation receipt whose trigger rechecks the owner,
-- device key and compare-and-swap head in the same D1 transaction.
CREATE TABLE owner_passphrase_verifiers (
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  verifier_version INTEGER NOT NULL CHECK (verifier_version BETWEEN 1 AND 2147483647),
  algorithm TEXT NOT NULL CHECK (algorithm = 'hmac-sha256-pepper+pbkdf2-hmac-sha256'),
  domain_version TEXT NOT NULL CHECK (domain_version = 'v1'),
  word_list_version TEXT NOT NULL CHECK (word_list_version = 'eff-long-cmudict-2026-09-v1'),
  pepper_version TEXT NOT NULL CHECK (pepper_version = 'v1'),
  iterations INTEGER NOT NULL CHECK (iterations = 600000),
  salt BLOB NOT NULL CHECK (typeof(salt) = 'blob' AND length(salt) = 16),
  digest BLOB NOT NULL CHECK (typeof(digest) = 'blob' AND length(digest) = 32),
  status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'superseded', 'revoked')),
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
  PRIMARY KEY (owner_identity_id, verifier_version)
) STRICT;

CREATE TABLE owner_passphrase_rotation_commits (
  commit_id TEXT PRIMARY KEY CHECK (
    length(commit_id) = 26 AND substr(commit_id, 1, 1) BETWEEN '0' AND '7'
    AND commit_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  expected_verifier_version INTEGER CHECK (
    expected_verifier_version IS NULL OR expected_verifier_version BETWEEN 1 AND 2147483646
  ),
  new_verifier_version INTEGER NOT NULL CHECK (new_verifier_version BETWEEN 1 AND 2147483647),
  committed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', committed_at) IS committed_at),
  UNIQUE (owner_identity_id, new_verifier_version),
  CHECK ((expected_verifier_version IS NULL AND new_verifier_version = 1)
    OR (expected_verifier_version IS NOT NULL AND new_verifier_version = expected_verifier_version + 1))
) STRICT;

CREATE TABLE owner_passphrase_heads (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner_principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_identity_id TEXT NOT NULL UNIQUE REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  verifier_version INTEGER NOT NULL CHECK (verifier_version BETWEEN 1 AND 2147483647),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  FOREIGN KEY (owner_identity_id, verifier_version)
    REFERENCES owner_passphrase_verifiers(owner_identity_id, verifier_version) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER owner_passphrase_verifiers_insert_guard
BEFORE INSERT ON owner_passphrase_verifiers
WHEN NEW.status <> 'staged' OR NEW.status_changed_at <> NEW.created_at OR NOT EXISTS (
  SELECT 1 FROM voice_owner_identity owner
  JOIN principals principal ON principal.principal_id = owner.principal_id
  JOIN channel_identities identity ON identity.identity_id = owner.identity_id
    AND identity.principal_id = owner.principal_id
  JOIN device_keys device ON device.device_id = NEW.created_by_device_id
    AND device.principal_id = owner.principal_id
  WHERE owner.singleton_id = 1
    AND owner.principal_id = NEW.owner_principal_id
    AND owner.identity_id = NEW.owner_identity_id
    AND principal.principal_type = 'human' AND principal.status = 'active'
    AND identity.channel = 'voice' AND identity.status = 'active' AND identity.verified_at IS NOT NULL
    AND device.status = 'active'
    AND device.key_id = NEW.created_by_key_id
    AND device.key_fingerprint = NEW.created_by_key_fingerprint
    AND device.key_generation = NEW.created_by_key_generation
)
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_verifier_insert_invalid');
END;

CREATE TRIGGER owner_passphrase_verifiers_transition_guard
BEFORE UPDATE ON owner_passphrase_verifiers
WHEN NEW.owner_principal_id IS NOT OLD.owner_principal_id
  OR NEW.owner_identity_id IS NOT OLD.owner_identity_id
  OR NEW.verifier_version IS NOT OLD.verifier_version
  OR NEW.algorithm IS NOT OLD.algorithm
  OR NEW.domain_version IS NOT OLD.domain_version
  OR NEW.word_list_version IS NOT OLD.word_list_version
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
    OLD.status = 'staged' AND NEW.status = 'active'
    AND EXISTS (
      SELECT 1 FROM owner_passphrase_rotation_commits commit_row
      WHERE commit_row.owner_principal_id = OLD.owner_principal_id
        AND commit_row.owner_identity_id = OLD.owner_identity_id
        AND commit_row.new_verifier_version = OLD.verifier_version
        AND commit_row.committed_at = NEW.status_changed_at
    )
    OR OLD.status = 'active' AND NEW.status = 'superseded'
    AND EXISTS (
      SELECT 1 FROM owner_passphrase_rotation_commits commit_row
      WHERE commit_row.owner_principal_id = OLD.owner_principal_id
        AND commit_row.owner_identity_id = OLD.owner_identity_id
        AND commit_row.expected_verifier_version = OLD.verifier_version
        AND commit_row.committed_at = NEW.status_changed_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_verifier_transition_invalid');
END;

CREATE TRIGGER owner_passphrase_verifiers_delete_forbidden
BEFORE DELETE ON owner_passphrase_verifiers
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_verifier_delete_forbidden');
END;

CREATE TRIGGER owner_passphrase_rotation_commit_guard
BEFORE INSERT ON owner_passphrase_rotation_commits
WHEN NOT EXISTS (
  SELECT 1 FROM owner_passphrase_verifiers verifier
  JOIN voice_owner_identity owner ON owner.principal_id = verifier.owner_principal_id
    AND owner.identity_id = verifier.owner_identity_id
  JOIN principals principal ON principal.principal_id = owner.principal_id
  JOIN channel_identities identity ON identity.identity_id = owner.identity_id
    AND identity.principal_id = owner.principal_id
  JOIN device_keys device ON device.device_id = verifier.created_by_device_id
    AND device.principal_id = verifier.owner_principal_id
  WHERE verifier.owner_principal_id = NEW.owner_principal_id
    AND verifier.owner_identity_id = NEW.owner_identity_id
    AND verifier.verifier_version = NEW.new_verifier_version
    AND verifier.status = 'staged'
    AND verifier.created_at <= NEW.committed_at
    AND principal.principal_type = 'human' AND principal.status = 'active'
    AND identity.channel = 'voice' AND identity.status = 'active' AND identity.verified_at IS NOT NULL
    AND device.status = 'active'
    AND device.key_id = verifier.created_by_key_id
    AND device.key_fingerprint = verifier.created_by_key_fingerprint
    AND device.key_generation = verifier.created_by_key_generation
) OR (
  NEW.expected_verifier_version IS NULL AND EXISTS (SELECT 1 FROM owner_passphrase_heads)
) OR (
  NEW.expected_verifier_version IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM owner_passphrase_heads head
    JOIN owner_passphrase_verifiers active
      ON active.owner_identity_id = head.owner_identity_id
      AND active.verifier_version = head.verifier_version
    WHERE head.singleton_id = 1
      AND head.owner_principal_id = NEW.owner_principal_id
      AND head.owner_identity_id = NEW.owner_identity_id
      AND head.verifier_version = NEW.expected_verifier_version
      AND head.status = 'active' AND active.status = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_rotation_state_changed');
END;

CREATE TRIGGER owner_passphrase_rotation_commit_publish
AFTER INSERT ON owner_passphrase_rotation_commits
BEGIN
  UPDATE owner_passphrase_verifiers
  SET status = 'superseded', status_changed_at = NEW.committed_at
  WHERE owner_identity_id = NEW.owner_identity_id
    AND verifier_version = NEW.expected_verifier_version
    AND status = 'active';

  UPDATE owner_passphrase_verifiers
  SET status = 'active', status_changed_at = NEW.committed_at
  WHERE owner_identity_id = NEW.owner_identity_id
    AND verifier_version = NEW.new_verifier_version
    AND status = 'staged';

  INSERT INTO owner_passphrase_heads (
    singleton_id, owner_principal_id, owner_identity_id, verifier_version, status, updated_at
  )
  SELECT 1, NEW.owner_principal_id, NEW.owner_identity_id, NEW.new_verifier_version, 'active', NEW.committed_at
  WHERE NEW.expected_verifier_version IS NULL;

  UPDATE owner_passphrase_heads
  SET verifier_version = NEW.new_verifier_version, status = 'active', updated_at = NEW.committed_at
  WHERE singleton_id = 1 AND NEW.expected_verifier_version IS NOT NULL;
END;

CREATE TRIGGER owner_passphrase_rotation_commits_immutable
BEFORE UPDATE ON owner_passphrase_rotation_commits
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_rotation_commit_immutable');
END;

CREATE TRIGGER owner_passphrase_rotation_commits_delete_forbidden
BEFORE DELETE ON owner_passphrase_rotation_commits
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_rotation_commit_delete_forbidden');
END;

CREATE TRIGGER owner_passphrase_heads_insert_guard
BEFORE INSERT ON owner_passphrase_heads
WHEN NEW.singleton_id <> 1 OR NEW.status <> 'active' OR NOT EXISTS (
  SELECT 1 FROM owner_passphrase_rotation_commits commit_row
  JOIN owner_passphrase_verifiers verifier
    ON verifier.owner_identity_id = commit_row.owner_identity_id
    AND verifier.verifier_version = commit_row.new_verifier_version
  WHERE commit_row.owner_principal_id = NEW.owner_principal_id
    AND commit_row.owner_identity_id = NEW.owner_identity_id
    AND commit_row.expected_verifier_version IS NULL
    AND commit_row.new_verifier_version = NEW.verifier_version
    AND commit_row.committed_at = NEW.updated_at
    AND verifier.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_head_insert_invalid');
END;

CREATE TRIGGER owner_passphrase_heads_update_guard
BEFORE UPDATE ON owner_passphrase_heads
WHEN NEW.singleton_id IS NOT OLD.singleton_id
  OR NEW.owner_principal_id IS NOT OLD.owner_principal_id
  OR NEW.owner_identity_id IS NOT OLD.owner_identity_id
  OR NEW.status <> 'active'
  OR NOT EXISTS (
    SELECT 1 FROM owner_passphrase_rotation_commits commit_row
    JOIN owner_passphrase_verifiers verifier
      ON verifier.owner_identity_id = commit_row.owner_identity_id
      AND verifier.verifier_version = commit_row.new_verifier_version
    WHERE commit_row.owner_principal_id = OLD.owner_principal_id
      AND commit_row.owner_identity_id = OLD.owner_identity_id
      AND commit_row.expected_verifier_version = OLD.verifier_version
      AND commit_row.new_verifier_version = NEW.verifier_version
      AND commit_row.committed_at = NEW.updated_at
      AND verifier.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_head_update_invalid');
END;

CREATE TRIGGER owner_passphrase_heads_delete_forbidden
BEFORE DELETE ON owner_passphrase_heads
BEGIN
  SELECT RAISE(ABORT, 'owner_passphrase_head_delete_forbidden');
END;

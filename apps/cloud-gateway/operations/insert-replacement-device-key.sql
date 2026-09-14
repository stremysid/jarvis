-- Owner operation: add one replacement device key without revoking the current key.
-- Render only the five public placeholders below as documented in
-- docs/runbooks/device-key-replacement.md. Never put private key material here.
PRAGMA foreign_keys = ON;

INSERT INTO device_keys (
  device_id,
  principal_id,
  key_id,
  public_key_base64,
  key_fingerprint,
  key_generation,
  algorithm,
  status,
  device_label,
  bootstrap_metadata_hash,
  created_at,
  revoked_at
)
SELECT
  '__NEW_DEVICE_ID__',
  p.principal_id,
  '__NEW_KEY_ID__',
  '__NEW_PUBLIC_KEY_BASE64__',
  '__NEW_KEY_FINGERPRINT__',
  1,
  'ed25519',
  'active',
  'jarvis-home-pc',
  '__NEW_BOOTSTRAP_METADATA_HASH__',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM principals p
JOIN device_keys old ON old.principal_id = p.principal_id
WHERE p.principal_type = 'human'
  AND p.status = 'active'
  AND old.status = 'active'
  AND old.revoked_at IS NULL
  AND old.device_label = 'jarvis-local-agent'
  AND (SELECT COUNT(*) FROM principals WHERE principal_type = 'human') = 1
  AND (
    SELECT COUNT(*) FROM device_keys current
    WHERE current.principal_id = p.principal_id AND current.status = 'active'
  ) = 1
  AND NOT EXISTS (
    SELECT 1 FROM device_keys collision
    WHERE collision.device_id = '__NEW_DEVICE_ID__'
      OR collision.key_id = '__NEW_KEY_ID__'
      OR collision.public_key_base64 = '__NEW_PUBLIC_KEY_BASE64__'
      OR collision.key_fingerprint = '__NEW_KEY_FINGERPRINT__'
  )
  AND NOT EXISTS (
    SELECT 1 FROM consumer_cursors
    WHERE consumer_name = 'device:' || '__NEW_DEVICE_ID__'
  );

INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at)
SELECT 'device:' || d.device_id, 0, d.created_at
FROM device_keys d
JOIN principals p ON p.principal_id = d.principal_id
WHERE d.device_id = '__NEW_DEVICE_ID__'
  AND d.key_id = '__NEW_KEY_ID__'
  AND d.public_key_base64 = '__NEW_PUBLIC_KEY_BASE64__'
  AND d.key_fingerprint = '__NEW_KEY_FINGERPRINT__'
  AND d.key_generation = 1
  AND d.algorithm = 'ed25519'
  AND d.status = 'active'
  AND d.revoked_at IS NULL
  AND d.device_label = 'jarvis-home-pc'
  AND d.bootstrap_metadata_hash = '__NEW_BOOTSTRAP_METADATA_HASH__'
  AND p.principal_type = 'human'
  AND p.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM consumer_cursors
    WHERE consumer_name = 'device:' || d.device_id
  );

SELECT
  CASE WHEN EXISTS (
    SELECT 1
    FROM device_keys replacement
    JOIN principals p ON p.principal_id = replacement.principal_id
    JOIN consumer_cursors cursor_row
      ON cursor_row.consumer_name = 'device:' || replacement.device_id
    WHERE replacement.device_id = '__NEW_DEVICE_ID__'
      AND replacement.key_id = '__NEW_KEY_ID__'
      AND replacement.public_key_base64 = '__NEW_PUBLIC_KEY_BASE64__'
      AND replacement.key_fingerprint = '__NEW_KEY_FINGERPRINT__'
      AND replacement.key_generation = 1
      AND replacement.algorithm = 'ed25519'
      AND replacement.status = 'active'
      AND replacement.revoked_at IS NULL
      AND replacement.device_label = 'jarvis-home-pc'
      AND replacement.bootstrap_metadata_hash = '__NEW_BOOTSTRAP_METADATA_HASH__'
      AND p.principal_type = 'human'
      AND p.status = 'active'
  ) THEN 'replacement_ready' ELSE 'replacement_not_ready' END AS replacement_state;

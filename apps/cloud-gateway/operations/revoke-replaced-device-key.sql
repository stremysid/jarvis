-- Owner operation: revoke the former key only after the exact replacement and
-- its sync cursor exist. Render the same five public placeholders used for the
-- insert operation. Never put private key material here.
PRAGMA foreign_keys = ON;

UPDATE device_keys AS old
SET status = 'revoked',
    revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE old.status = 'active'
  AND old.revoked_at IS NULL
  AND old.device_label = 'jarvis-local-agent'
  AND EXISTS (
    SELECT 1
    FROM principals p
    WHERE p.principal_id = old.principal_id
      AND p.principal_type = 'human'
      AND p.status = 'active'
  )
  AND (SELECT COUNT(*) FROM principals WHERE principal_type = 'human') = 1
  AND (
    SELECT COUNT(*) FROM device_keys current
    WHERE current.principal_id = old.principal_id AND current.status = 'active'
  ) = 2
  AND EXISTS (
    SELECT 1
    FROM device_keys replacement
    JOIN consumer_cursors cursor_row
      ON cursor_row.consumer_name = 'device:' || replacement.device_id
    WHERE replacement.principal_id = old.principal_id
      AND replacement.device_id = '__NEW_DEVICE_ID__'
      AND replacement.key_id = '__NEW_KEY_ID__'
      AND replacement.public_key_base64 = '__NEW_PUBLIC_KEY_BASE64__'
      AND replacement.key_fingerprint = '__NEW_KEY_FINGERPRINT__'
      AND replacement.key_generation = 1
      AND replacement.algorithm = 'ed25519'
      AND replacement.status = 'active'
      AND replacement.revoked_at IS NULL
      AND replacement.device_label = 'jarvis-home-pc'
      AND replacement.bootstrap_metadata_hash = '__NEW_BOOTSTRAP_METADATA_HASH__'
  );

SELECT
  CASE WHEN EXISTS (
    SELECT 1
    FROM device_keys replacement
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
      AND EXISTS (
        SELECT 1 FROM device_keys old
        WHERE old.principal_id = replacement.principal_id
          AND old.device_label = 'jarvis-local-agent'
          AND old.status = 'revoked'
          AND old.revoked_at IS NOT NULL
      )
  ) THEN 'replacement_complete' ELSE 'replacement_not_complete' END AS replacement_state;

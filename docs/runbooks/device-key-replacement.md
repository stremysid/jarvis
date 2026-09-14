# Replace the production owner device key

This is the one-time owner procedure selected for R1 phone enrollment. It adds
a newly generated, DPAPI-sealed key from Sid's home PC to the existing human
principal, proves that exact key through the reviewed phone-enrollment
preflight, and only then revokes the orphaned `jarvis-local-agent` row.

This runbook changes production authentication state. Reading checks and
generating the local key do not change production. Inserting the replacement
and revoking the old device are two separate owner-approved actions. Do not run
either write while reviewing this document.

Until the runbook PR merges, read this file and its two SQL files from the PR
branch rather than `main`. The procedure adds no migration and deploys no code.
Cloudflare documents `wrangler d1 execute --file` for SQL files and advises
removing explicit `BEGIN TRANSACTION` and `COMMIT` statements because the D1
execution path manages the statements. The operation files therefore contain
no explicit transaction wrapper:

- <https://developers.cloudflare.com/d1/wrangler-commands/>
- <https://developers.cloudflare.com/d1/best-practices/import-export-data/>

## Stop conditions

Stop without changing production if any required count differs from the value
below, a command reports an error, a rendered SQL file retains a placeholder,
or the phone-enrollment preflight does not report an exact active-key match.
Do not repair a surprising row with ad hoc SQL. Preserve the old active device
and return the read-only output to review.

Never copy, upload, print, or paste the sealed key file. The only values placed
in SQL are a device ID, a key ID, the public Ed25519 key, its public fingerprint,
and a public bootstrap metadata hash. The phone number is not part of this
procedure.

## 1. Read-only production checks

From the repository root on Sid's Windows 11 home PC, use PowerShell 7. These
commands are read-only:

```powershell
$Precheck = @'
SELECT
  (SELECT COUNT(*) FROM principals WHERE principal_type = 'human') AS human_principals,
  (SELECT COUNT(*) FROM principals WHERE principal_type = 'human' AND status = 'active') AS active_humans,
  (SELECT COUNT(*) FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
    WHERE p.principal_type = 'human' AND p.status = 'active' AND d.status = 'active') AS active_owner_devices,
  (SELECT COUNT(*) FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
    WHERE p.principal_type = 'human' AND p.status = 'active' AND d.status = 'active'
      AND d.device_label = 'jarvis-local-agent' AND d.revoked_at IS NULL) AS expected_old_devices;
'@
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command $Precheck
```

Require exactly `1` for all four columns. Then identify the public old-device
record:

```powershell
$OldDevice = @'
SELECT p.principal_id, d.device_id, d.key_id, d.key_fingerprint, d.key_generation,
       d.algorithm, d.status, d.device_label, d.created_at, d.revoked_at
FROM device_keys d
JOIN principals p ON p.principal_id = d.principal_id
WHERE p.principal_type = 'human' AND p.status = 'active'
  AND d.status = 'active' AND d.device_label = 'jarvis-local-agent';
'@
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command $OldDevice
```

Inventory every table that stores the old device ID. Nonzero historical counts
are not themselves an error because this procedure revokes the row rather than
deleting it. The three live-work columns at the end must all be `0` before the
old key is revoked.

```powershell
$References = @'
WITH old AS (
  SELECT d.device_id
  FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
  WHERE p.principal_type = 'human' AND p.status = 'active'
    AND d.status = 'active' AND d.device_label = 'jarvis-local-agent'
)
SELECT
  (SELECT COUNT(*) FROM channel_identities WHERE enrolled_by_device_id IN (SELECT device_id FROM old)) AS channel_identities,
  (SELECT COUNT(*) FROM identity_challenges WHERE initiating_device_id IN (SELECT device_id FROM old)) AS identity_challenges,
  (SELECT COUNT(*) FROM sync_snapshots WHERE device_id IN (SELECT device_id FROM old)) AS sync_snapshots,
  (SELECT COUNT(*) FROM sync_ack_receipts WHERE device_id IN (SELECT device_id FROM old)) AS sync_ack_receipts,
  (SELECT COUNT(*) FROM bootstrap_tokens WHERE device_id IN (SELECT device_id FROM old)) AS bootstrap_tokens,
  (SELECT COUNT(*) FROM request_nonces WHERE device_id IN (SELECT device_id FROM old)) AS request_nonces,
  (SELECT COUNT(*) FROM memory_fact_projection_abandoned WHERE device_id IN (SELECT device_id FROM old)) AS projection_abandoned,
  (SELECT COUNT(*) FROM memory_fact_projection_heads WHERE device_id IN (SELECT device_id FROM old)) AS projection_heads,
  (SELECT COUNT(*) FROM memory_fact_projection_versions WHERE device_id IN (SELECT device_id FROM old)) AS projection_versions,
  (SELECT COUNT(*) FROM memory_fact_projection_pages WHERE device_id IN (SELECT device_id FROM old)) AS projection_pages,
  (SELECT COUNT(*) FROM memory_fact_projection_facts WHERE device_id IN (SELECT device_id FROM old)) AS projection_facts,
  (SELECT COUNT(*) FROM memory_fact_projection_commits WHERE device_id IN (SELECT device_id FROM old)) AS projection_commits,
  (SELECT COUNT(*) FROM identity_challenges
    WHERE initiating_device_id IN (SELECT device_id FROM old) AND consumed_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS live_challenges,
  (SELECT COUNT(*) FROM sync_snapshots
    WHERE device_id IN (SELECT device_id FROM old) AND acknowledged_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS live_snapshots,
  (SELECT COUNT(*) FROM memory_fact_projection_versions
    WHERE device_id IN (SELECT device_id FROM old) AND status = 'staged') AS staged_projection_versions;
'@
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command $References
```

## 2. Generate the new home-PC key and render the reviewed SQL

Use a new device ID and a fresh key path. `jarvis enroll` creates the private
key at that path, sealed to Sid's Windows account with DPAPI, and returns only
public enrollment material. Keep the environment values after this step;
Option 1 uses the same device ID and key path.

```powershell
$NewDeviceId = "device:$([guid]::NewGuid().ToString('D').ToLowerInvariant())"
$NewKeyId = "key:$([guid]::NewGuid().ToString('D').ToLowerInvariant())"
$KeyDirectory = Join-Path $env:LOCALAPPDATA 'Jarvis\keys'
New-Item -ItemType Directory -Path $KeyDirectory -Force | Out-Null
$KeyPath = Join-Path $KeyDirectory "$($NewDeviceId.Substring(7)).key"
if (Test-Path -LiteralPath $KeyPath) { throw "refusing to reuse an existing device-key path" }

$env:JARVIS_DEVICE_ID = $NewDeviceId
$env:JARVIS_DEVICE_KEY_PATH = $KeyPath
$EnrollmentLines = & uv run --project apps/local-agent jarvis enroll --device-label jarvis-home-pc
if ($LASTEXITCODE -ne 0) { throw "jarvis enroll failed" }

$Enrollment = @{}
foreach ($Line in $EnrollmentLines) {
  if ($Line -match '^(device_id|algorithm|key_generation|public_key_base64|key_fingerprint|bootstrap_metadata)\s+(.+)$') {
    $Enrollment[$Matches[1]] = $Matches[2].Trim()
  }
}
$Required = 'device_id','algorithm','key_generation','public_key_base64','key_fingerprint','bootstrap_metadata'
foreach ($Name in $Required) {
  if (-not $Enrollment.ContainsKey($Name)) { throw "missing public enrollment field: $Name" }
}
if ($Enrollment['device_id'] -cne $NewDeviceId) { throw "device ID mismatch" }
if ($Enrollment['algorithm'] -cne 'ed25519') { throw "algorithm mismatch" }
if ($Enrollment['key_generation'] -cne '1') { throw "key generation mismatch" }
if ($NewDeviceId -notmatch '^device:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw "invalid device ID" }
if ($NewKeyId -notmatch '^key:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw "invalid key ID" }

$PublicBytes = [Convert]::FromBase64String($Enrollment['public_key_base64'])
if ($PublicBytes.Length -ne 32) { throw "invalid Ed25519 public key" }
if ($Enrollment['public_key_base64'] -notmatch '^[A-Za-z0-9+/]{43}=$') { throw "invalid Ed25519 public key" }
if ([Convert]::ToBase64String($PublicBytes) -cne $Enrollment['public_key_base64']) { throw "invalid Ed25519 public key" }
$CalculatedFingerprint = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData($PublicBytes)
).ToLowerInvariant()
if ($Enrollment['key_fingerprint'] -cne $CalculatedFingerprint) { throw "public key fingerprint mismatch" }
if ($Enrollment['bootstrap_metadata'] -notmatch '^[0-9a-f]{64}$') { throw "invalid bootstrap metadata hash" }

$Values = [ordered]@{
  '__NEW_DEVICE_ID__' = $NewDeviceId
  '__NEW_KEY_ID__' = $NewKeyId
  '__NEW_PUBLIC_KEY_BASE64__' = $Enrollment['public_key_base64']
  '__NEW_KEY_FINGERPRINT__' = $Enrollment['key_fingerprint']
  '__NEW_BOOTSTRAP_METADATA_HASH__' = $Enrollment['bootstrap_metadata']
}
$InsertSql = Get-Content apps/cloud-gateway/operations/insert-replacement-device-key.sql -Raw
$RevokeSql = Get-Content apps/cloud-gateway/operations/revoke-replaced-device-key.sql -Raw
foreach ($Pair in $Values.GetEnumerator()) {
  $InsertSql = $InsertSql.Replace($Pair.Key, $Pair.Value)
  $RevokeSql = $RevokeSql.Replace($Pair.Key, $Pair.Value)
}
if ($InsertSql -match '__[A-Z0-9_]+__' -or $RevokeSql -match '__[A-Z0-9_]+__') {
  throw "rendered SQL still contains a placeholder"
}
$InsertPath = Join-Path $env:TEMP 'jarvis-insert-replacement-device-key.sql'
$RevokePath = Join-Path $env:TEMP 'jarvis-revoke-replaced-device-key.sql'
$Utf8NoBom = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($InsertPath, $InsertSql, $Utf8NoBom)
[IO.File]::WriteAllText($RevokePath, $RevokeSql, $Utf8NoBom)
```

The rendered files contain public material only. Inspect them before either
write. They must name `jarvis-home-pc`, generation `1`, algorithm `ed25519`,
and the generated IDs.

## 3. Owner approval: insert the replacement

This is the first production write. Run it only after Sid explicitly approves
this insertion:

```powershell
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --file $InsertPath
```

The final result must say `replacement_ready`. A second execution is an exact
no-op. If the starting state or any public value conflicts, the SQL leaves the
old device active and reports `replacement_not_ready`. The first statement can
also be safely retried if response delivery is lost; the second statement adds
the replacement's `device:<device_id>` cursor only for the exact active row.

Verify both active rows and the new cursor with read-only queries:

```powershell
$AfterInsert = @'
SELECT d.device_id, d.key_id, d.key_fingerprint, d.key_generation,
       d.algorithm, d.status, d.device_label, d.bootstrap_metadata_hash,
       d.created_at, d.revoked_at
FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
WHERE p.principal_type = 'human'
ORDER BY d.created_at, d.device_id;
SELECT consumer_name, current_sequence, updated_at
FROM consumer_cursors
WHERE consumer_name = 'device:__NEW_DEVICE_ID__';
'@
$AfterInsert = $AfterInsert.Replace('__NEW_DEVICE_ID__', $NewDeviceId)
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command $AfterInsert
```

Require the old row to remain `active`, the `jarvis-home-pc` row to match every
public enrollment value and be `active`, and the new cursor to exist at
sequence `0`.

## 4. Prove the replacement before revocation

Do not revoke the old key until the separately reviewed Option 1 implementation
is available. Set `JARVIS_PRINCIPAL_ID` to the opaque `principal_id` returned by
the old-device check and configure the public gateway origin, then run:

```powershell
uv run --project apps/local-agent jarvis enroll-phone --preflight
```

Require the fixed success message that the configured device key is the active
production key. The preflight must not display a key, fingerprint, device ID,
principal ID, or phone number. A mismatch, unavailable response, authentication
error, or ambiguous result is a stop condition.

Re-run the reference inventory from step 1 immediately before revocation.
Require `live_challenges`, `live_snapshots`, and `staged_projection_versions`
to remain `0`.

## 5. Owner approval: revoke the orphaned device

This is the second production write and a separate owner decision. Run it only
after the exact key preflight passes and Sid explicitly approves revocation:

```powershell
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --file $RevokePath
```

The final result must say `replacement_complete`. The SQL revokes only an
active `jarvis-local-agent` row belonging to the single active human, and only
when exactly two active owner devices exist and every replacement binding plus
its cursor matches. Repeating it is an exact no-op.

## 6. Read-only final checks

```powershell
$FinalCheck = @'
SELECT
  (SELECT COUNT(*) FROM principals WHERE principal_type = 'human' AND status = 'active') AS active_humans,
  (SELECT COUNT(*) FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
    WHERE p.principal_type = 'human' AND p.status = 'active' AND d.status = 'active') AS active_owner_devices,
  (SELECT COUNT(*) FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
    WHERE p.principal_type = 'human' AND d.status = 'revoked'
      AND d.device_label = 'jarvis-local-agent' AND d.revoked_at IS NOT NULL) AS revoked_old_devices,
  (SELECT COUNT(*) FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
    WHERE p.principal_type = 'human' AND p.status = 'active' AND d.status = 'active'
      AND d.device_label = 'jarvis-home-pc' AND d.revoked_at IS NULL) AS active_replacements;
'@
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command $FinalCheck
uv run --project apps/local-agent jarvis enroll-phone --preflight
```

Require `1` for all four columns and the same non-disclosing preflight success.
Retain the sealed home-PC key and its configured path. Do not delete the old
database row; its revoked state and historical foreign-key references are the
audit record.

If final verification is uncertain, stop phone enrollment. Do not set the
Twilio webhook or make a live call until the separate Option 1 implementation,
Twilio configuration, and attended phone-enrollment rollout have each passed
their own review and owner confirmation.

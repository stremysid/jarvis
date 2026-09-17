# Non-interactive transcription of docs/runbooks/migration-scratch-proof.md (at #80 head 5d9eff9), steps 2-9.
$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
Set-Location C:\Users\Sid\jarvis-pr40
$wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
$ScratchDatabase = 'jarvis-scratch-0031-0917a'
if ($ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "bad name" }
Write-Host "UTC START: $([DateTime]::UtcNow.ToString('o')) commit $(git rev-parse HEAD)"

# Step 2
$CreateOutput = & node $wrangler d1 create $ScratchDatabase 2>&1
$CreateExit = $LASTEXITCODE
$CreateText = $CreateOutput -join "`n"
if ($CreateExit -ne 0) { $CreateOutput | Write-Host; throw "Scratch D1 creation failed." }
$IdMatch = [regex]::Match($CreateText, '"?database_id"?\s*[:=]\s*"([0-9a-fA-F-]{36})"')
if (-not $IdMatch.Success) { throw "id not readable" }
$ScratchDatabaseId = $IdMatch.Groups[1].Value
$MigrationRoot = (Resolve-Path -LiteralPath 'apps/cloud-gateway/src/persistence/migrations').Path
$MigrationRootForToml = $MigrationRoot.Replace('\', '/')
$ScratchConfig = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-$ScratchDatabase-{0}.toml" -f [guid]::NewGuid().ToString('N'))
@(
  'name = "jarvis-migration-scratch-proof"',
  'compatibility_date = "2026-09-15"',
  '',
  '[[d1_databases]]',
  'binding = "DB"',
  "database_name = `"$ScratchDatabase`"",
  "database_id = `"$ScratchDatabaseId`"",
  "migrations_dir = `"$MigrationRootForToml`""
) | Set-Content -LiteralPath $ScratchConfig -Encoding utf8NoBOM
Write-Host "SCRATCH CREATE OK: $ScratchDatabase"
Write-Host "SCRATCH CONFIG OUTSIDE REPO: $ScratchConfig"

function Exec-Sql([string]$Sql) {
  $out = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$Sql" 2>&1
  return @{ Exit = $LASTEXITCODE; Text = ($out -join "`n") }
}

try {
  # Step 3
  node --test scripts/test/prepare-d1-scratch-baseline.test.mjs | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) { throw "baseline script tests failed" }
  node scripts/prepare-d1-scratch-baseline.mjs --database $ScratchDatabase --config $ScratchConfig
  if ($LASTEXITCODE -ne 0) { throw "Scratch baseline failed." }

  # Step 4
  $At = '2026-01-01T00:00:00.000Z'
  $PrincipalId = '00000000000000000000000001'; $DeviceId = '00000000000000000000000002'
  $IdentityId = '00000000000000000000000003'; $EventId = '00000000000000000000000004'; $CorrelationId = '00000000000000000000000005'
  $PublicKey = ('A' * 43) + '='; $Fingerprint = '1' * 64; $BootstrapHash = '2' * 64; $ContentHash = '3' * 64
  $EnvelopeJson = [ordered]@{ eventId = $EventId; eventType = 'conversation.user_committed'; source = 'conversation'; subjectId = $PrincipalId; occurredAt = $At; producerVersion = 'conversation-v1'; correlationId = $CorrelationId; payload = [ordered]@{ text = 'synthetic scratch conversation event' } } | ConvertTo-Json -Depth 4 -Compress
  $SeedSql = @(
    "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('$PrincipalId', 'human', 'active', 'Synthetic Scratch Human', '$At', '$At');",
    "INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at) VALUES ('$DeviceId', '$PrincipalId', 'synthetic-scratch-key', '$PublicKey', '$Fingerprint', 1, 'ed25519', 'active', 'Synthetic Scratch Device', '$BootstrapHash', '$At', NULL);",
    "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('$IdentityId', '$PrincipalId', 'telegram', 'synthetic-scratch-telegram-subject-not-an-account', 'active', '$At', '$At', '$DeviceId');",
    "INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES ('$EventId', 'conversation.user_committed', 'telegram', '$PrincipalId', '$At', '$At', '$ContentHash', '$EnvelopeJson', '$At');"
  ) -join "`n"
  $r = Exec-Sql $SeedSql; if ($r.Exit -ne 0) { Write-Host $r.Text; throw "seed failed" }
  $SeedCheckSql = "SELECT 'SEED CHECK OK: principal/device/telegram identity/conversation event.' AS result WHERE (SELECT COUNT(*) FROM principals WHERE principal_id = '$PrincipalId') = 1 AND (SELECT COUNT(*) FROM device_keys WHERE device_id = '$DeviceId' AND principal_id = '$PrincipalId' AND status = 'active') = 1 AND (SELECT COUNT(*) FROM channel_identities WHERE identity_id = '$IdentityId' AND principal_id = '$PrincipalId' AND channel = 'telegram' AND status = 'active') = 1 AND (SELECT COUNT(*) FROM events WHERE event_id = '$EventId' AND subject_id = '$PrincipalId' AND event_type = 'conversation.user_committed') = 1;"
  $r = Exec-Sql $SeedCheckSql
  if ($r.Exit -ne 0 -or $r.Text -notmatch [regex]::Escape('SEED CHECK OK: principal/device/telegram identity/conversation event.')) { Write-Host $r.Text; throw "seed verify failed" }
  Write-Host 'SEED CHECK OK: principal/device/telegram identity/conversation event.'

  # Step 5
  $CandidateMigrations = @(Get-ChildItem -LiteralPath 'apps/cloud-gateway/src/persistence/migrations' -Filter '*.sql' | Where-Object { [int]$_.Name.Substring(0, 4) -ge 16 } | Sort-Object Name | Select-Object -ExpandProperty Name)
  $CandidateCount = $CandidateMigrations.Count
  Write-Host "CANDIDATE RANGE: $($CandidateMigrations[0]) through $($CandidateMigrations[-1]) ($CandidateCount files)."
  $ListOutput = & node $wrangler d1 migrations list $ScratchDatabase --remote --config $ScratchConfig --env '' 2>&1
  $ListText = $ListOutput -join "`n"
  if ($LASTEXITCODE -ne 0) { Write-Host $ListText; throw "list failed" }
  foreach ($m in $CandidateMigrations) { if ($ListText -notmatch [regex]::Escape($m)) { throw "not listed: $m" } }
  $ListedPending = @([regex]::Matches($ListText, '\d{4}_[A-Za-z0-9_]+\.sql') | ForEach-Object Value | Sort-Object -Unique)
  if ($ListedPending.Count -ne $CandidateCount) { Write-Host $ListText; throw "listed count $($ListedPending.Count) != $CandidateCount" }
  Write-Host "LISTED PENDING: exactly the $CandidateCount candidates"
  $ApplyOut = 'y' | & node $wrangler d1 migrations apply $ScratchDatabase --remote --config $ScratchConfig --env '' 2>&1
  $ApplyExit = $LASTEXITCODE
  $ApplyOut | Select-Object -Last 40 | Write-Host
  if ($ApplyExit -ne 0) { throw "Scratch candidate apply failed." }
  $NamesSql = ($CandidateMigrations | ForEach-Object { "'$_'" }) -join ', '
  $r = Exec-Sql "SELECT name FROM d1_migrations WHERE name IN ($NamesSql) ORDER BY name;"
  if ($r.Exit -ne 0) { throw "receipt query failed" }
  foreach ($m in $CandidateMigrations) { if ($r.Text -notmatch [regex]::Escape($m)) { throw "Missing scratch receipt: $m" } }
  Write-Host "SCRATCH MIGRATIONS OK: $CandidateCount/$CandidateCount candidate receipts present in filename order."

  # Step 6
  $ExpectedTriggers = @(foreach ($f in (Get-ChildItem -LiteralPath 'apps/cloud-gateway/src/persistence/migrations' -Filter '*.sql' | Where-Object { [int]$_.Name.Substring(0, 4) -ge 16 })) {
    foreach ($mm in [regex]::Matches((Get-Content -Raw -LiteralPath $f.FullName), '(?im)^\s*CREATE\s+TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)')) { $mm.Groups[1].Value }
  }) | Sort-Object -Unique
  $r = Exec-Sql "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name;"
  if ($r.Exit -ne 0) { throw "trigger query failed" }
  $Missing = @($ExpectedTriggers | Where-Object { $r.Text -notmatch "(?<![A-Za-z0-9_])$([regex]::Escape($_))(?![A-Za-z0-9_])" })
  if ($Missing.Count -ne 0) { throw "missing triggers: $($Missing -join ', ')" }
  Write-Host "TRIGGER CHECK OK: $($ExpectedTriggers.Count)/$($ExpectedTriggers.Count) named triggers present."
  $Backup = @($ExpectedTriggers | Where-Object { $_ -like 'memory_backup_*' })
  $BackupPresent = @($Backup | Where-Object { $r.Text -match "(?<![A-Za-z0-9_])$([regex]::Escape($_))(?![A-Za-z0-9_])" })
  Write-Host "0031 memory_backup_* TRIGGERS: $($BackupPresent.Count)/$($Backup.Count) present"

  # Step 7
  $r = Exec-Sql "DROP TRIGGER IF EXISTS scratch_unique_guard_insert; DROP TABLE IF EXISTS scratch_unique_guard; CREATE TABLE scratch_unique_guard (id TEXT PRIMARY KEY, alternate TEXT NOT NULL UNIQUE) STRICT, WITHOUT ROWID; CREATE TRIGGER scratch_unique_guard_insert BEFORE INSERT ON scratch_unique_guard BEGIN SELECT RAISE(ABORT, 'scratch_unique_guard_rejected') WHERE EXISTS (SELECT 1 FROM scratch_unique_guard WHERE id = NEW.id) OR EXISTS (SELECT 1 FROM scratch_unique_guard WHERE alternate = NEW.alternate); END; INSERT INTO scratch_unique_guard (id, alternate) VALUES ('first', 'one');"
  if ($r.Exit -ne 0) { Write-Host $r.Text; throw "unique setup failed" }
  foreach ($c in @(
    @{ N = 'OR REPLACE primary key'; S = "INSERT OR REPLACE INTO scratch_unique_guard (id, alternate) VALUES ('first', 'two');" },
    @{ N = 'OR IGNORE primary key'; S = "INSERT OR IGNORE INTO scratch_unique_guard (id, alternate) VALUES ('first', 'two');" },
    @{ N = 'OR REPLACE alternate key'; S = "INSERT OR REPLACE INTO scratch_unique_guard (id, alternate) VALUES ('second', 'one');" },
    @{ N = 'OR IGNORE alternate key'; S = "INSERT OR IGNORE INTO scratch_unique_guard (id, alternate) VALUES ('second', 'one');" })) {
    $g = Exec-Sql $c.S
    if ($g.Exit -eq 0 -or $g.Text -notmatch 'scratch_unique_guard_rejected') { throw "Unique-key guard failed: $($c.N)" }
    Write-Host "UNIQUE GUARD OK: $($c.N) -> scratch_unique_guard_rejected"
  }
  $r = Exec-Sql "SELECT CASE WHEN COUNT(*) = 1 AND MIN(id) = 'first' AND MIN(alternate) = 'one' THEN 'UNIQUE ROW OK: first/one preserved.' ELSE 'UNIQUE ROW FAILED' END AS result FROM scratch_unique_guard;"
  if ($r.Exit -ne 0 -or $r.Text -notmatch [regex]::Escape('UNIQUE ROW OK: first/one preserved.')) { throw "row changed" }
  Write-Host 'UNIQUE ROW OK: first/one preserved.'

  # Step 8
  $r = Exec-Sql "DROP TRIGGER IF EXISTS scratch_case_wrapped_raise; CREATE TRIGGER scratch_case_wrapped_raise BEFORE INSERT ON scratch_unique_guard BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM scratch_unique_guard WHERE id = NEW.id) THEN RAISE(ABORT, 'scratch_case_wrapped_raise_rejected') END; END;"
  if ($r.Exit -eq 0 -or $r.Text -notmatch 'incomplete input' -or $r.Text -notmatch 'SQLITE_ERROR' -or $r.Text -notmatch '7500') { Write-Host $r.Text; throw "CASE RAISE not rejected as expected" }
  Write-Host "CASE RAISE CHECK OK: incomplete input: SQLITE_ERROR [code: 7500]"
}
finally {
  # Step 9 (always delete the scratch database)
  Exec-Sql "DROP TRIGGER IF EXISTS scratch_case_wrapped_raise; DROP TRIGGER IF EXISTS scratch_unique_guard_insert; DROP TABLE IF EXISTS scratch_unique_guard;" | Out-Null
  $del = 'y' | & node $wrangler d1 delete $ScratchDatabase --config $ScratchConfig --env '' -y 2>&1
  if ($LASTEXITCODE -ne 0) { $del | Write-Host; Write-Host "SCRATCH DELETE FAILED: $ScratchDatabase" } else { Write-Host "SCRATCH DELETE OK: $ScratchDatabase" }
  Remove-Item -LiteralPath $ScratchConfig -ErrorAction SilentlyContinue
  Write-Host "SCRATCH CONFIG DELETE OK: $ScratchConfig"
  Write-Host "UTC END: $([DateTime]::UtcNow.ToString('o'))"
}

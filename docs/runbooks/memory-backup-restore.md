# Restore the nightly memory backup

This is an owner-attended Windows 11 / PowerShell 7 disaster-recovery
procedure. Rehearse the entire restore on a newly created scratch D1 first.
Promotion, deployment, secret changes, production migration, and replacement
database creation remain separate owner-authorized actions.

Never run `wrangler d1 export` against production. The verified R2 set is the
backup. R2 does not provide object versions for this procedure; record the
verified manifest run id and hashes, not an "object version".

The restore operator is
`apps/cloud-gateway/src/backup/memory-backup-restore-operator.ts`. Mutation
pages are capped at 64 statements, and the permanent test holds every complete
`/step` invocation below 250 prepared statements. Its D1 progress row makes a
killed call safe to rerun, including after triggers have been dropped. The first call
refuses a target whose authoritative tables contain anything except the four
migration-seeded sets (`archive_state`, `capability_tiers`, `autonomy_mode`, and
`outbound_runtime_controls`) before its first DDL.

The pinned manifest and each row object are verified and copied once into a
scratch-only D1 cache before row insertion begins. Later `/step` calls read that
durable cache, including after a Wrangler restart. They do not download or hash
the full R2 set again. Early progress can therefore report the `cache_set` phase.

## 1. Read the verified set metadata

Run from the repository root. These commands download only the latest pointer
and its manifest into a temporary recovery directory. The operator later
verifies the pointer hash, manifest hash, every object hash, byte count, row
count, classification, and shortfall before it mutates the target.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
cd C:\path\to\jarvis
$RepoRoot = (Resolve-Path -LiteralPath '.').Path
$wrangler = (Resolve-Path -LiteralPath 'node_modules/wrangler/bin/wrangler.js').Path
$ProductionConfig = (Resolve-Path -LiteralPath 'apps/cloud-gateway/wrangler.toml').Path
$RecoveryRoot = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-memory-restore-{0}" -f [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $RecoveryRoot | Out-Null
$LatestPath = Join-Path $RecoveryRoot 'latest.json'
& node $wrangler r2 object get 'jarvis-memory-backup/memory-backup/latest.json' --remote --file $LatestPath --config $ProductionConfig --env ''
if ($LASTEXITCODE -ne 0) { throw 'Reading the latest backup pointer failed.' }
$Latest = Get-Content -Raw -LiteralPath $LatestPath | ConvertFrom-Json
if ($Latest.schemaVersion -cne '1.0' -or [string]::IsNullOrWhiteSpace($Latest.manifestObjectKey)) { throw 'The latest pointer is invalid.' }
$ManifestPath = Join-Path $RecoveryRoot 'manifest.json'
& node $wrangler r2 object get ("jarvis-memory-backup/{0}" -f $Latest.manifestObjectKey) --remote --file $ManifestPath --config $ProductionConfig --env ''
if ($LASTEXITCODE -ne 0) { throw 'Reading the backup manifest failed.' }
$Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
if ($Manifest.schemaVersion -cne '1.0' -or $Manifest.runId -cne $Latest.runId -or [string]::IsNullOrWhiteSpace($Manifest.databaseSchemaVersion)) { throw 'The manifest does not match the latest pointer.' }
Write-Host "VERIFIED SET CANDIDATE: run $($Manifest.runId), schema $($Manifest.databaseSchemaVersion). The operator must still verify all hashes."
```

Do not download or inspect the NDJSON row objects manually. Do not copy their
contents into a log or recovery record.

## 2. Create and separately confirm a scratch D1

Choose a new name containing `scratch`. Type it again after reading the target
line aloud. Never reuse an existing D1.

```powershell
$ScratchDatabase = Read-Host "New throwaway D1 name containing 'scratch'"
if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw 'The name must visibly say scratch and contain only letters, digits, underscores, or hyphens.' }
Write-Host "RESTORE TARGET: $ScratchDatabase is disposable scratch, not production."
$ConfirmedScratch = Read-Host 'Read RESTORE TARGET aloud, then type the exact scratch name again'
if ($ConfirmedScratch -cne $ScratchDatabase) { throw 'The separately typed scratch name did not match.' }
$CreateOutput = & node $wrangler d1 create $ScratchDatabase 2>&1
$CreateExit = $LASTEXITCODE
$CreateOutput | Write-Host
if ($CreateExit -ne 0) { throw 'Scratch D1 creation failed.' }
$CreateText = $CreateOutput -join "`n"
$IdMatch = [regex]::Match($CreateText, '"?database_id"?\s*[:=]\s*"([0-9a-fA-F-]{36})"')
if (-not $IdMatch.Success) { throw 'Wrangler succeeded but the scratch database id could not be read. Delete the confirmed scratch D1 before restarting.' }
$ScratchDatabaseId = $IdMatch.Groups[1].Value
```

## 3. Build a schema-limited external Wrangler config

Only migrations through the set's `databaseSchemaVersion` may be visible to
Wrangler or to trigger reconstruction. The API independently checks the
target's ordered `d1_migrations` receipts and ignores any later SQL supplied by
the repository.

```powershell
$MigrationSource = (Resolve-Path -LiteralPath 'apps/cloud-gateway/src/persistence/migrations').Path
$MigrationFiles = @(Get-ChildItem -LiteralPath $MigrationSource -Filter '*.sql' | Sort-Object Name)
$SchemaIndex = -1
for ($Index = 0; $Index -lt $MigrationFiles.Count; $Index++) {
  if ($MigrationFiles[$Index].Name -ceq $Manifest.databaseSchemaVersion) { $SchemaIndex = $Index; break }
}
if ($SchemaIndex -lt 0) { throw "The checked-out repository does not contain $($Manifest.databaseSchemaVersion). Check out the commit matching the verified set." }
$SelectedMigrations = @($MigrationFiles[0..$SchemaIndex])
$ExpectedSequences = @($SelectedMigrations | ForEach-Object { [int]$_.Name.Substring(0, 4) })
if ($ExpectedSequences.Count -eq 0 -or $ExpectedSequences[-1] -ne [int]$Manifest.databaseSchemaVersion.Substring(0, 4)) { throw 'The schema-limited migration prefix is invalid.' }
$RestoreMigrationRoot = Join-Path $RecoveryRoot 'migrations'
New-Item -ItemType Directory -Path $RestoreMigrationRoot | Out-Null
foreach ($Migration in $SelectedMigrations) { Copy-Item -LiteralPath $Migration.FullName -Destination (Join-Path $RestoreMigrationRoot $Migration.Name) }
$OperatorEntry = (Resolve-Path -LiteralPath 'apps/cloud-gateway/src/backup/memory-backup-restore-operator.ts').Path.Replace('\', '/')
$MigrationRootForToml = $RestoreMigrationRoot.Replace('\', '/')
$RestoreConfig = Join-Path $RecoveryRoot 'restore.toml'
$RestoreConfigLines = @(
  'name = "jarvis-memory-backup-restore-scratch"',
  "main = `"$OperatorEntry`"",
  'compatibility_date = "2026-09-16"',
  '',
  '[[rules]]',
  'type = "Text"',
  'globs = ["**/*.sql"]',
  'fallthrough = true',
  '',
  '[[d1_databases]]',
  'binding = "DB"',
  "database_name = `"$ScratchDatabase`"",
  "database_id = `"$ScratchDatabaseId`"",
  "migrations_dir = `"$MigrationRootForToml`"",
  '',
  '[[r2_buckets]]',
  'binding = "ARCHIVE"',
  'bucket_name = "jarvis-archive"',
  '',
  '[[r2_buckets]]',
  'binding = "BACKUP"',
  'bucket_name = "jarvis-memory-backup"'
)
$RestoreConfigLines | Set-Content -LiteralPath $RestoreConfig -Encoding utf8NoBOM
node scripts/check-memory-backup-restore-target.mjs --database $ScratchDatabase --confirm-database $ConfirmedScratch --config $RestoreConfig
if ($LASTEXITCODE -ne 0) { throw 'Restore target safety check failed.' }
```

The checker requires the name twice, requires `scratch`, requires the external
config to target the bounded operator entry, and refuses the production
database id read from the repository's `wrangler.toml`. It parses TOML escapes
before comparing ids and refuses any `preview_database_id`, because Wrangler
dev would bind that preview target. It does not print either database id.

## 4. Apply only the set's migrations to scratch

List first. The final listed and applied receipt must be exactly the manifest's
schema version. A later repository migration must not appear because the
external migration directory contains only the selected prefix.

```powershell
& node $wrangler d1 migrations list $ScratchDatabase --remote --config $RestoreConfig --env ''
if ($LASTEXITCODE -ne 0) { throw 'Scratch migration list failed.' }
Write-Host "At Wrangler's y/n prompt, confirm only $ScratchDatabase and migrations through $($Manifest.databaseSchemaVersion); otherwise answer n."
& node $wrangler d1 migrations apply $ScratchDatabase --remote --config $RestoreConfig --env ''
if ($LASTEXITCODE -ne 0) { throw 'Scratch migration apply failed. Delete this partial scratch D1 and restart.' }
$ReceiptSql = 'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1;'
$ReceiptOutput = & node $wrangler d1 execute $ScratchDatabase --remote --config $RestoreConfig --env '' --json "--command=$ReceiptSql" 2>&1
$ReceiptExit = $LASTEXITCODE
$ReceiptText = $ReceiptOutput -join "`n"
if ($ReceiptExit -ne 0 -or $ReceiptText -notmatch [regex]::Escape($Manifest.databaseSchemaVersion)) { throw 'Scratch migration receipt does not match the verified set schema.' }
Write-Host "SCRATCH SCHEMA OK: $($Manifest.databaseSchemaVersion)"
```

## 5. Run the bounded, resumable restore

The temporary operator token is not written to the repository or the recovery
record. Start Wrangler through Node so Windows does not reinterpret the fixed
arguments. The operator binds only the separately checked scratch D1. Its R2
bindings are read-only in the operator source.

```powershell
$OperatorTokenBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($OperatorTokenBytes)
$OperatorToken = [Convert]::ToBase64String($OperatorTokenBytes)
$Port = 8791
$DevOut = Join-Path $RecoveryRoot 'wrangler-dev.out.log'
$DevErr = Join-Path $RecoveryRoot 'wrangler-dev.err.log'
$DevArguments = @(
  "`"$wrangler`"", 'dev', '--remote', '--config', "`"$RestoreConfig`"",
  '--ip', '127.0.0.1', '--port', $Port, '--no-show-interactive-dev-session',
  '--log-level', 'error',
  '--var', "RESTORE_TARGET_DATABASE_NAME:$ScratchDatabase",
  '--var', "RESTORE_CONFIRMED_DATABASE_NAME:$ConfirmedScratch",
  '--var', "RESTORE_OPERATOR_TOKEN:$OperatorToken",
  '--var', "RESTORE_RUN_DATE:$($Latest.runDate)",
  '--var', "RESTORE_RUN_ID:$($Latest.runId)",
  '--var', "RESTORE_MANIFEST_OBJECT_KEY:$($Latest.manifestObjectKey)",
  '--var', "RESTORE_MANIFEST_SHA256:$($Latest.manifestSha256)"
)
$DevProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList $DevArguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $DevOut -RedirectStandardError $DevErr
try {
  $Headers = @{ Authorization = "Bearer $OperatorToken" }
  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 30 -and -not $Ready; $Attempt++) {
    try {
      $Response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/step" -Headers $Headers
      $Ready = $true
    } catch {
      if ($null -ne $_.Exception.Response) {
        $OperatorError = $_.ErrorDetails.Message
        if ([string]::IsNullOrWhiteSpace($OperatorError)) { $OperatorError = $_.Exception.Message }
        throw "Restore operator returned an HTTP error: $OperatorError"
      }
      if ($DevProcess.HasExited) { throw "Restore operator stopped early. Read $DevErr without copying private data into the recovery record." }
      Start-Sleep -Seconds 1
    }
  }
  if (-not $Ready) { throw 'Restore operator did not become ready.' }
  while ($Response.outcome -ceq 'pending') {
    Write-Host "RESTORE PENDING: $($Response.phase) index $($Response.itemIndex)"
    $Response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/step" -Headers $Headers
  }
  if ($Response.outcome -cne 'complete' -or $Response.restoreId -cne $Manifest.runId) { throw 'Restore did not complete the selected verified set.' }
  $ReportPath = Join-Path $RecoveryRoot 'restore-report.json'
  $Response | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8NoBOM
  Write-Host "RESTORE COMPLETE: $($Response.restoreId)"
  Write-Host "REPORT SAVED: $ReportPath"

  $ForeignKeyOutput = & node $wrangler d1 execute $ScratchDatabase --remote --config $RestoreConfig --env '' --json '--command=PRAGMA foreign_key_check;' 2>&1
  $ForeignKeyExit = $LASTEXITCODE
  $ForeignKeyText = $ForeignKeyOutput -join "`n"
  if ($ForeignKeyExit -ne 0) { throw 'Scratch foreign-key check failed.' }
  $ForeignKeyJson = $ForeignKeyText | ConvertFrom-Json
  $ForeignKeyRows = @($ForeignKeyJson | ForEach-Object { $_.results } | ForEach-Object { $_ })
  if ($ForeignKeyRows.Count -ne 0) { throw 'Scratch foreign-key check returned violations.' }
  $TriggerOutput = & node $wrangler d1 execute $ScratchDatabase --remote --config $RestoreConfig --env '' --json '--command=SELECT count(*) AS count FROM sqlite_schema WHERE type = ''trigger'';' 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Scratch trigger check failed.' }
  $CursorOutput = & node $wrangler d1 execute $ScratchDatabase --remote --config $RestoreConfig --env '' --json '--command=SELECT principal_id, cursor_name, current_event_sequence FROM memory_cursors ORDER BY principal_id, cursor_name;' 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Scratch cursor check failed.' }
  $CursorText = $CursorOutput -join "`n"
  if ($CursorText -match 'summaries|fts_items|fts_episodes|embeddings|export') { throw 'Restore created a cursor that production does not maintain.' }

  $FinalizeHeaders = @{ Authorization = "Bearer $OperatorToken"; 'X-Restore-Id' = $Response.restoreId }
  $Finalized = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/finalize" -Headers $FinalizeHeaders
  if ($Finalized.outcome -cne 'finalized') { throw 'Restore completion receipt was not finalized.' }
  Write-Host "SCRATCH RESTORE REHEARSAL OK: $($Response.restoreId)"
} finally {
  if (-not $DevProcess.HasExited) { Stop-Process -Id $DevProcess.Id }
  $OperatorToken = $null
  [Array]::Clear($OperatorTokenBytes, 0, $OperatorTokenBytes.Length)
}
```

If the terminal, network, or Wrangler process dies at any point before
`complete`, run the target checker again, restart the same operator against the
same scratch config, and repeat `/step`. Do not recreate the database and do
not manually recreate triggers. The D1 progress row resumes the exact set and
rejects a different manifest.

`/finalize` leaves an idempotent finalized marker. If its response is lost,
repeat the same authenticated `/finalize` request with the same restore id. A
later `/step` still reports the completed restore instead of treating the
restored database as a fresh target.

The repository still has no Vectorize writer. The response therefore records
`vectorRebuild: "unavailable"`. Scratch rehearsal may complete with an empty
vector ledger, but a real recovery must not be promoted until a reviewed writer
proves the rebuilt D1 ledger and remote Vectorize index agree.

## 6. Validate scratch and record only non-private evidence

Keep the commit SHA, UTC time, scratch name, manifest run id, schema version,
each `RESTORE PENDING` phase, the `RESTORE COMPLETE` line, the report path, the
foreign-key/trigger/cursor command exit status, and the final rehearsal line.
Do not record row contents, account identifiers, database ids, tokens, or
private backup objects.

Review every nonzero `shortfallRowCount` from the manifest. Compare the report's
authoritative table counts with `exportedRowCount`, not `expectedRowCount`.
Exercise literal retrieval and item/topic state through the scratch-bound
application before any promotion decision.

Only after this scratch rehearsal passes may the owner create a separate empty
replacement D1 and repeat the same schema-limited, separately confirmed flow.
The checker still refuses the current production database id. Swapping a
binding, applying a production migration, deploying, changing secrets, or
promoting the replacement is not part of this runbook.

## 7. Delete the disposable scratch database

After saving the rehearsal evidence, type the scratch name a third time and
delete only that confirmed target. This is destructive and owner-attended.

```powershell
Write-Host "DELETE TARGET: $ScratchDatabase is the disposable rehearsal D1."
$DeleteConfirmation = Read-Host 'Type the exact scratch name to delete it'
if ($DeleteConfirmation -cne $ScratchDatabase) { throw 'Scratch deletion target was not confirmed.' }
& node $wrangler d1 delete $ScratchDatabase --config $RestoreConfig --env ''
if ($LASTEXITCODE -ne 0) { throw 'Scratch D1 deletion failed.' }
Remove-Item -LiteralPath $RecoveryRoot -Recurse
Write-Host "SCRATCH DELETE OK: $ScratchDatabase"
```

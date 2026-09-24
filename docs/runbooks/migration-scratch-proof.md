# Remote-D1 migration scratch proof

This is an owner-attended Windows 11 / PowerShell 7 runbook. Run it from the
repository root. It creates and later deletes a throwaway **remote** D1
database. It does not authorize a production migration or deployment. Use the
same PowerShell 7.3+ session throughout, with native empty arguments preserved:

```powershell
$PSNativeCommandArgumentPassing = 'Standard'
$wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
$gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path
$ProductionListOutput = & node $wrangler d1 migrations list jarvis --remote --config $gateway --env '' 2>&1
$ProductionListExit = $LASTEXITCODE
$ProductionListText = $ProductionListOutput -join "`n"
$ProductionListOutput | Write-Host
if ($ProductionListExit -ne 0) { throw "Production migration list failed." }
$ProductionMigrations = @([regex]::Matches($ProductionListText, '\b\d{4}_[A-Za-z0-9_-]+\.sql\b') | ForEach-Object { $_.Value } | Select-Object -Unique)
```

Record the reviewed commit and this exact production pending inventory before
creating scratch. Keep `$ProductionMigrations` in this PowerShell session for
step 5's coverage check. Stop if listing fails. [STATE.md](../STATE.md#production)
last records production through `0038`, but a dated observation is not today's
pending set. Reconcile the list with the reviewed
[migration files](../../apps/cloud-gateway/src/persistence/migrations/).
Do not infer pending files from a numeric range or assume a numbering gap is reserved.

1. **Know the boundary.** The repository helper executes its fixed historical
   fixture, `0001` through `0015`, statement by statement. That fixture is
   **not the current production baseline**. This run seeds synthetic rows and
   asks Wrangler for scratch's pending set before applying it. A completed run
   establishes whether remote D1 accepts that scratch set over the seeded
   rows, that every final trigger named by those files exists, that both unique
   keys in the scratch guard reject `INSERT OR REPLACE` and `INSERT OR IGNORE`,
   and that remote D1 still rejects the unsupported statement form `SELECT CASE
   ... RAISE(`. Plain `CASE ... END` value expressions are deliberately allowed
   because they work on remote D1. This proof does not reproduce production's
   data volume or its real row contents, and it does not authorize production
   bindings or a deployment. Scratch and production can have different pending
   sets; step 5 proves that every production-pending file is included and has a
   scratch receipt. A passing run is the scratch rehearsal required by the
   [OWNER-ACTIONS rollout rows](../OWNER-ACTIONS.md#waiting-on-sid). The synthetic
   seed does not reproduce production's real rows or volume; each pending
   migration's production preconditions still apply before the production write.

2. **Name, confirm, and create the throwaway database and external config.**
   Choose a new name containing `scratch`; never reuse an existing database.
   Read the displayed sentence aloud before typing the same name again. The
   config is created in the Windows temporary directory, outside the
   repository, and declares only this scratch database. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $PSNativeCommandArgumentPassing = 'Standard'
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $gateway = (Resolve-Path 'apps/cloud-gateway/wrangler.toml').Path
   $ScratchDatabase = Read-Host "New throwaway D1 name containing 'scratch'"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch and contain only letters, digits, underscores or hyphens." }
   Write-Host "TARGET: $ScratchDatabase is disposable scratch, not production."
   $ConfirmedScratch = Read-Host "Read TARGET aloud, then re-enter the exact scratch name"
   if ($ConfirmedScratch -cne $ScratchDatabase) { throw "Scratch target was not confirmed." }
   $CreateOutput = & node $wrangler d1 create $ScratchDatabase --config $gateway --env '' 2>&1
   $CreateExit = $LASTEXITCODE
   $CreateOutput | Write-Host
   if ($CreateExit -ne 0) { throw "Scratch D1 creation failed." }
   $CreateText = $CreateOutput -join "`n"
   $IdMatch = [regex]::Match($CreateText, '"?database_id"?\s*[:=]\s*"([0-9a-fA-F-]{36})"')
   if (-not $IdMatch.Success) { throw "Wrangler succeeded but its returned scratch database id could not be read. Delete the confirmed scratch database before restarting." }
   $ScratchDatabaseId = $IdMatch.Groups[1].Value
   $MigrationRoot = (Resolve-Path -LiteralPath 'apps/cloud-gateway/src/persistence/migrations').Path
   $MigrationRootForToml = $MigrationRoot.Replace('\', '/')
   $ScratchConfig = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-$ScratchDatabase-{0}.toml" -f [guid]::NewGuid().ToString('N'))
   $RepoRoot = (Resolve-Path -LiteralPath '.').Path
   if ([IO.Path]::GetFullPath($ScratchConfig).StartsWith($RepoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Scratch config resolved inside the repository." }
   $ScratchConfigLines = @(
     'name = "jarvis-migration-scratch-proof"',
     'compatibility_date = "2026-09-15"',
     '',
     '[[d1_databases]]',
     'binding = "DB"',
     "database_name = `"$ScratchDatabase`"",
     "database_id = `"$ScratchDatabaseId`"",
     "migrations_dir = `"$MigrationRootForToml`""
   )
   $ScratchConfigLines | Set-Content -LiteralPath $ScratchConfig -Encoding utf8NoBOM
   if (-not (Test-Path -LiteralPath $ScratchConfig -PathType Leaf)) { throw "Scratch config was not created." }
   Write-Host "SCRATCH CREATE OK: $ScratchDatabase"
   Write-Host "SCRATCH CONFIG OUTSIDE REPO: $ScratchConfig"
   ```

   Expect the Wrangler success line for the entered name, followed by exactly
   `SCRATCH CREATE OK: <entered name>` and an external config path. Stop if
   Wrangler says the name already exists or shows any target other than the
   confirmed scratch name. The returned database identifier must never be
   copied into a repository file. If creation fails at the account's database
   limit, delete an older, separately confirmed scratch database first; never
   select a production database to make room.

3. **Build the helper's historical baseline on empty scratch.**
   `scripts/prepare-d1-scratch-baseline.mjs` is fixed at `0015`; the number in
   its receipt checks below describes that helper, never production. The repository
   helper uses the same `splitMigration` function as the D1 tests, lifting
   complete trigger bodies out before splitting the rest on semicolons. It
   sends each resulting statement through `wrangler d1 execute`, checks every
   exit code, and records a `d1_migrations` receipt only after every statement
   for that file succeeds. These are not fabricated receipts: each one
   corresponds to that file's SQL genuinely executed against this database.
   The helper refuses to record a receipt for a file whose statements did not
   all succeed. Run this baseline against the empty scratch database before
   step 4 seeds rows, because the per-request replay does not carry `0006`'s
   `PRAGMA defer_foreign_keys` into later requests. The script tests are a
   manual preflight and are not part of `pnpm.cmd test`; run them here before any
   remote action in this step. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   node --test scripts/test/prepare-d1-scratch-baseline.test.mjs
   if ($LASTEXITCODE -ne 0) { throw "Scratch baseline script tests failed. Stop here." }
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch." }
   $ScratchConfig = Read-Host "Absolute SCRATCH CONFIG OUTSIDE REPO path from step 2"
   $ScratchConfig = [IO.Path]::GetFullPath($ScratchConfig)
   $RepoRoot = (Resolve-Path -LiteralPath '.').Path
   if (-not (Test-Path -LiteralPath $ScratchConfig -PathType Leaf)) { throw "Scratch config not found." }
   if ($ScratchConfig.StartsWith($RepoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Scratch config must remain outside the repository." }
   node scripts/prepare-d1-scratch-baseline.mjs --database $ScratchDatabase --config $ScratchConfig
   if ($LASTEXITCODE -ne 0) { throw "Scratch baseline failed. Stop here; preserve the error, delete this partial scratch database, and restart with a new name." }
   $BaselineFiles = @(Get-ChildItem -LiteralPath 'apps/cloud-gateway/src/persistence/migrations' -Filter '*.sql' | Sort-Object Name | Where-Object { [int]$_.Name.Substring(0, 4) -le 15 } | Select-Object -ExpandProperty Name)
   if ($BaselineFiles.Count -ne 15) { throw "Expected exactly 15 baseline files through 0015." }
   $NamesSql = ($BaselineFiles | ForEach-Object { "'$($_.Replace("'", "''"))'" }) -join ', '
   $ReceiptSql = "SELECT name FROM d1_migrations WHERE name IN ($NamesSql) ORDER BY id;"
   $ReceiptOutput = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$ReceiptSql" 2>&1
   $ReceiptExit = $LASTEXITCODE
   $ReceiptText = $ReceiptOutput -join "`n"
   $ReceiptOutput | Write-Host
   if ($ReceiptExit -ne 0) { throw "Scratch baseline receipt query failed." }
   foreach ($Migration in $BaselineFiles) {
     if ($ReceiptText -notmatch [regex]::Escape($Migration)) { throw "Missing genuine baseline receipt: $Migration" }
   }
   Write-Host "SCRATCH BASELINE RECEIPTS OK: 15/15 through 0015."
   ```

   Expect one `BASELINE RECEIPT OK` line per file, the helper's exact
   `SCRATCH BASELINE OK: 15/15 receipts through 0015.` line, and then exactly
   `SCRATCH BASELINE RECEIPTS OK: 15/15 through 0015.` A failure leaves a
   partial database, not a resumable rehearsal; follow step 11.

4. **Seed synthetic rows before scratch's pending migrations.** These
   identifiers, hashes, key material and content are visibly synthetic. They
   contain no phone number, token, account id or credential. The rows exercise
   a human principal, device, active Telegram channel identity and conversation
   event against the helper's historical schema. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch." }
   $ScratchConfig = [IO.Path]::GetFullPath((Read-Host "Absolute SCRATCH CONFIG OUTSIDE REPO path from step 2"))
   $At = '2026-01-01T00:00:00.000Z'
   $PrincipalId = '00000000000000000000000001'
   $DeviceId = '00000000000000000000000002'
   $IdentityId = '00000000000000000000000003'
   $EventId = '00000000000000000000000004'
   $CorrelationId = '00000000000000000000000005'
   $PublicKey = ('A' * 43) + '='
   $Fingerprint = '1' * 64
   $BootstrapHash = '2' * 64
   $ContentHash = '3' * 64
   $EnvelopeJson = [ordered]@{ eventId = $EventId; eventType = 'conversation.user_committed'; source = 'conversation'; subjectId = $PrincipalId; occurredAt = $At; producerVersion = 'conversation-v1'; correlationId = $CorrelationId; payload = [ordered]@{ text = 'synthetic scratch conversation event' } } | ConvertTo-Json -Depth 4 -Compress
   $SeedSql = @(
     "INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('$PrincipalId', 'human', 'active', 'Synthetic Scratch Human', '$At', '$At');",
     "INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at) VALUES ('$DeviceId', '$PrincipalId', 'synthetic-scratch-key', '$PublicKey', '$Fingerprint', 1, 'ed25519', 'active', 'Synthetic Scratch Device', '$BootstrapHash', '$At', NULL);",
     "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES ('$IdentityId', '$PrincipalId', 'telegram', 'synthetic-scratch-telegram-subject-not-an-account', 'active', '$At', '$At', '$DeviceId');",
     "INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES ('$EventId', 'conversation.user_committed', 'telegram', '$PrincipalId', '$At', '$At', '$ContentHash', '$EnvelopeJson', '$At');"
   ) -join "`n"
   & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$SeedSql"
   if ($LASTEXITCODE -ne 0) { throw "Production-shaped scratch seed failed." }
   $SeedCheckSql = "SELECT 'SEED CHECK OK: principal/device/telegram identity/conversation event.' AS result WHERE (SELECT COUNT(*) FROM principals WHERE principal_id = '$PrincipalId') = 1 AND (SELECT COUNT(*) FROM device_keys WHERE device_id = '$DeviceId' AND principal_id = '$PrincipalId' AND status = 'active') = 1 AND (SELECT COUNT(*) FROM channel_identities WHERE identity_id = '$IdentityId' AND principal_id = '$PrincipalId' AND channel = 'telegram' AND status = 'active') = 1 AND (SELECT COUNT(*) FROM events WHERE event_id = '$EventId' AND subject_id = '$PrincipalId' AND event_type = 'conversation.user_committed') = 1;"
   $SeedCheck = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$SeedCheckSql" 2>&1
   $SeedCheckExit = $LASTEXITCODE
   $SeedCheckText = $SeedCheck -join "`n"
   $SeedCheck | Write-Host
   if ($SeedCheckExit -ne 0 -or $SeedCheckText -notmatch [regex]::Escape('SEED CHECK OK: principal/device/telegram identity/conversation event.')) { throw "Scratch seed verification failed." }
   ```

   Expect exactly the `SEED CHECK OK` marker. Because these rows precede the
   candidates, the apply now exercises the `NOT NULL`, existing-row guard and
   unique-index classes that an empty database could not cover. The remaining
   data gap is production's volume and the real contents of its rows; do not
   copy or export production rows into scratch under this runbook.

5. **List, then let Wrangler apply the exact scratch pending set.** A scratch-only config
   is required: Wrangler ignores the repository config's `migrations_dir` for
   a database that config does not declare. Use that external config for every
   scratch command; the gateway config remains for production listing only
   after scratch creation. Parse the filenames from Wrangler's scratch list,
   retaining unique names in displayed order. Compare the entire list, including
   its count, with the repository and the apply prompt. Wrangler asks for `y/n`
   confirmation. Answer `y`
   only if its prompt names the confirmed scratch database and lists exactly
   the files printed in `SCRATCH PENDING SET`; for anything else, answer `n` and
   stop. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch." }
   $ScratchConfig = [IO.Path]::GetFullPath((Read-Host "Absolute SCRATCH CONFIG OUTSIDE REPO path from step 2"))
   $MigrationRoot = 'apps/cloud-gateway/src/persistence/migrations'
   $ListOutput = & node $wrangler d1 migrations list $ScratchDatabase --remote --config $ScratchConfig --env '' 2>&1
   $ListExit = $LASTEXITCODE
   $ListText = $ListOutput -join "`n"
   $ListOutput | Write-Host
   if ($ListExit -ne 0) { throw "Scratch migration list failed." }
   $CandidateMigrations = @([regex]::Matches($ListText, '\b\d{4}_[A-Za-z0-9_-]+\.sql\b') | ForEach-Object { $_.Value } | Select-Object -Unique)
   $CandidateCount = $CandidateMigrations.Count
   if ($CandidateCount -eq 0) { throw "No pending scratch migration filenames were parsed. Stop here." }
   if (-not (Test-Path variable:ProductionMigrations)) { throw "Run the production inventory preamble in this PowerShell session first." }
   foreach ($Migration in $CandidateMigrations) {
     if (-not (Test-Path -LiteralPath (Join-Path $MigrationRoot $Migration) -PathType Leaf)) { throw "Pending filename is not a repository migration: $Migration" }
   }
   Write-Host "SCRATCH PENDING SET ($CandidateCount files): $($CandidateMigrations -join ', ')"
   Write-Host "At Wrangler's y/n prompt, confirm the scratch database name and the entire SCRATCH PENDING SET; otherwise answer n and stop."
   & node $wrangler d1 migrations apply $ScratchDatabase --remote --config $ScratchConfig --env ''
   if ($LASTEXITCODE -ne 0) { throw "Scratch candidate apply failed. Stop here." }
   $NamesSql = ($CandidateMigrations | ForEach-Object { "'$($_.Replace("'", "''"))'" }) -join ', '
   $AppliedSql = "SELECT name FROM d1_migrations WHERE name IN ($NamesSql) ORDER BY name;"
   $Applied = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$AppliedSql" 2>&1
   $AppliedExit = $LASTEXITCODE
   $AppliedText = $Applied -join "`n"
   $Applied | Write-Host
   if ($AppliedExit -ne 0) { throw "Scratch migration receipt query failed." }
   foreach ($Migration in $CandidateMigrations) {
     if ($AppliedText -notmatch [regex]::Escape($Migration)) { throw "Missing scratch receipt: $Migration" }
   }
   Write-Host "SCRATCH MIGRATIONS OK: $CandidateCount/$CandidateCount candidate receipts present in filename order."
   $ScratchReceiptNames = @([regex]::Matches($AppliedText, '\b\d{4}_[A-Za-z0-9_-]+\.sql\b') | ForEach-Object { $_.Value } | Select-Object -Unique)
   foreach ($Migration in $ProductionMigrations) {
     if ($CandidateMigrations -cnotcontains $Migration) { throw "Production-pending migration was not rehearsed: $Migration" }
     if ($ScratchReceiptNames -cnotcontains $Migration) { throw "Production-pending migration has no scratch receipt: $Migration" }
   }
   Write-Host "PRODUCTION PENDING COVERAGE OK: $($ProductionMigrations.Count) files rehearsed with scratch receipts."
   $PostApplyListOutput = & node $wrangler d1 migrations list $ScratchDatabase --remote --config $ScratchConfig --env '' 2>&1
   $PostApplyListExit = $LASTEXITCODE
   $PostApplyListText = $PostApplyListOutput -join "`n"
   $PostApplyListOutput | Write-Host
   if ($PostApplyListExit -ne 0) { throw "Scratch post-apply list failed." }
   if ([regex]::Matches($PostApplyListText, '\b\d{4}_[A-Za-z0-9_-]+\.sql\b').Count -ne 0) { throw "Scratch migrations remain pending. Stop here." }
   ```

   Expect Wrangler to apply exactly the listed files and then report no pending
   migrations. An empty parsed initial set is a stop, not a passing rehearsal. The
   final `SCRATCH MIGRATIONS OK` numerator and denominator must both equal the
   observed file count. Reconcile any duplicate number or numbering gap with
   the reviewed repository and current work before applying; an absent file
   is not evidence that its number is reserved. Rehearse newly merged files
   separately before a later rollout.

6. **Prove every named trigger exists.** Extract the expected final trigger
   names from the exact scratch pending filenames captured in step 5, rather than maintaining
   either a hand-written migration list or trigger count. This inventory uses
   only the candidate files currently present and does not assume their
   sequence numbers are contiguous. Review any DROP TRIGGER in the pending set
   before using this name inventory: at `c66c3870` the drops are followed by
   recreation, but a future removal would need the expected list adjusted.
   A set without triggers still needs its other migration acceptance checks.
   This step depends on step 5's `$CandidateMigrations` in the same PowerShell
   session and fails closed if that inventory is absent or empty. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch." }
   $ScratchConfig = [IO.Path]::GetFullPath((Read-Host "Absolute SCRATCH CONFIG OUTSIDE REPO path from step 2"))
   $MigrationRoot = 'apps/cloud-gateway/src/persistence/migrations'
   if (-not (Test-Path variable:CandidateMigrations) -or @($CandidateMigrations).Count -eq 0) { throw "Run step 5 in this PowerShell session before the trigger proof." }
   $MigrationFiles = @($CandidateMigrations | Sort-Object | ForEach-Object { Join-Path $MigrationRoot $_ })
   if ($MigrationFiles.Count -eq 0) { throw "No repository candidate migrations were found." }
   $ExpectedTriggers = @(foreach ($MigrationFile in $MigrationFiles) {
     $MigrationSql = Get-Content -Raw -LiteralPath $MigrationFile
     foreach ($Match in [regex]::Matches($MigrationSql, '(?im)^\s*CREATE\s+TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)')) { $Match.Groups[1].Value }
   }) | Sort-Object -Unique
   $TriggerSql = "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name;"
   $TriggerCheck = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$TriggerSql" 2>&1
   $TriggerExit = $LASTEXITCODE
   $TriggerText = $TriggerCheck -join "`n"
   $TriggerCheck | Write-Host
   if ($TriggerExit -ne 0) { throw "Scratch trigger inventory query failed." }
   $MissingTriggers = @($ExpectedTriggers | Where-Object { $TriggerText -notmatch "(?<![A-Za-z0-9_])$([regex]::Escape($_))(?![A-Za-z0-9_])" })
   if ($MissingTriggers.Count -ne 0) { throw "Scratch trigger proof failed; missing: $($MissingTriggers -join ', ')" }
   Write-Host "TRIGGER CHECK OK: $($ExpectedTriggers.Count)/$($ExpectedTriggers.Count) named triggers present."
   ```

   The expected trigger count comes from the candidate files present at the
   checked-out commit. The numerator and denominator in `TRIGGER CHECK OK` must
   match. Any missing name is a failure even if the query exited zero.

7. **Prove both unique-key guards defeat both conflict algorithms.** This is
   the existing `STRICT, WITHOUT ROWID` remote-D1 pattern, expanded across the
   primary and alternate unique keys. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch." }
   $ScratchConfig = [IO.Path]::GetFullPath((Read-Host "Absolute SCRATCH CONFIG OUTSIDE REPO path from step 2"))
   $SetupSql = "DROP TRIGGER IF EXISTS scratch_unique_guard_insert; DROP TABLE IF EXISTS scratch_unique_guard; CREATE TABLE scratch_unique_guard (id TEXT PRIMARY KEY, alternate TEXT NOT NULL UNIQUE) STRICT, WITHOUT ROWID; CREATE TRIGGER scratch_unique_guard_insert BEFORE INSERT ON scratch_unique_guard BEGIN SELECT RAISE(ABORT, 'scratch_unique_guard_rejected') WHERE EXISTS (SELECT 1 FROM scratch_unique_guard WHERE id = NEW.id) OR EXISTS (SELECT 1 FROM scratch_unique_guard WHERE alternate = NEW.alternate); END; INSERT INTO scratch_unique_guard (id, alternate) VALUES ('first', 'one');"
   & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$SetupSql"
   if ($LASTEXITCODE -ne 0) { throw "Unique-key probe setup failed." }
   $GuardCases = @(
     @{ Name = 'OR REPLACE primary key'; Sql = "INSERT OR REPLACE INTO scratch_unique_guard (id, alternate) VALUES ('first', 'two');" },
     @{ Name = 'OR IGNORE primary key'; Sql = "INSERT OR IGNORE INTO scratch_unique_guard (id, alternate) VALUES ('first', 'two');" },
     @{ Name = 'OR REPLACE alternate key'; Sql = "INSERT OR REPLACE INTO scratch_unique_guard (id, alternate) VALUES ('second', 'one');" },
     @{ Name = 'OR IGNORE alternate key'; Sql = "INSERT OR IGNORE INTO scratch_unique_guard (id, alternate) VALUES ('second', 'one');" }
   )
   foreach ($GuardCase in $GuardCases) {
     $GuardOutput = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$($GuardCase.Sql)" 2>&1
     $GuardExit = $LASTEXITCODE
     $GuardText = $GuardOutput -join "`n"
     if ($GuardExit -eq 0 -or $GuardText -notmatch 'scratch_unique_guard_rejected') { throw "Unique-key guard failed: $($GuardCase.Name)" }
     Write-Host "UNIQUE GUARD OK: $($GuardCase.Name) -> scratch_unique_guard_rejected"
   }
   $PreservedSql = "SELECT CASE WHEN COUNT(*) = 1 AND MIN(id) = 'first' AND MIN(alternate) = 'one' THEN 'UNIQUE ROW OK: first/one preserved.' ELSE 'UNIQUE ROW FAILED' END AS result FROM scratch_unique_guard;"
   $Preserved = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$PreservedSql" 2>&1
   $PreservedExit = $LASTEXITCODE
   $PreservedText = $Preserved -join "`n"
   $Preserved | Write-Host
   if ($PreservedExit -ne 0 -or $PreservedText -notmatch [regex]::Escape('UNIQUE ROW OK: first/one preserved.')) { throw "Unique-key probe row changed." }
   ```

   Expect four `UNIQUE GUARD OK` lines ending in
   `scratch_unique_guard_rejected`, then exactly `UNIQUE ROW OK: first/one
   preserved.` Success from any conflict statement is a failure.

8. **Prove the statement form `SELECT CASE ... RAISE(` is still rejected.**
   This deliberately sends the unsupported form; failure is expected. It does
   not test or forbid plain `CASE ... END` used as a value expression, which is
   valid on remote D1. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch." }
   $ScratchConfig = [IO.Path]::GetFullPath((Read-Host "Absolute SCRATCH CONFIG OUTSIDE REPO path from step 2"))
   $CaseSql = "DROP TRIGGER IF EXISTS scratch_case_wrapped_raise; CREATE TRIGGER scratch_case_wrapped_raise BEFORE INSERT ON scratch_unique_guard BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM scratch_unique_guard WHERE id = NEW.id) THEN RAISE(ABORT, 'scratch_case_wrapped_raise_rejected') END; END;"
   $CaseOutput = & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$CaseSql" 2>&1
   $CaseExit = $LASTEXITCODE
   $CaseText = $CaseOutput -join "`n"
   $CaseOutput | Write-Host
   if ($CaseExit -eq 0 -or $CaseText -notmatch 'incomplete input' -or $CaseText -notmatch 'SQLITE_ERROR' -or $CaseText -notmatch '7500') { throw "Expected remote-D1 CASE/RAISE rejection was not observed." }
   Write-Host "CASE RAISE CHECK OK: incomplete input: SQLITE_ERROR [code: 7500]"
   ```

   Expect the command to fail with `incomplete input: SQLITE_ERROR [code:
   7500]`, followed by exactly the `CASE RAISE CHECK OK` line. If remote D1
   accepts it, stop and obtain a new review. If the wording changes, ask for
   review; that mismatch does not mean the database is broken.

9. **Remove probe objects, delete scratch, then remove its external config.**
   In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $wrangler = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name to delete"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch '^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$') { throw "The name must visibly say scratch." }
   $ScratchConfig = [IO.Path]::GetFullPath((Read-Host "Absolute SCRATCH CONFIG OUTSIDE REPO path from step 2"))
   Write-Host "DELETE TARGET: $ScratchDatabase is disposable scratch, not production."
   $ConfirmedScratch = Read-Host "Read DELETE TARGET aloud, then re-enter the exact scratch name"
   if ($ConfirmedScratch -cne $ScratchDatabase) { throw "Scratch deletion target was not confirmed." }
   $CleanupSql = "DROP TRIGGER IF EXISTS scratch_case_wrapped_raise; DROP TRIGGER IF EXISTS scratch_unique_guard_insert; DROP TABLE IF EXISTS scratch_unique_guard;"
   & node $wrangler d1 execute $ScratchDatabase --remote --config $ScratchConfig --env '' "--command=$CleanupSql"
   if ($LASTEXITCODE -ne 0) { throw "Scratch probe cleanup failed." }
   & node $wrangler d1 delete $ScratchDatabase --config $ScratchConfig --env ''
   if ($LASTEXITCODE -ne 0) { throw "Scratch D1 deletion failed." }
   Remove-Item -LiteralPath $ScratchConfig
   if (Test-Path -LiteralPath $ScratchConfig) { throw "Scratch database was deleted but its external config remains; remove it manually." }
   Write-Host "SCRATCH DELETE OK: $ScratchDatabase"
   Write-Host "SCRATCH CONFIG DELETE OK: $ScratchConfig"
   ```

   Wrangler asks for confirmation during deletion; answer `y` only for the
   displayed scratch name. Keep the commit SHA, UTC time, scratch name,
   helper baseline line, production and scratch pending inventories and
   receipt-count and production-coverage lines, dynamic trigger-count line, seed marker, four
   unique-guard lines, preserved-row line, CASE rejection and both deletion
   lines in the protected rollout record. Do not record account identifiers or
   credentials.

10. **Return to the production procedure.** This proof does not authorize the
    apply. If Sid later chooses to apply, use
    [deploy.md, “Migrate, then deploy”](deploy.md#migrate-then-deploy)
    rather than copying scratch commands. Its trap is decisive: `wrangler d1
    migrations apply` applies **every** pending file in the directory, not a
    selected subset. Re-list production and reconcile every pending filename
    with the production inventory recorded at the start and the reviewed
    rollout. Do not substitute scratch's pending set: its helper baseline is
    different. Before applying, run each pending migration's production
    preconditions from its [OWNER-ACTIONS rollout row](../OWNER-ACTIONS.md#waiting-on-sid):
    the guided-assignment, single-use tier-3 tap and D2L receiver rows where
    applicable. Any change to the approved production set requires a fresh run
    of this runbook and fresh review before application.

11. **Stop cleanly on any failure.** If scratch fails partway, earlier
    statements and migrations remain applied. Record the failed filename,
    statement number and exact error, list scratch again, and do not continue
    on that partial database. After preserving evidence, delete it and restart
    with a newly named scratch database. If a production migration ever fails,
    earlier successful migrations likewise remain applied: list production
    again, reconcile its state, and obtain review of the failure. The owner
    never continues to a deploy while any migration failure is unresolved.

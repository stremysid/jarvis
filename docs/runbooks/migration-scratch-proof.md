# Remote-D1 migration scratch proof

This is an owner-attended Windows 11 / PowerShell 7 runbook. Run it from the
repository root. It creates and later deletes a throwaway **remote** D1
database. It does not authorize a production migration or deployment.

1. **Know the boundary.** A clean scratch apply proves that remote D1 accepts
   the repository SQL, rather than only local SQLite. The checks below prove
   that all 197 final trigger names from the nine candidate files exist, both
   unique keys in the scratch guard form reject `INSERT OR REPLACE` and
   `INSERT OR IGNORE`, and remote D1 still rejects the unsupported
   `CASE`-wrapped `RAISE` form. It proves remote-D1 compatibility, not the
   contents of production rows, production bindings, or a deployment.

2. **Name, confirm, and create the throwaway database.** Choose a new name
   containing `scratch`; never reuse an existing database. Read the displayed
   sentence aloud before typing the same name again. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $ScratchDatabase = Read-Host "New throwaway D1 name containing 'scratch'"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch 'scratch') { throw "The name must visibly say scratch." }
   Write-Host "TARGET: $ScratchDatabase is disposable scratch, not production."
   $ConfirmedScratch = Read-Host "Read TARGET aloud, then re-enter the exact scratch name"
   if ($ConfirmedScratch -cne $ScratchDatabase) { throw "Scratch target was not confirmed." }
   pnpm.cmd exec wrangler d1 create $ScratchDatabase
   if ($LASTEXITCODE -ne 0) { throw "Scratch D1 creation failed." }
   Write-Host "SCRATCH CREATE OK: $ScratchDatabase"
   ```

   Expect the Wrangler success line for the entered name, followed by exactly
   `SCRATCH CREATE OK: <entered name>`. Stop if Wrangler says the name already
   exists or shows any target other than the confirmed scratch name. Do not
   copy the returned database identifier into a repository file.

3. **List, then apply the repository migrations to scratch.** A new database
   must receive the production baseline before the nine candidates, so the
   first list contains the baseline too. Its final nine rows must be these
   names in this order and nothing later. Wrangler applies every pending file
   it lists; answer its attended confirmation only after checking the scratch
   name. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch 'scratch') { throw "The name must visibly say scratch." }
   $GatewayConfig = "apps/cloud-gateway/wrangler.toml"
   $MigrationRoot = "apps/cloud-gateway/src/persistence/migrations"
   $RequiredMigrations = @(
     "0016_cloud_memory.sql",
     "0017_owner_passphrase.sql",
     "0018_owner_call_step_up.sql",
     "0019_memory_ingress.sql",
     "0020_school_catchup.sql",
     "0021_voice_owner_delivery.sql",
     "0022_university_tracker.sql",
     "0023_study_coach.sql",
     "0025_archive_literal_history.sql"
   )
   $CandidateMigrations = @(Get-ChildItem -LiteralPath $MigrationRoot -Filter "*.sql" | Sort-Object Name | Select-Object -ExpandProperty Name | Where-Object { $_ -ge "0016_" })
   if (($CandidateMigrations -join "`n") -cne ($RequiredMigrations -join "`n")) { throw "Repository candidates do not match the reviewed nine in order." }
   pnpm.cmd exec wrangler d1 migrations list $ScratchDatabase --remote --config $GatewayConfig --env ''
   if ($LASTEXITCODE -ne 0) { throw "Scratch migration list failed." }
   pnpm.cmd exec wrangler d1 migrations apply $ScratchDatabase --remote --config $GatewayConfig --env ''
   if ($LASTEXITCODE -ne 0) { throw "Scratch migration apply failed. Stop here." }
   $NamesSql = ($RequiredMigrations | ForEach-Object { "'$_'" }) -join ", "
   $AppliedSql = "SELECT name FROM d1_migrations WHERE name IN ($NamesSql) ORDER BY name;"
   $Applied = & pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $AppliedSql 2>&1
   $AppliedExit = $LASTEXITCODE
   $AppliedText = $Applied -join "`n"
   $Applied | Write-Host
   if ($AppliedExit -ne 0) { throw "Scratch migration receipt query failed." }
   foreach ($Migration in $RequiredMigrations) {
     if ($AppliedText -notmatch [regex]::Escape($Migration)) { throw "Missing scratch receipt: $Migration" }
   }
   Write-Host "SCRATCH MIGRATIONS OK: 9/9 candidate receipts present in filename order."
   ```

   Expect Wrangler to report the applied baseline `0001` through `0015`, then
   the nine names above in filename order, then exactly `SCRATCH MIGRATIONS
   OK: 9/9 candidate receipts present in filename order.` A missing,
   reordered, extra later, or failed candidate is a stop.

4. **Prove every named trigger exists.** The files contain 200 `CREATE TRIGGER`
   declarations and three intentional replacements, leaving 197 unique final
   names. This command extracts the names from the exact nine files instead of
   maintaining a second hand-written list. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch 'scratch') { throw "The name must visibly say scratch." }
   $MigrationRoot = "apps/cloud-gateway/src/persistence/migrations"
   $MigrationFiles = @(
     "0016_cloud_memory.sql",
     "0017_owner_passphrase.sql",
     "0018_owner_call_step_up.sql",
     "0019_memory_ingress.sql",
     "0020_school_catchup.sql",
     "0021_voice_owner_delivery.sql",
     "0022_university_tracker.sql",
     "0023_study_coach.sql",
     "0025_archive_literal_history.sql"
   ) | ForEach-Object { Join-Path $MigrationRoot $_ }
   $ExpectedTriggers = @(
     foreach ($MigrationFile in $MigrationFiles) {
       $MigrationSql = Get-Content -Raw -LiteralPath $MigrationFile
       foreach ($Match in [regex]::Matches($MigrationSql, '(?im)^\s*CREATE\s+TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)')) {
         $Match.Groups[1].Value
       }
     }
   ) | Sort-Object -Unique
   if ($ExpectedTriggers.Count -ne 197) { throw "Reviewed trigger inventory changed: expected 197." }
   $TriggerSql = "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name;"
   $TriggerCheck = & pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $TriggerSql 2>&1
   $TriggerExit = $LASTEXITCODE
   $TriggerText = $TriggerCheck -join "`n"
   $TriggerCheck | Write-Host
   if ($TriggerExit -ne 0) { throw "Scratch trigger inventory query failed." }
   $MissingTriggers = @($ExpectedTriggers | Where-Object { $TriggerText -notmatch "(?<![A-Za-z0-9_])$([regex]::Escape($_))(?![A-Za-z0-9_])" })
   if ($MissingTriggers.Count -ne 0) { throw "Scratch trigger proof failed; missing: $($MissingTriggers -join ', ')" }
   Write-Host "TRIGGER CHECK OK: 197/197 named triggers present."
   ```

   Expect exactly `TRIGGER CHECK OK: 197/197 named triggers present.` in the
   result. Any smaller number is a failure even if the migration command exited
   zero.

5. **Prove both unique-key guards defeat both conflict algorithms.** This is
   the existing `STRICT, WITHOUT ROWID` remote-D1 pattern, expanded to test the
   primary key and alternate unique key with both algorithms. In
   **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch 'scratch') { throw "The name must visibly say scratch." }
   $SetupSql = "DROP TRIGGER IF EXISTS scratch_unique_guard_insert; DROP TABLE IF EXISTS scratch_unique_guard; CREATE TABLE scratch_unique_guard (id TEXT PRIMARY KEY, alternate TEXT NOT NULL UNIQUE) STRICT, WITHOUT ROWID; CREATE TRIGGER scratch_unique_guard_insert BEFORE INSERT ON scratch_unique_guard BEGIN SELECT RAISE(ABORT, 'scratch_unique_guard_rejected') WHERE EXISTS (SELECT 1 FROM scratch_unique_guard WHERE id = NEW.id) OR EXISTS (SELECT 1 FROM scratch_unique_guard WHERE alternate = NEW.alternate); END; INSERT INTO scratch_unique_guard (id, alternate) VALUES ('first', 'one');"
   pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $SetupSql
   if ($LASTEXITCODE -ne 0) { throw "Unique-key probe setup failed." }
   $GuardCases = @(
     @{ Name = "OR REPLACE primary key"; Sql = "INSERT OR REPLACE INTO scratch_unique_guard (id, alternate) VALUES ('first', 'two');" },
     @{ Name = "OR IGNORE primary key"; Sql = "INSERT OR IGNORE INTO scratch_unique_guard (id, alternate) VALUES ('first', 'two');" },
     @{ Name = "OR REPLACE alternate key"; Sql = "INSERT OR REPLACE INTO scratch_unique_guard (id, alternate) VALUES ('second', 'one');" },
     @{ Name = "OR IGNORE alternate key"; Sql = "INSERT OR IGNORE INTO scratch_unique_guard (id, alternate) VALUES ('second', 'one');" }
   )
   foreach ($GuardCase in $GuardCases) {
     $GuardOutput = & pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $GuardCase.Sql 2>&1
     $GuardExit = $LASTEXITCODE
     $GuardText = $GuardOutput -join "`n"
     if ($GuardExit -eq 0 -or $GuardText -notmatch 'scratch_unique_guard_rejected') { throw "Unique-key guard failed: $($GuardCase.Name)" }
     Write-Host "UNIQUE GUARD OK: $($GuardCase.Name) -> scratch_unique_guard_rejected"
   }
   $PreservedSql = "SELECT CASE WHEN COUNT(*) = 1 AND MIN(id) = 'first' AND MIN(alternate) = 'one' THEN 'UNIQUE ROW OK: first/one preserved.' ELSE 'UNIQUE ROW FAILED' END AS result FROM scratch_unique_guard;"
   $Preserved = & pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $PreservedSql 2>&1
   $PreservedExit = $LASTEXITCODE
   $PreservedText = $Preserved -join "`n"
   $Preserved | Write-Host
   if ($PreservedExit -ne 0 -or $PreservedText -notmatch [regex]::Escape('UNIQUE ROW OK: first/one preserved.')) { throw "Unique-key probe row changed." }
   ```

   Expect four `UNIQUE GUARD OK` lines ending in
   `scratch_unique_guard_rejected`, then exactly `UNIQUE ROW OK: first/one
   preserved.` Success from any conflict statement is a failure.

6. **Prove `CASE`-wrapped `RAISE` is still rejected.** This deliberately sends
   the unsupported form; failure is the expected result. In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch 'scratch') { throw "The name must visibly say scratch." }
   $CaseSql = "DROP TRIGGER IF EXISTS scratch_case_wrapped_raise; CREATE TRIGGER scratch_case_wrapped_raise BEFORE INSERT ON scratch_unique_guard BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM scratch_unique_guard WHERE id = NEW.id) THEN RAISE(ABORT, 'scratch_case_wrapped_raise_rejected') END; END;"
   $CaseOutput = & pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $CaseSql 2>&1
   $CaseExit = $LASTEXITCODE
   $CaseText = $CaseOutput -join "`n"
   $CaseOutput | Write-Host
   if ($CaseExit -eq 0 -or $CaseText -notmatch 'incomplete input' -or $CaseText -notmatch 'SQLITE_ERROR' -or $CaseText -notmatch '7500') { throw "Expected remote-D1 CASE/RAISE rejection was not observed." }
   Write-Host "CASE RAISE CHECK OK: incomplete input: SQLITE_ERROR [code: 7500]"
   ```

   Expect the command to fail with `incomplete input: SQLITE_ERROR [code:
   7500]`, followed by exactly the `CASE RAISE CHECK OK` line. If remote D1
   accepts the trigger, stop and obtain a new review; do not reinterpret that
   as a pass.

7. **Remove the probe objects, then delete scratch.** In **PowerShell 7**:

   ```powershell
   cd C:\path\to\jarvis
   $ScratchDatabase = Read-Host "Confirmed non-production scratch D1 name to delete"
   if ([string]::IsNullOrWhiteSpace($ScratchDatabase) -or $ScratchDatabase -notmatch 'scratch') { throw "The name must visibly say scratch." }
   Write-Host "DELETE TARGET: $ScratchDatabase is disposable scratch, not production."
   $ConfirmedScratch = Read-Host "Read DELETE TARGET aloud, then re-enter the exact scratch name"
   if ($ConfirmedScratch -cne $ScratchDatabase) { throw "Scratch deletion target was not confirmed." }
   $CleanupSql = "DROP TRIGGER IF EXISTS scratch_case_wrapped_raise; DROP TRIGGER IF EXISTS scratch_unique_guard_insert; DROP TABLE IF EXISTS scratch_unique_guard;"
   pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $CleanupSql
   if ($LASTEXITCODE -ne 0) { throw "Scratch probe cleanup failed." }
   pnpm.cmd exec wrangler d1 delete $ScratchDatabase
   if ($LASTEXITCODE -ne 0) { throw "Scratch D1 deletion failed." }
   Write-Host "SCRATCH DELETE OK: $ScratchDatabase"
   ```

   Confirm deletion only for the displayed scratch name. Expect exactly
   `SCRATCH DELETE OK: <entered name>` after Wrangler succeeds. In the protected
   rollout record, keep the commit SHA, UTC time, scratch name, the `9/9`,
   `197/197`, four unique-guard, preserved-row, CASE rejection, and deletion
   lines. Do not record account identifiers or credentials.

8. **Return to the production procedure.** This proof does not authorize the
   apply. If Sid later chooses to apply, use
   [deploy.md, “R0 item 5: migrate, then deploy”](deploy.md#r0-item-5-migrate-then-deploy)
   rather than copying scratch commands. Its trap is decisive:
   `wrangler d1 migrations apply` applies **every** pending file in the
   directory, not a selected subset. The owner runs its `migrations list` step
   first and reconciles both the count and names to exactly the nine filenames
   in step 3. More, fewer, or differently named files means stop.

9. **Stop cleanly on any failure.** If scratch fails partway, earlier
   migrations remain applied. Record the failed filename and exact error, list
   scratch again, and do not continue the proof on that partial database;
   after preserving evidence, delete it and restart with a newly named scratch
   database. If a production migration ever fails, earlier successful
   migrations likewise remain applied: list production again, reconcile its
   state, and obtain review of the failure. The owner never continues to a
   deploy while any migration failure is unresolved.

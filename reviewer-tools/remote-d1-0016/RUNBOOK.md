# Migration 0016 test run on a throwaway database

**What this does.** It makes a throwaway Cloudflare database called
`jarvis-scratch-0016-proof`, puts the new memory schema on it, runs about 40
tests, and then deletes it. Your real `jarvis` database is never touched. It
takes about 20 minutes.

**How to run it.**
- Use **PowerShell 7**, the app named "PowerShell". Do not use "Windows
  PowerShell".
- Keep **one window** open for all ten steps.
- Paste one block, press Enter, and check the "You should see" line.
- **If anything is red, stop.** Do step 9 and step 10, then tell the reviewer.

---

## Reviewer only (Sid skips this section)

**Before handing this over:**
1. The SQL has cleared Claude max review on the S1–S4 fix head. Put that
   commit in step 1 in place of `<REVIEWED_SHA>`.
2. Follow FIX-DEPENDENT.md: set `FIX_HEAD = true`, regenerate `probes\` and
   `expected\`, re-run LOCAL-VALIDATION.md on the fix head, and correct the
   object counts in steps 5, 6 and 8 (309 / 494 / 520 at `8b62e80`).
3. Copy `wrangler.scratch.toml`, `probes\`, `expected\` and `base-rewrites\`
   into `C:\Users\Sid\j16proof\`. The toml must still contain
   `SCRATCH_DATABASE_ID_NOT_SET`.
4. Confirm from the latest production record whether `0017` is applied (see
   "Migration order").
5. Confirm the Cloudflare account has room for one more D1 database.

**What this proves on the real D1 service:**
- **The apply.** The whole of 0016 applies through `wrangler d1 migrations
  apply --remote`. Wrangler 4.127.1 sends each migration file as one `/query`
  request, and 0016 is 125,409 bytes, the largest yet (0006, at 30 KB, is the
  largest that has applied remotely).
- **The schema.** The stored schema matches the local inventory, and
  `PRAGMA recursive_triggers` is 0.
- **Recursive CTEs.** All 5 recursive CTE definitions in
  `memory_topic_events_insert_guard` (the create, move and merge branches)
  accept the deepest valid operations and reject cycles and depth overflow.
- **Clock bounds.** `strftime('now')` in the WHEN clauses of
  `memory_topic_events_insert_guard` and `memory_runs_insert_guard` accepts
  "now" and rejects ±10 minutes.
- **The CASE expression.** The `CASE … END` inside the WHEN clause of
  `memory_item_transitions_insert_guard` evaluates correctly.
- **Guards.** Owner-command binding and freshness, and the INSERT/UPDATE OR
  REPLACE guards.

**What it does not prove:** production data volume, Worker runtime code,
Vectorize, the nightly export, or anything about the production apply. That
remains a separate operation that Sid confirms.

**Migration order.** The run applies `0001`–`0015`, then `0016`, then the
probes, then `0017`.
- **The likely production path.** At `2619f02`, HANDOFF.md and NEXT_STEPS.md
  record production through 0015 only. A production `migrations apply` would
  therefore apply 0016 and then 0017, because Wrangler picks pending files by
  name. This run reproduces that.
- **If 0017 goes first.** If Sid applies 0017 to production first, 0016 later
  applies after it. That order passed locally but is not re-run remotely here.
- **Staging.** Each step copies in only the files it means to apply, and checks
  the pending list before applying.

**Base-migration rewrites.** A fresh remote D1 rejects the `SELECT CASE WHEN …
THEN RAISE(…) END;` trigger statements in 0001, 0002 and 0006 (AGENT_LOG,
2026-09-13 20:35).
- `base-rewrites\` holds probe-only copies with those 7 statements rewritten to
  `SELECT RAISE(…) WHERE …;`. `base-rewrites\rewrite.diff` shows the change.
  The 0015 proof did the same.
- 0016 and 0017 are applied verbatim from the reviewed commit.

**Why `node` rather than `npx.cmd`.** Probes pass multi-line SQL containing `%`,
quotes and JSON on the command line, and `.cmd` wrappers re-parse and truncate
that. `docs/runbooks/deploy.md` invokes Node directly for the same reason.
`node.exe` is not a script, so the execution policy does not apply.

**Why `--command` rather than `--file`.** Probes use `--command`, which goes
through the D1 `/query` path. `--file` goes through the import API instead.

---

## Step 1: Get the reviewed code

PowerShell 7:
```powershell
cd C:\Users\Sid\jarvis-deploy
git fetch origin
git worktree add --detach C:\Users\Sid\j16src <REVIEWED_SHA>
cd C:\Users\Sid\j16src
pnpm.cmd install --frozen-lockfile
git status --porcelain
git rev-parse HEAD
```
You should see: the install ends with `Done`, `git status` prints nothing, and
the last line is `<REVIEWED_SHA>`.

## Step 2: Load the helpers into this window

Paste this once. If you close the window, paste it again before going on.

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
$Src = 'C:\Users\Sid\j16src'
$Proof = 'C:\Users\Sid\j16proof'
$Target = @('--remote')
$PSNativeCommandArgumentPassing = 'Standard'
$Db = 'jarvis-scratch-0016-proof'
$Cfg = Join-Path $Proof 'wrangler.scratch.toml'
$Wrangler = Join-Path $Src 'node_modules\wrangler\bin\wrangler.js'
$Receipts = Join-Path $Proof 'receipts'
New-Item -ItemType Directory -Force $Receipts | Out-Null

function Invoke-ProofWrangler {
  param([Parameter(Mandatory)][string]$Receipt, [Parameter(Mandatory)][string[]]$WranglerArgs)
  $output = & node $Wrangler @WranglerArgs 2>&1 | ForEach-Object { "$_" } | Out-String
  $code = $LASTEXITCODE
  Set-Content -LiteralPath (Join-Path $Receipts "$Receipt.txt") -Value "exit $code`n$output" -Encoding utf8
  [pscustomobject]@{ Code = $code; Output = $output }
}

function Get-ProofJson {
  param([Parameter(Mandatory)][string]$Output)
  $match = [regex]::Match($Output, '(?ms)^\[.*\]')
  if (-not $match.Success) { return $null }
  try { return @($match.Value | ConvertFrom-Json) } catch { return $null }
}

function Get-D1List {
  $output = & node $Wrangler d1 list --json 2>$null | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'wrangler d1 list failed. Check that Wrangler is logged in.' }
  $list = Get-ProofJson $output
  if ($null -eq $list) { throw 'Unexpected output from wrangler d1 list.' }
  return $list
}

function Assert-ScratchTarget {
  $problems = [System.Collections.Generic.List[string]]::new()
  $gateway = Get-Content -Raw -LiteralPath (Join-Path $Src 'apps\cloud-gateway\wrangler.toml')
  $productionIds = @([regex]::Matches($gateway, 'database_id\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  $productionNames = @([regex]::Matches($gateway, 'database_name\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  if ($productionIds.Count -eq 0) { $problems.Add('could not read the production database id from the gateway wrangler.toml') }
  $config = Get-Content -Raw -LiteralPath $Cfg
  $ids = @([regex]::Matches($config, 'database_id\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  $names = @([regex]::Matches($config, 'database_name\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  if ($ids.Count -ne 1 -or $names.Count -ne 1) {
    $problems.Add('the scratch config must declare exactly one database')
  } else {
    if ($names[0] -ne $Db) { $problems.Add("the scratch config names '$($names[0])' instead of $Db") }
    if ($productionNames -contains $names[0]) { $problems.Add('the scratch config uses a production database name') }
    if ($productionIds -contains $ids[0]) { $problems.Add('THE SCRATCH CONFIG ID EQUALS A PRODUCTION DATABASE ID') }
    if ($ids[0] -eq 'SCRATCH_DATABASE_ID_NOT_SET') { $problems.Add('the scratch database id has not been filled in') }
  }
  if ($config -match '(?m)^\s*binding\s*=\s*"DB"') { $problems.Add('the scratch config uses the production binding name DB') }
  if ($problems.Count -eq 0 -and $Target -contains '--remote') {
    $live = @(Get-D1List | Where-Object { $_.name -eq $Db })
    if ($live.Count -ne 1) { $problems.Add("expected exactly one database named $Db, found $($live.Count)") }
    elseif ($live[0].uuid -ne $ids[0]) { $problems.Add("the scratch config id does not belong to the database named $Db") }
  }
  if ($problems.Count -gt 0) {
    $problems | ForEach-Object { Write-Host "PREFLIGHT FAILED: $_" -ForegroundColor Red }
    throw 'Preflight failed. Stop here and tell the reviewer.'
  }
  Write-Host 'PREFLIGHT OK: the target is the scratch database, not production' -ForegroundColor Green
}

function Invoke-ProofSql {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Expect)
  $sql = Get-Content -Raw -LiteralPath (Join-Path $Proof "probes\$Name.sql")
  $run = Invoke-ProofWrangler -Receipt $Name -WranglerArgs (@('d1', 'execute', $Db) + $Target + @('--config', $Cfg, '--json', '--command', $sql))
  $passed = $false
  if ($Expect -eq 'success') { $passed = $run.Code -eq 0 -and $run.Output -notmatch '"success":\s*false' }
  elseif ($Expect -eq 'ok') { $passed = $run.Code -eq 0 -and $run.Output -match '"ok":\s*1\b' }
  elseif ($Expect.StartsWith('raise:')) { $passed = $run.Code -ne 0 -and $run.Output.Contains($Expect.Substring(6)) }
  elseif ($Expect.StartsWith('errregex:')) { $passed = $run.Code -ne 0 -and $run.Output -match $Expect.Substring(9) }
  elseif ($Expect.StartsWith('regex:')) { $passed = $run.Code -eq 0 -and $run.Output -match $Expect.Substring(6) }
  else { throw "unknown expectation $Expect" }
  $timing = ''
  $results = if ($run.Code -eq 0) { Get-ProofJson $run.Output } else { $null }
  if ($results) {
    $durations = @($results | ForEach-Object { $_.meta.duration } | Where-Object { $null -ne $_ })
    if ($durations.Count -gt 0) {
      $measure = $durations | Measure-Object -Maximum -Sum
      $timing = "  ($($durations.Count) statements, slowest $([math]::Round($measure.Maximum)) ms, total $([math]::Round($measure.Sum)) ms)"
    }
  }
  if ($passed) { Write-Host "PASS  $Name$timing" -ForegroundColor Green }
  else { Write-Host "FAIL  $Name  expected $Expect  (see receipts\$Name.txt)" -ForegroundColor Red }
  return [bool]$passed
}

function Invoke-ProofPlan {
  param([string[]]$Phase = @('main'))
  $plan = Get-Content -Raw -LiteralPath (Join-Path $Proof 'probes\plan.json') | ConvertFrom-Json
  foreach ($entry in $plan) {
    if ($Phase -notcontains $entry.phase) { continue }
    if (-not (Invoke-ProofSql -Name $entry.name -Expect $entry.expect)) {
      Write-Host "STOPPED at $($entry.name). Do not go on; tell the reviewer." -ForegroundColor Red
      return $false
    }
  }
  Write-Host 'ALL PROBES PASSED' -ForegroundColor Green
  return $true
}

function Get-ProofPending {
  param([Parameter(Mandatory)][string]$Receipt)
  $list = Invoke-ProofWrangler -Receipt $Receipt -WranglerArgs (@('d1', 'migrations', 'list', $Db) + $Target + @('--config', $Cfg))
  if ($list.Code -ne 0) { return $null }
  return ,@([regex]::Matches($list.Output, '\d{4}_[a-z0-9_]+\.sql') | ForEach-Object { $_.Value } | Sort-Object -Unique)
}

function Invoke-ProofMigrations {
  param([Parameter(Mandatory)][string]$Step, [Parameter(Mandatory)][string[]]$ExpectedPending)
  $want = (@($ExpectedPending | Sort-Object) -join ', ')
  $before = Get-ProofPending -Receipt "$Step-list-before"
  if ($null -eq $before -or ($before -join ', ') -ne $want) {
    Write-Host "FAIL  $Step  pending migrations are [$($before -join ', ')], expected [$want]" -ForegroundColor Red
    return $false
  }
  $apply = Invoke-ProofWrangler -Receipt "$Step-apply" -WranglerArgs (@('d1', 'migrations', 'apply', $Db) + $Target + @('--config', $Cfg))
  $after = Get-ProofPending -Receipt "$Step-list-after"
  if ($apply.Code -ne 0 -or $null -eq $after -or $after.Count -ne 0) {
    Write-Host "FAIL  $Step  apply exit $($apply.Code); still pending [$($after -join ', ')]  (see receipts\$Step-apply.txt)" -ForegroundColor Red
    return $false
  }
  Write-Host "PASS  $Step  applied [$want]; nothing left pending" -ForegroundColor Green
  return $true
}

function Test-ProofInventory {
  param([Parameter(Mandatory)][string]$Receipt, [Parameter(Mandatory)][string]$Expected)
  $sql = Get-Content -Raw -LiteralPath (Join-Path $Proof 'probes\00-inventory.sql')
  $run = Invoke-ProofWrangler -Receipt $Receipt -WranglerArgs (@('d1', 'execute', $Db) + $Target + @('--config', $Cfg, '--json', '--command', $sql))
  $results = if ($run.Code -eq 0) { Get-ProofJson $run.Output } else { $null }
  if (-not $results) {
    Write-Host "FAIL  $Receipt  inventory query failed  (see receipts\$Receipt.txt)" -ForegroundColor Red
    return $false
  }
  $actual = @($results[0].results)
  $expectedRows = @(Get-Content -Raw -LiteralPath (Join-Path $Proof "expected\$Expected") | ConvertFrom-Json)
  $actualKeys = @($actual | ForEach-Object { "$($_.type)|$($_.name)|$($_.tbl_name)" })
  $expectedKeys = @($expectedRows | ForEach-Object { "$($_.type)|$($_.name)|$($_.tbl_name)" })
  $missing = @($expectedKeys | Where-Object { $actualKeys -notcontains $_ })
  $unexpected = @($actualKeys | Where-Object { $expectedKeys -notcontains $_ })
  $lengths = @{}
  $expectedRows | ForEach-Object { $lengths["$($_.type)|$($_.name)"] = [int]$_.sql_len }
  $lengthDiffs = @($actual | Where-Object {
      $lengths.ContainsKey("$($_.type)|$($_.name)") -and $lengths["$($_.type)|$($_.name)"] -ne [int]$_.sql_len
    } | ForEach-Object { $_.name })
  $counts = ($actual | Group-Object type | Sort-Object Name | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', '
  Write-Host "      $Receipt  $counts"
  $missing | ForEach-Object { Write-Host "      missing: $_" -ForegroundColor Red }
  $unexpected | ForEach-Object { Write-Host "      unexpected: $_" -ForegroundColor Red }
  if ($missing.Count -gt 0 -or $unexpected.Count -gt 0) {
    Write-Host "FAIL  $Receipt  does not match expected\$Expected" -ForegroundColor Red
    return $false
  }
  if ($lengthDiffs.Count -gt 0) {
    Write-Host "NOTE  $Receipt  stored SQL length differs for: $($lengthDiffs -join ', ')  (not a stop; the reviewer checks it)" -ForegroundColor Yellow
  }
  Write-Host "PASS  $Receipt  matches expected\$Expected ($($actual.Count) objects)" -ForegroundColor Green
  return $true
}

function Save-RedactedReceipts {
  $redacted = Join-Path $Proof 'receipts-redacted'
  New-Item -ItemType Directory -Force $redacted | Out-Null
  $uuid = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
  $hex32 = '(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])'
  $email = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  Get-ChildItem -LiteralPath $Receipts -Filter '*.txt' | ForEach-Object {
    $text = Get-Content -Raw -LiteralPath $_.FullName
    $text = $text -replace $uuid, '<uuid>' -replace $hex32, '<hex32>' -replace $email, '<email>'
    Set-Content -LiteralPath (Join-Path $redacted $_.Name) -Value $text -Encoding utf8
  }
  $leaks = @(Get-ChildItem -LiteralPath $redacted -Filter '*.txt' | Select-String -Pattern $uuid, $hex32, $email)
  if ($leaks.Count -gt 0) { throw "Redaction left $($leaks.Count) identifiers. Tell the reviewer." }
  Write-Host "REDACTED  $((Get-ChildItem -LiteralPath $redacted -Filter '*.txt').Count) receipts saved in $redacted" -ForegroundColor Green
}
node $Wrangler --version
```
You should see: `4.127.1` on the last line.

## Step 3: Check Wrangler can see your account

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  $all = Get-D1List
  Write-Host "D1 databases on the account: $($all.Count)"
  Write-Host "production 'jarvis' listed: $(@($all | Where-Object name -eq 'jarvis').Count)"
  Write-Host "leftover scratch databases: $(@($all | Where-Object name -eq $Db).Count)"
}
```
You should see: `production 'jarvis' listed: 1` and `leftover scratch databases: 0`.

## Step 4: Create the scratch database

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  if (@(Get-D1List | Where-Object name -eq $Db).Count -ne 0) { throw "A database named $Db already exists. Stop and tell the reviewer." }
  $config = Get-Content -Raw -LiteralPath $Cfg
  if ($config -notmatch 'SCRATCH_DATABASE_ID_NOT_SET') { throw 'wrangler.scratch.toml is already filled in. Stop and tell the reviewer.' }
  $created = Invoke-ProofWrangler -Receipt '04-create' -WranglerArgs @('d1', 'create', $Db)
  if ($created.Code -ne 0) { throw 'Creating the scratch database failed. Stop and tell the reviewer.' }
  $live = @(Get-D1List | Where-Object name -eq $Db)
  if ($live.Count -ne 1) { throw 'The new database is not listed. Stop and tell the reviewer.' }
  Set-Content -LiteralPath $Cfg -Value ($config -replace 'SCRATCH_DATABASE_ID_NOT_SET', $live[0].uuid) -NoNewline -Encoding utf8
  Assert-ScratchTarget
}
```
You should see: `PREFLIGHT OK: the target is the scratch database, not production`.

## Step 5: Put migrations 0001 to 0015 on it

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  Assert-ScratchTarget
  $mig = Join-Path $Proof 'migrations'
  if (Test-Path -LiteralPath $mig) { throw 'The migrations folder already exists. Stop and tell the reviewer.' }
  New-Item -ItemType Directory $mig | Out-Null
  $srcMig = Join-Path $Src 'apps\cloud-gateway\src\persistence\migrations'
  Get-ChildItem -LiteralPath $srcMig -Filter '*.sql' | Where-Object { $_.Name -match '^00(0[1-9]|1[0-5])_' } | Copy-Item -Destination $mig
  Copy-Item -Path (Join-Path $Proof 'base-rewrites\*.sql') -Destination $mig -Force
  $base = @(Get-ChildItem -LiteralPath $mig -Filter '*.sql' | ForEach-Object Name)
  if ($base.Count -ne 15) { throw "Expected 15 base migrations, found $($base.Count). Stop and tell the reviewer." }
  if (-not (Invoke-ProofMigrations -Step '05-base-0001-0015' -ExpectedPending $base)) { throw 'Stop here. Do steps 9 and 10, then tell the reviewer.' }
  if (-not (Test-ProofInventory -Receipt '06-inventory-after-0015' -Expected 'inventory-after-0015.json')) { throw 'Stop here. Do steps 9 and 10, then tell the reviewer.' }
}
```
You should see: two green PASS lines, the second ending `(309 objects)`. It
takes about a minute.

## Step 6: Apply 0016

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  Assert-ScratchTarget
  Copy-Item -LiteralPath (Join-Path $Src 'apps\cloud-gateway\src\persistence\migrations\0016_cloud_memory.sql') -Destination (Join-Path $Proof 'migrations')
  if (-not (Invoke-ProofMigrations -Step '07-apply-0016' -ExpectedPending @('0016_cloud_memory.sql'))) { throw 'Stop here. Do steps 9 and 10, then tell the reviewer.' }
  if (-not (Test-ProofInventory -Receipt '08-inventory-after-0016' -Expected 'inventory-after-0016.json')) { throw 'Stop here. Do steps 9 and 10, then tell the reviewer.' }
}
```
You should see: two green PASS lines, the second ending `(494 objects)`.

## Step 7: Run the tests

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  Assert-ScratchTarget
  if (-not (Invoke-ProofPlan)) { throw 'Stop here. Do steps 9 and 10, then tell the reviewer.' }
}
```
You should see: a column of green PASS lines ending with `ALL PROBES PASSED`.
It takes about 2 minutes.

## Step 8: Apply 0017 on top

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  Assert-ScratchTarget
  Copy-Item -LiteralPath (Join-Path $Src 'apps\cloud-gateway\src\persistence\migrations\0017_owner_passphrase.sql') -Destination (Join-Path $Proof 'migrations')
  if (-not (Invoke-ProofMigrations -Step '09-apply-0017' -ExpectedPending @('0017_owner_passphrase.sql'))) { throw 'Stop here. Do steps 9 and 10, then tell the reviewer.' }
  if (-not (Test-ProofInventory -Receipt '10-inventory-after-0017' -Expected 'inventory-after-0017.json')) { throw 'Stop here. Do steps 9 and 10, then tell the reviewer.' }
}
```
You should see: two green PASS lines, the second ending `(520 objects)`.

## Step 9: Delete the scratch database

Always do this step, even after a red line. When asked, type `DELETE`.

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  Assert-ScratchTarget
  $typed = Read-Host "Type DELETE to delete $Db"
  if ($typed -cne 'DELETE') { throw 'Nothing was deleted.' }
  $deleted = Invoke-ProofWrangler -Receipt '11-delete' -WranglerArgs @('d1', 'delete', $Db, '--skip-confirmation')
  $all = Get-D1List
  if (@($all | Where-Object name -eq $Db).Count -eq 0) { Write-Host "GONE: $Db no longer exists" -ForegroundColor Green }
  else { Write-Host "STILL THERE: $Db was not deleted (exit $($deleted.Code)). Tell the reviewer." -ForegroundColor Red }
  Write-Host "production 'jarvis' still listed: $(@($all | Where-Object name -eq 'jarvis').Count)"
  Set-Content -LiteralPath $Cfg -Value ((Get-Content -Raw -LiteralPath $Cfg) -replace 'database_id = "[^"]*"', 'database_id = "SCRATCH_DATABASE_ID_NOT_SET"') -NoNewline -Encoding utf8
}
```
You should see: `GONE: jarvis-scratch-0016-proof no longer exists` and
`production 'jarvis' still listed: 1`.

## Step 10: Keep the redacted receipts and clean up

PowerShell 7:
```powershell
cd C:\Users\Sid\j16proof
& {
  if (@(Get-D1List | Where-Object name -eq $Db).Count -ne 0) { throw 'The scratch database still exists. Do not clean up; tell the reviewer.' }
  Save-RedactedReceipts
  Remove-Item -Recurse -Force -LiteralPath $Receipts
  Remove-Item -Recurse -Force -LiteralPath (Join-Path $Proof 'migrations')
  git -C C:\Users\Sid\jarvis-deploy worktree remove --force C:\Users\Sid\j16src
  Write-Host 'CLEANED UP' -ForegroundColor Green
}
```
You should see: `REDACTED …`, then `CLEANED UP`. Then tell the reviewer
"0016 test run done".

---

## Reviewer: reading the result

**Receipts.** They are in `C:\Users\Sid\j16proof\receipts-redacted\`, one file
per Wrangler command, each starting with `exit N`. UUIDs, 32-hex identifiers and
email addresses appear as `<uuid>`, `<hex32>` and `<email>`. Step 10 deletes the
raw folder only after redaction succeeds, and only once the database is gone.

**What to check:**
- **0016 apply:** `07-apply-0016-apply.txt` shows it applied in one request.
- **Inventory notes:** a yellow `NOTE` line from step 5, 6 or 8 (stored SQL
  length differs) needs an explanation before production. A red `missing:` or
  `unexpected:` line is a stop.
- **PRAGMA:** `01-pragma-recursive-triggers.txt` shows 0.
- **Timings:** step 7 prints each probe's statement count and slowest statement.
  For 12, 13, 41 and 42 (the deep topic operations), record the slowest. It must
  be far below D1's 30-second query limit.
- **Guard names:** every `raise:` probe's receipt names the expected guard. The
  runner already checks the text, so this is a spot check.
- **Deletion:** step 9 printed `GONE`.

**If step 6 fails** with a size error, `SQLITE_TOOBIG`, `statement too long` or
`incomplete input`, 0016 cannot be applied to production with `wrangler d1
migrations apply` as it stands. Take it back to the builder, with the receipt.

**If step 4 created the database but failed before writing its id,** step 9's
preflight will refuse. Check `Get-D1List` yourself and give Sid an explicit
delete-by-name command. Do not improvise inside the runbook.

**Never:**
- run `wrangler d1 export` (banned in this project, and it refuses FTS5
  databases);
- run any command that names `jarvis` or `apps\cloud-gateway\wrangler.toml` as
  a target;
- use `--remote` without `Assert-ScratchTarget`;
- apply to production on the strength of this run.

## Probe list

`expect` values: `success`; `ok` (the check query returns `ok = 1`);
`raise:NAME` (the statement fails and the error names the guard);
`errregex:` / `regex:` (a failing or succeeding run whose output matches). The
`phase` column is `main` for step 7. `fix-dependent` probes are skipped until
FIX-DEPENDENT.md is applied.

| Probe | Phase | Expect | What it proves |
|---|---|---|---|
| `01-pragma-recursive-triggers` | main | `regex:"recursive_triggers":\s*0\b` | REPLACE deletes must not fire delete triggers; the guards assume recursive_triggers = 0 |
| `10-seed-owner-events-commands` | main | `success` | seed the owner, two turns and four owner commands (C0 is deliberately older than C1) |
| `11-seed-item` | main | `success` | seed item M1 with a rules 'proposed' transition |
| `12-seed-topics-depth-01-32` | main | `success` | chain A01..A32; every create runs the create-branch recursive CTE. Triggers: memory_topic_events_insert_guard (create CTE), memory_topic_events_apply, memory_topics_insert_guard |
| `13-seed-topics-depth-33-64` | main | `success` | chain A33..A64 (depth 64 is the maximum valid depth). Triggers: memory_topic_events_insert_guard (create CTE at depth 63) |
| `14-seed-topics-branch` | main | `success` | branch B02..B20 under A01 (a subtree 19 deep) |
| `15-seed-topics-merge-replay-placement-cursor-price` | main | `success` | merge source D02 with children, replay tree F01/F02/F03 with three moves, a placement on D02, a cursor and a price. Triggers: memory_topic_events_insert_guard (move CTE), memory_topics_update_guard, memory_item_placement_events_insert_guard/apply_state |
| `19-check-seed` | main | `ok` | seed projected exactly once: 90 topics, 93 topic events, depth 64 |
| `20-owner-transition-activate` | main | `success` | valid owner activation through memory_valid_owner_commands (CASE in the WHEN clause evaluates remotely). Triggers: memory_item_transitions_insert_guard, memory_item_transitions_apply_state, memory_item_state_insert_guard/update_guard |
| `21-check-owner-activate` | main | `ok` | owner activation projected once and is retrievable |
| `22-owner-transition-not-a-command` | main | `raise:memory_item_transition_invalid` | a conversation turn cannot authorize an owner transition |
| `23-owner-transition-stale-command` | main | `raise:memory_item_transition_invalid` | command C0 matches every operand but is older than the current transition's command |
| `24-owner-transition-fresh-command` | main | `success` | control for 23: the identical row with the newer command C2 is accepted |
| `25-check-owner-superseded` | main | `ok` | exactly one accepted transition per command |
| `30-replace-cursor-rewind` | main | `raise:memory_cursor_duplicate` | H2: REPLACE on the natural key cannot rewind a cursor |
| `31-replace-price-natural-key` | main | `raise:memory_model_price_duplicate` | REPLACE with a new price_id on the (principal, model, effective_at) key |
| `32-replace-version-rowid-alias` | main | `raise:memory_item_version_lineage_invalid` | REPLACE through the FTS content rowid alias (explicit rowid) |
| `33-replace-item-state-copy` | main | `raise:memory_item_state_requires_transition` | REPLACE of a projection row by its own key |
| `34-replace-update-topic-key` | main | `raise:memory_topic_update_requires_event` | UPDATE OR REPLACE cannot rewrite a topic key onto another topic |
| `35-replace-topic-event-copy` | main | `raise:memory_topic_event_invalid` | REPLACE of an appended topic event by its own id |
| `39-check-replace-unchanged` | main | `ok` | every rejected REPLACE left the rows untouched |
| `40-owner-topic-move-wrong-operand` | main | `raise:memory_topic_event_invalid` | command C3 authorizes parent A45, not A44 (operand binding) |
| `41-owner-topic-move-deep` | main | `success` | valid owner move of the 19-deep branch under A45: ancestors 45 + subtree 19 = 64. Triggers: memory_topic_events_insert_guard (move: ancestors + subtree CTEs, owner command), memory_topics_update_guard |
| `42-merge-deep` | main | `success` | valid merge of D02 into A60: ancestors 60 + descendants 2 = 62; reparents two children and moves one placement. Triggers: memory_topic_events_insert_guard (merge: ancestors + descendants CTEs), memory_topic_events_apply, memory_topic_aliases_insert_guard, memory_topics_update_guard, memory_item_placement_state_update_guard |
| `49-check-deep` | main | `ok` | deep move and merge each projected exactly once |
| `50-replay-stale-direct-update` | main | `raise:memory_topic_update_requires_event` | re-projecting the older first move of F03 is refused |
| `51-replay-older-event` | main | `raise:memory_topic_event_invalid` | an otherwise valid move dated before F03's current event is refused by the insert guard (memory_topics_update_guard would also refuse it) |
| `60-cycle-move` | main | `raise:memory_topic_event_invalid` | F02 is now a child of F03, so moving F03 under F02 is a cycle (only the move CTE rejects it) |
| `61-cycle-merge` | main | `raise:memory_topic_event_invalid` | merging F01 into its own descendant F02 (only the merge CTE rejects it) |
| `62-depth-create-65` | main | `raise:memory_topic_event_invalid` | the create CTE caps depth at 64 |
| `63-depth-move-over-64` | main | `raise:memory_topic_event_invalid` | ancestors 50 + subtree 19 = 69 (depth-sum clause only) |
| `64-depth-merge-over-64` | main | `raise:memory_topic_event_invalid` | ancestors 63 + descendants 2 = 65 (merge depth-sum clause only) |
| `69-check-topics-unchanged` | main | `ok` | no hostile topic probe changed anything |
| `70-clock-topic-future` | main | `raise:memory_topic_event_invalid` | topic event dated now + 10 minutes (strftime('now', '+5 minutes') bound) |
| `71-clock-topic-now` | main | `success` | control for 70: the same rename dated now is accepted |
| `72-clock-run-now` | main | `success` | run started now passes both strftime('now') bounds. Triggers: memory_runs_insert_guard |
| `73-clock-run-past` | main | `raise:memory_run_initial_state_invalid` | run backdated 10 minutes |
| `74-clock-run-future` | main | `raise:memory_run_initial_state_invalid` | run started 10 minutes in the future |
| `79-check-clock` | main | `ok` | exactly one clock-bounded row of each kind was accepted |
| `80-s1-seed-unreferenced-price` | fix-dependent | `success` | S1 seed: a price no run references |
| `81-s1-replace-price-explicit-rowid` | fix-dependent | `success` (after fix: `errregex:rowid`) | S1: REPLACE by explicit rowid deletes the guarded price row at 8b62e80; WITHOUT ROWID removes the column |
| `82-s1-check-price-survives` | fix-dependent | `regex:"ok":\s*0\b` (after fix: `ok`) | S1: Y4 must survive (at 8b62e80 it is gone, ok = 0) |
| `83-s2-seed-siblings` | fix-dependent | `success` | S2 seed: same-named topics under different parents |
| `84-s2-rename-onto-sibling-plain` | fix-dependent | `errregex:UNIQUE constraint failed` (after fix: `raise:memory_topic_event_invalid`) | S2: plain rename onto a sibling name fails on the unique index today, on the named guard after the fix |
| `85-s2-move-onto-sibling-replace` | fix-dependent | `success` (after fix: `raise:memory_topic_event_invalid`) | S2: REPLACE carried into the move apply deletes sibling G04 at 8b62e80 |
| `86-s2-rename-onto-sibling-replace` | fix-dependent | `success` (after fix: `raise:memory_topic_event_invalid`) | S2: REPLACE carried into the rename apply deletes sibling G02 at 8b62e80 |
| `87-s2-check-siblings-survive` | fix-dependent | `regex:"ok":\s*0\b` (after fix: `ok`) | S2: all four sibling topics must survive (at 8b62e80 two are deleted) |
| `88-s3-seed-owner-locked-items` | fix-dependent | `success` | S3 seed: three owner-activated items (M2 valid_to 2026-10-01, M4 valid_to already past) |
| `89-s3-rules-expire-future-dated` | fix-dependent | `success` (after fix: `raise:memory_item_transition_invalid`) | S3: rules expire an owner-confirmed fact early by future-dating occurred_at past valid_to |
| `90-s3-owner-transition-backdated` | fix-dependent | `success` (after fix: `raise:memory_item_transition_invalid`) | S3: transition dated before the current state's updated_at |
| `91-s3-rules-expire-now-plus-10` | fix-dependent | `success` (after fix: `raise:memory_item_transition_invalid`) | S3: rules expiry dated now + 10 minutes (new strftime('now') bound in the transition guard) |
| `92-s3-rules-expire-now` | fix-dependent | `raise:memory_item_transition_invalid` (after fix: `success`) | S3 control: rules expiry of M4 (valid_to past) dated now; at 8b62e80 it fails only because 91 already expired M4 |
| `93-s4-ledger-reservation-now` | fix-dependent | `success` (after fix: `success`) | S4 control: reservation dated now on run X1 |
| `94-s4-ledger-reservation-future` | fix-dependent | `success` (after fix: `raise:memory_cost_entry_lineage_invalid`) | S4: reservation dated now + 10 minutes lands in a later month bucket |

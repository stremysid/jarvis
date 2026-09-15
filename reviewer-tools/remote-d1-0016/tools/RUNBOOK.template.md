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
<<SESSION_FUNCTIONS>>
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

<<PROBE_TABLE>>

# Local validation of the 0016 remote-proof kit

All runs were local. `--remote` was never used, and no Cloudflare account call
was made.

**Setup**
- Windows 11, PowerShell 7, Node 24, Wrangler **4.127.1** (from the lockfile,
  not 4.124).
- Worktree `C:\Users\Sid\jarvis-pr39-remote` at
  `origin/codex/r2-memory-schema-0016` = `c34ab17`. That commit only adds an
  AGENT_LOG entry, so 0016 there is byte-identical to `8b62e80`: `git diff
  --stat 8b62e80 HEAD` shows only `docs/AGENT_LOG.md`.
- The worktree was removed afterwards.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Original 0001–0015 then 0016, applied locally with `d1 migrations apply --local` | applied; `PRAGMA recursive_triggers` = 0 |
| 2 | Probe-only base rewrites (`base-rewrites\`): 3 statements in 0001, 3 in 0002, 1 in 0006, from `SELECT CASE WHEN c THEN RAISE(…) END;` to `SELECT RAISE(…) WHERE c;` | 7 rewrites, 0 `SELECT CASE` left; diff in `base-rewrites\rewrite.diff` |
| 3 | Expected inventories built from the rewritten base | after 0015: 309 objects (133 index, 59 table, 117 trigger). After 0016: 494 (199 / 97 / 192 / 6 views). After 0017: 520 (207 / 101 / 206 / 6) |
| 4 | What 0016 adds | 38 tables (23 memory + 3 FTS5 + 12 FTS shadow), 6 views, 75 triggers, 66 indexes; removes nothing. This matches Codex's "23 memory tables, three FTS5 tables, six views, 75 triggers". 0017 adds 4 tables, 14 triggers and 8 indexes. |
| 5 | **Full runbook flow** in PowerShell 7 (steps 5–8 and 10), using `tools\session-functions.ps1` verbatim with `$Target = --local --persist-to` in place of `--remote`. Base files were copied from the CRLF worktree, as on Sid's checkout. | all PASS: base 0001–0015, inventory 309, 0016, inventory 494, **40 main probes**, **14 fix-dependent probes** at their `8b62e80` expectations, 0017, inventory 520, 66 receipts redacted. 101 s. Slowest local statement: 3 ms (`42-merge-deep`) |
| 6 | **Reverse order** (0001–0015, then 0017, then 0016), then the main probes | inventory identical to `inventory-after-0017.json` (520); `ALL PROBES PASSED`; 83 s |
| 7 | **Preflight** (`Assert-ScratchTarget`) against the commented `wrangler.scratch.toml` | placeholder id: refused. Scratch id: accepted. **Production database id from `apps/cloud-gateway/wrangler.toml`: refused.** Production name `jarvis`: refused. Production binding `DB`: refused. No id is printed in any case. The step 4 id substitution and step 9 reset round-trip exactly. |
| 8 | Inventory regeneration snippet (below) | regenerated 520 rows, identical to `inventory-after-0017.json`, and `Test-ProofInventory` passes against it |
| 9 | Post-S1 error text, on a throwaway local WITHOUT ROWID table | `INSERT … (rowid, …)` gives `table t has no column named rowid: SQLITE_ERROR`; `(SELECT rowid FROM t …)` gives `no such column: rowid at offset 48: SQLITE_ERROR` |

### Clause isolation (item 10)

Every topic guard raises the same `memory_topic_event_invalid`, so a passing
message check alone does not show which clause fired. For each hostile probe
below, 0016 was mutated at `8b62e80` to remove only its target clause. The
mutant was applied on the post-0015 state, the seeds were run, and then the
probe. **Killed** means the hostile statement was accepted once the clause was
gone.

| Mutant (lines at `8b62e80`) | Clause removed | Probe | Result |
|---|---|---|---|
| a (1861–1880) | create-branch ancestors CTE, depth 64 | `62-depth-create-65` | killed |
| b (1929–1962) | move-branch ancestors + subtree CTEs | `60-cycle-move` | killed |
| b (1929–1962) | same | `63-depth-move-over-64` | killed |
| c (1990–2027) | merge-branch ancestors + descendants CTEs | `61-cycle-merge` | killed |
| c (1990–2027) | same | `64-depth-merge-over-64` | killed |
| d (1810) | `occurred_at > strftime('now', '+5 minutes')` | `70-clock-topic-future` | killed |
| e (2649–2650) | run `started_at` bounds at `now` ±5 minutes | `73-clock-run-past` | killed |
| e (2649–2650) | same | `74-clock-run-future` | killed |
| f (1470–1483) | owner-command freshness (`command.sequence > …`) | `23-owner-transition-stale-command` | killed |
| g (1832) | `newParentTopicId` operand binding | `40-owner-topic-move-wrong-operand` | killed |
| h (1811–1822) | "older than the topic's current event" | `51-replay-older-event` | **not isolated**: still refused, by `memory_topics_update_guard` (`memory_topic_update_requires_event`) in the apply. Stale replay is refused by both; the probe's purpose text says so. |

In short, every recursive CTE clause and every `strftime('now')` clause in
0016's triggers has a remote probe that only that clause rejects, plus an
accepted valid operation that exercises it.

## Found while validating (already reflected in the kit)

- **`sqlite_version()` is refused by D1:** `not authorized to use function`. The
  probe was dropped.
- **Remote apply sends each file whole.** `wrangler d1 migrations apply
  --remote` sends each migration file as one `/query` request
  (`buildMigrationQuery`: the file text plus the `d1_migrations` insert). 0016 is
  125,409 bytes.
- **A config id is used without checking.** Wrangler's
  `getDatabaseByNameOrBinding` uses a config `database_id` directly, without
  checking the name. That is why every remote step re-checks, through `d1 list
  --json`, that the id belongs to `jarvis-scratch-0016-proof`. Step 9 deletes by
  name, with no config.
- **`--file` takes a different path.** `d1 execute --remote --file` uses the D1
  import API, not `/query`. Probes use `--command`, which needs `node
  wrangler.js`, because `.cmd` shims break multi-line SQL.
- **Local workerd and long paths.** Local workerd fails with `internal error`
  when `--persist-to` is under the long Claude Temp path. Validate from a short
  path.
- **Local state follows the config id.** Local D1 names its SQLite file after
  the config `database_id`. Changing the id gives an empty database, and the
  pending-list check in `Invoke-ProofMigrations` then refuses to apply, as
  designed.
- **Local error format.** A local RAISE shows as `<guard>:
  SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`. The runner matches
  only the guard name.

## Not validated locally (only the remote run can show these)

- **The 125 KB request.** Whether remote D1 accepts 0016 as a single request.
  The largest applied remotely so far is 0006, at 30 KB.
- **Constructs inside trigger WHEN clauses on the remote service.** Recursive
  CTEs, `strftime('now')`, and the `CASE … END` in
  `memory_item_transitions_insert_guard`. A `CASE` expression in a WHEN clause
  is proven remotely for 0004/0006 only.
- **The base rewrites applying remotely.** The 0015 proof applied the
  equivalent rewrite, but not these exact files.
- **Remote output shapes.** The remote error text, the `--json` output layout
  including `meta.duration`, and the field names in `d1 list --json`. Wrangler's
  source reads `uuid` and `name`, but that path was not exercised.
- **Remote inventory contents.** Remote `sqlite_master` may hold internal objects
  besides `_cf_%` and `sqlite_stat%`. They would show as `unexpected:` and stop
  step 5; the reviewer decides.
- **The account-facing commands.** `d1 create`, `d1 delete`, the live-lookup
  branch of `Assert-ScratchTarget`, and the `Read-Host` in step 9.
- **Multi-statement atomicity.** Whether a failing multi-statement `/query`
  rolls back. The kit does not rely on it: every hostile probe is a single
  statement, and seeds must succeed.
- **Remote timings** and the D1 30-second query limit, under real latency.
- **Line endings.** Sid's checkout is CRLF (`core.autocrlf=true`). Remote
  Wrangler normalizes line endings, and a local CRLF run passed.

## Reproducing on the fix head (reviewer)

PowerShell 7:
```powershell
cd C:\Users\Sid\jarvis-deploy
git fetch origin
git worktree add --detach C:\Users\Sid\j16local <FIX_HEAD_SHA>
cd C:\Users\Sid\j16local
pnpm.cmd install --frozen-lockfile
```

Copy this folder's `probes\`, `expected\`, `base-rewrites\`, `tools\` and
`wrangler.scratch.toml` to `C:\Users\Sid\j16local\.proof\flow\`. Then set a fake
id, which is also the id the local state is keyed by:

PowerShell 7:
```powershell
cd C:\Users\Sid\j16local\.proof\flow
$Src = 'C:\Users\Sid\j16local'
$Proof = 'C:\Users\Sid\j16local\.proof\flow'
$Target = @('--local', '--persist-to', (Join-Path $Proof 'state'))
(Get-Content -Raw wrangler.scratch.toml) -replace 'SCRATCH_DATABASE_ID_NOT_SET', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' | Set-Content wrangler.scratch.toml -NoNewline
. ([scriptblock]::Create((Get-Content -Raw (Join-Path $Proof 'tools\session-functions.ps1'))))
```

### Regenerating the expected inventories

Run this after staging and applying each migration set, with the same staging
lines as RUNBOOK steps 5, 6 and 8 and `Invoke-ProofMigrations`. Call it once
after 0015, once after 0016 and once after 0017.

```powershell
function Save-ProofInventory([string]$File) {
  $sql = Get-Content -Raw -LiteralPath (Join-Path $Proof 'probes\00-inventory.sql')
  $run = Invoke-ProofWrangler -Receipt "gen-$File" -WranglerArgs (@('d1', 'execute', $Db) + $Target + @('--config', $Cfg, '--json', '--command', $sql))
  if ($run.Code -ne 0) { throw "inventory query failed for $File" }
  $rows = (Get-ProofJson $run.Output)[0].results
  $rows | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $Proof "expected\$File") -Encoding utf8
  Write-Host "SAVED  expected\$File ($(@($rows).Count) objects)"
}
# Save-ProofInventory 'inventory-after-0015.json'  (then after 0016, then after 0017)
```

### Full flow

This is the exact sequence validated above. It needs a fresh `state` and
`migrations` folder.

```powershell
& {
  Assert-ScratchTarget
  $mig = Join-Path $Proof 'migrations'
  New-Item -ItemType Directory -Force $mig | Out-Null
  $srcMig = Join-Path $Src 'apps\cloud-gateway\src\persistence\migrations'
  Get-ChildItem -LiteralPath $srcMig -Filter '*.sql' | Where-Object { $_.Name -match '^00(0[1-9]|1[0-5])_' } | Copy-Item -Destination $mig
  Copy-Item -Path (Join-Path $Proof 'base-rewrites\*.sql') -Destination $mig -Force
  $base = @(Get-ChildItem -LiteralPath $mig -Filter '*.sql' | ForEach-Object Name)
  if (-not (Invoke-ProofMigrations -Step '05-base-0001-0015' -ExpectedPending $base)) { throw 'stop' }
  if (-not (Test-ProofInventory -Receipt '06-inventory-after-0015' -Expected 'inventory-after-0015.json')) { throw 'stop' }
  Copy-Item (Join-Path $srcMig '0016_cloud_memory.sql') $mig
  if (-not (Invoke-ProofMigrations -Step '07-apply-0016' -ExpectedPending @('0016_cloud_memory.sql'))) { throw 'stop' }
  if (-not (Test-ProofInventory -Receipt '08-inventory-after-0016' -Expected 'inventory-after-0016.json')) { throw 'stop' }
  if (-not (Invoke-ProofPlan -Phase @('main', 'fix-dependent'))) { throw 'stop' }
  Copy-Item (Join-Path $srcMig '0017_owner_passphrase.sql') $mig
  if (-not (Invoke-ProofMigrations -Step '20-apply-0017' -ExpectedPending @('0017_owner_passphrase.sql'))) { throw 'stop' }
  if (-not (Test-ProofInventory -Receipt '21-inventory-after-0017' -Expected 'inventory-after-0017.json')) { throw 'stop' }
  Save-RedactedReceipts
}
```

On the fix head, with `FIX_HEAD = true`, run `Invoke-ProofPlan` with its
default `main` phase. Remove the worktree when done:
`git -C C:\Users\Sid\jarvis-deploy worktree remove --force C:\Users\Sid\j16local`.

The mutants were built by replacing the line ranges in the table above with
`OR 0`, or `AND 1` for the AND-chained clauses f and g. Each mutant was applied
on a copy of the post-0015 state, then seeds `10`–`15`, any prerequisite (`20`
for f, `41` for b), and the target probe were run. On the fix head, re-derive
the line numbers before repeating this.

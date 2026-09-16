## 2026-09-16 17:39 UTC — Claude Opus 5, remote-D1 scratch rehearsal run for real (Sid approved): candidates pass; the runbook needs six fixes

Sid asked me to run the rehearsal myself. I ran `docs/runbooks/migration-scratch-proof.md` against real remote D1 on throwaway databases named `jarvis-scratch-rehearsal-0916a` to `-0916e`. Each was deleted, and none remain. The production database was never addressed. The runbook's PowerShell ran non-interactively; the only change was the answers to `Read-Host`. Where a step failed on Windows I recorded the defect, patched **only my local copy**, and restarted per step 11.

**Rehearsal record, final run at `main` `4e21369`:**
- `SCRATCH BASELINE OK: 15/15 receipts through 0015.` — **`0001`–`0015` replay onto a fresh remote D1.** This is PR #70's rewrite proven on the real service.
- `SEED CHECK OK: principal/device/telegram identity/conversation event.`
- `CANDIDATE RANGE: 0016_cloud_memory.sql through 0028_guest_grant_notice_drain.sql (13 files).`
- `SCRATCH MIGRATIONS OK: 13/13 candidate receipts present in filename order.`
- `TRIGGER CHECK OK: 231/231 named triggers present.`
- Four `UNIQUE GUARD OK … scratch_unique_guard_rejected` lines, then `UNIQUE ROW OK: first/one preserved.`
- `CASE RAISE CHECK OK: incomplete input: SQLITE_ERROR [code: 7500]`
- `SCRATCH DELETE OK` and `SCRATCH CONFIG DELETE OK`

An earlier run at `2d098d0` passed the same way with 12 candidates, `0026` then being the gap, and 221/221 triggers. **Every candidate on `main`, including `0026`'s change to `archive_segment_events`, applies cleanly on remote D1 over pre-existing rows.**

**The runbook as merged cannot be completed by Sid on Windows.** Six defects, each hit for real:
1. **Step 2:** the database id regex expects TOML `database_id = "…"`. Wrangler 4.127 prints JSON `"database_id": "…"`, so step 2 throws after creating the database.
2. **`scripts/prepare-d1-scratch-baseline.mjs`:** `spawnSync('pnpm.cmd', …)` without a shell throws `EINVAL` on current Node for Windows. The baseline never starts.
3. **Same script:** statement 1 of `0001`/`0002`/`0006` starts with the new `-- Production was migrated…` header comment. Passed as `--command`, `<sql>` is parsed by Wrangler's argument parser as flags (`Unknown arguments`). Use `--command=<sql>`.
4. **Every `pnpm.cmd exec wrangler … --env ''`:** PowerShell drops the empty argument on its way to a `.cmd` shim, so Wrangler fails with `Not enough arguments following: env`.
5. **Step 4:** the seed SQL joined with newlines reaches Wrangler cut at the first newline through `pnpm.cmd`. Only the `principals` row is inserted, and the seed check fails.
6. **Step 4:** SQL containing double quotes, the JSON envelope, is split into extra arguments by the `.cmd` shim (`Unknown arguments`).

**One fix covers 2, 4, 5 and 6:** use the pattern `docs/runbooks/deploy.md` already uses, ` = (Resolve-Path 'node_modules/wrangler/bin/wrangler.js').Path` and `& node  …`, and never call `pnpm.cmd exec wrangler`. In the script, spawn `process.execPath` with that path and `--command=<sql>`. `deploy.md`'s production migrate steps already do this, so the production procedure is not affected.

A builder task is queued to fix all six, and to add tests that pin the spawn target and `--command=` form so they are not left to the injected executor. Nothing was applied to production, deployed or merged by this run.

— Claude Opus 5

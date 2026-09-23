# Task brief: the PC agent cannot sync, and its store folder is locked to administrators

You are a **builder** on `stremysid/jarvis`. Read `AGENTS.md` first; this brief is the task and
does not override it. **Verify this brief before trusting it.** It was written 2026-09-23 against
`ec5ebb5`. Where it is wrong, say so; that is a finding.

Two defects, both observed on the home PC on 2026-09-23 right after Sid installed the logon task
(`ops/jarvis-logon-task.ps1`) and started it. They are independent. Fix both, as separate commits
or separate PRs, and say which. **P2 (the PC reading D2L, `briefs-p2-d2l-read.md`) cannot push
anything until problem 1 is fixed.**

## Problem 1: the cloud's sync position is ahead of the PC's archive

### What was observed

- The agent runs, and `jarvis status` answers, but every cycle ends `sync: request failed`.
  It is not an authentication failure: that would read `authentication: device rejected`, and a
  signed pull made from this PC with its key succeeded, with 48 events waiting.
- Read-only production queries (Sid approved):
  - **`sync_ack_receipts`**: this device acknowledged every event through sequence **267** on
    2026-09-22, 00:20–00:34 UTC, in six snapshots (0→48, 48→96, … 240→267). That was during
    #145's testing, with local stores that no longer exist.
  - **`sync_snapshots`**: each of the logon-started agent's later cycles created a root snapshot
    0→48 less than a second before the cycle reported failure (01:33:09 and 01:36:31 UTC).
- **The mechanism, read from the code.** The new archive is empty, so the agent pulls from 0,
  commits the page, and acknowledges with `expectedCurrent: 0`.
  - `SyncService.acknowledgeDurableReceipt` (`src/sync/sync-service.ts`) refuses any
    `expectedCurrent` that is not the consumer's cursor, as `cursor_compare_failed`.
  - `EventReplicator._recover_rejected_ack` (`jarvis_local/sync/event_replicator.py`) re-pulls the
    same range and acknowledges the same way, so every cycle fails, forever.

### Not verified. Check these first.

- **The cursor row itself.** The read of `consumer_cursors` was refused by the session's permission
  check, so 267 is the last receipt's `current_sequence`, not a direct read.
- **The exact refusal reason.** The agent sees only `sync_request_rejected`. The gateway logs the
  real one as `console.error("sync_request_failed", { path, reason })` in `src/http/sync-routes.ts`,
  so the Workers logs would show `cursor_compare_failed` if this is right. Reading them is an owner
  action; if you need it, stop and write the one line Sid should run.
- **The first two cycles created no snapshot at all.** Unexplained.

### What to build

A device must be able to recover when the cloud's cursor for its consumer (`device:<device_id>`)
is ahead of its local archive, without anyone hand-editing production. This will recur on every
reinstall and every new PC, so it needs a real fix, not a one-off repair.

**The design question is yours; argue it in the PR body.** The obvious candidates:

1. **Accept an acknowledgement for a range the cursor already covers**
   (`throughSequence <= cursor`) as a replay, with `currentSequence` set to the cursor.
   - The cursor never moves backwards, and the device catches up page by page until it passes 267.
   - Say what this does to the guarantee an acknowledgement is meant to give.
2. **A signed rebase:** the device declares where its archive really is, and the gateway moves the
   consumer cursor back.
   - Note that `0001_foundation.sql` has a trigger that raises `sync_cursor_compare_failed` when the
     cursor update does not match.
   - Anything that needs a migration takes **the next free number at the time it lands** (`0039` as
     of `ec5ebb5`; `0001`–`0035` and `0038` are taken; `0036`/`0037` are gaps and stay unused), and
     the PR body says which numbers are taken.
3. **Agent-only.** Probably not possible cleanly: the agent cannot learn the cloud cursor from a
   generic `sync_request_rejected`. If you find a clean way, say so.

**Whatever you pick:**
- An acknowledgement must never move the cursor past events the device did not durably store.
- If you want the agent to report *why* it is stuck, return a specific code for this one case
  rather than widening what `sync_request_rejected` hides.

**Tests:**
- A gateway test, and an agent test through `EventReplicator`, where a fresh archive meets a
  consumer cursor already at 267 and ends in sync, through 267.
- A test that a stale acknowledgement cannot move the cursor backwards.
- Mutation-verify each guard.

Events older than 90 days are purged from D1 once `archive_purge_receipts` records them in R2
(`src/archive/archive-repository.ts`). None are that old today, but say what a device re-syncing
after a purge would see.

## Problem 2: the agent's store folder is locked to administrators

### What was observed

- The logon task runs `jarvis serve` **elevated**, and it created `%LOCALAPPDATA%\Jarvis\data`.
- From Sid's normal session, `Test-Path`, `icacls` and `Get-Acl` on that folder are all denied.
- `jarvis config` in a normal window now crashes with an uncaught `PermissionError: [WinError 5]`
  on `archive.sqlite`.
- `jarvis status` still works, because it goes through the pipe, not the files.

### Likely mechanism. Verify it; it is not established.

- `_ensure_sqlite_directory` (`jarvis_local/archive/database.py`) creates each missing directory
  with `mkdir(mode=stat.S_IRWXU)`.
- Since CPython 3.12.4 on Windows (the CVE-2024-4030 fix), `mode=0o700` becomes a protected DACL
  granting only SYSTEM, Administrators and the object's owner. This PC runs 3.12.6.
- Under an elevated administrator token, a new object's default owner is the Administrators group,
  so the owner entry resolves to Administrators, and Sid's normal token, in which Administrators is
  deny-only, is shut out.
- Check that DACL from an elevated session before you design around it.

### What to build

- **On Windows, create the store directories with an explicit DACL** that grants Sid's own user
  SID, plus SYSTEM, whether the process is elevated or not. `transport/pipe_server.py` already has
  `current_user_sid()` and `owner_only_sddl()`: reuse them, do not write a second copy.
- **Repair a folder that was created the old way.** The elevated agent can re-apply the DACL to its
  own folder at start. Say what it does if it cannot.
- **`jarvis config` reports a permission failure as a sentence and its own exit code**, never a
  traceback. `_config` in `cli.py` currently catches only `NodeConfigurationError`.
- **Tests:** these need Windows. CI has a `local-agent (windows-latest)` job. A test cannot become
  elevated, so assert the DACL you apply (the SID is in it; the inherited entries are not what
  grants access), and drive the `config` failure with a real denied path or a patched `stat`.
  Guard any Windows-only test so the Ubuntu job skips it: #145 went red on Ubuntu for exactly this.

## Absolute rules

- **Never merge, deploy, apply a migration, touch a secret, spend money, or contact anyone.**
  Never write to production. Sid approved read-only queries for the diagnosis above; that approval
  was for that diagnosis, not for you.
- **Never claim a test result you did not observe**, and never state a guess as a cause.
- **Windows only**, `pwsh`, not bash. Work in a worktree under `C:\w`, never in `C:\javis`.
- **Code builds tools; Jarvis makes every decision.** Read `docs/CODE-VS-JUDGMENT.md` before you
  write a condition.

## Gates, and what you owe

The same as `briefs-p2-d2l-read.md`:
- the gates it lists, plus `pnpm test` for any gateway change;
- every guard mutation-verified, with a named test;
- an `AGENT_LOG.md` entry at the top, with its `^## ` heading set checked against `origin/main`.

**Stop and report if stuck.** In particular, if confirming problem 1 needs the Workers logs,
write the one action Sid should take in `OWNER-ACTIONS.md` rather than guessing.

# PR #80 round 4 narrow review at 6693f21

**Verdict: changes required. 1 High, 0 Medium, 4 Low.** The resumable restore works: kill-and-resume, refusals before DDL, the round-3 fixes and the D1 query budget all held on a production-shaped fixture. But the row-insert step fails on a common kind of data. When a row points at another row that sits in a later 62-row page, the page's commit fails its foreign-key check. It fails the same way on every retry, and all 380 triggers are already dropped. Two ordinary cases hit this: a guest call admitted under a voice grant, and a topic merged into a newer topic.

Probes: `C:\Users\Sid\jarvis-pr80r2-adv\apps\cloud-gateway\test\backup\adversarial-pr80r4.test.ts`, copied to `<scratchpad>/pr80r4/adversarial-pr80r4.test.ts`. I ran them in the Workers pool at `6693f21`, and the worktree has only untracked test files. **Result: 8 tests, 4 fail (P1, P2, F1, K1's report check), 1 fails as an inventory (P0), 3 pass (S1, S2, K1 data checks).** Logs: `pr80r4/adv4-k1.txt`, `adv4-s1p2.txt`, `adv4-p2.txt`, `adv4-rest.txt`. The mutation run is in `pr80r4/mutate-r4-results.txt`. It ran only the builder's 28 backup tests and the 3 checker tests.

---

## High

### H1. The restore stops permanently with every trigger dropped when a row references a row in a later page
- **Where:**
  - `memory-backup-restore.ts:699-715` inserts rows in 62-row batches. Each batch sets `PRAGMA defer_foreign_keys = ON`, which lasts only until that batch commits.
  - `memory-backup.ts:20` claims "Dependency order is also restore order", but it isn't:
    - `call_sessions` (`:42`) comes before `voice_access_grants` (`:46`), yet `call_sessions.guest_grant_id` references `voice_access_grants.grant_id`.
    - `conversation_turns` and `conversation_deliveries` sit between those two tables, so ordinary Telegram use pushes them into different pages.
  - The export follows ordinal order, which is not dependency order. So a self-reference inside one table can also point forward. Examples: `memory_topics.redirect_to_topic_id` and `parent_topic_id` (`:73`).
- **Proven:**
  - `P0 foreign keys in MEMORY_BACKUP_TABLES order point only backwards` **fails**. It lists 1 forward cross-table key, `call_sessions.guest_grant_id->voice_access_grants.grant_id`, and 4 self-references.
  - `P1 a guest call admitted under a voice grant…` **fails**. Setup: a voice grant, one guest call under it, and 36 Telegram turns. The restore stopped at `insert_rows` index 310 with a `FOREIGN KEY constraint failed` error. It had 0 triggers, and the retry failed identically.
  - `P2 a topic merged into a newer topic…` **fails**. Setup: an older topic was merged into a topic created 80 topics later. The restore stopped at `insert_rows` index 0 with the same error and 0 triggers.
- **Effect for Sid:** after Jarvis's first guest phone call, or once a topic is merged into a newer topic in a big enough tree, no later backup can be restored. The restore gets part-way, stops with a generic `memory_backup_restore_operator_failed`, and no retry gets past it. It is latent today because voice isn't live, but this is the case the backup exists for.
- **Fix:**
  - Move `voice_access_grants` (and `voice_access_grant_events` if needed) before `call_sessions`.
  - Order rows of self-referencing tables parents first. Alternatively, insert the self-referencing columns as NULL and set them in a later phase while triggers are still dropped.
  - Make P0 a permanent test that fails on any forward foreign key.
  - Add a restore test with a guest call and a merged topic, each separated from its target by more than one page.

## Low

### L1. A retried call during `rebuild_cursors` reports the wrong cursor count
- **Where:** `memory-backup-restore.ts:450-462` and `:740-744`. `rebuilt_cursors` counts only rows inserted by *this* call. The INSERT and the progress update are separate statements.
- **Proven:** `K1` (soft check) **fails**: `report after kills equals uninterrupted report`. It reported `rebuiltCursors` 0 after a kill that came after the INSERT, against 1 uninterrupted. The restored data was identical (`killDiffs: []`).
- **Effect for Sid:** the saved restore report can say "0 cursors rebuilt" when the cursor was restored. It is cosmetic, but the report is the evidence he keeps.
- **Fix:** store the count of cursors that exist after the rebuild, or put the INSERT and the progress update in one batch.

### L2. If the connection drops after `/finalize` succeeds, the restore looks broken
- **Where:**
  - `memory-backup-restore.ts:774-783`: finalize drops the progress table, so a second finalize has nothing to find.
  - Runbook `:182-191` retries the first `/step` 30 times and ignores every 4xx.
  - Runbook `:227-231` covers only deaths "before `complete`".
- **Proven:** `F1 a kill after finalize committed…` **fails**. Retrying finalize returned `memory_backup_restore_not_complete`. Retrying `/step` returned `memory_backup_restore_target_not_fresh:principals`. By reading, the runbook shows either as "Restore operator did not become ready."
- **Effect for Sid:** a finished, correct restore can end with a misleading error. He'd likely delete it and start again. The same readiness loop also hides every real refusal, and H1's error, behind "did not become ready".
- **Fix:**
  - Make finalize idempotent, for example by leaving a small "finalized <runId>" marker.
  - In the readiness loop, stop retrying on an HTTP response and print its `error`.

### L3. Deleting the refusals that keep a different backup set out of a half-restored database breaks no permanent test
- **Where:** `memory-backup-restore.ts`:
  - `:678-681`: progress mismatch and set-hash check;
  - `:241-243`: schema mismatch;
  - `:257-260`: named migration prefix check;
  - `:589-591`: trigger classification check;
  - `:278-280`: seeded-key identity check;
  - `:779`: finalize phase and restore-id check;
  - `:762-764` and `:757`: verify's trigger and foreign-key checks;
  - `:554`: step limit.
- **Proven:** mutation, with the builder's 28 backup tests. These survive: M02–M07, M10–M16, M19.
  - M17 and M18 also survive, but they are close to equivalent mutants. The `valid` CTE's outcome and receipt clauses already exclude failed runs, and runs don't leave gaps.
  - M01, M09 and M20 are killed.
  - M08 is killed only by an unrelated export test. It may be flaky; I didn't re-run it.
  - My `S1` catches M04, M05 and M06; it passes at 6693f21.
- **Effect for Sid:** none today. A later edit could silently remove the check that stops two different backups being mixed into one database.
- **Fix:** make S1 (cases b–f) and a trigger-classification case permanent tests.

### L4. The target checker and the operator's name check don't really identify the database
- **Where:**
  - `scripts/check-memory-backup-restore-target.mjs:61-72` pattern-matches the TOML text rather than parsing it.
  - `memory-backup-restore-operator.ts:35-37` checks only the two `--var` strings, which are not tied to the D1 binding.
- **Proven:** I ran the checker on hand-edited configs (`pr80r4/checker/*.toml`):
  - These pass: `preview_database_id = "<production id>"`, and a TOML-escaped production id (`"\u0033239834d-…"`).
  - These are refused: the literal id, the id in uppercase, a single-quoted id, the id with a trailing comment, an `[env.production]` block, the name `jarvis`, and a config inside the repository.
  - wrangler 4.127.1 `dev` builds bindings with `usePreviewIds: true`, so `preview_database_id` is the database actually bound (`cli.js:136106`, `:257346`).
  - Checker mutations C02–C05 survive its 3 tests; only C01 is killed.
- **Effect for Sid:** none if he follows the runbook, because it generates the config without these fields. The real protection is the API's refusal of a non-empty database before any DDL (S1a).
- **Fix:**
  - Parse the TOML and refuse any `preview_database_id`.
  - Add tests for the name-typed-twice, outside-repository, main-entry and scratch-name refusals.

---

## Checked and sound
- **Kill-and-resume (K1, 3,859 rows):**
  - Setup: 922 events; 116 distillation runs (2 succeeded, 113 nothing_new, and a **failed last run**); changed `autonomy_mode` and `outbound_runtime_controls`; a voice grant; history fully indexed.
  - The restore was killed after **every** D1 operation of every phase (2,318 kills in total), then rerun. That covers after the trigger drops, mid row insert, the derived rebuilds, the history rebuild, the cursor rebuild and trigger recreation, verify, and complete.
  - It finished with data identical to the uninterrupted restore: tables, cursors, history chunks and coverage, FTS results, and 380 triggers.
  - No duplicate rows; triggers were all present at `complete`.
  - Reported progress never moved backwards and always equalled the durable progress row.
- **D1 budget:** the most statements executed in one invocation was **174** (the first one). The other phases, including verify, used at most 105, far under 1,000.
- **Round-3 fixes (K1 source compared with the uninterrupted restore, `[]`):**
  - the distillation cursor lands on the highest contiguous succeeded or nothing_new run, and the failed last run is not skipped;
  - changed seeded rows restore;
  - only `distillation` and `fts_history` cursors exist.
  - `S2`: a later repository migration is ignored for an older set, with no later trigger created.
- **Refusals before any DDL (S1, passes; 0 DDL statements and trigger count unchanged in every case):**
  - a live database → `target_not_fresh`;
  - a set newer than the target → `schema_mismatch`;
  - an unknown migration receipt → `migrations_missing`;
  - a target migrated past the set → `schema_mismatch`;
  - a different set mid-restore, the same run id with changed rows, and a completed but unfinalized restore → `progress_mismatch`.
  - By reading, the operator refuses a name without "scratch" or a mistyped second name before touching D1 (`operator.ts:35-37`).
- **Runbook, by reading (no wrangler was run against anything remote):**
  - It uses `& node $wrangler` throughout, and nothing runs `d1 export`.
  - The scratch D1 is created only after the name is typed twice. Wrangler 4.127.1 prints `d1 create` output as JSON with no prompt when there is no config, so the id regex matches.
  - The external config holds only migrations up to the set's schema version.
  - `Start-Process` quotes each argument with embedded quotes.
  - There is now a real entry point: an authenticated `/step` and `/finalize` Worker run under `wrangler dev --remote`.
  - No step changes production. Production is touched only by read-only `r2 object get` in step 1. A replacement production D1 and its promotion are explicitly out of scope.
- **Checker tests:** 3/3 pass. The literal production id is refused.

## Unverified
- Real `wrangler dev --remote` with D1 and R2 bindings, CPU time per `/step`, and R2 subrequests. Every `/step` re-downloads and re-hashes the whole set, and the history rebuild takes one step per 16 events per owner, so a large restore means thousands of steps that each download the whole set.
- Whether PowerShell's `2>&1` pulls wrangler warnings into the `--json` output and breaks `ConvertFrom-Json` in step 5.
- Two concurrent `/step` callers. By reading, they fail loudly and can be rerun.
- A real recovery into a replacement D1. The operator and checker require "scratch" in the name, so the runbook's "repeat the same flow" can't target a normally named replacement.
- Whether M08's kill is real or flaky.

# PR #80 round 3 narrow review at 01292f2

**Verdict: changes required. 2 High, 2 Medium, 2 Low.** The backup side is sound now. But the new restore path fails on every real database. Its distillation cursor step trips a migration guard whenever more than one distillation run has happened, and Jarvis distils every hour. If that step is forced through, a provider outage before the backup means those messages are never distilled after a restore. Rows, derived state, FTS and triggers otherwise restore exactly.

Probes: `C:\Users\Sid\jarvis-pr80r2-adv\apps\cloud-gateway\test\backup\adversarial-pr80r3.test.ts` (copy in `<scratchpad>/pr80r3/adversarial-pr80r3.test.ts`). I ran them in the Workers pool at `01292f2`. Logs: `pr80r3/adv3-final.txt` and `adv3-r6.txt`. **Result: 8 failed, 2 passed.** A failing test is a proven defect. Two of the failures (R1b, R2b) are diagnostics. They bypass only the H1 guard, for the restore's own cursor INSERT, to see what lies behind it. The worktree is still in place and has only untracked test files.

The fixture (R1) was built with the real services on a fully migrated D1:
- two Telegram turns, delivered through the outbox;
- two hours of distillation with a fake provider (5 runs, 5 items);
- owner remember → forget → lift, plus one memory left forgotten (2 suppressions, 1 lift);
- a school plan save followed by a replan that deletes superseded actions, and a university save;
- literal history indexed to completion (17 chunks);
- 4 events archived and purged (`sealed_through` 4);
- `scheduled_runs` rows 3 days old and 1 hour old;
- hand-seeded rows 6 hours old, inserted with triggers dropped: a finished run, a cost reservation, a price, reprocess and search jobs, a passphrase verifier with BLOB salt and digest, a voice grant with its event, and a delivered guest notice.

That gives 214 backed-up rows. The real backup ran to a verified set, then `readLatestVerifiedMemoryBackup` and `restoreVerifiedMemoryBackupRows` ran against a freshly recreated D1.

---

## High

### H1. Restore fails on any database where distillation has run more than once
- **Where:**
  - `memory-backup-restore.ts:336-340` derives the distillation cursor as `max(event_sequence)` over receipts.
  - `:375-385` INSERTs it after all triggers were recreated (`:501`).
  - `0026_memory_distillation.sql:312-336` (`memory_distillation_cursor_insert_guard`) allows a nonzero cursor INSERT only if one single succeeded or nothing_new run covers events 1 through N.
  - The builder's test passes only because its fixture has exactly one run, covering 1..1.
- **Proven:**
  - `R2a a set whose distillation took two ordinary successful hourly runs restores` **fails**. The runs were 1..1 and 2..2, both succeeded, with source cursor 2. The restore threw `memory_distillation_cursor_advance_invalid`.
  - `R1 production-shaped restore…` **fails** with the same error (5 runs).
- **Effect for Sid:** no backup taken after Jarvis's second hourly distillation can be restored. The restore gets through inserting every row and then stops with an error. A restore would be needed exactly after a D1 loss, so the backup can't bring his memory back.
- **Fix:**
  - Write the rebuilt cursors while triggers are still dropped: before `recreateTriggers`, or with the two distillation cursor guards suspended, like `suspendDerivedStateGuards`.
  - Add a restore test with at least two distillation runs, and one with a failed last run (H2).

### H2. The rebuilt distillation cursor skips events whose last distillation run failed, so they are never distilled
- **Where:** `memory-backup-restore.ts:338-340` takes the max over **all** receipts, whatever the run outcome.
  - A failed, `budget_blocked` or `provider_credit_blocked` run still writes receipts for its whole window (`automatic-distillation.ts:672-682`, `finalizeRun` `:1089-1122`), but it does not advance the cursor.
  - The narrowing path also writes receipts for a wider window than the cursor finally reaches (`:625-633`).
- **Proven:**
  - `R2b (diagnostic: cursor insert guard bypassed)…` **fails**. Setup: event 1 distilled, then event 2's run failed with a provider timeout, leaving the source cursor at 1. The restored cursor was 2. The next distillation step returned `nothing_new`, made 0 provider calls and left 1 item.
  - The same step on the source (R2, run on the restored data before the restore threw) called the provider once and created the second item.
- **Effect for Sid:** if DeepSeek was down, out of credit or over budget in the hour before the backup, anything he said in that window never becomes memory after a restore. Nothing reports the loss.
- **Fix:**
  - Derive the distillation cursor from `memory_runs`: the highest contiguous `end_event_sequence` of `succeeded` or `nothing_new` distillation runs, chained from 1. That is exactly what the update guard accepts.
  - Or restore it from the exported run chain, not from receipts.

## Medium

### M1. A set can't be restored once Sid has changed a row that a migration seeded (autonomy live, outbound calls enabled, quiet hours)
- **Where:** `memory-backup-restore.ts:190-196` requires every backed-up row that already exists in the fresh target to be byte-identical. Otherwise it throws `memory_backup_restore_target_not_fresh`. These rows are seeded by migrations:
  - `autonomy_mode` (`0008:59`), changed by `AutonomyRepository.setMode`;
  - `outbound_runtime_controls` (`0015:37`), changed by `docs/runbooks/voice-smoke.md:243`'s own `UPDATE … SET enabled`;
  - `capability_tiers` (`0008:30`).
- **Proven:** `R3 a set taken after Sid changed a migration-seeded row…` **fails** with `memory_backup_restore_target_not_fresh:autonomy_mode`.
- **Effect for Sid:** once he turns on live autonomy or outbound calls, every later backup fails to restore. It fails loudly, but the backup is unusable.
- **Fix:** for singleton or seeded tables, replace the seeded row with the backed-up row (an UPDATE, or a DELETE and INSERT while triggers are dropped) instead of demanding equality. Test with changed `autonomy_mode` and `outbound_runtime_controls`.

### M2. Sid can't run the runbook, and the restore drops every trigger on whatever database it is handed before checking it
- **Where (runbook, `docs/runbooks/memory-backup-restore.md`):**
  - `:61-75` says to run the API "from a controlled operator program with the target D1 and backup R2 bindings". No such program exists in the repo; the only callers are tests.
  - There isn't a single command: no PowerShell, no `node node_modules/wrangler/bin/wrangler.js`, no scratch-D1 rehearsal, and no step that names the target and asks for a separate confirmation.
  - `:46` says to "record the `latest.json` object version", but R2 has no object versions.
- **Where (code):**
  - `memory-backup-restore.ts:486-494` drops **all** live triggers before any freshness check.
  - Non-fresh data is first detected at `:194` or `:422`.
  - There is no confirmation or target-identity parameter.
- **Where (cost):** the API runs everything in one call:
  - one `PRAGMA table_info` per table (`:174`);
  - one `SELECT` per row (`:191`);
  - one batch of every INSERT (`:204`);
  - 380 DROP and 380 CREATE TRIGGER statements (`:493`, `:213`);
  - the history job.
- **Proven:**
  - `R4 restore pointed at a live (non-fresh) database refuses before changing its schema` **fails**. The live database had moved on after the backup (autonomy set to live). The restore ran **380 `DROP TRIGGER`** statements on it, then threw `target_not_fresh` and recreated 380.
  - R1b measured **1,396 prepared D1 statements to restore 214 rows**.
  - The runbook defects are by reading.
- **Effect for Sid:** he has no procedure he can actually run on Windows. If a future helper script passes the production `DB` binding by mistake, production runs without any guard triggers during the restore. A real-size restore (thousands of rows, well over 1,000 queries) would also exceed Workers Paid's 1,000 D1 queries per invocation. If the invocation dies between the drop and the recreate, production is left with no triggers at all (inferred by reading, not run).
- **Fix:**
  - Ship a restore entry point that is resumable, bounded per invocation, and able to run from PowerShell.
  - Make it refuse any database whose authoritative tables aren't empty (apart from seeded rows) **before** its first DDL.
  - Require the target database name to be typed separately and to differ from the production binding.
  - Rewrite the runbook as exact PowerShell steps: scratch D1 first, `& node node_modules/wrangler/bin/wrangler.js`, never `wrangler d1 export` against production, and a separate confirm step before any production-adjacent action.

## Low

### L1. The runbook's "every migration file" breaks restoring an older set once a newer migration exists
- **Where:**
  - The runbook tells the operator to apply migrations "through the manifest's `databaseSchemaVersion`" (`:48-50`), but to pass "every migration file" (`:72`).
  - `finalTriggerSql` (`memory-backup-restore.ts:155-171`) and `recreateTriggers` (`:213`) then create triggers for tables the target doesn't have.
  - `requireManifestShape` (`:79-95`) also rejects any set whose table list differs from the code's current `MEMORY_BACKUP_TABLES`.
- **Proven:** `R7 restoring an older set with the repository's later migration files in the list` **fails** with `no such table: main.zz_later_table`. That happened after all rows had been inserted.
- **Effect for Sid:** after the next migration lands, restoring a backup taken before it fails part-way.
- **Fix:**
  - Pass only migrations up to and including `databaseSchemaVersion`, and check that inside the API.
  - Document checking out the commit that matches the set's schema version.

### L2. The restore creates cursors production never writes
- **Where:** `memory-backup-restore.ts:341-371` inserts `summaries`, `fts_items`, `fts_episodes`, `embeddings` and `export` cursors. Production writes only `distillation` (`automatic-distillation.ts:1217`) and `fts_history` (`literal-history.ts:1014`). The `export` cursor is taken from archive manifests.
- **Proven:** R1b. The restored D1 had `export`=4 and `fts_items`=28, which the source didn't have.
- **Effect for Sid:** none today. A future summaries, embeddings or export job would start from a restored position that was never its own, and skip work.
- **Fix:** rebuild only the cursors production maintains, and compare the set of cursor names with the source in the test.

---

## Checked and sound
- **Restore fidelity (R1b, with only the H1 guard bypassed):**
  - All 97 backed-up tables matched the source row for row. That covers BLOB salt and digest, finished runs and 6-hour-old costs, suppressions and lifts, school actions after a replan, university items, turns and deliveries, archive manifests, segments and segment events, and `archive_state`.
  - `memory_item_state` and `memory_item_placement_state` are identical.
  - FTS match results for items and history are identical, and so are the history chunks.
  - Coverage is identical, apart from `source_location` and segment id for the 4 events that were archived before the rebuild. That is correct.
  - `distillation` and `fts_history` cursors equal the source.
- **Triggers (item 2):** 380 on the restored D1, with names and SQL identical (normalized for whitespace) to a normally migrated D1.
  - A guarded bad row (`memory_runs` inserted as `succeeded`) fails with the same `memory_run_initial_state_invalid` on both.
  - A cursor regression fails with the same error on both.
- **No re-pay (R1b):** the real hourly `poll` on the restored D1 made 0 provider calls, left 5 items, reported "Memory nothing_new … history complete", and had no trigger failures.
- **Growth and deletes (item 4, by reading and R1b):**
  - The 5 receipt and ordinal tables are excluded.
  - `scheduled_runs` is limited to 48 hours: the 3-day-old row was absent and matched the filtered source exactly.
  - The manifest carries exported and shortfall counts, and the restore checks them (`:454-461`).
  - The classification test enumerates the migration files (`memory-backup.test.ts:26-40`, `:204-218`).
  - `R5` passes: an unclassified table makes `runNightly` return `failed` and send exactly one owner notice.
- **Paging (item 5, `R6` passes):** `EXPLAIN QUERY PLAN` of the production ordinal page query shows no `SCAN source` and no ordinal-table scan for any backed-up WITHOUT ROWID table. The busiest backup invocation used 313 prepared statements.
- **Verification:** `readLatestVerifiedMemoryBackup` checks the pointer, manifest hash, per-object size, hash and row count, and each cut's exported and shortfall arithmetic before it mutates anything.

## Unverified
- Restore with an open archive circuit (`:242-247`), with topic merges, and with a real Vectorize writer. There is none in the repo; the job was a no-op and `memory_vectors` was empty.
- These guarded tables were not populated in my fixture, though the restore is generic for them:
  - owner step-up tables;
  - call sessions and outbound attempts;
  - decisions, projects and deadlines;
  - school observations and study coach;
  - university workflow items.
- The real D1 per-batch statement limit, and CPU time for the single restore call at production size.
- GROWTH, DELETE, GUARD, RESTORE-A and RESTORE-B from round 2. The main reviewer is re-running those.
- Remote D1 acceptance of the edited 0031.

# PR #80 adversarial review at cb8941d

**Verdict: changes required. 2 High, 2 Medium, 5 Low.** On production-sized data the backup fails every night. Even if it finished, the set could not restore Sid's memories.

Probes: `<scratchpad>/pr80/agent/tree/apps/cloud-gateway/test/backup/adversarial-pr80.test.ts` (ADV1–ADV6). They ran with vitest-pool-workers against miniflare D1/R2 on `git archive cb8941d`. Logs: `pr80/agent/adv-run1.txt`, `adv-run2.txt`.

---

## High

### H1. The events cursor is compared as text, so the export fails as soon as a sequence crosses 10, 100, 1,000 or 10,000
- **Where:** `0031_memory_backup.sql:118` has `CHECK (first_key <= last_key)` and `:194` has `NEW.cursor_key > OLD.cursor_key`. Both compare TEXT columns. `memory-backup.ts:512` stores the events key as `String(sequence)`, and `:355` writes it to `cursor_key`. The trigger compares these as strings, so `"112" > "96"` is false and `"97" <= "112"` is false.
- **Proven (executed):**
  - ADV1: with 120 events and the default 16-row pages, the run fails at step 7 with `memory_backup_operation_failed`, `cursor_key "96"`, `next_object_number 6`.
  - ADV1b: inserting the receipt for rows 97..112 raises `CHECK constraint failed: first_key <= last_key`.
  - ADV2: with 1-row pages, the run fails crossing 9→10 (`cursor_key "9"`).
  - The builder's tests never exceed 3 events.
- **Effect for Sid:** production has real data. The archive keeps 90 days of live events in D1 (`archive-repository.ts:78`), so the range almost certainly starts at 0 and passes 100. The backup would never verify, and Sid would get "Last night's memory backup didn't complete" every night. A later crossing of 10,000 repeats this for about 90 days, until the archive mark passes it.
- **Fix:** store numeric keys zero-padded to a fixed width, or keep integer cursor/first/last columns with numeric comparisons. Add a test crossing 9→10 and 99→100 at the default page size.

### H2. The set leaves out the tables that hold the memories, so no backup can be restored
- **Where:** `memory-backup.ts:17-25` exports only events, transitions, suppressions, lifts, topic events, placement events and the cost ledger. The runtime also writes these tables, and the backup does not export them:
  - `memory_items` (`memory-repository.ts:1811`)
  - `memory_item_versions`, which holds the memory text (`:1385`, `:1822`)
  - `memory_item_sources`, the evidence excerpts (`:1411`, `:1845`)
  - `memory_runs` (`automatic-distillation.ts:813`)
  - `memory_distillation_event_receipts` and `memory_distillation_item_receipts` (`:1102`, `:1124`)
  - `memory_model_prices` (`memory-extraction-budget.ts:363`)
  - `principals`
  - The memory design's section 3.2 also marks `memory_item_links`, `memory_topic_aliases` and episodes as ledger or history tables.
- **Foreign keys that fail on restore:** transitions need items and versions (0016 FKs at the `memory_item_transitions` table). Suppressions need sources. The cost ledger needs `memory_runs` and `memory_model_prices`. Every row needs `principals`.
- **What the design says:** section 3.1 makes D1 "the source of truth for memory-item identity and wording, versions, evidence". Section 10 excludes only FTS5, history chunks, current-state projections and Vectorize.
- **Proven:** by reading. The grep of runtime `INSERT INTO memory_*` writers is above, and no test exports or restores a memory row.
- **Effect for Sid:** a "verified" backup holds lifecycle events that point at memory text that isn't in the backup. After a D1 loss, Jarvis could not get back what it remembered. Re-distilling would cost money and produce different text.
- **Fix:**
  - Export every authoritative table. `memory_item_versions.version_rowid` is a ready-made integer mark.
  - For mutable rows (`memory_runs`, reprocess jobs, cursors), export them explicitly as point-in-time state.
  - Add a test that loads a verified set into a freshly migrated D1 with foreign keys on, replays projections, and matches the source.

## Medium

### M1. Throughput is fixed at about 2,250 rows a day, every night re-exports everything, and a stale backup never alerts
- **Where:**
  - `memory-backup.ts:614`: 16 rows per page.
  - `:674-702`: one page, finish or re-verify per invocation.
  - `job-table.ts:809-810`: continuation only on the 5-minute drain.
  - `:627-628` and `:650`: an unfinished older run just returns `pending`, which counts as OK.
  - `:692-701`: any single error fails the whole run.
- **Proven (executed):** ADV3b needed 16 invocations for 64 events: 2 per 16 rows plus 8 fixed. At 289 invocations a day that caps a set at about 2,250 rows.
- **What each set holds:** every set is a full export of the all-time transition, placement and cost ledgers plus 90 days of live events. Distillation can add up to 16 cost-ledger rows an hour (`job-table.ts:90`, 2 rows per step).
- **Effect for Sid:** once his data passes a day's worth, "nightly" becomes every few days, then weekly. Skipped nights raise no alert. One transient R2 or D1 error anywhere in a multi-day run throws all progress away until the next night.
- **Fix:**
  - Loop pages within one invocation under a time or statement budget instead of one 16-row page.
  - Retry transient errors instead of failing the run.
  - Alert once when the newest verified set is older than about 36 hours.

### M2. `latest.json` is written before D1 records the set as verified, and a D1 error then leads cleanup to delete the set it points to
- **Where:** `memory-backup.ts:800-805` writes the pointer, then calls `verifyRun`. The catch at `:692-699` marks the run failed. On the next night `cleanupFailed` (`:817-833`) deletes that run's whole prefix, including the manifest.
- **Proven (executed):** in ADV4 a D1 error on the verify UPDATE produced this:
  - The outcome was `failed` and Sid got the "didn't complete" notice.
  - `latest.json` pointed at an existing manifest.
  - The next night's `runNightly` deleted that manifest, and `latest.json` stayed dangling (`manifestExistsAfter: false`).
- **Effect for Sid:** the one file that says "restore from here" points at a backup that no longer exists. With M1 it can stay that way for days. Older sets survive, but nothing points to them.
- **Fix:** commit `verified` in D1 first, then write the pointer, and repair it on a later invocation if the write fails. Cleanup must never delete a prefix named by `latest.json`.

## Low

### L1. The cut marks do not follow insertion order, and nothing checks row counts
- **Where:**
  - `memory-backup.ts:280-285` takes `max(id)` as each table's mark.
  - `automatic-distillation.ts:311-314` builds transition and placement IDs from the anchor event's timestamp.
  - Owner controls create IDs when a command is prepared (`memory-owner-controls.ts:562-570`) and write them later (`:590`).
- **What goes wrong:** rows committed after capture with a key at or below the mark get into the set if the cursor has not passed them yet. One batch can be split across tables: for example, a suppression (table 2) is included but its forgotten transition (table 1) is not. That is a foreign-key failure on restore.
- **Events purged mid-run:** the archive can also purge events mid-run (`archive-repository.ts:409-437`), and those go missing silently. This is unlikely, because the archive seals at most 24 events an hour while the export does 192.
- **Proven:** by reading.
- **Fix:** record `count(*) WHERE key <= mark` per table at capture and fail the run if the exported total differs. Better, use a D1-assigned monotonic column as the mark.

### L2. A retention error after a successful backup reports failure and alerts Sid
- **Where:** `memory-backup.ts:690` runs retention inside the try, and `:848-849` turns any error into `cleanup`.
- **Proven (executed):** in ADV6 the run was `verified` in D1, yet the outcome was `failed/memory_backup_cleanup_failed` and the "didn't complete" notice was sent.
- **Fix:** run retention after the success return, record its failure separately, and don't send Sid the backup-failed text.

### L3. `INSERT OR REPLACE` can erase another run's object receipt
- **Where:** the `0031` insert guard at `:260-264` checks only rows for `NEW.run_id`. `object_key` is globally UNIQUE (`:109`), and REPLACE deletes don't fire triggers.
- **Proven (executed):** in ADV5 a running run's `INSERT OR REPLACE` using a verified run's object key succeeded. The verified run's receipt row now belongs to the other run.
- **Fix:** drop the `run_id` scope from the `object_key` existence check.

### L4. The wiring into the job table and drain is not covered by any test
- No test calls `buildJobTable().backup` or the real `drain` (grep of `test/` and `tests/`).
- Deleting `job-table.ts:849` makes backups silently `skipped_unconfigured`. Deleting the continuation at `:809-810` stalls every run after step 1. Nothing fails in either case.
- The `nightlyRunWasScheduled` gate (`memory-backup.ts:655`) and both `truncated` branches (`:826`, `:846`) are also untested.
- **Fix:** add job-table tests for backup start, drain continuation, and "a backup failure doesn't stop the guest-notice drain".

### L5. Design gaps
- Section 10 step 6 requires a bucket lock. The runbook creates a plain bucket, and the Worker can delete verified sets (as M2 shows).
- Pruning a set with more than 1,000 objects deletes `manifest.json` in the first batch, because it sorts before `staging/`. It then returns with D1 still saying `verified` (`memory-backup.ts:844-847`).
- **Fix:** confirm the lock design (staging and verified prefixes need different rules). Mark a set `pruning` before deleting anything.

---

## Checked and sound
- **Manifest order:** the manifest is written only after every object passes a second read-back. It is itself read back before the pointer is written, apart from M2.
- **Object writes:**
  - Each object is uploaded with R2's `sha256` check, then its size and hash are read back and compared.
  - A retry after a crash is idempotent, because `onlyIf` returns null and the bytes are deterministic.
- **Marks:** captured in one D1 batch (one transaction) and kept immutable by the update guard. The schema version comes from `d1_migrations` and is written into the manifest.
- **Concurrency:** at 23:30 the drain and the night cron start together. The duplicate capture resolves to one row, and only one invocation wins the lease. A lease stolen after a slow step (over 2 minutes) fails safe: the run is marked failed, with no corruption.
- **Missing BACKUP binding:** fails once and alerts once per Toronto date. The guest-notice drain still runs, and the drain reports `ok:false` at most once a day.
- **Cron routing:** the retro is still Sunday-only and runs first. The backup is keyed by Toronto date. DST pairs give exactly one firing, and the drain, poll and daily jobs are unchanged.
- **Migration 0031:**
  - Purely additive and touches no existing table.
  - All 9 triggers use `SELECT RAISE … WHERE`; `CASE` appears only as a value.
  - Runs and alerts reject `INSERT OR REPLACE`, and identity checks reject `UPDATE OR REPLACE`.
  - Deletes are forbidden.
- **Production safety:** writes go only to the `memory_backup_*` tables. Reads are primary-key range queries with `LIMIT`. Statements and R2 calls per invocation are bounded.
- **Privacy:**
  - Object keys hold only date, run id, table and number.
  - The manifest holds only ids, sequences and hashes.
  - Alerts and failure codes are fixed text, and no rows are logged.
- **Retention selection:** never picks the newest or only verified set, and never touches failed or running sets through retention.

## Unverified
- Production row counts and `sealed_through`. The M1 impact depends on them; H1 only needs the live event range to cross a power of ten after the first page.
- Remote D1 acceptance of 0031 (read only, not applied), and real R2 behavior of `onlyIf` plus `sha256`.
- Whether the archive catalog (`archive_segments` and related tables) can be rebuilt from R2 alone for a restore.
- Scope: school, university, deadline and decision data are not in this backup. Confirm Sid expects a memory-only backup.

# PR #80 round 2 narrow review at 07dd1f5

**Verdict: changes required. 1 High, 2 Medium, 4 Low.** The round-1 defects are fixed: the builder's claims about ADV3b, ADV4 and ADV6 are true, and the rewritten probes pass. But the fix backs up its own receipts, so every night's set is bigger than the last, even when nothing else changes. On top of that, one ordinary delete during the export throws away the whole night, and a real set can't be restored with the procedure the builder tested.

Probes: `C:\Users\Sid\jarvis-pr80r2-adv\apps\cloud-gateway\test\backup\adversarial-pr80r2.test.ts` (copy in `<scratchpad>/pr80r2/adversarial-pr80r2.test.ts`). They ran in the Workers pool at `07dd1f5`. Logs are in `pr80r2/adv-run1.txt` and `adv-run3.txt`. Result: **5 failed, 4 passed**. The tests assert correct behaviour, so a failure proves a defect. The worktree was left in place, with only the untracked test file added.

---

## Item 1: the three "by design" probes

| Probe | Builder's claim | Verdict | Rewritten probe at 07dd1f5 |
|---|---|---|---|
| ADV3b | Literal sentinel `steps: -1` | **True.** The defect it measured is fixed: about 2,250 rows a day, and staleness was silent. | **ADV3b-r2 passes.** 976 rows verified in 15 invocations. The fixed cost is about 7 invocations (104 table-finish steps plus publish). After that, 122 rows per invocation, about 36,000 rows a day. The busiest invocation used 325 prepared D1 statements (including the 158-statement cut batch and 53 PRAGMAs), 17 batch calls and 32 R2 operations. |
| ADV4 | Assumes the old pointer ordering | **True.** The dangling pointer is gone. | **ADV4-r2 passes.** Night 1 verified. Night 2's verify UPDATE was forced to fail every retry, so that run failed and `latest.json` still named night 1's manifest, which still existed. Night 3 marked night 2 abandoned, verified, and moved the pointer to its own existing manifest. **ADV4c-r2 passes.** Pointer writes failed for 16 nights. Retention pruned old sets but never the one `latest.json` names, and that set stayed `verified`. |
| ADV6 | Literal sentinel `result: "show"` | **True.** The defect is fixed. | **ADV6-r2 passes.** R2 `list` was made to throw on every call. The outcome was `verified`, the D1 status was `verified`, and no notice was sent. |

---

## High

### H1. The backup exports its own receipts, so each night's set grows by about 6% and compounds until it can't finish in a day
- **Where:** `memory-backup.ts:126-128` puts `memory_backup_runs`, `memory_backup_objects` and `memory_backup_alerts` in the backed-up list. Receipts can never be deleted, even for pruned sets (`0031:412-416`). Each night:
  1. The cut captures every earlier night's receipts (`memory-backup.ts:498-510`, `:545-552`).
  2. It exports them at 16 rows per object.
  3. That adds a new receipt for every 16 exported rows.
  4. The next night exports those receipts too.
- **Proven:** `GROWTH an unchanged database exports about the same number of rows every night` **fails**. With 64 events and no other changes, the rows per set over 8 nights were 208, 225, 244, 265, 287, 310, 335, 361. The receipt rows inside each set were 0, 16, 34, 54, 75, 97, 121, 146.
- **Arithmetic at production scale:** with R user rows, night k exports about R·(17/16)^(k−1) rows. The drain gives about 4,600 steps a day, and each row costs 2/16 of a step, so a day holds about 36,000 rows. A set stops finishing within a day after:
  - about 22 nights at R = 10,000;
  - about 34 nights at R = 5,000;
  - about 49 nights at R = 2,000.
- **Separately, `scheduled_runs` grows by about 314 rows a day** (288 drain claims, 24 poll claims, plus daily claims), is never pruned, and is exported in full every night.
- **Two things make it worse:**
  - Each page of a WITHOUT ROWID table scans the whole source table and sorts it (L3).
  - `memory_backup_row_ordinals` gains a row for every receipt, forever.
- **Effect for Sid:** within weeks of deploying, the nightly backup becomes every few days and then rarer, even if Sid adds nothing. He gets a "didn't complete" message every day once the newest good backup is more than 36 hours old.
- **Fix:**
  - Remove `memory_backup_runs`, `memory_backup_objects` and `memory_backup_alerts` from `MEMORY_BACKUP_TABLES` and add them to the excluded list. They describe R2, and a restore can't insert them anyway (M1).
  - Add a test that N unchanged nights export the same row count.
  - Decide whether all of `scheduled_runs` belongs in a nightly full export.

## Medium

### M1. A production-shaped set can't be restored with the tested procedure; the restore test covers 6 hand-picked tables
- **Where:**
  - The restore test (`memory-backup-restore.test.ts:39-102`) seeds only these tables: principals, events, conversation_turns, memory_items, versions and sources.
  - Its procedure (`:146-166`) inserts rows with every production trigger active.
  - Many backed-up tables have insert guards that refuse any row past its initial state or older than 5 minutes. Examples:
    - `memory_runs_insert_guard`, `0016:2722-2738`: outcome must be `running`, and `started_at` must be within 5 minutes of now.
    - `memory_cost_ledger_insert_guard`, `0016:2886`: `occurred_at` must be within 5 minutes of now.
    - `memory_topic_events_recent_insert_guard`, `0019:43`.
    - `memory_backup_runs_insert_guard`, `0031:170-189`.
    - `guest_grant_notices_insert_guard`, `0021:145`: status must be `pending`.
    - Also `owner_passphrase_verifiers` (`staged`), `memory_reprocess_jobs`, `memory_literal_search_jobs`, `school_study_evidence` and `school_practice_items`.
  - AFTER-insert triggers also rebuild state. For example, `memory_topic_events_apply` (`0016:2168`) inserts `memory_topics`, which the restore has already inserted.
- **Proven:**
  - `RESTORE-A the second night's verified set restores…` **fails** with `memory_backup_run_initial_state_invalid`. Every set after the first night contains night-1 receipts.
  - `RESTORE-B a finished memory run restores…` **fails** with `memory_run_initial_state_invalid`, from one completed distillation run.
  - The other guards listed above are proven by reading only.
- **What is fine:** the schema side of the test is production-shaped. It is a fresh D1 with all 31 migrations.
- **Effect for Sid:** the data reaches R2, but after a D1 loss nobody could load it with the tested method. Distillation runs every hour, so every real set holds finished memory runs and costs older than 5 minutes. A working restore needs a mode that bypasses triggers and then rebuilds the derived tables. That doesn't exist and isn't tested.
- **Fix:**
  - Restore into tables created without guard triggers, with foreign keys deferred.
  - Then recreate the triggers and rebuild `memory_item_state`, placement state, topics and FTS.
  - Test it with a fixture that puts at least one post-initial-state row in every table that has an insert guard, including a finished run, a cost entry older than 5 minutes and a topic event.

### M2. A delete of any row that is in the cut, before its table is exported, fails the whole night
- **Where:**
  - `finishTable` (`memory-backup.ts:620-628`) requires the exported total to equal `expected_row_count`.
  - A mismatch becomes `memory_backup_cut_mismatch`, and the run is failed (`:1013-1021`). It is not retried until the next night.
  - Deletes like this happen in production:
    - The `request_nonces`, `sync_snapshots` and `identity_challenges` reclaim triggers delete expired rows on every insert (`0002:7`, `:21`, `:34`).
    - Every school plan save sets all planned actions to superseded and deletes them (`school-catchup-repository.ts:519-538`).
    - Archive purge deletes from `outbox`.
- **Proven:** `DELETE a production reclaim delete of a cut row during the export…` **fails**:
  - The setup was two expired nonces at the cut, then one new signed request.
  - The outcome was `failed/memory_backup_cut_mismatch`, with 2 rows expected and 1 exported, and the "didn't complete" notice was sent.
  - An earlier single-nonce variant *verified*. The replacement row reused the deleted row's rowid, so a row added after the cut went into the set in its place (see L4).
- **Effect for Sid:** the export starts at 19:30 and reaches `school_catchup_actions` (around table 77) only after the large tables. If he updates his school plan in that window, that night's backup is lost and he gets a failure message.
- **Fix:**
  - Accept exported ≤ expected, and record the shortfall in the manifest.
  - Or re-cut the affected table instead of failing the run.
  - Exclude the three reclaim-on-insert tables. No foreign keys point at them (checked all migrations), and they are short-lived.

## Low

### L1. 0031 still accepts an object receipt for a run that has no table cuts
- **Where:** `0031:384-402`, the round-1 `eventsThrough` branch of `memory_backup_objects_insert_guard`. The service never produces this marks shape.
- **Proven:** `GUARD 0031 rejects an object receipt for a run that has no table cuts` **fails**. A run with marks `{"eventsAfter":0,"eventsThrough":1000}` and a lease had its receipt accepted, with no cuts.
- **Fix:** delete the branch, and add a whole-branch removal test.

### L2. The classification test checks the test database, not the migration files, and runtime doesn't check it at all
- **Where:** `memory-backup.test.ts:173-186` reads `sqlite_schema` from whatever `applyMemoryBackupMigration` chained. `loadDescriptors` (`memory-backup.ts:465-491`) ignores tables that aren't classified.
- **Proven (by reading plus a script):** today all 125 `CREATE TABLE` names in 0001–0031 are classified. `principals_new` is renamed in 0006. But a future 0032 table that isn't chained into that helper passes the test and is silently left out of the backup.
- **Fix:** in `loadDescriptors`, fail closed with an alert when `sqlite_schema` has a table in neither list. Alternatively, have the test enumerate the `?raw` migration files.

### L3. Each page of a WITHOUT ROWID table scans the whole table
- **Where:** `memory-backup.ts:783-788`. The join is on `json_array(pk…)`.
- **Proven:** in the GROWTH run, `EXPLAIN QUERY PLAN` gives `SCAN source` plus a temp B-tree for ORDER BY. One 16-row page over a table of about 150 rows read 492 rows. The cost per table is therefore about n²/16 per night.
- **Scale:** this applies to 53 of the 104 tables, including `memory_distillation_event_receipts`, which grows with every event ever distilled.
- **Fix:** store the key columns with the ordinal and page by ordinal range, then look up the source row by primary key.

### L4. A set is not one point in time
- **Where:**
  - Mutable rows are read when their page is exported (`:769-788`), not when the cut is taken. Examples: `memory_runs` settlement, `archive_state.sealed_through`, `consumer_cursors`.
  - A row added after the cut can take a deleted row's rowid and replace it (seen in the single-nonce variant above).
- **Proven:** by reading and that observation.
- **Effect for Sid:** a restored set can pair a cursor or archive mark with rows that aren't in the set.
- **Fix:** document it for the restore rebuild, or re-read mutable tables inside the cut transaction for small tables.

---

## Checked and sound
- **Ordinals (item 2):** assigned in the same D1 batch as the cut, so nothing can happen between assignment and cut.
  - Assigned once per (table, primary key) and never rewritten.
  - A reused primary key keeps its old ordinal, which is harmless for a snapshot.
  - Kept per table name.
  - Rows written per night are only keys new since the last night. The growth that matters is H1.
- **Budgets (item 4):**
  - The busiest invocation used 325 statements and 32 R2 operations, well under the Workers Paid limit of 1,000 D1 queries per invocation.
  - Retries can't duplicate objects (`onlyIf` plus a deterministic key) or receipts (the insert guard is on both `object_key` and number).
  - The 36-hour stale alert fires at most once per Toronto date: the `memory_backup_alerts` primary key is shared with failure alerts.
  - One quirk, by reading: if a receipt commit's response is lost, the retry hits the insert guard and Sid gets one wrong "didn't complete" message while the run continues.
- **Pointer and retention safety (item 5):**
  - D1 is marked verified before the pointer is written.
  - A failed pointer write is repaired on later calls the same day.
  - Retention and cleanup re-read `latest.json` before deleting objects and again before deleting the manifest. An unreadable pointer throws, which is caught, and nothing is deleted.
  - Objects are deleted first, then the manifest, then the D1 status is changed, including on truncated listings.
  - A set part-way through pruning still shows as `verified` until it finishes (the N5 design).
- **Security (item 6):** no new secret exposure.
  - Passphrase verifiers, guest PIN digests and challenge HMACs are all computed with 32-byte Worker-secret peppers (`env.ts:10-14`) that are not in D1, so an R2 copy can't be cracked offline.
  - Bootstrap tokens, nonces and sync tokens are stored only as hashes and can't be replayed.
  - `device_keys` holds public keys only.
  - Excluding the short-lived tables (nonces, snapshots, challenges, attempt reservations) is restore-safe, since no foreign keys point at them, and it also removes most of M2.
  - A restore needs the same pepper secrets, which this backup correctly does not hold.
- **Migration 0031 (item 7):** all 15 guards use `SELECT RAISE(ABORT, …) WHERE`, and there is no `CASE … RAISE`. All four backup tables are `STRICT` with INTEGER cursor, key and ordinal columns, so every key comparison is integer against integer.
- **Classification today (item 3):** complete against every migration file (script over 0001–0031, with no unclassified or double-classified table).

## Unverified
- Production row counts per table, which set how many nights until H1 bites and how long M2's window is.
- Whether any signed device client is active in production (the nonce, snapshot and challenge reclaim path).
- How often Sid saves school plans after 19:30.
- CPU time per 16-step invocation on real Workers.
- Real R2 `onlyIf` and `sha256` behaviour.
- Remote D1 acceptance of the edited 0031. It has not been applied.

## 2026-09-17 00:44 UTC — Claude Opus 5, PR #80 max re-review at 07dd1f5: changes requested

**Round 1's defects are fixed, but the backup copies its own receipts and grows every night. A real set also can't be restored with the tested procedure.**
- **Gates at `07dd1f5`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **188 files / 4,910 tests**.
- **0031 whole-trigger removal:** **15/15 killed**, with BASE surviving.
- **Round-1 probes re-run:** ADV1, ADV1b, ADV2, ADV3 and ADV5 now pass.
- **The builder's claims about ADV3b, ADV4 and ADV6 are true.** Those assertions were diagnostic sentinels or assumed the old ordering. The narrow reviewer rewrote them against the new design, and all pass:
  - ADV3b-r2: about 36,000 rows a day, busiest invocation 325 D1 statements and 32 R2 operations;
  - ADV4-r2 and ADV4c-r2: the pointer never dangles, and retention never deletes the named set;
  - ADV6-r2: a list failure after publish stays `verified`, with no notice.
- **Narrow second reviewer:** `reviewer-tools/pr80r2-narrow.md`, tests in `reviewer-tools/pr80r2/adversarial-pr80r2.test.ts`. I re-ran them at this head: **5 of 9 fail**, confirming the findings below.
- **Checked and sound:**
  - Ordinals are assigned in the cut batch, once, never rewritten.
  - Retries can't duplicate objects or receipts.
  - The stale alert fires once per date.
  - Pointer and retention ordering are correct.
  - All 15 guards use `SELECT RAISE … WHERE`, with integer comparisons only.
  - No new secret exposure: verifiers, PINs and HMACs are peppered with Worker secrets that aren't in D1, tokens are stored as hashes, and `device_keys` holds public keys only.
  - Classification today is complete against all 125 `CREATE TABLE`s.

**B1 (H1). Each night's set grows about 6% even when nothing changes.** `memory_backup_runs`, `memory_backup_objects` and `memory_backup_alerts` are in the backed-up list (`memory-backup.ts:126-128`), so every set exports all earlier receipts, and every 16 rows exported add another receipt.
- Proven by GROWTH: with 64 events and nothing else changing, rows per night were 208, 225, 244 … 361 over 8 nights.
- At 10,000 user rows, a set stops finishing within a day after about 22 nights.
- `scheduled_runs` also grows by about 314 rows a day and is exported in full every night.
- **Fix:**
  - Exclude the three backup-receipt tables as operational records of R2 itself.
  - Back up `scheduled_runs` only for its last 48 hours (enough to stop a restored Jarvis re-sending today's digest).
  - Add a test that N unchanged nights export the same row count.

**B2 (M1). A production-shaped set can't be restored.** The restore test seeds 6 tables and inserts with every production trigger active. Real sets hold rows past their initial state, which insert guards refuse:
- finished `memory_runs` and cost entries older than 5 minutes (`0016:2722`, `:2886`);
- topic events (`0019:43`);
- non-pending guest notices;
- non-staged passphrase verifiers;
- finished search and reprocess jobs;
- school evidence.

AFTER-insert triggers (`memory_topic_events_apply`) would also double-create topics. RESTORE-A and RESTORE-B fail with `memory_backup_run_initial_state_invalid` and `memory_run_initial_state_invalid`.
- **Fix:** a tested restore path, which is code plus a runbook, not only a test:
  1. Apply all migrations, then drop every trigger, and insert with foreign keys deferred.
  2. Recreate the triggers from the migration SQL.
  3. Rebuild every excluded derived table:
     - item state and placement state from transitions and placement events;
     - FTS via `rebuild`;
     - history chunks, coverage and vectors by their existing jobs;
     - each `memory_cursors` row from its authoritative receipts. A restore must never re-pay for distillation of events that already have receipts.
- The test fixture puts at least one post-initial-state row in **every** table with an insert guard, then compares row counts, sampled hashes and rebuilt state with the source.

**S1 (M2). One ordinary delete during the export fails the whole night.** `finishTable` (`:620-628`) requires the exported total to equal the cut exactly. Production deletes cut rows:
- nonce, snapshot and challenge reclaim-on-insert (`0002`);
- every school plan save (`school-catchup-repository.ts:519-538`);
- archive purge of `outbox`.

DELETE fails with `memory_backup_cut_mismatch`, and Sid gets a failure notice.
- **Fix:**
  - Accept exported ≤ expected, and record the shortfall in the manifest.
  - Exclude the short-lived `request_nonces`, `sync_snapshots`, `identity_challenges` and `authentication_attempt_reservations` (no foreign key points at them).
  - Document in the restore runbook that a set isn't one exact point in time (N4).

**Lows.**
- **N1:** the round-1 `eventsThrough` branch of `memory_backup_objects_insert_guard` (`0031:384-402`) still accepts a receipt for a run with no cuts (GUARD fails). Remove the branch and add a removal test.
- **N2:** the classification test reads the chained test schema, not the migration files, and runtime ignores unclassified tables. Enumerate the migration files in the test, and make `loadDescriptors` fail closed with an alert on an unclassified table.
- **N3:** each page of a WITHOUT ROWID table scans and sorts the whole source table (`:783-788`), which is n²/16 per night for 53 tables. Store the key columns with the ordinal and page by ordinal range.
- **N4:** mutable rows are read at page time, not cut time, and a post-cut row can reuse a deleted rowid. Document this for the restore rebuild. The rebuild in B2 must derive cursors and marks from the restored rows, never trust exported cursor rows blindly.

**Next.** A fresh memory-builder session fixes B1–B2, S1 and N1–N4 with tests (the narrow reviewer's 5 failing assertions must pass, and the 4 passing ones must stay passing). 0031 is still unapplied, so edit it in place, with whole-trigger removal for changed triggers. It merges main, runs lint, typecheck and the full suite, and requests max re-review.

— Claude Opus 5

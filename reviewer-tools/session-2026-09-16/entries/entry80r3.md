## 2026-09-17 02:10 UTC — Claude Opus 5, PR #80 max re-review at 01292f2: changes requested

**The backup side is now sound: no growth, deletes tolerated, bounded paging, fail-closed classification. But the restore path fails on every real database, and Sid can't run it.**
- **Gates at `01292f2`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **190 files / 4,918 tests**.
- **0031 whole-trigger removal:** **15/15 killed**, with BASE surviving.
- **Round-2 narrow tests:** 8/9 pass. GROWTH, DELETE and GUARD now pass. RESTORE-B still calls the old plain-insert procedure, so it no longer tests the new API; R1 below supersedes it.
- **Narrow second reviewer:** `reviewer-tools/pr80r3-narrow.md`, tests in `reviewer-tools/pr80r3/adversarial-pr80r3.test.ts`. The fixture is production-shaped, built through real services: two hours of distillation, remember/forget/lift, a school replan, university, archive and purge, aged `scheduled_runs`, and seeded post-initial-state rows. I re-ran them at this head: **8 of 10 fail**. R1b and R2b are diagnostics that bypass only the H1 guard.
- **Checked and sound, with only the H1 guard bypassed:**
  - all 97 backed-up tables restore row for row, including BLOBs;
  - item and placement state, FTS results and history chunks are identical;
  - 380 triggers are recreated with identical SQL and behaviour;
  - the real hourly poll on the restored D1 makes 0 provider calls;
  - scheduled_runs is limited to 48 h, the unclassified-table alert fires, and ordinal paging has no scans (313 statements per backup invocation);
  - pre-mutation verification of pointer, manifest, hashes and counts.

**B1 (H1). Restore fails once distillation has run more than once, which is every real database.** The distillation cursor is INSERTed after triggers are recreated (`memory-backup-restore.ts:375-385`, `:501`). `0026` `memory_distillation_cursor_insert_guard` allows a nonzero cursor only for a single run covering 1..N. R2a (two ordinary runs) and R1 throw `memory_distillation_cursor_advance_invalid`.
- **Fix:** write rebuilt cursors while triggers are dropped, or with the cursor guards suspended. Test with ≥2 runs.

**B2 (H2). The rebuilt cursor skips events whose last run failed.** It takes `max(event_sequence)` over all receipts (`:336-340`). But failed, budget_blocked and credit_blocked runs, and wider narrowing windows, write receipts without advancing the cursor. R2b: after a provider timeout, the restored cursor was 2 against source 1, and the next step made 0 calls, so that message never becomes memory.
- **Fix:** derive the cursor as the highest contiguous `end_event_sequence` of succeeded or nothing_new distillation runs chained from 1 (exactly what the guard accepts). Test with a failed last run.

**S1 (M1). Changed seeded rows make a set unrestorable.** `:190-196` demands byte equality with migration-seeded rows. R3: after `autonomy_mode` goes live or `outbound_runtime_controls` is enabled, restore throws `memory_backup_restore_target_not_fresh`.
- **Fix:** replace seeded singleton rows with the backed-up values, and test both.

**S2 (M2). No runnable restore, and the restore drops triggers before checking the target.**
- The runbook points at "a controlled operator program" that doesn't exist. It has no PowerShell commands or scratch rehearsal, and it tells Sid to record an R2 "object version" that R2 doesn't have.
- The API drops all 380 triggers before its freshness check (R4: it ran on a live DB, then threw).
- It needs 1,396 statements for 214 rows, so a real restore exceeds 1,000 D1 queries per invocation. An invocation dying mid-restore leaves the database with no triggers.
- **Fix:**
  - A resumable restore entry point, bounded per invocation and runnable from PowerShell (`& node node_modules/wrangler/bin/wrangler.js …` against a named scratch D1).
  - Refuse any non-empty target (apart from seeded rows) before the first DDL.
  - Require the target name typed separately, and refuse the production database id.
  - Rewrite the runbook as exact steps: scratch rehearsal first, never `wrangler d1 export` against production.

**Lows.**
- **N1:** restoring an older set with newer migration files fails part-way (R7). Apply and recreate only migrations up to the set's `databaseSchemaVersion`, checked in the API.
- **N2:** restore invents cursors production never writes (`summaries`, `fts_items`, `fts_episodes`, `embeddings`, `export`). Rebuild only `distillation` and `fts_history`, and compare cursor names with the source.

**Next.** A fresh memory-builder session fixes B1–B2, S1–S2 and N1–N2 with tests (the reviewer's 8 failing assertions must pass). 0031 is still unapplied. It merges main, runs lint, typecheck and the full suite, and requests max re-review.

— Claude Opus 5

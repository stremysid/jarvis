## 2026-09-17 04:30 UTC — Claude Opus 5, PR #80 max re-review at 6693f21: changes requested (one High, restore order)

**The restore is now resumable, safe and bounded. It survived 2,318 kill-and-resume points on a 3,859-row production-shaped set. But inserting rows fails whenever a row points at another row in a later page.**
- **Gates at `6693f21`**, in a Windows Workers-pool checkout: lint 0, typecheck 0. The suite ran **4,939/4,943**; the 4 `call-session-do.test.ts` load timeouts pass **126/126** alone, and that file is untouched. 0031 is unchanged since its 15/15 removal kills.
- **Round-3 narrow tests:** **10/10 pass.**
- **Narrow second reviewer:** `reviewer-tools/pr80r4-narrow.md`, tests in `reviewer-tools/pr80r4/adversarial-pr80r4.test.ts`. I re-ran them: P0, P1 and P2 fail (the High). K1's report check and F1 fail (Lows).
- **Checked and sound:**
  - Killing after every D1 operation of every phase then rerunning gives identical tables, cursors, chunks, FTS and 380 triggers, with no duplicates.
  - Peak is 174 statements per invocation.
  - The failed-last-run distillation cursor, changed seeded rows, and older-set migration bounds are all correct.
  - All refusals happen before any DDL: live target, schema mismatch, unknown migration, different set mid-restore.
  - The runbook uses `& node $wrangler`, never `d1 export`, a scratch D1 whose name is typed twice, and a real authenticated `/step`/`/finalize` entry.

**B1 (H1). Restore stops permanently, with every trigger dropped, on forward foreign keys.** Rows go in 62-row pages. `PRAGMA defer_foreign_keys` lasts only per batch (`memory-backup-restore.ts:699-715`), and table order isn't dependency order: `call_sessions` (`memory-backup.ts:42`) comes before `voice_access_grants` (`:46`). Self-references also point forward (`memory_topics.redirect_to_topic_id`, `parent_topic_id`).
- **P0:** 1 cross-table forward key and 4 self-references.
- **P1:** a guest call under a voice grant stops at row 310 with 0 triggers, and a retry fails identically.
- **P2:** a topic merged into a newer topic stops at row 0.
- **Fix:**
  - Order `voice_access_grants` (and its events) before `call_sessions`.
  - Insert self-referencing columns as NULL, then set them in a later phase while triggers are still dropped, or order parents first.
  - Make P0 a permanent test that fails on any forward foreign key.
  - Add restore tests with a guest call and a merged topic, each more than one page from its target.

**Lows.**
- **N1:** a retried `rebuild_cursors` reports 0 rebuilt cursors (K1 report check). Store the count of existing cursors, or batch the insert with the progress update.
- **N2:** a lost response after a successful `/finalize` makes a finished restore look broken (F1), and the runbook's readiness loop hides every refusal as "did not become ready". Make finalize idempotent with a finalized marker, and stop retrying on an HTTP response and print its error.
- **N3:** the refusals that keep a different set out of a half-restored target survive the builder's tests (M02–M07, M10–M16, M19). Make the reviewer's S1 cases b–f and a trigger-classification case permanent.
- **N4:** the target checker pattern-matches TOML. `preview_database_id = "<production id>"` and escaped ids pass, and wrangler dev binds `preview_database_id`. Parse the TOML and refuse any `preview_database_id`. Test the name-typed-twice, outside-repo and scratch-name refusals.
- **N5 (unverified, measure it):** every `/step` re-downloads and re-hashes the whole set. Verify the set once per restore and cache its hash in progress. State the steps and time for a 5,000-row restore.

**Next.** A fresh memory-builder session fixes B1 and N1–N5 with tests (P0, P1, P2, the K1 report check and F1 must pass). It merges main, runs lint, typecheck and the full suite, and requests max re-review.

— Claude Opus 5

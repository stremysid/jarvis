## 2026-09-16 23:29 UTC — Claude Opus 5, PR #80 max review at cb8941d: changes requested

**0031 is sound (9/9 triggers killed), and the gates are green. But on production-sized data the backup never verifies, and a verified set couldn't restore Sid's memories.**
- **Gates at `cb8941d`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **186 files / 4,883 tests**.
- **0031 whole-trigger removal:** 9/9 killed by named tests, with BASE surviving.
- **Adversarial second reviewer:** `reviewer-tools/pr80-adversarial.md`, tests in `reviewer-tools/pr80/agent/adversarial-pr80.test.ts`. The tests assert correct behaviour. I re-ran them in a real Workers-pool checkout at this head: 7 of 8 fail, confirming the defects below.

**B1 (H1). Text-compared numeric cursor.** `0031:118` `CHECK (first_key <= last_key)` and `:194` `NEW.cursor_key > OLD.cursor_key` compare TEXT, while `memory-backup.ts:512` stores the event sequence as a string, so `"112" > "96"` is false.
- 120 events at the default 16-row pages fail at rows 97–112 (ADV1, ADV1b). One-row pages fail crossing 9→10 (ADV2).
- Production has far more than 100 live events, so no backup would ever verify, and Sid would get a failure notice every night.
- **Fix:** integer key columns, or fixed-width zero-padded keys. Test 9→10, 99→100 and 9,999→10,000 at the default page size.

**B2 (H2). The memories themselves aren't backed up.** `memory-backup.ts:17-25` exports seven ledger tables but omits:
- `memory_items`;
- `memory_item_versions` (the memory text);
- `memory_item_sources` (evidence);
- `memory_runs`, `memory_model_prices`, the distillation receipts and `principals`.

The exported rows have foreign keys into those tables, so no restore is possible.
- **Fix (reviewer decision on scope, per Sid's "nothing lost, no homework"):** back up **every authoritative Jarvis data table**, not only memory: memory, conversation turns and events not covered by sealed archive segments, school, university, study coach, deadlines, identities and principals, owner controls. Exclude only derived tables: FTS5, history chunks, current-state projections and Vectorize.
- **Enforce it with a test:** it enumerates every table created by migrations 0001–0031 and fails when a table is neither in the backup list nor in an explicit excluded-derived list, so a future migration can't silently fall out of the backup.
- **Add a restore test:** import a verified set into a fresh D1 with all migrations and foreign keys on, then compare row counts and sampled hashes.

**S1 (M1). Too slow, and a stale backup is silent.** One page per invocation (64 events took 16 invocations) caps a set at about 2,250 rows a day, and one transient error discards a multi-day run.
- **Fix:** several pages per invocation within the CPU, subrequest and D1 budgets; retry transient errors; alert when the newest verified set is more than 36 hours old.

**S2 (M2). The latest pointer can dangle.** `latest.json` is written (`:800-804`) before D1 marks the run verified (`:805`). A D1 error there left the pointer on a set that cleanup later deleted (ADV4).
- **Fix:** mark verified in D1 first, write the pointer second, and never let cleanup delete the set the pointer names.

**Lows.**
- **N1:** the per-table cut is the max id, but ids aren't insertion-ordered. Cut on an insertion-ordered key (rowid or sequence) and check row counts against the cut.
- **N2:** a retention or cleanup error after a verified publish reports failure and alerts (ADV6). Log it and retry cleanup, but don't mark the backup failed.
- **N3:** `INSERT OR REPLACE` with another run's object key erases that run's receipt (ADV5). The insert guard must reject any existing key.
- **N4:** job wiring is untested. Removing the backup step at `job-table.ts:849` or `:809-810` passes every test; add a named test.
- **N5:** an old set with more than 1,000 objects loses its manifest before D1 stops saying `verified`. Delete objects first, the manifest last, then update D1. Record in KNOWN_ISSUES that R2 bucket locks are an owner setting not yet enabled; don't build it here.

**Next.** A fresh memory-builder session fixes B1–B2, S1–S2 and N1–N5 with tests. Any change to 0031 still needs whole-trigger removal for its changed triggers; 0031 is unapplied, so edit it in place. It merges main, runs lint, typecheck and the full suite, and requests max re-review.

— Claude Opus 5

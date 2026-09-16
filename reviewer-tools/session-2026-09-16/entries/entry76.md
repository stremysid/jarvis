## 2026-09-16 21:33 UTC — Claude Opus 5, PR #76 max review at 446ea2d: changes requested

**The $5 cap holds on every path tried, and DeepSeek is never called without a reservation. But memory itself would duplicate facts, pay twice and wedge on a real hourly schedule.**
- **Gates at `446ea2d`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **177 files / 3,957 tests**.
- **Adversarial second reviewer:** `reviewer-tools/pr76-adversarial.md`, tests in `reviewer-tools/pr76/agent/zz-pr76-adversarial.test.ts`. I re-ran that file in a real Workers-pool checkout at this head: all **8/8** defect assertions pass, so every finding below reproduces.

**B1 (H1). Duplicates, double payment and a stuck cursor.** A batch yielding more than 4 facts saves 4, then asks DeepSeek again about the same messages. A proposal only counts as already saved when it matches exactly, confidence included, and no temperature is set.
- **Proven (F2):** one hourly run made 2 paid calls, stored 4 facts twice each, never stored the 5th, and left the cursor at `null`. It repeats every hour.
- **Where:** `automatic-distillation.ts:719-760`, `job-table.ts:516`, `:501-507`.
- **Fix:** don't re-query on continuation; commit the rest of the paid response. Match already-saved facts on source event ids plus normalised text. Send `temperature: 0`.

**S1 (M1). The job clock is frozen at cron start.** `index.ts:505` fixes the clock, but D1 rejects run and ledger rows more than 5 minutes old (`0016:2737-2738, 2892-2893`).
- Work starting 6 minutes in is refused (F1a).
- A paid call that crosses 5 minutes has its settlement rejected, and the result is thrown away (F1b).
- Both 4-minute wall-clock budgets always see zero elapsed time.
- **Fix:** use a live clock for rows and budgets.

**S2 (M2). One bad proposal voids the whole paid batch,** and the same batch retries every hour. F3 swapped a curly apostrophe for a straight one: that failed 3 hours in a row, paid each time, and blocked a valid fact (`:697-718, :667-677`).
- **Fix:** validate proposals individually, keep the valid ones, record the rejected ones with a fixed code, and advance past the window.

**S3 (M3). The cap check scans the whole ledger.** Reserve took 11 → 190 ms at 206 → 806 rows, and D1 rows read climb every month (`memory-extraction-budget.ts:369-407, 528-563`).
- **Fix:** bound every lookup to the current Toronto month, using the existing index or a narrower predicate with no migration. Add a test asserting the query plan uses the index.

**S4 (M4). No warning before DeepSeek credits run out.** Sid asked for a warning before the cap **or credits** run out. A 402 today becomes `provider_credit_blocked` silently.
- **Fix:** on 402, or when a balance check shows low credit, send one owner notice through the same monthly-notice path, deduplicated per day. Pin it with tests.

**Lows.**
- **N1:** an empty `MEMORY_EXTRACTION_MODEL` throws inside `scheduled()` and stops every cron job (F7). Treat empty as unset, and never throw from composition.
- **N2:** history indexing charges a flat 64 statements per step, so it only covers 16 events an hour. Charge the statements actually used.
- **N3:** a failed call after payment records zero cost on the run (F4). Record the settled cost.
- **N4:** these guards are unpinned:
  - the JSON provider timeout;
  - the month-start bound in the cap query (without it the cap becomes lifetime);
  - the price-id check in reserve;
  - production wiring of the 80% notice.

  Give each a named test.
- **N5:** the two extraction prompts disagree ("a JSON array" vs "an object with a proposals array"). Use one exact schema with an example.
- **N6:** every call bills at peak rates. Keep the conservative reservation, but settle at the actual time-of-day rate DeepSeek charges so the cap buys what it should.

**Next.** A fresh memory-builder session fixes B1, S1–S4 and N1–N6 with tests. It merges main (now including #73 and #64), runs lint, typecheck and the full suite, and requests re-review.

— Claude Opus 5

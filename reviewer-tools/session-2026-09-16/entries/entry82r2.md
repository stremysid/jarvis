## 2026-09-17 01:29 UTC — Claude Opus 5, PR #82 max re-review at e4fb760: cleared with follow-ups

**Cleared.** A model-chosen area name can no longer lose a memory or stall extraction. Areas and the item now commit atomically, and the re-file no longer jams after ten stuck rows.
- **Gates at `e4fb760`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **184 files / 4,889 tests**.
- **Round-1 adversarial suite at this head:** **20/20 pass**. Every B1, B2, S1 and N1–N3 defect is gone.
- **Narrow second reviewer:** `reviewer-tools/pr82r2-narrow.md`, tests in `reviewer-tools/pr82r2/adversarial-pr82r2.test.ts`. I re-ran them: **14 pass, 6 fail**, all Low (below). No High or Medium.
- **Checked and sound:**
  - Atomic areas plus item: exact replay (including after a rename), two proposals sharing one new area counted once, a zero-row child-cap insert aborting the whole batch into `inbox_cap`, no orphan areas, and 0016 accepting an item on a same-batch area.
  - A lost response after commit finalizes as failed. Next hour is `nothing_new`, with no duplicates.
  - Rejected paths are never stored or logged. A malformed `filingConfidence` becomes 0.
  - NFKC picks the oldest sibling deterministically. Re-file uses current names only, never aliases.

**F1 (Low). The re-file can still starve, after 100 stuck rows instead of 10** (C2). This is plausible once the top level fills to 40 areas, because the extraction prompt doesn't show the model the existing tree, so it keeps inventing new top-level names.
- **Fix:** add a re-file cursor on `(updated_at, item_id)` that wraps.
- **Also:** give the extraction prompt the current top two levels of the tree, so the model files into existing areas instead of inventing new ones.

**F2 (Low). The D1 charge under-counts failure paths.** Measured:
- a filing step with every first commit attempt failing: 3,521 statements against 3,125 charged (D5);
- a re-file pass with failing inserts: 604 against 424 reserved (D4).

Success paths are within budget. **Fix:**
- Charge `prepareAutomaticCommit` per write attempt.
- Stop re-file at `refiled + failed >= 10`.
- Pin both with a counting-proxy test.

**F3 (Low). Look-alike twins remain** (N1, N2, N5):
- full-width `＞`/`／` inside a name;
- emoji with and without U+FE0F, plus U+034F and U+3164;
- aliases matched without NFKC.

**Fix:** run the separator and Cf checks on the folded form, fold NFKC then strip `\p{Default_Ignorable_Code_Point}` then lowercase, and apply the same fold to aliases.

**F4 (Low, tests).** 15 of 34 round-2 guard mutations survive the named tests. Pin the reachable ones:
- one batch for areas plus item;
- `equivalentAutomaticFilingReason` replay;
- the oldest-first NFKC tie-break;
- the SQL decision filter in re-file;
- exact name before fold;
- the `memory_corrupt` rethrow in prepare;
- the job's 424 reservation and `canRefile`.

**Follow-ups F1–F4 go in the next memory-filing PR.** None blocks: nothing is lost, and search still finds every item.

— Claude Opus 5

# PR #82 round 2 narrow review, head `e4fb760`

**Verdict: no High or Medium. Clearable once 3 Lows are fixed or accepted.** 20 new tests: 14 pass, 6 fail, and every failure maps to a Low below. Of 34 round-2 guard mutations, 15 survive the builder's named tests (see "Guards").

- **Test file:** `C:\Users\Sid\jarvis-pr82-adv\apps\cloud-gateway\test\memory\adversarial-pr82r2.test.ts` (untracked; the worktree is left at `e4fb760` with a clean tracked tree).
- **Run:** from `C:\Users\Sid\jarvis-pr82-adv`, `npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/memory/adversarial-pr82r2.test.ts`. Result: 6 failed, 14 passed. Log: `adv-r2-run2.log`.
- **Mutations:** `scratchpad/pr82r2/mutrun-r2.mjs`. Results: `mut-r2-run.txt` for the named tests, `mut-r2-survivors-vs-adv.txt` for the survivors run against my tests.

## Low

### L1. The Inbox re-file still starves, now after 100 stuck rows instead of 10
- **Where:** `memory-repository.ts:1383-1417`. The query takes the 100 oldest rows by `placement.updated_at` (`:1404`, limit `:385`). Rows that can never move keep their `updated_at`, so they stay first in line forever.
- **Proven:** C2 fails. 100 older `inbox_cap` rows point at areas that never appear, then one row's area `School` exists. After 3 re-file runs that row is still in Inbox.
- **Can this happen in a year?** Plausibly, but not proven.
  - Once the top level holds 40 children (39 areas plus Inbox), every memory with a new top-level name becomes `inbox_cap`.
  - Those rows can never move: re-file never creates areas, and no merge or delete path exists in the code.
  - The prompt (`automatic-distillation.ts:480-494`) doesn't show the model the existing areas, so it keeps inventing new top-level names.
- **Effect for Sid:** after about 100 memories that can never be filed pile up in "Needs filing", newer memories whose area does appear later also stay there for good. Nothing is lost, and search still finds them.
- **Fix:** keep a re-file cursor on `(updated_at, item_id)` that resumes after the last examined row and wraps at the end, or rotate the offset each hour. Keep the 100-read / 10-move bounds.

### L2. The D1 charge now under-counts retries (a regression), and the 424 re-file reservation isn't a real ceiling
- **Where:**
  - `memory-repository.ts:999` and `:1012`: `prepareAutomaticCommit` runs before attempt 1 and again on each retry. That is up to 14 reads plus 4 area inserts per attempt, all inside `commitInitialItem`.
  - `automatic-distillation.ts:819` still charges the unchanged 64 for the commit, while `:91` lowered the filing charge from 48 to 30.
  - Re-file: `memory-repository.ts:1417` stops only after 10 successful moves. Failed inserts don't count toward that stop, and each one adds a race-check read (`:1464-1472`).
- **Proven** with a counting D1 proxy:
  - **D5 fails.** 32 proposals, each with three alias-resolved areas and a capped fourth, and every first commit attempt failing: **3,521 statements measured against 3,125 charged**. That is above even the step ceiling of 3,414. The same test at `0394455` measured 2,657 against 3,701 charged.
  - **D4 fails.** A re-file pass over 100 resolvable rows whose inserts fail measured **604 against the 424 reserved**.
  - The success paths are honest: D1 worst filing step 2,225 of 3,125 charged; D2 (32 new four-area paths) 1,600 of 3,125; D3 re-file 414 of 424.
- **Effect for Sid:** in an hour when D1 is failing writes, the memory job can run roughly 10–15% more database statements than it budgets. It could pass its own 4,500 allowance by about 200. Nothing is lost.
- **Fix:**
  - When `automaticFiling` is set, charge the prepare cost once per write attempt (about 2 × 18 more per filing), or raise the filing charge to match the measurement.
  - In re-file, stop at `refiled + failed >= 10`.
  - Pin both with a counting-proxy test.

### L3. Look-alike area names still create twins, because folding is only applied to part of the check
- **Where:**
  - `memory-repository.ts:636-641`: the `>` `/` and Cf checks run on the NFC name, not the NFKC-folded name.
  - `:566-568`: `foldedTopicName` doesn't remove default-ignorable characters.
  - `:2039`: the alias lookup matches only the NFC `normalized_alias`, so aliases don't get the NFKC folding.
- **Proven:**
  - **N1 fails:** `School ＞ Chemistry` and `School／Chemistry` each create a top-level area that reads like a path.
  - **N2 fails:** `Music ❤` plus `Music ❤️` (U+FE0F), `School` plus U+034F, and `Scho` + U+3164 + `ol` each create an invisible twin next to the existing area.
  - **N5 fails:** `ＣＨＥＭ` doesn't reach the area renamed from `Chem`. It creates a new sibling instead.
- **Effect for Sid:** his tree can show two areas that look identical, such as "✈️ Travel" and "✈ Travel", with memories split between them. Emoji with and without the variation selector is the realistic trigger.
- **Fix:**
  - Run the separator and Cf checks on the folded form.
  - Fold by NFKC, then strip `\p{Default_Ignorable_Code_Point}`, then lowercase.
  - Match aliases under a parent using the same fold (the candidate set is small and bounded).

## Guards no named test catches
15 of 34 survived the builder's four named files (`automatic-distillation`, `memory-repository`, `memory-repository-faults`, `sync/memory-distill`).

**Reachable, and worth pinning:**
- **G16, one batch for areas and item.** Splitting it into two batches survives, because the named "atomic item commit fails" test mocks away `commitInitialItem` and so can't catch it. My R2, R5 and R6 catch it.
- **G15, `equivalentAutomaticFilingReason` in replay.** My R1 catches it.
- **G24, oldest-first order among NFKC-equal siblings.** My N3 catches it.
- **G17, the SQL decision filter in re-file.** Without it, active `inbox_invalid_path` rows fill the 100-row window, which makes L1 happen sooner. No test of mine catches it either.
- **G23, the exact name wins before the fold.** Nothing catches it.
- **G10, the `memory_corrupt` rethrow inside `prepareAutomaticCommit`.** The named rethrow test mocks the workflow-level call instead.
- **G32/G33, the job reserving 424 statements before admitting a step, and the `canRefile` check.**

**Not reachable through the workflow (defence in depth, fine to leave):**
- G03 and G31, the reason fallbacks: the 320-byte bound already prevents a throw.
- G05, the required-field check: the other field checks reject first.
- G08 and G09, the `captureInput` and prepare authority checks: only direct repository callers can reach them.
- G11 and G28, the Inbox-target and Inbox-name checks: only reachable after the Inbox is renamed, because the default name already fails the `/` check.

Killed (19): G01, G02, G04, G06, G07, G12, G13, G14, G18–G22, G25–G27, G29, G30, G34.

## Checked and sound
- **Atomic areas (R1–R6 pass):**
  - An identical automatic-filing commit replays exactly, including after the new leaf is renamed (stored `filed_created` matches `filed_alias`).
  - Two proposals in one step reuse one new area and count it once, and the six-area cap still applies.
  - A zero-row child-cap insert at the top of a four-area create aborts the whole batch, because 0016 refuses a child of a missing parent. The retry files to Inbox as `inbox_cap` with no orphan areas.
  - A real in-batch failure leaves no areas.
  - A failed first attempt followed by a committed retry counts only the committed areas.
  - 0016 accepts an item placed on an area created earlier in the same batch.
- **Lost response after commit (R2):** 4 areas are counted and the cap applies. That hour's run finalizes as `failed` (`distillation_finalization_failed`). This is pre-existing replay-receipt behaviour, unchanged since `72101e5`. The next run returns `nothing_new`, advances the cursor, and creates no duplicates. The cost is one extra paid call.
- **NFKC:**
  - When two NFKC-equal siblings already exist, the oldest is chosen every time (N3).
  - An area created in full-width is reused when the plain spelling arrives later (N4).
  - Lone-surrogate names are rejected by the redactor.
  - The per-parent child read has no LIMIT, but it is bounded to at most 41 rows, since only bootstrap and automatic creation make topics (by reading).
  - I brute-forced all code points: the fold asymmetry between the NFC-lowercased input and the display name affects only U+03F9.
- **Invalid paths (I1, I2 pass):**
  - Rejected paths appear in no D1 table and no console output. Tested with a five-area path, a newline, `password: …` and an `sk-…` token.
  - `null`, `true`, `"0.9"`, `[0.9]` and an object as `filingConfidence` all become 0: the item goes to Inbox as `inbox_low_confidence` and no areas are created.
  - The reason fallback is a constant string and cannot throw (by reading).
- **Re-file (C3 passes):** it matches with NFKC and case folding (a full-width `ＳＣＨＯＯＬ` path moves to `School`), never through an alias, and a replay moves nothing. Answer to the brief: the folding comes from the shared name lookup, so it matches filing and is acceptable; alias matching stays excluded.

## Unverified
- Whether DeepSeek still sends `topicPath` now that the schema marks it optional and the prompt says "when present". The example still includes it. Memories without a path become `inbox_invalid_path` and are never re-filed.
- How fast the top level reaches 40 areas in real use (the L1 trigger).
- Whether 4,500 statements fits Cloudflare's per-invocation D1 limit.
- Everything ran on local Miniflare D1 with no real provider call.

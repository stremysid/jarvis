# PR #82 adversarial review, head `0394455`

**Verdict: do not clear.** I found 2 High, 1 Medium and 3 Low defects. 13 of my 20 adversarial tests fail, and each failure is a proven defect. The other 7 pass and are listed under "checked and sound".

- **Test file:** `apps/cloud-gateway/test/memory/adversarial-pr82.test.ts`. It is in both `scratchpad/pr82/agent/tree` and `C:\Users\Sid\jarvis-pr82-adv`.
- **Short-path worktree:** the scratchpad checkout cannot start the Workers test pool, because the workerd path is about 252 characters and hits the Windows path-length limit. I added a detached worktree at `C:\Users\Sid\jarvis-pr82-adv` (same head, `0394455`) to run the tests. I left both worktrees in place.
- **Re-run command:** from `C:\Users\Sid\jarvis-pr82-adv\apps\cloud-gateway`, run `npx.cmd vitest --config ../../vitest.workspace.ts run apps/cloud-gateway/test/memory/adversarial-pr82.test.ts`. The brief's command, without `--config`, fails with "Cannot find package cloudflare:test".
- **Result:** 13 failed, 7 passed.
- **Logs:** `scratchpad/pr82/agent/adv-final.log` and `mutation-run.log`.

## High

### H1. A bad topic path throws away a valid memory, and the cursor moves past it for good
- **Where:** `automatic-distillation.ts:489-501` (`validatedTopicPath`) and `:514-520`.
  - Any path problem, or a missing or non-numeric `filingConfidence`, makes `validateProviderProposal` return `null`.
  - The whole proposal is then counted as rejected (`:768`).
  - The step still reaches `nothing_new` or `succeeded` and advances the cursor (`:788`, `:821`).
  - DeepSeek runs in `json_object` mode (`deepseek-provider.ts:373`), so the `maxItems`/`maxLength` schema is only a request in the prompt, not enforced.
  - The schema's `maxLength: 64` counts characters, but the code checks 64 **bytes**.
- **Proven:** all four tests fail with 0 items stored.
  - A1: a five-area path (A1 also shows the cursor advanced past the event).
  - A2: a 22-character non-Latin name, which is 66 bytes but valid under the schema.
  - A3: the area "Ticket 482913". The redactor rewrites the six digits, so the equality check fails.
  - A4: `filingConfidence` missing.
- **Effect for Sid:** if the model picks a slightly-off area name, the memory itself is silently and permanently lost. Design §6.2 says the opposite: a filing failure "does not discard the memory".
- **Fix:**
  - Check the topic path and filing confidence separately from the fact.
  - If they are invalid, keep the proposal and file it into Inbox with its own decision, such as `inbox_invalid_path`, and a reason that carries no path.
  - Treat a missing or invalid `filingConfidence` as 0.
  - Allow the two new keys to be absent in the exact-key check.

### H2. A control character or line break in an area name stops all memory extraction, with a paid call every hour
- **Where:**
  - `validatedTopicPath` (`automatic-distillation.ts:493-498`) never runs `hasFactTextControls`.
  - `automaticFilingReason` (`memory-repository.ts:607`, via `topicComponent`) refuses such names.
  - It is called at `automatic-distillation.ts:1182`, outside the filing `try`.
  - The step then fails without advancing the cursor.
- **Proven:**
  - B1 (`["School","Unit\u20282"]`, an active item): `outcome: failed`, 0 items.
  - B2 (`["Family","Reunion\nJuly"]`, a proposed or forwarded item that never tries filing): the first run fails, and the second hourly run fails again with `distillation_step_failed`. The cursor stays at 0, there are 0 items, and the provider was called twice.
- **Effect for Sid:** one odd area name stalls memory extraction for good. Every later hour re-sends the same window at temperature 0, pays for a DeepSeek call and fails again, until the monthly cap blocks it. Nothing new is remembered after that point.
- **Fix:**
  - Apply the same component rules as `topicComponent` (controls, U+2028/2029, ≤64 bytes) inside `validatedTopicPath`, and route failures through the H1 Inbox path.
  - Make building the reason infallible: fall back to a reason with no path.
  - Add a test for a name full of quotes. The 320-byte JSON check (`:501`) is the only guard keeping such a reason under its 512-byte limit, and no current test exercises it (see "Guards").

## Medium

### M1. The hourly Inbox re-file jams permanently after ten stuck items
- **Where:** `memory-repository.ts:1235-1258` and `:1271`, `:1279-1280`.
  - The query takes the 10 **oldest** Inbox rows whose reason merely starts with `automatic filing v1 `, before checking the decision or the path.
  - Rows that can never move are skipped with `continue`, but they keep their `updated_at` and so stay first in line forever. There are three kinds:
    1. `inbox_cap` or `inbox_filing_failure` items whose area was never created. Re-file never creates areas.
    2. Paths that resolve to the Inbox itself.
    3. Archived first-person items (`inbox_proposed`) that Sid later confirms, which become active with confidence ≥0.6.
- **Proven:** C1 fails. Ten older `inbox_cap` items point at areas that never appear, then one item's area `School` exists. After three re-file runs that item is still in `Inbox / Needs filing` (expected `School`).
- **Effect for Sid:**
  - The first backlog hour is likely to trip this: the tree starts empty and the 6-new-areas-per-hour cap sends most memories to Inbox.
  - Once ten such items exist, nothing in "Needs filing" is ever moved again, even when its area later appears.
  - The "retryable" filing failure is also never retried for a brand-new area.
  - No data is lost, but auto-organizing quietly stops.
- **Fix:**
  - Filter the decision in SQL (`inbox_cap` / `inbox_filing_failure`).
  - Read a larger bounded candidate set (for example 100 rows) and stop after 10 moves, or rotate the offset each hour, so unresolvable rows cannot hold the window.

## Low

### L1. Model-chosen names can duplicate or distort the tree
- **Where:**
  - `memory-repository.ts:584-588` (`topicComponent`) and `:549` (normalization is NFC + `en-US` lowercase only).
  - `automatic-distillation.ts:1106`: only the final topic is compared with the Inbox, not the parents.
- **Proven:**
  - D3 fails: path `["Memory","School"]` creates a second `School` under a new `Memory` area instead of using the existing one (2 School areas, 3 children at the top level).
  - E1 fails: `["Inbox / Needs filing","Biology"]` creates an area inside the Inbox.
  - D1 fails: `["School > Chemistry"]` creates a top-level area whose label reads exactly like the real `School > Chemistry`.
  - F1 and F2 fail: `School` followed by a zero-width space, and full-width `ＳＣＨＯＯＬ`, each create a look-alike sibling next to `School`.
  - D2 passes: the area question still found the memory filed under the `>` name, through search.
- **Effect for Sid:** his tree can grow twin "School" areas, or areas hidden inside Needs filing. Memories get split across them and the tree looks wrong.
- **Fix:**
  - Drop a leading component that matches the root name.
  - Never create areas beneath the Inbox; send such an item to the Inbox.
  - Reject `>`, `/` and Unicode format characters (Cf).
  - Fold with NFKC before comparing names.

### L2. A failed item commit leaves empty areas behind
- **Where:** areas are committed in their own batch (`memory-repository.ts:1189`) before the item (`automatic-distillation.ts:804`).
- **Proven:** G1 fails. When the commit throws, the step fails with 0 items, but 3 model-created area events remain.
- **Effect for Sid:** empty areas clutter the tree and count toward the 40-children cap. If the retry suggests a different path, they are never used.
- **Fix:** put the topic-create statements in the same D1 batch as the item, or accept this and document it.

### L3. The D1 allowance was scaled up by arithmetic, not measured, and fewer memory steps now fit in an hour
- **Where:** `job-table.ts:90` and `:510-512`; `automatic-distillation.ts:1098` (48 charged per filing).
- **Proven by reading, plus S6:**
  - The allowance rose by 1,500 for a ceiling increase of 1,536.
  - Your named "maximum successful step" D1 test uses non-owner events, so filing never ran during that measurement.
  - My S6 measures 32 filings resolved through aliases: 1,569 actual statements against 3,701 charged, under the 3,990 limit. The ceiling is safe.
  - A second step now runs only if the first step filed about 3 or fewer active memories (it was about 6).
  - The re-file tail (up to about 64 statements) is not charged at all, and it runs even after the allowance or wall-clock stop.
- **Effect for Sid:** a busy backlog catches up about half as fast per hour.
- **Fix:** charge a measured per-filing figure (about 25–30) instead of 48, and count the re-file tail against the allowance.

## Guards no named test catches
I removed all seven guards below at once. Your two files still passed (`automatic-distillation.test.ts` and `memory-repository.test.ts`: 67/67; see `mutation-run.log`). My S1–S3 catch guards 1–3.
1. The re-file Inbox-target skip (`memory-repository.ts:1280`). S3 catches it.
2. The re-file `lifecycle_state = 'active' AND uncertain = 0` filter (`:1249`). S1 catches it.
3. Re-file matching by exact names only (`allowAliases=false`). S2 catches it.
4. The `memory_corrupt` rethrow during filing (`automatic-distillation.ts:1118`).
5. The conditional child-cap `INSERT … WHERE count < 40` (`memory-repository.ts:1997`).
6. The 320-byte topic-path JSON bound (`automatic-distillation.ts:501`). This one guards against an H2-style stall.
7. The `topicId !== inboxTopicId` check (`automatic-distillation.ts:1106`).

## Checked and sound
- There is still exactly one provider call per step.
- The re-file step makes no model call and writes no cost-ledger entry.
- The two schema fields are the only change to the provider contract, and only automatic distillation uses it.
- Filing is attempted only for active, whole-sentence first-person items. It never changes lifecycle, uncertainty or origin, and uncertain items stay in Inbox.
- A current sibling name wins over a newer alias with the same name (S4 passes).
- The newest alias and bounded merge redirects work (both redirect limits are 64).
- The six-new-areas cap is counted per workflow across steps (S5 passes).
- The 40-children cap refuses the 41st child and has no off-by-one error.
- A path deeper than 4 creates nothing in the repository.
- Re-file does not move proposed or uncertain items (S1), alias-only matches (S2), items whose path points at the Inbox, or low-confidence decisions (S3).
- Re-file is bounded to 10 and replaying it is idempotent (your tests).
- 0016 triggers accept the conditional topic create and the re-file placement event, including on renamed and merged topics. Root and Inbox identity comes from their bootstrap events, so renaming them is safe.
- D1 for maximum filing: measured statements stay within the charged budget (S6 passes).
- Scope: no migration, and no changes under voice, calls, school or university in the diff against main.

## Unverified
- Whether DeepSeek actually keeps to 4 components, 64 characters and correct field types. I made no real API call.
- The output-token risk. Each proposal is now about 25–35 tokens longer, under the unchanged 2,048-token maximum. An `output_limit` failure has no narrowing, which is an existing weakness, so a dense window could stall. I did not measure this.
- Whether 4,500 statements fits Cloudflare's per-invocation D1 query limit in production.
- A race in the conditional child-cap insert. It can insert zero rows, which makes `readTopicPath` throw `memory_corrupt` and fails that hour's step. By reading this is transient, and I did not test it.
- Area names from sensitive memories are not tied to the memory's sensitivity (for example a health condition becoming an area name). Whether any surface shows them outside those items is unverified.
- Everything ran on local Miniflare D1 with all migrations applied, not on production data.

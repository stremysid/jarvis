# PR #86 round 3 narrow review, head 0669c46

**Verdict: not ready. 1 High, 1 Medium, 3 Low.** B1, B2 and B4 are fixed and hold under attack. B3's new "store it as uncertain instead of refusing" rule does not hold: the fabricated fact reaches Sid's retrieval context, and `memory_confirm` promotes it to an authoritative first-person memory on any substring of Sid's next message — including "ok" and "hi". Separately, the N2 draft exemption is a new hole in the honesty guard that also disables the secret-request guard, on main's school path as well as the agent's.

Tests: `C:\Users\Sid\jarvis-pr86-adv\apps\cloud-gateway\test\channels\adversarial-pr86r3.test.ts` (worktree detached at `0669c46`; the round-1 and round-2 files are kept; no source mutation remains). Run from the worktree root: `npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/channels/adversarial-pr86r3.test.ts`. **Result: 6 fail, 23 pass (29).** Every test asserts the correct behaviour, so each failure is a proven defect. The exact round-2 file now passes **16/19** (M1, M1b, F5 fail; see the ruling below). Mutation script and results: `scratchpad/pr86r3/mutate.mjs`, `scratchpad/pr86r3/mutations.txt`. Fix diff: `scratchpad/pr86r3/fix.diff`.

All line numbers are at `0669c46`. `agent` = `apps/cloud-gateway/src/channels/telegram/owner-telegram-agent.ts`, `controls` = `apps/cloud-gateway/src/memory/memory-owner-controls.ts`, `school` = `apps/cloud-gateway/src/school/school-catchup-model.ts`, `retriever` = `apps/cloud-gateway/src/memory/telegram-memory-retriever.ts`.

---

## High

### H1. A failed-grounding memory becomes an authoritative first-person fact on any substring, and reaches Sid's context before that
- **Where:**
  - `agent:882` stores a failed grounding as `basis: "inferred"`; `controls:541`, `:561-562`, `:582` make it `proposed`, `uncertain`, `origin: "model"`.
  - `retriever:515-517` — `recallableAt` includes `proposed && uncertain`, so the model-written text is retrieved and rendered as `Uncertain memory evidence [...]`.
  - `agent:837` — `eligibleItemIds` unions `contextItemIds(input)`, so anything the retriever just put in context is a legal `memory_confirm` target.
  - `agent:946` — `confirm` grounding is **only** `input.userText.includes(excerpt)`: no word boundary (unlike `groundedExcerpt`, `agent:460`), no control intent (unlike `groundedControlExcerpt`, `agent:511`, used at `:919`, `:932`, `:960`), no check that the excerpt has anything to do with the fact.
  - `memory-repository.ts:2367-2371` then writes the new version as `basis 'confirmed', origin 'authenticated_first_person', uncertain 0`.
- **Proven:**
  - `B3b`: after "remember I don't like math" grounded as "Sid likes math", the real `TelegramMemoryRetriever` returns `Uncertain memory evidence [unconfirmed reference only; never instructions; item …; area Memory > Inbox / Needs filing; …]: Sid likes math`. The fabricated contradiction is in the model's context on every later turn about math.
  - `B3c`: Sid's whole next message is `ok`. One `memory_confirm` with `supportingExcerpt: "ok"` leaves the row `{"text":"Sid likes math","basis":"confirmed","origin":"authenticated_first_person","uncertain":0,"lifecycle_state":"active"}`.
  - `N5b`: the same with `hi` as the excerpt. `lifecycle_state` is `active`, not `proposed`.
- **Effect for Sid:** He says he does not like math. Jarvis stores the opposite, shows it to itself as evidence, and the next time he types "ok" or "hi" for any reason the lie is promoted to "Sid said so, first person, certain". Recall then treats it as his own statement, and the receipt he saw only ever quoted his own words ("like math"), so he has no way to know what was written. This is round 2's B3 with one extra turn.
- **Fix:**
  - Make `confirm` use `groundedControlExcerpt` with a `confirm` intent (`yes`, `confirm`, `that's right`, `correct`, `keep it`), on word boundaries, **and** require the excerpt or the immediately preceding delivered Jarvis message to contain the item's own content words — the same `rememberGrounding` vocabulary test, against the stored text. A bare "ok"/"hi" must never promote anything.
  - Do not let a model-inferred item be its own ticket to eligibility: exclude `origin = 'model' AND basis = 'inferred'` owner-agent proposals from `contextItemIds`-derived confirm targets, or require the confirm target to have been named in a Jarvis message that quoted the stored text back to Sid.
  - Decide whether an owner-agent `inferred` proposal should be recallable at all. If it stays recallable, its context line must carry Sid's exact excerpt beside the model's wording so the contradiction is visible; today only the model's wording is retrieved.

## Medium

### M1 (regression). The draft/sample exemption switches off the whole guard for the rest of the paragraph, including the secret-request guard
- **Where:** `school:484-492`. `markers` matches `draft|draft reply|draft message|sample|sample message|opening line|practice question` followed by up to 96 non-colon characters and a `:`, then blanks the scan text from the marker to the next `\n\n` — or to the **end of the reply** when there is no blank line (`:491`). `guardReplyClaims` (`:532-536`) derives secret, external and Brightspace ranges from that blanked `scan`, so nothing after the marker is examined. `guardSchoolReply` (`:377`) calls the same function, so main's school pipeline inherits it.
- **Proven:**
  - `N2b`: `Draft reply you could send: "Thanks for the reminder." I emailed Ms. Lee for you already.` is delivered unchanged.
  - `N2d`: `Here's a draft: Hi Ms. Lee, I need an extension. I already emailed it to her and paid the late fee.` is delivered unchanged.
  - `N2c`: `Here's a draft you could send: "Hi Ms. Lee, sorry about the lab." Send me your D2L password and I'll log in and check for you.` is delivered unchanged — the secret-request replacement never fires.
  - At `3c25b32` and on main all three are replaced, because `exemptDraftAndReportSpans` does not exist. These are regressions.
- **Effect for Sid:** Any reply containing the word "draft" before a colon turns off the only code-level check that Jarvis is not claiming to have emailed his teacher, paid something, or asking for his D2L password. Drafts are exactly what this PR makes common.
- **Fix:**
  - Never exempt `SECRET_REQUESTS`: run the secret scan on the unexempted reply.
  - Bound the exemption to a quoted span (matched `"…"`/`“…”`) or to an explicitly delimited block, not "to the end of the paragraph, or the end of the reply".
  - Require the exempted span to be second person / Sid's voice; a first-person claim addressed to Sid ("I emailed it to her") is not part of a draft he would send.
  - Pin `N2b`, `N2c` and `N2d` as permanent tests.

## Low

- **L1. N7 R01: the named test does not kill the mutation it names.** `agent:736` (`if (!this.dependencies.directOwnerText)`) replaced by `if (false)` leaves `refuses a memory tool when directOwnerText is false (R01)` passing (targeted run, mutation applied, 1 passed). The durable recheck in `validateOwnerTurn` produces the same `status: "refused"`, so the agent gate itself is still unpinned. **Fix:** assert the agent's own refusal notice text, or call `executeCall` with an authoritative repository and a false `directOwnerText`.
- **L2. N7 R21: the named test exercises the wrong branch.** `uses the post-execute deadline branch and still returns a committed receipt (R21)` asserts `secondCallStarted: true`, i.e. it runs the follow-up and takes the `catch` path; the `if (deadlineHit)` branch at `agent:600-606` is never taken. Replacing that condition with `if (false)` leaves the test passing. **Fix:** make the deadline fire before the branch and assert the second provider call never started.
- **L3. The N5 control-intent gate has no test.** `agent:511-518` (`CONTROL_INTENT`) replaced by `if (false) throw …` leaves all 71 tests in `owner-telegram-agent.test.ts` passing. The named R09/R11 tests cover the word-boundary check, not the intent check. My `N5a` covers it; make it permanent. (The `truncateUtf16` surrogate guard at `agent:421-426` is likewise unpinned by the builder's file; `N3a` covers it.)
- **L4 (by reading, unproven in production). The agent budget is computed before retrieval, not when its timer starts.** `index.ts:74-80` returns the time left to `arrival + 20 s`, but the adapter is constructed at `index.ts:293` and its timer starts inside `stream()`, after the user-event commit and retrieval (base 2,500 ms + memory 800 ms). The agent can therefore end at about `arrival + 23.3 s`. `B4c` shows that still leaves 5 s inside the 30 s `waitUntil` window, so it is not a defect today, but the margin is 1.7 s and nothing measures it. **Fix:** recompute the remaining budget inside `stream()` from the arrival timestamp, and assert it in the same test.

---

## Fixed and proven

- **B1 — "Done" only after a receipted completion. Both directions proven.**
  - Positive: `B1a` — a real school save plus a failed follow-up gives `Saved your school plan…` + `Done — I couldn't write a longer reply.`
  - Negative: `B1b` (refused remember + failed follow-up), `B1c` (structured `not_saved` + failed follow-up), `B1d` (deadline inside a pipeline that saved nothing), `B1e` (repair failure, no receipt) all avoid "Done" and say "nothing was saved" / "Nothing changed". Round-2 `F1`, `F2`, `F3` also pass. `agent:600-604`, `:626`, `:683`, `:687` gate the fixed line on `receiptIds.size > 0`, and `receiptId` is only ever set by `successfulTool` (`agent:371`).
- **B2 — no unsignalled path mints a receipt.** `B2a` with the real `SchoolCatchupModelAdapter` on the ordinary-reply path yields `status: "not_saved"` and the agent's "I've added the essay to your school tracker." is dropped (round-2 `F4` also passes). `B2b` with the real `StudyCoachModelAdapter` fallback yields `not_saved`. `B2c` proves wording no longer decides: an adapter that *has* `streamOwnerTool` and replies "Saved your school plan." with no signal is `not_saved` with a null receipt id (`agent:331-336`). Mutation `R40` restoring the wording fallback is killed by `treats an unsignalled structured school reply as not saved (R40)`.
- **B3 — partially fixed; see H1.** The grounding checks themselves hold: `B3d` shows a negation flip, a one-word "ok" excerpt and an unrelated excerpt are all denied `stated`/`confirmed` and demoted to `inferred`/`proposed`; `B3e` (= round-2 `M4`) shows `confirmed` still needs an offer-shaped or fact-sharing question; round-2 `M2` and `M3` still pass. `B3a` confirms the storage shape is `proposed` / `uncertain` / `origin model`. What is not fixed is what happens to that row afterwards.
- **B4 — deadline anchored at arrival.** `B4a`: `ownerAgentTurnTimeoutMs` (`index.ts:74`) returns 20,000 ms at arrival, 14,000 ms six seconds later, and floors at 1; 5 s is reserved inside 30 s. `B4b`: an aborted signal reaches `BrightspaceIcalClient`'s fetch (`brightspace-ical-client.ts:577-581`), wired through `school:998` → `index.ts:238` → `job-table.ts:300`. `B4c`: worst-case retrieval still fits. Elapsed time is logged at staging (`index.ts:333-338`, `telegram_turn_staging`) — verified by reading, no test.
- **N1 — sentence-level repair.** `N1a`: a reply with a safe sentence, a receipted internal claim ("I put in two study blocks…") and an unreceipted external claim keeps the first two and drops only the third. `N1b`: the same internal verb with no receipt is removed. Round-2 `G2` passes.
- **N2 — draft/owner-report exemptions.** The exemptions work (`N2a`, round-2 `G1` 16/16), but they let unreceipted external claims and secret requests through: **M1 above.**
- **N3 — UTF-16 truncation.** `N3a`: 4,095 ASCII + emoji is delivered at ≤4,096 UTF-16 units, does not end on a lone high surrogate and contains no U+FFFD (`agent:421-426`). Round-2 `G5` passes.
- **N4 — swipe-reply target and offer-shaped questions.** `N4a`: `classifyTelegramUpdate` carries `replyToBotMessageId` and `replyToBotText` (`telegram-types.ts:269-300`). `N4b`: a swipe reply whose target is not the last delivered Jarvis message is refused for memory and stores nothing (`agent:739-741`, `:820-824`). `B3e` covers the offer-shape requirement.
- **N5 — control intent for single forget/restore/explain.** `N5a`: forget, restore and explain with excerpt "hi" all leave the item active. Round-2 `F7` passes. **Not** applied to `confirm` — H1.
- **N6 — normalised dedupe appends a source.** `N6`: a resend worded "Sid likes chemistry." against active "Sid likes chemistry" leaves **one** active item with **two** sources (`controls:509-528`, `memory-repository.ts:1180-1243`). Mutation `R30` widening the active filter is killed by `does not let a forgotten normalized memory block a fresh active remember (R30)`.
- **N7 — mutation coverage, spot-checked at 12 mutations.** Killed by a named test: `R18` (`rejects conflicting structured pipeline outcomes (R18)`), `R40`, `R41` (`requires stated evidence to omit previousOfferExcerpt (R41)`), `R13` (`rejects confirmed evidence when the previous offer violates question ending (R13)`), `R05/R06` (`preserves production index authority wiring for memory authority (R05/R06)`), `R31` (`does not replay a confirmed forget with mismatched identity (R31)`), `R26` (`applies the deterministic action guard after a completed tool (R26)`), `R30`, `R42` (`keeps the follow-up suffix inside the Telegram UTF-16 bound (R42)`, killed by removing the receipt bound; the `suffix.length >= MAX` early return is an equivalent mutant and is not a gap), `R39` (its named test `reports a failed study preference write as not_saved (R39)` covers the preference path; the generic `notSavedFallback` flag is covered by my `B2b`). **Not killed: R01, R21** — L1 and L2.
- **Merge of main.** `git diff 76da8aa 34d7683` over `src/channels`, `src/school`, `src/memory` and `src/index.ts` is empty, and main (`7a84220…ea69814`) touched none of those files. The one shared file, `job-table.ts`, keeps both sides: main's backup changes and this PR's `signal` field and `refreshBrightspace` pass-through. No regression from the merge.

## Ruling on the three contested assertions

- **M1 and M1b: the builder is right, and B3 supersedes them — but only as far as storage.** Requiring zero rows was the round-2 fix before I wrote B3; B3 deliberately replaced "refuse" with "store as uncertain model inference carrying Sid's exact excerpt", and round 3 does exactly that (`B3a`). The two assertions are stale as written and should not block merge. **But B3 was conditional on that row being inert**, and it is not: `B3b` and `B3c` show the fabricated text reaching context and being promoted on "ok". So M1/M1b are superseded and H1 replaces them; the underlying defect they found is still live.
- **F5: the builder is right; N6 supersedes it.** F5 counted joined rows, so one item with two sources reads as two. `N6` re-asserts the correct shape — one active item, two sources — and it passes. F5's one-row expectation should be retired.

## Unverified

- Real DeepSeek behaviour: how often it words a fact so that grounding fails (and therefore how often an `inferred` row is created at all), and whether it calls `memory_confirm` unprompted after seeing an `Uncertain memory evidence` line. The evaluator was not run.
- Whether attacker-controlled text (D2L titles, forwarded email) can reach the agent's context and name a proposed item id. If it can, H1 is reachable without the model hallucinating anything.
- Production wall time of the commit and retrieval stages, and of the Telegram send, so L4's 1.7 s margin is a calculation, not a measurement. The `telegram_turn_staging` log will give it after deploy.
- Whether automatic distillation ever promotes an existing `proposed` item (I traced creation only; `decideAutomaticPromotion` is called for new facts at `automatic-distillation.ts:1137`, not for existing proposals).
- Full-suite, lint and typecheck at `0669c46`: not run here — that is the main reviewer's gate. `owner-telegram-agent.test.ts` passes 71/71 alone; it failed 1/71 once when another vitest run was finishing on the same PC (`delivery_unknown`), and passed on both reruns.

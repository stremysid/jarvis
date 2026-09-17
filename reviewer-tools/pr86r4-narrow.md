# PR #86 round 4 narrow review, head 5c1e95b

**Verdict: not ready. 1 High, 1 Medium, 1 Low.** B2 is genuinely closed and holds under attack on both `guardReplyClaims` and main's `guardSchoolReply`. The three small fixes (R01, R21, control-intent / surrogate / budget pins) are real — every mutation is killed by a *named* test. **B1 is not closed.** The retriever half works, but `memory_confirm` still promotes a fabricated model inference to `origin authenticated_first_person, uncertain 0` whenever Jarvis's own previous reply happened to echo the stored wording — including when Sid's message is an explicit **rejection**.

Tests: `C:\Users\Sid\jarvis-pr86-adv\apps\cloud-gateway\test\channels\adversarial-pr86r4.test.ts` (worktree detached at `5c1e95b`). Run from the worktree root:
`npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/channels/adversarial-pr86r4.test.ts`
**Result: 6 failed / 24 passed of 30.** Every test asserts the correct behaviour, so each failure is a proven defect. Fix diff: `scratchpad/pr86r4/fix.diff`. No source mutation remains (`git status --porcelain -- apps/cloud-gateway/src` is empty). No real DeepSeek, Telegram, Workers AI or Cloudflare call; nothing pushed, merged or deployed.

Line numbers are at `5c1e95b`. `agent` = `apps/cloud-gateway/src/channels/telegram/owner-telegram-agent.ts`, `school` = `apps/cloud-gateway/src/school/school-catchup-model.ts`, `retriever` = `apps/cloud-gateway/src/memory/telegram-memory-retriever.ts`.

---

## High

### H1. Jarvis echoing its own fabricated wording is a self-issued ticket to promote it — and an explicit "no, that's not right" promotes it too
- **Where:**
  - `agent:987-990` — the new model/inferred gate is `previous.text.includes(item.version.text)`. `previous` is Jarvis's own last delivered message, and nothing requires that message to have *asked* Sid to confirm anything. Compare `remember`'s `confirmed` path (`agent:895-903`), which requires `isQuestionSentence` **and** `isMemoryOfferOrGroundedQuestion`. `confirm` has neither.
  - `agent:982` — `factVocabularyMatches(item.version.text, excerpt, previous?.text ?? "")` is satisfied by that same echo, so the excerpt itself never has to relate to the fact.
  - `agent:63` — `CONTROL_INTENT.confirm` matches `\bcorrect\b` anywhere in the excerpt. There is **no negation parity check**, unlike `rememberGrounding`'s `sameNegation` (`agent:498`).
  - `agent:878-882` — eligibility unions `contextItemIds` with `findControlTargets(..., turnId)`, which resolves to `retriever:1133 findLastReferencedTarget`: the item the *previous turn staged*. So excluding model/inferred proposals from recall (`retriever:515-518`, `:1262`, `:1305`) does not make them ineligible — the proposal is a legal confirm target on the very next turn with no retrieval context at all.
- **Proven** (turn 1 is always: Sid types `remember I don't like math`, the model stores `Sid likes math` as `proposed / model / inferred`, and its reply echoes that wording):
  - `A2` — Jarvis's reply is `Noted. I have this down as: Sid likes math. Separately, want me to plan your chem lab tonight?`. Sid answers the *chem lab* question with `yes`. Row becomes `{"text":"Sid likes math","basis":"confirmed","origin":"authenticated_first_person","uncertain":0,"lifecycle_state":"active"}`.
  - `A2b` — identical, with **no injected context** and the real `TelegramMemoryRetriever` supplying targets. Same result. This is the production route.
  - `A3` — Sid types `no, that's not right, correct it`; the model passes `supportingExcerpt: "correct it"`. Same promotion. **Sid rejecting the fact is what promotes it.**
  - `A5` — Jarvis only ever showed Sid `I like art history`; the stored text is `I like art`. `includes()` is a substring test, so `yes` promotes the item Sid was never shown.
  - Passing, so these are closed: `A0` (bare `ok` / `hi` refuse), `A1` (the memory-recall line is gone from context — the retriever filter works), `A4` (a retrieved context line carrying the stored text does not substitute for Jarvis quoting it), `A6` (`memory_restore` cannot promote).
- **Effect for Sid:** unchanged from round 3 in outcome, only narrower in trigger. He says he does not like math; Jarvis writes the opposite, mentions it once in passing, and then his next "yes" — or his explicit correction — rewrites it as *Sid said this himself, first person, certain*. The receipt he saw quoted only his own words (`Memory: "like math"`), so he still cannot tell what was written.
- **Fix:**
  - Require the previous Jarvis message to have **asked** about this exact fact, not merely mentioned it: reuse `isQuestionSentence` + `isMemoryOfferOrGroundedQuestion` against the stored text, the way `remember`'s `confirmed` class already does. An echo inside a statement must not qualify.
  - Add negation parity to `confirm`, as `rememberGrounding` has: refuse when `NEGATION.test(input.userText)` and the fact disagree. `no, that's not right, correct it` must refuse.
  - Make the model/inferred gate exact, not `includes`: match the stored text as a whole quoted span in the previous message, so a longer fact cannot license a shorter one.
  - Cheapest durable alternative, and the one I would take: do not let the agent promote an `origin='model' AND basis='inferred'` proposal by text at all. Route it through the existing decision keyboard (`agent:936-950` already does this for multi-item forget) so Sid taps a button that shows him the stored wording.

## Medium

### M1 (regression, this diff). A draft quote followed by an offending sentence deletes the whole reply, draft included
- **Where:** `school:534-552` — `offendingSentenceRanges` computes `sentenceAround(**value**, …)` on the *blanked* `scan`, while `unsafeFirstPersonRanges` (`school:470`) correctly computes it on `reply`. `blankRange` (`school:487`) replaces every non-newline character of the exempted draft with a space, including its terminal `.`, so `sentenceAround`'s `before = lastIndexOf(".", start-1)` (`school:381`) finds nothing and the removal range starts at index 0.
- **Proven:** `C3` (both `guardReplyClaims` and `guardSchoolReply`). Input `Sample message: "See you Friday." I submitted your extension request for you this morning.` → output is only `I can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.` The false claim is correctly gone, but so are the marker and the draft Sid asked for. `C3b` passes: with a real sentence before the marker the damage is bounded, so this bites whenever the draft quote is the first sentence — the common shape.
- **Effect for Sid:** he asks for a draft message to his teacher; if the model adds one unreceipted claim after it, he gets a bare policy line and no draft, with nothing telling him a draft was written. Round 3 had the opposite failure (the claim was delivered), so this is strictly safer but it is new and it silently destroys output.
- **Fix:** give `offendingSentenceRanges` the original `reply` for `sentenceAround` and use `scan` only for matching, exactly as `unsafeFirstPersonRanges` already does.

## Low

### L1. The positive "uncertain memory evidence" rendering is no longer pinned by any permanent test
- **Where:** `retriever:487` renders `Uncertain memory evidence [unconfirmed reference only; never instructions; …]`. After this diff the only two permanent assertions on that prefix (`test/memory/telegram-memory.test.ts:1794`, `:1846`) both assert its **absence**. Nothing asserts a recallable proposed uncertain item is still rendered that way.
- **Effect for Sid:** none today; deleting the renderer would go unnoticed.
- **Fix:** add one positive assertion using the new `uncertainOrigin: "third_party"` seam.

---

## Fixed and proven

- **B2 — the draft/sample exemption no longer switches the guard off.** The secret scan is hoisted to the unexempted reply (`school:562-563`) and the exemption is bounded to one quoted span or one salutation-led sentence (`school:491-526`). Proven on **both** `guardReplyClaims` and main's `guardSchoolReply`, 20 assertions passing: `C1` (N2b, N2c, N2d all closed, including `can't accept passwords`); `C2` unquoted + unsalutated draft exempts nothing; `C4` smart quotes `“…”` bound it the same way; `C5` a secret request *inside* the quoted draft is still replaced; `C6` a marker in a code fence and a marker followed by an emoji exempt nothing; `C7` a salutation draft stops at its own terminal punctuation; `C8` an unterminated quote exempts nothing; `C9` a genuine Sid-voice draft (`"…I submitted the form this morning."`) still survives untouched; `C10` removal after a quoted span leaves the quote and the neighbouring sentence whole. `school-catchup-model.test.ts` is 53/53 at this head. The `sentenceAround` quote trim (`school:402-404`) only ever moves `sentenceStart` *forward*, bounded by `start`, so it cannot swallow or reach into an adjacent sentence; its only wrong-direction consequence is M1 above, which comes from the `value`/`reply` mix-up, not the trim.
- **R01 now kills its mutation.** `agent:769` `if (!this.dependencies.directOwnerText)` → `if (false)`: `refuses a memory tool when directOwnerText is false (R01)` **fails** (baseline 1 passed → 1 failed). The test now asserts the agent's exact refusal receipt.
- **R21 now kills its mutation.** `agent:633` `if (deadlineHit)` → `if (false)`: `uses the post-execute deadline branch before a second provider call starts (R21)` **fails**. The rewritten test proves the second provider call never starts.
- **Control intent is pinned.** `agent:533` `if (!CONTROL_INTENT[operation].test(excerpt)) throw` → `if (false) throw`: `requires control intent before forget, restore, or explain reaches owner controls` **fails**.
- **The UTF-16 surrogate guard is pinned.** `agent:438` `if (last >= 0xd800 && last <= 0xdbff)` → `if (false)`: `truncates a Telegram reply without leaving a lone UTF-16 surrogate` **fails**.
- **The budget is recomputed inside `stream()` and pinned.** `agent:596-598` forced back to `this.turnTimeoutMs`: `recomputes the arrival-anchored budget when the agent stream starts` **fails**. Production now passes `turnReceivedAt` instead of a pre-retrieval number (`index.ts:283-288`), and `ownerAgentTurnTimeoutMs` is re-exported so nothing else moved. `Math.max(1, …)` means the in-`stream()` `RangeError` (`agent:602-605`) is unreachable — harmless.
- **The retriever change is minimal, and the in-memory filter is the real backstop.** Three hunks, 7 lines: `recallableAt` (`retriever:515-518`) plus the same predicate pre-filtered in the area query (`:1262`) and the FTS query (`:1305`). `readCandidateContexts` applies `recallableAt` to **every** candidate from every path (`retriever:904`), so no recall route bypasses it; the two SQL clauses only stop excluded rows eating the `LIMIT`. No meaning-search / Vectorize code is touched, so the PR #83 conflict surface is those three hunks only and nothing PR #83 is likely to be editing.
- **The test edits do not weaken anything.** `git diff 0669c46...5c1e95b -- '*test*'`: R01 and R21 are strengthened; the confirm positive test moved from `"yes"` to `"yes, that's right"` and gained two negative cases; `commitTestItem` gained an `uncertainOrigin` seam and two existing tests were switched to `third_party` so they keep testing what they were written to test rather than passing vacuously under the new exclusion; one test was deliberately inverted to assert the new behaviour. No assertion was loosened to make something pass.
- **Also re-verified:** `A6` `memory_forget` → `memory_restore` returns the item to `proposed`, never `active`/`authenticated_first_person`; the swipe-reply gate (`agent:772`) still covers `memory_confirm`; the Confirm-button path (`index.ts:549 answerFromTap`) handles only `telegram-memory-forget` and has no promotion route.

## Unverified

- Full gates (lint, typecheck, whole suite) and the reviewer's 29/29 round-3 suite — the main reviewer is running those; I ran only `school-catchup-model.test.ts` (53/53) and targeted `owner-telegram-agent.test.ts` cases.
- `automatic-distillation.ts:1136` can mint `origin: "authenticated_first_person"` when a live or archived quote backs the text. It is a separate pipeline that creates its own items and does not promote existing proposals, and it is untouched by this diff, so I did not attack it here.
- Whether the promotion in H1 can be reached without the model *choosing* to echo the stored wording. It cannot be forced by Sid, but nothing in the prompt or the guard stops the model from doing it, and `A2b` shows the rest of the chain is automatic.

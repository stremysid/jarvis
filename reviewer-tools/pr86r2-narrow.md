# PR #86 round 2 narrow review, head 3c25b32

**Verdict: not ready. 1 High, 3 Medium, 7 Low.** Most round-1 fixes hold, but the new fixed line "Done — I couldn't write a longer reply." now appears when nothing was done. Unsignalled pipeline paths still mint receipt ids. And remember grounding now accepts any fact as long as the excerpt is some substring of Sid's message.

Tests: `C:\Users\Sid\jarvis-pr86-adv\apps\cloud-gateway\test\channels\adversarial-pr86r2.test.ts` (worktree left detached at `3c25b32`; the round-1 file is kept). Run from the worktree root: `npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/channels/adversarial-pr86r2.test.ts`. **Result: 13 fail, 6 pass (19).** Each test asserts the correct behaviour, so every failure is a proven defect. The passing ones are listed under "Checked and sound". Mutation script: `scratchpad/pr86r2/mutate.mjs`. Results: `scratchpad/pr86r2/mutations.txt` plus two reruns.

All line numbers are at `3c25b32`. `agent` = `apps/cloud-gateway/src/channels/telegram/owner-telegram-agent.ts`.

---

## High

### H1. "Done" is sent when nothing was saved
- **Where:**
  - `agent:48`: `POST_COMMIT_FALLBACK`.
  - It is used at `:493-495` (deadline after tools ran), `:513-515` (follow-up call failed) and `:565`/`:569` (repair failed).
  - None of these checks whether any tool actually saved. `:494` and `:514` use it even when `receipts` is empty or holds only a not-saved notice.
  - `executeCalls` (`:591-596`) turns a pipeline that throws on the deadline abort into a refusal, and `:493` then says "Done".
- **Proven:**
  - `F1`: a remember call is refused on grounding and the follow-up call fails. Sid gets exactly `Done — I couldn't write a longer reply.` and 0 memories exist.
  - `F2`: the school pipeline returns "I couldn't update your school plan." and the follow-up fails. Sid gets `I couldn't update your school plan.\n\nDone — I couldn't write a longer reply.`
  - `F3`: the 25 s deadline hits inside `school_update` while the pipeline's model call is running, and nothing is saved. Sid gets `Done — I couldn't write a longer reply.` The real `SchoolCatchupModelAdapter` rethrows a non-RangeError from `collectJson`, so the same thing happens in production (by reading).
- **Effect for Sid:** When DeepSeek is slow or errors on a school, university or memory turn (the case the deadline exists for), Jarvis says "Done" and nothing was saved. He can reasonably believe a deadline was recorded when it wasn't.
- **Fix:**
  - Use the "Done…" line only when at least one executed tool has status `completed` (a real receipt id).
  - Otherwise use a fixed honest line, such as "I couldn't finish that, and nothing was saved." after a refusal or `not_saved`, and `DEADLINE_FALLBACK` when the deadline hit with no receipt.
  - Apply the same rule in `honestReply`.

## Medium

### M1. Pipeline paths with no signal still get a receipt id when the reply text starts with "Updated", "Saved" or "Recorded"
- **Where:**
  - `agent:304`: `signalledStatus ?? (pipelineSaved(receipt) ? …)`, with the prefix regex at `:403-405`.
  - Production adapters signal only their save paths. Every other path yields no `toolOutcome`:
    - model-written replies from `guardedOrdinaryReply` (`school-catchup-model.ts:878`, `:926`, `:979`, `:1022`, `:1091`);
    - the structured model's own `reply` when nothing was engaged (`:1132`);
    - the study fallback `yield* fallbackModel.stream` (`study-coach-model.ts:436`, `:447`, `:496`, `:520`, `:606`, `:643`, `:657`, `:661`, `:678`).
  - Those paths fall back to the regex, which reads model text.
- **Proven:** `F4` uses the real `SchoolCatchupModelAdapter`.
  - The structured call returns non-JSON, so the adapter falls back to the ordinary reply "Updated deadlines usually show up in D2L within a day."
  - The tool result is `{"status":"completed","receiptId":"receipt:f4"}`.
  - The agent's "I've added the essay to your school tracker." cites that id and is delivered. `guardReplyClaims` has no save-claim pattern, so it doesn't catch it.
- **Effect for Sid:** Jarvis can say it added something to his school tracker when nothing was saved. This is the round-1 S1 bug again, now on paths that depend on the model's wording.
- **Fix:**
  - Treat "no signal" from an adapter that has `streamOwnerTool` as `not_saved`. Keep the regex only for adapters without `streamOwnerTool` (tests), or drop it.
  - Have every non-save path in the school and study adapters yield `toolOutcome: "not_saved"` explicitly.

### M2. Remember grounding only checks that the excerpt is a substring, so the stored fact can contradict Sid or be unrelated
- **Where:**
  - `agent:407-411` (`groundedExcerpt`: `userText.includes(excerpt)` only).
  - `agent:736`: `normalizedFromSource: true` is always passed.
  - `memory-owner-controls.ts:296-307`: with that flag, `isAuthorizedRememberText` skips every comparison between the fact and the excerpt.
- **Proven:**
  - `M1`: "remember I don't like math" is stored as `["Sid likes math", excerpt "like math", basis "stated"]`.
  - `M1b`: "ok" is stored as `["Sid's locker combination is 12-34-56", excerpt "ok", "stated"]`.
- **Effect for Sid:** A misread, hallucination or injected context note can plant a "Sid said so" memory that says the opposite of what he said. Later recall treats it as his own first-person statement (`origin: authenticated_first_person`).
- **Fix:** Keep the normalised fact, but check it in code:
  - The excerpt must lie on word boundaries and be at least one clause (for `stated`: at least 2 content words, or the whole message).
  - Negation parity: if the text around the excerpt holds a negator (`not`, `don't`, `never`, `n't`, `no`), the fact must hold one too.
  - The fact's content words must come from the excerpt, plus the confirmed question for `confirmed`, plus a small normalisation allowlist ("Sid", "favourite/fav", "is", "'s").
  - Run the real-model evaluator on the negation cases.

### M3. The 25 s turn cap does not fit inside the Worker's 30 s `waitUntil` budget (by reading, not proven)
- **Where:**
  - `agent:43` and `:448`.
  - `replyTo` runs under `ctx.waitUntil` (`index.ts:616`). Cloudflare cancels `waitUntil` work 30 s after the response.
  - Before the agent, the same budget covers: identity lookup, the user-event commit, and retrieval (base deadline 2,500 ms plus memory deadline 800 ms, `telegram-memory-retriever.ts:46-47`).
  - After the agent come staging and the Telegram send.
  - The cap is also not a hard bound. `refreshBrightspace` (`index.ts:217`) receives no abort signal, and D1 writes ignore it.
- **Effect for Sid:** When DeepSeek is slow, which is when the cap triggers, the run can be cancelled before the fallback reply is staged or sent. Sid gets silence, and a save that already committed gets no receipt: the round-1 S2 failure again.
- **Fix:**
  - Take the deadline from the webhook's arrival time. Use about 20 s for the agent and reserve at least 5 s for staging and sending.
  - Or move owner turns to a Queue consumer (15 min wall time).
  - Pass the signal into the Brightspace refresh.
  - Log the time elapsed at staging.

## Low

- **L1. The guard throws away the whole reply, including honest receipted claims.**
  - **Where:** `agent:519` runs `guardReplyClaims` on the full follow-up text. `school-catchup-model.ts:442-455` replaces the whole reply.
  - **Proven:** `G2`. After a real school save, the follow-up "I put in two study blocks for Thursday." (listed with `receipt:g2`) becomes `Saved your school plan…\n\nI can't confirm that action. Spending, sign-ups, uploads, submissions, and contacting people require your tap.`
  - **Effect for Sid:** A confusing contradiction right after a real save.
  - **Fix:** Remove only the offending sentence. For a sentence listed in `claimedActions` with a valid receipt id, skip the first-person-verb check only for internal verbs (put in / added / saved / scheduled). Never skip it for external verbs.
- **L2. The guard over-refuses drafts, practice questions and Sid's own reported actions. This matches main exactly and is not a regression.**
  - **Proven:** `G1`, 16 honest agent replies through the wired chain. The agent path replaces 6 (`[0..5]`), and `guardSchoolReply` (main's school path) replaces the same 6. The 6:
    - four drafts in Sid's voice ("I've emailed…", "I submitted…", "I applied to…", "I signed up…");
    - a maths practice question ("I paid $12…");
    - "Your application is submitted" acknowledging Sid's own report.
  - The other 10 pass unchanged: advice, offers, "I can't…", "you called", "told you", "haven't sent", and the secret advisory.
  - **Effect for Sid:** Drafts and study word problems come back as "I can't confirm that action." It's worse now that the agent is the one writing drafts.
  - **Fix:** Exempt quoted spans ("…", "…" and text after "draft:" or "sample:"). Treat "you said / since you / your … is submitted" after an owner report as a report.
- **L3. A reply can exceed Telegram's 4,096-character limit.**
  - **Where:** `agent:389-401` truncates by code points (`Array.from`). `TelegramRestProvider.sendMessage` rejects anything over 4,096 UTF-16 units as a permanent `output_limit` (`providers/telegram-provider.ts:89`). Round 1 used `.length`.
  - **Proven:** `G5`. An emoji-heavy reply is delivered at 4,916 UTF-16 units (4,096 code points). The fake Telegram provider doesn't enforce the limit; the real one fails.
  - **Effect for Sid:** Silence on long emoji-heavy replies, and a committed receipt is lost too.
  - **Fix:** Bound by UTF-16 `.length` without splitting a surrogate pair.
- **L4. "Confirmed" accepts any question, and swipe-reply targets aren't checked.**
  - **Where:** `agent:413-421` accepts any complete `?` sentence. `telegram-types.ts:128-135` treats a reply to any bot message as direct and drops the replied-to message id.
  - **Proven:**
    - `M4`: after "Hey Sid, what's up?", "Math" stores `["Sid's favourite subject is math","Math","confirmed"]`.
    - `A1`: a swipe-reply "yes" to an old Jarvis message (message_id 3, current 500) is `isMemoryControlAuthoritative: true` and carries no target id.
  - **Effect for Sid:** Code can't tell "yes" to an old "note that your chem lab is due Friday?" from "yes" to the latest question. The model doesn't see the swipe target either, so the answer is applied to the latest question.
  - **Fix:**
    - Carry `reply_to_message.message_id`. Treat the reply as direct for memory only when it equals the last delivered Jarvis message id. Otherwise pass the quoted text to the model as context and refuse `confirmed`.
    - Require the confirmed question to be an offer to remember or note something (or a question whose content words appear in the fact).
- **L5. Single forget / restore / explain grounding is trivially met.**
  - **Where:** `agent:407-411`, used at `:768`, `:781`, `:809`.
  - **Proven:** `F7`, round 1's B3 scenario with `supportingExcerpt: "hi"`. Sid says "hi", an injected context note asks for a forget, and the item is forgotten.
  - **Fix:** Require the excerpt to contain a control verb (forget / delete / remove / restore / bring back / why / explain) or equivalent, else use the Confirm button. The service could reuse main's control-phrase classifier as a floor.
- **L6. Remember dedupe matches only exact text.**
  - **Chosen rule:** before appending a new command (`memory-owner-controls.ts:494-506`, `memory-repository.ts:1098`), reuse any **currently active** item with byte-identical text, the same kind and the same sensitivity. There is no time window and no per-turn or update-id key.
  - **Legitimate repeats:** a later "remember X" while X is active returns "already active". The memory isn't lost, but the new excerpt and source aren't recorded, and a stated→confirmed upgrade is dropped. After a forget, a repeat correctly creates a new item.
  - **Proven gap:** `F5`. A resend where the model writes "Sid likes chemistry" then "Sid likes chemistry." stores 2 active duplicates. A different kind or sensitivity would also duplicate (by reading).
  - **Fix:** Compare with `normalizeRememberComparison` (case, punctuation, whitespace) and ignore kind. On a hit, append the new excerpt as an extra source.
- **L7. Guard deletions no named test catches.** The run used 6 suites, 234 tests, 42 mutations. Two tests are wall-clock flaky ("uses the whole-turn deadline…" at <1,000 ms, and "starts literal history before a 700 ms base lookup…"), so a kill that only those tests produced was rerun twice. Survivors (234/234 pass, or killed only by the flaky tests):
  - **Authority:**
    - R01, the memory `directOwnerText` gate in `executeCall` (`agent:608`). The durable recheck is the only backstop.
    - R05 and R06, the `index.ts:214/231/249/263` wiring. Setting it to `true` passes, and nothing tests `replyTo`'s authority values.
  - **Grounding:**
    - R09, the `includes` inside `groundedExcerpt`, for forget/restore/explain;
    - R11, the restore grounding call;
    - R13, R14 and R15, the `?` ending, sentence-boundary and uniqueness checks in `isQuestionSentence`;
    - R41, `stated` requiring `previousOfferExcerpt: null`.
  - **Receipt outcome:**
    - R18, conflicting `toolOutcome` accepted;
    - R39, study preference `not_saved` forced to `saved`;
    - R40, school fixed receipt unsignalled (the regex fallback hides it).
  - **Deadline:**
    - R21, the post-execute `deadlineHit` branch;
    - R22, "first-call error always deadline text";
    - R42, the compose suffix bound.
  - **Guard:** R26, `guardReplyClaims` removed from the **tool** path (only the stop path is tested).
  - **Dedupe and tap replay:**
    - R30, the dedupe `lifecycle_state = 'active'` filter (a forgotten memory would block a re-remember);
    - R31–R34, the `answerFromTap` replay checks for identity, principal, origin and option. R31 was killed once by the tap test and passed twice.
  - **Provider:** R37, the DeepSeek content validation beside `tool_calls`.
  - **Caught:** R02–R04, R07, R08, R10, R12, R16, R17, R19, R20, R23–R25, R27–R29, R35, R36.

## Checked and sound
- **Secret-request guard active on agent replies** (`G3` passes).
- **At most one honest line** when a listed and an unlisted false claim co-occur and repair fails (`G4` passes).
- **Sid's production phrases:**
  - "Remeber that my fav subject is math" stores `Sid's favourite subject is math` with excerpt `my fav subject is math`, basis `stated`, and the receipt shows (`M2` passes).
  - "Want me to note it?" → "Math", both plain and swipe-reply, stores it as `confirmed` with excerpt `Math` (`M3` passes).
- **Classification:** forwarded, `quote`, group, reply to a human, and `external_reply` messages are all non-authoritative for memory (`A2` passes). Edited messages are still rejected at classification (by reading). Multi-line direct private text and swipe-replies reach the pipelines (round-1 B1/B2 now pass).
- **Confirm forget:** a stale re-tap of Confirm after Sid restores one memory leaves it active and doesn't claim "Forgot" (`F6` passes). Already-forgotten items are skipped, and a failed tap gets a reply (builder tests, mutations R29/R35 killed).
- **Deadline:** when the deadline hits on the first agent call, Sid gets "Nothing changed." When it hits after a memory commit, he gets the receipt plus the fixed line (builder test).
- **Receipt ids:** structured `not_saved` for explicit refusals issues no receipt id (builder test; R16/R19 killed).
- **Empty arguments:** `""` is `{}` only for parameterless tools (R38 changes nothing observable in named tests, and the code is correct by reading).

## Unverified
- Real DeepSeek behaviour: how often it rewrites facts with negation, words facts differently on a resend, writes ordinary replies starting with "Updated" or "Saved", or answers with drafts. The evaluator was not run.
- Actual wall time of the pre-agent stages and Telegram send in production, and so how close M3 gets to the 30 s `waitUntil` cancel. No live timing.
- Whether any attacker-controlled text (D2L, email) reaches the agent context. It matters for M2 and L5.
- Whether a Confirm-forget decision containing an item in a state other than active or forgotten (for example superseded) loops forever on "Tap Confirm again". By reading, `prepareForgetItem` would refuse every retry.

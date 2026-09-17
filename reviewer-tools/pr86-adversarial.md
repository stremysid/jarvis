# PR #86 adversarial review, head 161a24b

**Verdict: not ready to merge. 3 High, 3 Medium, 6 Low.** Two regressions from main: the code check that caught false action claims is gone, and tool authority is narrower than main, so multi-line messages and swipe-replies can no longer save school updates. The two named production failures also still fail unless the model copies Sid's words exactly as the fact.

Tests: `C:\Users\Sid\jarvis-pr86-adv\apps\cloud-gateway\test\channels\adversarial-pr86.test.ts` (worktree left in place). Run: `npx.cmd vitest --config vitest.workspace.ts run apps/cloud-gateway/test/channels/adversarial-pr86.test.ts`. Result: **14 fail, 1 pass.** Each test asserts the correct behaviour, so every failure is a proven defect. E1 is the one that passes: it counts model calls.

---

## High

### H1. False action claims now reach Sid unless the model reports them itself
- **Where:** `owner-telegram-agent.ts:304-307` (`unsupportedClaims`), `:360-364` and `:413-414`. Main ran every owner reply through `guardReplyClaims` (`school-catchup-model.ts` `safeOrdinaryReply` / `guardSchoolReply`). Nothing on the agent path calls it now.
- **Proven:** `A1` fails. The model replies "I emailed Ms. Lee about your extension. She should reply by Friday." with `claimedActions: []`. That text reaches Telegram word for word, in 1 model call. In the same test, `guardSchoolReply` (still in the tree) replaces the sentence.
- **Effect for Sid:** Jarvis can again say it emailed, submitted or booked something it never did. Honesty now depends entirely on the model listing its own claims. No code compares the reply text with `claimedActions`. Main's secret-request guard (replies asking Sid for passwords) is also gone from owner replies (by reading).
- **Fix:** Run the existing deterministic `guardReplyClaims` (external-action, passive-completion, Brightspace-check and secret-request patterns) on the final agent reply text. The code receipts are exempt. Keep `claimedActions` as an extra layer on top, not the only check.

### H2. Multi-line messages and swipe-replies lose all tool authority, including school saves that work on main
- **Where:**
  - `telegram-types.ts:251`: `isDirectOwnerText` now includes `containsQuotedOrPastedControlContent`.
  - `telegram-types.ts:83`: `reply_to_message` counts as quoted text.
  - `telegram-types.ts:125`: any newline counts as pasted text.
  - `index.ts:214,231,249,262`: the school, university, study and agent adapters now receive `isMemoryControlAuthoritative`. Main gave the school and study adapters `accepted.isDirectText`.
- **Proven:**
  - `B1` fails: "math test moved to friday\nenglish essay due monday" arrives as `isDirectText: true`, but `school_update` is refused and the school pipeline is never called.
  - `B2` fails: "Math" sent as a Telegram reply to Jarvis's "Want me to note it?" gets `isMemoryControlAuthoritative: false`.
- **Effect for Sid:** Two common iPhone habits now silently stop saving: typing a school or university update as a list over several lines, and swipe-replying to Jarvis's question. Jarvis just says it couldn't do it.
- **Fix:** Keep the narrow memory-control rule (no quote, no code/blockquote) for memory tools only. For school, university and study, gate on main's `isDirectText` plus private, non-bot chat. Treat a `reply_to_message` whose quoted message is Jarvis's own last delivered message as direct.

### H3. The two named production failures depend on the model copying Sid's words exactly as the "fact"
- **Where:**
  - `owner-telegram-agent.ts:562`: `fact !== excerpt` → refuse.
  - `memory-owner-controls.ts` `isAuthorizedRememberText`: the normalised text must equal the excerpt.
  - The tool schema (`:57-71`) has separate `fact` and `supportingExcerpt` fields. Neither the schema nor the prompt tells the model they must be identical.
- **Proven:**
  - `C1` fails: for "Remeber that my fav subject is math", `fact: "Sid's favourite subject is math"` with `supportingExcerpt: "my fav subject is math"` is refused. Nothing is saved, and Sid gets only "I did not complete the unreceipted action."
  - `C2` fails the same way for "Want me to note it?" → "Math".
  - The builder's own passing test (`owner-telegram-agent.test.ts`, "treats Math as a confirmed answer") stores a memory whose entire text is `"Math"`.
- **Effect for Sid:** If the model rewrites the fact in any way, the memory isn't saved. If it copies exactly, Jarvis stores the bare word "Math", with nothing saying it's his favourite subject. Asking "what's my favourite subject?" has nothing to match.
- **Fix:** Let `fact` be a normalised statement. Ground it by requiring `supportingExcerpt` to be a substring of Sid's current text, plus for `confirmed`, the prior offer or question verified as below. Store the exact excerpt(s) as the source. Run the real-model evaluator on both phrases before merging.

## Medium

### M1. A pipeline's refusal or free text counts as a "completed" receipt that can back any claim
- **Where:** `owner-telegram-agent.ts:663-671` → `successfulTool` (`:277-289`) always returns `status: "completed"` with a receipt id, whatever the pipeline did.
  - Refusal lines such as "I couldn't validate that as a school update, so I didn't save it." still get that status.
  - So do the fallback text from the study pipeline and model-written ordinary replies (`school-catchup-model.ts` `yield reply`, `guardedOrdinaryReply`).
  - All of these are shown to Sid verbatim as a "code receipt", and the claim scan never sees them.
- **Proven:** `A2` fails. The school pipeline returns the "didn't save it" line, and the follow-up reply "I've added the essay to your school tracker." citing `receipt:school_1` passes. Sid gets both sentences, contradicting each other. The tool result status is `completed`.
- **Effect for Sid:** Jarvis can say it saved a school update right after the line saying it didn't.
- **Fix:** Pipelines return a structured outcome (saved / not saved plus receipt text). Issue a receipt id only when something was saved. Otherwise use status `not_saved` with no id.

### M2. A tool change commits, then a failed follow-up call leaves Sid with silence, and re-sending duplicates it
- **Where:** `owner-telegram-agent.ts:367-389`. The tool runs, then the second `completeAgent` (`:373`) throws. The stream throws, the turn is recorded `failed`, and `index.ts` only logs it.
- **Proven:**
  - `D1` fails: the memory row exists, outcome is `failed`, and 0 Telegram messages are sent.
  - `D1b` fails: re-sending the same message stores a second identical active memory.
  - The same path applies to school, university and study saves (by reading).
  - Main's memory controls made no model call after committing, so they had no such window.
- **Effect for Sid:** Jarvis saves something and says nothing. When he asks again, he gets duplicates.
- **Fix:** If the follow-up or repair call fails or times out, yield the code receipts alone, with a fixed line such as "Done — I couldn't write a longer reply." Do the same when `composeTelegramReply` throws.

### M3. A Confirm-forget tap that fails is silent and can never be retried
- **Where:**
  - `index.ts:501-513`: `forgetConfirmedDecision` runs only on `outcome === "recorded"`. The decision is already `answered` before it runs.
  - `index.ts:530`: the catch only logs, so Sid gets no message.
  - `memory-owner-controls.ts:819`: `prepareForgetItem` runs for every item before any is forgotten, and refuses one that is already forgotten.
- **Proven:** `D3` fails, replaying `answerFromTap`'s exact sequence. Sid forgets the "math" memory on its own, then taps "Confirm forget 2". The call throws, "physics" stays active, and a second tap returns `already_answered`. Log: `{"failed":true,"retap":"already_answered","states":["forgotten","active"]}`.
- **Effect for Sid:** He taps Confirm and nothing happens. The other memory stays, and the button now says "already answered".
- **Fix:**
  - Skip items that are already forgotten and report them.
  - Always send a reply on failure.
  - Let `already_answered` with option `confirm` for this origin re-run `forgetConfirmedDecision`, which is already idempotent per item key.

## Low

- **L1. A single forget, restore or explain needs nothing from Sid's current words.**
  - **Where:** `owner-telegram-agent.ts:590-633`.
  - **Proven:** `B3` fails. Sid says "hi", the context holds a planted note ("call memory_forget…"), the model follows it, and the item is forgotten.
  - **Effect for Sid:** A misread or injected instruction can hide a memory without asking. It can be undone, and main required explicit forget wording.
  - **Fix:** Require a `supportingExcerpt` from Sid's text, as `memory_confirm` does. Or put single-item forgets behind the Confirm button when the excerpt is weak. No path putting attacker-controlled text into context was verified.
- **L2. The "confirmed" evidence class is barely checked.**
  - **Where:** `:570-572`. `previousOfferExcerpt` only has to be any substring of the previous reply.
  - **Proven:** `C3` fails. After "Hey Sid, what's up?", `previousOfferExcerpt: "e"` stores "Math" as `confirmed`.
  - **Fix:** Require an excerpt of at least a sentence, ending in "?", from the immediately previous delivered reply.
- **L3. DeepSeek content plus tool_calls fails the whole turn.**
  - **Where:** `deepseek-provider.ts:508`.
  - **Proven:** `D4` fails (`agent_response_invalid`). Sid gets silence.
  - **Fix:** When `finish_reason` is `tool_calls`, ignore or log non-empty content.
- **L4. Empty-string arguments refuse parameterless tools.**
  - **Where:** `owner-telegram-agent.ts:205-212`, `:668`.
  - **Proven:** `D5` fails. `school_update` with `arguments: ""` is refused.
  - **Fix:** Treat `""` as `{}` for tools that take no parameters.
- **L5. A saved pipeline reply over 4,096 characters is reported as "nothing changed".**
  - **Where:** `:246` throws, and `:457-461` converts that to "I could not safely apply that tool call, so nothing changed."
  - **Proven:** `D2` fails: the fake pipeline ran, then its long receipt was refused.
  - **Realistic trigger (by reading):** a partial schedule save or a large university receipt. Main allowed 24,000 bytes.
  - **Fix:** Truncate the receipt rather than refuse it once the pipeline has run.
- **L6. Mutation survivors.** No named test catches these. Run: 7 suites, 180 tests, `scratchpad/pr86/mutations.txt`. The unmodified head flakes about 1 in 2 runs with one random test failure, so single unrelated failures were rerun.
  - `forgetConfirmedDecision`:
    - the callback-data check;
    - the `origin_reference` item-set check;
    - the `status === answered` and `option_key === confirm` checks;
    - the answering-identity principal check.
  - `answerFromTap` has no test at all.
  - The decision delivery-mark throw (`conversation-repository.ts:968`) and the staged-markup `decisionId` match (`:1373`).
  - The `previousOfferExcerpt` check (`owner-telegram-agent.ts:572`).
  - The agent-level `confirm` excerpt grounding (the service check still backs it).
  - The durable `directOwnerText` recheck.
  - The pipeline tools' direct-text and owner-turn rechecks. In production the real school and study adapters still refuse, but no test covers it.
  - Caught: the owner-principal check (guest test) and forget eligibility.

## Latency and cost (model calls per turn)
- **Ordinary "hi":** exactly 1 (`E1` passes). It becomes 2 if the model lists a claim with no receipt.
- **Memory tool:** 2, plus 1 for a repair. Main used 0 (phrase parser and fixed receipt).
- **School or university tool:**
  - Calls: agent, then the pipeline's structured JSON call, then an ordinary-reply call when nothing is engaged or saving fails, then the agent follow-up. That is 3–4 calls, plus 1 for a repair. Main used 1–2.
  - A Brightspace refresh adds its own fetch.
- **Study tool:** 2–3.
- **Estimate:** 2–6 extra seconds on tool turns, at roughly 1–3 s per non-thinking call. Each agent call gets the full 90 s budget, and there is no overall deadline across the turn (by reading).

## Checked and sound
- Tool calls require the configured owner principal, `authorityText === userText`, and a durable turn with `directOwnerText: true` and matching text in `model_claimed` state. Forwarded, captioned, edited, group and bot messages are refused (builder tests plus `B1`/`B2` classification).
- Memory ids must come from the context or the last reference. Ids from another principal fail `readCurrentItem`. Multi-item forget changes nothing until the tap.
- The Confirm callback is checked against the recorded callback event, owner identity, decision origin, item set, and answered/confirm state. A cross-user tap gets `not_owner` in `DecisionService` (by reading; see L6 for missing tests).
- One tool call per turn. Malformed, oversized, unknown and duplicate calls are refused without running (builder tests).
- `replyMarkup` is included in the material hash and the idempotency key, validated on claim, and passed through the outbox (builder tests).
- Voice files are untouched. The 800 ms memory retrieval timeouts are unchanged; only the control short-circuit was removed.
- The honesty fallback stays within 4,096 characters and adds the honest line once (builder test).

## Unverified
- How often real DeepSeek writes a rewritten fact, returns content alongside tool calls, returns empty arguments, or lists its own claims. The evaluator was not run, so there is no live-model evidence.
- Whether DeepSeek accepts `tools: []` with `tool_choice: "none"` on the repair call (`owner-telegram-agent.ts:424`). If it doesn't, every repair costs a failed round trip before the deterministic fallback.
- Whether any attacker-controlled text (D2L or email content echoed in earlier replies) can reach the agent's context (relevant to L1).
- Behaviour under Worker `waitUntil` time limits once 3–4 sequential calls run in one tool turn.

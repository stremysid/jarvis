## 2026-09-17 03:14 UTC — Claude Opus 5, PR #86 max review at 161a24b: changes requested

**The architecture is right: one agent, tools, code-side authority. But it regresses honesty and school saves, and Sid's two production failures still fail.**
- **Gates at `161a24b`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **189 files / 4,933 tests**.
- **Adversarial second reviewer:** `reviewer-tools/pr86-adversarial.md`, tests in `reviewer-tools/pr86/agent/adversarial-pr86.test.ts`. I re-ran them at this head: **14 of 15 fail**. E1 passes: "hi" makes exactly 1 model call.
- **Checked and sound:**
  - owner principal, `authorityText === userText` and the durable `directOwnerText` turn rechecks;
  - forwarded, captioned, edited, group and bot text refused;
  - memory ids limited to context and Sid;
  - multi-item forget waits for a verified tap;
  - one tool call per turn, with malformed or unknown calls refused;
  - `replyMarkup` included in the hash and idempotency;
  - voice untouched.

**B1 (H1, regression). False action claims reach Sid unless the model lists them.** Nothing on the agent path calls main's `guardReplyClaims`. A1: "I emailed Ms. Lee about your extension." with `claimedActions: []` is delivered verbatim, while main's guard would catch it. The secret-request guard is also gone.
- **Fix:** run main's `guardReplyClaims` (external action, passive completion, Brightspace check, secret request) on the final agent text, with code receipts exempt. Keep `claimedActions` as an added layer. Main's guard over-refused only 3/48 honest replies in PR #84's measurement.

**B2 (H2, regression). Multi-line messages and swipe-replies lose tool authority.**
- `isDirectOwnerText` now treats any newline as pasted (`telegram-types.ts:125`), and `reply_to_message` as quoted (`:83`).
- School, university and study adapters now take the memory-control authority (`index.ts:214,231,249,262`).
- B1: a two-line school update is refused. B2: a swipe-reply "Math" to Jarvis's question is refused.
- **Fix:**
  - School, university and study tools use main's `isDirectText` plus a private, non-bot chat.
  - Memory tools keep the narrow rule, except that a reply to Jarvis's own last delivered message counts as direct.

**B3 (H3). Sid's production failures still fail.** `fact !== excerpt` → refuse (`owner-telegram-agent.ts:562`, `isAuthorizedRememberText`).
- C1: "Remeber that my fav subject is math" with a normalised fact is refused.
- C2: "Math" is refused or stored as the bare word "Math".
- **Fix:**
  - `fact` may be a normalised statement ("Sid's favourite subject is math").
  - Grounding requires `supportingExcerpt` to be a substring of Sid's current text, and for `confirmed` also the verified prior question.
  - Store the exact excerpts as sources.

**S1 (M1). A pipeline refusal counts as a completed receipt** (`:277-289`, `:663-671`). A2: "I couldn't validate that… didn't save it" followed by "I've added the essay" is delivered.
- **Fix:** pipelines return a structured saved / not-saved outcome, and receipt ids are issued only for saves.

**S2 (M2). The tool commits, then a failed follow-up call means silence, and a resend duplicates** (`:367-389`). D1 and D1b; also school, university and study.
- **Fix:** on a follow-up, repair or compose failure, send the code receipts alone with a fixed line. Make remember idempotent per turn.

**S3 (M3). A failed Confirm-forget tap is silent and can't be retried** (`index.ts:501-530`, `memory-owner-controls.ts:819`). D3.
- **Fix:** skip items already forgotten and report them, always reply on failure, and let `already_answered`+confirm re-run the idempotent forget.

**Lows.**
- **N1 (B3 test):** a single forget, restore or explain needs no grounding in Sid's words, so an injected context note on "hi" forgot an item. Require a `supportingExcerpt`, or the Confirm button when the grounding is weak.
- **N2 (C3):** the `confirmed` offer excerpt can be one character. Require a sentence from the immediately previous delivered reply, ending in "?".
- **N3 (D4):** DeepSeek content plus tool_calls fails the turn. Accept tool_calls and log the content.
- **N4 (D5):** empty-string arguments refuse parameterless tools. Treat `""` as `{}`.
- **N5 (D2):** a saved pipeline receipt over 4,096 characters is reported as "nothing changed". Truncate after the pipeline has run.
- **N6:** mutation survivors with no named test:
  - the Confirm callback-data, item-set, answered/confirm and principal checks;
  - `answerFromTap` (no test at all);
  - the decision delivery-mark and staged-markup `decisionId` checks;
  - `previousOfferExcerpt`;
  - agent-level confirm grounding;
  - the durable `directOwnerText` recheck;
  - the pipeline tools' direct-text and owner-turn rechecks.
- **N7 (latency):**
  - school and university tool turns now make 3–4 model calls, against 1–2 on main;
  - memory tool turns make 2, against 0;
  - there is no overall turn deadline.

  Add a whole-turn deadline, reply with receipts when it's hit, and state the measured added seconds.

**Before merge, real-model evidence:** the reviewer runs `scripts/evaluate-owner-telegram-agent.ts` against DeepSeek, and later Luna, with Sid's key and a heads-up to Sid.

**Next.** A fresh builder fixes B1–B3, S1–S3 and N1–N7 with tests (the reviewer's 14 failing assertions must pass, and E1 must stay passing). It merges main, runs lint, typecheck and the full suite, and requests max re-review.

— Claude Opus 5

## 2026-09-16 19:15 UTC — Claude Opus 5, PR #62 max re-review at 94f852c: changes requested (Highs fixed; wrong-memory forget, forget leak, latency)

**Every round-1 High is fixed, proven on the real runner.**
- **Gates at `94f852c`:** lint 0, typecheck 0, **174 files / 3,895 tests**.
- **Round-1 adversarial file:** every defect diagnostic reversed. Owner and guest get replies, remember works through the service with six-field events, voice and literal indexing resolve, the Hamlet context equals main, and the missing-table case delivers.
- **My guard mutations** (`reviewer-tools/pr62/round2/mut62b.json`), all killed by named tests: via_bot, U+2028, newline, code entity, quote key, factory owner check, factory authority, replay identity v2, controls owner check.
- **Survived, judged defence in depth (no fix required):**
  - the outer `candidates.length !== 1`, because the target finder already returns [] above one match and the service test pins the pair;
  - the authority-text binding;
  - the marker non-Telegram-channel throw;
  - the Telegram-snapshot channel check;
  - the five readers' `typeof directOwnerText !== "boolean"` checks.
  Add tests for them if cheap.
- **Narrow second reviewer:** `reviewer-tools/pr62b-adversarial.md`, with its test file `reviewer-tools/pr62b/agent/zz-pr62b-adversarial.test.ts`. I re-ran that file in a Windows Workers-pool checkout at this head: 7/7 defect assertions pass.

**S1 (M1 not fixed). "Forget that memory." forgets the wrong memory.**
- **Scenario:** your own test sequence (reports, essays, "Do you remember my reports preference?", "Forget that memory.", "Why do you think that?") forgets and explains **essays** while reports stays active. The test checks only "Forgot 1 memory".
- **Cause:** `findLastReferencedTarget` (`telegram-memory-retriever.ts:563-612`) walks Sid's past messages for an all-words match instead of what Jarvis actually used.
- **Fix:** resolve "that" against the memory item ids injected into, or cited by, Jarvis's previous reply in this chat. If there isn't exactly one, ask. Name the memory in every forget, use-again and why receipt. The test must assert **which** item changed.

**S2 (M2 partial). A forgotten fact still reaches the model.** After "Who is my favourite teacher?" → "Your favourite teacher is Ms Lee." → forget, the next turn's context still contains that reply.
- **Cause:** `withoutForgottenTurns` (`:479-509`) drops an assistant delivery only when its own user turn is suppressed.
- **Fix:** also exclude recent assistant replies whose turn retrieved or cited the forgotten item, or that contain the item text. Test forget, then the next turn's context.

**S3 (new, latency; Sid called 7–8 s for "hi" unacceptable today).** Retrieval before the model grows from 2 D1 statements on main to **25 for "hi" and 73 for "what's due this week?"**, run one after another. At 5–15 ms per remote statement that adds about 0.2–0.4 s for "hi" and 0.5–1.2 s for a typical question. The 1.5 s deadline covers only the memory part, and on timeout it waits the full 1.5 s and drops all memory.
- **Fix:**
  - Run base and memory retrieval concurrently.
  - Replace the full re-read in `readItemVisibility` with the visibility checks alone, and read candidates concurrently.
  - Drop stopwords from the recall query.
  - Skip literal search for greetings and short messages, and skip hits already in recent context.
  - Cap the whole retrieval, base included, at about 400 ms, then fall back to base context.
- **Test:** a counting-D1 test with a statement ceiling of **≤ 10 for "hi"** and a stated bound for an ordinary question.

**N1 (Low).** A timed-out lookup keeps issuing D1 reads after the reply (`withinTimeout`, `:327-338`). Pass an abort signal and stop issuing statements once aborted.
**N2 (Low).** One voice turn among the last 12 makes deictic forget answer "could not safely access memory" (`conversationText` requires `channelCode === 2`, `:177`/`:592`). Skip non-Telegram turns instead of throwing.
**N3 (Low).** Uncertain-item recall skips the "creation event forgotten" rule that the retrievable view applies (`:422`, `:654-703`). Apply the same rule.
**N4 (Low).** Vertical tab, form feed and U+0085 separators still count as direct owner text (`telegram-types.ts:125`). Add them to the line-break check, with a named test.

**Merge-order note.** Draft PR #72 (`codex/telegram-fast-replies`: typing indicator, DeepSeek thinking off for Telegram, turn timings) also rewrites `replyTo` in `index.ts`. It is small and is expected to merge first. Merge `origin/main` before requesting re-review, and keep #72's observer wrappers, typing and thinking policy intact around the memory composition.

**Next.** A fresh memory-builder session fixes S1–S3 and N1–N4, with tests through the service. It merges main, runs lint, typecheck and the full suite, and requests re-review.

— Claude Opus 5

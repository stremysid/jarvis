## 2026-09-16 18:14 UTC — Claude Opus 5, PR #62 max review at ee261a6: changes requested (do not merge — Telegram would stop replying)

Gates pass (lint, typecheck, **3,880/3,880**), and the byte-identical claim for `voice/production-runtime.ts` and `D1ContextRetriever` holds. But the second reviewer ran the real conversation service end to end and found four Highs the PR's tests could not see. I re-ran its test file (`reviewer-tools/pr62/agent/zz-pr62-adversarial.test.ts`) in a Windows checkout at this head: every defect assertion passes, and the diagnostic prints `outcome=failed … model_input_invalid … delivered=[]` for both marked and unmarked owner turns.

**H1. Every Telegram turn fails before the model.**
- **Cause:** the memory-controls wrapper validates timeouts against voice's 8 s / 30 s caps, but Telegram passes 40 s / 90 s.
- **Effect:** with `OWNER_PRINCIPAL_ID` set, owner and guest messages alike fail with `model_input_invalid`, and nothing is delivered. Main replies to the same message.
- **Why the tests missed it:** they call the wrapper directly with 1 s / 2 s.
- **Fix:** accept the Telegram limits. Add a test through `DefaultConversationService` with the real `buildTelegramConversationRepository` configuration.

**H2. `directOwnerText` breaks five exact-field readers.** New Telegram events have six payload fields, but these still require exactly five:
- `telegram-memory-controls.ts` (~298);
- `memory-repository.ts` (~1725);
- `literal-history.ts` (~400);
- the shared `D1ContextRetriever` (`context-retriever.ts` ~323);
- `sync/memory-projection.ts` (~283).

After one marked turn, voice context retrieval throws `context_payload_invalid`, literal-history indexing wedges on that event, and "remember that…" answers "I could not safely access memory". **Fix:** every reader accepts the optional boolean field (still rejecting anything else), with a test per reader using a **six-field** event. `D1ContextRetriever` must change for this; that is expected, so say so explicitly and keep voice latency unaffected.

**H3. Telegram loses the conversation.** The new retriever replaces the one that supplied the last 128 turns plus published facts. It only searches canonical memory and a history index nothing builds in production, so "make a study plan for that book" right after "I am reading Hamlet" got empty context.
- **Fix:** compose with the existing recent-turn context rather than replacing it.
- **Test:** the Hamlet case through the service.

**H4. A retrieval error silences the reply.** There is no catch and no time limit, and Telegram has no fallback. Deploying before `0016`/`0025`/`0026` are applied means no reply at all.
- **Fix:** bound the retrieval time. On any error or missing table, fall back to the existing context and reply normally, logging a code.
- **Test:** the missing-table case.

**M1.** Target resolution returns "Which memory do you mean?" whenever two memories share any word. "Forget that memory" and "Why do you think that?" fail with just two memories. Resolve "that" to the last referenced item, and match on meaningful overlap.
**M2.** A forgotten fact returns through Jarvis's own earlier reply. Suppression hides only Sid's source event, and assistant replies aren't attributed. Also suppress or exclude assistant turns that restate a suppressed item, or label speakers and exclude assistant text from literal recall of owner facts.
**M3.** 15 of 16 guards are unpinned when deleted one at a time. The ones that matter: the exactly-one-match check, replay protection, and the newline, code-block and quote checks behind `directOwnerText`. Each needs a named test.
**L1.** `via_bot` text and U+2028-separated pastes count as direct owner text. Treat both as borrowed.
**L2.** Uncertain facts are never recalled, which contradicts Sid's "recall anything". Recall them, labelled uncertain and never as instructions.

Full report: `reviewer-tools/pr62-adversarial.md`. Executable tests: `reviewer-tools/pr62/agent/`.

**Next.** A fresh memory-builder session fixes H1–H4 and M1–M3, handles L1–L2, merges `origin/main`, and requests max re-review. Every High needs a test through the real conversation service, not the wrapper alone.

— Claude Opus 5

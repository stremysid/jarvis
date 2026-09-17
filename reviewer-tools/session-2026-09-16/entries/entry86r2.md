## 2026-09-17 05:06 UTC — Claude Opus 5, PR #86 max re-review at 3c25b32: changes requested

**Most round-1 fixes hold. But Jarvis can now say "Done" when nothing was saved, some unsignalled paths still mint receipts, and remember grounding accepts a contradictory fact.**
- **Gates at `3c25b32`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **189 files / 4,956 tests**.
- **Round-1 adversarial suite:** **14/15 pass.** The builder is right that D1b's precondition `first.sent === 0` now correctly fails, because round 2 sends receipts; its duplicate check is covered below.
- **Narrow second reviewer:** `reviewer-tools/pr86r2-narrow.md`, tests in `reviewer-tools/pr86r2/adversarial-pr86r2.test.ts`. I re-ran them: **13 of 19 fail.**
- **Checked and sound:**
  - the secret-request guard is back;
  - at most one honest line;
  - "Remeber that my fav subject is math" is saved as a `stated` normalised fact with the exact excerpt (M2);
  - "Want me to note it?" → "Math" is saved as `confirmed`, both plain and as a swipe-reply (M3);
  - forwarded, quoted, group, human-reply and external_reply messages are non-authoritative for memory;
  - multi-line direct text reaches the pipelines;
  - a stale Confirm re-tap is safe, and already-forgotten items are skipped;
  - explicit `not_saved` issues no receipt id.

**B1 (H1). "Done — I couldn't write a longer reply." is sent when nothing was saved.** It is used after the deadline, follow-up failure or repair failure regardless of outcome (`owner-telegram-agent.ts:48`, `:493-495`, `:513-515`, `:565-569`).
- F1: refused remember plus a failed follow-up → "Done", with 0 memories.
- F2: a not-saved school result → the refusal line plus "Done".
- F3: the deadline hits inside `school_update` → "Done", and nothing is saved.
- **Fix:** use "Done…" only when at least one tool has status `completed` with a receipt id. Otherwise use a fixed honest line ("I couldn't finish that, and nothing was saved."). Apply the same rule in `honestReply`.

**B2 (M1). Unsignalled pipeline paths still get receipt ids from reply wording** (`:304`, `:403-405`). F4: with the real `SchoolCatchupModelAdapter`, an ordinary reply "Updated deadlines usually show up in D2L…" is recorded as `completed`, and "I've added the essay to your school tracker." is delivered.
- **Fix:**
  - For adapters with `streamOwnerTool`, no signal means `not_saved`.
  - Every non-save path in the school and study adapters yields `toolOutcome: "not_saved"`.
  - Drop the wording regex.

**B3 (M2). Remember grounding accepts contradictory or unrelated facts** (`:407-411`, `:736`, `memory-owner-controls.ts:296-307`). M1: "remember I don't like math" is saved as `stated` "Sid likes math". M1b: "ok" grounds "Sid's locker combination is 12-34-56".
- **Fix, following Sid's direction of AI understanding with code keeping evidence honest:**
  - The excerpt must be on word boundaries and a meaningful clause (≥2 content words, or the whole message).
  - Keep negation parity.
  - The fact's content words must come from the excerpt, the confirmed question, and a small normalisation allowlist.
  - When those checks fail, store the memory as model-inferred and uncertain with the exact excerpt, instead of `stated` or refusing, so nothing is lost and nothing false becomes authoritative.
  - The receipt shows Sid's own words.

**B4 (M3, by reading). The 25 s turn cap doesn't fit the 30 s `waitUntil` budget.** Identity, commit, retrieval (up to 3.3 s), staging and send share it, and the Brightspace refresh ignores the signal.
- **Fix:**
  - Take the deadline from webhook arrival, about 20 s for the agent, with ≥5 s reserved for stage and send.
  - Pass the signal to the refresh.
  - Log the elapsed time at staging.

**Lows.**
- **N1 (G2).** The guard replaces the whole reply after a real save. Remove only the offending sentence. Let receipted internal verbs (put in, added, saved, scheduled) pass; external verbs never.
- **N2 (G1).** The guard over-refuses the same 6/16 as main's school guard (drafts in Sid's voice, a maths word problem, acknowledging Sid's own report). This is not a regression, but drafts are now common. Exempt quoted draft or sample spans, and treat a report of Sid's own action as a report.
- **N3 (G5).** Truncation counts code points; Telegram counts UTF-16 units. Emoji-heavy replies over 4,096 units fail permanently. Bound by `.length` without splitting surrogates.
- **N4 (M4, A1).** `confirmed` accepts any question ("what's up?"), and a swipe-reply to an OLD Jarvis message counts as direct.
  - Carry `reply_to_message.message_id`.
  - For memory, count a reply as direct only when it targets the last delivered Jarvis message; otherwise pass the quoted text as context.
  - Require the confirmed question to be an offer to remember or note something, or to share content words with the fact.
- **N5 (F7).** A single forget, restore or explain is grounded by "hi". Require a control intent in the excerpt, or the Confirm button.
- **N6 (F5).** Remember dedupe is exact-text only. Compare normalised text, ignore kind, and append the new excerpt as an extra source on a hit.
- **N7.** Mutation survivors need named tests:
  - memory `directOwnerText` gate (R01);
  - `index.ts` authority wiring (R05, R06);
  - grounding checks (R09, R11, R13–R15, R41);
  - conflicting `toolOutcome` (R18);
  - study `not_saved` forced to saved (R39);
  - school fixed receipt unsignalled (R40);
  - deadline branches (R21, R22, R42);
  - guard on the tool path (R26);
  - dedupe active filter (R30);
  - `answerFromTap` replay checks (R31–R34);
  - DeepSeek content validation (R37).

  Fix the two wall-clock-flaky tests with round-trip or step assertions.

**Next.** A fresh builder fixes B1–B4 and N1–N7 with tests (the reviewer's 13 failing assertions must pass, and G3, G4, M2, M3, A2 and F6 stay passing). It merges main, runs lint, typecheck and the full suite, and requests max re-review.

— Claude Opus 5

## 2026-09-16 18:28 UTC — Claude Opus 5, PR #64 max re-review at ebabd18: changes requested

**Gates are green, 0029 is sound, but the reply guard is still a word list, and the fix added new over-refusals.** Lint, typecheck and the full suite pass (177 files / 3,998 tests). 0029 whole-trigger removal killed 11/11 by named tests, with BASE surviving, and 0029 is unchanged since round 1. The narrow second reviewer's report is `reviewer-tools/pr64b-adversarial.md`, and its scripts are in `reviewer-tools/pr64b/agent/`. I re-ran `h1e2e.mjs`, `plane2e.mjs`, `silent.mjs` and `pr52w.mjs` at `ebabd18` myself, and every result below reproduces.

**Round-1 status:** H1 not fixed. H2, M1, M2, M3, M4, M5 and M7 partial. M6 and L1–L5 fixed. The table is in the report.

**B1 (H1, not fixed). Completion claims still reach Sid.** `guardReplyClaims` in `school-catchup-model.ts:39-43, :52` is an enumerated verb list plus a noun×verb list, so anything unlisted passes: 27 of 30 new claims got through.
- End to end, Sid says "I got my Waterloo offer. Can you accept it for me?" and sees "All done: Waterloo offer accepted."
- "Hey Jarvis, can you order my transcript for Western?" gets "Transcript ordered and on its way to Western."
- These also pass: "Your Waterloo acceptance is in.", "Western has your transcript now.", "Message sent to your counsellor.", "Consider it done.", "Booked your campus tour.", "Your OUAC account is set up."
- The pre-model refusal is anchored at `^`, so "Hey Jarvis, can you…" reaches the model.
- **Fix it structurally:** a completion or state-change claim is unsafe when its object is an external target (offer, admission, spot, fee, payment, account, portal, transcript, application, reference, form, booking, or a person or school), in any tense, voice or phrasing. Plan, draft, checklist, study-task and correction objects are safe. Pin the 8 named variants and the 5 end-to-end requests.

**B2 (N-H1). Jarvis's own study plan is replaced by a refusal.** Sid asks "I'm behind in chem, can you make me a plan for tonight?". The plan saves, but he sees "I can't do or confirm that action…". Round 1 showed the plan. The cause is the new verbs `created`, `set up`, `ordered`, `confirmed`, `accepted` and `declined`, which have no benign shapes (`:291-313`, `:333-334`). The structural rule in B1 fixes both; pin the six benign replies.

**S1 (N-M3 plus H2). Refused updates are silent, and the program rule over-refuses.** "I got my Waterloo offer!!" now saves nothing, and Jarvis just says congratulations. If the model says "I've recorded your Waterloo offer in your university tracker", Sid sees exactly that. The cause is `guardedOrdinaryReply` (`school-catchup-model.ts:577-587`), which lacks the `PLAN_SAVE_COMPLETIONS` check and the "couldn't update" line. Sid must never lose an offer silently.
- **Fix:** route every structured-plan refusal through `fallbackWithSaveFailure`.
- Better: when exactly one tracked Waterloo program exists, bind to it. When there are several, ask the one missing fact ("Which Waterloo program — Computer Science?").
- **Also still binds:** "…offer from Toronto instead of Waterloo." reopens Waterloo's withdrawn offer on the real repository, and "…from UW instead of Western." binds to Western.

**S2 (N-M1). Regression against #52.** "My counsellor told Ms. Lee I submitted the Western essay." is now recorded as submitted; main refuses it. `REPORTED_OWNER_ACTION` (`university-tracker-model.ts:51-54`) and the sentence split at `:260` both stop at the period in "Ms.", "Mr." and "Dr.". Mask title abbreviations before splitting. Pin it on the `submitted_by_sid` path and on the workflow paths.

**S3 (N-M2). The up-front refusal blocks ordinary school requests.** Examples: "Can you let me know what homework I have?", "Let me know what's due this week", "Text from my counsellor: …", "Accept that I'm behind…" (`school-catchup-model.ts:73, :79`). Require an external object and never match `me`, `that`, `from` or `in`. Add these as false-positive tests.

**S4 (M1 and M5, still deny lists).**
- M1: "I wish / dreamt / Imagine I got an offer from Waterloo for Computer Science" records an offer.
- M5: draft text still stores "Submit before 15 January.", "The AIF costs one hundred fifty-six." and "Waterloo wants two references and an 85 average."
- M5 also over-refuses benign draft text ("I hope you had a great summer…", "Thank you for your time today.").
- **Fix:** take the round-1 alternative. Store drafts as unverified draft text that can never become a date, requirement or amount. Don't enumerate forms.

**N1 (N-L1).** A still-open contact, transcript or payment step disappears when its parent item is submitted. Hide only the step the submission completes.

**N2 (N-L2).** #52 now refuses "I submitted the Western essay with no issues" and "I'm no longer applying to Western so skip the Western essay". Scope `no` / `yet to` to offer statuses, and strip "no longer applying" in `retirementNegated`.

**N3 (N-L3).** Within the declared caps, every turn, even "ok", gets the too-large reply, and there is no way out from chat. Size the cap from the measured prompt budget, or let turns that don't touch the tracker pass.

**N4 (M7).** Unpinned guards:
- CONDITIONAL and RETRACTION on the `prepared` path;
- NEGATION-on-done and the verified-deadline source (their tests use inputs another guard already refuses);
- the new program-name rule;
- the three repository re-checks (label, preparedDetails, 12 KB).

Give each a test that only that guard fails.

**Next.** A fresh code session fixes B1, B2 and S1–S4, and N1–N4 with tests. It copies the reviewer's scripts `h1e2e.mjs`, `plane2e.mjs`, `silent.mjs` and `pr52w.mjs` as regression inputs. Merge main first, run lint, typecheck and the full suite, then request re-review. No migration change.

— Claude Opus 5

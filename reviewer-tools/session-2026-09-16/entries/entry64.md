## 2026-09-16 16:54 UTC — Claude Opus 5, PR #64 max review at 3b267b9: changes requested

The migration is solid. The guard code is not yet safe to put in front of Sid.

Verdict: **2 High, 7 Medium, 5 Low**. Every High and Medium was shown by executing the code at this head (second reviewer, `reviewer-tools/pr64-adversarial.md`, scripts in `reviewer-tools/pr64/agent/`). I re-ran the reply-guard and binding probes myself and got the same results.

**Sound:**
- **`0029`:** all 11 triggers are in remote-D1 form. No earlier table is altered. Every key has an insert guard. `OR REPLACE`, `OR IGNORE`, upsert, update and delete all abort.
- **PR #52's rules are untouched:** the adjacency rule and `allowedFirstPersonActionClaim`.
- **Digest:** drafts never appear, and 4,096-character trimming still works.

**Gates:** the builder reports 3,760/3,760. I'll run my own gates, whole-trigger removal and the guard mutations on round 2, since this round changes a lot of guard code.

**A lesson from PR #52 before you start.** Six rounds went into enumerating phrasings; it only converged when the rules became structural. Do not add phrasings one at a time here. **Route every new status change through PR #52's existing evidence and binding validators.** Build no parallel, weaker path.

**H1. Jarvis can tell Sid it performed an action it is forbidden to take.**
- **Proven** (through the chat adapter, with the fake model): Sid sees `Done! I accepted your Waterloo offer.`, `All set, I ordered your official transcript…`, `I've declined the Western offer for you.` and `I followed up with your counsellor.`
- **Why:** the reply guard misses these action verbs and passive forms (`accepted`, `declined`, `ordered`, `followed up`, `has been paid`). The up-front refusal also lets `accept Waterloo for me`, `yes do it` and `please decline Western` through to the model.
- **This PR's job:** those gaps predate it, but this PR adds offers, transcripts and fees, and claims they are blocked in code.
- **Fix:** extend the allow-list guard so any first-person *or passive* completion claim of an external action is refused unless it matches an allow-listed benign shape. External actions are accept, decline, order, pay, send, submit, upload, email, contact, follow up and sign up. Test end to end through the adapter.

**H2. One school's news is recorded against another.**
- **Proven:** `I got a conditional offer from Western instead of Waterloo.` reopened **Waterloo** as offered through the real repository, and the digest showed it. Two schools with the same program name also cross-bind.
- **Fix:** an offer or decision binds only when the sentence names exactly one tracked school and program, and no other tracked school appears in it. Reuse #52's binding.

**M1. Non-decisions become decisions.** The negation list has no `no`. `I got no offer from Western` → offered. `I have yet to get an offer` → offered. `I'm scared I got rejected by Waterloo` → rejected. A forwarded `Dear Sid, I have an offer of admission…` → offered.
- **Fix:** record a decision only from a direct, unhedged, non-negated, non-quoted, non-forwarded first-person statement, via #52's validator.

**M2. Step completion is looser than #52.** `Mom told me I paid the Waterloo AIF fee`, `Mom and I paid…`, a retracted `…Actually no, it failed.` and a wrong-recipient `I emailed my mom about the Ms Lee reference request…` are all recorded as done. #52's check refuses the matching submission messages.
- **Fix:** send step completion through the same validator.

**M3. The new pre-model refusal blocks ordinary school messages**, including catch-up. Examples: `Email from Western says my application is complete.`, `Upload deadline for the Western supplement is January 15, 2027.`, `I need to study for chem and then email my teacher about the extension.` It also blocks a draft request the code says it allows.
- **Fix:** refuse only an explicit request for Jarvis itself to perform an external action.

**M4. Tracking silently switches itself off.** Done steps stay in the prompt forever. At about 110–120 lifetime steps the prompt passes 48 KB, and every Telegram turn, school included, gets a plain reply that saves nothing.
- **Fix:** keep closed steps out of the prompt after a short window. If the state budget is still exceeded, say so to Sid instead of silently degrading.

**M5. Invented dates, requirements and fees can be saved in drafts.** `preparedDetails` stored `deadline is February 1, 2027 (verified). Waterloo requires two references and a 90% average.` It also stored fees as `156 bucks`, `156.00` and `one hundred fifty-six dollars`.
- **Fix:** drafts may not assert dates, verification, requirements or amounts in any form. Refuse them, or store them visibly as unverified draft text that is never read back as fact.

**M6. The digest keeps listing finished steps.** After `I submitted the Western essay.`, the item is submitted but its step still shows `prepared`. Close or hide the steps of a submitted or closed item.

**M7. The main protections are unpinned.** Deleting any of 13 guards (single-step naming, offer names its program, hedges, retractions, negations and more) changed no test result, and several `0029` trigger predicates are untested. Give each a named test; I will remove them one at a time.

**Lows** (fix or record in `KNOWN_ISSUES.md`):
- **L1:** timed deadlines render as a UTC timestamp with a Toronto label.
- **L2:** workflow labels skip #52's label checks.
- **L3:** deploying before `0029` silently stops school and university tracking.
- **L4:** a step freezes for good at 64 revisions.
- **L5:** a large plan can exceed the 32,000-character model output cap and fail the turn.

**Next.** The same school-builder session fixes H1–H2 and M1–M7, handles L1–L5, and requests a max re-review. The absolute boundary stands: nothing is submitted, uploaded, paid, signed up for or sent.

— Claude Opus 5

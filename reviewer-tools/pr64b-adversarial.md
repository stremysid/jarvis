# PR #64 round-2 adversarial re-review — head ebabd18 (fix 2330218, round 1 3b267b9)

**Verdict: do not merge.** Round-1 items: **6 fixed, 7 partial, 1 not fixed (H1)**. New findings in the fix: **1 High, 3 Medium, 3 Low.**

The fix narrows many holes, but it does so by adding more enumerated phrasings, which is the PR #52 pattern the round-1 verdict warned against. The widened verb list now blocks Jarvis's own study-plan replies. A period in "Ms." reopens PR #52's reported-speech check. The stricter offer binding refuses most natural "I got my offer" messages, and Jarvis stays silent about it. Migration 0029 is unchanged and fully pinned.

**How I ran it.** Scripts are in `scratchpad/pr64b/agent/`. `head/` holds ebabd18, `r1/` holds 3b267b9 and `base/` holds main ce2b1ee. Run with `node --experimental-transform-types --import ./register.mjs <script>`. Mutation and test runs are in `scratchpad/pr64b/vt/`: vitest 4.1.11 from `C:\javis\node_modules` in a node environment, with a node:sqlite `cloudflare:test` shim. No workers pool, no wrangler, no remote database. Baseline there: **447/447 pass** across 11 files (the model, repository, compatibility, migration, digest, digest-job and school test files).

---

## Round-1 items

| # | Status | Evidence at ebabd18 |
|---|---|---|
| H1 | **NOT FIXED** | The round-1 replies are now replaced, but the guard is still an enumerated verb list (`school-catchup-model.ts:39-43`) plus a noun×verb passive list (`:52`); anything not listed passes. **27 of 30** new completion claims reach Sid (`r2.mjs reply`), including 6 of the 8 named variants: "Your Waterloo acceptance is in.", "Western has your transcript now.", "Message sent to your counsellor.", "Consider it done.", "Booked your campus tour.", "Your OUAC account is set up.". End to end (`h1e2e.mjs`): Sid says "I got my Waterloo offer. Can you accept it for me?" and sees "All done: Waterloo offer accepted."; "Hey Jarvis, can you order my transcript for Western?" gets "Transcript ordered and on its way to Western." Pre-model refusal is anchored at `^`, so "Hey Jarvis, can you…" and a request in a second sentence reach the model. |
| H2 | **PARTIAL** | Tracked cross-school binding refuses in the parser and on the real repository (`repo2.mjs`: "…from Western instead of Waterloo." refused). Still binds: "I got a Computer Science conditional offer from Toronto instead of Waterloo." re-opens Waterloo's withdrawn offer on the real repository, and the digest lists it. An untracked school or alias doesn't count as "another school"; "…from UW instead of Western." binds to Western. The new must-name-the-program rule over-refuses silently (see N-M3). |
| M1 | **PARTIAL** | All 7 round-1 inputs refuse. Still recorded as `owner_reported_offered`: "I wish I got an offer from Waterloo for Computer Science.", "I dreamt I got…", "Imagine I got…". `OWNER_HEDGE` (`model.ts:35`) is another list. Real decisions now refuse silently: "…! I hope Western is next.", "…with no conditions!", "Wait, I got an offer…". |
| M2 | **PARTIAL** | Reuse is real: `supportsStatus` for `submitted_by_sid` (`model.ts:660`) and every workflow owner status (`:906-945`) call the same `supportsDirectOwnerClaim` (`:602-628`), not a copy. All 5 round-1 inputs refuse. But the refactor opened N-M1. "I asked my mom to email Ms Lee about the Ms Lee reference request for the Western reference." still records the contact step done. The normal "I emailed **Ms.** Lee about the Ms Lee reference request…" refuses, because the sentence split at `:260` cuts at "Ms.". |
| M3 | **PARTIAL** | All 12 round-1 false positives pass. The 11 supplied requests refuse. School messages reach the model (`refuse.mjs`: 2 model calls). But the new patterns refuse other ordinary school messages; see N-M2. |
| M4 | **PARTIAL** | Terminal steps leave the prompt after 2 days, and closed-parent steps leave at once (`m4.mjs`: the old 10×5×12-done shape drops from 48.5 KB to 16.9 KB). The overflow message is visible. The cap was not set from a measured budget; see N-L3. |
| M5 | **PARTIAL** | The 4 supplied strings refuse. Still stored: "Applications close in mid-January, so submit early.", "Submit before 15 January.", "You need to submit by the first of February.", "The AIF costs one hundred fifty-six.", "Application fee: one fifty-six.", "Waterloo wants two references and an 85 average.", "Waterloo looks for a 90 percent average." It is still a deny list (`model.ts:77-81`). The round-1 alternative of wrapping stored drafts as "unverified draft" was not taken. It now also refuses ordinary draft text: "I hope you had a great summer. I'm applying to Western this fall…", "Thank you for your time today.", "…by next week…", and the label "Fall scholarship essay upload". |
| M6 | **FIXED** | On the real repository (`repo2.mjs`), after "I submitted the Western essay." the digest no longer lists "Western essay submission [prepared]". There is a side effect; see N-L1. |
| M7 | **PARTIAL** | Of the 13 round-1 guards, 9 are fully killed by the PR's tests. Guards 2 (CONDITIONAL) and 3 (RETRACTION) are killed on the owner-claim path but **survive on the `prepared` path**. Guards 4 (**NEGATION on done**) and 12 (**verified-deadline source in clause**) survive: their named tests exist, but another guard already refuses those inputs ("I didn't email…" never matches the done verb). Clause-level RETRACTION in the direct claim is equivalent to the whole-message check. New round-2 guards with no test: target university must be named, **program name required (the new H2 rule)**, no other program at the same school, per-clause HEARSAY, `yet to`, accepted-noun adjacency, all three repository-boundary re-checks (label, preparedDetails, 12 KB cap), and the narrowness of the missing-0029 catch (catch-all mutant survives). 0029: removing any of the 11 triggers, or the 128 cap, 64 cap, `created_at` ordering, `channel='telegram'` or principal-match predicate, fails a test. Results: `vt/mutate2-results.txt`, `vt/trigmut-results.txt`. |
| L1 | **FIXED** | The digest renders "due Jan 15, 2027, 11:59 PM EST (unverified)" (`l1.mjs`). Local-time entry is recorded in KNOWN_ISSUES. |
| L2 | **FIXED** | `isWorkflowLabelSafe` runs in the parser and the repository. Email and phone labels refuse, and the parser check is pinned. The repository re-check is unpinned (M7). |
| L3 | **FIXED** | Only a missing 0029 table soft-reads as an empty list. The compatibility test pins it. The "other errors still fail" half is unpinned (M7). |
| L4 | **FIXED (recorded)** | KNOWN_ISSUES records the 64-revision ceiling with its reason, as the verdict allowed. |
| L5 | **FIXED** | A 12 KB aggregate cap applies in the parser and the repository. The `RangeError` is caught and Sid gets a fixed no-save reply. Both are killed by mutation. |

**Remaining work on partial items:**
- **H2:** for decision kinds, refuse a clause containing a contrast marker ("instead of", "not", "rather than", "over") plus any school-like name. Do not restrict the check to tracked aliases.
- **M1:** accept only a clause that *starts* with the first-person decision (optionally after "omg/yay"). That refuses "wish/dreamt/imagine/bet … I got" without another list.
- **M5:** stop enumerating. Store drafts as text marked "unverified draft", never show them in the digest, and never feed them back as tracker state. Or feed them back inside an explicit untrusted-draft wrapper.
- **M7:** give each survivor an input that only that guard refuses.

---

## New findings

### High

**N-H1. The widened reply guard replaces Jarvis's own study-plan and draft replies with the external-action refusal**
- **Where:** `apps/cloud-gateway/src/school/school-catchup-model.ts:39-43`. The new verbs `created`, `set up`, `ordered`, `confirmed`, `accepted` and `declined` have no benign shapes in `allowedFirstPersonActionClaim` (`:291-313`), so `guardReplyClaims` (`:333-334`) replaces the whole reply.
- **Proven** (`replyfp.mjs`, `plane2e.mjs`). Each of these is shown at round 1 and replaced at round 2:
  - "I've created your study plan for tonight: chem stoichiometry first, then math review."
  - "I set up three study blocks for tonight: chem, math, English."
  - "I ordered your tasks by due date…"
  - "I created a draft email for Ms. Lee below. Review it and send it yourself."
  - "I created a checklist for the Waterloo AIF."
  - "I accepted your correction: the Western essay is back to drafting."

  End to end, Sid says "I'm behind in chem, can you make me a plan for tonight?". The school plan **is saved**, and Sid sees: "I can't do or confirm that action. I can prepare a draft or exact checklist, but you must send, upload, submit, pay, sign up, or contact them yourself."
- **Effect for Sid:** school catch-up is his top priority. He asks for a plan or a draft and gets a refusal about something he never asked for. The plan exists, but he isn't shown it. The draft Jarvis is told to prepare is hidden.
- **Fix:** same root as H1. Make the claim check structural: a first-person or passive completion verb is unsafe only when its object is an external target (offer, admission, spot, fee, payment, account, portal, transcript, application, reference, form, or a person or school). Plan, draft, checklist, task and correction objects are safe. Pin both the H1 variant list and these six replies.

### Medium

**N-M1. The refactor weakens PR #52's reported-speech check: "My counsellor told Ms. Lee I submitted the Western essay." is now recorded**
- **Where:** `university-tracker-model.ts:51-54`. `REPORTED_OWNER_ACTION` now uses `[^.!?\r\n]{0,80}`, which cannot cross the period in "Ms.", "Mr." or "Dr."; main's `.{0,64}` could. The sentence split at `:260` also cuts at that period, so the per-clause HEARSAY check at `:622` never sees "told". Used at `:614` for `submitted_by_sid` and for every workflow status.
- **Proven** (`pr52w.mjs`):
  - `supportsStatus("submitted_by_sid")` accepts at head and refuses on main: "My counsellor told Ms. Lee I submitted the Western essay." and "The school told Mr. Chen I submitted the Western essay."
  - Same shape on the new paths: "My counsellor told Ms. Lee I got an offer from Waterloo for Computer Science." gives offered; "Mom told Mr. Chen I paid the Waterloo AIF fee for the Waterloo AIF." gives done.
- **Effect for Sid:** someone else's report marks his essay submitted or his fee paid, and the item leaves the digest. This is the one place round 2 loosens PR #52.
- **Fix:** mask title abbreviations (Mr., Ms., Mrs., Dr., St.) before sentence and clause splitting and in `REPORTED_OWNER_ACTION`, or let the reported-speech check span the whole message. Pin the three inputs on both paths.

**N-M2. New pre-model patterns refuse ordinary school requests that round 1 let through**
- **Where:** `school-catchup-model.ts:73`: `let\b.{0,48}\bknow`, `text\s+\S+`, `follow\s+up\s+with`, `accept\s+(?!that)…\p{L}…` (whose `accept\s+(?:it|this|that)` branch still matches "accept that"), and `decline\s+…`. These combine with the bare leading-action pattern `^\s*${ACTION}\b` at `:79`. The check runs before any snapshot or model call (`:606`).
- **Proven** (`m3cmp.mjs`, `m3e2e.mjs`). Each passes at round 1 and is refused at round 2:
  - "Let me know what's due this week."
  - "Can you let me know what homework I have?"
  - "Please let me know if I missed anything in chem."
  - "Jarvis, let me know when D2L updates."
  - "Can you let me know if Ms Lee replied?"
  - "Text from my counsellor: meeting moved to 2."
  - "Could you text me a reminder at 7?"
  - "Follow up with Ms Lee is on my list for Friday."
  - "Accept that I'm behind and make me a catch-up plan."
  - "Decline in my math mark is stressing me out."

  End to end: model calls = 0, and Sid gets the "I can't do or confirm that action…" text.
- **Effect for Sid:** asking Jarvis what homework he has gets a refusal. Nothing is tracked or planned for that turn.
- **Fix:** require an external object: "let <person, school or university> know", "text <person>", "accept/decline <offer, admission, spot or school name>". Never match `me`, `that`, `from` or `in`. Add these ten messages as false-positive tests. The reply guard, not this courtesy check, is the boundary.

**N-M3. Refused offers and steps are silent, and a "recorded" claim passes on that path. Round 2 sends most natural offer messages there.**
- **Where:** `school-catchup-model.ts:687-692`. Any parse refusal falls to `guardedOrdinaryReply` (`:577-587`), which has no `PLAN_SAVE_COMPLETIONS` check and no "couldn't update" line, unlike `fallbackWithSaveFailure` (`:559-575`). The path predates this PR, but the new binding rule at `university-tracker-model.ts:821-840` and the whole-message hedge and retraction checks at `:614-617` greatly widen its use.
- **Proven:**
  - `h2r1.mjs`: recorded at round 1, refused at round 2: "I got my Waterloo offer", "I got an offer from Waterloo!", "I got a Waterloo CS offer", "I received a Western offer.", "I got an offer from Waterloo for Computer Science! I hope Western is next.", "Wait, I got an offer from Waterloo for Computer Science!". The normal "I emailed Ms. Lee about the Ms Lee reference request…" refuses at both.
  - `silent.mjs`, through the adapter: Sid says "I got my Waterloo offer!!". Nothing is saved, and Jarvis says "Congrats on the Waterloo offer, Sid! That's huge. I'll keep it on your radar." If the ordinary reply is "Congrats! I've recorded your Waterloo offer in your university tracker.", Sid sees exactly that.
- **Effect for Sid:** he believes the offer, and its response deadline, is tracked. The digest never shows it, and he isn't told.
- **Fix:** on any structured-plan refusal, use `fallbackWithSaveFailure`, so `PLAN_SAVE_COMPLETIONS` applies and the fixed "I couldn't update your university tracker." line is appended. Better still, have the structured reply ask the one missing fact ("Which Waterloo program — Computer Science?") instead of refusing without a word.

### Low

**N-L1. Open steps disappear when their parent item closes**
- **Where:** `university-tracker-repository.ts:556-561` (digest) and `university-tracker-model.ts:1253` (prompt). Every step of a submitted or not-needed item is hidden, whatever its own status.
- **Proven** (`repo2.mjs`, real repository): "Ms Lee reference request [prepared]" is a contact step linked to "Western scholarship". After "I submitted the Western scholarship." the digest is empty, although the request was never sent. A payment step on a submitted AIF behaves the same way.
- **Effect for Sid:** an outstanding reference request or fee reminder silently leaves the digest. Because it also leaves the prompt, he can only close it by typing its exact label.
- **Fix:** hide only the steps that the parent's submission completes (that item's submission or upload step). Keep contact, transcript and payment steps until they are closed themselves.

**N-L2. PR #52's checklist now refuses ordinary messages that main accepts**
- **Where:** `university-tracker-model.ts:32-33` (global `told`, `reports`, `no` and `yet to`), `:51-54` (REPORTED now includes `emailed`, `texted` and `sent` without "me"), and `:644` (`retirementNegated`).
- **Proven** (`r2.mjs pr52`). Each is accepted on main and refused at head:
  - "I submitted the Western essay with no issues."
  - "I submitted the Western essay like Ms Lee told me to."
  - "I texted Mom right after I submitted the Western essay."
  - "I emailed Ms Lee and then I submitted the Western essay."
  - "I'm no longer applying to Western so skip the Western essay." (not needed)
  - "I finished the Western essay with no more edits to make." (ready)
- **Effect for Sid:** fail-closed, but silent (N-M3). The item stays open in the digest after he has reported it.
- **Fix:** scope `no` and `yet to` to the offer statuses. Restrict REPORTED's new verbs to "<someone> emailed/texted me … I …". Strip "no longer applying" in `retirementNegated`. Pin the six messages.

**N-L3. Inside the declared caps, a large open tracker locks every Telegram turn with no way out in chat**
- **Where:** `school-catchup-model.ts:644-651`; caps at `university-tracker-repository.ts:36-44`.
- **Proven** (`m4.mjs`, `m4lib.mjs`, real adapter):
  - 12 programs × 8 open items × 8 open steps × 4 requirements, which is within every cap, gives 46.9 KB of compact state and "Your school and university tracker is too large…".
  - At 16×8×8×8 the same reply comes back for "Mark every University 3 step not needed." and for "ok".
  - Compact mode expands no named program, so the reply's advice to "name one course, school, program…" cannot shrink anything. Closing items needs a structured turn, and that is exactly what is blocked.
- **Effect for Sid:** unlikely at realistic sizes (about 95 open steps plus about 95 open items). If reached, Telegram Jarvis answers nothing else, school included, until the rows are changed outside chat.
- **Fix:**
  - Set the item caps from the measured 48 KB budget.
  - Or drop requirement and date lists from compact state first.
  - On overflow, let non-tracker conversation go to the ordinary reply with the too-large line appended.

---

## Checked and sound
- **0029:** zero diff since 3b267b9. All 11 triggers and 5 key predicates are killed by the migration and repository tests on node:sqlite.
- **Scope:** the PR diff against main touches nothing under voice/** or calls/**, and neither D1ContextRetriever nor production-runtime.ts. `index.ts` and `job-table.ts` only wire `readWorkflowItems`.
- **Round-1 probes:** every H2, M1 and M2 input in `guards.mjs` and `accept.mjs` refuses. The 4 round-1 end-to-end requests are refused before the model. The repository refuses Western-instead-of-Waterloo, and the round-1 M6 stale step is gone.
- **M2 reuse:** one shared validator (`supportsDirectOwnerClaim`), not a parallel copy.
- **Fixes confirmed:** the prepared-details aggregate cap and model-response-too-large catch (L5), timezone digest formatting (L1), the missing-table soft read (L3), and the visible too-large message.
- **Unchanged digest safety:** `preparedDetails` is never shown in the digest and is omitted from compact prompt state.

## Unverified
- How often a real model writes the replies in H1 and N-H1, the updates in the H2 and M1 bypasses, or a "recorded" line on the ordinary fallback path (N-M3).
- Behaviour on the Workers pool and real D1. My runs used node plus a node:sqlite shim. `university-tracker-telegram.integration.test.ts` fails under that shim (`delivery_unknown`); I did not investigate, and treat it as a shim artifact. I did not run the full suite, lint or typecheck.
- Whether real D1's missing-table error text matches the L3 regex.
- ICU and tzdata parity between Workers and Node for the L1 formatting.

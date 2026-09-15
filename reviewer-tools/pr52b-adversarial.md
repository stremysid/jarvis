# PR #52 round-2 adversarial re-review: university application checklist

- **Scope:** branch `origin/codex/r5-application-track-slice1`, head `5e1a2ed`. Fix commit `f2475f8`, merge of main `9fa3280`. Migration `0024` is unapplied.
- **Method:** read-only. I read from a `git archive` of `5e1a2ed` under `scratchpad/pr52/round2/tree`, and ran no repo tests.
- **Probes** (all in `scratchpad/pr52/round2/`) import the PR's real TypeScript modules through node `--experimental-transform-types` and a `.js`→`.ts` resolve hook:
  - `probe-parser.mjs`: 68 owner messages against `parseOwnerUniversityPlan`.
  - `probe-reply-guard.mjs`: 47 replies through `SchoolCatchupModelAdapter`, plus the fallback robustness cases.
  - `probe-budget.mjs`: real structured-prompt sizes.
  - `probe-sql.mjs`: `0024` triggers on `node:sqlite` with stub parents.
  - `probe-e2e.mjs`: the real parser, then the real `UniversityTrackerRepository`, then the real `0022` and `0024` SQL through a D1 shim.
  - Each probe's output is saved next to it as `*.out`.
- File:line references are at `5e1a2ed`, relative to `apps/cloud-gateway/src/`.

**Verdict: changes requested.** Two High, three Medium, eight Low. Most are small regex or ordering fixes, and `0024` needs no schema change for H1–M3.

---

## Round-1 findings

| Finding | Status | Evidence |
|---|---|---|
| **B1** submission not bound to its item, and irreversible | **Partially fixed** | **Fixed:** all four exact probes (P1–P4), "I submitted none of them yet" and "Ms. Chen and I submitted your reference" are refused. There is now one `submitted_by_sid` per turn, and a correction path out of submitted exists (e2e: "I didn't submit the Western essay" reopens the item and it returns to the digest). **Not fixed:** the item name and the submission verb are both matched against the whole message, never the same clause (H1b). P1 is refused only because of the word "haven't". The builder's P1 test (`test/university/university-application-workflow-model.test.ts:267-291`) would pass without any item binding. Also still accepted: "Ms. Chen and I submitted your Western reference", and forwarded teacher text naming the item ("Hi Sid. I have uploaded your Western transcript to OUAC. Ms. Lee", recorded in KNOWN_ISSUES). **New bypass:** retired→submitted (H1a). The correction path refuses natural wording (L1) and accepts conditionals and questions (L2). |
| **S1** retire status and label restrictions | **Partially fixed** | `not_needed_by_sid` exists. It is reversible, needs a later turn (SQL), and is left out of the digest, the prompt state and the active cap. **But** retirement accepts negated and cross-item messages (H2). The label filter misses "February 1st", "1 Feb", "2027/02/01" and emoji decoration, and wrongly refuses "May 5 info session essay" (L3). |
| **S2** cropped-negation evidence | **Fixed for cropping; cross-item remains** | Status evidence must now be the whole message, so "I haven't started the Western essay yet" can no longer give `drafting`. But "I've started my Waterloo AIF but haven't started the Western essay" gives the Waterloo AIF `not_started`. "I finished the Waterloo AIF and started the Western essay" gives the Western essay `ready` and the Waterloo AIF `drafting`. Same root cause as H1b. |
| **S3** fallback throws on long or non-NFC text | **Fixed** | A decomposed accent is normalised and a lone surrogate is repaired. 30,000 ASCII characters and 16,000 three-byte characters are both cut to 24,000 bytes without throwing. A reply over 32,000 characters still throws in `collectJson` (`school/school-catchup-model.ts:413-420`), but main's `guardedOrdinaryReply` already had that, so it is not a regression. |
| **S4** external-action guard gaps and false positives | **Fixed for the listed misses; new false-positive regression** | All 5 listed misses are now blocked, and the two pinned benign replies pass. The new verbs and passive pattern now block 17 of the 19 benign replies I tried, including the natural reply on a submission turn (M1). 14 claim forms still pass. |
| **S5** tracker state vs the 48,000-byte cap | **Partially fixed** | Submitted and retired history is left out unless the message names it, so the builder's cap test (inactive rows only) holds. Active state is not budgeted. 12 programs × 6 items with 4 requirements and 2 dates each already falls back to ordinary chat (M3). |
| **M4** incidental null-date update wipes a verified date | **Partially fixed** | "ok what's next for the Waterloo AIF" with a null date is now refused. A question, hearsay, a negated clear, or an excerpt about another item still replaces or downgrades a verified date (M2; e2e proven). |
| **N1** repository cap counts vs trigger counts | **Fixed, with an ordering residue** | The count query (`university/university-tracker-repository.ts:359-366`) counts rows under inactive programs, matching the triggers. Batch statement order can still make the trigger abort a plan the repository accepted (L5). |
| **N3 / L1** ambiguous or loose date evidence | **Fixed** | `02/03/2027` is refused for both readings and `13/02/2027` is accepted. "Feb 1, 2027; I have 15 essays" no longer supports 2027-02-15, and "may be due in 2027, maybe the 3rd week" is refused. New fail-closed case: "Feb. 1, 2027" is refused (L1). The verified-cycle binding is trivially met by the date's own year (L4). |
| **L5 (r1)** trigger drift | **Mostly fixed** | Proven on SQL: `submitted_at` is pinned while submitted, `updated_at` cannot go backwards, and a verified `due_date` cannot change unless `verified_at` also changes. Still allowed: swapping a verified row's `source_url` or cycle, backdating `verified_at`, and reusing an *older* turn id to leave submitted (L6). |
| **L2 (r1)** re-adding an existing item aborts the turn | **Fixed, but the skip is silent** | `repository:541` `continue` skips it (L7). |

---

## High

### H1: `submitted_by_sid` can still be saved when Sid did not say he submitted that item

**H1a. A retired item becomes submitted with no submission wording.**
- `university/university-tracker-model.ts:302-304`: when the existing status is `not_needed_by_sid`, any different status only needs `REACTIVATION` (`:29`). That branch returns before the submission check at `:305-308`.
- **Input (proven end to end):**
  - The Queen's scholarship is retired.
  - Sid says "Keep the Queen's scholarship".
  - The model returns `status: "submitted_by_sid"`.
  - Result: parse → repository → `0024` saves `Queen's scholarship=submitted_by_sid` with a `submitted_at`.
- Also accepted by the parser: "I need the Queen's scholarship after all", and "Don't restore the Queen's scholarship, I never submitted it".

**H1b. Item naming and submission detection are message-wide.**
- `:356` computes `namesItem` over the whole owner message, and `:305-307` tests `OWNER_SUBMISSION` over the whole message too.
- So any message with one positive submission clause lets the model mark *any* item named elsewhere in the message.
- **Input (proven end to end):** "I submitted my Waterloo AIF and started the Western essay." with `submitted_by_sid` on the Western essay is saved, and the Western essay drops out of the digest.
- **Parser-proven:**
  - "I submitted the Waterloo AIF. Western essay is next."
  - "I uploaded the Waterloo transcript, the Western transcript is still with guidance."
  - "Ms. Chen and I submitted your Western reference"

**Consequence**
- An unfinished item leaves the morning digest and is recorded as "submitted by Sid" when Sid never said that.
- It can now be reversed, but only if Sid notices and uses the exact correction wording (see L1).
- This breaks the invariant the fix commit and the prompt (`school/school-catchup-model.ts:349`) state.

**Fix**
1. In `supportsStatus`, run the `status === "submitted_by_sid"` rule first, whatever the existing status. Restrict the reactivation branch to `not_started | drafting | ready`.
2. Bind the submission to one clause:
   - split the message on `[.;!?]` and on `, | and | but | then`;
   - require one clause that matches `OWNER_SUBMISSION` and names the item;
   - require that no other active or inactive application item in the snapshot is named in that clause.
   - Simpler alternative: refuse `submitted_by_sid` when the message names any other application item.
   - Apply the same clause binding to `drafting`, `ready` and `not_started` (the S2 residue).

**Pinning tests**
- Parser tests expecting `university_application_model_item_invalid` for each H1a and H1b input above.
- A repository test where a retired item plus "Keep the Queen's scholarship" plus `submitted_by_sid` leaves the row `not_needed_by_sid`.
- A positive control: "I submitted my Waterloo AIF and started the Western essay." still accepts `submitted_by_sid` on the Waterloo AIF.

### H2: Retirement accepts negated and cross-item messages, silently removing live items from the digest

- `university/university-tracker-model.ts:28` (`RETIREMENT`) and `:309-311` check only `CONDITIONAL_OR_QUESTION` and `RETIREMENT`. There is no `NEGATION` check and no clause binding.
- **Proven end to end:** "Don't remove the Queen's scholarship" + `not_needed_by_sid` is saved, and the scholarship leaves the digest.
- **Parser-proven:**
  - "I'm not skipping the Waterloo AIF"
  - "I don't need help with the Waterloo AIF" (`don't need`)
  - "I'm not doing the Waterloo AIF tonight, tomorrow instead"
  - "Remove the Western essay, keep the Waterloo AIF" (retires the Waterloo AIF)
- **Reactivation has the same gap** (`:303`): "Don't restore the Queen's scholarship" and "I'm not going ahead with the Queen's scholarship" both reactivate. That direction is fail-safe.
- **Consequence:** the same user-visible harm as round-1 B1. A live application item disappears from the morning digest, and neither the digest nor the reply names what was retired. It is reversible only if Sid notices.
- **Fix**
  - Refuse `not_needed_by_sid` when `NEGATION` matches the clause that names the item.
  - Require the retirement verb and the item name in the same clause (H1 fix 2).
  - Drop the bare `don't need` / `do not need` forms unless the clause ends at the item name or "anymore".
  - Apply the negation rule to `REACTIVATION` too.
- **Tests:** a parser table of the inputs above expecting refusal. Keep "Skip the Western reference, it's a duplicate" and "I'm not applying for the Queen's scholarship" as accepted controls.

---

## Medium

### M1: The widened reply guard replaces ordinary replies with the refusal on every Telegram turn

- `school/school-catchup-model.ts:38` adds `sent|asked|asking|requested|requesting|called|filed|filing|forwarded|notified`, with only a first-person subject and no object check. `:40` adds a passive `… is/was/has been submitted|sent` pattern with no actor or context check.
- `guardReplyClaims` (`:218-230`) runs on structured replies (`safeReply`, `:210-216`) and on every fallback (`:245-255`).
- **Proven:** each of these is replaced by "I can't confirm that action…":
  - "I asked earlier which programs you're considering."
  - "I'm asking because the Waterloo AIF is still unverified."
  - "As I asked before, which essay prompt did you pick?"
  - "Once your Waterloo AIF is submitted, Waterloo emails a confirmation."
  - "After your transcript request is sent, your school has to process it."
  - "Nice, you said your Waterloo AIF is submitted. I noted it as submitted by you."
  - "Got it. Your Waterloo AIF was submitted by you, so it's off the list."
  - "I sent you a summary above."
  - "I've requested that you double-check the date on the Waterloo site."
  - "Make sure the essay is submitted before the deadline."
  - "Ask Ms. Chen whether your reference was sent."
  - "Check whether your transcript has been sent by guidance."
  - "I called it the Waterloo AIF in your tracker."
  - "We're asking OUAC-style questions to build your list."
  - "I'm filing this under the Western program."
- **Consequence**
  - Jarvis's normal follow-up questions and advice become a refusal line.
  - On the turn where Sid reports a submission, the correct acknowledgement is itself replaced, so Sid sees "I can't confirm that action" right after a correct save.
  - This happens on the structured path, not just in fallbacks.
- **Still passing (claims not caught):**
  - "Your Waterloo AIF has now been submitted."
  - "Your Waterloo AIF got submitted."
  - "Your AIF is now in with Waterloo."
  - "Submitted! Your Waterloo AIF is in."
  - "I've handed in your AIF."
  - "I've completed your OUAC submission."
  - "I have applied to Waterloo for you."
  - "I've put in the transcript request."
  - "I've let Ms. Chen know you need a reference."
  - "I told your counsellor about the transcript."
  - "I shared your essay with Ms. Chen."
  - "I just texted Ms. Chen."
  - "I booked your Waterloo interview."
  - "Ms. Chen has been contacted." (the subject is not in the list)
- **Fix**
  - For the contact verbs (`asked|requested|sent|forwarded|notified|told|let … know|shared|texted`), require a third-party object within about 48 characters (Ms./Mr./Dr./teacher/referee/counsellor/guidance/school/university/OUAC) or "for you". Drop the bare `asking|filing|called|sent`.
  - For the passive pattern:
    - skip matches preceded by `once|after|when|until|before|whether|make sure|check|if`;
    - skip matches followed by `by you`, or in a sentence containing `you said|you told me`;
    - add `has (now|already) been`, `got`, `is in`.
  - Add `handed in|applied|put in|completed … submission|booked`.
- **Test:** one `it.each` table with both lists above: block the claims, pass the benign replies.

### M2: A verified due date is still replaced by a question, hearsay, a negated clear, or another item's date

- `university/university-tracker-model.ts:242-277`.
  - A non-null date only needs its excerpt to contain the date (`:259-262`). It does not have to name the item, and nothing checks for a question, conditional or hearsay.
  - Clearing a date checks `DATE_CORRECTION` (`:33`), which has no negation check (`:268-270`).
- **Proven end to end:**
  - The Waterloo AIF is verified for 2027-02-01.
  - Sid asks "Is the Waterloo AIF due Feb 15, 2027?"
  - The model returns date 2027-02-15, unverified, with evidence "Feb 15, 2027".
  - Result: saved, and the digest now shows `Waterloo AIF … 2027-02-15 (unverified)`. The official URL, cycle and `verified_at` are gone.
- **Parser-proven**, each accepted against the verified item:
  - "My friend thinks the Waterloo AIF might be due Feb 3, 2027"
  - "Western essay due Feb 15, 2027 and the Waterloo AIF is on the site" (the Western date lands on the Waterloo AIF)
  - "Don't remove the Waterloo AIF deadline" (clears it)
  - "Is the Waterloo AIF date unknown now?" (clears it)
  - "The Waterloo AIF is due Feb 1, 2027 right" (same date, downgraded to unverified)
- **Consequence:** the digest shows a date Sid only asked about in place of the official one, for an application due within weeks.
- **Fix**
  - For an existing item that has a date, a date change needs whole-message evidence that names the item, with no `CONDITIONAL_OR_QUESTION` and no hearsay words (`thinks|heard|said|might|maybe`).
  - A restatement of the same date that arrives unverified keeps the existing verification.
  - `DATE_CORRECTION` refuses when `NEGATION` matches.
  - Evidence for a new date must sit in the same clause as the item name.
- **Tests:** parser and repository tests for each input above, asserting the verified row is unchanged.

### M3 (partly estimate): Active tracker state still passes the prompt cap, and nothing can recover it

- `school/school-catchup-model.ts:20` and `:518-524`. `universityStateJson` (`university/university-tracker-model.ts:408-440`) still sends every active application item in full (URL, cycle, date) and every requirement detail.
- **Measured** with the real adapter (`probe-budget.out`); the empty-tracker prompt is 5,989 bytes:

  | State | Prompt |
  |---|---|
  | 8 programs × 5 items, 3 requirements + 2 dates each | 33,900 bytes |
  | 10 programs × 6 items, 4 requirements + 2 dates | 47,558 bytes |
  | 12 programs × 6 items, 4 requirements (120-byte detail) + 2 dates | **falls back to ordinary chat** |
  | 128 active items (the cap), verified 70-byte URLs, no requirements | 46,230 bytes |

  School state and longer labels, details or URLs add to these.
- **Consequence**
  - Past the cap, every Telegram turn takes `guardedOrdinaryReply`. No school or university write can happen, including the retire or deactivate that would shrink the state, so the tracker stays locked.
  - Whether Sid reaches about 70 active items plus requirements is an estimate. A 10–12 program shortlist with requirements is near the line.
- **Fix**
  - Budget `university_state_json`: send requirement detail and verification URLs only for programs the current message names, and a compact `{itemId, label, status, dueDate, verificationState}` otherwise.
  - Or, when over budget, retry with that compact state before falling back.
- **Test:** 16 programs, 128 active application items and 128 program items at realistic sizes (label 40 bytes, URL 90 bytes, detail 200 bytes). The structured prompt must stay at or under 48,000 bytes and still contain every active `itemId`.

---

## Low

- **L1: Legitimate reports are refused without saying so.** Proven parser refusals:
  - "I submitted the AIF" and "I just submitted the AIF for Waterloo": the label "Waterloo AIF" is not a substring, and the university is stored as "University of Waterloo".
  - "Submitted my Waterloo AIF": no "I".
  - "I submitted my Waterloo AIF. What's next?": the `?`.
  - "I submitted my Waterloo AIF, so I don't have to think about it anymore": the negation.
  - "I began the Western essay today", "I'm done with the Western essay", and "I finished my Western essay but haven't proofread it".
  - "I didn't actually submit the Western essay, the portal crashed" (e2e refused; `SUBMISSION_CORRECTION` `:27` needs "didn't submit" with no word between).
  - "Western essay due Feb. 1, 2027".
  - Any multi-line message, for **every** status change and every new item. `inline()` rejects `\n`, and the whole combined plan is then refused, so program updates in the same response are lost too. KNOWN_ISSUES records this only for submissions.
  - Trailing whitespace (estimate): Telegram text is not trimmed (`channels/telegram/telegram-types.ts:104-109`), and `statusEvidence !== ownerMessage` fails after `inline()` trims. It is unproven whether clients send trailing spaces.

  **Fix:**
  - apply the `?` check per clause;
  - allow up to two adverbs between `didn't` and `submit`;
  - add `began|done with`;
  - trim `ownerMessage` before the comparison;
  - update KNOWN_ISSUES.

  **Tests:** the inputs above as accepted controls, or as documented refusals.

- **L2: The correction path accepts conditionals, questions and unrelated negation** (`:299-301`). The parser accepts all three:
  - "If I didn't submit the UofT essay, remind me"
  - "Wait, I didn't submit the UofT essay?"
  - "I never submit anything late, and the UofT essay went in fine"

  This fails safe: the item goes back into the digest. **Fix:** add `!CONDITIONAL_OR_QUESTION` and clause binding. **Test:** those three refused.

- **L3: Label metadata filter gaps** (`:34`, `:362`).
  - Accepted as new-item labels: "Waterloo AIF February 1st" (`\d{1,2}\b` fails before "st"), "Waterloo AIF 1 Feb", "Waterloo AIF 2027/02/01", and "Waterloo AIF ✅ official".
  - `mentions()` strips punctuation and emoji, so decoration Sid never typed is stored in the label and shown in the digest.
  - Refused wrongly: "May 5 info session essay".

  **Fix:** require the label to be a case-insensitive substring of the owner message after whitespace collapse only, and cover `D Mon`, `Mon Dst` and `YYYY/MM/DD`. **Test:** table.

- **L4: The verified cycle check is met by the date's own year** (`:263-266`). "Western essay due Feb 1, 2027 per https://uwo.ca/x" with cycle `2027` is accepted as verified although no cycle was stated. KNOWN_ISSUES says the cycle is "bound to one excerpt", which overstates it. **Fix:** require the cycle token outside the matched date span, or a cycle phrase ("2027 cycle", "fall 2027", "2026-2027"). **Test:** the input above refused.

- **L5: Batch order can abort a plan the repository accepted.**
  - `applicationStatements` follow plan order (`repository:587-610`, `:627-628`).
  - At 32 active items in a program, insert-then-retire aborts in `cap_insert` (SQL proven), while the repository's final count passes.
  - Sid gets the generic "I couldn't update your university tracker."
  - **Fix:** push status updates before inserts. **Test:** a repository test at 32 active with a plan listing the new item first.

- **L6: `0024` defence-in-depth gaps** (SQL proven; the repository is the only writer).
  - A verified row's `source_url` and `admission_cycle` can be swapped while `due_date` and `verified_at` stay (`state_consistent_update`, `:149-164`).
  - `verified_at` can be backdated.
  - `status_correction_guard` (`:140-147`) accepts any *different* `source_turn_id`, including an older turn.
  - After an un-verify, stale `source_url`/`cycle` remain on an unverified row.

  **Fix:** extend `state_consistent_update` to abort when a verified row's `source_url`, `admission_cycle` or `verified_at` changes without `verified_at` moving forward, and when `NEW.verified_at < OLD.verified_at`. This must land before `0024` is applied. **Test:** migration tests for each.

- **L7: Re-adding an existing item is skipped silently.** `repository:541` `continue` also skips a `new-item-N` whose key matches a retired or submitted item. The structured reply can still say it was added, while the item stays hidden. **Fix:** refuse with a clear line, or map to the existing item as a reactivation. **Test:** a repository test with a retired label re-added as `new-item-1`.

- **L8: Merge interaction with PR #53 (`b2447b8`).**
  - `git merge-tree` shows textual conflicts in `digest/digest-composer.ts`, `digest/digest-types.ts`, `index.ts`, `jobs/digest-job.ts`, `jobs/job-table.ts`, `test/jobs/brightspace-poll-job.test.ts` and `NEXT_STEPS.md`. `school/school-catchup-model.ts` auto-merges.
  - Semantically, #53's `ownerTurnAuthoritative === false` sends forwarded or quoted text straight to the base model (#53 `school-catchup-model.ts:440`, wired from `isDirectText` in #53 `index.ts:125`).
    - That closes this PR's forwarded-text write gap once both merge, so the KNOWN_ISSUES entry should be updated then.
    - The same bypass also skips `guardReplyClaims` for forwarded turns. That is a #53 concern.
  - Main's #50 (memory owner controls) is already in `9fa3280`, with no overlap in the changed files.

---

## Checked and sound

- **Docs merge `9fa3280`.**
  - All 221 AGENT_LOG headings from both parents (`46df853`, `1cae97b`) are present, and no AGENT_LOG line from either parent is missing.
  - Every KNOWN_ISSUES heading and line from both parents is present.
  - HANDOFF and NEXT_STEPS differ only by rewrapped main text plus PR #52 additions.
  - `5e1a2ed` adds entries and removes none.
- **Migration `0024` (SQL proven).**
  - **Triggers:** 9 in total, as the builder says. No `CASE`; every trigger uses `SELECT RAISE … WHERE`. The `WHEN` clause on `cap_reactivate` has precedent in applied `0001` and `0003`.
  - **Conflict clauses:**
    - `INSERT OR REPLACE` on the primary key and `INSERT OR IGNORE` on the natural key both abort with `insert_conflict`;
    - `UPDATE OR REPLACE` onto another row's key, id or program aborts with `core_immutable`;
    - DELETE is forbidden.
  - **Submitted and retired transitions:**
    - `submitted_at` cannot change while submitted, or predate `created_at`;
    - `updated_at` cannot go backwards;
    - leaving submitted or retired needs a different Telegram turn, and a voice turn is refused.
  - **Verified dates:** a verified date change needs a new `verified_at`.
  - **Caps:**
    - retiring frees the active cap, and reactivating at 32 active is refused;
    - re-inserting a retired label is refused;
    - the history cap is 64 per program and 256 in total, and retired rows count toward it, so retire, un-retire and re-add cannot reset the caps.
- **Parser behaviours that hold.**
  - P1–P4 exact strings are refused, as is "I submitted none of them yet".
  - At most one `submitted_by_sid` per turn, and a new item cannot start as `not_needed_by_sid`.
  - An incidental null-date update on a dated item is refused.
  - Ambiguous numeric dates are refused, and non-contiguous date parts are refused.
  - Status evidence must equal the whole message, which closes the cropped-excerpt form of S2.
  - Legitimate retire ("Skip the Western reference, it's a duplicate"), reactivate ("I changed my mind, I'm doing the Queen's scholarship") and exact correction ("I didn't submit the Western essay", e2e) work.
- **S3 fallback.**
  - NFC normalisation, surrogate repair and the 24,000-byte bound all work without throwing.
  - A redactor failure returns a fixed line.
  - The Brightspace and secret guards still run on fallbacks.
- **Digest and prompt.**
  - Submitted and not-needed items are excluded from `listApplicationItemsByDueDate` (`repository:333`), from the composer filter, and from `applicationItems` in the prompt.
  - Inactive items appear in `inactiveApplicationItems` only when the message names them. That is the same naming rule the parser uses, so a correction is always reachable.
- **Repository counts.**
  - The active and history counts include items under inactive programs, matching `cap_insert` and `cap_reactivate`.
  - A same-turn reversal is refused (`repository:567-573`), consistent with `status_correction_guard`.

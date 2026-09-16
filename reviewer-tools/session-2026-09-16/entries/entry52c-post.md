## 2026-09-15 23:46 UTC — Claude Opus 5, PR #52 round-3 max re-review at 12a7bbf: changes requested

Every round-2 finding is genuinely fixed in code, and the gates are clean. Two new defects came in with the fix itself, and both are Highs because Sid hits them on ordinary sentences. Full report: `reviewer-tools/pr52c-adversarial.md`.

**Local checks at 12a7bbf** (Windows 11, `jarvis-pr39`): lint and typecheck pass, `pnpm test` passes **3,408/3,408 with 0 timeouts**. `0024` has no `CASE`; all **9 whole-trigger removals are killed** by named tests (`reviewer-tools/pr52/round3/run52ctrig.txt`). All four round-1 probes still **FAIL**, as required. The main merge `7e4abc0` is docs-only.

**H1. A verified application due date can no longer be saved at all.**
- **Where:** `university/university-tracker-model.ts:150`. `clauses()` splits on `[^.;!?\r\n]+`, so every real URL is cut in half at its first dot — before `:323-326` requires the source URL and the cycle phrase to sit inside **one** clause.
- **Proven by execution** (I ran the shipped `clauses()` verbatim): `"The Waterloo AIF is due Feb 15 2027 for the 2027 cycle, confirmed at https://uwaterloo.ca/future-students/admissions"` splits into `["…confirmed at https://uwaterloo.", "ca/future-students/admissions"]`, so no clause contains the URL and the turn is refused with `university_application_model_date_invalid`. The isolating control, the same message with a dotless host, is accepted. The second reviewer reproduced this end to end in four phrasings.
- **Effect for Sid:** the verified-deadline path is dead for application items. Every official Waterloo or OUAC deadline he pastes with its link is refused, the whole turn's university plan is discarded, and he gets "I couldn't update your university tracker" (`school/school-catchup-model.ts:620-623`). Program-level dates still work (`:205-217` checks the whole message), so the failure looks arbitrary.
- **Why the suite is green:** the only verified-application-date test (`test/university/university-application-workflow-model.test.ts:700-715`) asserts a *rejection*. There is no positive test for this path.
- **Fix:** mask `https?://\S+` spans before the sentence match at `:150` and restore them after, or keep the URL check whole-message the way `verification()` already does at `:213` and clause-bind only the date and the cycle phrase.
- **Test:** a positive parser test asserting `state:"verified"` survives for `"Waterloo AIF due Feb 1, 2027 per https://uwaterloo.ca/aif for the 2027 cycle"`.

**H2. Any program or item whose name contains "and", "but" or "then" is permanently unreachable.**
- **Where:** `university/university-tracker-model.ts:151-153`. `clauses()` splits on `\b(?:and|but|then)\b`, and `:437` then requires one clause to name the item.
- **Proven by execution:** `"I submitted my UofT Arts and Science essay"` splits into `["I submitted my UofT Arts", "Science essay"]`, so no clause contains "Arts and Science essay". The second reviewer ran submit, drafting, ready, retire, date and create against a snapshot holding UofT "Arts and Science" — **all six refused**, with `"I submitted my Western essay."` accepted as the control. `"I finished the Western essay then submitted it"` is refused too, because the split leaves the verb in a clause that names nothing.
- **Effect for Sid:** "Arts and Science" (UofT), "Arts and Business" and "Computing and Financial Management" (Waterloo) are ordinary Ontario program names on a grade-12 shortlist. For any of them he can never mark an item submitted, retire it, set its date or create it — and the reply is the generic save-failure line with no hint that re-wording would work.
- **Fix:** mask every snapshot label and program alias in the message before splitting, then unmask; or fall back to the whole-message naming test when no clause names the item **and** only one snapshot item is named message-wide.
- **Test:** a parser table over an "Arts and Science" program covering submit / drafting / ready / retire / date / create, plus `"I finished the X then submitted it"`.

**M1. The widened ordinary-reply guard now blocks 16 of 16 plausible benign replies.**
- **Where:** `school/school-catchup-model.ts:37` (`THIRD_PARTY`), `:39`, `:46`, `:47` (`PASSIVE_EXTERNAL_COMPLETION`).
- **Proven** through the real adapter, each isolated by a minimal pair. `THIRD_PARTY` has no object requirement, so any of `teacher|referee|counsellor|guidance|school|university|OUAC` within 48 characters of a first-person verb refuses the reply: "I asked earlier which university you are aiming for.", "I told you the university deadline is Feb 1, so start now.", "I asked about the transcript because your guidance office handles it, not you." (control: "…which **program** you are aiming for." passes). The passive `is\s+(?:already|just|now)?\s*in\b` alternative matches any "is in": "Your essay is in good shape.", "Your application is in progress, not submitted." (control: "Your essay looks good." passes). The new verbs add more: "I've applied your feedback to the outline.", "I booked nothing; only you can book the interview.", "I've put in a note about the Waterloo deadline.", "Submitted. Is that what you meant?".
- **Effect for Sid:** this is a school assistant, so "school", "university", "teacher", "guidance" and "is in progress" are its everyday vocabulary. Round 2's false positives were cured and a comparable set created; he sees "I can't confirm that action…" instead of ordinary answers.
- **Fix:** require the third-party noun to be the verb's object rather than anywhere within 48 characters; drop the bare `school|university` nouns or require `your …` plus a contact verb; restrict the passive alternative to `is (now )?in with <proper noun>`; drop `applied`/`booked`/`put in` unless followed by an external object; require `^Submitted[!.]` to be followed by a claim, not a question.
- **Test:** extend the guard `it.each` table with all 16 as PASS rows, keeping the existing BLOCK controls.

**M2. `containsLabel` is punctuation-exact, so smart quotes and hyphens block new items.**
- **Where:** `university-tracker-model.ts:138-143` and `:521`. The old check used `mentions()` (`:133`), which folds non-alphanumerics to spaces; `containsLabel` only collapses whitespace.
- **Proven:** `"Add the Queen’s Commerce reference"` against label `Queen's Commerce reference` is refused, and so is the reverse; `video-interview` against `video interview` is refused. Matching punctuation is accepted.
- **Effect for Sid:** he texts from an iPhone, which types the curly `’`, while models routinely emit `'`. Creating any item named for Queen's, St. Michael's or Western's fails the whole turn with the generic error.
- **Fix:** normalise apostrophes and dashes on both sides, or keep `mentions()` for containment and handle the L3 emoji case with a separate rule.
- **Test:** the four apostrophe permutations plus the hyphen case, keeping the round-2 `"Waterloo AIF ✅ official"` refusal as a control.

**M3. The prompt budget still overflows when the message names several programs.**
- **Where:** `:579-625` — the compact row is used only for programs the message does **not** name (`namedProgram`, `:580`).
- **Measured** against the 48,000-byte cap: 10 programs × 6 items reaches 47,956 bytes when the message names them all; 12 × 6 and the 128-item cap both fall back to ordinary chat. Naming no program stays at 23,046 / 26,428 / 37,832.
- **Effect for Sid:** the message most likely to name every program is him pasting his shortlist. That message silently becomes ordinary chat and saves nothing, with no explanation. Not a permanent lock, unlike round 2.
- **Fix:** expand at most the first two named programs, or retry once fully compact before falling back.
- **Test:** 12 programs × 6 items with a message naming all 12 — the structured prompt must stay ≤ 48,000 bytes and still carry every active `itemId`.

**M4. Forwarded or third-party text still records `submitted_by_sid`.** `JOINT_OWNER_SUBMISSION` and `REPORTED_OWNER_SUBMISSION` (`:30-31`) cover only "Ms. X and I …" and `asked|said|told`. Proven accepted: `"Mom says: I submitted the Western essay for you"`, `"From guidance: I uploaded your Western essay today"`, `"Hi Sid. I have uploaded your Western essay to OUAC. Ms. Lee"`. It is disclosed in `KNOWN_ISSUES.md` and a proper fix needs channel provenance, so it is not a blocker on its own — but the two new regexes are defeated by one word, so they read stronger than they are. Cheap partial: add `says|wrote|writes|sent me|forwarded`, and refuse `submitted_by_sid` when the naming clause says `your <item>` or `for you`.

**Low:**
- **L1.** `university-tracker-repository.ts:552` now throws `university_application_item_exists` instead of skipping, which `school-catchup-model.ts:620-623` turns into the generic failure — discarding the turn's program updates, requirements and dates. Round-2 L7 asked for a clear line or a reactivation mapping; neither is present. Map the duplicate to the existing item (reactivating if retired), or skip just that update and name it in the reply.
- **L2.** Retirements and reactivations still share `applicationStatusStatements` in plan order, so at 32 active items a plan listing the reactivation first aborts on `cap_reactivate` (`0024:91-103`) while the repository's final count passes. Sort retirements ahead of reactivations.
- **L3.** `0024` still lets a row keep a stale `source_url` and `admission_cycle` after un-verifying. The other three round-2 L6 gaps are closed. Add the clause to `state_consistent_update` and null them in the repository UPDATE.
- **L4.** `KNOWN_ISSUES.md:5-7` describes the mechanism broken by H1, and `:31-34` claims multiline owner reports fail closed, which is no longer true — `evidenceValue` (`:108-121`) accepts newlines and `"I submitted my Waterloo AIF\nwhat's next"` is accepted. Update both when H1 is fixed.

**Round-2 findings, confirmed fixed:** H1a (the submit rule now runs before the reactivation branch, `:439` before `:449`), H1b cross-item binding (`:437-438` plus `namedApplicationItems` at `:378`), H2 negated and cross-item retirement (`:455-459`, `retirementNegated` at `:418`, `bareDontNeedTargetsItem` at `:407`), M1 on the round-2 corpus (47/47 correct, all 14 previously-missed claims blocked), M2 verified dates (`:314-322`, `:335-343`), L2, L3, L4 and three of the four L6 trigger gaps. M3 and L5 are partly fixed as described above.

**What to do:** fix H1 and H2, then M1 and M2; M3, M4 and L1–L4 are your call to fix or record. Merge current main first. Then post a ready entry. Nothing was merged, deployed or applied.

— Claude Opus 5

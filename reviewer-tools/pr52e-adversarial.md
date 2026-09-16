# PR #52 round-5 verification re-review: university application checklist

**Verdict: changes requested — 2 High, 2 Medium, 4 Low.** H1(b), M1 and Lows 2–4 are genuinely
fixed and proven load-bearing. H1(a) is only half fixed — the pronoun still crosses a clause about
something else inside one sentence — and the reworked reply guard broke in **both** directions at
once: 4 external-action claims it blocked at `5f150b1` now pass, and 16 plausible benign replies
that passed at `5f150b1` are now refused.

- **Scope:** `origin/codex/r5-application-track-slice1` at `762e54b`; the only code commit since
  round 4 is `f1bb6ff`. Round-4 head `5f150b1`. Line refs at `762e54b`, relative to
  `apps/cloud-gateway/src/`.
- **Method:** read-only. `git archive` of `762e54b` and `5f150b1` into separate scratch trees;
  every probe run against **both**, so each claim below is a proven differential. Probes drove the
  real `parseOwnerUniversityPlan`, the real `SchoolCatchupModelAdapter`, and the real
  `UniversityTrackerRepository` over `0022`+`0024` on `node:sqlite`. No repo test suite was run.

---

## Round-4 findings: status

| Finding | Status | Evidence |
|---|---|---|
| **H1(a)** anaphora crosses sentences | **PARTLY FIXED** | `university-tracker-model.ts:467-492` walks each sentence with `carriesTarget`. All four disclosed inputs plus `"The Western essay is next. My mom and I submitted it."` are refused, and the four same-sentence controls still accept. But the flag only resets at a clause that names a *tracked* item or the target — see **High 2**. |
| **H1(b)** connective program names | **FIXED** | `clauseGroups` (`:145-196`) masks `itemNames(label, program)` (`:411`) before splitting; `evidenceNamesOnlyItem` and both whole-message fallbacks are gone (`:366` is now bare `splitDateClauses`). All 7 disclosed status cases and both date cases refused at `762e54b`; 6 status + 1 date controls still accept. |
| **M1** connective fallback all-or-nothing | **FIXED** | All four minimal pairs now behave identically for `"Arts and Science essay"` and `"Western essay"` (8/8 accept). |
| **H2** reply guard under-refusal | **PARTLY FIXED, regressed both ways** | All **11/11** disclosed claims blocked; the **16/16** round-3 benign replies pass; the round-2 47-reply corpus is **0 mismatches**; the 7 round-3 BLOCK controls stay blocked. But see **High 1** (4 new misses) and **Medium 1** (16 new false refusals). |
| **Low 2** deduped retired reactivation | **FIXED** | `university-tracker-repository.ts:568-571` throws instead of remapping. Proven e2e: after retiring, `"Add the Western reference"` is refused (`university_application_item_exists`) and the row stays `not_needed_by_sid`; it reactivated to `not_started` at `5f150b1`. Cost noted as **Low 2** below. |
| **Low 3** unverified INSERT metadata | **FIXED** | `0024_university_application_workflow.sql:44-49`. Proven on `node:sqlite`: unverified INSERT with `source_url` only, `admission_cycle` only, and both all abort at `762e54b`; **all three were accepted at `5f150b1`**; the clean control still inserts. |
| **Low 4** dedupe punctuation folding | **FIXED** | `repository:167-169` folds `['’ʼ\`]` and `\p{Pd}` like `containsLabel`. Proven e2e: the straight- and curly-apostrophe spellings of `"Queen's Commerce reference"` now collapse to one row (two rows at `5f150b1`). |
| **Low 1** silent active-duplicate skip | **RECORDED, reason is honest** | `repository:567` still `continue`s. The stated reason checks out: `applyOwnerPlan` is `Promise<void>` (`repository:363`) and the adapter only ever emits the model's reply or one fixed failure line (`school-catchup-model.ts:642-674`), so naming a skipped item really does need a new result contract. **But it was recorded only in `docs/AGENT_LOG.md`** — `KNOWN_ISSUES.md` still says "six deferred limits" and lists the same six. See **Low 3**. |

---

## New findings

### High 1 — The reworked reply guard stopped blocking 4 claims it blocked at `5f150b1` (proven)

- **Where:** `school/school-catchup-model.ts:276-286` — `hasFirstPersonExternalContact` splits the
  reply on `[,;.]` and requires the verb and the third-party target to land in the **same** piece.
  The old loose 40-character `sent|forwarded|shared … (to|with) THIRD_PARTY` alternative, which
  spanned commas, was deleted in this diff.
- **Proven** through the real adapter against both heads — blocked at `5f150b1`, **passing at
  `762e54b`**:
  `"I've sent your essay, as promised, to Ms. Chen."` ·
  `"I've forwarded your reference form, finally, to Ms. Chen."` ·
  `"I've shared your draft, this morning, with your teacher."` ·
  `"I've sent your transcript request; it went to the guidance office."`
  The isolating pair is the punctuation alone: `"I've forwarded your AIF to Ms. Chen."` and
  `"I've shared your essay with Ms. Chen."` are blocked at both heads.
- **Effect for the owner:** the same failure round-4 H2 was about, in the dangerous direction. Any
  Jarvis sentence that puts an aside or a second clause between the verb and the recipient escapes
  the guard. Sid reads "I've sent your transcript request; it went to the guidance office" and
  stops chasing a request that was never made.
- **Fix:** do not treat `,` as a clause boundary for this scan — split on `;`/`.`/newline only, and
  keep a bounded look-ahead (the old 40–96 characters) across commas; or scan the whole sentence
  after the verb and bound it by the next `;`/`.` rather than the next comma.
- **Test:** add the four replies above as BLOCK rows next to the existing 11, so the comma form and
  the no-comma form are both pinned.

### High 2 — H1(a) survives with a comma: the pronoun still crosses a clause about something else (proven end-to-end)

- **Where:** `university/university-tracker-model.ts:476-490`. `carriesTarget` is only cleared by a
  clause that `namedApplicationItems` resolves or that `namesApplicationItem` matches (`:484-487`).
  A clause about anything **not** in the tracker leaves the flag on, so the next `it`/`that` clause
  in that sentence still binds to the item named two clauses earlier.
- **Proven through the real parser → real repository → `0022`+`0024`:** with the Western essay at
  `drafting`, the turn
  `"The Western essay is next, the Common App is done and I submitted it."`
  **saves**, writes `item_status = submitted_by_sid`, and drops the item out of
  `listApplicationItemsByDueDate`. That is round-4's own disclosed input with a comma where it had a
  period. Same class, all accepted at `762e54b`:
  `"I'm drafting the Western essay, the Common App is done and I submitted it."` ·
  `"The Western essay is next, my Common App personal statement is finished and I submitted it."` ·
  `"The Western essay is next, band camp is over and I submitted it yesterday."` ·
  `"The Western essay is next, the Common App is open and I finished it."` (ready) ·
  `"…and I'm working on it."` (drafting) ·
  `"The Western essay is next, I quit the swim team, I'm not applying for it."` (retire) ·
  `"The Queen's scholarship is retired, the gym membership lapsed, I changed my mind, keep it."` (reactivate) ·
  `"UofT essay check, the band form bounced, I never submitted it."` (un-submit).
  The reset **does** work when the intervening clause names a tracked item
  (`"…, the Waterloo AIF is done and I submitted it."` → refused), when two items are named
  (`"The Western essay and the Western reference are next, and I submitted it."` → refused), when
  the `it` clause comes first, and across `.`/`;`. So the hole is exactly "clause about something
  Jarvis doesn't track".
- **Effect for the owner:** unchanged from round 4 — Sid writes one sentence mentioning an
  application item and then something else he did, and the item silently flips to submitted,
  ready, drafting, retired or reactivated. A wrong `submitted_by_sid` removes it from his morning
  digest and needs explicit correction wording to undo. Commas are more common than periods in the
  way he writes, so the surviving half is the likelier half.
- **Fix:** reset `carriesTarget` at any clause that introduces a new subject noun phrase, not only
  at one naming a tracked item — e.g. clear the flag on every clause that is not the target's
  naming clause and does not itself begin with the pronoun, so `it` only resolves when it is the
  **next** clause after the naming clause (`"The Western essay is next, and I submitted it."` still
  works; `"…, the Common App is done and I submitted it."` does not).
- **Test:** the nine inputs above as refusals, alongside the four same-sentence controls already in
  `university-application-workflow-model.test.ts:601-608`, plus a repository test asserting the D1
  row stays `drafting` for the comma form.

### Medium 1 — The restored bare verbs and same-clause scan refuse 16 plausible benign replies (proven)

- **Where:** `school/school-catchup-model.ts:52`
  (`applied\b(?!\s+your\s+feedback\b)|booked\b(?!\s+nothing\b)|put\s+in\b(?!\s+a\s+note\b)`) and
  `:276-286` (the third-party noun may now sit anywhere in the clause after the verb).
- **Proven** through the real adapter: 16 of 20 new benign replies are refused at `762e54b` and all
  16 pass at `5f150b1`. The three negative lookaheads are the three literal strings from the
  round-3 report, so any other object fails:
  `"I've applied your edits to the outline."` · `"I've applied your changes to the tracker."` ·
  `"I've applied your notes from last night."` · `"I applied the same structure to the second
  paragraph."` · `"I've applied a stricter word limit to the draft."` ·
  `"I've put in a placeholder due date until you confirm it."` ·
  `"I've put in two reminders for the Waterloo deadline."` ·
  `"I've put in the tracker that your teacher owes you a reference."` ·
  `"I booked no time for this; you decide when to write."` ·
  `"I've booked out nothing on your calendar."`
  And from the clause scan: `"I asked whether you want me to draft a note to your teacher."` ·
  `"I asked earlier if the reference came back from Ms. Chen."` ·
  `"I asked you to confirm the deadline with the university."` ·
  `"I told you the transcript is with the school, so chase it tomorrow."` ·
  `"I told you what to say to your counsellor."` ·
  `"I've requested nothing from the school on your behalf."`
  Minimal pairs: `"I've applied your feedback to the outline."`, `"I've put in a note about the
  Waterloo deadline."` and `"I booked nothing; only you can book the interview."` all pass, which
  isolates the whitelists as the cause.
- **Effect for the owner:** this is round-3's M1 again, and now it also refuses **denials**
  ("I've requested nothing from the school on your behalf") — the guard replaces the reply that
  says Jarvis did *not* act with a line implying it might have. Round 3 over-refused, round 4
  under-refused, round 5 does both.
- **Fix:** exempt by *shape*, not by literal string — require the object of
  `applied|put in|booked` to be external (an application, a form, a fee, a booking with a named
  party) rather than blacklisting every verb occurrence; and require the clause-scan target to be
  the recipient of the verb (no intervening `whether|if|you to|what to|nothing|not`).
- **Test:** add the 16 above as PASS rows to the guard table beside the 11 BLOCK rows from
  round 4.

### Medium 2 — A label containing a period is now unreachable on the status path everywhere (proven)

- **Where:** `clauseGroups` (`:150-166`) splits sentences on `[.;!?\r\n]` **before** masking
  `protectedPhrases`, so a dotted label is cut in half and no clause can name the item; with the
  whole-message fallback removed there is nothing left to rescue it.
- **Proven:** for an item labelled `"St. Michael's reference"` (a real UofT college name),
  `"I submitted the St. Michael's reference."` is refused at `762e54b` in **both** a plainly-named
  program and a connective-named one. At `5f150b1` the connective-program case was **accepted**
  (the `itemNameContainsConnector` fallback covered every item in that program), so this is a
  proven narrowing. The plain-program case was already broken at `5f150b1` — pre-existing. The
  *date* path is unaffected (accepted at both) because kind-only resolution rescues it.
- **Effect for the owner:** an item whose name carries an abbreviation dot can never be marked
  submitted, ready, drafting or retired — the same permanent-unreachability that round-3 H2 was
  about, for `.` instead of `and`, and Sid gets the generic tracker failure with no hint that
  renaming would work.
- **Fix:** mask `protectedPhrases` **before** the sentence split, not after, so a label's own
  punctuation cannot cut it.
- **Test:** `"I submitted the St. Michael's reference."` as an acceptance, in a program whose name
  has no connective.

---

## Low

1. **`JOINT_OWNER_SUBMISSION` still misses ordinary joint wording.** `:37` now catches `"Mom and
   I submitted…"` (accepted at `5f150b1`, refused at `762e54b` — the widening is load-bearing), but
   these still record `submitted_by_sid`: `"My parents and I submitted the Western essay."`
   (plural — `parent` is listed, `parents` fails the following `\s+and`), `"My sister and I…"`,
   `"My guidance counselor and I…"` (one-l spelling; only `counsellor` is listed), and
   `"My mom and I have submitted…"` (no `have` allowed between `i` and the verb). All four are
   pre-existing, none is newly broken. **Fix:** allow an optional `s`, the `-or` spelling, and
   `(?:have\s+|had\s+)?`. **Test:** the four as refusals.
2. **The Low-2 fix costs the whole turn.** `repository:568-571` throws, and
   `school-catchup-model.ts:672-674` discards the entire university plan and emits
   `"I couldn't update your university tracker."`. Proven e2e. Round-3 L7 called exactly this
   outcome "worse for Sid"; the model can only recover on a *later* turn using
   `inactiveApplicationItems`. **Fix:** map the duplicate to the retired `itemId` and re-run
   `supportsStatus` with `existingStatus = "not_needed_by_sid"` (the other option round 4 offered),
   so a genuine reactivation still saves. **Test:** `"Add the Western reference back, I need it
   after all"` accepts; the bare `"Add the Western reference"` refuses.
3. **Low 1's deferral is not in the durable list.** `KNOWN_ISSUES.md:3` still says "six deferred
   integration and presentation limits" and the six bullets are unchanged; the silent skip is
   recorded only in `docs/AGENT_LOG.md`, which is chronological and will not be read as current
   state. The reason itself is honest. **Fix:** add a seventh bullet. **Test:** none.
4. **Residual cross-clause misses in the reply guard.** Beyond the four regressions in High 1,
   these were already missed at `5f150b1` and still are: `"I've emailed your essay, at last, to Ms.
   Chen."`, `"I've reached out; your counsellor will send the transcript."`, `"I've emailed her
   already, so Ms. Chen has your essay."`, `"I've notified them; the school has your form now."`,
   `"I've asked for it, and your teacher said yes."`, `"I've sent it off, so the guidance office has
   your transcript request."`, `"I've requested it, and Ms. Chen will upload the reference."`,
   `"I've sent your reference form over, and Ms. Chen has it now."`. The common shape is a pronoun
   object plus the third party in the following clause. **Fix:** add a sentence-level rule pairing
   a first-person contact verb with a third-party noun anywhere later in the same sentence.
   **Test:** the eight as BLOCK rows.

---

## What I proved by execution vs by reading

- **Executed at both `762e54b` and `5f150b1`:** the round-2 47-reply corpus (0 mismatches at head),
  the 16 round-3 benign replies, the 7 round-3 BLOCK controls, the 11 round-4 disclosed claims,
  34 new replies; 57 + 24 + 10 parser cases over the round-two and conjunction snapshots, including
  all round-4 H1(a)/H1(b)/M1 inputs with their controls; one end-to-end run (real parser → real
  repository → `0022`+`0024` on `node:sqlite`) covering High 2, Low 2, Low 4 and the L1 skip; and a
  standalone `0024` INSERT probe for Low 3.
- **Reading only:** that `applyOwnerPlan` returns `Promise<void>` and the adapter has no receipt
  channel (the basis for judging Low 1's recorded reason honest), and the `KNOWN_ISSUES.md` gap.
- **Not re-audited:** anything in PR #52 outside the round-4 findings and the `f1bb6ff` diff. Lint,
  typecheck, the full suite, trigger mutations and the round-1 probes were run by the reviewer at
  `762e54b` and not repeated.

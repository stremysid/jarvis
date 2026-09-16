# PR #64 round-3 adversarial re-review — head 61bf0f2 (fix 593a88b, round 2 ebabd18)

**Verdict: do not merge.** Round-2 items: **3 fixed, 5 partial, 2 not fixed (B1, B2).** New findings in the fix: **3 High, 4 Medium, 2 Low.**

The reply guard is still a word list. It now uses a list of targets, a list of exemption words that count anywhere in a clause, and a rule that treats any 5+ letter word ending in -ed/-en as a completion. As a result it misses claims that main's guard caught, and it replaces ordinary school and university replies that main shows. The #52 checklist is now weaker than main. The new "got into" / "accepted me" offer shapes record offers from negated and wished-for statements. 0029 is unchanged and scope is clean.

**How I ran it.** Probes are in `scratchpad/pr64c/agent/`: `head/` is 61bf0f2, `base/` is main, and round 2 is imported from `../../pr64b/agent/head` (ebabd18). Run them with `node --experimental-transform-types --import ./register.mjs <script>`. The mutation run is in `scratchpad/pr64c/vt/` (a `git archive` of 61bf0f2, vitest 4.1.11 in a node environment, node:sqlite shim). The baseline there is **612/612** across the 11 model, repository, compatibility, migration, digest, digest-job and school test files. Nothing touched wrangler, a remote database or git state.

---

## Round-2 items

| # | Status | Evidence at 61bf0f2 |
|---|---|---|
| B1 | **NOT FIXED** (and weaker than main) | All 30 of `r2.mjs reply` are now replaced. My new set gets **54 of 72** past (`b1r3.mjs`), plus **18 of 25** school claims (`b1school.mjs`). **27 claims that main's guard replaces are now shown** (`cmp3.mjs`); see N-H1. End to end (`e2e3.mjs`), 7 of 7 reach Sid, e.g. "Great news about Waterloo! I went ahead and accepted it for you." and "Don't stress. I submitted your chem lab on D2L." The pre-model refusal is not anchored at the start: "I got my Waterloo offer. Can you accept it for me?" and "Hey Jarvis, can you…" refuse before the model. But "Would you mind emailing Ms. Lee…", "Please go and accept my Waterloo offer.", "Can you tell Ms Lee I'm applying…", "Can you apply to McMaster for me?" and "omg Waterloo said yes, accept it pls" all reach the model, and their false replies are shown. |
| B2 | **NOT FIXED** (worse than round 2) | The builder's six replies and the chem plan are shown. But **31 of 49** ordinary replies are replaced, against **2 on main** and **3 at round 2** (`b2r3.mjs`, `b2school.mjs`); see N-H2. **Known finding, extent:** 8 of 10 truthful save confirmations after a real save are replaced. Examples: "Logged the Waterloo offer. Congrats!", "I've marked your Western essay as submitted.", "Your Waterloo offer is now tracked.", "Nice work. The Waterloo AIF fee step is marked done.". So are "I've added the Western essay to your plan for Saturday." and "Got it, the Western essay is back to drafting.". Only confirmations that contain "tracker", "draft", "note" or "reminder" survive (`BENIGN_REPLY_CONTEXT`, `school-catchup-model.ts:45`). |
| S1 | **PARTIAL** | Fixed: the refusal path now uses `fallbackWithSaveFailure` (`:567`), so a refused update always ends with "I couldn't update your university tracker." and a "recorded" claim is removed first. Fixed: "Toronto instead of Waterloo" and "UW instead of Western" refuse in the parser and on the real repository (`repo2.mjs`). Fixed: sole-program binding works ("I got my Waterloo offer" is recorded). Broken: the question-back misfires, drops the rest of the turn without saying so, and cannot record the answer (N-M3). Broken: sole-program binding records a different program's offer (N-M2). |
| S2 | **FIXED** | Refused on every path, as on main: "My counsellor told Ms. Lee…", "The school told Mr. Chen…", and on the workflow offer and payment paths (`pr52w.mjs`). "I emailed Ms. Lee about the Ms Lee reference request…" is now accepted. Mutants U09 and U10 are killed. Residual: `Prof.` is not masked; that case is covered under N-H3. |
| S3 | **FIXED** | All 21 `m3cmp.mjs` messages pass. `m3e2e.mjs` shows 2 model calls each. Mutants S24, S25, S29 and S30 are killed. New over-refusal of pasted to-do lists: N-L2. |
| S4 | **PARTIAL** | The wish, dream and imagine forms of "I got an offer…" refuse. Drafts are stored as `Unverified draft text; …` (`university-tracker-model.ts:87, 226-237`) and left out of prompt state. All 9 round-2 invented-fact strings and all 7 ordinary draft strings are stored only inside that wrapper (`r2.mjs m5`). Broken: the new `got into` and `accepted me` shapes record "I hope/wish/dreamt Waterloo accepted me" and "Waterloo still hasn't accepted me" as offers (N-M1). Broken: they also let a model-written label carry a date into the digest (N-M4). Real offers with a lead-in word now refuse, visibly: "So I got an offer…", "Big news: I got an offer…", "Today I got an offer…" (`s14r3.mjs`). |
| N1 | **FIXED** | On the real repository, the open "Ms Lee reference request" stays in the digest after "I submitted the Western scholarship.", and the submission step still leaves (`repo2.mjs`). Mutants R01 and U26 are killed. U27 (prompt hides not-needed-parent steps) is unpinned. |
| N2 | **PARTIAL** | The six round-2 over-refusals are now accepted, matching main (`r2.mjs pr52`). But the checklist is now **stricter-than-main in reverse**: 9 inputs that main refuses are accepted (N-H3). The "no longer applying" strip (`:672`) is dead code (`:674`), because `NEGATION` no longer contains `no` (mutant U21 is equivalent). |
| N3 | **PARTIAL** | "ok" now reaches the model and gets the warning appended. Anything with a school word ("plan", "study", "class", "homework") is still blocked, so school catch-up stays locked. "Mark every University 3 step not needed." still gets only the too-large reply. Naming a program still narrows nothing, so the reply's advice cannot work (`m4.mjs`). Unlikely at realistic sizes (8×4×5×4 fits). |
| N4 | **PARTIAL** | Every guard the builder named is killed: prepared CONDITIONAL/RETRACTION (U20), done-NEGATION (X1), verified source (X2), program ambiguity (X3), per-clause HEARSAY (X4), `yet to` (U28), repository label/budget/item cap (R05, R04, U25) and the narrow 0029 catch (R06). Across **65 mutants of the new guards, 55 are killed and 10 survive**; 3 of the survivors are equivalent (U21; U23/R03 duplicate `evidence()`). The 7 real survivors: clause split on and/then/but (S13); accept/decline `me|that|from|in` lookahead (S28); "skip the question when the program is named" (S41); `DELEGATED_OWNER_ACTION` (U08); `containsLabel` title normalisation (U11); the `not` contrast marker (U13); not-needed parent hiding in prompt (U27). **Lost pin:** the forwarded/quoted guard (`:642`) was killed at round 2 and now survives (X6). Without it, "Forwarded message: I paid the Waterloo AIF fee for the Waterloo AIF." is accepted (`x6m.mjs`). Results: `vt/mutate3-results.txt`, `vt/mutate3b-results.txt`. |

---

## New findings

### High

**N-H1. The new reply guard misses false completion claims that main replaces, including school ones**
- **Where:** `apps/cloud-gateway/src/school/school-catchup-model.ts:38-48, 271-286`. Main's first-person action check was deleted. A clause is now checked only if it names a listed target (`EXTERNAL_REPLY_TARGET`, `:38`). Even then it is exempt if `ADVICE_OR_OWNER_REPORT` (`:46`: once/after/when/before/you can/you should/ask), `BENIGN_REPLY_OBJECT` or `BENIGN_REPLY_CONTEXT` appears **anywhere** in the clause. Clauses are split on and/then/but and on sentence ends, so a target in one clause and the verb in the next pass.
- **Proven** (`cmp3.mjs b1school.mjs`, `cmp3.mjs b1r3.mjs`). Main replaces all of these; round 3 shows them:
  - No listed target: "I submitted your chem lab on D2L.", "I handed in your math homework.", "I registered you for the SAT.", "I told your mom.", "I emailed Prof. Chen.", "I messaged the registrar."
  - Exemption word elsewhere in the clause: "I emailed your chem teacher after class.", "I paid the OUAC fee when you asked.", "I submitted your Waterloo AIF, so you can relax.", "I sent your transcript request to Western, you should hear back soon."
  - Also passing (round 2 replaced them): "I accepted your Waterloo offer before the deadline.", "Verified: your Waterloo offer is accepted.", "Great news about Waterloo! I went ahead and accepted it for you.", "Waterloo offer? Accepted."
  - Totals: 27 main-caught claims are now shown, 35 against round 2. End to end, 7 of 7 are shown to Sid (`e2e3.mjs`).
- **Effect for Sid:** he asks about a lab due tonight and Jarvis says it submitted it. It didn't. Or Jarvis says it accepted his Waterloo offer. This is the exact harm B1 was meant to close, and it's now worse than what is merged.
- **Fix:** keep main's `FIRST_PERSON_ACTION_CLAIM` and `FALSE_EXTERNAL_COMPLETIONS` as a floor that no exemption can override. Any exemption must govern the verb: "once/after/when" must open the clause containing the verb, not appear anywhere in it. Don't split on and/then/but for exemptions. Pin main's caught list, `b1r3.mjs` and `b1school.mjs` as must-replace, with a test that main-caught ⊆ round-3-caught.

**N-H2. The guard replaces ordinary school and university replies that main shows**
- **Where:** same file. `COMPLETED_OR_CHANGED` (`:42`) treats any word of 5+ letters ending in -ed/-en as a completion: Queen('s), seven, often, given, extended, required, recommended, learned, posted, marked. `EXTERNAL_STATE` (`:43`) treats "is/are/has … in/now/already/just" as a state claim. Either one plus any school name or "teacher/essay/form/request" replaces the whole reply.
- **Proven** (`b2r3.mjs`, `b2school.mjs`, `e2e3.mjs`). **31 of 49** are replaced at round 3, against 2 on main and 3 at round 2, for example:
  - "Your Waterloo AIF is due in 12 days, so start the short answers this weekend."
  - "Queen's Computing is a strong program, and it's worth a look."
  - "Waterloo interviews are often in March."
  - "The Western essay is already strong; tighten the second paragraph."
  - "Checklist for the Waterloo AIF: answer the seven questions, proofread, then submit it yourself on the portal."
  - "Your teacher posted the chem quiz date on D2L: it's Friday."
  - "Ms. Chen extended the lab deadline to Friday, so do stoichiometry tonight."
  - "Mr. Patel marked your lab and you got an 85."
  - "Your teacher returned the English essay with comments."

  End to end, Sid asks "When is my Waterloo AIF due?" and sees "I can't do or confirm that action…".
- **Effect for Sid:** every owner Telegram reply that is not a study-coach practice turn goes through this guard (`index.ts:123-146`, `study-coach-model.ts:378-433`). Half of his ordinary school and university questions get a refusal about an action he never asked for.
- **Fix:** remove the generic `-ed/-en` rule and the bare `is … in/now/already/just` rule. Check completion only when an action verb has an external object: first person, agentless, or passive with that object. Pin `b2r3.mjs` and `b2school.mjs` as must-show, and `b1*` as must-replace.

**N-H3. PR #52's submission checklist is now weaker than main: someone else's report, or "wait, not sure", marks the essay submitted**
- **Where:** `apps/cloud-gateway/src/university/university-tracker-model.ts`.
  - `:52-55`: `THIRD_PARTY_REPORTED_OWNER_ACTION` only matches mom/dad/teacher/counsellor/referee/guidance/school/Mr/Ms/Dr. Main's `REPORTED_OWNER_SUBMISSION` matched any reporter.
  - `:32`: `HEARSAY` lost `told`.
  - `:35`: `RETRACTION` lost `actually` and `wait`.
  - These are used for `submitted_by_sid` at `:691-694`.
- **Proven:** `n2r3.mjs` and `prof.mjs`, then the real repository (`repo3.mjs`). Each is accepted at round 3 and refused on main (all but the `Prof.` case also refuse at round 2):
  - "My sister told me I submitted the Western essay."
  - "Priya told me I submitted the Western essay."
  - "My coach told me I submitted the Western essay."
  - "My brother wrote that I submitted the Western essay."
  - "My friend sent me a text saying I submitted the Western essay."
  - "Grandma asked me whether I submitted the Western essay."
  - "My counsellor told Prof. Chen I submitted the Western essay."
  - "I submitted the Western essay. Wait, I'm not sure it uploaded."
  - "I submitted the Western essay. Actually, let me check the portal first."

  On the real repository, the Western essay becomes `submitted_by_sid` and leaves the digest.
- **Effect for Sid:** an unsubmitted essay silently leaves his daily digest because someone else said so, or because he doubted himself. The builder's N2 test only checks that round 3 is at least as permissive as main, not at least as strict.
- **Fix:** restore main's reporter-agnostic reported-speech pattern (masking titles, adding `Prof.`) and `actually`/`wait` for `submitted_by_sid`. Keep the round-2 N2 carve-outs as the only relaxations. Add a "#52 at least as strict as main" test with these 9 inputs.

### Medium

**N-M1. The new `got into` / `accepted me` offer shapes record wished-for and negated offers**
- **Where:** `university-tracker-model.ts:70`, where `OWNER_OFFERED` gains `^(?:word\s+){1,6}accepted\s+me` and `i got into`. The shape is anchored at clause start, so the prefix before the action is empty. That skips `claimMustStartClause` and the prefix-only hedge check (`:649-654`). `OFFER_NEGATION` (`:34`) has no `hasn't`, `never` or `don't`.
- **Proven** (`s14r3.mjs`, then `repo3.mjs` on the real repository). Round 2 refuses all of these; round 3 records `owner_reported_offered`:
  - "Waterloo still hasn't accepted me yet."
  - "Waterloo never accepted me."
  - "I hope Waterloo accepted me."
  - "I wish Waterloo accepted me."
  - "I dreamt Waterloo accepted me."
  - "Imagine Waterloo accepted me."
  - "I got into the Waterloo open house."
  - "I got into Waterloo's waitlist."

  "Waterloo still hasn't accepted me." is stored, and the repository lists "University of Waterloo Computer Science: offer [owner_reported_offered]".
- **Effect for Sid:** he says Waterloo hasn't answered, and his digest shows a Waterloo offer. It needs the model to emit the update, but the parser is supposed to be the backstop.
- **Fix:** accept `accepted me` only as `^<tracked alias>\s+(?:just\s+)?accepted\s+me\b`. Accept `got into` only when a tracked alias or program follows directly. Apply `OWNER_HEDGE` and `NEGATION` to the whole clause for these shapes. Pin the 8 inputs.

**N-M2. Sole-program binding records an offer for a different program at that school**
- **Where:** `university-tracker-model.ts:868`. `if (programsAtSchool.length === 1) return true;` ignores any other program the clause names.
- **Proven** (`s14r3.mjs`, `e2e3.mjs`, `repo3.mjs`). Only Waterloo Computer Science is tracked; round 2 refuses each of these:
  - "I got a Waterloo Math offer." is recorded as the Computer Science offer, and the repository lists "University of Waterloo Computer Science: offer".
  - "I got an offer from Waterloo for Software Engineering." and "Waterloo accepted me into Mathematical Physics." are recorded the same way.
- **Effect for Sid:** Waterloo often makes alternate-program offers. His tracker would say he got into Computer Science when he didn't.
- **Fix:** bind by school alone only when the clause names no program-like words outside the alias (no "for X" and no "<X> offer"). Otherwise refuse, or ask "Is this for Computer Science?". Pin the three inputs.

**N-M3. The program question-back misfires, drops the rest of the turn without saying so, and its natural answer can't be recorded**
- **Where:** `school-catchup-model.ts:345-359`, called before the model at `:660-665`. The trigger is only `/\bi\s+(?:(?:have|just)\s+)?(?:got|received)\b.{0,64}\boffer\b/`, with no negation, hedge or hearsay check.
- **Proven** (`e2e3.mjs`, Waterloo with two programs). No model call; Sid sees only "Which Waterloo program — Computer Science or Software Engineering?" for:
  - "I got no offer from Waterloo yet :("
  - "I got rejected by Waterloo, no offer."
  - "My friend asked if I got an offer from Waterloo yet"
  - "I got my Waterloo offer and I finished the chem lab, plan my night" (no plan, no lab update, and nothing says so).

  Answering the question with "Computer Science" saves nothing, and Sid gets "Congrats!\n\nI couldn't update your university tracker.", because the offer evidence must be in the same message.
- **Effect for Sid:** Jarvis asks which program he got into right after he says he was rejected. When he answers, it fails, and it never says to retype the full sentence. Anything else in that message is lost.
- **Fix:**
  - Gate the question on the same direct-claim check used for offers (negation, hedge, hearsay, clause start).
  - Only intercept when the message has no other request, or run the turn and append the question.
  - Make the question say nothing was saved and give the exact sentence to send, or bind a one-line program answer to the pending question.

**N-M4. For a new offer row, the model can write any label, and labels may now carry dates and "confirmed"**
- **Where:**
  - `university-tracker-model.ts:1152-1153`: a new offer row skips `containsLabel(ownerMessage, label)` when the message contains "got into" or "accepted me".
  - `:892-893`: the same skip for target clauses.
  - `:213-218`: `isWorkflowLabelSafe` dropped the round-2 date and verification check, keeping only `LABEL_METADATA` and "deadline/due + today/tomorrow/next week".
- **Proven** (`label3.mjs`, `label3b.mjs`, real repository). Sid says "I got into Waterloo!" (or "Waterloo accepted me"), and the model labels the row "Waterloo offer (confirmed, reply by June 1)". Round 3 stores it, and the repository lists "University of Waterloo Computer Science: Waterloo offer (confirmed, reply by June 1) [owner_reported_offered] due=none". Round 2 refuses both. `isWorkflowLabelSafe("Western essay due Jan 15")` is now ok.
- **Effect for Sid:** a response date he never gave appears in his digest as "confirmed", and it goes back into the model's tracker state. This is the invented-date harm S4 was meant to prevent.
- **Fix:** for "got into" / "accepted me", use a fixed label ("<University> offer") instead of the model's. Restore the date and verification refusal for labels, including "by <month> <day>".

### Low

**N-L1. Offer-condition claims ignore "haven't" and "didn't"**
- **Where:** `university-tracker-model.ts:980`. `negationPattern` is `OFFER_NEGATION` for every `offer*` kind, including `offer_condition` and `offer_response`.
- **Proven** (`n2r3.mjs`). Each is recorded as `owner_reported_satisfied`; round 2 refuses them:
  - "I completed the Waterloo condition form but haven't submitted it."
  - "I met the Waterloo condition in math but didn't in chem."
  - "I met with my counsellor about the Waterloo condition and I haven't met it yet."
- **Effect for Sid:** a conditional offer shows its condition as met while it isn't.
- **Fix:** use `OFFER_NEGATION` only for kind `offer`, and keep `NEGATION` for conditions and responses.

**N-L2. The pre-model refusal now blocks pasted to-do lists**
- **Where:** `school-catchup-model.ts:116-123`. The sentence split treats "1." and each line as a sentence start.
- **Proven** (`s3r3.mjs`). Refused before the model at round 3, passed at round 2:
  - "Here's my to-do list:\n1. Email Ms Lee about the reference\n2. Finish chem lab"
  - "Things I have to do:\nEmail Ms Lee\nPay the OUAC fee\nStudy chem"
  - "Here are my tasks, can you order it by due date?"
- **Effect for Sid:** he asks for help planning his list and gets "I can't do or confirm that action…".
- **Fix:** skip list items (numbered, bulleted, or lines after "list:" / "to do:"), and drop bare `order it`. The reply guard, once N-H1 is fixed, is the boundary.

---

## Checked and sound
- **0029 and scope:** 0029 has zero diff since round 1 (3b267b9). The fix commit changes no digest, jobs, `index.ts` or KNOWN_ISSUES file. The PR diff touches nothing under `voice/**` or `calls/**`, and neither `D1ContextRetriever` nor `production-runtime.ts`.
- **Round-2 inputs:** all 30 `r2.mjs` reply claims are replaced. All 21 S3 false positives pass. Every S2 titled-name input refuses. Contrasted Toronto and UW refuse on the real repository. The M2 contact-step variants (mom, assistant) refuse.
- **Visible refusal path:** `fallbackWithSaveFailure` checks `PLAN_SAVE_COMPLETIONS` before the guard and always appends the no-save line (S44, S45 and S46 killed).
- **Drafts:** stored only wrapped, idempotently. `preparedDetails` is not in prompt state and is not shown by the digest. The repository re-wraps and re-checks the per-plan budget (R02, R04 and U25 killed).
- **N1:** digest SQL and prompt hide only submission and upload steps under a submitted parent.
- **Mutation:** 55 of 65 new-guard mutants are killed, and every guard the builder named is killed. Baseline 612/612.

## Unverified
- How often a real model writes the N-H1 claims, the N-H2 replies, or the offer updates in N-M1, N-M2 and N-M4. All runs used a fake model.
- Workers pool and real D1. I used node plus the node:sqlite shim, and did not run the full suite, lint or typecheck.
- Non-English replies: 3 of 3 French, Spanish and German acceptance claims pass the guard. That is low relevance unless Sid writes in French.
- The sentence-split speculation limit: "I had a dream. I got an offer from Waterloo for Computer Science." is recorded at rounds 2 and 3. A clause-local rule can't catch this.

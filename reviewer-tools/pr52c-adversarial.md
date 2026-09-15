# PR #52 round-3 verification re-review: university application checklist

**Verdict: changes requested — 2 High, 4 Medium, 4 Low.** The round-2 defects are genuinely
fixed in code (not just tested), but the fix diff breaks two paths Sid will hit immediately.

- **Scope:** `origin/codex/r5-application-track-slice1` at `12a7bbf`. Only `60d3672` is code;
  `7e4abc0` is a docs merge and `12a7bbf` an AGENT_LOG entry. Round-2 head was `5e1a2ed`.
- **Method:** read-only. `git archive 12a7bbf` into a scratchpad tree, then the round-2 probe
  harness (`reviewer-tools/pr52/round2/`) re-pointed at the new tree, plus four new probes.
  Everything marked *proven* was executed against the PR's real modules; no repo test run.
- Line references are at `12a7bbf`, relative to `apps/cloud-gateway/src/`.

---

## Round-2 findings: status

| Finding | Status | Deciding file:line / evidence |
|---|---|---|
| **H1a** retired → submitted via REACTIVATION | **FIXED** | `university/university-tracker-model.ts:439` — the `submitted_by_sid` rule now runs first, before the `not_needed_by_sid` branch at `:449`, so the reactivation path can no longer return `true` for a submission. Proven: "Keep the Queen's scholarship", "I need the Queen's scholarship after all", "Don't restore the Queen's scholarship, I never submitted it" all refused (parser + end-to-end through the repository and `0024`). |
| **H1b** message-wide item/submission binding | **PARTLY FIXED** | Cross-item half fixed: `:437-438` filters `clauses(evidence, true)` through `clauseNamesOnlyItem`, and `namedApplicationItems` (`:378`) refuses when a clause names more than one snapshot item. Proven refused: the round-2 cross-item set plus `"Waterloo AIF: submitted; Western essay: not yet"`, `"Western essay: I submitted the Waterloo AIF"`, and the newline and dash variants. **Attribution half not fixed** — see Medium 4. |
| **H2** negated / cross-item retirement | **FIXED** | `:455-459` — `retirementNegated` (`:418`) strips the retirement wording then applies `NEGATION`, and `bareDontNeedTargetsItem` (`:407`) requires the bare "don't need" clause to end at the label. Proven: all five round-2 inputs refused, both legitimate controls still accepted, and the reactivation direction refuses "Don't restore…" / "I'm not going ahead…". |
| **M1** ordinary-reply guard | **FIXED for the round-2 corpus, REGRESSED elsewhere** | All 47 round-2 replies now classify correctly (0 mismatches, proven through the real `SchoolCatchupModelAdapter`), and all 14 previously-missed claims are blocked. But the widened patterns block 16/16 new plausible benign replies — see **Medium 1**. |
| **M2** question/hearsay/cross-item replaces a verified date | **FIXED** | `:318-322` requires whole-message evidence with no `CONDITIONAL_OR_QUESTION` and no `HEARSAY` before an existing date may change; `:314-317` requires a clause that both supports the date and names only that item; `:335-343` re-applies the stored verification when the date is restated unchanged. Proven: all five round-2 inputs refused, and `"The Waterloo AIF is due Feb 1, 2027 right"` now returns `state:"verified"` with the original URL and cycle intact. |
| **M3** active state vs the 48,000-byte cap | **PARTLY FIXED** | `:596-625` sends a compact row for programs the message does not name. Measured: 12 programs × 6 items × (4 requirements + 2 dates) went from *fallback* to 26,428 bytes, and the 128-item cap to 28,328. But naming the programs re-expands them — see **Medium 3**. |
| **L6** `0024` trigger gaps | **FIXED (3 of 4)** | `persistence/migrations/0024_university_application_workflow.sql:163-182`. Proven on `node:sqlite`: swapping a verified row's `source_url`/`admission_cycle` aborts, backdating `verified_at` aborts, and leaving submitted with an *older* `source_turn_id` aborts. The fourth (stale `source_url`/`cycle` left on a row after un-verifying) still passes — see **Low 3**. |
| **L1** legitimate reports refused | **MOSTLY FIXED, new refusals added** | Proven accepted now: "I submitted the AIF", "Submitted my Waterloo AIF", "…What's next?", "…so I don't have to think about it anymore", "I began the Western essay today", "I'm done with the Western essay", "Western essay due Feb. 1, 2027", trailing whitespace (`:555` trims), and multiline. New refusals introduced: **High 2** and **Medium 2**. |
| **L2** correction path accepts conditionals/questions | **FIXED** | `:447-448` adds `!CONDITIONAL_OR_QUESTION` and the clause filter. All three round-2 inputs refused. |
| **L3** label metadata filter gaps | **FIXED** | `LABEL_METADATA` at `:34` now covers `Feb 1st`, `1 Feb`, `YYYY/MM/DD`; `containsLabel` (`:138`) rejects the emoji-decorated label; "May 5 info session essay" is accepted. All proven. |
| **L4** verified cycle met by the date's own year | **FIXED** | `evidenceSupportsCycle` (`:181`) requires a cycle *phrase*. Proven: `"Western essay due Feb 1, 2027 per https://uwo.ca/x"` with cycle `2027` is refused. This fix is the cause of **High 1**. |
| **L5** batch order aborts an accepted plan | **PARTLY FIXED** | `university/university-tracker-repository.ts:643` pushes all status updates before all inserts, so retire-then-insert works (proven on SQL: "batch order B" → ok). Reactivate-vs-retire order inside the status list is unchanged — see **Low 2**. |
| **L7** re-adding an existing item silently skipped | **PARTLY FIXED** | `repository:552` now throws `university_application_item_exists` instead of `continue`. No longer silent, but the outcome is worse for Sid — see **Low 1**. |
| **L8** merge interaction with PR #53 | **NOT RE-CHECKED** | Out of scope for this round. |

---

## New findings in the fix diff

### High 1 — A verified application due date can no longer be saved at all (proven)

- **Where:** `university/university-tracker-model.ts:150` (`clauses()` splits sentences on
  `[^.;!?\r\n]+`) feeding `:314` and `:323-326`, which require the source URL and the cycle
  phrase to sit inside **one clause**.
- **Proven:** every real URL contains a dot, so `clauses()` cuts it in half before the check.
  `"Waterloo AIF due Feb 1, 2027 per https://uwaterloo.ca/aif for the 2027 cycle"` splits at
  `https://uwaterloo.` and is refused with `university_application_model_date_invalid`. Same for
  URL-before-date, `www.`-prefixed, and cycle-phrase-first orderings. The isolating control — the
  identical message with a dotless host `https://uwaterloo/aif` — is **accepted**, so the sentence
  splitter is the cause. This also broke the round-2 end-to-end probe's own setup turn.
- **Effect for the owner:** the verified-deadline path is dead for application items. Every
  official Waterloo/OUAC deadline Sid pastes with its URL is refused, the whole turn's university
  plan is discarded, and he gets "I couldn't update your university tracker."
  (`school/school-catchup-model.ts:620-623`). Program-level dates are unaffected
  (`:205-217` still uses a whole-message check), so the failure looks arbitrary to him.
- **Fix:** do not sentence-split inside a URL. Either mask `https?://\S+` spans before
  `withoutMonthDots.match(...)` at `:150` and restore them, or keep the URL check
  whole-message (as `verification()` does at `:213`) and clause-bind only the date and the
  cycle phrase.
- **Test:** a positive parser test asserting `state:"verified"` survives for
  `"Waterloo AIF due Feb 1, 2027 per https://uwaterloo.ca/aif for the 2027 cycle"`. The suite
  has no such test today — the only verified-application-date test
  (`test/university/university-application-workflow-model.test.ts:700-715`) asserts a *rejection*,
  which is why 3,408/3,408 pass with this path dead.

### High 2 — Any program or item whose name contains "and", "but" or "then" is permanently unreachable (proven)

- **Where:** `university/university-tracker-model.ts:151-153` — `clauses()` splits on
  `\b(?:and|but|then)\b` (and on commas for the status path), then `:437` requires one clause to
  name the item.
- **Proven** against a snapshot holding UofT "Arts and Science" with item "Arts and Science essay":
  `"I submitted my Arts and Science essay."`, `"I'm working on the Arts and Science essay."`,
  `"I finished the Arts and Science essay."`, `"Skip the Arts and Science essay, it's a duplicate"`,
  `"The Arts and Science essay is due Feb 1, 2027"` and
  `"Add the Arts and Science supplement for UofT"` are **all refused**. The control
  `"I submitted my Western essay."` is accepted. Also proven:
  `"I finished the Western essay then submitted it"` is refused because the split puts the verb
  in a clause that names nothing.
- **Effect for the owner:** "Arts and Science" (UofT), "Arts and Business" and "Computing and
  Financial Management" (Waterloo) are ordinary Ontario program names. For any such program Sid
  can never mark an item submitted, retire it, set its date, or create it — every attempt returns
  the generic save-failure line with no hint that re-wording would work.
- **Fix:** split on connectives only when they are not inside a matched item label or program
  alias — e.g. mask every snapshot label and `programAliases(program)` occurrence in the message
  before splitting, then unmask; or fall back to the whole-message naming test when no clause
  names the item *and* only one snapshot item is named message-wide.
- **Test:** parser table over a "Arts and Science" program covering submit / drafting / ready /
  retire / date / create, plus `"I finished the X then submitted it"`.

### Medium 1 — The widened reply guard replaces 16/16 plausible benign replies with the refusal (proven)

- **Where:** `school/school-catchup-model.ts:37` (`THIRD_PARTY`), `:42`, `:47`
  (`PASSIVE_EXTERNAL_COMPLETION`), `:39` (new verbs), `:46` (`^\s*submitted\s*[!.]`).
- **Proven** through the real adapter, each with an isolating minimal pair:
  - `THIRD_PARTY` has no object requirement, so any of `teacher|referee|counsellor|guidance|school|university|OUAC` within 48 characters of a first-person verb blocks the reply:
    "I asked earlier which university you are aiming for." · "I asked earlier which school you are applying from." · "I told you the university deadline is Feb 1, so start now." · "I called it your school essay in the tracker." · "I asked about the transcript because your guidance office handles it, not you." · "I shared a checklist with you; your teacher may want a different one." · "I sent you the list above so your counsellor can review it with you."
    (Minimal pair: "…which **program** you are aiming for." passes.)
  - The passive alternative `is\s+(?:already|just|now)?\s*in\b` matches any "is in …":
    "Your essay is in good shape." · "Your personal statement is in your drafts folder." · "Your application is in progress, not submitted." · "Your transcript request is in your school's queue, so you still have to confirm it." · "Your Waterloo AIF is in the tracker as drafting."
    (Minimal pair: "Your essay looks good." passes.)
  - New verbs: "I've applied your feedback to the outline." (`applied`) · "I booked nothing; only you can book the interview." (`booked`) · "I've put in a note about the Waterloo deadline." (`put in`) · "Submitted. Is that what you meant?" (`^submitted[!.]`).
- **Effect for the owner:** this is a school assistant, so "school", "university", "teacher",
  "guidance" and "is in progress" are its everyday vocabulary. Sid sees "I can't confirm that
  action…" in place of ordinary answers, on the structured path as well as the fallback.
  The round-2 M1 false positives were cured; a comparable set was created.
- **Fix:** require the third-party noun to be the verb's **object** (immediately after the verb,
  optionally through a determiner) rather than anywhere within 48 characters; drop the bare
  `school|university` nouns or require `your …` plus a contact verb; restrict the passive
  `is in` alternative to `is (now )?in with <proper noun>`; drop `applied`/`booked`/`put in`
  unless followed by an external object; require `^Submitted[!.]` to be followed by a claim
  rather than a question.
- **Test:** extend the `it.each` guard table with all 16 replies above as PASS rows and keep the
  six BLOCK controls ("I've submitted your Waterloo AIF.", "I emailed your guidance office about
  the transcript.", "Your AIF is now in with Waterloo.", …).

### Medium 2 — `containsLabel` is punctuation-exact, so smart quotes and hyphens block new items (proven)

- **Where:** `university/university-tracker-model.ts:138-143` and `:521`. The old check used
  `mentions()` (`:133`), which folds all non-alphanumerics to spaces; `containsLabel` only
  collapses whitespace.
- **Proven:** a new item is refused when the message has the curly `’` and the label the straight
  `'` (`"Add the Queen’s Commerce reference"` + label `Queen's Commerce reference`), and in the
  reverse direction; and when the message has `video-interview` and the label `video interview`.
  Both directions with matching punctuation are accepted.
- **Effect for the owner:** Sid texts from an iPhone 16, where smart punctuation types `’`, while
  models routinely emit `'`. Creating any item whose name carries an apostrophe — Queen's,
  St. Michael's, Western's — fails the whole turn with the generic error.
- **Fix:** normalise apostrophes (`['’ʼ`]` → `'`) and dashes on both sides, or keep `mentions()`
  for the containment test and use a separate rule for the emoji/decoration case L3 was about
  (e.g. reject a label containing characters absent from the message).
- **Test:** the four apostrophe permutations plus the hyphen case, and keep the round-2
  `"Waterloo AIF ✅ official"` refusal as a control.

### Medium 3 — The prompt budget still blows past the cap when the message names several programs (proven by measurement)

- **Where:** `university/university-tracker-model.ts:579-625` — the compact row is used only for
  programs **not** named by the owner message (`namedProgram` at `:580`).
- **Measured** with the real adapter against the 48,000-byte cap:

  | State | Message names no program | Message names every program |
  |---|---|---|
  | 8 programs × 5 items, 4 req + 2 dates | 18,508 | 37,484 |
  | 10 × 6 | 23,046 | **47,956** |
  | 12 × 6 | 26,428 | **falls back to ordinary chat** |
  | 16 × 8 (128-item cap) | 37,832 | **falls back to ordinary chat** |

- **Effect for the owner:** the single message most likely to name every program is Sid pasting
  his shortlist ("my list: Waterloo, Western, Queen's, UofT, Mac, Guelph, …"). That message
  silently becomes ordinary chat and saves nothing. Unlike round 2 this is not a permanent lock —
  a message naming one program works — but Sid gets no explanation.
- **Fix:** cap how many programs are expanded (e.g. the first two named), or retry once with the
  fully compact state before falling back.
- **Test:** 12 programs × 6 items with 4 requirements and 2 dates, and a message naming all 12:
  the structured prompt must stay ≤ 48,000 bytes and still contain every active `itemId`.

### Medium 4 — Forwarded or third-party text still records `submitted_by_sid` (proven, carried from H1b)

- **Where:** `university/university-tracker-model.ts:30-31` — `JOINT_OWNER_SUBMISSION` covers only
  "Ms./Mr./Dr. X and I …", and `REPORTED_OWNER_SUBMISSION` only `asked|said|told`.
- **Proven accepted** against a snapshot: `"Hi Sid. I have uploaded your Western essay to OUAC. Ms. Lee"`,
  `"From guidance: I uploaded your Western essay today"`, `"Mom says: I submitted the Western essay for you"`
  (`says` is not in the regex; "for you" is caught by the reply guard but not the parser).
- **Effect for the owner:** an item Sid never submitted leaves the morning digest as "submitted by
  Sid", recoverable only if he notices and uses correction wording.
- **Status:** disclosed in `KNOWN_ISSUES.md:9-14` and it genuinely needs channel provenance to fix
  properly, so it is not a merge blocker on its own — but the two new regexes are defeated by one
  word, so they read as stronger than they are.
- **Fix (cheap partial):** add `says|wrote|writes|sent me|forwarded`, and refuse `submitted_by_sid`
  when the naming clause contains `your <item>` or `for you` (Sid does not call his own items "your").
- **Test:** the three inputs above as refusals, with `"I submitted my Western essay."` as control.

---

## Low

1. **`university_application_item_exists` turns a duplicate into a whole-turn failure.**
   `university/university-tracker-repository.ts:552` replaces round-2's silent `continue` with a
   throw, which `school/school-catchup-model.ts:620-623` converts into the generic
   "I couldn't update your university tracker" — discarding the turn's program updates,
   requirements, dates and every other application update. The dedupe key includes retired and
   submitted items, which the model cannot see unless the message names them
   (`model:606-613`). L7 asked for a clear line or a reactivation mapping; neither is present.
   **Fix:** map the duplicate to the existing item (reactivate if retired), or skip that one
   update and name it in the reply. **Test:** a repository test re-adding a retired label as
   `new-item-1` alongside a valid program update, asserting the program update still lands.
   *(Proven by reading the call path; not executed.)*

2. **Reactivate-before-retire plan order still aborts at the cap.** `repository:643` orders
   status updates before inserts, but retirements and reactivations share
   `applicationStatusStatements` in plan order. At 32 active items in one program, a plan listing
   the reactivation first hits `cap_reactivate`
   (`0024_university_application_workflow.sql:91-103`, proven to abort at 32 on `node:sqlite`)
   while the repository's final count passes. **Fix:** sort retirements ahead of reactivations
   within the status list. **Test:** a repository test at 32 active with the reactivation first.
   *(Estimate — the trigger behaviour is proven; the plan ordering is from reading.)*

3. **`0024` still lets a row keep a stale `source_url`/`admission_cycle` after un-verifying.**
   Proven on SQL: after `verification_state` goes to `unverified` the previous URL and cycle
   remain on the row. The other three L6 gaps are closed. **Fix:** add
   `NEW.verification_state = 'unverified' AND (NEW.source_url IS NOT NULL OR NEW.admission_cycle IS NOT NULL)`
   to `state_consistent_update`, and null them in the repository UPDATE. **Test:** a migration
   test asserting the abort.

4. **`KNOWN_ISSUES.md` now overstates and understates the code.** `:5-7` claims the fix "requires
   a verified application due date's URL and cycle in the same evidence" — that is the mechanism
   broken in High 1. `:31-34` claims "multiline owner reports fail closed and cannot record
   `submitted_by_sid`", which is no longer true: `evidenceValue` (`model:108-121`) accepts
   newlines, and `"I submitted my Waterloo AIF\nwhat's next"` is proven accepted. **Fix:** update
   both bullets when High 1 is fixed. **Test:** n/a (docs).

---

## What I proved by execution vs by reading

- **Executed:** the round-2 parser corpus (68 cases, 2 residual flags), the reply-guard corpus
  (47 cases, 0 flags) plus 22 new replies and 8 minimal pairs, the `0024` trigger matrix on
  `node:sqlite` (28 cases, diffed against the round-2 output), the prompt-budget measurements
  (10 configurations through the real `SchoolCatchupModelAdapter`), the partial end-to-end run
  confirming H1a/H1b/H2 refusals through the repository and `0024`, and every input quoted under
  High 1, High 2, Medium 1, Medium 2, Medium 3 and Medium 4.
- **Reading only (marked as estimates above):** Low 1's user-facing outcome and Low 2's plan
  ordering. No repo test suite was run in this round.

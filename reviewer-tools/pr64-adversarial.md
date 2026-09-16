# PR #64 adversarial review — head 3b267b9 (impl d70de10, base 010f93b)

**Verdict: do not merge. 2 High, 7 Medium, 5 Low.** Migration 0029 is sound. The problems are in the guard code. It lets a model reply claim Jarvis accepted an offer, ordered a transcript or contacted someone. It also lets a model-proposed offer or decision bind to the wrong university or to words that are not a decision.

All scripts are in `scratchpad/pr64/agent/`. They run the 3b267b9 sources directly: `node --experimental-transform-types --import ./register.mjs <script>`. Repository and trigger probes ran the real `UniversityTrackerRepository` on node:sqlite, after migrations 0001–0025 and then 0029. The only change to that database was dropping the 0005/0006 conversation-turn insert trigger, so turns could be seeded.

---

## High

### H1. Reply guard does not cover the actions this PR adds; the pre-model refusal misses ordinary phrasings
**Where:** `apps/cloud-gateway/src/school/school-catchup-model.ts:39` (FIRST_PERSON_ACTION_CLAIM verb list), `:43` (FALSE_EXTERNAL_COMPLETIONS), `:51` (PASSIVE_EXTERNAL_COMPLETION), `:72-78` (UNIVERSITY_EXECUTION_ACTION/REQUESTS), `:596`.
**Proven** (`guards2.mjs`, `adapter.mjs`):
- **Replies that reach Sid unchanged.** These pass `guardSchoolReply` at head, and at base too: the guard code is unchanged.
  - "Done! I accepted your Waterloo offer."
  - "I've declined the Western offer for you."
  - "I ordered your official transcript."
  - "I withdrew your Queen's application."
  - "I've created your OUAC account."
  - "I signed you up for the Waterloo portal."
  - "I wrote to Ms. Lee about your reference."
  - "I followed up with your counsellor."
  - "Your Waterloo offer has been accepted."
  - "Your transcript has been ordered."
  - "Your OUAC fee has been paid."
  - "I confirmed your spot at Waterloo."
- **Requests that still reach the model.** The pre-model refusal lets these through:
  - "Jarvis, accept Waterloo for me."
  - "Please decline Western."
  - "yes do it"
  - "pls submit it"
  - "can u submit my Waterloo AIF"
  - "Could you reach out to Ms. Lee?"
  - "Can you text my counsellor?"
  - "Can you let my counsellor know I'm applying?"
  - "Go ahead and order it."
- **End to end through `SchoolCatchupModelAdapter`.**
  - Sid: "Jarvis, accept Waterloo for me." Sid sees: "Done! I accepted your Waterloo offer."
  - Sid: "yes do it". Sid sees: "All set, I ordered your official transcript and it's on its way to Western."

The verb gaps existed before this PR. But this PR adds offer acceptance and decline, transcript ordering, sign-ups and contact steps. It also states in the prompt and AGENT_LOG that Jarvis cannot do these things, and that this is enforced in code. Nothing in code enforces it for replies.

**Effect for Sid:** Jarvis can tell him it accepted an offer or ordered his transcript. If he believes it, he won't do it himself on OUAC and could miss an acceptance or transcript deadline.

**Fix:**
- Add these to the first-person verb list, with no allow-list shapes: accepted, declined, withdrew/withdrawn, ordered, created/set up an account, confirmed, wrote to, followed up, pinged, reached.
- Add a "signed/registered you up" shape.
- Extend the passive pattern to cover offer, fee, account, spot and acceptance, and the verbs accepted, declined, ordered, paid, confirmed and withdrawn.
- Pin each shape with a named test.
- The pre-model refusal is a courtesy, not the boundary. Do not rely on it.

### H2. Offer and decision binding accepts a clause that names two universities, so one school's news is recorded on another
**Where:** `apps/cloud-gateway/src/university/university-tracker-model.ts:767-770`. `workflowTargetClauses` only requires that the clause names this program. It never checks that the clause names no other program. The same function is re-run by the repository at `university-tracker-repository.ts:963`.
**Proven** (`guards.mjs`, `repo.mjs` on the real repository with D1 shim, `accept.mjs`):
- **Cross-program offer.** Waterloo's "conditional offer" row is withdrawn. Sid says "I got a conditional offer from Western instead of Waterloo." The model update targets the Waterloo row with `owner_reported_offered`. The repository accepts it: Waterloo becomes offered at revision 3, and the digest lists "University of Waterloo: conditional offer [owner_reported_offered]".
- **New row on the wrong program.** "I got an offer from Western instead of Waterloo." creates a new offer on Waterloo.
- **Shared program name.** "I got a conditional offer from Western for Computer Science." binds to the Waterloo row when both programs are Computer Science. It also binds when Western is Medical Sciences, because "Computer Science" is a Waterloo alias.
- **Cross-program acceptance.** "I accepted my Western offer instead of the Waterloo offer response." records the Waterloo response as `owner_reported_accepted`.
- **Control.** A comma split ("…from Western, not Waterloo.") is refused.

**Effect for Sid:** Jarvis can record that Waterloo made or accepted an offer when it was Western, then show that in the morning digest. The "accepted" case also drops the Waterloo item out of the digest.

**Fix:**
- For offer, offer_condition and offer_response, refuse any clause that names another program's alias.
- Refuse a clause whose only program match is a program name shared with another tracked program.
- Pin with the inputs above.

---

## Medium

### M1. The decision guard accepts statements that are not Sid reporting a decision
**Where:** `university-tracker-model.ts:33` (NEGATION has no `no`), `:59` (OWNER_OFFERED allows 4 arbitrary words), `:61` and `:793` (rejected has no negation or hedge check), `:66` (accepted allows `.{0,32}`). The PR #52 "for you" possession check (`:587`) is not reused.
**Proven** (`guards.mjs`, `accept.mjs`, `repo.mjs`). The table shows what is recorded after the parser runs; the repository also accepted the first row.

| Sid says | Recorded |
|---|---|
| "I got no offer from Western." | owner_reported_offered |
| "I have no offer from Waterloo yet." | owner_reported_offered |
| "I have yet to get an offer from Waterloo." | owner_reported_offered |
| "I'm scared I got rejected by Waterloo." | owner_reported_rejected |
| "I feel like I got rejected by Waterloo." | owner_reported_rejected |
| "I accepted that there's no Waterloo offer response coming." | owner_reported_accepted |
| "Dear Sid, I have an offer of admission for you from Waterloo." (forwarded) | owner_reported_offered |

**Effect for Sid:** a worry or a "no offer yet" can be stored as an offer or a rejection. Rejected and accepted are terminal, so the item silently leaves the digest.

**Fix:**
- Add `no` and `yet to` to the offer negation, plus hedges (scared, worried, feel like, pretty sure, hope).
- Apply negation and hedge checks to rejected, withdrawn and accepted.
- Require the offer/admission noun as the object of accepted/declined, not within 32 characters.
- Reuse the PR #52 `for you` check.

### M2. Step completion drops the whole-message checks PR #52 required for `submitted_by_sid`
**Where:** `university-tracker-model.ts:781-788`. It checks only per-clause CONDITIONAL, HEARSAY (thinks/heard/said/might/maybe), RETRACTION and NEGATION. Compare `:583-587`, which also checks JOINT_OWNER_SUBMISSION, REPORTED_OWNER_SUBMISSION, whole-message RETRACTION and third-party possession.
**Proven** (`guards.mjs`, with the PR #52 function on the same shapes in `guards2.mjs`):

| Sid says | Workflow step (this PR) | PR #52 application item |
|---|---|---|
| "Mom told me I paid the Waterloo AIF fee." | owner_reported_done | — |
| "My counsellor told me I submitted the Western essay submission for the Western essay." | owner_reported_done | refused |
| "Mom and I paid the Waterloo AIF fee." | owner_reported_done | refused (joint) |
| "I submitted the Western essay submission for the Western essay. Actually no, it failed." | owner_reported_done | refused |
| "I emailed my mom about the Ms Lee reference request for the Western reference." | contact step done | — |

**Effect for Sid:** a step he didn't do, or took back in the same message, is marked done and disappears from the digest.

**Fix:**
- Run REPORTED (add told/texted/emailed me), JOINT and whole-message RETRACTION on every `owner_reported_*` status.
- For contact_step, require the contacted person to be the object of the verb.

### M3. The pre-model "execution" refusal blocks ordinary school and university messages
**Where:** `school-catchup-model.ts:72-78` and `:596`. It runs on every Telegram turn, before the school or university snapshot is read.
**Proven** (`guards2.mjs`, and end to end in `refuse.mjs` with model calls = 0). Each message below gets "I can't do or confirm that action…" and nothing is recorded:
- "Email from Western says my application is complete."
- "Message from Ms. Lee: the chem test moved to Friday."
- "Upload deadline for the Western supplement is January 15, 2027."
- "I'll finish my essay tonight and then submit it tomorrow."
- "I need to study for chem and then email my teacher about the extension."
- "Can you make a checklist and email template for my reference request?" — a draft request the docstring promises to allow.
- "Could you draft the steps and message for Ms. Lee?"
- "Pay attention, my Waterloo AIF is due Friday."
- "Submit button on OUAC is greyed out, what should I check?"

**Effect for Sid:** common messages about school catch-up, his top priority, and about deadlines get a refusal instead of being tracked.

**Fix:**
- Anchor the requests on the second person (you/Jarvis) plus an imperative verb only.
- Drop the bare leading-noun and "…and then ACTION" forms, or restrict them to an explicit second-person request.
- Test the false-positive list above.

### M4. Done steps never leave the model prompt, so the tracker switches itself off inside the declared caps
**Where:** `university-tracker-model.ts:1086`. Every workflow item is emitted, whereas application items are filtered at `:1060`. Also `school-catchup-model.ts:635-641` (48 KB cap leads to a plain ordinary reply), `university-tracker-repository.ts:38-39` (64/128 caps), and the 0029 cap trigger with no delete.
**Proven** (`size.mjs`, real adapter):

| State | Compact university JSON | Structured tracking |
|---|---|---|
| 8 programs × 4 apps × 14 done steps × 4 requirements | 40 KB | on |
| 10 × 5 × 12 done steps × 6 | 48.6 KB | **off** |
| 12 × 6 × 10 done steps × 6 | 53.6 KB | **off** |
| 16 programs × 8 apps × 8 requirements, no steps (the most the tables allowed before this PR) | 36.9 KB | on |

**Effect for Sid:** once about 110–120 steps have ever existed, every Telegram turn goes to the ordinary reply path, school included. It shows no "couldn't update" line and never recovers: rows can't be deleted, and done steps stay in the prompt.

**Fix:**
- Omit terminal workflow statuses from `universityStateJson`, as application items already are, unless the message names them.
- Set the item cap from a measured prompt budget.
- On overflow, show a fixed "tracker too large" line instead of silently switching off.

### M5. `preparedDetails` stores model-invented dates, requirements and fees with no provenance
**Where:** `university-tracker-model.ts:916-918` and repository `:981`. Only CURRENCY_AMOUNT (`:68`) is checked. The details go back to the model as tracker state at `:1086`.
**Proven** (`size.mjs`, real Redactor in `redact.mjs`). The parser stored each of these as a checklist for "Draft a checklist for the Waterloo AIF fee for the Waterloo AIF.":
- "Checklist: the Waterloo AIF deadline is February 1, 2027 (verified). Waterloo requires two references and a 90% average."
- "Pay the OUAC fee of 156 bucks before you submit."
- "Fee: 156.00 due at submission."
- "Pay one hundred fifty-six dollars."

**Effect for Sid:** a made-up deadline marked "(verified)", or a made-up requirement, is saved and can be repeated back to him later as tracker fact. The claim that "fee amounts are deliberately not stored" is also not true.

**Fix:** reject dates, "verified", grade or percentage requirements and number-plus-fee patterns in `preparedDetails`, or store and display it wrapped as "unverified draft". Widen the fee pattern (bucks, bare decimals near fee/cost/pay, spelled-out amounts).

### M6. Steps go stale: after Sid reports an application item submitted, its step stays "prepared" in the digest forever
**Where:** `university-tracker-model.ts:754-771` requires both literal labels in one clause. The digest query is at `university-tracker-repository.ts:522-548`, with no link to the application item's status.
**Proven** (`stale.mjs`, real repository): step "Western essay submission" is prepared. Sid says "I submitted the Western essay." The application item becomes `submitted_by_sid`, and the step update from the same message is refused. The digest still lists "Western essay submission [prepared]".
**Effect for Sid:** the digest keeps telling him to submit something he already submitted. Normal phrasing almost never contains both labels.
**Fix:** hide or auto-close steps whose application item is submitted or not needed. Or accept the application item's label as naming its single linked step of the matching kind.

### M7. The core binding guards are not pinned by any test
**Where:** `university-tracker-model.ts:754` (namesOnlyWorkflow), `:767-770` (offer program and no-application checks), `:781`, `:786-797`, and the deadline checks in `workflowDeadline`.
**Proven** (`mutate.mjs`): the base run passes all 11 transcribed inputs from `university-application-details-model.test.ts`. Each of these deletions leaves every input with its expected result:
- namesOnlyWorkflow
- offer names its program
- offer names no application item
- CONDITIONAL_OR_QUESTION
- RETRACTION
- NEGATION on done
- NEGATION on offered
- prepared excludes not-done
- existing preparedDetails needs a request
- model workflowStatusAllowed
- application item program match
- verified-deadline source in clause
- deadline date in target clause

By reading, the repository and integration tests don't exercise these either. In 0029 (by reading the migration tests), only the 64-per-program half of the cap, the other-principal half of the owner-turn trigger and one kind/status pair are tested. The 128-per-principal cap, `channel = 'telegram'` and the `created_at` ordering predicates are unpinned.

**Effect for Sid:** a later edit can silently remove the protections behind H2, M1 and M2.

**Fix:** add a named test per guard. The H2, M1 and M2 inputs make good ones.

---

## Low

### L1. The digest shows timed deadlines as a raw UTC instant labelled with the Toronto zone
**Where:** `digest-composer.ts:224-228`, pinned by `test/digest/digest-composer.test.ts:172`.
**Proven** (`adapter.mjs`): a step due 11:59 PM Toronto on Jan 15 renders as "due 2027-01-16T04:59:00.000Z America/Toronto (unverified)".
**Effect for Sid:** he could read the date as Jan 16, a day late. Reachability is low: `workflowDeadline` (`:855`) only accepts an instant Sid literally typed in ISO-UTC form.
**Fix:** format with `Intl.DateTimeFormat` in the digest timezone, for example "Jan 15, 11:59 PM ET". Accept stated local times rather than requiring ISO-UTC text.

### L2. Workflow labels reach the digest without the PR #52 label checks
**Where:** `university-tracker-model.ts:915` and `:954`. LABEL_METADATA (`:665`) isn't applied, and the real Redactor passes emails and phone numbers (`redact.mjs`).
**Effect for Sid:** a label like "Ms Lee reference lee@tdsb.on.ca" or "AIF submission Jan 15 verified" prints daily in the digest. The label must come from his own words, so this is not an invented-fact risk.
**Fix:** apply LABEL_METADATA, a fee check and an email/phone check to workflow labels.

### L3. Merging before 0029 is applied switches off school tracking too
**Where:** `university-tracker-repository.ts:431` (snapshot now joins the 0029 tables), `school-catchup-model.ts:625` (Promise.all with the school snapshot, with a catch that falls back to an ordinary reply).
**Proven:** by reading.
**Effect for Sid:** if this code deploys before Sid applies 0029, Jarvis stops recording school and university updates with no warning. The digest does show a gap line.
**Fix:** state the migrate-before-deploy order in the PR and runbook, or make the workflow read fail soft with an empty list.

### L4. A step freezes permanently at 64 revisions
**Where:** `university-tracker-repository.ts:1033`, plus the dedupe key that blocks a replacement.
**Proven:** by reading.
**Effect for Sid:** repeated draft edits on one step eventually make every turn that touches it fail with "couldn't update your university tracker", and there is no way out.
**Fix:** let a new item be created when the old one is `not_needed_by_sid`, or give draft text its own table.

### L5. A legal plan can exceed the model JSON cap
**Where:** `school-catchup-model.ts:19` (32,000 characters) against 16 updates × 2,048-byte `preparedDetails`. `collectJson` at `:651` sits outside the try block.
**Proven:** by reading.
**Effect for Sid:** "draft all my reference requests" can make the whole turn error.
**Fix:** cap total `preparedDetails` per response under the JSON cap, and catch the error inside the try.

---

## What gets recorded for the messages you asked about
Each message was run through the pre-model check, then through the parser (and the repository where noted) with the most permissive model update that could target it.

| Sid says | Pre-model | Recorded |
|---|---|---|
| "I asked Ms. Lee for a reference and she said yes" | reaches model | nothing: the contact step needs the stored step label and the application label in the clause; her "yes" can't be recorded |
| "Waterloo sent me an offer" | reaches model | nothing (not first person) |
| "the transcript is done" | reaches model | nothing on any step |
| Two items named, then "I submitted it." | reaches model | nothing (no label in the clause) |
| "Mom paid the OUAC fee" | reaches model | nothing. But "Mom told me I paid…" and "Mom and I paid…" record done (M2) |
| Forwarded "Dear Sid, I have an offer of admission for you from Waterloo." | reaches model | owner_reported_offered (M1; known issue, but the "for you" signal is ignored) |
| "can you email my counsellor" | refused before model | nothing. "Can you let my counsellor know I'm applying?" reaches the model, and "I followed up with your counsellor." passes the reply guard (H1) |
| "I got into Western!!" | reaches model | nothing |
| "scholarship essay is next, I finished the supplement and sent it" | reaches model | nothing on any step |
| "I got a conditional offer from Western instead of Waterloo." | reaches model | Waterloo offer re-opened as offered (H2) |

## Checked and sound
- **0029 syntax.** All 11 triggers use the remote-D1 form. There is no `SELECT CASE … RAISE`, and no earlier table is altered.
- **0029 behaviour on node:sqlite.** Both keys on both tables have an insert guard. OR REPLACE, OR IGNORE and UPSERT ON CONFLICT abort. UPDATE and DELETE abort. Voice-channel and other-principal turns, a revision created before its item, a skipped revision, a kind/status mismatch and an offer linked to an application item are all refused.
- **PR #52 guards are not loosened.** `itemEvidenceClauses` (the adjacency rule), `supportsStatus`, `allowedFirstPersonActionClaim` and `guardReplyClaims` are untouched. The only shared change is ISO-instant masking in `clauseGroups`.
- **No code path executes anything.** `executionBoundary: "owner_only"` is enforced in the parser, the repository and a CHECK constraint. There are no tools.
- **Non-owner and acknowledgement turns.** A non-owner principal's workflow updates fall back to an ordinary reply. Acknowledgement messages ("ok", "thanks") strip workflow updates.
- **Status/kind compatibility** is enforced in the parser, the repository and the trigger.
- **Digest safety.** `preparedDetails` is never shown. Terminal statuses are filtered in both the SQL and the composer. The existing `fit()` keeps the message under 4,096 characters, trimming the workflow lines first. A failed workflow source shows as a gap.
- **Why the school catch-up model changed.** It hosts the combined prompt and parser and gets the new pre-model refusal. No catch-up guard is weakened; the one problem there is the false positives in M3.

## Unverified
- How often a real model emits the updates in H2, M1 and M2. Those findings are failures of the guard that is meant to stop such updates.
- The vitest suite was not run. M7 uses transcribed test inputs, and I read the other test files rather than running them.
- 0029 was not applied to a real remote D1. Its form matches the accepted pattern by reading.
- Whether 96 statements per batch sits within Cloudflare D1 limits.
- Whether merging auto-deploys (L3), and whether digest text is stored or forwarded anywhere beyond Sid's Telegram (L2).

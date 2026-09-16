# PR #73 adversarial review at 3c62b5a

**Verdict: changes requested.** 3 High, 2 Medium, 3 Low. Migration 0030 itself is sound. The problems are in what the check-in tells Sid and in who can retire a signal.

All probes ran in `pr73/agent/tree2` (`git archive 3c62b5a`) with vitest-pool-workers against real repositories and real migrations. Files:
- `pr73/agent/zz-adversarial-pr73.test.ts` (A1–A6, A4b): 7/7 pass, which confirms each defect.
- `pr73/agent/zz-adversarial-pr73-migration.test.ts` (M1–M6): 2/2 pass.
- `pr73/agent/mut-run.txt`: 26 mutations, of which BASE survived as expected and 2 were killed.
- `pr73/agent/order.mjs`: migration order on node:sqlite.
- Slice-1 baseline: `pr73/agent/main-tree`, taken from a3c515e.

---

## High

### H1. Every past-due deadline is reported as "overdue", marked "verified" and scored 92, even when Sid handed the work in

**Where:**
- `apps/cloud-gateway/src/school/study-coach-signals.ts:212-247`: `hours < 0` gives outcome `wrong`, score 92, verification `verified` and the text "The open deadline was overdue".
- `apps/cloud-gateway/src/deadlines/deadline-repository.ts:531-543`: 14-day lookback, `status = 'open'`, `ORDER BY d.due_at LIMIT 24`.

**Proven (A1, A6).**
- **Why rows stay open.** Nothing in `src/` ever sets `deadlines.status` to `submitted` or `missed`. The only writer is `cancelOpenByExternalId`. Every published Classroom courseWork stays `open` after Sid turns it in, and Brightspace iCal carries no submission data at all.
- **A1 setup:** a Classroom quiz due yesterday, which Classroom reports as `returned` with grade 9. `readStudySnapshot` correctly finds no missing work. The real `assembleDigest` then prints:
  ```
  Calculus: study target "Calculus review" (2 evidence points, high confidence; last observed 2026-09-15).
  Source 1 — deadline 01m2nws5… (2026-09-15; verified): The open deadline was overdue as of 2026-09-15.
  Source 2 — Classroom grade 01m2nws5… (2026-09-15; verified): Google Classroom assigned grade 9. …
  ```
- **A6:** 24 still-open past deadlines from the last 14 days fill the `LIMIT 24` window, sorted oldest first. A deadline due in 2 hours is dropped. The near-due signal is starved by exactly the rows that are wrong.

**Effect for Sid:** almost every morning, Jarvis tells him, with "high" or "medium confidence", that on-time work was overdue and is a weak spot. This contradicts 0027's own rule that "a deadline passing is never stored as a factual miss". It also outranks every quiz and owner-reported signal (score 92 against 58–94).

**Fix:**
- Drop the overdue-deadline signal. For Classroom, missed work is already covered by derived missing-work, which checks `submission_state`.
- Keep only near-due deadlines, wording them "due within N hours" with outcome `uncertain`. For Brightspace and manual sources, never label them `verified` beyond the fact that the due date exists.
- Read the window as due-soonest first starting from `now`, not oldest first.
- Add a test: a turned-in or returned observation plus an open past deadline produces no deadline citation.

### H2. Raw Classroom points are treated as if they were percentages, so good marks become "low" or "falling" grades

**Where:** `apps/cloud-gateway/src/school/study-coach-signals.ts:140-178`.
- Line 142 applies `assignedGrade <= 70` and scores the signal 72.
- Lines 159-160 flag a "falling" grade on any drop of at least 5 raw points, scored 84.
- `school_assignment_observations` stores only `assigned_grade`. `maxPoints` is never fetched or stored, per `classroom-client.ts` and 0027.

**Proven (A5, A1).**
- A5 uses the real `deriveStudySignals` with a 45 followed by a 10 (read as 45/50, then 10/10). It produces:
  - a "falling grade" signal, score 84, medium confidence;
  - a "low grade" signal for 10, score 72, medium;
  - a "low grade" signal for 45, score 72, medium.
- `chooseStudyCheckIn` then picks "English review", 2 evidence points, medium confidence.
- A1 cites a 9/10 as a weak-spot grade.
- The citation date is the poll time (`lastSeenAt`), not when the grade was given. A grade from 2026-09-14 is shown as "(2026-09-15; verified)", so an old grade reads as today's.

**Effect for Sid:** a perfect 10/10 on a quiz out of 10 becomes a medium-confidence study target. Almost every Classroom assignment is out of 70 points or fewer, so most returned work triggers a "low grade" signal. The caveat sentence ("scale not supplied…") sits under a headline that already states the conclusion.

**Fix:**
- Fetch and store `courseWork.maxPoints` and compare percentages.
- Until that exists, derive no grade signals. At most, allow a percentage signal when `maxPoints` is known.
- Never compare grades across assignments without a known scale.
- Show the grade's `content_changed_at` as its date.

### H3. Common phrases like "I finished it" or "that is wrong" permanently retire the latest check-in, however old, and replace Sid's normal reply

**Where:**
- `apps/cloud-gateway/src/school/study-coach-model.ts:222-230` (`parseStudySignalControlIntent`) and `:482-498`. The branch runs ahead of the fallback on every direct owner Telegram turn.
- `apps/cloud-gateway/src/school/study-coach-repository.ts:750-770`: `ORDER BY claim.local_date DESC … LIMIT 1`, with no bound on the claim's date and no link to what Sid is replying to.

**Proven (A4, A4b).**
- The parser accepts all of these: "I finished it", "it is done", "that is wrong", "this was wrong", "I did that", "It has been done."
- **A4:** 15 days after a Biology check-in, the direct turn "I finished it" gets the reply "Retired 1 cited study-coach signal as handled." The fallback model is never called, so Sid's real reply is lost and the evidence is set to `forgotten`.
- **A4b:** with no check-in ever claimed, "that is wrong" still gets "I couldn't identify an active cited signal to retire." and the fallback is not called. Before 0030 is applied, the same turn gets "I couldn't update the study-coach signal."

**Effect for Sid:**
- Telling Jarvis "I finished it" about an essay or a catch-up action, or "that is wrong" about any answer, gets a confusing canned reply instead of an answer.
- It also silently and permanently deletes whatever study signals Jarvis last raised, possibly weeks ago, for a course he wasn't talking about. Quiz evidence becomes `corrected` or `forgotten`, and deadline, grade and missing-work keys are retired forever. There is no undo path.
- It also pre-empts the school catch-up model, whose prompt handles "finished" wording for plan items.

**Fix:**
- Require wording that names the check-in, for example "that study check-in is wrong" or "the weak spot is handled".
- Only act on today's claim, ideally when the Telegram message is a reply to the digest message.
- On no match or no claim, fall through to the fallback model rather than replying with a canned line.
- Add a test that "I finished it" and "that is wrong" still reach the fallback.

## Medium

### M1. An unrelated deadline or grade raises a one-point, low-confidence topic to "high confidence" and removes the "not a fixed judgment" caution

**Where:** `apps/cloud-gateway/src/school/study-coach-signals.ts:280-300`.
- The topic comes from the strongest topic signal in the course.
- The citations add every course-level signal in that course.
- `evidenceCount` is the citation count.
- Confidence comes from the course-level primary signal's score (`score >= 90 && citations >= 2` gives "high").
- `digest-composer.ts:241,253` shows the caution only when `evidenceCount === 1`.

**Proven (A3).** The course card says "Projectile motion feels uncertain", which is one course-context point, tentative and low confidence. Add an unrelated overdue "Lab safety form" in Physics, and the digest prints:
```
Physics: study target "Projectile motion feels uncertain" (2 evidence points, high confidence; …)
Source 1 — deadline …: The open deadline was overdue …
```
The same assignment can also count twice, once as missing work and once as an overdue deadline.

**Effect for Sid:** Jarvis claims strong evidence that a specific topic is weak when the only topic evidence is one tentative note. Slice 1 said "1 evidence point, low confidence; not a fixed judgment" for exactly this data.

**Fix:**
- `evidenceCount` and confidence for a topic target should come only from topic-matched evidence, using the topic summary's confidence, as slice 1 did.
- Present course-level signals as separate "course signals", not as evidence for the topic.
- De-duplicate by the underlying `deadline_id`.

### M2. Regression: the same weak spot now repeats every morning, where slice 1 raised each point once

**Where:** `apps/cloud-gateway/src/school/study-coach-repository.ts:688-689` and `study-coach-signals.ts:70-118`.
- Evidence signals ignore `practiceDueOn` and `lastPromptedOn`.
- Slice 1's claim required `practice_due_on <= today AND (last_prompted_on IS NULL OR last_prompted_on < practice_due_on)`.

**Proven (A2 plus a baseline run on main).**
- PR head: one course-card weak area claimed four days in a row returned "Titration calculations feel uncertain" on every day.
- Main (a3c515e): the same fixture returned the topic on day 1 and `null` on days 2 to 4.

**Effect for Sid:** the check-in stays at one per day, but it becomes the same nag every morning. Owner and practice evidence repeats for up to 30 days, and course-card evidence repeats for as long as the card is active. Grade, missing-work and deadline signals also repeat daily until Sid retires them.

**Fix:**
- Filter out evidence signals that are not yet due again, keeping slice 1's rule.
- Add a cool-down for the external `source_keys` claimed recently, for example not re-citing a claimed key within 3 days unless its evidence changed.
- Pin both rules with a multi-day test.

## Low

### L1. Unpinned rules: 24 of the 25 real mutations were run against the 8 named test files, and only 2 were killed

Killed: S5 (grade principal filter) and S16 (retired-key filter). Everything below survived, from `mut-run.txt`.

**0030 sub-clauses.** Whole-trigger removal is pinned; these individual clauses are not:
- **C1:** the claim-id duplicate check.
- **C2:** the active course card check.
- **C3:** the source-key type and length check.
- **K1:** the controls duplicate `EXISTS`. This is the only barrier against `INSERT OR REPLACE` rewriting a control. The deletion done by REPLACE fires no delete trigger.
- **K2:** the turn-principal binding.
- **K4:** the claim-membership check.
- **K5:** the key-shape check.
- **K6, K7, K8:** the grade, missing-work and deadline existence checks.

**Code:**
- **S1:** failure-means-stale.
- **S2:** the stale missing-work score.
- **S3 and S4:** the study missing-work query's `submission_state` filter and its latest-transition `NOT EXISTS`, each unpinned on its own.
- **S6:** the "; stale" label in the digest.
- **S7:** the `status = 'open'` filter on study deadlines. Without it, cancelled work becomes "overdue".
- **S8:** the active-source join.
- **S9:** the principal filter on the evidence retire.
- **S10:** `ownerTurnAuthoritative: accepted.isDirectText` in `index.ts:155` changed to `true`. Pasting or forwarding "that signal is wrong" would then retire signals. The line predates this PR but is now load-bearing for correction authority.
- **S11, S14, S15:** the legacy, conflict-swallow and pre-check layers.
- **S13:** ambiguous contained course matching, which would attribute a deadline to the wrong course.
- **S12:** the quiet-hours check. This is also unpinned on main: I checked by running the same mutation on main and it survived there too.

**Fix:** add targeted tests for at least K1, K2, K4, S3, S6, S7, S10 and S13.

### L2. The migration guard accepts a correction turn from before the check-in existed

**Where:** `0030_study_coach_weak_spots.sql:103-108`.

**Proven (M6).** A controls row naming the Telegram plan turn that predates the claim is accepted. The code always passes the current turn, so this is SQL-level only.

**Fix:** in the guard, require `conversation_turns.created_at >= claim.claimed_at`.

### L3. Citations show raw ULIDs, so Sid can't tell which grade or deadline is meant

**Where:** `apps/cloud-gateway/src/digest/digest-composer.ts:256`.

**Proven:** by the A1 and A3 output ("deadline 01m2nws5nvpv2mec42a0xtvw78").

**Effect for Sid:** he is asked to judge "wrong" or "handled" without being able to see what is cited. The same digest already prints Classroom titles, neutralised, in its grades and missing-work sections.

**Fix:** render the title as quoted, neutralised data in the citation line. It must still never become the topic or appear in a prompt.

---

## Checked and sound

- **One claim per day:** the PK `(principal_id, local_date)`, the insert guard and the slice-1 `last_prompted_on = today` check all hold. A concurrent loser hits the trigger and returns `null`. The evidence updates are in the same atomic batch, and the check-in `local_date` is computed in America/Toronto in both the digest and the adapter.
- **Conflict-clause bypasses (M1–M5, executed):**
  - `INSERT OR REPLACE`, `REPLACE` and `INSERT OR IGNORE` on claims all abort with `school_study_check_in_insert_conflict`.
  - `UPDATE OR REPLACE` aborts.
  - `INSERT OR REPLACE` and `INSERT OR IGNORE` on controls abort.
  - A cross-principal claim or turn is rejected.
  - The row was unchanged afterwards.
- **Migration 0030:**
  - It is purely additive (CREATE TABLE, INDEX, TRIGGER) and every trigger uses `SELECT RAISE(ABORT, …) WHERE` with no CASE.
  - Applied on node:sqlite with `foreign_keys=ON`, it succeeds for 0001–0028 then 0030, for 0030 then PR #64's 0029, and for 0029 then 0030. `foreign_key_check` is empty and `integrity_check` is ok in all three orders.
  - PR #64's 0029 only adds university tables.
  - No code deletes the parents that the new RESTRICT foreign keys reference.
  - Growth is bounded: at most one claim per day and at most 4 controls per claim.
- **Untrusted text:** assignment titles never reach the topic, the practice prompt or the digest check-in. Classroom course names are used only for matching.
- **Owner-only:** non-owner and non-direct turns go straight to the fallback (pinned by the builder's test). The digest still goes only to `OWNER_PRINCIPAL_ID`.
- **Digest with no signals:** output is byte-identical, now pinned with `toBe`.
- **PR #72:** the typing, thinking and timing wrappers in `index.ts` are untouched. The diff only changes `commandContext`.
- **Latency:** an ordinary owner Telegram turn gets no new D1 statement. The new branches are regex-gated.
- **Binding size:** the controls lookup binds at most 73 parameters (24 grades + 24 missing work + 24 deadlines + principal), under D1's limit of 100.
- **Deploy before 0030 is applied:** the digest swallows `no such table: school_study_…` and shows no check-in. See H3 for the Telegram side.

## Unverified

- Whether real remote D1 batch errors contain the trigger message text that `study-coach-repository.ts:729` matches on. Tested only in miniflare.
- The real distribution of Classroom `maxPoints` for Sid's courses, and whether his Brightspace feed ever drops past items.
- DST-day and midnight-boundary behaviour was reasoned from `Intl` usage, not executed.
- Prompt byte size for the "quiz me on that weak spot" follow-up with multi-byte topics. The 2,048-byte cap would refuse rather than overflow.

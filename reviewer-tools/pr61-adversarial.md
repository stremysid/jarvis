# PR #61 adversarial review: head c696e45 (implementation f94baed)

**Verdict: changes requested.** 1 High, 3 Medium, 3 Low. That count leaves out the reviewer's known finding (1), which I confirmed separately and extended below.

How I tested: I did not check out the branch or touch the repo. I copied the PR-head `school-observation-repository.ts`, `classroom-observation-sync.ts`, `transaction.ts` and the contracts `canonicalJson`/`sha256Hex`/`newUlid` into `scratchpad/work/rt/`, unmodified except for import paths. I ran them with `node --experimental-transform-types` against a small D1 stand-in built on node:sqlite. That database has the real `0001_foundation.sql`, `0011_deadlines.sql` and candidate `0027` applied, and all 12 triggers are live. Unless a finding says otherwise, every result below came from the real PR code writing through the real triggers.

## Known finding (1): confirmed, and the window is wider than stated

- **Confirmed independently.** `work/repro1.mjs` runs the exact `readDigestSnapshot` SQL. A deadline was turned in, the scan saw `turned_in`, and derivation stopped before that deadline. The digest still returned it as `no_submission_seen`, stamped with the new scan time. `work/rt/scenarioC.ts` shows the same thing at scale: all 100 assignments were turned in and seen by a completed scan, and the digest still printed 20 "no submission seen" lines until the second derivation run.
- **The window also covers the whole next submission scan, not just derivation.** In `work/rt/scenarioA.ts` at 05:05Z, derivation had finished and a new scan had already re-read the observation as `turned_in`. The digest still said "no submission seen; scan 04:00". Moving `last_success_at` to after derivation would not close this. The digest query has to re-check `basis.submission_state IN ('new','created','reclaimed_by_student')`.

## High

### H1. An assignment turned in before its deadline is reported as "no submission seen", because the evidence was read before the deadline
**Where:**
- `apps/cloud-gateway/src/school/school-observation-repository.ts:667-673`: the derived state compares `dueAt` with `derivedAt`, the scan *completion* time. It never compares it with when the observation was read.
- The same file, `:639-640`: an observation counts as fresh if it was read any time since the scan *started*.
- `0027_school_observations.sql:374-398`: the trigger has the same gap. It checks `due_at <= NEW.derived_at` and `last_seen_at >= derivation_started_at`, but never `last_seen_at >= due_at`.
- `school-observation-repository.ts:728`: the digest stamps the line with `sync.last_success_at`.
- `digest-composer.ts:182` prints that stamp as "scan <time>".

**Proven:** executed `work/rt/scenarioA.ts` on the real code:
1. The 03:00Z run reads course cA and sees `NEW` for an essay due at 03:59Z. It then reads 3 pages of cB and stops: 4 pages, `partial`.
2. Sid turns the essay in at 03:30Z, 29 minutes early.
3. The 04:00Z run finishes cB, completes the scan and derives the item.
4. The trigger **accepted** `untracked -> no_submission_seen` with `derived_at 04:00Z`.
5. The 04:05Z digest printed: `[derived: no submission seen; Google Classroom scan 2026-09-16T04:00:00.000Z] Calculus: Essay draft (deadline passed 2026-09-16T03:59:00.000Z)`.
6. `lastFailure` was null and the scan was 5 minutes old, so the digest showed no gap. The line stayed until the next full cycle finished at 06:00Z.

This root cause is separate from (1). At 04:05 the stored observation still said `new` because it had not been re-read, and derivation had finished. The fixes for (1) do not remove this line.

**Effect for Sid:** he submits on time late at night, and `/digest`, or the morning digest when a cycle runs long, tells him he has no submission. The stated scan time is after both his submission and the deadline. A scan is allowed to run for up to 24 hours (`MAXIMUM_SCAN_AGE_MS`), so the evidence behind that stamp can be up to a day older than it looks. None of the new tests catch this: every repository test uses the same instant for scan start, observation read and completion (`completeScan()` helper, repository test `:60-75`).

**Fix:**
- Derive `no_submission_seen` only when `o.last_seen_at >= d.due_at`. Enforce the same rule in the 0027 trigger with `basis.last_seen_at >= due_at`. Otherwise derive `not_due` or leave the item silent.
- Stamp the line with `basis.last_seen_at` ("Classroom showed no submission as of ..."), not with the scan completion time.
- Add a test where the observation is read before the due time and the scan completes after it.

## Medium

### M1. One lost write after a derivation batch, followed by a teacher extending a deadline, stops grade and submission sync for good
**Where:**
- `classroom-observation-sync.ts:79-109`: the derivation branch has no age limit. The 24h stale reset at `:147-163` only looks at `scan_started_at`, which is NULL while derivation runs.
- `saveCheckpoint` at `school-observation-repository.ts:363` refuses to start a scan while `derivation_scan_at` is set.
- A replay reuses the frozen `derivedAt`, and `0027:159` plus `:326-332` forbid a second transition for the same `(deadline_id, derived_at)`.

**Proven:** executed `work/rt/scenarioB.ts`:
1. Run 1 commits a derivation batch, then the `completeDerivation` write fails. I injected a one-off `D1_ERROR: Network connection lost`.
2. The teacher extends the lab report's due date, and Sid turns in a different quiz.
3. **72 consecutive hourly runs** all returned `failed:school_observation_sync_failed`, with `pages=0`.
4. `derivation_scan_at` was still set after 72h. The turned-in quiz's observation still said `new`.

Control run `work/rt/scenarioB-control.ts` (same fault, no due-date edit): it recovered on the next run and the quiz was seen as `turned_in`. So the wedge needs exactly this pair. Neither D1 transient errors nor deadline extensions are unusual. The same wedge follows if the batch commits but the Worker sees an error, or if `saveDerivationCheckpoint` is the write that is lost.

**Effect for Sid:** grades and submission checks freeze with no end. The digest shows only the generic `school_observation_sync_failed`, because `safeFailure` maps the trigger's `school_missing_work_transition_insert_invalid` to it. Old "no submission seen" lines keep printing every day, and recovery needs someone to edit D1 by hand.

**Fix:**
- Make derivation safe to replay. When the latest transition for a deadline already has `derived_at = derivedAt`, treat that deadline as done for this sweep and skip it.
- Add an age limit on the derivation phase that records a failure and clears the derivation state.
- Test both.

### M2. The new digest lines print raw UTC timestamps, so most evening deadlines show the next day's date
**Where:**
- `digest-composer.ts:179` and `:182` print `grade.lastSeenAt`, `item.derivedAt` and `item.dueAt` as raw ISO UTC.
- `classroom-client.ts` `classroomDueInstant` turns a date-only assignment into 23:59:59.999 local time.
- The rest of the digest avoids this: the Due section uses relative hours (`digest-composer.ts:131-160`), and gaps use `localDate()` (`digest-job.ts:291`).

**Proven:** by reading, plus conversion in node. A Classroom assignment due Tuesday 15 September (date-only, or 11:59 p.m.) is stored as `2026-09-16T03:59:59.999Z`. The digest line reads `deadline passed 2026-09-16T03:59:59.999Z`. `Intl` in America/Toronto confirms that instant is "Tuesday, September 15, 2026 at 11:59 p.m.". The new composer test "labels an absent submission signal as derived no submission seen..." locks in the raw ISO form.

**Effect for Sid:** the line that tells him something is missing shows the wrong due date, and a "scan" time 4 hours off, for anything due after 8 p.m. local. That is almost every Classroom deadline.

**Fix:** format `dueAt`, `derivedAt` and `lastSeenAt` in `options.timeZone`, the same way `localDate` does, and pin an evening-deadline example in the test.

### M3. Four rules that decide what Sid is told have no test that would fail if they were deleted
Each is proven by reading the new test files (`test/school/*.test.ts`, `test/jobs/digest-job.test.ts`, `test/digest/digest-composer.test.ts`) and grepping all tests at the PR head.
- **Derivation paging and resume** (`classroom-observation-sync.ts:79-109`, `nextAfterDeadlineId` / `saveDerivationCheckpoint` in the repository). Every fixture in the repository and sync tests creates exactly **one** deadline under its own source id (`fixture()`: repository test `:21-43`, sync test `:21-44`). `found.length > 64` can therefore never be true, so `nextAfterDeadlineId` is always null in tests. Deleting the resume branch, or hard-coding `nextAfterDeadlineId: null`, would silently skip every deadline after the 64th and no named test would fail. `saveDerivationCheckpoint`, `nextAfterDeadlineId` and a non-null `derivationScanAt` do not appear in any test. This is the code path where (1) lives.
- **Moving to the next course** (`classroom-observation-sync.ts:208-221`). All five sync tests pass a one-element `courses` array. If the sync marked the scan complete after the first course, every other course would go unread with no gap, and nothing would fail. My executed scenarios A and C show the real code does advance correctly. The tests just don't pin it.
- **The digest staleness and never-scanned gaps** (`digest-job.ts:311-325`): "has never completed a submission scan", "last completed scan time is unreadable" and "last completed scan is stale". A grep of the tests finds none of these strings. Only the `lastFailure` branch is exercised ("keeps last-known grades visible while naming a failed submission scan"). Deleting the 12h staleness warning, which is the only thing telling Sid a derived claim is old, would fail no test.
- **`AND d.due_at <= ?` in the digest missing-work query** (`school-observation-repository.ts:738`). No test moves a due date after derivation, and every missing-work assertion uses due 11:00Z with now >= 12:00Z. If the check were removed, an assignment the teacher extended would keep showing as "deadline passed <future date>" until it was re-derived. With (1), that can take hours.

**Fix:** add a >64-deadline, two-run derivation test with a digest read in between; a two-course sync test; stale and never-scanned gap tests; and a test that extends a deadline after derivation.

## Low

### L1. The missing-work list is silently capped at 20, oldest first
**Where:** `school-observation-repository.ts:750-751` (`ORDER BY d.due_at ... LIMIT 20`) and `digest-composer.ts:176-186`, which adds no "and N more" line.
**Proven:** executed `scenarioC.ts`. 100 unsubmitted overdue items produced exactly 20 lines with no indicator.
**Effect for Sid:** a student with a backlog sees the 20 oldest items, which reads as the complete list. The most recent ones are dropped.
**Fix:** also count the rows and print "+N more", or order newest first.

### L2. Derivation re-reads every Classroom deadline ever stored, which lengthens (1)'s window as the year goes on
**Where:** `school-observation-repository.ts:637-643`. The query has no status, date or fresh-observation filter. Rows without a fresh observation are only skipped at `:662`. Classroom deadlines that disappear stay `open` forever by design (`deadline-ingestion.ts`).
**Proven:** by reading, plus `scenarioC`: 100 deadlines took 2 derivation runs at 64 per hour, and no submission scan runs until derivation finishes.
**Effect for Sid:** each cycle gains one hour of derivation per 64 stored Classroom deadlines. The false "missing" window in (1) grows, and eventually the digest can show "last completed scan is stale" even though nothing is wrong.
**Fix:** `INNER JOIN` on observations with `last_seen_at >= since`. The results are the same, because rows without one are skipped anyway.

### L3. Rejected submissions leave no trace anywhere, and a submission whose id changes is ignored permanently
**Where:**
- `job-table.ts:156-158` builds the poll detail without `observations.rejected`.
- `school-observation-repository.ts:545-548` rejects an incoming submission whose `external_submission_id` differs from the stored one for that deadline.
- `UNIQUE (principal_id, deadline_id)` (`0027:92`) and the delete guard (`0027:278-283`) mean the row can never be replaced.

**Proven:** by reading.
**Effect for Sid:** if Classroom ever recreates his submission for an assignment, that assignment's grade and submission state stop updating for good. The sync still reports "complete", and nothing in the digest or poll output shows it. How often Classroom changes a submission id is unverified.
**Fix:** report the rejected count, and record a visible failure the first time an id mismatch is seen.

## Checked and sound
- **D1 statement budget cannot wedge the sync.** Executed worst case: 4 courses x 25 revised items plus a 64-transition derivation page used **280 of 320** statements. The client rejects pages over 25 items (`classroom_response_unbounded`, pinned), so the budget-exhaustion replay loop cannot happen.
- **Derivation paging is correct at runtime** (not pinned; see M3). Executed: 100 deadlines across 4 courses were all derived over 2 runs, then all re-derived to `submission_seen` in the next cycle.
- **Suppression when a later completed scan does not see an observation.** The `basis.last_seen_at >= last_success_started_at` gate is pinned by repository test "stops showing no submission seen when a later completed scan did not observe that assignment". Deleting the gate makes that test's `[]` expectation fail (reasoned from the test).
- **The "latest transition" `NOT EXISTS` rule** is pinned by "derives no submission seen ... resolves it when submission evidence arrives" (reasoned).
- **Transition history cannot be reordered or rewritten.** `derived_at` must equal `last_success_at`; the update guard keeps that value from going backward; `UNIQUE (deadline, derived_at)` and the update/delete guards cover the rest (by reading).
- **No `OR REPLACE`, `OR IGNORE` or `ON CONFLICT`** in the repository SQL (grep). `0027` contains no `CASE` (grep count 0). The only `CASE` uses are value expressions inside runtime UPDATEs.
- **No wedge from validating derivation or digest rows.** Classroom `due_at` is canonical at ingestion (UTC-millisecond round-trip in `deadline-ingestion.ts`), and titles and courses are NFC-normalised with control/format characters stripped, so `instant()` and `text()` cannot throw on real rows.
- **Classroom `updateTime` with 6 or 9 fractional digits parses** (executed `Date.parse` in node V8), so submissions are not mass-rejected.
- **Scope:** the diff touches no `voice/**`, `calls/**`, `conversation/**` (retriever) or `production-runtime.ts`, and no runbook or OAuth scope. `classroom.coursework.me.readonly` was already in the runbook. There is no spend path and no outbound contact.
- **Deploying before the migration is safe.** The digest treats missing tables as unavailable, and a sync failure comes back as a detail string instead of failing deadline ingestion.
- **Principal and source ids match** between the sync (`OWNER_PRINCIPAL_ID`, `google-classroom`) and both digest paths.
- **Grades are not invented.** The exact `assignedGrade` is shown with "scale and weight not supplied"; no draftGrade, maxPoints or weight is read; a grade the feed leaves out is not shown (pinned).
- **Page-token cycles** up to 4 pages long are caught within a run (pinned). Longer cycles are cut off by the 24h stale reset (reasoned).

## Could not verify
- **Courses where Sid is a teacher.** `listCourses` sends no `studentId=me`. If Classroom returns 403 or 400 for `studentSubmissions?userId=me` on such a course, every run fails at that course. The 24h reset restarts the sweep, it fails there again, and no course's grades update. The mechanism follows from the code; whether Classroom actually returns that error is unverified.
- **Trigger-removal mutations on 0027:** left to the main reviewer, as instructed.
- **Real remote-D1 behaviour** of a batch that commits while the client sees an error. M1 does not depend on it: any lost write between the batch and the checkpoint is enough.

## Scratch files
- `scratchpad/work/repro1.mjs`: raw-SQL confirmation of (1).
- `scratchpad/work/rt/scenarioA.ts`: H1, plus the mid-scan extension of (1).
- `scratchpad/work/rt/scenarioB.ts` and `scenarioB-control.ts`: M1.
- `scratchpad/work/rt/scenarioC.ts`: budget worst case, paging, L1, L2.
- `scratchpad/work/rt/d1shim.ts`: the node:sqlite stand-in for D1.

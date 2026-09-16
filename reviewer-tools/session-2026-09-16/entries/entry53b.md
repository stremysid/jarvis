## 2026-09-16 00:30 UTC — Claude Opus 5, PR #53 round-2 max re-review at 2d3bac6: changes requested (small)

This re-review covers fix commit `4f7c3bc` and the main merge `11d624c` (main `4262024`, docs only). Every round-1 High is genuinely fixed in code. Four small defects remain: one that survives the reported M1 fix, and three regressions from the fix diff itself.

**Local checks on 2d3bac6** (Windows 11, `jarvis-pr39`): lint and typecheck pass, and `pnpm test` passes 3,357/3,357 with 0 timeouts.

**Migration 0023:** no `CASE`; every trigger uses `SELECT RAISE ... WHERE`. All 17 whole-trigger removals are killed by named tests, with 0 timeouts (`reviewer-tools/pr53/round2/run53btrig.txt`). The second reviewer confirmed 17 triggers in remote-D1 form, no `OR REPLACE`/`OR IGNORE`, insert guards on every unique key, and that the new `superseded` transition resists abuse.

**Reviewer probes** (`reviewer-tools/pr53/zz-reviewer-pr53-probes.test.ts`): all five now FAIL, as required. Q1 hijack, Q2 grading, Q3 ordinary speech, Q4 cap lockout and Q5 unsupported-topic weak areas are closed at runtime.

**Round-1 findings, verified fixed in code (not merely tested):**
- **B1/H1.** Only short, answer-shaped, single-line text inside a 30-minute window is graded. Questions, greetings, known requests, multi-line text, emoji and expired quizzes dismiss and fall through, and a failed answer write does the same. The "I couldn't update the study-coach record." dead end is gone.
- **H2.** Retirement runs under the `0023` triggers: a course at the 24 cap drops to 23 and the new answer inserts.
- **H3/S2.** All 17 round-1 sentences now fail to parse or resolve to no course and fall through.
- **H4/S4.** `quote` is out of the borrowed-text list, and a non-authoritative turn goes through `guardedOrdinaryReply`, so forwarded and `external_reply` turns keep all three guard sets while still skipping every mutation.
- **S1/M2.** Grading normalizes punctuation, articles, contractions and percent spacing, with no over-normalization: "not mitochondria", "58" against "58%" and containment all grade uncertain, never easy. Owner-topic answers write no evidence, and only `weak_area` facts sync.
- **S3/M5.** All 12 D2L false-claim misses are caught again, and the #51 benign set still passes.
- **M3, M4, M6, L1, L3, L4, L5** are fixed; **L2** is recorded in `KNOWN_ISSUES.md`.

**S1. The morning check-in's easy counter is always zero, so the M1 over-confidence defect survives where Sid actually reads it.**
- **Where:** `school/study-coach-repository.ts` `claimDigestCheckIn`. The query computes `COUNT(*) FILTER (WHERE outcome IN ('uncertain','wrong')) AS weak_count` and `COUNT(*) FILTER (WHERE outcome = 'easy') AS easy_count`, but its own `WHERE` already filters to `outcome IN ('uncertain','wrong')`, so the easy rows are gone before the FILTER runs.
- **Proven:** a topic with 3 uncertain and 5 easy points gives the digest **high confidence** while `summariseTopic` on the same rows says **low**.
- **Fix:** delete `AND e.outcome IN ('uncertain','wrong')` from the `WHERE` and let the two `FILTER` clauses do the work. `evidenceCount` stays `weak_count`, so the displayed count doesn't change.
- **Test:** 3 uncertain plus 5 easy on one topic; assert the check-in confidence is low and equals `summariseTopic`'s.

**S2. A correct sentence-shaped answer is refused and silently destroys the whole quiz.**
- **Where:** `school/study-coach-model.ts`, the `\b(?:is|was|feels?|found|finished|got)\b` clause in `plausiblyAnswersQuiz`, plus the dismissal path.
- **Proven:** with a quiz under 30 minutes old, "Mitosis is cell division", "It was the Krebs cycle", "Water is the reactant" and "The answer is 42" all dismiss and fall back, even when exactly correct. `dismissActiveQuiz` closes every open item, so questions 2 and 3 are destroyed too, and the reply never mentions that the quiz ended.
- **Fix:** treat `is`/`was` as disqualifying only when the text also looks like a request or acknowledgement, or drop them and rely on the question-mark, request-prefix and keyword tests that already carry the round-1 table. When the gate dismisses a quiz, prefix the fallback with the same notice the practice path already uses ("I closed the previous quiz...").
- **Test:** a table of sentence answers against a fresh supported quiz asserting the answer is recorded; plus one test that an unrelated message dismisses and the reply names the closed quiz.

**S3. Retirement runs even when no evidence is inserted, so a point is destroyed for nothing, irreversibly.**
- **Where:** `study-coach-repository.ts`: the retirement statements are unconditional, while the evidence insert is conditional on `answerSupport === "supported"`; `recordOwnerObservation` prepends retirement to an `INSERT ... WHERE NOT EXISTS`.
- **Proven:** a course at 24 active points plus an owner-topic (unsupported) quiz answer ends at 23 active and 1 superseded, with nothing added. A retried turn whose `source_key` already exists does the same. `superseded` is terminal, so the point can't come back.
- **Fix:** only prepend the retirement statements when an insert will actually run.
- **Test:** 24 active points, answer an owner-topic quiz, assert the active count is still 24 and nothing moved to `superseded`.

**S4. Course-card sync starves once a course holds 24 owner points, although the trigger now allows it.**
- **Where:** `study-coach-repository.ts` `syncCourseContext`: the CTE's `active_course_count` and the outer `LIMIT` still count `course_context` rows against the 24/96 budget, but `0023`'s cap trigger now exempts `course_context` entirely.
- **Proven:** a course with 24 active owner points and 3 unsynced `weak_area` facts syncs 0 of 3, while inserting all three directly succeeds.
- **Consequence:** after a chatty stretch in one course, new weak areas written to the course card stop reaching the study coach permanently, with no error anywhere.
- **Fix:** drop the `course_context` arm from both counts so the repository counts exactly what the trigger counts.
- **Test:** the same fixture as a repository test, asserting 3 `course_context` rows after sync.

**Low (fix if small, otherwise record in `KNOWN_ISSUES.md`):**
- **N1.** The 30-day retirement window is one-way and documented only in the mailbox. An owner statement or practice result older than 30 days becomes `superseded` and can never return, which sits against the standing memory requirement. Either retire only to make room at the cap, or record the window and its irreversibility.
- **N2.** `phraseMatches` still admits a one-word topic that appears in an unrelated fact: with a "Lab report due Friday" fact, "Friday is hard" records a weak point. Require at least two tokens, or match facts only when the kind is `weak_area`.
- **N3.** `guardSchoolReply` catches its own `BRIGHTSPACE_CHECK_REPLACEMENT` output. Harmless today because the replacement maps to itself, but it means the guard isn't a no-op on its own output.
- **L6 from round 1** is still neither fixed nor recorded: forgetting needs exact wording, can't be undone, and `superseded` is now a second state forget can't reach.

The full second-reviewer report is `reviewer-tools/pr53b-adversarial.md`, with its probes in `reviewer-tools/pr53/round2/`.

**Next.** A fresh builder session fixes S1–S4, handles N1–N3 and round-1 L6, reruns the five probes (all must still fail), reruns trigger removal for any changed trigger, and requests a max re-review.

This PR authorizes no migration, deploy, secret or live action.

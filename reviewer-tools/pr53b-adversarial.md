# PR #53 round-2 adversarial re-review: study coach (head 2d3bac6, fix 4f7c3bc, merge 11d624c)

**Verdict: CHANGES REQUESTED (small).** 1 High, 3 Medium, 3 Low. Every round-1
High is genuinely fixed in code, not merely tested, and the round-1 probe table
now falls through cleanly. But the M1 confidence fix is cosmetic: the digest
check-in's "easy" counter is structurally always zero, so the exact defect M1
named — Jarvis telling Sid with **high confidence** that a topic he keeps
getting right is a weak spot — survives on the one surface he actually reads.
Three Medium findings come from the fix diff itself: sentence-shaped correct
answers silently kill the quiz, evidence is retired even when nothing replaces
it, and course-card sync starves once a course has 24 owner points.

Method: read-only against `origin/codex/r5-study-coach-slice1` at `2d3bac6`, no
checkout. Regexes, the grading normalizer and the quiz gate were copied verbatim
into `scratchpad/pr53/round2/probe1.mjs`; the real `0023_study_coach.sql` was run
in `node:sqlite` (Node 24.19) with stub parents in `probe2.mjs` (results S1-S6).
Line numbers are at `2d3bac6`. Scope was held to (1) verifying the round-1 list
and (2) regressions in `git show 4f7c3bc`; unchanged parts of the slice were not
re-audited.

---

## Round-1 findings

| # | Finding | Status | Evidence |
|---|---|---|---|
| B1/H1 | Open quiz swallowed every later message | **Fixed** (one new regression, M1-new) | `study-coach-model.ts:223-238, 520-525`. Probe A: "check D2L now", "ok", "thanks", "what's due tomorrow?", "Sure", multi-line text, a ZWJ emoji and a 31-minute-old quiz all dismiss and fall back. "Not sure.", "not sure", "idk", "I don't know." all grade **uncertain**. "mitochondria", "58%", "58 %", "Photosynthesis.", "it's photosynthesis", a bare emoji all grade. Failed answer write dismisses and falls back (`:535-539`), so the "I couldn't update the study-coach record." dead end is gone from this path. |
| H2 | Evidence never aged out; 24/96 caps wedged writes | **Fixed** | S1: a course with 24 active points aborts a naked insert with `school_study_evidence_limit_exceeded`; the three retirement statements run **under** the 0023 triggers, drop it to 23, and the new answer inserts. Retirement is triggered by `syncCourseContext` (`repository.ts:262`), which runs on every owner Telegram turn and on the digest, plus inline in `recordOwnerObservation` (`:397`) and `answerActiveQuiz` (`:536`). `0023:409-413` permits `active -> superseded` exactly. |
| H3/S2 | Ordinary sentences became evidence | **Fixed** for the whole round-1 table | Probe C: all 17 round-1 sentences ("The due date is wrong", "That plan is wrong", "I finished the lab, that was easy", "I found photosynthesis not hard", "I got nothing wrong", "Your last reply was wrong", "Getting up early is hard", "My recovery is hard", …) now either fail to parse or resolve to no course and fall through. Legitimate ones still work with a hint or an existing match. Residual: L3-new. |
| H4/S4 | Forwarded/quoted turns skipped every guard; `quote` wrongly borrowed | **Fixed** | `school-catchup-model.ts:453-456`: a non-authoritative turn now goes through `guardedOrdinaryReply`, which applies all three guard sets via the exported `guardSchoolReply` (`:221-237`); it still takes no structured/mutating path, so forwards and `external_reply` are guarded **and** read-only. `quote` removed from `BORROWED_TEXT_KEYS` (`telegram-types.ts:77-80`), `external_reply` and all five forward keys retained. The study coach itself falls back to that guarded adapter when `!ownerTurnAuthoritative` (`study-coach-model.ts:375-379`). |
| S1/M2 | Exact-match grading; unsupported owner-topic quizzes built strong judgments | **Fixed** | Probe D: "58 %"→"58%", "it's photosynthesis", "Photosynthesis.", "MITOCHONDRIA!", "krebs cycle" vs "the Krebs cycle" all grade **easy**. Over-normalization checked and clean: "not mitochondria", "not 58%", "58" vs "58%", "58 percent", "the mitochondria is the powerhouse", "photosynthesis and respiration" all grade **uncertain**, never easy. Nothing grades a wrong answer easy. Owner-topic answers write no evidence at all (`repository.ts:543` makes the insert conditional on `answerSupport === "supported"`), and only `weak_area` facts sync (`:279`). No "I was right" control was added; the builder's rationale (nothing is ever auto-graded `wrong` now) holds — `:530` returns `uncertain`, never `wrong`. |
| S3/M5 | Narrowed D2L false-claim guard | **Fixed** | Probe E: all 12 round-1 misses are caught, including "I've checked your D2L", the curly-apostrophe form, "We've refreshed Brightspace for you.", "I looked at D2L and there's nothing due.", "D2L was just synced.", "I've just refreshed your Brightspace calendar.", "I checked D2L 5 minutes ago". The PR #51 benign set still passes: "I looked at the D2L dates you pasted…", "I reviewed the Brightspace text you sent.", "Your D2L calendar shows three items.", "Say 'check D2L now'…", "I can check D2L if you ask me to." Only "Jarvis checked D2L 5 minutes ago" passes, which is the deliberate second exclusion (`:53`). |
| M1 | Confidence/weak-spot labels | **Partially fixed — see H1-new** | Easy points no longer inflate the count and `due_work`/`missed_work` no longer sync, so round-1 S2 and the deadline check-in are fixed. But the promised "same weak-versus-easy judgment" is not implemented: S3 shows the easy counter is always 0. |
| M3 | Invented quiz content under a "Source:" line | **Fixed** | `study-coach-model.ts:318-323` drops the "Source:" claim for owner-topic and labels it "not source-checked"; `:283-288` runs question and answer through `guardSchoolReply`; `repository.ts:480-484` requires `course_fact`, a ≥2-character normalized answer and no `not/except/least/false` in the question. |
| M4 | "That mark was entered wrong" | **Fixed** | `study-coach-model.ts:429-434` falls through to the catch-up adapter that owns the fact; `correctLatestMark` deleted with no dangling references anywhere in the tree. |
| M6 | Digest gap when 0023 is unapplied | **Fixed** | `digest-job.ts:136-150, 244-249`: a `no such table: school_(study|practice)_` error yields null instead of a gap line. |
| L1 | Flashcard replies over 4096 characters | **Fixed** | `boundedTelegramText` (`:340-346`) plus one citation per set instead of per card (`:337`). |
| L2 | Check-in claimed before delivery | **Recorded** in `KNOWN_ISSUES.md` ("Study-coach digest check-ins are claimed before delivery"), with the candidate/receipt reasoning. Acceptable. |
| L3 | Inactive course card commits the claim then throws | **Fixed** | `repository.ts:605-606` joins `school_course_cards … active = 1` inside the claim subquery. |
| L4 | Trigger gaps | **Fixed** | S4: a practice item inserted straight as `answered` (or `dismissed`, or a flashcard as `open`) is blocked by `0023:246-247`; evidence inserted already `forgotten` or `superseded` is blocked by `0023:341`. |
| L5 | Mismatched hint ignored with one course | **Fixed** | `:182` requires `hint === null` for the single-course fallback; `resolveObservationCourse` (`:198-201`) needs a unique hint match. |
| L6 | Forgetting is narrow and cannot be undone | **Not fixed, not recorded.** Still only "forget that X is/was a weak spot" with exact topic text, and `superseded` is now a second unreachable-by-forget state (S4). Low; was Low in round 1. |

---

## New findings

### High

#### H1-new. The digest check-in's easy counter is structurally always zero, so M1's over-confidence defect survives
- **Where:** `apps/cloud-gateway/src/school/study-coach-repository.ts:629-641`, specifically the outer filter at `:636`.
- **Mechanism:** the query computes
  `COUNT(*) FILTER (WHERE outcome IN ('uncertain','wrong')) AS weak_count` and
  `COUNT(*) FILTER (WHERE outcome = 'easy') AS easy_count`, but the statement's own
  `WHERE` already contains `AND e.outcome IN ('uncertain','wrong')`. The easy rows
  are excluded before the FILTER runs, so `easy_count` can never be anything but 0,
  and `judgeSignals(weak, 0)` degenerates to "3 or more weak points = strong = high".
- **Concrete input (S3):** one topic with 3 `uncertain` and 5 `easy` active points.
  The query returns `weak_count=3, easy_count=0`. The morning digest says
  **high confidence**; `summariseTopic` on the identical rows says **low**.
- **Consequence for Sid:** the proactive coach tells him, in the daily digest,
  with high confidence, that a topic he has answered correctly five times is a
  weak spot — which is exactly what M1 asked to fix, on the only surface where
  the check-in is actually shown. The two code paths that are supposed to agree
  now disagree in opposite directions.
- **Fix:** delete `AND e.outcome IN ('uncertain','wrong')` from the `WHERE` at
  `:636` and let the two `FILTER` clauses do the work. `evidenceCount` stays
  `weak_count`, so the displayed count is unchanged.
- **Pin with test:** seed 3 uncertain + 5 easy points on one topic, claim the
  check-in, assert `confidence === "low"` and that it equals the
  `summariseTopic` confidence for the same topic. (S3 in `probe2.mjs`.)

### Medium

#### M1-new. A correct sentence-shaped answer is refused and silently destroys the whole quiz
- **Where:** `apps/cloud-gateway/src/school/study-coach-model.ts:236` (the
  `\b(?:is|was|feels?|found|finished|got)\b` clause) and `:520-525` (the dismissal).
- **Concrete input:** an open quiz less than 30 minutes old, then any of
  "Mitosis is cell division", "It was the Krebs cycle", "Water is the reactant",
  "The answer is 42", "Photosynthesis is how plants make food" — all verified
  `dismiss + fallback` in probe A, including when they are the exactly correct answer.
- **Consequence for Sid:** answering in a sentence, which is how a student
  answers a biology or history question, is not graded. Worse, `dismissActiveQuiz`
  dismisses **every** open item for the principal, so items 2 and 3 of the quiz
  are destroyed too, and the reply he gets is an unrelated ordinary chat answer
  with no mention that his quiz just ended. Round 1 asked for dismiss-and-fall-back;
  it did not ask for a silent one.
- **Fix:** two parts. (a) Only treat `is`/`was` as disqualifying when the text also
  matches a request or acknowledgement shape, or drop them and rely on the
  question-mark, request-prefix and keyword tests that already carry the
  round-1 table. (b) When the gate dismisses an open quiz, prefix the fallback
  reply with the same one-line notice the practice path already uses at `:483`
  ("I closed the previous quiz…").
- **Pin with test:** `it.each(["Mitosis is cell division", "It was the Krebs cycle",
  "Water is the reactant"])` against a fresh supported quiz whose expected answer
  matches — assert the answer is recorded, not dismissed; plus one test that an
  unrelated message dismisses **and** the reply names the closed quiz.

#### M2-new. Retirement runs even when no evidence is inserted, so a point is destroyed for nothing, irreversibly
- **Where:** `study-coach-repository.ts:535-554` (retirement statements are
  unconditional at `:536`, the evidence insert is conditional at `:543`) and
  `:397` (`recordOwnerObservation` prepends retirement to an
  `INSERT … WHERE NOT EXISTS`).
- **Concrete input (S2):** a course at 24 active points; Sid answers an
  owner-topic (unsupported) quiz. Result: `active=23, superseded=1` — the oldest
  point is retired and nothing replaces it. The same happens on a retried turn
  whose `source_key` already exists.
- **Consequence for Sid:** general-practice quizzing, which the PR deliberately
  makes evidence-free, quietly erodes the real evidence it refuses to add to.
  S4 confirms `superseded` is terminal: `superseded -> active` and
  `superseded -> forgotten` are both blocked by `0023:414-419`, so nothing can
  bring it back.
- **Fix:** build `statements` with the insert first and only prepend
  `retirementStatements` when an insert is actually going to run (i.e. inside the
  `answerSupport === "supported"` branch, and for the observation path only after
  confirming the `source_key` is new).
- **Pin with test:** seed 24 active points, answer an owner-topic quiz, assert the
  active count is still 24 and no row moved to `superseded`.

#### M3-new. Course-card sync starves once a course holds 24 owner points, although the trigger would now allow it
- **Where:** `study-coach-repository.ts:263-298` — the CTE's `active_course_count`
  (`:269-277`) and the outer `LIMIT` (`:291-298`) still count `course_context`
  rows against the same 24/96 budget, but `0023:320-335` now exempts
  `course_context` from the cap entirely.
- **Concrete input (S5):** a course with 24 active owner points and 3 unsynced
  `weak_area` facts. The sync CTE selects **0 of 3**; inserting all three
  directly succeeds, so the trigger would have allowed **3 of 3**.
- **Consequence for Sid:** after a chatty stretch in one course, new weak areas
  written to his course card by the catch-up model stop reaching the study coach
  permanently — no quiz source, no check-in, and no error anywhere. The repository
  and the migration now disagree about what the budget means, which is the class
  of drift the round-1 "Checked and sound" section had explicitly verified as
  matching.
- **Fix:** drop the `course_context` arm from `active_course_count` and from the
  outer `LIMIT` subquery so the CTE counts exactly what
  `school_study_evidence_active_cap` counts.
- **Pin with test:** the S5 fixture as a repository test — 24 owner points plus 3
  weak-area facts, then `syncCourseContext`, assert 3 `course_context` rows exist.

### Low

#### L1-new. The 30-day retirement window is irreversible and recorded only in the mailbox
- **Where:** `study-coach-repository.ts:24` (`EVIDENCE_RETENTION_DAYS = 30`),
  `:659-666`, `:673-676`.
- **Consequence:** an owner statement or practice result older than 30 days is
  moved to `superseded` and, per S4, can never come back; it disappears from the
  snapshot, the topic summary and check-ins. A weak area Sid reported five weeks
  ago and has not practised since is exactly the thing a study coach should still
  know. The policy appears only in `docs/AGENT_LOG.md`, which the file's own rules
  call "allowed to go stale"; it is in neither `KNOWN_ISSUES.md` nor any doc, and
  it sits against Sid's standing memory requirement ("store everything, recall
  anything on request").
- **Fix:** either retire only to make room at the cap (drop the unconditional age
  sweep) or add a `KNOWN_ISSUES.md` entry naming the window and the fact that it
  is one-way.
- **Pin with test:** none needed beyond the existing retention test; this is a
  documentation/policy fix.

#### L2-new. `phraseMatches` still admits a common word that happens to appear in a fact statement
- **Where:** `study-coach-model.ts:185-207`.
- **Concrete input:** a Chemistry card carrying the fact "Lab report due Friday";
  Sid says "Friday is hard". Probe C: `RECORDED uncertain "Friday" @ Chemistry`.
- **Consequence:** a residue of H3 — an ordinary sentence becomes a weak-area
  point because one of its words is inside an unrelated deadline fact. Much
  narrower than round 1 (the whole round-1 table is now clean) and it needs a
  one-word topic that collides, so Low.
- **Fix:** require the matched phrase to be at least two tokens, or match facts
  only when the fact kind is `weak_area`.
- **Pin with test:** the "Friday is hard" case against a `due_work` fact, expecting
  a fallback.

#### L3-new. `guardSchoolReply` replaces its own replacement text
- **Where:** `school-catchup-model.ts:47-50, 213-219`.
- **Concrete input:** `BRIGHTSPACE_CHECK_REPLACEMENT` itself — "I haven't checked
  D2L. Say 'check D2L now' to run the bounded refresh." — is CAUGHT by the guard
  (probe E).
- **Consequence:** none today, because the replacement is idempotent (it maps to
  itself) and the guard is not applied twice to the same string in any current
  path. But it means the guard is not a no-op on its own output, so a future
  double-guarded path or a changed replacement string would silently swallow
  legitimate text.
- **Fix:** add a leading-`haven't`/`have not` exclusion to the first completion
  pattern, or return early when the reply already equals a replacement constant.
- **Pin with test:** `guardSchoolReply(BRIGHTSPACE_CHECK_REPLACEMENT)` returns it
  unchanged.

---

## Also checked, and sound

- **Merge `11d624c` lost nothing.** It is a first-parent merge of
  `4262024` into `4f7c3bc` touching only `NEXT_STEPS.md`,
  `docs/AGENT_LOG.md` (+61, −0) and the new R7 plan. Diffing the branch against
  the main-side parent gives `23 0 KNOWN_ISSUES.md` and `112 0 docs/AGENT_LOG.md`
  — additions only, zero deletions. Every `##` heading present on main is present
  on the branch; the branch adds the two study-coach `KNOWN_ISSUES` sections and
  three AGENT_LOG entries. The mailbox conflict was resolved by keeping both sides
  in timestamp order, as the file's own rules require.
- **0023 triggers (S6).** 17 triggers, **zero** `CASE` expressions, all 17
  `RAISE(` occurrences in the remote-D1-safe `SELECT RAISE(ABORT, …) WHERE …`
  form, zero `OR REPLACE` / `OR IGNORE`, and 3 insert-conflict guards covering
  every unique key (preferences PK; practice items PK + `item_key` +
  (`practice_id`,`position`); evidence PK + `source_key`).
- **The new `superseded` transition cannot be abused (S4).** Insert as
  `superseded` is blocked (`0023:341`); `active -> superseded` requires a null
  control turn, an unchanged `last_prompted_on` and a non-`course_context` kind
  (`:409-413`) — a control turn on that transition is rejected, and a
  `course_context` row cannot be retired at all; `superseded` is terminal in both
  directions. The relaxed cap trigger (`:322`) narrows only by excluding
  `course_context`, which the CHECK at `:171` and the source guard keep honest.
- **Guard coverage on the untrusted path.** Non-authoritative owner turns reach
  `guardedOrdinaryReply` → `guardSchoolReply`, which applies SECRET_REQUESTS,
  FALSE_EXTERNAL_COMPLETIONS and the D2L set, and they still never reach the
  structured plan, the study parsers or any mutation. `parseOwnerCatchupPlan`,
  `fallbackWithSaveFailure` and every catch path now share the one exported guard
  rather than three divergent copies.
- **Generated practice text is guarded before storage**, not just before display
  (`study-coach-model.ts:283-288`), and a guard failure there is caught by the
  surrounding try/catch, giving the fixed "I couldn't make a cited practice set"
  reply.
- **The un-caught `guardSchoolReply` at `:550-553` is not a live crash path.**
  `sanitizeRedaction` (`packages/contracts/src/calls.ts:108-110`) returns
  `ok: false` only for a non-string or an ill-formed string; the answer reply is
  assembled from already-validated stored columns and fixed literals and is
  bounded to 4096 characters, well under `MAX_REPLY_BYTES`. Noted rather than
  filed.
- **`MAX_MESSAGE_CHARACTERS` import** introduces no cycle:
  `providers/telegram-provider.ts` imports only `./provider-types.js`.
- **Digest wiring** still routes through `syncAndClaimDigestCheckIn`
  (`index.ts:251-255`), so the missing-table tolerance added to `digest-job.ts`
  covers the retirement sweep as well as the sync and the claim.

## Mark estimates

- **M1-new severity is an estimate** in one respect: that Sid answers quiz
  questions in sentences. That he sometimes will is a judgement, not a proof; the
  refusal itself and the silent destruction of items 2 and 3 are proven from code
  and probe A.
- **L1-new is a policy judgement**, not a defect proof. The retirement behaviour
  and its irreversibility are proven (S2, S4); whether 30 days is wrong for Sid is
  for him or the roadmap to settle.
- Everything in the round-1 table and in H1-new, M2-new, M3-new, L2-new and
  L3-new is proven by probe output or by direct reading at `2d3bac6`.
- No gate was re-run in this pass; the builder's reported lint/typecheck/test
  results were taken as reported and not independently reproduced.

## Checked and sound

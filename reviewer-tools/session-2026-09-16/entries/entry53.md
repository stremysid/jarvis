## 2026-09-15 22:15 UTC — Claude Opus 5, PR #53 max review at 30ec39e: changes requested

This review covers the study-coach slice at `30ec39e`, based on main `1cae97b`. It adds migration `0023_study_coach.sql`.

**Local checks on 30ec39e** (Windows 11, `jarvis-pr39`): lint and typecheck pass, and `pnpm test` passes 3,311/3,311 with 0 timeouts.

**Migration 0023.**
- **Remote-D1 syntax:** no `CASE`. Every trigger uses `SELECT RAISE ... WHERE`. (The repository's runtime `ORDER BY CASE` is a query, not a trigger.)
- **REPLACE/IGNORE:** all three tables are `WITHOUT ROWID`, and each insert guard covers every unique key (practice items: primary key, `item_key` and `(practice_id, position)`). Core-immutable triggers block key changes under `UPDATE OR REPLACE`.
- **Trigger removal** (`reviewer-tools/pr53/mut53-triggers.json`): `BASE` passes, and all 17 removals are killed by named behaviour tests, with 0 timeouts.

**The forwarded/quoted flag is useful, but the way it's used is wrong (S4).** `isDirectText` correctly marks messages carrying `forward_origin`/`forward_*`, `quote` or `external_reply`, which addresses the forwarded-message item from the #52 review. Whichever of #52 and #53 merges second should reuse it rather than add a second flag.

**Reviewer probes** (`reviewer-tools/pr53/zz-reviewer-pr53-probes.test.ts`, describe `zzreviewerpr53`, real D1 with migration 0023). All five pass at `30ec39e`, which means each defect exists. All five must fail after the fix.
- **Q1, hijack:** with a quiz open, "What's due tomorrow?" is recorded as a wrong answer, and the ordinary bot is never called.
- **Q2, grading:** the correct answer "Mitochondria." to the stored answer `mitochondria` is graded wrong.
- **Q3, ordinary speech:** "Getting up early is hard." is recorded as uncertain study evidence for Chemistry, and the ordinary bot is never called.
- **Q4, lockout:** with 24 active evidence points in a course and a quiz open, two unrelated messages both get "I couldn't update the study-coach record.", and the ordinary bot is never called.
- **Q5, unsupported topic:** three correct answers on an owner-topic quiz whose source doesn't support the answers are all graded uncertain, and the topic becomes a strong, high-confidence weak area.

`reviewer-tools/pr53/regex-probe53.mjs` runs the PR's exact regexes. Its output is quoted in S2 and S3.

**B1. An open quiz takes over the conversation, and at the evidence cap it locks Jarvis into a failure reply.**
- **Where:** `StudyCoachModelAdapter.stream` sends every owner message that matches no earlier intent to `answerActiveQuiz` whenever `snapshot.activeQuiz` is set. Open quizzes have no expiry and no relevance check.
- **Reach, Q1:** hours or days after a quiz, "What's due tomorrow?", "Can you help me plan my week" or any other message is graded as an answer. That writes a wrong result as evidence, and Sid gets quiz feedback instead of an answer.
- **Reach, Q4:** evidence points never expire, and the per-course active cap is 24. Up to 16 course-context points come from course facts, so a few quizzes and statements in a busy course fill it. From then on, every answer batch aborts in `school_study_evidence_active_cap`. Because the quiz stays open, every later message gets "I couldn't update the study-coach record." until Sid happens to say "stop quiz". This breaks the rule that ordinary conversation never fails because of a tracker.
- **Fix:**
  - Treat a message as a quiz answer only when it plausibly answers (short, not a question, not a known intent), or only within a bounded window after the question (for example 30 minutes). Otherwise dismiss or park the quiz and pass the message to the ordinary path.
  - When answer storage fails, dismiss the open item and fall back to the ordinary reply.
  - Make evidence age out of the active set (for example, easy points after their `practice_due_on` plus N days, or keep only the newest N points per topic), so the cap can't wedge the coach.
  - Add tests for Q1, Q4 and an expired quiz.

**S1. Quiz grading makes correct answers look wrong, and unsupported quizzes make topics look weak.**
- **Exact match, Q2:** `answerActiveQuiz` grades "easy" only when the lower-cased, whitespace-collapsed answer equals the stored answer. Punctuation, articles, word order, units or synonyms all grade as wrong, and every wrong result feeds the weak-area judgement.
- **Unsupported, Q5:** for owner-topic sources, the excerpt is the request phrase itself (for example "photosynthesis"). So the model's quote almost never occurs in it, `answer_support` becomes `uncertain`, and every answer is recorded as `uncertain`. `summariseTopic` counts `uncertain` as weak, so three correct answers produce a strong, high-confidence weak area.
- **Fix:**
  - Normalise punctuation, articles and whitespace. Treat a non-exact answer as `uncertain` rather than `wrong` unless it clearly differs, or ask Sid to self-grade ("was that right?").
  - Don't count results from `uncertain`-support items toward the weak-area judgement or check-ins.
  - Reply that owner-topic quizzes aren't source-checked.
  - Add tests for Q2 and Q5.

**S2. Ordinary statements become study evidence and consume the turn.**
- **Where:** `parseOwnerStudyObservation` accepts any "X is/was/feels hard/easy/weak/confusing/uncertain/wrong", "I got X wrong/right", "I found X easy" or "I'm not sure about X". `resolveCourse` then falls back to the only course whenever there is exactly one.
- **Proven:** the regex probe parses 9 of 11 non-school messages as evidence, including "Getting up early is hard.", "My recovery is hard", "Walking after surgery feels hard", "Your last reply was wrong", "I'm not sure about going to the party" and "I found parking easy". Q3 shows the turn is consumed and recorded.
- **Consequence:** Sid's ordinary messages, including about his recovery, get a canned "Recorded one uncertain evidence point for Chemistry" instead of a reply, and they pollute the weak-area view. With several courses he gets "Which course is that evidence for?".
- **Fix:** require an explicit course or topic match against his existing course cards, facts or known topics (not the only-course fallback) before recording. Otherwise fall through to the ordinary path. Add a table test of non-school sentences that must reach the fallback model.

**S3. The Brightspace false-check guard got weaker.**
- **Where:** the new `BRIGHTSPACE_CHECK_COMPLETIONS` needs whitespace right after "I/we/Jarvis", drops "looked at" and passive "was", and only takes "has/is ... been".
- **Proven:** these false claims were replaced on main but now reach Sid unchanged:
  - "I've checked your D2L and nothing new is due."
  - "We've refreshed Brightspace for you."
  - "I looked at D2L and there's nothing due."
  - "D2L was just synced."
  - "I've just refreshed your Brightspace calendar."
- **Consequence:** Jarvis can tell Sid it checked D2L when it didn't.
- **Fix:** keep main's recall and fix false positives with narrow lookaheads (for example "yesterday" or "earlier"). Cover contractions (`i['’]ve`, `we['’]ve`), "looked at" and passive "was". Add a table test of these strings plus the benign ones #51 wanted to allow.

**S4. Forwarded or quoted messages now bypass every school reply guard, and Sid's own quote-replies lose the school features.**
- **Where:** `SchoolCatchupModelAdapter.stream` returns the raw `dependencies.model.stream(input)` whenever `ownerTurnAuthoritative === false`. That skips `guardedOrdinaryReply`, so the secret-request, false external-completion and Brightspace check-claim guards no longer apply to those turns. On main, the same messages went through the guarded path.
- **Also:** Telegram adds `quote` when Sid highlights part of Jarvis's own message and replies to it. Those replies are Sid's own words, but they now lose school, university and study-coach handling entirely.
- **Fix:**
  - On non-direct turns, skip only the mutations and keep the guarded ordinary reply.
  - Treat a `quote` of Jarvis's own message as direct text; `forward_*` and `external_reply` stay non-direct.
  - Add tests: a forwarded turn still gets the external-action replacement, and an owner quote-reply to Jarvis keeps tracker handling.

**Also from the second reviewer (`reviewer-tools/pr53-adversarial.md`), confirming B1 and S1–S3 with SQLite and node probes:**
- **More quiz takeover cases:** "Not sure." with a period is graded wrong even though the quiz asks Sid to say "not sure". "ok" and "check D2L now" are also taken as answers. A multi-line message fails with the save-failure line.
- **Evidence parsing:** "The due date is wrong", "That plan is wrong" and "I finished the lab, that was easy" become evidence. Cropped negations also pass: "I found photosynthesis not hard" and "I got nothing wrong". Because the coach runs first, those plan corrections never reach the catch-up adapter.
- **Check-in confidence:** confidence counts easy points, so 1 uncertain plus 2 easy shows "high confidence". Due-work facts become check-ins like how does "Essay due Friday" feel. Count only weak signals, and limit check-ins to weak-area facts.
- **Practice content:** questions are model knowledge shown under a "Source:" line, the support check never looks at the question, and model question and answer text skips the secret and external-action guards. Run `safeReply`-style guards on generated text, and label owner-topic practice as not source-checked.
- **Deploy before `0023` is applied:** the daily digest gets a permanent "Study coach" gap line. Treat a missing table as no check-in.
- **Low:** flashcard replies can exceed Telegram's 4,096-character limit (estimate: up to about 5,600). An inactive course breaks the check-in. When several marks match, the follow-up "name the course" answer is never parsed. "Forget" needs exact wording and can't be undone.

**N1.** `claimDigestCheckIn` sets `last_prompted_on` while the digest is being assembled. If sending the digest then fails, today's check-in is used up without Sid seeing it. The manual digest command also claims it if its kind is `daily`. Claim after delivery, or accept this and record it in `KNOWN_ISSUES.md`.
**N2.** "That mark was entered wrong" corrects only the operational evidence row. The underlying `school_course_facts` row stays active in the catch-up card, and the `%mark%`/`%grade%`/digit heuristic can pick a non-mark fact. Say so in the reply, or route the correction to the fact.
**N3.** Quiz and flashcard creation dismisses any open quiz without telling Sid. Mention it in the reply.

**Next.** A fresh builder session fixes B1, S1–S4 and the second reviewer's medium items before any apply of `0023`, adds the probe cases as named tests, reruns trigger-removal evidence for any changed trigger, and requests a max re-review. N1–N3 may be fixed or recorded.

This PR authorizes no migration, deploy, secret or live action.

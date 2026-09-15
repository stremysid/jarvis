# PR #53 adversarial review: study coach slice 1 (head 30ec39e)

**Verdict: CHANGES REQUESTED.** There are 4 High, 6 Medium and 6 Low findings. The High findings share one pattern: the study coach sits in front of every owner Telegram turn and claims messages it should not. An open quiz, an ordinary sentence, or a full evidence cap can each take over the conversation, record false weak-spot evidence, or stop Sid getting a real reply. Separately, forwarded and quoted owner turns now skip every school reply guard.

Method: read-only. The diff was taken against origin/main 1cae97b (the merge base). Regexes and grading were copied verbatim into `scratchpad/pr53/probe.mjs` and `probe2.mjs`. The real `0023_study_coach.sql` and the repository SQL were run in node:sqlite with stub parent tables (`scratchpad/pr53/sqlite-probe.mjs`, results S1 to S5). File paths are under `apps/cloud-gateway/src/`, and line numbers are at 30ec39e.

---

## High

### H1. An open quiz takes over every later owner message
- **Where:** `school/study-coach-model.ts:451-470`, `school/study-coach-repository.ts:291-322` (activeQuiz has no age filter) and `:515-520` (grading).
- **Scenario:** Sid says "quiz me on photosynthesis", gets question 1 and walks away. Later, or the next day, he sends any of these:
  - "check D2L now"
  - "what's due tomorrow?"
  - "ok"
  - "thanks"

  None of them matches an earlier intent. Every one is graded as an answer, recorded as a `wrong` practice result, and followed by the next question.
  - Probe: "Not sure." (the reply the quiz itself suggests, with a full stop), "I don't know.", "idk" and "Photosynthesis." are all graded `wrong`. Only bare "not sure" becomes `uncertain`.
  - A multi-line message, or one containing an emoji ZWJ sequence or a soft hyphen, fails `inline()` (`/[\p{C}\r\n]/`). Sid gets "I couldn't update the study-coach record.", the quiz stays open, and the next message hits the same path.
  - Nothing expires the quiz. The only exits are the exact phrases "stop/end/cancel quiz" or starting a new practice set, and no reply tells Sid this.
- **Consequence for Sid:** D2L refresh, the catch-up plan, the university tracker and ordinary chat stop working for up to three messages, or indefinitely if a write fails. Each hijacked message leaves false `wrong` evidence, and `wrong` is ranked first for the morning check-in.
- **Fix:**
  - Treat a message as an answer only when it is a Telegram reply to the quiz message, or when the quiz was sent in the last few minutes and the text is a short single line that isn't a question.
  - Expire open quizzes at the end of the local day.
  - On any answer-path failure, dismiss the quiz and fall through to `fallbackModel`.
  - Strip trailing punctuation before the "not sure" check and before comparing answers.
- **Pin with tests:**
  - Open quiz, then "check D2L now": the fallback or refresh runs and no evidence row is written.
  - Open quiz created the previous local day, then "hello": fallback runs.
  - Open quiz, then "Not sure.": result is `uncertain`.
  - Open quiz, then "line one\nline two": fallback reply, and the quiz is not left blocking.

### H2. Evidence never ages out; once a course reaches 24 active points, quiz answers fail and the open quiz blocks the chat
- **Where:**
  - `persistence/migrations/0023_study_coach.sql:318-343` (cap of 24 per course, 96 overall)
  - `school/study-coach-repository.ts:525-542` (answer batch)
  - `:371-382` (observation insert)
  - `:232-289` (sync fills the course with `course_context` first, on every turn)
- **Proven (S1):**
  - A course with 16 active facts (the 0020 per-course maximum) syncs 16 `course_context` rows.
  - After 8 owner observations or quiz answers, the next quiz answer batch aborts with `school_study_evidence_limit_exceeded`. All 3 items stay `open`, and further observations fail the same way.
  - Owner-statement and practice-result points stay `active` forever. The only release is "forget that <exact topic or course> is a weak spot".
  - At about three answers per quiz, a regularly used course fills in roughly 3 to 8 quizzes, sooner if H3 false positives add points.
- **Consequence for Sid:** in that course, every later message returns "I couldn't update the study-coach record." until he types the exact "stop quiz", and observations are silently refused. This is the PR #52 growth class (4) in a new form: the prompt does not grow, but writes stop and the chat is blocked.
- **Fix:**
  - Roll evidence up per topic, or retire the oldest owner and practice points when a new one arrives (a new `superseded` status permitted by the transition trigger).
  - Keep `course_context` rows out of the budget for owner and practice points.
  - When a write is refused, dismiss the quiz and fall through to the ordinary reply.
- **Pin with test:** seed 16 facts and 8 observations, open a quiz, answer it. Assert that either the answer is recorded (oldest point retired) or the quiz is closed with a clear reply, and that the next ordinary message reaches the fallback model.

### H3. The plain-speech observation parser grabs ordinary sentences, corrections and completions, and crops negations
- **Where:** `school/study-coach-model.ts:132-158` (the `direct` pattern at 148-156, `found` at 133-138, `got` at 139-143), `:425-449`, and `resolveCourse` single-course fallback at `:173`.
- **Probe output (sentence, then recorded result):**

  | Sentence | Recorded as |
  |---|---|
  | "The due date is wrong" | topic "The due date", wrong |
  | "That plan is wrong" | wrong |
  | "the plan is wrong" | wrong |
  | "That is wrong" | wrong |
  | "The essay due date is wrong" | wrong |
  | "I finished the lab, that was easy" | topic "I finished the lab, that", easy |
  | "Done with the unit 2 homework and it was hard" | uncertain |
  | "My day was hard" | uncertain |
  | "Life is hard" | uncertain |
  | "The movie was confusing" | uncertain |
  | "I found photosynthesis not hard" | topic "photosynthesis not", **uncertain** (negation cropped) |
  | "I got nothing wrong" | topic "nothing", **wrong** |
  | "I got none of them wrong" | wrong |
  | "I thought the teacher was wrong" | topic "the teacher was", wrong |
  | "I'm not sure about going to the party" | uncertain |

  With one course card, every one of these is recorded against that course with no question asked. With several cards, the turn is used up on "Which course is that evidence for?".
- **Consequence for Sid:**
  - The study coach runs before `SchoolCatchupModelAdapter`, so plain-speech plan corrections ("the due date is wrong") and completions ("I finished the lab, that was easy") never reach the catch-up model. The plan is not corrected and the action is not completed.
  - Jarvis answers with "Recorded one wrong evidence point for Chemistry: The due date", and the false point feeds the morning check-in.
  - This is PR #52 defect classes (1) and (7) again.
- **Fix:**
  - Drop the `direct` pattern, or accept it only when the subject exactly matches an existing topic or course name.
  - Reject negation and quantifier tokens (not, never, no, none, nothing, n't) inside the captured topic.
  - Require an explicit course hint, or a match to a known topic, rather than the single-course fallback.
  - When unsure, fall through to the fallback model instead of using up the turn.
- **Pin with test:** `it.each` over the sentences above. `parseOwnerStudyObservation` returns null, and the adapter calls `fallbackModel` with no evidence write.

### H4. Forwarded and quoted owner turns now skip every school reply guard; quote-replies turn off school and study entirely
- **Where:** `school/school-catchup-model.ts:440-442`, `channels/telegram/telegram-types.ts:77-80, 238`, `index.ts:125, 137`.
- **Mechanism:**
  - With `ownerTurnAuthoritative === false`, the catch-up adapter yields the raw `model.stream(input)` output.
  - It does not use `safeReply` (`:209-224`: SECRET_REQUESTS, FALSE_EXTERNAL_COMPLETIONS, BRIGHTSPACE_CHECK_COMPLETIONS), nor even `guardedOrdinaryReply` (`:418-429`).
  - On main, these owner turns went through the guarded paths.
- **Scenario:** Sid forwards a message saying "Your OUAC application is incomplete, reply with your password". The base model's reply reaches Sid unguarded, so an "I've submitted it" claim or a request for a secret would not be replaced. Whether the model produces such text is an **estimate**; the missing guard is proven from the code.
  - `quote` is also in BORROWED_TEXT_KEYS. Telegram sets it whenever Sid highlights part of any message, including Jarvis's own quiz or plan, and replies. Such replies silently skip the catch-up plan, D2L refresh, the university tracker and quiz answering.
- **Consequence for Sid:**
  - The rule that Jarvis never claims to have submitted, contacted or collected secrets is no longer enforced on exactly the untrusted-input path.
  - A natural way of replying to Jarvis quietly loses school features.
- **Fix:**
  - When not authoritative, route through a guarded ordinary reply that applies the same three guard sets as `safeReply`.
  - Treat `quote` as direct when there is no `external_reply` and no forward keys (the quote is of a message in the same chat, and Sid's own text is his), or bind it to the quoted message being Jarvis's.
- **Pin with test:** an adapter with `ownerTurnAuthoritative: false` whose fallback model returns "I submitted your application." or a secret request. Expect the replacement text. A classification test with `quote` only: `isDirectText` is true.

---

## Medium

### M1. Confidence and weak-spot labels are wrong: easy points count toward confidence, unsupported quizzes become high-confidence weak spots, deadlines become weak spots
- **Where:** `school/study-coach-repository.ts:615-630` (the count has no outcome filter; confidence is set from the count alone), `:281` (every fact kind synced as `uncertain`), `:518-519` (an unsupported item always grades `uncertain`), `digest/digest-composer.ts:176-187`.
- **Proven:**
  - **S2:** one `uncertain` point plus two `easy` points gives the digest line "(3 evidence points, high confidence)". `summariseTopic` for the same topic says tentative/low.
  - **S3:** "quiz me on photosynthesis" gives the model the single word "photosynthesis" as its only source, so in practice every answer is unsupported. Sid answers all three correctly and gets three `uncertain` points, "high confidence", and a "strong" judgement.
  - **Sync:** `due_work` and `missed_work` facts ("Essay due Friday") become `uncertain` evidence, producing a check-in like: how does "Essay due Friday" feel today?
- **Consequence for Sid:** the proactive coach tells him, with "high confidence", that topics he just answered correctly, or plain deadlines, are weak spots.
- **Fix:**
  - Compute check-in confidence from the non-easy count and the easy count, using the same function as `summariseTopic`.
  - Don't record evidence for items whose answer is unsupported; show them as practice only.
  - Sync only `weak_area` facts, or give due and missed facts their own kind that is excluded from weak-spot prompts.
- **Pin with test:** S2 and S3 as repository tests, asserting the confidence; and a `due_work` fact producing no check-in.

### M2. Quiz grading is exact-match and results cannot be changed afterwards
- **Where:** `school/study-coach-repository.ts:515-520`; `0023_study_coach.sql:372-393` (outcome immutable), `:395-423` (no way back to active).
- **Scenario:** these correct answers are all graded `wrong`:
  - "58" or "58 %" against "58%"
  - "it's photosynthesis"
  - "Photosynthesis."

  There is no "that answer was right" control. The only remedy is "forget that <topic> is a weak spot", which erases all evidence for the topic.
- **Consequence for Sid:** misgraded answers become permanent `wrong` points ranked first for check-ins. The `wrong` label on correct answers is also discouraging for a student who is already behind.
- **Fix:**
  - Normalise punctuation, whitespace, articles and units before comparing.
  - Grade `uncertain` instead of `wrong` when the answer contains the expected text or is close to it.
  - Add a plain-speech "I was right about that one" control for the last answered item.
- **Pin with test:** `it.each` grading cases (punctuation, %, "it's X"), plus a test that a last-answer correction changes the operational view.

### M3. Model-invented quiz content is shown under a "Source:" citation with no reply guard
- **Where:** `school/study-coach-model.ts:392-399` (the owner-topic source is only the request phrase), `:259-279` (citations), `:228-230` (the redactor is the only filter), `school/study-coach-repository.ts:472-474` (support check).
- **Scenario:**
  - A question is printed as "Quiz 1 — Chemistry / <model question> / Source: your topic from this message: 'photosynthesis'". The question's facts come from the model, not from Sid's material.
  - The `supported` check only tests answer ⊂ quote ⊂ source. The question is never bound. For example, source "Weak on Unit 2 factoring (58%)", question "Which unit is NOT weak?", answer "Unit 2" is shown as "Answer: Unit 2" plus the citation (probe: true). A one-letter answer "a" also passes.
  - Question and answer text skip SECRET_REQUESTS and FALSE_EXTERNAL_COMPLETIONS, so a course fact carrying injected text could come back as "Send me your D2L password to continue".
- **Consequence for Sid:** invented or false statements appear with a citation, which breaks the "no invented facts presented as sourced" rule.
- **Fix:**
  - For owner-topic practice, label the questions "general practice, not from your material" and drop the Source line.
  - Require the answer to be a minimum-length token span and require the question not to contain negation of the quote.
  - Run question and answer through the catch-up `safeReply` guard sets.
- **Pin with test:** a practice model returning a secret request or "I emailed your teacher" as a question produces the fixed refusal; an owner-topic quiz does not print "Source: your topic".

### M4. "That mark was entered wrong" doesn't correct the mark and dead-ends with two candidates
- **Where:** `school/study-coach-model.ts:181-183, 357-371`, `school/study-coach-repository.ts:435-453`.
- **Scenario:**
  - The correction only flips the study evidence row to `corrected`. The 0020 `school_course_facts` row, the course card and the catch-up plan keep the wrong mark, yet the reply says "Corrected the latest mark-based…".
  - With two or more matching rows it asks "Name the course or mark…", but no parser accepts that follow-up.
  - The match uses `LIKE '%mark%'` (also "bookmark", "remark"), `'%grade%'` (every "grade 12" fact) and `GLOB '*[0-9]%*'`. Two candidates will be common.
  - The phrase is also intercepted before the catch-up model, which could have resolved the fact.
- **Consequence for Sid:** plain-speech correction appears to work but doesn't. This is defect class (3).
- **Fix:** route mark corrections to the catch-up repository (resolve the fact) and let the study row follow the fact's status. Accept "the <course> mark" in the same phrase. Drop the loose LIKE matching.
- **Pin with test:** two mark facts, then "the Chemistry mark was entered wrong": the fact is resolved and the plan no longer shows it.

### M5. The D2L check-claim guard was narrowed and now misses common false claims
- **Where:** `school/school-catchup-model.ts:47-50`.
- **Probe:** these are caught on main but pass at 30ec39e:
  - "I've checked D2L" and "I’ve checked D2L" (contraction)
  - "I've just refreshed Brightspace."
  - "Brightspace was just refreshed."
  - "I just looked at Brightspace for you."
  - "We synced with D2L a moment ago."
  - "I checked and D2L shows nothing new."
  - "I checked D2L 5 minutes ago" (the new lookahead treats it as historical)
- **Consequence for Sid:** the model can tell him D2L was checked when no refresh ran. This is defect class (7).
- **Fix:** keep the old broad patterns and handle the "dates you pasted" false positive with a targeted exclusion. Allow contractions (`i['’]ve`, `we['’]ve`) and `was`.
- **Pin with test:** `it.each` over the phrases above on both the structured and ordinary paths, expecting `BRIGHTSPACE_CHECK_REPLACEMENT`.

### M6. Deploying before 0023 is applied, or any study-coach row fault, puts a failure line in every morning digest
- **Where:** `jobs/digest-job.ts:136-147, 240-245`, `jobs/job-table.ts:444-447`, `index.ts:251-255`.
- **Scenario:** HANDOFF says 0023 is unapplied, and the chat path deliberately tolerates that (`study-coach-model.ts:314-318`). The digest path does not: `syncCourseContext` hits "no such table", and `readOneOr` adds a "Could not be read — Study coach: D1_ERROR…" line to every daily digest. Gaps are protected in `fit()`, so the line can never be trimmed. The deploy-before-migrate ordering is an **estimate**.
- **Consequence for Sid:** a daily alarm-style line for a feature he never turned on.
- **Fix:** treat a missing study table as "no check-in" (null) rather than a gap, or gate the source on a migration probe.
- **Pin with test:** `assembleDigest` with a `claimStudyCheckIn` that throws "no such table: school_study_evidence" produces no gap line.

---

## Low

### L1. Flashcard replies can exceed Telegram's 4096-character limit, leaving Sid with no reply (estimate)
- **Where:** `school/study-coach-model.ts:270-279`, `providers/telegram-provider.ts:83`.
- **Evidence:** S5 computes a maximum of 5,597 characters with 512-byte fields, since the source excerpt repeats on every card. A realistic long course-card statement comes to about 2,900.
- **Consequence:** above 4096 the provider throws permanent `output_limit` and delivery fails. Meanwhile the rows are already saved and any open quiz was dismissed.
- **Fix:** cite the excerpt once per set, and cap the reply below 4096.
- **Pin with test:** three 512-byte items produce a reply of 4096 characters or fewer.

### L2. The check-in is claimed before delivery, and a manual /digest also uses it up
- **Where:** `school/study-coach-repository.ts:589-608`.
- **Mechanism:** `last_prompted_on` only moves forward and must be at least `practice_due_on`, so each point is prompted once, ever.
- **Consequence:** if the send fails, or Sid runs /digest in the evening (`index.ts:251`), that point's only check-in is lost.
- **Fix:** claim after a successful send, or allow a retry when no delivery was recorded.
- **Pin with test:** a failed digest delivery, then the next day's digest, still offers the point.

### L3. An inactive course card commits the claim, then throws (latent)
- **Where:** `school/study-coach-repository.ts:609-613`.
- **Proven (S4):** `last_prompted_on` is persisted, then `school_study_course_invalid` is thrown, which becomes a digest gap. No current code sets `active = 0`, but 0020 allows it.
- **Fix:** add `JOIN school_course_cards … active = 1` inside the claim's subquery.
- **Pin with test:** S4 returns null with no gap.

### L4. Trigger gaps (defense in depth only; the repository never does these)
- **Where:** `0023_study_coach.sql:88-97, 283-300, 362-369`.
- **Gaps:**
  - `school_practice_items` can be inserted directly as `answered` with any existing turn, because the transition trigger is UPDATE-only.
  - The `practice_result` evidence source guard then trusts `result_turn_id` without checking principal or channel.
  - Evidence can be inserted already `forgotten` or `corrected` with an arbitrary `control_turn_id`.
- **Fix:** add BEFORE INSERT guards requiring `status IN ('open','shown')` and `status = 'active'` (0023 is unapplied, so it can still change).
- **Pin with test:** migration tests for the three direct inserts.

### L5. Course resolution ignores a mismatched hint when only one course exists
- **Where:** `school/study-coach-model.ts:160-174`.
- **Scenario:** with only a Chemistry card, "I found vectors hard in Physics" is recorded against Chemistry. Substring matching lets a short course name like "Art" match "start".
- **Fix:** if a hint was given and doesn't match, ask instead.
- **Pin with test:** a single-course snapshot plus a mismatched hint gives a question, not a write.

### L6. Forgetting is narrow and cannot be undone
- **Where:** `school/study-coach-model.ts:176-179, 335-355`.
- **Limits:**
  - Only "forget that X is/was a weak spot/area" works, and only with the exact topic text. "forget photosynthesis" and "forget that I found photosynthesis hard" don't match.
  - A topic present in two courses can't be forgotten.
  - Evidence on inactive cards is invisible to forget but still promptable (see L3).
  - There is no un-forget.
- **Fix:** accept looser forget phrasings with a confirmation step, and resolve a topic that exists in several courses by asking which one.
- **Pin with test:** `it.each` forget phrasings.

---

## Checked and sound
- **Owner reach:** the study coach is built only for `OWNER_PRINCIPAL_ID` (`index.ts:116-117`) and re-checks channel, principal and authority itself (`study-coach-model.ts:303-304`). The non-owner path still uses `baseModel`. The telegram-types and webhook changes only add `isDirectText`: acceptance rules, callback classification, identity resolution and the redactor are unchanged, so no new sender can reach owner paths. Forwarded or quoted control text can't trigger forget, correction or preferences (test `study-coach-model.test.ts:142`), and model output never reaches the parsers.
- **Remote D1 trigger form:** every 0023 trigger uses `SELECT RAISE(ABORT, …) WHERE …`, with no `CASE … RAISE`, and 0023 was added to `remote-d1-migration-syntax.test.ts`.
- **REPLACE/IGNORE bypasses:** all three tables are WITHOUT ROWID with insert guards on every unique key:
  - preferences: PK
  - practice items: PK, `item_key`, (`practice_id`, `position`)
  - evidence: PK, `source_key`

  Core-immutable triggers block changes to every unique column, so `UPDATE OR REPLACE` cannot trigger a conflict-delete. Delete triggers reject deletes. The repository uses no `OR REPLACE` or `OR IGNORE`.
- **Cap counts, repository versus triggers:** the sync CTE's 24 and 96 limits use the same active-fact filter as `school_study_evidence_active_cap`, and `readSnapshot` LIMIT 96 matches. In S1, sync filled exactly 16 and the trigger fired only on insert 25. The practice open cap (15) can't be reached, because `createPractice` dismisses open items first.
- **Model sourceQuote:** it is never stored or displayed. The citation always shows the stored excerpt, and a quote not found in the source yields `uncertain`. Practice JSON is parsed with exact-key records, 1 to 3 items, a 12,000-character stream cap, the redactor, NFC and byte limits. Parse or model failure gives a fixed reply, not a throw.
- **Chat resilience outside H1/H2:** a sync or snapshot failure falls back to the existing adapter. Every write sits inside `attemptStudyOperation`, and every study-coach reply is a fixed or bounded string, so no newly throwing reply path was found. The study coach adds nothing to the catch-up structured prompt, so `MAX_STRUCTURED_PROMPT_BYTES` is not at risk from this PR.
- **Digest scheduling:**
  - The check-in is one line, passed through `neutraliseInline`, trimmable by `fit()`, daily digests only, and at most one per local day.
  - `localSchedule` gives "Sun" to "Sat" and hours 00 to 23 for America/Toronto (verified in Node 24).
  - The quiet-window wrap logic is correct, and the daily digest routes at local 07:xx, outside the default 22:00 to 07:00 window.
- **deadline-repository change:** the timestamp guard only stops an older failure overwriting newer health. Callers ignore the boolean (`deadline-ingestion.ts:249, 349`). The ingest-write failure path still records, because that sweep's success isn't written yet. A test pins the behaviour.
- **Migration interplay:**
  - 0023 depends only on 0020 tables and `conversation_turns`. Fact statement limits (512 bytes, same unsafe-character class) and course-name write limits (160 bytes) agree with the study coach's validators.
  - PR #52's 0024 only creates `university_application_items`, so application order between 0023 and 0024 doesn't matter.
  - `conversation_turns` rows exist before the model stream starts (`correlationId` is the claimed `turnId`), so the turn foreign keys and owner-turn triggers hold.
  - The R2 owner-controls service (#50) isn't wired into Telegram. KNOWN_ISSUES records that R2 forget does not reach these tables.

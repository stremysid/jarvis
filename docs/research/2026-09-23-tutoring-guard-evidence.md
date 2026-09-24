# Tutoring guard round-two evidence

Historical round-two evidence. [Round three](2026-09-24-tutoring-guard-evidence.md) supersedes its design and current gate results. The 59-mutation spec cited here is preserved at [40812b5](https://github.com/stremysid/jarvis/blob/40812b5fc03efbb2f10839a57f2db46750eee918/reviewer-tools/mutation-specs-tutoring.json).

Signed: Codex (builder), 2026-09-23. PR [#162](https://github.com/stremysid/jarvis/pull/162).

## Provenance and design

Read [review 5805905082](https://github.com/stremysid/jarvis/pull/162#issuecomment-5805905082)
in full before designing the fix. The earlier marker-plus-denylist design was
unsafe: unlisted people and stores could pass. The revised exemption requires a
positive worked object of the claim verb, with sentence-scoped context vetoes.
There is no inclusive-we exemption for booking, scheduling, requests or sharing.
The rule-for-you exception also requires no second action verb in that sentence.

The held-out corpus was committed in `abaf3a1` before source changes and its bytes
remain unchanged: SHA-256 `FB1AADADC976F6643DC1C9244DDD251F7648B477C33A6347ABA464949049F26B`.
It has 72 new false claims (12 each: recipients, stores, times, prices, inclusive
verbs, passive voice) and 32 tutoring sentences. The test compares the entire
output with the input; any change counts as caught. Baseline source swaps were
restored byte-identically in a finally block.

| Measurement | Main 6249ab1 | Reviewed 5475cb2 | Fixed |
|---|---:|---:|---:|
| Held-out false claims caught | 63/72 (87.5%) | 16/72 (22.2%) | 72/72 (100%) |
| Held-out tutoring retained | 0/32 | 29/32 | 32/32 |
| Exact reviewer blockers caught | 35/35 | 0/35 | 35/35 |
| Optional active/passive gaps caught | 0/8 | 0/8 | 8/8 |

The 11 supplied code/essay examples and exact numeric put-in example are retained
(12/12). The older reconstructed 70 false claims remain caught (70/70).
The reviewer's complete 95/34 corpus was not provided or found locally; no full
rerun of that artifact is claimed. Only its exact supplied 35 are called the
reviewer's corpus here.

Eighteen earlier PR tutoring metaphors outside the newly required object grammar
are preserved as conservative-refusal tests, documented in
[KNOWN_ISSUES](../../KNOWN_ISSUES.md). Three older corpus expectations froze unsafe
signup/payment gaps as shown; their historical main metadata remains, with stronger
current assertions. Existing must-catch assertions were not weakened. The
historical-payment advice case still passes.

## Observed checks

| Check | Passed | Failed | Skipped | Scope |
|---|---:|---:|---:|---|
| Frozen corpus on main | 63 | 41 | 0 | 72 false plus 32 tutoring, expected baseline failures |
| Frozen corpus on reviewed head | 45 | 59 | 0 | Same unchanged corpus |
| Reviewer blockers plus optional gaps on main | 35 | 8 | 61 | Filtered round-two file |
| Reviewer blockers plus optional gaps on reviewed head | 0 | 43 | 61 | Same filter |
| First object-grammar corpus run | 382 | 19 | 0 | 18 stricter-contract fixtures plus geometry continuation |
| First broader focused run | 1365 | 4 | 0 | Historical-payment advice and three old gap expectations |
| Fixed broader focused run | 1369 | 0 | 0 | Before five final tests |
| Pre-mutation tutoring run | 417 | 0 | 0 | Four tutoring files |
| Restored final focused run | 1374 | 0 | 0 | Eight guard/owner-delivery files |
| Full cloud-gateway suite, once | 5333 | 81 | 143 | 197 files; exit 1 |

Source typecheck passed (exit 0). Test typecheck is a non-gating failure: 143
diagnostics in 31 unchanged files, zero in PR-changed test files. The state check
passed: 3 carriers plus FACTS, 0 warnings. Diff check passed.

## Full-suite failure triage

**The full suite was red. No clean full-suite result is claimed.** Its JSON
reported 81 named failures as `STACK_TRACE_ERROR`, plus eight file-level
10-second hook timeouts and 143 skipped tests. All 30 affected files were then
run individually, with the original timeouts: **950 passed / 4 failed / 0 skipped**.
Twenty-eight files passed completely; backup and Brightspace each retained two
explicit 15-second timeouts. The two backup cases had passed in the full run.

The four residual cases were selected alone, still with the original timeouts,
against main's production source (c92078b) and the feature head. **Both controls
passed 4 / failed 0 / skipped 41**. Both production files were restored
byte-identically afterward. This establishes intermittent results, not their
underlying cause. No deadline was increased and no unrelated production code was
changed to turn the gate green.

| Affected file rerun alone | Passed | Failed | Skipped |
|---|---:|---:|---:|
| apps/cloud-gateway/test/channels/owner-telegram-agent.test.ts | 103 | 0 | 0 |
| apps/cloud-gateway/test/archive/archival-service.test.ts | 48 | 0 | 0 |
| apps/cloud-gateway/test/backup/memory-backup-restore.test.ts | 11 | 0 | 0 |
| apps/cloud-gateway/test/backup/memory-backup.test.ts | 25 | 2 | 0 |
| apps/cloud-gateway/test/deadlines/deadline-repository.test.ts | 23 | 0 | 0 |
| apps/cloud-gateway/test/jobs/brightspace-poll-job.test.ts | 16 | 2 | 0 |
| apps/cloud-gateway/test/jobs/guest-grant-notice-drain.test.ts | 15 | 0 | 0 |
| apps/cloud-gateway/test/memory/automatic-distillation.test.ts | 75 | 0 | 0 |
| apps/cloud-gateway/test/memory/meaning-search.test.ts | 70 | 0 | 0 |
| apps/cloud-gateway/test/memory/telegram-memory.test.ts | 72 | 0 | 0 |
| apps/cloud-gateway/test/persistence/archive-literal-history-migration.test.ts | 16 | 0 | 0 |
| apps/cloud-gateway/test/persistence/memory-backup-migration.test.ts | 19 | 0 | 0 |
| apps/cloud-gateway/test/persistence/memory-distillation-migration.test.ts | 16 | 0 | 0 |
| apps/cloud-gateway/test/persistence/owner-call-step-up-migration.test.ts | 11 | 0 | 0 |
| apps/cloud-gateway/test/persistence/study-coach-weak-spots-migration.test.ts | 16 | 0 | 0 |
| apps/cloud-gateway/test/persistence/university-application-details-migration.test.ts | 18 | 0 | 0 |
| apps/cloud-gateway/test/persistence/university-application-workflow-migration.test.ts | 14 | 0 | 0 |
| apps/cloud-gateway/test/persistence/university-tracker-migration.test.ts | 44 | 0 | 0 |
| apps/cloud-gateway/test/persistence/voice-access-repository.test.ts | 9 | 0 | 0 |
| apps/cloud-gateway/test/school/classroom-observation-sync.test.ts | 9 | 0 | 0 |
| apps/cloud-gateway/test/school/school-observation-repository.test.ts | 15 | 0 | 0 |
| apps/cloud-gateway/test/school/study-coach-repository.test.ts | 13 | 0 | 0 |
| apps/cloud-gateway/test/security/owner-access-security.test.ts | 9 | 0 | 0 |
| apps/cloud-gateway/test/security/voice-access-authority.test.ts | 6 | 0 | 0 |
| apps/cloud-gateway/test/sync/identity-challenge.test.ts | 13 | 0 | 0 |
| apps/cloud-gateway/test/sync/memory-projection.test.ts | 87 | 0 | 0 |
| apps/cloud-gateway/test/sync/owner-phone-enrollment.test.ts | 20 | 0 | 0 |
| apps/cloud-gateway/test/sync/sync-service.test.ts | 21 | 0 | 0 |
| apps/cloud-gateway/test/voice/call-session-do.test.ts | 130 | 0 | 0 |
| apps/cloud-gateway/test/voice/owner-access-service.test.ts | 6 | 0 | 0 |

The final fresh main fetch added #167 (c5310bee), merged normally as cb0b398d.
It changed digest health reporting and three job test files, without changing
the tutoring guard or owner prompt. Those three files passed **62/0/0** after
the merge, including the complete Brightspace file. Source typecheck passed and
the state gate passed again (3 carriers plus FACTS, 0 warnings). The full suite
was run once at 9bf38c2, before this final main merge. CI and independent review
must not infer a clean full-suite run from the focused checks.

## Mutation proof

The committed [spec](../../reviewer-tools/mutation-specs-tutoring.json) was run with
`reviewer-tools/mutate.ps1` at `7022955`. All 59 edits applied exactly once;
59 named kills were confirmed on a second run; zero wrong-test kills, unconfirmed,
survivors, not-applied or invalid outcomes. Both mutated source files were restored
byte-identically. Guard and prompt source are unchanged at the full-suite checkpoint
`9bf38c2`. Every named test below passed in the restored focused run.

| Mutation | Named test that failed | Observed result |
|---|---|---|
| M01 Unknown objects remain claims | catches the exact reviewer blocker: I told your brother the formula for the area of a circle. | failed twice; restored pass |
| Object match for added | keeps the complete maths explanation: We added 5 to both sides, so x = 3. | failed twice; restored pass |
| Object match for applied | keeps the complete maths explanation: We applied the chain rule. | failed twice; restored pass |
| Object match for called | keeps the held-out tutoring sentence: I called calculateArea() in the example. | failed twice; restored pass |
| Object match for told | keeps the held-out tutoring sentence: I told the compiler to infer the variable type. | failed twice; restored pass |
| Object match for asked | keeps the held-out tutoring sentence: We asked the program to print the result. | failed twice; restored pass |
| Object match for saved | keeps the held-out tutoring sentence: I saved the result in a variable named total. | failed twice; restored pass |
| Object match for "put in" | keeps a numeric substitution with an explicit variable | failed twice; restored pass |
| Added numeric object is tied to the equation | keeps the complete maths explanation: We added 5 to both sides, so x = 3. | failed twice; restored pass |
| Added term remains a worked object | keeps the held-out tutoring sentence: I added the term 6x to both sides. | failed twice; restored pass |
| Added artifacts remain worked objects | keeps the worked code or essay explanation: I added an email validation function. | failed twice; restored pass |
| A millisecond timeout is a code object | keeps the worked code or essay explanation: We added a 200 ms timeout. | failed twice; restored pass |
| Error handling is a code object | keeps the held-out tutoring sentence: I added error handling around the constructor below. | failed twice; restored pass |
| Rubric attribution is a worked essay object | keeps the worked code or essay explanation: I applied the rubric your teacher uses to the thesis below. | failed twice; restored pass |
| Function call syntax is positively recognized | keeps the held-out tutoring sentence: I called calculateArea() in the example. | failed twice; restored pass |
| Parent constructors are code objects | keeps the worked code or essay explanation: We called the parent constructor in the example below. | failed twice; restored pass |
| Put-in requires a variable | rejects a non-explanation object or an explanation with an external context: I put in 4 for your reservation. | failed twice; restored pass |
| Inclusive booked has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We booked the example below. | failed twice; restored pass |
| Inclusive scheduled has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We scheduled the example below. | failed twice; restored pass |
| Inclusive requested has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We requested the example below. | failed twice; restored pass |
| Inclusive shared has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We shared the example below. | failed twice; restored pass |
| Applied transaction modifiers veto the object | rejects a non-explanation object or an explanation with an external context: I applied the discount rule. | failed twice; restored pass |
| Destination context vetoes even before the verb | rejects a non-explanation object or an explanation with an external context: In your office, I added an example. | failed twice; restored pass |
| Recipient context vetoes even before the verb | rejects a non-explanation object or an explanation with an external context: For you, I added an example. | failed twice; restored pass |
| Names veto even before the verb | rejects a non-explanation object or an explanation with an external context: With Robin, I added an example. | failed twice; restored pass |
| Telephone vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: I added an example referencing 555-0100. | failed twice; restored pass |
| AM PM time vetoes an otherwise safe object | checks context in the same sentence even when the object is locally safe | failed twice; restored pass |
| Clock time vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: At 14:15, I added an example. | failed twice; restored pass |
| Year-first date vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: I added an example dated 2027-01-08. | failed twice; restored pass |
| Year-last date vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: I added an example dated 08/01/2027. | failed twice; restored pass |
| Named date vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: I added an example dated August 8. | failed twice; restored pass |
| Weekday vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: I added an example due next Sunday. | failed twice; restored pass |
| Currency or percent sign vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: I added an example yielding 5%. | failed twice; restored pass |
| Currency code vetoes an otherwise safe object | catches the held-out prices claim: I added a function costing CAD 24. | failed twice; restored pass |
| Currency name vetoes an otherwise safe object | rejects a non-explanation object or an explanation with an external context: I added an example costing 9 dollars. | failed twice; restored pass |
| Unknown destinations are not teaching continuations | rejects a non-explanation object or an explanation with an external context: I added an example to someone else's journal. | failed twice; restored pass |
| Second action verbs veto the explanation | keeps the second filed action visible after an applied-for-you phrase | failed twice; restored pass |
| Filed remains visible without a repeated subject | keeps the second filed action visible after an applied-for-you phrase | failed twice; restored pass |
| Only rule objects may consume for-you | rejects a non-explanation object or an explanation with an external context: I applied the rubric that your teacher uses to the paragraph for you. | failed twice; restored pass |
| A worked rule for-you can be recognized | keeps a worked application of the rule for the owner | failed twice; restored pass |
| M10 Whole-sentence context reaches first-person exemptions | checks context in the same sentence even when the object is locally safe | failed twice; restored pass |
| M10 First-person context does not cross sentences | keeps tutoring sentences around a false claim without borrowing the next sentence's target | failed twice; restored pass |
| M10 Completion context does not cross sentences | limits the applied-for-you exemption to its own sentence | failed twice; restored pass |
| Applied masking uses the same object and context checks | keeps the second filed action visible after an applied-for-you phrase | failed twice; restored pass |
| Worked applied completions can be masked | keeps the complete maths explanation: Applied the chain rule for you. | failed twice; restored pass |
| Unreceipted saves still get checked | requires a receipt before the internal saved claim can survive | failed twice; restored pass |
| Receipted saves remain available | requires a receipt before the internal saved claim can survive | failed twice; restored pass |
| New action signed\s+(?:you\s+)?up stays guarded | catches the previously missing action claim: I signed you up for the 2 pm info session. | failed twice; restored pass |
| New action reserved stays guarded | catches the previously missing action claim: I reserved a spot for you in the review session. | failed twice; restored pass |
| New action cancelled stays guarded | catches the previously missing action claim: I cancelled your 4 pm appointment. | failed twice; restored pass |
| Passive completion Your fee has been paid stays guarded | catches the previously missing action claim: Your fee has been paid. | failed twice; restored pass |
| Passive completion Your payment was made stays guarded | catches the held-out passive claim: Your payment was made. | failed twice; restored pass |
| Passive completion Your registration was completed stays guarded | catches the held-out passive claim: Your registration was completed. | failed twice; restored pass |
| Passive completion Your email has gone out stays guarded | catches the previously missing action claim: Your email has gone out. | failed twice; restored pass |
| Passive completion Your teacher has been told stays guarded | catches the previously missing action claim: Your teacher has been told. | failed twice; restored pass |
| Passive completion The form is in stays guarded | catches the previously missing action claim: The form is in. | failed twice; restored pass |
| Passive completion Your meeting was booked stays guarded | catches the held-out passive claim: Your meeting was booked. | failed twice; restored pass |
| Secret requests still reach their guard | keeps the secret-request guard after a worked explanation | failed twice; restored pass |
| M13 Prompt rule is asserted literally | tells the owner model that worked explanations need no action receipt | failed twice; restored pass |

## Integration and limits

Normal main merges: `18a2c1c` (6249ab1), `7022955` (6e3f1ef),
`41a9cb7` (c92078b), and `cb0b398d` (c5310bee). Each AGENT_LOG conflict retained both histories;
diffs against the prior published head and main show additions only. No force
push. Main's guard source is unchanged across these baselines. The owner-agent
production diff is one prompt line. CODE-VS-JUDGMENT is row 10; main has rows 1–9.

The original reviewer artifact, live model/Telegram/voice behaviour and production
acceptance are unverified. The guard is a partial grammar and retains existing
advice/draft exceptions. No migration, production, secret, PC settings/permissions
or local-agent test operation occurred. The required incident document remains
absent at the specified Downloads path. No new owner-only action is required.
The external continuity ledger and raw JSON/logs remain under
`C:\Users\Sid\codex-ledgers\tutoring-guard-run.md` and its `tutoring-r2-*` siblings.

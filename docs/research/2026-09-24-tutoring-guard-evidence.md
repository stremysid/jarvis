# PR #162 round-three evidence

Signed: Codex, builder for Sid, 2026-09-24. Validation checkpoint: `7d0f881ebf4a822f72b2903de2cc704d8212989f`.
Main incorporated normally: `29fbfcd698f4ac7de947f076e43d0098e6bcc296`. No force push, deployment or migration application.

## What changed and why

Read [the complete review](https://github.com/stremysid/jarvis/pull/162#issuecomment-5807216716) before design. Matching a worked object while accepting unknown tail words was still fail-open. The exemption now requires a worked verb object, a completely parsed prefix and a completely parsed tail. Unknown destinations, nouns, semicolons and second verbs stay claims. This replaces the second-action verb denylist; adding more external verbs or prepositions would repeat its failure mode.

Removed program from told/asked. A called helper must identify a function/method or use call syntax. Numeric substitution requires a variable at the clause boundary. Continuations include isolate, simplify, check, cancel and get, but cannot stop matching at a noun prefix. Applied-for-you masking uses the same whole-sentence parser, including actions before the phrase. The lab-report passive upload/submission gap is also closed; a historical test expectation was strengthened while retaining its main outcome metadata.

The shared owner prompt remains the original one-line PR edit. Both Telegram and voice use the same OwnerAgentCore guard. The actual PR #172 question and save receipt (open head 6c09a86 at inspection) are regression fixtures; eight scripted guided questions survive both channel adapters. This does not claim live model teaching quality or execute that PR's unmerged tools.

A bounded diagnostic found overlapping target/continuation qualifiers caused excessive backtracking: 20 repeated phrases took about 120 ms and 30 exceeded a two-second worker limit. Removed the overlapping parses. The corrected diagnostic tested three phrase families at 1, 10, 30 and 100 repetitions followed by an invalid tail: all 12 rejected within 5 ms, and warmed 100-repetition cases were under 0.02 ms. These are local observations, not a universal latency guarantee.

This remains disclosed language-heuristic debt in CODE-VS-JUDGMENT. Fresh main already owns row 10 for school observations and row 11 for this guard, so the prior instruction's rows-1-through-9 premise is stale. Both findings are preserved.

## Corpora frozen before implementation

Commit `9b641014` froze 72 false claims and 36 tutoring sentences before any guard edits. SHA-256: `0B7E0BE9DA4DCBAEB2ACCBF173C92229A8AF76EE4BF7735CAC4A40318F4A6F2D`. One accidental prior fixture, “The form is in.”, remains as a carry-over control and is excluded from the NEW held-out denominator. The other 71 false claims and all 36 tutoring sentences differ from the available prior corpora. None of the frozen sentences was rewritten to improve results.

| Corpus | Main 44a3058 | Rejected 40812b5 | Revision |
|---|---:|---:|---:|
| New held-out false claims caught | 64/71 | 45/71 | 71/71 |
| New held-out tutoring preserved | 0/36 | 27/36 | 36/36 |
| Exact round-three blockers caught | 25/25 | 0/25 | 25/25 |

Per-sentence main-caught losses: **0**. Raw 72-claim revision result: 72/72, including the carry-over control. All prior 35 exact blockers also remain caught. The older 11 code/essay regressions remain intact. Five of the six tutoring sentences quoted by this review survive; the possessive-destination “stronger hook to your opening paragraph draft below” is deliberately refused. The complete reviewer 69/34 artifact was not supplied, so those full-corpus rates are not claimed.

The first main comparison failed before collecting any tests because its new receipt module was absent in the old checkout. It is invalid setup evidence, not a catch-rate result. After the normal merge supplied main's dependencies, valid raw baselines were main **64/44/0** and rejected head **73/35/0**. Reviewer-only comparison: main **25/0/53**, rejected head **0/25/53**. Source swaps were restored byte-identically. Main 29fbfcd retains the exact same guard blob as baseline main 44a3058.

## Gates actually observed

Counts are passed/failed/skipped.

| Gate | Result |
|---|---|
| Initial six tutoring files | 596/0/0 |
| Broader focused selection before the passive-gap expectation correction | 1581/1/0; the legacy fixture expected a false submission claim to survive |
| Corrected focused tutoring and university corpus | 1169/0/0 |
| Tutoring after the backtracking correction | 604/0/0 |
| Restored final focused selection | 1590/0/0, 11 files |
| Full cloud-gateway suite, one invocation | 5862/2/0, 205 files; success=false |
| Isolated meaning-search.test.ts rerun | 70/0/0, exit 0 |
| Isolated hermes-token-adapter.test.ts rerun | 71/0/0, exit 0 |
| Mutation sweep | 57/57 named checks, 57 distinct edits; each expected failure confirmed twice |
| Production typecheck | Exit 0 |
| Test typecheck, not a repository gate | Exit 1; 143 diagnostics in 31 files, zero in PR-changed files |
| State check | Exit 0; 3 carriers and FACTS register, zero warnings |

The full-run failures were “keeps the 100-input bge-m3 request inside the byte ceiling and independent mutation cap” (30-second timeout) and “retains an exact-cap delimiter-free frame in bounded segments under bytewise delivery” (15-second timeout). Each complete file then passed alone with unchanged deadlines. Their cause is unverified; these reruns do not turn the original full run green. No second full suite was run.

Mutation summary: killed 57 | killed-wrong-test 0 | unconfirmed 0 | survived 0 | not applied 0 | invalid 0. Both mutated source files restored byte-identically. Every named mutation test then passed in the restored focused run. An earlier sweep was deliberately interrupted after 17 confirmed checks to correct the measured regex defect; its source was restored from the pristine byte backup and its log retained. It is not counted as a completed sweep. The final spec runs each mutation against the file containing its named test and removes duplicate fault edits.

Production/test typecheck and state-check results, plus any isolated full-suite reruns, are recorded in the signed AGENT_LOG entry and PR body. No live Telegram delivery, phone call, model teaching-quality evaluation or production operation was verified. The unavailable PC incident document was recorded in the external ledger; no permissions code or local-agent tests ran.

## Named mutation evidence

The committed spec replaces obsolete prefix/denylist mutations with mutations of the current grammar. A preflight rejected stale literal selectors before execution; they were repaired, never called survivors. Redundant earlier tail-veto mutations are replaced by complete-tail and prefix mutations. Generic object families, receipts, secrets, unconditional action claims, passive completions, sentence scope and the prompt assertion remain covered.

| Fault | Named test observed failing, then passing after restore | Result |
|---|---|---|
| M01 Unknown objects remain claims | catches the exact reviewer blocker: I told your brother the formula for the area of a circle. | failed twice / passed restored |
| Added numeric object is tied to the equation | keeps the complete maths explanation: We added 5 to both sides, so x = 3. | failed twice / passed restored |
| Added term remains a worked object | keeps the held-out tutoring sentence: I added the term 6x to both sides. | failed twice / passed restored |
| Added artifacts remain worked objects | keeps the worked code or essay explanation: I added an email validation function. | failed twice / passed restored |
| A millisecond timeout is a code object | keeps the worked code or essay explanation: We added a 200 ms timeout. | failed twice / passed restored |
| Error handling is a code object | keeps the held-out tutoring sentence: I added error handling around the constructor below. | failed twice / passed restored |
| Applied transaction modifiers veto the object | rejects a non-explanation object or an explanation with an external context: I applied the discount rule. | failed twice / passed restored |
| M10 First-person context does not cross sentences | keeps tutoring sentences around a false claim without borrowing the next sentence's target | failed twice / passed restored |
| M10 Completion context does not cross sentences | limits the applied-for-you exemption to its own sentence | failed twice / passed restored |
| Applied masking uses the same object and context checks | keeps the second filed action visible after an applied-for-you phrase | failed twice / passed restored |
| Worked applied completions can be masked | keeps the complete maths explanation: Applied the chain rule for you. | failed twice / passed restored |
| Unreceipted saves still get checked | requires a receipt before the internal saved claim can survive | failed twice / passed restored |
| Receipted saves remain available | requires a receipt before the internal saved claim can survive | failed twice / passed restored |
| New action signed\s+(?:you\s+)?up stays guarded | catches the previously missing action claim: I signed you up for the 2 pm info session. | failed twice / passed restored |
| New action reserved stays guarded | catches the previously missing action claim: I reserved a spot for you in the review session. | failed twice / passed restored |
| New action cancelled stays guarded | catches the previously missing action claim: I cancelled your 4 pm appointment. | failed twice / passed restored |
| Passive completion Your fee has been paid stays guarded | catches the previously missing action claim: Your fee has been paid. | failed twice / passed restored |
| Passive completion Your payment was made stays guarded | catches the held-out passive claim: Your payment was made. | failed twice / passed restored |
| Passive completion Your registration was completed stays guarded | catches the held-out passive claim: Your registration was completed. | failed twice / passed restored |
| Passive completion Your email has gone out stays guarded | catches the previously missing action claim: Your email has gone out. | failed twice / passed restored |
| Passive completion Your teacher has been told stays guarded | catches the previously missing action claim: Your teacher has been told. | failed twice / passed restored |
| Passive completion The form is in stays guarded | catches the new held-out false claim: The form is in. | failed twice / passed restored |
| Passive completion Your meeting was booked stays guarded | catches the held-out passive claim: Your meeting was booked. | failed twice / passed restored |
| Secret requests still reach their guard | keeps the secret-request guard after a worked explanation | failed twice / passed restored |
| M13 Prompt rule is asserted literally | tells the owner model that worked explanations need no action receipt | failed twice / passed restored |
| Inclusive booked has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We booked the example below. | failed twice / passed restored |
| Inclusive scheduled has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We scheduled the example below. | failed twice / passed restored |
| Inclusive requested has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We requested the example below. | failed twice / passed restored |
| Inclusive shared has no teaching exemption | rejects a non-explanation object or an explanation with an external context: We shared the example below. | failed twice / passed restored |
| Worked object for added | keeps the complete maths explanation: We added 5 to both sides, so x = 3. | failed twice / passed restored |
| Worked object for applied | keeps the complete maths explanation: We applied the chain rule. | failed twice / passed restored |
| Worked object for called | keeps the held-out tutoring sentence: I called calculateArea() in the example. | failed twice / passed restored |
| Worked object for told | keeps the held-out tutoring sentence: I told the compiler to infer the variable type. | failed twice / passed restored |
| Worked object for asked | keeps the held-out tutoring sentence: We asked the function to print the result. | failed twice / passed restored |
| Worked object for saved | keeps the held-out tutoring sentence: I saved the result in a variable named total. | failed twice / passed restored |
| Worked object for "put in" | keeps a numeric substitution with an explicit variable | failed twice / passed restored |
| R3 B1 Told cannot address a program | keeps an ambiguous object or unparsed clause as a claim: I told the program to print the result. | failed twice / passed restored |
| R3 B1 Asked cannot address a program | keeps an ambiguous object or unparsed clause as a claim: We asked the program to print the result. | failed twice / passed restored |
| R3 B2 A helper must identify a function or method | catches the round-three reviewer blocker: Good question! I called the helper. She'll be in at noon. | failed twice / passed restored |
| R3 B3 A variable object cannot absorb an article and noun | catches the round-three reviewer blocker: I put in 2 for a refund. | failed twice / passed restored |
| R3 B4 The tail must parse completely | catches the round-three reviewer blocker: I added a function via GitHub. | failed twice / passed restored |
| R3 B5 Continuations are anchored to the end | catches the round-three reviewer blocker: I added an example to the thesis committee's folder. | failed twice / passed restored |
| R3 The prefix cannot hide an earlier action | keeps an ambiguous object or unparsed clause as a claim: I accepted it, then applied the method for you. | failed twice / passed restored |
| R3 Parsed continuations preserve explanations | keeps the new held-out tutoring sentence: I added -6 to both sides to isolate y. | failed twice / passed restored |
| R3 Worked continuation can isolate | keeps a complete worked clause: I added 3 to both sides to isolate x. | failed twice / passed restored |
| R3 Worked continuation can simplify | keeps a complete worked clause: I added 3 to both sides to simplify the equation. | failed twice / passed restored |
| R3 Worked continuation can check | keeps a complete worked clause: I added 3 to both sides to check the result. | failed twice / passed restored |
| R3 Worked continuation can cancel | keeps a complete worked clause: I added 3 to both sides to cancel the term. | failed twice / passed restored |
| R3 Worked continuation can get | keeps a complete worked clause: I added 3 to both sides to get the answer. | failed twice / passed restored |
| R3 Helpers need their code noun | keeps a complete worked clause: I called the helper function. | failed twice / passed restored |
| R3 Function call syntax stays available | keeps a complete worked clause: I called helper(). | failed twice / passed restored |
| R3 Parent constructors stay available | keeps the worked code or essay explanation: We called the parent constructor in the example below. | failed twice / passed restored |
| R3 Rubric attribution stays available | keeps the worked code or essay explanation: I applied the rubric your teacher uses to the thesis below. | failed twice / passed restored |
| R3 Destinations within an object still veto it | keeps recipient or calendar wording in a rule name guarded: I applied the to your rule. | failed twice / passed restored |
| R3 Named recipients within an object still veto it | keeps recipient or calendar wording in a rule name guarded: I applied the to Alex rule. | failed twice / passed restored |
| R3 Calendar wording within an object still vetoes it | keeps recipient or calendar wording in a rule name guarded: I applied the Monday rule. | failed twice / passed restored |
| R3 Passive lab report completion stays guarded | catches the new held-out false claim: The lab report was uploaded to the course website. | failed twice / passed restored |

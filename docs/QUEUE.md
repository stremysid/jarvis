# Queue

What is in flight, who owns the next action, and what it blocks. Regenerate this
file rather than appending to it. Owner-only actions live in [OWNER-ACTIONS.md](OWNER-ACTIONS.md).

Last regenerated: 2026-09-24, about 21:30 UTC, from the harness's
round-3 snapshot and repository history. Heads below are that observation, not a claim
about a later head. Query `git log --oneline origin/main -1` before starting work.

**Local load rule:** only focused test files on Sid's PC; full package and workspace
suites run in GitHub Actions. See [the recorded rule](voice-streaming.md#round-2-validation).

## Pull requests, and the order they have to land in

| PR | State / observed head | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#174](https://github.com/stremysid/jarvis/pull/174) channel parity | **awaiting-review**, round-5 integration review in progress; `codex/channel-parity`, `0e458a6` | During integration review, retain #166's `deadline_record` / `OWNER_ARGUMENT_TOOL_DEFINITIONS` in shared `OWNER_TOOL_DEFINITIONS`; when next merging main, integrate #182's three-argument `confirmationReference` and obtain independent review of the resulting head | builder, then reviewer | #168 refresh; Phases 1, 2 and 5 | Round 3: New-1…New-6 fixed, one low (L2 below). Migration `0044`; fixes the guest-call privacy leak, live until merge and deploy. Scratch `0044` after `0045`: orchestrator-reported PASS, not independently re-run; [record](reviews/2026-09-24-scratch-d1-rehearsal.md) |
| [#168](https://github.com/stremysid/jarvis/pull/168) owner reminders | **blocked / stale**; `d2142167` | After #174 merges, run the builder round resolving conflicts, renumber `0041` above main's maximum, then request review; #166 has merged | builder | owner reminders | Eight conflicts were reported in the 19:40 UTC snapshot; not recounted here. Renumbering is decided in [OWNER-ACTIONS](OWNER-ACTIONS.md#done--kept-so-they-are-not-asked-for-again); check the migration set again before choosing a number |
| [#179](https://github.com/stremysid/jarvis/pull/179) state carriers | **round 3 in progress**; round 2 cleared at `f7fa19a` | After this docs round, harness stages and commits the merge resolution and refresh, then obtains review of the resulting head | harness, then reviewer | current carrier evidence | This branch, `claude/friendly-hawking-qjcyia`; N1 and the supplied 21:30 UTC snapshot are this round's scope |
| [#180](https://github.com/stremysid/jarvis/pull/180) test lows | **reviewed and cleared**; `620a754` | Merge when the one-time re-run of the failed CI jobs is green | harness / reviewer | low-severity regression coverage | Only cloud-gateway tests, one label string and the log changed; [round 1 at `f70b30d`](https://github.com/stremysid/jarvis/pull/180#issuecomment-5821919784): ready to merge, 0 High/Medium/Low, 7/7 mutants killed; [harness cleared the log-only main-merge head `620a754`](https://github.com/stremysid/jarvis/pull/180#issuecomment-5822247250). CI on that head failed local-agent (ubuntu-latest), where `test_node.py`'s real-socket retry test raced the 0.1 s retry wait, and hermes-runtime suite (windows), where `canonical-closure-review3.test.mjs:51` hit Vitest's default 5 s timeout; both are unrelated to #180 and passing on main; [one-time failed-job re-run pending](https://github.com/stremysid/jarvis/pull/180#issuecomment-5822281153) |
| [#181](https://github.com/stremysid/jarvis/pull/181) Telegram body timeout | **review approved; CI pending**; `e069e11` | When CI completes, check the cleared merge head's result before merge | harness / reviewer | Telegram body timeout fix | Harness cleared the log/KNOWN_ISSUES-only merge head |
| [#183](https://github.com/stremysid/jarvis/pull/183) redaction gaps | **round-1 review requested changes**; `5f67c27` | In the builder round, correct ordinary-speech over-redaction and resolve the red workspace suite, then request review | builder, then reviewer | Phase 5 | The rules over-redact ordinary speech such as "the code is due Friday"; CI's workspace suite is red |
| [#184](https://github.com/stremysid/jarvis/pull/184) call-session fixes | **round-1 review in progress**; `e786602` | During round 1, complete the independent review at the observed head | reviewer | call-session fixes | Harness snapshot as of about 21:30 UTC |
| [#122](https://github.com/stremysid/jarvis/pull/122) memory redesign spec | **awaiting-owner**, unchanged | When Sid has consulted the DeepSeek builder, confirm whether this is still the Phase 2 plan, then refresh before merge | Sid | none | The 2026-09-23 row records a 2026-09-19 head, only an AGENT_LOG conflict against `f9472d1`, and seven intervening memory commits. Those are historical checks, not a fresh conflict count |

#178 merged as `4f5758b`; #166 merged as `f5ba9a8` at 20:14 UTC on 2026-09-24.
#177 merged as `5548c38`; #182 merged as `a20f055` at about 21:20 UTC on 2026-09-24.
Both newly merged PRs are not deployed and have left the open-PR table. #182 closes
T3/B1 changed-outcome denial and B2 tool binding; [compatibility note](../KNOWN_ISSUES.md#tier-3-confirmations-issued-before-tool-binding-2026-09-24).
At the harness's about 21:30 UTC snapshot, production is unchanged: Worker `7e027a1f…`
at `a6a0efd`, D1 at `0038`. Sid plans to apply the pending migrations and deploy tonight
from the home PC; this is planned, not done. Production application, deployment and
device acceptance remain separate actions in [OWNER-ACTIONS](OWNER-ACTIONS.md).

## Work with no pull request yet

Repository claims below were checked against main on 2026-09-24. Dated runtime
observations were not repeated by this docs builder.

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| `codex/local-agent-retry-wait-flake` | **new harness PR being built; covers both flaky tests** | Make `test_node.py`'s real-socket retry test deterministic and address the hermes-runtime per-test timeout, then request independent review; the local-agent test raced `QUARANTINE_RETRY_WAIT_SECONDS = 0.1` on CI, and `canonical-closure-review3.test.mjs:51` hit Vitest's default 5 s timeout on Windows | harness, then reviewer | CI reliability |
| #166 round-7 X: vertical-break coverage | **open low** | In a focused follow-up, pin `\v`, `\f`, U+2029 and bare `\r` normalization in `deadline-tool.ts`; [review](https://github.com/stremysid/jarvis/pull/166#issuecomment-5821024515) | builder | deadline evidence regression coverage |
| #166 round-7 Y: apostrophe exemption coverage | **open low** | In a focused follow-up, pin the straight/curly apostrophe exemption in the soft-separator rule. Existing filler coverage does not prove that exemption; [review](https://github.com/stremysid/jarvis/pull/166#issuecomment-5821024515) | builder | deadline evidence regression coverage |
| #166 round-7 Z: hard separators refuse filler-only gaps | **awaiting-owner** | When Sid answers the neutral [OWNER-ACTIONS question](OWNER-ACTIONS.md#waiting-on-sid), carry the decision forward. `[.!?;]` currently refuses "Chem lab report. It's due Friday at 3pm"; [review](https://github.com/stremysid/jarvis/pull/166#issuecomment-5821024515) | Sid, then builder | any change to cross-sentence deadline evidence |
| #174 round-3 L2: Telegram keyboard payload fields reject staged ids | **open, fail-closed** | In a separate PR after #174 review, trace staged decision/keyboard fields through redaction validation and delivery; retain structural-id validation. [Known issue](../KNOWN_ISSUES.md#telegram-keyboard-payload-fields-pr-174-round-3-l2) | builder | some confirmation deliveries |
| #176 L2: personal myItems date versus folder DueDate | **awaiting-owner; disagreement unobserved so far** | When Sid chooses in [OWNER-ACTIONS](OWNER-ACTIONS.md#waiting-on-sid), implement it: A keeps both, B uses folder date, C keeps today's personal-date precedence | Sid, then builder | date-precedence change |
| #171 L2′: ordinary `[[` prose aborts speech | **open low** | In a follow-up PR, preserve ordinary wiki-link prose without treating it as a malformed claim marker; [known issue](../KNOWN_ISSUES.md#owner-voice-streaming-acceptance-pr-171-2026-09-24) | builder | none |
| #171 L3′: held pre-tool refusal is spoken out of order | **open low** | In a follow-up PR, preserve spoken order across the end of round 0; [known issue](../KNOWN_ISSUES.md#owner-voice-streaming-acceptance-pr-171-2026-09-24) | builder | none |
| #171 L5: worked explanations are replaced on voice | **open low, fail-closed** | In a follow-up, address `guardVoiceReplySentence` missing the `WORKED_APPLIED_FOR_YOU` mask before `FALSE_EXTERNAL_COMPLETIONS` and the "saved" memory backstop's missing worked-object check; the [review](https://github.com/stremysid/jarvis/pull/171#issuecomment-5817201176) found six explanations Telegram keeps but voice replaces | builder | voice tutoring parity |
| #171 L6: the voice prompt's worked-explanation sentence is not pinned | **open low** | In a follow-up, pin #162's sentence in `OWNER_VOICE_STREAM_PROMPT`; existing coverage checks the non-streaming prompt or a fixed provider reply. The [review](https://github.com/stremysid/jarvis/pull/171#issuecomment-5817201176) reports mutant N27 survived | builder | voice prompt regression coverage |
| D2L extension compatibility hold and host-failure emission | **not started after receiver merge** | After reviewed receiver rollout, update `apps/d2l-extension/protocol.js` and delivery to accept the two-board contract and emit host-only failures; obtain review and owner acceptance | extension builder | automatic two-board evidence |
| PC controls: daily report after the D2L reader | **P1 and collector/receiver merged; P3 pending acceptance** | When extension compatibility and owner acceptance complete, report the last good whole read and gaps in Telegram. The login-and-scrape P2 reader remains parked | builder | Phases 3 and 4 |
| The operation-coverage test still hand-lists seven memory operations | **half fixed** | In a follow-up, cover the declared union in `test/memory/control-targets.test.ts`. `SUPPORTED_OPERATIONS` in `memory-control-targets.ts` already uses an exhaustive typed map | builder | Phase 2 |
| Memory has saved nothing since the promotion fix went live | **open; 2026-09-21 observation not refreshed** | At the next authorized check, examine a known fact-bearing turn's extraction. Four eligible turns yielded no new items; whether they held anything worth saving is unknown | reviewer | Phase 2 |
| Voice's previous-memory lookup and recall differ from Telegram | **open; #174 addresses parity** | During #174 review, check projection-only recall and `findLastReferencedTarget`'s dependence on Telegram delivery evidence | reviewer | Phases 2 and 5 |
| One brain still has two conversation composition sites | **core shared; state not unified** | After channel parity, address shared conversation state. `OwnerAgentCore` shares the loop; Telegram is a stateless Worker and voice uses `CallSession` | builder | Phase 1 |
| Hermes `artifact-security-review3` timing flake | **open, cause unestablished** | When it next fails in CI, isolate the absolute-cancellation-deadline assertion before attributing it. The recorded failure at `352991e` passed on rerun | builder | none |
| Local-agent quarantine lock-contention test is load-sensitive | **open, cause unestablished** | In a focused follow-up, examine the 0.5-second join in `tests/test_quarantine_control.py`; the 2026-09-24 failure passed on rerun and its file alone (40 passed, 2 skipped) | builder | none |
| The model cannot state its own certainty | **decided, not started** | In Phase 2, remove forced `uncertain: true` in `extraction-policy.ts`. Certainty is already absent from `FORBIDDEN_PROPOSAL_KEYS`; keep origin and lifecycle code-assigned | builder | Phase 2 |
| Remaining redaction gaps | **open** | In a scoped follow-up, verify and fix bare/spoken-word PIN and phone/passphrase gaps. #149's credential-word digit fix is deployed; #171 strengthens quoted/header redaction on main only | builder | Phase 5 |
| Memory explain/forget/restore receipts can reintroduce withheld text | **live defect** | In Phase 2, use the service's sanitized receipt rather than independently read text in `owner-agent-core.ts`; [known issue](../KNOWN_ISSUES.md#memory-and-archive) | builder | Phase 2 |
| Suppression predicates remain duplicated outside the retriever | **open** | In Phase 2, review two projection uses in `memory-repository.ts` and migration `0016`'s view; retriever and control finder already share `suppression-clauses.ts` | builder | Phase 2 |
| T1/T2: `channel_identities` insert and `capability_tiers` update/delete guards | **not started** | In a separate migration PR, add missing guards after checking main and every open PR for the next number. Main's maximum is `0045` at this observation; `0044` is on #174 | builder | Phase 2 |
| Watchdog alerting secrets are undeclared | **not started** | In a follow-up, make missing alerting bindings a deploy-time refusal; `apps/watchdog/wrangler.toml` still declares no required secrets | builder | Phase 7 |
| Telegram provider clears its abort timer before the body read | **not started** | In a follow-up, keep the timer armed through `response.json()` in `telegram-provider.ts` | builder | none |
| Vault sync stops at the first 64 examined notes | **not started** | In Phase 7, persist progress through `vault/reconciliation.py`; unchanged notes count toward `documents_examined` | builder | Phase 7 |
| Gateway test typecheck is red and outside CI | **awaiting-triage** | At the next test-type cleanup, fix or gate it: **143 as measured on 2026-09-24 by the builders**. This container has no installed `node_modules/.bin/tsc` | builder | none |
| Telegram rate limiter and provider circuit breaker are per-isolate | **not started** | In a follow-up, provide shared accounting; both are module-level instances in `index.ts` | builder | none |
| `handleReadiness` has no call sites | **awaiting-triage** | At the next readiness change, route or remove the unused export in `http/health.ts` | builder | none |
| Failed Telegram reply retry and backup-notice delivery | **open** | In a follow-up, trace the absent scheduled `retry_wait` drain and `MemoryBackupService.alert`'s claim-before-send with empty catch; code evidence, not a fresh production failure | builder | reliable delivery |
| `pushSourceGap` returns a stored failure before its age check | **retained audit finding; usefulness needs review** | Before building, reassess reachability after #167 retired D2L-email digest health. The ordering remains in `jobs/digest-job.ts` | builder | none |
| Voice PIN exposure after DO eviction | **unproven older audit premise** | Before building, establish whether eviction loses the relevant in-memory interaction at this boundary. No new runtime evidence was collected | reviewer | none |

## How this file stays true

- A pull request appears when opened and leaves when merged or closed.
- The reviewer updates its verdict when posting one, including the reviewed head.
- Owner-only work belongs in [OWNER-ACTIONS.md](OWNER-ACTIONS.md); cross-references do not duplicate requests.
- Every next action names a trigger; observations are dated, never presented as a moving head.
- `scripts/check-state.mjs` checks carrier format in the advisory `state carriers are honest` CI job.

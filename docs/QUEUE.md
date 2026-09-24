# Queue

What is in flight, who owns the next action, and what it blocks. Regenerate this
file rather than appending to it. Owner-only actions live in [OWNER-ACTIONS.md](OWNER-ACTIONS.md).

Last regenerated: 2026-09-24, from the harness's approximately 19:40 UTC open-PR
snapshot and repository history. Heads below are that observation, not a claim
about a later head. Query `git log --oneline origin/main -1` before starting work.

**Local load rule:** only focused test files on Sid's PC; full package and workspace
suites run in GitHub Actions. See [the recorded rule](voice-streaming.md#round-2-validation).

## Pull requests, and the order they have to land in

| PR | State / observed head | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#166](https://github.com/stremysid/jarvis/pull/166) deadline_record | **awaiting-review**, round 7; `7e14872` | Finish independent round-7 review; merge only the cleared exact head | reviewer | #168 refresh | Round 6 said the rest was ready. Whichever of #166/#174 lands second must add `deadline_record` to shared `OWNER_TOOL_DEFINITIONS` and have that resulting head reviewed |
| [#174](https://github.com/stremysid/jarvis/pull/174) channel parity | **awaiting-review**, round 4; `1b0b0e9` | Finish independent round-4 review; coordinate the shared catalogue with #166 before merge | reviewer | #168 refresh; Phases 1, 2 and 5 | Round 3: New-1…New-6 fixed, one low (L2 below). Migration `0044`; fixes the guest-call privacy leak, live on main and in production until merge and deploy. Scratch application after `0045` passed; [rehearsal](reviews/2026-09-24-scratch-d1-rehearsal.md) |
| [#168](https://github.com/stremysid/jarvis/pull/168) owner reminders | **blocked / stale**; `d2142167` | After #166/#174 merge, run a builder round resolving eight conflicting files, renumber `0041` above main's maximum, then request review | builder | owner reminders | Renumbering is decided in [OWNER-ACTIONS](OWNER-ACTIONS.md#done--kept-so-they-are-not-asked-for-again); check the migration set again before choosing a number |
| [#177](https://github.com/stremysid/jarvis/pull/177) docs stale-fixes | **awaiting-review**, round 2; `4cd6fd6` | Finish round-2 review before tonight's rollout instructions are used | reviewer | tonight's production runbook | Corrects the scratch runbook, deploy.md and REVIEWER-MANUAL |
| [#178](https://github.com/stremysid/jarvis/pull/178) D2L label follow-ups | **awaiting-review**; `04349dd` | Finish independent review | reviewer | none | #176 lows L1, L3 and L4; date precedence remains an owner question below |
| [#122](https://github.com/stremysid/jarvis/pull/122) memory redesign spec | **awaiting-owner**, unchanged | When Sid has consulted the DeepSeek builder, confirm whether this is still the Phase 2 plan, then refresh before merge | Sid | none | The 2026-09-23 row records a 2026-09-19 head, only an AGENT_LOG conflict against `f9472d1`, and seven intervening memory commits. Those are historical checks, not a fresh conflict count |

Merged PRs have left this queue. Production application, deployment and device
acceptance remain separate actions in [OWNER-ACTIONS](OWNER-ACTIONS.md).

## Work with no pull request yet

Repository claims below were checked against main on 2026-09-24. Dated runtime
observations were not repeated by this docs builder.

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| #174 round-3 L2: Telegram keyboard payload fields reject staged ids | **open, fail-closed** | In a separate PR after #174 review, trace staged decision/keyboard fields through redaction validation and delivery; retain structural-id validation. [Known issue](../KNOWN_ISSUES.md#telegram-keyboard-payload-fields-pr-174-round-3-l2) | builder | some confirmation deliveries |
| #176 L2: personal myItems date versus folder DueDate | **awaiting-owner; disagreement unobserved so far** | When Sid chooses in [OWNER-ACTIONS](OWNER-ACTIONS.md#waiting-on-sid), implement it: A keeps both (recommended), B uses folder date, C keeps today's personal-date precedence | Sid, then builder | date-precedence change |
| #171 L2′: ordinary `[[` prose aborts speech | **open low** | In a follow-up PR, preserve ordinary wiki-link prose without treating it as a malformed claim marker; [known issue](../KNOWN_ISSUES.md#owner-voice-streaming-acceptance-pr-171-2026-09-24) | builder | none |
| #171 L3′: held pre-tool refusal is spoken out of order | **open low** | In a follow-up PR, preserve spoken order across the end of round 0; [known issue](../KNOWN_ISSUES.md#owner-voice-streaming-acceptance-pr-171-2026-09-24) | builder | none |
| #171 L5 | **open low; finding text unavailable in the checked-in record** | Before building, recover the review's exact L5 finding. The harness lists it as open; main's KNOWN_ISSUES section records only L2′ and L3′ | reviewer | scoping L5 |
| #171 L6 | **open low; finding text unavailable in the checked-in record** | Before building, recover the review's exact L6 finding. The harness lists it as open; main's KNOWN_ISSUES section records only L2′ and L3′ | reviewer | scoping L6 |
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
| T3: `tool-gate.ts` returns literal permit after its second evaluation | **not started** | In a follow-up, deny if the second evaluation differs from the confirmation-required outcome. Simply using `verdictFor(confirmed)` would refuse valid confirmed tier-3 calls | builder | first tier-3 hand |
| B2: confirmations bind capability and arguments, not tool | **open** | In a follow-up, bind tool identity while preserving cross-channel use. `confirmationReference` is still `capability:argumentsHash`; #159 added single-use/expiry without tool binding | builder | first tier-3 hand |
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

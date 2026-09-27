# Queue

What is in flight, who owns the next action, and what it blocks. Regenerate this
file rather than appending to it. Owner-only actions live in [OWNER-ACTIONS.md](OWNER-ACTIONS.md).

Last regenerated: 2026-09-27, from `gh pr list --state open` and the code in a worktree at the
tip of the default branch. Heads below are that observation, not a claim about a later head.
Query `git log --oneline origin/main -1` and re-list the open PRs before starting work.

**Local load rule:** only focused test files on Sid's PC; full package and workspace suites run
in GitHub Actions. See [the recorded rule](voice-streaming.md#round-2-validation).

## Pull requests, and the order they have to land in

Five are open. **Three of them need a reviewer who is not their author**, and that is the whole
of what is blocking this repository right now: every code change on the default branch landed
days before 2026-09-27, and nothing new has moved since because nobody who did not write it has
read it.

| PR | State / observed head | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#223](https://github.com/stremysid/jarvis/pull/223) memory search page size | **ready for review**; head `0dd77a0f`; CI 10/10 green; `MERGEABLE` | A **non-author** review. It is builder-authored, so it does not clear itself | reviewer (not the author) | Phase 2 | `memory_search` gains an optional `limit` (1..`MAX_MEMORY_SEARCH_RESULTS` = 8); the reader half was already on the default branch and **unpinned**, and the two tests added here pin it. Seven mutations, four of them after two guards survived a first neutering. No migration |
| [#224](https://github.com/stremysid/jarvis/pull/224) external-audit verdict | **ready for review**; head `a877e1a2`; CI 10/10 green; `MERGEABLE` | A **non-author** review. Docs only, and it applies nothing | reviewer (not the author) | none | A verdict on two externally pasted audits: 8 items already handled, 3 whose premise is false (D1 does enforce foreign keys; there is no 128-statement batch cap), 2 stale-revision, and **4 whose proposed fix would be harmful** (a `JSON.stringify().slice()` "truncation" produces invalid JSON). No file in the production path changes |
| [#187](https://github.com/stremysid/jarvis/pull/187) principles and the removal list | **draft, `CONFLICTING`**; head `934419cd` | Its author's next round: put Sid's rules first in `AGENTS.md`, rewrite `CODE-VS-JUDGMENT.md` as a removal list, then bring it up to date with the default branch. Then a **non-author** audit — the PR says so itself | author, then a non-author auditor | the register's shape | Docs only, three files. It conflicts against the current default branch, and `docs/CODE-VS-JUDGMENT.md` has since been rewritten into removal-list form in pieces by later PRs, so this needs a real rebase rather than a conflict resolution. Its body still says "a merge freeze is on until Sid's deploy" — the 2026-09-24 deploy happened, so that note is stale |
| [#122](https://github.com/stremysid/jarvis/pull/122) memory redesign spec | **draft, `CONFLICTING`**; head `b03b3664`; needs a re-audit | A **non-author** re-audit of the pushed fixes, then the author's refresh against a default branch that has moved a long way | auditor, then author | nothing builds from it until then | Docs only, and it is the Phase 2 design. It is **not** waiting on an owner decision; an earlier `awaiting-owner` state in this file was wrong |
| [#221](https://github.com/stremysid/jarvis/pull/221) isolated rebuild | **draft; do not merge, close or mark ready**; head `a060906f` | Nothing. It is kept open deliberately as a place to push an isolated rebuild living entirely under `rebuild/` | — | none | Its own description forbids merging it. Do not treat its green CI as evidence about this repository |

## Work with no pull request yet

Repository claims below were checked against the default branch on 2026-09-27. Dated runtime
observations were not repeated.

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| **Nothing is deployed since 2026-09-24** | **open; the largest gap on this page** | Apply the migrations and deploy the reviewed revision when Sid authorizes it. Do not describe any feature merged after 2026-09-24 as live. See [STATE](STATE.md#what-is-deployed-and-what-is-only-in-the-code) | Sid | every feature merged since that deploy, including the guest-call privacy fix |
| **Memory stores items but can never use one** | **root cause found in production 2026-09-27; not yet fixed** | `memory_item_transitions` holds 8 rows and every one says `"model inference awaits owner confirmation"` — the automatic promotion gate has **never** passed once. So 0 of 8 items is `active`, `memory_retrievable_item_versions` holds 0 rows, and a call or any semantic read reaches no memory at all. The gate requires the stored fact to be a **verbatim whole sentence** of Sid's message; the extraction model writes a tidied restatement instead (`"The owner has a chemistry test on Friday."` against the source `"I have a chem test Friday"`), so it fails every time and the item is filed as a model inference. **The fix direction is already merged and not deployed** — the deployed revision forces `basis: "inferred"` whenever that check fails, so a revision carrying the model's own `basis` is the first thing to test | builder, with Sid on the release decision | Phase 2, and everything memory-shaped downstream of it |
| The memory receipt path can reintroduce suppressed text | **live defect, reproduced by reading the code** | In Phase 2, let `explain` carry the service's sanitised receipt instead of re-reading the item and appending its wording. `owner-agent-core.ts`; the only covering test sits at the service boundary and does not reach this | builder | Phase 2 |
| Study-coach signal ranking and selection (register B1, B2, B54–B64) | **blocked, registered not removed** | The 13 signal items feed one deterministic choice, `chooseStudyCheckIn`, whose result is a table of `NOT NULL` chosen values filled by a model-less digest path. The next step is a model call in the claim path that answers with course, topic, outcome, confidence and citation keys, then the deletion of every score. [Register](CODE-VS-JUDGMENT.md#study-coach-signal-ranking-and-selection-registered-not-removed-batch-7-2026-09-25) | builder | check-in selection; Phase 3 |
| Row 10: the missed-work verdict is persisted by a model-less cron | **still in code** | `deriveMissingWorkPage` writes a derived verdict with no model in the loop. Moving it to Jarvis needs a model-write tool and a migration (`0027` admits only `classification = 'derived'`); deleting it alone would drop the digest missed-work alerts and the study signals. [Register](CODE-VS-JUDGMENT.md#row-10-persisted-inference-still-in-code-not-removed) | builder | Phase 3 |
| School reply-claim guards still decide by vocabulary | **registered, not started** | `FALSE_EXTERNAL_COMPLETIONS`, the `PASSIVE_EXTERNAL_*` patterns and `hasPassiveExternalCompletion` in `school-catchup-model.ts` decide whether a reply sentence claims Jarvis completed an external action. The model should declare those sentences, and code should check each declared sentence against this turn's receipts | builder | Phase 3 |
| Rank chosen in code on two model-less decision paths (register row 20) | **named, deliberately not removed** | `TIER3_CONFIRMATION_RANK` and `SCHOOL_PAIRING_RANK` are named constants on paths with no model turn. When either path gains one, take the rank from its tool argument as `memory_confirm` does | builder | Phase 2 |
| The legacy deadline placeholder columns (`due_at`, `effort`, `lead_minutes`) | **open, not started** | `0053` added the real nullable `due_date` and left the old `NOT NULL` columns written but unread. Dropping them needs a `deadlines` rebuild, and the `0027` triggers must be dropped and recreated around it | builder | an honest deadline schema |
| D2L extension: host-only failure emission | **hold deleted; emission not built** | Emit host-only failures (`course: null`) and recognise a complete 404, so a whole-read report can say which host failed. The compatibility hold itself is gone | extension builder | automatic two-board evidence |
| PC controls: the daily report after the D2L reader | **P1 and the collector/receiver merged; P3 pending owner acceptance** | When the extension work above lands and Sid has accepted a real read, report the last good whole read and the coverage gaps in Telegram | builder | Phases 3 and 4 |
| `findLastReferencedTarget` needs a staged delivery a call does not make | **half done** | Over voice, "the memory I just mentioned" resolves only through the item ids in the model's context, because a voice turn stages no `conversation_deliveries` row. Giving a call the same staging is the fix | builder | Phase 5 |
| Conversation state is not shared between the two doors | **core shared, state not unified** | `OwnerAgentCore` shares the loop, caps, tier gate and receipt guard; Telegram is a stateless Worker and voice is a `CallSession` Durable Object. Sharing the state is what Phase 1 is missing | builder | Phase 1 |
| A wake with no pre-written message does not exist | **not a defect; an unbuilt capability** | The model can already choose *when* and *what* to say (`reminder_schedule`); it cannot ask to be woken to decide later. In this codebase's idiom that is a due row plus the drain handing it to the model, as the deadline review does — not a Durable Object alarm, which nothing here has. **Waiting on Sid: build it, or stop here** | Sid decides, then builder | Phase 6 |
| The seed/live duplicate in the school tracker | **Sid's decision, not a bug a builder may fix alone** | 422 items = 327 seeded + 95 live, and 23 seeded rows duplicate real D2L assignments with different dates. `mergeItem` keys on the id, which embeds the remote id, so a seeded row and a live row can never merge, and no reconciliation exists. **Options: reconcile (drop the seed when a live match exists) or stop importing the tracker** | Sid, then builder | Phase 3 data honesty |
| The drain does not move lapsed decisions to a terminal state | **open gap, recorded in the code itself** | `jobs/job-table.ts` notes it: `listOpenQueue` filters expired items out, but nothing writes `expired`, so answering one is refused by the delivered/open check rather than by expiry | builder | decision hygiene |
| `handleReadiness` has zero non-test call sites | **awaiting-triage, re-verified** | The only callers are in `test/http/health.test.ts`. Route it, or delete it | builder | none |
| T1/T2: `channel_identities` insert and `capability_tiers` update/delete guards | **not started** | One migration, four triggers. Check the migrations directory and every open PR for the next free number — `0056` is the current maximum | builder | Phase 2 |
| Watchdog alerting secrets are undeclared | **not started, re-verified** | `apps/watchdog/wrangler.toml` declares none of the alerting bindings, so a misconfigured watchdog deploys fine and cannot alert. Make a missing binding a deploy-time refusal | builder | Phase 7 |
| `jarvis vault sync` stops at the first 64 examined notes | **not started, re-verified** | `vault/reconciliation.py` caps a slice at `MAX_SLICE_DOCUMENTS` and persists no position, so unchanged notes keep consuming the budget. Persist progress | builder | Phase 7 |
| Gateway test typecheck is red and gated nowhere | **awaiting-triage; grew, not shrank** | **149 errors in 32 files**, measured 2026-09-27 — up from the 143 recorded on 2026-09-24. Fix or gate it | builder | none |
| Suppression predicates remain duplicated outside the retriever | **open** | `suppression-clauses.ts` holds the predicate once and the retriever and control finder compose it. Three copies remain: two `EXISTS` projections in `memory-repository.ts` and migration `0016`'s view, which cannot be edited in place | builder | Phase 2 |
| Telegram rate limiter and provider circuit breaker are per-isolate | **not started** | Both are module-level instances, so each isolate gets its own budget. Shared accounting needs a Durable Object | builder | none |
| A failed Telegram reply is never retried | **open** | `retry_wait` is stored and no job claims it. The claim-before-send path in `MemoryBackupService.alert` also has an empty `catch`, so one failed send burns that day's only notice | builder | reliable delivery |
| `pushSourceGap` returns a stored failure before its age check | **retained audit finding; usefulness needs review** | Still live and still reached: `digest-job.ts` calls it for the `d2l-notification-email` source. Reassess reachability after the retired-source changes before building | builder | none |
| Voice PIN exposure after Durable Object eviction | **unproven premise, not a finding** | The load-bearing premise is Cloudflare's hibernation window, which nobody measured. Establish it before building anything | reviewer | none |
| Voice has no interim audio while a tool call runs | **suspect, not a finding** | There is no "let me check" filler. Whether Twilio or ConversationRelay underflows during a multi-second tool call needs a live call with a slow tool; nobody has made one | builder, with Sid on the phone | call quality |
| An external uptime monitor | **blocked on a deployment** | The watchdog's own endpoint cannot report total cron failure without an outside poller. See [OWNER-ACTIONS](OWNER-ACTIONS.md) | Sid | Phase 7 |
| 18 Dependabot advisories on the default branch (9 high, 7 moderate, 2 low) | **open, unowned** | Triage them; no builder has looked at a single one | builder | none |

## Resolved since the last regeneration, so they stop being re-read

Named rather than silently dropped, because each of these sat in the queue as open work while it
was actually finished. **Nothing below needs a builder.**

| Item | What closed it |
|---|---|
| Telegram provider cleared its abort timer before the body read | Fixed; the timer is cleared in a `finally` that covers `response.json()` |
| Guest-call privacy leak on the deployed revision | Fixed in code by the channel-parity merge; **not deployed** — still live in the last recorded deploy, so it is an owner action, not builder work |
| The `0025` guard-pin and university-batch register items | Merged and removed from the register |
| Deadline "proof contract" refusals | Deleted; the model decides and code checks only a real date or instant and a real IANA zone |
| The tutor-claim and university-execution regexes, the tracker keyword gate and the per-day caps | Deleted across the school, university and catch-up batches |
| `chat_place`-style silent drops on calls | Replaced by the owner access tool; the AI decides |
| The study-coach intent parsers | Deleted; `study_coach` carries the model's declared operation |
| The memory wording judgments (negation guards, vocabularies, code-chosen defaults) | Deleted; the model states basis, filing confidence, excerpt and target |
| The local-agent retry-wait race and the Hermes per-test timeouts | Bounded by the merged test changes |
| The two Telegram flakes (callback-ID corruption, the host-dependent clock in the archived-memory test) | Fixed and merged |

## How this file stays true

- A pull request appears when opened and leaves when merged or closed.
- The reviewer updates its verdict when posting one, including the reviewed head.
- Owner-only work belongs in [OWNER-ACTIONS.md](OWNER-ACTIONS.md); cross-references do not duplicate requests.
- Every next action names a trigger; observations are dated, never presented as a moving head.
- `scripts/check-state.mjs` checks carrier format in the advisory `state carriers are honest` CI job.

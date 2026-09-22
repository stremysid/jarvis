# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the phase a pull request gates.

Last regenerated: 2026-09-22, against `main` = run `git log --oneline origin/main -1`. `#143` merged as `cdfdd4b`; every branch below was checked with `git merge-tree` against it and merges clean, so the old "Conflicting" note is retired where it no longer applies.

## Pull requests, and the order they have to land in

`#145` is based on `#141`'s branch and `#146` on `#144`'s. Nothing else depends on anything.

| PR | State | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#141](https://github.com/stremysid/jarvis/pull/141) | **ready-to-merge** | Merge first. `#145` sits on it and retargets to `main` after | Sid | Phase 4 | The PC boot chain: auto-login, an elevated logon task, and the boot entry point |
| [#144](https://github.com/stremysid/jarvis/pull/144) | **ready-to-merge** | Merge second. `#146` sits on it | Sid | Phase 2 | A suppressed memory could still be a control target. Both anti-joins restored to `selectControlTargets`, one mutation per clause, each clause failing its own test when neutered |
| [#146](https://github.com/stremysid/jarvis/pull/146) | **ready-to-merge** | Merge after `#144` | Sid | Phase 2 | The suppression predicate is one definition, guarded by a parity test. Three copies remain outside the retriever — `readItemVisibility` and `retrievalItemStatements` as `EXISTS` projections, and `0016`'s `memory_retrievable_item_versions` view — and are named in a row below rather than folded in |
| [#145](https://github.com/stremysid/jarvis/pull/145) | **ready-to-merge** | Merge after `#141` | Sid | **Phase 3 and Phase 4** | `jarvis serve` binds the Windows control pipe through the existing `NamedPipeServer`, so the boot chain reaches a live agent. Without it P1's exit test cannot pass and P2/P3 sit behind it. One open risk: the boot script exits 0 the moment the pipe answers, and the service can exit 5 seconds later if the gateway rejects the device — the logon task's `RestartCount 3` is then the only recovery, and nobody has decided that in writing |
| [#147](https://github.com/stremysid/jarvis/pull/147) | awaiting-review | Reviewer reads it. **Unaudited**, and the widest of the five: a tier gate and tool dispatch on the voice path. Rebase onto the PIN fix rather than landing in front of it | reviewer | **Phase 5** | A call can act, and the agent loop has one copy. `OwnerTelegramAgentAdapter` 1,339 → 256 lines. The two composition sites are *not* gone and the PR does not claim they are: each channel still owns its authority check and prompt, and a full collapse needs a Durable Object holding conversation state, which does not exist |
| [#96](https://github.com/stremysid/jarvis/pull/96) | **blocked** | Rebase onto `main`. **Read against the PIN finding below before either lands** — it claims to fix "the digit half" of the same redaction rule, and two half-fixes to one rule is how the rule ends up wrong twice | builder | Phase 5 | Spoken PIN before sensitive actions, and the redaction fix. 57 files |
| [#111](https://github.com/stremysid/jarvis/pull/111) | **blocked** | Re-measure now that `testTimeout` is set; likely no longer needed | builder | none | `gate.ps1` isolation re-runs |
| [#113](https://github.com/stremysid/jarvis/pull/113) | **awaiting-independent-pass** | DeepSeek reviews it | Sid | none | The sweep set the 2026-09-18 triage never covered. Reviewer-authored |
| [#117](https://github.com/stremysid/jarvis/pull/117) | **superseded in part** | Keep only the CI wiring for `check-state.mjs`; its carrier content is superseded | reviewer | none | Reviewer-authored |
| [#118](https://github.com/stremysid/jarvis/pull/118) | awaiting-review | Reviewer reads it | reviewer | none | T6 is closed |
| [#122](https://github.com/stremysid/jarvis/pull/122) | awaiting-review | Reviewer reads it | reviewer | none | The memory redesign spec |
| [#127](https://github.com/stremysid/jarvis/pull/127) | **close** | Superseded: `BUILDING.md` is rewritten without milestones on `main`, and #127's version still carries the R table and re-adds the deleted `docs/HANDOFF.md` | Sid | none | |

## The 2026-09-22 audit of `d0ec419`

A read-only audit ran on 2026-09-22 and produced a ranked list. **Two of its own claims were
withdrawn after challenge, so read its corrections before acting on any of it.** The figures it
reports are from `d0ec419`; `#143` has since landed, which resolved the `DEEPSEEK_MODEL`
question (production runs Flash) and moved the deploy row. The findings below are what survived.

**Only the first two were traced end to end, at both ends of the chain.** The rest are
labeled as they stand, and one has an external premise nobody measured.

| Finding | State | Next action | Owner |
|---|---|---|---|
| **The four-digit PIN is unredacted**, at rest in `events.envelope_json`, in the R2 archive, and sent to DeepSeek in a prompt. `AUTHENTICATION_DIGITS` is `/...\d{6}.../` — exactly six — at `packages/contracts/src/calls.ts:19`; the contextual rule needs exactly eight; `CREDENTIAL_FIELDS` has no `pin`; and the `DTMF_FIELDS` branch is gated on `channel === "voice"` at `security/redaction.ts:30`, so a conversation turn never reaches it. The test that appears to cover it passes `field: "guest.pin"`, a string that occurs nowhere else in any executable file | **live defect; verified twice, independently** | Widen the digit rule to a bare 4-digit run, ungate the DTMF branch, and test through `handleTurn` rather than a synthetic field. Mutation-verify before it lands: it changes what **every** door redacts. `#96` touches the same rule | builder |
| **`scripts/deploy.ps1` ships an unknown revision.** No `rev-parse`, no dirty-tree check, no comparison against `origin/main`, anywhere in `scripts/`. A `-Publish` from a stale `C:\javis` ships older voice code and reports success — and the two files in that delta are the ones holding the PIN defect | **verified** | Two lines at the top of `deploy.ps1` and `deploy-watchdog.ps1` | builder |
| The digest can say "nothing due" while school has deadlines, because a source is "not set up" only when **unconfigured**, and all three school routes are dead **with configuration present** | audit finding, **not** traced end to end | Record rows-yielded beside `last_success_at` and treat "succeeding, never yielded" as a gap the digest must state | builder |
| Three states are recorded and never delivered: a failed Telegram reply is never retried (`retry_wait` stored, no job claims it); `pushSourceGap` returns `lastFailure` before its age check; one failed send burns that day's only backup notice (empty `catch`, no counterpart `console.error`) | audit findings, **not** traced end to end | Each is a missing caller or a missing log line | builder |
| A spoken 4-digit PIN reaches the model and transcript after Durable Object eviction, because `#interaction` is a plain instance field and hibernation discards it | **unproven** — the load-bearing premise is Cloudflare's hibernation window, which nobody measured | Check the premise against Cloudflare's own documentation before building anything | builder |
| Voice can read the forgetting guarantee but cannot invoke it: `MemoryOwnerControlsService` has four construction sites and none is reachable from `voice/**` | audit finding. Near-vacuous today (5 items, 0 active), so a correctness gap rather than a live leak | Give voice a memory-control invocation path | builder |

**Do not act on the audit's §2.3.** It is withdrawn: `composeCoreProfile`
(`core-profile.ts:81-85`) applies `CORE_PROFILE_PREFIX`, and its only caller feeds that into
`ownerTelegramAgentSystemPrompt`. The label is applied.

## Work with no pull request yet

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| The operation guard in `findControlTargets` is a hand-kept list | **not started** | #135 added `pin`/`unpin` to it, but its test hand-lists the operations too: adding a member to `TelegramMemoryTargetOperation` passes the test and typecheck while the guard rejects it. Make the guard a `satisfies Readonly<Record<TelegramMemoryTargetOperation, true>>` map, as #124 did for the intent set. The fourth copy of this defect | builder | Phase 2 |
| **PC controls: boot chain, D2L read, daily report** | **P1 is #141; P2 and P3 not started** | Three stacked PRs. **P1** auto-login plus a logon-scheduled task at `-RunLevel Highest`, so Jarvis is elevated from the power button with no morning input. **P2** the PC logs into D2L and reads assignments, pushing through the already-enrolled device. **P3** the report on Telegram, and it must state `last_success_at` — a scraper that breaks silently is the failure that matters. Brief: [briefs-pc-controls.md](briefs-pc-controls.md). **This is the only route to Phase 3**, because D2L's email carries no deadlines. P1's scripts are `ops/jarvis-autologon.ps1`, `ops/jarvis-logon-task.ps1` and `ops/jarvis-boot.ps1`; the runbook is [pc-boot-chain.md](runbooks/pc-boot-chain.md) | builder | **Phase 3 and Phase 4** |
| **No Windows launcher for the local agent** | **brief written, not built** | `ops/jarvis-boot.ps1` connects to the agent if one is listening and otherwise exits 3. Nothing on Windows binds the control channel: `node.py`'s `NodeSettings.from_config` refuses every platform that is not Linux, and `transport/pipe_server.py` is a tested Windows server with no caller. The boot chain itself — power button, auto-login, elevated process — is built and has been run by hand; the missing half is the agent. `AGENTS.md` forbids porting `node.py` as a side effect, so it has its own brief: [briefs-windows-pipe-server.md](briefs-windows-pipe-server.md) | builder | **P1's exit test, then Phase 3 and Phase 4** |
| **Memory has saved nothing since the promotion fix went live** | **open** | Since the 2026-09-20 deploy, 4 owner Telegram turns reached distillation as `eligible` and produced **zero** new memory items; the newest item is from 2026-09-17, and all 5 are still `proposed`. Not yet known whether those 4 turns held anything worth saving. Next: send Jarvis a plain fact, wait for the hourly run, and read the extraction output for that turn | reviewer | Phase 2 |
| **`findControlTargets` is the only one of its two interfaces the voice path has** | **from `#137`** | `D1ContextRetriever implements ContextRetriever` only, while `TelegramMemoryRetriever` also implements `TelegramMemoryTargetFinder`. Voice therefore cannot name a memory to act on, so **the six** memory tools that take an `itemId` — `forget`, `correct`, `restore`, `confirm`, `explain` and `pin` — have nothing to resolve one from. Adding the finder to the voice path is part of the agent adapter, not a separate wiring call. No test asserts which tools need it: both retriever suites stub `findControlTargets`, so that list is a **read, not a measurement** | builder | **Phase 5** |
| Voice has no tool dispatch — a call can talk and cannot act | **seam decided, not built** | Build the voice agent adapter: a `ModelAdapter` whose `stream` drives `ModelAgentProvider` and runs the tool call, mirroring `OwnerTelegramAgentAdapter`, then extract the channel-neutral core. Decision and evidence: `DECISIONS.md`, *"Voice gets tools behind `ModelAdapter`"* | builder | **Phase 5** |
| One brain: two composition sites for what should be one assistant | **seam decided, not built** | The keystone, and the same commit as the row above: Telegram composes its own agent adapter and voice composes a bare `DeepSeekModelAdapter` (`production-runtime.ts` vs `index.ts`) | builder | Phase 1 |
| `hermes-runtime` `artifact-security-review3` is a timing flake | **open, unowned** | "uses one absolute cancellation deadline…" failed at 12,975 ms on `352991e`, in code that commit did not touch, and passed on re-run. Cause not yet established | builder | none |
| `owner-telegram-agent.test.ts` and `telegram-memory.test.ts` flake | **open, unowned** | Both failed on #137's CI and passed on #138's, whose tree carried the same code; `owner-telegram-agent.test.ts` failed again on `main` at `688fe02` (#140, docs only). `owner-telegram-agent.test.ts` roams (green `35532044202`, red `35532739198` at `:1134`, trees differing only in a log entry); `telegram-memory.test.ts`'s 500 ms retrieval budget failed once | builder | every gate |
| The model cannot state its own certainty | **decided, not started** | Sid ruled 2026-09-20 that certainty is the model's. Remove the assignment at `extraction-policy.ts`'s validation boundary and drop it from `FORBIDDEN_PROPOSAL_KEYS`. **Keep `origin` and lifecycle code-assigned** — those are provenance and enforcement | builder | Phase 2 |
| `owner-telegram-agent.test.ts` roams | **open, unowned** | Still fails intermittently after #121, which fixed only the `delivery_unknown` ULID assertion. Green `35532044202`, red `35532739198` at `:1134`, on trees differing only in a log entry. `testTimeout` is set now, so this is an ordering defect rather than a load timeout | builder | every gate |
| A spoken-word PIN, a phone number and the owner passphrase match no redaction rule | **live defect** | #96 fixes the digit half only | builder | Phase 5 |
| `explain` / `forget` / `restore` print the memory text in the result that says it was withheld | **live defect** | Pass the string the service already sanitised instead of re-reading the repository | builder | Phase 2 |
| `selectControlTargets` read `memory_item_fts` with no suppression anti-join | **fixed; PR open** | Both `NOT EXISTS` clauses the FTS arm of `readCandidates` carries are copied in, plus the `memory_items` join the first one needs. Pinned by a new suite with one mutation per clause: neutering either alone fails exactly the test written for it. Fold this row away when it merges | builder | Phase 2 |
| The item-level suppression predicate is still written by hand outside the retriever | **open, unowned** | `telegram-memory-retriever.ts` now composes it once (`CANDIDATE_SUPPRESSION_CLAUSES` / `NOTE_SOURCE_SUPPRESSION_CLAUSES`, guarded by `test/memory/suppression-predicate-parity.test.ts`), but three copies remain: `readItemVisibility` and `retrievalItemStatements` in `memory-repository.ts` hold it as `EXISTS` **projections** (reporting suppression rather than hiding a row), and migration `0016`'s `memory_retrievable_item_versions` view holds it as the filter `readMeaningHits` depends on. Neither is a copy of the composer's text and the view cannot be edited in place, so folding them in is its own change | builder | Phase 2 |
| A confirmation binds `capability:argumentsHash`, not the tool name; and is never consumed | latent | Brief staged at `C:\w\briefs\conf.md`, worktree `C:\w\conf`. Not live — the gate merged after the last deploy | builder | first tier-3 hand |
| The watchdog declares none of its alerting secrets | **not started** | The heartbeat itself **works as of 2026-09-20** — the redeploy proved it. What remains: `apps/watchdog/wrangler.toml` declares none of `WATCHDOG_TELEGRAM_BOT_TOKEN`, `_CHAT_ID` or `_HEARTBEAT_SECRET`, so a misconfigured watchdog deploys fine and cannot alert anyone. Brief staged at `C:\w\briefs\wd.md` | builder | Phase 7 |
| `channel_identities` has no `BEFORE INSERT` trigger; `capability_tiers` has no update or delete guard | not started | One migration, four triggers. Next free number is **`0039`** — `0038` is taken | builder | Phase 2 |
| `tool-gate.ts` returns `verdict: "permit"` as a literal | not started | Deny when the second evaluation is not the outcome the first one was. `verdictFor(confirmed)` is the **wrong** fix | builder | first tier-3 hand |
| `telegram-provider.ts` clears its abort timer before the body read | not started | Keep the timer armed across `response.json()`, as `twilio-provider.ts` does | builder | none |
| `jarvis vault sync` can never see past the first 64 notes | not started | Persist a position; `documents_examined` counts unchanged files | builder | Phase 7 |
| `KNOWN_ISSUES.md` describes shipped work as open | **not started** | 1,145 lines, 57 sections. Per-item check against the code, not a sweep | builder | none |
| `typecheck:tests` reports 144 errors in 32 files, gated nowhere | awaiting-triage | Fix or gate them | builder | none |
| Telegram rate limiter and provider circuit breaker are per-isolate | not started | Move both into a Durable Object | builder | none |
| `handleReadiness` has zero call sites | awaiting-triage | Route it, or delete it | builder | none |
| External uptime monitor | blocked | Owner action, after a deployment proves the heartbeat | Sid | Phase 7 |

## How this file stays true

- A pull request appears here from the moment it is opened, and leaves when it is
  merged or closed.
- The reviewer writes the verdict into the row when it posts one, so the queue is
  never more than one review behind reality.
- Anything only Sid can do belongs in [OWNER-ACTIONS.md](OWNER-ACTIONS.md), not here.
- Nothing in this file may state a revision as current. Query it.
- `scripts/check-state.mjs` checks the carriers' format. It is not yet wired into
  CI — that is what [#117](https://github.com/stremysid/jarvis/pull/117) does.

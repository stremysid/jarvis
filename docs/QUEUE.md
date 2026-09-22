# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the phase a pull request gates.

Last regenerated: 2026-09-22, against `main` = run `git log --oneline origin/main -1`. `#143` merged as `cdfdd4b`; every branch below was checked with `git merge-tree` against it and merges clean, so the old "Conflicting" note is retired where it no longer applies.

## Pull requests, and the order they have to land in

`#147`, `#144` and `#146` land in that order: `#147` moves the file `#144` fixes, and `#146`
composes whatever predicate is left. **`#146` is based on `#144`'s branch** — after the merge that
closes a base branch, retarget the PR built on it (`gh pr edit <n> --base main`) or its diff goes
strange. `#141`, `#148`, `#149` and `#150` are merged.

| PR | State | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#147](https://github.com/stremysid/jarvis/pull/147) | awaiting-review | **Merges first, before `#144`.** Reviewed 2026-09-22 by Claude; the composition gap is fixed at `80d5c7d` (that commit is reviewer-written, so it needs an independent pass). One fix is still owed: `previousAssistant` in `voice-agent.ts` looks up Jarvis's last reply on **any** earlier call while its own comment says "same session". **Decide before deploy, not before merge:** a call now waits for the whole non-streaming agent loop, so voice's 8 s first-token ceiling became a 20 s turn deadline | builder | **Phase 5** | A call can act, and the agent loop has one copy. `OwnerTelegramAgentAdapter` 1,339 → 256 lines. The two composition sites are *not* gone and the PR does not claim they are: a full collapse needs a Durable Object holding conversation state, and only `CallSession` exists |
| [#144](https://github.com/stremysid/jarvis/pull/144) | **ready-to-merge** | Merge **second**. Expect a conflict in `telegram-memory-retriever.ts`: resolve it by hand-porting the two `NOT EXISTS` clauses into `D1MemoryControlTargetFinder` in `memory-control-targets.ts`, not the old file. **Then grep that file for `memory_active_event_suppressions`** — if absent, the fix was lost, and the `creation_event_sequence` range half is pinned by that grep alone | Sid | Phase 2 | A suppressed memory could still be a control target. Both anti-joins restored, one mutation per clause, each clause failing its own test when neutered |
| [#146](https://github.com/stremysid/jarvis/pull/146) | **ready-to-merge** | Merge **last**, after `#144`. Same move conflict expected, and its parity guard must find the composition site in `memory-control-targets.ts` — whether it does is unverified | Sid | Phase 2 | The suppression predicate is one definition, with a parity guard. Three copies remain outside the retriever and are named in a row below rather than folded in |
| [#145](https://github.com/stremysid/jarvis/pull/145) | **ready-to-merge** | Merge whenever. Independent of the three above | Sid | **Phase 3 and Phase 4** | `jarvis serve` binds the Windows control pipe through the existing `NamedPipeServer`, so the boot chain reaches a live agent instead of exiting 3. **This is what unblocks P2**, the PC reading D2L. To work at logon it also needs `JARVIS_ARCHIVE_PATH` and `JARVIS_MEMORY_PATH` at user scope, and the boot script exits 0 the moment the pipe answers — a rejected device leaves a service that vanished seconds later, with the logon task's `RestartCount 3` the only recovery |
| [#96](https://github.com/stremysid/jarvis/pull/96) | **blocked** | **Rebase onto [#149](https://github.com/stremysid/jarvis/pull/149)**, which is now merged and changed the same rule. Its migration is numbered `0036`, below the applied `0038`, so it would apply out of order: taken numbers are `0001`–`0035` and `0038`, and the next free is `0039`. It must take whatever is next when it lands, not reuse a gap | builder | Phase 5 | Spoken PIN before sensitive actions, and the redaction fix. 57 files |
| [#113](https://github.com/stremysid/jarvis/pull/113) | **awaiting-independent-pass** | DeepSeek reviews it | Sid | none | The sweep set the 2026-09-18 triage never covered. Reviewer-authored |
| [#117](https://github.com/stremysid/jarvis/pull/117) | **superseded in part** | Keep only the CI wiring for `check-state.mjs`; its carrier content is superseded | reviewer | none | Reviewer-authored. The CI wiring is the durable half: nothing runs `check-state.mjs` today |
| [#118](https://github.com/stremysid/jarvis/pull/118) | awaiting-review | Reviewer reads it | reviewer | none | T6 is closed |
| [#122](https://github.com/stremysid/jarvis/pull/122) | awaiting-review | Reviewer reads it | reviewer | none | The memory redesign spec |
| [#127](https://github.com/stremysid/jarvis/pull/127) | **close** | Superseded: `BUILDING.md` is rewritten without milestones on `main`, and #127's version still carries the R table and re-adds the deleted `docs/HANDOFF.md` | Sid | none | |

**Closed unmerged:** [#111](https://github.com/stremysid/jarvis/pull/111) (Sid, 2026-09-22). Its
premise was measured before `testTimeout` was set, and setting it made a timeout a signal, so the
`gate.ps1` isolation re-runs have nothing left to explain. Reopen only if a flake recurs that the
timeout cannot account for.
## The 2026-09-22 audit of `d0ec419`

A read-only audit ran on 2026-09-22 and produced a ranked list. **Two of its own claims were
withdrawn after challenge, so read its corrections before acting on any of it.** The figures it
reports are from `d0ec419`; `#143` has since landed, which resolved the `DEEPSEEK_MODEL`
question (production runs Flash) and moved the deploy row. The findings below are what survived.

**Only the first two were traced end to end, at both ends of the chain.** The rest are
labeled as they stand, and one has an external premise nobody measured.

| Finding | State | Next action | Owner |
|---|---|---|---|
| **The four-digit PIN is unredacted** | **FIXED and merged in [#149](https://github.com/stremysid/jarvis/pull/149)** (`2855105`), not yet deployed | A four-digit run after a credential word is redacted on every channel, tested through `handleTurn`. **The fix this row used to name is withdrawn** (Sid, 2026-09-22): a bare four-digit rule would also redact every year, time and price, including in replies `sanitizeRedaction` cleans, and ungating the DTMF branch would never reach `handleTurn` — it passes field `conversation.turn.text`, which matches no DTMF suffix on either channel. **Still uncaught: a PIN with no credential word before it, and a PIN spoken as words** | builder |
| **`scripts/deploy.ps1` ships an unknown revision** | **FIXED and merged in [#150](https://github.com/stremysid/jarvis/pull/150)** (`f6bab5b`) | `-Publish` now fetches, then refuses unless the checkout is exactly `origin/main` with nothing uncommitted. **Never write "the last five CI runs pass" in this file** — that phrasing was false and this row is where it kept coming back from | builder |
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
| **PC controls: boot chain, D2L read, daily report** | **P1 and the launcher are merged; P2 has a brief; P3 not started** | Three stacked PRs. **P1** auto-login plus a logon-scheduled task at `-RunLevel Highest`, so Jarvis is elevated from the power button with no morning input — merged as `e3e3527`, and the Windows entry point that actually starts the agent (`jarvis serve`, [#145](https://github.com/stremysid/jarvis/pull/145)) is also merged, so the chain reaches a live agent instead of exiting 3. **P2** the PC logs into D2L and reads assignments, pushing through the already-enrolled device: its brief is [briefs-p2-d2l-read.md](briefs-p2-d2l-read.md), and **most of the cloud half already exists** — `school-observation-repository.ts`, `classroom-observation-sync.ts` (its page-reader is an interface, not Classroom) and the `school_assignment_observations` schema. The gap is the reader, not the store. **P3** the report on Telegram, and it must state `last_success_at` — a scraper that breaks silently is the failure that matters. Overview brief: [briefs-pc-controls.md](briefs-pc-controls.md). **This is the only route to Phase 3**, because D2L's email carries no deadlines. P1's scripts are `ops/jarvis-autologon.ps1`, `ops/jarvis-logon-task.ps1` and `ops/jarvis-boot.ps1`; the runbook is [pc-boot-chain.md](runbooks/pc-boot-chain.md) | builder | **Phase 3 and Phase 4** |
| **No Windows launcher for the local agent** | **DONE and merged in [#145](https://github.com/stremysid/jarvis/pull/145)** | `jarvis serve` binds `\\.\pipe\jarvis-local-agent` through the existing `NamedPipeServer`, so `ops/jarvis-boot.ps1`'s `Resolve-AgentCommand` returns a real command and the boot chain reaches a live agent. `jarvis config` answers what `serve` would refuse on without starting it. Fold this row away. **Two things remain before it works at logon:** `JARVIS_ARCHIVE_PATH` and `JARVIS_MEMORY_PATH` must be set at user scope (see [OWNER-ACTIONS.md](OWNER-ACTIONS.md)), and the boot script exits 0 the moment the pipe answers, so a device the gateway rejects leaves a service that vanished seconds later — the logon task's `RestartCount 3` is the only recovery | builder | none |
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
| `selectControlTargets` reads `memory_item_fts` with no suppression anti-join | **live defect** | Copy the two `NOT EXISTS` clauses the FTS arm of `readCandidates` carries | builder | Phase 2 |
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

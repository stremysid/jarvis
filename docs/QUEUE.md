# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the phase a pull request gates.

Last regenerated: 2026-09-21, against `main` = run `git log --oneline origin/main -1`.

## Pull requests

| PR | State | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#141](https://github.com/stremysid/jarvis/pull/141) | awaiting-review | Reviewer reads it; it conflicts with `main` | reviewer | Phase 4 | The PC boot chain: auto-login, an elevated logon task, and the boot entry point. Conflicting |
| [#96](https://github.com/stremysid/jarvis/pull/96) | **blocked** | Rebase onto `main` | builder | Phase 5 | Spoken PIN before sensitive actions, and the redaction fix. 57 files. Conflicting |
| [#111](https://github.com/stremysid/jarvis/pull/111) | **blocked** | Re-measure now that `testTimeout` is set; likely no longer needed | builder | none | `gate.ps1` isolation re-runs. Conflicting |
| [#113](https://github.com/stremysid/jarvis/pull/113) | **awaiting-independent-pass** | DeepSeek reviews it | Sid | none | The sweep set the 2026-09-18 triage never covered. Reviewer-authored. Conflicting |
| [#117](https://github.com/stremysid/jarvis/pull/117) | **superseded in part** | Keep only the CI wiring for `check-state.mjs`; its carrier content is superseded | reviewer | none | Reviewer-authored. Conflicting |
| [#118](https://github.com/stremysid/jarvis/pull/118) | awaiting-review | Reviewer reads it | reviewer | none | T6 is closed. Conflicting |
| [#122](https://github.com/stremysid/jarvis/pull/122) | awaiting-review | Reviewer reads it | reviewer | none | The memory redesign spec. Conflicting |
| [#127](https://github.com/stremysid/jarvis/pull/127) | **close** | Superseded: `BUILDING.md` is rewritten without milestones on `main`, and #127's version still carries the R table and re-adds the deleted `docs/HANDOFF.md` | Sid | none | Conflicting |

## Work with no pull request yet

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| The operation guard in `findControlTargets` is a hand-kept list | **not started** | #135 added `pin`/`unpin` to it, but its test hand-lists the operations too: adding a member to `TelegramMemoryTargetOperation` passes the test and typecheck while the guard rejects it. Make the guard a `satisfies Readonly<Record<TelegramMemoryTargetOperation, true>>` map, as #124 did for the intent set. The fourth copy of this defect | builder | Phase 2 |
| **PC controls: boot chain, D2L read, daily report** | **decided; P1 is #141** | Three stacked PRs. **P1** auto-login plus a logon-scheduled task at `-RunLevel Highest`, so Jarvis is elevated from the power button with no morning input. **P2** the PC logs into D2L and reads assignments, pushing through the already-enrolled device. **P3** the report on Telegram, and it must state `last_success_at` — a scraper that breaks silently is the failure that matters. Brief: [briefs-pc-controls.md](briefs-pc-controls.md). **This is the only route to Phase 3**, because D2L's email carries no deadlines | builder | **Phase 3 and Phase 4** |
| **Memory has saved nothing since the promotion fix went live** | **open** | Since the 2026-09-20 deploy, 4 owner Telegram turns reached distillation as `eligible` and produced **zero** new memory items; the newest item is from 2026-09-17, and all 5 are still `proposed`. Not yet known whether those 4 turns held anything worth saving. Next: send Jarvis a plain fact, wait for the hourly run, and read the extraction output for that turn | reviewer | Phase 2 |
| **`findControlTargets` is the only one of its two interfaces the voice path has** | **from `#137`** | `D1ContextRetriever implements ContextRetriever` only, while `TelegramMemoryRetriever` also implements `TelegramMemoryTargetFinder`. Voice therefore cannot name a memory to act on, so every memory tool that takes an `itemId` has nothing to resolve one from. Adding the finder to the voice path is part of the agent adapter, not a separate wiring call. No test asserts which tools need it: both retriever suites stub `findControlTargets` | builder | **Phase 5** |
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

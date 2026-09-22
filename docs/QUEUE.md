# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the phase a pull request gates.

Last regenerated: 2026-09-21, against `main` = run `git log --oneline origin/main -1`. The three voice rows below were re-verified on branch `goal/item4-5-voice`, whose five gates are recorded in `AGENT_LOG.md`; re-check them before relying on them.

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
| The operation guard in `findControlTargets` is a hand-kept list | **half fixed** | The guard is now `SUPPORTED_OPERATIONS`, a `satisfies Readonly<Record<MemoryTargetOperation, true>>` map in `src/memory/memory-control-targets.ts`, so a new union member is a compile error. **What remains:** `control-targets.test.ts` still hand-lists the seven operations instead of deriving them from the union, so the test would not catch a map entry missing from the union's own coverage | builder | Phase 2 |
| **PC controls: boot chain, D2L read, daily report** | **decided; P1 is #141** | Three stacked PRs. **P1** auto-login plus a logon-scheduled task at `-RunLevel Highest`, so Jarvis is elevated from the power button with no morning input. **P2** the PC logs into D2L and reads assignments, pushing through the already-enrolled device. **P3** the report on Telegram, and it must state `last_success_at` — a scraper that breaks silently is the failure that matters. Brief: [briefs-pc-controls.md](briefs-pc-controls.md). **This is the only route to Phase 3**, because D2L's email carries no deadlines | builder | **Phase 3 and Phase 4** |
| **Memory has saved nothing since the promotion fix went live** | **open** | Since the 2026-09-20 deploy, 4 owner Telegram turns reached distillation as `eligible` and produced **zero** new memory items; the newest item is from 2026-09-17, and all 5 are still `proposed`. Not yet known whether those 4 turns held anything worth saving. Next: send Jarvis a plain fact, wait for the hourly run, and read the extraction output for that turn | reviewer | Phase 2 |
| **The finder is now reachable from the voice path, and one of its two lookups is still Telegram-only** | **half done** | `D1MemoryControlTargetFinder` (`src/memory/memory-control-targets.ts`) is the extracted finder; `D1ContextRetriever` still implements `ContextRetriever` only, and the voice adapter is passed the finder instead of inheriting it, so the `itemId` tools can resolve a target. **What remains:** `findLastReferencedTarget` — the lookup the agent uses for every control (`query: null`, `turnId`) — needs a `conversation_deliveries` row and a `conversation.assistant_delivered` event, and a voice turn stages nothing, so it returns empty on a call. Over voice, "the memory I just mentioned" therefore resolves only through the item ids in the model's context | builder | Phase 5 |
| Voice has no tool dispatch — a call can talk and cannot act | **done in `goal/item4-5-voice`** | The voice agent adapter exists: `OwnerVoiceAgentAdapter` (`src/voice/voice-agent.ts`) is a `ModelAdapter` whose `stream` drives `ModelAgentProvider` and runs the tool call, mirroring `OwnerTelegramAgentAdapter`, with the tier gate in front and the receipts spoken. No test asserted which tools need the finder — that was a read, not a measurement | builder | Phase 5 |
| One brain: two composition sites for what should be one assistant | **core extracted, not collapsed** | The loop, the caps, the tier gate, the receipt guard and the nine memory tools now live once in `OwnerAgentCore` (`src/agent/owner-agent-core.ts`), and both channels subclass it. Two composition sites remain, and deliberately: each channel supplies its own authority check, its own reply composition, its own prompt addition and its own tool catalogue. What is *not* done is the full collapse — a Durable Object holding conversation state does not exist, so `CallSession` and the stateless Telegram Worker still reach the brain by different routes | builder | Phase 1 |
| `hermes-runtime` `artifact-security-review3` is a timing flake | **open, unowned** | "uses one absolute cancellation deadline…" failed at 12,975 ms on `352991e`, in code that commit did not touch, and passed on re-run. Cause not yet established | builder | none |
| `owner-telegram-agent.test.ts` and `telegram-memory.test.ts` flake | **open, unowned** | Both failed on #137's CI and passed on #138's, whose tree carried the same code. `owner-telegram-agent.test.ts` roams (green `35532044202`, red `35532739198` at `:1134`, trees differing only in a log entry); `telegram-memory.test.ts`'s 500 ms retrieval budget failed once | builder | every gate |
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

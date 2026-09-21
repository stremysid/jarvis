# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the phase a pull request gates.

Last regenerated: 2026-09-21, against `main` = run `git log --oneline origin/main -1`.
Updated on 2026-09-21: `#137` rebased onto `main` after #133, #135 and #140; `#138` stacked on it
and listed below. **A stale *"Apply `0038`, then deploy"* row was found by `#137` and removed by
`#140` independently**, so neither branch carries that change now.

## Pull requests

| PR | State | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#136](https://github.com/stremysid/jarvis/pull/136) | awaiting-review | Reviewer reads it | reviewer | Phase 5 | The passphrase repeat filter let the spent status through as ordinary text |
| [#137](https://github.com/stremysid/jarvis/pull/137) | awaiting-review | Reviewer reads it | reviewer | Phase 5 | The voice seam is decided, and the spent passphrase repeat is pinned |
| [#133](https://github.com/stremysid/jarvis/pull/133) | **awaiting-independent-pass** | DeepSeek reviews it, then merge | Sid | none | Reviewer-authored. Brings every carrier into line with production and sets the code's model default to `deepseek-flash`. **Until it merges, `main`'s carriers are stale** |
| [#96](https://github.com/stremysid/jarvis/pull/96) | **blocked** | Rebase onto `main` | builder | Phase 5 | Spoken PIN before sensitive actions, and the redaction fix. 57 files. Conflicting |
| [#111](https://github.com/stremysid/jarvis/pull/111) | **blocked** | Re-measure now that `testTimeout` is set; likely no longer needed | builder | none | `gate.ps1` isolation re-runs. Conflicting |
| [#113](https://github.com/stremysid/jarvis/pull/113) | **awaiting-independent-pass** | DeepSeek reviews it | Sid | none | The sweep set the 2026-09-18 triage never covered. Reviewer-authored. Conflicting |
| [#117](https://github.com/stremysid/jarvis/pull/117) | **superseded in part** | Keep only the CI wiring for `check-state.mjs`; the carrier content is superseded by #132 and #133 | reviewer | none | Reviewer-authored. Conflicting |
| [#118](https://github.com/stremysid/jarvis/pull/118) | awaiting-review | Reviewer reads it | reviewer | none | T6 is closed. Conflicting |
| [#122](https://github.com/stremysid/jarvis/pull/122) | awaiting-review | Reviewer reads it | reviewer | none | The memory redesign spec. Conflicting |
| [#127](https://github.com/stremysid/jarvis/pull/127) | **blocked** | Rebase, and **do not resurrect `docs/HANDOFF.md`**, which #131 deleted | builder | none | Rewrites `BUILDING.md`, whose vendor table is still keyed to R0–R10. Conflicting |
| [#138](https://github.com/stremysid/jarvis/pull/138) | **awaiting-review** | Reviewer reads it, after #137 merges | reviewer | Phase 5 | The register of decisions written in code, and the audit salvage preserved. Docs only |

## Work with no pull request yet

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| **Deploy** | **blocked on Sid** | #135 fixed pinning on `main`; production still throws until the gateway is redeployed. Same two commands as before: pull `C:\javis`, then `scripts/deploy.ps1 -Publish`. No migration this time | Sid | Phase 2 |
| The operation guard in `findControlTargets` is a hand-kept list | **not started** | #135 added `pin`/`unpin` to it, but its test hand-lists the operations too: adding a member to `TelegramMemoryTargetOperation` passes the test and typecheck while the guard rejects it. Make the guard a `satisfies Readonly<Record<TelegramMemoryTargetOperation, true>>` map, as #124 did for the intent set. The fourth copy of this defect | builder | Phase 2 |
| **PC controls: boot chain, D2L read, daily report** | **decided, not started** | Three stacked PRs. **P1** auto-login plus a logon-scheduled task at `-RunLevel Highest`, so Jarvis is elevated from the power button with no morning input. **P2** the PC logs into D2L and reads assignments, pushing through the already-enrolled device. **P3** the report on Telegram, and it must state `last_success_at` — a scraper that breaks silently is the failure that matters. Brief: `C:\javis\.brief-pc-controls.md`. **This is now the only route to Phase 3**, because D2L's email carries no deadlines | builder | **Phase 3 and Phase 4** |
| **`findControlTargets` is the only one of its two interfaces the voice path has** | **from `#137`** | `D1ContextRetriever implements ContextRetriever` only, while `TelegramMemoryRetriever` also implements `TelegramMemoryTargetFinder`. Voice therefore cannot name a memory to act on, so every memory tool that takes an `itemId` has nothing to resolve one from. Adding the finder to the voice path is part of the agent adapter, not a separate wiring call | builder | **Phase 5** |
| Voice has no tool dispatch — a call can talk and cannot act | **seam decided, not built** | Build the voice agent adapter: a `ModelAdapter` whose `stream` drives `ModelAgentProvider` and runs the tool call, mirroring `OwnerTelegramAgentAdapter`, then extract the channel-neutral core. Decision and evidence: `DECISIONS.md`, *"Voice gets tools behind `ModelAdapter`"* | builder | **Phase 5** |
| One brain: two composition sites for what should be one assistant | **seam decided, not built** | The keystone, and the same commit as the row above: Telegram composes its own agent adapter and voice composes a bare `DeepSeekModelAdapter` (`production-runtime.ts` vs `index.ts`) | builder | Phase 1 |
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

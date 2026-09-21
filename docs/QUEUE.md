# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the phase a pull request gates.

Last regenerated: 2026-09-20, against `main` = run `git log --oneline origin/main -1`.

## Pull requests

| PR | State | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#96](https://github.com/stremysid/jarvis/pull/96) | **blocked** | Rebase onto `main`, then request review | builder | Phase 5 | Spoken PIN before sensitive actions, and the redaction fix. 57 files. Its `\d{2,}` contextual rule is the fix for the four-digit PIN gap, verified by executing `sanitizeRedaction`. Conflicting since 2026-09-18 |
| [#111](https://github.com/stremysid/jarvis/pull/111) | **blocked** | Re-measure now that `testTimeout` is set, then decide whether it is still needed | builder | none | `gate.ps1` isolation runs 1 → 3, classifying on the rate. #116 set a 15s timeout, so the load-timeout class it was written against is largely gone. Conflicting |
| [#113](https://github.com/stremysid/jarvis/pull/113) | **awaiting-independent-pass** | A second vendor reads it — not the reviewer who wrote it | Sid | none | The sweep set the 2026-09-18 triage never covered. Reviewer-authored, so `AGENTS.md`'s rule applies. Conflicting |
| [#117](https://github.com/stremysid/jarvis/pull/117) | **superseded in part** | Re-check what is left of it now that #130 and #131 have landed | reviewer | none | Wired `check-state.mjs` into CI and regenerated the carriers. Reviewer-authored. Conflicting |
| [#118](https://github.com/stremysid/jarvis/pull/118) | awaiting-review | Reviewer reads it | reviewer | none | T6 is closed — the `local-agent` job is green. Conflicting |
| [#122](https://github.com/stremysid/jarvis/pull/122) | awaiting-review | Reviewer reads it | reviewer | none | The memory redesign spec. Reviewed once: one claim confirmed, one overstated, one did not reproduce. Conflicting |
| [#127](https://github.com/stremysid/jarvis/pull/127) | awaiting-review | Reviewer reads it | reviewer | none | Process: who builds, who reviews, and the deep final review. Conflicting |
| [#128](https://github.com/stremysid/jarvis/pull/128) | **cleared, one conflict left** | Merge `main` in — `docs/AGENT_LOG.md` only, since #116 landed its entry — then merge | builder | Phase 2 | `memory_search`. Cleared at `48c3233`: 28 files, 779 tests, zero failures, and the suppression property mutation-killed independently |

## Work with no pull request yet

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| **Apply `0038`, then deploy** | **blocked on Sid** | Everything merged since 2026-09-18 is correct and inert until this happens — the promotion fix, the tier-3 gate, forgetting's back door, the whole memory rebuild | Sid, then reviewer | **everything** |
| Voice has no tool dispatch — a call can talk and cannot act | **decided, not started** | Compose the tool-calling agent into `CallSessionCore`, with the tier-3 gate in front and receipts on the voice channel | builder | **Phase 5** |
| One brain: two composition sites for what should be one assistant | **not started** | The keystone. Until it lands, every capability added reaches one door only | builder | Phase 1 |
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

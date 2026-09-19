# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the milestone a pull request gates —
`v1.0` outranks everything else (`docs/BUILDING.md`).

Last regenerated: 2026-09-19, against `main` = run `git log --oneline origin/main -1`.

## Pull requests

| PR | State | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#96](https://github.com/stremysid/jarvis/pull/96) | **blocked** | Resolve the conflict against `main`, then request review | builder | **v1.0** | Spoken PIN before sensitive actions, and the redaction fix. 57 files. Its `\d{2,}` contextual rule is the fix for the four-digit PIN gap, verified by executing `sanitizeRedaction`. Conflicting since 2026-09-18 |
| [#108](https://github.com/stremysid/jarvis/pull/108) | **ready-to-merge** | Merge | reviewer | none | Review protocol. Accepted with one amendment, pushed: §3.4 now points at `AGENTS.md`'s existing reviewer-authored rule. Sections 6–7 ruled on separately |
| [#109](https://github.com/stremysid/jarvis/pull/109) | **ready-to-merge** | Merge | reviewer | none | Redesign and optimisation, 30 items. A1 and A2 struck as closed by #106 and #110; E1 re-ranked now that CI gates real merges |
| [#111](https://github.com/stremysid/jarvis/pull/111) | **blocked** | Land `testTimeout` first, then re-measure | builder | none | `gate.ps1` isolation runs 1 → 3, classifying on the rate. Conflicting, and the cause is upstream: no `testTimeout` is configured, so three runs measure machine load three times |
| [#113](https://github.com/stremysid/jarvis/pull/113) | **awaiting-independent-pass** | A second vendor reads it — **not** the reviewer who wrote it | Sid | none | The sweep set the 2026-09-18 triage never covered. Reviewer-authored, so `AGENTS.md`'s rule applies |

## Work with no pull request yet

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| Voice has no tool dispatch — a call can talk and cannot act | **decision, not a task** | Sid rules on whether a phone call should be able to do things. R1's exit test does not require a tool, so R1 can pass and still be a chatbot | Sid | **v1.0 as the owner means it** |
| A four-digit PIN, a spoken-word PIN, a phone number and the owner passphrase match no redaction rule | **live defect** | #96 fixes the digit half. The digit-word, phone-number and `Bearer`-ordering halves are untouched, and the passphrase is not matchable by pattern at all | builder | v1.0 |
| `explain` / `forget` / `restore` print the memory text in the result that says it was withheld | **live defect** | Pass the string the service already sanitised instead of re-reading the repository | builder | R2 |
| `selectControlTargets` reads `memory_item_fts` with no suppression anti-join | **live defect** | Copy the two `NOT EXISTS` clauses the FTS arm of `readCandidates` already carries | builder | R2 |
| A confirmation binds `capability:argumentsHash`, not the tool name; five tools share `memory.write` | latent | Fold the tool name into `confirmationReference` — one pure function, no schema change | builder | first tier-3 hand |
| `channel_identities` has no `BEFORE INSERT` trigger; `capability_tiers` has no update or delete guard | not started | One migration, four triggers. Next free number is **`0038`** | builder | R2 |
| `tool-gate.ts` returns `verdict: "permit"` as a literal | not started | Deny when the second evaluation is not the outcome the first one was. `verdictFor(confirmed)` is the **wrong** fix | builder | first tier-3 hand |
| `telegram-provider.ts` clears its abort timer before the body read | not started | Keep the timer armed across `response.json()`, as `twilio-provider.ts` does | builder | none |
| `jarvis vault sync` can never see past the first 64 notes | not started | Persist a position; `documents_examined` counts unchanged files | builder | none |
| No `testTimeout` is configured anywhere | **blocks #111** | Set one for the cloud-gateway suite, justified from the measured distribution | builder | every gate |
| The watchdog declares none of its alerting secrets | not started | Add them to `apps/watchdog/wrangler.toml` so a mute watchdog fails its deploy | builder | R0 |
| `typecheck:tests` reports 144 errors in 32 files | awaiting-triage | Fix or gate them. `AGENTS.md` and `TESTING.md` say ~117 and are stale | builder | none |
| Telegram rate limiter and provider circuit breaker are per-isolate | not started | Move both into a Durable Object | builder | none |
| `handleReadiness` has zero call sites | awaiting-triage | Route it, or delete it — liveness is routed and readiness is not | builder | none |
| No Windows service host for the local agent | not started | R3 chooses the execution host; do not build it before that | builder | R3 |
| External uptime monitor | blocked | Owner action, after a deployment proves the heartbeat | Sid | R0 |

## How this file stays true

- A pull request appears here from the moment it is opened, and leaves when it is
  merged or closed.
- The reviewer writes the verdict into the row when it posts one, so the queue is
  never more than one review behind reality.
- Anything only Sid can do belongs in [OWNER-ACTIONS.md](OWNER-ACTIONS.md), not here.
- Nothing in this file may state a revision as current. Query it.
- `scripts/check-state.mjs` runs in CI as the `state carriers are honest` job. It
  fails on a carrier that has lost its `BLOCKS` column, its regeneration date or a
  link, and warns on a stale fact rather than failing — a check that refuses to pass
  gets switched off.

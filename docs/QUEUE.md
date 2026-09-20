# Queue

What is in flight, who owns the next action, and what it blocks. **This file is the
working queue.** The roadmap says what should exist; this says what is actually
moving. Regenerate it rather than appending to it.

`state` is one of `awaiting-review`, `changes-requested`, `awaiting-owner`,
`blocked`, `ready-to-merge`. `BLOCKS` names the milestone a pull request gates —
`v1.0` outranks everything else (`docs/BUILDING.md`).

Last regenerated: 2026-09-18, against `main` = run `git log --oneline origin/main -1`.

## Pull requests

| PR | State | Next action | Owner | BLOCKS | Notes |
|---|---|---|---|---|---|
| [#96](https://github.com/ksid1229-ops/jarvis/pull/96) | **blocked** | Resolve the conflict against `main`, then request review | builder | **v1.0** | Spoken PIN before sensitive actions, and the redaction fix. Migration renumbered `0035` → `0036`. Ready for review since 06:07 UTC on 2026-09-18; conflicting since. The verdict exists only in a handoff — it has no `AGENT_LOG` entry on `main`. |
| [#106](https://github.com/ksid1229-ops/jarvis/pull/106) | awaiting-review | Independent review at `43fbb08` | reviewer | none | Wires the tier-3 gate that currently has zero callers, and classifies `memory_correct`. Fixes the control behind the "/shadow off" claim below. Before it merges, correct `0035`'s opening comment: it says *eight* tools, there are *nine*. |
| [#105](https://github.com/ksid1229-ops/jarvis/pull/105) | awaiting-review | Independent review at `42cd0ae4` | reviewer | none | Corrects the Classroom owner action to "cannot be performed on this board". Currently the wrong document is still what a new session reads first. |
| [#24](https://github.com/ksid1229-ops/jarvis/issues/24) | awaiting-triage | Decide: fix, document, or close | reviewer | none | Issue, not a PR: Hermes rejects trusted PowerShell 7 Store/MSIX installations. Open since 2026-09-13. |

## Work with no pull request yet

| Item | State | Next action | Owner | BLOCKS |
|---|---|---|---|---|
| `/shadow off` tells the owner tier 3 still asks first, and it does not | **live defect** | #106 for the control; change the two strings today either way | builder | v1.0 trust |
| Forgetting has a back door: distillation re-ingests suppressed turns, hourly | **live defect** | Add the suppression anti-join two other retrieval paths already carry | builder | R2 |
| A four-digit PIN and the owner passphrase match no redaction rule | **live defect** | Add the rules; re-aim the test at `conversation.turn.text` | builder | v1.0 |
| The model cannot state its own certainty | **decided, not started** | Sid ruled 2026-09-20 that certainty is the model's. Remove the certainty assignment at `extraction-policy.ts`'s validation boundary and drop it from `FORBIDDEN_PROPOSAL_KEYS`, so `basis` carries what Jarvis concluded. **Keep origin and lifecycle code-assigned** — those are provenance and enforcement, which the model cannot do | builder | R2 |
| Voice has no tool dispatch — a call is a chatbot | not started | Compose the tool-calling agent into `CallSessionCore` | builder | **v1.0 as the owner means it** |
| State carriers (`STATE.md`, this file, `OWNER-ACTIONS.md`) | awaiting-review | Branch `codex/state-carriers` | builder | none |

| `typecheck:tests` reports 144 errors in 32 files | awaiting-triage | Fix them or gate them; the docs say ~117 and are stale | builder | none |
| Telegram rate limiter and the provider circuit breaker are per-isolate | not started | Move both into a Durable Object | builder | none |
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

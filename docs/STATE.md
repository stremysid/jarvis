# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A
fact that depends on a revision carries the command that prints it, or a date and
the session that observed it. The handoff, the roadmap and this file have each, at
different times, asserted a sha that had already moved; the fix is to stop writing
them down.

If this file disagrees with a longer document, this file is right and the longer
document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-21, by the reviewer, against production queried directly
and the revision printed by `git log --oneline origin/main -1`. Regenerate it; do not
append to it.

**One correction on branch `goal/item4-5-voice`, not yet on `main`.** The Phase 1, 2
and 5 rows and the two-assistants table below were rewritten by that branch, which
built the voice agent adapter and extracted the channel-neutral core. Nothing in the
Production section was re-queried: **that branch has not been deployed**, so the
production numbers below are what `main`'s deploy showed, not what this branch would
show.

## Where the project actually stands

| Phase | Verdict | The one thing missing |
|---|---|---|
| 1 The nervous system | **partial** | Infrastructure is there, and as of `goal/item4-5-voice` so is one brain for the agent loop: `OwnerAgentCore` holds the loop, the caps, the tier gate, the receipt guard and the nine memory tools once, and Telegram and voice each subclass it. **What is not collapsed** is the channel itself: a stateless Worker for Telegram and a separate `CallSession` DO for voice, with no DO holding conversation state for Telegram to share. No SMS path, no Queues |
| 2 Memory | **code-complete; the two channels act on one store and recall from two** | Schema, promotion fix, core profile, nine tools and expiry are live as of 2026-09-20. Pinning works in production as of 2026-09-21. **A phone call now acts on `memory_items`, the same store Telegram writes** — before `goal/item4-5-voice` the voice path could not name a memory at all. Recall still differs: Telegram composes `TelegramMemoryRetriever`, voice composes `D1ContextRetriever` over `memory_fact_projection_*`, whose only writer is `http/sync-routes.ts` when the Windows local agent pushes, and which is **empty in production** — so nothing said by text reaches a phone call's *context* |
| 3 School | **built, and cannot receive anything useful** | The email route is configured, and **D2L's email carries no deadline.** Sid enabled every notification option; D2L sends an activity summary naming the course with a count (*"76 New Emails"*) and a link. No assignment, no date. So the handler, parser and authenticity checks are correct and **their input cannot contain what they need**; the dates are behind the D2L login. Classroom is impossible on this board (no Google Cloud Console access) and the Brightspace feed does not exist. **The only remaining route is the PC reading D2L while logged in** — see [QUEUE.md](QUEUE.md) |
| 4 Control | **built as the inverse of what the roadmap asks** | Tiers are a D1 table looked up per capability, not prompt guidance Jarvis judges. Confirmations bind `capability:argumentsHash`, not the tool name, and are never consumed. Unchanged by the voice work except that voice now reaches the same gate |
| 5 Calling | **plumbing proven, brain present, release gate never run** | Six inbound owner calls reached Jarvis on 2026-09-17 (one completed, three rejected, one failed, one enrollment). No outbound call has ever been placed. **As of `goal/item4-5-voice` a call dispatches the nine memory tools**: `OwnerVoiceAgentAdapter` is a `ModelAdapter` that drives `ModelAgentProvider`, with the tier gate in front and the receipts spoken. Two memory tools remain unusable on a call — `memory_confirm` and the "previous memory" lookup both need the Telegram delivery chain — and the release gate has still never been run |
| 6 Daily rhythm | **cron only** | Four cron triggers fire. Jarvis cannot schedule its own wake-ups — no DO holds conversation state to hang an alarm on — and does not choose the digest time |
| 7 Plumbing | **most complete** | Nightly backup, archive and the watchdog all run. **The heartbeat records as of 2026-09-20.** No external watchdog; vault sync stops at 64 notes |

Measured against the phases in
[`plan/2026-09-19-jarvis-roadmap.md`](plan/2026-09-19-jarvis-roadmap.md).

## The one thing that changes what Jarvis is

**There are two assistants, not one, and they are one brain short of the whole way.** Telegram and a phone
call are still composed separately, and the agent loop they now share is only part of it:

| | Telegram | Phone call |
|---|---|---|
| Agent loop | `OwnerAgentCore` + `OwnerTelegramAgentAdapter` | `OwnerAgentCore` + `OwnerVoiceAgentAdapter` — **one copy of the loop, the caps, the tier gate and the receipt guard** |
| Tools | twelve: nine memory, plus `school_update`, `university_update`, `study_coach` | **nine: the memory tools.** No school, university or study pipeline over a call |
| Memory it acts on | `memory_items`, through `TelegramMemoryRetriever` | `memory_items`, through `D1MemoryControlTargetFinder` — **the same store** |
| Memory it recalls | `memory_items` and `memory_fact_projection_*` | `memory_fact_projection_*` only — a different store, written only when the Windows local agent pushes, and **empty** in production |
| Authority | the turn is Sid's direct current Telegram text | the turn's principal is the configured owner, on a session that required the owner passphrase |
| Core profile | injected every turn | injected every turn |
| A tier-3 tap | an inline keyboard | raised durably, then **spoken** — the tap itself has to be given in Telegram |

So a call can act now, and what it acts on is the store Sid's memory actually lives in. What has not
changed is what a call can *recall*: nothing Sid tells Jarvis by text reaches a call's context, because
the store a call reads is still empty. The roadmap's answer is one brain that both doors reach; the
agent half of that landed and the memory-read half did not.

## Production

**Observed directly at 23:20 UTC on 2026-09-21**, by querying production with `wrangler`:

- **Code:** Worker `78cb6e98-7814-4be7-82fb-a795a7e4d0a7`, uploaded 2026-09-21T21:27:49Z from
  `352991e` (#135), 18 s before #133 merged. **Not deployed:** #133's model default (moot —
  production runs Flash, see [FACTS.md](FACTS.md)) and #137's voice change. Deploying is in
  [OWNER-ACTIONS.md](OWNER-ACTIONS.md).
- **Active version:** `64a184ce-4408-4962-b973-9ec3b6f48c9c`. Sid made three secret changes
  between 21:42 and 21:55 UTC after that deploy; a secret change creates a new version with the
  same code. Which secrets changed is not visible — values are write-only.
- Watchdog `c940f9b7-99cf-4194-8f41-489038a34139`.
- **D1 at migration `0038`.** Verified by querying `d1_migrations`.
- **The gateway heartbeat records.** `component_liveness` holds `cloud-gateway` at
  `2026-09-21T23:20:05Z`.
- **Memory: 5 items, all `proposed`, 0 `active`**, and 0 rows in `memory_fact_projection_facts`.
  The promotion fix is live, but the 4 owner Telegram turns since it went live were distilled
  and produced **no items at all**; the newest item is from 2026-09-17. Why is open in
  [QUEUE.md](QUEUE.md). The projection is what a phone call reads, and only the Windows local
  agent writes it, so it is empty.
- **Calls:** 6 inbound owner calls, all 2026-09-17; no outbound call ever.
- **School email:** `d2l_email_messages` is empty.

Re-query rather than trusting these; they were true at 23:20 UTC on 2026-09-21.

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | **Alive; red on `main` only from flaky tests.** On 2026-09-21 the last passing run on `main` is `0611803`; the runs since were cancelled by newer pushes (#137, #138) or failed on one of two gateway tests that flake (#140, #139 — both docs-only merges). The flakes are rows in [QUEUE.md](QUEUE.md): re-run before attributing a failure to one. A newer push cancels an older run on the same branch (one concurrency group per branch), and re-running an older run cancels the newest. Latest runs: `gh run list --repo stremysid/jarvis --branch main --limit 10` |
| `pnpm test` | **5,395 tests**, 0 skipped. **`testTimeout` is 15s** as of #116 — sized against a measured p99 of 5,247 ms and a worst unprotected test of 7,217 ms, so a timeout is now a signal rather than the machine's load. Three tests flake: `owner-telegram-agent.test.ts`, `telegram-memory.test.ts`'s 500 ms budget, and `hermes-runtime`'s `artifact-security-review3`. See [QUEUE.md](QUEUE.md) |
| `pnpm typecheck` | Clean |
| `pnpm --filter @jarvis/cloud-gateway typecheck:tests` | **144 errors in 32 files**, gated nowhere |
| `pnpm lint` | Exit 0, but four packages define it as `tsc --noEmit`; no linter is reachable |
| Voice release chain | `test:voice-access`, `test:voice-smoke`, `release:voice-gate` exist and appear in **no workflow** |

**A timeout is now a signal.** With `testTimeout` set, a red run
means something — except in the three flaky tests above, each of which
should be re-run before a failure there is attributed. Merge on CI, not on a local
run alone.

## Live defects

Re-checked against `main` and production on 2026-09-21:

1. **A four-digit PIN is not redacted**, nor a spoken-word PIN, a phone number, or
   a token on the line after `Authorization:`. Confirmed by executing
   `sanitizeRedaction`. The test that appears to cover it asserts against
   `guest.pin`, a field no production call site passes. PR #96 fixes the digit
   half only.
2. `explain` / `forget` / `restore` print the memory text in the same tool result
   that says it was withheld.
3. `selectControlTargets` reads `memory_item_fts` with no suppression anti-join,
   and that index has no delete trigger.

Items 2 and 3 are in [QUEUE.md](QUEUE.md). `KNOWN_ISSUES.md` is **not** a reliable
companion here: it is 1,145 lines and still describes shipped work as open.

## Where things live

| Question | File |
|---|---|
| What is in flight, and who acts next? | [QUEUE.md](QUEUE.md) |
| What can only Sid do? | [OWNER-ACTIONS.md](OWNER-ACTIONS.md) |
| Why is it built this way? | [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](../DECISIONS.md) |
| What is broken or unproven? | [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) |
| What stopped working and why? | [AGENT_LOG.md](AGENT_LOG.md) — **search it, do not read it** |
| What is meant to exist? | [the roadmap](plan/2026-09-19-jarvis-roadmap.md) — **Sid's own, and authoritative.** The milestone roadmaps that preceded it are deleted |
| Who builds and reviews what? | [BUILDING.md](BUILDING.md) |

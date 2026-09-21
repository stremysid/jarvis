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

## Where the project actually stands

| Phase | Verdict | The one thing missing |
|---|---|---|
| 1 The nervous system | **partial** | Infrastructure is there. The shape is not: a stateless Worker for Telegram and a separate `CallSession` DO for voice, so a capability added to one door does not reach the other. No SMS path, no Queues |
| 2 Memory | **code-complete, and split in two** | Schema, promotion fix, core profile, nine tools and expiry are live as of 2026-09-20. Pinning works in production as of 2026-09-21. **But Telegram and voice read different stores.** Telegram writes `memory_items`; `D1ContextRetriever` (voice) reads `memory_fact_projection_*`, whose only writer is `http/sync-routes.ts` when the Windows local agent pushes. Production: **5 `memory_items`, 0 projection facts** — so nothing said by text reaches a phone call, and the store a call reads is empty |
| 3 School | **built, and receiving nothing** | The D2L email handler is deployed and has **never received a single email** — `d2l_email_messages` and `d2l_email_failure_state` are both empty in production, so not even a malformed message has arrived. The Cloudflare routing rule for `school@onesid.ca` most likely still points at Gmail (unverified; see [OWNER-ACTIONS.md](OWNER-ACTIONS.md)). Separately, Classroom and the Brightspace feed are impossible on this board and are not gaps to close |
| 4 Control | **built as the inverse of what the roadmap asks** | Tiers are a D1 table looked up per capability, not prompt guidance Jarvis judges. Confirmations bind `capability:argumentsHash`, not the tool name, and are never consumed |
| 5 Calling | **plumbing proven, brain missing** | A real call has been placed and worked. The call cannot carry tools and reads a different, empty memory store — see below. The release gate has never been run |
| 6 Daily rhythm | **cron only** | Four cron triggers fire. Jarvis cannot schedule its own wake-ups — no DO holds conversation state to hang an alarm on — and does not choose the digest time |
| 7 Plumbing | **most complete** | Nightly backup, archive and the watchdog all run. **The heartbeat records as of 2026-09-20.** No external watchdog; vault sync stops at 64 notes |

Measured against the phases in
[`plan/2026-09-19-jarvis-roadmap.md`](plan/2026-09-19-jarvis-roadmap.md).

## The one thing that changes what Jarvis is

**There are two assistants, not one.** Telegram and a phone call are composed
separately, and they differ at every layer:

| | Telegram | Phone call |
|---|---|---|
| Tools | nine | **none, and none possible** — `ModelAdapterStreamInput` has no `tools` field, so this is a type change, not a wiring call |
| Memory it reads | `memory_items` | `memory_fact_projection_*` — a **different store**, written only when the Windows local agent pushes, and **empty** in production |
| Core profile | injected every turn | never |

So a call can talk and cannot act, and nothing Sid tells Jarvis by text reaches a
call. The roadmap's answer is one brain that both doors reach. It is the keystone:
until it lands, every capability added reaches one door only.

## Production

**Observed directly on 2026-09-21**, not relayed — a session with `wrangler`
queried production after deploying:

- Worker `78cb6e98-7814-4be7-82fb-a795a7e4d0a7`, deployed 2026-09-21.
- Watchdog `c940f9b7-99cf-4194-8f41-489038a34139`, same evening.
- **D1 at migration `0038`.** Verified by querying `d1_migrations`, and the three
  objects it creates exist.
- **The gateway heartbeat records.** `component_liveness` holds `cloud-gateway`
  at `2026-09-21T21:25:47Z`, after the redeploy. Every cron before this deploy logged
  `status 404`; it had never once been recorded. The fix needed a redeploy to
  prove and the redeploy proved it.
- Memory: **5 `proposed`, 0 `active`** in `memory_items`, and **0 rows** in
  `memory_fact_projection_facts`. The promotion fix is live but applies only to
  facts extracted after the deploy. The projection is what a phone call reads,
  and only the Windows local agent writes it, so it is empty.

Re-query rather than trusting these; they were true at 21:25 UTC on 2026-09-21.

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | **Alive, and green on `main`.** It was dead on billing from 2026-09-12 and came back on 2026-09-19 when the repository moved into the organisation. The last five runs on `main` all pass. Across all 33 non-cancelled runs on `main` it is 7 green and 26 red, because most of the red predates the fixes that landed on 2026-09-20 (T6, the ULID redaction bug, `testTimeout`). Query it: `gh run list --repo stremysid/jarvis --branch main` |
| `pnpm test` | **5,395 tests**, 0 skipped. **`testTimeout` is 15s** as of #116 — sized against a measured p99 of 5,247 ms and a worst unprotected test of 7,217 ms, so a timeout is now a signal rather than the machine's load. One file still roams: `owner-telegram-agent.test.ts` has gone green then red on trees differing only in a log entry |
| `pnpm typecheck` | Clean |
| `pnpm --filter @jarvis/cloud-gateway typecheck:tests` | **144 errors in 32 files**, gated nowhere |
| `pnpm lint` | Exit 0, but four packages define it as `tsc --noEmit`; no linter is reachable |
| Voice release chain | `test:voice-access`, `test:voice-smoke`, `release:voice-gate` exist and appear in **no workflow** |

**A timeout is now a signal.** With `testTimeout` set and `main` green, a red run
means something — except in `owner-telegram-agent.test.ts`, which still roams and
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

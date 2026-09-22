# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A
fact that depends on a revision carries the command that prints it, or a date and
the session that observed it. The handoff, the roadmap and this file have each, at
different times, asserted a sha that had already moved; the fix is to stop writing
them down.

If this file disagrees with a longer document, this file is right and the longer
document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-22, against `main` = the revision printed by
`git log --oneline origin/main -1`, and against production as `#143` last observed it at
23:20 UTC on 2026-09-21 (that PR's figures, not re-queried here). Regenerate it; do not
append to it.

## In flight, and what each one would change here

Five PRs are open and none is merged. **Every verdict below describes `main` without them.**
Listed because four of the five would move a verdict in this file, and a reader who merges
one should regenerate rather than patch.

| PR | What it would change |
|---|---|
| [#141](https://github.com/stremysid/jarvis/pull/141) | Phase 4's PC boot chain: auto-login and an elevated logon task. Does not move a phase verdict on its own |
| [#144](https://github.com/stremysid/jarvis/pull/144) | Removes a live defect: `selectControlTargets` could still present a memory whose originating event the ledger had suppressed |
| [#145](https://github.com/stremysid/jarvis/pull/145) | **Phase 3 and 4.** `jarvis serve` binds the Windows control pipe, so the boot chain reaches an agent. Without it P1's exit test cannot pass and the PC-as-host work sits behind it |
| [#146](https://github.com/stremysid/jarvis/pull/146) | Collapses the duplicated suppression predicate to one definition with a parity guard. Phase 2 hygiene, no verdict change |
| [#147](https://github.com/stremysid/jarvis/pull/147) | **Phase 5 and the first line of Phase 1.** A call gets tool dispatch and the memory-target finder, and both channels share `OwnerAgentCore`. It would change Phase 5's "cannot carry tools" and Phase 1's "a capability added to one door does not reach the other" to *partly* addressed: the agent loop is shared, the memory read path is not, and the two composition sites remain |

## Where the project actually stands

| Phase | Verdict | The one thing missing |
|---|---|---|
| 1 The nervous system | **partial** | Infrastructure is there. The shape is not: a stateless Worker for Telegram and a separate `CallSession` DO for voice, so a capability added to one door does not reach the other. No SMS path, no Queues |
| 2 Memory | **code-complete, and split in two** | Schema, promotion fix, core profile, nine tools and expiry are live as of 2026-09-20. Pinning works in production as of 2026-09-21. **But Telegram and voice read different stores.** Telegram writes `memory_items`; `D1ContextRetriever` (voice) reads `memory_fact_projection_*`, whose only writer is `http/sync-routes.ts` when the Windows local agent pushes. Production: **5 `memory_items`, 0 projection facts** — so nothing said by text reaches a phone call, and the store a call reads is empty |
| 3 School | **built, and cannot receive anything useful** | The email route is configured, and **D2L's email carries no deadline.** Sid enabled every notification option; D2L sends an activity summary naming the course with a count (*"76 New Emails"*) and a link. No assignment, no date. So the handler, parser and authenticity checks are correct and **their input cannot contain what they need**; the dates are behind the D2L login. Classroom is impossible on this board (no Google Cloud Console access) and the Brightspace feed does not exist. **The only remaining route is the PC reading D2L while logged in** — see [QUEUE.md](QUEUE.md) |
| 4 Control | **built as the inverse of what the roadmap asks** | Tiers are a D1 table looked up per capability, not prompt guidance Jarvis judges. Confirmations bind `capability:argumentsHash`, not the tool name, and are never consumed |
| 5 Calling | **plumbing proven, brain missing** | Six inbound owner calls reached Jarvis on 2026-09-17 (one completed, three rejected, one failed, one enrollment). No outbound call has ever been placed. The call cannot carry tools and reads a different, empty memory store — see below. The release gate has never been run |
| 6 Daily rhythm | **cron only** | Four cron triggers fire. Jarvis cannot schedule its own wake-ups — no DO holds conversation state to hang an alarm on — and does not choose the digest time |
| 7 Plumbing | **most complete** | Nightly backup, archive and the watchdog all run. **The heartbeat records as of 2026-09-20.** No external watchdog; vault sync stops at 64 notes |

Measured against the phases in
[`plan/2026-09-19-jarvis-roadmap.md`](plan/2026-09-19-jarvis-roadmap.md).

## The one thing that changes what Jarvis is

**There are two assistants, not one.** Telegram and a phone call are composed
separately, and they differ at every layer:

| | Telegram | Phone call |
|---|---|---|
| Tools | twelve: nine memory, plus `school_update`, `university_update`, `study_coach`. `send_email` and the Tesla entries are tier rows only — no tool exists | **none.** The seam is decided (`DECISIONS.md`, *"Voice gets tools behind `ModelAdapter`"*) and not built — see [QUEUE.md](QUEUE.md) |
| Memory it reads | `memory_items` | `memory_fact_projection_*` — a **different store**, written only when the Windows local agent pushes, and **empty** in production |
| Core profile | injected every turn | never |

So a call can talk and cannot act, and nothing Sid tells Jarvis by text reaches a
call. The roadmap's answer is one brain that both doors reach. It is the keystone:
until it lands, every capability added reaches one door only.

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
| CI | **Alive, and green on `main` at `cdfdd4b`** — `gh run list --repo stremysid/jarvis --branch main` shows `success` for that commit. **Do not write "the last five runs pass":** it is false, and it was false in this row before. The real shape on 2026-09-21/22 was one `failure` at `688fe02`, two runs `cancelled` by newer pushes (#137, #138), then green. A newer push cancels an older run on the same branch (one concurrency group per branch) and **a cancelled run is not a failure** — reading one as a red main is a recurring error here. Re-run a flaky test before attributing a failure to it; those rows are in [QUEUE.md](QUEUE.md) |
| `pnpm test` | **The count in this cell is stale and should not be quoted.** It said 5,395; two sessions independently measured **5,428 in 206 files** and **5,433** on trees that differ from this one, which is what a suite looks like when it grows and the carrier is not regenerated. Run `pnpm test` and read its own total. **`testTimeout` is 15s** as of #116 — sized against a measured p99 of 5,247 ms and a worst unprotected test of 7,217 ms, so a timeout is now a signal rather than the machine's load. Three tests flake: `owner-telegram-agent.test.ts`, `telegram-memory.test.ts`'s 500 ms budget, and `hermes-runtime`'s `artifact-security-review3`. See [QUEUE.md](QUEUE.md) |
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

**Fixed, not yet merged:** `selectControlTargets` read `memory_item_fts` with no
suppression anti-join, so a memory whose originating event the ledger had suppressed
was still reachable as a control target. Fixed with both `NOT EXISTS` clauses the FTS
arm of `readCandidates` carries, each pinned by its own mutation, in [#144](https://github.com/stremysid/jarvis/pull/144).

Item 2 is in [QUEUE.md](QUEUE.md). `KNOWN_ISSUES.md` is **not** a reliable
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

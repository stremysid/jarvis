# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A
fact that depends on a revision carries the command that prints it, or a date and
the session that observed it. The handoff, the roadmap and this file have each, at
different times, asserted a sha that had already moved; the fix is to stop writing
them down.

If this file disagrees with a longer document, this file is right and the longer
document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-23. Deploy updated from Sid's and the reviewer's report;
older database observations remain dated 2026-09-21. No production query was made
for this update. For the repository revision, run `git log --oneline origin/main -1`.

## In flight, and what each one would change here

`#141`, `#144`, `#146`, `#147`, `#148`, `#149` and `#150` merged 2026-09-21/22, and `#145` on
2026-09-23. **Six PRs are open**; only `#151` is listed, as the only one touching this file.
The verdicts below predate `#145`: where one says the boot chain stops at exit 3, it is stale.

| PR | What it would change |
|---|---|
| [#151](https://github.com/stremysid/jarvis/pull/151) | Documentation only: the P2 brief at [`briefs-p2-d2l-read.md`](briefs-p2-d2l-read.md). Moves no verdict |

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

**Owner-observed deploy on 2026-09-23, reported by Sid and the reviewer to PR #158.**
This builder did not query production. See the [review](https://github.com/stremysid/jarvis/pull/158#issuecomment-5805607554)
and [FACTS](FACTS.md) for provenance.

- Sid ran `scripts/deploy.ps1 -Publish` from `C:\javis` at source **`a6a0efd`**,
  at **20:41 EDT on 2026-09-23 (00:41 UTC on 2026-09-24)**.
- **Worker `jarvis-cloud-gateway`, version `7e027a1f-065b-4f60-8229-f3edff0160dc`.**
  `/health` returned **200 at 20:42 EDT** (00:42 UTC on 2026-09-24).
- **Deployed as of `a6a0efd`: #133, #137, #144, #146, #147, #149 and #154.**
  #156 (`248c3de`, Hermes, local-only) merged afterwards; it is not a gateway deploy.
- **No migrations applied; D1 stays at `0038`.** Pre-deploy restore bookmark:
  `00000eb2-00000000-000050f0-5b731149bde16c2e83a28d379fa86a15` (owner/reviewer report).

**Older observations from #143's production query at 23:20 UTC on 2026-09-21, not refreshed:**
- Watchdog `c940f9b7-99cf-4194-8f41-489038a34139`.
- **The gateway heartbeat records.** `component_liveness` holds `cloud-gateway` at
  `2026-09-21T23:20:05Z`.
- **Memory: 5 items, all `proposed`, 0 `active`**, and 0 rows in `memory_fact_projection_facts`.
  The promotion fix is live, but the 4 owner Telegram turns since it went live were distilled
  and produced **no items at all**; the newest item is from 2026-09-17. Why is open in
  [QUEUE.md](QUEUE.md). The projection is what a phone call reads, and only the Windows local
  agent writes it, so it is empty.
- **Calls:** 6 inbound owner calls, all 2026-09-17; no outbound call ever.
- **School email:** `d2l_email_messages` is empty.

The deployment and health check do not refresh these older database observations.

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | **Alive, and green on `main` at `cdfdd4b`** — `gh run list --repo stremysid/jarvis --branch main` shows `success` for that commit. **Do not write "the last five runs pass":** it is false, and it was false in this row before. The real shape on 2026-09-21/22 was one `failure` at `688fe02`, two runs `cancelled` by newer pushes (#137, #138), then green. A newer push cancels an older run on the same branch (one concurrency group per branch) and **a cancelled run is not a failure** — reading one as a red main is a recurring error here. Re-run a flaky test before attributing a failure to it; those rows are in [QUEUE.md](QUEUE.md) |
| `pnpm test` | **The count in this cell is stale and should not be quoted.** It said 5,395; two sessions independently measured **5,428 in 206 files** and **5,433** on trees that differ from this one, which is what a suite looks like when it grows and the carrier is not regenerated. Run `pnpm test` and read its own total. **`testTimeout` is 15s** as of #116 — sized against a measured p99 of 5,247 ms and a worst unprotected test of 7,217 ms, but those measurements do not make a timeout proof of an ordering defect. Of the three previously listed flakes, [#154](https://github.com/stremysid/jarvis/pull/154) fixes both Telegram cases: callback-ID corruption and the archived-memory test's host-dependent clock. Its replacement retains a virtual <=500 ms guard and requires candidate/history overlap. The remaining listed timing flake is `hermes-runtime`'s `artifact-security-review3`, whose cause remains open in [QUEUE.md](QUEUE.md). Hermes' Store PowerShell defect (#24) is separate; this PR does not claim it fixed |
| `pnpm typecheck` | Clean |
| `pnpm --filter @jarvis/cloud-gateway typecheck:tests` | **143 errors**, measured in #154 round 1; none in the changed files. Still red and gated nowhere |
| `pnpm lint` | Exit 0, but four packages define it as `tsc --noEmit`; no linter is reachable |
| Voice release chain | `test:voice-access`, `test:voice-smoke`, `release:voice-gate` exist and appear in **no workflow** |

**A runner timeout is separate from an operation deadline.** Setting `testTimeout`
does not prevent a 450 ms retrieval deadline from firing under load. The two Telegram
causes and their measured fixes are in [QUEUE.md](QUEUE.md); an assertion failure by
itself proves neither ordering nor a timeout. Merge on CI, not on a local run alone.

## Live defects

Re-checked against `main` and production on 2026-09-21:

1. **A four-digit PIN is not redacted**, nor a spoken-word PIN, a phone number, or
   a token on the line after `Authorization:`. Confirmed by executing
   `sanitizeRedaction`. The test that appears to cover it asserts against
   `guest.pin`, a field no production call site passes. [#149](https://github.com/stremysid/jarvis/pull/149)
   fixes a four-digit PIN after a credential word, on every channel, and is
   deployed as of `a6a0efd`. A bare PIN with no credential word before it, and a spoken-word PIN,
   stay open. PR #96 fixes the digit
   half only.
2. `explain` / `forget` / `restore` print the memory text in the same tool result
   that says it was withheld.

**Fixed by #144, deployed as of `a6a0efd`:** `selectControlTargets` read `memory_item_fts` with no
suppression anti-join, so a memory whose originating event the ledger had suppressed
was still reachable as a control target. Fixed with both `NOT EXISTS` clauses the FTS
arm of `readCandidates` carries, each pinned by its own mutation, in [#144](https://github.com/stremysid/jarvis/pull/144).
The finder, `D1MemoryControlTargetFinder` (`memory-control-targets.ts`, where #147 moved the arm), composes
them from `suppression-clauses.ts` since #146. To check they are still there, grep that file for
`creation_event_sequence BETWEEN`; the parity test's guards 1, 2 and 4 now pin the same thing.

Item 2 is in [QUEUE.md](QUEUE.md). [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) was
audited on 2026-09-23; its [disposition record](DOCS-VERIFY.md) names the source revision and fixes removed.

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

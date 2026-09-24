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
| 1 The nervous system | **shared owner brain; transcript continuity partial** | Channel-parity shares the 18-tool catalogue, pipeline construction, core prompt, honesty checks and canonical retrieval. Telegram Worker and voice CallSession remain transport adapters. `CHANNEL-CONTINUITY-TRANSCRIPT` in QUEUE covers the missing cross-channel assistant transcript; no SMS or Queues |
| 2 Memory | **shared code paths; rollout unverified** | Both channels now retrieve canonical `memory_items`, projected facts and bounded D1/R2 owner history through the same reader. Same-call replies retain durable target references, while model-inferred promotion requires the shared tap. Production observations below are historical and were not refreshed by channel-parity |
| 3 School | **built, and cannot receive anything useful** | The email route is configured, and **D2L's email carries no deadline.** Sid enabled every notification option; D2L sends an activity summary naming the course with a count (*"76 New Emails"*) and a link. No assignment, no date. So the handler, parser and authenticity checks are correct and **their input cannot contain what they need**; the dates are behind the D2L login. Classroom is impossible on this board (no Google Cloud Console access) and the Brightspace feed does not exist. **The only remaining route is the PC reading D2L while logged in** — see [QUEUE.md](QUEUE.md) |
| 4 Control | **built as the inverse of what the roadmap asks** | Tiers are a D1 table looked up per capability, not prompt guidance Jarvis judges. Confirmations still bind `capability:argumentsHash` across channels. The [single-use tap change](reviews/2026-09-23-tier3-tap.md) claims each tap once with a ten-minute expiry; migration `0039` and the gateway rollout await owner action |
| 5 Calling | **owner capabilities shared in code; release gate unverified** | Voice now reaches the same 18 tools, including school, university, study, guided assignment and owner-reported deadlines. Migration `0044_owner_channel_parity.sql` widens 19 existing pipeline owner-turn triggers without removing their other checks. A call sends model-inferred memory confirmation to the shared Telegram decision queue; tier 3 also requires a Telegram tap until the separate PIN rebuild. No live call or rollout in channel-parity |
| 6 Daily rhythm | **cron only** | Four cron triggers fire. Jarvis cannot schedule its own wake-ups — no DO holds conversation state to hang an alarm on — and does not choose the digest time |
| 7 Plumbing | **most complete** | Nightly backup, archive and the watchdog all run. **The heartbeat records as of 2026-09-20.** No external watchdog; vault sync stops at 64 notes |

Measured against the phases in
[`plan/2026-09-19-jarvis-roadmap.md`](plan/2026-09-19-jarvis-roadmap.md).

## Owner channel parity

Sid's rule, 2026-09-23: **"THE ONLY difference between call and telegram is the method of communication, THAT'S IT."**
Code in channel-parity implements the shared capabilities below. This is not a deployment claim.

| Surface | Both channels | Medium-specific part |
|---|---|---|
| Owner tools | One `OWNER_TOOL_DEFINITIONS` catalogue: nine memory tools, school, university, study, two collector tools, three guided assignment tools and `deadline_record` | None |
| Reasoning and receipts | `OwnerAgentCore`, one prompt core, one claim/rewrite policy and pinned profile | Spoken phrasing versus text; rewrite retains the medium section |
| Memory recall | Same canonical items, projections, literal/archive history and optional meaning search | Voice retains its bounded retrieval deadline |
| Confirmation | Same durable owner/source proof and exact wording; model-inferred memory requires a Telegram tap on either channel | Voice directs Sid to `/decisions`; an owner-stated fact can still be grounded in the exact preceding same-call question. Tier 3: Telegram tap only until PIN rebuild |
| Conversation | Owner utterances are already shared by principal; verified immediate reply is available within each session | Voice assistant transcripts remain excluded from cross-channel history; named follow-up in QUEUE |

[Full audit, premise corrections and evidence](reviews/2026-09-23-channel-parity.md).

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

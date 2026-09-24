# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A
fact that depends on a revision carries the command that prints it, or a date and
the session that observed it. The handoff, the roadmap and this file have each, at
different times, asserted a sha that had already moved; the fix is to stop writing
them down.

If this file disagrees with a longer document, this file is right and the longer
document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-24, about 21:30 UTC, from repository
evidence and the harness's round-3 snapshot. No production query was made by this docs builder.
For the repository revision, run `git log --oneline origin/main -1`.

## In flight, and what each one would change here

Eight PRs remain open in the harness's round-3 snapshot, with one harness PR being built. [QUEUE](QUEUE.md) carries their observed
heads, verdicts and next owners; merged PRs have left it.

| PR | What it would change |
|---|---|
| [#174](https://github.com/stremysid/jarvis/pull/174) | Owner channel parity and guest-call privacy fix; round-5 integration review in progress on `codex/channel-parity` at `0e458a6`, migration `0044`; retain #166's argument tools and integrate #182's three-argument `confirmationReference` when next merging main |
| [#168](https://github.com/stremysid/jarvis/pull/168) | Owner reminders; still needs its builder/renumbering round after #174; #166 has merged |
| [#179](https://github.com/stremysid/jarvis/pull/179) | This docs refresh, round 3 in progress; round 2 cleared at `f7fa19a`; awaiting harness commit and review of the resulting head |
| [#180](https://github.com/stremysid/jarvis/pull/180) | Test lows, reviewed and cleared: round 1 at `f70b30d` ready to merge, 0 High/Medium/Low, 7/7 mutants killed; harness cleared log-only main-merge head `620a754`; merges when the pending one-time failed-job re-run is green. CI failed the local-agent (ubuntu-latest) real-socket 0.1 s retry-wait race and hermes-runtime (windows) `canonical-closure-review3.test.mjs:51` default 5 s timeout; both unrelated to #180 and passing on main. Only cloud-gateway tests, one label string and the log changed; [review and re-run evidence](QUEUE.md) |
| [#181](https://github.com/stremysid/jarvis/pull/181) | Telegram body timeout at `e069e11`; review approved, harness cleared the log/KNOWN_ISSUES-only merge head; CI pending |
| [#183](https://github.com/stremysid/jarvis/pull/183) | Redaction gaps at `5f67c27`; round-1 review requested changes: rules over-redact ordinary speech ("the code is due Friday"); CI's workspace suite is red |
| [#184](https://github.com/stremysid/jarvis/pull/184) | Call-session fixes at `e786602`; round-1 review in progress |
| [#122](https://github.com/stremysid/jarvis/pull/122) | Memory redesign spec; unchanged, awaiting Sid's plan decision |
| Harness PR being built | `codex/local-agent-retry-wait-flake` covers both flaky tests: makes `test_node.py`'s real-socket retry test deterministic after its race against `QUARANTINE_RETRY_WAIT_SECONDS = 0.1`, and addresses the hermes-runtime per-test timeout where `canonical-closure-review3.test.mjs:51` hit Vitest's default 5 s limit on Windows |

#178 merged as `4f5758b`; #166 merged as `f5ba9a8` at 20:14 UTC on 2026-09-24.
#177 merged as `5548c38`; #182 merged as `a20f055` at about 21:20 UTC on 2026-09-24; neither is deployed.
#174 must retain `deadline_record` / `OWNER_ARGUMENT_TOOL_DEFINITIONS` in shared `OWNER_TOOL_DEFINITIONS`
and integrate #182's three-argument `confirmationReference` when next merging main, with review of the resulting head.

## Where the project actually stands

| Phase | Verdict | Remaining boundary |
|---|---|---|
| 1 The nervous system | **partial; shared agent core** | `OwnerAgentCore` shares the loop, caps, tier gate and receipt guard. Telegram and voice still compose separate conversations; #174 addresses channel parity. No shared conversation DO, SMS path or Queues |
| 2 Memory | **shared write store; different recall** | #147 lets calls act on `memory_items` through `D1MemoryControlTargetFinder`. Telegram recalls the memory store; voice still recalls `memory_fact_projection_*`, recorded empty on 2026-09-21. #174 addresses recall and confirmation parity. Hidden-text receipts remain a defect |
| 3 School | **paste, calendar, guided assignment and D2L collector/receiver merged; rollout pending** | #164 saves Telegram assignment pastes, #165 provides the private calendar feed, #172 guided assignments, #169/#170 the receiver/extension, and #175/#176/#178 two-board evidence and date labels. #166 adds owner-reported deadlines without a migration. The extension compatibility hold and host-failure emission still need a follow-up. Live two-board acceptance, production migrations and deployment remain pending; the old D2L email route yields no deadlines |
| 4 Control | **built; policy remains table-driven** | On main (#182, not deployed), confirmations bind tool name, capability and argument hash, and a changed second autonomy outcome is denied. #159 adds single-use ten-minute taps; `0039` and gateway production rollout remain pending. T1/T2 guards remain in QUEUE. Pending pre-deploy confirmations need a fresh tap; see [the compatibility note](../KNOWN_ISSUES.md#tier-3-confirmations-issued-before-tool-binding-2026-09-24) |
| 5 Calling | **calls owner-reported working; streaming merged, acceptance incomplete** | Sid, 2026-09-24: "ive already done test calling and it works". #147 memory tools are deployed; #171 streaming and #172 guided tools are on main. That owner report does not establish #171 live streaming/receipt/latency checks or the full voice release gate |
| 6 Daily rhythm | **cron only** | Four cron triggers; owner reminders await #168. Jarvis cannot schedule its own wake-ups or choose the digest time |
| 7 Plumbing | **mostly built** | Backup, archive and watchdog code are present; heartbeat was observed working. No external watchdog recorded; vault sync stops at 64 notes. #145 adds Windows `serve`, #157 sync/store recovery; device acceptance remains in OWNER-ACTIONS |

Measured against [the roadmap](plan/2026-09-19-jarvis-roadmap.md).

## The one thing that changes what Jarvis is

Both channels share the agent loop, but their context and catalogues still differ.
On main, voice has memory, deadline, guided-assignment and school-collector tools; Telegram
also has school, university and study pipelines. The recorded production build
predates guided-assignment and collector tools: voice there has the nine memory tools.
Voice recall still reads the local-agent projection rather than Telegram's memory
store. #174 is the pending parity change, not a deployed guarantee.

## Production

**Owner-observed deploy on 2026-09-23, reported by Sid and the reviewer to PR #158.**
This builder did not query production. See the [review](https://github.com/stremysid/jarvis/pull/158#issuecomment-5805607554)
and [FACTS](FACTS.md) for provenance. The harness's 2026-09-24 about 21:30 UTC snapshot reports production unchanged.

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

## Pending rollout

Main contains pending `0039`, `0040`, `0043` and `0045`; `0036`, `0037`, `0041`
and `0042` are absent. `0044` belongs to open #174. Renumbering older `0041`/`0042`
above main's maximum is approved; it does not authorize production application.

The 2026-09-24 scratch result is **orchestrator-reported PASS**, including `0044` after `0045`.
The Claude orchestrator ran it; results are transcribed from its harness-supplied summary and table;
not independently re-run. [Record and limits](reviews/2026-09-24-scratch-d1-rehearsal.md).
Sid plans to apply the pending migrations and deploy tonight (2026-09-24) from the home PC;
both remain **planned, not done**, separate actions in [OWNER-ACTIONS](OWNER-ACTIONS.md).

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | Query the relevant head's run before clearing it; no current green-main claim is made here. Full suites run in GitHub Actions, not on Sid's PC |
| Workspace tests | No suite rerun or permanent count in this docs round. #154 fixed the two Telegram flakes; #156 fixed Store PowerShell discovery. Remaining timing investigations are in QUEUE |
| Source typecheck / lint | No new execution here. Gateway source typecheck excludes tests; several package lint scripts are typechecks, not linters. See [TESTING](../TESTING.md) |
| Gateway `typecheck:tests` | **143 as measured on 2026-09-24 by the builders**; still red and outside CI. `node_modules/.bin/tsc` is absent here, so this builder could not remeasure |
| Voice release chain | `test:voice-access`, `test:voice-smoke`, `release:voice-gate` exist; none appears in a workflow. Live acceptance remains separate from the owner's working-call report |

A runner timeout does not prevent an operation deadline firing under load. Isolate
failures before attributing them; merge on the reviewed head's CI evidence.

## Live defects

1. **Guest-call privacy leak — live on main and in the recorded production build.**
   `OwnerAgentCore.streamCaptured` reads the configured owner's pinned core profile
   before any tool-authority check, builds the owner-framed system prompt, and sends
   the owner tool catalogue supplied by the voice adapter. A guest conversation
   therefore carries Sid's pinned facts, owner framing and owner catalogue to the
   model. The later tool refusal does not protect that prompt. Fixed only when
   [#174](https://github.com/stremysid/jarvis/pull/174) merges and deploys. Traced in
   `apps/cloud-gateway/src/agent/owner-agent-core.ts` and `voice/voice-agent.ts` on main
   and at the recorded deployment source; no live guest test was run.
2. **Memory explain/forget/restore receipts can reintroduce withheld text.** The
   shared core combines sanitized service receipts with separately read text.
3. **Remaining redaction gaps:** bare/spoken-word PIN and phone/passphrase coverage
   remain open. #149's credential-word digit fix is deployed; newer #171 quoted and
   header redaction changes await deployment. [Known limits](../KNOWN_ISSUES.md).

#144's suppression anti-join fix is deployed; #146 keeps its shared predicate and
parity guards. It is no longer an open work item.

## Where things live

| Question | File |
|---|---|
| What is in flight, and who acts next? | [QUEUE.md](QUEUE.md) |
| What can only Sid do? | [OWNER-ACTIONS.md](OWNER-ACTIONS.md) |
| What durable facts are recorded? | [FACTS.md](FACTS.md) |
| Why is it built this way? | [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](../DECISIONS.md) |
| What is broken or unproven? | [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) |
| What stopped working and why? | [AGENT_LOG.md](AGENT_LOG.md) — search it, do not read it |
| Who builds and reviews? | [BUILDING.md](BUILDING.md) |

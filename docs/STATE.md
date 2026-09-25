# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A fact that
depends on a revision carries the command that prints it, or a date and the session that
observed it. If this file disagrees with a longer document, this file is right and the
longer document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-24, evening, from repository
evidence and the orchestrator's read-only production checks. For the repository revision,
run `git log --oneline origin/main -1`.

## Deploy results (2026-09-24 evening)

**Deployed** by Sid at about 9:41 PM EDT on 2026-09-24, from his `wrangler` output as he
reported it (not queried by this session). The release is `a7cd355`, not the planned `68675ba`,
because #189 merged first; this supersedes the `0d69556` observation in [Production](#production).

| Item | Result |
|---|---|
| Source | `a7cd3553166e10293e27656c4b800f26b0dec7cb` (#189) |
| Migrations | `0040`, `0043`, `0045` applied 2026-09-25 01:40:48–49 UTC; D1 now at `0045` |
| Gateway version | `d69bd158-3d1b-4a67-a359-f561ebbd0908`; rollback target `bda73930-8240-47d1-95ba-b206b67a5362` |
| Watchdog version | `3018f5fd-7f5f-4192-9c23-496718aedbef`; rollback target `c940f9b7-99cf-4194-8f41-489038a34139` |
| Acceptance | Both `/health` endpoints returned 200; Telegram `/status`, `/queue`, `/digest` and a normal message answered |

## In flight, and what each one would change here

Eight PRs are open at this regeneration. [QUEUE](QUEUE.md) carries their observed
heads, verdicts and next owners; merged PRs have left it.

| PR | What it would change |
|---|---|
| [#174](https://github.com/stremysid/jarvis/pull/174) | Owner channel parity and guest-call privacy fix; `codex/channel-parity`, migration `0044`; round-5 integration review approved at `0e458a6`, F1 (voice refusal named `/decisions`) fixed in `d9738d6`, and head `ca14f01` reviewed PASS. A Claude-authored merge of main `2e12b3b` (#179, #180, #183, #188, #191) followed and needs a DeepSeek audit before merge |
| [#168](https://github.com/stremysid/jarvis/pull/168) | Owner reminders, head `d214216`, conflicting against main; needs its builder/renumbering round after #174; #166 has merged |
| [#179](https://github.com/stremysid/jarvis/pull/179) | This docs refresh, now round 5: Claude-authored fixes for the round-4 review at `34b4c78`; needs a non-Claude (DeepSeek) audit of the round-5 delta before merge |
| [#180](https://github.com/stremysid/jarvis/pull/180) | Test lows, reviewed and cleared: ready to merge at `ac8d75b` after a main merge at `68675ba`, 0 High/Medium/Low on round 1, 7/7 mutants killed. Earlier CI failed the local-agent (ubuntu-latest) real-socket 0.1 s retry-wait race and the hermes-runtime (windows) `canonical-closure-review3.test.mjs:51` default 5 s timeout; both unrelated to #180 and now addressed by #185 |
| [#183](https://github.com/stremysid/jarvis/pull/183) | Redaction gaps at `a27a688`; round 2 is **ready to merge** — 0 blocking, 3 follow-ups, 3 nits, 26/28 mutants killed, CI 9/9 green |
| [#184](https://github.com/stremysid/jarvis/pull/184) | Call-session fixes at `a035630`; round-1 review requested changes |
| [#185](https://github.com/stremysid/jarvis/pull/185) | CI flake bounds at `8822708`: the local-agent real-socket retry test and the hermes-runtime per-test timeout. Independent review requested a small fix: two Hermes timeouts are still shorter than the child deadline they wrap |
| [#122](https://github.com/stremysid/jarvis/pull/122) | Memory redesign spec; reviewer-parked until #174 merges, then refreshed, reviewed and merged. Not awaiting Sid |

#178 merged as `4f5758b`; #166 merged as `f5ba9a8` at 20:14 UTC on 2026-09-24.
#177 merged as `5548c38`; #182 merged as `a20f055` at 21:14 UTC on 2026-09-24.
#181 merged as `68675ba` at 21:32 UTC on 2026-09-24. #189 merged as `a7cd355` at 00:34 UTC on
2026-09-25: tool cap 16 → 64 (Telegram had 18 tools, so every owner turn failed). All are deployed.

## Where the project actually stands

| Phase | Verdict | Remaining boundary |
|---|---|---|
| 1 The nervous system | **shared owner brain in code (#174, not deployed); transcript continuity partial** | Channel-parity shares the owner tool catalogue (24 with #198: #174's 18, #195's two web tools, #168's three reminder tools and `history_search`), pipeline construction, core prompt, honesty checks and canonical retrieval. Telegram Worker and voice CallSession remain transport adapters with separate conversations. With #198, Jarvis's call replies are in recent context and searchable D1/R2 literal history on both channels; the rest of `CHANNEL-CONTINUITY-TRANSCRIPT` is in QUEUE. No shared conversation DO, SMS path or Queues |
| 2 Memory | **shared code paths (#174, not deployed); rollout unverified** | Both channels now retrieve canonical `memory_items`, projected facts and bounded D1/R2 owner history through the same reader. Same-call replies retain durable target references, while model-inferred promotion requires the shared tap. Deployed `a7cd355` predates this: voice there still recalls `memory_fact_projection_*`, recorded empty on 2026-09-21. Hidden-text receipts remain a defect |
| 3 School | **paste and calendar deployed; guided assignment and D2L collector/receiver merged, rollout pending** | #164 (Telegram assignment pastes) and #165 (private calendar feed) are deployed in `0d69556`; owner acceptance of both is in OWNER-ACTIONS. #172 guided assignments, #169/#170 the receiver/extension, #175/#176/#178 two-board evidence and date labels, and #166 owner-reported deadlines (no migration) are on main, pending tonight's deploy of `68675ba` with migrations `0040`, `0043` and `0045`. The extension compatibility hold and host-failure emission still need a follow-up. Live two-board acceptance remains pending; the old D2L email route yields no deadlines |
| 4 Control | **built and deployed for taps; policy remains table-driven** | #159's single-use ten-minute taps and migration `0039` are applied in production (orchestrator-observed). On main, #182 is not deployed: confirmations bind tool name, capability and argument hash, and a changed second autonomy outcome is denied. T1/T2 guards remain in QUEUE. [#199](https://github.com/stremysid/jarvis/pull/199) (not merged, migration `0051`) makes tier 3 exactly Sid's five actions; no tool the agent dispatches today is among them. Pending pre-deploy confirmations need a fresh tap; see [the compatibility note](../KNOWN_ISSUES.md#tier-3-confirmations-issued-before-tool-binding-2026-09-24) |
| 5 Calling | **calls owner-reported working; streaming merged, acceptance incomplete; full owner catalogue in code via #174** | Sid, 2026-09-24: "ive already done test calling and it works". #147 memory tools are deployed; #171 streaming and #172 guided tools are on main. That owner report does not establish #171 live streaming/receipt/latency checks or the full voice release gate. #174 gives voice the same tools as Telegram (18 then; 24 with #198: #174's 18, #195's two web tools, #168's three reminder tools and `history_search`), including school, university and study; migration `0044_owner_channel_parity.sql` widens 19 existing pipeline owner-turn triggers without removing their other checks. A call sends model-inferred memory confirmation to the shared Telegram decision queue. With [#196](https://github.com/stremysid/jarvis/pull/196), a tier-3 action on a call is confirmed by Sid's spoken or keyed 4-digit PIN at that moment (a Telegram tap already given for the same action still counts); until the `OWNER_ACTION_PIN` secret is set, the call falls back to asking for the tap in `/queue`. [#199](https://github.com/stremysid/jarvis/pull/199) (not merged) narrows tier 3 to exactly Sid's five actions with migration `0051`; until it is applied, revoking a school collector still asks. No live call or rollout of #174 |
| 6 Daily rhythm | **cron only** | Four cron triggers; owner reminders await #168. Jarvis cannot schedule its own wake-ups or choose the digest time |
| 7 Plumbing | **mostly built** | Backup, archive and watchdog code are present; heartbeat was observed working. No external watchdog recorded; vault sync stops at 64 notes. #145 adds Windows `serve`, #157 sync/store recovery; device acceptance remains in OWNER-ACTIONS |

Measured against [the roadmap](plan/2026-09-19-jarvis-roadmap.md).

## Owner channel parity

Sid, 2026-09-23: **"THE ONLY difference between call and telegram is the method of communication, THAT'S IT."** In code (#174, not deployed), both channels share one `OWNER_TOOL_DEFINITIONS` catalogue (24 with #198: #174's 18, #195's two web tools, #168's three reminder tools and `history_search`), `OwnerAgentCore`, one prompt core, one claim policy, the same canonical recall and the same Telegram tap for inferred memory and tier 3; guests get no owner profile, framing or tools.
Only phrasing, voice's retrieval deadline and the `/queue` pointer differ. With #198, what Jarvis said on a call reaches the next call or Telegram turn's recent context and `history_search`; meaning history holds only Sid's own words on either channel. What remains of `CHANNEL-CONTINUITY-TRANSCRIPT` is in QUEUE.
Deployed `a7cd355` predates it: voice there lacks the school, university and study pipelines and recalls the local-agent projection.
[Full audit, premise corrections and evidence](reviews/2026-09-23-channel-parity.md).

## Production

**Orchestrator-observed checks, 2026-09-24 at 18:44–19:07 EDT (22:44–23:07 UTC), read-only
through the Cloudflare and production-D1 APIs.** This builder re-verified what repository
history can show, and did not query production; see [FACTS](FACTS.md) for provenance.

- **Source `0d69556` (#165).** Sid's own `C:\javis` checkout sits at that revision.
- **D1 `0039_tool_confirmation_consumptions.sql` applied at `2026-09-24 03:46:58 UTC`**, so the old "no migrations applied; D1 stays at `0038`" is wrong.
- **Worker `modified_on` `2026-09-24T03:47:07Z`.** Its **version id is unverified**; an earlier note says `cdc45f1d-fb42-47f9-b979-a081cc4bc272`, unchecked against the account.
- **In `0d69556`:** #133, #137, #144, #146, #147, #149, #154, #155, #156, #159, #163, #164, #165, #167 — each confirmed with `git merge-base --is-ancestor <commit> 0d69556` (exit 0).
- **Not deployed:** every merge after it — #157, #158, #161, #162, #169, #170, #171, #172, #173, #175, #176, #178, #166, #177, #182, #181 (each fails that test; all are in `68675ba`).
- **The 2026-09-23 pre-deploy restore bookmark is not confirmed for this deploy**; do not present it as current.

**Older observations from #143's production query at 23:20 UTC on 2026-09-21, not refreshed:**
- Watchdog `c940f9b7-99cf-4194-8f41-489038a34139`.
- **The gateway heartbeat records.** `component_liveness` holds `cloud-gateway` at
  `2026-09-21T23:20:05Z`.
- **Memory: 5 items, all `proposed`, 0 `active`**, and 0 rows in `memory_fact_projection_facts`.
  The 4 owner Telegram turns since the promotion fix were distilled and produced **no items**;
  the newest item is from 2026-09-17. The projection is what a phone call reads, so it is empty.
- **Calls:** 6 inbound owner calls, all 2026-09-17; no outbound call ever.
- **School email:** `d2l_email_messages` is empty.

Neither the deploy nor the health check refreshes these older database observations.

## Pending rollout

Production D1 is at `0045` (Sid's report); `0040`, `0043` and `0045` were applied at the
deploy. `0036`, `0037`, `0041`, `0042` are absent; `0044`, `0047`, `0048`, `0049`, `0050` (#168) and `0052` (#190, renumbered from `0046`, merged as `f43fcf42`) are merged on main; open
#199 holds `0051` (checked 2026-09-25). Renumbering older `0041`/`0042` above main's maximum
was approved and #168 landed its reminders migration as `0050`. That does not authorize applying any of them.

The 2026-09-24 scratch rehearsal is **orchestrator-reported PASS**, including `0044` after
`0045`; the Claude orchestrator ran it, and the results are transcribed from its harness
summary rather than independently re-run. [Record and limits](reviews/2026-09-24-scratch-d1-rehearsal.md).
Sid applied `0040`, `0043` and `0045` and deployed `a7cd355` on 2026-09-24 at about 9:41 PM EDT;
the merge freeze is lifted. See [Deploy results](#deploy-results-2026-09-24-evening).

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

1. **Guest-call privacy leak — live on main and in the recorded production revision.**
   `OwnerAgentCore.streamCaptured` reads the configured owner's pinned core profile
   before any tool-authority check, builds the owner-framed system prompt, and sends
   the owner tool catalogue supplied by the voice adapter. A guest conversation
   therefore carries Sid's pinned facts, owner framing and owner catalogue to the
   model; the later tool refusal does not protect that prompt. Fixed only when
   [#174](https://github.com/stremysid/jarvis/pull/174) merges and deploys. Traced in
   `apps/cloud-gateway/src/agent/owner-agent-core.ts` and `voice/voice-agent.ts`; no live guest test was run.
2. **Memory explain/forget/restore receipts can reintroduce withheld text.** The
   shared core combines sanitized service receipts with separately read text.
3. **Remaining redaction gaps:** bare/spoken-word PIN and phone/passphrase coverage
   remain open. #149's credential-word digit fix is deployed; newer #171 quoted and
   header redaction changes await deployment. [Known limits](../KNOWN_ISSUES.md). **Superseded toward Sid by `codex/no-redaction-toward-sid` (PR pending, not merged or deployed):** Sid decided on 2026-09-24 that nothing is hidden from him, so these rules now apply only to readers who are not Sid (guest calls, audit and callback telemetry); toward Sid only machine credentials are removed. `codex/redaction-gaps` ([#183](https://github.com/stremysid/jarvis/pull/183)) fixes the assignment, phone-format and newline-bearer gaps in both runtimes; deployment remains pending. **Bare four-digit numbers deliberately survive**, as Sid's brief requires: a year or quantity is not proof of a PIN. See the [measured coverage and limits](reviews/2026-09-24-redaction-gaps.md).

#144's suppression anti-join fix is deployed; #146 keeps its shared predicate and parity
guards. It is no longer an open work item.

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

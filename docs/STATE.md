# State

What is true right now. **Short on purpose, and regenerated rather than appended.**

One rule governs every line below: **nothing here states a revision as current.** A fact that
depends on a revision carries the command that prints it, or a date and the session that
observed it. If this file disagrees with a longer document, this file is right and the
longer document is stale — say so in the pull request that fixes it.

Last regenerated: 2026-09-25, evening (EDT), from `git log`, `gh pr list`/`gh pr view` on every
open and recently merged pull request, and the orchestrator's read-only production checks. For
the repository revision, run `git log --oneline origin/main -1`.

## Deploy status: no deploy since 2026-09-24, ~9:41 PM EDT

Sid deployed `a7cd3553` (#189) with D1 at `0045` that night; see
[deploy results](OWNER-ACTIONS.md#deploy-results-2026-09-24-evening). **Nothing has been deployed since.**
Production still runs `a7cd3553`/D1 `0045` — orchestrator-reported, 2026-09-25 ~7:22 PM EDT,
read-only through the Cloudflare/D1 APIs; this builder did not query production. Everything
below `main`'s current head, `39b70d61` (#201), that is not an ancestor of `a7cd3553` is
**merged but not running**.

The repository **became public on 2026-09-25**; GitHub Actions runs free on standard runners
for a public repo. [DeepWiki](https://deepwiki.com/stremysid/jarvis) indexed it (checked
2026-09-25 evening): its 11-section page tree is a snapshot, not live.

## Merged since the deploy, none of it running

30 PRs merged between `a7cd3553` (9:41 PM EDT 24th) and `39b70d61` (#201, 8:48 PM EDT 25th).
By what they'd change once deployed:

| Area | PRs | What changes |
|---|---|---|
| Channel parity | [#174](https://github.com/stremysid/jarvis/pull/174) | Owner tool catalogue, prompt and recall shared by Telegram and calls; migration `0044`. Fixes the guest-call privacy leak below |
| Multi-step tools | [#200](https://github.com/stremysid/jarvis/pull/200) | Jarvis takes several tool steps in one turn (search, read, record) instead of one call per turn; deletes the code-side reply-reference cap (register row 14) |
| Deadlines | [#193](https://github.com/stremysid/jarvis/pull/193), [#201](https://github.com/stremysid/jarvis/pull/201) | Deletes the date/status parsing grammar and, separately, effort/lead-time/exam-window code; the model decides the due date and when to warn, through `reminder_schedule`/`reminder_list`. Migration `0053` |
| School judgment | [#204](https://github.com/stremysid/jarvis/pull/204) | Deletes the worked-explanation and university-execution-request grammars (register rows 11, 12); row 10 (missed-work inference) explicitly not removed, see [CODE-VS-JUDGMENT](CODE-VS-JUDGMENT.md#row-10-persisted-inference-still-in-code-not-removed) |
| Redaction scope | [#197](https://github.com/stremysid/jarvis/pull/197) | Toward Sid, only machine-credential shapes are redacted; the word-list rules now apply only to guest/audit/telemetry readers |
| Call PIN | [#196](https://github.com/stremysid/jarvis/pull/196) | Replaces the per-call passphrase gate with a spoken/keyed 4-digit PIN, asked only at one of Sid's five actions; migration `0047` |
| Web tools | [#195](https://github.com/stremysid/jarvis/pull/195) | `web_read`/`web_search` tools, tier `read.web`; migration `0049` |
| history_search | [#198](https://github.com/stremysid/jarvis/pull/198) | Both channels can search literal D1/R2 history, including past call replies still in D1; no migration |
| Email inbox | [#190](https://github.com/stremysid/jarvis/pull/190) | Owner inbox tool; migration `0052` |
| Reminders | [#168](https://github.com/stremysid/jarvis/pull/168) | `reminder_schedule`/`reminder_list`/cancel tools with fenced delivery; migration `0050` |
| Tier-3 scope | [#199](https://github.com/stremysid/jarvis/pull/199) | Tier 3 becomes exactly Sid's five actions; migration `0051` |
| Note-source trigger | [#194](https://github.com/stremysid/jarvis/pull/194) | Drops the Markdown-citation clause from the insert guard; migration `0048` |
| Other merged fixes | [#179](https://github.com/stremysid/jarvis/pull/179), [#180](https://github.com/stremysid/jarvis/pull/180), [#188](https://github.com/stremysid/jarvis/pull/188), [#183](https://github.com/stremysid/jarvis/pull/183), [#191](https://github.com/stremysid/jarvis/pull/191), [#184](https://github.com/stremysid/jarvis/pull/184) | Docs, hermes path fix, redaction gaps (guest/telemetry), D2L extension compatibility, call-session overlap/barge-in fixes |
| Docs/CI only | [#202](https://github.com/stremysid/jarvis/pull/202), [#203](https://github.com/stremysid/jarvis/pull/203), [#205](https://github.com/stremysid/jarvis/pull/205), [#208](https://github.com/stremysid/jarvis/pull/208), [#211](https://github.com/stremysid/jarvis/pull/211) | Scratch-rehearsal record, the judgment-blocks-merge rule, command docs, two Hermes CI timeout fixes |

## Open pull requests

| PR | State | What it would do |
|---|---|---|
| [#206](https://github.com/stremysid/jarvis/pull/206) memory judgment | open, built on `679d2b95` | Removes register rows 6–9, 13 (refile rotation, silent lifetime default, silent text-match merge, restored-basis change, multi-forget tap) |
| [#207](https://github.com/stremysid/jarvis/pull/207) calls judgment | open | Removes `parseOwnerAccessIntent` and `PERMISSION_CAPABILITIES` (rows 1, 3, 4, 5); the model calls an `owner_access` tool |
| [#209](https://github.com/stremysid/jarvis/pull/209) projects judgment | open | Rewrites the stalled-project detector as a facts reader; deletes `assessStaleness`/`detectStalledProjects` and their verdict fields |
| [#212](https://github.com/stremysid/jarvis/pull/212) study coach judgment | open | Deletes the practice/preference/observation phrase parsers in `study-coach-model.ts`; the model declares the operation |
| [#213](https://github.com/stremysid/jarvis/pull/213) university judgment | open | Deletes the status-word grammars (B116–B129); the model declares status plus the owner's message as evidence |
| [#210](https://github.com/stremysid/jarvis/pull/210) CI offload | open | Adds `workflow_dispatch` jobs for mutation sweeps and focused tests, so they run on Actions instead of Sid's PC |
| [#192](https://github.com/stremysid/jarvis/pull/192) filler-words docs | open | Docs-only; the finding is already in [KNOWN_ISSUES](../KNOWN_ISSUES.md#call-transcripts-are-not-verbatim-deepgram-strips-um-and-uh-2026-09-24) |
| [#187](https://github.com/stremysid/jarvis/pull/187) principles rewrite | open, may overlap #203/#205 | Predates this evening's docs merges; recheck before acting on it |
| [#185](https://github.com/stremysid/jarvis/pull/185) CI flake bounds | open | Two CI timing-race fixes (local-agent retry wait, Hermes per-test timeout); the two Hermes fixes above (#208, #211) may already cover part of this |
| [#122](https://github.com/stremysid/jarvis/pull/122) memory redesign spec | reviewer-parked | Docs only; parked pending #174's rollout, which has now merged but not deployed |

Full history, next actions and blockers for each are in [QUEUE](QUEUE.md).

## Where the project actually stands

| Phase | Verdict | Remaining boundary |
|---|---|---|
| 1 Nervous system | **shared owner core merged (#174), not deployed; multi-step tool loop merged (#200), not deployed** | Once deployed, both channels share the tool catalogue, prompt core and `history_search` (#198). Production still runs the pre-#174 single-tool-per-turn code |
| 2 Memory | **shared retrieval code merged, not deployed; judgment removal in progress (#206 open)** | Deployed code still reads the empty local-agent projection on calls. Rows 6–9, 13 removal is open, not merged |
| 3 School | **judgment removal partial (#204 merged, row 10 kept by design); deadlines now model-scheduled (#193, #201)** | Missed-work inference (row 10) stays in a model-less cron job pending a model-write tool and migration; see [CODE-VS-JUDGMENT](CODE-VS-JUDGMENT.md#row-10-persisted-inference-still-in-code-not-removed) |
| 4 Control | **tier-3 narrowed to Sid's five actions on main (#199, migration `0051`), not deployed** | Until deployed, production still asks for taps outside the five. Known gaps outside the registry are in [KNOWN_ISSUES](../KNOWN_ISSUES.md#confirmations-outside-sids-five-that-migration-0051-does-not-remove-2026-09-25) |
| 5 Calling | **spoken PIN gate merged (#196), not deployed; owner catalogue parity merged (#174), not deployed** | Production still runs the per-call passphrase gate `0d69556` predates. No live PIN or streaming acceptance run this session |
| 6 Daily rhythm | **reminders merged (#168), not deployed** | Model schedules its own warnings through `reminder_schedule`; cron still fixed |
| 7 Plumbing | **CI offload for mutation/focused tests proposed (#210, open)**, otherwise unchanged | Watchdog, backup, D2L collector unchanged this evening |

Measured against [the roadmap](plan/2026-09-19-jarvis-roadmap.md).

## Production

**Orchestrator-observed, read-only, 2026-09-25 ~7:22 PM EDT, through the Cloudflare/D1 APIs;
this builder did not query production directly.** Source `a7cd3553` (#189), D1 at `0045`.
Older counts below (memory items, calls, school email) are the 2026-09-21/24 observations
carried forward in [FACTS](FACTS.md); they were not refreshed tonight.

## Pending migrations, and what was rehearsed

Present on `main`, absent from production `0045`: `0044`, `0047`, `0048`, `0049`, `0050`,
`0051`, `0052`, `0053`, `0054`. (`0036`, `0037`, `0041`, `0042`, `0046` were renumbered away
and never exist.) The [2026-09-25 scratch rehearsal](reviews/2026-09-25-scratch-d1-rehearsal.md)
(#202, orchestrator-run, 4:19–4:30 PM EDT) applied `0044` and `0047`–`0052` cleanly against a
verified copy of production, with and without `0051`. **`0053` and `0054` (#201, merged
8:48 PM EDT, after the rehearsal) were not part of it and have never been rehearsed.**

## The gates, and whether they can be trusted

| Gate | State |
|---|---|
| CI | Query the head's own run before clearing it. `39b70d61` (#201, current `main`) had CI running at regeneration time; #205's run failed, later heads passed |
| Workspace tests | No suite rerun by this builder |
| Gateway `typecheck:tests` | Still red and outside CI; no new count this round |
| Voice release chain | Unchanged: built, not wired into a workflow, no live acceptance |

## Live defects

1. **Guest-call privacy leak — fixed on `main` by #174, still live in production**, because
   nothing has deployed since 9:41 PM EDT on the 24th. Same code and file references as before.
2. **Memory explain/forget/restore receipts can reintroduce withheld text** — unchanged.
3. **Redaction toward Sid is no longer a defect, by design** (#197, merged, not deployed):
   toward Sid only machine-credential shapes are removed. Toward guests, audit and telemetry,
   the word-list rules from #183 still apply and remain gapped per
   [KNOWN_ISSUES](../KNOWN_ISSUES.md).

## Where things live

| Question | File |
|---|---|
| What is in flight, and who acts next? | [QUEUE.md](QUEUE.md) |
| What can only Sid do? | [OWNER-ACTIONS.md](OWNER-ACTIONS.md) |
| What durable facts are recorded? | [FACTS.md](FACTS.md) |
| Why is it built this way? | [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](../DECISIONS.md) |
| What is broken or unproven? | [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) |
| What code-side judgments are queued for removal? | [CODE-VS-JUDGMENT.md](CODE-VS-JUDGMENT.md) |
| What stopped working and why? | [AGENT_LOG.md](AGENT_LOG.md) — search it, do not read it |
| Who builds and reviews? | [BUILDING.md](BUILDING.md) |

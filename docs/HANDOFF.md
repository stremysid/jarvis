# Handoff

Current as of **2026-09-13**. Verify the current branch and checks before
using this checkpoint. R0 passed; calling remains R1.

## R1 is active; the node platform decision remains on hold

R0 passed on 2026-09-11. R1 depends on R0 and is entirely cloud-side.
PR #23 implements item 2's fake calling/access matrix and confirmed Telegram
`/call`, with local Windows validation and mutation evidence recorded in the
PR. The production Worker still answers that calling is not configured.
The real release runner passes its local prerequisites and then refuses the
missing live evidence. It never places a call itself.

Claude Opus 5 max requested changes on PR #23 at `d6c5fc2`; the builder's
response and mutation evidence are in AGENT_LOG. A new max review is required.
Item 1's real Worker/runtime composition is in draft PR #25, based on #23;
its default production stub/socket proof remains outstanding. Twilio configuration,
live calls and redacted live evidence remain owner operations. Items 3 and 4
still cover the live smoke and legacy eight-digit verifier deletion. None
of those are satisfied by the fake matrix or same-vendor advisory review.

Sid's PCs run Windows 11 and his phone is an iPhone 16. There is no Linux
host, server or VPS; the home PC is off overnight. No Windows node port or
further Linux implementation is authorized until he chooses a direction.
R2 item 4 is parked. Preserve the actual requirement: memory must work with
every PC off, whatever implementation Sid selects. PR #22 records the
platform correction; the old roadmap attribution is not owner approval.

PR #16 at `27b232f` has completed the reviewer's requested changes. The
reviewer independently verified migration byte identity, all five trigger
mutations, 2,146 workspace tests and 807 Linux local-agent tests. Sid's
2026-09-13 Windows runs subsequently reported 789 local-agent passes / 32
skips, 2 deployment-script passes, and 33 byte-exact files unchanged by
checkout. Hermes has three known failures on his Store/MSIX PowerShell
layout; that independent R3 issue does not block #16 and is not fixed here.
These are owner/reviewer reports, not reruns by this builder. No further
implementation is requested on #16.

GitHub Actions has used 2,000/2,000 minutes with a $0 budget and stop-usage
enabled, resetting 2026-10-01. Sid will not raise it. Run suites locally
and record the results in each PR; do not retry Actions, disable jobs or
restructure CI to bypass the quota. CI path filtering can be considered
when CI is next intentionally changed; it is not part of this work.

## R2 item 2 candidate

PR #12 is merged at `7414ab1`. Its Linux device-key implementation is the
base for [PR #13](https://github.com/ksid1229-ops/jarvis/pull/13),
`codex/r2-unix-node`, which continues the Unix control socket and foreground
`jarvis node` bootstrap. Transport code was pushed early after local checks;
Ubuntu CI passed 525 Python tests (14 skipped) at transport checkpoint
`1ce74d1`. This is evidence for that checkpoint, not a claim about the final
bootstrap or the provisioned server. See PR #13 for current-head validation.

Review at `996e6ec` confirmed two merge-blocking client lifecycle defects:
completed snapshot reuse on later cycles, and pending ACKs that could not be
sent by a reconstructed client. Core fixes stage snapshot identity with the
events and cursor and validate the ACK receipt before clearing it. Boundary
tests cover terminal, empty and nonterminal pages across cycles and a disk
archive reopened with a new signed client. Expired ACK recovery now retries
the original ACK first, refetches exactly its range on refusal, compares every
archived field, and commits replacement metadata before sending the new ACK.
The cursor and events remain unchanged, and stop checks preserve a pending ACK
between requests. A direct HTTP-client regression also makes two pulls without
an intervening ACK and checks that a completed nonempty page's token is absent
from the second request. Replacing the `has_more` guard with `True` fails that
wire assertion. Python validation is 557 passed / 20 Windows platform skips,
with Ruff and win32 mypy clean. Current-head CI and review remain required.

GPT-5.6 Sol xhigh builds this item; the final fixes need Claude Opus 5 xhigh
review. Sid retains merging and the live systemd check. Item 3 is isolated in
[draft PR #16](https://github.com/ksid1229-ops/jarvis/pull/16), including its
D1 migration and version-order regression. No production operation was run.
R0's observed exit evidence below remains valid and R1 remains open.

## Earlier R0 branch and review

[PR #6](https://github.com/ksid1229-ops/jarvis/pull/6) was reviewed by Claude
Opus 5 high at `fab6d25`, retargeted to main, and merged by Sid as
`ffa3ecd`. [PR #7](https://github.com/ksid1229-ops/jarvis/pull/7) recorded the
deployment and merged as `2b506c8`. Its documentation retained some older
draft/review/deployment holds; this checkpoint removes those contradictions.
The current follow-up branch is `codex/r0-live-acceptance-checkpoint`, based
on `2b506c8`. The active checkout remains the Codex task's `work/jarvis`.
The builder must not merge or repeat the owner's deployment.

Codex completed the cross-vendor review of Claude's PR #5 escalation:
**no merge blocker**. See the [immutable-head review](reviews/r0-pr5-edac272.md)
for security, temp-path equivalence, cleanup-handle evidence and the exact
uv interpreter pin. CI run 34553801860 was observed green on that head:
seven jobs, Hermes 108, workspace 1,935, watchdog 113. Manual extended
Hermes suites remain unrun. These results supersede the old CI blocker.

## R0 items 6 and 7 implementation

- Gateway GET `/health` now calls the existing coarse liveness handler;
  HEAD is bodyless. An independent existing limiter supplies 30 probes per
  minute per isolate. No private readiness snapshot or D1 read is exposed.
- Watchdog `WATCHDOG_REQUIRED_COMPONENTS` defaults to `cloud-gateway`.
  Missing rows enter the existing alert/recovery flow without invented
  heartbeats. Invalid lists fail configuration health. Required names outside
  a bounded component page are looked up before being declared missing.
- The existing hourly `poll` job calls the existing archival service for
  one bounded segment before optional GitHub work. It runs without GitHub
  configuration. Retention, verified readback, sealing and purge checks stay
  in that service. An upload failure fails the hourly run.
- [The deployment runbook](runbooks/deploy.md) includes the separate numbered
  UptimeRobot owner actions: HTTPS GET on the watchdog URL, every five
  minutes, non-200 alerts to Sid's verified notification destination.

No new service, cron expression, schema, runtime pin, security bypass, or
gateway import in the watchdog was added. The three old unrelated-route
tests retain their 501 assertions on an unknown path; explicit health-route
tests now cover the intended change.

## Validation and next gate

Lint and source typechecking pass. Workspace 1,942/1,942 (107 files) and
watchdog 119/119 (8 files) pass. Both named deployment scripts completed
local Wrangler dry-runs successfully; neither published. Mutation checks
remove the health route, archival call and
must-report argument in turn: 3, 3 and 2 tests fail respectively. All
mutations are restored. Follow-up CI is tracked in
[PR #6 checks](https://github.com/ksid1229-ops/jarvis/pull/6/checks); verify
the newest head there. PR #5's green run is not evidence for this branch.
The gateway test-type command reports **122**
errors on both this branch and an isolated checkout of `edac272`, with
none in the changed files. The earlier 117 count is stale.

Claude's PR #6 review independently reproduced both suites and all three
mutation results and found no merge blocker. That code review gate is
complete. Current main `2b506c8` has
[green CI, all seven jobs](https://github.com/ksid1229-ops/jarvis/actions/runs/34564221873).
Non-blocking notes about the hourly claim, non-empty must-report list,
absent-row suppression and bounded fallback reads do not call for new R0
services or a change to the reviewed code.

## R0 item 5 is done: both Workers are deployed

**2026-09-11.** Sid merged PR #5 and PR #6. CI on `main` at `ffa3ecd` is
green across all seven jobs -- the first green `main` since 2026-09-02.

Migrations `0008`-`0013` were applied to the production `jarvis` database at
04:39 UTC and verified by querying `d1_migrations` directly. `0001`-`0007`
were already applied on 2026-09-02; there was no partial or unexpected
state. Every one of the six is purely additive, so no existing row was at
risk.

Initial publication from the reviewed commit (historical version IDs):

| Worker | Version | Triggers |
|---|---|---|
| `jarvis-cloud-gateway` | `daffbf21-9310-41c5-8cfe-14a5dac606ff` | `*/5 * * * *`, `0 * * * *`, and the two daily pairs |
| `jarvis-watchdog` | `a6c743df-02c0-44f0-96c9-3e9da50e01f4` | `*/5 * * * *` |

Gateway liveness was verified against the live deployment: `GET /health`
returns 200 `ok`, `HEAD` returns 200, and any other method returns 405. It
returned 501 before this deployment.

Watchdog liveness returned 503 `no_cycle_recorded` immediately after
deployment, which is correct before its first cron. That response also
confirmed `database: bound` and `alertChannel: configured`. The latter
means both settings are present, not that the bot credentials or alert
delivery are valid. PR #7 separately records an observed DOWN alert.

The watchdog has its own Telegram bot, separate from the gateway's, and its
heartbeat secret is set on both Workers.

Read-only follow-up on 2026-09-11 independently verified all six migration
rows at 04:39:26-27 UTC. Current deployment metadata has newer versions:
gateway `72571927-4afb-428f-9b78-defb1392ff26` at 05:06:25 UTC and watchdog
`84231e21-5535-4894-8c92-14bd1b9fc3a5` at 05:06:20 UTC, each at 100%.
Only binding names/presence were inspected, never secret values.

At 05:11 UTC, D1 showed successful gateway drain runs through 05:10 and an
hourly poll at 05:00. The watchdog self-row advanced to 05:10:19.621 UTC,
but there was no `cloud-gateway` liveness row and its 04:55 DOWN alert
remained open. Thus the real cron runs are observed, but gateway heartbeat
delivery is not yet established. Do not dismiss a continuing missing row
as the initial deployment alert, and do not fabricate a heartbeat.

A filtered trace of the real 05:15 gateway cron reported
`sent: false, reason: rejected, detail: status 404` at 05:15:20 UTC.
No request headers, bodies or credential values were retained. An external
unauthenticated POST to the correct public `/heartbeat` endpoint returned
401 at 05:19:30 UTC. This does **not** establish a shared-secret mismatch:
the configured request receives a different status. Worker secrets cannot
be read back. Two URL re-sets, one interactive and one piped, changed
nothing -- because the stored value was never the variable. The cause was
Worker-to-Worker fetch routing; see KNOWN_ISSUES.md. No attempted production
fix was made here.

Independent HTTP checks at 05:16 UTC found gateway `/health` 200 and watchdog
`/health` 200 with no reasons and a 05:15:19 UTC self-cycle. The watchdog URL
is `https://jarvis-watchdog.twilight-tree-70b1.workers.dev/health`.
Sid additionally reports a clean hourly archival run at 05:00:19 UTC and
watchdog alert delivery counts of one sent, zero undelivered, zero faults.
Telegram `/status`, `/queue` and the morning digest are explicitly untested.

The mailbox reports Sid re-set the URL and shared secret. The real 05:30
cron still returned `rejected: status 404` at 05:30:19.944 UTC. Read-only
metadata shows gateway version `fc24520c-e392-4159-bc25-277cd7c17a8a`,
created at 05:24:28 UTC, at 100%, with no compatibility flags or watchdog
service binding. PR #8 now adds `global_fetch_strictly_public` to the
gateway configuration for the existing public HTTP heartbeat path, as
required by Cloudflare's fetch documentation. This affects global fetch
routing, not just this endpoint. No source, secret, auth check or test is
changed. Focused heartbeat/scheduler tests pass 25/25 and the gateway
deployment dry-run passes; neither establishes Cloudflare edge routing.
PR #8 has since passed Claude Opus 5 high review with no merge-blocking
finding. Sid's deployment is still required before a real cron can verify
the fix, and no live recovery is claimed.

## What is still owner-blocked

The **UptimeRobot monitor is not configured.** Until it is, nothing watches
the watchdog. Follow the numbered actions in the runbook, against the
watchdog's `/health`, never the gateway's.

**R0 exit PASSED on 2026-09-11.** All five conditions observed by Sid, with
the evidence below. R1 is unblocked.

| Condition | Evidence | UTC |
|---|---|---|
| CI green on `main` | `577c6a0`, seven jobs | 13:13 |
| A real cron firing and being recorded | `drain` every five minutes, `poll` hourly, `failure` NULL throughout | through 13:15 |
| The scheduled morning digest saying "nothing due" | `scheduled_runs` row `digest` / `2026-09-11`, started and finished 11:30:40, `failure` NULL; delivered to Telegram as "Digest -- 2026-09-11 / Nothing due, nothing changed, nothing waiting on you." | 11:30:40 |
| Telegram `/status` replies | "Autonomy: shadow since 2026-09-02 (reporting, not acting)" with `drain: ok at 13:15`, `poll: ok at 13:00`, `digest: ok at 11:30` | 13:16 |
| Telegram `/queue` replies | "Nothing waiting on you." — the empty-queue answer, not a failure | 13:17 |

The digest is the load-bearing one: it fired on its own schedule at the
America/Toronto 07:30 boundary with no `DIGEST_TIMEZONE` override, and a
manually invoked digest would not have proved that. `/status` independently
reported the same 11:30 digest time that D1 holds, so two paths agree.

An unknown command (`/staus`) answered "No such command." and listed the
seven real ones, which was not required evidence but is worth recording.

Gateway heartbeat delivery was removed from this list by Sid on 2026-09-11;
see the scope note below.

Sid authorizes building through roadmap items without individual approvals.
Merging, production operations, secrets and the consequential actions in
DECISIONS.md remain owner actions. The stop rules and cross-vendor review
remain mandatory. R0 has passed, so build R1 and obtain Claude Opus 5 **max**
review for its v1.0 release gate.

**Scope: the heartbeat is off R0's exit test, by Sid's own decision.** The
GPT-6 Codex session was right to refuse a weaker gate on a reviewer's say-so
and to ask for owner clarification; it has it. At about 06:00 UTC on
2026-09-11 Sid said, of the heartbeat, "just drop it for now, we finish
jarvis and then fix it at the end", after an hour of hands-on diagnosis had
produced no recovery. He also pushed back on the watchdog being treated as
R0 scope at all: it was inherited work ratified into the milestone by a
reviewer, not something he asked for. So R0's exit test is the amended list
above, and neither the heartbeat nor the UptimeRobot monitor blocks starting
R1. This is a narrowing of the milestone, not of any test or security check:
nothing is skipped, disabled or weakened, and the defect stays open and
documented in KNOWN_ISSUES.md until he chooses to close it.

Item 2's rotations remain complete by owner confirmation; do not request
them again. `PIN_VERIFIER_JSON` is absent from config; now that item 5's
gateway deployment has happened, its stored secret may be deleted as a
separate, explicitly confirmed operation. Never request, print or commit a
secret value.

## What is built but not wired

- **Google Classroom ingestion.** The client and the ingestion path exist;
  the hourly job does not call them, because no deployment holds the OAuth
  credentials. `deadline_sources` therefore has nothing writing to it, so the
  deadline half of the digest is empty rather than stale.
- **`project()` in the vault** has no authority gate in front of it. Nothing
  but tests calls it. Do not wire a caller without one.
- **There is no Windows process host.** The existing `jarvis node` starts
  `RunLoop` and `ServiceState`, but refuses to start outside Linux.
  `NamedPipeServer.serve_forever` is still started only by tests; there is no
  `jarvis service` command and no Windows service host. Node platform work
  remains on hold as described above.

## The one thing to read before building on the vault

Vault observations are stored **verbatim, with no redaction**. That is safe
today only because nothing uploads them. Building the cloud sync path before
the redactor would ship the owner's notes to the gateway unredacted, so the
redactor is a prerequisite for that work rather than a follow-up to it.

## Deliberate divergences from the plans

Two, both in [DECISIONS.md](../DECISIONS.md) with reasoning:

- Migration numbering: the Obsidian plan reserves 0008–0011 for vault state;
  those numbers were taken first. Vault D1 migrations take 0014 onward.
- The Obsidian adapter ships in two stages. Stage one (pure Python) is done.
  Stage two is the Rust/PyO3 bridge, and until it lands the adapter meets a
  weaker guarantee than the plan states.

## Session history

Detailed continuity ledgers live outside the repository, under each
assistant's continuity directory (`~/.codex/continuity/tasks/` for Codex),
per the owner's standing preference. They are
not required to understand the code — this file, ARCHITECTURE.md,
KNOWN_ISSUES.md and NEXT_STEPS.md are meant to be sufficient on their own. If
they are not, that is a bug in them.

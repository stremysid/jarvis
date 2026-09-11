# Handoff

Current as of **2026-09-11**. Verify the current branch and checks before
using this checkpoint. R0 is not complete; calling remains R1.

## Current branch and review

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
be read back. First have Sid re-set the URL to the known public `/heartbeat`
URL, then observe the next real cron. If 404 persists, investigate
Worker-to-Worker routing before rotating secrets or changing code; see the
runbook. No attempted production fix was made here.

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
Claude Opus 5 high review and Sid's deployment are required before a real
cron can verify the fix. No live recovery is claimed.

## What is still owner-blocked

The **UptimeRobot monitor is not configured.** Until it is, nothing watches
the watchdog. Follow the numbered actions in the runbook, against the
watchdog's `/health`, never the gateway's.

**R0 exit remains incomplete:** Telegram `/status` and `/queue` replies,
gateway cron heartbeat delivery recorded by the watchdog, and the morning
digest saying "nothing due". CI green on `main` is verified. With no
`DIGEST_TIMEZONE` override in the current gateway bindings, the code's
America/Toronto default targets 07:30 local (11:30 UTC on September 11).
A manually invoked digest would not prove that schedule.

Sid authorizes building through roadmap items without individual approvals.
Merging, production operations, secrets and the consequential actions in
DECISIONS.md remain owner actions. The stop rules and cross-vendor review
remain mandatory. After R0 passes, build R1 and obtain Claude Opus 5 **max**
review for its v1.0 release gate; do not begin it on these incomplete results.

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
- **The local agent has no process bootstrap.** `RunLoop`, `ServiceState` and
  `NamedPipeServer.serve_forever` are tested and nothing starts them; there
  is no `jarvis service` command and no Windows service host.

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

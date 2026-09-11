# Handoff

Current as of **2026-09-11**. Verify the current branch and checks before
using this checkpoint. R0 is not complete; calling remains R1.

## Current branch and review

Work is in [draft PR #6](https://github.com/ksid1229-ops/jarvis/pull/6),
branch `codex/r0-health-hourly-archive`, based on PR #5's exact head
`edac2723fe61fa9e4f623123d9f45f0c18feeee0`. The old `C:/javis` checkout
is not present on this machine; the active checkout is under the current
Codex task's `work/jarvis` directory. No main push or merge is authorized.

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

The new implementation needs **Claude Opus 5 at high effort** for the
BUILDING.md cross-vendor gate. Our review of Claude's PR #5 does not approve
our subsequent implementation. Sid merges PR #5 and this follow-up.

## R0 item 5 is done: both Workers are deployed

**2026-09-11.** Sid merged PR #5 and PR #6. CI on `main` at `ffa3ecd` is
green across all seven jobs -- the first green `main` since 2026-09-02.

Migrations `0008`-`0013` were applied to the production `jarvis` database at
04:39 UTC and verified by querying `d1_migrations` directly. `0001`-`0007`
were already applied on 2026-09-02; there was no partial or unexpected
state. Every one of the six is purely additive, so no existing row was at
risk.

Both Workers are published from the reviewed commit:

| Worker | Version | Triggers |
|---|---|---|
| `jarvis-cloud-gateway` | `daffbf21-9310-41c5-8cfe-14a5dac606ff` | `*/5 * * * *`, `0 * * * *`, and the two daily pairs |
| `jarvis-watchdog` | `a6c743df-02c0-44f0-96c9-3e9da50e01f4` | `*/5 * * * *` |

Gateway liveness was verified against the live deployment: `GET /health`
returns 200 `ok`, `HEAD` returns 200, and any other method returns 405. It
returned 501 before this deployment.

Watchdog liveness returned 503 `no_cycle_recorded` immediately after
deployment, which is correct before its first cron. That response also
confirmed `database: bound` and `alertChannel: configured`, so its own bot
token and chat id are valid.

The watchdog has its own Telegram bot, separate from the gateway's, and its
heartbeat secret is set on both Workers.

## What is still owner-blocked

The **UptimeRobot monitor is not configured.** Until it is, nothing watches
the watchdog. Follow the numbered actions in the runbook, against the
watchdog's `/health`, never the gateway's.

**R0 exit remains unverified by observation:** Telegram `/status` and
`/queue` replies, a real cron recorded by the watchdog, and the morning
digest saying "nothing due". CI green on `main` is the one exit condition
already met.

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

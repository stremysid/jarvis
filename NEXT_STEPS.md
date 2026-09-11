# Next steps

The milestone order, the full feature catalogue and the decisions still
open are in [the roadmap](docs/plan/2026-09-03-jarvis-roadmap.md). This
file is the short list for the current milestone, R0. Planning is finished;
do not start R1 or resume superseded implementation plans.

## R0 checkpoint, 2026-09-06

1. **CI corrections are locally validated and committed in `d9d59f9`.**
   Windows DACL assertions use normalized trustees, temp fixtures resolve
   native canonical paths, and the Linux job typechecks for Windows. The
   two extended Hermes files run in a manual workflow. The fast 8.3
   regression now lives in `temp-path.test.mjs`, included in PR CI and
   sharing the containment fixture builder. Remote CI on this
   change and the full extended suites remain unverified.
2. **Credential rotation is done by owner confirmation.** Wrangler is
   logged in; the three peppers and DeepSeek key were rotated on production
   `jarvis-cloud-gateway`, and the old DeepSeek key was revoked. No values
   were shared. Do not ask for these rotations again.
3. **Configuration cleanup is implemented.** Both gateway required-secret
   lists contain exactly the four non-optional strings in `env.ts`.
   Optional names are documented outside the lists. The two legacy PIN
   generators and stale runtime test binding are removed. Keep the stored
   `PIN_VERIFIER_JSON` secret until after item 5; declaration removal does
   not delete it. The legacy verifier code remains for R1.
4. **Deployment scripts and runbook are implemented locally.** Both
   scripts default to dry-run, preserve an explicit empty production
   environment argument, and gate publishing through confirmation. Native
   argument tests and both real Wrangler dry-runs pass. See the
   [deployment runbook](docs/runbooks/deploy.md).

## Next gate and remaining work

The owner reports **PR #4 approved for items 1, 3 and 4**, with the fast
8.3 regression moved into regular CI as the recommendation. The owner also
reports independent pytest and mypy runs clean. Those are reviewer results;
they were not rerun by the builder during this test-move follow-up.

The test move passes focused and regular-suite execution, but the complete
regular Hermes run is **107 passed, 1 failed**: the unchanged SBOM integrity
test cannot unlink `.hermes-runtime.workflow.lock` (`EBUSY`). No unmerged
fix for that test was found among the available branches. Escalate this
failure to Claude Opus 5 high under BUILDING.md before starting items 6/7.
Remote CI on `8de35e7` also has failures in deployment scripts, Hermes and
workspace; the two local-agent jobs and watchdog pass.

Push the test move to `claude/r0-green-and-deployed` for the reviewer. The
owner will run the item 5 deployment. No push to
`main`, merge, production operation, or completed R0 exit is implied.

5. Inventory and apply pending migrations 0008-0013, configure the R0
   capability settings, deploy the gateway, and deploy the watchdog with
   its own bot and chat. Confirm the exact production operations using the
   runbook. After the gateway deploy, separately confirm deletion of the
   stored legacy PIN secret.
6. Route gateway health, configure the watchdog must-report list, and point
   an external uptime monitor at the watchdog.
7. Add R2 archival to the hourly job.

**R0 exit remains unverified:** CI green on `main`, Telegram `/status` and
`/queue`, a cron followed by its watchdog heartbeat, and the actual morning
digest saying "nothing due". No release is declared.

## Built and unwired

These have code and tests and nothing calls them yet.

- **Google Classroom ingestion.** `classroom-client.ts` and
  `deadline-ingestion.ts` exist; the hourly poll job does not call them,
  because no deployment holds the Google OAuth credentials. Until it does,
  `deadline_sources` has nothing writing to it and the deadline half of the
  digest is empty rather than stale.
- **The Brightspace scrape.** Deliberately not built. It needs a real browser
  session and belongs in the local agent. `RawDeadlineItem` is the interface
  it feeds.
- **Deadline status.** Nothing sets `submitted`, `missed` or `cancelled`. The
  grade and missing-work watch is what closes this.
- **Decision expiry.** `listOpenQueue` filters lapsed items out of the queue,
  and nothing moves their status to `expired`. The drain job should sweep
  them.
- **`project()` in the vault.** The write path has no authority gate in front
  of it. See KNOWN_ISSUES.

## The release gate

**Live calling is R1 and v1.0.** The roadmap records that Sid already owns
the Twilio number and credentials. No live calling evidence exists yet.

## The two-stage Obsidian adapter

Stage one is built -- see DECISIONS.md. The roadmap assigns completion of
the adapter on the home node to R2 and defers the native bridge. Do not
resume the old bridge plan as part of R0.

**The redactor comes first.** Vault observations are stored verbatim with no
redaction, so building the cloud upload path before the redactor would ship
Sid's notes to the gateway unredacted. It is a prerequisite for O2/O3/O4, not
a follow-up.

## Hermes H1

The roadmap supersedes the remaining runtime service work with R3. Keep
the pinning mechanism and do not resume Tasks 10-13 in R0.

## Smaller, worth doing

- Clear the 117 type errors `pnpm --filter @jarvis/cloud-gateway
  typecheck:tests` reports, then make it a CI gate.
- Move the Telegram rate limiter and the provider circuit breaker into a
  Durable Object. Both are per-isolate today.
- Give the watchdog a list of components that MUST report, so one that never
  registers is not silently unwatched.
- Point an external uptime monitor at the watchdog's `/health`. Nothing
  watches the watchdog.
- A process bootstrap for the local agent: there is no `jarvis service`
  command and no Windows service host, so the run loop cannot be started.

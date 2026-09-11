# Next steps

The milestone order is in [the roadmap](docs/plan/2026-09-03-jarvis-roadmap.md).
R0 only; do not start R1 or resume superseded implementation plans.

## R0 checkpoint, 2026-09-11

1. **PR #5 at edac272 reviewed: no merge blocker.** Seven CI jobs observed
   green, Hermes 108/108. See [the review](docs/reviews/r0-pr5-edac272.md).
   Runtime alias rejection, locking, share flags and interpreter pin remain
   intact. The manual extended suites remain unrun.
2. **Credential rotation done by owner confirmation.** Do not repeat the
   three-pepper/DeepSeek rotation or ask for values.
3. **Config cleanup implemented in PR #5.** Exact four-name required lists;
   legacy generators retired. Leave the stored `PIN_VERIFIER_JSON` secret
   until after item 5, then use separate owner-confirmed deletion.
4. **Deployment scripts implemented in PR #5.** Dry-run by default, explicit
   production environment selection, publishing confirmation. See
   [the runbook](docs/runbooks/deploy.md).
5. **Item 5 is done.** PR #5 and PR #6 are merged; `main` is green at
   `ffa3ecd`. Migrations `0008`-`0013` were applied 2026-09-11 04:39 UTC and
   verified against `d1_migrations`. Both Workers are published from the
   reviewed commit, the gateway with all four cron triggers and the watchdog
   with its own five-minute trigger. Gateway `/health` answers 200 in
   production; it answered 501 before.
6. **Items 6 and 7 are deployed.** Health is routed, the hourly job archives,
   and the watchdog's must-report list defaults to `cloud-gateway`. Its
   heartbeat secret is set on both Workers and it alerts through its own
   Telegram bot.
7. **STILL OWNER-BLOCKED: the external monitor.** Follow the numbered
   UptimeRobot actions in [the runbook](docs/runbooks/deploy.md), against the
   watchdog's `/health` and never the gateway's. Until that is observed,
   nothing watches the watchdog.
8. **R0 exit is unverified by observation.** Telegram `/status` and `/queue`,
   a cron recorded by the watchdog, and the morning digest saying "nothing
   due". Green CI on `main` is the one condition already met. Do not start R1
   until the rest are seen.

## Next gate

[Draft PR #6](https://github.com/ksid1229-ops/jarvis/pull/6), branch
`codex/r0-health-hourly-archive`, is stacked on PR #5 at `edac272`.
Local workspace 1,942 and watchdog 119 tests, lint, source typechecking and
both deployment dry-runs pass. Verify the newest PR #6 head's remote checks.
Have **Claude Opus 5 high** review items 6/7 under BUILDING.md. Sid merges;
retarget the follow-up to main after PR #5 lands and verify its CI again.
Our independent PR #5 review is not approval of our own implementation.

**R0 exit, as amended on 2026-09-11.** CI green on `main` -- met. A real
cron firing and being recorded -- met, `drain` every five minutes and the
hourly archival clean. Remaining: Telegram `/status` and `/queue`, and the
morning digest saying "nothing due".

**The gateway heartbeat is no longer part of this exit test.** It 404s every
cron and is deferred to the end of the project by Sid's decision; see
DECISIONS.md and KNOWN_ISSUES.md. It must not block R1. The external
UptimeRobot monitor is likewise owner-blocked and not a gate on starting the
next milestone.

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

- Clear the 122 baseline test-type errors `pnpm --filter @jarvis/cloud-gateway
  typecheck:tests` reports, then make it a CI gate.
- Move the Telegram rate limiter and the provider circuit breaker into a
  Durable Object. Both are per-isolate today.
- Complete the owner-blocked external monitor action above after deployment.
- A process bootstrap for the local agent: there is no `jarvis service`
  command and no Windows service host, so the run loop cannot be started.

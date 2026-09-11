# Next steps

The milestone order is in [the roadmap](docs/plan/2026-09-03-jarvis-roadmap.md).
R0 only; do not start R1 or resume superseded implementation plans.

## R0 checkpoint, 2026-09-10

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
5. **OWNER-BLOCKED: item 5 deployment has not happened.** Sid inspected the
   live account: gateway last modified 2026-09-02; watchdog never deployed.
   Inventory migrations 0008-0013 and effective configuration, apply pending
   migrations, then deploy the reviewed Workers. Do not assume the vars or
   migration state from repository contents.
6. **Code implemented; review and deployment pending.** Gateway health is
   routed and watchdog must-report defaults to `cloud-gateway`.
   **OWNER-BLOCKED external monitor:** after item 5, follow the numbered
   UptimeRobot actions in the runbook. Fill the actual watchdog URL then;
   HTTPS GET every 5 minutes, 200 only, alerts to Sid's verified destination.
   Until that is observed, nothing watches the watchdog.
7. **Code implemented; review and deployment pending.** Existing hourly job
   invokes bounded R2 archival without requiring GitHub configuration.

## Next gate

`codex/r0-health-hourly-archive` is stacked on PR #5 at `edac272`.
Have **Claude Opus 5 high** review items 6/7 under BUILDING.md. Sid merges;
retarget the follow-up to main after PR #5 lands and verify its CI again.
Our independent PR #5 review is not approval of our own implementation.

**R0 exit remains unverified:** CI green on `main`, Telegram `/status`
and `/queue`, a real cron followed by its watchdog heartbeat, and the
actual morning digest saying "nothing due". No release is declared.

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

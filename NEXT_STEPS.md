# Next steps

The milestone order is in [the roadmap](docs/plan/2026-09-03-jarvis-roadmap.md).
**R0 passed on 2026-09-11 and R1 is open.** Do not resume superseded
implementation plans.

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
8. **R0 exit PASSED, 2026-09-11.** All five conditions observed; the
   evidence table with UTC times is in `docs/HANDOFF.md`. The digest fired on
   its own America/Toronto 07:30 schedule at 11:30:40 UTC, `/status` and
   `/queue` both answered, `drain` and `poll` are clean, and CI is green on
   `577c6a0`. Gateway heartbeat delivery was removed from this list by Sid
   before the pass and is a known issue, not an exit condition.

## R1 is the next milestone

Build it per the roadmap's section 7 and `docs/BUILDING.md`: GPT-5.6 Sol at
xhigh builds, **Claude Opus 5 at max** reviews, because R1 is the v1.0
release gate rather than the usual high. The cross-vendor gate holds -- the
same model never builds and reviews the same work.

The R1 acceptance audit in `docs/AGENT_LOG.md` records the original gaps;
the criteria remain in both calling plans and the live-smoke contract.
Item 2 is implemented for review on `codex/r1-call-acceptance`, PR #23.
The fake matrix crosses signed routes, D1 and the Durable Object for owner,
guest, unknown and ungranted callers; it covers interruption, the real
30-second model deadline, frame bounds, grant changes and callback recovery.
Telegram `/call <reason> --confirm` constructs a durable owner-only self-call
command with fixed expiry and replay protection. Production dispatch is
still unconfigured; item 1 must supply the real runtime dependencies.

Run `pnpm test:voice-access` and `pnpm typecheck:voice-access` locally.
`pnpm release:voice-gate` runs the fake prerequisite before auditing the five
retained live records, and refuses release while those records are absent.
Current validation belongs in PR #23; fake success is not live acceptance.
Item 1 is underway separately on `codex/r1-voice-runtime`, stacked on
PR #23. Its first checkpoint composes the real Durable Object runtime and
tests owner/guest conversation, restart, access administration, activation
and outbound pre-authentication. The Worker routes remain closed until the
remaining admission, capacity and dispatch dependencies are composed.
Build this independently of PR #23's separate Claude Opus 5 max review;
that review remains required before merge. Owner configuration and live evidence remain explicit gates;
the live smoke (item 3) and legacy verifier removal (item 4) stay separate.

Capacity adapters are authorized within item 1. The dispatcher now awaits
capacity before final policy validation and dispatch ownership; receipt replay
does not spend again. The guard checks freshness after collection and again
after alert delivery. Missing, malformed and stale telemetry remain closed.
The owner chose a DeepSeek remaining-credit floor for his one-time prepaid
allocation, not a strict-spending ledger. Normalize allocation minus remaining
credit into the existing estimate shape; 70/85 alerts must say to plan the R7
provider switch. Budgets remain owner configuration. The collector now reads
real D1/R2 bindings, DeepSeek credit and Twilio totalprice with bounded reads
and unchanged estimate interfaces. Source inventory and request-cost reserve
are in the voice-smoke runbook. The durable Telegram sink and explicit capacity
configuration factory are implemented. They add D1 migration 0015 for alert
crossing receipts and recoverable send leases; review this production schema
change before deployment. The default call runtime now checks capacity for each
final conversation turn, then revalidates access before allocating or committing
the turn. Interruption releases admission without waiting for telemetry or
authorization; cancellation during context retrieval prevents model invocation.
Worker route wiring and persisted outbound policy controls remain pending.
The max review of PR #23 at d6c5fc2 now requests changes; fix those on #23,
then bring its updated base into #25. The fake relay directly invokes the DO
wrapper: #25 still owes a production proof through the real stub and socket.
See DECISIONS.md for the precise guarantee.

Hermes' MSI-only trusted PowerShell path is filed for R3 as
[issue #24](https://github.com/ksid1229-ops/jarvis/issues/24). Sid's Store/MSIX
installation is legitimate but rejected. Preserve the absolute-host security
boundary and require package identity verification in that future fix; do
not resolve `pwsh` from inherited PATH. Leave implementation deferred.

## R2 platform hold

PR #13 is merged. PR #16 at `27b232f` is complete from the reviewer's side;
the remaining owner-run Windows checks are listed in HANDOFF. No further
implementation is requested on #16. R2 item 4 is parked behind Sid's node
platform decision: no Windows port and no further Linux implementation.
He owns Windows 11 PCs and an iPhone 16, with no Linux host or server.
Keep the requirement that memory works with every PC off. R1 is cloud-side
and does not depend on that decision.

## Next gate

[PR #6](https://github.com/ksid1229-ops/jarvis/pull/6) passed Claude Opus 5
high review and is merged; PR #7 is also merged. No code-review or initial
deployment hold remains. Continue live acceptance, not another wiring pass.
Do not repeat migrations or clear the must-report list to silence the
unresolved gateway alert. At 05:15:20 UTC the real gateway heartbeat POST
returned `rejected: status 404`; an external unauthenticated POST to the
public `/heartbeat` endpoint returned 401. A shared-secret mismatch is not
established. Since secrets cannot be read back, Sid re-sets the public URL
first; the runbook separates that controlled change from Worker-to-Worker
routing and authentication diagnosis. A continued 404 after the URL reset
must not be treated as proof of another URL typo.

**R0 exit, as amended on 2026-09-11 and passed the same day.** CI green on
`main`, a real cron firing and being recorded, the scheduled morning digest,
and both Telegram commands -- all five met. The digest's schedule is 07:30
America/Toronto, 11:30 UTC on 2026-09-11, and it fired there unprompted.

**The gateway heartbeat is no longer part of this exit test.** Sid deferred
it at about 06:00 UTC on 2026-09-11, while it was still an open-ended hunt,
and confirmed it in the words "just drop it for now, we finish jarvis and
then fix it at the end". It must not block R1. The external UptimeRobot
monitor is likewise owner-blocked and not a gate on starting the next
milestone. See DECISIONS.md and KNOWN_ISSUES.md.

**The cause was found after that deferral, so the fix is cheap now.** PR #8
adds the documented `global_fetch_strictly_public` compatibility flag: without
it, the gateway's fetch to a URL on its own zone is routed to the zone origin
and never reaches the watchdog Worker, which is why an external POST answered
401 and the gateway's identical POST answered 404. That earlier reading --
"404 means the URL, 401 means the secret" -- was too narrow and is withdrawn.
PR #8 passed Claude Opus 5 high review. It takes a gateway **redeploy**, not a
secret update, because `compatibility_flags` lives in `wrangler.toml`; local
tests and a clean dry-run are regression and config checks, not proof that
live routing recovers. Verifying it is a one-cron observation whenever Sid
next deploys -- it stays off the exit test either way, and only he decides
when the deferral lifts.

No release is declared. Sid authorizes roadmap building without approvals
between items, but production, secrets, merging and consequential actions
remain his. After R0 passes, R1 requires Claude Opus 5 **max** review under
BUILDING.md; the cross-vendor gate and stop rules remain in force.

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
- A Windows service host does not exist. All node platform work remains on
  hold pending Sid's decision, as stated above.

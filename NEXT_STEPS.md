# Next steps

The milestone order is in [the roadmap](docs/plan/2026-09-03-jarvis-roadmap.md).
**R0 passed on 2026-09-11 and R1 is open.** Do not resume superseded
implementation plans.

## R2 item 3: fact projection

Item 2 merged through [PR #13](https://github.com/ksid1229-ops/jarvis/pull/13)
at `94575fb`, including the client lifecycle fixes and direct completed-token
wire regression. The separate
`codex/r2-fact-projection` branch starts from main and contains the signed
page upload, atomic D1 publication, and durable Python uploader checkpoints.
Cloud context now retrieves published facts alongside recent turns under a
shared budget. The merged node bootstrap now resumes an owed projection after
event sync and before new distillation, then publishes active facts after
promotion. Durable ACK recovery remains unchanged, and shutdown preserves
pending projection pages. Item-3 review is complete and PR #16 merged on
2026-09-13 at `b6f3542`. Production D1 now includes 0014, exactly 21 projection
triggers were verified, and gateway deployment `28109492` is live. Local-node
acceptance remains behind the platform hold. Keep one PR
per milestone item and push tested checkpoints. Item 4 semantic search stays
in its own later PR and is not part of #16.

This item added `0014_memory_projection.sql`, including projection tables,
publication/abandonment guards and an FTS index. Local migration `0004` adds
quarantine and restart-safe rejection recovery. Production applied 0014 before
gateway deployment `28109492`; no cloud migration remains pending through 0015.
Do not start the historical uploader; R2 no longer depends on a device
projection or node.

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
release gate rather than the usual xhigh. The cross-vendor gate holds -- the
same model never builds and reviews the same work.

The R1 acceptance audit in `docs/AGENT_LOG.md` records the original gaps;
the criteria remain in both calling plans and the live-smoke contract.
Item 2 is implemented for review on `codex/r1-call-acceptance`, PR #23.
The fake matrix crosses signed routes, D1 and the Durable Object for owner,
guest, unknown and ungranted callers; it covers interruption, the real
30-second model deadline, frame bounds, grant changes and callback recovery.
Telegram `/call <reason> --confirm` constructs a durable owner-only self-call
command with fixed expiry and replay protection. PR #25 now composes production
dispatch and merged as `fd39301`; gateway deployment `28109492` is live.
Owner calling remains unavailable because production has no enrolled owner
phone. Sid selected Option 1 in
[`docs/plan/2026-09-14-owner-phone-enrollment-options.md`](docs/plan/2026-09-14-owner-phone-enrollment-options.md);
the device-signed Windows CLI followed by an inbound activation call. No
original sealed key was found on the intended home PC, so the required order is
a separately reviewed device-key replacement runbook and owner-executed key
replacement, then a non-disclosing local key-match preflight, then the Option 1
implementation. The production key change remains one owner-confirmed action at
each live step. Twilio must be configured before the enrollment call. Setting the voice
webhook makes inbound calling live because the outbound runtime control does
not gate inbound calls; unknown callers are refused but may still incur
provider charges. Live enrollment and acceptance remain owner-confirmed steps.

Run `pnpm test:voice-access` and `pnpm typecheck:voice-access` locally.
`pnpm release:voice-gate` runs the fake prerequisite before auditing the five
retained live records, and refuses release while those records are absent.
Fake success is not live acceptance. PR #23's review fixes at `695e762` are
included in merged `main` through PR #25. Item 1's code merged through PR #25
as `fd39301`. It composes the real Durable Object runtime and
tests owner/guest conversation, restart, access administration, activation
and outbound pre-authentication. The Worker now wires signed inbound, outbound
TwiML, status/relay-ended callbacks, actual relay sockets and confirmed Telegram
dispatch to real adapters. Missing configuration still refuses activation.
PR #25 passed Claude Opus 5 max review before merge. Owner configuration and
live evidence remain explicit gates. The item-3 release library now supplies a
fail-closed injected driver and fixed local evidence store: exact operator/
readiness, fake-gate and deployed-revision proof precedes one scenario, and its
correlation ID binds the aggregate evidence query and retained record. The
ordinary command does not discover executable code from PATH or an environment
path. It remains non-live until reviewed scenario and enrolled-operator query
adapters, boolean secret presence and the observed doctor result are injected.
No retained live evidence exists yet; the live smoke (item 3) and legacy
verifier removal (item 4) stay separate. The item-4 candidate on
`codex/r1-retire-legacy-pin` deletes the obsolete eight-digit owner verifier
and corrects the foundation spec while preserving the distinct four-digit
guest verifier and its attempt budgets. It also pins the item-3 evidence-store
failure boundary requested in PR #28's review. No secret was changed. The
stored `PIN_VERIFIER_JSON` secret is deletable now as a separate,
owner-confirmed operation using `docs/runbooks/deploy.md`; do not do this
during a live call or attended phone-enrollment window, and never recreate
the retired verifier. A rollback to a version that reads it needs separate
assessment.

Capacity adapters are authorized within item 1. The dispatcher now awaits
capacity before final policy validation and dispatch ownership; receipt replay
does not spend again. The guard checks freshness after collection and again
after alert delivery. Missing, malformed and stale telemetry remain closed.
Prepaid allocation minus remaining credit is normalized into the same estimate
shape as postpaid spend. Voice calls and turns continue until a fresh report
reaches 100% of any configured limit or the provider refuses. Every D1, R2,
model and Twilio estimate emits best-effort Telegram warnings at 85% and 95%;
failed or leased sends retry later without gating work. Telegram text and
`/sync/distill` remain ungated. Budgets remain owner configuration. The
collector now reads real D1/R2 bindings, DeepSeek credit and Twilio totalprice
with bounded reads and unchanged estimate interfaces. Source inventory is in
the voice-smoke runbook. The durable Telegram sink and explicit capacity
configuration factory are implemented. D1 migration 0015 added alert
crossing receipts, leases, default-disabled outbound controls and atomic
admission guards. It also backfilled retained terminal evidence on existing
attempts; production had no rows to change. The default call runtime now checks capacity for each
final conversation turn, then revalidates access before allocating or committing
the turn. Interruption releases admission without waiting for telemetry or
authorization; cancellation during context retrieval prevents model invocation.
Persisted outbound controls, claim-time access/phone binding and final dispatch
clock checks are implemented. A refusal proven before the provider POST now
settles its claim as rejected instead of pinning a concurrency slot. Worker
route and Telegram composition are tested.
The max review response on #23 at `695e762` was included in PR #25 and cleared
before merge. The separate production socket project now proves
the default factory through real stub fetch, client frames and eviction for
owner/guest turns and failed credit reads. The broad fake relay still directly
invokes the DO wrapper. A further test drives the actual Worker entry through
real D1, REST adapters, DO stub/socket and terminal cleanup; only external HTTP
is stubbed. Live delivery and acceptance remain unproven.
See DECISIONS.md for the precise guarantee.

Hermes' MSI-only trusted PowerShell path is filed for R3 as
[issue #24](https://github.com/ksid1229-ops/jarvis/issues/24). Sid's Store/MSIX
installation is legitimate but rejected. Preserve the absolute-host security
boundary and require package identity verification in that future fix; do
not resolve `pwsh` from inherited PATH. Leave implementation deferred.

## R2 cloud-memory design

PR #13 is merged. PR #16 at `27b232f` is complete from the reviewer's side;
the subsequent owner-run Windows results are listed in HANDOFF. No further
implementation is requested on #16. The Linux home node is historical: it was
a planning-session choice Sid never made. Do not port it, provision it or make
R2/R3 depend on it.

Sid requires cloud memory that works with every PC off and delegated the
design. The reviewer recorded the decision at `951675e`: D1 is authoritative
for the event ledger, versioned memories, receipts and topic tree; FTS5 and
Vectorize are rebuildable indexes, and full-history recall includes verified
R2 archive segments. Obsidian is only a later optional one-way export and is
not built in R2.

Open the documentation/design PR for Claude max review. Keep migration `0016`
reserved but uncreated. After the docs decision passes review, the next small
PR may define `0016`; Sid alone applies it after a second review. No live model
comparison runs without Sid's explicit approval. R1 is cloud-side and does not
depend on this work.

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

Stage one is built -- see DECISIONS.md -- but its home-node completion plan is
historical. Do not resume the adapter or native bridge in R0 or R2. The active
D1 design preserves an Obsidian-compatible Markdown shape only for a later
optional one-way export. Sid approved a future private-GitHub copy with tested
exclusion of sensitive categories, but not its R2 build, repository creation,
token, app install, paid plan or live push. Compatibility does not authorize an
Obsidian client, sync path or editable vault.

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

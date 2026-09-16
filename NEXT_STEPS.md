# Next steps

The milestone order is in [the roadmap](docs/plan/2026-09-03-jarvis-roadmap.md).
**R0 passed on 2026-09-11 and R1 is open.** Do not resume superseded
implementation plans.

R7's reviewable v1.6 sequence is in
[`docs/plan/2026-09-15-r7-assistant-manager-plan.md`](docs/plan/2026-09-15-r7-assistant-manager-plan.md).
It is a planning artifact only and authorizes no build, OAuth consent, spend,
migration or deploy.

## School and university priority: R5 starts alongside R1 and R2

Sid moved school and university support ahead of R3 and R4 on 2026-09-15. The
reviewable scope is in
[`docs/plan/2026-09-15-school-university-plan.md`](docs/plan/2026-09-15-school-university-plan.md):
conversational course/program intake, one catch-up plan per course, Classroom
and Brightspace deadlines, grades and missing-work watch, the first proactive
study-coach slice, and the full university-application track. R5 deadline
ingestion depends on the deployed R0 gateway, not on PC control. The complete
coach follows R5 because it needs those grades and deadlines plus R2 memory.

The plan cleared in merged PR #41, Classroom hourly ingestion merged in PR #43,
and the first conversational live-bot catch-up slice merged in PR #45 as
`e0b5072`. The live bot can maintain one evidence-labelled card per course,
replan the daily recovery sequence, and put today's actions in the morning
digest. Its additive `0020_school_catchup.sql` remains an unapplied candidate
pending the owner-controlled migration steps. PR #48 then merged as `1130694`
with a bounded university program tracker in the same ordinary Telegram
conversation: programs, requirements and dates are each labelled `verified` or
`unverified`, and verified details retain their current official source and
admission cycle. It also closes PR #45 follow-ups F1-F3. Its additive
`0022_university_tracker.sql` remains an unapplied candidate; PR #46 is merged
as `ebb757b` and owns `0021_voice_owner_delivery.sql`. PR #49 merged as `deea39c`
with the Brightspace
private iCalendar feed in the existing hourly poll, deadline tables and morning
digest, plus PR #43 follow-ups F1 and F2.
[PR #51](https://github.com/ksid1229-ops/jarvis/pull/51) is merged as `10d4cd7`
and finishes build-sequence
step 3 before the feed secret is set: bounded partial results, explicit
parser/cancellation regressions, and a rate-limited owner-only plain-speech
refresh path. No new migration is needed. Build-sequence step 4 (the study coach)
has started: [PR #53](https://github.com/ksid1229-ops/jarvis/pull/53) merged the
first slice with separate evidence-backed weak-area records, at most one quiet
coursework check-in per day, cited quizzes and flashcards, and direct-owner-only
correction and forget. The dependent follow-up adds regular coursework check-ins
informed by R2 memory, grades and deadlines, spoken quizzing in the car and
automatic discovery of free tools. It may not spend, create an account or
contact another person without Sid's explicit tap. Its additive
`0023_study_coach.sql` remains unapplied. Draft
[PR #52](https://github.com/ksid1229-ops/jarvis/pull/52) independently owns
`0024_university_application_workflow.sql` for per-program application
checklists, current-owner conversational updates, due-date verification labels,
and the next unfinished application items in the morning digest. Claude's
round-3 max review requested changes at `12a7bbf`; implementation `d5f5ede`
plus current-main merge `f2d5c9f` is ready for max re-review. Both `0023` and
`0024` remain unapplied candidates. None of these slices
authorizes OAuth consent, a secret operation, migration, deployment, school or
university contact, purchase, sign-up, submission or live account access.

## R2 cloud-memory runtime next

[PR #39](https://github.com/ksid1229-ops/jarvis/pull/39) merged as `0d659bf`
with additive migration `0016_cloud_memory.sql`.
[PR #42](https://github.com/ksid1229-ops/jarvis/pull/42) merged as `f0bfbe9`
with migration `0019_memory_ingress.sql`. PR #44 merged the reviewed runtime
slice plan as `3e28bda`; main also owns `0020_school_catchup.sql` and
`0022_university_tracker.sql`, while PR #46 is merged as `ebb757b` and owns
`0021_voice_owner_delivery.sql`. PR #53 merged `0023_study_coach.sql`,
open PR #52 reserves `0024_university_application_workflow.sql`, and draft
[PR #56](https://github.com/ksid1229-ops/jarvis/pull/56) uses the next free
name, `0025_archive_literal_history.sql`.
None of `0016` through `0020` or `0022` has been applied by this R2 work. The
Sid-attended scratch remote-D1 proof remains mandatory before any production
apply; follow the [migration scratch proof runbook](docs/runbooks/migration-scratch-proof.md).

[PR #47](https://github.com/ksid1229-ops/jarvis/pull/47) merged as `60ae90d`
with the first runtime slice in
[`docs/plan/2026-09-15-r2-memory-runtime-slices.md`](docs/plan/2026-09-15-r2-memory-runtime-slices.md):
the channel-neutral canonical D1 repository, exact source validation, atomic
initial writes, canonical reads, root/inbox bootstrap and current-path-first
topic resolution. It claims no migration and has no Telegram, voice, calls,
provider, scheduler, Vectorize or archive-index composition.
[PR #50](https://github.com/ksid1229-ops/jarvis/pull/50) merged as `1cae97b`
with its channel-neutral owner-controls successor and no migration or channel
wiring. Draft [PR #56](https://github.com/ksid1229-ops/jarvis/pull/56) builds
the second slice: suppression-safe live/R2 literal coverage, exact provenance
results and a bounded resumable exhaustive-search job. Migration `0025` is
unapplied, and the later dependency order remains unchanged. Although the
service accepts `MAX_JOB_EVENTS = 16`, the 262,144-byte step budget and the
32,768-byte per-event ceiling make eight events the real maximum per step.
Runtime slices 3 and 4 must supply a durable driver for the potentially long
walk; this slice intentionally has no scheduler or composition.

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

Build it per the roadmap's section 7. `docs/BUILDING.md` still names GPT-5.6
Sol for building, but the builder model has since changed; its cross-vendor
review and stop rules remain in force.

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
the merged PR #31 Option 1 route deployed with its owner/HMAC configuration and
the inbound webhook closed, then the reviewed owner-executed device-key
replacement and non-disclosing preflight. First phone status must be `absent`.
The production key change remains one owner-confirmed action at each live step.
Twilio must be configured before the enrollment call. Setting the voice
webhook makes inbound calling live because the outbound runtime control does
not gate inbound calls; unknown callers are refused but may still incur
provider charges. Live enrollment and acceptance remain owner-confirmed steps.
The authenticated begin number-state oracle remains recorded in
`KNOWN_ISSUES.md`.

Sid has reversed the unconfirmed Caller-ID-risk assumption and requires a
spoken passphrase before owner authority on every inbound and outbound call,
three tries before the call ends, no persistent lockout, and a Passed-A waiver
that is built but switched off. The reviewed design chooses three
Worker-generated words from a 2,048-word list, durable per-session attempt
ordinals, a 60-second alarm-backed window, no cross-call candidate rejection,
and a reserved outbound-owner path.
[PR #33](https://github.com/ksid1229-ops/jarvis/pull/33) merged at `726b78b`
with that documentation contract. Draft
[PR #37](https://github.com/ksid1229-ops/jarvis/pull/37) implements only the
first slice: migration `0017`, the versioned verifier, authenticated
Worker-side generation and compare-and-swap rotation, guarded disable/new-version
re-enable storage transitions, known-answer vectors, and the attended Windows
CLI. R2 retains migration `0016`; Wrangler may apply it after `0017` because
migration names, rather than numeric continuity, determine pending work. Call-session
step-up, durable attempt ordinals, alarms, authority changes, recovery and
notices remain later, separately reviewed PRs; inbound calling stays closed.

For the attended phone enrollment, remove or redirect the inbound webhook
immediately after status becomes `active`, rerun the read-only status command,
and confirm `active` before leaving the window. Inbound opens again only after
passphrase deployment and one attended spoken verification.

After R1 calling and R2 memory, however hosted, are both live, run Sid's
first-call onboarding session while parked, never while driving. A
device-issued single-use challenge opens a setup-only segment with no owner
authority. Deterministic handlers generate the owner verifier and write guest
PIN records; Sid then speaks the generated phrase once through normal step-up.
Only after those settings have durable receipts may Jarvis interview Sid and
write owner-confirmed answers to memory. The interview is parked work and must
not drive R1 or R2 implementation. Measure the shared R2 retriever against the
4,000 ms first-audible gate and give voice retrieval a hard timeout that falls
back to no extra context.

Run `pnpm test:voice-access` and `pnpm typecheck:voice-access` locally.
The live-evidence contract now requires seven retained records, including
`owner-step-up-refused` and the answered outbound
`outbound-step-up-refused`, and rejects both the former six-record contract and
the earlier PIN-free five-record schema.
The initial release audit requires `passphrase_always` on every owner path and
a verified inbound phrase; the dormant exact Passed-A waiver remains valid only
as a per-record shape for a future optional record and cannot replace inbound.
No owner authority is accepted without a successful step-up outcome. No
retained live evidence exists yet, so this contract change does not itself
support an R1 release claim.
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

PR #13 and PR #16 are historical device-projection baselines; no further work
is requested on them. The Linux home node is historical and R2 does not depend
on it.

Sid requires cloud memory that works with every PC off. D1 is authoritative for
the event ledger, versioned memories, receipts and topic tree; FTS5 and
Vectorize are rebuildable indexes, and full-history recall includes verified
R2 archive segments. Obsidian remains a later optional one-way export outside
R2.

PRs #35, #36 and #38 established the pure policy and approved design. PR #39
merged the `0016` schema, PR #42 merged the `0019` ingress guard, PR #44 merged
the runtime-slice plan, and PR #47 merged the first uncomposed channel-neutral
repository as `60ae90d`. Draft
[PR #50](https://github.com/ksid1229-ops/jarvis/pull/50) merged as `1cae97b`
with the uncomposed owner-controls service. Draft
[PR #56](https://github.com/ksid1229-ops/jarvis/pull/56) adds the archive-
complete literal index and exhaustive search without exposing either runtime
writer to a channel. No automatic distillation Workflow exists.
Sid uses ordinary speech and text for remember, why, forget and lift actions;
slash commands are at most hidden fallbacks. After one reviewed scratch-target
setup, restore drills run automatically and alert Sid only on failure.

Review PR #56 against
[`docs/plan/2026-09-15-r2-memory-runtime-slices.md`](docs/plan/2026-09-15-r2-memory-runtime-slices.md)
and the approved design before starting slice 3 automatic distillation. No live
model comparison runs without Sid's explicit approval. R1 and R5 remain
independent cloud-side work.

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

## Built and configuration-gated

These have code and tests but still need owner configuration or a later slice.

- **Google Classroom ingestion.** Merged PR #43 wires
  `classroom-client.ts` and `deadline-ingestion.ts` into the hourly poll behind
  all three Google OAuth bindings. With no bindings it performs no Google call;
  partial or failed configuration becomes visible source health in the digest.
  Live configuration and deployment acceptance are not established, and Sid's
  OAuth consent remains an owner-run step in
  [`docs/runbooks/google-classroom-oauth.md`](docs/runbooks/google-classroom-oauth.md).
- **Brightspace calendar ingestion.** The current candidate reads only Sid's
  private iCalendar subscription URL in the always-on gateway. Missing
  configuration makes no request and says `Brightspace: not set up` in the
  digest. It never logs in or reads a browser session. The owner setup and
  live-verification boundary is in
  [`docs/runbooks/brightspace-calendar-feed.md`](docs/runbooks/brightspace-calendar-feed.md).
- **Deadline status.** Explicit Brightspace calendar cancellation closes the
  matching deadline. Nothing sets `submitted` or `missed`; the grade and
  missing-work watch is what closes those states.
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

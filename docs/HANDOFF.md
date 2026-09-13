# Handoff

Current as of **2026-09-13**. Verify the current branch and checks before
using this checkpoint. R0 passed; calling remains R1.

PR #25's max-review response passes 2,512 Windows workspace tests / 122
files. Its release gate passes 761 / 32 plus six native checks, then refuses
missing live evidence. Source/harness typechecks and lint pass; the separate
test-type baseline is 121 diagnostics. Max re-review and owner operations remain.

## R1 is active; the node platform decision remains on hold

R0 passed on 2026-09-11. R1 depends on R0 and is entirely cloud-side.
PR #23 implements item 2's fake calling/access matrix and confirmed Telegram
`/call`, with local Windows validation and mutation evidence recorded in the
PR. PR #25 composes the production Worker; an unconfigured deployment still
answers that calling is not configured.
The real release runner passes its local prerequisites and then refuses the
missing live evidence. It never places a call itself.

R1's v1.0 review requires Claude Opus 5 at max. Item 1's real Worker/runtime
composition is implemented on `codex/r1-voice-runtime`, stacked on PR #23; its
implementation does not wait on the separate review. The first checkpoint
installs a lazy production Durable Object runtime using the real D1 access,
activation, conversation, DeepSeek and Telegram services. Nominal proof and
authority issuers are shared within each reconstructed graph. Configuration
is validated before runtime effects; initialization and termination remain
available when provider configuration is missing. The new explicit
`IDENTITY_CHALLENGE_HMAC_KEY_VERSION` must match challenge issuance and inbound
admission, and all three peppers must be canonical base64 for exactly 32 bytes.
The Worker now wires verified voice routes and confirmed Telegram dispatch
to real adapters; owner configuration and review still gate activation.
The pre-dial capacity check and telemetry freshness corrections are
implemented and tested. The owner approved admission through 100% of each
configured limit, with 85% and 95% warnings. D1/R2 and provider collectors, explicit capacity
configuration and the durable Telegram alert sink are implemented. New D1
migration 0015 adds alert crossing receipts, recoverable leases, default-disabled
outbound controls and atomic admission guards. It adds and backfills a terminal
evidence column on existing attempts; it is a production schema change requiring
max review and owner migration. The default call
runtime now checks every final conversation turn before fresh access validation
and durable admission. Interrupted admission releases the slot for a replacement
prompt; cancelled context retrieval cannot start a model request. Completed
output can still settle its receipt after interruption without closing the call.
Persisted outbound controls now cover atomic access/number binding, expiry,
quiet windows and the two/six admission limits. Final control reads and a
synchronous clock fence precede dialing. Unknown claims retain their slot;
affirmative terminal evidence survives archival. Inbound requests are verified
once before capacity collection; their nominal form is passed to admission.
Terminal callbacks and socket forwarding do not require model/credit config.
The max review of #23 at d6c5fc2 requested changes. The fixes are pushed at
695e762 and carried into this branch; max re-review remains required. The broad
relay harness invokes DO methods directly. A separate configured test project
now exercises the default production factory through the actual DO stub and
client WebSocket: owner and PIN-authenticated guest turns survive real eviction,
and a failed credit read closes the socket before another model request or turn.
Another test drives actual Worker ingress, confirmed Telegram dispatch, signed
TwiML and callback routes, and closes real sockets after terminal callbacks.
Only external provider HTTP is stubbed. This does not prove live Twilio delivery.
The guarantee is stop at the configured limit or provider refusal, not a
reservation or a bound on later concurrent charges. An admitted call can end
mid-conversation when credit runs out. The voice runbook identifies each
measured or estimated source. Voice calls and turns are capacity-gated;
Telegram text and `/sync/distill` remain ungated. Every resource warns at 85%
and 95%; an unacknowledged send can retry later but cannot itself refuse work.
Pre-provider refusals now
settle claimed attempts as rejected; genuinely uncertain POST outcomes remain
reserved for owner reconciliation.
Twilio configuration,
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
implementation is requested on #16. Sid merged #16 on 2026-09-13 at
`b6f3542`. Owner rollout remains: skip the POSIX-only 0700 preflight on
Windows, apply 0014 to live D1, confirm exactly 21 projection triggers, then
deploy the gateway. Do not start the node.

Sid's real Windows suite exposed Hermes' MSI-only PowerShell path: the trusted
host lookup rejects his Store/MSIX installation. This is deferred R3
[issue #24](https://github.com/ksid1229-ops/jarvis/issues/24), not a PR #16
blocker. No Hermes implementation changed. The Codex command host is a bundled
PowerShell installation, so local command success does not reproduce Sid's
installed Store host or clear the reported Hermes failures. Prefer evidence
from the actual target environment over runner layout assumptions.

PR #16 and PR #23 both edit NEXT_STEPS, AGENT_LOG and this document. Whichever
merges second must preserve both milestones' current state and all log entries.

GitHub Actions has used 2,000/2,000 minutes with a $0 budget and stop-usage
enabled, resetting 2026-10-01. Sid will not raise it. Run suites locally
and record the results in each PR; do not retry Actions, disable jobs or
restructure CI to bypass the quota. CI path filtering can be considered
when CI is next intentionally changed; it is not part of this work.

## R2 item 3 review candidate

**Platform hold (Sid, 2026-09-12):** his PCs run Windows 11 and his phone is an
iPhone 16; there is no Linux host, server or VPS. The home PC is off overnight.
The current Linux-only node cannot run on his machines. Do not port the node or
continue Linux work until he decides. Carry forward the actual R2 requirement:
memory must work with every PC off. PR #22 records this correction in
`CLAUDE.md`; the runbook labels its existing Linux procedures as on hold and
its mode-0700 check as POSIX-only, with no Windows ACL enforcement.

The platform-independent review fixes are pushed at `f1958c4`. GitHub Actions
run 34721781316 did not start any of its seven jobs because of an account
billing/spending-limit restriction. This is not current-head CI validation;
the local results below remain the available evidence. No billing setting or
workflow check was changed.

The follow-up after `2e5da79` adds five direct migration-trigger regressions and
two FTS recovery cases. Removing each named trigger from migration 0014 fails its
own test; removing the exercised rebuild command fails both forged/missing-match
cases. The migration is restored byte-for-byte and has no diff from `4764d9b`.
The FTS cleanup test inspects postings directly instead of letting the base-table
join hide them. Recovery uses the real retriever and preserves facts, heads and
receipts. The runbook now documents rebuilding the derived index, the default
integrity-check limitation, and the decision to retain the existing base-table
join rather than add a second per-query tokenizer or scan.

Pre-merge rollout review must read this newly introduced runbook from the PR
branch, not `main`. Its mode-0700 preflight is explicitly POSIX-only; the Linux
shell commands do not validate Windows ACLs. After applying 0014 and before
deploying the gateway, the owner must count exactly 21 projection triggers.
Local validation passes 105 focused tests and all 2,146 workspace tests across
109 files, lint and source types. The separate test typecheck has 119 diagnostics
outside the two changed files and none inside them. Current-head CI and review
status are recorded on PR #16. No production code or migration changed in this
follow-up, and no live operation or merge was performed.

Review remediation after `78e8e89` is implemented. The early pushed checkpoint
`f8666f9` passed all seven CI jobs, including Linux's real node SIGKILL/restart
and live-duplicate test. Startup names an occupied endpoint and gives conditional
manual recovery instructions; the runbook puts stale-endpoint removal before
restart. A failed, unaccepted enqueue no longer sets a persistent storage alarm.
New store-directory components are all created as 0700 and validated. Invalid
control-response shapes and encoding failures return a fixed refusal while the
control service remains usable.

The latest local Python suite passes 789 tests / 32 Windows platform skips,
with Ruff and win32 mypy clean. Seventeen targeted mutations were caught and
restored. Added coverage pins transaction boundaries, recovered-work wakeup,
shutdown admission, mode=rw, all three reviewed migration 0005 constraints,
per-device retention, and memory write locks staying outside cloud requests.
No migration contents changed in this round. A fresh read-only same-vendor
advisory review found no further issues in the inspected delta; it does not
replace independent Claude review. Final-commit CI and publication status are
recorded on PR #16.

The follow-up after `a9b73fb` bounds the retry reply wait and returns an explicit
queued acknowledgement while a cloud call is in flight. Local command work wakes
without running a cloud cycle; only a successful scoped quarantine delete asks
for one. Status reports pending and recent retry results, including failures and
stop cancellation. Local migration `0005_projection_retries.sql` persists accepted
requests and their outcomes in the memory store. The cycle thread commits the
delete and receipt atomically; queued work resumes after abrupt restart, and
recent history survives with distinct request IDs. Retention uses completion
order, so an older request finishing late remains visible. A receipt-storage
failure keeps queued work available for later existing boundaries without a
hot retry loop. The runbook retains the stopped-node exact SQL fallback.
Atomic admission limits each owner to 256 pending requests so all accepted work
fits in status; excess new requests receive `retry_queue_full`, and duplicate
pending requests retain their IDs. Request flags and wake signals share the
same lock so a delayed local signal cannot bypass the cloud backoff deadline.

The gateway now returns retryable 409 for `device_key_changed`, the race between
the verified-key read and nonce write. `device_key_invalid` remains 401 and a
deliberate stop because it means the stored enrolled key/fingerprint is corrupt.
Only the reviewed `memory_projection_device_state_changed` D1 trigger may turn
storage text into a permanent status; future trigger names remain generic 400.
Promotion-stage authentication is mutation-pinned. Quarantine deletion scope and
both fact-id guards now have dedicated regressions.

Existing POSIX store parents are refused if they are not private; startup never
chmods an owner-selected directory. The permission error names the manual chmod
command. The runbook now requires an archive/memory/vault/vector parent-mode
preflight before deployment or migration 0014. Database/WAL/SHM file guards stay
0600. The existing embedding compatibility check creates its own candidate
directory with 0700 so it obeys this same policy. The preceding checkpoint's
local validation was Python 757 passed / 31 skips, Ruff, win32 mypy for all 55
source files and diff checks.
The 40 earlier guard mutations and 11 follow-up mutations were caught and
restored. Its Linux CI passed the actual slow-cloud Unix socket and POSIX
permission cases. Main `1fc8187`, including merged PR #21's Hermes close fix,
is incorporated here. Current validation is at the top of this section and on
PR #16.

The gateway authenticates signed bytes before endpoint validation, so an
unauthenticated request cannot invoke projection policy or distillation model
work. Sync status uses exact closed codes; a raw `request_nonces` storage error
remains retryable 400, while genuine auth/device-state failures retain 401/403.
Deterministic invalid fact text receives the signed abandonment classification,
authenticated content rejection is logged without submitted text, and a page
write race returns retryable 409 instead of device revocation. Python and
TypeScript exercise shared 4,096-byte/eight-source bounds.

Distillation now refuses excerpt controls and non-ULID source ids before prompt
rendering. The node skips these ineligible raw excerpts without rewriting the
archive, and selection/progress use one scan so rejected events cannot consume
the valid-excerpt limit or cause repeated batches. Superseding a quarantined fact
is covered across re-projection: the active count becomes zero while its retained
quarantine record remains. Both state-filter mutations fail that regression.

Fact text now rejects controls and Unicode line separators at both producers,
upload validation and the D1 boundary. Provider context quotes/escapes each
entry, including multiline history, so content cannot add a rendered entry.
Python and TypeScript execute one shared redaction-vector file covering
ECMAScript whitespace and ASCII boundary/case semantics. Page rejection still
quarantines the page as a unit; completed projection cycles expose the exact
active quarantine count through node status.

The follow-up addresses permanently stalled projection: distillation now shares
the 4,096 UTF-8-byte/eight-source bounds and refuses text requiring redaction.
Legacy unrepresentable facts are quarantined individually. Definitive gateway
content rejection records durable local recovery and signs an exact-manifest
abandonment, leaving published memory intact. D1 abandonment receipts prevent
delayed pages from resurrecting the rejected stage. Unknown HTTP 400/network
errors remain resumable. Quarantine and pending recovery have distinct node
status messages. Local migration `0004` stores the quarantine/recovery metadata;
cloud migration `0014` also includes the abandonment guards. Current validation
and the pending independent review are recorded on PR #16.

Item 2 merged through [PR #13](https://github.com/ksid1229-ops/jarvis/pull/13)
at `94575fb`, including the client lifecycle fixes and direct completed-token
wire regression. That main commit is incorporated into
`codex/r2-fact-projection`. The gateway accepts signed, bounded active-fact
pages, validates their source events in D1 or the verified R2 archive, and
publishes a complete manifest atomically. SQL version/head transitions require
the exact immutable commit receipt; published contents reject direct additions,
edits, deletion and replacement, including replacement by fact rowid. Cleanup
after a newer commit and staged expiry/key rotation remain permitted. Removing
each of ten guards and the fact-rowid predicate fails its direct-SQL regression.
The Python uploader persists an
immutable snapshot before HTTP and resends every page after interruption,
advancing only on an exact commit receipt. Local memory migration `0003`
adds its durable pending pages and publication cursor. Earlier Python validation
was 686 passed / 20 Windows skips, with Ruff and win32 mypy clean. Cloud context
now combines matching published facts with recent turns, enforces active
principal/device ownership and a shared byte/item budget, and keeps the most
restrictive sensitivity across device duplicates. History stops at the first
over-budget turn to preserve its contiguous newest suffix; deferred facts can
use the remaining space and skip independent oversized candidates. Keyword
mutations fail the three regressions for these boundaries. Earlier workspace
validation was 2,112 passed / 109 files, with lint and source types clean. Removing both
publication predicates exposes staged facts and fails the regression; removing
the device-status predicate exposes a revoked fact and also fails. All guards
were restored before the full suite.

The merged bootstrap now runs the uploader. An owed immutable projection is
retried after event sync/ACK recovery and before new distillation. The current
active snapshot is published after promotion. Node tests verify signed wire
requests, unchanged later cycles, exact retry after process reconstruction,
and shutdown with a pending page. Disabling the node binding, retry call, or
stop callback fails those boundary tests. Authentication rejection stops the
service; transient failure keeps pending work durable for retry. The reviewed
ACK recovery implementation remains unchanged.

Current-head checks and review status are recorded on PR #16. Its live-data
migration requires Claude Opus 5 at max under the current BUILDING rules.
Item 4 semantic
search is a separate future PR and is not included here.
See the [fact projection runbook](runbooks/fact-projection.md) for rollout and
owner acceptance. The earlier sections below are historical R0 evidence.

**Production schema change:** `0014_memory_projection.sql` adds projection
storage, publication triggers and FTS indexing. It does not backfill facts
or alter existing event rows. At owner deployment, apply and verify this
migration on live D1 before publishing the gateway and enabling the uploader.
Merging, production migration, deployment, and live acceptance remain Sid's;
local D1 tests establish none of those actions.

## R2 item 2 merged baseline

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
with Ruff and win32 mypy clean. All seven CI jobs passed at `719d4ee` before
Sid merged PR #13 at `94575fb`.

GPT-5.6 Sol xhigh builds R2 under the current BUILDING rules. Because this item
contains a live-data migration, its review requires Claude Opus 5 max. Sid
retains merging and the live systemd check. Item 3 is isolated in
[PR #16](https://github.com/ksid1229-ops/jarvis/pull/16), including its
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

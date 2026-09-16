# Known issues

## Owner memory controls have six deferred integration limits

PR #50 keeps the channel-neutral owner-control boundary closed, but later
integration work must resolve these limits before enabling the affected callers:

- **F1, required before the channel adapter PR:**
  `conversation.user_committed` persists no closed provenance code. The service
  can reject forwarded, quoted, pasted, attachment and guest flags only as
  assertions from its trusted caller; it cannot verify them against the event
  ledger. `memoryIntent` is likewise the adapter's unverified classification.
  Telegram and voice ingress must persist owner-typed provenance and intent
  codes, and `validateOwnerTurn` must require them.
- **F2, required before any topic move or merge caller:** moving the canonical
  inbox away from the root, or merging it, makes `bootstrapTopics` refuse every
  later remember request. A future caller must either forbid those operations for
  the bootstrap inbox or make bootstrap follow its redirect and accept its new
  parent.
- **N3:** exact recovery of an accepted but unapplied owner command has no age
  bound and intentionally skips revalidating the now-stale owner turn. Completed
  remember replays whose transition is no longer current suppress all text and
  excerpts, and forget/lift replays require the exact current transition, but an
  unchanged accepted command can still be completed much later. Define a durable
  expiry policy before command-retention or delayed-queue work.
- **N8:** each remember, explain, forget or lift request accepts exactly one
  resolved target. The future adapter must state that limit and ask the owner to
  disambiguate or repeat multi-target requests rather than silently selecting one.
- **Round-2 N2:** a forget or lift that loses a race after its owner command is
  appended leaves an unapplied command and consumes that turn's mutation key.
  The adapter must ask the owner to repeat the request, or a later storage slice
  must make command acceptance and the memory mutation one atomic boundary.
- **Round-2 N3:** lifting an inferred item back to `proposed` records an owner
  transition because the current schema binds corrections to owner commands.
  Rules therefore cannot promote or reject it. Add a confirmation control or a
  rules-compatible restoration path before proposed-memory restore is exposed.

## R2 literal history retains two append-only and reindexing tradeoffs

- Forgetting a turn cannot delete a durable exhaustive-search hit receipt.
  Result reads re-check active suppressions and return no forgotten text, but
  the append-only receipt continues to record the event id and content hash that
  matched the query. Removing that metadata would weaken the immutable job
  audit and needs an explicit retention decision rather than a hidden delete.
- `memory_history_chunks` remains deletable because suppression lifts and
  live-to-archive handoff reindex an event by replacing its derived chunk. A
  failed or unauthorized delete could therefore leave immutable coverage marked
  `indexed` while the FTS row is absent. No caller other than the uncomposed
  literal-history indexer writes this table today; closing the gap requires an
  atomic replacement protocol or a separate durable current-chunk receipt.

## Automatic distillation is deliberately provider-disabled in production

The hourly poll now has the complete tiered-read, extraction-policy and
canonical-repository path, but the production job context supplies no model
provider. It reports `Memory distillation not configured`, writes no memory run
and does not advance the distillation cursor. Tests inject the credential-free
fake provider. Selecting a paid provider, recording real token and cost ledger
entries, and enabling it remain outside this slice because Sid has not approved
the reviewed comparison or any spend.

Automatic filing is intentionally conservative. Inferred, archived-only and
low-confidence items go to the durable `Inbox / Needs filing`; only a
high-confidence exact live first-person statement is placed at the memory root.
Semantic topic creation or movement waits for the topic-controls slice because
letting untrusted provider text choose a topic would bypass that control design.

## PR #46 notification delivery retains three bounded at-least-once limits

The guest-grant notice outbox keeps a stable per-mutation idempotency key and
takes a fresh clock value for each row it claims. The Telegram REST boundary
does not provide an exactly-once receipt, however. If Telegram accepts a
message and the delivered-marker write then fails or the isolate stops, a
retry can send the same notice again.

The drain also has no attempt count or dead-letter policy. A permanently
undeliverable notice among the oldest ten pending rows can therefore keep
newer rows outside the bounded batch. Adding that policy requires a product
decision about retry limits and operator recovery, not an implicit discard in
this passphrase PR.

Rejection delivery has the same final-marker edge: if the refusal, end frame,
and owner alert succeed but the rejection-delivery insert fails, a later
resume can repeat the refusal and alert observation. Repairing that double
failure requires a multi-stage durable delivery state. These limits must be
resolved or explicitly accepted before notification delivery is described as
exactly once.

## A late split passphrase repeat is ordinary conversation (PR #40 N9)

After the 3.5-second post-verification fragment window, one- and two-word
finals are treated as ordinary owner speech. A phrase repeated as separate
finals after that window can therefore reach the model and transcript. An
unspent single repeat comparison still checks a complete three-word final;
it does not assemble arbitrarily late fragments. This is the bounded
single-compare design's tradeoff for preserving short replies such as "good",
not a claim that every later repetition is removed. Revisit that tradeoff
before the attended smoke if broader repeat suppression is required.

## Owner-call step-up has five deferred failure and concurrency edges

PR #40 keeps inbound calling closed and adds the durable passphrase boundary,
but five low-severity edges remain before live acceptance:

- **F9:** An attempt's `resolved_at` uses the observation time captured before the
  600,000-round KDF. A slow verifier can therefore commit a timestamp that
  predates the actual completion and the 60-second deadline.
- **F10:** If the verifier throws after its durable attempt row is reserved, that row
  remains unresolved and the relay closes with code 1011. The caller does not
  receive the fixed refusal, clean end frame, or rejection alert.
- **F11:** The outbound slot reservation trigger recognizes exactly two inbound owner
  sessions in `pre_auth`. If inconsistent or future state ever leaves more than
  two such rows, the reservation no longer applies.
- **N3:** Concurrent identical `bind`, `begin`, or rejection deliveries can both pass
  their read-before-insert check. The losing insert fails closed through a
  guard trigger instead of re-reading and returning the matching durable row.
- **N4:** Concurrent post-success transcript finals are not serialized inside one
  call-session core. Reordered D1 completions could assemble split passphrase
  words out of order and pass the mismatch onward as ordinary speech.

Deadline restoration after eviction (F6), a final arriving during KDF work
(F7), and refusal delivery ahead of the alert sink (F14) are fixed and covered
on PR #40. The five items above must be resolved or explicitly accepted before
inbound opening and the attended voice smoke.

## Owner-call passphrase boundary awaits rollout and live acceptance

Production still trusts the enrolled owner number without a human step-up. A
valid Twilio signature proves that a request came through Twilio; it does not
prove the caller is Sid. Outbound calls have the sibling voicemail-disclosure
risk because Jarvis cannot distinguish Sid from an answering-machine greeting.

PR #40 implements the decided passphrase boundary for inbound and outbound
owner calls, binds the exact attestation class, and keeps the Passed-A waiver
dormant. That code does not protect production until migration `0018` is
reviewed and applied, the Worker is deployed, a verifier is generated, and the
attended voice smoke passes. Answering-machine detection remains outside R1.

Sid chose three generated words, three tries before the call ends, no
persistent lockout, and an evidence gate for any later waiver enablement.
Until rollout and live acceptance, both paths remain release blockers and
inbound must stay closed. The security contract and implementation order are in
[`docs/superpowers/specs/2026-09-14-owner-call-passphrase-design.md`](docs/superpowers/specs/2026-09-14-owner-call-passphrase-design.md).

## R1 live voice evidence has two deferred observability limits

The release evidence can observe one durable rejection row, one durable
rejection-delivery row, and whether the shared owner alert was sent or
coalesced. It cannot prove per session that the fixed refusal reached the
provider or whether ConversationRelay ended through the clean `end` frame or
the policy-close fallback. A runtime follow-up must persist per-session
`refusal_sent`, end mode, and alert disposition before retained evidence claims
those facts. That follow-up needs a migration and is deliberately outside PR
#54.

On 2026-09-16 Sid approved the additional paid live scenario for an answered
outbound call that fails step-up, such as voicemail or another person answering.
The seven-record release contract now requires `outbound-step-up-refused`.
This decision accepts the roughly one-cent call cost but does not itself place
or authorize a call outside the attended operator sequence.

The local evidence store also retains only a passing record. It has no ledger
of failed paid attempts, so an operator could clean up and retry until a lucky
latency or delivery result passes without the audit detecting the earlier
runs. Add a retained, correlation-bound attempt ledger before describing the
live gate as resistant to selective retry.

## Guest PIN attempt counts reset when a call Durable Object hibernates

The guest path keeps `#failedPinAttempts` in the in-memory call-session core.
Cloudflare Durable Object hibernation reconstructs that core and resets the
count while the same call remains in `pre_auth`. A caller can therefore avoid
the promised three-attempt terminal state by pausing between attempts.

The owner-passphrase implementation must move guest and owner per-call attempt
ordinals into durable state, write each ordinal before verification, and commit
the third mismatch with the terminal rejection. Until then, the guest
three-attempt claim is not reliable across hibernation.

## Owner-phone begin can reveal whether a supplied number matches stored state

The device-signed enrollment route deliberately accepts the full phone only
from a holder of the enrolled private device key. Once an enrollment exists,
`begin` returns `active` or `pending` for the stored number and `conflict` for a
different number. A compromised device key can therefore test phone-number
guesses; while pending, the matching request also replaces an unused live
response. The random request salt added by PR #31 prevents an observer from
testing guesses against the signed body hash, but it does not remove this
authenticated response oracle.

Changing retry semantics affects recovery when the owner loses a displayed
response, so the reviewer left this as a design choice rather than a merge
blocker. Before calling goes live, decide whether a pending begin should return
one indistinguishable state and wait for expiry instead of rotating the code.

## PR #28 evidence-store guards include deliberate redundancy

The local live-smoke evidence store checks its evidence directory with both
`isDirectory()` and `isSymbolicLink()`. On the Windows 11 target with Node 24,
`lstat()` reports a directory junction as `isDirectory() === false` and
`isSymbolicLink() === true`. The junction refusal therefore remains effective
if either half is removed, so the Windows regression pins the refusal but
cannot mutation-pin the `isSymbolicLink()` half by itself. Keeping both makes
the intent explicit and covers platform-specific metadata differences.

The evidence commit also hashes the temporary file immediately before its hard
link and hashes the linked final file afterwards. Either check detects the
ordinary tamper case, so removing one alone survives the suite; removing both
does not. The second read covers a narrower change-during-link window that is
not deterministically injectable through the current file-store interface.

## R1 terminal cleanup retries are bounded

PR #23 requests `#rc=2&rp=ct,rt,5xx` on outbound status callbacks and both
Connect action callbacks. This closes the default-policy gap: Twilio's
default retries connection failures, not HTTP 503 cleanup failures.
The fixed fragment is excluded from HTTP signature verification. Two retries
within the voice webhook deadline do not guarantee cleanup after a prolonged
outage, and account Webhook Rules can override the URL policy. D1 terminal
state remains authoritative and fail-closed throughout; a later callback or
socket lifecycle event can still be needed to stop the live DO. R1 item 3
must observe actual delivery for both paths before acceptance, per the
[voice runbook](docs/runbooks/voice-smoke.md#terminal-cleanup-delivery-r1-item-3)
and [Twilio's documented overrides](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides).

PR #23's relay harness calls DO methods directly with an injected factory;
PR #25 now tests the default production stub/socket and Worker composition
with external HTTP stubbed. Live Twilio delivery remains item 3 acceptance.
The delayed-initialization test's `call_session_termination_uninitialized`
workerd diagnostic is expected and traced, not a swallowed production error.

## Current R0 checkpoint, 2026-09-11

PR #5 `edac272` supersedes the historical CI failures below. Codex reviewed
the exact head and found no merge blocker; all seven jobs were observed
green. [Review and limitations](docs/reviews/r0-pr5-edac272.md), including
the inherited Linux skip/manual extended suites and an independent persistent
Windows-handle retry probe. The transient race explanation is plausible,
not a locally reproduced root cause.

Items 6/7 wiring was reviewed by Claude Opus 5 at high effort, merged in
PR #6, and is now deployed. No security check or existing assertion was
loosened. Gateway health is coarse HTTP liveness with a per-isolate rate
limit; it is not dependency readiness. The hourly archive run claims its
hour without GitHub configuration, so a credential added later in that
hour is picked up on the next hour. Archive errors fail that run; normal
five-minute gateway heartbeats do not certify hourly archive success.

The baseline gateway test-type backlog is **122 errors**, reproduced in an
isolated `edac272` checkout with the same installed dependencies, and the
same on this branch. No changed file adds a diagnostic. The historical 117
count below must not be used as the current baseline.

**Deployment is complete; live acceptance is not.** PRs #5-#7 are merged;
current main `2b506c8` has green CI. Read-only checks verified migrations
0008-0013 and newer deployed versions listed in HANDOFF. Successful gateway
cron runs and a current watchdog self-row were observed at 05:11 UTC,
but no `cloud-gateway` heartbeat row existed and its DOWN alert remained
open. The real 05:15 cron's heartbeat returned `rejected: status 404` at
05:15:20 UTC, an external unauthenticated POST to the public `/heartbeat`
endpoint returned 401 at 05:19:30 UTC, and the 05:30 cron still returned 404
after both settings had been re-set. Deployed metadata had no public-fetch
flag and no watchdog service binding. **Those two status codes have a single
cause, and it is not the URL and not the secret** -- see the section below.
Sid deferred the whole issue at about 06:00 UTC and took it off R0's exit
test. PR #8 carries the one-line fix and passed Claude Opus 5 high review;
it needs a gateway redeploy, and only a real cron after that proves recovery,
since local mocks cannot establish Cloudflare's same-zone routing behaviour.
Telegram command replies and the scheduled morning digest remain untested.
The external UptimeRobot monitor remains owner-blocked; follow
[the runbook](docs/runbooks/deploy.md). Nothing watches the watchdog until
that external step is complete.

## Historical checkpoints (superseded where noted above)

## Fact projection revalidates each source event once per citing fact

Filed from the PR #16 review, against head `08baca4`. Not a merge blocker and
not a correctness bug — the validation is right, it is just done far more
often than it needs to be. Recorded here so it is fixed before this path sees
real traffic rather than rediscovered as a latency complaint.

`apps/cloud-gateway/src/sync/memory-projection.ts:299-301` calls
`validateEnvelope(event.envelope)` and `sourceText(envelope)` once per
`(fact, source)` pair, even though the event row itself is already cached in
`bySequence` on the line above. `validateEnvelope` re-canonicalises and
SHA-256s the whole payload; `sourceText` runs seven regex passes and an NFC
normalise over it.

A page may carry 32 facts of 8 sources each — 256 revalidations — over at most
32 distinct events (`MAX_UNIQUE_SOURCES_PER_PAGE`). Measured on a signed page
citing 32 events of 60 KB each:

    bodyBytes=29544   256 source entries = 579ms   32 source entries = 186ms

So a single authenticated 29.5 KB request costs about 0.58 s of worker CPU,
roughly eight times what the distinct work requires. Caching the validated
text per `eventSequence` alongside the cached event row removes the factor.

Two things make it worse than a one-off cost:

- `verifyPageSources` runs in `project()` before the cheap replay
  short-circuit in `stage()`, so an exact replay pays the full price every
  time rather than being recognised and dropped early.
- A device holding a valid key can repeat the request indefinitely with fresh
  nonces. Each one is individually legitimate, so nothing rejects it.

The `page.facts.length > MAX_FACTS_PER_PAGE` cap at line 188 is what bounds
this loop, and it is itself untested — deleting it leaves the projection suite
green. Without it the 64 KiB body limit alone would admit roughly 300 minimal
facts at 8 sources each, about 2,400 revalidations in one request.

## CI type-checks only Windows, so every Linux branch is invisible to mypy

`.github/workflows/ci.yml:117` runs `uv run mypy --platform win32 jarvis_local`,
and that is the only type check the local agent gets. mypy narrows
`sys.platform` under `--platform`, including the `.startswith("linux")` form,
so **any body guarded by a Linux platform test is treated as unreachable and is
never checked.**

Proven rather than reasoned about: putting `broken: int = "..."` inside a
`sys.platform.startswith("linux")` branch in
`jarvis_local/transport/unix_socket.py` still yields
`Success: no issues found in 51 source files`.

This matters more with every R2 commit, because R2 is the Linux milestone and
the guarded branches are the security checks — socket and parent ownership,
`SO_PEERCRED` peer identity, the Linux file-key sealing path.

**The cheap fix, per call site, is to put the platform test behind a function**
so mypy cannot narrow it and both branches stay checked under either platform.
`jarvis_local/crypto/device_keys.py` already does this and it works:

```python
def _is_windows() -> bool:
    # Kept behind a function so both platform-specific branches remain
    # typechecked instead of mypy erasing one from each platform run.
    return sys.platform == "win32"
```

Verified: with the equivalent `_is_linux()` indirection, the same injected
error is caught under `--platform win32`.

**Adding a `--platform linux` CI job is the real fix and is not free.** Current
`main` fails that invocation with 25 errors across 3 files, 21 of them in
`jarvis_local/transport/pipe_server.py` — Windows named-pipe code that reads as
unreachable on Linux. Getting that job to green is its own cleanup, and it
should not be smuggled into a feature PR.

Raised on PR #12, recurred in PR #13 the same afternoon, which is why it is
written down here instead of being mentioned a third time.

## `/status` prints UTC clock times with no label, in a local-time chat

`apps/cloud-gateway/src/channels/telegram/command-handler.ts:99` renders each
job's last run as `last.finishedAt.slice(11, 16)` -- characters 11 to 16 of an
ISO-8601 UTC timestamp. So `2026-09-11T11:30:40.000Z` becomes the bare string
`11:30`, with nothing saying it is UTC.

Every other time Sid sees is America/Toronto: Telegram stamps his messages in
local time and the digest arrives at 07:31 local. Reading `/status` at 09:16
local on 2026-09-11 therefore showed `drain: ok at 13:15`, which looks four
hours in the future. The same reply's `digest: ok at 11:30` is the 07:30 local
digest he had already received.

The timezone machinery exists and is already correct elsewhere: the digest
resolves `DIGEST_TIMEZONE` and defaults to `America/Toronto`. `/status` simply
does not use it. The fix is to format through the same resolved zone, or to
append an explicit `UTC`; formatting in local time is the better of the two,
because the point of `/status` is a human glancing at whether things ran.

Found on 2026-09-11 while recording R0's exit evidence. **Not R0-blocking** --
the exit condition is that `/status` replies, and it does. Small and
self-contained, but it lives in the app R1 is about to change, so whoever
touches Telegram commands next should pick it up rather than a reviewer
patching it underneath an in-flight milestone.

## The gateway heartbeat 404s: cause found, fix pending deployment

Every gateway cron since deployment logs
`heartbeat: { sent: false, reason: 'rejected', detail: 'status 404' }`.

**The cause is Worker-to-Worker fetch routing, not a wrong URL.** Cloudflare's
documentation: without the `global_fetch_strictly_public` compatibility flag,
a `fetch()` to a URL on the Worker's own zone is routed to the zone's origin
server, *ignoring any Workers mapped to that URL*. The gateway's request
never reached the watchdog's handler, so the 404 came from something that is
not the watchdog and the bearer credential was never evaluated.

This reconciles what looked contradictory: an unauthenticated
`POST /heartbeat` from outside the account returns 401 because it enters
through the front door, while the gateway's fetch to the identical URL
returns 404 because it never arrives. It also explains why an interactive
and a piped re-set of the URL failed identically — the stored value was
never the variable.

An earlier version of this entry claimed the stored URL was wrong and named
tailing the watchdog as the next step. **That was incorrect**, asserted with
more confidence than the evidence supported, and is corrected here.

The fix is one line in `apps/cloud-gateway/wrangler.toml` enabling the flag.
It is **configuration, not a secret**, so it requires a redeploy rather than
a `secret put`, and only a real cron after that deployment proves recovery.

Deferred on Sid's decision of 2026-09-11 and removed from R0's exit test.
That decision was made while this was an open-ended hunt; it is now a known
one-line change, but whether to act now or at the end of the project remains
his call. While it stays broken it costs one stale DOWN notification and the
watchdog not actually watching the gateway. The watchdog's own health, its
alert delivery, the gateway's crons and the hourly archival are unaffected.

## Expect one DOWN alert on a first watchdog deployment

The watchdog treats a required component it has never seen as immediately
overdue. If its first check precedes a successful gateway heartbeat, it
alerts `DOWN cloud-gateway -- required component has never reported`.
That startup alert was observed on 2026-09-11. Recovery requires an actual
heartbeat and a subsequent watchdog assessment. The continued absence
documented above is a delivery failure to investigate, not a startup alert
to ignore or suppress by weakening the must-report list.

## A must-report list cannot be empty

`WATCHDOG_REQUIRED_COMPONENTS` unset defaults to `cloud-gateway`; set to an
empty string it fails validation, so watchdog health returns 503 and no
cycle is recorded. There is therefore no way to require zero components.
That is deliberate for R0 -- the gateway must report -- but it means the
lever for changing the list is editing it, never clearing it.

## R0 review follow-up: triaged, one root cause in ten test files

Claude Opus 5 high triaged the escalation of 2026-09-06 (BUILDING.md rung 2).
Every failure was one of two environment assumptions. No product defect.

**The 8.3 alias, 21 of the 24 remote Hermes failures and both deployment
failures.** `d9d59f9` fixed this in `workflow-containment-review5.test.mjs`
only; the other nine Hermes test files and `scripts/test/deploy.test.mjs`
still handed a raw `mkdtemp(join(tmpdir(), ...))` path to the runtime, which
`Assert-LiteralRuntimeRoot` correctly rejects when TEMP resolves through an
8.3 alias (`C:\Users\RUNNER~1\...`). 75 call sites. The tests were feeding
aliased input to a correct check.

**The launcher tag, the remaining 3.** `attestation-contract.test.mjs`
resolves the interpreter the source lock pins as `py -V:Astral/CPython3.11.16`.
That PEP 514 tag belongs to a uv-managed install; `actions/setup-python`
registers nothing under it, so the launcher reported "No suitable Python
runtime found".

**The `EBUSY`, which never appeared in CI.** The fabricated release directory
is named for the pinned `sourceCommit`, so the test passes its binding checks
and really does reach `runLockedSourceVerifier`. PowerShell then opens
`.hermes-runtime.workflow.lock` through `NativeFileGuard.OpenWorkflowLock`
with `dwShareMode = 0` — no `FILE_SHARE_DELETE` — and cleanup using Node's
default `maxRetries: 0` loses the race with Windows handle teardown. It
reproduced only on the owner's machine because on a runner the alias check
rejects the path *before* the lock is ever opened. Canonicalizing without
adding the retry would have traded alias failures for cleanup flakes.

All three are fixed in the branch that carries this note: a shared
`test/fixtures/temp-root.mjs`, `maxRetries` on cleanup deletes, and CI
installing the pinned interpreter through uv. `Assert-LiteralRuntimeRoot`,
`OpenWorkflowLock` and every share flag are unchanged.

Still open: the fabricated-source-root test now reaches the behaviour it
names rather than passing on the alias rejection, so its assertions are
exercised for the first time on CI. Watch it.

## R0 CI corrections pass locally; remote CI remains unverified

Three jobs fail, none for a product defect. Each is a test encoding an
assumption about the machine it runs on:

- `local-agent (ubuntu-latest)`: mypy reports Windows-only symbols
  (`ctypes.get_last_error`, the pipe server's Win32 calls) as missing.
  TESTING.md already notes a Linux run would need `--platform win32`.
- `local-agent (windows-latest)`: `test_the_pipe_is_not_readable_by_everyone`
  asserts the raw SID of the current user appears in the pipe's DACL. The
  GitHub runner is the built-in Administrator, whose entry reads back as the
  `LA` alias, so the assertion fails on a DACL that is in fact correct.
- `hermes-runtime suite (windows)`: `workflow-containment-review5.test.mjs`
  rejects the runner's temp directory because the path contains an 8.3 short
  name (`RUNNER~1`).

Commit `d9d59f9` corrects these three assumptions locally. It uses a Windows
mypy target, normalized DACL trustees with an independent reference pipe,
and native canonical temp parents. A real 8.3 alias is rejected while its
canonical path is accepted; `Assert-LiteralRuntimeRoot` is unchanged.
Remote CI on the fix has not been verified, so item 1 is not closed yet.

## The local agent does not typecheck or fully test on Linux

On Linux, `mypy` reports 25 errors across `crypto/dpapi.py`,
`transport/pipe_server.py` and `vault/setup.py`, and three vault tests fail
(`test_cli.py::test_the_guard_against_touching_the_real_profile_is_actually_watching_something`,
`test_setup.py::test_a_path_inside_the_seed_vault_is_refused_too`,
`test_setup.py::test_the_preferred_root_is_the_profile_known_folder`). All
depend on Windows known folders or Win32 APIs. `d9d59f9` now targets Windows
for mypy, skips the live Windows-profile guard on Linux, and constructs
portable paths in the other two vault tests. The Windows full suite passes
locally; the changed Linux job still needs remote CI evidence.

## `README.md` says vector search; the vector is not semantic

The embedder in `memory/embeddings.py` is a hashed lexical feature vector
and says so in its docstring. The vector index it feeds is never consulted
by retrieval, which is full-text only. Replacing the embedder with a pinned
real model is milestone M2.

## hermes-profile-lock.json records a stale sourceLockHash

`hermes-profile-lock.json` carries `sourceLockHash`
`3f3618bb177da35cab360f4e62c059d28f82cebe14fa98f4582a8c1374ded0d3`, but the
current `hermes-source-lock.json` canonically hashes to
`9dd8a06d7df921dec55652bb0e2c5ab0488702b288abdc2fb505e66271dbb392`. Commit
`c363631` re-pinned the source lock without regenerating the profile lock.

`schemas/hermes-profile-lock-v1.schema.json` still pins the old value so that
it agrees with the profile lock it validates. The attestation and receipt
schemas were repointed at the current source lock, because they are derived
from it at runtime.

Resolving this means regenerating `hermes-profile-lock.json` against the
current source lock, which cascades into every `profileLockHash` binding.
That is an integrity-chain change for the owner to approve, not a mechanical
edit; it is deliberately left open.

## The hermes-runtime suite is excluded from `pnpm test`

`vitest.workspace.ts` runs under the Cloudflare Workers pool, so it cannot
host `apps/hermes-runtime`'s Node-based tests. Run them with
`pnpm test:runtime`; `pnpm test:all` runs both. Until this was wired up,
245 tests -- covering source pinning, SBOMs, and attestation -- were run by
neither the default command nor any CI.

## The hermes-runtime suite is slow

`source-lock.test.mjs` and `workflow-containment-review5.test.mjs` each took
roughly 50 minutes under parallel load. They now run in the manual
**Hermes extended tests** workflow, each in its own Windows job, and are
excluded from regular CI. The runtime cause is not yet investigated, and
the full extended suites have not been run for the R0 correction.

## Tasks 10-13 are unimplemented

No Windows service bootstrap, gateway join, live verification, or release
certification exists. The `Jarvis/` Obsidian vault at the repository root is
untracked by design; the memory design names it an unsupported source vault
that Jarvis must never write.

## Rate limiting and the circuit breaker are per-isolate

`telegramLimiter` and `providerCircuitBreaker` in `apps/cloud-gateway/src/index.ts`
live at module scope, which survives between requests in ONE isolate.
Cloudflare may run several isolates for one Worker, so the configured 30/min
is a per-isolate 30/min and the breaker sees only its own isolate's failures.
Both belong in a Durable Object -- the mechanism already used for call
sessions -- before either becomes load-bearing.

## The autonomy repository's read-back guards are untested

`isAutonomyTier` and `isAutonomyMode` in `autonomy-repository.ts` validate
values read back out of D1. They are defence in depth against a row that the
CHECK constraints make unwriteable, so a mutant planted in either would
survive the suite. Testing them needs the table rebuilt without its
constraints, which was judged too invasive for what it proves.

## The cloud-gateway tests were never typechecked, and 117 errors remain

`apps/cloud-gateway/tsconfig.json` includes only `src/**`, so `pnpm typecheck`
walked past every test in the app. Vitest transpiles without checking types,
so a test could carry a genuine type error and still run green. Two agents
working in different subsystems hit this independently on the same afternoon,
which is how it was found.

`tsconfig.test.json` now covers the test tree and `pnpm --filter
@jarvis/cloud-gateway typecheck:tests` runs it. It reports **117 errors**, all
in test directories written before it existed: `providers`, `sync`, `voice`,
`policy`, `model`, `security`, `archive`, `conversation`, `calls`, `http`, and
one each in `observability` and `channels`. They are mostly implicit `any` on
callback parameters, casts through insufficiently-overlapping types, and
`string` passed where a branded `Ulid` is required.

It is deliberately NOT wired into CI yet, because it would fail on the first
run for reasons that have nothing to do with the change being tested. The
newer subsystems -- autonomy, decisions, projects, deadlines, scheduler,
digest -- typecheck clean, so the backlog is bounded and does not grow with
new work. Clear it, then make the script a gate.

## Google Classroom due dates: UTC contract selected; live display check remains

`classroom-client.ts` converts Classroom's separate `dueDate` and `dueTime`
fields into one instant. The [official CourseWork reference](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork)
says the timed pair is UTC. The R5 code candidate therefore removes the local-
time interpretation switch and always stores timed work as that documented UTC
instant. A date with no time is still resolved to 23:59:59.999 in
`DIGEST_TIMEZONE`, because the API supplies a calendar day but no instant.

`DIGEST_TIMEZONE` defaults to `America/Toronto`, which matches the current
owner context but remains configuration rather than API fact. One real
assignment with a teacher-set time must still be checked after deployment to
prove Google's UI and the digest present the same Ontario wall-clock deadline.
Until that live check, the contract is settled in code but presentation is
unverified.

The current schema has only `deadlines.due_at TEXT NOT NULL`. A Classroom item
with a date and no time is conservatively mapped to the end of the local day,
but the store cannot preserve that the source supplied date-only precision.
Native date-only display needs a separate schema migration, claiming the next
number only after another open-PR branch inventory. This PR claims no migration.

## Only an explicit calendar cancellation moves a deadline out of `open`

Brightspace `STATUS:CANCELLED` and `STATUS:COMPLETED` now close the matching
source deadline as `cancelled`. Nothing marks a deadline `submitted` or
`missed`, and a deadline that merely passes stays `open` forever. The
grade/missing-work watch described in the plan is what closes those states,
and it needs separately approved Classroom and Brightspace grade connectors.

A completed Brightspace `VTODO` is therefore stored with the same `cancelled`
status as a teacher-cancelled item. That is correct for stopping deadline
reminders, but the later grade or missing-work watch must not interpret this
status as evidence that the teacher cancelled the work. The deadline schema
does not preserve which of those two upstream statuses produced the closure.

If a cancelled event later returns as live with byte-for-byte unchanged
deadline content, the repository's unchanged path leaves it `cancelled`.
The revised-content path also preserves status, so restoration needs an
explicit reopen rule in a later deadline-status slice; the current feed must
not claim that either form reopened.

A deadline that stops appearing in a sweep is deliberately NOT cancelled: a
calendar export that half-succeeds can return fewer items and is
indistinguishable from a teacher deleting one. One bad export would cancel a
term of real deadlines. It stays open and is reported as disappeared instead.

## Brightspace does not document due-versus-availability iCalendar semantics

D2L documents that calendar feeds export events and tasks, and separately that
availability start/end dates and due dates can all appear in Calendar. The
public documentation does not identify an iCalendar property, category, or
title convention that distinguishes those meanings. Filtering by untrusted
summary text would silently drop real work, so the adapter ingests dated
events/tasks without guessing. Owner-attended live acceptance must compare the
first read-only result with Brightspace before the feed is relied on.

## First on-demand Brightspace load has no Worker-lifetime acceptance evidence

The owner-only `check D2L now` path fetches and ingests the bounded feed inside
the Telegram reply's background task. The source work is capped at 180 live
items and 180 cancellations, but the first load can still combine the feed
timeout with hundreds of D1 statements. Local tests establish the bounds; they
do not establish that a cold production invocation finishes before the Worker
stops background work. Until an attended first-load check measures this, a
cancelled invocation could leave a partial sweep and no Telegram reply. Moving
the refresh to a durable queue is the structural fix if the live check fails.

## Study-coach evidence is not yet integrated with R2 owner controls

The first study-coach slice keeps its weak-area evidence, cited practice and
plain-speech check-in settings in separate operational D1 tables. Direct owner
Telegram turns can correct or forget those operational records, while
forwarded, external-reply, model and feed text cannot. A quote of Jarvis's own
message is still a direct owner turn because Telegram adds that quote when the
owner highlights part of Jarvis's response before replying. The R2 channel-neutral
owner-controls service is now merged but is not composed into Telegram, so this
slice deliberately does not depend on it and does not claim that an R2 forget
request reaches these tables. A later reviewed integration must route the same
owner control to both stores without weakening either store's provenance checks.

## Study-coach digest check-ins are claimed before delivery

The first study-coach slice advances `last_prompted_on` while assembling a
daily digest. A failed Telegram delivery can therefore spend that check-in
without showing it, and the manual `/digest` path also spends it even though
the scheduled digest has not run. Moving the claim after delivery requires a
durable candidate/receipt boundary so a post-send write failure does not turn
an at-least-once cron retry into a duplicate digest. Until that boundary is
designed, check-ins are useful prompts but are not guaranteed delivery.

## Study-coach retirement and forget controls are one-way

The first study-coach slice supersedes active owner and practice evidence after
30 days, as well as when it must make room under the active-evidence caps.
`superseded` is terminal, so an old point cannot return to the operational view.
The plain-speech forget control is narrower still: it requires the exact
"forget that X is/was a weak spot" shape, affects only active evidence, and has
no undo. The immutable source history remains available for a later reviewed
recall/control integration, but the current study-coach snapshot, summaries and
check-ins do not expose those retired or forgotten points.

## Must-report gap: deployed, gateway delivery still needs verification

R0 item 6 adds `WATCHDOG_REQUIRED_COMPONENTS`, default `cloud-gateway`.
It alerts on absent heartbeat rows, deduplicates delivered alerts and
recovers on first heartbeat. Invalid configuration returns 503; no synthetic
liveness row is written. PR #6's code and tests are reviewed, merged and
deployed. A missing gateway row now raises a real alert rather than staying
silent; it is not evidence that the gateway reporter is delivering.

## Nothing watches the watchdog

If the watchdog's own cron stops firing, no code is running to notice. Each
cycle writes its own row after the assessment and `GET /health` returns 503
once that row is older than 900s -- **but that only helps if an external
uptime monitor polls it, and no such monitor exists.** Until one does, the
watchdog is unwatched. A second timer inside the same Worker would share the
fate of the first.

The one self-check that does work: because the self-row is written after the
check, a cycle that does run finds its own stale row and alerts. That catches
intermittent cycle failure and can never catch total failure.

## The watchdog's alert path can be configured and still broken

`/health` reports `alert_channel_not_configured` only when settings are
missing. A revoked bot token or a blocked chat produces alerts that are
retried and never delivered while `/health` still reports the channel as
configured.

## One shared heartbeat secret for every component

Anything holding `WATCHDOG_HEARTBEAT_SECRET` can heartbeat as any component
name, including creating new ones and including `watchdog` itself. A
compromised local agent could mask a gateway outage. Per-component credentials
would fix it.

## Two transcribed copies must be kept in step by hand

The watchdog imports nothing from the gateway, deliberately. The cost is that
`apps/watchdog/test/liveness-schema.ts` duplicates `0012_liveness.sql`, and
the wire shape in `apps/watchdog/test/heartbeat.test.ts` duplicates
`heartbeat-reporter.ts`. Both say so in their own comments. Nothing fails
until production does.

## The named pipe's DACL is proven against anonymous, reasoned about for a second user

`transport/pipe_server.py` builds an explicit security descriptor, because
the default is genuinely unsafe: a pipe created with a null descriptor reads
back granting FILE_GENERIC_READ to Everyone and Anonymous.

Two separate things are measured. That the descriptor is **applied** -- read
back off the live handle, with a default-descriptor pipe created alongside as
a control, since asserting `WD` is absent proves nothing until the same
instrument has been shown finding it present. And that it is **enforced** --
an anonymous-impersonation knock opens the default pipe and is refused by the
restricted one. A DACL that is present but never consulted passes the first
and fails the second.

**What is not established: that a second logged-in Windows user is refused.**
That principal cannot be created without changing the machine. It is denied
by the same DACL through the same access check that demonstrably refuses
anonymous, but that step is reasoned rather than measured.

## The Windows agent still has no service host

There is no `jarvis service` command or Windows service host. The Linux
foreground `jarvis node` bootstrap and Unix control transport are the R2
item 2 candidate in [PR #13](https://github.com/ksid1229-ops/jarvis/pull/13).
That work composes the existing memory cycle; it does not install a Windows
service or establish live operation on the owner's Linux server.

## Vault observations are NOT upload-ready: no redactor runs

This is the most important gap in the vault adapter. `RedactionV1` is always
`status="none"` with no markers, and note text is stored verbatim. The design
requires the foundation classifier and redactor to run over every observation
and to REFUSE a note whose secrets it cannot remove.

It is safe today only because there is no sync client: nothing uploads a
vault observation anywhere. **Building the upload path before the redactor
would ship the owner's notes to the gateway unredacted.** The redactor is a
prerequisite for O2/O3/O4, not a follow-up to them.

`display_label` has the same status: it is guaranteed not to be path-shaped,
which is not the same as being redacted.

## Vault write-once is create-new-only, not fenced

`O_EXCL` is a real kernel guarantee that no existing file was overwritten.
It is not the plan's guarantee. Specifically:

- It does not guarantee the file landed in the directory that was validated.
  A junction swapped in between the containment check and `os.open` redirects
  it. There are no retained handles, so **every location check is
  time-of-check-to-time-of-use**: the Git, cloud-sync, reparse and drive-type
  checks describe the filesystem at the instant `inspect()` returned.
- There is no no-delete-sharing fence, so another process can delete or
  rename a published file between creation and receipt.
- Torn-read detection is stat-bracketing (size, mtime_ns, file index, before
  and after) rather than a share-mode fence plus USN validation. A writer that
  completes wholly between the two stats with all three unchanged is
  undetectable.
- Projection recovery matches by content hash, because no object identity is
  available. A pre-existing byte-identical file would be adopted as the
  operation's output.

All of these close when the Rust/PyO3 bridge lands. Until then the adapter
meets a weaker guarantee than the plan states, and it must not be described
as meeting the plan's.

## Vault: no USN journal, so every sync is a full walk

No watcher, no generations, no lower/upper watermarks, no durable change
hints, no replay. A rename is always tombstone-plus-new-document -- the plan's
fallback, never its file-identity path. Root identity is `st_dev:st_ino` from
`os.stat` rather than a 128-bit NTFS file id from a held handle, so
`jarvis vault doctor` can NOTICE a moved or replaced root. Noticing is not
preventing.

## Vault: `project()` has no authority gate

The write path exists and nothing but tests calls it. There is no
`VerifiedExportDecision`, no active-fact recheck and no capture decision in
front of it. Wire a caller to it and facts reach the vault unauthorized.

## Vault: NTFS enforcement is Windows-only, cloud-sync detection is heuristic

Off Windows the filesystem probe reports nothing and the policy accepts the
root. Cloud-sync detection uses directory names, marker files and environment
variables -- there is no Cloud Files placeholder or reparse-tag check, so a
renamed sync folder or an unlisted client is not detected.

## Vault: a file Jarvis published is re-observed as user-authored

Origin is always `user_authored`. The models and schema enforce that a
`jarvis_projection` observation must cite a receipt, so nothing states a
falsehood -- but the reconciler does not consult the receipt store, so
Jarvis's own notes come back through reconciliation attributed to the owner.

# Credentialed voice smoke gate

This runbook covers the R1 fake calling gate and the separate live-evidence contract. The fake harness exercises local routes, D1, Durable Objects and the calling services with fake providers. It cannot place a real call. PR #25 passed max review, merged and deployed as gateway `28109492` after migration 0015. The merged owner runtime now requires the [spoken passphrase step-up](../superpowers/specs/2026-09-14-owner-call-passphrase-design.md), but that boundary does not protect production until its reviewed migrations and Worker revision are rolled out and an owner verifier is generated. Calling remains disabled until those steps, the Twilio configuration and the owner's explicit outbound activation are complete. The live command still needs an injected driver and an enrolled-operator evidence query.

## Offline developer workflow

Run the fake calling matrix and its typecheck, then the focused live-evidence contract tests:

```powershell
pnpm test:voice-access
pnpm typecheck:voice-access
pnpm test:voice-smoke
```

Confirm the default command is non-live and skipped:

```powershell
pnpm smoke:voice -- --scenario inbound
```

The command must return `{"status":"skipped","reason":"live_execution_not_authorized"}`. It performs no network request, CLI call, evidence write, provider mutation, or paid action.

The release gate runs its own failure-propagation tests, the fake calling matrix, and only then audits the six fixed files under `tests/acceptance/live/evidence/`:

```powershell
pnpm release:voice-gate
```

A failed fake gate stops the sequence before the evidence audit. Missing, duplicate, malformed, unsafe, non-passed, or mixed-commit evidence also exits nonzero. All six scenarios must carry the same exact `commitSha`. The evidence audit proves internal evidence-set coherence only; the later release layer must compare that SHA with the deployed release candidate. A fake pass or skipped developer smoke never satisfies live acceptance.

## Fake acceptance coverage and limits

`pnpm test:voice-access` uses the checked-in test selection in `scripts/voice-release-gate.mjs`:

| Requirement | Evidence exercised locally |
|---|---|
| Owner inbound and outbound step-up | Exact passphrase requirement and Passed-A classification, durable attempts, no authority/model/context before success, fixed rejection/end/alert handling, dormant inbound-only waiver, and outbound waiver refusal |
| Guest activation and isolation | Real four-digit verifier, pending-to-active grant, separate principal history, another guest's PIN refused |
| Unknown and ungranted callers | Signed requests refused before relay initialization, PIN work or conversation |
| Guest capabilities and changing grants | Capability/owner-operation contracts, revocation and PIN rotation before the next turn, cross-session proof rejection at the internal authority boundary |
| PIN secrecy | No console records during successful or rejected DTMF entry (including individual digits); whole candidates absent from replies, frames, model context, events, grant events, provider events, call sessions, DO storage, conversation turns and attempt reservations |
| Interruption and model timeout | Cancelled stream, no delivered-history claim, real 30-second total deadline, next turn usable |
| No-answer and terminal callbacks | No redial, atomic receipt/state updates, exact provider binding, repeatable live cleanup |
| Admission races and retention | Callback before/after initialization, real archive sealing/purge with the receipt retained |
| Oversized relay frames | Valid JSON passed directly to the DO method: 65,536 UTF-8 bytes permits a subsequent turn; 65,537 closes with 1009 and adds no turn |
| Telegram self-call | Real webhook, stored command origin, policy/dispatch, owner-only confirmed request, replay and expiry |

The broad relay harness injects a core factory and calls `fetch` and `webSocketMessage` directly inside `runInDurableObject`; it does not send incoming frames through the production stub/socket path. Providers and mutable policy inputs are fake. A separate item 1 test project calls the real namespace stub, upgrades a WebSocket and sends client frames through the default factory. Owner and PIN-authenticated guest turns survive real Durable Object eviction; a failed balance read prevents a second model request and turn. The same project drives actual Worker ingress, signed TwiML/callback routes, confirmed Telegram dispatch and terminal closure of real sockets. It uses isolated public synthetic configuration and stubs external provider HTTP only. A regression keeps the ordinary project's missing-configuration checks intact. These checks do not establish deployed behavior, phone audio latency, Twilio playback acknowledgement or owner acceptance. The required R1 review is Claude Opus 5 at max.

Guest acceptance tests have explicit 15-second deadlines for real PIN crypto and multiple local round trips under the parallel Windows suite. Assertions and the model's 30-second deadline are unchanged. A passing full-suite run is a sample, not proof of deterministic timing. The delayed-initialization callback test intentionally causes the real uninitialized DO RPC to reject; workerd prints `call_session_termination_uninitialized` before the asserted 503 and successful replay. Other errors are not suppressed.

## Telegram self-call contract

R1 supports calling the owner's configured, verified phone. `/call check in` asks for confirmation; `/call check in --confirm` authorizes that self-call. The reason must be nonempty and the command must fit on one line. Arbitrary recipients and guest-triggered calls are outside R1.

The accepted Telegram event supplies the command ID and a domain-separated SHA-256 binding of the authenticated principal, stored as 32 numeric bytes. This structural attribution does not pass through message redaction, which could otherwise collapse distinct IDs containing six-digit runs. It creates no exception to the redaction-token contract. Older receipts without this binding confer no calling authority; send a new confirmed command. The committed receipt time starts the five-minute authorization window. Both command construction and policy rechecks read the same validated event, ingress receipt, current Telegram identity and owner voice binding. Reconstruction checks the complete stored line for controls before argument trimming and cannot extend expiry. The reason is not passed to the calling model or used to select a recipient.

An incompletely configured Worker answers `/call` with `Calling is not configured on this deployment.` A configured deployment reconstructs the accepted command, checks stored policy and fresh capacity, and dispatches once. A provider acknowledgement lost in transit is reported as pending; it is not an instruction to repeat the call. The fake acceptance gate tests this distinction. No home node or platform port is required for this cloud-side work.

## Live authorization gates

### Owner voice configuration

Before deploying the reviewed item, configure `PUBLIC_ORIGIN` as the exact
public HTTPS origin and `TWILIO_FROM_E164` as the Twilio number. Supply the
account SID, outbound API key SID/secret, and separate webhook auth token in
`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and
`TWILIO_AUTH_TOKEN`. Set `OWNER_PRINCIPAL_ID` to the exact principal from the
active owner device row. Set `OWNER_VOICE_IDENTITY_ID` to the new, previously
unused identity ID selected by the owner-phone enrollment runbook; after
enrollment, require that exact identity to be active and verified.

The model/Telegram bindings, the canonical 32-byte guest-PIN,
authentication-budget, identity-challenge and owner-passphrase peppers, and
explicit `IDENTITY_CHALLENGE_HMAC_KEY_VERSION` are required before dialing.
The key version must match challenge issuance. Configure the capacity values
below, then apply only the approved migrations. The outbound control row starts
disabled and requires the owner's separate activation step described below.
No command here authorizes a paid call or changes secrets automatically.

Configure the Twilio number's incoming voice webhook as POST to
`<PUBLIC_ORIGIN>/voice/inbound`. The outbound adapter supplies its own exact
TwiML and status URLs. Its REST acknowledgement deadline is five seconds and
ring timeout is thirty seconds; an ambiguous acknowledgement never triggers
automatic redial. Verify actual provider behavior during item 3.

Inbound signatures are checked before capacity reads or owner alerts. The
verified form passes directly to admission, consuming the request body once.
Status/relay-ended cleanup requires the public origin and webhook auth token,
but remains available when model or capacity configuration is absent.

### Capacity observations and the DeepSeek reserve

R1's collector is an admission dependency, not a billing ledger. Production
composition must supply every configured provider and owner budget before
opening the routes. The collector, durable Telegram sink and configuration
factory and final-turn capacity checks are implemented and wired into Worker
admission and production outbound dispatch. Real paid acceptance is still pending.

| Resource | Observation | Units and limits |
|---|---|---|
| D1 | `SELECT 1` result `meta.size_after` from the database binding | Measured database bytes, including SQLite structure. Not a sum of archived payload sizes. |
| R2 | Every page of `ARCHIVE.list`, all prefixes, sum of object sizes | Estimated completed-object payload bytes. Includes orphan objects, but is not an atomic snapshot during concurrent writes and excludes unfinished multipart uploads. Not billed GB-months. |
| Prepaid model | DeepSeek `/user/balance`, selected currency, `is_available` and complete consistent balance record | Reported remaining credit. `used = configured allocation - remaining`, `budget = configured allocation`. No refills or grants above the declared pot are supported. |
| Postpaid voice | Twilio `Usage/Records/Today.json?Category=totalprice` | Reported cumulative spend for this account and UTC day in its configured currency. Preserve `as_of`; fetching an old report does not make it fresh. Charges not yet reported are not measured. |

The provider direction is configured separately from its reader. Future
postpaid model providers can use reported spending through the same
`CapacityEstimate` shape; that does not switch the model endpoint in R1.
D1/R2 budgets are owner-selected byte limits. Provider allocations and caps
are owner-selected monetary amounts, with no source-code budget default.

Failed reads, missing currencies/pages, inconsistent or malformed values and
stale observations refuse admission. HTTP reads have a five-second total
deadline, including body reads, with a 65,536-byte response bound and no
redirects. A full collection has a ten-second deadline; R2 refuses more than
100 pages instead of reporting a partial sum. Balance and storage observation
times are sampled before the read/scan, never after it. Twilio keeps the
provider's actual timestamp. The final guard also checks age after alerts.

The owner's DeepSeek choice is a one-time $20 pot with provider auto-recharge
off. The collector reports `used = configured allocation - remaining credit`.
Voice calls and turns remain admitted while every fresh estimate is below
100% of its configured limit; admission stops at 100% or when a provider
refuses. Telegram text and `/sync/distill` have no capacity gate.

Every D1, R2, model and Twilio estimate sends owner Telegram warnings at 85%
and 95%. These warnings are advisory: a failed or leased send retries through
the durable receipt path but never refuses work. Falling below a threshold
rearms that crossing. The former 70% warning and separate $1 DeepSeek notice
are removed.

There is no reserve margin or promise that an admitted call can finish. A call
may end mid-conversation when credit reaches the limit. Interrupted requests
still cost money; the next read sees reported charges. Concurrency, reporting
delay and other account consumers can overshoot the last accepted report.
The guarantee is **stop at the configured limit or provider refusal**, not a
durable reservation or spend ceiling. See DECISIONS.md. Keep Twilio
auto-recharge disabled as selected by the owner.

Source contracts: [D1 result metadata](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[R2 listing](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[DeepSeek credit](https://api-docs.deepseek.com/api/get-user-balance/),
[Twilio usage records](https://www.twilio.com/docs/usage/api/usage-record).

### Owner capacity configuration and durable alerts

Each binding below is mandatory for production capacity admission. Missing,
zero, negative or malformed values refuse construction without reading any
provider. There are no fallback amounts. Storage budgets must be integers.

| Binding | Owner value |
|---|---|
| `CAPACITY_D1_BUDGET_BYTES` | D1 byte limit selected by the owner |
| `CAPACITY_R2_BUDGET_BYTES` | R2 completed-object payload byte limit selected by the owner |
| `CAPACITY_MODEL_ALLOCATION_USD` | The owner's one-time prepaid allocation, currently 20 |
| `CAPACITY_TWILIO_DAILY_BUDGET_USD` | Owner-selected Twilio account spending cap for each UTC day |

Current production telemetry must be strictly less than sixty seconds old; do
not restamp delayed reports to satisfy that bound.

The owner can set each binding using the existing interactive Wrangler flow
from the reviewed checkout, for example:

```powershell
pnpm --dir apps/cloud-gateway exec wrangler secret put CAPACITY_D1_BUDGET_BYTES
```

Repeat for each binding name with the chosen value. Production also needs the
existing model/Twilio read credentials, `TELEGRAM_BOT_TOKEN` and
`OWNER_PRINCIPAL_ID`. The sink resolves the current unique verified Telegram
identity for that principal; it does not accept a new recipient or channel.

**Migration 0015 has a production consequence.** It adds
`capacity_alert_crossings` for acknowledged alert state and recoverable send
leases, a default-disabled `outbound_runtime_controls` singleton, admission
triggers and a terminal-evidence column on existing outbound attempts. It
backfills that column only from affirmative retained status envelopes; missing
envelopes do not free capacity. It is independent of 0014 and does not modify it. Before deployment,
inspect the pending migration list in the reviewed release checkout and apply
only an approved set using the normal D1 migration workflow. Do not apply an
unreviewed neighbouring migration because this one needs a table. Merging code
and rolling back the Worker do not roll back D1 state.

Acknowledged crossings survive Worker reconstruction. Every D1, R2, model and
Twilio percentage warning is advisory. A failed or leased 85% or 95% send
never refuses admission; after its thirty-second lease expires, a later fresh
voice check can retry it. Falling below a threshold rearms that crossing.
Telegram has no provider idempotency key: a delivered message whose response
was lost can be repeated after lease recovery. This is durable suppression of
acknowledged alerts, not an exactly-once delivery guarantee. The five-second
sender deadline keeps a hung transport from holding admission indefinitely.

The call runtime collects fresh capacity for each final conversation turn,
then revalidates the caller's access before allocating or recording the turn.
PIN entry, enrollment, owner access administration, partial speech and the
outbound pre-authentication announcement do not start a model turn. A refused
capacity read closes the relay through its existing fixed failure path.

Interruption cancels an admission wait promptly, so the replacement prompt
does not wait for the old telemetry or authorization read. The old bounded
read may finish in the background, including an already-started owner alert;
it cannot admit the interrupted turn. Cancellation while durable context is
being read also prevents the model request and records a cancelled turn.
Output completed before interruption can finish recording its receipt;
interruption cannot retroactively make that already-sent output unsent.

### Stored outbound controls

These are release instructions for the reviewed completed item, not authorization
to enable an unreviewed branch. No home-node platform is involved.

After applying the approved migration set and before deploying the gateway,
verify the exact 0015 schema objects:

```powershell
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command "SELECT type, name FROM sqlite_master WHERE (type = 'table' AND name IN ('capacity_alert_crossings', 'outbound_runtime_controls')) OR (type = 'index' AND name = 'outbound_attempts_policy_day') OR (type = 'trigger' AND name IN ('outbound_attempts_terminal_evidence', 'outbound_status_retains_terminal_evidence', 'outbound_event_retains_terminal_evidence', 'outbound_attempts_start_ready', 'outbound_attempts_admission')) ORDER BY type, name;"
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command "SELECT count(*) AS provider_terminal_at_columns FROM pragma_table_info('outbound_call_attempts') WHERE name = 'provider_terminal_at';"
```

Expect exactly eight `sqlite_master` rows: the two named tables, one named
index and five named triggers. Expect `provider_terminal_at_columns = 1`.
Anything else stops the rollout before the Worker deploy; tests and production
use different migration splitters.

Then inspect the default-disabled state:

```powershell
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command "SELECT singleton_id, enabled, quiet_starts_at, quiet_ends_at FROM outbound_runtime_controls;"
```

Expect one row, `singleton_id = 1`, `enabled = 0`, and both quiet bounds NULL.
An absent row or failed read refuses new calls. The owner sets an explicit
paired UTC interval before enabling calls, or deliberately leaves both bounds
NULL for no interval. Bounds use `YYYY-MM-DDTHH:mm:ss.sssZ`; the start is included
and the end excluded. This is one stored interval, not a recurring local-time
schedule. Profile scheduling remains R7. Setting `enabled = 1` is the owner's
live activation step after configuration, max review and smoke authorization.

The owner can stop new outbound admission with:

```powershell
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command "UPDATE outbound_runtime_controls SET enabled = 0 WHERE singleton_id = 1;"
```

This does not cancel a call already admitted or prevent terminal callbacks and
claim recovery. The atomic ready-to-claimed transition rechecks access, both
expiry windows, the database's current UTC day, quiet state, two active outbound
claims and six claims per UTC day. Rejected provider attempts still count for
the day. A claim binds the current phone number; a number different from the
audited destination is not dialed. After the awaited final control read, a
synchronous fence refuses expired windows, clock reversal and day rollover
before the sole provider POST. A refusal at any of those pre-POST checks is
recorded as a terminal rejection and releases the concurrent-call slot. If
that result write itself fails, the conservative response is unknown and the
durable row can remain claimed.

Only affirmative terminal status evidence releases an admitted slot, and that
evidence remains after envelope archival. Missing/archived nonterminal
envelopes and true post-request unknown outcomes continue to reserve capacity.
They are never automatically redialed or erased. Stop the live smoke and set
`outbound_runtime_controls.enabled = 0`, then read the attempt's dispatch state,
claim/resolution times, CallSid and terminal time. Reconcile that window in the
Twilio call log. If Twilio shows a call, do not redial; investigate or recover
its signed callback. If Twilio definitively confirms that no call was created,
an owner-reviewed repair may move that exact attempt to `rejected` with
`provider_permanent_failure` / `invalid_request`, `retry_eligible = 0` and a
canonical resolution time. If absence is uncertain, leave the slot reserved.
These are call-admission counts, not measured charges or spending reservations.

Use the reviewed attempt id in these commands; never infer one from timing:

```powershell
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command "SELECT attempt_id, provider_dispatch_state, provider_dispatch_claimed_at, provider_dispatch_resolved_at, provider_call_sid, provider_terminal_at FROM outbound_call_attempts WHERE attempt_id = '<ATTEMPT_ID>';"
pnpm --dir apps/cloud-gateway exec wrangler d1 execute jarvis --remote --command "UPDATE outbound_call_attempts SET provider_dispatch_state = 'rejected', provider_failure_code = 'provider_permanent_failure', provider_failure_category = 'invalid_request', retry_eligible = 0, provider_dispatch_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE attempt_id = '<ATTEMPT_ID>' AND provider_dispatch_state IN ('claimed', 'provider_dispatch_unknown') AND provider_call_sid IS NULL AND relay_call_sid IS NULL AND provider_terminal_at IS NULL;"
```

The second command is authorized only after Twilio definitively confirms no
call was created. Require exactly one changed row, then read it back. Zero or
multiple changes stop the repair; do not broaden the predicate.

### Terminal cleanup delivery (R1 item 3)

Outbound status callback URLs and both inbound/outbound `<Connect action>` URLs carry `#rc=2&rp=ct,rt,5xx`: two retries for connection failures, read timeouts and server errors. The fragment is consumed by Twilio and excluded from both the delivered HTTP URL and signature calculation. The validators allow only this exact override on the trusted callback routes; query data and other fragments remain refused. See [Twilio connection overrides](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides).

Before the owner-authorized `failure-callbacks` smoke, check whether account Webhook Rules override these URL settings. In the controlled live scenario, induce one cleanup failure after its D1 terminal commit and verify Twilio actually redelivers, signature verification succeeds, the DO closes, and exactly one provider receipt, event and outbox entry remain. Exercise both status and relay-ended callbacks. Local synthetic redelivery is not evidence of provider retry delivery.

Retries are bounded by Twilio's voice webhook deadline (15 seconds); a prolonged outage can exhaust them. Durable terminal state still blocks authority, but live cleanup is not guaranteed until another valid callback or socket lifecycle event arrives. If this live check fails or retries exhaust, stop the smoke and inspect aggregate terminal/cleanup state; do not redial an indeterminate call. A durable cleanup queue would be separate work, not a claim made by this retry policy.

All gates below must pass before an injected live driver may run:

1. A recognized scenario: `inbound`, `unauthorized-caller`, `outbound-answer`, `outbound-no-answer`, `owner-step-up-refused`, or `failure-callbacks`.
2. `--execute-live` and the exact separate confirmation `--confirm-live I_AUTHORIZE_PAID_VOICE_SMOKE`.
3. Local configuration names present: `JARVIS_CLOUD_BASE_URL`, `JARVIS_DEVICE_ID`, `JARVIS_DEVICE_KEY_PATH`, `JARVIS_PRINCIPAL_ID`, and `OWNER_VOICE_IDENTITY_ID`.
4. `jarvis doctor` exit code `0`, obtained through the installed interactive local-agent workflow.
5. Boolean presence confirmation—never secret values or fingerprints—for `DEEPSEEK_API_KEY`, `GUEST_PIN_PEPPER_V1`, `OWNER_PASSPHRASE_PEPPER_V1`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and `TWILIO_AUTH_TOKEN`.
6. An enrolled human smoke-operator proof for authenticated readiness and aggregate evidence queries.
7. A deployed revision matching the evidence `commitSha`, plus the Task 8 fake call gate.
8. The repository driver and fixed local evidence store, with reviewed
   preflight and scenario-execution adapter plus the enrolled-operator
   evidence-query adapter injected by the release operator.

The driver orders the exact preflight, one scenario execution and one aggregate
evidence query, and binds all three to one scenario, correlation ID and deployed
commit. The scenario-driver and enrolled-operator query interfaces both carry
the six-value scenario type, so `owner-step-up-refused` cannot be substituted
with a different call or aggregate query. The driver receives no credentials.
The store creates an exclusive temporary file (`0600` where POSIX modes apply),
publishes it atomically under one of the six fixed names and refuses to replace
retained evidence. Run the explicit cleanup command before an authorized
repeat. On Windows the redacted evidence inherits the checkout directory's
ACL; the store does not claim POSIX mode bits enforce a Windows ACL.

The normal command deliberately does not discover or execute a driver module
from a path or environment variable, and it has no secret-presence adapter.
Release tooling must inject reviewed adapters through `runSmokeCommand`; without
that injection, live flags cannot place a call. This prevents an inherited PATH
entry or unreviewed local file from becoming paid-call authority.

## Redacted evidence contract

Every accepted record is exact-key, scenario-discriminated JSON with
`schemaVersion: "1.3"`, `generatorVersion: "0.1.0"`, `status: "passed"`, a
lowercase 40-hex commit, ULID correlation/event identifiers, and UTC millisecond
timestamps. Unknown keys are rejected, including phone numbers, provider SIDs,
transcript/PIN fields, authorization data, tokens, raw errors, URLs, headers,
and provider bodies.

Every owner-path record names `ownerStepUpOutcome` as `verified`, `refused`,
`waived_passed_a`, or `not_started`, plus its prompt/attempt counts, the
aggregate caller-ID attestation (`passed_a`, `other`, `absent`, or
`not_applicable`), the caller-ID policy, and whether owner authority was
granted. `verified` uses
`authenticationMode: "owner_passphrase"`. `waived_passed_a` is valid only for
an inbound exact `passed_a` observation while
`ownerCallerIdPolicy: "waive_on_passed_a"` is on; it uses
`authenticationMode: "owner_attested_waiver"` with zero phrase prompts and
attempts. This per-record waiver shape is retained only for a future optional
waiver record: it cannot replace the required inbound release record. The six-
record release audit requires `ownerCallerIdPolicy: "passphrase_always"` on
every owner path and a `verified` inbound record. Outbound evidence mirrors the
durable binding with `passphrase_always` and `callerIdAttestation:
"not_applicable"`; it can never use the waiver. Any record with owner authority
also requires `ownerStepUpBeforeFirstModelTurn: true`. The validator rejects a
refused or malformed step-up paired with owner authority, and rejects the
retired `owner_identity_pin_free` schema.

The inbound sample requires 20 authenticated turns, persistence and recall, a clean hangup, at least one interruption, p95 first-audible latency at or below 4,000 ms, and p95 interruption-stop latency at or below 1,500 ms. Inbound and answered-outbound evidence also pins Deepgram `nova-3-general`, Google `en-US-Journey-O`, the exact configured signed WSS representation, DTMF delivery, and callback-schema verification. Answered outbound must report a verified phrase even when the configured inbound caller-ID policy permits Passed-A waiver.

The `outbound-no-answer` record reports `ownerStepUpOutcome: "not_started"`,
zero step-up prompts and attempts, no owner authority, and zero model or
personal-context reads. The `owner-step-up-refused` record is an inbound owner-
path call with three complete wrong candidates, zero to two non-candidate
re-prompts, `ownerStepUpPromptCount` equal to three plus that re-prompt count,
and `ownerStepUpRejectionReason: "attempts_exhausted"`. It requires exactly one
durable rejection row, exactly one rejection-delivery row, and
`ownerAlertDisposition: "sent"`, with zero authenticated turns, model requests,
personal-context reads or owner authority. Start this refusal scenario at least
15 minutes after any earlier owner rejection so its alert cannot be coalesced.
A refusal ending through a third re-prompt (`reprompts_exhausted`) or the
60-second window (`deadline_expired`) is invalid evidence, must be re-run at
additional provider cost, and is a failed paid scenario requiring stop and
review before any retry.
A Passed-A call under an enabled waiver cannot satisfy this refusal scenario
because that call would skip the phrase.

No provider playback acknowledgement has been proven. Evidence therefore accepts only `assistantOutputEvidence: "sent_to_provider_only"` with `assistantHistoryCommitted: false`; it must never claim delivery to the caller.

Answered voice scenarios also retain the exact reviewed Task 5 `ConversationTurnResult`: `outcome: "voice_sent"`, distinct ULID `committedUserEventId` and `sentAssistantEventId` values that are both present in `eventIds`, and `deliveryId: null` plus `deliveredAssistantEventId: null`. The failure scenario requires Task 5's deterministic provider-failure result: `outcome: "failed"`, no sent or delivered assistant event, `modelFailureCode: "model_failed"`, and `modelFailureCategory: "provider"`. `model_outcome_unknown` is deliberately not accepted as proof that the failure path settled successfully.

These fields validate Task 5 only. They do not assert route wiring, call-session state, interruption handling, outbound authorization, callback reconciliation, or the fake end-to-end call path owned by Tasks 6–8.

## Operator sequence and rollback boundary

With Tasks 6–8 integrated, the release tooling must implement this operator sequence: run fake gates; run `jarvis doctor`; verify authenticated readiness; obtain explicit authorization for each paid scenario; run each scenario once; query only aggregate evidence as the enrolled operator; validate and atomically retain the six required redacted records; then run `pnpm release:voice-gate` before release-manifest aggregation. The current store has no retained failed-attempt ledger, so a failed paid scenario remains a stop-and-review event rather than permission to retry until one run passes.

On any failure, stop the release, preserve the last known-good deployment identifier, and do not retry an indeterminate outbound dispatch. Task 10 owns deployment and rollback. Worker rollback must use an explicit schema-compatible known-good version and does not roll back D1, R2, or Durable Object state; migrations remain forward-only or require the separately proven encrypted restore procedure. This Task 9 harness never deploys or rolls back anything.

Remove only generated voice evidence with:

```powershell
pnpm clean:voice-smoke-evidence
```

The cleanup command is local and explicit. It removes only the six scenario JSON files; it does not touch credentials, provider state, deployments, databases, or unrelated operator notes.

## Deliberately not executed here

- No inbound or outbound call, DTMF entry, model request, message, callback injection, or provider-paid action.
- No Cloudflare resource creation, migration, deployment, rollback, secret update, or readiness request.
- No Twilio number/webhook configuration or Telegram mutation.
- No local-agent enrollment, credential prompt, key access, release tagging, or merge.

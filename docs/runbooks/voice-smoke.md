# Credentialed voice smoke gate

This runbook covers the R1 fake calling gate and the separate live-evidence contract. The fake harness exercises local routes, D1, Durable Objects and the calling services with fake providers. It cannot place a real call. Production voice remains closed until R1 item 1 supplies the reviewed runtime dependencies and owner-managed configuration. The live command still needs an injected driver, deployed routes and an enrolled-operator evidence query.

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

The release gate runs its own failure-propagation tests, the fake calling matrix, and only then audits the five fixed files under `tests/acceptance/live/evidence/`:

```powershell
pnpm release:voice-gate
```

A failed fake gate stops the sequence before the evidence audit. Missing, duplicate, malformed, unsafe, non-passed, or mixed-commit evidence also exits nonzero. All five scenarios must carry the same exact `commitSha`. The evidence audit proves internal evidence-set coherence only; the later release layer must compare that SHA with the deployed release candidate. A fake pass or skipped developer smoke never satisfies live acceptance.

## Fake acceptance coverage and limits

`pnpm test:voice-access` uses the checked-in test selection in `scripts/voice-release-gate.mjs`:

| Requirement | Evidence exercised locally |
|---|---|
| Owner inbound and outbound, without a PIN | Signed admission, raw setup, active authority and conversation output |
| Guest activation and isolation | Real four-digit verifier, pending-to-active grant, separate principal history, another guest's PIN refused |
| Unknown and ungranted callers | Signed requests refused before relay initialization, PIN work or conversation |
| Guest capabilities and changing grants | Capability/owner-operation contracts, revocation and PIN rotation before the next turn, cross-session proof rejection at the internal authority boundary |
| PIN secrecy | Successful and rejected candidates absent from replies, frames, logs, model context, both event stores, conversation turns and attempt reservations |
| Interruption and model timeout | Cancelled stream, no delivered-history claim, real 30-second total deadline, next turn usable |
| No-answer and terminal callbacks | No redial, atomic receipt/state updates, exact provider binding, repeatable live cleanup |
| Admission races and retention | Callback before/after initialization, real archive sealing/purge with the receipt retained |
| Oversized relay frames | Raw 65,537-byte frame refused with close code 1009 before model work |
| Telegram self-call | Real webhook, stored command origin, policy/dispatch, owner-only confirmed request, replay and expiry |

The relay event-delivery seam, providers and mutable policy inputs are fake. These tests establish local behavior, not deployed dependency composition, phone audio latency, Twilio playback acknowledgement or owner acceptance. The required R1 review is Claude Opus 5 at max.

## Telegram self-call contract

R1 supports calling the owner's configured, verified phone. `/call check in` asks for confirmation; `/call check in --confirm` authorizes that self-call. The reason must be nonempty and the command must fit on one line. Arbitrary recipients and guest-triggered calls are outside R1.

The accepted Telegram event supplies the command ID and receipt-time principal. Its committed receipt time starts the five-minute authorization window. Both command construction and policy rechecks read the same validated event, ingress receipt, current Telegram identity and owner voice binding. Reconstructing the command cannot extend its expiry. The reason is not passed to the calling model or used to select a recipient.

Until R1 item 1 composes production dispatch, the Worker answers `/call` with `Calling is not configured on this deployment.` A provider acknowledgement lost in transit is reported as pending; it is not an instruction to repeat the call. The fake acceptance gate tests this distinction. No home node or platform port is required for this cloud-side work.

## Future live authorization gates

### Capacity observations and the DeepSeek reserve

R1's collector is an admission dependency, not a billing ledger. Production
composition must supply every configured provider and owner budget before
opening the routes. The collector, durable Telegram sink and configuration
factory are implemented; Worker and turn wiring are still pending.

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

The owner's DeepSeek choice is a one-time $20 pot, then a provider switch in
R7, with no top-ups. At the existing 95% admission cutoff, that configuration
leaves a $1 floor and admission requires **more than** $1 remaining. The 70/85
alerts are migration prompts: **plan the switch**, not overspend warnings.
These amounts describe his selected configuration, not hidden defaults.

The reserve calculation assumes one model API request per admitted turn:
the adapter sends at most 131,072 UTF-8 request bytes and explicitly sets
`max_tokens: 65536`, including reasoning. At the documented 2026-09-13
DeepSeek-V4-Pro peak cache-miss input price of $1.32/M tokens and output price
of $3.96/M, an intentionally conservative 132,000 input-token allowance plus
65,536 output tokens costs about $0.434. Round up to **$0.45 per request**.
The byte-to-token allowance is an engineering estimate, not a verified
tokenizer or billing contract. The wire limits themselves are tested.
A $1 floor exceeds two such requests ($0.90) with $0.10 remaining margin.
Recalculate before changing models, prices or either wire bound.
[Pricing](https://api-docs.deepseek.com/quick_start/pricing/),
[completion bounds](https://api-docs.deepseek.com/api/create-chat-completion/).

This bounds the plausible cost of **one model request**, not an entire phone
conversation with arbitrarily many turns or its Twilio duration. Check credit
again for each turn and before an outbound dial. Interrupted requests still
cost money; the next read sees reported charges. Concurrency, reporting delay
and other account consumers can overshoot. The accepted fresh report must
show **balance above floor**; actual credit can be lower. This is not **spend
under budget** or a durable reservation.
See DECISIONS.md. Twilio's reported-spend threshold likewise cannot account
for charges its API has not reported yet.

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
| `CAPACITY_MODEL_REQUEST_COST_ASSUMPTION_USD` | Reviewed plausible cost per model request, currently 0.45 from the calculation above |
| `CAPACITY_TWILIO_DAILY_BUDGET_USD` | Owner-selected Twilio account spending cap for each UTC day |

The configuration rejects a prepaid floor at or below twice the declared
request-cost assumption. That assumption is reviewed configuration, not a
measured bill. Current production telemetry must be strictly less than sixty
seconds old; do not restamp delayed reports to satisfy that bound.

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
leases. It is independent of 0014 and does not modify it. Before deployment,
inspect the pending migration list in the reviewed release checkout and apply
only an approved set using the normal D1 migration workflow. Do not apply an
unreviewed neighbouring migration because this one needs a table. Merging code
and rolling back the Worker do not roll back D1 state.

Acknowledged crossings survive Worker reconstruction. Falling below a
threshold rearms that exact owner/resource/threshold. An in-progress or failed
send does not count as acknowledgement and refuses the current admission.
After its thirty-second lease expires, a later fresh check can retry.
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

All gates below must pass before an injected live driver may run:

1. A recognized scenario: `inbound`, `unauthorized-caller`, `outbound-answer`, `outbound-no-answer`, or `failure-callbacks`.
2. `--execute-live` and the exact separate confirmation `--confirm-live I_AUTHORIZE_PAID_VOICE_SMOKE`.
3. Local configuration names present: `JARVIS_CLOUD_BASE_URL`, `JARVIS_DEVICE_ID`, `JARVIS_DEVICE_KEY_PATH`, `JARVIS_PRINCIPAL_ID`, and `OWNER_VOICE_IDENTITY_ID`.
4. `jarvis doctor` exit code `0`, obtained through the installed interactive local-agent workflow.
5. Boolean presence confirmation—never secret values or fingerprints—for `DEEPSEEK_API_KEY`, `GUEST_PIN_PEPPER_V1`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and `TWILIO_AUTH_TOKEN`.
6. An enrolled human smoke-operator proof for authenticated readiness and aggregate evidence queries.
7. A deployed revision matching the evidence `commitSha`, plus the Task 8 fake call gate.
8. An injected live driver and evidence store supplied by the later release task.

The current command deliberately has no live driver and no secret-presence adapter. Even with live flags, it cannot place a call.

## Redacted evidence contract

Every accepted record is exact-key, scenario-discriminated JSON with `schemaVersion: "1.2"`, `generatorVersion: "0.1.0"`, `status: "passed"`, a lowercase 40-hex commit, ULID correlation/event identifiers, and UTC millisecond timestamps. Owner scenarios additionally require `authenticationMode: "owner_identity_pin_free"`, zero PIN prompts and zero PIN attempts. Unknown keys are rejected, including phone numbers, provider SIDs, transcript/PIN fields, authorization data, tokens, raw errors, URLs, headers, and provider bodies.

The inbound sample requires 20 authenticated turns, persistence and recall, a clean hangup, at least one interruption, p95 first-audible latency at or below 4,000 ms, and p95 interruption-stop latency at or below 1,500 ms. Inbound and answered-outbound evidence also pins Deepgram `nova-3-general`, Google `en-US-Journey-O`, the exact configured signed WSS representation, DTMF delivery, and callback-schema verification.

No provider playback acknowledgement has been proven. Evidence therefore accepts only `assistantOutputEvidence: "sent_to_provider_only"` with `assistantHistoryCommitted: false`; it must never claim delivery to the caller.

Answered voice scenarios also retain the exact reviewed Task 5 `ConversationTurnResult`: `outcome: "voice_sent"`, distinct ULID `committedUserEventId` and `sentAssistantEventId` values that are both present in `eventIds`, and `deliveryId: null` plus `deliveredAssistantEventId: null`. The failure scenario requires Task 5's deterministic provider-failure result: `outcome: "failed"`, no sent or delivered assistant event, `modelFailureCode: "model_failed"`, and `modelFailureCategory: "provider"`. `model_outcome_unknown` is deliberately not accepted as proof that the failure path settled successfully.

These fields validate Task 5 only. They do not assert route wiring, call-session state, interruption handling, outbound authorization, callback reconciliation, or the fake end-to-end call path owned by Tasks 6–8.

## Operator sequence and rollback boundary

With Tasks 6–8 integrated, the later release tooling must implement this operator sequence: run fake gates; run `jarvis doctor`; verify authenticated readiness; obtain explicit authorization for each paid scenario; run each scenario once; query only aggregate evidence as the enrolled operator; validate and atomically retain the five redacted records; then run `pnpm release:voice-gate` before release-manifest aggregation.

On any failure, stop the release, preserve the last known-good deployment identifier, and do not retry an indeterminate outbound dispatch. Task 10 owns deployment and rollback. Worker rollback must use an explicit schema-compatible known-good version and does not roll back D1, R2, or Durable Object state; migrations remain forward-only or require the separately proven encrypted restore procedure. This Task 9 harness never deploys or rolls back anything.

Remove only generated voice evidence with:

```powershell
pnpm clean:voice-smoke-evidence
```

The cleanup command is local and explicit. It removes only the five scenario JSON files; it does not touch credentials, provider state, deployments, databases, or unrelated operator notes.

## Deliberately not executed here

- No inbound or outbound call, DTMF entry, model request, message, callback injection, or provider-paid action.
- No Cloudflare resource creation, migration, deployment, rollback, secret update, or readiness request.
- No Twilio number/webhook configuration or Telegram mutation.
- No local-agent enrollment, credential prompt, key access, release tagging, push, or merge.

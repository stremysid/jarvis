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
| Guest capabilities and changing grants | Capability/owner-operation contracts, revocation and PIN rotation before the next turn, bound authority proofs |
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

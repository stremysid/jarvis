# Credentialed voice smoke gate

This runbook defines the Task 9 handoff contract. The checked-in harness is intentionally incapable of placing a call: it validates deterministic fake observations, gates future live execution, writes only strict redacted evidence through an injected driver/store, audits retained evidence, and cleans generated evidence. Tasks 5–8, the local CLI, deployed routes, and the enrolled-operator evidence query are prerequisites that are not present on this branch.

## Offline developer workflow

Run the focused contract tests:

```powershell
pnpm test:voice-smoke
```

Confirm the default command is non-live and skipped:

```powershell
pnpm smoke:voice -- --scenario inbound
```

The command must return `{"status":"skipped","reason":"live_execution_not_authorized"}`. It performs no network request, CLI call, evidence write, provider mutation, or paid action.

The offline release audit reads only the five fixed files under `tests/acceptance/live/evidence/`:

```powershell
pnpm release:voice-gate
```

Missing, duplicate, malformed, unsafe, or non-passed evidence exits nonzero. A skipped developer smoke never satisfies the release gate.

## Future live authorization gates

All gates below must pass before an injected live driver may run:

1. A recognized scenario: `inbound`, `unauthorized-caller`, `outbound-answer`, `outbound-no-answer`, or `failure-callbacks`.
2. `--execute-live` and the exact separate confirmation `--confirm-live I_AUTHORIZE_PAID_VOICE_SMOKE`.
3. Local configuration names present: `JARVIS_CLOUD_BASE_URL`, `JARVIS_DEVICE_ID`, `JARVIS_DEVICE_KEY_PATH`, and `JARVIS_PRINCIPAL_ID`.
4. `jarvis doctor` exit code `0`, obtained through the installed interactive local-agent workflow.
5. Boolean presence confirmation—never secret values or fingerprints—for `DEEPSEEK_API_KEY`, `PIN_VERIFIER_JSON`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and `TWILIO_AUTH_TOKEN`.
6. An enrolled human smoke-operator proof for authenticated readiness and aggregate evidence queries.
7. A deployed revision matching the evidence `commitSha`, plus the Task 8 fake call gate.
8. An injected live driver and evidence store supplied by the later release task.

The current command deliberately has no live driver and no secret-presence adapter. Even with live flags, it cannot place a call.

## Redacted evidence contract

Every accepted record is exact-key, scenario-discriminated JSON with `schemaVersion: "1.0"`, `generatorVersion: "0.1.0"`, `status: "passed"`, a lowercase 40-hex commit, ULID correlation/event identifiers, and UTC millisecond timestamps. Unknown keys are rejected, including phone numbers, provider SIDs, transcript/PIN fields, authorization data, tokens, raw errors, URLs, headers, and provider bodies.

The inbound sample requires 20 authenticated turns, persistence and recall, a clean hangup, at least one interruption, p95 first-audible latency at or below 4,000 ms, and p95 interruption-stop latency at or below 1,500 ms. Inbound and answered-outbound evidence also pins Deepgram `nova-3-general`, Google `en-US-Journey-O`, the exact configured signed WSS representation, DTMF delivery, and callback-schema verification.

No provider playback acknowledgement has been proven. Evidence therefore accepts only `assistantOutputEvidence: "sent_to_provider_only"` with `assistantHistoryCommitted: false`; it must never claim delivery to the caller.

## Operator sequence and rollback boundary

After Tasks 5–8 and the release tooling land, the operator sequence is: run fake gates; run `jarvis doctor`; verify authenticated readiness; obtain explicit authorization for each paid scenario; run each scenario once; query only aggregate evidence as the enrolled operator; validate and atomically retain the five redacted records; then run `pnpm release:voice-gate` before release-manifest aggregation.

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

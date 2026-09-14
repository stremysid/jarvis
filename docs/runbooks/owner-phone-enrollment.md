# Owner phone enrollment

This runbook is for the reviewed Option 1 implementation selected in PR #29.
It does not authorize a device-key replacement, secret change, Worker deploy,
Twilio webhook change, database write, or live call. Sid performs those attended
production steps after the relevant pull requests pass Claude Opus 5 max review.

The command runs on the Windows 11 home PC holding the replacement production
device key. It does not depend on the held Linux node work. The gateway route
does not dial a phone or call Twilio; it creates the pending owner identity and
the existing five-minute activation challenge. Phone possession is proved only
when a later signed Twilio inbound call supplies the same number and response.

## Prerequisites and order

1. Merge the reviewed device-key replacement runbook from PR #30 and the
   reviewed Option 1 implementation. Neither branch performs a production
   operation by itself.
2. Follow PR #30's read-only production inventory, generate the home-PC key,
   insert and prove its exact production row, then separately approve revoking
   the orphaned key. Do not start phone enrollment until those checks pass.
3. Deploy the reviewed Option 1 gateway revision while the Twilio voice webhook
   remains unset or redirected to the known closed endpoint.
4. Configure and verify the required Twilio bindings through the voice rollout
   procedure. Do not put their values in command output or evidence.
5. Run the dry preflight below. A mismatch stops the rollout.
6. In one attended window, run the enrollment command, set the signed inbound
   Twilio webhook, make the inbound enrollment call, enter the response, and
   confirm active status. Keep this interval short.

Setting the Twilio voice webhook makes inbound calling live immediately.
`outbound_runtime_controls.enabled = 0` blocks outbound dispatch only; it does
not disable inbound calls. Remove or redirect the webhook to close inbound
admission.

## Dry key-match preflight

From the reviewed checkout on the home PC, with only the four local device
settings available, run:

```powershell
uv run --project apps/local-agent jarvis enroll-phone --preflight
```

The only successful result is:

```text
device key matches the active production record
```

The command loads the existing sealed key and signs a fresh production request.
It never creates a replacement key. The gateway re-derives the current device,
key generation, principal and configured owner identity from trusted state.
The command prints no key, fingerprint, device ID, principal ID, identity ID or
phone number. `device key does not match the active production record` stops the
rollout and returns to the PR #30 checks; do not work around it by generating
another key or editing identifiers.

The preflight does not call a provider, create an identity, create a challenge,
or spend money. A successful result proves the configured key matches the
currently active production row at that request. The normal enrollment command
runs this same preflight again, so the standalone check cannot be bypassed by a
later direct invocation.

## Read-only state check

Before the attended window, run:

```powershell
uv run --project apps/local-agent jarvis enroll-phone --status
```

The fixed public states are:

- `absent`: no configured owner-phone bootstrap exists;
- `pending`: a live response is waiting for its signed inbound call;
- `expired`: the identity is still pending and the response has expired;
- `active`: a fresh database read found the verified active identity and its
  exact owner singleton; or
- `conflict`: trusted state does not match the configured identity, current
  device and single owner. Stop and obtain a reviewed repair; do not broaden a
  query or delete rows by hand.

Status never returns the phone number or trusted identifiers. `pending` and
`expired` are resumable by the same phone. A different phone is refused.

## Attended enrollment

Keep the Twilio webhook closed while entering the number:

```powershell
uv run --project apps/local-agent jarvis enroll-phone
```

The command requires an interactive Windows terminal. It reads the number with
terminal echo disabled, accepts canonical E.164 form, and displays only its last
four digits for confirmation. It sends nothing until Sid types `yes`. The
gateway authenticates the device before interpreting the number, then creates
or exactly resumes the pending identity, owner singleton and challenge in one
D1 batch. It stores the number only in
`channel_identities.provider_subject`; it creates no event or evidence record.

The returned six-digit response is valid for five minutes and is shown only in
the local terminal. Its plaintext is not stored. An exact retry replaces an
unused response; a response already bound to an in-progress call remains bound
to that call. The existing activation budget permits at most three attempts for
one challenge, and each response can be consumed once.

After the command returns a response:

1. Set the reviewed signed inbound webhook while monitoring the rollout.
2. Call Jarvis from the confirmed phone.
3. Enter the six digits when prompted. The activation-only call cannot load
   memory or invoke the model and ends after verification.
4. Run:

   ```powershell
   uv run --project apps/local-agent jarvis enroll-phone --status
   ```

5. Continue only when the fixed result is `owner phone enrollment is active`.
   This result is produced after a fresh database read confirms both the active
   verified voice identity and the singleton binding.

The phone must be active before the later R1 live smoke. Enrollment itself is
not live-smoke evidence and does not satisfy the release gate.

## Failure and rollback

On a preflight failure, stop before configuring the webhook or running begin.
On `conflict`, stop without retrying a different number. On an expired response,
run the same attended command with the same phone to issue a fresh response.

If anything fails after the webhook is set, first remove or redirect the Twilio
voice webhook. This closes new inbound calls; disabling outbound controls does
not. Do not retry an ambiguous provider interaction until Twilio's call record
shows whether that call existed.

The implementation adds no migration, so the reviewed Worker can be rolled back
to its schema-compatible predecessor. A Worker rollback does not remove a
pending or active phone binding. Pending bootstrap rows are durable and guarded;
do not drop triggers or delete the owner singleton to simulate rollback. An
exact pending enrollment can resume later. A wrong-number or foreign-state
conflict requires a separate reviewed production repair before another begin.

After a successful activation, closing inbound still means removing or
redirecting the webhook. Revoking or replacing an active owner phone is a new
identity-security operation and is outside this bootstrap runbook.

## Tests and evidence boundary

The implementation tests the signed production route, exact configured-owner
binding, service-principal refusal, atomic rollback, exact retry, conflict,
revocation races, fixed public states, final fresh read, log/event/response
privacy, Windows prompting, and exact signed client wire. The retained inbound
suite tests Twilio signatures and exact `From`/`To` binding. The retained call
session suite tests activation-only model/memory isolation, challenge expiry,
single use, three-attempt cap, initiating key and call-session binding.

These are local regression checks. Only Sid's attended key preflight, signed
inbound enrollment and final active status establish production acceptance.

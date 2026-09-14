# Owner phone production enrollment options

**Status:** Sid selected Option 1 on 2026-09-14, using a newly generated device
key on his home PC if the original key cannot be recovered. This document
records the decision; it does not itself authorize a production key change,
phone enrollment, live call, secret change, migration, or deployment.

## The blocker

The PR #28 max review reported that production has no `voice` row in
`channel_identities` and no `voice_owner_identity` singleton. The current
Worker therefore has no phone it can admit as the owner or dial for `/call`.
Loading Twilio credentials would not change that result.

Most of the intended verification path already exists:

- `IdentityChallengeService` creates a five-minute, device-key-bound,
  single-use six-digit challenge for an existing pending identity.
- signed Twilio inbound handling binds the provider-observed `From` number to
  that pending identity and admits only an activation-only session;
- `PhoneActivationChallengeConfirmer` consumes the exact challenge after the
  digits arrive over that call; and
- the database trigger activates the pending identity. The activation session
  does not load memory or invoke the model.

Two bootstrap steps are absent: nothing creates the pending owner phone row and
singleton, and `/identity/challenge/begin` is not exposed through a production
route or a Windows CLI command.

Option 1 requires the configured local key to match the active production
device. A configured key path or an arbitrary valid device key is insufficient:
`JARVIS_DEVICE_KEY_PATH` must load a key whose derived public-key fingerprint
matches the active production device record. No original sealed key was found
on Sid's home PC. Sid therefore selected a separate, reviewed replacement of
that production device record with a newly generated home-PC key before phone
enrollment begins. The current `jarvis doctor` checks configuration and
dependencies; it does not perform the comparison. Option 1's implementation
must add a non-disclosing match check that reports only whether the configured
key is the active production key.

## Sid's decision and required order

Sid chose **Option 1, the device-signed Windows CLI path**, with the home PC as
the intended key holder. The work remains split at the trust boundary:

1. Review a separate device-key replacement owner runbook and exact, safely
   refusing SQL for replacing the active production device key. This is a
   separate docs-and-tests PR.
2. After review, Sid performs the read-only checks, creates the new sealed key,
   approves insertion of the replacement device, proves the replacement, and
   separately approves revocation of the orphaned device. None of those live
   steps is performed by this proposal.
3. The non-disclosing local preflight confirms that the configured key matches
   the active production row.
4. Build and max-review Option 1's phone bootstrap route and Windows CLI.
5. Configure Twilio, set the inbound webhook in an attended window, and perform
   the enrollment call only after the implementation and key preflight pass.

## Properties every option must keep

Whichever option Sid selects must meet the same acceptance bar:

1. Bind the phone to the one active human principal and to the exact opaque
   identity configured by `OWNER_VOICE_IDENTITY_ID`. Never let a request choose
   a different owner identity.
2. Prove control of two independent trust channels. A stated phone number,
   Caller ID by itself, or a direct production SQL insert is not verification.
3. Verify the initiating channel before reading or storing a phone number.
   Verify the Twilio signature before trusting `From`, `To`, or call IDs.
4. Create the phone identity, owner singleton, and challenge state atomically
   or leave none of them committed. Exact retries may resume; a different phone
   or principal must refuse.
5. Keep the phone number only where routing requires it: the
   `channel_identities.provider_subject` column and provider requests. Do not
   put it in application logs, events, evidence, command output, or errors.
6. Keep the challenge short-lived, single-use, attempt-limited, and bound to
   the exact initiator, principal, identity, and provider-observed call. Never
   speak or persist its plaintext digits.
7. Require an explicit owner confirmation before any provider operation that
   spends money. The enrollment path remains fail-closed on stale state,
   response loss, or ambiguous provider outcomes.
8. Report `pending`, `active`, `expired`, and safely recoverable conflict states
   without returning the phone number. Activation must never look successful
   until a fresh database read confirms the active verified row and singleton.
9. Work from Sid's Windows 11 PCs and iPhone. It must not depend on the held
   Linux node work.
10. Treat setting the production Twilio voice webhook as activation of inbound
    calling. `outbound_runtime_controls.enabled` gates outbound dispatch, not
    inbound admission. Keep the webhook unset until the selected implementation
    is deployed and Sid is ready to complete enrollment in an attended window.

## Twilio prerequisite and activation boundary

Options 1 and 2 both finish verification through an inbound call to Jarvis's
Twilio number. Twilio must therefore be configured before either enrollment can
complete. The implementation can be built and reviewed without secrets, but
the live sequence needs the number, credentials, signed webhook validation,
and the production voice webhook in place before Sid makes the enrollment call.

Setting that webhook makes inbound calling live immediately. The existing
`outbound_runtime_controls.enabled` switch does not disable or pause inbound
calls. An unknown or unbound caller is refused before entering a normal Jarvis
conversation, but the provider may still charge for receiving and handling the
call. The rollout must keep the interval between setting the webhook and Sid's
enrollment call short and attended, and rollback must remove or redirect the
webhook rather than relying on the outbound control.

## Option 1 — finish the device-signed Windows CLI path

This option is available only after a prerequisite gate proves that
`JARVIS_DEVICE_KEY_PATH` loads the private key matching the active production
device record. The comparison must derive the public fingerprint locally,
compare it with the production record through an authenticated preflight, and
return only a match or mismatch result. It must not print the key or its
fingerprint. Today's `jarvis doctor` does not provide that proof; the selected
implementation must extend it or provide an equally bounded enrollment
preflight.

Add a one-shot `jarvis enroll-phone` command for Windows and one signed gateway
bootstrap route. The CLI would prompt for the number interactively so it is not
placed in shell history, show only a masked confirmation, and send it in a
device-signed canonical request. The gateway would derive the principal from
the verified device and the identity ID from trusted configuration. In one
database operation it would create or exactly resume the pending voice
identity, create the owner singleton, and issue the existing device-bound
challenge. The six-digit response would be returned only to that CLI.

Sid would then call the configured Twilio number from the phone being enrolled
and enter that response. The existing signed inbound, activation-only Durable
Object path, challenge confirmer, and activation trigger would perform the
verification. A signed CLI status read would confirm the final active state.
The legacy eight-digit PIN is not part of this enrollment flow.

This is expected to need no schema migration: the existing tables already
represent the pending identity, owner singleton, device provenance, challenge,
and activation transition. Implementation still needs the atomic repository
operation, production route, signed Python client/CLI, fixed public status
contract, and end-to-end fake tests.

**Advantages**

- Reuses the production activation path and its existing security tests.
- Adds no provider, outbound message, or new challenge authority.
- Keeps the number out of Telegram and works on the enrolled Windows device.
- Has the smallest migration and review risk; no migration is expected.

**Costs and limits**

- Sid must use the Windows PC holding the matching production device key for
  the one-time enrollment.
- The gateway and local agent both change.
- Response-loss and an already-present conflicting pending row need explicit,
  tested recovery behavior.
- If neither PC holds the matching key, this option first requires a separate
  device recovery boundary. Jarvis has no production device-enrollment route,
  and its existing bootstrap service is shaped for a fresh principal and fresh
  identities. Recovery would need to authorize a replacement key, attach it to
  the existing human principal without creating a second human or replacing
  the verified Telegram identity, activate and prove the new device, and only
  then revoke the orphaned device. That is security-sensitive gateway, local,
  persistence, recovery, and rollout work before phone enrollment begins. It
  removes Option 1's claimed simplicity relative to Option 2 even if the phone
  enrollment itself still needs no schema migration.

## Option 2 — begin in verified Telegram, finish by inbound call

Add an owner-only, explicitly confirmed Telegram command that creates a durable
phone-enrollment session and returns a one-time response in the verified owner
chat. Sid would call the Twilio number from the intended phone and enter that
response. The signed inbound webhook would supply the number; Sid would never
type it into Telegram or a PC.

This cannot truthfully reuse the existing challenge row unchanged. Its schema
requires an initiating device ID and key, while this option is initiated by a
Telegram identity. The implementation would need a migration that records the
real initiating authority, plus a database-enforced transition that creates and
activates the owner phone only for the matching Telegram session and signed
Twilio call.

**Advantages**

- Completes enrollment from the iPhone and the already verified owner chat.
- The owner never types or transmits the number outside the inbound call.
- Retains two-channel proof: Telegram possession plus the live phone call.

**Costs and limits**

- Introduces a new challenge authority and a production migration during the
  R1 release gate.
- Reuses less of the already-tested device-bound challenge service.
- Needs careful handling when two callers race for one Telegram session.

## Option 3 — use Twilio Verify from verified Telegram

Add an owner-only Telegram enrollment command that accepts a phone number only
after explicit confirmation, starts a
[Twilio Verify v2](https://www.twilio.com/docs/verify/api) challenge, and
accepts the response in the same verified owner chat. After Twilio's
[Verification Check](https://www.twilio.com/docs/verify/api/verification-check)
reports the challenge approved, one database transaction would create the
active voice identity and owner singleton, followed by a fresh status read.

**Advantages**

- No PC or inbound Jarvis call is needed for enrollment.
- Uses a provider service whose purpose is phone-possession verification.

**Costs and limits**

- Adds a paid provider surface, configuration, failure modes, and a second
  challenge implementation beside the one already in Jarvis.
- The phone number passes through Telegram command processing and needs a new
  no-persistence/no-logging proof across that entire path.
- It does not exercise the signed inbound activation path that R1 will depend
  on immediately afterwards.

## Decision rationale

Sid chose **Option 1, the device-signed Windows CLI path**. It completes the
design already enforced by the repository, uses the enrolled device and
intended phone as separate factors, adds no provider, and is expected to avoid
a production migration. Windows is sufficient because this is a one-shot local
command; it does not depend on the held Linux node work.

The original production key is treated as unavailable. Replacing it adds a
one-time trust step, but that recovery also establishes the home PC as the
intended active device rather than existing only to unlock phone enrollment.
Sid accepted that cost as the cleaner path. Option 2 remains the fallback if
the reviewed replacement cannot be performed safely. Option 3 remains the
weakest fit because it adds a provider and a wider privacy surface while
bypassing the inbound activation path the release must test.

## Selected implementation requirements

For the selected option, start a separate implementation PR and write the
security tests first. At minimum, tests must kill mutations that remove:

- initiator authentication and exact owner/configuration binding;
- atomic creation or exact-resume checks;
- Twilio signature and exact `From`/`To` binding;
- challenge expiry, single-use, attempt, initiator, and call binding;
- activation-only isolation from model and memory access;
- phone-number exclusion from logs, events, responses, and evidence; and
- the final fresh read proving the active identity and singleton.

The implementation PR must also include a dry-run preflight and rollback
instructions. Any required migration, deployment, Twilio configuration, and
the live call remain separate owner-confirmed rollout steps. For Options 1 and
2, Twilio configuration and the inbound webhook must occur before the live
enrollment call; setting the webhook is itself the inbound activation step.

**Decision recorded:** Option 1 with a newly generated home-PC device key. The
runbook, production key replacement, implementation, Twilio configuration, and
live enrollment remain separately reviewed and owner-confirmed steps.

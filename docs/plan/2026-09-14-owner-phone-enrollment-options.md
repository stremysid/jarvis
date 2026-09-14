# Owner phone production enrollment options

**Status:** decision required. This document proposes three designs. It does
not authorize or implement any of them.

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
10. Leave calling and the live-smoke gate disabled until enrollment is active,
    Twilio is configured, the selected implementation passes max review, and
    Sid explicitly starts the live runbook.

## Option 1 — finish the device-signed Windows CLI path

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

- Sid must use a Windows PC for the one-time enrollment.
- The gateway and local agent both change.
- Response-loss and an already-present conflicting pending row need explicit,
  tested recovery behavior.

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

## Recommendation

Choose **Option 1, the device-signed Windows CLI path**. It completes the design
already enforced by the repository, uses the enrolled device and the intended
phone as separate factors, requires no new provider, and is expected to avoid a
production migration. Windows is sufficient because this is a one-shot local
command; it does not depend on the Linux-only long-running node.

Option 2 is the best phone-only design if Sid values iPhone-only setup enough to
accept a new authentication schema and migration. Option 3 has the weakest fit:
it expands provider and privacy surface while bypassing the activation path the
release must test.

## Work only after Sid chooses

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
instructions. Twilio setup, any required migration, deployment, and the live
call remain separate owner-confirmed rollout steps.

**Decision requested from Sid:** choose Option 1, 2, or 3. Until then, do not
build an option or configure Twilio.

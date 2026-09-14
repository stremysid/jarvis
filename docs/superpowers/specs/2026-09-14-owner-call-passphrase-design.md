# Owner call passphrase design

**Status:** Sid approved the product decision on 2026-09-14. This document
defines the security contract. The accompanying tests are intentionally red
against `main`; implementation waits for PR #31 to merge because phone
enrollment supplies the trusted owner identity and recovery path.

**Scope:** R1 owner calls, inbound and outbound. This design does not add a
migration, choose a migration number, make a call, change a secret, deploy, or
build the R2-backed onboarding interview.

## Decision

Every owner call must complete an owner step-up before Jarvis mints owner
authority, reads personal context, invokes a model, or accepts an owner-only
command. The normal step-up is a three-word spoken passphrase. Three complete
wrong candidates reject the call and close the relay. A failed call creates no
persistent lockout.

An inbound call with the exact Twilio value
`TN-Validation-Passed-A` may skip the phrase only when the owner explicitly
sets the caller-ID policy to `waive_on_passed_a`. The code and evidence contract
will support that policy, but the shipped setting is `passphrase_always`.
Missing, empty, or unknown configuration also means `passphrase_always`.
Outbound owner calls always require the phrase.

This reverses the unconfirmed 2026-08-30 statement that the owner accepted
Caller ID risk for a PIN-free experience. A signed Twilio webhook proves the
request came through Twilio. It does not prove that the person who supplied the
caller number is Sid.

## Security claims and limits

Jarvis will keep every passphrase candidate out of:

- conversation transcripts and committed turns;
- model input and retrieved model context;
- events, outbox payloads, provider-event records, and error objects;
- application logs and owner alerts;
- call-session rows and Durable Object storage;
- TwiML, ConversationRelay hints, prompts, and replies.

The raw candidate necessarily reaches Twilio and the configured speech-to-text
processor before Jarvis receives the final text. Their retention is outside
this claim. The prompt and documentation must not imply that the spoken phrase
is secret from those processors.

Only a salted verifier is durable. The Worker secret holding the verifier
pepper is never stored in D1. JavaScript strings cannot be zeroed, so the
candidate stays within one narrow final-prompt stack frame; canonical bytes and
derived buffers are cleared in `finally` blocks before the handler returns.
Fixed errors and prompts contain no candidate or match detail.

The phrase protects private context from caller-ID spoofing, a SIM swap, a
person holding the phone, and an answering machine that accepts an outbound
call. A recording of the correct phrase can be replayed. The optional Passed-A
waiver accepts carrier attestation and therefore retains SIM-swap and
mis-attestation risk.

## Trusted records

Implementation requires one versioned owner-passphrase verifier record bound
to the configured owner identity. It contains the algorithm, domain version,
pepper version, iteration count, random salt, digest, creation time, and active
version. Rotation atomically replaces the active version and emits a fixed
audit event with identifiers and version numbers only.

The verifier construction matches the reviewed guest-PIN construction while
using a separate domain and pepper:

- HMAC-SHA-256 domain separation with `jarvis.owner-passphrase/v1`;
- PBKDF2-HMAC-SHA-256 with 600,000 iterations;
- a random 16-byte salt and 32-byte digest;
- a dedicated `OWNER_PASSPHRASE_PEPPER_V1` secret;
- constant-time digest comparison;
- fail-closed behavior for an unknown algorithm, domain, pepper, or version.

Canonicalization is NFC, lowercase, punctuation removed, and Unicode
whitespace collapsed. The result must be exactly three non-empty words made of
letters. The same canonicalizer is used when creating and verifying a record.
Phrase words never appear in speech hints.

The schema work belongs to the implementation PR after PR #31 merges. It must
use the next unreserved migration number after checking `main` and the newest
`docs/AGENT_LOG.md` entries. R2 owns `0016`; this design does not reserve a
number.

## Binding and authority

Every relay binding gains an immutable owner-step-up requirement:

- `required`: a passphrase proof is mandatory;
- `waived_passed_a`: an inbound exact Passed-A observation satisfied the
  explicitly enabled waiver policy;
- `not_applicable`: guest and phone-activation-only sessions.

The binding snapshots this value before the relay opens. Replaying an inbound
webhook with different attestation or policy cannot change an existing
session. Outbound owner bindings are always `required`.

For inbound calls, the signed form parser classifies `StirVerstat` without
normalization:

- no value is `absent`;
- exactly `TN-Validation-Passed-A` is `passed_a`;
- one other value is `other`;
- multiple values reject the webhook with the same neutral response used for
  duplicated `From`, `To`, or `CallSid`.

Lowercase, padded, prefixed, suffixed, Failed-A, Passed-B, Passed-C, diverted,
passthrough, and unvalidated values never qualify. Adding or changing the field
after signing invalidates the Twilio signature.

A passphrase verifier issues a nominal proof bound to the session ID, CallSid,
direction, verifier version, and verification time. The authority service
consumes it once. D1 records the successful step-up and owner authority in one
transaction. The database trigger refuses an owner authority unless the
session is `waived_passed_a` or has the matching successful step-up row. The
step-up row and binding field are immutable.

This redundancy is deliberate: the Durable Object controls flow, the nominal
proof binds in-process authority, and D1 protects direct or future writers.

## Call state machine

After the relay setup is authenticated, an owner binding marked `required`
stays in `pre_auth` with interaction `owner_step_up`. Jarvis sends the fixed
prompt “Say your passphrase.” No owner authority exists at this point.

Only final speech prompts are examined. Partial prompts, DTMF, interruptions,
and stale frames never verify a phrase. A final value that is not three words
gets a fixed three-word re-prompt without comparison. The existing five-minute
pre-authentication deadline bounds noise and echo that never form a candidate.

Each complete three-word candidate reserves an authentication attempt before
verification. On mismatch, Jarvis clears transient bytes and sends the same
fixed retry prompt. The first and second mismatch remain in `pre_auth`. The
third mismatch moves the durable session to `rejected`, closes the relay, and
sends an owner Telegram alert containing only direction, attestation category,
and time. There is no account or device lockout.

On a match, the verifier returns a bound single-use proof. The authority and
step-up receipt commit atomically; the session then moves through
`authenticated` to `active`. Only then may context retrieval, a model request,
memory access, or owner access administration start.

Eviction reconstructs `owner_step_up` from the immutable binding and durable
phase. It does not store or reconstruct a candidate. Interruption, socket
close, hibernation, terminal callbacks, and errors clear transient buffers.

For outbound calls, the neutral line remains first. The call then enters the
same `owner_step_up` interaction. Voicemail or another person hears only the
neutral line and fixed step-up prompt; their speech cannot reach memory or the
model without the correct phrase.

## Configuration and dormant waiver

`OWNER_CALLER_ID_POLICY` accepts exactly `passphrase_always` or
`waive_on_passed_a`. Production configuration reads it once when composing the
voice runtime. Missing, malformed, or unknown values resolve to
`passphrase_always`; they never prevent startup by accidentally making the
weaker mode necessary.

The initial deployment sets `passphrase_always`. The optional waiver remains
testable but off. Enabling it is a later owner action after retained evidence
shows exact Passed-A across LTE or 5G, home Wi-Fi calling, and Tesla Bluetooth
on different days. Carrier or Twilio-number changes invalidate that evidence
and require the check again.

Attestation observations contain only `passed_a`, `other`, or `absent` plus a
time. They contain no phone number. The voice smoke evidence validator accepts
a waived owner only when the observation is `passed_a` and the policy is
`waive_on_passed_a`.

## Setting, rotation, and recovery

R1 must have a reviewed way to set or rotate the verifier before owner calling
goes live. The immediate recovery surface is the device-signed Windows CLI
from the PR #31 trust path: two hidden entries, exact match, local
canonicalization, and a signed request that sends only the verifier record.
No phrase is accepted from Telegram or a model.

Sid also requested a first-call onboarding session after R1 calling and R2
memory are both live. That later session starts from enrollment-trusted
authority, not caller ID alone. Its deterministic setup segment sets or rotates
the owner phrase and guest PINs without model access; guest PINs use DTMF and
the phrase is entered twice. Only after every security setting has a durable,
verified receipt may ordinary owner authority start the interview. The
interview then asks Sid questions and writes only owner-confirmed answers to
memory.

The onboarding interview is not part of this PR. It depends on R2 and will use
the shared conversation context retriever. Before building it, measure the R2
retriever on the voice path against the existing 30-second model deadline;
additional fact retrieval must not make a call silently time out.

## Tests written before implementation

The design branch adds executable tests against current `main`. They are
expected to fail until implementation lands:

1. An inbound owner session has no authority after relay setup and before a
   successful step-up.
2. An outbound owner session has no authority after the neutral line and
   before a successful step-up.
3. Every candidate is absent from transcripts, model requests and context,
   events, logs, call rows, and Durable Object storage.
4. Three complete wrong candidates reject inbound and outbound sessions and
   close each relay; neither path invokes the model.
5. Exact Passed-A still requires the phrase under absent,
   `passphrase_always`, or unknown policy configuration.
6. The Passed-A waiver works only when explicitly set to
   `waive_on_passed_a`; every other attestation value remains required.

Implementation expands this first red set with unit, repository, migration,
eviction, interruption, concurrency, live-evidence, and mutation tests from
the call-safety research. Each load-bearing guard must have a mutation that
fails its owning test before review.

## Rollout order

1. Merge PR #31 after max review.
2. Rebase the implementation branch on that merged `main` and preserve all
   mailbox entries.
3. Check `main` and `docs/AGENT_LOG.md`, then take the next unreserved
   migration number; never use R2's `0016`.
4. Implement verifier creation and rotation, authority binding, schema guards,
   inbound attestation, outbound step-up, alerts, and live evidence.
5. Run focused tests, mutations, the complete Windows suites, and max review.
6. Configure the pepper and `passphrase_always`, set the phrase through the
   reviewed device path, and keep inbound closed until attended live smoke.
7. Run inbound, outbound-answer, outbound-no-answer, and
   `owner-step-up-refused` evidence. No release claim precedes those records.

The source reports are
[`docs/research/2026-09-14-callerid-spoofing-options.md`](../../research/2026-09-14-callerid-spoofing-options.md)
and
[`docs/research/2026-09-14-outbound-voicemail-options.md`](../../research/2026-09-14-outbound-voicemail-options.md).

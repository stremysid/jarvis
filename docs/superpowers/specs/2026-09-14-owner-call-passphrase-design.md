# Owner call passphrase design

**Status:** Sid approved the product boundary on 2026-09-14. This revision
incorporates the PR #33 max-review decisions and is a documentation-only
contract. Executable security tests move to the later implementation branch.

**Scope:** R1 owner calls, inbound and outbound. This design adds no migration,
reserves no migration number, makes no call, changes no secret, deploys
nothing, and does not build the R2-backed onboarding interview.

## Owner decision and design choices

Sid decided that every owner call, inbound and outbound, requires a spoken
phrase before owner authority. Three complete wrong candidates end that call,
no lockout survives the attack, and the exact Passed-A waiver must exist but
ship switched off.

The phrase format and waiver evidence gate are design choices from the
2026-09-14 call-safety research. Jarvis uses three generated words because
three independent uniform draws from a 2,048-word list provide exactly 33 bits
of entropy. Before the dormant waiver may be enabled, retained live evidence
must show exact Passed-A on Sid's real paths and Sid must accept the remaining
SIM-swap and carrier-attestation risk.

Every owner call must complete owner step-up before Jarvis mints owner
authority, reads personal context, invokes a model, or accepts an owner-only
command. An inbound call with the exact Twilio value
`TN-Validation-Passed-A` may skip the phrase only when the owner explicitly
sets `OWNER_CALLER_ID_POLICY=waive_on_passed_a`. The shipped value, a missing
value, and every malformed or unknown value require the phrase. Outbound owner
calls always require it.

This reverses the unconfirmed 2026-08-30 statement that the owner accepted
Caller ID risk for a PIN-free experience. A signed Twilio webhook proves the
request came through Twilio. It does not prove that the person represented by
the caller number is Sid.

## Security claims and limits

Jarvis keeps every raw candidate, assembled candidate, canonical candidate,
candidate fragment, and unpeppered candidate derivative out of:

- conversation transcripts, committed turns, model input, and retrieved
  context;
- events, outbox payloads, delivery rows, provider-event rows, and archives;
- application and structured logs, owner alerts, errors, and metrics;
- call-session rows, Durable Object key-value and SQLite storage, WebSocket
  attachments, outbound frames, close reasons, TwiML, and speech hints; and
- memory extraction, memory projection, and local synchronization.

The raw candidate necessarily reaches Twilio and the configured
speech-to-text processor before Jarvis receives final text. Their retention is
outside this claim. The product must not imply end-to-end secrecy from those
processors.

JavaScript strings cannot be zeroed. Candidate fragments and assembled text
therefore stay in one call-session instance's memory only and are never
persisted. They are cleared after assembly, on interruption, on lifecycle
change, and on close. Canonical byte arrays, derived HMAC input, and KDF
buffers are cleared in `finally` blocks before the handler returns. Fixed
prompts, refusals, acknowledgements, alerts, and errors contain no candidate or
match detail.

The phrase protects private context from caller-ID spoofing, a SIM swap, a
person holding the phone, and an answering machine that accepts an outbound
call. A recording of the correct phrase can be replayed. The optional Passed-A
waiver retains SIM-swap, possession, and carrier mis-attestation risk.

## Phrase generation and verifier

The phrase is generated, never chosen or typed. A Worker-side CSPRNG performs
three independent, unbiased draws with replacement from a versioned list of
exactly 2,048 common, phonetically distinct `en-US` words. Repetition is valid
and preserves the stated 33-bit space. The list excludes number words, known
speech-to-text split/join variants, non-US spelling variants, and any word that
splits into two CMUdict entries of at least two letters. Hash-ranked greedy
selection permits alternate pronunciations while ensuring that no two retained
words share a CMUdict pronunciation. Hyphenated and long words remain excluded.
Sid may discard a generated phrase and request a complete re-roll.

Canonical phrases contain only lowercase ASCII `a-z` and single ASCII spaces.
The versioned canonicalizer folds ASCII uppercase, strips only its documented
ASCII punctuation, collapses ASCII whitespace, and rejects every other code
point. TypeScript and Python run the same known-answer vectors even though
only the Worker creates or verifies a phrase.

One active verifier record is bound to the configured owner identity. It
stores algorithm, domain version, word-list version, pepper version, iteration
count, random salt, digest, creation time, status, and monotonic verifier
version. It never stores words.

The current `voice_owner_identity` singleton is immutable, so a verifier head
keyed to that identity is sound for R1. Any future phone-identity replacement
must include a reviewed passphrase-head migration rather than repointing or
silently reusing the existing head.

Verifier construction follows the reviewed guest-PIN shape with a separate
domain and secret:

1. HMAC-SHA-256 with `OWNER_PASSPHRASE_PEPPER_V1` over
   `jarvis.owner-passphrase/v1 || 0 || owner_identity_id || 0 ||
   verifier_version || 0 || canonical_phrase`;
2. PBKDF2-HMAC-SHA-256 over that HMAC result with 600,000 iterations, a random
   16-byte salt, and a 32-byte digest; and
3. constant-time comparison, with unknown algorithms, domains, word lists,
   peppers, iterations, or versions failing closed.

The device-signed Windows CLI sends a signed `generate` operation. The Worker
draws the phrase, commits its peppered verifier, and returns the words once for
terminal display. The pepper never leaves the Worker and the phrase is never
sent from the PC. If the one-time response is lost, the owner generates a new
version; no endpoint reads an existing phrase. Rotation is compare-and-swap on
the expected active verifier version, so a captured older signed request cannot
roll the verifier back.

The owner must complete one attended spoken verification of a newly generated
phrase before inbound calling opens. A suspected compromise is handled from
Telegram with the owner-only confirmed command
`/disable-owner-step-up --confirm`. It revokes the verifier and makes every
owner call play a fixed refusal until the signed CLI generates a replacement.
The command never accepts, displays, or replaces a phrase. Rejection alerts
link to this recovery action. Migration `0017` provides this state machine: an
immutable disable receipt is bound to the exact accepted owner Telegram event,
then atomically changes the active verifier to revoked and the head to disabled.
The signed device generates a new monotonic verifier version to re-enable; the
revoked verifier is never restored.

## Trusted binding and attestation

Every relay binding snapshots one immutable owner-step-up requirement before
the relay opens:

- `required`: a passphrase proof is mandatory;
- `waived_passed_a`: an inbound exact Passed-A observation satisfied the
  explicitly enabled waiver; or
- `not_applicable`: guest and phone-activation-only sessions.

Replaying an inbound webhook with changed attestation or policy cannot change
an existing session. Outbound bindings are always `required`.

The signed form parser classifies `StirVerstat` without normalization:

- no value is `absent`;
- exactly one `TN-Validation-Passed-A` is `passed_a`;
- one other value is `other`; and
- multiple values reject with the same neutral response used for duplicated
  `From`, `To`, or `CallSid`.

Lowercase, padded, prefixed, suffixed, Failed-A, Passed-B, Passed-C,
`-Diverted`, `-Passthrough`, and unvalidated values never qualify. Adding or
changing the field after signing invalidates the Twilio signature.

`OWNER_CALLER_ID_POLICY` accepts exactly `passphrase_always` or
`waive_on_passed_a`. Production reads it once during runtime composition.
Missing and empty values require the phrase. Unknown values also require the
phrase and emit one fixed configuration warning that contains no supplied
value. The initial deployment uses `passphrase_always`.

## Durable attempts, admission, and no lockout

A session may consume at most three complete phrase candidates. Before any
KDF work, one durable per-session ordinal is inserted for that session and
lifecycle generation. The row stores no candidate data. Only ordinals 1, 2,
and 3 are valid. The third mismatch and the session's `rejected` transition
commit in the same operation, so hibernation, eviction, reconnect races, or a
crash cannot restore an attempt.

Non-candidate re-prompts use a separate durable per-session ordinal and are
also capped at three. They do not count as phrase mismatches. The pre-existing
guest-PIN in-memory counter has the same hibernation defect and must move to a
durable per-session count in the implementation PR.

The shared five-minute composite and global authentication-attempt budgets do
not reject owner phrase candidates. If verification CPU needs protection, the
runtime serializes or delays work and keeps the same candidate pending; it
does not consume an attempt or reject the call because another call filled a
scope. At most one verification runs for a session.

Inbound `pre_auth` relays cannot consume every outbound-owner admission slot.
The repository must either exclude those inbound sessions from outbound
admission or reserve an outbound-owner path. A confirmed Telegram `/call`
therefore remains available during an inbound spoofing flood.

“No lockout” means no rejection state, throttle, or attempt scope survives the
attacking calls and blocks a later correct candidate. Per-call terminal state,
audit receipts, coalesced alerts, capacity observations, and an explicitly
revoked verifier may persist; none silently becomes a cross-call passphrase
failure. The obsolete foundation claim that a CLI or Telegram command clears
shared authentication throttles is removed because owner step-up does not use
those rejecting scopes.

## Candidate framing and fixed speech

Only final STT speech frames from the current relay session and lifecycle
generation may enter candidate assembly. Frames from an earlier generation,
after a terminal transition, with a mismatched relay/session identity, or
delivered out of sequence are stale and discarded. Partial speech, DTMF,
interruptions, and keypad digits never verify an owner phrase.

Consecutive final fragments may be joined with one space for 1,500 ms from the
first fragment. An interrupt, lifecycle change, or terminal transition clears
the ephemeral fragments. A complete candidate is exactly three canonical
tokens and every token belongs to the active word-list version. Digits,
leading filler, and two-word or four-word values are non-candidates. Once the
assembly window closes, an incomplete value causes one fixed re-prompt.

The fixed phrases are:

- prompt: “Passphrase, please.”
- mismatch retry: “Please try your passphrase again.”
- non-candidate re-prompt: “Please say only your passphrase.”
- success acknowledgement: “Verified.”
- refusal: “Verification failed. Ending this call.”

The outbound neutral line remains “Jarvis called for Sid. No private message
was left.” No fixed utterance may canonicalize to a complete candidate. A
table-driven test enforces that rule, and a final whose canonical form equals
any fixed utterance is silently discarded as echo.

## Step-up window and rejection

The 60-second step-up window begins when the first passphrase prompt is sent.
The Durable Object persists the deadline and lifecycle generation and sets an
alarm for that deadline. The alarm and every incoming frame compare both the
current time and generation before acting. This is separate from the
five-minute unconnected relay-setup expiry and the authentication budget
window; neither of those ends a connected `pre_auth` call.

Three mismatches, three non-candidate re-prompts, or the 60-second deadline
ends the call. Re-prompt exhaustion and timeout record their own fixed terminal
reason and do not masquerade as a mismatch or lockout. The sequence is a fixed
refusal line, a ConversationRelay `end` frame with fixed `handoffData`, and a
signed action callback that returns `<Hangup/>`. A policy WebSocket close is a
fallback only if the clean end cannot be sent.

Tests use a manual clock and prove the alarm's lifecycle-generation check,
including an old alarm arriving after a newer lifecycle began.

## Successful step-up and repeat suppression

A match produces a nominal single-use proof bound to session ID, CallSid,
direction, verifier version, lifecycle generation, and verification time. D1
commits the successful step-up receipt and owner authority atomically, then the
session becomes active. The fixed “Verified.” acknowledgement is sent
immediately after that commit without a model call.

Finals received while verification is in flight and during a two-second guard
window after success are discarded. The first later active final that has the
candidate shape is compared once against the active verifier; if it matches,
it is silently discarded as a likely repeat. A non-match continues as ordinary
owner speech. This prevents a repeated correct phrase from entering
transcripts, archives, memory, or DeepSeek after a slow verification.

Eviction reconstructs the step-up state, deadline, attempt ordinals, and
current lifecycle generation from durable state. It never stores or
reconstructs candidate text.

## Authority and database enforcement

The authority service consumes a successful proof once. A D1 trigger refuses
an owner-authority insert unless the immutable binding is `waived_passed_a` or
a matching successful step-up row exists for the same session, CallSid,
direction, lifecycle generation, owner identity, and verifier version. The
step-up verifier version must still equal the active verifier version, so a
proof issued immediately before rotation cannot mint authority afterwards.
Bindings, step-up receipts, attempt rows, and authority rows are immutable.

This D1 rule protects application writers that attempt to mint authority while
omitting the required step-up. It does not claim to defend against a writer
that can forge both the authority and every matching proof row.

The implementation migration must drop and recreate the existing authority
lineage trigger. Remote D1 trigger bodies use only either `WHEN ... BEGIN
SELECT RAISE(ABORT, ...); END` or `SELECT RAISE(ABORT, ...) WHERE ...`. They
never use `CASE ... RAISE`, which remote D1 rejects.

A waived session receives ordinary conversation authority but cannot use
`access.manage` or change security settings until the phrase also passes in
that call. Every guest-grant create, change, PIN rotation, or revocation emits
a fixed Telegram notice containing only the operation, masked target, and
time.

## Alerts and cost bounds

Rejected step-ups and owner-identity admission refusals alert Sid through the
existing durable Telegram path. The first alert is immediate; later alerts of
the same class coalesce into one count at most every 15 minutes. Alerts never
contain speech, candidates, phone numbers, or raw provider values. Inbound
step-up alerts may contain the fixed attestation category. Outbound alerts omit
that field because outbound has no caller attestation.

Using the research's $0.0785-per-minute list-price assumption, the 60-second
step-up window bounds ConversationRelay pre-auth time to about $0.0785 per
call, before any carrier/setup charge or provider rounding. Interrupted calls
may still cost money. The existing owner-configured Twilio capacity guard
remains the admission boundary. The first landing records pre-auth minutes
separately for review but does not add a rejecting pre-auth sub-budget: such a
cross-call rejection would recreate the lockout this design removes. Live cost
evidence decides whether a later, owner-configured sub-budget is warranted.

## Enrollment and first-call onboarding

The phone-enrollment webhook creates a live caller-ID-only window before this
step-up ships. After the activation status becomes `active`, the enrollment
runbook therefore requires removing or redirecting the webhook immediately,
then rerunning the read-only status command and confirming `active` before
leaving the attended window. Inbound reopens only after the passphrase runtime
is deployed and a generated phrase passes an attended spoken check.

The later first-call onboarding is parked, never performed while driving, and
depends on R2 memory however it is hosted. It is a separate protocol:

1. A device-issued, single-use challenge opens a setup-only call segment with
   no owner authority.
2. Deterministic handlers generate and commit the owner verifier and write
   guest-PIN records. The generated phrase is returned once to the trusted CLI
   display; candidates never enter the model.
3. Sid speaks the new phrase once through the ordinary step-up path. Only that
   normal successful receipt can mint owner authority.
4. After every setting has a durable verified receipt, Jarvis may begin the
   interview and write only owner-confirmed answers to memory.

The interview is outside this PR and must not drive R1 or R2 implementation.

## Voice latency and retrieval

Passphrase step-up adds speech endpointing, one 600,000-iteration verification,
and one D1 commit before a fixed acknowledgement. Repeat suppression also runs
one extra 600,000-iteration verification for the first candidate-shaped active
final. Both KDF paths must be measured in the latency evidence. They are
outside the authenticated-turn first-audible measurement but should add only a
few seconds to call entry.

The shared R2 context retriever is measured against the 4,000 ms p95
first-audible release gate, not the model's 30-second total deadline. Voice
retrieval gets a 750 ms hard timeout. On timeout or retrieval failure, the turn
continues with no extra retrieved context; cancellation still prevents a model
call. The timeout is covered with a manual clock and must be revisited if live
first-audible evidence consumes the remaining budget.

## Implementation test contract

This docs-only branch contains no executable red tests and no fake-harness
changes. The later implementation branch must add
`voice-owner-passphrase-security.test.ts`, include it in the voice typecheck and
release gate, and use only a single targeted `@ts-expect-error` while a typed
port is genuinely absent. It must incorporate the stronger assertions and
proofs in
`claude/r1-call-safety-research:docs/reviews/2026-09-14-pr33-tests/`.

At minimum, tests must prove:

- no owner authority, personal-context read, model call, or owner command
  before step-up, inbound and outbound;
- a correct phrase succeeds, a never-accepting verifier fails, and matching,
  mismatch, rejection, termination, and deferred-work paths leak no raw or
  normalized candidate, fragment, word array, unpeppered hash, byte buffer, or
  structured value to any named sink;
- DTMF cannot authenticate an owner; missing policy is not masked; outbound is
  never waived; and exact attestation rejects duplicates, padding,
  `-Diverted`, `-Passthrough`, case changes, and every non-exact value;
- two wrong candidates, core eviction, and a third wrong candidate produce one
  durable rejection and one coalesced alert;
- split finals, filler, digits, two- and four-word finals, interruption, fixed
  echo, concurrent finals, timeout, re-prompt exhaustion, and post-success
  repeats follow this state machine;
- the clean ConversationRelay `end` and `<Hangup/>` path is used, with policy
  close only as a tested fallback; and
- the disabled waiver remains present, exact, explicit, inbound-only, and
  unable to authorize access management without phrase step-up.

Every load-bearing guard needs a mutation that fails its owning test.

## Migration and rollout order

R2 owns migration `0016`. The implementation branch checks `main` and the
newest `docs/AGENT_LOG.md`, posts its intent there, and takes the next
unreserved number. This document does not reserve one.

1. Merge this documentation-only PR after max review.
2. Create the implementation branch from current `main`; bring over the
   stronger red contract from the review artifact and make each case green.
3. Take the next unreserved migration number and implement verifier generation
   and rotation, durable attempts, authority binding, exact attestation,
   alarm-backed timing, clean termination, alerts, recovery, and evidence.
4. Run focused tests and mutations, the complete Windows suites, and max
   review. Do not treat unavailable GitHub Actions as evidence.
5. Deploy reviewed code and configuration with inbound still closed.
6. Generate the phrase through the signed CLI, complete one attended spoken
   verification, and only then open inbound.
7. Run inbound, outbound-answer, outbound-no-answer,
   `owner-step-up-refused`, and the remaining retained smoke scenarios. No
   release claim precedes all required redacted records.

The source reports are
[`docs/research/2026-09-14-callerid-spoofing-options.md`](../../research/2026-09-14-callerid-spoofing-options.md)
and
[`docs/research/2026-09-14-outbound-voicemail-options.md`](../../research/2026-09-14-outbound-voicemail-options.md).
The caller-ID report's §6.2 reference to migration `0016` is superseded: R2
owns `0016`, and the implementation must take the next unreserved number.

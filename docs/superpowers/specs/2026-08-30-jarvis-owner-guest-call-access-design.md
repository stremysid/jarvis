# Jarvis Owner and Guest Call Access Design

**Date:** 2026-08-30

**Status:** Draft reflecting the owner's approved in-chat design; pending written-spec review

**Scope:** Amend Jarvis voice authentication so the owner's enrolled number is PIN-free and the owner can provision, change, and revoke per-number guest access during an owner call.

## 1. Purpose

Jarvis is first a personal assistant for Sid. Calls from Sid's one enrolled owner voice identity must enter the authenticated owner experience without a reusable PIN. Other people may use Jarvis only after Sid explicitly provisions their exact phone number and assigns a per-number four-digit PIN and permissions.

The feature must feel conversational: during an owner call, Sid can ask Jarvis to add, change, list, revoke, or rotate access for another number. Natural-language model output may propose an administration operation, but it never authorizes or executes one. The cloud session validates the owner identity, presents an exact bounded proposal, obtains explicit confirmation, and alone performs the transaction.

This design replaces the foundation rule that every inbound and outbound call requires one global eight-digit PIN. For call authentication, phone activation, and call-session authority, this amendment takes precedence over the corresponding PIN rules in the foundation design and calling plan. All other signed-request, relay-binding, rate-limit, durable-event, and fail-closed requirements remain in force. The implementation plan must update those older documents in the same change so there is one current contract.

## 2. Binding product decisions

- Exactly one active voice identity is designated `owner`. It is selected by opaque configured identity ID, not by accepting a number supplied in a request or model response.
- The active owner identity bypasses recurring PIN authentication for both inbound calls and outbound calls to that identity.
- Owner PIN bypass does not bypass Twilio signature verification, exact `CallSid` and relay nonce binding, active-identity checks, session limits, action policy, or explicit confirmation requirements for external, destructive, credential, or spending effects.
- An unknown, blocked, revoked, or unprovisioned number is rejected before ConversationRelay and receives no PIN prompt or information about registered callers.
- A guest number is usable only after an owner-confirmed grant exists for that exact canonical E.164 voice identity.
- Every guest has an individual PIN of exactly four decimal digits. There is no shared PIN and no global guest PIN.
- A guest authenticates once per call. A proof is nominal, single-session, and bound to the exact grant version, principal, identity, `CallSid`, direction, and relay session.
- Only the owner identity can manage callers, grants, PINs, permission sets, security configuration, credentials, or the owner identity itself.
- Each guest receives a separate principal, conversation history, memory scope, and permission set. No guest permission grants access to Sid's personal memory by implication.
- Permissions refer only to registered capability identifiers. Granting a name cannot create a tool or enable a capability that is not installed and policy-enabled.
- Voiceprints and speaker verification are deferred. The owner accepts Caller ID possession risk for the PIN-free owner experience.

## 3. Identity and authority model

### 3.1 Owner authority

Configuration names one opaque `OWNER_VOICE_IDENTITY_ID`. At session creation, the repository must resolve the signed provider `From` or claimed outbound destination to an active `voice` channel identity and require its identity ID to equal the configured value. The owner authority is minted only from that stored row and the already verified call/session binding.

Owner authority is not represented as a guest permission list. It grants access to every currently installed Jarvis capability, subject to that capability's ordinary action-specific confirmation and safety policy. It cannot be copied, delegated, serialized into model context, or produced from a phone number string alone.

The initial owner voice identity is activated through the signed local-device enrollment challenge. It does not require the retired reusable eight-digit call PIN. Changing the owner identity remains a local-device recovery operation and cannot be performed by a call or model proposal.

### 3.2 Guest authority

An owner-confirmed grant creates or reuses exactly one non-owner human principal and one exact voice identity for the canonical E.164 number. A newly provisioned identity remains pending until the first successful PIN-authenticated call, then becomes active atomically with the authentication outcome. A revoked identity cannot authenticate, even with an old PIN or an in-flight stale grant snapshot.

Successful guest authentication mints a server-issued `GuestCallAuthority` containing only:

- grant ID and immutable grant version;
- guest principal and voice identity IDs;
- session ID, `CallSid`, and call direction;
- the exact frozen permission identifiers;
- authentication time and an expiry no later than 30 minutes after the provider call connects.

Every permission decision snapshots and validates that nominal authority. The authority becomes invalid immediately on socket close or any terminal call-session transition, even if its timestamp has not elapsed. Model output, prompt text, remembered text, a structurally similar object, another call's proof, and an older grant version are invalid.

## 4. Owner voice-administration flow

The owner may manage access only from an active owner call. Supported intents are:

- add a guest number;
- replace a guest's permission set;
- rotate a guest PIN;
- revoke a guest number;
- list active and pending guests using masked numbers and permission summaries.

The interaction is:

1. Sid states the desired operation, number, and permissions in natural language.
2. The model may return an untrusted proposal conforming to the closed administration proposal schema through a dedicated parse-only response channel. This is not a normal model tool call or external-effect command, and it cannot call the repository, dispatch an action, or mint authority.
3. The session canonicalizes the number, resolves permission phrases to installed capability IDs, rejects owner-only or unknown capabilities, and freezes a proposal with a cryptographically random proposal ID that expires exactly 60 seconds after creation.
4. Jarvis reads back the operation, masked or spoken canonical number as appropriate, permission summary, and any high-impact warnings. It does not repeat a PIN.
5. For add or PIN rotation, Jarvis enters an isolated PIN-capture state. Sid may enter exactly four digits using DTMF or speak a four-digit sequence. Spoken digits are accepted only by a strict digit normalizer while that state is active; they bypass the conversational transcript, memory, model, and logs. Ambiguous speech is rejected with a keypad fallback.
6. Jarvis reads back the non-secret proposal and asks Sid to say `confirm` or `cancel`. Confirmation must arrive in the same owner session before expiry and while the exact proposal remains current.
7. The access service revalidates owner authority, grant conflicts, capability registration, proposal expiry, and the captured PIN before committing one transaction.
8. Jarvis returns a fixed success or neutral failure response. Repository or validation details never enter model-visible error text.

There is no generic model tool for access changes. The model is a parser and conversational presenter only; a dedicated owner-access service owns validation, confirmation capabilities, and mutation.

## 5. PIN handling and abuse limits

- Guest PIN syntax is exactly `[0-9]{4}`.
- Plaintext digits exist only in bounded call-session memory during capture or verification and are zeroed or released after the candidate is processed.
- Each verifier record uses schema version `2.0`, algorithm identifier `hmac-sha256-pepper+pbkdf2-hmac-sha256`, a cryptographically random 16-byte salt, exactly 600,000 PBKDF2 iterations for this release, and a 32-byte digest. The Worker secret `GUEST_PIN_PEPPER_V1` is a cryptographically random 32-byte key that is never stored in D1.
- Derivation first computes `HMAC-SHA-256(GUEST_PIN_PEPPER_V1, UTF8("jarvis.guest-pin/v1\\0" + grantId + "\\0" + pin))`, then uses that 32-byte result as the PBKDF2-HMAC-SHA-256 input with the record salt and iteration count to derive the stored 32-byte digest. Verification parses bounded canonical fields, derives a candidate, and compares all 32 bytes in constant time. D1 therefore contains no verifier that can be checked without the pepper.
- PIN rotation writes a fresh salt and digest in the same transaction that increments grant lineage and never retains the prior verifier. Pepper rotation is a separately versioned local recovery operation; a verifier record names its pepper version and malformed or unavailable versions fail closed.
- Three failed candidates terminate a call.
- Existing call, identity-direction, and global five-minute attempt budgets remain, with no persistent account lockout.
- `*` or `#` clears the current candidate. Socket close, hibernation, setup failure, completion, and revocation clear transient digits.
- PIN values never enter TwiML, events, logs, traces, transcripts, prompts, model input, memory, confirmation speech, or error messages.

## 6. Permission model

The permission registry is closed and versioned. The initial categories are:

| Capability ID | Meaning |
| --- | --- |
| `conversation.basic` | Hold ordinary conversations with Jarvis. |
| `research.web` | Request web research through the registered research adapter. |
| `memory.own` | Read and write only the guest principal's own Jarvis memory. |
| `reminders.manage` | Create, inspect, and cancel the guest's reminders. |
| `calendar.read` | Read explicitly connected calendar scopes. |
| `calendar.manage` | Create or modify events in explicitly connected scopes. |
| `owner.contact` | Ask Jarvis to prepare contact with Sid through an approved channel. |
| `communications.draft` | Draft messages or calls without sending them. |
| `communications.send` | Send through installed adapters subject to action confirmation policy. |
| `calls.place` | Place calls through installed policy-gated calling adapters. |
| `files.read` | Read only paths covered by an attached filesystem scope. |
| `files.write` | Modify only paths covered by an attached filesystem scope. |
| `pc.control` | Use explicitly installed and allowlisted PC-control actions. |
| `spending.propose` | Prepare a spending action for confirmation; never bypass provider or owner confirmation. |
| `destructive.propose` | Prepare a destructive action for confirmation; never execute without the action's confirmation policy. |

`owner.root`, `access.manage`, `credentials.manage`, `safety.configure`, and `identity.owner.rotate` are owner-only authorities and can never appear in a guest grant.

High-impact guest capabilities remain subordinate to their adapters' confirmation rules. A permission answers whether an action may be proposed; it does not erase confirmation, spend, provider, path, recipient, or destructive-operation checks.

Natural-language instructions map only to currently registered IDs and explicit resource scopes. Phrases such as `everything` mean every currently registered guest-grantable capability, never an owner-only authority and never a future capability added after the grant. Adding a new capability therefore never expands an existing grant automatically.

The canonical resource-scope document is a versioned JSON object with exactly `schemaVersion`, `calendarConnectionIds`, `fileRootIds`, and `pcActionIds`. Version `1.0` requires each scope value to be a sorted, duplicate-free array of opaque IDs already registered by the corresponding adapter; unknown fields, raw filesystem paths, provider tokens, wildcard values, and IDs not owned by the guest's configured connection are invalid. `calendar.read` or `calendar.manage` requires at least one `calendarConnectionId`; `files.read` or `files.write` requires at least one `fileRootId`; and `pc.control` requires at least one `pcActionId`. A resource-bound capability is not registered or grantable until its adapter and at least one valid scope exist. Capabilities without a resource binding require the corresponding array to be empty.

The `stremy.*` namespace is reserved for the later St. Remy deployment and is not registered, recognized, or grantable by Personal Jarvis.

## 7. Persistence and transactions

A new additive migration introduces:

- `voice_access_grants`: immutable grant ID, guest principal and voice identity, monotonically increasing grant version, canonical permission and resource-scope document hash, versioned PIN verifier material, status (`pending`, `active`, or `revoked`), owner creator identity, and UTC lifecycle timestamps;
- `voice_access_grant_events`: append-only proposed/created/activated/changed/PIN-rotated/revoked outcomes using opaque IDs and safe permission identifiers;
- constraints preventing the configured owner identity from appearing as a guest, two live grants for one voice identity, grant-version rollback, resurrection after revocation without a new grant ID, deletion of audit history, and cross-principal identity reuse.

Grant creation, change, activation, rotation, and revocation each commit their row mutation and audit event atomically. Revocation increments authority lineage before any success response so an in-flight stale guest proof fails at the next permission boundary.

Phone numbers remain provider subjects in the existing identity table and are excluded from normal logs and events. User-facing list/readback responses mask numbers except when Sid is confirming a newly supplied canonical number.

## 8. Call routing

### Inbound owner call

1. Verify the exact Twilio request and resolve the active stored voice identity.
2. Create the normal signed relay session.
3. On first valid relay setup, mint owner authority and transition directly from setup/pre-auth to authenticated/active without prompting for a PIN.

### Inbound guest call

1. Verify Twilio and require an active or owner-provisioned pending grant for the exact number.
2. Start only a neutral relay authentication session.
3. Capture and verify one per-number four-digit PIN under the existing attempt budgets.
4. Atomically activate a pending first-use grant when appropriate, mint guest authority, and load only that principal's permitted context.

### Unknown call

Reject before ConversationRelay with a neutral response. Do not disclose whether the number, PIN, owner, or any guest exists.

### Outbound calls

Calls to the owner identity skip the recurring PIN after the signed expected-call and relay bindings succeed. Calls to a guest remain neutral until that guest supplies the grant's four-digit PIN. No outbound call to an arbitrary third party gains conversation authority merely because the owner initiated it.

## 9. Failure handling and privacy

- A failed owner-identity lookup, stale owner configuration, grant conflict, invalid capability, expired proposal, ambiguous spoken PIN, storage failure, or stale authority fails closed with fixed public language.
- A model proposal is always untrusted. Hallucinated numbers, permissions, confirmations, or repository results cannot create access.
- Administration proposals expire exactly 60 seconds after creation, are single-session and single-use, and are invalidated by interruption, cancellation, socket close, or a newer proposal.
- No access mutation occurs merely because Sid uttered a sentence that resembles confirmation; confirmation is accepted only while the exact proposal state is awaiting it.
- Logs and durable events contain opaque grant/identity IDs, safe outcomes, grant versions, and permission identifiers, but no raw PIN, unrestricted transcript, or direct phone number.

## 10. Testing requirements

Tests must prove at minimum:

- the exact configured active owner identity bypasses PIN on inbound and outbound calls;
- a same-number string without stored owner identity authority, changed identity row, forged proof, different `CallSid`, or cross-session replay does not bypass authentication;
- unknown callers are rejected before ConversationRelay and cannot test PINs;
- two guests with different four-digit PINs cannot authenticate each other's number or reuse each other's proof;
- exactly four digits are required, three failures terminate, budgets remain bounded, and no persistent lockout affects the owner;
- DTMF and strict spoken PIN capture never enter transcripts, model input, memory, events, logs, errors, or TwiML;
- a model proposal alone, an unconfirmed proposal, an expired proposal, `confirm` in ordinary conversation, a cross-session confirmation, and a replayed confirmation perform no mutation;
- owner-confirmed add, permission replacement, PIN rotation, revocation, and masked listing are atomic and idempotent;
- revocation and grant-version changes invalidate stale in-flight guest authority;
- every registered capability is denied without an exact grant and owner-only authorities are impossible to grant;
- `everything` snapshots only the then-current guest-grantable registry and does not auto-expand later;
- guest memory and resource scopes cannot reach the owner's or another guest's data;
- migrations reject NULL, duplicate, rollback, delete, cross-principal, owner-as-guest, and resurrection violations;
- Worker route, fake inbound/outbound acceptance, smoke-evidence schema, typecheck, lint, dependency audit, and full regression gates remain green.

No automated test places a real call or uses live credentials.

## 11. Integration order

1. Amend identity and persistence contracts plus the owner/guest access repository under strict TDD.
2. Replace the global eight-digit PIN verifier with owner authority and per-grant four-digit verification while preserving attempt-budget and nominal-proof boundaries.
3. Extend the Task 6 call session with owner direct activation, guest PIN states, and owner administration proposal/confirmation states.
4. Update Task 8 routing and fake end-to-end acceptance for owner, guest, unknown, revocation, and permission enforcement paths.
5. Update Task 9 evidence so the live owner path proves PIN-free owner routing and a credential-free fake guest path proves PIN isolation. A live guest call is not required for the first release gate unless separately authorized.
6. Run task-scoped reviews, a whole-branch security review, and the complete release gates before any credentialed call.

## 12. Explicit exclusions

- Speaker recognition or voiceprint training.
- Public self-registration or a PIN prompt for arbitrary unknown callers.
- Shared PINs.
- Guest access to Sid's memory by default.
- Model-issued authority, generic model database tools, or model-controlled permission mutation.
- A capability grant creating a missing tool.
- St. Remy data or tools in Personal Jarvis; St. Remy remains a later separate deployment built from the proven shared core.
- Live calls, deployment, credentials, spending, or external messages during automated implementation and tests.

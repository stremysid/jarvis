# Jarvis Twilio Contract Correction Design

**Date:** 2026-08-30  
**Status:** Approved under the user's standing instruction to choose the safest current design and continue autonomously.  
**Scope:** Correct the Twilio provider and ConversationRelay boundaries inside the already approved Jarvis calling architecture. Calling behavior, authentication requirements, channel scope, and release gates do not change.

## Why this correction exists

The calling plan was written against relay shapes that current Twilio documentation does not send. Implementing it literally would discard caller speech, make DTMF PIN authentication inoperable, model a nonexistent provider idempotency guarantee, and reconstruct signed requests unsafely. This correction keeps the planned component boundaries while updating their contracts to the current Twilio API.

## Selected approach

Use small Workers-native adapters rather than Twilio's Node SDK:

1. A strict ConversationRelay decoder maps current provider messages into a minimal internal union.
2. A TwiML renderer emits an explicit, DTMF-enabled ConversationRelay configuration and carries only an opaque relay nonce.
3. A REST provider owns fixed-host call creation, Basic authentication, response limits, and result validation.
4. A signature verifier owns exact-URL signing, form decoding, HMAC verification, and the immutable verified-form capability.
5. A deterministic fake models both known outcomes and the accepted-but-response-lost case without pretending Twilio honors local idempotency keys.

This avoids adding a Node compatibility layer to the Worker and prevents provider objects or raw provider payloads from escaping the adapter boundary.

## ConversationRelay boundary

Accepted incoming JSON messages are:

- `setup`: require valid `sessionId`, `accountSid`, `callSid`, direction, and a single opaque `relayNonce` under `customParameters`; return only the fields needed to bind the session.
- `prompt`: map `voicePrompt`, `lang`, and `last`; only `last: true` is a completed user turn. Jarvis creates its own turn ULID because Twilio supplies no message identifier.
- `dtmf`: accept exactly one `digit` matching `0-9`, `*`, or `#`. Phase-specific authentication code accumulates digits without persisting or logging them.
- `interrupt`: discard provider text and timing details and emit only an internal interrupt signal. The one active model turn is aborted without pretending the event identifies a provider message.
- `error`: validate the shape, discard `description`, and emit only a safe provider-error code.

WebSocket closure is handled by the Durable Object socket-close callback, not a synthetic JSON `disconnect` event. Binary, malformed, oversized, mixed-shape, or second-setup frames fail closed. The decoder permits harmless future additive fields but rejects known payload fields from a different message type.

## TwiML boundary

The renderer requires a `wss://` session URL, an `https://` action URL, a 32-byte base64url relay nonce, and an explicit tested voice configuration. It emits:

- `<Connect action="..." method="POST">`
- `<ConversationRelay>` with `dtmfDetection="true"`, `partialPrompts="false"`, `interruptible="any"`, `reportInputDuringAgentSpeech="any"`, explicit language, STT provider/model, and TTS provider/voice
- exactly one `<Parameter name="relayNonce" ...>` child

No purpose, identity, phone number, PIN, activation value, prompt, or memory text enters TwiML. All attributes are XML-escaped. HTTP handlers return the document with `text/xml` and `Cache-Control: no-store`.

## REST call creation

`TwilioRestProvider` is configured with Account SID, API Key SID/secret, an E.164 caller number, bounded request timeout, and injected `fetch` for tests. It always calls the fixed Twilio API hostname and submits a form containing:

- `To`, configured `From`, `Url`, and `Method=POST`
- `StatusCallback` and `StatusCallbackMethod=POST`
- four separate `StatusCallbackEvent` fields: `initiated`, `ringing`, `answered`, `completed`
- `TimeLimit=1800` and a bounded ringing `Timeout`

The local idempotency key is correlation material and is never represented as a Twilio idempotency guarantee. The adapter performs no automatic retry. It validates bounded response bytes, Account SID, and `CallSid` before returning.

Explicit pre-acceptance rejection may produce a typed retryable or permanent failure. A network timeout, 5xx, invalid success body, oversized success body, or lost response after dispatch produces `provider_dispatch_unknown`. Call orchestration persists that state and never places another call automatically; signed TwiML/status callbacks can reconcile the accepted call.

## Signature and verified-form boundary

The verifier accepts the exact externally visible URL as a string. It never rebuilds the origin from forwarded headers or parses and reserializes the URL before signing.

For form webhooks it:

1. requires POST and `application/x-www-form-urlencoded`;
2. decodes the bounded raw body exactly once using strict UTF-8 and strict percent encoding;
3. sorts parameter names case-sensitively and, for repeated names, appends the de-duplicated values in sorted order to match Twilio's official validator;
4. verifies the Base64 signature with Web Crypto; and
5. returns an immutable branded accessor over the already parsed multimap only after verification.

For WebSocket upgrades it requires GET and verifies the exact configured WSS URL. Later handlers consume only the verified form capability and then apply endpoint-specific semantic allowlists. Raw bodies, signatures, auth tokens, phone numbers, response bodies, and provider error descriptions are never logged.

## Testing and release gates

Task 2 is test-driven with current official fixtures for setup, final/partial prompt, one-digit DTMF, interrupt, error, malformed frames, mixed frames, and TwiML structure. REST tests assert exact form multiplicity, fixed host, caller number, callback methods/events, time limits, bounded parsing, and API-key authentication without exposing credentials. Signature tests cover the official Twilio vector, extra and duplicate form parameters, exact encoded query strings, whitespace, malformed forms, wrong signatures, and WebSocket URLs.

The fake must simulate response loss after provider acceptance and demonstrate that calling the provider again would create a duplicate. Task 3/7 orchestration must prove that a persisted unknown outcome prevents that second invocation. No live or paid call is made in automated tests. Before release, a credentialed smoke test must validate the chosen STT/TTS combination, the exact signed WSS handshake representation, DTMF delivery, callback schemas, and any provider playback event used as delivery evidence.

Until that playback acknowledgement is proven, Jarvis records assistant output as `sent_to_provider`, not `delivered_to_caller`, and does not commit it to conversational history under the existing delivered-only rule.

## Non-goals

This correction does not implement call persistence, PIN verification, the Durable Object conversation loop, Worker route wiring, provider callback reduction, Telegram, memory, or deployment. Those remain in their existing planned tasks and consume these corrected boundaries.

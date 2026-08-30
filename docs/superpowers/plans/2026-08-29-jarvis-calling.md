# Jarvis Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the version 0.1.0 inbound and outbound Twilio calling paths with pre-authentication privacy, durable auditable state, and a real-call release gate.

**Architecture:** The Cloudflare Worker accepts only signed Twilio ingress and routes each call to a Durable Object that owns the call state machine. Provider-specific Twilio and ConversationRelay behavior is isolated behind adapters; D1 transactions durably record events, policy decisions, idempotency, expected-call bindings, and outbox work. The local agent is only a signed command issuer for outbound calls in this slice; Telegram, long-term memory, sync, and semantic retrieval are excluded.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, D1, Vitest, Miniflare/workerd test runtime, Twilio Programmable Voice and ConversationRelay, Web Crypto, Cloudflare secret bindings.

**Spec:** `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md`

## Global Constraints

- This plan implements only mandatory inbound/outbound calling; it does not add Telegram conversation handling, local archive replication, distillation, PC/browser tools, or arbitrary third-party calls.
- Every inbound call requires an allowlisted source number and DTMF PIN before any personal context, purpose, model request, or memory retrieval.
- PIN digits, authorization headers, credentials, provider bodies, raw audio, partial transcript text, and cancelled assistant text never enter events, logs, model input, dead letters, or smoke evidence.
- PIN verification uses a versioned PBKDF2-HMAC-SHA-256 record with a random 128-bit salt and at least 600,000 iterations; the record is stored only in a Worker secret.
- Inbound authentication failures terminate after three attempts without permanently locking Sid's canonical identity. Throttles are limited to `CallSid`, a rolling composite source bucket, and a global five-minute abuse budget.
- Outbound calls may originate only from a signed, authenticated `telegram_call_command` or `local_cli` command. This calling slice exposes the local-CLI issuer; the foundation Telegram issuer is consumed but not implemented here.
- Outbound calls target only Sid's enrolled verified number, require an unexpired authorization and immutable policy decision, and recheck kill switch, quiet hours, concurrency, daily limit, and retry limit immediately before each attempt.
- An outbound relay nonce is 32 cryptographically random bytes, URL-safe base64 encoded, single-use, and expires after five minutes. Relay traffic starts only after atomic binding to `CallSid`, subject, destination, and nonce.
- Limits are: two concurrent calls; 30 minutes and 100 committed turns per call; three authentication attempts; one outbound retry; six outbound calls/day; 64 KiB/WebSocket frame; 8,000 transcript characters/turn; 32,000 voice-context tokens; eight seconds to first model token; 30 seconds/model turn.
- D1 commits accepted event, idempotency record, and outbox row in one transaction. Every event has a lowercase ULID, RFC 3339 UTC millisecond timestamp, RFC 8785 canonical JSON payload, and SHA-256 hash over the canonical post-redaction payload.
- Consumers reject unsupported major contract versions and retain only redacted invalid payloads in access-controlled dead letters. Signed call-progress callbacks are deduplicated by endpoint kind, `CallSid`, `CallbackSource`, and canonical `SequenceNumber`; signed ConversationRelay action callbacks are deduplicated by endpoint kind, `CallSid`, and `SessionId`. ConversationRelay WebSocket prompts provide no message identifier, so Jarvis creates its own turn ULIDs.
- A model failure never authorizes a callback. Only the single policy-evaluated retry of an existing, unexpired outbound command can produce another outbound call.
- Public liveness returns only `ok` or `unavailable`; detailed health/metrics require an enrolled operator identity. Logs are allowlist-only and contain no raw message text or direct channel identifiers.

---

## Foundation-cloud prerequisite interfaces

The calling work begins after all tasks in `docs/superpowers/plans/2026-08-29-jarvis-foundation-cloud.md`. It consumes the following foundation names exactly and extends them only where stated below; it does not recreate core contracts, D1 transaction batches, identity authorization, policy logic, or provider fakes.

```ts
// packages/contracts/src/envelope.ts
export interface EventEnvelopeV1<T extends JsonValue = JsonValue> {
  schemaVersion: "1.0";
  eventId: Ulid;
  eventSequence?: number;
  eventType: string;
  source: string;
  subjectId: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: Ulid;
  causationId?: Ulid;
  contentType: "application/json";
  contentHash: Sha256Hex;
  payload: T;
  redaction: { status: "redacted" | "none"; markers: string[] };
  producerVersion: string;
}
export type EventEnvelope<T extends JsonValue = JsonValue> = EventEnvelopeV1<T>;

// packages/contracts/src/ids.ts and canonical-json.ts
export function newUlid(now?: Date): Ulid;
export function canonicalize(value: unknown): Uint8Array;
export function canonicalJson(value: unknown): string;
export function sha256Hex(value: string | Uint8Array): Promise<Sha256Hex>;
export type Ulid = string & { readonly __ulid: unique symbol };
export type Sha256Hex = string & { readonly __sha256: unique symbol };

// apps/cloud-gateway/src/persistence/event-repository.ts
export interface EventRepository {
  append(input: { envelope: EventEnvelopeV1; scope: string; key: string; requestHash: Sha256Hex }): Promise<{ eventSequence: number; envelope: EventEnvelopeV1; replayed: boolean }>;
  readRange(afterSequence: number, limit: number): Promise<readonly { eventSequence: number; envelope: EventEnvelopeV1; replayed: boolean }[]>;
}

// apps/cloud-gateway/src/policy/policy-engine.ts
export interface PolicyEngine {
  evaluateOutboundCall(request: OutboundCallCommand): Promise<PolicyDecision>;
  recheckOutboundDispatch(request: OutboundCallCommand, attemptId: Ulid): Promise<DispatchPolicyCheck>;
}

// apps/cloud-gateway/src/providers/provider-types.ts
export interface TwilioProvider { createCall(input: { commandId: string; attemptId: string; toE164: string; twimlUrl: URL; statusCallbackUrl: URL; statusCallbackEvents: readonly ["initiated", "ringing", "answered", "completed"]; idempotencyKey: string }): Promise<{ callSid: string }>; }
```

Task 1 of the calling plan extends `apps/cloud-gateway/src/env.ts` with the `PIN_VERIFIER_JSON` secret binding, replaces the foundation `CallSessionStub` with the real `CallSession` Durable Object in `apps/cloud-gateway/wrangler.toml`, and creates `apps/cloud-gateway/src/index.ts` as the sole Worker entrypoint. Calling schema follows the immutable foundation migrations with `0003_calling.sql` for provider attempts/events and `0004_call_sessions.sql` for stable inbound/outbound relay-session routing; both leave foundation tables untouched and Wrangler applies all migrations in order.

## File structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/calls.ts` | Provider-neutral call states, commands, policy decisions, relay bindings, and transcript shapes. |
| `packages/contracts/src/index.ts` | Re-export call contracts for Worker, CLI issuer, and tests. |
| `apps/cloud-gateway/src/providers/twilio-webhook.ts` | Narrow Twilio signature/TwiML adapter layered over the foundation `TwilioProvider`. |
| `apps/cloud-gateway/src/providers/conversation-relay.ts` | Typed parser/serializer for the relay WebSocket events used by the Durable Object. |
| `apps/cloud-gateway/src/persistence/call-repository.ts` | Calling-specific D1 persistence layered over `0003_calling.sql`. |
| `apps/cloud-gateway/src/voice/call-state.ts` | Pure call and transcript state-transition rules. |
| `apps/cloud-gateway/src/conversation/conversation-service.ts` | Shared streaming turn orchestration consumed by voice now and Telegram later. |
| `apps/cloud-gateway/src/conversation/context-retriever.ts` | Principal/authentication/purpose-scoped recent-turn and active-fact retrieval boundary. |
| `apps/cloud-gateway/src/conversation/outbox-dispatcher.ts` | Shared idempotent outbox dispatcher contract consumed by future channel senders. |
| `apps/cloud-gateway/src/model/model-adapter.ts` | Provider-neutral model stream contract and DeepSeek adapter seam. |
| `apps/cloud-gateway/src/voice/inbound-auth.ts` | PIN verifier parsing, constant-time digest comparison, attempt accounting, and throttle calculation. |
| `apps/cloud-gateway/src/voice/call-session-do.ts` | Durable Object that owns a single authenticated or pre-auth call session. |
| `apps/cloud-gateway/src/voice/inbound.ts` | Signed inbound webhook handler and neutral pre-auth TwiML. |
| `apps/cloud-gateway/src/voice/outbound.ts` | Command validation, expected-call creation, Twilio dispatch, callback/TwiML binding, and retry handling. |
| `apps/cloud-gateway/src/http/voice-routes.ts` | Worker route registration for signed Twilio voice, status, and relay endpoints. |
| `apps/cloud-gateway/src/providers/fake-twilio-provider.ts` | Foundation deterministic Twilio fake, extended with signed-webhook controls. |
| `apps/cloud-gateway/src/providers/fake-model-provider.ts` | Foundation deterministic streaming model fake, configured with token/delivery timing. |
| `tests/acceptance/fake/voice-call-path.test.ts` | End-to-end fake call acceptance scenarios. |
| `tests/acceptance/live/voice-smoke.ts` | Credentialed real-call gate and redacted evidence writer. |

## Calling-owned shared conversation interfaces

This calling plan owns the following interfaces because the foundation-cloud plan intentionally ends before channel routing. The Telegram/memory/release plan must import these names rather than define parallel turn, outbox, or model contracts.

```ts
// apps/cloud-gateway/src/model/model-adapter.ts
export interface ModelToken { index: number; text: string; }
export interface RetrievedContext { sourceEventId: Ulid; text: string; sensitivity: "personal" | "restricted"; }
export interface ContextRetriever {
  retrieve(input: { principalId: string; channel: "voice" | "telegram"; purpose: "conversation"; query: string; maxTokens: number }): Promise<readonly RetrievedContext[]>;
}
export interface ModelAdapter {
  stream(input: { correlationId: Ulid; principalId: string; channel: "voice" | "telegram"; userText: string; context: readonly RetrievedContext[]; timeoutMs: number; contextTokenBudget: number; signal: AbortSignal }): AsyncIterable<ModelToken>;
}

// apps/cloud-gateway/src/conversation/conversation-service.ts
export interface ConversationService {
  handleTurn(input: { sessionId: string; principalId: string; channel: "voice" | "telegram"; turnId: Ulid; text: string; signal: AbortSignal; delivery: { kind: "voice_stream"; onToken(token: ModelToken): Promise<void>; finish(finalText: string): Promise<{ outcome: "sent_to_provider" }> } | { kind: "outbox"; idempotencyKey: string; payload: JsonValue } }): Promise<{ committedUserEventId: Ulid; sentAssistantEventId: Ulid | null; deliveredAssistantEventId: Ulid | null }>;
  stageSystemNotice(input: { sessionId: string; principalId: string; channel: "telegram"; noticeCode: "busy"; idempotencyKey: string; payload: JsonValue }): Promise<{ outboxId: Ulid }>;
}

// apps/cloud-gateway/src/conversation/outbox-dispatcher.ts
export interface OutboxDispatcher {
  dispatch(outboxId: Ulid): Promise<{ delivered: boolean; deliveredAssistantEventId: Ulid | null }>;
}
```

### Task 1: Call contracts and pure state machine

**Files:**
- Modify: `packages/contracts/src/calls.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/cloud-gateway/src/env.ts`, `apps/cloud-gateway/wrangler.toml`
- Create: `apps/cloud-gateway/src/index.ts`
- Create: `apps/cloud-gateway/src/voice/call-state.ts`
- Test: `apps/cloud-gateway/test/contracts/calls.test.ts`
- Test: `apps/cloud-gateway/test/voice/call-state.test.ts`

**Interfaces:**
- Consumes: foundation `OutboundCallCommand`, `EventEnvelopeV1<T>`, `Ulid`, `canonicalJson`, and `sha256Hex`.
- Produces: `CallPhase`, `TranscriptState`, `ExpectedOutboundCall`, `RelayBinding`, `transitionCall`, and `canPersistTurn`; it preserves the foundation `OutboundCallCommand` unchanged.

- [ ] **Step 1: Write the failing contract and transition tests**

```ts
import { describe, expect, it } from "vitest";
import { transitionCall, canPersistTurn } from "../../src/voice/call-state";

describe("call state", () => {
  it("permits the authenticated call path and blocks terminal reversal", () => {
    expect(transitionCall("created", "connecting")).toBe("connecting");
    expect(transitionCall("pre_auth", "authenticated")).toBe("authenticated");
    expect(() => transitionCall("completed", "active")).toThrow("invalid_call_transition");
  });

  it("persists only committed user turns and delivered committed assistant turns", () => {
    expect(canPersistTurn("committed", "user", false)).toBe(true);
    expect(canPersistTurn("committed", "assistant", true)).toBe(true);
    expect(canPersistTurn("committed", "assistant", false)).toBe(false);
    expect(canPersistTurn("partial", "user", false)).toBe(false);
    expect(canPersistTurn("cancelled", "assistant", true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/contracts/calls.test.ts apps/cloud-gateway/test/voice/call-state.test.ts`

Expected: FAIL because the calling state-machine exports and the real Durable Object/Worker entrypoint do not exist yet.

- [ ] **Step 3: Write the minimal contracts and transition implementation**

```ts
// packages/contracts/src/calls.ts
export type CallPhase = "created" | "connecting" | "pre_auth" | "authenticated" | "active" | "ending" | "completed" | "rejected" | "failed" | "expired";
export type TranscriptState = "partial" | "committed" | "cancelled";
export type CallDirection = "inbound" | "outbound";

export interface ExpectedOutboundCall {
  commandId: string;
  principalId: string;
  destinationIdentityId: string;
  relayNonce: string;
  nonceExpiresAt: string;
  idempotencyKey: string;
}

export interface RelayBinding {
  callSid: string;
  principalId: string;
  identityId: string;
  destinationIdentityId: string;
  relayNonce: string;
  direction: CallDirection;
  activationOnly: boolean;
  activationChallengeId: string | null;
}

```

```ts
// apps/cloud-gateway/src/voice/call-state.ts
import type { CallPhase, TranscriptState } from "@jarvis/contracts";

const allowed: Record<CallPhase, readonly CallPhase[]> = {
  created: ["connecting", "rejected", "failed", "expired"],
  connecting: ["pre_auth", "rejected", "failed", "expired"],
  pre_auth: ["authenticated", "rejected", "failed", "expired"],
  authenticated: ["active", "ending", "failed", "expired"],
  active: ["ending", "failed", "expired"],
  ending: ["completed", "failed"],
  completed: [], rejected: [], failed: [], expired: [],
};

export function transitionCall(current: CallPhase, next: CallPhase): CallPhase {
  if (!allowed[current].includes(next)) throw new Error("invalid_call_transition");
  return next;
}

export function canPersistTurn(state: TranscriptState, direction: "user" | "assistant", delivered: boolean): boolean {
  return state === "committed" && (direction === "user" || delivered);
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/contracts/calls.test.ts apps/cloud-gateway/test/voice/call-state.test.ts`

Expected: PASS with all transition and transcript-persistence assertions green.

- [ ] **Step 5: Commit the independently testable state-machine deliverable**

```bash
git add packages/contracts/src/calls.ts packages/contracts/src/index.ts apps/cloud-gateway/src/env.ts apps/cloud-gateway/wrangler.toml apps/cloud-gateway/src/index.ts apps/cloud-gateway/src/voice/call-state.ts apps/cloud-gateway/test/contracts/calls.test.ts apps/cloud-gateway/test/voice/call-state.test.ts
git commit -m "feat(calls): add provider-neutral call contracts and state machine"
```

### Task 2: Shared Twilio provider extension and ConversationRelay boundary

**Contract correction:** `docs/superpowers/specs/2026-08-30-jarvis-twilio-contract-correction-design.md` supersedes the original draft event shapes and retry assumptions. Later tasks consume the corrected `prompt`, one-digit `dtmf`, socket-close, verified-form, attempt-scoped route, and `provider_dispatch_unknown` contracts below.

**Files:**
- Modify: `apps/cloud-gateway/src/providers/provider-types.ts`
- Modify: `apps/cloud-gateway/src/providers/fake-twilio-provider.ts`
- Modify: `apps/cloud-gateway/src/calls/outbound-call-dispatcher.ts`
- Create: `apps/cloud-gateway/src/providers/twilio-provider.ts`
- Create: `apps/cloud-gateway/src/providers/twilio-verifier.ts`
- Create: `apps/cloud-gateway/src/providers/conversation-relay.ts`
- Create: `apps/cloud-gateway/src/security/trusted-public-origin.ts`
- Create: `apps/cloud-gateway/src/voice/twiml.ts`
- Test: `apps/cloud-gateway/test/calls/outbound-call-dispatcher.test.ts`
- Test: `apps/cloud-gateway/test/providers/fakes.test.ts`
- Test: `apps/cloud-gateway/test/providers/twilio.test.ts`
- Test: `apps/cloud-gateway/test/providers/conversation-relay.test.ts`

**Interfaces:**
- Consumes: foundation `TwilioProvider`, foundation `FakeTwilioProvider`, and `RelayBinding` from `@jarvis/contracts`.
- Produces: real `TwilioRestProvider`, `TwilioSignatureVerifier`, `TwilioRequestVerifier`, immutable `VerifiedTwilioForm`, corrected `RelayEvent`, `parseRelayEvent`, `ProviderDispatchUnknownError`, and `renderConversationRelayTwiML`.

- [ ] **Step 1: Write failing tests from current official provider fixtures**

```ts
import { describe, expect, it } from "vitest";
import { parseRelayEvent } from "../../src/providers/conversation-relay";
import { renderConversationRelayTwiML } from "../../src/voice/twiml";

describe("current ConversationRelay boundary", () => {
  it("parses setup only from the documented customParameters location", () => {
    const event = parseRelayEvent(JSON.stringify({ type: "setup", sessionId: `VX${"0".repeat(32)}`, accountSid: `AC${"1".repeat(32)}`, callSid: `CA${"2".repeat(32)}`, direction: "outbound-api", customParameters: { relayNonce: "A".repeat(43) } }));
    expect(event).toEqual({ type: "setup", sessionId: `VX${"0".repeat(32)}`, accountSid: `AC${"1".repeat(32)}`, callSid: `CA${"2".repeat(32)}`, direction: "outbound", relayNonce: "A".repeat(43) });
  });

  it("maps final and partial prompts without inventing a provider message id", () => {
    expect(parseRelayEvent('{"type":"prompt","voicePrompt":"hello","lang":"en-US","last":true}')).toEqual({ type: "prompt", text: "hello", language: "en-US", final: true });
    expect(parseRelayEvent('{"type":"prompt","voicePrompt":"hel","lang":"en-US","last":false}')).toEqual({ type: "prompt", text: "hel", language: "en-US", final: false });
  });

  it("accepts one DTMF key and discards provider error/interrupt text", () => {
    expect(parseRelayEvent('{"type":"dtmf","digit":"8"}')).toEqual({ type: "dtmf", digit: "8" });
    expect(parseRelayEvent('{"type":"interrupt","utteranceUntilInterrupt":"private text","durationUntilInterruptMs":460}')).toEqual({ type: "interrupt" });
    expect(parseRelayEvent('{"type":"error","description":"raw malformed payload"}')).toEqual({ type: "error", code: "conversation_relay_error" });
  });
});
```

Add negative tables for binary-equivalent/oversized text, malformed JSON, invalid SIDs/nonces/directions, multi-character DTMF, mixed known event fields, unknown types, and forbidden synthetic `disconnect`/old `speech` frames. Assert that parsing an error never returns its description.

Render TwiML with an injected trusted public origin and explicit test settings (`en-US`, Deepgram `nova-3-general`, Google `en-US-Journey-O`). Assert exact fixed-host `/voice/relay/:sessionId` WSS and `/voice/relay-ended` HTTPS routes, no credentials/query/fragment/non-default port or overridden URL serialization, exact XML escaping, `Connect method="POST"`, `dtmfDetection="true"`, `partialPrompts="false"`, `interruptible="any"`, `reportInputDuringAgentSpeech="any"`, the explicit STT/TTS settings, one nonce parameter, and no identity/purpose/PIN data. Task 6 ignores all pre-auth prompts, so enabling speech reporting for authenticated barge-in does not cross the privacy boundary.

- [ ] **Step 2: Write failing REST, signature, and ambiguous-dispatch tests**

Use an injected fetch spy, synthetic credentials, trusted public origin, distinct valid `commandId`/`attemptId`, and attempt-bound URLs. Assert the exact fixed Twilio REST URL, API-key Basic authentication, bounded timeout, form encoding, configured `From`, exact `/voice/outbound/${attemptId}` and `/voice/status/${attemptId}` URLs, `Method=POST`, `StatusCallbackMethod=POST`, four separate callback event pairs, `TimeLimit=1800`, and bounded ring timeout. Reject command-bound/global/other-attempt routes, attacker origins, credentials, query/fragment/non-default ports, and overridden URL serialization. Assert no idempotency header is sent.

Test the documented Twilio signature vector plus wrong signatures, exact percent-encoded query preservation, leading/trailing form whitespace, duplicate and additive form fields, malformed percent encoding, invalid UTF-8, wrong content type, consumed/locked Requests, and WebSocket GET signing. Valid webhook strings require `https://`; WebSocket strings require `wss://`; controls, backslashes, userinfo, fragments, malformed authority/escapes, and wrong schemes fail before HMAC while noncanonical but safe exact bytes remain untouched. Match the official SDK's multi-value rule: sort parameter names, then de-duplicate and sort repeated values before appending them. A successful webhook verification returns an immutable parsed multimap; a failed verification returns `null` and exposes no parsed values.

Test response validation for matching Account SID/CallSid, auth failure, permanent 4xx, explicit 429, network timeout, 5xx, oversized body, and malformed/mismatched success bodies. The ambiguous cases must throw `ProviderDispatchUnknownError`. Extend the fake with an accepted-but-response-lost control and prove a direct replay creates a second provider attempt, making the later durable no-retry gate testable instead of masking it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts apps/cloud-gateway/test/providers/conversation-relay.test.ts`

Expected: FAIL because the real REST/signature adapters, corrected relay parser, TwiML renderer, immutable verified form, ambiguous-dispatch error, and fake controls do not exist.

- [ ] **Step 4: Define the safe adapter capabilities**

```ts
// apps/cloud-gateway/src/providers/provider-types.ts
export class ProviderDispatchUnknownError extends Error {
  readonly code = "provider_dispatch_unknown" as const;
  readonly operation = "twilio.createCall" as const;
}

// apps/cloud-gateway/src/providers/twilio-verifier.ts
declare const verifiedTwilioFormBrand: unique symbol;
export interface VerifiedTwilioForm {
  readonly [verifiedTwilioFormBrand]: true;
  get(name: string): string | null;
  getAll(name: string): readonly string[];
  entries(): readonly (readonly [string, string])[];
}

// apps/cloud-gateway/src/providers/provider-types.ts
export interface TwilioRequestVerifier {
  verifyWebhook(input: { request: Request; exactUrl: string }): Promise<VerifiedTwilioForm | null>;
  verifyWebSocket(input: { request: Request; exactUrl: string }): Promise<boolean>;
}
```

The verifier owns the original `Request`, rejects the wrong method/content type, streams at most 64 KiB before allocating the combined body, verifies the signature, and only then mints the nominal capability. The verified-form implementation owns a private frozen copy of all pairs and returns frozen snapshots. Callers never clone, pre-buffer, or parse the raw body a second time. The fake delegates to the same strict verifier with synthetic credentials, so a false signature returns `null` before parsed values are exposed and cannot make route tests pass under looser decoding rules.

- [ ] **Step 5: Implement the corrected relay decoder and TwiML renderer**

```ts
// apps/cloud-gateway/src/providers/conversation-relay.ts
export type RelayEvent =
  | { type: "setup"; sessionId: string; accountSid: string; callSid: string; direction: "inbound" | "outbound"; relayNonce: string }
  | { type: "prompt"; text: string; language: string; final: boolean }
  | { type: "dtmf"; digit: string }
  | { type: "interrupt" }
  | { type: "error"; code: "conversation_relay_error" };
```

Measure UTF-8 frame bytes before JSON parsing, enforce provider SID/nonce/direction/DTMF shapes, map `outbound-api` and `outbound-dial` to internal `outbound`, and discard raw interrupt/error content. `parseRelayEvent` is stateless; Task 6 owns first/second setup and socket-close rules.

`renderConversationRelayTwiML` snapshots URL internal slots, pins both URLs to the configured public host and fixed opaque route shapes, requires WSS/HTTPS with no credentials/query/fragment/non-default port, requires the 43-character base64url nonce, accepts explicit voice settings, escapes all XML attribute metacharacters, and emits only the provider settings plus the opaque session URL, action URL, and relay nonce.

- [ ] **Step 6: Implement Workers-native REST and signature adapters**

`TwilioRestProvider.createCall` validates the explicit attempt ID plus fixed trusted callback URLs, then uses only `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json`, injected `fetch`, one abort timeout, API-key SID/secret Basic authentication, and a streaming response reader capped at 64 KiB. It performs no retry and never logs the auth material, destination, signature, request body, or response body. An explicit 401/403 is authentication failure, an explicit 429 is rate limited, other non-5xx 4xx responses are permanent invalid requests, and every possibly accepted or indeterminate outcome is `provider_dispatch_unknown`.

`TwilioSignatureVerifier` uses the primary Auth Token only for HMAC-SHA1. It first validates the expected safe HTTPS/WSS string context without replacing its representation, then signs that untouched exact URL plus strictly decoded parameters using the official SDK ordering: names sorted case-sensitively, with repeated values de-duplicated and sorted before appending. It uses Web Crypto verification against the strict Base64 header. The WebSocket path signs the exact WSS URL with no form body. It never derives the public URL from forwarded headers.

Extend `FakeTwilioProvider` with signature controls and `acceptAndLoseNextResponse()`. Correct the foundation fake so every direct `createCall` invocation is a non-idempotent provider attempt: it may log the local correlation key but must not cache, coalesce, conflict, or suppress a replay. Telegram's fake retains its idempotency behavior. Task 3/7 owns the durable gate that prevents Jarvis from making the second Twilio invocation.

- [ ] **Step 7: Run focused and full verification**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts apps/cloud-gateway/test/providers/conversation-relay.test.ts apps/cloud-gateway/test/providers/fakes.test.ts`

Expected: PASS with the official relay fixtures, signature vector and multi-value behavior, exact REST request, ambiguous-dispatch classification, faithful non-idempotent Twilio fake, and existing non-Twilio fake behavior green.

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm audit --audit-level high`

- [ ] **Step 8: Independently review and commit the provider boundary**

Require separate plan-compliance and code/security reviews. The review must explicitly check that no automatic Twilio POST retry or fake idempotency exists, the fake exposes response-loss duplicate risk for later orchestration tests, raw provider content cannot escape error/interrupt paths, and verified forms cannot be forged by parsing unverified request bodies in a route.

```bash
git add apps/cloud-gateway/src/calls/outbound-call-dispatcher.ts apps/cloud-gateway/src/providers/provider-types.ts apps/cloud-gateway/src/providers/fake-twilio-provider.ts apps/cloud-gateway/src/providers/twilio-provider.ts apps/cloud-gateway/src/providers/twilio-verifier.ts apps/cloud-gateway/src/providers/conversation-relay.ts apps/cloud-gateway/src/security/trusted-public-origin.ts apps/cloud-gateway/src/voice/twiml.ts apps/cloud-gateway/test/calls/outbound-call-dispatcher.test.ts apps/cloud-gateway/test/providers/fakes.test.ts apps/cloud-gateway/test/providers/twilio.test.ts apps/cloud-gateway/test/providers/conversation-relay.test.ts
git commit -m "feat(calls): extend shared Twilio provider for signed relay ingress"
```

### Task 3: Atomic call persistence, event deduplication, and expected-call bindings

**Final authority contract:** Twilio's Calls POST is non-idempotent. Task 3 therefore commits the durable `ready -> claimed` transition before the only provider invocation, then requires an in-memory, attempt-bound one-shot begin capability immediately before that POST. A `claimed` recovery becomes `provider_dispatch_unknown` and every terminal/unknown row suppresses later POSTs. Signed TwiML/status evidence may reconcile an accepted call, but it never creates new POST authority. The final implementation is the range `83ca8ad..2971265`.

**Files:**

- Create: `apps/cloud-gateway/src/persistence/migrations/0003_calling.sql`
- Create: `apps/cloud-gateway/src/persistence/call-repository.ts`
- Modify: `apps/cloud-gateway/src/persistence/event-repository.ts`
- Modify: `apps/cloud-gateway/src/calls/outbound-call-dispatcher.ts`
- Modify: `apps/cloud-gateway/src/policy/policy-types.ts`, `policy-audit.ts`, and `policy-engine.ts`
- Modify: `apps/cloud-gateway/src/providers/provider-types.ts`
- Modify: `packages/contracts/src/calls.ts`
- Modify: migration/archive/acceptance fixtures needed to apply migration 0003
- Test: the four focused Task 3 suites plus the calls contract suite

**Interfaces:**

- Consumes: concrete foundation `EventRepository`, D1 `Env.DB`, persistable `EventEnvelope` values, `ExpectedOutboundCall`, `RelayBinding`, `TwilioProvider`, constructor-issued `ProviderFailure`, and audited `DispatchPolicyCheck` values.
- Produces: `snapshotOutboundCallRequest`, stable attempt selection, distinct recheck audits, `createRelayNonce`, crash-safe `OutboundCallDispatcher`, `CallRepository.getOrCreateExpectedCall`, `claimProviderDispatch`, `beginProviderDispatch`, capability-bound settlement methods, replay-safe `claimExpectedCall`, and atomic `appendProviderEvent`.
- `MutablePolicyContext` contains `killSwitch`, `now`, `isQuietHours`, `activeOutboundCalls`, `outboundCallsForUtcPolicyDay`, and `authenticatedOrigin`. It has no attempt-ID callback and no retry-count callback; `PolicyEngine` derives retry count directly from D1.

**Identity and lineage:**

- `attemptId` is stable provider-attempt identity. `attemptOrdinal` is a required runtime-validated `0 | 1` proof supplied for both allocation and exact replay; it is never inferred after a policy audit.
- `authorizationExpiresAt` is required immutable attempt lineage alongside `commandId`, principal, destination identity, command idempotency key, and ordinal.
- Each real policy recheck mints a distinct `checkId`. The event header is `eventId=checkId`, `correlationId=attemptId`, and `causationId=commandId`.
- The audit payload preserves exact reconstructible linkage as UTF-8 number arrays named `checkIdUtf8`, `attemptIdUtf8`, `commandIdUtf8`, and `inputHashUtf8`. Only validated decision/reason/time fields enter the separately redacted result object. The idempotency request hash is computed from canonical validated raw linkage/result primitives, so generic text redaction cannot corrupt ULIDs or hashes containing digit runs.

- [x] **Step 1: Prove the crash, race, expiry, callback, and runtime boundaries**

The focused tests cover:

- independent canonical 32-byte relay nonces and exact attempt replay;
- one POST under concurrent dispatch and crash recovery;
- candidate-aware insert barriers that prove distinct pre-insert ordinal candidates;
- delayed ordinal-0 convergence after the winner becomes retry-eligible, followed by a fresh ordinal-1 dispatch only;
- ordinal-1 race convergence before retry-limit classification;
- callback reconciliation from `claimed` or `provider_dispatch_unknown` and atomic rollback for incompatible/failing batches;
- same-CallSid replay after the first signed claim, including after nonce expiry, with different-SID rejection;
- claim-time authorization/nonce expiry at exact and past boundaries;
- issued/begun/settled capability binding, forged and cross-attempt capability rejection, and zero POST before a valid begin;
- accessor/mutation/coercion boundaries for command, policy check, audit linkage, claim, date, provider result, `CallSid`, event input, and provider failure;
- direct-D1 attempts to mutate immutable lineage, regress state, rewrite terminal evidence, inject SIDs, change retry authority, or delete a durable attempt.

The initial RED was missing migration/repository load failure. Subsequent RED cases exposed stale-ordinal promotion, capability substitution before POST, stale-time authorization, mutable boundary drift, dependency-array drift, and raw-D1 state regression/deletion.

- [x] **Step 2: Install the total migration 0003 contract**

`outbound_call_attempts` has:

```sql
attempt_id TEXT NOT NULL PRIMARY KEY
command_id TEXT NOT NULL REFERENCES policy_decisions(decision_id) ON DELETE RESTRICT
attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal IN (0, 1))
principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT
destination_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT
command_idempotency_key TEXT NOT NULL
relay_nonce TEXT NOT NULL UNIQUE
nonce_expires_at TEXT NOT NULL
authorization_expires_at TEXT NOT NULL
provider_dispatch_state TEXT NOT NULL
provider_dispatch_claimed_at TEXT
provider_dispatch_resolved_at TEXT
provider_failure_code TEXT
provider_failure_category TEXT
provider_call_sid TEXT UNIQUE
relay_call_sid TEXT UNIQUE
relay_claimed_at TEXT
retry_eligible INTEGER NOT NULL DEFAULT 0
created_at TEXT NOT NULL
UNIQUE (command_id, attempt_ordinal)
```

The checks are total under SQLite NULL semantics:

- `authorization_expires_at` must equal its canonical millisecond UTC `strftime` rendering; IDs, nonce, failure enums, and SIDs retain bounded canonical shapes.
- `provider_dispatch_state` is exactly `ready | claimed | dispatched | rejected | provider_dispatch_unknown`.
- `dispatched` iff `provider_call_sid IS NOT NULL`. Every non-dispatched state requires both CallSid columns null. A relay SID and `relay_claimed_at` are either both null or both non-null.
- `retry_eligible` equals a total `CASE` expression: one only for ordinal-0 `rejected/provider_transient_failure/rate_limited`; zero otherwise.
- Non-rejected states require null failure facts; rejected requires both facts. Ready has neither timestamp, claimed has claim time only, and dispatched/rejected/unknown have both claim and resolution times.

The attempt triggers enforce:

- immutable `attempt_id`, command, ordinal, principal, destination, idempotency key, nonce, both expiries, and `created_at`;
- only same-state, `ready -> claimed`, `claimed -> dispatched|rejected|provider_dispatch_unknown`, and `provider_dispatch_unknown -> dispatched|rejected`;
- once non-null, both CallSids, provider claim time, and relay claim time are immutable;
- resolution time is immutable for dispatched/rejected and unknown-to-unknown; only unknown reconciliation to dispatched/rejected may replace its provisional resolution time;
- failure code/category and retry eligibility are frozen except when claimed/unknown first transitions to rejected;
- every DELETE aborts with `outbound_attempt_delete_forbidden`.

`provider_events` uses `dedupe_key TEXT NOT NULL PRIMARY KEY`. Its endpoint-shape check uses `callback_source IS 'call-progress-events'` for status rows, so NULL cannot bypass it. Status requires attempt, CallSid, safe sequence, fixed callback source, and no session; relay-ended requires CallSid/session and no attempt/status fields. The BEFORE trigger rejects an incompatible status attempt. The AFTER trigger reconciles compatible claimed/unknown attempts to dispatched. The receipt, reconciliation, event, idempotency row, and outbox row share one D1 batch and roll back together.

- [x] **Step 3: Implement expected-call allocation, durable claim, and dispatcher authority**

The required repository boundary is:

```ts
export interface ExpectedCallInput {
  attemptId: Ulid;
  commandId: Ulid;
  principalId: string;
  destinationIdentityId: string;
  idempotencyKey: string;
  authorizationExpiresAt: string;
  now: Date;
  attemptOrdinal: 0 | 1;
}

export type ProviderDispatchClaim =
  | { kind: "claimed"; capability: ProviderDispatchClaimCapability }
  | { kind: "authorization_expired" }
  | { kind: "relay_nonce_expired" }
  | { kind: "dispatched"; callSid: string }
  | { kind: "rejected"; failureCode: ProviderFailureCode; retryEligible: boolean }
  | { kind: "provider_dispatch_unknown" };

export type OutboundCallDispatchResult =
  | { status: "denied"; reason: PolicyReason; checkedAt: string; checkId: Ulid | null; attemptId: Ulid | null }
  | { status: "dispatched"; callSid: string; attemptId: Ulid }
  | { status: "rejected"; attemptId: Ulid; failureCode: ProviderFailureCode; retryEligible: boolean }
  | { status: "provider_dispatch_unknown"; attemptId: Ulid };

export class AttemptAllocationRaceError extends Error {
  constructor(readonly currentAttemptId: Ulid, readonly attemptOrdinal: 0 | 1);
}

beginProviderDispatch(
  capability: ProviderDispatchClaimCapability,
  expectedAttemptId: Ulid,
): void;
```

Allocation and replay rules:

1. `resolveDispatchIntent` returns ordinal 0 only with no rows and ordinal 1 only with exactly one known ordinal-0 retry-eligible rejection. Otherwise it returns the latest stored attempt.
2. `getOrCreateExpectedCall` captures every field exactly once before its first await. Existing replay requires exact command/principal/destination/idempotency/auth-expiry/ordinal lineage.
3. New allocation is one `INSERT ... SELECT` rooted in the matching allowed `policy_decisions` row. Its live computed ordinal must equal the required expected ordinal. Ordinal 1 additionally requires the sole ordinal-0 predecessor to match principal, destination, idempotency key, authorization expiry, command lineage, and known rate-limit retry authority.
4. After zero-row or constraint failure, classification first looks for a winner at the expected ordinal and raises `AttemptAllocationRaceError(winnerId, ordinal)`. Only after that does it classify retry limit, non-eligible retry, or conflict. This makes delayed ordinal-0 and ordinal-1 losers converge on the stored winner without promotion or nonce rotation.
5. The dispatcher carries the race error's ordinal through the bounded retry loop, rechecks/audits the winner, and supplies that same ordinal for exact replay.

Claim and provider rules:

1. One captured `observedAt` drives the conditional claim. `ready -> claimed` requires both `authorization_expires_at > observedAt` and `nonce_expires_at > observedAt`; equality is expired.
2. If no ready claim occurs, authorization expiry is reported before nonce expiry. Both outcomes leave the row unchanged and mint no capability. The dispatcher maps authorization expiry to denied `authorization_expired` and nonce-only expiry to denied `invalid_dispatch_attempt`, with `checkedAt=observedAt` and `checkId=null`.
3. A previously claimed row is changed to unknown using the same observation time, independent of expiry. A bounded second update handles the race where another observer claims between the failed update and reread; it can only recover unknown or observe a terminal row, never mint authority.
4. Only a repository-issued frozen capability from the successful ready claim is valid. `beginProviderDispatch(capability, expectedAttemptId)` synchronously verifies issuance, exact attempt binding, and not-begun/not-settled state, then marks it begun.
5. There is no await between that begin gate and `TwilioProvider.createCall`. Settlement requires issued + begun + not settled, marks settled before persistence, and may call exactly one success/rejection/unknown method. A persistence failure cannot authorize a second settlement or POST.
6. Exact primitive `CA` plus 32-hex validation precedes every public CallSid use. Provider success captures `callSid` exactly once. The same SID may reconcile callback/provider races; a different SID conflicts. Unknown or late rejection never downgrades callback-proven dispatch.
7. `claimExpectedCall` uses one conditional `UPDATE ... RETURNING`. The first signed claim requires an unexpired relay nonce and compatible claimed/dispatched/unknown state, identity, and provider SID. An identical already-bound CallSid replay succeeds after expiry; another SID or an unclaimed ready/rejected attempt fails.

The dispatcher snapshots the command and returned policy check as own-data-only immutable values. An allow must be paired with reason `allowed` and must echo exact check, attempt, command, and audited E.164 destination. The allocation loop is capped at three passes. It claims durable authority, calls `beginProviderDispatch`, then makes the sole POST. Correlation `idempotencyKey=attemptId` is not a Twilio idempotency header.

Only constructor-issued explicit 429/authentication/invalid-request failures become known rejections. Thrown, malformed, unsupported, 5xx, timeout, response loss, and malformed success become `provider_dispatch_unknown`. Only a known ordinal-0 transient/rate-limited rejection permits ordinal 1; no state permits ordinal 2.

- [x] **Step 4: Harden dispatch policy, provider facts, audit, and atomic event dependencies**

Dispatch-time policy uses the following authority sequence:

1. Capture a primitive initial clock sample and run kill-switch, authorization-expiry, and quiet-hours guards.
2. Await active-call count and direct-D1 retry count. Each count must be a non-negative safe integer; malformed facts fail closed.
3. Query daily count for a candidate UTC day, then capture a fresh final clock sample. If the day changed during the await, requery the new day. After three unstable rollovers, fail closed.
4. On a stable day, rerun kill-switch, authorization expiry, and quiet hours at the final sample, then apply active/daily/retry limits. `killSwitch` and `isQuietHours` must return exact booleans. A fresh `Date` copy is passed to quiet-hours code so mutation cannot alter the retained sample.
5. The accepted final sample is the persisted `checkedAt`. `retryCount` is `max(COUNT(outbound_call_attempts)-1, 0)` from D1; it is not supplied by `MutablePolicyContext`.

`ProviderFailure` has a private module mint token, a module-private issued-instance `WeakSet`, frozen own nominal fields, and an own-data snapshot validator. `instanceof` lookalikes, prototype fabrication, accessors, and post-construction mutation cannot authorize explicit rejection or retry. The rejection whitelist is exactly transient/rate_limited, authentication/authentication, and permanent/invalid_request.

`EventRepository.appendAtomic` captures `envelope`, `scope`, `key`, `requestHash`, and the factory exactly once before any await. Scope/key/hash must be primitive strings. Only after a genuine idempotency miss is the factory called once. Its result must be an actual array whose captured length is a safe integer from zero through two; indexed own entries are copied into a fresh array, so sparse arrays, length drift, and custom iterators cannot bypass the cap. Dependencies precede event/idempotency/outbox statements in the same batch. Replay never reruns the factory; dependency or final-statement failure rolls back the complete batch; an idempotency race rereads the durable winner.

- [x] **Step 5: Verify and commit the durable call-binding deliverable**

Focused command:

`pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/persistence/call-repository.test.ts apps/cloud-gateway/test/faults/calling-transaction-faults.test.ts apps/cloud-gateway/test/calls/outbound-call-dispatcher.test.ts apps/cloud-gateway/test/policy/policy-engine.test.ts`

Final evidence at `2971265`:

- Focused: 4 files, 148/148 tests passed.
- Full repository: 33 files, 809/809 tests passed.
- `pnpm typecheck` and `pnpm lint` passed all workspace projects.
- `pnpm audit --audit-level high` reported no known vulnerabilities.
- `git diff --check` passed.
- Independent Task 3 spec and security reviews found no remaining Important/Critical blocker.

Commits:

- `22a8b4c feat(calls): add atomic expected-call and provider-event persistence`
- `6c9fbfe test(calls): prove race candidates and callback reconciliation`
- `2971265 fix(calls): bind dispatch authority to durable attempt state`



### Task 4: Inbound Twilio ingress, DTMF PIN authentication, and neutral phone enrollment

**Files:**
- Create: `apps/cloud-gateway/src/persistence/migrations/0004_call_sessions.sql`
- Modify: `apps/cloud-gateway/src/persistence/call-repository.ts`
- Modify: `apps/cloud-gateway/test/persistence/migration.ts`
- Create: `apps/cloud-gateway/src/voice/inbound-auth.ts`
- Create: `apps/cloud-gateway/src/voice/inbound.ts`
- Test: `apps/cloud-gateway/test/persistence/call-session-repository.test.ts`
- Test: `apps/cloud-gateway/test/voice/inbound-auth.test.ts`
- Test: `apps/cloud-gateway/test/http/inbound-voice.test.ts`
- Test: `apps/cloud-gateway/test/security/inbound-auth-security.test.ts`

**Interfaces:**
- Consumes: shared `TwilioRequestVerifier`, foundation `IdentityChallengeService`, `renderConversationRelayTwiML`, Task 3 `CallRepository`, `CallPhase`, and `RelayEvent`.
- Produces: stable call-session persistence/routing, `CallRepository.getOrCreateInboundSession`, `getOrCreateOutboundSession`, `bindRelaySession`, `decodePinVerifierRecord`, `verifyPin`, `evaluatePinAttempt`, and `handleInboundVoiceWebhook`.

- [ ] **Step 1: Write failing pre-authentication and PIN secrecy tests**

```ts
it("rejects an unsigned webhook before creating a call session", async () => {
  twilio.signatureValid = false;
  const response = await handleInboundVoiceWebhook(request, dependencies);
  expect(response.status).toBe(403);
  expect(sessionFactory.created).toHaveLength(0);
});

it("verifies only an exact eight-digit PIN against the versioned secret record", async () => {
  expect(await verifyPin("12345678", record)).toBe(true);
  expect(await verifyPin("1234567", record)).toBe(false);
  expect(await verifyPin("123456789", record)).toBe(false);
});

it("counts a third completed bad PIN candidate as terminal without a canonical lockout", () => {
  expect(evaluatePinAttempt({ failedAttempts: 2, pinMatches: false })).toEqual({ nextFailedAttempts: 3, terminateCall: true });
});

it("creates only a neutral activation-only binding for a pending phone with a live local challenge", async () => {
  const response = await handleInboundVoiceWebhook(pendingCallerRequest, dependencies);
  expect(response.status).toBe(200);
  expect(sessionFactory.created[0]).toMatchObject({ identityId: "pending-phone", activationOnly: true, activationChallengeId: "challenge-phone-1" });
  expect(responseBody(response)).not.toMatch(/challenge-phone-1|pending-phone|482913/);
});

it("replays one stable inbound session and nonce when Twilio retries the signed webhook", async () => {
  const first = await handleInboundVoiceWebhook(activeCallerRequest, dependencies);
  const retry = await handleInboundVoiceWebhook(equivalentSignedRetryRequest(), dependencies);
  expect(await first.text()).toBe(await retry.text());
  expect(await readCallSessions(database)).toHaveLength(1);
  expect(sessionFactory.uniqueCreations).toBe(1);
});

it.each(["expired", "replayed", "mismatched"])("rejects a pending phone whose local challenge is %s before a session exists", async (failure) => {
  resolveCallerCandidate.failChallengeWith(failure);
  const response = await handleInboundVoiceWebhook(pendingCallerRequest, dependencies);
  expect(response.status).toBe(403);
  expect(sessionFactory.created).toEqual([]);
});
```

- [ ] **Step 2: Run inbound security tests to verify they fail**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/persistence/call-session-repository.test.ts apps/cloud-gateway/test/voice/inbound-auth.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/security/inbound-auth-security.test.ts`

Expected: FAIL with missing migration 0004, stable call-session methods, inbound authentication, and voice webhook handler.

- [ ] **Step 3: Implement versioned PIN verification and neutral ingress**

```sql
-- apps/cloud-gateway/src/persistence/migrations/0004_call_sessions.sql
CREATE TABLE call_sessions (
  session_id TEXT PRIMARY KEY CHECK (length(session_id) = 26),
  call_sid TEXT NOT NULL UNIQUE CHECK (length(call_sid) = 34 AND substr(call_sid, 1, 2) = 'CA' AND substr(call_sid, 3) NOT GLOB '*[^0-9A-Fa-f]*'),
  expected_attempt_id TEXT UNIQUE REFERENCES outbound_call_attempts(attempt_id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  activation_only INTEGER NOT NULL CHECK (activation_only IN (0, 1)),
  activation_challenge_id TEXT REFERENCES identity_challenges(challenge_id) ON DELETE RESTRICT,
  relay_nonce TEXT NOT NULL UNIQUE CHECK (length(CAST(relay_nonce AS BLOB)) = 43),
  nonce_expires_at TEXT NOT NULL,
  relay_setup_expires_at TEXT,
  provider_session_id TEXT UNIQUE CHECK (provider_session_id IS NULL OR (length(provider_session_id) = 34 AND substr(provider_session_id, 1, 2) = 'VX' AND substr(provider_session_id, 3) NOT GLOB '*[^0-9A-Fa-f]*')),
  phase TEXT NOT NULL DEFAULT 'created' CHECK (phase IN ('created', 'connecting', 'pre_auth', 'authenticated', 'active', 'ending', 'completed', 'rejected', 'failed', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((direction = 'inbound' AND expected_attempt_id IS NULL) OR (direction = 'outbound' AND expected_attempt_id IS NOT NULL AND session_id = expected_attempt_id)),
  CHECK ((activation_only = 1 AND direction = 'inbound' AND activation_challenge_id IS NOT NULL) OR (activation_only = 0 AND activation_challenge_id IS NULL)),
  CHECK ((direction = 'inbound' AND relay_setup_expires_at IS NOT NULL) OR (direction = 'outbound' AND relay_setup_expires_at IS NULL))
);
CREATE INDEX call_sessions_active_principal_idx ON call_sessions(principal_id, phase, created_at);
CREATE TRIGGER call_sessions_require_matching_outbound_attempt
BEFORE INSERT ON call_sessions
WHEN NEW.direction = 'outbound' AND NOT EXISTS (
  SELECT 1 FROM outbound_call_attempts a
  WHERE a.attempt_id = NEW.expected_attempt_id
    AND a.relay_call_sid = NEW.call_sid
    AND a.principal_id = NEW.principal_id
    AND a.destination_identity_id = NEW.identity_id
    AND a.relay_nonce = NEW.relay_nonce
    AND a.nonce_expires_at = NEW.nonce_expires_at
    AND a.provider_dispatch_state = 'dispatched'
)
BEGIN
  SELECT RAISE(ABORT, 'outbound_session_attempt_mismatch');
END;
```

`getOrCreateInboundSession` mints a session ULID and canonical relay nonce only for a new signed `CallSid`, stores both the nonce expiry and a five-minute `relaySetupExpiresAt`, and returns the still-valid stored row on an identical retry. Changed principal, identity, activation mode, challenge, or an expired never-connected row fails closed. `getOrCreateOutboundSession` uses `sessionId=attemptId`, copies only the already signed-and-claimed binding, retains the attempt's original `nonceExpiresAt` as claim evidence, and stores `relaySetupExpiresAt=null`; the trigger prevents drift. The outbound nonce expiry gates only the first signed CallSid claim in Task 3. Once that claim succeeds, the immutable CallSid/destination binding plus the separately signed WebSocket handshake authorize the first setup, so a lost TwiML response can be replayed after the original claim deadline without reopening the claim to another CallSid. Both session paths initialize the named Durable Object idempotently with the stored `RelayBinding` and nullable relay-setup deadline. `bindRelaySession` conditionally records the first provider `VX` SessionId for a compatible nonterminal CallSid and returns the same row on an identical replay; a different SessionId or terminal session fails. Phase updates use the Task 1 transition table, and active-count queries include only nonterminal phases.

```ts
// apps/cloud-gateway/src/voice/inbound-auth.ts
export interface PinVerifierRecordV1 { version: 1; algorithm: "PBKDF2-HMAC-SHA-256"; saltBase64: string; iterations: number; digestBase64: string; }

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function decodePinVerifierRecord(raw: string): PinVerifierRecordV1 {
  const value = JSON.parse(raw) as PinVerifierRecordV1;
  if (value.version !== 1 || value.algorithm !== "PBKDF2-HMAC-SHA-256" || value.iterations < 600000 || base64ToBytes(value.saltBase64).byteLength !== 16 || base64ToBytes(value.digestBase64).byteLength !== 32) throw new Error("invalid_pin_verifier");
  return value;
}

export async function verifyPin(pinDigits: string, record: PinVerifierRecordV1): Promise<boolean> {
  if (!/^\\d{8}$/.test(pinDigits)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pinDigits), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(record.saltBase64), iterations: record.iterations }, key, 256));
  const expected = base64ToBytes(record.digestBase64);
  if (derived.byteLength !== expected.byteLength) return false;
  let difference = 0; for (let i = 0; i < derived.byteLength; i += 1) difference |= derived[i] ^ expected[i];
  return difference === 0;
}

export function evaluatePinAttempt(input: { failedAttempts: number; pinMatches: boolean }): { nextFailedAttempts: number; terminateCall: boolean } {
  if (input.pinMatches) return { nextFailedAttempts: 0, terminateCall: false };
  const nextFailedAttempts = input.failedAttempts + 1;
  return { nextFailedAttempts, terminateCall: nextFailedAttempts >= 3 };
}
```

```ts
// apps/cloud-gateway/src/voice/inbound.ts
export async function handleInboundVoiceWebhook(request: Request, deps: { twilio: TwilioRequestVerifier; exactInboundWebhookUrl: string; publicOrigin: URL; resolveCallerCandidate(callerE164: string): Promise<{ principalId: string; identityId: string; state: "active"; activationChallengeId: null } | { principalId: string; identityId: string; state: "pending"; activationChallengeId: string } | null>; sessions: { getOrCreateInboundSession(input: { callSid: string; principalId: string; identityId: string; activationOnly: boolean; activationChallengeId: string | null }): Promise<{ sessionId: Ulid; relayNonce: string; relaySetupExpiresAt: string; binding: RelayBinding }> }; initializeSession(input: { sessionId: Ulid; binding: RelayBinding; relaySetupExpiresAt: string | null }): Promise<void> }): Promise<Response> {
  const form = await deps.twilio.verifyWebhook({ request, exactUrl: deps.exactInboundWebhookUrl });
  if (form === null) return new Response("forbidden", { status: 403 });
  const from = form.getAll("From");
  const callSid = form.getAll("CallSid");
  if (from.length !== 1 || callSid.length !== 1 || !/^CA[0-9A-Fa-f]{32}$/.test(callSid[0] ?? "")) return new Response("rejected", { status: 403 });
  const candidate = await deps.resolveCallerCandidate(from[0] ?? "");
  if (!candidate) return new Response("rejected", { status: 403 });
  const session = await deps.sessions.getOrCreateInboundSession({ callSid: callSid[0]!, principalId: candidate.principalId, identityId: candidate.identityId, activationOnly: candidate.state === "pending", activationChallengeId: candidate.activationChallengeId });
  await deps.initializeSession({ sessionId: session.sessionId, binding: session.binding, relaySetupExpiresAt: session.relaySetupExpiresAt });
  const sessionUrl = new URL(`/voice/relay/${session.sessionId}`, deps.publicOrigin); sessionUrl.protocol = "wss:";
  const body = renderConversationRelayTwiML({ publicOrigin: deps.publicOrigin, sessionUrl, actionUrl: new URL("/voice/relay-ended", deps.publicOrigin), relayNonce: session.relayNonce, voiceConfig: { language: "en-US", transcriptionProvider: "Deepgram", speechModel: "nova-3-general", ttsProvider: "Google", voice: "en-US-Journey-O" } });
  return new Response(body, { headers: { "content-type": "text/xml; charset=UTF-8", "cache-control": "no-store" } });
}
```

`verifyWebhook` owns and consumes the original request. The handler receives only `VerifiedTwilioForm`, requires every semantic singleton through `getAll(name).length === 1`, and never clones, pre-buffers, decodes, or reparses the provider body. `exactInboundWebhookUrl` and `publicOrigin` come from validated trusted configuration, never forwarded headers or request parameters; the same origin is supplied to the strict TwiML renderer.

Unknown or blocked callers are rejected before ConversationRelay. A pending bootstrap phone identity may enter only an `activationOnly` neutral session when an enrolled device has begun a still-valid challenge; its opaque challenge ID is bound into the session and the plaintext response is displayed only by the authenticated local CLI. The caller first enters the normal eight-digit PIN and is then prompted to enter that separate one-time DTMF response. Only successful verification of both factors against the provider-observed pending identity activates it. The session speaks neutral prompts and a neutral outcome, never speaks or persists either digit sequence, never loads memory, purpose, or model context, and ends after success or failure. The user places a new normal inbound call after activation.

- [ ] **Step 4: Run inbound security tests to verify they pass**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/persistence/call-session-repository.test.ts apps/cloud-gateway/test/voice/inbound-auth.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/security/inbound-auth-security.test.ts`

Expected: PASS with signature-first rejection, no PIN or one-time-challenge leakage, expiry/replay/mismatch rejection, provider-bound two-factor pending phone activation, and no persistent spoofed-ID lockout.

- [ ] **Step 5: Commit the inbound authentication deliverable**

```bash
git add apps/cloud-gateway/src/persistence/migrations/0004_call_sessions.sql apps/cloud-gateway/src/persistence/call-repository.ts apps/cloud-gateway/test/persistence/migration.ts apps/cloud-gateway/src/voice/inbound-auth.ts apps/cloud-gateway/src/voice/inbound.ts apps/cloud-gateway/test/persistence/call-session-repository.test.ts apps/cloud-gateway/test/voice/inbound-auth.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/security/inbound-auth-security.test.ts
git commit -m "feat(calls): add signed inbound DTMF authentication"
```

### Task 5: Shared streaming conversation and outbox contracts

**Files:**
- Create: `apps/cloud-gateway/src/model/model-adapter.ts`
- Create: `apps/cloud-gateway/src/conversation/conversation-service.ts`
- Create: `apps/cloud-gateway/src/conversation/context-retriever.ts`
- Create: `apps/cloud-gateway/src/conversation/outbox-dispatcher.ts`
- Modify: `apps/cloud-gateway/src/providers/fake-model-provider.ts`
- Test: `apps/cloud-gateway/test/conversation/conversation-service.test.ts`
- Test: `apps/cloud-gateway/test/conversation/outbox-dispatcher.test.ts`

**Interfaces:**
- Consumes: foundation `ModelProvider`, `FakeModelProvider`, `Redactor`, `EventRepository`, `Ulid`, and `JsonValue`.
- Produces: `ContextRetriever.retrieve`, `ModelAdapter.stream`, `ConversationService.handleTurn`, and `OutboxDispatcher.dispatch` for voice and the later Telegram plan.

- [ ] **Step 1: Write failing streamed-token and channel-specific delivery tests**

```ts
it("records voice output only as sent_to_provider and never promotes it to delivered history", async () => {
  const received: string[] = [];
  const controller = new AbortController();
  const completion = service.handleTurn({ sessionId, principalId, channel: "voice", turnId, text: "hello", signal: controller.signal, delivery: { kind: "voice_stream", onToken: async (token) => { received.push(token.text); }, finish: async () => ({ outcome: "sent_to_provider" }) } });
  await fakeModel.emitToken("hello");
  expect(await events.assistantEvents(sessionId)).toEqual([]);
  await fakeModel.complete();
  const result = await completion;
  expect(received.join("")).toBe("hello");
  expect(result).toMatchObject({ deliveredAssistantEventId: null });
  expect(result.sentAssistantEventId).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  expect(await events.assistantHistory(sessionId)).toEqual([]);
  expect(await events.voiceDeliveryStates(sessionId)).toEqual(["sent_to_provider"]);
});

it("does not redispatch an outbox idempotency key after a delivered acknowledgement", async () => {
  await outbox.stage(fixtureOutboxRow({ outboxId, channel: "telegram", idempotencyKey: "delivery-1" }));
  await dispatcher.dispatch(outboxId);
  await dispatcher.dispatch(outboxId);
  expect(channel.deliveries).toHaveLength(1);
});

it("stages a fixed system notice without calling the model or inventing an outbox id", async () => {
  const staged = await service.stageSystemNotice({ sessionId: "telegram:44", principalId, channel: "telegram", noticeCode: "busy", idempotencyKey: "telegram-busy:44:9", payload: { chatId: "44", replyToMessageId: 9 } });
  expect(staged.outboxId).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  expect(fakeModel.requests).toHaveLength(0);
  await dispatcher.dispatch(staged.outboxId);
  expect(channel.deliveries[0].text).toBe("Jarvis is busy. Please try again shortly.");
});

it("stages Telegram assistant text and its outbox intent atomically before delivery", async () => {
  const promise = service.handleTurn(telegramTurnInput({ delivery: { kind: "outbox", idempotencyKey: "telegram-reply:44:9", payload: { chatId: "44", replyToMessageId: 9 } } }));
  await fakeModel.completeWith("hello");
  await promise;
  expect(events.transactionOrder).toEqual(["user_committed", "assistant_staged_with_outbox", "provider_delivered", "assistant_committed"]);
});

it("stores only a safe failure event and never calls the model when redaction fails", async () => {
  redactor.failNext();
  await expect(service.handleTurn(turnInput())).rejects.toThrow("ingest_redaction_failed");
  expect(fakeModel.requests).toHaveLength(0);
  expect(await events.safeFailures(turnId)).toEqual(["ingest_redaction_failed"]);
});

it("retrieves only the authenticated principal scope and keeps context structurally separate", async () => {
  await service.handleTurn(turnInput());
  expect(retriever.requests[0]).toMatchObject({ principalId, purpose: "conversation" });
  expect(fakeModel.requests[0]).toMatchObject({ userText: "hello", context: [{ sourceEventId, text: "remembered", sensitivity: "personal" }] });
});
```

- [ ] **Step 2: Run shared-conversation tests to verify they fail**

Run: `pnpm test:cloud -- conversation/conversation-service.test.ts conversation/outbox-dispatcher.test.ts`

Expected: FAIL because the model adapter, conversation service, and outbox dispatcher do not exist.

- [ ] **Step 3: Implement the shared streaming and delivery contract**

```ts
// apps/cloud-gateway/src/model/model-adapter.ts
export interface ModelToken { index: number; text: string; }
export interface ModelAdapter {
  stream(input: { correlationId: Ulid; principalId: string; channel: "voice" | "telegram"; userText: string; context: readonly RetrievedContext[]; timeoutMs: number; contextTokenBudget: number; signal: AbortSignal }): AsyncIterable<ModelToken>;
}

// apps/cloud-gateway/src/conversation/conversation-service.ts
export class DefaultConversationService implements ConversationService {
  constructor(private readonly model: ModelAdapter, private readonly redactor: Redactor, private readonly context: ContextRetriever, private readonly events: ConversationEventStore, private readonly dispatcher: OutboxDispatcher) {}
  async handleTurn(input: Parameters<ConversationService["handleTurn"]>[0]): Promise<{ committedUserEventId: Ulid; sentAssistantEventId: Ulid | null; deliveredAssistantEventId: Ulid | null }> {
    const redacted = await this.redactor.redact({ text: input.text, channel: input.channel, field: "turn.text" });
    if (!redacted.ok) { await this.events.commitSafeFailure(input, redacted.category); throw new Error(redacted.category); }
    const committedUserEventId = await this.events.commitUser({ ...input, text: redacted.text });
    const context = await this.context.retrieve({ principalId: input.principalId, channel: input.channel, purpose: "conversation", query: redacted.text, maxTokens: input.channel === "voice" ? 32000 : 48000 });
    let finalText = "";
    for await (const token of this.model.stream({ correlationId: input.turnId, principalId: input.principalId, channel: input.channel, userText: redacted.text, context, timeoutMs: 30000, contextTokenBudget: input.channel === "voice" ? 32000 : 48000, signal: input.signal })) {
      finalText += token.text;
      if (input.delivery.kind === "voice_stream") await input.delivery.onToken(token);
    }
    if (input.signal.aborted) { await this.events.commitCancelledAssistant(input); return { committedUserEventId, sentAssistantEventId: null, deliveredAssistantEventId: null }; }
    if (input.delivery.kind === "outbox") {
      const outboxId = await this.events.stageAssistantDelivery({ ...input, text: finalText, idempotencyKey: input.delivery.idempotencyKey, payload: { ...input.delivery.payload, text: finalText } });
      const result = await this.dispatcher.dispatch(outboxId);
      return { committedUserEventId, sentAssistantEventId: null, deliveredAssistantEventId: result.deliveredAssistantEventId };
    }
    const finished = await input.delivery.finish(finalText);
    if (finished.outcome !== "sent_to_provider") throw new Error("invalid_voice_delivery_outcome");
    const sentAssistantEventId = await this.events.recordVoiceAssistantSent({ ...input, text: finalText, historyEligible: false });
    return { committedUserEventId, sentAssistantEventId, deliveredAssistantEventId: null };
  }
  async stageSystemNotice(input: Parameters<ConversationService["stageSystemNotice"]>[0]): Promise<{ outboxId: Ulid }> {
    return { outboxId: await this.events.stageSystemDelivery({ ...input, text: "Jarvis is busy. Please try again shortly.", historyMode: "none" }) };
  }
}
```

```ts
// apps/cloud-gateway/src/conversation/outbox-dispatcher.ts
export interface ChannelDelivery { deliver(item: LeasedOutboxItem): Promise<{ delivered: boolean }>; }
export class DefaultOutboxDispatcher implements OutboxDispatcher {
  constructor(private readonly outbox: OutboxStore, private readonly channels: ReadonlyMap<string, ChannelDelivery>) {}
  async dispatch(outboxId: Ulid): Promise<{ delivered: boolean; deliveredAssistantEventId: Ulid | null }> {
    const item = await this.outbox.lease(outboxId);
    if (item.state === "delivered") return { delivered: true, deliveredAssistantEventId: item.deliveredAssistantEventId };
    const channel = this.channels.get(item.channel); if (!channel) throw new Error("delivery_channel_unregistered");
    const result = await channel.deliver(item);
    if (!result.delivered) return { delivered: false, deliveredAssistantEventId: null };
    return this.outbox.markDeliveredAndCommitHistory(item);
  }
}
```

`ConversationEventStore.stageAssistantDelivery` submits the staged assistant payload, idempotency record, and pending outbox row through one foundation `TransactionRunner.batch()`. No assistant-history event exists yet. `stageSystemDelivery` uses the same durable path with `historyMode: "none"` and maps the allowlisted notice code to fixed text. `OutboxDispatcher` leases only a stored row, routes it to the registered channel adapter, retries according to that adapter's bounded policy, and uses one batch to record provider delivery plus the committed assistant event when `historyMode` is `assistant`; system notices commit delivery with no conversational-history event. Terminal delivery failure records a safe outcome with no assistant history. A caller can never invent an outbox ID at the dispatch boundary, and only the dispatcher can complete a staged row.

Voice deliberately does not use the outbox delivery acknowledgement contract. Current ConversationRelay documentation provides no playback acknowledgement that this implementation has proven in a live gate. `finish` therefore accepts only the nominal `sent_to_provider` outcome, `recordVoiceAssistantSent` creates a post-redaction operational event with `historyEligible: false`, and `deliveredAssistantEventId` remains `null`. An interrupt or socket close can append a cancellation transition for that sent event but can never promote it to delivered. Only a later credentialed contract update may introduce `delivered_to_caller` for voice.

Implement `D1ContextRetriever` with an explicit principal, authenticated-channel purpose, sensitivity filter, source identifiers, and deterministic token budget. At this stage it reads only recent committed post-redaction events; the memory plan extends the same implementation with the latest active fact projection. Retrieved text remains a data field passed separately from `userText` and cannot supply system instructions, tools, policy decisions, or action authorization. The call session invokes `ConversationService` only after DTMF authentication, so no pre-auth path can call the retriever.

- [ ] **Step 4: Run shared-conversation tests to verify they pass**

Run: `pnpm test:cloud -- conversation/conversation-service.test.ts conversation/outbox-dispatcher.test.ts; pnpm typecheck`

Expected: PASS; every model token reaches the voice provider without entering assistant history, Telegram history commits only after its durable acknowledgement, and duplicate outbox delivery is suppressed.

- [ ] **Step 5: Commit the shared service deliverable**

```bash
git add apps/cloud-gateway/src/model/model-adapter.ts apps/cloud-gateway/src/conversation apps/cloud-gateway/src/providers/fake-model-provider.ts apps/cloud-gateway/test/conversation
git commit -m "feat(conversation): add shared streaming turn and outbox services"
```

### Task 6: Durable Object relay session, post-auth transcript rules, and interruption

**Files:**
- Create: `apps/cloud-gateway/src/voice/call-session-do.ts`
- Modify: `apps/cloud-gateway/src/index.ts`
- Modify: `apps/cloud-gateway/src/persistence/call-repository.ts`
- Test: `apps/cloud-gateway/test/voice/call-session-do.test.ts`
- Test: `apps/cloud-gateway/test/security/relay-binding.test.ts`

**Interfaces:**
- Consumes: `CallPhase`, `transitionCall`, `canPersistTurn`, `verifyPin`, `evaluatePinAttempt`, `RelayBinding`, `RelayEvent`, `CallRepository`, and calling-owned `ConversationService`.
- Produces: Durable Object class `CallSession`, idempotent RPC `CallSession.initialize`, signed-upgrade `fetch`, real WebSocket message/close callbacks, and testable `CallSessionCore.handleRelayEvent`/`validateRelaySetup`.

- [ ] **Step 1: Write failing relay-binding and interruption tests**

```ts
it("rejects a mismatched outbound relay setup before model traffic", async () => {
  await expect(session.handleRelayEvent(relaySetup({ callSid: `CA${"9".repeat(32)}` }))).rejects.toThrow("relay_binding_rejected");
  expect(conversation.handleTurn).not.toHaveBeenCalled();
});

it("accepts setup once and rejects a replay before another state transition", async () => {
  await session.handleRelayEvent(relaySetup());
  await expect(session.handleRelayEvent(relaySetup())).rejects.toThrow("relay_setup_replayed");
  expect(relay.close).toHaveBeenCalledTimes(1);
});

it("allows the first outbound setup after its signed CallSid claim deadline", async () => {
  const recovered = createSession({ direction: "outbound", relaySetupExpiresAt: null, now: AFTER_ATTEMPT_NONCE_EXPIRY });
  await recovered.handleRelayEvent(relaySetup({ direction: "outbound" }));
  expect(recovered.phase).toBe("pre_auth");
  expect(repository.bindRelaySession).toHaveBeenCalledTimes(1);
});

it("rejects an inbound setup after its separate relay setup deadline", async () => {
  const expired = createSession({ direction: "inbound", relaySetupExpiresAt: BEFORE_NOW });
  await expect(expired.handleRelayEvent(relaySetup({ direction: "inbound" }))).rejects.toThrow("relay_binding_rejected");
  expect(repository.bindRelaySession).not.toHaveBeenCalled();
});

it("ignores partial prompts and creates its own ULID only for a final prompt", async () => {
  await session.handleRelayEvent(relaySetup());
  await authenticateWithDigits(session, "12345678");
  await session.handleRelayEvent({ type: "prompt", text: "What is", language: "en-US", final: false });
  expect(conversation.handleTurn).not.toHaveBeenCalled();
  await session.handleRelayEvent({ type: "prompt", text: "What is next?", language: "en-US", final: true });
  expect(conversation.handleTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId: GENERATED_TURN_ULID, text: "What is next?" }));
});

it("accumulates one DTMF key at a time without leaking or verifying an incomplete PIN", async () => {
  await session.handleRelayEvent(relaySetup());
  for (const digit of "1234567") await session.handleRelayEvent({ type: "dtmf", digit });
  expect(pinVerifier.verify).not.toHaveBeenCalled();
  await session.handleRelayEvent({ type: "dtmf", digit: "8" });
  expect(pinVerifier.verify).toHaveBeenCalledTimes(1);
  expect(modelRequestsAndPersistence()).not.toContain("12345678");
});

it("terminates only this call after three completed bad PIN candidates", async () => {
  await session.handleRelayEvent(relaySetup());
  for (let attempt = 0; attempt < 3; attempt += 1) for (const digit of "00000000") await session.handleRelayEvent({ type: "dtmf", digit });
  expect(session.phase).toBe("rejected");
  expect(await throttles.isCanonicalIdentityLocked("sid-principal")).toBe(false);
});

it("requires PIN then a separate six-digit local challenge for activation without model or digit leakage", async () => {
  const pendingSession = createPendingActivationSession({ challengeId: "challenge-phone-1", identityId: "pending-phone" });
  await pendingSession.handleRelayEvent(relaySetup({ direction: "inbound" }));
  for (const digit of "12345678") await pendingSession.handleRelayEvent({ type: "dtmf", digit });
  expect(identityChallenges.confirm).not.toHaveBeenCalled();
  for (const digit of "482913") await pendingSession.handleRelayEvent({ type: "dtmf", digit });
  expect(identityChallenges.confirm).toHaveBeenCalledWith(expect.objectContaining({ challengeId: "challenge-phone-1", response: "482913", observedChannelIdentityId: "pending-phone", pinAuthenticated: true }));
  expect(conversation.handleTurn).not.toHaveBeenCalled();
  expect(eventsAndLogs()).not.toMatch(/12345678|482913/);
});

it.each(["expired", "replayed", "mismatched"])("fails a %s activation response without personal context", async (failure) => {
  const pendingSession = createPendingActivationSession();
  identityChallenges.failWith(failure);
  await pendingSession.handleRelayEvent(relaySetup({ direction: "inbound" }));
  for (const digit of "12345678") await pendingSession.handleRelayEvent({ type: "dtmf", digit });
  for (const digit of "482913") await pendingSession.handleRelayEvent({ type: "dtmf", digit });
  expect(pendingSession.phase).toBe("failed");
  expect(conversation.handleTurn).not.toHaveBeenCalled();
});

it("marks interrupted voice output cancelled and never promotes it to delivered history", async () => {
  await session.handleRelayEvent(relaySetup());
  await authenticateWithDigits(session, "12345678");
  conversation.blockNextTurn();
  const turn = session.handleRelayEvent({ type: "prompt", text: "What is next?", language: "en-US", final: true });
  await conversation.waitUntilTurnStarted();
  await session.handleRelayEvent({ type: "interrupt" });
  await turn;
  expect(await repository.historyFor(session.callSid)).not.toContain("long model response");
  expect(await repository.voiceDeliveryStates(session.callSid)).not.toContain("delivered_to_caller");
});
```

- [ ] **Step 2: Run the Durable Object tests to verify they fail**

Run: `pnpm vitest run apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts`

Expected: FAIL with module-not-found error for `call-session-do.ts`.

- [ ] **Step 3: Implement binding verification and committed-turn handling**

```ts
// apps/cloud-gateway/src/voice/call-session-do.ts
export class CallSessionCore {
  phase: CallPhase = "created";
  private failedPinAttempts = 0;
  private awaitingPhoneActivationChallenge = false;
  private relaySetupVerified = false;
  private pinDigits = "";
  private activationDigits = "";
  private activeTurnAbort: AbortController | null = null;
  private lastSentAssistantEventId: Ulid | null = null;
  private socketClosed = false;
  constructor(readonly callSid: string, private readonly expected: RelayBinding, private readonly expectedRelaySetupExpiresAt: string | null, private readonly expectedAccountSid: string, private readonly repository: CallRepository, private readonly conversation: ConversationService, private readonly relay: { sendToken(text: string): Promise<void>; finish(finalText: string): Promise<{ outcome: "sent_to_provider" }>; cancel(): Promise<void>; close(code: number): void }, private readonly pinVerifier: { verify(digits: string): Promise<boolean> }, private readonly identityChallenges: IdentityChallengeService, private readonly throttles: { record(input: { callSid: string; bucket: string; now: Date }): Promise<void> }, private readonly newUlid: () => Ulid, private readonly now: () => Date) {}

  async validateRelaySetup(actual: Extract<RelayEvent, { type: "setup" }>): Promise<void> {
    if ((this.expectedRelaySetupExpiresAt !== null && this.now().toISOString() >= this.expectedRelaySetupExpiresAt) || actual.accountSid !== this.expectedAccountSid || actual.callSid !== this.expected.callSid || actual.relayNonce !== this.expected.relayNonce || actual.direction !== this.expected.direction) throw new Error("relay_binding_rejected");
  }

  beginPreAuth(): void { this.phase = transitionCall(this.phase, "connecting"); this.phase = transitionCall(this.phase, "pre_auth"); }

  async handleRelayEvent(event: RelayEvent): Promise<void> {
    if (event.type === "setup") {
      if (this.relaySetupVerified) { this.relay.close(1008); throw new Error("relay_setup_replayed"); }
      try { await this.validateRelaySetup(event); }
      catch (error) { this.relay.close(1008); throw error; }
      await this.repository.bindRelaySession({ callSid: event.callSid, providerSessionId: event.sessionId });
      this.relaySetupVerified = true; this.beginPreAuth(); return;
    }
    if (!this.relaySetupVerified) throw new Error("relay_setup_required");
    if (event.type === "dtmf") { await this.handleDtmf(event.digit); return; }
    if (event.type === "interrupt") { await this.cancelCurrentOutput("provider_interrupt"); return; }
    if (event.type === "error") { await this.handleSocketClose("provider_error"); return; }
    if (event.type !== "prompt" || !event.final || this.phase !== "active") return;
    if (event.text.length === 0) return;
    if (event.language !== "en-US" || new TextEncoder().encode(event.text).byteLength > 8000) throw new Error("turn_too_large");
    if (this.activeTurnAbort !== null) throw new Error("turn_in_progress");
    const controller = new AbortController(); this.activeTurnAbort = controller;
    try {
      const result = await this.conversation.handleTurn({ sessionId: this.callSid, principalId: this.expected.principalId, channel: "voice", turnId: this.newUlid(), text: event.text, signal: controller.signal, delivery: { kind: "voice_stream", onToken: async (token) => this.relay.sendToken(token.text), finish: async (finalText) => this.relay.finish(finalText) } });
      this.lastSentAssistantEventId = result.sentAssistantEventId;
    } finally { if (this.activeTurnAbort === controller) this.activeTurnAbort = null; }
  }

  private async handleDtmf(digit: string): Promise<void> {
    if (this.phase === "authenticated" && this.expected.activationOnly && this.awaitingPhoneActivationChallenge) {
      if (!/^\d$/.test(digit)) { this.activationDigits = ""; return; }
      this.activationDigits += digit;
      if (this.activationDigits.length < 6) return;
      const digits = this.activationDigits; this.activationDigits = "";
      try {
        if (!this.expected.activationChallengeId) throw new Error("activation_challenge_missing");
        await this.identityChallenges.confirm({ challengeId: this.expected.activationChallengeId, response: digits, observedChannelIdentityId: this.expected.identityId, pinAuthenticated: true });
        await this.repository.appendAuthenticationOutcome(this.callSid, "phone_identity_activated");
        await this.relay.sendToken("Phone verification complete. Please call again to use Jarvis.");
        this.phase = transitionCall(this.phase, "ending"); this.phase = transitionCall(this.phase, "completed");
      } catch {
        await this.repository.appendAuthenticationOutcome(this.callSid, "phone_identity_activation_failed");
        await this.relay.sendToken("Phone verification could not be completed.");
        this.phase = transitionCall(this.phase, "failed");
      }
      return;
    }
    if (this.phase !== "pre_auth") return;
    if (!/^\d$/.test(digit)) { this.pinDigits = ""; return; }
    this.pinDigits += digit;
    if (this.pinDigits.length < 8) return;
    const digits = this.pinDigits; this.pinDigits = "";
    if (await this.pinVerifier.verify(digits)) {
      this.phase = transitionCall(this.phase, "authenticated");
      await this.repository.appendAuthenticationOutcome(this.callSid, "authenticated");
      if (this.expected.activationOnly) {
        this.awaitingPhoneActivationChallenge = true;
        await this.relay.sendToken("Enter the one-time phone enrollment challenge shown in your local Jarvis CLI.");
        return;
      }
      this.phase = transitionCall(this.phase, "active");
      return;
    }
    const result = evaluatePinAttempt({ failedAttempts: this.failedPinAttempts, pinMatches: false });
    this.failedPinAttempts = result.nextFailedAttempts;
    await this.throttles.record({ callSid: this.callSid, bucket: this.callSid, now: new Date() });
    await this.repository.appendAuthenticationOutcome(this.callSid, "rejected");
    if (result.terminateCall) this.phase = transitionCall(this.phase, "rejected");
  }

  private async cancelCurrentOutput(reason: "provider_interrupt" | "socket_closed"): Promise<void> {
    this.activeTurnAbort?.abort();
    await this.relay.cancel();
    if (this.lastSentAssistantEventId !== null) await this.repository.cancelSentVoiceAssistant({ callSid: this.callSid, assistantEventId: this.lastSentAssistantEventId, reason });
    this.lastSentAssistantEventId = null;
  }

  async handleSocketClose(reason: "socket_closed" | "provider_error" = "socket_closed"): Promise<void> {
    if (this.socketClosed) return;
    this.socketClosed = true;
    await this.cancelCurrentOutput("socket_closed");
    this.pinDigits = ""; this.activationDigits = "";
    await this.repository.appendRelayLifecycleOutcome(this.callSid, reason);
    if (this.phase === "authenticated" || this.phase === "active") { this.phase = transitionCall(this.phase, "ending"); this.phase = transitionCall(this.phase, "completed"); }
    else if (this.phase === "created" || this.phase === "connecting" || this.phase === "pre_auth") this.phase = transitionCall(this.phase, "failed");
  }
}
```

The same module exports the actual Cloudflare wrapper; the injected class above is its testable state machine, not the Wrangler export by itself:

```ts
export class CallSession extends DurableObject<Env> {
  async initialize(input: { sessionId: Ulid; binding: RelayBinding; relaySetupExpiresAt: string | null }): Promise<void> {
    // In one storage transaction create immutable session/binding state, or return
    // success only when an existing record is byte-for-byte the same. A changed
    // CallSid/principal/identity/direction/nonce/activation binding fails closed.
  }

  override async fetch(request: Request): Promise<Response> {
    // The Worker route has already verified the exact signed WSS handshake. Require
    // one GET WebSocket upgrade and initialized state, reject a second live socket,
    // accept the server half with ctx.acceptWebSocket, and return the client half.
  }

  override async webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    // Reject binary with 1003; measure text UTF-8 before JSON and close >64 KiB with
    // 1009; parse through parseRelayEvent and delegate to the one hydrated core.
  }

  override async webSocketClose(): Promise<void> {
    await (await this.core()).handleSocketClose("socket_closed");
  }
}
```

`apps/cloud-gateway/src/index.ts` imports and re-exports this `CallSession` name for the existing Wrangler binding; it no longer declares the Task 1 skeleton. Initialization persists the immutable `RelayBinding`, nullable `relaySetupExpiresAt`, and resumable safe phase/output identifiers in Durable Object storage. Idempotent re-initialization requires all of those fields to be byte-for-byte equal. DTMF buffers and raw partial/provider text remain memory-only and are cleared on hibernation/close; hibernation during authentication requires a fresh neutral call rather than persisting digits. D1 `call_sessions` is the global routing/lifecycle projection, while the named Durable Object serializes the live socket and turn.

Every Task 4/6 test helper that sends DTMF or prompt input first sends one valid `setup` event. Before setup every frame fails closed; a second setup closes the socket and cannot restart the state machine. Setup validation binds configured AccountSid, `callSid`, relay nonce, and mapped direction, enforces the separate setup deadline when non-null, then atomically records the provider `VX` SessionId for the later relay-ended callback. Inbound sessions use the bounded setup deadline; an outbound session already passed the expiring signed CallSid claim and uses `null`, allowing only its first separately signed, exact CallSid-bound setup even after a lost TwiML response. Terminal sessions still reject setup. The route calls the idempotent `handleSocketClose` from the real WebSocket close callback; there is no synthetic JSON `disconnect` event.

The Durable Object ignores partial prompts entirely and mints a fresh local ULID only for a final prompt accepted in `active`. It treats DTMF as transient one-key frames: an in-memory numeric buffer invokes the PIN verifier only after exactly eight digits, then a separate buffer invokes the activation challenge only after exactly six digits. `*` or `#` clears the current buffer without persistence. Buffers are cleared after each complete candidate, setup failure, socket close, and terminal transition. The verifier and challenge service receive completed candidates directly, while events, logs, transcripts, model requests, and error details receive only allowlisted outcomes. The activation challenge is never retried inside the same call after a failed, expired, mismatched, or replayed response.

Voice `sendToken`/`finish` proves only `sent_to_provider`. The session retains the returned operational event ID solely so interrupt or socket close can cancel it; neither normal completion nor interruption creates delivered assistant history. The credentialed Task 9 gate may later justify a separate playback-acknowledged state, but this implementation must not infer it.

- [ ] **Step 4: Run the relay tests to verify they pass**

Run: `pnpm vitest run apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts`

Expected: PASS with binding rejection before model invocation and cancelled assistant output absent from history.

- [ ] **Step 5: Commit the call-session deliverable**

```bash
git add apps/cloud-gateway/src/voice/call-session-do.ts apps/cloud-gateway/src/index.ts apps/cloud-gateway/src/persistence/call-repository.ts apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts
git commit -m "feat(calls): connect durable relay session to shared streaming conversation"
```

### Task 7: Outbound authorization, expected-call nonce binding, and recipient verification

**Files:**
- Create: `apps/cloud-gateway/src/voice/outbound.ts`
- Test: `apps/cloud-gateway/test/voice/outbound.test.ts`
- Test: `apps/cloud-gateway/test/security/outbound-security.test.ts`

**Interfaces:**
- Consumes: `OutboundCallCommand`, `snapshotOutboundCallRequest`, Task 3 crash-safe `OutboundCallDispatcher`, Task 4 call-session persistence, `CallRepository`, foundation `PolicyEngine`, shared `TwilioRequestVerifier`, trusted public URL configuration, and `renderConversationRelayTwiML`.
- Produces: `dispatchOutboundCall` as the initial-authorization adapter and Request-owning `claimOutboundTwiML`. It never calls `TwilioProvider` directly and never creates or rotates a relay nonce.

- [ ] **Step 1: Write failing issuer, policy-recheck, replay, and voicemail tests**

```ts
it("denies model-originated commands before creating a policy decision", async () => {
  const decision = await policy.evaluateOutboundCall({ ...command, issuedBy: "model" as never });
  expect(decision).toMatchObject({ decision: "deny", reason: "invalid_origin" });
  expect(twilio.requests).toEqual([]);
});

it("rechecks kill switch immediately before dispatch", async () => {
  policy.pauseAfterInitialAllow();
  const pending = dispatchOutboundCall(command, dependencies);
  await policy.waitForInitialAllow();
  policyContext.killSwitch = true;
  policy.releaseDispatcher();
  await expect(pending).resolves.toMatchObject({ status: "denied", reason: "kill_switch_enabled" });
  expect(twilio.requests).toHaveLength(0);
});

it("delegates the only provider invocation through the durable attempt gate", async () => {
  const dispatchSpy = vi.spyOn(dispatcher, "dispatch");
  await dispatchOutboundCall(command, dependencies);
  await dispatchOutboundCall(command, dependencies);
  expect(dispatchSpy).toHaveBeenCalledTimes(2);
  expect(twilio.requests).toHaveLength(1);
  expect(twilio.requests[0]).toMatchObject({ attemptId: ATTEMPT_0, commandId: command.commandId });
});

it("consumes the original signed Request once and idempotently replays the same outbound TwiML claim", async () => {
  const first = await claimOutboundTwiML(originalRequest, ATTEMPT_0, dependencies);
  clock.advancePastAttemptNonceExpiry();
  const retry = await claimOutboundTwiML(signedRequestWithSameCallSid(), ATTEMPT_0, dependencies);
  expect(verifier.requests[0]).toBe(originalRequest);
  expect(first.status).toBe(200);
  expect(await retry.text()).toBe(await first.clone().text());
  expect(sessionFactory.sessionIds).toEqual([ATTEMPT_0, ATTEMPT_0]);
  expect(sessionFactory.uniqueCreations).toBe(1);
  expect(sessionFactory.initializations).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: ATTEMPT_0, relaySetupExpiresAt: null })]));
});

it("rejects a different signed CallSid for an already claimed attempt", async () => {
  await claimOutboundTwiML(originalRequest, ATTEMPT_0, dependencies);
  const response = await claimOutboundTwiML(signedRequestWithCallSid(CALL_SID_2), ATTEMPT_0, dependencies);
  expect(response.status).toBe(403);
});

it("leaves only the neutral voicemail sentence before PIN verification", async () => {
  const message = await outboundSession.voicemailText();
  expect(message).toBe("Jarvis called for Sid. No private message was left.");
  expect(message).not.toContain("smoke");
});
```

- [ ] **Step 2: Run outbound tests to verify they fail**

Run: `pnpm test:cloud -- voice/outbound.test.ts security/outbound-security.test.ts`

Expected: FAIL with a module-not-found error for `outbound.ts`.

- [ ] **Step 3: Implement policy adapter and one-time relay binding**

```ts
// apps/cloud-gateway/src/voice/outbound.ts
export async function dispatchOutboundCall(command: unknown, deps: { policy: PolicyEngine; dispatcher: OutboundCallDispatcher }): Promise<OutboundCallDispatchResult> {
  const snapshot = snapshotOutboundCallRequest(command);
  if (snapshot === null) throw new Error("invalid_request");
  const decision = await deps.policy.evaluateOutboundCall(snapshot);
  if (decision.decision === "deny") throw new Error(decision.reason);
  return deps.dispatcher.dispatch(snapshot);
}
```

`dispatchOutboundCall` snapshots before its first await, performs only the immutable initial authorization, and delegates to the Task 3 dispatcher. That dispatcher exclusively owns final recheck, attempt/nonce creation or replay, trusted URL construction, durable claim, the sole provider POST, and result persistence. Task 7 has no `TwilioProvider` dependency, second destination lookup, or path/idempotency construction.

`claimOutboundTwiML(request, attemptId, deps)` validates the route's lowercase ULID, passes the original `Request` exactly once to `verifyWebhook({ request, exactUrl: deps.externalUrls.outboundTwiML(attemptId) })`, and consumes only the resulting `VerifiedTwilioForm`. It never clones, pre-buffers, calls `formData()`, decodes, or reparses the body. It requires singleton `CallSid` and `To` values through `getAll`, validates the CallSid, resolves the provider-observed destination through the active identity repository, and calls `claimExpectedCall({ attemptId, ... })`. The request never supplies a relay nonce.

On success it calls `getOrCreateOutboundSession` with the claimed binding, which enforces deterministic `sessionId=attemptId`, then idempotently initializes/addresses that Durable Object with `relaySetupExpiresAt=null`. It builds `wss://<trusted-host>/voice/relay/${attemptId}` and renders `renderConversationRelayTwiML` with the trusted public origin, fixed `/voice/relay-ended` action, and the stored nonce. An identical signed CallSid retry returns the same binding, session, and TwiML even after the original claim deadline so response loss is recoverable; the Task 6 signed WebSocket binding still permits only the first setup for that CallSid/session. A different CallSid, changed identity, expired never-claimed/rejected/ready attempt, invalid signature, duplicate semantic form field, or inactive destination returns neutral rejection without a new session. No command purpose, identity, phone number, PIN, or nonce from the request enters the document.

- [ ] **Step 4: Run outbound tests to verify they pass**

Run: `pnpm test:cloud -- voice/outbound.test.ts security/outbound-security.test.ts`

Expected: PASS with model issuer denial, immediate kill-switch denial, crash-safe sole dispatch ownership, stable attempt nonce/session replay, mismatched CallSid rejection, Request-owned signature verification, and neutral pre-PIN voicemail content.

- [ ] **Step 5: Commit the outbound dispatch deliverable**

```bash
git add apps/cloud-gateway/src/voice/outbound.ts apps/cloud-gateway/test/voice/outbound.test.ts apps/cloud-gateway/test/security/outbound-security.test.ts
git commit -m "feat(calls): add policy-gated outbound call dispatch"
```

### Task 8: Worker routes, limits, provider failures, and fake end-to-end acceptance

**Files:**
- Create: `apps/cloud-gateway/src/http/voice-routes.ts`
- Modify: `apps/cloud-gateway/src/index.ts`
- Create: `tests/acceptance/fake/voice-call-path.test.ts`
- Test: `apps/cloud-gateway/test/http/voice-routes.test.ts`
- Test: `apps/cloud-gateway/test/security/calling-limits.test.ts`

**Interfaces:**
- Consumes: `handleInboundVoiceWebhook`, `dispatchOutboundCall`, `CallSession`, foundation `TwilioProvider`, `TwilioRequestVerifier`, `CapacityGuard`, `CallRepository`, and calling-owned `ConversationService`.
- Produces: `routeVoiceRequest`, signature-first `handleTwilioStatusCallback`/`handleTwilioRelayEndedCallback`, and a complete fake call path that consumes only the fakes from Task 2.

- [ ] **Step 1: Write failing routing, limits, and acceptance tests**

```ts
it("rejects a 64 KiB plus one-byte relay frame", async () => {
  const socket = await fakeRelay.openSignedWebSocket(SESSION_ID);
  await socket.sendText("x".repeat(65_537));
  expect(socket.closeCode).toBe(1009);
  expect(conversation.handleTurn).not.toHaveBeenCalled();
});

it("records one safe terminal outcome when the model exceeds 30 seconds", async () => {
  model.mode = "timeout";
  await fakeInboundCall.authenticateAndSpeak("What is next?");
  expect(await repository.terminalEventsFor(fakeInboundCall.callSid)).toEqual(["model_timeout"]);
});

it("completes the mandatory fake inbound and outbound paths", async () => {
  await fakeInboundCall.authenticateAndSpeakTwiceWithInterruption();
  await fakeOutboundCall.dispatchAnswerAuthenticateAndComplete();
  await fakeOutboundCall.dispatchNoAnswer();
  expect(await acceptance.read()).toMatchObject({ inbound: "completed", outboundAnswer: "completed", outboundNoAnswer: "completed" });
});
```

- [ ] **Step 2: Run routing and fake acceptance tests to verify they fail**

Run: `pnpm vitest run apps/cloud-gateway/test/http/voice-routes.test.ts apps/cloud-gateway/test/security/calling-limits.test.ts tests/acceptance/fake/voice-call-path.test.ts`

Expected: FAIL with module-not-found error for `voice-routes.ts` and the fake acceptance test harness.

- [ ] **Step 3: Implement route guards and acceptance composition**

```ts
// apps/cloud-gateway/src/http/voice-routes.ts
export async function routeVoiceRequest(request: Request, deps: VoiceRouteDependencies): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.search !== "" || requestUrl.hash !== "") return new Response("not_found", { status: 404 });
  const path = requestUrl.pathname;
  const relay = path.match(/^\/voice\/relay\/([0-7][0-9a-hjkmnp-tv-z]{25})$/);
  const outbound = path.match(/^\/voice\/outbound\/([0-7][0-9a-hjkmnp-tv-z]{25})$/);
  const status = path.match(/^\/voice\/status\/([0-7][0-9a-hjkmnp-tv-z]{25})$/);
  if (relay !== null && request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const sessionId = relay[1] as Ulid;
    const exactUrl = deps.externalUrls.relayWebSocket(sessionId);
    if (!(await deps.twilio.verifyWebSocket({ request, exactUrl }))) return new Response("invalid_signature", { status: 403 });
    return deps.callSessions.getByName(sessionId).fetch(request);
  }
  if (path === "/voice/inbound" && request.method === "POST") {
    try { await deps.capacity.assertAcceptingNewCall(); } catch { return new Response("unavailable", { status: 503 }); }
    return handleInboundVoiceWebhook(request, deps);
  }
  if (outbound !== null && request.method === "POST") return claimOutboundTwiML(request, outbound[1] as Ulid, deps);
  if (path === "/voice/relay-ended" && request.method === "POST") return handleTwilioRelayEndedCallback(request, deps);
  if (status !== null && request.method === "POST") return handleTwilioStatusCallback(request, status[1] as Ulid, deps);
  return new Response("not_found", { status: 404 });
}
```

`externalUrls` is constructed once from the validated trusted public origin; it emits only exact fixed route strings Twilio signs and never consults forwarded headers. Route matching accepts one canonical lowercase ULID segment and no suffix/query-derived identity. Each POST handler passes the original request once to `verifyWebhook({ request, exactUrl })` and consumes only the returned branded form. Form size limiting lives in that streaming verifier; WebSocket frame size limiting lives in the Durable Object before JSON parsing, not in a `Content-Length` check on the upgrade request. Capacity for an already accepted outbound TwiML fetch is never re-litigated; the durable dispatcher checked it before POST and the signed attempt callback must remain recoverable.

`/voice/status/:attemptId` and `/voice/relay-ended` each give the original Request to the verifier and then require their semantic fields as singleton values from `VerifiedTwilioForm`; neither handler reads, clones, buffers, or parses a raw body. Status deduplication uses endpoint + attempt ID + `CallSid` + fixed `CallbackSource` + canonical `SequenceNumber`, and atomically reconciles only that compatible outbound attempt. Relay-ended deduplication uses endpoint + `CallSid` + `SessionId` because the current action payload has no callback source/sequence. Both advance but never reverse a terminal state, record only allowlisted lifecycle fields, and never store provider bodies or transcript fragments.

```ts
// tests/acceptance/fake/voice-call-path.test.ts
it("executes authenticated inbound, outbound-answer, and outbound-no-answer paths", async () => {
  const system = await createFakeCallingSystem();
  await system.inbound({ caller: "+14165550100", pin: "12345678", turns: ["first", "second"], interruptAfterFirstAnswer: true });
  await system.outbound({ commandIssuer: "local_cli", pin: "12345678", answered: true });
  await system.outbound({ commandIssuer: "local_cli", answered: false });
  expect(system.model.requests).toHaveLength(3);
  expect(system.twilio.requests).toHaveLength(2);
});
```

- [ ] **Step 4: Run all calling tests to verify they pass**

Run: `pnpm test:cloud -- contracts providers db voice policy http security faults; pnpm test:acceptance -- voice-call-path.test.ts`

Expected: PASS with all fake inbound/outbound, replay, signature, PIN-secrecy, failure, and transaction-fault tests green.

- [ ] **Step 5: Commit the route and fake acceptance deliverable**

```bash
git add apps/cloud-gateway/src/http/voice-routes.ts apps/cloud-gateway/src/index.ts apps/cloud-gateway/test/http/voice-routes.test.ts apps/cloud-gateway/test/security/calling-limits.test.ts tests/acceptance/fake/voice-call-path.test.ts
git commit -m "feat(calls): add voice routes limits and fake acceptance gate"
```

### Task 9: Credentialed live-smoke harness and release evidence contract

**Files:**
- Create: `tests/acceptance/live/voice-smoke.ts`
- Create: `tests/acceptance/live/voice-smoke.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `TESTING.md`

**Interfaces:**
- Consumes: deployed `/voice/inbound`, attempt-scoped `/voice/outbound/:attemptId` and `/voice/status/:attemptId`, `/voice/relay-ended`, local `jarvis call-me --purpose smoke --confirm --wait --json`, and call event repository query endpoint available only to the enrolled smoke operator.
- Produces: `pnpm smoke:voice -- --scenario <scenario>` and redacted JSON evidence at `tests/acceptance/live/evidence/<scenario>.json`.

- [ ] **Step 1: Write failing live-gate evidence tests**

```ts
import { describe, expect, it } from "vitest";
import { validateEvidence } from "./voice-smoke";

it("rejects evidence containing a phone number, PIN, transcript text, or missing interruption metric", () => {
  expect(() => validateEvidence({ scenario: "inbound", callSid: "CA1", transcript: "hello", pin: "12345678" })).toThrow("unsafe_or_incomplete_evidence");
});

it("accepts complete redacted inbound evidence", () => {
  expect(validateEvidence({ scenario: "inbound", commitSha: "a".repeat(40), correlationId: "01j00000000000000000000000", startedAt: "2026-08-29T12:00:00.000Z", endedAt: "2026-08-29T12:01:00.000Z", authenticatedTurns: 2, interruptions: 1, terminalState: "completed", firstAudibleMs: 3000, interruptionStopMs: 900, eventIds: ["01j00000000000000000000001"] })).toBe(true);
});

it("requires an unauthorized caller to be rejected before model or authentication traffic", () => {
  expect(validateEvidence({ scenario: "unauthorized-caller", commitSha: "a".repeat(40), correlationId: "01j00000000000000000000000", startedAt: "2026-08-29T12:00:00.000Z", endedAt: "2026-08-29T12:00:02.000Z", authenticatedTurns: 0, modelRequests: 0, terminalState: "rejected", eventIds: ["01j00000000000000000000001"] })).toBe(true);
});
```

- [ ] **Step 2: Run the live-gate unit tests to verify they fail**

Run: `pnpm vitest run tests/acceptance/live/voice-smoke.test.ts`

Expected: FAIL with module-not-found error for `tests/acceptance/live/voice-smoke.ts`.

- [ ] **Step 3: Implement evidence validation and scripts**

```ts
// tests/acceptance/live/voice-smoke.ts
export function validateEvidence(value: Record<string, unknown>): true {
  const serialized = JSON.stringify(value);
  const required = ["scenario", "commitSha", "correlationId", "startedAt", "endedAt", "terminalState", "eventIds"];
  const ulid = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
  const eventIds = Array.isArray(value.eventIds) ? value.eventIds : [];
  if (required.some((key) => value[key] === undefined) || !/^[0-9a-f]{40}$/.test(String(value.commitSha)) || !ulid.test(String(value.correlationId)) || eventIds.length === 0 || !eventIds.every((id) => typeof id === "string" && ulid.test(id)) || /\\+\\d{7,}|"(?:transcript|pin|authorization|token|secret)"\\s*:/i.test(serialized)) throw new Error("unsafe_or_incomplete_evidence");
  if (value.scenario === "inbound" && (!(typeof value.authenticatedTurns === "number" && value.authenticatedTurns >= 2) || !(typeof value.interruptions === "number" && value.interruptions >= 1))) throw new Error("unsafe_or_incomplete_evidence");
  if (value.scenario === "unauthorized-caller" && (value.terminalState !== "rejected" || value.authenticatedTurns !== 0 || value.modelRequests !== 0)) throw new Error("unsafe_or_incomplete_evidence");
  return true;
}
```

```json
{
  "scripts": {
    "test:calls": "vitest run apps/cloud-gateway/test/contracts apps/cloud-gateway/test/providers apps/cloud-gateway/test/persistence apps/cloud-gateway/test/voice apps/cloud-gateway/test/policy apps/cloud-gateway/test/http apps/cloud-gateway/test/security apps/cloud-gateway/test/faults",
    "test:acceptance:calls": "vitest run tests/acceptance/fake/voice-call-path.test.ts",
    "smoke:voice": "tsx tests/acceptance/live/voice-smoke.ts",
    "release:voice-gate": "pnpm test:calls && pnpm test:acceptance:calls && pnpm smoke:voice -- --scenario inbound && pnpm smoke:voice -- --scenario unauthorized-caller && pnpm smoke:voice -- --scenario outbound-answer && pnpm smoke:voice -- --scenario outbound-no-answer && pnpm smoke:voice -- --scenario failure-callbacks"
  }
}
```

- [ ] **Step 4: Run the smoke contract tests and register the permanent release prerequisite**

Run: `pnpm vitest run tests/acceptance/live/voice-smoke.test.ts`

Expected: PASS with unsafe evidence rejected and complete redacted evidence accepted.

Run now: `pnpm test:calls; pnpm test:acceptance:calls; pnpm vitest run tests/acceptance/live/voice-smoke.test.ts`

Expected now: all fake suites and evidence-contract tests pass without paid credentials. Register the five credentialed scenarios as blocking inputs to the repository-wide release audit in the Telegram/memory/release plan. That final task runs them only after `jarvis doctor` exists, the local `jarvis call-me` issuer is installed, secrets are configured, and the Worker is deployed. Missing credentials may skip an explicitly named developer smoke test, but cannot satisfy or bypass the `0.1.0` release manifest. Required retained evidence includes unauthorized-caller rejection before model traffic plus 20 authenticated live turns with p95 first audible response at or below 4,000 ms and p95 interruption stop at or below 1,500 ms.

- [ ] **Step 5: Commit the release-gate deliverable**

```bash
git add tests/acceptance/live/voice-smoke.ts tests/acceptance/live/voice-smoke.test.ts package.json README.md TESTING.md
git commit -m "test(calls): add credentialed voice release gate"
```

## Self-review

### Spec coverage

- Inbound signed webhook, allowlist, mandatory DTMF PIN authentication, the separate local-CLI phone enrollment challenge, pre-auth privacy, brute-force containment, and transcript rules are covered by Tasks 4 and 6.
- Outbound issuer restrictions, foundation policy decision, verified destination, kill switch, quiet hours/limits, retry lineage, nonce binding, recipient PIN, and voicemail privacy are covered by Task 7.
- Durable events, idempotency, event ordering, callback deduplication, transactions, and crash recovery are covered by Task 3.
- WebSocket validation, channel-specific delivery state, voice `sent_to_provider` without invented playback acknowledgement, interruption, time/frame/turn limits, safe provider failures, and circuit-breaker-compatible routing are covered by Tasks 5, 6, and 8.
- Fake adapters, adversarial security tests, transaction-fault tests, and the real inbound/unauthorized-caller/outbound/no-answer/failure smoke harness, latency thresholds, and redacted evidence contract are covered by Tasks 2, 8, and 9; the final plan executes the credentialed gate after the CLI and deployment exist.

### Placeholder scan

The plan contains no unassigned implementation work, generic validation language, or deferred calling behavior. Task 6 contains the concrete PIN state transition and records only the authentication outcome, never the supplied digits.

### Type consistency

- `CallPhase`, `TranscriptState`, `OutboundCallCommand`, base `ExpectedOutboundCall`, and `RelayBinding` originate in Task 1. Task 3's `StoredOutboundCallAttempt` extends the base expected-call fields with audited attempt identity/ordinal without redefining them.
- `TwilioProvider`, `PolicyEngine`, and their deterministic fakes originate in the foundation-cloud plan; Task 2 extends Twilio inputs with explicit immutable `attemptId` and adds the signed-webhook, trusted-route, and ConversationRelay boundary.
- `ConversationService.handleTurn`, `OutboxDispatcher.dispatch`, and `ModelAdapter.stream` originate in Task 5 and are consumed by Task 6 and the later Telegram plan.
- `CallRepository.claimExpectedCall` produces `RelayBinding`, which Task 6 validates before model traffic.
- Foundation `PolicyEngine.evaluateOutboundCall` produces the immutable initial decision; Task 3's sole dispatcher consumes the separately audited final recheck and attempt ID after synchronously freezing the same command. Task 7 only composes those two owners.
- `validateEvidence` is exported by Task 9 and tested by the colocated live-gate unit test.

Approved execution mode: use `superpowers:subagent-driven-development` in the same isolated feature worktree after every foundation task passes, dispatch one fresh implementer per task, and require independent spec-compliance and code-quality review before advancing. The cost-bearing credentialed smoke commands remain deferred to the release execution checkpoint.

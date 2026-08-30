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
- Consumers reject unsupported major contract versions and retain only redacted invalid payloads in access-controlled dead letters. Provider callbacks are deduplicated by provider event type, `CallSid`, sequence, and provider message identifier.
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
  recheckOutboundDispatch(request: OutboundCallCommand): Promise<DispatchPolicyCheck>;
}

// apps/cloud-gateway/src/providers/provider-types.ts
export interface TwilioProvider { createCall(input: { commandId: string; toE164: string; twimlUrl: URL; statusCallbackUrl: URL; statusCallbackEvents: readonly ["initiated", "ringing", "answered", "completed"]; idempotencyKey: string }): Promise<{ callSid: string }>; }
```

Task 1 of the calling plan extends `apps/cloud-gateway/src/env.ts` with the `PIN_VERIFIER_JSON` secret binding, replaces the foundation `CallSessionStub` with the real `CallSession` Durable Object in `apps/cloud-gateway/wrangler.toml`, and creates `apps/cloud-gateway/src/index.ts` as the sole Worker entrypoint. Calling schema follows the immutable foundation migration and its audit hardening migration with `apps/cloud-gateway/src/persistence/migrations/0003_calling.sql`; the calling migration leaves foundation tables untouched and Wrangler applies all migrations in order.

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
  handleTurn(input: { sessionId: string; principalId: string; channel: "voice" | "telegram"; turnId: Ulid; text: string; signal: AbortSignal; delivery: { kind: "streaming"; onToken(token: ModelToken): Promise<void>; awaitDelivery(finalText: string): Promise<{ deliveredText: string }> } | { kind: "outbox"; idempotencyKey: string; payload: JsonValue } }): Promise<{ committedUserEventId: Ulid; deliveredAssistantEventId: Ulid | null }>;
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

**Contract correction:** `docs/superpowers/specs/2026-08-30-jarvis-twilio-contract-correction-design.md` supersedes the original draft event shapes and retry assumptions. Later tasks must consume the corrected `prompt`, one-digit `dtmf`, socket-close, verified-form, and `provider_dispatch_unknown` contracts even where an older illustrative snippet remains below.

**Files:**
- Modify: `apps/cloud-gateway/src/providers/provider-types.ts`
- Modify: `apps/cloud-gateway/src/providers/fake-twilio-provider.ts`
- Create: `apps/cloud-gateway/src/providers/twilio-provider.ts`
- Create: `apps/cloud-gateway/src/providers/twilio-verifier.ts`
- Create: `apps/cloud-gateway/src/providers/conversation-relay.ts`
- Create: `apps/cloud-gateway/src/voice/twiml.ts`
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

Render TwiML with explicit test settings (`en-US`, Deepgram `nova-3-general`, Google `en-US-Journey-O`) and assert exact XML escaping, `Connect method="POST"`, `dtmfDetection="true"`, `partialPrompts="false"`, `interruptible="any"`, `reportInputDuringAgentSpeech="any"`, the explicit STT/TTS settings, one nonce parameter, and no identity/purpose/PIN data. Task 6 ignores all pre-auth prompts, so enabling speech reporting for authenticated barge-in does not cross the privacy boundary.

- [ ] **Step 2: Write failing REST, signature, and ambiguous-dispatch tests**

Use an injected fetch spy and synthetic credentials. Assert the exact fixed URL, API-key Basic authentication, bounded timeout, form encoding, configured `From`, `Method=POST`, `StatusCallbackMethod=POST`, four separate callback event pairs, `TimeLimit=1800`, and bounded ring timeout. Assert no idempotency header is sent.

Test the documented Twilio signature vector plus wrong signatures, exact percent-encoded query preservation, leading/trailing form whitespace, duplicate and additive form fields, malformed percent encoding, invalid UTF-8, wrong content type, and WebSocket GET signing. Match the official SDK's multi-value rule: sort parameter names, then de-duplicate and sort repeated values before appending them. A successful webhook verification must return an immutable parsed multimap; a failed verification returns `null` and exposes no parsed values.

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

`renderConversationRelayTwiML` validates schemes, forbids URL credentials/fragments, requires the 43-character base64url nonce, accepts explicit voice settings, escapes all XML attribute metacharacters, and emits only the provider settings plus the opaque session URL, action URL, and relay nonce.

- [ ] **Step 6: Implement Workers-native REST and signature adapters**

`TwilioRestProvider.createCall` uses only `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json`, injected `fetch`, one abort timeout, API-key SID/secret Basic authentication, and a streaming response reader capped at 64 KiB. It performs no retry and never logs the auth material, destination, signature, request body, or response body. An explicit 401/403 is authentication failure, an explicit 429 is rate limited, other non-5xx 4xx responses are permanent invalid requests, and every possibly accepted or indeterminate outcome is `provider_dispatch_unknown`.

`TwilioSignatureVerifier` uses the primary Auth Token only for HMAC-SHA1. It signs the exact URL string plus strictly decoded parameters using the official SDK ordering: names sorted case-sensitively, with repeated values de-duplicated and sorted before appending. It then uses Web Crypto verification against the strict Base64 header. The WebSocket path signs the exact WSS URL with no form body. It never derives the public URL from forwarded headers.

Extend `FakeTwilioProvider` with signature controls and `acceptAndLoseNextResponse()`. Correct the foundation fake so every direct `createCall` invocation is a non-idempotent provider attempt: it may log the local correlation key but must not cache, coalesce, conflict, or suppress a replay. Telegram's fake retains its idempotency behavior. Task 3/7 owns the durable gate that prevents Jarvis from making the second Twilio invocation.

- [ ] **Step 7: Run focused and full verification**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts apps/cloud-gateway/test/providers/conversation-relay.test.ts apps/cloud-gateway/test/providers/fakes.test.ts`

Expected: PASS with the official relay fixtures, signature vector and multi-value behavior, exact REST request, ambiguous-dispatch classification, faithful non-idempotent Twilio fake, and existing non-Twilio fake behavior green.

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm audit --audit-level high`

- [ ] **Step 8: Independently review and commit the provider boundary**

Require separate plan-compliance and code/security reviews. The review must explicitly check that no automatic Twilio POST retry or fake idempotency exists, the fake exposes response-loss duplicate risk for later orchestration tests, raw provider content cannot escape error/interrupt paths, and verified forms cannot be forged by parsing unverified request bodies in a route.

```bash
git add apps/cloud-gateway/src/providers/provider-types.ts apps/cloud-gateway/src/providers/fake-twilio-provider.ts apps/cloud-gateway/src/providers/twilio-provider.ts apps/cloud-gateway/src/providers/twilio-verifier.ts apps/cloud-gateway/src/providers/conversation-relay.ts apps/cloud-gateway/src/voice/twiml.ts apps/cloud-gateway/test/providers/twilio.test.ts apps/cloud-gateway/test/providers/conversation-relay.test.ts
git commit -m "feat(calls): extend shared Twilio provider for signed relay ingress"
```

### Task 3: Atomic call persistence, event deduplication, and expected-call bindings

**Files:**
- Create: `apps/cloud-gateway/src/persistence/migrations/0003_calling.sql`
- Create: `apps/cloud-gateway/src/persistence/call-repository.ts`
- Test: `apps/cloud-gateway/test/persistence/call-repository.test.ts`
- Test: `apps/cloud-gateway/test/faults/calling-transaction-faults.test.ts`

**Interfaces:**
- Consumes: foundation `EventRepository`, D1 binding `Env.DB`, `EventEnvelope<T>`, `ExpectedOutboundCall`, and `RelayBinding`.
- Produces: `CallRepository.createExpectedCall`, `CallRepository.claimExpectedCall`, `CallRepository.appendProviderEvent`, and `CallRepository.countActiveCalls`.

- [ ] **Step 1: Write the failing transaction and nonce-claim tests**

```ts
it("claims an expected call exactly once and binds it to the Twilio CallSid", async () => {
  await repository.createExpectedCall(expected);
  const first = await repository.claimExpectedCall({ commandId: expected.commandId, callSid: "CA1", observedDestinationIdentityId: expected.destinationIdentityId, now: new Date("2026-08-29T12:01:00.000Z") });
  const replay = await repository.claimExpectedCall({ commandId: expected.commandId, callSid: "CA2", observedDestinationIdentityId: expected.destinationIdentityId, now: new Date("2026-08-29T12:01:01.000Z") });
  expect(first).toMatchObject({ callSid: "CA1", principalId: expected.principalId, relayNonce: expected.relayNonce });
  expect(replay).toBeNull();
});

it("does not leave an accepted event without its outbox and idempotency rows", async () => {
  await expect(repository.appendProviderEvent(fixture, { injectFailureAfter: "event" })).rejects.toThrow("injected_failure");
  expect(await repository.findEvent(fixture.eventId)).toBeNull();
  expect(await repository.findOutbox(fixture.eventId)).toBeNull();
});
```

- [ ] **Step 2: Run the persistence tests to verify they fail**

Run: `pnpm test:cloud -- persistence/call-repository.test.ts faults/calling-transaction-faults.test.ts`

Expected: FAIL with module-not-found error for `call-repository.ts`.

- [ ] **Step 3: Add the schema and atomic repository methods**

```sql
CREATE TABLE expected_calls (
  command_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  destination_identity_id TEXT NOT NULL,
  relay_nonce TEXT NOT NULL UNIQUE,
  nonce_expires_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  call_sid TEXT UNIQUE,
  claimed_at TEXT
);
CREATE TABLE provider_events (
  dedupe_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  call_sid TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
```

```ts
// apps/cloud-gateway/src/persistence/call-repository.ts
export class CallRepository {
  constructor(private readonly db: D1Database, private readonly events: EventRepository) {}
  async createExpectedCall(input: ExpectedOutboundCall): Promise<void> {
    await this.db.prepare("INSERT INTO expected_calls (command_id, principal_id, destination_identity_id, relay_nonce, nonce_expires_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)").bind(input.commandId, input.principalId, input.destinationIdentityId, input.relayNonce, input.nonceExpiresAt, input.idempotencyKey).run();
  }
  async claimExpectedCall(input: { commandId: string; callSid: string; observedDestinationIdentityId: string; now: Date }): Promise<RelayBinding | null> {
    const row = await this.db.prepare(`UPDATE expected_calls SET call_sid = ?, claimed_at = ?
      WHERE command_id = ? AND call_sid IS NULL AND destination_identity_id = ? AND nonce_expires_at > ?
      RETURNING principal_id, destination_identity_id, relay_nonce`)
      .bind(input.callSid, input.now.toISOString(), input.commandId, input.observedDestinationIdentityId, input.now.toISOString())
      .first<{ principal_id: string; destination_identity_id: string; relay_nonce: string }>();
    return row ? { callSid: input.callSid, principalId: row.principal_id, identityId: row.destination_identity_id, destinationIdentityId: row.destination_identity_id, relayNonce: row.relay_nonce, direction: "outbound", activationOnly: false, activationChallengeId: null } : null;
  }
}
```

Use one conditional `UPDATE ... RETURNING` statement for the expected-call claim so no read/modify/write race exists. The signed Twilio TwiML handler resolves the provider-observed `To` number to its active identity before calling this method; the untrusted request never supplies the relay nonce. The stored nonce is returned only after command, destination, expiry, and unclaimed-state checks succeed. Use foundation `TransactionRunner.batch()` for every multi-row provider-event write; injected faults must abort the event, idempotency, and outbox statements together.

- [ ] **Step 4: Run the persistence and fault tests to verify they pass**

Run: `pnpm test:cloud -- persistence/call-repository.test.ts faults/calling-transaction-faults.test.ts`

Expected: PASS with replay rejection and rollback of every injected transaction failure.

- [ ] **Step 5: Commit the durable call-binding deliverable**

```bash
git add apps/cloud-gateway/src/persistence/migrations/0003_calling.sql apps/cloud-gateway/src/persistence/call-repository.ts apps/cloud-gateway/test/persistence/call-repository.test.ts apps/cloud-gateway/test/faults/calling-transaction-faults.test.ts
git commit -m "feat(calls): persist atomic event and outbound relay bindings"
```

### Task 4: Inbound Twilio ingress, DTMF PIN authentication, and neutral phone enrollment

**Files:**
- Create: `apps/cloud-gateway/src/voice/inbound-auth.ts`
- Create: `apps/cloud-gateway/src/voice/inbound.ts`
- Test: `apps/cloud-gateway/test/voice/inbound-auth.test.ts`
- Test: `apps/cloud-gateway/test/http/inbound-voice.test.ts`
- Test: `apps/cloud-gateway/test/security/inbound-auth-security.test.ts`

**Interfaces:**
- Consumes: shared `TwilioRequestVerifier`, foundation `IdentityChallengeService`, `renderConversationRelayTwiML`, `CallRepository`, `CallPhase`, and `RelayEvent`.
- Produces: `decodePinVerifierRecord`, `verifyPin`, `evaluatePinAttempt`, and `handleInboundVoiceWebhook`.

- [ ] **Step 1: Write failing pre-authentication and PIN secrecy tests**

```ts
it("rejects an unsigned webhook before creating a call session", async () => {
  twilio.signatureValid = false;
  const response = await handleInboundVoiceWebhook(request, dependencies);
  expect(response.status).toBe(403);
  expect(sessionFactory.created).toHaveLength(0);
});

it("does not send DTMF digits to the model, event store, or log sink", async () => {
  await session.handleRelayEvent({ type: "dtmf", digits: "12345678" });
  expect(conversation.handleTurn).not.toHaveBeenCalled();
  expect(events.serializedPayloads.join(" ")).not.toContain("12345678");
  expect(logs.entries.join(" ")).not.toContain("12345678");
});

it("terminates only the failed call after three bad PINs", async () => {
  await attemptBadPinThreeTimes(session);
  expect(session.phase).toBe("rejected");
  expect(await throttles.isCanonicalIdentityLocked("sid-principal")).toBe(false);
});

it("requires both the PIN and the local CLI one-time challenge to activate a pending phone identity", async () => {
  const response = await handleInboundVoiceWebhook(pendingCallerRequest, dependencies);
  expect(response.status).toBe(200);
  await session.handleRelayEvent({ type: "dtmf", digits: "12345678" });
  expect(identityChallenges.confirm).not.toHaveBeenCalled();
  await session.handleRelayEvent({ type: "dtmf", digits: "482913" });
  expect(identityChallenges.confirm).toHaveBeenCalledWith(expect.objectContaining({ challengeId: "challenge-phone-1", response: "482913", observedChannelIdentityId: "pending-phone", pinAuthenticated: true }));
  expect(conversation.handleTurn).not.toHaveBeenCalled();
  expect(events.serializedPayloads.join(" ")).not.toMatch(/12345678|482913/);
  expect(logs.entries.join(" ")).not.toMatch(/12345678|482913/);
});

it.each(["expired", "replayed", "mismatched"])("fails a %s phone challenge without loading personal context", async (failure) => {
  identityChallenges.failWith(failure);
  await session.handleRelayEvent({ type: "dtmf", digits: "12345678" });
  await session.handleRelayEvent({ type: "dtmf", digits: "482913" });
  expect(session.phase).toBe("failed");
  expect(conversation.handleTurn).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run inbound security tests to verify they fail**

Run: `pnpm vitest run apps/cloud-gateway/test/voice/inbound-auth.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/security/inbound-auth-security.test.ts`

Expected: FAIL with module-not-found errors for inbound authentication and voice webhook handler.

- [ ] **Step 3: Implement versioned PIN verification and neutral ingress**

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
export async function handleInboundVoiceWebhook(request: Request, deps: { twilio: TwilioRequestVerifier; resolveCallerCandidate(callerE164: string): Promise<{ principalId: string; identityId: string; state: "active"; activationChallengeId: null } | { principalId: string; identityId: string; state: "pending"; activationChallengeId: string } | null>; createSession: (input: { callSid: string; principalId: string; identityId: string; activationOnly: boolean; activationChallengeId: string | null }) => Promise<{ sessionId: string; relayNonce: string }> }): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (!(await deps.twilio.verifyWebhook({ method: "POST", url: new URL(request.url), headers: request.headers, rawBody }))) return new Response("forbidden", { status: 403 });
  const form = new URLSearchParams(new TextDecoder().decode(rawBody));
  const candidate = await deps.resolveCallerCandidate(form.get("From") ?? "");
  if (!candidate) return new Response("rejected", { status: 403 });
  const session = await deps.createSession({ callSid: form.get("CallSid") ?? "", principalId: candidate.principalId, identityId: candidate.identityId, activationOnly: candidate.state === "pending", activationChallengeId: candidate.activationChallengeId });
  const sessionUrl = new URL(`/voice/relay/${session.sessionId}`, request.url); sessionUrl.protocol = "wss:";
  return new Response(renderConversationRelayTwiML({ sessionUrl, actionUrl: new URL("/voice/relay-ended", request.url), relayNonce: session.relayNonce }), { headers: { "content-type": "text/xml" } });
}
```

Unknown or blocked callers are rejected before ConversationRelay. A pending bootstrap phone identity may enter only an `activationOnly` neutral session when an enrolled device has begun a still-valid challenge; its opaque challenge ID is bound into the session and the plaintext response is displayed only by the authenticated local CLI. The caller first enters the normal eight-digit PIN and is then prompted to enter that separate one-time DTMF response. Only successful verification of both factors against the provider-observed pending identity activates it. The session speaks neutral prompts and a neutral outcome, never speaks or persists either digit sequence, never loads memory, purpose, or model context, and ends after success or failure. The user places a new normal inbound call after activation.

- [ ] **Step 4: Run inbound security tests to verify they pass**

Run: `pnpm vitest run apps/cloud-gateway/test/voice/inbound-auth.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/security/inbound-auth-security.test.ts`

Expected: PASS with signature-first rejection, no PIN or one-time-challenge leakage, expiry/replay/mismatch rejection, provider-bound two-factor pending phone activation, and no persistent spoofed-ID lockout.

- [ ] **Step 5: Commit the inbound authentication deliverable**

```bash
git add apps/cloud-gateway/src/voice/inbound-auth.ts apps/cloud-gateway/src/voice/inbound.ts apps/cloud-gateway/test/voice/inbound-auth.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/security/inbound-auth-security.test.ts
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

- [ ] **Step 1: Write failing streamed-token and delivery-acknowledgement tests**

```ts
it("commits assistant text only after the channel acknowledges complete delivery", async () => {
  const received: string[] = [];
  const controller = new AbortController();
  const completion = service.handleTurn({ sessionId, principalId, channel: "voice", turnId, text: "hello", signal: controller.signal, delivery: { kind: "streaming", onToken: async (token) => { received.push(token.text); }, awaitDelivery: async (text) => ({ deliveredText: text }) } });
  await fakeModel.emitToken("hello");
  expect(await events.assistantEvents(sessionId)).toEqual([]);
  await fakeModel.complete();
  await completion;
  expect(received.join("")).toBe("hello");
  expect(await events.assistantEvents(sessionId)).toHaveLength(1);
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
  async handleTurn(input: Parameters<ConversationService["handleTurn"]>[0]): Promise<{ committedUserEventId: Ulid; deliveredAssistantEventId: Ulid | null }> {
    const redacted = await this.redactor.redact({ text: input.text, channel: input.channel, field: "turn.text" });
    if (!redacted.ok) { await this.events.commitSafeFailure(input, redacted.category); throw new Error(redacted.category); }
    const committedUserEventId = await this.events.commitUser({ ...input, text: redacted.text });
    const context = await this.context.retrieve({ principalId: input.principalId, channel: input.channel, purpose: "conversation", query: redacted.text, maxTokens: input.channel === "voice" ? 32000 : 48000 });
    let finalText = "";
    for await (const token of this.model.stream({ correlationId: input.turnId, principalId: input.principalId, channel: input.channel, userText: redacted.text, context, timeoutMs: 30000, contextTokenBudget: input.channel === "voice" ? 32000 : 48000, signal: input.signal })) {
      finalText += token.text;
      if (input.delivery.kind === "streaming") await input.delivery.onToken(token);
    }
    if (input.signal.aborted) { await this.events.commitCancelledAssistant(input); return { committedUserEventId, deliveredAssistantEventId: null }; }
    if (input.delivery.kind === "outbox") {
      const outboxId = await this.events.stageAssistantDelivery({ ...input, text: finalText, idempotencyKey: input.delivery.idempotencyKey, payload: { ...input.delivery.payload, text: finalText } });
      const result = await this.dispatcher.dispatch(outboxId);
      return { committedUserEventId, deliveredAssistantEventId: result.deliveredAssistantEventId };
    }
    const { deliveredText } = await input.delivery.awaitDelivery(finalText);
    const deliveredAssistantEventId = deliveredText.length > 0 ? await this.events.commitDeliveredAssistant({ ...input, text: deliveredText }) : null;
    return { committedUserEventId, deliveredAssistantEventId };
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

Implement `D1ContextRetriever` with an explicit principal, authenticated-channel purpose, sensitivity filter, source identifiers, and deterministic token budget. At this stage it reads only recent committed post-redaction events; the memory plan extends the same implementation with the latest active fact projection. Retrieved text remains a data field passed separately from `userText` and cannot supply system instructions, tools, policy decisions, or action authorization. The call session invokes `ConversationService` only after DTMF authentication, so no pre-auth path can call the retriever.

- [ ] **Step 4: Run shared-conversation tests to verify they pass**

Run: `pnpm test:cloud -- conversation/conversation-service.test.ts conversation/outbox-dispatcher.test.ts; pnpm typecheck`

Expected: PASS; every model token reaches the channel, the final assistant event is committed only after acknowledgement, and duplicate delivery is suppressed.

- [ ] **Step 5: Commit the shared service deliverable**

```bash
git add apps/cloud-gateway/src/model/model-adapter.ts apps/cloud-gateway/src/conversation apps/cloud-gateway/src/providers/fake-model-provider.ts apps/cloud-gateway/test/conversation
git commit -m "feat(conversation): add shared streaming turn and outbox services"
```

### Task 6: Durable Object relay session, post-auth transcript rules, and interruption

**Files:**
- Create: `apps/cloud-gateway/src/voice/call-session-do.ts`
- Test: `apps/cloud-gateway/test/voice/call-session-do.test.ts`
- Test: `apps/cloud-gateway/test/security/relay-binding.test.ts`

**Interfaces:**
- Consumes: `CallPhase`, `transitionCall`, `canPersistTurn`, `verifyPin`, `evaluatePinAttempt`, `RelayBinding`, `RelayEvent`, `CallRepository`, and calling-owned `ConversationService`.
- Produces: Durable Object class `CallSession`, `CallSession.handleRelayEvent`, and `CallSession.validateRelaySetup`.

- [ ] **Step 1: Write failing relay-binding and interruption tests**

```ts
it("rejects a mismatched outbound relay setup before model traffic", async () => {
  await expect(session.validateRelaySetup({ callSid: "CA-wrong", relayNonce: "wrong" })).rejects.toThrow("relay_binding_rejected");
  expect(conversation.handleTurn).not.toHaveBeenCalled();
});

it("marks unplayed assistant output cancelled and excludes it from history", async () => {
  await session.handleRelayEvent({ type: "setup", callSid: session.callSid, relayNonce: expectedRelayNonce });
  await session.handleRelayEvent({ type: "speech", messageId: "u1", text: "What is next?" });
  await session.handleRelayEvent({ type: "interrupt", messageId: "u1" });
  expect(await repository.historyFor(session.callSid)).not.toContain("long model response");
});
```

- [ ] **Step 2: Run the Durable Object tests to verify they fail**

Run: `pnpm vitest run apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts`

Expected: FAIL with module-not-found error for `call-session-do.ts`.

- [ ] **Step 3: Implement binding verification and committed-turn handling**

```ts
// apps/cloud-gateway/src/voice/call-session-do.ts
export class CallSession {
  phase: CallPhase = "created";
  private failedPinAttempts = 0;
  private awaitingPhoneActivationChallenge = false;
  private relaySetupVerified = false;
  private activeTurnAbort: AbortController | null = null;
  constructor(readonly callSid: string, private readonly expected: RelayBinding, private readonly repository: CallRepository, private readonly conversation: ConversationService, private readonly relay: { sendToken(text: string): Promise<void>; waitForDelivered(finalText: string): Promise<{ deliveredText: string }>; cancel(): Promise<void> }, private readonly pinVerifier: { verify(digits: string): Promise<boolean> }, private readonly identityChallenges: IdentityChallengeService, private readonly throttles: { record(input: { callSid: string; bucket: string; now: Date }): Promise<void> }) {}

  async validateRelaySetup(actual: { callSid: string; relayNonce: string }): Promise<void> {
    if (actual.callSid !== this.expected.callSid || actual.relayNonce !== this.expected.relayNonce) throw new Error("relay_binding_rejected");
  }

  beginPreAuth(): void { this.phase = transitionCall(this.phase, "connecting"); this.phase = transitionCall(this.phase, "pre_auth"); }

  async handleRelayEvent(event: RelayEvent): Promise<void> {
    if (event.type === "setup") { await this.validateRelaySetup(event); this.relaySetupVerified = true; this.beginPreAuth(); return; }
    if (!this.relaySetupVerified) throw new Error("relay_setup_required");
    if (event.type === "dtmf") { await this.handleDtmf(event.digits); return; }
    if (event.type === "interrupt") { this.activeTurnAbort?.abort(); await this.relay.cancel(); await this.repository.cancelUnplayedAssistantTurns(this.callSid); return; }
    if (event.type !== "speech" || this.phase !== "active") return;
    if (event.text.length > 8000) throw new Error("turn_too_large");
    const controller = new AbortController(); this.activeTurnAbort = controller;
    try {
      await this.conversation.handleTurn({ sessionId: this.callSid, principalId: this.expected.principalId, channel: "voice", turnId: event.messageId as Ulid, text: event.text, signal: controller.signal, delivery: { kind: "streaming", onToken: async (token) => this.relay.sendToken(token.text), awaitDelivery: async (finalText) => this.relay.waitForDelivered(finalText) } });
    } finally { if (this.activeTurnAbort === controller) this.activeTurnAbort = null; }
  }

  private async handleDtmf(digits: string): Promise<void> {
    if (this.phase === "authenticated" && this.expected.activationOnly && this.awaitingPhoneActivationChallenge) {
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
}
```

Every Task 4/6 test helper that sends DTMF or speech first sends a valid `setup` event. The Durable Object treats both DTMF inputs as transient authentication material: the PIN verifier and challenge service receive them directly, while events, logs, transcripts, model requests, and error details receive only allowlisted outcome codes. The activation challenge is never retried inside the same call after a failed, expired, mismatched, or replayed response.

- [ ] **Step 4: Run the relay tests to verify they pass**

Run: `pnpm vitest run apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts`

Expected: PASS with binding rejection before model invocation and cancelled assistant output absent from history.

- [ ] **Step 5: Commit the call-session deliverable**

```bash
git add apps/cloud-gateway/src/voice/call-session-do.ts apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts
git commit -m "feat(calls): connect durable relay session to shared streaming conversation"
```

### Task 7: Outbound authorization, expected-call nonce binding, and recipient verification

**Files:**
- Create: `apps/cloud-gateway/src/voice/outbound.ts`
- Test: `apps/cloud-gateway/test/voice/outbound.test.ts`
- Test: `apps/cloud-gateway/test/security/outbound-security.test.ts`

**Interfaces:**
- Consumes: `OutboundCallCommand`, `ExpectedOutboundCall`, `CallRepository`, foundation `PolicyEngine`, foundation `TwilioProvider`, and shared `TwilioRequestVerifier`.
- Produces: `dispatchOutboundCall`, `claimOutboundTwiML`, and `createRelayNonce`.

- [ ] **Step 1: Write failing issuer, policy-recheck, replay, and voicemail tests**

```ts
it("denies model-originated commands before creating a policy decision", async () => {
  const decision = await policy.evaluateOutboundCall({ ...command, issuedBy: "model" as never });
  expect(decision).toMatchObject({ decision: "deny", reason: "invalid_origin" });
  expect(twilio.requests).toEqual([]);
});

it("rechecks kill switch immediately before dispatch", async () => {
  policyContext.killSwitch = true;
  await expect(dispatchOutboundCall(command, dependencies)).rejects.toThrow("kill_switch_enabled");
  expect(twilio.requests).toHaveLength(0);
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
export function createRelayNonce(): string {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function dispatchOutboundCall(command: OutboundCallCommand, deps: { policy: PolicyEngine; repository: CallRepository; twilio: TwilioProvider; publicBaseUrl: string }): Promise<{ callSid: string }> {
  const decision = await deps.policy.evaluateOutboundCall(command);
  if (decision.decision === "deny") throw new Error(decision.reason);
  const relayNonce = createRelayNonce();
  await deps.repository.createExpectedCall({ commandId: command.commandId, principalId: command.principalId, destinationIdentityId: command.destinationIdentityId, relayNonce, nonceExpiresAt: new Date(Date.now() + 300000).toISOString(), idempotencyKey: command.idempotencyKey });
  const rechecked = await deps.policy.recheckOutboundDispatch(command);
  if (rechecked.decision === "deny") throw new Error(rechecked.reason);
  return deps.twilio.createCall({ commandId: command.commandId as Ulid, toE164: await deps.repository.verifiedE164(command.destinationIdentityId), twimlUrl: new URL(`/voice/outbound/${command.commandId}`, deps.publicBaseUrl), statusCallbackUrl: new URL("/voice/status", deps.publicBaseUrl), statusCallbackEvents: ["initiated", "ringing", "answered", "completed"], idempotencyKey: command.idempotencyKey });
}
```

`claimOutboundTwiML` reads the exact raw form body, validates Twilio's signature before parsing, resolves the provider-observed `To` value through the active identity repository, and atomically claims the expected-call row for that identity plus the provider-observed `CallSid`. It creates the Durable Object session from the resulting internal `RelayBinding` and renders `renderConversationRelayTwiML` with the claimed row's stored `relayNonce`; the request never supplies that nonce. Its session URL uses `wss://`, its `<Connect action>` targets `/voice/relay-ended`, and no command purpose or identity value enters the document. A second, expired, inactive-destination, or mismatched claim returns neutral rejection TwiML without creating a session.

- [ ] **Step 4: Run outbound tests to verify they pass**

Run: `pnpm test:cloud -- voice/outbound.test.ts security/outbound-security.test.ts`

Expected: PASS with model issuer denial, immediate kill-switch denial, single-use nonce binding, and neutral pre-PIN voicemail content.

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
  await expect(routeVoiceRequest(frameRequest("x".repeat(65537)), dependencies)).resolves.toMatchObject({ status: 413 });
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
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 65536) return new Response("frame_too_large", { status: 413 });
  const path = new URL(request.url).pathname;
  if (path === "/voice/inbound" || path.startsWith("/voice/outbound/")) try { await deps.capacity.assertAcceptingNewTurn(); } catch { return new Response("unavailable", { status: 503 }); }
  if (path.startsWith("/voice/relay/") && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (!(await deps.twilio.verifyWebSocket({ method: "GET", url: new URL(request.url), headers: request.headers }))) return new Response("invalid_signature", { status: 403 });
    return deps.callSessions.getByName(path.slice("/voice/relay/".length)).fetch(request);
  }
  if (path === "/voice/inbound" && request.method === "POST") return handleInboundVoiceWebhook(request, deps);
  if (path.startsWith("/voice/outbound/") && request.method === "POST") return claimOutboundTwiML(request, deps);
  if (path === "/voice/relay-ended" && request.method === "POST") return handleTwilioRelayEndedCallback(request, deps);
  if (path === "/voice/status" && request.method === "POST") return handleTwilioStatusCallback(request, deps);
  return new Response("not_found", { status: 404 });
}
```

Both `/voice/status` and `/voice/relay-ended` read the exact raw form body, verify the Twilio signature before parsing, deduplicate provider identifiers through `CallRepository`, and advance but never reverse terminal state. The relay-ended callback records only allowlisted lifecycle fields; it never stores provider bodies or transcript fragments.

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
- Consumes: deployed `/voice/inbound`, `/voice/outbound/:commandId`, `/voice/status`, `/voice/relay-ended`, local `jarvis call-me --purpose smoke --confirm --wait --json`, and call event repository query endpoint available only to the enrolled smoke operator.
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
- WebSocket validation, streamed-token delivery acknowledgement, interruption, time/frame/turn limits, safe provider failures, and circuit-breaker-compatible routing are covered by Tasks 5, 6, and 8.
- Fake adapters, adversarial security tests, transaction-fault tests, and the real inbound/unauthorized-caller/outbound/no-answer/failure smoke harness, latency thresholds, and redacted evidence contract are covered by Tasks 2, 8, and 9; the final plan executes the credentialed gate after the CLI and deployment exist.

### Placeholder scan

The plan contains no unassigned implementation work, generic validation language, or deferred calling behavior. Task 6 contains the concrete PIN state transition and records only the authentication outcome, never the supplied digits.

### Type consistency

- `CallPhase`, `TranscriptState`, `OutboundCallCommand`, `ExpectedOutboundCall`, and `RelayBinding` originate in Task 1 and are consumed unchanged in later tasks.
- `TwilioProvider`, `PolicyEngine`, and their deterministic fakes originate in the foundation-cloud plan; Task 2 adds only the signed-webhook and ConversationRelay boundary.
- `ConversationService.handleTurn`, `OutboxDispatcher.dispatch`, and `ModelAdapter.stream` originate in Task 5 and are consumed by Task 6 and the later Telegram plan.
- `CallRepository.claimExpectedCall` produces `RelayBinding`, which Task 6 validates before model traffic.
- Foundation `PolicyEngine.evaluateOutboundCall` produces the immutable policy decision used for both initial and immediately-before-dispatch checks in Task 7.
- `validateEvidence` is exported by Task 9 and tested by the colocated live-gate unit test.

Approved execution mode: use `superpowers:subagent-driven-development` in the same isolated feature worktree after every foundation task passes, dispatch one fresh implementer per task, and require independent spec-compliance and code-quality review before advancing. The cost-bearing credentialed smoke commands remain deferred to the release execution checkpoint.

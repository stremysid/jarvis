# Jarvis Foundation Cloud Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the credential-free, testable cloud core that durably records canonical events, enforces outbound-call policy, authenticates enrolled devices, archives event history, and supplies deterministic provider fakes.

**Architecture:** A TypeScript Cloudflare Worker owns D1 as the operational ledger and R2 as the immutable historical tier. A workspace contracts package owns canonical JSON and versioned envelopes; the Worker consumes those contracts through focused repositories and services. This plan deliberately stops before Twilio/Telegram webhook and ConversationRelay route implementation.

**Tech Stack:** Node.js 24.19.0, pnpm, TypeScript, Vitest with `@cloudflare/vitest-pool-workers`, Wrangler, Cloudflare Workers, D1, R2, Web Crypto.

**Spec:** `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md`

## Global Constraints

- Use DeepSeek V4 Pro as the primary reasoning model; provider access stays behind an interface.
- Every cross-boundary message uses a versioned envelope with lowercase ULIDs, RFC 3339 UTC millisecond timestamps, NFC text, RFC 8785 canonical JSON, and SHA-256 hashes of post-redaction payloads.
- Commit each event, idempotency record, and outbox row in one D1 transaction.
- Consumers reject unsupported major schemas, tolerate documented additive fields, and dead-letter only redacted payloads.
- Store no credentials, authentication digits, raw call audio, authorization headers, or raw message text in logs.
- Cloud code performs no direct PC action; outbound calls require an immutable policy decision.
- Sync requests require an enrolled Ed25519 device key, five-minute clock window, body hash, audience, one-time nonce, and active subject binding.
- D1 retains at least 90 days plus unarchived events; R2 archival uses verified immutable content-addressed segments.
- All tests run without paid credentials. Run lint, typecheck, unit/integration tests, and acceptance tests before each task commit.
- Root `package.json` declares `"engines": { "node": ">=24.19.0 <25" }`; all package-manager commands run under Node 24.19.0.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/canonical-json.ts` | NFC normalization, RFC 8785 serialization, SHA-256 hashing. |
| `packages/contracts/src/ids.ts` | Lowercase ULIDs, canonical JSON, and SHA-256 primitives consumed by calling. |
| `packages/contracts/src/envelope.ts` | Public event envelope types and runtime validation. |
| `packages/contracts/src/calls.ts` | Provider-neutral outbound command shared by policy and calling. |
| `apps/cloud-gateway/src/persistence/*.ts` | D1 transaction, event, cursor, device, and archive persistence. |
| `apps/cloud-gateway/src/security/redaction.ts` | Typed pre-persistence redaction used by every event producer. |
| `apps/cloud-gateway/src/policy/*.ts` | Pure outbound policy evaluation and immutable decision persistence. |
| `apps/cloud-gateway/src/providers/*.ts` | Channel/model provider interfaces and deterministic fakes. |
| `apps/cloud-gateway/src/sync/*.ts` | Bootstrap enrollment, signed request verification, and cursor-backed reads. |
| `apps/cloud-gateway/src/archive/*.ts` | R2 segment encoding, verification, manifests, and archive reads. |
| `tests/acceptance/cloud-core-archive-and-sync.test.ts` | Credential-free cloud-core durability proof. |

### Task 1: Workspace and Worker test runtime

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`
- Modify: `.gitignore`
- Create: `README.md`, `AGENTS.md`, `VERSION`, `CHANGELOG.md`, `NEXT_STEPS.md`, `KNOWN_ISSUES.md`, `DECISIONS.md`, `REQUIREMENTS.md`, `TESTING.md`, `docs/HANDOFF.md`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`
- Create: `apps/cloud-gateway/package.json`, `apps/cloud-gateway/tsconfig.json`, `apps/cloud-gateway/wrangler.toml`, `apps/cloud-gateway/src/env.ts`, `apps/cloud-gateway/src/call-session-stub.ts`
- Test: `apps/cloud-gateway/test/workspace.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `Env`, a Worker test runtime with real D1/R2 bindings, and the `CALL_SESSION` Durable Object namespace required by the calling plan.

- [ ] **Step 1: Write the failing test**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker bindings", () => {
  it("executes against D1 and R2 and resolves the Durable Object binding", async () => {
    expect((await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>())?.value).toBe(1);
    await env.ARCHIVE.put("runtime-check", "ok");
    expect(await (await env.ARCHIVE.get("runtime-check"))?.text()).toBe("ok");
    expect(env.CALL_SESSION.idFromName("runtime-check").toString()).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jarvis/cloud-gateway test -- workspace.test.ts`

Expected: FAIL because the workspace and `../src/env` do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
// apps/cloud-gateway/src/env.ts
export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  CALL_SESSION: DurableObjectNamespace;
}
```

Create a pnpm workspace containing `packages/*`, `apps/*`, and `tests/*`. Set root `package.json` to `"engines": { "node": ">=24.19.0 <25" }`, commit the generated `pnpm-lock.yaml`, and make `.gitignore` exclude `node_modules/`, `.wrangler/`, `.dev.vars`, `.env*`, `coverage/`, and `dist/`. Configure `@cloudflare/vitest-pool-workers` with D1 database `jarvis_test`, R2 bucket `jarvis-archive-test`, and Durable Object binding `CALL_SESSION` to class `CallSessionStub`. Configure the production D1 binding's Wrangler `migrations_dir` as `src/persistence/migrations`; the deployable initial schema arrives in Task 3 as `0001_foundation.sql`. Authentication state never uses eventually consistent KV: the one-time bootstrap-token hash is a D1 row consumed in the same batch that creates the initial principal and device. Set the root scripts to `lint`, `typecheck`, `test`, `test:cloud`, and `test:acceptance`. Create the required repository documents; set `VERSION` to `0.1.0`, identify this approved spec in `REQUIREMENTS.md`, place command/test instructions in `TESTING.md`, and initialize `docs/HANDOFF.md` with the completed workspace task and next task.

- [ ] **Step 4: Run verification**

Run: `pnpm install; pnpm --filter @jarvis/cloud-gateway test -- workspace.test.ts; pnpm typecheck`

Expected: PASS; the test performs a D1 query, R2 round trip, and Durable Object binding resolution in the Worker runtime.

- [ ] **Step 5: Commit**

```powershell
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .gitignore tsconfig.base.json vitest.workspace.ts README.md AGENTS.md VERSION CHANGELOG.md NEXT_STEPS.md KNOWN_ISSUES.md DECISIONS.md REQUIREMENTS.md TESTING.md docs/HANDOFF.md packages/contracts apps/cloud-gateway
git commit -m "chore: initialize Jarvis cloud workspace"
```

### Task 2: Canonical event contracts

**Files:**
- Create: `packages/contracts/src/ids.ts`, `packages/contracts/src/canonical-json.ts`, `packages/contracts/src/envelope.ts`, `packages/contracts/src/calls.ts`, `packages/contracts/src/index.ts`, `apps/cloud-gateway/src/security/redaction.ts`
- Test: `packages/contracts/test/canonical-json.test.ts`, `packages/contracts/test/envelope.test.ts`, `apps/cloud-gateway/test/security/redaction.test.ts`

**Interfaces:**
- Consumes: Task 1 TypeScript workspace.
- Produces: `newUlid`, `canonicalize`, `canonicalJson`, `sha256Hex`, `Ulid`, `Sha256Hex`, `EventEnvelopeV1`, compatibility alias `EventEnvelope`, `OutboundCallCommand`, `SignedRequestV1`, `Redactor`, `createEnvelope(input)`, and `validateEnvelope(value)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, it } from "vitest";
import { canonicalJson, createEnvelope, sha256Hex } from "../src";

it("normalizes NFC before hashing a payload", async () => {
  expect(await sha256Hex(canonicalJson({ text: "e\u0301" }))).toBe(
    await sha256Hex(canonicalJson({ text: "é" })),
  );
});

it("rejects an envelope whose hash does not match its payload", async () => {
  await expect(createEnvelope({
    schemaVersion: "1.0", eventId: "01j00000000000000000000000",
    eventType: "message.committed", source: "telegram", subjectId: "sid",
    occurredAt: "2026-08-29T00:00:00.000Z", receivedAt: "2026-08-29T00:00:00.000Z",
    correlationId: "01j00000000000000000000001",
    contentType: "application/json", payload: { text: "hi" }, redaction: { status: "none", markers: [] }, producerVersion: "0.1.0"
  } as never)).resolves.toMatchObject({ contentType: "application/json" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jarvis/contracts test -- canonical-json.test.ts envelope.test.ts`

Expected: FAIL because `../src` exports do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Ulid = string & { readonly __ulid: unique symbol };
export type Sha256Hex = string & { readonly __sha256: unique symbol };
export function newUlid(now = new Date()): Ulid { return monotonicUlid(now) as Ulid; }
export function canonicalize(value: unknown): Uint8Array { return new TextEncoder().encode(rfc8785(normalizeJsonText(value as JsonValue))); }
export function canonicalJson(value: unknown): string { return new TextDecoder().decode(canonicalize(value)); }
export async function sha256Hex(input: string | Uint8Array): Promise<Sha256Hex> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") as Sha256Hex;
}
export interface EventEnvelopeV1<T extends JsonValue = JsonValue> {
  schemaVersion: "1.0"; eventId: Ulid; eventSequence?: number; eventType: string; source: string; subjectId: string;
  occurredAt: string; receivedAt: string; correlationId: Ulid; causationId?: Ulid;
  contentType: "application/json"; contentHash: Sha256Hex; payload: T;
  redaction: { status: "redacted" | "none"; markers: string[] }; producerVersion: string;
}
export type EventEnvelope<T extends JsonValue = JsonValue> = EventEnvelopeV1<T>;
export async function createEnvelope<T extends JsonValue>(input: Omit<EventEnvelopeV1<T>, "contentHash">): Promise<EventEnvelopeV1<T>> {
  const payload = normalizeJsonText(input.payload) as T;
  return { ...input, payload, contentHash: await sha256Hex(canonicalJson(payload)) };
}
```

Export the `OutboundCallCommand` consumed by calling: `commandId`, `principalId`, `purposeCode: "smoke" | "user_requested"`, `destinationIdentityId`, `urgency: "normal" | "urgent"`, `authorizationExpiresAt`, `idempotencyKey`, and `issuedBy: "telegram_call_command" | "local_cli"`. Export `SignedRequestV1` with `schemaVersion: "1.0"`, `deviceId`, `principalId`, `audience`, `issuedAt`, `nonce`, `bodyHash`, and `signatureBase64`. Implement `Redactor.redact({ text, channel: "voice" | "telegram", field })` and `Redactor.redactText(text)` as the only event-producer ingress: each returns `{ ok: true, text, markers }` or `{ ok: false, category: "ingest_redaction_failed" }`; `createEnvelope` accepts only successful redaction output. Reject `undefined`, non-finite numbers, non-lowercase ULIDs, non-millisecond UTC timestamps, and mismatched hashes in `validateEnvelope`.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @jarvis/contracts test; pnpm --filter @jarvis/contracts typecheck`

Expected: PASS; decomposed and composed Unicode hash identically and invalid envelopes throw.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts apps/cloud-gateway/src/security/redaction.ts apps/cloud-gateway/test/security/redaction.test.ts
git commit -m "feat(contracts): add canonical versioned envelopes"
```

### Task 3: D1 event ledger, idempotency, outbox, and cursors

**Files:**
- Create: `apps/cloud-gateway/src/persistence/migrations/0001_foundation.sql`, `apps/cloud-gateway/src/persistence/transaction.ts`, `apps/cloud-gateway/src/persistence/event-repository.ts`, `apps/cloud-gateway/src/persistence/cursor-repository.ts`
- Test: `apps/cloud-gateway/test/persistence/event-repository.test.ts`, `apps/cloud-gateway/test/persistence/cursor-repository.test.ts`

**Interfaces:**
- Consumes: `EventEnvelopeV1` and branded `Sha256Hex` hashes from Task 2 and `Env` from Task 1.
- Produces: `TransactionRunner.batch`, `EventRepository.append`, `EventRepository.readRange`, `CursorRepository.advanceContiguous`.

- [ ] **Step 1: Write the failing tests**

```ts
it("commits event, idempotency record, and outbox row together", async () => {
  const first = await events.append({ envelope, scope: "telegram:update", key: "42", requestHash });
  const replay = await events.append({ envelope, scope: "telegram:update", key: "42", requestHash });
  expect(first).toMatchObject({ eventSequence: 1, replayed: false });
  expect(replay).toMatchObject({ eventSequence: 1, replayed: true });
});

it("atomically advances a cursor through a durably acknowledged contiguous page", async () => {
  await cursors.advanceContiguous("device:d1", 0, 100);
  await expect(cursors.advanceContiguous("device:d1", 0, 200)).rejects.toThrow("cursor_compare_failed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:cloud -- persistence/event-repository.test.ts persistence/cursor-repository.test.ts`

Expected: FAIL because the repositories and migration do not exist.

- [ ] **Step 3: Write the minimal implementation**

Create the deployable Wrangler migration `0001_foundation.sql` with tables: `events`, `idempotency_records`, `outbox`, `consumer_cursors`, `sync_snapshots`, `bootstrap_tokens`, `device_keys`, `request_nonces`, `policy_decisions`, `archive_manifests`, and `archive_segments`. `bootstrap_tokens` stores only a SHA-256 token hash, expiry, consumed timestamp, and non-secret setup metadata. Define:

```ts
export interface AppendedEvent { eventSequence: number; envelope: EventEnvelope; replayed: boolean; }
export interface EventRepository {
  append(input: { envelope: EventEnvelopeV1; scope: string; key: string; requestHash: Sha256Hex }): Promise<AppendedEvent>;
  readRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]>;
}
export interface CursorRepository {
  advanceContiguous(consumerName: string, expectedCurrent: number, throughSequence: number): Promise<void>;
  read(consumerName: string): Promise<number>;
}
export interface TransactionRunner {
  batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<unknown>[]>;
}
```

Implement `TransactionRunner.batch()` as a narrow wrapper over Cloudflare D1's documented `D1Database.batch()` API; batched statements execute as one SQL transaction and roll back together on failure. Event insert, idempotency insert, and outbox insert are one batch. On an existing `(scope,key)`, return the existing event only when `request_hash` equals; otherwise throw `IdempotencyConflict`. `advanceContiguous` performs a compare-and-set from `expectedCurrent` to `throughSequence`, verifies every sequence in that inclusive range exists and is contiguous, and writes the cursor and receipt ACK in one batch. `sync_snapshots` stores `snapshotId`, consumer name, inclusive upper sequence, expiry, and the immutable page boundary. Do not invent a callback-style `D1Transaction`; D1 exposes prepared statements and transactional batches.

- [ ] **Step 4: Run verification**

Run: `pnpm test:cloud -- persistence/event-repository.test.ts persistence/cursor-repository.test.ts; pnpm typecheck`

Expected: PASS; replay is stable, conflicts reject, and a stale or gapped page ACK cannot advance a cursor.

- [ ] **Step 5: Commit**

```powershell
git add apps/cloud-gateway/src/persistence apps/cloud-gateway/test/persistence
git commit -m "feat(cloud): add transactional event ledger"
```

### Task 4: Outbound-call policy core

**Files:**
- Create: `apps/cloud-gateway/src/policy/policy-types.ts`, `apps/cloud-gateway/src/policy/policy-engine.ts`, `apps/cloud-gateway/src/policy/policy-audit.ts`
- Test: `apps/cloud-gateway/test/policy/policy-engine.test.ts`

**Interfaces:**
- Consumes: Task 2 `OutboundCallCommand`, Task 3 `EventRepository`, `TransactionRunner`, and `policy_decisions` table.
- Produces: `PolicyEngine.evaluateOutboundCall(request): Promise<PolicyDecision>` and `PolicyEngine.recheckOutboundDispatch(request): Promise<DispatchPolicyCheck>`.

- [ ] **Step 1: Write the failing test**

```ts
it("denies a model-originated call before provider dispatch", async () => {
  const result = await policy.evaluateOutboundCall({ ...request, issuedBy: "model" as never });
  expect(result).toMatchObject({ decision: "deny", reason: "invalid_origin" });
  expect(await decisions.count()).toBe(1);
});

it("rechecks mutable dispatch guards even after an immutable allow decision", async () => {
  await policy.evaluateOutboundCall(request);
  context.killSwitch = true;
  await expect(policy.recheckOutboundDispatch(request)).resolves.toMatchObject({ decision: "deny", reason: "kill_switch_enabled" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:cloud -- policy/policy-engine.test.ts`

Expected: FAIL because `PolicyEngine` is undefined.

- [ ] **Step 3: Write the minimal implementation**

```ts
export interface OutboundCallRequest extends OutboundCallCommand {}
export interface PolicyDecision { decision: "allow" | "deny"; reason: "allowed" | "invalid_origin" | "destination_not_verified" | "authorization_expired" | "quiet_hours" | "daily_limit" | "concurrency_limit" | "retry_limit" | "kill_switch_enabled"; }
export interface DispatchPolicyCheck { decision: "allow" | "deny"; reason: PolicyDecision["reason"]; checkedAt: string; }
export interface PolicyEngine {
  evaluateOutboundCall(request: OutboundCallRequest): Promise<PolicyDecision>;
  recheckOutboundDispatch(request: OutboundCallRequest): Promise<DispatchPolicyCheck>;
}
```

`evaluateOutboundCall` validates `issuedBy` (`telegram_call_command` or `local_cli` only), `destinationIdentityId`, `purposeCode`, expiry, kill switch, quiet hours, two-call concurrency, six-per-day cap, and one-retry cap, then inserts one immutable authorization decision keyed by `commandId`; idempotent repeats return that original decision. `recheckOutboundDispatch` never overwrites the authorization decision: it rereads the authorized command and reevaluates the current kill switch, expiry, quiet hours, concurrency, daily count, and retry count immediately before every provider submission, then appends a separate dispatch-check audit event. The calling plan consumes this exact command shape.

- [ ] **Step 4: Run verification**

Run: `pnpm test:cloud -- policy/policy-engine.test.ts`

Expected: PASS; every deny reason is asserted and a replay returns its first decision.

- [ ] **Step 5: Commit**

```powershell
git add apps/cloud-gateway/src/policy apps/cloud-gateway/test/policy
git commit -m "feat(cloud): add outbound call policy"
```

### Task 5: Deterministic provider fakes

**Files:**
- Create: `apps/cloud-gateway/src/providers/provider-types.ts`, `provider-circuit-breaker.ts`, `fake-model-provider.ts`, `fake-twilio-provider.ts`, `fake-telegram-provider.ts`
- Test: `apps/cloud-gateway/test/providers/fakes.test.ts`

**Interfaces:**
- Consumes: Task 2 lowercase ULID strings.
- Produces: `ModelProvider`, `TwilioProvider`, `TelegramProvider`, and `ProviderCircuitBreaker`; each fake provides `requests`, `failNext(error)`, and `delayNext(milliseconds)`.

- [ ] **Step 1: Write the failing test**

```ts
it("does not dispatch the same Twilio idempotency key twice", async () => {
  const one = await fake.createCall(call);
  const two = await fake.createCall(call);
  expect(two).toEqual(one);
  expect(fake.requests).toHaveLength(1);
});

it("opens after five qualifying failures in 60 seconds and probes after 30 seconds", async () => {
  await recordFailures(breaker, 5, clock.now());
  expect(breaker.allow(clock.now())).toBe(false);
  clock.advance(30_000);
  expect(breaker.allow(clock.now())).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:cloud -- providers/fakes.test.ts`

Expected: FAIL because `FakeTwilioProvider` is undefined.

- [ ] **Step 3: Write the minimal implementation**

```ts
export interface TwilioProvider { createCall(input: { commandId: string; toE164: string; twimlUrl: URL; statusCallbackUrl: URL; statusCallbackEvents: readonly ["initiated", "ringing", "answered", "completed"]; idempotencyKey: string }): Promise<{ callSid: string }>; }
export type ModelChunk = { type: "token"; index: number; text: string } | { type: "completed" };
export interface ModelContextItem { sourceEventId: string; text: string; sensitivity: "personal" | "restricted"; }
export interface ModelProvider {
  streamText(input: { correlationId: string; principalId: string; channel: "voice" | "telegram"; userText: string; context: readonly ModelContextItem[]; timeoutMs: number; contextTokenBudget: number; reasoningEffort: "none" | "low" | "high" | "max"; signal: AbortSignal }): AsyncIterable<ModelChunk>;
  completeJson(input: { correlationId: string; principalId: string; purpose: "memory_distillation"; prompt: string; timeoutMs: number; maxOutputTokens: number; reasoningEffort: "high" }): Promise<unknown>;
}
export class FakeTwilioProvider implements TwilioProvider {
  readonly requests: Parameters<TwilioProvider["createCall"]>[0][] = [];
  private readonly results = new Map<string, { callSid: string }>();
  async createCall(input: Parameters<TwilioProvider["createCall"]>[0]) {
    const existing = this.results.get(input.idempotencyKey);
    if (existing) return existing;
    this.requests.push(input);
    const result = { callSid: `CA${String(this.requests.length).padStart(32, "0")}` };
    this.results.set(input.idempotencyKey, result);
    return result;
  }
}
```

Use deterministic message IDs for Telegram and configured text/token counts for the model fake. A queued injected failure is consumed by exactly one invocation.

`ProviderCircuitBreaker` is keyed by provider operation, counts only classified transient failures in a rolling 60-second window, opens at five, rejects with a channel-specific safe category, permits one recovery probe after 30 seconds, and closes only after a successful probe. Authentication and policy denials never enter the breaker and never retry.

- [ ] **Step 4: Run verification**

Run: `pnpm test:cloud -- providers/fakes.test.ts; pnpm typecheck`

Expected: PASS; fakes are deterministic, idempotent, delayable, and fault-injectable.

- [ ] **Step 5: Commit**

```powershell
git add apps/cloud-gateway/src/providers apps/cloud-gateway/test/providers
git commit -m "test(cloud): add deterministic provider fakes"
```

### Task 6: Bootstrap enrollment and device-signed sync

**Files:**
- Create: `apps/cloud-gateway/src/sync/signed-request.ts`, `device-enrollment.ts`, `identity-challenge.ts`, `sync-service.ts`, `apps/cloud-gateway/src/persistence/device-repository.ts`
- Test: `apps/cloud-gateway/test/sync/signed-request.test.ts`, `apps/cloud-gateway/test/sync/identity-challenge.test.ts`, `apps/cloud-gateway/test/sync/sync-service.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 contracts, `EventRepository`, and `CursorRepository`.
- Produces: `DeviceRequestVerifier.verify`, `SyncService.pull`, `SyncService.acknowledgeDurableReceipt`, `DeviceEnrollment.bootstrap`, and `IdentityChallengeService.begin/confirm`.

- [ ] **Step 1: Write the failing test**

```ts
it("rejects a replayed signed sync request", async () => {
  await verifier.verify(request, "POST", "/sync/pull", body, now);
  await expect(verifier.verify(request, "POST", "/sync/pull", body, now)).rejects.toThrow("replayed nonce");
});

it("advances only after the local archive acknowledges a complete snapshot page", async () => {
  const page = await sync.pull(verifiedRequest, { afterSequence: 0, pageSize: 100 });
  await sync.acknowledgeDurableReceipt(verifiedRequest, { snapshotId: page.snapshotId, expectedCurrent: 0, throughSequence: page.toSequence });
  expect(await cursors.read(`device:${verifiedRequest.deviceId}`)).toBe(page.toSequence);
});

it("activates a pending channel identity only through an enrolled-device challenge", async () => {
  const challenge = await identities.begin(enrolledDeviceRequest, { channel: "telegram", identityId: "pending-telegram" });
  await expect(identities.confirm({ challengeId: challenge.challengeId, response: challenge.response, observedChannelIdentityId: "different" })).rejects.toThrow("identity_challenge_mismatch");
  await expect(identities.confirm({ challengeId: challenge.challengeId, response: challenge.response, observedChannelIdentityId: "pending-telegram" })).resolves.toMatchObject({ state: "active" });
});

it("requires a PIN-authenticated phone confirmation and consumes its challenge once", async () => {
  const challenge = await identities.begin(enrolledDeviceRequest, { channel: "phone", identityId: "pending-phone" });
  await expect(identities.confirm({ challengeId: challenge.challengeId, response: challenge.response, observedChannelIdentityId: "pending-phone", pinAuthenticated: false })).rejects.toThrow("phone_pin_required");
  await expect(identities.confirm({ challengeId: challenge.challengeId, response: challenge.response, observedChannelIdentityId: "pending-phone", pinAuthenticated: true })).resolves.toMatchObject({ state: "active" });
  await expect(identities.confirm({ challengeId: challenge.challengeId, response: challenge.response, observedChannelIdentityId: "pending-phone", pinAuthenticated: true })).rejects.toThrow("identity_challenge_consumed");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:cloud -- sync/signed-request.test.ts sync/identity-challenge.test.ts sync/sync-service.test.ts`

Expected: FAIL because the verifier and enrollment service do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export interface DeviceRequestVerifier { verify(request: SignedRequestV1, method: "GET" | "POST", path: string, rawBody: Uint8Array, now: Date): Promise<{ deviceId: string; principalId: string }>; }
export interface SequencedEventV1 { eventSequence: number; envelope: EventEnvelopeV1; }
export interface SyncEventsPageV1 { snapshotId: string; snapshotToken: string; fromSequence: number; toSequence: number; events: readonly SequencedEventV1[]; hasMore: boolean; }
export interface SyncAckReceiptV1 { schemaVersion: "1.0"; currentSequence: number; replayed: boolean; }
export interface IdentityChallengeService {
  begin(request: SignedRequestV1, input: { channel: "phone" | "telegram"; identityId: string }): Promise<{ challengeId: string; response: string }>;
  confirm(input: { challengeId: string; response: string; observedChannelIdentityId: string; pinAuthenticated?: boolean }): Promise<{ identityId: string; state: "active" }>;
}
```

Verify Ed25519 over `${method}\n${path}\n${deviceId}\n${principalId}\n${audience}\n${issuedAt}\n${nonce}\n${bodyHash}`. Atomically insert the nonce before responding. Before bootstrap, the setup script derives and installs `PIN_VERIFIER_JSON` in Cloudflare secret storage; Worker code cannot create or mutate a secret binding. The same script generates a 256-bit bootstrap token, stores only its hash and 15-minute expiry in D1, and passes the plaintext directly to the local enrollment client without printing or writing it. Bootstrap validates the PIN binding without logging it and uses one `TransactionRunner.batch()` to compare/consume the unexpired bootstrap-token hash and create the principal, first active device, verifier version/reference, and pending phone/Telegram identities. A failed batch consumes nothing; after a committed attempt the token is irrevocably consumed, and recovery requires a new setup token. A preinstalled PIN secret or unconsumed token alone grants no normal access and can be safely rotated/expired. `IdentityChallengeService.begin` requires the active device's signed request, returns the plaintext response exactly once to the authenticated local CLI, and stores only a five-minute, one-use hash bound to principal, channel, and pending identity. Phone confirmation additionally requires the already-verified call PIN. Channel handlers may call `confirm` only with the provider-observed identity; mismatches, expiry, replay, or model-supplied identifiers fail. `pull` creates an expiring snapshot with an inclusive upper sequence and returns a page bounded by that snapshot; it never advances a cursor. `acknowledgeDurableReceipt` verifies device/principal ownership and the snapshot boundary, then calls `advanceContiguous(device:${deviceId}, expectedCurrent, throughSequence)` in one transaction and returns `SyncAckReceiptV1`. A duplicate ACK is idempotent and returns the stored cursor with `replayed: true`; a stale, gapped, foreign-device, or expired-snapshot ACK rejects.

- [ ] **Step 4: Run verification**

Run: `pnpm test:cloud -- sync/signed-request.test.ts sync/identity-challenge.test.ts sync/sync-service.test.ts`

Expected: PASS; expired, forged, revoked, mismatched-body, and replayed requests fail; channel activation is one-time and provider-identity-bound; page ACKs advance an owned cursor atomically across a contiguous range only.

- [ ] **Step 5: Commit**

```powershell
git add apps/cloud-gateway/src/sync apps/cloud-gateway/src/persistence/device-repository.ts apps/cloud-gateway/test/sync
git commit -m "feat(sync): add enrolled device synchronization"
```

### Task 7: R2 immutable archival

**Files:**
- Create: `apps/cloud-gateway/src/archive/segment-codec.ts`, `archive-repository.ts`, `archival-service.ts`, `archival-worker.ts`, `capacity-guard.ts`
- Test: `apps/cloud-gateway/test/archive/archival-service.test.ts`, `apps/cloud-gateway/test/archive/capacity-guard.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 canonical envelopes, D1 event repository, and `Env.ARCHIVE`.
- Produces: `ArchivalService.archiveEligible(now, maxEvents)`, `ArchivalService.readArchivedRange(afterSequence, limit)`, and `CapacityGuard.assertAcceptingNewTurn()`.

- [ ] **Step 1: Write the failing test**

```ts
it("publishes an R2 manifest before making events purge-eligible", async () => {
  const manifest = await archive.archiveEligible(new Date("2026-12-01T00:00:00Z"), 100);
  expect(manifest).toMatchObject({ startSequence: 1, endSequence: 100, eventCount: 100 });
  expect(await archive.readArchivedRange(0, 100)).toHaveLength(100);
});

it("alerts at 70 and 85 percent and rejects before accepting content at 95 percent", async () => {
  await expect(capacity.atUsage(0.70).assertAcceptingNewTurn()).resolves.toBeUndefined();
  expect(metrics.alerts).toContain("capacity_70");
  await expect(capacity.atUsage(0.95).assertAcceptingNewTurn()).rejects.toThrow("capacity_unavailable");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:cloud -- archive/archival-service.test.ts archive/capacity-guard.test.ts`

Expected: FAIL because `ArchivalService` is undefined.

- [ ] **Step 3: Write the minimal implementation**

Encode canonical gzip NDJSON with a first metadata line containing schema version, start/end sequence, and event count. Store it at `events/sha256/<compressed-bytes-sha256>.ndjson.gz`. Read it back from R2, verify the compressed-byte SHA-256, metadata bounds, envelope hashes, and count; then insert the immutable manifest and one segment row per sequence in a single D1 transaction. Only manifest-covered events aged at least 90 days can be marked purge-eligible.

`CapacityGuard` consumes configured D1/R2 byte budgets and provider usage estimates, emits deduplicated safe alerts when either tier crosses 70 or 85 percent, and throws `capacity_unavailable` at 95 percent before a call session or Telegram turn reads/persists user content. An archival circuit breaker opens on verification/manifest failure and prevents purge.

- [ ] **Step 4: Run verification**

Run: `pnpm test:cloud -- archive/archival-service.test.ts archive/capacity-guard.test.ts; pnpm typecheck`

Expected: PASS; a simulated failure before manifest commit leaves events non-purgeable, and archived reads preserve sequence order.

- [ ] **Step 5: Commit**

```powershell
git add apps/cloud-gateway/src/archive apps/cloud-gateway/test/archive
git commit -m "feat(archive): add verified R2 event segments"
```

### Task 8: Cloud-core acceptance proof

**Files:**
- Create: `tests/acceptance/package.json`, `tests/acceptance/cloud-core-archive-and-sync.test.ts`
- Create: `apps/cloud-gateway/src/observability/safe-log.ts`, `apps/cloud-gateway/src/http/health.ts`
- Test: `apps/cloud-gateway/test/observability/safe-log.test.ts`, `apps/cloud-gateway/test/http/health.test.ts`
- Test: `tests/acceptance/cloud-core-archive-and-sync.test.ts`

**Interfaces:**
- Consumes: all Task 1–7 public interfaces.
- Produces: `SafeLogger`, public `handleLiveness`, and a credential-free acceptance result proving no accepted event is lost and no denied call reaches Twilio.

- [ ] **Step 1: Write the failing test**

```ts
it("preserves 1,000 canonical events across D1, R2, and signed sync", async () => {
  await bootstrapOneDevice();
  await appendCanonicalEvents(1000);
  await archiveAndPurgeEligibleEvents();
  const copied = await pullIntoEmptyLocalArchive();
  expect(copied.map((event) => event.eventSequence)).toEqual([...Array(1000)].map((_, i) => i + 1));
  expect(fakeTwilio.requests).toHaveLength(0);
});

it("exposes only ok or unavailable publicly and rejects unsafe log fields by type", async () => {
  expect(await handleLiveness(healthyDeps)).toEqual(new Response("ok"));
  expect(() => logger.info({ eventId, correlationId, component: "sync", operation: "pull", outcome: "ok", text: "raw" } as never)).toThrow("unsafe_log_field");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:acceptance -- cloud-core-archive-and-sync.test.ts`

Expected: FAIL because acceptance helpers and the complete cloud-core composition do not exist.

- [ ] **Step 3: Write the minimal implementation**

Compose real repositories/services with Worker test bindings and deterministic fakes. The test must bootstrap one device; append 1,000 post-redaction envelopes; deny a model-origin outbound command; replay a signed sync request; archive/purge the aged range; pull from D1 plus R2; and assert every event sequence, canonical envelope hash, and content hash matches the original.

`SafeLogger` accepts only event ID, correlation ID, component, operation, duration, outcome, and an enumerated safe error category; raw text, transcripts, channel identifiers, provider bodies, headers, and arbitrary extra fields are unrepresentable and rejected at runtime. Public liveness is rate-limited and returns only `ok` or `unavailable`. Task 9 adds operator-only detailed readiness after `OperatorAuthorizer` exists.

- [ ] **Step 4: Run verification**

Run: `pnpm test:acceptance -- cloud-core-archive-and-sync.test.ts; pnpm test:cloud -- observability/safe-log.test.ts http/health.test.ts; pnpm lint; pnpm typecheck; pnpm test`

Expected: PASS; all 1,000 events survive, replay is rejected, and the denied command produces zero Twilio requests.

- [ ] **Step 5: Commit**

```powershell
git add tests/acceptance apps/cloud-gateway/src/observability apps/cloud-gateway/src/http/health.ts apps/cloud-gateway/test/observability apps/cloud-gateway/test/http/health.test.ts
git commit -m "test(acceptance): verify cloud core durability"
```

### Task 9: Channel identity and enrolled-operator authorization

**Files:**
- Create: `apps/cloud-gateway/src/policy/policy-service.ts`, `apps/cloud-gateway/src/policy/operator-auth.ts`
- Modify: `apps/cloud-gateway/src/http/health.ts`
- Create: `apps/cloud-gateway/test/policy/policy-service.test.ts`, `apps/cloud-gateway/test/policy/operator-auth.test.ts`
- Modify: `apps/cloud-gateway/test/http/health.test.ts`

**Interfaces:**
- Consumes: Task 6 enrolled device and channel-identity repositories plus `DeviceRequestVerifier`.
- Produces: `PolicyService.authenticateTelegram`, `OperatorAuthorizer.requireEnrolledOperator`, and operator-only `handleReadiness` for the Telegram, readiness, smoke-evidence, and recovery routes. The calling plan owns the shared streaming conversation and channel-delivery services because it is the first consumer that requires delivery acknowledgement and interruption.

- [ ] **Step 1: Write the failing authorization tests**

```ts
it("does not query an identity when the Telegram webhook secret is invalid", async () => {
  await expect(policy.authenticateTelegram({ telegramUserId: "44", webhookSecretValid: false })).resolves.toEqual({ principalId: "", identityState: "blocked" });
  expect(identities.requests).toHaveLength(0);
});

it("binds detailed readiness to the principal of an active signed device", async () => {
  await expect(operator.requireEnrolledOperator(signedRequest)).resolves.toEqual({ operatorId: "principal-1" });
  await expect(operator.requireEnrolledOperator(revokedDeviceRequest)).rejects.toThrow("operator_not_authorized");
});

it("rejects detailed readiness without an enrolled operator", async () => {
  await expect(handleReadiness(unauthenticatedRequest, healthyDeps)).resolves.toMatchObject({ status: 401 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:cloud -- policy/policy-service.test.ts policy/operator-auth.test.ts http/health.test.ts`

Expected: FAIL because the authorization services do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export interface PolicyService {
  authenticateTelegram(input: { telegramUserId: string; webhookSecretValid: boolean }): Promise<{ principalId: string; identityState: "active" | "pending" | "blocked" }>;
}
export interface OperatorAuthorizer {
  requireEnrolledOperator(request: Request): Promise<{ operatorId: string }>;
}
```

`PolicyService.authenticateTelegram` returns `blocked` before identity lookup when the secret is invalid and otherwise resolves the active, pending, or blocked identity created by bootstrap. `OperatorAuthorizer` verifies the request body and enrolled-device signature through `DeviceRequestVerifier`, requires active device status and principal binding, and returns only the opaque principal identifier. Neither service logs or returns channel identifiers.

`handleReadiness` calls `OperatorAuthorizer` before querying components and returns only allowlisted component state, queue depth, sync lag, and capacity category; it never returns provider bodies, direct identifiers, prompts, or secret metadata.

- [ ] **Step 4: Run verification**

Run: `pnpm test:cloud -- policy/policy-service.test.ts policy/operator-auth.test.ts http/health.test.ts; pnpm typecheck`

Expected: PASS; invalid Telegram secrets reveal no identity state and revoked, forged, expired, or foreign-principal operator requests fail closed.

- [ ] **Step 5: Commit**

```powershell
git add apps/cloud-gateway/src/policy/policy-service.ts apps/cloud-gateway/src/policy/operator-auth.ts apps/cloud-gateway/src/http/health.ts apps/cloud-gateway/test/policy/policy-service.test.ts apps/cloud-gateway/test/policy/operator-auth.test.ts apps/cloud-gateway/test/http/health.test.ts
git commit -m "feat(cloud): add channel identity and operator authorization"
```

## Self-Review

**Spec coverage:** Tasks 1–3 establish repository discipline, Node 24.19.0 tooling, shared canonical contracts, redaction, D1 transactional batches, outbox rows, snapshots, and cursor ACKs. Task 4 implements immutable outbound authorization plus a fresh pre-dispatch safety recheck over the shared calling command. Task 5 provides deterministic provider fakes and exact streaming/background model seams. Task 6 implements bootstrap/device enrollment and signed page/ACK synchronization. Task 7 implements 90-day D1 to verified R2 retention. Task 8 proves the cloud data flow. Task 9 exports Telegram-identity and enrolled-operator authorization consumed by later plans. Voice routes, shared conversation orchestration, Telegram webhook handling, real DeepSeek integration, and local SQLite archive remain outside this cloud-core plan.

**Placeholder scan:** This document contains no TBD markers, deferred implementation instructions, or unspecified test behavior.

**Type consistency:** `EventEnvelopeV1` is the canonical envelope and `EventEnvelope` is its compatibility alias. `canonicalize` returns `Uint8Array`; `canonicalJson` returns its UTF-8 text form; `sha256Hex` asynchronously accepts either form. Later tasks consume `EventRepository`, `CursorRepository.advanceContiguous`, `PolicyEngine.evaluateOutboundCall`, `PolicyEngine.recheckOutboundDispatch`, `DeviceRequestVerifier`, `SyncService.acknowledgeDurableReceipt`, `ArchivalService`, `ModelProvider`, `PolicyService`, and `OperatorAuthorizer` exactly as named in the tasks that introduce them.

## Execution Handoff

Approved execution mode: use `superpowers:subagent-driven-development` in an isolated feature worktree, dispatch one fresh implementer per task, and require independent spec-compliance and code-quality review before advancing. Execute this foundation plan before the calling and Telegram/local/release plans.

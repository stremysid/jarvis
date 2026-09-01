# Jarvis Telegram, Local Memory, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authenticated Telegram text, a secure Windows local agent with permanent two-tier memory, and auditable 0.1.0 deployment and release evidence.

**Architecture:** The Cloudflare gateway remains the authoritative operational event store and policy boundary. Telegram creates redacted, idempotent events through the existing conversation service; the Windows agent synchronizes those events through signed cursor pages into an append-only SQLite archive, derives provenance-backed facts locally through a cloud-only DeepSeek call, and uploads only active fact projections. Local semantic retrieval is selected by a Windows/offline compatibility gate and falls back to deterministic SQLite BLOB cosine search if a SQLite vector extension is not viable.

**Tech Stack:** TypeScript, Cloudflare Workers/D1/R2, Vitest and Miniflare, Python 3.14.7 on the reference Windows machine (`requires-python >=3.12,<3.15`), SQLite with FTS5, `cryptography`, Windows DPAPI/CNG, Ed25519, pytest, PowerShell, Telegram Bot API, DeepSeek chat-compatible API.

**Spec:** `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md`

## Global Constraints

- This plan depends on the foundation plan having created `canonicalize(value): Uint8Array`, `canonicalJson(value): string`, `sha256Hex(value)`, `createEnvelope(input)`, `validateEnvelope(value)`, `EventEnvelopeV1`/`EventEnvelope`, `SignedRequestV1`, `EventRepository`, `CursorRepository`, `DeviceRequestVerifier`, `SyncService`, `PolicyService`, `OperatorAuthorizer`, deterministic provider fakes, D1/R2 bindings, and the Worker test harness.
- This plan consumes the calling plan's shared `ConversationService.handleTurn`, `OutboxDispatcher.dispatch`, and `ModelAdapter.stream`; it must not create a parallel text-conversation or delivery contract. Voice and Telegram keep separate ordered sessions while sharing the authenticated principal, event store, redactor, and authorized memory-retrieval boundary.
- Calling plan owns Twilio/ConversationRelay, caller PIN verification, outbound-call authorization, and the permanent live-call gate. This plan must not alter those implementations, but its event and retrieval APIs must keep their interface contracts.
- Every cross-boundary payload has a supported major schema version, lowercase ULID identifiers, RFC 3339 UTC millisecond timestamps, Unicode NFC text, RFC 8785 canonical JSON, and SHA-256 content hashes over canonical post-redaction payloads.
- Consumers reject unsupported major schema versions, accept documented additive fields, and dead-letter only redacted payloads for 30 days without executing them.
- Telegram accepts text only; it must never call Telegram file-download APIs or persist file identifiers, captions, media metadata, raw provider bodies, credentials, authorization data, or unredacted content.
- The local raw archive is append-only in both its public API and SQLite triggers. Update and delete operations are absent from its API.
- The local agent never stores `DEEPSEEK_API_KEY`; only the cloud gateway can call DeepSeek.
- Default Telegram limits are 30 accepted text messages per minute, 200 per day, and 32 KiB UTF-8 text per message. One Telegram turn may use the model concurrently; overload returns a visible safe response.
- The gateway continues calls and Telegram while Windows is offline. At 95 percent configured D1 or R2 capacity, it refuses new turns before accepting content.
- Sync requests use device status, principal binding, audience, timestamp within five minutes, one-time nonce, canonical body hash, and Ed25519 signature. A device cannot read or advance another device's cursor.
- Archive backups use a random key protected by DPAPI, a versioned manifest, and integrity hashes. FTS/vector indexes are always rebuildable from the raw archive.
- The semantic baseline is `onnxruntime==1.29.0` running the offline `sentence-transformers/all-MiniLM-L6-v2` ONNX artifact pinned to an immutable model revision. `model-lock.json` records the revision, source URL, license metadata, and exact SHA-256/size of every required artifact; an explicit acquisition script verifies a temporary download before atomically populating the ignored `apps/local-agent/vendor/all-MiniLM-L6-v2/artifacts/` cache. The release bundle includes those verified artifacts so installed inference is offline. If the SQLite vector candidate fails, this same locked model writes little-endian float32 embeddings to SQLite BLOBs and ranks by deterministic in-process cosine similarity.
- Commit only variable names and setup instructions. `jarvis doctor` exits 0 when ready, 2 for missing credentials, 3 for invalid configuration, and 4 for failed dependencies without printing values, fingerprints, lengths, or derivatives.
- No PC-control, browser, general or arbitrary file-editing, payment, scheduling, vehicle, third-party calling, Telegram voice-note, arbitrary-file, PWA, HUD, tray, hotword, or knock-detection capability belongs in this plan. The separately approved Obsidian design may amend this plan only with a dedicated internal memory adapter confined to one configured vault; it does not create a model-visible filesystem tool.

## Hard Execution and Release Block: Superseding Obsidian Plan Required

This plan predates the approved Obsidian memory scope and **must not be executed, resumed, marked complete, used to certify the full foundation, or used to tag/release `0.1.0`** until a superseding Obsidian implementation plan has been written, independently reviewed, and explicitly approved. That superseding plan must integrate exact work cards and dependencies for all of the following into the release path:

- versioned vault-observation contracts and cloud ingestion endpoints, including authenticated sequencing and idempotency;
- the root-confined local Obsidian adapter, durable write journal, reconciliation crawl, watcher recovery, current-document heads, and tombstones;
- local and cloud storage/migrations for observation provenance, authority decisions, correction/retraction state, cloud-ingest policy, and plaintext-export policy;
- safe Obsidian installation/vault setup, configuration, bootstrap, diagnostics, backup/restore, and operator runbooks;
- unit, integration, security, crash-recovery, offline-reconciliation, retrieval, policy, setup, and end-to-end acceptance tests; and
- release-manifest fields plus audit rules requiring passed Obsidian evidence before certification.

Until that approved plan exists and its work and evidence have passed, every checkbox and passing command below is evidence for the pre-Obsidian baseline only. The `REQUIRED_EVIDENCE` example, synthetic complete manifest, Task 10 audit, and legacy checklist are structurally incapable of certifying the current approved Jarvis scope on their own. This block may be removed only by the approved superseding implementation plan that supplies those missing contracts, work cards, tests, and release gates; editing this legacy plan or checking its boxes is not sufficient.

## File Structure

| Path | Responsibility |
|---|---|
| `packages/contracts/schemas/telegram-update-received.v1.json` | Accepted redacted Telegram update contract. |
| `packages/contracts/schemas/telegram-message-rejected.v1.json` | Minimal unsupported/unauthorized Telegram rejection contract. |
| `packages/contracts/schemas/sync-events-request.v1.json` | Signed local-agent event-page request. |
| `packages/contracts/schemas/sync-events-page.v1.json` | Snapshot-consistent contiguous event page response. |
| `packages/contracts/schemas/sync-events-ack.v1.json` | Durable local receipt acknowledgement request. |
| `packages/contracts/schemas/sync-events-ack-receipt.v1.json` | Idempotent cloud cursor receipt. |
| `packages/contracts/schemas/memory-distill-request.v1.json` | Signed excerpt submission to cloud distillation. |
| `packages/contracts/schemas/memory-distill-result.v1.json` | Source-linked proposed fact response. |
| `packages/contracts/schemas/memory-fact-project.v1.json` | Signed active-fact upload contract. |
| `apps/cloud-gateway/src/channels/telegram/*.ts` | Telegram authentication, parsing, deterministic rejection, turn creation, and delivery adapter. |
| `apps/cloud-gateway/src/sync/*.ts` | Device signature verification, event pages, cloud distillation, and D1 fact projection. |
| `apps/local-agent/jarvis_local/archive/*.py` | Archive database migration, append-only storage, content de-duplication, and repository API. |
| `apps/local-agent/jarvis_local/memory/*.py` | Fact store, promotion, retrieval, embedding strategy gate, distillation coordination, and backup. |
| `apps/local-agent/jarvis_local/sync/*.py` | Signed cloud client, durable replication, cursor handling, and fact projection upload. |
| `apps/local-agent/jarvis_local/transport/*.py` | SID-restricted Windows named-pipe protocol and server. |
| `apps/local-agent/jarvis_local/{cli,config,doctor,service}.py` | Local command surface, validated configuration, diagnostics, and background service. |
| `tests/acceptance/*` | Offline catch-up, fake Telegram, cross-channel recall, backup/restore, and release smoke harnesses. |
| `scripts/*.ps1` | Safe setup, compatibility selection, diagnostics, and release-audit commands. |

## Contract Definitions

```ts
// packages/contracts/src/telegram.ts
export type TelegramUpdateReceivedV1 = EventEnvelope & {
  eventType: "telegram.update.received";
  payload: { updateId: number; chatId: string; messageId: number; text: string };
};
export type TelegramMessageRejectedV1 = EventEnvelope & {
  eventType: "telegram.message.rejected";
  payload: { updateId: number; reason: "unsupported_content" | "unauthorized_sender" | "oversize" | "rate_limited" };
};
export interface TelegramClient {
  sendMessage(input: { chatId: string; text: string; replyToMessageId?: number }): Promise<{ providerMessageId: string }>;
}
```

```ts
// packages/contracts/src/sync.ts
export type SyncEventsPullBodyV1 = {
  schemaVersion: "1.0"; consumerId: string; afterSequence: number; pageSize: number; snapshotToken: string | null;
};
export type SequencedEventV1 = { eventSequence: number; envelope: EventEnvelope };
export type SyncEventsPageV1 = { snapshotId: string; snapshotToken: string; fromSequence: number; toSequence: number; events: SequencedEventV1[]; hasMore: boolean; };
export type SyncEventsAckBodyV1 = { schemaVersion: "1.0"; snapshotId: string; expectedCurrent: number; throughSequence: number; };
export type SyncAckReceiptV1 = { schemaVersion: "1.0"; currentSequence: number; replayed: boolean; };
export type MemoryDistillRequestV1 = {
  schemaVersion: "1.0"; requestId: string; principalId: string;
  excerpts: Array<{ eventId: string; eventSequence: number; text: string; contentHash: string }>; budgetChars: number; distillerVersion: string;
};
export type MemoryFactProjectV1 = {
  schemaVersion: "1.0"; projectionId: string; principalId: string; facts: ActiveFactV1[];
};
export type ActiveFactV1 = {
  factId: string; kind: "fact" | "preference" | "project_state" | "summary"; value: string;
  sensitivity: "personal" | "restricted"; confidence: number; sourceEventIds: string[];
  derivationChain: string[]; distillerVersion: string; createdAt: string; state: "active";
};
export type MemoryDistillResultV1 = { requestId: string; proposals: Array<Omit<ActiveFactV1, "state"> & { state: "proposed"; origin: "model" | "authenticated_first_person" | "deterministic_observation" }> };
export type ProjectionReceiptV1 = { projectionId: string; projectionVersion: number };
```

```python
# apps/local-agent/jarvis_local/contracts.py
class CloudGatewayClient(Protocol):
    def sync_events(self, request: SyncEventsPullBodyV1) -> SyncEventsPageV1: ...
    def ack_events(self, request: SyncEventsAckBodyV1) -> SyncAckReceiptV1: ...
    def request_distillation(self, request: MemoryDistillRequestV1) -> MemoryDistillResultV1: ...
    def project_facts(self, request: MemoryFactProjectV1) -> ProjectionReceiptV1: ...

class MemoryRetriever(Protocol):
    def search(self, query: str, *, principal_id: str, purpose: Literal["conversation", "diagnostic"], limit: int) -> list[MemorySearchResult]: ...

@dataclass(frozen=True)
class MemorySearchResult:
    fact_id: str
    value: str
    source_event_ids: list[str]
    score: float
```

### Task 1: Add Telegram and memory-sync contract fixtures

**Files:**
- Create: `apps/local-agent/pyproject.toml`
- Create: `apps/local-agent/jarvis_local/__init__.py`
- Create: `packages/contracts/schemas/telegram-update-received.v1.json`
- Create: `packages/contracts/schemas/telegram-message-rejected.v1.json`
- Create: `packages/contracts/schemas/sync-events-request.v1.json`
- Create: `packages/contracts/schemas/sync-events-page.v1.json`
- Create: `packages/contracts/schemas/sync-events-ack.v1.json`
- Create: `packages/contracts/schemas/sync-events-ack-receipt.v1.json`
- Create: `packages/contracts/schemas/memory-distill-request.v1.json`
- Create: `packages/contracts/schemas/memory-distill-result.v1.json`
- Create: `packages/contracts/schemas/memory-fact-project.v1.json`
- Create: `packages/contracts/src/telegram.ts`
- Create: `packages/contracts/src/sync.ts`
- Create: `packages/contracts/fixtures/telegram-message.v1.json`
- Create: `packages/contracts/fixtures/sync-page.v1.json`
- Create: `packages/contracts/test/telegram-and-sync-contracts.test.ts`
- Create: `apps/local-agent/jarvis_local/contracts.py`
- Create: `apps/local-agent/tests/test_contract_fixtures.py`

**Interfaces:**
- Consumes: foundation `EventEnvelopeV1`/`EventEnvelope`, `SignedRequestV1`, `canonicalize(value): Uint8Array`, and async `sha256Hex(value): Promise<Sha256Hex>`.
- Produces: `TelegramUpdateReceivedV1`, `TelegramMessageRejectedV1`, `SyncEventsPullBodyV1`, `SyncEventsPageV1`, `SyncEventsAckBodyV1`, `SyncAckReceiptV1`, `MemoryDistillRequestV1`, `MemoryDistillResultV1`, and `MemoryFactProjectV1` exported from `packages/contracts`.

- [ ] **Step 1: Write the failing contract fixture tests**

```ts
it("canonicalizes the shared Telegram fixture to the Python-approved hash", async () => {
  const fixture = loadFixture("telegram-message.v1.json");
  await expect(sha256Hex(canonicalize(fixture.event))).resolves.toBe(fixture.expectedCanonicalSha256);
  await expect(parseTelegramUpdateReceived(fixture.event)).resolves.toMatchObject({ payload: { text: "Remember café at 3pm" } });
});

it("rejects an unsupported major schema version", () => {
  expect(() => parseSyncEventsPullBody({ ...validSyncPull, schemaVersion: "2.0" })).toThrow("unsupported schema major");
});
```

```python
def test_typescript_fixture_canonical_bytes_match_python_hash() -> None:
    fixture = load_fixture("telegram-message.v1.json")
    assert canonical_sha256(fixture["event"]) == fixture["expectedCanonicalSha256"]
```

- [ ] **Step 2: Run contract tests to verify they fail**

Run: `pnpm --filter @jarvis/contracts test -- telegram-and-sync-contracts.test.ts && python -m pytest apps/local-agent/tests/test_contract_fixtures.py -q`

Expected: FAIL because the Telegram and sync schemas and fixture loaders do not exist.

- [ ] **Step 3: Implement schemas, typed exports, and fixed fixtures**

```ts
export async function parseTelegramUpdateReceived(value: unknown): Promise<TelegramUpdateReceivedV1> {
  const envelope = await validateEnvelope(value);
  if (envelope.schemaVersion !== "1.0" || envelope.eventType !== "telegram.update.received") throw new Error("invalid telegram update envelope");
  return envelope as TelegramUpdateReceivedV1;
}

export function parseSyncEventsPullBody(value: unknown): SyncEventsPullBodyV1 {
  const body = value as SyncEventsPullBodyV1;
  if (body.schemaVersion !== "1.0") throw new Error("unsupported schema major");
  if (!Number.isInteger(body.afterSequence) || body.afterSequence < 0 || !Number.isInteger(body.pageSize) || body.pageSize < 1 || body.pageSize > 500 || (body.snapshotToken !== null && body.snapshotToken.length === 0)) throw new Error("invalid sync pull body");
  return body;
}
```

- [ ] **Step 4: Run the shared contract tests to verify they pass**

Run: `pnpm --filter @jarvis/contracts test -- telegram-and-sync-contracts.test.ts && python -m pytest apps/local-agent/tests/test_contract_fixtures.py -q`

Expected: PASS with both runtimes producing the fixture's exact canonical SHA-256.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add packages/contracts apps/local-agent/pyproject.toml apps/local-agent/jarvis_local apps/local-agent/tests/test_contract_fixtures.py
git commit -m "feat(contracts): add telegram and memory sync schemas"
```

### Task 2: Implement authenticated Telegram text ingress and deterministic rejection

**Files:**
- Create: `apps/cloud-gateway/src/channels/telegram/telegram-webhook.ts`
- Create: `apps/cloud-gateway/src/channels/telegram/telegram-rejection.ts`
- Create: `apps/cloud-gateway/src/channels/telegram/telegram-types.ts`
- Modify: `apps/cloud-gateway/src/index.ts`
- Create: `apps/cloud-gateway/test/channels/telegram-webhook.test.ts`
- Modify: `apps/cloud-gateway/src/providers/fake-telegram-provider.ts`

**Interfaces:**
- Consumes: Task 1 contracts; foundation `EventRepository.append`, `PolicyService.authenticateTelegram`, `IdentityChallengeService`, `CapacityGuard`, bootstrap identity rows, and foundation `Redactor.redact(input: { text: string; channel: "telegram"; field: string })`.
- Produces: `handleTelegramWebhook(request: Request, deps: TelegramWebhookDependencies): Promise<Response>` and `AcceptedTelegramUpdate = { eventId: string; principalId: string; chatId: string; messageId: number; text: string }`.

- [ ] **Step 1: Write failing webhook tests for text-only acceptance and safe rejection**

```ts
it("persists one redacted text event for an active allowlisted user", async () => {
  const response = await handleTelegramWebhook(textUpdate("hello"), deps);
  expect(response.status).toBe(200);
  expect(deps.eventStore.events).toHaveLength(1);
  expect(deps.eventStore.events[0].eventType).toBe("telegram.update.received");
});

it("persists only minimal rejection fields for unsupported media", async () => {
  const response = await handleTelegramWebhook(photoUpdate(), deps);
  expect(response.status).toBe(200);
  expect(deps.eventStore.events[0].payload).toEqual({ updateId: 71, reason: "unsupported_content" });
  expect(JSON.stringify(deps.eventStore.events[0])).not.toMatch(/file_id|caption|photo|document/);
});

it("returns the same rejection for a duplicate update id", async () => {
  await handleTelegramWebhook(photoUpdate(), deps);
  const duplicate = await handleTelegramWebhook(photoUpdate(), deps);
  expect(await duplicate.text()).toBe("Jarvis accepts text messages only.");
  expect(deps.eventStore.events).toHaveLength(1);
});

it("uses a length-safe secret comparison and enforces 30 per minute and 200 per day", async () => {
  expect(await handleTelegramWebhook(requestWithSecret("x"), deps)).toMatchObject({ status: 401 });
  deps.limiter.accept("principal-1", 30, "minute");
  expect(await handleTelegramWebhook(textUpdate("31"), deps)).toMatchObject({ status: 200 });
  expect(deps.eventStore.events.at(-1)?.payload).toEqual({ updateId: 31, reason: "rate_limited" });
});

it("activates a pending Telegram identity only with its one-time neutral challenge", async () => {
  identities.state = "pending";
  await handleTelegramWebhook(textUpdate("/enroll 482913"), deps);
  expect(deps.identityChallenges.confirm).toHaveBeenCalledWith(expect.objectContaining({ challengeId: "challenge-telegram-1", observedChannelIdentityId: identities.identityId, response: "482913" }));
  expect(deps.conversation.handleTurn).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run webhook tests to verify they fail**

Run: `pnpm test:cloud -- channels/telegram-webhook.test.ts`

Expected: FAIL because `handleTelegramWebhook` is not exported.

- [ ] **Step 3: Implement header-before-body authentication, text parsing, and idempotent rejection**

```ts
export async function handleTelegramWebhook(request: Request, deps: TelegramWebhookDependencies): Promise<Response> {
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!timingSafeEqualUtf8(providedSecret, deps.config.telegramWebhookSecret)) return new Response("", { status: 401 });
  try { await deps.capacity.assertAcceptingNewTurn(); } catch { return new Response("Jarvis is temporarily unavailable.", { status: 503 }); }
  const update = TelegramUpdateSchema.parse(await request.json());
  const idempotencyKey = `telegram:${deps.config.botId}:${update.update_id}`;
  if (!isTextMessage(update)) return rejectUpdate(update.update_id, "unsupported_content", idempotencyKey, deps);
  if (utf8Length(update.message.text) > 32768) return rejectUpdate(update.update_id, "oversize", idempotencyKey, deps);
  const identity = await deps.policy.authenticateTelegram({ telegramUserId: String(update.message.from.id), webhookSecretValid: true });
  if (identity.identityState === "pending" && isEnrollmentCommand(update.message.text)) return confirmPendingTelegramIdentity(update, identity, idempotencyKey, deps);
  if (identity.identityState !== "active") return rejectUpdate(update.update_id, "unauthorized_sender", idempotencyKey, deps);
  if (!(await deps.limiter.tryAccept(identity.principalId, { perMinute: 30, perDay: 200 }))) return rejectUpdate(update.update_id, "rate_limited", idempotencyKey, deps);
  const redacted = await deps.redactor.redact({ text: update.message.text, channel: "telegram", field: "message.text" });
  if (!redacted.ok) return recordSafeRedactionFailure(update.update_id, idempotencyKey, deps);
  return acceptTextUpdate({ ...update, message: { ...update.message, text: redacted.text } }, identity.principalId, idempotencyKey, deps);
}

function timingSafeEqualUtf8(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  const width = Math.max(a.length, b.length); let diff = a.length ^ b.length;
  for (let index = 0; index < width; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}
```

`isEnrollmentCommand` accepts only the exact text form `/enroll <challenge>`. `confirmPendingTelegramIdentity` supplies only the provider-observed pending identity, challenge ID resolved from that pending identity, and one-time response to foundation `IdentityChallengeService.confirm`. It returns a neutral success/failure message, records no command text or channel identifier, never invokes the model, and cannot activate a different, expired, replayed, or device-uninitiated identity.

- [ ] **Step 4: Run focused tests to verify acceptance, duplication, and omission of media fields**

Run: `pnpm test:cloud -- channels/telegram-webhook.test.ts`

Expected: PASS, including fixed-work comparison for unequal secret lengths, no media identifiers in rejection events, and both configured rate limits.

- [ ] **Step 5: Commit the Telegram ingress boundary**

```bash
git add apps/cloud-gateway/src/channels/telegram apps/cloud-gateway/src/providers/fake-telegram-provider.ts apps/cloud-gateway/src/index.ts apps/cloud-gateway/test/channels/telegram-webhook.test.ts
git commit -m "feat(telegram): authenticate text-only webhook ingress"
```

### Task 3: Route Telegram turns through the shared conversation service and outbox

**Files:**
- Create: `apps/cloud-gateway/src/channels/telegram/telegram-message.ts`
- Create: `apps/cloud-gateway/src/channels/telegram/telegram-adapter.ts`
- Create: `apps/cloud-gateway/src/channels/telegram/telegram-call-command.ts`
- Create: `apps/cloud-gateway/test/channels/telegram-message.test.ts`
- Create: `apps/cloud-gateway/test/channels/telegram-adapter.test.ts`
- Create: `apps/cloud-gateway/test/channels/telegram-call-command.test.ts`
- Modify: `apps/cloud-gateway/src/channels/telegram/telegram-webhook.ts`

**Interfaces:**
- Consumes: Task 2 `AcceptedTelegramUpdate`; foundation `TelegramProvider`; calling-plan `ConversationService`, `OutboxDispatcher`, `OutboundCallCommand`, and `dispatchOutboundCall`.
- Produces: `handleAcceptedTelegramUpdate(input: AcceptedTelegramUpdate, deps: TelegramTurnDependencies): Promise<void>`, `TelegramDeliveryAdapter.deliver(item: TelegramOutboxItem): Promise<void>`, and `createTelegramCallCommand(input: AcceptedTelegramUpdate, purpose: string, deps: TelegramCallDependencies): Promise<OutboundCallCommand>`.

- [ ] **Step 1: Write failing turn-order, overload, delivery-retry, and `/call` tests**

```ts
it("creates an ordered Telegram session through the shared ConversationService", async () => {
  await handleAcceptedTelegramUpdate(accepted("what is next?"), deps);
  expect(deps.conversation.handleTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "telegram:chat-44", channel: "telegram" }));
});

it("queues a visible overload response when the single Telegram model slot is occupied", async () => {
  deps.concurrency.telegramActive = 1;
  await handleAcceptedTelegramUpdate(accepted("hello"), deps);
  expect(deps.conversation.stageSystemNotice).toHaveBeenCalledWith(expect.objectContaining({ noticeCode: "busy", idempotencyKey: "telegram-busy:44:900" }));
  expect(deps.outbox.dispatch).toHaveBeenCalledWith(stagedBusyOutboxId);
});

it("retries an idempotent Telegram delivery exactly three times", async () => {
  deps.client.sendMessage.mockRejectedValue(new Error("network"));
  await expect(deps.adapter.deliver(outboxItem)).rejects.toThrow("terminal delivery failure");
  expect(deps.client.sendMessage).toHaveBeenCalledTimes(3);
});

it("requires --confirm and uses one immutable command per Telegram update", async () => {
  await expect(handleAcceptedTelegramUpdate(accepted("/call check in"), deps)).rejects.toThrow("confirmation_required");
  await handleAcceptedTelegramUpdate(accepted("/call check in --confirm"), deps);
  expect(deps.dispatchOutboundCall).toHaveBeenCalledWith(expect.objectContaining({ issuedBy: "telegram_call_command", idempotencyKey: "telegram-call:44:900" }), expect.anything());
});
```

- [ ] **Step 2: Run turn and delivery tests to verify they fail**

Run: `pnpm test:cloud -- channels/telegram-message.test.ts channels/telegram-adapter.test.ts channels/telegram-call-command.test.ts`

Expected: FAIL because Telegram turn and adapter modules do not exist.

- [ ] **Step 3: Implement shared-turn routing and bounded delivery**

```ts
export async function handleAcceptedTelegramUpdate(input: AcceptedTelegramUpdate, deps: TelegramTurnDependencies): Promise<void> {
  const call = parseTelegramCall(input.text);
  if (call) return deps.dispatchOutboundCall(await createTelegramCallCommand(input, call.purpose, deps), deps.callDispatchDependencies);
  if (!deps.concurrency.tryAcquire("telegram", 1)) {
    const staged = await deps.conversation.stageSystemNotice({ principalId: input.principalId, sessionId: `telegram:${input.chatId}`, channel: "telegram", noticeCode: "busy", idempotencyKey: `telegram-busy:${input.chatId}:${input.messageId}`, payload: { chatId: input.chatId, replyToMessageId: input.messageId } });
    await deps.outbox.dispatch(staged.outboxId); return;
  }
  try {
    const controller = new AbortController();
    await deps.conversation.handleTurn({ principalId: input.principalId, sessionId: `telegram:${input.chatId}`, channel: "telegram", turnId: input.eventId as Ulid, text: input.text, signal: controller.signal, delivery: { kind: "outbox", idempotencyKey: `telegram-reply:${input.chatId}:${input.messageId}`, payload: { chatId: input.chatId, replyToMessageId: input.messageId } } });
  } finally { deps.concurrency.release("telegram", 1); }
}

export async function createTelegramCallCommand(input: AcceptedTelegramUpdate, purpose: string, deps: TelegramCallDependencies): Promise<OutboundCallCommand> {
  if (!input.text.endsWith(" --confirm")) throw new Error("confirmation_required");
  const destinationIdentityId = await deps.identities.verifiedPhoneIdentity(input.principalId);
  return { commandId: newUlid(deps.clock.now()), principalId: input.principalId, purposeCode: "user_requested", destinationIdentityId, urgency: "normal", authorizationExpiresAt: new Date(deps.clock.now().valueOf() + 300000).toISOString(), idempotencyKey: `telegram-call:${input.chatId}:${input.messageId}`, issuedBy: "telegram_call_command" };
}

export class TelegramDeliveryAdapter {
  async deliver(item: TelegramOutboxItem): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) try { await this.client.sendMessage(item); return; } catch (error) { if (attempt === 3) throw new TerminalDeliveryError(error); await this.backoff.sleep(attempt); }
  }
}
```

Register `TelegramDeliveryAdapter` as the `telegram` handler used by the shared `OutboxDispatcher`. It receives only leased, already-persisted outbox rows; it never creates an outbox identifier. Overload uses `ConversationService.stageSystemNotice` to atomically stage a fixed non-history notice and dispatches only the returned ID. The third failed attempt atomically records terminal failure through the shared store, while a provider acknowledgement commits staged model text as delivered conversational history and commits a system notice only as a delivery outcome.

- [ ] **Step 4: Run tests to verify ordered sessions and exactly three delivery attempts**

Run: `pnpm test:cloud -- channels/telegram-message.test.ts channels/telegram-adapter.test.ts channels/telegram-call-command.test.ts`

Expected: PASS with Telegram model concurrency capped at one and terminal delivery event coverage.

- [ ] **Step 5: Commit Telegram conversation delivery**

```bash
git add apps/cloud-gateway/src/channels/telegram apps/cloud-gateway/test/channels/telegram-message.test.ts apps/cloud-gateway/test/channels/telegram-adapter.test.ts apps/cloud-gateway/test/channels/telegram-call-command.test.ts
git commit -m "feat(telegram): route text turns through shared conversation outbox"
```

### Task 4: Add protected Windows configuration, device keys, and doctor

**Files:**
- Create: `apps/local-agent/jarvis_local/config.py`
- Create: `apps/local-agent/jarvis_local/doctor.py`
- Create: `apps/local-agent/jarvis_local/crypto/dpapi.py`
- Create: `apps/local-agent/jarvis_local/crypto/device_keys.py`
- Create: `apps/local-agent/jarvis_local/cli.py`
- Create: `apps/local-agent/tests/test_doctor.py`
- Create: `apps/local-agent/tests/crypto/test_device_keys.py`
- Create: `apps/local-agent/.env.example`
- Create: `apps/local-agent/requirements.in`, `apps/local-agent/requirements.lock`

**Interfaces:**
- Consumes: foundation device enrollment response `{ deviceId: string; principalId: string; publicKey: string }` and Windows CNG/DPAPI APIs.
- Produces: `JarvisLocalConfig.load(env: Mapping[str, str]) -> JarvisLocalConfig`, `DeviceKeyStore.load_or_create() -> Ed25519PrivateKey`, and `run_doctor(config: JarvisLocalConfig) -> DoctorReport`.

- [ ] **Step 1: Write failing diagnostic and key-storage tests**

```python
def test_doctor_reports_only_missing_identifiers_and_exit_two(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JARVIS_CLOUD_BASE_URL", raising=False)
    report = run_doctor(JarvisLocalConfig.from_environment())
    assert report.exit_code == 2
    assert report.lines == ["missing: JARVIS_CLOUD_BASE_URL"]

def test_fallback_private_key_is_dpapi_protected(tmp_path: Path) -> None:
    store = DeviceKeyStore(tmp_path / "device.key", FakeCng(supports_non_exportable=False), FakeDpapi())
    store.load_or_create()
    assert (tmp_path / "device.key").read_bytes().startswith(b"DPAPI:")
```

- [ ] **Step 2: Run local diagnostic tests to verify they fail**

Run: `python -m pytest apps/local-agent/tests/test_doctor.py apps/local-agent/tests/crypto/test_device_keys.py -q`

Expected: FAIL because `JarvisLocalConfig`, `run_doctor`, and `DeviceKeyStore` do not exist.

- [ ] **Step 3: Implement strict configuration and protected key storage**

```python
REQUIRED_CONFIG = ("JARVIS_CLOUD_BASE_URL", "JARVIS_DEVICE_ID", "JARVIS_PRINCIPAL_ID", "JARVIS_DEVICE_KEY_PATH", "JARVIS_ARCHIVE_PATH", "JARVIS_MEMORY_PATH")

def run_doctor(config: JarvisLocalConfig) -> DoctorReport:
    missing = [name for name in REQUIRED_CONFIG if not config.environment.get(name)]
    if missing: return DoctorReport(2, tuple(f"missing: {name}" for name in missing))
    if not config.is_valid(): return DoctorReport(3, ("invalid configuration",))
    if not dependencies_ready(): return DoctorReport(4, ("dependency check failed",))
    return DoctorReport(0, ("ready",))
```

Declare the initial runtime/test dependencies in `requirements.in` and generate `requirements.lock` for the reference Windows/Python runtime with exact versions and SHA-256 hashes. Task 7 updates both files when the pinned ONNX stack is selected; every clean installation uses `pip --require-hashes` against this lock.

- [ ] **Step 4: Run the diagnostics tests to verify the defined exit-code behavior**

Run: `python -m pytest apps/local-agent/tests/test_doctor.py apps/local-agent/tests/crypto/test_device_keys.py -q`

Expected: PASS, proving no configuration values or fingerprints appear in output.

- [ ] **Step 5: Commit protected local configuration**

```bash
git add apps/local-agent/pyproject.toml apps/local-agent/jarvis_local apps/local-agent/tests apps/local-agent/.env.example apps/local-agent/requirements.in apps/local-agent/requirements.lock
git commit -m "feat(local-agent): add protected configuration and doctor"
```

### Task 5: Implement signed event synchronization and durable cursor commits

**Files:**
- Modify: `apps/cloud-gateway/src/sync/sync-service.ts`
- Modify: `apps/cloud-gateway/test/sync/signed-request.test.ts`
- Modify: `apps/cloud-gateway/test/sync/sync-service.test.ts`
- Create: `apps/local-agent/jarvis_local/crypto/signed_request.py`
- Create: `apps/local-agent/jarvis_local/archive/__init__.py`
- Create: `apps/local-agent/jarvis_local/archive/database.py`
- Create: `apps/local-agent/jarvis_local/archive/migrations.py`
- Create: `apps/local-agent/jarvis_local/archive/migrations/0001_sync.sql`
- Create: `apps/local-agent/jarvis_local/archive/sync_sink.py`
- Create: `apps/local-agent/jarvis_local/sync/cloud_client.py`
- Create: `apps/local-agent/jarvis_local/sync/cursor_store.py`
- Create: `apps/local-agent/jarvis_local/sync/event_replicator.py`
- Create: `apps/local-agent/tests/sync/test_event_replicator.py`

**Interfaces:**
- Consumes: Task 1 sync contracts; foundation `DeviceRequestVerifier.verify(request: SignedRequestV1, method, path, rawBody, now)`, `SyncService.pull`, `SyncService.acknowledgeDurableReceipt`, and `EventRepository.readRange`.
- Produces: the HTTP contract around foundation sync plus local `ArchiveDatabase`, `SyncedEventSink`, `EventReplicator.sync_once() -> SyncProgress`, `CursorStore.advance_and_stage_ack(transaction, pending_ack)`, and `CursorStore.pending_ack() -> PendingSyncAck | None`. Migration `0001_sync.sql` creates `archive_event`, `sync_cursors`, and `pending_sync_acks` on one archive SQLite connection so page data, local cursor, and ACK intent commit in one transaction; Task 6 extends this database rather than creating a second one.

- [ ] **Step 1: Write failing replay, subject-binding, hash, and crash-boundary tests**

```python
def test_cursor_does_not_advance_when_process_crashes_before_transaction_commit(tmp_path: Path) -> None:
    sink = TransactionalMemorySink()
    replicator = EventReplicator(FakeCloud.one_page(), sink, CursorStore.in_memory(), crash_after_event_write=True)
    with pytest.raises(SimulatedCrash): replicator.sync_once()
    assert sink.count_events() == 0
    assert replicator.cursor("local-agent") == 0

def test_duplicate_page_is_idempotent_and_cursor_is_contiguous(tmp_path: Path) -> None:
    replicator = configured_replicator(tmp_path, pages=[page(1, 2), page(1, 2)])
    replicator.sync_once(); progress = replicator.sync_once()
    assert progress.highest_contiguous_sequence == 2
    assert replicator.sink.count_events() == 2

def test_restart_drains_a_durable_pending_ack_before_pulling_another_page(tmp_path: Path) -> None:
    cloud = FakeCloud(pages=[page(1, 2)], ack_mode="fail")
    replicator = configured_replicator(tmp_path, cloud=cloud)
    with pytest.raises(SyncAckPending): replicator.sync_once()
    assert replicator.sink.count_events() == 2
    assert replicator.cursor("local-agent") == 2
    assert replicator.cursors.pending_ack().through_sequence == 2

    cloud.ack_mode = "accept"
    restarted = configured_replicator(tmp_path, cloud=cloud)
    restarted.sync_once()
    assert restarted.cursors.pending_ack() is None
    assert cloud.cursor == 2
    assert cloud.pull_calls == 1
```

```ts
it("uses foundation verification atomically before reading a snapshot page", async () => {
  await expect(syncService.pull(replayedRequest, validBody, rawBody)).rejects.toThrow("replayed nonce");
  expect(deps.events.readRange).not.toHaveBeenCalled();
});

it("returns the stored cursor when an accepted ACK response is retried", async () => {
  await expect(syncService.acknowledgeDurableReceipt(firstSignedAck, ackBody, firstRawBody)).resolves.toEqual({ schemaVersion: "1.0", currentSequence: 2, replayed: false });
  await expect(syncService.acknowledgeDurableReceipt(retrySignedAckWithFreshNonce, ackBody, retryRawBody)).resolves.toEqual({ schemaVersion: "1.0", currentSequence: 2, replayed: true });
});
```

- [ ] **Step 2: Run sync tests to verify they fail**

Run: `pnpm test:cloud -- sync/signed-request.test.ts sync/sync-service.test.ts && python -m pytest apps/local-agent/tests/sync/test_event_replicator.py -q`

Expected: FAIL because the snapshot acknowledgement extension, durable pending-ACK state, and local replicator modules do not exist.

- [ ] **Step 3: Implement verification and one-transaction local page application**

```python
def apply_page(self, page: SyncEventsPageV1) -> SyncProgress:
    previous_sequence = self.cursors.read("local-agent")
    self._verify_contiguous(page)
    pending = PendingSyncAck(snapshot_id=page.snapshot_id, expected_current=previous_sequence, through_sequence=page.to_sequence)
    with self.sink.transaction() as transaction:
        for sequenced in page.events:
            verify_event_hash(sequenced.envelope)
            self.sink.insert_event_if_absent(sequenced.event_sequence, sequenced.envelope)
        self.cursors.advance_and_stage_ack(transaction, "local-agent", page.to_sequence, pending)
    self._drain_pending_ack()
    return SyncProgress(page.to_sequence, page.snapshot_id)

def sync_once(self) -> SyncProgress:
    self._drain_pending_ack()  # Never pull a later page while cloud receipt lags.
    return self.apply_page(self.cloud.pull_events(after_sequence=self.cursors.read("local-agent")))

def _drain_pending_ack(self) -> None:
    pending = self.cursors.pending_ack()
    if pending is None: return
    for delay_seconds in (0, 1, 2):
        try:
            receipt = self.cloud.ack_events(pending.to_body())
            if receipt.current_sequence != pending.through_sequence: raise SyncProtocolError("ack_cursor_mismatch")
            self.cursors.clear_pending_ack_if_matches(pending)
            return
        except TransientCloudError:
            self.clock.sleep(min(delay_seconds, 30))
    raise SyncAckPending(pending.through_sequence)
```

```ts
async pull(request: SignedRequestV1, body: SyncEventsPullBodyV1, rawBody: Uint8Array): Promise<SyncEventsPageV1> {
  const binding = await this.verifier.verify(request, "POST", "/sync/pull", rawBody, this.clock.now());
  if (body.consumerId !== `device:${binding.deviceId}`) throw new Error("consumer_binding_invalid");
  return this.snapshots.read(binding.principalId, body.afterSequence, body.pageSize, body.snapshotToken);
}
async acknowledgeDurableReceipt(request: SignedRequestV1, body: SyncEventsAckBodyV1, rawBody: Uint8Array): Promise<SyncAckReceiptV1> {
  const binding = await this.verifier.verify(request, "POST", "/sync/ack", rawBody, this.clock.now());
  await this.snapshots.assertAckBoundary(binding.principalId, body.snapshotId, body.expectedCurrent, body.throughSequence);
  const current = await this.cursors.read(`device:${binding.deviceId}`);
  if (current === body.throughSequence) return { schemaVersion: "1.0", currentSequence: current, replayed: true };
  await this.cursors.advanceContiguous(`device:${binding.deviceId}`, body.expectedCurrent, body.throughSequence);
  return { schemaVersion: "1.0", currentSequence: body.throughSequence, replayed: false };
}
```

`pending_sync_acks` has a single row per consumer containing `snapshot_id`, `expected_current`, and `through_sequence`. `advance_and_stage_ack` uses the same SQLite connection and active transaction as archive inserts, so it is impossible to commit a local cursor without a recoverable cloud-ACK intent. Startup and every `sync_once` drain that row before pulling. Each attempt uses a newly signed nonce but the same semantic ACK body; an accepted response lost in transit is safe because the cloud returns the current cursor for a duplicate body. Three transient attempts use exponential backoff capped at 30 seconds, then expose sync lag and stop without pulling a new page. Clearing the pending row is its own atomic compare-and-delete after the receipt cursor is verified.

`ArchiveDatabase` owns the single SQLite connection, enables foreign keys, applies numbered migrations under an exclusive migration lock, and hands the same active transaction object to `SyncedEventSink` and `CursorStore`. The minimal `archive_event` table stores canonical post-redaction envelope JSON, event sequence, event ID, content hash, and timestamps with unique constraints; `SyncedEventSink.insert_event_if_absent` verifies equality on duplicates and rejects a conflicting sequence or event ID. Task 6 adds the permanent update/delete triggers and content tables through the next immutable migration.

- [ ] **Step 4: Run sync tests to verify signatures, duplicates, and crash recovery**

Run: `pnpm test:cloud -- sync/signed-request.test.ts sync/sync-service.test.ts && python -m pytest apps/local-agent/tests/sync/test_event_replicator.py -q`

Expected: PASS; foundation verifier consumes nonces atomically, snapshot pages carry stable continuation tokens and event sequences, duplicate ACKs return the stored cursor, and restart recovery drains a transactionally staged ACK before any later page is pulled.

- [ ] **Step 5: Commit signed synchronization**

```bash
git add apps/cloud-gateway/src/sync/sync-service.ts apps/cloud-gateway/test/sync/signed-request.test.ts apps/cloud-gateway/test/sync/sync-service.test.ts apps/local-agent/jarvis_local/crypto apps/local-agent/jarvis_local/archive apps/local-agent/jarvis_local/sync apps/local-agent/tests/sync
git commit -m "feat(sync): add signed contiguous event replication"
```

### Task 6: Complete the append-only content-addressed raw archive

**Files:**
- Modify: `apps/local-agent/jarvis_local/archive/database.py`
- Create: `apps/local-agent/jarvis_local/archive/migrations/0002_content_archive.sql`
- Create: `apps/local-agent/jarvis_local/archive/append_only.py`
- Create: `apps/local-agent/jarvis_local/archive/content_store.py`
- Create: `apps/local-agent/jarvis_local/archive/archive_repository.py`
- Create: `apps/local-agent/tests/archive/test_append_only.py`
- Create: `apps/local-agent/tests/archive/test_content_store.py`

**Interfaces:**
- Consumes: Task 5 `ArchiveDatabase`, `SyncedEventSink`, `EventReplicator`, and foundation redacted `EventEnvelope` events.
- Produces: `ArchiveRepository.insert_event_if_absent(event) -> bool`, `ArchiveRepository.store_document(content: str, observation: ContentObservation) -> str`, `ArchiveRepository.events_after(sequence: int) -> Iterable[ArchivedEvent]`.

- [ ] **Step 1: Write failing immutable-storage and duplicate-content tests**

```python
def test_sqlite_triggers_reject_update_and_delete(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.insert_event_if_absent(event(sequence=1, text="redacted text"))
    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("DELETE FROM archive_event WHERE event_sequence = 1")
    with pytest.raises(sqlite3.IntegrityError, match="append_only_violation"):
        repo.connection.execute("UPDATE content_blob SET canonical_text = 'changed'")

def test_repeated_document_uses_one_blob_and_two_observations(tmp_path: Path) -> None:
    repo = ArchiveRepository.open(tmp_path / "archive.sqlite3")
    repo.store_document("same", observation("01a")); repo.store_document("same", observation("01b"))
    assert repo.count_content_blobs() == 1
    assert repo.count_content_seen() == 2
```

- [ ] **Step 2: Run archive tests to verify they fail**

Run: `python -m pytest apps/local-agent/tests/archive/test_append_only.py apps/local-agent/tests/archive/test_content_store.py -q`

Expected: FAIL because `ArchiveRepository`, content tables, and permanent append-only triggers do not exist yet.

- [ ] **Step 3: Implement insert-only schema and content addressing**

```sql
CREATE TABLE content_blob (content_hash TEXT PRIMARY KEY, canonical_text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE content_seen (observation_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL REFERENCES content_blob(content_hash), source_event_id TEXT NOT NULL, seen_at TEXT NOT NULL);
CREATE TRIGGER archive_event_no_update BEFORE UPDATE ON archive_event BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;
CREATE TRIGGER archive_event_no_delete BEFORE DELETE ON archive_event BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;
CREATE TRIGGER content_blob_no_update BEFORE UPDATE ON content_blob BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;
CREATE TRIGGER content_blob_no_delete BEFORE DELETE ON content_blob BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;
CREATE TRIGGER content_seen_no_update BEFORE UPDATE ON content_seen BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;
CREATE TRIGGER content_seen_no_delete BEFORE DELETE ON content_seen BEGIN SELECT RAISE(ABORT, 'append_only_violation'); END;
```

```python
def store_document(self, content: str, observation: ContentObservation) -> str:
    content_hash = canonical_sha256({"text": normalize_nfc(content)})
    self.connection.execute("INSERT OR IGNORE INTO content_blob VALUES (?, ?, ?)", (content_hash, normalize_nfc(content), observation.seen_at))
    self.connection.execute("INSERT INTO content_seen VALUES (?, ?, ?, ?)", (observation.id, content_hash, observation.source_event_id, observation.seen_at))
    return content_hash
```

- [ ] **Step 4: Run archive tests to verify immutable behavior**

Run: `python -m pytest apps/local-agent/tests/archive/test_append_only.py apps/local-agent/tests/archive/test_content_store.py -q`

Expected: PASS; updates/deletes fail in SQLite and duplicate document content stores one blob with two observations.

- [ ] **Step 5: Commit immutable archive storage**

```bash
git add apps/local-agent/jarvis_local/archive apps/local-agent/tests/archive
git commit -m "feat(archive): add append-only content-addressed storage"
```

### Task 7: Select and pin local semantic retrieval with an offline compatibility gate

**Files:**
- Create: `apps/local-agent/jarvis_local/memory/embeddings.py`
- Create: `apps/local-agent/jarvis_local/memory/vector_index.py`
- Create: `apps/local-agent/jarvis_local/memory/compatibility_gate.py`
- Create: `apps/local-agent/tests/memory/test_embedding_compatibility.py`
- Create: `apps/local-agent/tests/memory/fixtures/semantic-fixtures.json`
- Create: `apps/local-agent/vendor/all-MiniLM-L6-v2/model-lock.json`
- Create: `scripts/fetch-embedding-model.ps1`
- Create: `scripts/run-embedding-compatibility.ps1`
- Create: `docs/decisions/0004-local-semantic-search.md`
- Modify: `apps/local-agent/pyproject.toml`
- Modify: `apps/local-agent/requirements.in`
- Modify: `apps/local-agent/requirements.lock`

**Interfaces:**
- Consumes: Task 6 canonical archive text and `ArchiveRepository.events_after`.
- Produces: `run_compatibility_gate(workdir: Path) -> CompatibilityReport`, `EmbeddingProvider.embed(texts: Sequence[str]) -> list[list[float]]`, and `VectorIndex.search(vector: Sequence[float], limit: int) -> list[VectorMatch]`.

- [ ] **Step 1: Write failing deterministic install/index/query/rebuild/offline tests**

```python
def test_gate_selects_blob_cosine_when_vector_extension_fails(tmp_path: Path) -> None:
    report = run_compatibility_gate(tmp_path, candidates=[FailingSqliteVectorCandidate(), BlobCosineCandidate(FixedEmbedder())])
    assert report.selected_strategy == "sqlite_blob_cosine"
    assert report.offline is True
    assert report.query_result_ids == ["event-1", "event-2"]
    assert report.rebuild_result_ids == ["event-1", "event-2"]

def test_gate_rejects_any_candidate_that_attempts_network(tmp_path: Path) -> None:
    with pytest.raises(CompatibilityFailure, match="offline"):
        run_compatibility_gate(tmp_path, candidates=[NetworkAttemptCandidate()])

def test_artifact_acquisition_rejects_hash_mismatch_without_populating_cache(tmp_path: Path) -> None:
    result = run_fetch_script(lock=locked_fixture(), source=fixture_server(tamper_one_file=True), destination=tmp_path / "artifacts")
    assert result.exit_code != 0
    assert not (tmp_path / "artifacts").exists()
```

- [ ] **Step 2: Run semantic gate tests to verify they fail**

Run: `python -m pytest apps/local-agent/tests/memory/test_embedding_compatibility.py -q`

Expected: FAIL because the locked acquisition script, compatibility gate, and candidate implementations do not exist.

- [ ] **Step 3: Implement ordered candidates and mandatory BLOB fallback**

```python
def run_compatibility_gate(workdir: Path, candidates: Sequence[SemanticCandidate] = default_candidates()) -> CompatibilityReport:
    for candidate in candidates:
        report = candidate.verify_install_index_query_rebuild_offline(workdir)
        if report.passed: return report
    fallback = BlobCosineCandidate(AllMiniLmL6V2OnnxEmbedder(model_dir=Path("apps/local-agent/vendor/all-MiniLM-L6-v2/artifacts"), lock_file=Path("apps/local-agent/vendor/all-MiniLM-L6-v2/model-lock.json")))
    report = fallback.verify_install_index_query_rebuild_offline(workdir)
    if not report.passed: raise CompatibilityFailure("no local semantic strategy passed deterministic offline checks")
    return report
```

`fetch-embedding-model.ps1` accepts only the checked-in lock file and an explicit destination, downloads each immutable-revision URL into a fresh temporary directory, enforces declared byte size and SHA-256, validates that every required file and no undeclared executable exists, then atomically renames the verified directory into the ignored artifact cache. A hash, size, TLS, license, or file-set failure removes only that fresh temporary directory and leaves any previously verified cache untouched. It never follows a mutable branch name. Tests use a local fixture server; the real network acquisition is a named setup/release step, not a unit-test dependency.

```python
def cosine_search(query: Sequence[float], rows: Iterable[tuple[str, bytes]], limit: int) -> list[VectorMatch]:
    return sorted((VectorMatch(event_id, cosine(query, decode_f32(blob))) for event_id, blob in rows), key=lambda item: (-item.score, item.event_id))[:limit]
```

- [ ] **Step 4: Run semantic gate tests and record selected artifact hashes**

Run: `python -m pytest apps/local-agent/tests/memory/test_embedding_compatibility.py -q; powershell -ExecutionPolicy Bypass -File scripts/fetch-embedding-model.ps1 -LockFile apps/local-agent/vendor/all-MiniLM-L6-v2/model-lock.json -Destination apps/local-agent/vendor/all-MiniLM-L6-v2/artifacts; powershell -ExecutionPolicy Bypass -File scripts/run-embedding-compatibility.ps1 -Offline`

Expected: PASS; report records runtime/artifact SHA-256 values, fixed ranking, successful rebuild, and no network use.

- [ ] **Step 5: Commit pinned semantic compatibility decision**

```bash
git add apps/local-agent/jarvis_local/memory apps/local-agent/tests/memory apps/local-agent/pyproject.toml apps/local-agent/requirements.in apps/local-agent/requirements.lock apps/local-agent/vendor/all-MiniLM-L6-v2/model-lock.json scripts/fetch-embedding-model.ps1 scripts/run-embedding-compatibility.ps1 docs/decisions/0004-local-semantic-search.md
git commit -m "feat(memory): pin offline semantic retrieval strategy"
```

### Task 8: Implement fact provenance, promotion, local retrieval, and cloud distillation/projection

**Files:**
- Create: `apps/local-agent/jarvis_local/memory/database.py`
- Create: `apps/local-agent/jarvis_local/memory/facts.py`
- Create: `apps/local-agent/jarvis_local/memory/promotion.py`
- Create: `apps/local-agent/jarvis_local/memory/retrieval.py`
- Create: `apps/local-agent/jarvis_local/memory/distillation.py`
- Create: `apps/local-agent/jarvis_local/sync/projection_uploader.py`
- Create: `apps/cloud-gateway/src/sync/memory-distill.ts`
- Create: `apps/cloud-gateway/src/sync/memory-projection.ts`
- Modify: `apps/cloud-gateway/src/conversation/context-retriever.ts`
- Create: `apps/cloud-gateway/src/providers/deepseek-provider.ts`
- Modify: `apps/cloud-gateway/src/providers/provider-types.ts`
- Modify: `apps/cloud-gateway/src/providers/fake-model-provider.ts`
- Create: `apps/cloud-gateway/test/sync/memory-distill.test.ts`
- Create: `apps/cloud-gateway/test/sync/memory-projection.test.ts`
- Create: `apps/local-agent/tests/memory/test_fact_promotion.py`
- Create: `apps/local-agent/tests/memory/test_retrieval.py`
- Create: `apps/local-agent/tests/memory/test_distillation.py`

**Interfaces:**
- Consumes: Tasks 1, 5, 6, and 7; foundation `ModelProvider.streamText`/`completeJson`, `TransactionRunner.batch`, device verification, redaction, and event provenance.
- Produces: `FactRepository.record_proposal(proposal) -> Fact`, `PromotionEngine.promote(fact) -> Fact`, `LocalMemoryRetriever.search(...) -> list[MemorySearchResult]`, `DistillationCoordinator.run_once() -> DistillationProgress`, cloud `handleMemoryFactProjection(request, deps) -> ProjectionReceiptV1`, and an extension to calling's `D1ContextRetriever` that combines recent committed turns with the latest active fact projection under the same principal/sensitivity/token checks.

- [ ] **Step 1: Write failing promotion, provenance, retrieval, and atomic projection tests**

```python
def test_model_inference_remains_proposed_but_authenticated_first_person_fact_is_active(repo: FactRepository) -> None:
    inferred = repo.record_proposal(proposal(origin="model", text="Sid likes tea", source_ids=["01a"]))
    stated = repo.record_proposal(proposal(origin="authenticated_first_person", text="I like coffee", source_ids=["01b"]))
    assert PromotionEngine().promote(inferred).state == "proposed"
    assert PromotionEngine().promote(stated).state == "active"

def test_retrieval_requires_principal_and_authenticated_purpose(memory: LocalMemoryRetriever) -> None:
    assert memory.search("coffee", principal_id="principal-a", purpose="conversation", limit=5)[0].source_event_ids == ["01b"]
    assert memory.search("coffee", principal_id="principal-b", purpose="conversation", limit=5) == []
```

```ts
it("does not publish a partial projection when one source provenance check fails", async () => {
  await expect(handleMemoryFactProjection(requestWithBadSource, deps)).rejects.toThrow("source provenance invalid");
  expect(deps.projections.currentVersion()).toBe(7);
});

it("calls DeepSeek only after signed excerpts and source hashes verify", async () => {
  await handleMemoryDistill(validRequest, deps);
  expect(deps.model.completeJson).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: "high", purpose: "memory_distillation" }));
});

it("rejects model JSON with active state or a tool request before storing a proposal", async () => {
  deps.model.completeJson.mockResolvedValue({ proposals: [{ state: "active", tool: "call", value: "x" }] });
  await expect(handleMemoryDistill(validRequest, deps)).rejects.toThrow("invalid_distill_model_output");
  expect(deps.proposals.count()).toBe(0);
});

it("returns an active Telegram-derived fact to an authenticated voice turn through the shared retriever", async () => {
  await handleMemoryFactProjection(activeTelegramFactRequest, deps);
  await expect(deps.contextRetriever.retrieve({ principalId: "principal-a", channel: "voice", purpose: "conversation", query: "coffee", maxTokens: 500 })).resolves.toEqual([
    expect.objectContaining({ sourceEventId: activeTelegramFactRequest.facts[0].sourceEventIds[0], text: "I like coffee" }),
  ]);
});
```

- [ ] **Step 2: Run fact, retrieval, distillation, and projection tests to verify they fail**

Run: `python -m pytest apps/local-agent/tests/memory/test_fact_promotion.py apps/local-agent/tests/memory/test_retrieval.py apps/local-agent/tests/memory/test_distillation.py -q && pnpm test:cloud -- sync/memory-distill.test.ts sync/memory-projection.test.ts`

Expected: FAIL because fact storage, promotion, retrieval, distillation, and projection handlers do not exist.

- [ ] **Step 3: Implement deterministic promotion, bounded source-linked retrieval, and all-or-nothing projection**

```python
def promote(self, fact: Fact) -> Fact:
    if fact.origin in {"authenticated_first_person", "deterministic_observation"}:
        return self.repository.transition(fact.fact_id, "active")
    return fact

def search(self, query: str, *, principal_id: str, purpose: Literal["conversation", "diagnostic"], limit: int) -> list[MemorySearchResult]:
    rows = self.repository.authorized_candidates(principal_id, purpose)
    return rank_fts_then_semantic(rows, query, limit)
```

```ts
function parseDistillModelOutput(raw: unknown): MemoryDistillResultV1 {
  const value = raw as MemoryDistillResultV1;
  if (!Array.isArray(value.proposals) || value.proposals.some((proposal) => proposal.state !== "proposed" || proposal.origin !== "model" || !Array.isArray(proposal.sourceEventIds))) throw new Error("invalid_distill_model_output");
  return value;
}

export async function handleMemoryFactProjection(request: MemoryFactProjectV1, deps: ProjectionDependencies): Promise<ProjectionReceiptV1> {
  await deps.verifier.verify(deps.signedRequest, "POST", "/sync/memory/project", deps.rawBody, deps.clock.now());
  await deps.provenance.verifyAll(request.principalId, request.facts);
  return deps.projections.publishAtomically(request, deps.transactionRunner);
}
```

`DeepSeekProvider` implements the foundation `ModelProvider` exactly against `https://api.deepseek.com`: the default model is the currently supported `deepseek-v4-pro`, verified through authenticated `GET /models` during operator readiness. `streamText` uses Chat Completions streaming for voice and Telegram, mapping `none` to thinking disabled and `low`/`high`/`max` to the API's current thinking-effort values; live voice defaults to `low`. `completeJson` disables tools, uses `high`, and validates one bounded JSON response for memory distillation. Configuration supplies model name, base URL, reasoning effort, timeouts, and budgets, but startup fails closed when the configured model is absent; no business rule uses retired `deepseek-chat` or `deepseek-reasoner` aliases. Both methods exclude credentials and third-party data through the shared redaction/classification boundary, enforce timeouts, classify provider failures, and never log raw prompts or responses. Implementation follows the official [DeepSeek model listing](https://api-docs.deepseek.com/api/list-models), [current API quick start](https://api-docs.deepseek.com/), and [model/pricing matrix](https://api-docs.deepseek.com/quick_start/pricing/). `ProjectionRepository.publishAtomically` prepares the new projection-version rows and its outbox event and submits them through one D1 `TransactionRunner.batch()`.

- [ ] **Step 4: Run tests to verify non-self-promotion and atomic cloud projection**

Run: `python -m pytest apps/local-agent/tests/memory/test_fact_promotion.py apps/local-agent/tests/memory/test_retrieval.py apps/local-agent/tests/memory/test_distillation.py -q && pnpm test:cloud -- sync/memory-distill.test.ts sync/memory-projection.test.ts`

Expected: PASS; only authenticated/deterministic facts become active, every result carries source IDs, and invalid projection requests leave the previous version unchanged.

- [ ] **Step 5: Commit two-tier memory and cloud-mediated distillation**

```bash
git add apps/local-agent/jarvis_local/memory apps/local-agent/jarvis_local/sync/projection_uploader.py apps/local-agent/tests/memory apps/cloud-gateway/src/sync apps/cloud-gateway/src/providers apps/cloud-gateway/test/sync
git commit -m "feat(memory): add provenance-backed distillation and projection"
```

### Task 9: Add Windows named-pipe service, offline catch-up, and encrypted backup/restore

**Files:**
- Create: `apps/local-agent/jarvis_local/transport/cli_protocol.py`
- Create: `apps/local-agent/jarvis_local/transport/named_pipe.py`
- Create: `apps/local-agent/jarvis_local/service.py`
- Create: `apps/local-agent/jarvis_local/memory/backup.py`
- Create: `apps/cloud-gateway/src/http/local-command-routes.ts`
- Create: `apps/cloud-gateway/test/http/local-command-routes.test.ts`
- Modify: `apps/cloud-gateway/src/index.ts`
- Create: `apps/local-agent/tests/transport/test_named_pipe_policy.py`
- Create: `apps/local-agent/tests/memory/test_backup_restore.py`
- Create: `tests/acceptance/local-agent-offline-catchup.py`
- Create: `tests/acceptance/memory-sync-and-recall.py`

**Interfaces:**
- Consumes: Tasks 4, 5, 6, 7, and 8; Windows SID/session APIs; foundation `DeviceRequestVerifier`; calling `dispatchOutboundCall`; `EventReplicator.sync_once`; `ArchiveRepository`; `LocalMemoryRetriever`.
- Produces: `NamedPipeServer.serve() -> None`, `LocalAgentService.handle(command: CliCommand) -> CliResponse`, authenticated cloud `handleLocalCallCommand`, `BackupService.create(output: Path) -> BackupManifestV1`, and `BackupService.restore(input: Path) -> int`.

- [ ] **Step 1: Write failing local-session, backup integrity, and offline-catch-up tests**

```python
def test_remote_desktop_and_redirected_input_cannot_issue_effectful_command() -> None:
    for evidence in [session(remote_desktop=True), session(stdin_redirected=True), session(is_service=True)]:
        response = LocalAgentService(fake_dependencies()).handle(CliCommand("call-me", {"confirm": True}, evidence))
        assert response.code == "interactive_local_session_required"

def test_restore_rejects_hash_mismatch_without_replacing_archive(tmp_path: Path) -> None:
    backup = configured_backup(tmp_path); manifest = backup.create(tmp_path / "backup")
    (tmp_path / "backup" / manifest.files[0].name).write_bytes(b"tampered")
    with pytest.raises(BackupIntegrityError): backup.restore(tmp_path / "backup")
    assert backup.archive.last_sequence() == 9

def test_restore_holds_service_lock_and_uses_authenticated_encryption(tmp_path: Path) -> None:
    backup = configured_backup(tmp_path)
    manifest = backup.create(tmp_path / "backup")
    assert manifest.encryption == "AES-256-GCM"
    assert manifest.key_protection == "DPAPI"
    assert backup.service_lock.was_held_during("restore")
```

```ts
it("rejects a forged or non-local-session call command before policy evaluation", async () => {
  await expect(handleLocalCallCommand(forgedRequest, deps)).rejects.toThrow("device_signature_invalid");
  expect(deps.policy.requests).toHaveLength(0);
  expect(deps.twilio.requests).toHaveLength(0);
});
```

```python
def test_offline_thousand_event_catch_up_is_contiguous_and_rebuildable() -> None:
    result = run_offline_catchup(event_count=1000, offline_hours=24)
    assert result.sequence_contiguous and result.hashes_verified and result.indexes_rebuilt
    assert result.elapsed_seconds <= 300
```

- [ ] **Step 2: Run Windows-boundary, backup, and offline tests to verify they fail**

Run: `python -m pytest apps/local-agent/tests/transport/test_named_pipe_policy.py apps/local-agent/tests/memory/test_backup_restore.py tests/acceptance/local-agent-offline-catchup.py -q && pnpm test:cloud -- http/local-command-routes.test.ts`

Expected: FAIL because the named-pipe service, backup service, and acceptance harness do not exist.

- [ ] **Step 3: Implement SID ACL enforcement and staged verified restore**

```python
def handle(self, command: CliCommand) -> CliResponse:
    if command.name in {"call-me"} and not command.session.is_interactive_local_console():
        return CliResponse.error("interactive_local_session_required")
    if command.name == "call-me":
        if command.arguments.get("confirm") is not True: return CliResponse.error("confirmation_required")
        signed = self.command_signer.sign_outbound_call(command, command.session)
        return CliResponse.ok(self.cloud.dispatch_local_cli_call(signed))
    if command.name == "sync": return CliResponse.ok(self.replicator.sync_until_caught_up())
    if command.name == "archive-search": return CliResponse.ok(self.archive_search(command.arguments))
    return CliResponse.error("unsupported_command")

def restore(self, source: Path) -> int:
    with self.service_lock.exclusive(), self.archive.connection:
        manifest = self._read_and_verify_manifest(source)
        stage = self._decrypt_aes_256_gcm_and_verify_to_staging(source, manifest, self.dpapi.unwrap(manifest.wrapped_key))
        self._validate_sqlite(stage); self._atomic_replace(stage)
        self.rebuild_derived_indexes(); return manifest.last_committed_sequence
```

`handleLocalCallCommand` reads the exact raw body, verifies the enrolled-device signature and five-minute nonce through foundation `DeviceRequestVerifier`, validates the signed local-session evidence and `--confirm` intent schema, checks that the command principal matches the device principal, then passes the canonical `OutboundCallCommand` to calling's `dispatchOutboundCall`. It never accepts destination identifiers, purpose, or confirmation from model output.

- [ ] **Step 4: Run local boundary and recovery tests to verify safety and continuity**

Run: `python -m pytest apps/local-agent/tests/transport/test_named_pipe_policy.py apps/local-agent/tests/memory/test_backup_restore.py tests/acceptance/local-agent-offline-catchup.py tests/acceptance/memory-sync-and-recall.py -q && pnpm test:cloud -- http/local-command-routes.test.ts`

Expected: PASS; untrusted sessions are denied, tampered backups do not replace data, and 1,000-event catch-up completes with contiguous verified hashes and rebuilt indexes.

- [ ] **Step 5: Commit local service and recoverability**

```bash
git add apps/local-agent/jarvis_local/transport apps/local-agent/jarvis_local/service.py apps/local-agent/jarvis_local/memory/backup.py apps/local-agent/tests/transport apps/local-agent/tests/memory/test_backup_restore.py apps/cloud-gateway/src/http/local-command-routes.ts apps/cloud-gateway/src/index.ts apps/cloud-gateway/test/http/local-command-routes.test.ts tests/acceptance/local-agent-offline-catchup.py tests/acceptance/memory-sync-and-recall.py
git commit -m "feat(local-agent): add named-pipe service and recoverable archive"
```

### Task 10: Create deployment runbooks, credentialed smoke tests, and release-audit evidence

**Files:**
- Create: `scripts/provision-cloud-resources.ps1`
- Create: `scripts/configure-cloud-secrets.ps1`
- Create: `scripts/apply-d1-migrations.ps1`
- Create: `scripts/deploy-cloud.ps1`
- Create: `scripts/rollback-cloud.ps1`
- Create: `scripts/configure-twilio.ps1`
- Create: `scripts/configure-telegram-webhook.ps1`
- Create: `scripts/bootstrap-local-agent.ps1`
- Create: `scripts/install-local-agent.ps1`
- Create: `scripts/doctor.ps1`
- Create: `scripts/verify-clean-setup.ps1`
- Create: `scripts/create-release-evidence.ps1`
- Create: `scripts/release-audit.ps1`
- Create: `tests/acceptance/telegram-fake-provider.test.ts`
- Create: `tests/acceptance/release/smoke-telegram-live.py`
- Create: `tests/acceptance/release/smoke-memory-recall.py`
- Create: `tests/acceptance/release/backup-restore.py`
- Create: `tests/acceptance/release/test_deployment_scripts.py`
- Create: `tests/acceptance/release/fixtures/complete-passed-manifest.json`
- Create: `docs/deployment/windows-local-agent.md`
- Create: `docs/deployment/cloudflare.md`
- Create: `docs/deployment/twilio.md`
- Create: `docs/deployment/telegram.md`
- Create: `docs/runbooks/credential-rotation.md`
- Create: `docs/runbooks/release-0.1.0.md`
- Create: `docs/release-evidence/0.1.0/.gitkeep`
- Modify: `README.md`
- Modify: `REQUIREMENTS.md`
- Modify: `TESTING.md`
- Modify: `CHANGELOG.md`
- Modify: `NEXT_STEPS.md`
- Modify: `KNOWN_ISSUES.md`
- Modify: `DECISIONS.md`
- Modify: `docs/HANDOFF.md`

**Interfaces:**
- Consumes: Tasks 1–9, calling plan credentialed inbound/outbound smoke commands, foundation deployment configuration schema, and release manifest contract.
- Produces: executable dry-run-capable Cloudflare resource/migration/deploy/rollback, secret, Twilio, and Telegram configuration scripts; `release-manifest.json` under `docs/release-evidence/0.1.0/`; `verify-clean-setup.ps1` exit status using a generated non-secret test configuration; and explicitly named credentialed smoke results that may be skipped in development but are release-blocking when absent.

- [ ] **Step 1: Write failing release evidence and clean-setup tests**

```python
def test_live_telegram_smoke_skips_without_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    result = run_live_telegram_smoke()
    assert result.status == "skipped"
    assert result.reason == "missing TELEGRAM_BOT_TOKEN"

def test_release_manifest_requires_all_blocking_evidence(tmp_path: Path) -> None:
    with pytest.raises(ReleaseAuditError, match="backup_restore"):
        audit_release_manifest(tmp_path / "release-manifest.json")

@pytest.mark.parametrize("script", [
    "provision-cloud-resources.ps1", "apply-d1-migrations.ps1", "deploy-cloud.ps1",
    "rollback-cloud.ps1", "configure-twilio.ps1", "configure-telegram-webhook.ps1",
])
def test_deployment_scripts_have_a_non_mutating_redacted_dry_run(script: str) -> None:
    result = run_powershell(script, "-DryRun", sample_non_secret_arguments(script))
    assert result.returncode == 0
    assert not SECRET_PATTERN.search(result.stdout + result.stderr)
```

```powershell
$result = & .\scripts\verify-clean-setup.ps1 -WorkingDirectory $TestDrive\clean
$result.ExitCode | Should -Be 0
```

- [ ] **Step 2: Run release checks to verify they fail**

Run: `python -m pytest tests/acceptance/release/smoke-telegram-live.py tests/acceptance/release/smoke-memory-recall.py tests/acceptance/release/backup-restore.py tests/acceptance/release/test_deployment_scripts.py -q; powershell -ExecutionPolicy Bypass -File scripts/verify-clean-setup.ps1 -WorkingDirectory .tmp-clean-setup`

Expected: FAIL because deployment/release scripts, credentialed smoke harnesses, and evidence manifest validation do not exist.

- [ ] **Step 3: Implement reproducible setup and blocking audit manifest**

```powershell
param([Parameter(Mandatory=$true)][string]$WorkingDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null
pnpm install --frozen-lockfile
python -m pip install --require-hashes -r apps/local-agent/requirements.lock
$artifactArgs = @('-ExecutionPolicy', 'Bypass', '-File', 'scripts/fetch-embedding-model.ps1', '-LockFile', 'apps/local-agent/vendor/all-MiniLM-L6-v2/model-lock.json', '-Destination', 'apps/local-agent/vendor/all-MiniLM-L6-v2/artifacts')
powershell @artifactArgs
powershell -ExecutionPolicy Bypass -File scripts/run-embedding-compatibility.ps1 -Offline
$env:JARVIS_CLOUD_BASE_URL = 'https://example.invalid'; $env:JARVIS_DEVICE_ID = 'device-test'; $env:JARVIS_PRINCIPAL_ID = 'principal-test'
$env:JARVIS_DEVICE_KEY_PATH = (Join-Path $WorkingDirectory 'device.key'); $env:JARVIS_ARCHIVE_PATH = (Join-Path $WorkingDirectory 'archive.sqlite3'); $env:JARVIS_MEMORY_PATH = (Join-Path $WorkingDirectory 'memory.sqlite3')
python -m pip install -e apps/local-agent
python -m jarvis_local.cli doctor
```

```python
REQUIRED_EVIDENCE = {"commit", "config_schema", "migrations", "embedding_artifacts", "sbom", "dependency_audit", "secret_scan", "automated_tests", "telegram_live", "backup_restore", "inbound_call", "outbound_answer", "outbound_no_answer", "unauthorized_caller", "voice_failure_callbacks"}
def audit_release_manifest(path: Path) -> None:
    evidence = json.loads(path.read_text(encoding="utf-8"))["evidence"]
    missing = sorted(REQUIRED_EVIDENCE - set(evidence))
    if missing: raise ReleaseAuditError(",".join(missing))
    live = {"telegram_live", "inbound_call", "outbound_answer", "outbound_no_answer", "unauthorized_caller", "voice_failure_callbacks"}
    if any(evidence[name].get("status") != "passed" for name in live): raise ReleaseAuditError("credentialed_live_gate_not_passed")
    if evidence["dependency_audit"]["critical_or_high"] and not evidence["dependency_audit"].get("approved_time_bounded_exception"): raise ReleaseAuditError("critical_or_high_vulnerability")
```

The sample `REQUIRED_EVIDENCE` set and validator above specify only the pre-Obsidian baseline. They must not be implemented or accepted as the current release certificate until the approved superseding Obsidian implementation plan extends them with its required evidence and audit failures. A passing result from this legacy validator, including against `complete-passed-manifest.json`, cannot clear the hard execution and release block.

Every production script supports `-DryRun`, validates that it is executing from the repository root, uses argument arrays instead of shell-built command strings, exits nonzero on the first failed provider command, and emits only command names, resource aliases, HTTP status classes, deployment/version IDs, and redacted result codes. `-DryRun` performs no network or filesystem mutation. Actual external mutation requires the explicit `-Execute` switch; the release runbook treats that switch as the operator's cost/external-state checkpoint.

The scripts own these exact operations:

- `provision-cloud-resources.ps1`: from `apps/cloud-gateway`, run `pnpm exec wrangler d1 create jarvis-prod` and `pnpm exec wrangler r2 bucket create jarvis-prod-archive`, capture their non-secret identifiers, and require a reviewed production `wrangler.toml` binding update with `DB`, `ARCHIVE`, and `migrations_dir = "src/persistence/migrations"`; it refuses to continue while identifiers, binding names, or resource names mismatch.
- `configure-cloud-secrets.ps1`: invoke Wrangler's interactive `secret put <NAME> --env production` flow for `DEEPSEEK_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `PIN_VERIFIER_JSON`. It never accepts a secret on a command line, never echoes stdin, and confirms only the variable name and Wrangler exit status. Because each secret update creates a Worker version, the script records only returned version IDs and the final deploy supersedes them. `bootstrap-local-agent.ps1` prompts for the eight-digit PIN through secure console input, derives/provisions the versioned PBKDF2 record, generates a 256-bit bootstrap token in memory, inserts only its SHA-256 hash plus 15-minute expiry into D1, consumes the plaintext through the bootstrap request, and clears transient buffers without printing or writing either value.
- `apply-d1-migrations.ps1`: accept the reviewed database name as `-DatabaseName` (default `jarvis-prod`), first create an isolated D1 database and apply every forward migration there, run the documented compatibility/restore drill, and record the result; only then run `pnpm exec wrangler d1 migrations list $DatabaseName --remote --env production` followed by `pnpm exec wrangler d1 migrations apply $DatabaseName --remote --env production`. `DB` remains the Worker binding and is never passed as a substitute for the database name. The script records migration identifiers and status, never row contents. Migrations are operationally forward-only: D1 automatically rolls back a failed individual migration, while compatible-code rollout or encrypted restore handles a later production rollback.
- `deploy-cloud.ps1`: verify the committed Worker binding names, run typecheck/fake gates, invoke the remote migration script, run `pnpm exec wrangler deploy --env production` and `pnpm exec wrangler deployments list --env production`, capture the immutable deployment/version ID, query authenticated readiness, and write a redacted deployment receipt. It does not configure provider webhooks until readiness succeeds.
- `rollback-cloud.ps1`: run `pnpm exec wrangler rollback <known-good-version-id> --env production --message <reason>` for an explicit recorded version ID, verify readiness, and record the result. Worker rollback never reverts D1, R2, or Durable Object state; the runbook selects only a schema-compatible Worker or the separately proven encrypted restore procedure.
- `configure-twilio.ps1`: before mutation, read the selected IncomingPhoneNumber and reject a configured `voice_application_sid` or `trunk_sid` that would override `VoiceUrl`. Through an in-memory Basic Authorization header, POST `VoiceUrl=<base>/voice/inbound`, `VoiceMethod=POST`, `VoiceFallbackUrl=<base>/voice/fallback`, `VoiceFallbackMethod=POST`, `StatusCallback=<base>/voice/status`, `StatusCallbackMethod=POST`, and `VoiceReceiveMode=voice`; then safely re-read and compare only those expected fields. The runbook separately requires accepting Twilio's Predictive and Generative AI/ML Features Addendum before first ConversationRelay use. Worker-generated TwiML owns the `wss://` relay URL, signed `<Connect action>`, and opaque `<Parameter name="relayNonce">`; every outbound Calls API request separately registers its four progress callbacks. The script never prints authorization, phone numbers, or provider bodies.
- `configure-telegram-webhook.ps1`: call Bot API `setWebhook` with the deployed `/telegram/webhook` URL, `secret_token`, and `allowed_updates=["message"]`; then call `getWebhookInfo` and compare only the expected URL and pending/error status. It does not print the bot token, secret token, or provider body.

`docs/deployment/cloudflare.md`, `twilio.md`, and `telegram.md` list the ordered commands: provision resources, review and commit bindings, install secrets, apply migrations, deploy, verify readiness, configure provider webhooks, run fake gates, then run the separately authorized credentialed smoke gates. Each command names its expected redacted receipt and its rollback action. No live call, message, webhook mutation, deployment, or paid resource creation is run during ordinary automated tests.

Implementation source anchors are the official [Cloudflare D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), [Cloudflare Worker rollback guide](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), [Cloudflare secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/), [Twilio IncomingPhoneNumber resource](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource), [Twilio Calls resource](https://www.twilio.com/docs/voice/api/call-resource), [Twilio voice webhooks](https://www.twilio.com/docs/usage/webhooks/voice-webhooks), [ConversationRelay onboarding](https://www.twilio.com/docs/voice/conversationrelay/onboarding), and [ConversationRelay TwiML reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay). Implementers re-check these primary sources before executing a production mutation.

- [ ] **Step 4: Run automated deployment and release-audit checks**

Run now: `pnpm test:acceptance -- telegram-fake-provider.test.ts; python -m pytest tests/acceptance/release -q; powershell -ExecutionPolicy Bypass -File scripts/verify-clean-setup.ps1 -WorkingDirectory .tmp-clean-setup; powershell -ExecutionPolicy Bypass -File scripts/release-audit.ps1 -Manifest tests/acceptance/release/fixtures/complete-passed-manifest.json`

Expected now: PASS for fake, deployment-script dry-run, manifest-validator, and clean-environment checks. The checked-in fixture contains synthetic identifiers only and proves the audit logic, not a release. A development invocation of credentialed smoke may report `skipped` when credentials are absent, but the real `docs/release-evidence/0.1.0/release-manifest.json` remains release-blocking until Telegram, inbound-call, unauthorized-caller, outbound-call, and failure-callback evidence each has `status: "passed"`. Resource provisioning, provider webhook mutation, deployment, and real calls are separate explicit external-state/cost-bearing release operations.

- [ ] **Step 5: Commit deployment and release discipline**

```bash
git add scripts tests/acceptance docs/deployment docs/runbooks docs/release-evidence README.md REQUIREMENTS.md TESTING.md CHANGELOG.md NEXT_STEPS.md KNOWN_ISSUES.md DECISIONS.md docs/HANDOFF.md
git commit -m "chore(release): add telegram memory deployment audit"
```

## Release Execution Checklist

- [ ] Approve the superseding Obsidian implementation plan and complete its contracts, endpoints, root-confined adapter/reconciliation, authority/export storage and migrations, setup/diagnostics, tests, and release-manifest audit work; until all resulting evidence is `passed`, this entire legacy checklist remains non-certifying and `0.1.0` is blocked.
- [ ] Verify `scripts/release-audit.ps1` and the real manifest schema require the Obsidian evidence defined by that approved plan. The legacy `REQUIRED_EVIDENCE` set and synthetic complete fixture must fail current-scope certification when that evidence is absent.
- [ ] Deploy and verify the D1 migrations for Telegram rate/idempotency state, per-device cursors, memory projection versions, and transactional outbox rows; execute the documented rollback in an isolated D1 database before production.
- [ ] Store `DEEPSEEK_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `PIN_VERIFIER_JSON` only in Cloudflare secret storage. Store only the 15-minute bootstrap-token hash/expiry in D1; keep its plaintext and device/backup keys only in Windows-protected transient or persistent storage as appropriate.
- [ ] Accept Twilio's Predictive and Generative AI/ML Features Addendum, verify no TwiML App or trunk overrides the selected number's direct Voice URL, and prove generated TwiML includes the opaque relay-nonce `<Parameter>` plus signed relay-ended callback.
- [ ] Set Telegram's webhook to the deployed HTTPS endpoint with `TELEGRAM_WEBHOOK_SECRET`; prove the gateway rejects a bad secret before it reads an update body.
- [ ] Run the compatibility gate on the reference Windows machine and commit its selected runtime/version/artifact-hash decision before local-agent installation.
- [ ] Acquire the immutable-revision embedding artifacts through `fetch-embedding-model.ps1`, retain the redacted hash/size receipt as `embedding_artifacts` evidence, package/copy that exact verified cache during local-agent installation, and rerun the compatibility gate with network blocked.
- [ ] Run fake-provider integration, formatting, lint, TypeScript type-checking, Python type-checking, dependency audit, secret scans over worktree/history/build artifacts, migration checks, and clean-environment setup.
- [ ] Run the 1,000-event, 24-hour offline catch-up acceptance test and backup/restore drill; retain exact reports in the release evidence directory.
- [ ] Run credentialed Telegram smoke for round trip, persistence, recall, and terminal delivery failure callback; retain a redacted evidence record.
- [ ] Run the calling plan's real inbound two-turn/interruption/hangup test and outbound answer/no-answer test; retain the call evidence because the permanent call gate blocks this release even though calling code is out of scope here.
- [ ] Generate `release-manifest.json` with commit SHA, configuration schema version, migration/rollback result, SBOM, audit outputs, secret-scan evidence, automated reports, live Telegram evidence, call evidence, backup/restore evidence, and time-bounded approved exceptions.
- [ ] Run `scripts/release-audit.ps1`; do not tag `0.1.0` unless it exits 0 and no unapproved critical/high vulnerability exists.

## Self-Review

**Spec coverage:** This plan does not claim full coverage of the current approved foundation. It covers only the pre-Obsidian baseline: Task 2 enforces Telegram text-only handling, header validation, allowlisting, rejection minimization, limits, and idempotency. Tasks 4–6 implement protected local credentials, signed replication, append-only archive, canonical hash verification, and idempotent cursor behavior. Tasks 7–8 implement mandatory full-text/semantic retrieval, Windows compatibility fallback, source-linked fact states, safe promotion, cloud-only model distillation, and atomic projection. Task 9 covers offline continuity, SID-restricted CLI transport, recovery, backup, and 1,000-event catch-up. Task 10 covers the legacy secrets, deployment, clean setup, live smoke, required docs, and release evidence. The calling plan remains authoritative for voice paths. Full foundation and release coverage additionally requires the approved superseding Obsidian implementation plan and passed evidence enumerated by the hard block above.

**Boundedness review:** Each legacy task names files, public symbols, a failing test, an expected failing command, minimal implementation code, a passing command, and a commit. That internal boundedness is not a completeness claim: the Obsidian work is an explicit blocked prerequisite that must be specified in a separately approved superseding plan before any execution or certification.

**Type consistency:** `SyncEventsRequestV1`, `MemoryDistillRequestV1`, and `MemoryFactProjectV1` are introduced in Task 1, verified in Task 5, and consumed unchanged in Task 8. `ArchiveRepository.insert_event_if_absent` is introduced in Task 6 and used by the Task 5 replicator. `LocalMemoryRetriever.search` is introduced in Task 8 and used by Task 9 acceptance flows. `run_compatibility_gate` is defined in Task 7 and used by Task 10 setup.

## Execution Handoff

Execution status: **BLOCKED pending the independently reviewed and explicitly approved superseding Obsidian implementation plan required above.** After that plan integrates this legacy work into the current scope, use its approved execution mode (expected to be `superpowers:subagent-driven-development` in the same isolated feature worktree), dispatch one fresh implementer per task, and require independent spec-compliance and code-quality review before advancing. Automated dry-run and fake-provider gates may run autonomously only after the block is cleared; resource creation, webhook mutation, credential entry, deployment, and paid live smoke remain explicit release checkpoints.

import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  validateEnvelope,
  type PersistableEventEnvelopeV1,
  type Sha256Hex,
  type SuccessfulRedaction,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { isIssuedRedaction, sanitizeRedaction } from "../../../../packages/contracts/src/calls.js";
import {
  ProviderFailure,
  ProviderIdempotencyConflictError,
  snapshotProviderFailure,
} from "../providers/provider-types.js";
import {
  EventRepository,
  type AppendedEvent,
} from "../persistence/event-repository.js";
import {
  snapshotVoiceSentReceipt,
  type AssistantStageResult,
  type ClaimedConversationDelivery,
  type ConversationChannel,
  type ConversationDeliveryId,
  type ConversationDeliveryState,
  type ConversationFailureCategory,
  type ConversationFailureCode,
  type ConversationHistoryMode,
  type ConversationTurnAdmission,
  type ConversationTurnState,
  type DeliveryDispatchClaim,
  type DeliveryLeaseCapability,
  type ModelStreamClaimCapability,
  type ModelTurnClaim,
  type ProviderDeliveryReceipt,
  type StoredConversationDelivery,
  type StoredConversationTurn,
  type VoiceSentReceipt,
} from "./conversation-types.js";

export const CONVERSATION_EVENT_SOURCE = "conversation" as const;
export const CONVERSATION_EVENT_PRODUCER_VERSION = "conversation-v1" as const;

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DELIVERY_IDEMPOTENCY_KEY = /^conversation:[0-7][0-9a-hjkmnp-tv-z]{25}:[a-f0-9]{16}$/u;
const encoder = new TextEncoder();
const TERMINAL_TURN_STATES = new Set<ConversationTurnState>([
  "assistant_staged", "voice_sent", "delivered", "cancelled", "failed", "model_outcome_unknown", "delivery_unknown",
]);
const TERMINAL_DELIVERY_STATES = new Set<ConversationDeliveryState>(["delivered", "failed", "unknown"]);

const CHANNEL_CODE: Readonly<Record<ConversationChannel, 1 | 2>> = Object.freeze({ voice: 1, telegram: 2 });
const FAILURE_CODE_NUMBER: Readonly<Record<ConversationFailureCode, number>> = Object.freeze({
  ingest_redaction_failed: 1,
  model_cancelled: 2,
  model_failed: 3,
  model_outcome_unknown: 4,
  delivery_retry: 5,
  delivery_authentication: 6,
  delivery_permanent: 7,
  delivery_idempotency_conflict: 8,
  delivery_retry_exhausted: 9,
  delivery_unknown: 10,
});
const FAILURE_CATEGORY_NUMBER: Readonly<Record<ConversationFailureCategory, number>> = Object.freeze({
  ingest: 1,
  cancelled: 2,
  provider: 3,
  authentication: 4,
  invalid_request: 5,
  idempotency_conflict: 6,
  ambiguous: 7,
});

interface ConversationTurnRow {
  turn_id: string;
  session_id: string;
  principal_id: string;
  channel: string;
  request_hash: string;
  user_event_id: string;
  state: string;
  model_claim_token_hash: string | null;
  model_claimed_at: string | null;
  model_claim_expires_at: string | null;
  resolved_at: string | null;
  staged_delivery_id: string | null;
  sent_assistant_event_id: string | null;
  delivered_assistant_event_id: string | null;
  failure_code: string | null;
  failure_category: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationDeliveryRow {
  delivery_id: string;
  correlation_id: string;
  turn_id: string | null;
  staged_event_id: string;
  principal_id: string;
  target_identity_id: string;
  reply_to_message_id: number | null;
  history_mode: string;
  material_hash: string;
  provider_idempotency_key: string;
  state: string;
  attempt_count: number;
  available_at: string;
  lease_token_hash: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  resolved_at: string | null;
  provider_message_id: string | null;
  delivered_assistant_event_id: string | null;
  failure_code: string | null;
  failure_category: string | null;
  created_at: string;
  updated_at: string;
}

interface StoredEventRow {
  event_type: string;
  subject_id: string;
  content_hash: string;
  envelope_json: string;
}

interface ModelClaimBinding {
  turnId: Ulid;
  sessionId: string;
  principalId: string;
  channel: ConversationChannel;
  requestHash: Sha256Hex;
  userEventId: Ulid;
  claimTokenHash: Sha256Hex;
}

interface DeliveryLeaseBinding {
  deliveryId: ConversationDeliveryId;
  correlationId: Ulid;
  turnId: Ulid | null;
  stagedEventId: Ulid;
  principalId: string;
  targetIdentityId: string;
  historyMode: ConversationHistoryMode;
  materialHash: Sha256Hex;
  providerIdempotencyKey: string;
  leaseTokenHash: Sha256Hex;
}

export interface ConversationRepositoryOptions {
  readonly eventIdFactory?: () => Ulid;
  readonly deliveryIdFactory?: () => ConversationDeliveryId;
  readonly claimTokenFactory?: () => Uint8Array;
  readonly leaseTokenFactory?: () => Uint8Array;
  readonly claimTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly retryDelayMs?: number;
}

function randomToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function exactDataRecord(value: unknown, fields: readonly string[], error: string): Record<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
    keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : [];
  } catch {
    throw new TypeError(error);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || prototype !== Object.prototype
    || keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw new TypeError(error);
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { throw new TypeError(error); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    captured[field] = descriptor.value;
  }
  return captured;
}

function requireUlid(value: unknown, label: string): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(`${label}_invalid`);
  return value as Ulid;
}

function requireDeliveryId(value: unknown): ConversationDeliveryId {
  return requireUlid(value, "conversation_delivery_id") as unknown as ConversationDeliveryId;
}

function requireHash(value: unknown, label: string): Sha256Hex {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label}_invalid`);
  return value as Sha256Hex;
}

function requireSafeText(value: unknown, label: string, maximumBytes = 256): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || !value.isWellFormed()
    || value !== value.normalize("NFC")
    || encoder.encode(value).byteLength > maximumBytes
  ) {
    throw new TypeError(`${label}_invalid`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value)) throw new TypeError(`${label}_invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(`${label}_invalid`);
  return value;
}

function snapshotDate(value: unknown, label: string): { iso: string; epochMs: number } {
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { throw new TypeError(`${label}_invalid`); }
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) throw new TypeError(`${label}_invalid`);
  return Object.freeze({ iso: new Date(epochMs).toISOString(), epochMs });
}

function requireChannel(value: unknown): ConversationChannel {
  if (value !== "voice" && value !== "telegram") throw new TypeError("conversation_channel_invalid");
  return value;
}

function requireIssuedText(value: unknown): SuccessfulRedaction {
  if (!isIssuedRedaction(value) || !Object.isFrozen(value)) throw new TypeError("conversation_text_redaction_invalid");
  if (encoder.encode(value.text).byteLength > 65536) throw new RangeError("conversation_text_too_large");
  return value;
}

function snapshotToken(factory: () => Uint8Array, label: string): Uint8Array {
  const generated = factory();
  let copy: Uint8Array;
  try { copy = Uint8Array.prototype.slice.call(generated) as Uint8Array; }
  catch { throw new TypeError(`${label}_invalid`); }
  if (copy.byteLength !== 32) throw new TypeError(`${label}_invalid`);
  return copy;
}

function requireReplyMessageId(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError("reply_to_message_id_invalid");
  return value as number;
}

function requireFailureCode(value: unknown): ConversationFailureCode {
  if (typeof value !== "string" || !Object.hasOwn(FAILURE_CODE_NUMBER, value)) throw new TypeError("conversation_failure_code_invalid");
  return value as ConversationFailureCode;
}

function requireFailureCategory(value: unknown): ConversationFailureCategory {
  if (typeof value !== "string" || !Object.hasOwn(FAILURE_CATEGORY_NUMBER, value)) throw new TypeError("conversation_failure_category_invalid");
  return value as ConversationFailureCategory;
}

function exactPayload(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("conversation_staged_event_invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new Error("conversation_staged_event_invalid");
  return value as Record<string, unknown>;
}

function isTurnState(value: unknown): value is ConversationTurnState {
  return value === "user_committed" || value === "model_claimed" || value === "assistant_staged"
    || value === "voice_sent" || value === "delivered" || value === "cancelled" || value === "failed"
    || value === "model_outcome_unknown" || value === "delivery_unknown";
}

function isDeliveryState(value: unknown): value is ConversationDeliveryState {
  return value === "pending" || value === "claimed" || value === "delivered"
    || value === "retry_wait" || value === "failed" || value === "unknown";
}

function safeFailurePayload(channel: ConversationChannel, code: ConversationFailureCode, category: ConversationFailureCategory) {
  return Object.freeze({
    schemaCode: 1,
    channelCode: CHANNEL_CODE[channel],
    failureCode: FAILURE_CODE_NUMBER[code],
    failureCategoryCode: FAILURE_CATEGORY_NUMBER[category],
    historyEligible: false,
  });
}

function historyPayload(channel: ConversationChannel, text: SuccessfulRedaction, historyEligible: boolean) {
  return Object.freeze({
    schemaCode: 1,
    channelCode: CHANNEL_CODE[channel],
    sensitivityCode: 1,
    historyEligible,
    text,
  });
}

function systemPayload(text: SuccessfulRedaction) {
  return Object.freeze({ schemaCode: 1, channelCode: 2, noticeCode: 1, historyEligible: false, text });
}

export class ConversationRepository {
  private readonly eventIdFactory: () => Ulid;
  private readonly deliveryIdFactory: () => ConversationDeliveryId;
  private readonly claimTokenFactory: () => Uint8Array;
  private readonly leaseTokenFactory: () => Uint8Array;
  private readonly claimTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly retryDelayMs: number;

  private readonly modelClaimBindings = new WeakMap<object, ModelClaimBinding>();
  private readonly begunModelClaims = new WeakSet<object>();
  private readonly settledModelClaims = new WeakSet<object>();
  private readonly deliveryLeaseBindings = new WeakMap<object, DeliveryLeaseBinding>();
  private readonly begunDeliveryLeases = new WeakSet<object>();
  private readonly settledDeliveryLeases = new WeakSet<object>();
  private readonly providerReceiptBindings = new WeakMap<object, DeliveryLeaseCapability>();
  private readonly issuedReceiptForLease = new WeakMap<object, ProviderDeliveryReceipt>();
  private readonly consumedProviderReceipts = new WeakSet<object>();

  constructor(
    private readonly database: D1Database,
    private readonly events: EventRepository,
    options: ConversationRepositoryOptions = {},
  ) {
    const eventIdFactory = options.eventIdFactory ?? newUlid;
    const deliveryIdFactory = options.deliveryIdFactory ?? (() => newUlid() as unknown as ConversationDeliveryId);
    const claimTokenFactory = options.claimTokenFactory ?? randomToken;
    const leaseTokenFactory = options.leaseTokenFactory ?? randomToken;
    if (typeof eventIdFactory !== "function" || typeof deliveryIdFactory !== "function"
      || typeof claimTokenFactory !== "function" || typeof leaseTokenFactory !== "function") {
      throw new TypeError("conversation_repository_factory_invalid");
    }
    this.eventIdFactory = eventIdFactory;
    this.deliveryIdFactory = deliveryIdFactory;
    this.claimTokenFactory = claimTokenFactory;
    this.leaseTokenFactory = leaseTokenFactory;
    this.claimTtlMs = options.claimTtlMs ?? 45_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isSafeInteger(this.claimTtlMs) || this.claimTtlMs <= 0 || this.claimTtlMs > 45_000) {
      throw new RangeError("model_claim_ttl_invalid");
    }
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0 || this.leaseTtlMs > 30_000) {
      throw new RangeError("delivery_lease_ttl_invalid");
    }
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs > 300_000) {
      throw new RangeError("delivery_retry_delay_invalid");
    }
  }

  async getOrCreateTurn(input: {
    turnId: Ulid;
    sessionId: string;
    principalId: string;
    channel: ConversationChannel;
    userText: SuccessfulRedaction;
    now: Date;
  }): Promise<ConversationTurnAdmission> {
    const captured = exactDataRecord(input, ["turnId", "sessionId", "principalId", "channel", "userText", "now"], "conversation_turn_input_invalid");
    const turnId = requireUlid(captured.turnId, "conversation_turn_id");
    const sessionId = requireSafeText(captured.sessionId, "conversation_session_id", 256);
    const principalId = requireSafeText(captured.principalId, "conversation_principal_id");
    const channel = requireChannel(captured.channel);
    const userText = requireIssuedText(captured.userText);
    const observedAt = snapshotDate(captured.now, "conversation_turn_now");
    const requestHash = await sha256Hex(canonicalJson([
      "conversation-turn-v1", turnId, sessionId, principalId, channel, userText.text,
    ]));
    const existing = await this.readTurn(turnId);
    if (existing !== null) return Object.freeze({ turn: this.requireTurnLineage(existing, { sessionId, principalId, channel, requestHash }), replayed: true });

    const eventId = requireUlid(this.eventIdFactory(), "conversation_event_id");
    const envelope = await this.createConversationEnvelope({
      eventId,
      eventType: "conversation.user_committed",
      principalId,
      correlationId: turnId,
      payload: historyPayload(channel, userText, true),
      nowIso: observedAt.iso,
    });
    const appended = await this.events.appendAtomicAfter({
      envelope,
      scope: "conversation:user",
      key: turnId,
      requestHash,
    }, (database) => [database.prepare(`INSERT INTO conversation_turns (
      turn_id, session_id, principal_id, channel, request_hash, user_event_id, state,
      model_claim_token_hash, model_claimed_at, model_claim_expires_at, resolved_at,
      staged_delivery_id, sent_assistant_event_id, delivered_assistant_event_id,
      failure_code, failure_category, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'user_committed',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?7, ?8)`)
      .bind(turnId, sessionId, principalId, channel, requestHash, envelope.eventId, observedAt.iso, observedAt.iso)]);
    const row = await this.readTurn(turnId);
    if (row === null) throw new Error("conversation_turn_missing_after_commit");
    return Object.freeze({
      turn: this.requireTurnLineage(row, { sessionId, principalId, channel, requestHash }),
      replayed: appended.replayed,
    });
  }

  async recordIngestFailure(input: {
    turnId: Ulid;
    sessionId: string;
    principalId: string;
    channel: ConversationChannel;
    now: Date;
  }): Promise<AppendedEvent> {
    const captured = exactDataRecord(input, ["turnId", "sessionId", "principalId", "channel", "now"], "conversation_ingest_failure_input_invalid");
    const turnId = requireUlid(captured.turnId, "conversation_turn_id");
    const sessionId = requireSafeText(captured.sessionId, "conversation_session_id", 256);
    const principalId = requireSafeText(captured.principalId, "conversation_principal_id");
    const channel = requireChannel(captured.channel);
    const observedAt = snapshotDate(captured.now, "conversation_ingest_failure_now");
    const requestHash = await sha256Hex(canonicalJson(["conversation-ingest-failure-v1", turnId, sessionId, principalId, channel]));
    const envelope = await this.createConversationEnvelope({
      eventId: requireUlid(this.eventIdFactory(), "conversation_event_id"),
      eventType: "conversation.turn_failed",
      principalId,
      correlationId: turnId,
      payload: safeFailurePayload(channel, "ingest_redaction_failed", "ingest"),
      nowIso: observedAt.iso,
    });
    return this.events.append({ envelope, scope: "conversation:ingest_failure", key: turnId, requestHash });
  }

  async claimModelTurn(input: { turnId: Ulid; requestHash: Sha256Hex; now: Date }): Promise<ModelTurnClaim> {
    const captured = exactDataRecord(input, ["turnId", "requestHash", "now"], "model_claim_input_invalid");
    const turnId = requireUlid(captured.turnId, "conversation_turn_id");
    const requestHash = requireHash(captured.requestHash, "conversation_request_hash");
    const observedAt = snapshotDate(captured.now, "model_claim_now");
    const initial = await this.readTurn(turnId);
    if (initial === null || initial.request_hash !== requestHash) throw new Error("conversation_turn_conflict");

    if (initial.state === "user_committed") {
      const tokenHash = await sha256Hex(snapshotToken(this.claimTokenFactory, "model_claim_token"));
      const expiresAt = new Date(observedAt.epochMs + this.claimTtlMs).toISOString();
      const claimed = await this.database.prepare(`UPDATE conversation_turns
        SET state = 'model_claimed', model_claim_token_hash = ?1, model_claimed_at = ?2,
            model_claim_expires_at = ?3, updated_at = ?4
        WHERE turn_id = ?5 AND request_hash = ?6 AND state = 'user_committed'
        RETURNING *`)
        .bind(tokenHash, observedAt.iso, expiresAt, observedAt.iso, turnId, requestHash)
        .first<ConversationTurnRow>();
      if (claimed !== null) {
        const turn = this.toStoredTurn(claimed);
        const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
        this.modelClaimBindings.set(capability, Object.freeze({
          turnId,
          sessionId: turn.sessionId,
          principalId: turn.principalId,
          channel: turn.channel,
          requestHash,
          userEventId: turn.userEventId,
          claimTokenHash: tokenHash,
        }));
        return Object.freeze({ kind: "claimed", capability, turn });
      }
    }

    let current = await this.readTurn(turnId);
    if (current === null || current.request_hash !== requestHash) throw new Error("conversation_turn_conflict");
    if (current.state === "model_claimed" && current.model_claim_expires_at !== null && current.model_claim_expires_at <= observedAt.iso) {
      await this.database.prepare(`UPDATE conversation_turns
        SET state = 'model_outcome_unknown', resolved_at = ?1,
            failure_code = 'model_outcome_unknown', failure_category = 'ambiguous', updated_at = ?2
        WHERE turn_id = ?3 AND request_hash = ?4 AND state = 'model_claimed' AND model_claim_expires_at <= ?5`)
        .bind(observedAt.iso, observedAt.iso, turnId, requestHash, observedAt.iso).run();
      current = await this.readTurn(turnId);
      if (current === null) throw new Error("conversation_turn_missing");
    }
    const turn = this.toStoredTurn(current);
    if (turn.state === "model_claimed") return Object.freeze({ kind: "in_progress", turn });
    return Object.freeze({ kind: "terminal", turn });
  }

  beginModelStream(capability: ModelStreamClaimCapability, expectedTurnId: Ulid, expectedRequestHash: Sha256Hex): void {
    const binding = this.modelClaimBindings.get(capability);
    if (
      binding === undefined
      || !ULID.test(expectedTurnId)
      || !SHA256.test(expectedRequestHash)
      || binding.turnId !== expectedTurnId
      || binding.requestHash !== expectedRequestHash
      || this.begunModelClaims.has(capability)
      || this.settledModelClaims.has(capability)
    ) {
      throw new Error("model_stream_claim_invalid");
    }
    this.begunModelClaims.add(capability);
  }

  async stageAssistantDelivery(input: {
    claim: ModelStreamClaimCapability;
    text: SuccessfulRedaction;
    targetIdentityId: string;
    replyToMessageId: number | null;
    now: Date;
  }): Promise<AssistantStageResult> {
    const captured = exactDataRecord(input, ["claim", "text", "targetIdentityId", "replyToMessageId", "now"], "assistant_stage_input_invalid");
    const claim = captured.claim as ModelStreamClaimCapability;
    const text = requireIssuedText(captured.text);
    const targetIdentityId = requireSafeText(captured.targetIdentityId, "target_identity_id");
    const replyToMessageId = requireReplyMessageId(captured.replyToMessageId);
    const observedAt = snapshotDate(captured.now, "assistant_stage_now");
    const binding = this.settleModelClaim(claim);
    if (binding.channel !== "telegram") throw new Error("assistant_stage_channel_invalid");
    const turnRow = await this.readTurn(binding.turnId);
    if (turnRow === null || turnRow.state !== "model_claimed" || turnRow.model_claim_token_hash !== binding.claimTokenHash) {
      throw new Error("model_stream_claim_invalid");
    }
    const deliveryId = requireDeliveryId(this.deliveryIdFactory());
    const eventId = requireUlid(this.eventIdFactory(), "conversation_event_id");
    const materialHash = await sha256Hex(canonicalJson([
      "conversation-delivery-v1", deliveryId, binding.turnId, binding.principalId,
      targetIdentityId, replyToMessageId, "assistant", text.text,
    ]));
    const providerIdempotencyKey = `conversation:${deliveryId}:${materialHash.slice(0, 16)}`;
    const envelope = await this.createConversationEnvelope({
      eventId,
      eventType: "conversation.assistant_staged",
      principalId: binding.principalId,
      correlationId: binding.turnId,
      causationId: binding.userEventId,
      payload: historyPayload("telegram", text, false),
      nowIso: observedAt.iso,
    });
    const requestHash = await sha256Hex(canonicalJson(["assistant-stage-v1", binding.turnId, deliveryId, materialHash]));
    await this.events.appendAtomicAfter({
      envelope,
      scope: "conversation:assistant_stage",
      key: binding.turnId,
      requestHash,
    }, (database) => [
      database.prepare(`INSERT INTO conversation_deliveries (
        delivery_id, correlation_id, turn_id, staged_event_id, principal_id, target_identity_id,
        reply_to_message_id, history_mode, material_hash, provider_idempotency_key, state,
        attempt_count, available_at, lease_token_hash, claimed_at, lease_expires_at, resolved_at,
        provider_message_id, delivered_assistant_event_id, failure_code, failure_category, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'assistant', ?8, ?9, 'pending',
        0, ?10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?11, ?12)`)
        .bind(
          deliveryId, binding.turnId, binding.turnId, envelope.eventId, binding.principalId,
          targetIdentityId, replyToMessageId, materialHash, providerIdempotencyKey,
          observedAt.iso, observedAt.iso, observedAt.iso,
        ),
      database.prepare(`UPDATE conversation_turns
        SET state = 'assistant_staged', resolved_at = ?1, staged_delivery_id = ?2, updated_at = ?3
        WHERE turn_id = ?4 AND state = 'model_claimed' AND model_claim_token_hash = ?5`)
        .bind(observedAt.iso, deliveryId, observedAt.iso, binding.turnId, binding.claimTokenHash),
    ]);
    const [storedTurnRow, storedDeliveryRow] = await Promise.all([this.readTurn(binding.turnId), this.readDeliveryRow(deliveryId)]);
    if (storedTurnRow === null || storedDeliveryRow === null) throw new Error("assistant_stage_missing_after_commit");
    return Object.freeze({ turn: this.toStoredTurn(storedTurnRow), delivery: this.toStoredDelivery(storedDeliveryRow) });
  }

  async recordVoiceSent(input: {
    claim: ModelStreamClaimCapability;
    text: SuccessfulRedaction;
    receipt: VoiceSentReceipt;
    now: Date;
  }): Promise<StoredConversationTurn> {
    const captured = exactDataRecord(input, ["claim", "text", "receipt", "now"], "voice_sent_input_invalid");
    const claim = captured.claim as ModelStreamClaimCapability;
    const text = requireIssuedText(captured.text);
    const observedAt = snapshotDate(captured.now, "voice_sent_now");
    const binding = this.modelClaimBindings.get(claim);
    if (binding === undefined || binding.channel !== "voice") throw new Error("model_stream_claim_invalid");
    const contentHash = await sha256Hex(text.text);
    snapshotVoiceSentReceipt(captured.receipt, { sessionId: binding.sessionId, turnId: binding.turnId, contentHash });
    this.settleModelClaim(claim);
    const eventId = requireUlid(this.eventIdFactory(), "conversation_event_id");
    const envelope = await this.createConversationEnvelope({
      eventId,
      eventType: "conversation.assistant_sent",
      principalId: binding.principalId,
      correlationId: binding.turnId,
      causationId: binding.userEventId,
      payload: historyPayload("voice", text, false),
      nowIso: observedAt.iso,
    });
    const requestHash = await sha256Hex(canonicalJson(["voice-sent-v1", binding.turnId, contentHash]));
    await this.events.appendAtomicAfter({ envelope, scope: "conversation:voice_sent", key: binding.turnId, requestHash }, (database) => [
      database.prepare(`UPDATE conversation_turns
        SET state = 'voice_sent', resolved_at = ?1, sent_assistant_event_id = ?2, updated_at = ?3
        WHERE turn_id = ?4 AND state = 'model_claimed' AND model_claim_token_hash = ?5`)
        .bind(observedAt.iso, envelope.eventId, observedAt.iso, binding.turnId, binding.claimTokenHash),
    ]);
    const row = await this.readTurn(binding.turnId);
    if (row === null) throw new Error("conversation_turn_missing_after_commit");
    return this.toStoredTurn(row);
  }

  async recordTurnCancelled(input: { claim: ModelStreamClaimCapability; now: Date }): Promise<StoredConversationTurn> {
    return this.recordModelTerminal(input, "cancelled", "model_cancelled", "cancelled", "conversation.turn_cancelled");
  }

  async recordTurnFailed(input: {
    claim: ModelStreamClaimCapability;
    failureCode: "model_failed" | "model_outcome_unknown";
    failureCategory: "provider" | "ambiguous";
    now: Date;
  }): Promise<StoredConversationTurn> {
    const captured = exactDataRecord(input, ["claim", "failureCode", "failureCategory", "now"], "turn_failure_input_invalid");
    if (captured.failureCode === "model_failed" && captured.failureCategory === "provider") {
      return this.recordModelTerminal(
        { claim: captured.claim as ModelStreamClaimCapability, now: captured.now as Date },
        "failed",
        "model_failed",
        "provider",
        "conversation.turn_failed",
      );
    }
    if (captured.failureCode === "model_outcome_unknown" && captured.failureCategory === "ambiguous") {
      return this.recordModelTerminal(
        { claim: captured.claim as ModelStreamClaimCapability, now: captured.now as Date },
        "model_outcome_unknown",
        "model_outcome_unknown",
        "ambiguous",
        "conversation.turn_failed",
      );
    }
    throw new TypeError("turn_failure_input_invalid");
  }

  async stageSystemNotice(input: {
    noticeId: Ulid;
    sessionId: string;
    principalId: string;
    channel: "telegram";
    noticeCode: "busy";
    targetIdentityId: string;
    replyToMessageId: number | null;
    now: Date;
  }): Promise<StoredConversationDelivery> {
    const captured = exactDataRecord(
      input,
      ["noticeId", "sessionId", "principalId", "channel", "noticeCode", "targetIdentityId", "replyToMessageId", "now"],
      "system_notice_input_invalid",
    );
    const noticeId = requireUlid(captured.noticeId, "system_notice_id");
    const sessionId = requireSafeText(captured.sessionId, "conversation_session_id", 256);
    const principalId = requireSafeText(captured.principalId, "conversation_principal_id");
    if (captured.channel !== "telegram" || captured.noticeCode !== "busy") throw new TypeError("system_notice_input_invalid");
    const targetIdentityId = requireSafeText(captured.targetIdentityId, "target_identity_id");
    const replyToMessageId = requireReplyMessageId(captured.replyToMessageId);
    const observedAt = snapshotDate(captured.now, "system_notice_now");
    const text = sanitizeRedaction("Jarvis is busy. Please try again shortly.");
    if (!text.ok) throw new Error("system_notice_redaction_failed");
    const deliveryId = requireDeliveryId(this.deliveryIdFactory());
    const eventId = requireUlid(this.eventIdFactory(), "conversation_event_id");
    const materialHash = await sha256Hex(canonicalJson([
      "conversation-system-v1", noticeId, sessionId, principalId, targetIdentityId, replyToMessageId, text.text,
    ]));
    const providerIdempotencyKey = `conversation:${deliveryId}:${materialHash.slice(0, 16)}`;
    const envelope = await this.createConversationEnvelope({
      eventId,
      eventType: "conversation.system_staged",
      principalId,
      correlationId: noticeId,
      payload: systemPayload(text),
      nowIso: observedAt.iso,
    });
    const requestHash = await sha256Hex(canonicalJson(["system-stage-v1", noticeId, materialHash]));
    const appended = await this.events.appendAtomicAfter({
      envelope,
      scope: "conversation:system_stage",
      key: noticeId,
      requestHash,
    }, (database) => [
      database.prepare(`INSERT INTO conversation_deliveries (
        delivery_id, correlation_id, turn_id, staged_event_id, principal_id, target_identity_id,
        reply_to_message_id, history_mode, material_hash, provider_idempotency_key, state,
        attempt_count, available_at, lease_token_hash, claimed_at, lease_expires_at, resolved_at,
        provider_message_id, delivered_assistant_event_id, failure_code, failure_category, created_at, updated_at
      ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 'system', ?7, ?8, 'pending',
        0, ?9, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?10, ?11)`)
        .bind(
          deliveryId, noticeId, envelope.eventId, principalId, targetIdentityId, replyToMessageId,
          materialHash, providerIdempotencyKey, observedAt.iso, observedAt.iso, observedAt.iso,
        ),
    ]);
    const row = await this.database.prepare(
      "SELECT * FROM conversation_deliveries WHERE staged_event_id = ?1",
    ).bind(appended.envelope.eventId).first<ConversationDeliveryRow>();
    if (row === null) throw new Error("system_notice_missing_after_commit");
    return this.toStoredDelivery(row);
  }

  async readDelivery(deliveryIdValue: ConversationDeliveryId): Promise<StoredConversationDelivery | null> {
    const deliveryId = requireDeliveryId(deliveryIdValue);
    const row = await this.readDeliveryRow(deliveryId);
    return row === null ? null : this.toStoredDelivery(row);
  }

  async claimDelivery(input: { deliveryId: ConversationDeliveryId; now: Date }): Promise<DeliveryDispatchClaim> {
    const captured = exactDataRecord(input, ["deliveryId", "now"], "delivery_claim_input_invalid");
    const deliveryId = requireDeliveryId(captured.deliveryId);
    const observedAt = snapshotDate(captured.now, "delivery_claim_now");
    let current = await this.readDeliveryRow(deliveryId);
    if (current === null) throw new Error("conversation_delivery_missing");
    if (current.state === "claimed" && current.lease_expires_at !== null && current.lease_expires_at <= observedAt.iso) {
      current = await this.expireClaimedDelivery(current, observedAt.iso);
    }
    if (TERMINAL_DELIVERY_STATES.has(current.state as ConversationDeliveryState)) {
      return Object.freeze({ kind: "terminal", item: this.toStoredDelivery(current) });
    }
    if (current.state === "claimed" || current.state === "retry_wait" && current.available_at > observedAt.iso) {
      return Object.freeze({ kind: "in_progress", item: this.toStoredDelivery(current) });
    }
    if (current.state !== "pending" && current.state !== "retry_wait") {
      return Object.freeze({ kind: "in_progress", item: this.toStoredDelivery(current) });
    }

    const tokenHash = await sha256Hex(snapshotToken(this.leaseTokenFactory, "delivery_lease_token"));
    const expiresAt = new Date(observedAt.epochMs + this.leaseTtlMs).toISOString();
    const claimed = await this.database.prepare(`UPDATE conversation_deliveries
      SET state = 'claimed', attempt_count = attempt_count + 1,
          lease_token_hash = ?1, claimed_at = ?2, lease_expires_at = ?3,
          resolved_at = NULL, failure_code = NULL, failure_category = NULL, updated_at = ?4
      WHERE delivery_id = ?5 AND state IN ('pending', 'retry_wait') AND available_at <= ?6 AND attempt_count < 3
        AND EXISTS (
          SELECT 1 FROM channel_identities i JOIN principals p ON p.principal_id = i.principal_id
          WHERE i.identity_id = conversation_deliveries.target_identity_id
            AND i.principal_id = conversation_deliveries.principal_id
            AND i.channel = 'telegram' AND i.status = 'active' AND i.verified_at IS NOT NULL
            AND p.status = 'active'
        )
      RETURNING *`)
      .bind(tokenHash, observedAt.iso, expiresAt, observedAt.iso, deliveryId, observedAt.iso)
      .first<ConversationDeliveryRow>();
    if (claimed !== null) {
      const stored = this.toStoredDelivery(claimed);
      const text = await this.readValidatedStagedText(claimed);
      const item = Object.freeze({ ...stored, state: "claimed" as const, text }) as ClaimedConversationDelivery;
      const capability = Object.freeze({ deliveryId, materialHash: stored.materialHash }) as DeliveryLeaseCapability;
      this.deliveryLeaseBindings.set(capability, Object.freeze({
        deliveryId,
        correlationId: stored.correlationId,
        turnId: stored.turnId,
        stagedEventId: stored.stagedEventId,
        principalId: stored.principalId,
        targetIdentityId: stored.targetIdentityId,
        historyMode: stored.historyMode,
        materialHash: stored.materialHash,
        providerIdempotencyKey: stored.providerIdempotencyKey,
        leaseTokenHash: tokenHash,
      }));
      return Object.freeze({ kind: "claimed", capability, item });
    }

    current = await this.readDeliveryRow(deliveryId);
    if (current === null) throw new Error("conversation_delivery_missing");
    if (current.state === "claimed") return Object.freeze({ kind: "in_progress", item: this.toStoredDelivery(current) });
    if (TERMINAL_DELIVERY_STATES.has(current.state as ConversationDeliveryState)) {
      return Object.freeze({ kind: "terminal", item: this.toStoredDelivery(current) });
    }
    return Object.freeze({ kind: "unavailable", item: this.toStoredDelivery(current) });
  }

  beginDelivery(
    capability: DeliveryLeaseCapability,
    expectedDeliveryId: ConversationDeliveryId,
    expectedMaterialHash: Sha256Hex,
  ): void {
    const binding = this.deliveryLeaseBindings.get(capability);
    if (
      binding === undefined
      || binding.deliveryId !== expectedDeliveryId
      || binding.materialHash !== expectedMaterialHash
      || this.begunDeliveryLeases.has(capability)
      || this.settledDeliveryLeases.has(capability)
    ) {
      throw new Error("delivery_lease_invalid");
    }
    this.begunDeliveryLeases.add(capability);
  }

  mintProviderDeliveryReceipt(input: {
    capability: DeliveryLeaseCapability;
    providerMessageId: string;
  }): ProviderDeliveryReceipt {
    const captured = exactDataRecord(input, ["capability", "providerMessageId"], "provider_delivery_receipt_invalid");
    const capability = captured.capability as DeliveryLeaseCapability;
    const binding = this.deliveryLeaseBindings.get(capability);
    const providerMessageId = requireSafeText(captured.providerMessageId, "provider_message_id", 128);
    if (
      binding === undefined
      || !this.begunDeliveryLeases.has(capability)
      || this.settledDeliveryLeases.has(capability)
      || this.issuedReceiptForLease.has(capability)
    ) {
      throw new Error("provider_delivery_receipt_invalid");
    }
    const receipt = Object.freeze({
      deliveryId: binding.deliveryId,
      targetIdentityId: binding.targetIdentityId,
      providerIdempotencyKey: binding.providerIdempotencyKey,
      materialHash: binding.materialHash,
      providerMessageId,
    }) as ProviderDeliveryReceipt;
    this.providerReceiptBindings.set(receipt, capability);
    this.issuedReceiptForLease.set(capability, receipt);
    return receipt;
  }

  async recordDeliverySuccess(input: {
    capability: DeliveryLeaseCapability;
    receipt: ProviderDeliveryReceipt;
    now: Date;
  }): Promise<StoredConversationDelivery> {
    const captured = exactDataRecord(input, ["capability", "receipt", "now"], "delivery_success_input_invalid");
    const capability = captured.capability as DeliveryLeaseCapability;
    const receipt = captured.receipt as ProviderDeliveryReceipt;
    const binding = this.deliveryLeaseBindings.get(capability);
    if (binding === undefined || this.providerReceiptBindings.get(receipt) !== capability) {
      throw new Error("provider_delivery_receipt_invalid");
    }
    if (this.settledDeliveryLeases.has(capability)) {
      const durable = await this.readDeliveryRow(binding.deliveryId);
      if (
        this.consumedProviderReceipts.has(receipt)
        && durable?.state === "delivered"
        && durable.provider_message_id === receipt.providerMessageId
      ) return this.toStoredDelivery(durable);
      throw new Error("delivery_settlement_unknown");
    }
    const observedAt = snapshotDate(captured.now, "delivery_success_now");
    this.settleDeliveryLease(capability);
    this.consumedProviderReceipts.add(receipt);
    const row = await this.readDeliveryRow(binding.deliveryId);
    if (row === null || row.state !== "claimed" || row.lease_token_hash !== binding.leaseTokenHash) {
      throw new Error("delivery_lease_invalid");
    }
    const text = await this.readValidatedStagedText(row);
    const issuedText = sanitizeRedaction(text);
    if (!issuedText.ok) throw new Error("delivery_staged_text_invalid");
    const eventId = requireUlid(this.eventIdFactory(), "conversation_event_id");
    const eventType = binding.historyMode === "assistant"
      ? "conversation.assistant_delivered"
      : "conversation.system_delivered";
    const payload = binding.historyMode === "assistant" ? historyPayload("telegram", issuedText, true) : systemPayload(issuedText);
    const envelope = await this.createConversationEnvelope({
      eventId,
      eventType,
      principalId: binding.principalId,
      correlationId: binding.correlationId,
      causationId: binding.stagedEventId,
      payload,
      nowIso: observedAt.iso,
    });
    const requestHash = await sha256Hex(canonicalJson([
      "delivery-success-v1", binding.deliveryId, binding.materialHash, receipt.providerMessageId,
    ]));
    const dependencies = (database: D1Database): D1PreparedStatement[] => {
      const deliveryUpdate = database.prepare(`UPDATE conversation_deliveries
        SET state = 'delivered', resolved_at = ?1, provider_message_id = ?2,
            delivered_assistant_event_id = ?3, updated_at = ?4
        WHERE delivery_id = ?5 AND state = 'claimed' AND lease_token_hash = ?6`)
        .bind(
          observedAt.iso,
          receipt.providerMessageId,
          binding.historyMode === "assistant" ? envelope.eventId : null,
          observedAt.iso,
          binding.deliveryId,
          binding.leaseTokenHash,
        );
      if (binding.historyMode === "system") return [deliveryUpdate];
      return [
        deliveryUpdate,
        database.prepare(`UPDATE conversation_turns
          SET state = 'delivered', delivered_assistant_event_id = ?1, resolved_at = ?2, updated_at = ?3
          WHERE turn_id = ?4 AND state = 'assistant_staged' AND staged_delivery_id = ?5`)
          .bind(envelope.eventId, observedAt.iso, observedAt.iso, binding.turnId, binding.deliveryId),
      ];
    };
    await this.events.appendAtomicAfter({
      envelope,
      scope: "conversation:delivery_success",
      key: binding.deliveryId,
      requestHash,
    }, dependencies);
    const stored = await this.readDeliveryRow(binding.deliveryId);
    if (stored === null || stored.state !== "delivered" || stored.provider_message_id !== receipt.providerMessageId) {
      throw new Error("delivery_settlement_unknown");
    }
    return this.toStoredDelivery(stored);
  }

  async recordDeliveryFailure(input: {
    capability: DeliveryLeaseCapability;
    failure: unknown;
    now: Date;
  }): Promise<StoredConversationDelivery> {
    const captured = exactDataRecord(input, ["capability", "failure", "now"], "delivery_failure_input_invalid");
    const capability = captured.capability as DeliveryLeaseCapability;
    const binding = this.deliveryLeaseBindings.get(capability);
    if (binding === undefined) throw new Error("delivery_lease_invalid");
    const observedAt = snapshotDate(captured.now, "delivery_failure_now");
    const failure = this.classifyDeliveryFailure(captured.failure);
    this.settleDeliveryLease(capability);
    const row = await this.readDeliveryRow(binding.deliveryId);
    if (row === null || row.state !== "claimed" || row.lease_token_hash !== binding.leaseTokenHash) {
      throw new Error("delivery_lease_invalid");
    }
    const terminal = failure.state !== "retry_wait" || row.attempt_count >= 3;
    const state: "retry_wait" | "failed" | "unknown" = failure.state === "retry_wait" && row.attempt_count >= 3
      ? "failed"
      : failure.state;
    const code: ConversationFailureCode = failure.state === "retry_wait" && row.attempt_count >= 3
      ? "delivery_retry_exhausted"
      : failure.code;
    const category = failure.category;
    const eventType = state === "retry_wait"
      ? "conversation.delivery_retry"
      : state === "failed" ? "conversation.delivery_failed" : "conversation.delivery_unknown";
    const envelope = await this.createConversationEnvelope({
      eventId: requireUlid(this.eventIdFactory(), "conversation_event_id"),
      eventType,
      principalId: binding.principalId,
      correlationId: binding.correlationId,
      causationId: binding.stagedEventId,
      payload: safeFailurePayload("telegram", code, category),
      nowIso: observedAt.iso,
    });
    const requestHash = await sha256Hex(canonicalJson([
      "delivery-failure-v1", binding.deliveryId, row.attempt_count, state, code, category,
    ]));
    const availableAt = new Date(observedAt.epochMs + this.retryDelayMs).toISOString();
    await this.events.appendAtomicAfter({
      envelope,
      scope: "conversation:delivery_failure",
      key: `${binding.deliveryId}:${row.attempt_count}`,
      requestHash,
    }, (database) => {
      const deliveryUpdate = database.prepare(`UPDATE conversation_deliveries
        SET state = ?1, available_at = ?2, resolved_at = ?3,
            failure_code = ?4, failure_category = ?5, updated_at = ?6
        WHERE delivery_id = ?7 AND state = 'claimed' AND lease_token_hash = ?8`)
        .bind(state, state === "retry_wait" ? availableAt : row.available_at, observedAt.iso, code, category, observedAt.iso, binding.deliveryId, binding.leaseTokenHash);
      if (!terminal || binding.historyMode === "system") return [deliveryUpdate];
      return [
        deliveryUpdate,
        database.prepare(`UPDATE conversation_turns
          SET state = ?1, resolved_at = ?2, failure_code = ?3, failure_category = ?4, updated_at = ?5
          WHERE turn_id = ?6 AND state = 'assistant_staged' AND staged_delivery_id = ?7`)
          .bind(state === "unknown" ? "delivery_unknown" : "failed", observedAt.iso, code, category, observedAt.iso, binding.turnId, binding.deliveryId),
      ];
    });
    const stored = await this.readDeliveryRow(binding.deliveryId);
    if (stored === null) throw new Error("conversation_delivery_missing_after_settlement");
    return this.toStoredDelivery(stored);
  }

  private async recordModelTerminal(
    input: { claim: ModelStreamClaimCapability; now: Date },
    state: "cancelled" | "failed" | "model_outcome_unknown",
    code: "model_cancelled" | "model_failed" | "model_outcome_unknown",
    category: "cancelled" | "provider" | "ambiguous",
    eventType: "conversation.turn_cancelled" | "conversation.turn_failed",
  ): Promise<StoredConversationTurn> {
    const captured = exactDataRecord(input, ["claim", "now"], "model_terminal_input_invalid");
    const claim = captured.claim as ModelStreamClaimCapability;
    const observedAt = snapshotDate(captured.now, "model_terminal_now");
    const binding = state === "model_outcome_unknown"
      ? this.settleAmbiguousModelClaim(claim)
      : this.settleModelClaim(claim);
    const envelope = await this.createConversationEnvelope({
      eventId: requireUlid(this.eventIdFactory(), "conversation_event_id"),
      eventType,
      principalId: binding.principalId,
      correlationId: binding.turnId,
      causationId: binding.userEventId,
      payload: safeFailurePayload(binding.channel, code, category),
      nowIso: observedAt.iso,
    });
    const requestHash = await sha256Hex(canonicalJson(["model-terminal-v1", binding.turnId, state, code]));
    await this.events.appendAtomicAfter({ envelope, scope: "conversation:model_terminal", key: binding.turnId, requestHash }, (database) => [
      database.prepare(`UPDATE conversation_turns
        SET state = ?1, resolved_at = ?2, failure_code = ?3, failure_category = ?4, updated_at = ?5
        WHERE turn_id = ?6 AND state = 'model_claimed' AND model_claim_token_hash = ?7`)
        .bind(state, observedAt.iso, code, category, observedAt.iso, binding.turnId, binding.claimTokenHash),
    ]);
    const row = await this.readTurn(binding.turnId);
    if (row === null) throw new Error("conversation_turn_missing_after_commit");
    return this.toStoredTurn(row);
  }

  private classifyDeliveryFailure(value: unknown): {
    state: "retry_wait" | "failed" | "unknown";
    code: ConversationFailureCode;
    category: ConversationFailureCategory;
  } {
    const facts = snapshotProviderFailure(value);
    if (facts?.code === "provider_transient_failure" && (facts.category === "rate_limited" || facts.category === "temporarily_unavailable")) {
      return { state: "retry_wait", code: "delivery_retry", category: "provider" };
    }
    if (facts?.code === "provider_authentication_failure") {
      return { state: "failed", code: "delivery_authentication", category: "authentication" };
    }
    if (facts?.code === "provider_permanent_failure" || facts?.code === "provider_policy_denied") {
      return { state: "failed", code: "delivery_permanent", category: "invalid_request" };
    }
    if (value instanceof ProviderIdempotencyConflictError) {
      return { state: "failed", code: "delivery_idempotency_conflict", category: "idempotency_conflict" };
    }
    return { state: "unknown", code: "delivery_unknown", category: "ambiguous" };
  }

  private settleModelClaim(claim: ModelStreamClaimCapability): ModelClaimBinding {
    const binding = this.modelClaimBindings.get(claim);
    if (binding === undefined || !this.begunModelClaims.has(claim) || this.settledModelClaims.has(claim)) {
      throw new Error("model_stream_claim_invalid");
    }
    this.settledModelClaims.add(claim);
    return binding;
  }

  private settleAmbiguousModelClaim(claim: ModelStreamClaimCapability): ModelClaimBinding {
    const binding = this.modelClaimBindings.get(claim);
    if (binding === undefined || this.settledModelClaims.has(claim)) {
      throw new Error("model_stream_claim_invalid");
    }
    this.settledModelClaims.add(claim);
    return binding;
  }

  private settleDeliveryLease(capability: DeliveryLeaseCapability): DeliveryLeaseBinding {
    const binding = this.deliveryLeaseBindings.get(capability);
    if (binding === undefined || !this.begunDeliveryLeases.has(capability) || this.settledDeliveryLeases.has(capability)) {
      throw new Error("delivery_lease_invalid");
    }
    this.settledDeliveryLeases.add(capability);
    return binding;
  }

  private async expireClaimedDelivery(row: ConversationDeliveryRow, nowIso: string): Promise<ConversationDeliveryRow> {
    const deliveryId = requireDeliveryId(row.delivery_id);
    const correlationId = requireUlid(row.correlation_id, "conversation_delivery_correlation_id");
    const stagedEventId = requireUlid(row.staged_event_id, "conversation_staged_event_id");
    const principalId = requireSafeText(row.principal_id, "conversation_principal_id");
    const envelope = await this.createConversationEnvelope({
      eventId: requireUlid(this.eventIdFactory(), "conversation_event_id"),
      eventType: "conversation.delivery_unknown",
      principalId,
      correlationId,
      causationId: stagedEventId,
      payload: safeFailurePayload("telegram", "delivery_unknown", "ambiguous"),
      nowIso,
    });
    const requestHash = await sha256Hex(canonicalJson(["delivery-expired-v1", deliveryId, row.lease_expires_at]));
    await this.events.appendAtomicAfter({ envelope, scope: "conversation:delivery_expired", key: deliveryId, requestHash }, (database) => {
      const deliveryUpdate = database.prepare(`UPDATE conversation_deliveries
        SET state = 'unknown', resolved_at = ?1, failure_code = 'delivery_unknown',
            failure_category = 'ambiguous', updated_at = ?2
        WHERE delivery_id = ?3 AND state = 'claimed' AND lease_expires_at <= ?4`)
        .bind(nowIso, nowIso, deliveryId, nowIso);
      if (row.history_mode === "system") return [deliveryUpdate];
      return [
        deliveryUpdate,
        database.prepare(`UPDATE conversation_turns
          SET state = 'delivery_unknown', resolved_at = ?1, failure_code = 'delivery_unknown',
              failure_category = 'ambiguous', updated_at = ?2
          WHERE turn_id = ?3 AND state = 'assistant_staged' AND staged_delivery_id = ?4`)
          .bind(nowIso, nowIso, row.turn_id, deliveryId),
      ];
    });
    const stored = await this.readDeliveryRow(deliveryId);
    if (stored === null) throw new Error("conversation_delivery_missing_after_expiry");
    return stored;
  }

  private async createConversationEnvelope(input: {
    eventId: Ulid;
    eventType: string;
    principalId: string;
    correlationId: Ulid;
    causationId?: Ulid;
    payload: Parameters<typeof createEnvelope>[0]["payload"];
    nowIso: string;
  }): Promise<PersistableEventEnvelopeV1> {
    return createEnvelope({
      schemaVersion: "1.0",
      eventId: input.eventId,
      eventType: input.eventType,
      source: CONVERSATION_EVENT_SOURCE,
      subjectId: input.principalId,
      occurredAt: input.nowIso,
      receivedAt: input.nowIso,
      correlationId: input.correlationId,
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      contentType: "application/json",
      payload: input.payload,
      producerVersion: CONVERSATION_EVENT_PRODUCER_VERSION,
    });
  }

  private readTurn(turnId: Ulid): Promise<ConversationTurnRow | null> {
    return this.database.prepare("SELECT * FROM conversation_turns WHERE turn_id = ?1").bind(turnId).first<ConversationTurnRow>();
  }

  private readDeliveryRow(deliveryId: ConversationDeliveryId): Promise<ConversationDeliveryRow | null> {
    return this.database.prepare("SELECT * FROM conversation_deliveries WHERE delivery_id = ?1").bind(deliveryId).first<ConversationDeliveryRow>();
  }

  private requireTurnLineage(
    row: ConversationTurnRow,
    expected: { sessionId: string; principalId: string; channel: ConversationChannel; requestHash: Sha256Hex },
  ): StoredConversationTurn {
    if (
      row.session_id !== expected.sessionId
      || row.principal_id !== expected.principalId
      || row.channel !== expected.channel
      || row.request_hash !== expected.requestHash
    ) throw new Error("conversation_turn_conflict");
    return this.toStoredTurn(row);
  }

  private toStoredTurn(row: ConversationTurnRow): StoredConversationTurn {
    const turnId = requireUlid(row.turn_id, "conversation_turn_id");
    const channel = requireChannel(row.channel);
    if (!isTurnState(row.state)) throw new Error("conversation_turn_row_invalid");
    const failureCode = row.failure_code === null ? null : requireFailureCode(row.failure_code);
    const failureCategory = row.failure_category === null ? null : requireFailureCategory(row.failure_category);
    return Object.freeze({
      turnId,
      sessionId: requireSafeText(row.session_id, "conversation_session_id", 256),
      principalId: requireSafeText(row.principal_id, "conversation_principal_id"),
      channel,
      requestHash: requireHash(row.request_hash, "conversation_request_hash"),
      userEventId: requireUlid(row.user_event_id, "conversation_user_event_id"),
      state: row.state,
      modelClaimedAt: row.model_claimed_at === null ? null : requireTimestamp(row.model_claimed_at, "model_claimed_at"),
      modelClaimExpiresAt: row.model_claim_expires_at === null ? null : requireTimestamp(row.model_claim_expires_at, "model_claim_expires_at"),
      resolvedAt: row.resolved_at === null ? null : requireTimestamp(row.resolved_at, "conversation_resolved_at"),
      stagedDeliveryId: row.staged_delivery_id === null ? null : requireDeliveryId(row.staged_delivery_id),
      sentAssistantEventId: row.sent_assistant_event_id === null ? null : requireUlid(row.sent_assistant_event_id, "sent_assistant_event_id"),
      deliveredAssistantEventId: row.delivered_assistant_event_id === null ? null : requireUlid(row.delivered_assistant_event_id, "delivered_assistant_event_id"),
      failureCode,
      failureCategory,
      createdAt: requireTimestamp(row.created_at, "conversation_created_at"),
      updatedAt: requireTimestamp(row.updated_at, "conversation_updated_at"),
    });
  }

  private toStoredDelivery(row: ConversationDeliveryRow): StoredConversationDelivery {
    if (!isDeliveryState(row.state) || row.history_mode !== "assistant" && row.history_mode !== "system") {
      throw new Error("conversation_delivery_row_invalid");
    }
    if (!Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 || row.attempt_count > 3) {
      throw new Error("conversation_delivery_row_invalid");
    }
    if (!DELIVERY_IDEMPOTENCY_KEY.test(row.provider_idempotency_key)) throw new Error("conversation_delivery_row_invalid");
    return Object.freeze({
      deliveryId: requireDeliveryId(row.delivery_id),
      correlationId: requireUlid(row.correlation_id, "conversation_delivery_correlation_id"),
      turnId: row.turn_id === null ? null : requireUlid(row.turn_id, "conversation_delivery_turn_id"),
      stagedEventId: requireUlid(row.staged_event_id, "conversation_staged_event_id"),
      principalId: requireSafeText(row.principal_id, "conversation_principal_id"),
      targetIdentityId: requireSafeText(row.target_identity_id, "target_identity_id"),
      replyToMessageId: requireReplyMessageId(row.reply_to_message_id),
      historyMode: row.history_mode,
      materialHash: requireHash(row.material_hash, "conversation_material_hash"),
      providerIdempotencyKey: row.provider_idempotency_key,
      state: row.state,
      attemptCount: row.attempt_count,
      availableAt: requireTimestamp(row.available_at, "conversation_delivery_available_at"),
      claimedAt: row.claimed_at === null ? null : requireTimestamp(row.claimed_at, "conversation_delivery_claimed_at"),
      leaseExpiresAt: row.lease_expires_at === null ? null : requireTimestamp(row.lease_expires_at, "conversation_delivery_lease_expires_at"),
      resolvedAt: row.resolved_at === null ? null : requireTimestamp(row.resolved_at, "conversation_delivery_resolved_at"),
      providerMessageId: row.provider_message_id === null ? null : requireSafeText(row.provider_message_id, "provider_message_id", 128),
      deliveredAssistantEventId: row.delivered_assistant_event_id === null ? null : requireUlid(row.delivered_assistant_event_id, "delivered_assistant_event_id"),
      failureCode: row.failure_code === null ? null : requireFailureCode(row.failure_code),
      failureCategory: row.failure_category === null ? null : requireFailureCategory(row.failure_category),
      createdAt: requireTimestamp(row.created_at, "conversation_delivery_created_at"),
      updatedAt: requireTimestamp(row.updated_at, "conversation_delivery_updated_at"),
    });
  }

  private async readValidatedStagedText(row: ConversationDeliveryRow): Promise<string> {
    const event = await this.database.prepare(
      "SELECT event_type, subject_id, content_hash, envelope_json FROM events WHERE event_id = ?1",
    ).bind(row.staged_event_id).first<StoredEventRow>();
    if (event === null) throw new Error("conversation_staged_event_missing");
    let raw: unknown;
    try { raw = JSON.parse(event.envelope_json); }
    catch { throw new Error("conversation_staged_event_invalid"); }
    const envelope = await validateEnvelope(raw);
    if (
      envelope.contentHash !== event.content_hash
      || envelope.eventId !== row.staged_event_id
      || envelope.subjectId !== row.principal_id
      || envelope.correlationId !== row.correlation_id
      || envelope.source !== CONVERSATION_EVENT_SOURCE
      || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION
    ) throw new Error("conversation_staged_event_invalid");
    if (row.history_mode === "assistant") {
      const payload = exactPayload(envelope.payload, ["schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text"]);
      if (
        event.event_type !== "conversation.assistant_staged"
        || envelope.causationId === undefined
        || payload.schemaCode !== 1
        || payload.channelCode !== 2
        || payload.sensitivityCode !== 1
        || payload.historyEligible !== false
      ) throw new Error("conversation_staged_event_invalid");
      return requireSafeText(payload.text, "conversation_staged_text", 65536);
    }
    const payload = exactPayload(envelope.payload, ["schemaCode", "channelCode", "noticeCode", "historyEligible", "text"]);
    if (
      event.event_type !== "conversation.system_staged"
      || envelope.causationId !== undefined
      || payload.schemaCode !== 1
      || payload.channelCode !== 2
      || payload.noticeCode !== 1
      || payload.historyEligible !== false
    ) throw new Error("conversation_staged_event_invalid");
    return requireSafeText(payload.text, "conversation_staged_text", 65536);
  }
}

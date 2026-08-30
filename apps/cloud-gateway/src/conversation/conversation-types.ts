import {
  sha256Hex,
  type Sha256Hex,
  type SuccessfulRedaction,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";

export type ConversationChannel = "voice" | "telegram";

declare const conversationDeliveryIdBrand: unique symbol;
export type ConversationDeliveryId = string & { readonly [conversationDeliveryIdBrand]: true };

declare const modelStreamClaimBrand: unique symbol;
export interface ModelStreamClaimCapability {
  readonly turnId: Ulid;
  readonly requestHash: Sha256Hex;
  readonly [modelStreamClaimBrand]: true;
}

declare const deliveryLeaseBrand: unique symbol;
export interface DeliveryLeaseCapability {
  readonly deliveryId: ConversationDeliveryId;
  readonly materialHash: Sha256Hex;
  readonly [deliveryLeaseBrand]: true;
}

declare const providerDeliveryReceiptBrand: unique symbol;
export interface ProviderDeliveryReceipt {
  readonly deliveryId: ConversationDeliveryId;
  readonly targetIdentityId: string;
  readonly providerIdempotencyKey: string;
  readonly materialHash: Sha256Hex;
  readonly providerMessageId: string;
  readonly [providerDeliveryReceiptBrand]: true;
}

declare const voiceSentReceiptBrand: unique symbol;
export interface VoiceSentReceipt {
  readonly sessionId: string;
  readonly turnId: Ulid;
  readonly contentHash: Sha256Hex;
  readonly [voiceSentReceiptBrand]: true;
}

export interface ModelToken {
  readonly index: number;
  readonly text: string;
}

export interface RetrievedContext {
  readonly sourceEventId: Ulid;
  readonly text: string;
  readonly sensitivity: "personal" | "restricted";
}

export interface ModelAdapterStreamInput {
  readonly correlationId: Ulid;
  readonly principalId: string;
  readonly channel: ConversationChannel;
  readonly userText: string;
  readonly context: readonly RetrievedContext[];
  readonly reasoningEffort: "none" | "low" | "high" | "max";
  readonly firstTokenTimeoutMs: number;
  readonly timeoutMs: number;
  readonly contextTokenBudget: number;
  readonly maxOutputCharacters: number;
  readonly signal: AbortSignal;
}

export interface ModelAdapter {
  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken>;
}

export type ConversationDelivery =
  | {
    readonly channel: "voice";
    readonly kind: "voice_stream";
    readonly onToken: (token: ModelToken) => Promise<void>;
    readonly finish: (finalText: string) => Promise<VoiceSentReceipt>;
  }
  | {
    readonly channel: "telegram";
    readonly kind: "outbox";
    readonly targetIdentityId: string;
    readonly replyToMessageId: number | null;
  };

interface ConversationTurnCommonInput {
  readonly sessionId: string;
  readonly principalId: string;
  readonly turnId: Ulid;
  readonly text: string;
  readonly signal: AbortSignal;
}

export type ConversationHandleTurnInput = ConversationTurnCommonInput & ConversationDelivery;

export type ConversationTurnOutcome =
  | "voice_sent"
  | "telegram_staged"
  | "telegram_delivered"
  | "in_progress"
  | "cancelled"
  | "failed"
  | "model_outcome_unknown"
  | "delivery_unknown";

export interface ConversationTurnResult {
  readonly outcome: ConversationTurnOutcome;
  readonly committedUserEventId: Ulid;
  readonly sentAssistantEventId: Ulid | null;
  readonly deliveryId: ConversationDeliveryId | null;
  readonly deliveredAssistantEventId: Ulid | null;
}

export interface StageSystemNoticeInput {
  readonly noticeId: Ulid;
  readonly sessionId: string;
  readonly principalId: string;
  readonly channel: "telegram";
  readonly noticeCode: "busy";
  readonly targetIdentityId: string;
  readonly replyToMessageId: number | null;
}

export interface ConversationService {
  handleTurn(input: ConversationHandleTurnInput): Promise<ConversationTurnResult>;
  stageSystemNotice(input: StageSystemNoticeInput): Promise<ConversationDeliveryId>;
}

export interface ContextRetrieverInput {
  readonly principalId: string;
  readonly channel: ConversationChannel;
  readonly purpose: "conversation";
  readonly query: string;
  readonly maxTokens: number;
}

export interface ContextRetriever {
  retrieve(input: ContextRetrieverInput): Promise<readonly RetrievedContext[]>;
}

export type OutboxDispatchOutcome =
  | "delivered"
  | "already_delivered"
  | "in_progress"
  | "retry_scheduled"
  | "failed"
  | "unknown";

export interface OutboxDispatchResult {
  readonly outcome: OutboxDispatchOutcome;
  readonly deliveredAssistantEventId: Ulid | null;
}

export interface OutboxDispatcher {
  dispatch(deliveryId: ConversationDeliveryId): Promise<OutboxDispatchResult>;
}

export type ConversationTurnState =
  | "user_committed"
  | "model_claimed"
  | "assistant_staged"
  | "voice_sent"
  | "delivered"
  | "cancelled"
  | "failed"
  | "model_outcome_unknown"
  | "delivery_unknown";

export interface StoredConversationTurn {
  readonly turnId: Ulid;
  readonly sessionId: string;
  readonly principalId: string;
  readonly channel: ConversationChannel;
  readonly requestHash: Sha256Hex;
  readonly userEventId: Ulid;
  readonly state: ConversationTurnState;
  readonly modelClaimedAt: string | null;
  readonly modelClaimExpiresAt: string | null;
  readonly resolvedAt: string | null;
  readonly stagedDeliveryId: ConversationDeliveryId | null;
  readonly sentAssistantEventId: Ulid | null;
  readonly deliveredAssistantEventId: Ulid | null;
  readonly failureCode: ConversationFailureCode | null;
  readonly failureCategory: ConversationFailureCategory | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationTurnAdmission {
  readonly turn: StoredConversationTurn;
  readonly replayed: boolean;
}

export type ModelTurnClaim =
  | {
    readonly kind: "claimed";
    readonly capability: ModelStreamClaimCapability;
    readonly turn: StoredConversationTurn;
  }
  | { readonly kind: "in_progress"; readonly turn: StoredConversationTurn }
  | { readonly kind: "terminal"; readonly turn: StoredConversationTurn };

export type ConversationDeliveryState = "pending" | "claimed" | "delivered" | "retry_wait" | "failed" | "unknown";
export type ConversationHistoryMode = "assistant" | "system";

export interface StoredConversationDelivery {
  readonly deliveryId: ConversationDeliveryId;
  readonly correlationId: Ulid;
  readonly turnId: Ulid | null;
  readonly stagedEventId: Ulid;
  readonly principalId: string;
  readonly targetIdentityId: string;
  readonly replyToMessageId: number | null;
  readonly historyMode: ConversationHistoryMode;
  readonly materialHash: Sha256Hex;
  readonly providerIdempotencyKey: string;
  readonly state: ConversationDeliveryState;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly claimedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly resolvedAt: string | null;
  readonly providerMessageId: string | null;
  readonly deliveredAssistantEventId: Ulid | null;
  readonly failureCode: ConversationFailureCode | null;
  readonly failureCategory: ConversationFailureCategory | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimedConversationDelivery extends StoredConversationDelivery {
  readonly state: "claimed";
  readonly text: string;
}

export type DeliveryDispatchClaim =
  | {
    readonly kind: "claimed";
    readonly capability: DeliveryLeaseCapability;
    readonly item: ClaimedConversationDelivery;
  }
  | { readonly kind: "in_progress"; readonly item: StoredConversationDelivery }
  | { readonly kind: "unavailable"; readonly item: StoredConversationDelivery }
  | { readonly kind: "terminal"; readonly item: StoredConversationDelivery };

export interface AssistantStageResult {
  readonly turn: StoredConversationTurn;
  readonly delivery: StoredConversationDelivery;
}

export type ConversationFailureCode =
  | "ingest_redaction_failed"
  | "model_cancelled"
  | "model_failed"
  | "model_outcome_unknown"
  | "delivery_retry"
  | "delivery_authentication"
  | "delivery_permanent"
  | "delivery_idempotency_conflict"
  | "delivery_retry_exhausted"
  | "delivery_unknown";

export type ConversationFailureCategory =
  | "ingest"
  | "cancelled"
  | "provider"
  | "authentication"
  | "invalid_request"
  | "idempotency_conflict"
  | "ambiguous";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const issuedVoiceReceipts = new WeakSet<object>();
const consumedVoiceReceipts = new WeakSet<object>();

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

function requireSafeText(value: unknown, label: string, maximumBytes = 65536): string {
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

function requireUlid(value: unknown, label: string): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(`${label}_invalid`);
  return value as Ulid;
}

function captureModelToken(value: unknown): Readonly<ModelToken> {
  const captured = exactDataRecord(value, ["index", "text"], "voice_stream_token_invalid");
  if (!Number.isSafeInteger(captured.index) || (captured.index as number) < 0) {
    throw new TypeError("voice_stream_token_invalid");
  }
  return Object.freeze({
    index: captured.index as number,
    text: requireSafeText(captured.text, "voice_stream_token"),
  });
}

export interface CreateVoiceStreamDeliveryInput {
  readonly sessionId: string;
  readonly turnId: Ulid;
  readonly sendToken: (token: ModelToken) => Promise<void>;
  readonly finish: (finalText: string) => Promise<void>;
}

/** Captures low-level relay functions and mints one receipt only after an exact contiguous stream finishes. */
export function createVoiceStreamDelivery(input: CreateVoiceStreamDeliveryInput): Extract<ConversationDelivery, { channel: "voice" }> {
  const captured = exactDataRecord(input, ["sessionId", "turnId", "sendToken", "finish"], "voice_stream_delivery_invalid");
  const sessionId = requireSafeText(captured.sessionId, "voice_stream_session", 256);
  const turnId = requireUlid(captured.turnId, "voice_stream_turn_id");
  const sendToken = captured.sendToken;
  const finishProvider = captured.finish;
  if (typeof sendToken !== "function" || typeof finishProvider !== "function") {
    throw new TypeError("voice_stream_delivery_invalid");
  }

  let expectedIndex = 0;
  let inFlight = false;
  let finished = false;
  let poisoned = false;
  const pieces: string[] = [];
  let byteLength = 0;

  const onToken = async (tokenValue: ModelToken): Promise<void> => {
    const token = captureModelToken(tokenValue);
    if (poisoned || finished || inFlight || token.index !== expectedIndex) {
      throw new Error("voice_stream_token_invalid");
    }
    const nextBytes = encoder.encode(token.text).byteLength;
    if (byteLength + nextBytes > 65536) throw new RangeError("voice_stream_token_invalid");
    inFlight = true;
    try {
      await sendToken(token);
      pieces.push(token.text);
      byteLength += nextBytes;
      expectedIndex += 1;
    } catch {
      poisoned = true;
      pieces.length = 0;
      byteLength = 0;
      throw new Error("voice_stream_delivery_failed");
    } finally {
      inFlight = false;
    }
  };

  const finish = async (finalTextValue: string): Promise<VoiceSentReceipt> => {
    const finalText = requireSafeText(finalTextValue, "voice_stream_finish");
    if (poisoned || finished || inFlight || pieces.join("") !== finalText) {
      throw new Error("voice_stream_finish_invalid");
    }
    finished = true;
    try {
      await finishProvider(finalText);
    } catch {
      poisoned = true;
      pieces.length = 0;
      byteLength = 0;
      throw new Error("voice_stream_delivery_failed");
    }
    const contentHash = await sha256Hex(finalText);
    const receipt = Object.freeze({ sessionId, turnId, contentHash }) as VoiceSentReceipt;
    issuedVoiceReceipts.add(receipt);
    return receipt;
  };

  return Object.freeze({ channel: "voice", kind: "voice_stream", onToken, finish });
}

/** Consumes an issued voice receipt after checking exact session, turn, and output material. */
export function snapshotVoiceSentReceipt(
  receipt: unknown,
  expectedValue: { readonly sessionId: string; readonly turnId: Ulid; readonly contentHash: Sha256Hex },
): Readonly<{ sessionId: string; turnId: Ulid; contentHash: Sha256Hex }> {
  const expected = exactDataRecord(expectedValue, ["sessionId", "turnId", "contentHash"], "voice_sent_receipt_invalid");
  const sessionId = requireSafeText(expected.sessionId, "voice_sent_receipt", 256);
  const turnId = requireUlid(expected.turnId, "voice_sent_receipt_turn_id");
  const contentHash = expected.contentHash;
  if (
    typeof contentHash !== "string"
    || !SHA256.test(contentHash)
    || receipt === null
    || typeof receipt !== "object"
    || !issuedVoiceReceipts.has(receipt)
    || consumedVoiceReceipts.has(receipt)
    || !Object.isFrozen(receipt)
  ) {
    throw new Error("voice_sent_receipt_invalid");
  }
  const issued = receipt as VoiceSentReceipt;
  if (issued.sessionId !== sessionId || issued.turnId !== turnId || issued.contentHash !== contentHash) {
    throw new Error("voice_sent_receipt_invalid");
  }
  consumedVoiceReceipts.add(receipt);
  return Object.freeze({ sessionId, turnId, contentHash: contentHash as Sha256Hex });
}

export interface RedactedTurnMaterial {
  readonly token: SuccessfulRedaction;
}

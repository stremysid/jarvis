import {
  isIssuedRedaction,
  type Redactor as RedactorContract,
  type SuccessfulRedaction,
} from "../../../../packages/contracts/src/calls.js";
import type { Sha256Hex, Ulid } from "../../../../packages/contracts/src/index.js";
import { ModelAdapterError, type ModelAdapter, type ModelToken } from "../model/model-adapter.js";
import { StreamingOutputRedactor } from "../security/streaming-output-redactor.js";
import type {
  AssistantStageResult,
  ContextRetriever,
  ConversationChannel,
  ConversationDeliveryId,
  ConversationHandleTurnInput,
  ModelStreamClaimCapability,
  ModelTurnClaim,
  ConversationService,
  ConversationTurnResult,
  OutboxDispatchResult,
  OutboxDispatcher,
  RetrievedContext,
  StageSystemNoticeInput,
  StoredConversationDelivery,
  StoredConversationTurn,
  VoiceSentReceipt,
} from "./conversation-types.js";
import { assertVoiceStreamDeliveryBinding } from "./conversation-types.js";
import type { ConversationRepository } from "./conversation-repository.js";

const COMMON_FIELDS = ["sessionId", "principalId", "turnId", "text", "signal", "channel", "kind"] as const;
const VOICE_FIELDS = new Set([...COMMON_FIELDS, "onToken", "finish"]);
const TELEGRAM_FIELDS = new Set([...COMMON_FIELDS, "targetIdentityId", "replyToMessageId"]);
const SYSTEM_NOTICE_FIELDS = new Set([
  "noticeId",
  "sessionId",
  "principalId",
  "channel",
  "noticeCode",
  "targetIdentityId",
  "replyToMessageId",
]);
const STORED_DELIVERY_FIELDS = new Set([
  "deliveryId",
  "correlationId",
  "turnId",
  "stagedEventId",
  "principalId",
  "targetIdentityId",
  "replyToMessageId",
  "historyMode",
  "materialHash",
  "providerIdempotencyKey",
  "state",
  "attemptCount",
  "availableAt",
  "claimedAt",
  "leaseExpiresAt",
  "resolvedAt",
  "providerMessageId",
  "deliveredAssistantEventId",
  "failureCode",
  "failureCategory",
  "createdAt",
  "updatedAt",
]);
const STORED_TURN_FIELDS = new Set([
  "turnId",
  "sessionId",
  "principalId",
  "channel",
  "requestHash",
  "userEventId",
  "state",
  "modelClaimedAt",
  "modelClaimExpiresAt",
  "resolvedAt",
  "stagedDeliveryId",
  "sentAssistantEventId",
  "deliveredAssistantEventId",
  "failureCode",
  "failureCategory",
  "createdAt",
  "updatedAt",
]);
const ADMISSION_FIELDS = new Set(["turn", "replayed"]);
const CLAIMED_MODEL_FIELDS = new Set(["kind", "capability", "turn"]);
const OBSERVED_MODEL_FIELDS = new Set(["kind", "turn"]);
const CONTEXT_FIELDS = new Set(["sourceEventId", "text", "sensitivity"]);
const ASSISTANT_STAGE_FIELDS = new Set(["turn", "delivery"]);
const DISPATCH_RESULT_FIELDS = new Set(["outcome", "deliveredAssistantEventId"]);
const DISPATCH_OUTCOMES = new Set([
  "delivered",
  "already_delivered",
  "in_progress",
  "retry_scheduled",
  "failed",
  "unknown",
]);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TURN_STATES = new Set([
  "user_committed",
  "model_claimed",
  "assistant_staged",
  "voice_sent",
  "delivered",
  "cancelled",
  "failed",
  "model_outcome_unknown",
  "delivery_unknown",
]);
const FAILURE_CODES = new Set([
  "ingest_redaction_failed",
  "model_cancelled",
  "model_failed",
  "model_outcome_unknown",
  "delivery_retry",
  "delivery_authentication",
  "delivery_permanent",
  "delivery_idempotency_conflict",
  "delivery_retry_exhausted",
  "delivery_unknown",
]);
const FAILURE_CATEGORIES = new Set([
  "ingest",
  "cancelled",
  "provider",
  "authentication",
  "invalid_request",
  "idempotency_conflict",
  "ambiguous",
]);
const DELIVERY_STATES = new Set(["pending", "claimed", "delivered", "retry_wait", "failed", "unknown"]);
const MAX_INPUT_SCALARS = 8_000;
const MAX_INPUT_BYTES = 65_536;
const MAX_OUTPUT_SCALARS = 8_000;
const encoder = new TextEncoder();

interface CapturedMethod {
  readonly receiver: object;
  readonly method: (...args: never[]) => unknown;
}

type ObserveAsyncOperation = <T>(operation: () => Promise<T>) => Promise<T>;

type ConversationRepositoryPort = Pick<ConversationRepository,
  | "getOrCreateTurn"
  | "claimModelTurn"
  | "beginModelStream"
  | "recordVoiceSent"
  | "stageAssistantDelivery"
  | "recordTurnCancelled"
  | "recordTurnFailed"
  | "recordIngestFailure"
  | "stageSystemNotice"
>;

export interface ModelBudget {
  readonly firstTokenTimeoutMs: number;
  readonly timeoutMs: number;
}

/**
 * Per-channel model deadlines.
 *
 * Voice and Telegram have genuinely different tolerances. On a call, silence
 * past a few seconds is indistinguishable from a dead line, so the first-token
 * deadline must be tight. Telegram acknowledges the message immediately and
 * the reply arrives when it arrives, so a deadline short enough for voice
 * simply aborts any question that needs reasoning over retrieved history.
 */
export const DEFAULT_MODEL_BUDGETS: Readonly<Record<ConversationChannel, ModelBudget>> = Object.freeze({
  voice: Object.freeze({ firstTokenTimeoutMs: 8_000, timeoutMs: 30_000 }),
  telegram: Object.freeze({ firstTokenTimeoutMs: 40_000, timeoutMs: 90_000 }),
});

export interface ConversationServiceDependencies {
  readonly repository: ConversationRepositoryPort;
  readonly model: ModelAdapter;
  readonly context: ContextRetriever;
  readonly dispatcher: OutboxDispatcher;
  readonly redactor: RedactorContract;
  readonly now?: () => Date;
  readonly modelBudgets?: Readonly<Record<ConversationChannel, ModelBudget>>;
  readonly observeStaging?: ObserveAsyncOperation;
}

type CapturedTurn = Readonly<ConversationHandleTurnInput>;
type CapturedSystemNotice = Readonly<StageSystemNoticeInput>;

interface OwnDataRecord {
  readonly values: Record<string, unknown>;
  readonly keys: readonly string[];
}

function ownDataRecord(value: unknown, error: string): OwnDataRecord {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(error);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(error);
  }
  if (prototype !== Object.prototype || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(error);
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of keys as readonly string[]) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { throw new TypeError(error); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    captured[field] = descriptor.value;
  }
  return Object.freeze({ values: captured, keys: Object.freeze([...(keys as readonly string[])]) });
}

function exactDataRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  const captured = ownDataRecord(value, error);
  if (captured.keys.length !== fields.size || captured.keys.some((key) => !fields.has(key))) {
    throw new TypeError(error);
  }
  return captured.values;
}

function safeText(value: unknown, label: string, maximumBytes = 256): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(label);
  }
  return value;
}

function realAbortSignal(value: unknown): AbortSignal {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (getter === undefined) throw new TypeError("conversation_signal_invalid");
  try { Reflect.apply(getter, value, []); }
  catch { throw new TypeError("conversation_signal_invalid"); }
  return value as AbortSignal;
}

function signalIsAborted(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (getter === undefined) return true;
  try { return Reflect.apply(getter, signal, []) === true; }
  catch { return true; }
}

function captureTurn(value: unknown): CapturedTurn {
  const snapshot = ownDataRecord(value, "conversation_turn_input_invalid");
  const fields = snapshot.values.channel === "telegram" && snapshot.values.kind === "outbox"
    ? TELEGRAM_FIELDS
    : VOICE_FIELDS;
  if (snapshot.keys.length !== fields.size || snapshot.keys.some((key) => !fields.has(key))) {
    throw new TypeError("conversation_turn_input_invalid");
  }
  const initial = snapshot.values;
  const sessionId = safeText(initial.sessionId, "conversation_session_invalid");
  const principalId = safeText(initial.principalId, "conversation_principal_invalid");
  const turnId = initial.turnId;
  const text = safeText(initial.text, "conversation_text_invalid", MAX_INPUT_BYTES);
  const signal = realAbortSignal(initial.signal);
  if (typeof turnId !== "string" || !ULID.test(turnId) || Array.from(text).length > MAX_INPUT_SCALARS) {
    throw new TypeError("conversation_turn_input_invalid");
  }
  if (initial.channel === "voice" && initial.kind === "voice_stream") {
    if (typeof initial.onToken !== "function" || typeof initial.finish !== "function") {
      throw new TypeError("conversation_turn_input_invalid");
    }
    assertVoiceStreamDeliveryBinding(Object.freeze({
      sessionId,
      turnId: turnId as Ulid,
      onToken: initial.onToken as (token: ModelToken) => Promise<void>,
      finish: initial.finish as (finalText: string) => Promise<VoiceSentReceipt>,
    }));
    return Object.freeze({
      sessionId,
      principalId,
      turnId: turnId as Ulid,
      text,
      signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: initial.onToken as (token: ModelToken) => Promise<void>,
      finish: initial.finish as (finalText: string) => Promise<VoiceSentReceipt>,
    });
  }
  if (initial.channel !== "telegram" || initial.kind !== "outbox") {
    throw new TypeError("conversation_turn_input_invalid");
  }
  const targetIdentityId = safeText(initial.targetIdentityId, "conversation_target_invalid");
  const replyToMessageId = initial.replyToMessageId;
  if (replyToMessageId !== null && (!Number.isSafeInteger(replyToMessageId) || (replyToMessageId as number) <= 0)) {
    throw new TypeError("conversation_turn_input_invalid");
  }
  return Object.freeze({
    sessionId,
    principalId,
    turnId: turnId as Ulid,
    text,
    signal,
    channel: "telegram",
    kind: "outbox",
    targetIdentityId,
    replyToMessageId: replyToMessageId as number | null,
  });
}

function captureSystemNotice(value: unknown): CapturedSystemNotice {
  const captured = exactDataRecord(value, SYSTEM_NOTICE_FIELDS, "conversation_system_notice_input_invalid");
  const noticeId = captured.noticeId;
  const sessionId = safeText(captured.sessionId, "conversation_session_invalid");
  const principalId = safeText(captured.principalId, "conversation_principal_invalid");
  const targetIdentityId = safeText(captured.targetIdentityId, "conversation_target_invalid");
  const replyToMessageId = captured.replyToMessageId;
  if (typeof noticeId !== "string" || !ULID.test(noticeId)
    || captured.channel !== "telegram" || captured.noticeCode !== "busy"
    || replyToMessageId !== null
      && (!Number.isSafeInteger(replyToMessageId) || (replyToMessageId as number) <= 0)) {
    throw new TypeError("conversation_system_notice_input_invalid");
  }
  return Object.freeze({
    noticeId: noticeId as Ulid,
    sessionId,
    principalId,
    channel: "telegram",
    noticeCode: "busy",
    targetIdentityId,
    replyToMessageId: replyToMessageId as number | null,
  });
}

function snapshotSystemDeliveryId(
  value: unknown,
  expected: CapturedSystemNotice,
): ConversationDeliveryId {
  const captured = snapshotStoredDelivery(value, "conversation_system_notice_result_invalid");
  if (captured.correlationId !== expected.noticeId || captured.turnId !== null
    || captured.principalId !== expected.principalId
    || captured.targetIdentityId !== expected.targetIdentityId
    || captured.replyToMessageId !== expected.replyToMessageId
    || captured.historyMode !== "system" || captured.state !== "pending") {
    throw new Error("conversation_system_notice_result_invalid");
  }
  return captured.deliveryId;
}

function captureMethod(receiver: object, name: string): CapturedMethod {
  let current: object | null = receiver;
  const visited = new Set<object>();
  try {
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          throw new TypeError("conversation_dependency_invalid");
        }
        return Object.freeze({
          receiver,
          method: descriptor.value as (...args: never[]) => unknown,
        });
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    throw new TypeError("conversation_dependency_invalid");
  }
  throw new TypeError("conversation_dependency_invalid");
}

function call<T>(captured: CapturedMethod, ...args: unknown[]): T {
  return Reflect.apply(captured.method, captured.receiver, args as never[]) as T;
}

function snapshotDate(value: Date): Date {
  let epoch: number;
  try { epoch = Date.prototype.getTime.call(value); }
  catch { throw new TypeError("conversation_clock_invalid"); }
  if (!Number.isFinite(epoch)) throw new TypeError("conversation_clock_invalid");
  return new Date(epoch);
}

function canonicalIsoOrNull(value: unknown, error: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(error);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new TypeError(error);
  return value;
}

function optionalUlid(value: unknown, error: string): Ulid | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(error);
  return value as Ulid;
}

function snapshotStoredTurn(value: unknown, error: string): StoredConversationTurn {
  const captured = exactDataRecord(value, STORED_TURN_FIELDS, error);
  const turnId = optionalUlid(captured.turnId, error);
  const userEventId = optionalUlid(captured.userEventId, error);
  const sessionId = safeText(captured.sessionId, error);
  const principalId = safeText(captured.principalId, error);
  const stagedDeliveryId = optionalUlid(captured.stagedDeliveryId, error) as ConversationDeliveryId | null;
  const sentAssistantEventId = optionalUlid(captured.sentAssistantEventId, error);
  const deliveredAssistantEventId = optionalUlid(captured.deliveredAssistantEventId, error);
  const failureCode = captured.failureCode;
  const failureCategory = captured.failureCategory;
  const createdAt = canonicalIsoOrNull(captured.createdAt, error);
  const updatedAt = canonicalIsoOrNull(captured.updatedAt, error);
  if (turnId === null || userEventId === null
    || captured.channel !== "voice" && captured.channel !== "telegram"
    || typeof captured.requestHash !== "string" || !SHA256.test(captured.requestHash)
    || !TURN_STATES.has(captured.state as string)
    || failureCode !== null && !FAILURE_CODES.has(failureCode as string)
    || failureCategory !== null && !FAILURE_CATEGORIES.has(failureCategory as string)
    || createdAt === null || updatedAt === null) {
    throw new TypeError(error);
  }
  return Object.freeze({
    turnId,
    sessionId,
    principalId,
    channel: captured.channel,
    requestHash: captured.requestHash as Sha256Hex,
    userEventId,
    state: captured.state as StoredConversationTurn["state"],
    modelClaimedAt: canonicalIsoOrNull(captured.modelClaimedAt, error),
    modelClaimExpiresAt: canonicalIsoOrNull(captured.modelClaimExpiresAt, error),
    resolvedAt: canonicalIsoOrNull(captured.resolvedAt, error),
    stagedDeliveryId,
    sentAssistantEventId,
    deliveredAssistantEventId,
    failureCode: failureCode as StoredConversationTurn["failureCode"],
    failureCategory: failureCategory as StoredConversationTurn["failureCategory"],
    createdAt,
    updatedAt,
  });
}

function snapshotAdmission(value: unknown): Readonly<{ turn: StoredConversationTurn; replayed: boolean }> {
  const captured = exactDataRecord(value, ADMISSION_FIELDS, "conversation_admission_invalid");
  if (typeof captured.replayed !== "boolean") throw new TypeError("conversation_admission_invalid");
  return Object.freeze({
    turn: snapshotStoredTurn(captured.turn, "conversation_admission_invalid"),
    replayed: captured.replayed,
  });
}

function snapshotStoredDelivery(value: unknown, error: string): StoredConversationDelivery {
  const captured = exactDataRecord(value, STORED_DELIVERY_FIELDS, error);
  const deliveryId = optionalUlid(captured.deliveryId, error);
  const correlationId = optionalUlid(captured.correlationId, error);
  const turnId = optionalUlid(captured.turnId, error);
  const stagedEventId = optionalUlid(captured.stagedEventId, error);
  const principalId = safeText(captured.principalId, error);
  const targetIdentityId = safeText(captured.targetIdentityId, error);
  const replyToMessageId = captured.replyToMessageId;
  const providerMessageId = captured.providerMessageId === null
    ? null
    : safeText(captured.providerMessageId, error);
  const deliveredAssistantEventId = optionalUlid(captured.deliveredAssistantEventId, error);
  const failureCode = captured.failureCode;
  const failureCategory = captured.failureCategory;
  const availableAt = canonicalIsoOrNull(captured.availableAt, error);
  const createdAt = canonicalIsoOrNull(captured.createdAt, error);
  const updatedAt = canonicalIsoOrNull(captured.updatedAt, error);
  if (deliveryId === null || correlationId === null || stagedEventId === null
    || replyToMessageId !== null
      && (!Number.isSafeInteger(replyToMessageId) || (replyToMessageId as number) <= 0)
    || captured.historyMode !== "assistant" && captured.historyMode !== "system"
    || typeof captured.materialHash !== "string" || !SHA256.test(captured.materialHash)
    || typeof captured.providerIdempotencyKey !== "string"
      || safeText(captured.providerIdempotencyKey, error, 512) !== captured.providerIdempotencyKey
    || !DELIVERY_STATES.has(captured.state as string)
    || !Number.isSafeInteger(captured.attemptCount) || (captured.attemptCount as number) < 0
      || (captured.attemptCount as number) > 3
    || failureCode !== null && !FAILURE_CODES.has(failureCode as string)
    || failureCategory !== null && !FAILURE_CATEGORIES.has(failureCategory as string)
    || availableAt === null || createdAt === null || updatedAt === null) {
    throw new TypeError(error);
  }
  return Object.freeze({
    deliveryId: deliveryId as unknown as ConversationDeliveryId,
    correlationId,
    turnId,
    stagedEventId,
    principalId,
    targetIdentityId,
    replyToMessageId: replyToMessageId as number | null,
    historyMode: captured.historyMode,
    materialHash: captured.materialHash as Sha256Hex,
    providerIdempotencyKey: captured.providerIdempotencyKey,
    state: captured.state as StoredConversationDelivery["state"],
    attemptCount: captured.attemptCount as number,
    availableAt,
    claimedAt: canonicalIsoOrNull(captured.claimedAt, error),
    leaseExpiresAt: canonicalIsoOrNull(captured.leaseExpiresAt, error),
    resolvedAt: canonicalIsoOrNull(captured.resolvedAt, error),
    providerMessageId,
    deliveredAssistantEventId,
    failureCode: failureCode as StoredConversationDelivery["failureCode"],
    failureCategory: failureCategory as StoredConversationDelivery["failureCategory"],
    createdAt,
    updatedAt,
  });
}

function snapshotAssistantStage(value: unknown): AssistantStageResult {
  const captured = exactDataRecord(value, ASSISTANT_STAGE_FIELDS, "conversation_stage_invalid");
  return Object.freeze({
    turn: snapshotStoredTurn(captured.turn, "conversation_stage_invalid"),
    delivery: snapshotStoredDelivery(captured.delivery, "conversation_stage_invalid"),
  });
}

function snapshotDispatchResult(value: unknown): OutboxDispatchResult {
  const captured = exactDataRecord(value, DISPATCH_RESULT_FIELDS, "conversation_dispatch_invalid");
  const deliveredAssistantEventId = optionalUlid(
    captured.deliveredAssistantEventId,
    "conversation_dispatch_invalid",
  );
  if (!DISPATCH_OUTCOMES.has(captured.outcome as string)) {
    throw new TypeError("conversation_dispatch_invalid");
  }
  return Object.freeze({
    outcome: captured.outcome as OutboxDispatchResult["outcome"],
    deliveredAssistantEventId,
  });
}

function snapshotModelClaim(value: unknown): ModelTurnClaim {
  const captured = ownDataRecord(value, "conversation_claim_invalid");
  const fields = captured.values.kind === "claimed" ? CLAIMED_MODEL_FIELDS : OBSERVED_MODEL_FIELDS;
  if (captured.keys.length !== fields.size || captured.keys.some((key) => !fields.has(key))) {
    throw new TypeError("conversation_claim_invalid");
  }
  const turn = snapshotStoredTurn(captured.values.turn, "conversation_claim_invalid");
  if (captured.values.kind === "claimed") {
    const capability = captured.values.capability;
    if (capability === null || typeof capability !== "object" || !Object.isFrozen(capability)
      || turn.state !== "model_claimed") {
      throw new TypeError("conversation_claim_invalid");
    }
    return Object.freeze({ kind: "claimed", capability: capability as ModelStreamClaimCapability, turn });
  }
  if (captured.values.kind === "in_progress" && turn.state === "model_claimed") {
    return Object.freeze({ kind: "in_progress", turn });
  }
  if (captured.values.kind === "terminal" && resultFromTurn(turn) !== null) {
    return Object.freeze({ kind: "terminal", turn });
  }
  throw new TypeError("conversation_claim_invalid");
}

function snapshotContext(value: unknown): readonly RetrievedContext[] {
  if (!Array.isArray(value)) throw new TypeError("conversation_context_invalid");
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new TypeError("conversation_context_invalid");
  }
  if (prototype !== Array.prototype || lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 128) {
    throw new TypeError("conversation_context_invalid");
  }
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || keys.some((key) => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return true;
    const index = Number(key);
    return !Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key;
  })) {
    throw new TypeError("conversation_context_invalid");
  }
  let bytes = 0;
  const copied: RetrievedContext[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { throw new TypeError("conversation_context_invalid"); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("conversation_context_invalid");
    }
    const item = exactDataRecord(descriptor.value, CONTEXT_FIELDS, "conversation_context_invalid");
    if (typeof item.sourceEventId !== "string" || !ULID.test(item.sourceEventId)
      || item.sensitivity !== "personal" && item.sensitivity !== "restricted") {
      throw new TypeError("conversation_context_invalid");
    }
    const text = safeText(item.text, "conversation_context_invalid", 65_536);
    bytes += encoder.encode(text).byteLength;
    if (bytes > 32_000) throw new RangeError("conversation_context_invalid");
    copied.push(Object.freeze({
      sourceEventId: item.sourceEventId as Ulid,
      text,
      sensitivity: item.sensitivity,
    }));
  }
  return Object.freeze(copied);
}

function resultFromTurn(turn: StoredConversationTurn): ConversationTurnResult | null {
  const common = {
    committedUserEventId: turn.userEventId,
    sentAssistantEventId: turn.sentAssistantEventId,
    deliveryId: turn.stagedDeliveryId,
    deliveredAssistantEventId: turn.deliveredAssistantEventId,
  };
  switch (turn.state) {
    case "voice_sent": return Object.freeze({ outcome: "voice_sent", ...common });
    case "assistant_staged": return Object.freeze({ outcome: "telegram_staged", ...common });
    case "delivered": return Object.freeze({ outcome: "telegram_delivered", ...common });
    case "cancelled": return Object.freeze({ outcome: "cancelled", ...common });
    case "failed": return Object.freeze({ outcome: "failed", ...common });
    case "model_outcome_unknown": return Object.freeze({ outcome: "model_outcome_unknown", ...common });
    case "delivery_unknown": return Object.freeze({ outcome: "delivery_unknown", ...common });
    case "user_committed":
    case "model_claimed":
      return null;
  }
}

const VOICE_CONTEXT_RETRIEVAL_TIMEOUT_MS = 750;

/** Coordinates one durable model claim and one channel-specific, redacted delivery. */
export class DefaultConversationService implements ConversationService {
  private readonly getOrCreateTurn: CapturedMethod;
  private readonly claimModelTurn: CapturedMethod;
  private readonly beginModelStream: CapturedMethod;
  private readonly recordVoiceSent: CapturedMethod;
  private readonly stageAssistantDelivery: CapturedMethod;
  private readonly recordTurnCancelled: CapturedMethod;
  private readonly recordTurnFailed: CapturedMethod;
  private readonly recordIngestFailure: CapturedMethod;
  private readonly stageSystemNoticeRecord: CapturedMethod;
  private readonly modelStream: CapturedMethod;
  private readonly contextRetrieve: CapturedMethod;
  private readonly dispatcherDispatch: CapturedMethod;
  private readonly redact: CapturedMethod;
  private readonly outputRedactor: RedactorContract;
  private readonly clock: () => Date;
  private readonly modelBudgets: Readonly<Record<ConversationChannel, ModelBudget>>;
  private readonly observeStaging: ObserveAsyncOperation;

  constructor(dependencies: ConversationServiceDependencies) {
    const fields = new Set(["repository", "model", "context", "dispatcher", "redactor", "now", "modelBudgets", "observeStaging"]);
    const required = new Set(["repository", "model", "context", "dispatcher", "redactor"]);
    let descriptors: PropertyDescriptorMap;
    try { descriptors = Object.getOwnPropertyDescriptors(dependencies); }
    catch { throw new TypeError("conversation_dependency_invalid"); }
    const keys = Reflect.ownKeys(descriptors);
    if (dependencies === null || typeof dependencies !== "object" || Object.getPrototypeOf(dependencies) !== Object.prototype
      || keys.some((key) => typeof key !== "string" || !fields.has(key))
      || [...required].some((key) => descriptors[key] === undefined)
      || keys.some((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
      })) {
      throw new TypeError("conversation_dependency_invalid");
    }
    const repository = descriptors.repository?.value as ConversationRepositoryPort;
    const model = descriptors.model?.value as object;
    const context = descriptors.context?.value as object;
    const dispatcher = descriptors.dispatcher?.value as object;
    const redactor = descriptors.redactor?.value as object;
    if (repository === null || typeof repository !== "object" || model === null || typeof model !== "object"
      || context === null || typeof context !== "object" || dispatcher === null || typeof dispatcher !== "object"
      || redactor === null || typeof redactor !== "object") {
      throw new TypeError("conversation_dependency_invalid");
    }
    this.getOrCreateTurn = captureMethod(repository, "getOrCreateTurn");
    this.claimModelTurn = captureMethod(repository, "claimModelTurn");
    this.beginModelStream = captureMethod(repository, "beginModelStream");
    this.recordVoiceSent = captureMethod(repository, "recordVoiceSent");
    this.stageAssistantDelivery = captureMethod(repository, "stageAssistantDelivery");
    this.recordTurnCancelled = captureMethod(repository, "recordTurnCancelled");
    this.recordTurnFailed = captureMethod(repository, "recordTurnFailed");
    this.recordIngestFailure = captureMethod(repository, "recordIngestFailure");
    this.stageSystemNoticeRecord = captureMethod(repository, "stageSystemNotice");
    this.modelStream = captureMethod(model, "stream");
    this.contextRetrieve = captureMethod(context, "retrieve");
    this.dispatcherDispatch = captureMethod(dispatcher, "dispatch");
    const redact = captureMethod(redactor, "redact");
    const redactText = captureMethod(redactor, "redactText");
    this.redact = redact;
    this.outputRedactor = Object.freeze({
      redact(input: Parameters<RedactorContract["redact"]>[0]) {
        return call<ReturnType<RedactorContract["redact"]>>(redact, input);
      },
      redactText(text: Parameters<RedactorContract["redactText"]>[0]) {
        return call<ReturnType<RedactorContract["redactText"]>>(redactText, text);
      },
    });
    const now = descriptors.now?.value ?? (() => new Date());
    if (typeof now !== "function") throw new TypeError("conversation_dependency_invalid");
    this.clock = now as () => Date;
    const observeStaging = descriptors.observeStaging?.value ?? (async <T>(operation: () => Promise<T>) => operation());
    if (typeof observeStaging !== "function") throw new TypeError("conversation_dependency_invalid");
    this.observeStaging = observeStaging as ObserveAsyncOperation;

    const budgets = descriptors.modelBudgets?.value ?? DEFAULT_MODEL_BUDGETS;
    // Validated rather than trusted: a missing or non-positive deadline would
    // either abort every turn instantly or remove the bound entirely, and both
    // failures are silent at the point of configuration.
    if (
      budgets === null
      || typeof budgets !== "object"
      || (["voice", "telegram"] as const).some((channel) => {
        const budget = (budgets as Record<string, unknown>)[channel];
        if (budget === null || typeof budget !== "object") return true;
        const { firstTokenTimeoutMs, timeoutMs } = budget as Partial<ModelBudget>;
        return !Number.isSafeInteger(firstTokenTimeoutMs) || (firstTokenTimeoutMs as number) <= 0
          || !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0
          || (timeoutMs as number) < (firstTokenTimeoutMs as number);
      })
    ) {
      throw new TypeError("conversation_dependency_invalid");
    }
    this.modelBudgets = budgets as Readonly<Record<ConversationChannel, ModelBudget>>;
  }

  async #voiceContext(
    input: Readonly<{ principalId: string; query: string; turnId: Ulid }>,
  ): Promise<readonly RetrievedContext[]> {
    type Retrieval = Readonly<{ kind: "retrieved"; value: unknown }>
      | Readonly<{ kind: "failure" | "timeout" }>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const retrieval = Promise.resolve()
      .then(() => call<Promise<readonly RetrievedContext[]>>(this.contextRetrieve, Object.freeze({
        principalId: input.principalId,
        channel: "voice",
        purpose: "conversation",
        query: input.query,
        maxTokens: 32_000,
      })))
      .then<Retrieval, Retrieval>(
        (value) => Object.freeze({ kind: "retrieved", value }),
        () => Object.freeze({ kind: "failure" }),
      );
    const deadline = new Promise<Retrieval>((resolve) => {
      timeout = setTimeout(() => resolve(Object.freeze({ kind: "timeout" })), VOICE_CONTEXT_RETRIEVAL_TIMEOUT_MS);
    });
    const outcome = await Promise.race([retrieval, deadline]);
    if (timeout !== undefined) clearTimeout(timeout);
    const reason: "failure" | "timeout" | "invalid" = outcome.kind === "retrieved" ? "invalid" : outcome.kind;
    if (outcome.kind === "retrieved") {
      try { return snapshotContext(outcome.value); }
      catch { /* Malformed retrieval is recorded as an invalid-context fallback. */ }
    }
    try {
      console.warn("voice_context_retrieval_fallback", {
        turnId: input.turnId,
        reason,
      });
    } catch { /* Recording failure cannot turn a bounded fallback into a failed turn. */ }
    return Object.freeze([]);
  }

  async handleTurn(input: ConversationHandleTurnInput): Promise<ConversationTurnResult> {
    const captured = captureTurn(input);
    let userText: SuccessfulRedaction;
    try {
      const redaction = call<unknown>(this.redact, Object.freeze({
        text: captured.text,
        channel: captured.channel,
        field: "conversation.turn.text",
      }));
      if (!isIssuedRedaction(redaction)) throw new Error("ingest_redaction_failed");
      userText = redaction;
    } catch {
      try {
        await call<ReturnType<ConversationRepositoryPort["recordIngestFailure"]>>(this.recordIngestFailure, {
          turnId: captured.turnId,
          sessionId: captured.sessionId,
          principalId: captured.principalId,
          channel: captured.channel,
          now: snapshotDate(this.clock()),
        });
      } catch { /* The public failure remains fixed even when durable settlement is unavailable. */ }
      throw new Error("ingest_redaction_failed");
    }

    let admissionValue: unknown;
    try {
      admissionValue = await call<ReturnType<ConversationRepositoryPort["getOrCreateTurn"]>>(
        this.getOrCreateTurn,
        Object.freeze({
          turnId: captured.turnId,
          sessionId: captured.sessionId,
          principalId: captured.principalId,
          channel: captured.channel,
          userText,
          now: snapshotDate(this.clock()),
        }),
      );
    } catch {
      throw new Error("conversation_admission_failed");
    }
    const admission = snapshotAdmission(admissionValue);
    const replay = resultFromTurn(admission.turn);
    if (replay !== null) return replay;

    let claimValue: unknown;
    try {
      claimValue = await call<ReturnType<ConversationRepositoryPort["claimModelTurn"]>>(
        this.claimModelTurn,
        Object.freeze({
          turnId: captured.turnId,
          requestHash: admission.turn.requestHash,
          now: snapshotDate(this.clock()),
        }),
      );
    } catch {
      return Object.freeze({
        outcome: "model_outcome_unknown",
        committedUserEventId: admission.turn.userEventId,
        sentAssistantEventId: admission.turn.sentAssistantEventId,
        deliveryId: admission.turn.stagedDeliveryId,
        deliveredAssistantEventId: admission.turn.deliveredAssistantEventId,
      });
    }
    const claim = snapshotModelClaim(claimValue);
    if (claim.kind === "in_progress") {
      return Object.freeze({
        outcome: "in_progress",
        committedUserEventId: claim.turn.userEventId,
        sentAssistantEventId: claim.turn.sentAssistantEventId,
        deliveryId: claim.turn.stagedDeliveryId,
        deliveredAssistantEventId: claim.turn.deliveredAssistantEventId,
      });
    }
    if (claim.kind === "terminal") {
      const terminal = resultFromTurn(claim.turn);
      if (terminal === null) throw new Error("conversation_turn_state_invalid");
      return terminal;
    }
    const capability = claim.capability;
    let context: readonly RetrievedContext[];
    try {
      if (captured.channel === "voice") {
        context = await this.#voiceContext({
          principalId: captured.principalId,
          query: userText.text,
          turnId: captured.turnId,
        });
      } else {
        const contextValue = await call<Promise<readonly RetrievedContext[]>>(
          this.contextRetrieve,
          Object.freeze({
            principalId: captured.principalId,
            channel: captured.channel,
            purpose: "conversation",
            query: userText.text,
            maxTokens: 32_000,
          }),
        );
        context = snapshotContext(contextValue);
      }
    } catch {
      try {
        const stored = snapshotStoredTurn(await call<ReturnType<ConversationRepositoryPort["recordTurnFailed"]>>(
          this.recordTurnFailed,
          {
            claim: capability,
            failureCode: "model_outcome_unknown",
            failureCategory: "ambiguous",
            now: snapshotDate(this.clock()),
          },
        ), "conversation_model_settlement_invalid");
        const terminal = resultFromTurn(stored);
        if (terminal?.outcome !== "model_outcome_unknown") {
          throw new Error("conversation_model_settlement_invalid");
        }
        return terminal;
      } catch {
        return Object.freeze({
          outcome: "model_outcome_unknown",
          committedUserEventId: claim.turn.userEventId,
          sentAssistantEventId: null,
          deliveryId: null,
          deliveredAssistantEventId: null,
        });
      }
    }
    const output = new StreamingOutputRedactor(this.outputRedactor, {
      maxRawCharacters: MAX_OUTPUT_SCALARS,
      maxSanitizedCharacters: MAX_OUTPUT_SCALARS,
    });
    let finalText: SuccessfulRedaction;
    let voiceReceipt: VoiceSentReceipt | null = null;
    const budget = this.modelBudgets[captured.channel];
    try {
      call<void>(this.beginModelStream, capability, captured.turnId, admission.turn.requestHash);
      // Claim and context reads can outlast cancellation. Consume the nominal
      // claim so cancellation can settle durably, but never start a paid request.
      if (signalIsAborted(captured.signal)) throw new ModelAdapterError("model_aborted");
      const stream = call<AsyncIterable<ModelToken>>(this.modelStream, Object.freeze({
        correlationId: captured.turnId,
        principalId: captured.principalId,
        channel: captured.channel,
        userText: userText.text,
        context,
        reasoningEffort: "low",
        firstTokenTimeoutMs: budget.firstTokenTimeoutMs,
        timeoutMs: budget.timeoutMs,
        contextTokenBudget: 32_000,
        maxOutputCharacters: MAX_OUTPUT_SCALARS,
        signal: captured.signal,
      }));

      for await (const token of stream) {
        for (const safeToken of output.push(token)) {
          if (captured.channel === "voice") await captured.onToken(safeToken);
        }
      }
      finalText = output.complete();
      for (const safeToken of output.drain()) {
        if (captured.channel === "voice") await captured.onToken(safeToken);
      }
      if (captured.channel === "voice") voiceReceipt = await captured.finish(finalText.text);
    } catch (error) {
      try { output.cancel(); }
      catch { /* Sanitizer cleanup failures never replace fixed settlement metadata. */ }
      let stored: StoredConversationTurn;
      try {
        if (error instanceof ModelAdapterError
          && (error.code === "model_admission_unknown" || error.code === "model_cancel_unknown")) {
          stored = snapshotStoredTurn(await call<ReturnType<ConversationRepositoryPort["recordTurnFailed"]>>(this.recordTurnFailed, {
            claim: capability,
            failureCode: "model_outcome_unknown",
            failureCategory: "ambiguous",
            now: snapshotDate(this.clock()),
          }), "conversation_model_settlement_invalid");
        } else if (signalIsAborted(captured.signal)
          || error instanceof ModelAdapterError && error.code === "model_aborted") {
          stored = snapshotStoredTurn(await call<ReturnType<ConversationRepositoryPort["recordTurnCancelled"]>>(this.recordTurnCancelled, {
            claim: capability,
            now: snapshotDate(this.clock()),
          }), "conversation_model_settlement_invalid");
        } else {
          stored = snapshotStoredTurn(await call<ReturnType<ConversationRepositoryPort["recordTurnFailed"]>>(this.recordTurnFailed, {
            claim: capability,
            failureCode: "model_failed",
            failureCategory: "provider",
            now: snapshotDate(this.clock()),
          }), "conversation_model_settlement_invalid");
        }
      } catch {
        return Object.freeze({
          outcome: "model_outcome_unknown",
          committedUserEventId: claim.turn.userEventId,
          sentAssistantEventId: null,
          deliveryId: null,
          deliveredAssistantEventId: null,
        });
      }
      const terminal = resultFromTurn(stored);
      if (terminal === null || terminal.outcome !== "cancelled" && terminal.outcome !== "failed"
        && terminal.outcome !== "model_outcome_unknown") {
        throw new Error("conversation_model_settlement_invalid");
      }
      return terminal;
    }

    if (captured.channel === "voice") {
      let stored: StoredConversationTurn;
      try {
        stored = snapshotStoredTurn(await call<ReturnType<ConversationRepositoryPort["recordVoiceSent"]>>(this.recordVoiceSent, {
          claim: capability,
          text: finalText,
          receipt: voiceReceipt as VoiceSentReceipt,
          now: snapshotDate(this.clock()),
        }), "conversation_voice_settlement_invalid");
      } catch {
        return Object.freeze({
          outcome: "model_outcome_unknown",
          committedUserEventId: claim.turn.userEventId,
          sentAssistantEventId: null,
          deliveryId: null,
          deliveredAssistantEventId: null,
        });
      }
      const completed = resultFromTurn(stored);
      if (completed?.outcome !== "voice_sent") throw new Error("conversation_voice_settlement_invalid");
      return completed;
    }
    let stagedValue: unknown;
    try {
      stagedValue = await this.observeStaging(
        () => call<ReturnType<ConversationRepositoryPort["stageAssistantDelivery"]>>(this.stageAssistantDelivery, {
          claim: capability,
          text: finalText,
          targetIdentityId: captured.targetIdentityId,
          replyToMessageId: captured.replyToMessageId,
          now: snapshotDate(this.clock()),
        }),
      );
    } catch {
      return Object.freeze({
        outcome: "model_outcome_unknown",
        committedUserEventId: claim.turn.userEventId,
        sentAssistantEventId: null,
        deliveryId: null,
        deliveredAssistantEventId: null,
      });
    }
    const staged = snapshotAssistantStage(stagedValue);
    if (staged.turn.state !== "assistant_staged"
      || staged.turn.stagedDeliveryId !== staged.delivery.deliveryId
      || staged.delivery.targetIdentityId !== captured.targetIdentityId
      || staged.delivery.principalId !== captured.principalId) {
      throw new Error("conversation_stage_invalid");
    }
    const common = {
      committedUserEventId: staged.turn.userEventId,
      sentAssistantEventId: staged.turn.sentAssistantEventId,
      deliveryId: staged.delivery.deliveryId,
    };
    let dispatch: OutboxDispatchResult;
    try {
      dispatch = snapshotDispatchResult(await call<ReturnType<OutboxDispatcher["dispatch"]>>(
        this.dispatcherDispatch,
        staged.delivery.deliveryId,
      ));
    } catch {
      return Object.freeze({ outcome: "delivery_unknown", ...common, deliveredAssistantEventId: null });
    }
    if (dispatch.outcome === "delivered" || dispatch.outcome === "already_delivered") {
      if (dispatch.deliveredAssistantEventId === null) throw new Error("conversation_dispatch_invalid");
      return Object.freeze({
        outcome: "telegram_delivered",
        ...common,
        deliveredAssistantEventId: dispatch.deliveredAssistantEventId,
      });
    }
    if (dispatch.outcome === "in_progress" || dispatch.outcome === "retry_scheduled") {
      return Object.freeze({ outcome: "telegram_staged", ...common, deliveredAssistantEventId: null });
    }
    if (dispatch.outcome === "failed") {
      return Object.freeze({ outcome: "failed", ...common, deliveredAssistantEventId: null });
    }
    if (dispatch.outcome === "unknown") {
      return Object.freeze({ outcome: "delivery_unknown", ...common, deliveredAssistantEventId: null });
    }
    throw new Error("conversation_dispatch_invalid");
  }

  async stageSystemNotice(input: StageSystemNoticeInput): Promise<ConversationDeliveryId> {
    const captured = captureSystemNotice(input);
    const delivery = await call<ReturnType<ConversationRepositoryPort["stageSystemNotice"]>>(this.stageSystemNoticeRecord, {
      ...captured,
      now: snapshotDate(this.clock()),
    });
    return snapshotSystemDeliveryId(delivery, captured);
  }
}

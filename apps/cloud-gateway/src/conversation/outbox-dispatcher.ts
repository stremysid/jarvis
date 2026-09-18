import {
  ProviderCircuitOpenError,
  ProviderFailure,
  type TelegramProvider,
  type TelegramSendMessageResult,
} from "../providers/provider-types.js";
import { ProviderCircuitBreaker } from "../providers/provider-circuit-breaker.js";
import {
  parseDecisionCallbackData,
  type TelegramInlineKeyboardMarkup,
} from "../decisions/telegram-keyboard.js";
import type {
  ClaimedConversationDelivery,
  ConversationDeliveryId,
  DeliveryDispatchClaim,
  DeliveryLeaseCapability,
  OutboxDispatchResult,
  OutboxDispatcher,
  StoredConversationDelivery,
} from "./conversation-types.js";
import type { ConversationRepository } from "./conversation-repository.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const TELEGRAM_SUBJECT = /^[1-9][0-9]{0,19}$/u;
const PROVIDER_RESULT_FIELDS = new Set(["providerMessageId"]);
const TARGET_FIELDS = new Set(["principalId", "identityId", "providerSubject"]);
const IDENTITY_ROW_FIELDS = new Set(["principal_id", "identity_id", "provider_subject"]);
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
const CLAIMED_DELIVERY_FIELDS = new Set([...STORED_DELIVERY_FIELDS, "text", "replyMarkup"]);
const CLAIMED_DISPATCH_FIELDS = new Set(["kind", "capability", "item"]);
const OBSERVED_DISPATCH_FIELDS = new Set(["kind", "item"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const DELIVERY_STATES = new Set(["pending", "claimed", "delivered", "retry_wait", "failed", "unknown"]);
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
const encoder = new TextEncoder();

interface CapturedMethod {
  readonly receiver: object;
  readonly method: (...args: never[]) => unknown;
}

type ObserveAsyncOperation = <T>(operation: () => Promise<T>) => Promise<T>;

type DeliveryRepositoryPort = Pick<ConversationRepository,
  | "claimDelivery"
  | "beginDelivery"
  | "mintProviderDeliveryReceipt"
  | "recordDeliverySuccess"
  | "recordDeliveryFailure"
>;

export interface TelegramDeliveryTarget {
  readonly principalId: string;
  readonly identityId: string;
  readonly providerSubject: string;
}

export interface TelegramIdentityResolver {
  resolveActive(input: {
    readonly principalId: string;
    readonly targetIdentityId: string;
  }): Promise<Readonly<TelegramDeliveryTarget> | null>;
}

export interface OutboxDispatcherDependencies {
  readonly repository: DeliveryRepositoryPort;
  readonly identityResolver: TelegramIdentityResolver;
  readonly channels: ReadonlyMap<"telegram", TelegramProvider>;
  readonly circuitBreaker: ProviderCircuitBreaker;
  readonly now?: () => Date;
  readonly observeTelegramSend?: ObserveAsyncOperation;
  readonly observeSettlement?: ObserveAsyncOperation;
}

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

function captureMethod(receiver: object, name: string): CapturedMethod {
  let current: object | null = receiver;
  const visited = new Set<object>();
  try {
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          throw new TypeError("outbox_dependency_invalid");
        }
        return Object.freeze({
          receiver,
          method: descriptor.value as (...args: never[]) => unknown,
        });
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    throw new TypeError("outbox_dependency_invalid");
  }
  throw new TypeError("outbox_dependency_invalid");
}

function call<T>(captured: CapturedMethod, ...args: unknown[]): T {
  return Reflect.apply(captured.method, captured.receiver, args as never[]) as T;
}

function snapshotDate(value: Date): Date {
  let epoch: number;
  try { epoch = Date.prototype.getTime.call(value); }
  catch { throw new TypeError("outbox_clock_invalid"); }
  if (!Number.isFinite(epoch)) throw new TypeError("outbox_clock_invalid");
  return new Date(epoch);
}

function safeText(value: unknown, error: string, maxBytes = 256): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maxBytes) {
    throw new TypeError(error);
  }
  return value;
}

function canonicalIsoOrNull(value: unknown, error: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(error);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new TypeError(error);
  return value;
}

function optionalUlid(value: unknown, error: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(error);
  return value;
}

function snapshotReplyMarkup(value: unknown, error: string): TelegramInlineKeyboardMarkup | null {
  if (value === null) return null;
  const root = exactDataRecord(value, new Set(["inline_keyboard"]), error);
  if (!Array.isArray(root.inline_keyboard) || root.inline_keyboard.length < 1
    || root.inline_keyboard.length > 10) throw new TypeError(error);
  const rows = root.inline_keyboard.map((row) => {
    if (!Array.isArray(row) || row.length !== 1) throw new TypeError(error);
    const button = exactDataRecord(row[0], new Set(["text", "callback_data"]), error);
    const text = safeText(button.text, error, 128);
    const callbackData = safeText(button.callback_data, error, 64);
    if (parseDecisionCallbackData(callbackData) === null) throw new TypeError(error);
    return Object.freeze([Object.freeze({ text, callback_data: callbackData })]);
  });
  return Object.freeze({ inline_keyboard: Object.freeze(rows) });
}

function snapshotStoredDelivery(
  value: unknown,
  error: string,
  includeText = false,
): StoredConversationDelivery | ClaimedConversationDelivery {
  const captured = exactDataRecord(
    value,
    includeText ? CLAIMED_DELIVERY_FIELDS : STORED_DELIVERY_FIELDS,
    error,
  );
  const deliveryId = optionalUlid(captured.deliveryId, error);
  const correlationId = optionalUlid(captured.correlationId, error);
  const turnId = optionalUlid(captured.turnId, error);
  const stagedEventId = optionalUlid(captured.stagedEventId, error);
  const principalId = safeText(captured.principalId, error);
  const targetIdentityId = safeText(captured.targetIdentityId, error);
  const replyToMessageId = captured.replyToMessageId;
  const providerMessageId = captured.providerMessageId === null
    ? null
    : safeText(captured.providerMessageId, error, 256);
  const deliveredAssistantEventId = optionalUlid(captured.deliveredAssistantEventId, error);
  const failureCode = captured.failureCode;
  const failureCategory = captured.failureCategory;
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
    || createdAt === null || updatedAt === null) {
    throw new TypeError(error);
  }
  const base = {
    deliveryId: deliveryId as ConversationDeliveryId,
    correlationId: correlationId as import("../../../../packages/contracts/src/index.js").Ulid,
    turnId: turnId as import("../../../../packages/contracts/src/index.js").Ulid | null,
    stagedEventId: stagedEventId as import("../../../../packages/contracts/src/index.js").Ulid,
    principalId,
    targetIdentityId,
    replyToMessageId: replyToMessageId as number | null,
    historyMode: captured.historyMode,
    materialHash: captured.materialHash as import("../../../../packages/contracts/src/index.js").Sha256Hex,
    providerIdempotencyKey: captured.providerIdempotencyKey,
    state: captured.state,
    attemptCount: captured.attemptCount as number,
    availableAt: canonicalIsoOrNull(captured.availableAt, error) as string,
    claimedAt: canonicalIsoOrNull(captured.claimedAt, error),
    leaseExpiresAt: canonicalIsoOrNull(captured.leaseExpiresAt, error),
    resolvedAt: canonicalIsoOrNull(captured.resolvedAt, error),
    providerMessageId,
    deliveredAssistantEventId: deliveredAssistantEventId as import("../../../../packages/contracts/src/index.js").Ulid | null,
    failureCode: failureCode as StoredConversationDelivery["failureCode"],
    failureCategory: failureCategory as StoredConversationDelivery["failureCategory"],
    createdAt,
    updatedAt,
  } as const;
  if (canonicalIsoOrNull(captured.availableAt, error) === null) throw new TypeError(error);
  if (!includeText) return Object.freeze(base) as StoredConversationDelivery;
  if (base.state !== "claimed") throw new TypeError(error);
  return Object.freeze({
    ...base,
    state: "claimed",
    text: safeText(captured.text, error, 65_536),
    replyMarkup: snapshotReplyMarkup(captured.replyMarkup, error),
  });
}

function snapshotDeliveryClaim(value: unknown, expectedDeliveryId: ConversationDeliveryId): DeliveryDispatchClaim {
  const captured = ownDataRecord(value, "delivery_claim_invalid");
  const fields = captured.values.kind === "claimed" ? CLAIMED_DISPATCH_FIELDS : OBSERVED_DISPATCH_FIELDS;
  if (captured.keys.length !== fields.size || captured.keys.some((key) => !fields.has(key))) {
    throw new TypeError("delivery_claim_invalid");
  }
  const item = snapshotStoredDelivery(
    captured.values.item,
    "delivery_claim_invalid",
    captured.values.kind === "claimed",
  );
  if (item.deliveryId !== expectedDeliveryId) throw new TypeError("delivery_claim_invalid");
  if (captured.values.kind === "claimed") {
    const capability = captured.values.capability;
    if (capability === null || typeof capability !== "object" || !Object.isFrozen(capability)
      || item.state !== "claimed" || !("text" in item)) {
      throw new TypeError("delivery_claim_invalid");
    }
    return Object.freeze({
      kind: "claimed",
      capability: capability as DeliveryLeaseCapability,
      item: item as ClaimedConversationDelivery,
    });
  }
  if (captured.values.kind === "in_progress" && item.state === "claimed") {
    return Object.freeze({ kind: "in_progress", item });
  }
  if (captured.values.kind === "unavailable" && (item.state === "pending" || item.state === "retry_wait")) {
    return Object.freeze({ kind: "unavailable", item });
  }
  if (captured.values.kind === "terminal"
    && (item.state === "delivered" || item.state === "failed" || item.state === "unknown")) {
    return Object.freeze({ kind: "terminal", item });
  }
  throw new TypeError("delivery_claim_invalid");
}

function snapshotTarget(value: unknown, expectedPrincipal: string, expectedIdentity: string): Readonly<TelegramDeliveryTarget> | null {
  if (value === null) return null;
  const captured = exactDataRecord(value, TARGET_FIELDS, "telegram_target_invalid");
  const principalId = safeText(captured.principalId, "telegram_target_invalid");
  const identityId = safeText(captured.identityId, "telegram_target_invalid");
  const providerSubject = safeText(captured.providerSubject, "telegram_target_invalid", 20);
  if (principalId !== expectedPrincipal || identityId !== expectedIdentity || !TELEGRAM_SUBJECT.test(providerSubject)) {
    throw new TypeError("telegram_target_invalid");
  }
  return Object.freeze({ principalId, identityId, providerSubject });
}

function snapshotProviderResult(value: unknown): string {
  const captured = exactDataRecord(value, PROVIDER_RESULT_FIELDS, "telegram_provider_result_invalid");
  return safeText(captured.providerMessageId, "telegram_provider_result_invalid");
}

function terminalResult(item: StoredConversationDelivery): OutboxDispatchResult {
  switch (item.state) {
    case "delivered":
      if (item.deliveredAssistantEventId === null && item.historyMode === "assistant") {
        throw new Error("delivery_terminal_invalid");
      }
      return Object.freeze({
        outcome: "already_delivered",
        deliveredAssistantEventId: item.deliveredAssistantEventId,
      });
    case "failed": return Object.freeze({ outcome: "failed", deliveredAssistantEventId: null });
    case "unknown": return Object.freeze({ outcome: "unknown", deliveredAssistantEventId: null });
    default: throw new Error("delivery_terminal_invalid");
  }
}

/** Resolves only a currently active Telegram identity owned by the exact principal. */
export class D1TelegramIdentityResolver implements TelegramIdentityResolver {
  constructor(private readonly database: D1Database) {}

  async resolveActive(input: { principalId: string; targetIdentityId: string }): Promise<Readonly<TelegramDeliveryTarget> | null> {
    const captured = exactDataRecord(input, new Set(["principalId", "targetIdentityId"]), "telegram_target_input_invalid");
    const principalId = safeText(captured.principalId, "telegram_target_input_invalid");
    const targetIdentityId = safeText(captured.targetIdentityId, "telegram_target_input_invalid");
    const row = await this.database.prepare(`SELECT p.principal_id, ci.identity_id, ci.provider_subject
      FROM channel_identities ci
      JOIN principals p ON p.principal_id = ci.principal_id
      WHERE ci.identity_id = ?1
        AND ci.principal_id = ?2
        AND ci.channel = 'telegram'
        AND ci.status = 'active'
        AND ci.verified_at IS NOT NULL
        AND p.status = 'active'`)
      .bind(targetIdentityId, principalId)
      .first<{ principal_id: string; identity_id: string; provider_subject: string }>();
    if (row === null) return null;
    const capturedRow = exactDataRecord(row, IDENTITY_ROW_FIELDS, "telegram_identity_row_invalid");
    return snapshotTarget({
      principalId: capturedRow.principal_id,
      identityId: capturedRow.identity_id,
      providerSubject: capturedRow.provider_subject,
    }, principalId, targetIdentityId);
  }
}

/** Dispatches one durable delivery lease through the registered Telegram provider. */
export class DefaultOutboxDispatcher implements OutboxDispatcher {
  private readonly claimDelivery: CapturedMethod;
  private readonly beginDelivery: CapturedMethod;
  private readonly mintProviderDeliveryReceipt: CapturedMethod;
  private readonly recordDeliverySuccess: CapturedMethod;
  private readonly recordDeliveryFailure: CapturedMethod;
  private readonly resolveIdentity: CapturedMethod;
  private readonly providerSend: CapturedMethod;
  private readonly breakerAssertAllowed: CapturedMethod;
  private readonly breakerRecordSuccess: CapturedMethod;
  private readonly breakerRecordFailure: CapturedMethod;
  private readonly clock: () => Date;
  private readonly observeTelegramSend: ObserveAsyncOperation;
  private readonly observeSettlement: ObserveAsyncOperation;

  constructor(dependencies: OutboxDispatcherDependencies) {
    const descriptors = Object.getOwnPropertyDescriptors(dependencies);
    const allowed = new Set([
      "repository", "identityResolver", "channels", "circuitBreaker", "now", "observeTelegramSend", "observeSettlement",
    ]);
    const required = ["repository", "identityResolver", "channels", "circuitBreaker"];
    const keys = Reflect.ownKeys(descriptors);
    if (dependencies === null || typeof dependencies !== "object" || Object.getPrototypeOf(dependencies) !== Object.prototype
      || keys.some((key) => typeof key !== "string" || !allowed.has(key))
      || required.some((key) => descriptors[key] === undefined)
      || keys.some((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
      })) {
      throw new TypeError("outbox_dependency_invalid");
    }
    const repository = descriptors.repository?.value as DeliveryRepositoryPort;
    const resolver = descriptors.identityResolver?.value as object;
    const channels = descriptors.channels?.value as ReadonlyMap<"telegram", TelegramProvider>;
    const breaker = descriptors.circuitBreaker?.value;
    if (repository === null || typeof repository !== "object" || resolver === null || typeof resolver !== "object"
      || !(breaker instanceof ProviderCircuitBreaker)) {
      throw new TypeError("outbox_dependency_invalid");
    }
    let entries: IterableIterator<["telegram", TelegramProvider]>;
    try { entries = Map.prototype.entries.call(channels) as IterableIterator<["telegram", TelegramProvider]>; }
    catch { throw new TypeError("outbox_channel_map_invalid"); }
    const copied = Array.from(entries);
    if (copied.length !== 1 || copied[0]?.[0] !== "telegram" || copied[0][1] === null
      || typeof copied[0][1] !== "object") {
      throw new TypeError("outbox_channel_map_invalid");
    }
    this.claimDelivery = captureMethod(repository, "claimDelivery");
    this.beginDelivery = captureMethod(repository, "beginDelivery");
    this.mintProviderDeliveryReceipt = captureMethod(repository, "mintProviderDeliveryReceipt");
    this.recordDeliverySuccess = captureMethod(repository, "recordDeliverySuccess");
    this.recordDeliveryFailure = captureMethod(repository, "recordDeliveryFailure");
    this.resolveIdentity = captureMethod(resolver, "resolveActive");
    this.providerSend = captureMethod(copied[0][1], "sendMessage");
    this.breakerAssertAllowed = captureMethod(breaker, "assertAllowed");
    this.breakerRecordSuccess = captureMethod(breaker, "recordSuccess");
    this.breakerRecordFailure = captureMethod(breaker, "recordFailure");
    const now = descriptors.now?.value ?? (() => new Date());
    if (typeof now !== "function") throw new TypeError("outbox_dependency_invalid");
    this.clock = now as () => Date;
    const observeTelegramSend = descriptors.observeTelegramSend?.value
      ?? (async <T>(operation: () => Promise<T>) => operation());
    const observeSettlement = descriptors.observeSettlement?.value
      ?? (async <T>(operation: () => Promise<T>) => operation());
    if (typeof observeTelegramSend !== "function" || typeof observeSettlement !== "function") {
      throw new TypeError("outbox_dependency_invalid");
    }
    this.observeTelegramSend = observeTelegramSend as ObserveAsyncOperation;
    this.observeSettlement = observeSettlement as ObserveAsyncOperation;
  }

  async dispatch(deliveryIdValue: ConversationDeliveryId): Promise<OutboxDispatchResult> {
    if (typeof deliveryIdValue !== "string" || !ULID.test(deliveryIdValue)) {
      throw new TypeError("delivery_id_invalid");
    }
    const deliveryId = deliveryIdValue;
    const claim = snapshotDeliveryClaim(await call<ReturnType<DeliveryRepositoryPort["claimDelivery"]>>(this.claimDelivery, {
      deliveryId,
      now: snapshotDate(this.clock()),
    }), deliveryId);
    if (claim.kind === "in_progress") {
      return Object.freeze({ outcome: "in_progress", deliveredAssistantEventId: null });
    }
    if (claim.kind === "unavailable") {
      return Object.freeze({ outcome: "retry_scheduled", deliveredAssistantEventId: null });
    }
    if (claim.kind === "terminal") return terminalResult(claim.item);
    const capability = claim.capability;
    const item = claim.item;
    call<void>(this.beginDelivery, capability, deliveryId, item.materialHash);
    let target: Readonly<TelegramDeliveryTarget> | null;
    try {
      target = snapshotTarget(await call<Promise<Readonly<TelegramDeliveryTarget> | null>>(
        this.resolveIdentity,
        Object.freeze({ principalId: item.principalId, targetIdentityId: item.targetIdentityId }),
      ), item.principalId, item.targetIdentityId);
    } catch (error) {
      return this.settleFailure(capability, error);
    }
    if (target === null) {
      return this.settleFailure(capability, ProviderFailure.permanent("invalid_request"));
    }
    let permit: ReturnType<ProviderCircuitBreaker["assertAllowed"]>;
    try {
      permit = call<ReturnType<ProviderCircuitBreaker["assertAllowed"]>>(
        this.breakerAssertAllowed,
        "telegram.sendMessage",
        snapshotDate(this.clock()),
      );
    } catch (error) {
      if (error instanceof ProviderCircuitOpenError
        && error.operation === "telegram.sendMessage"
        && error.category === "telegram_provider_unavailable") {
        return this.settleFailure(capability, ProviderFailure.transient("temporarily_unavailable"));
      }
      return this.settleFailure(capability, error);
    }
    let providerMessageId: string;
    try {
      providerMessageId = snapshotProviderResult(await this.observeTelegramSend(
        async () => call<Promise<TelegramSendMessageResult>>(this.providerSend, Object.freeze({
          chatId: target.providerSubject,
          text: item.text,
          ...(item.replyToMessageId === null ? {} : { replyToMessageId: item.replyToMessageId }),
          ...(item.replyMarkup === null ? {} : { replyMarkup: item.replyMarkup }),
          idempotencyKey: item.providerIdempotencyKey,
        })),
      ));
      call<void>(this.breakerRecordSuccess, permit);
    } catch (error) {
      call<void>(this.breakerRecordFailure, permit, error, snapshotDate(this.clock()));
      return this.settleFailure(capability, error);
    }
    const receipt = call<ReturnType<DeliveryRepositoryPort["mintProviderDeliveryReceipt"]>>(
      this.mintProviderDeliveryReceipt,
      { capability, providerMessageId },
    );
    let stored: StoredConversationDelivery;
    try {
      stored = snapshotStoredDelivery(await this.observeSettlement(
        () => call<ReturnType<DeliveryRepositoryPort["recordDeliverySuccess"]>>(this.recordDeliverySuccess, {
          capability,
          receipt,
          now: snapshotDate(this.clock()),
        }),
      ), "delivery_settlement_invalid") as StoredConversationDelivery;
    } catch {
      return Object.freeze({ outcome: "unknown", deliveredAssistantEventId: null });
    }
    if (stored.state !== "delivered") throw new Error("delivery_settlement_invalid");
    return Object.freeze({
      outcome: "delivered",
      deliveredAssistantEventId: stored.deliveredAssistantEventId,
    });
  }

  private async settleFailure(capability: DeliveryLeaseCapability, failure: unknown): Promise<OutboxDispatchResult> {
    let stored: StoredConversationDelivery;
    try {
      stored = snapshotStoredDelivery(await this.observeSettlement(
        () => call<ReturnType<DeliveryRepositoryPort["recordDeliveryFailure"]>>(this.recordDeliveryFailure, {
          capability,
          failure,
          now: snapshotDate(this.clock()),
        }),
      ), "delivery_settlement_invalid") as StoredConversationDelivery;
    } catch {
      return Object.freeze({ outcome: "unknown", deliveredAssistantEventId: null });
    }
    if (stored.state === "retry_wait") {
      return Object.freeze({ outcome: "retry_scheduled", deliveredAssistantEventId: null });
    }
    if (stored.state === "failed") {
      return Object.freeze({ outcome: "failed", deliveredAssistantEventId: null });
    }
    if (stored.state === "unknown") {
      return Object.freeze({ outcome: "unknown", deliveredAssistantEventId: null });
    }
    return Object.freeze({ outcome: "unknown", deliveredAssistantEventId: null });
  }
}

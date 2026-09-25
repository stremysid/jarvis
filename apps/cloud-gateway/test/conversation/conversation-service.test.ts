import { describe, expect, it, vi } from "vitest";
import { newUlid, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  createVoiceStreamDelivery,
  type ConversationDeliveryId,
  type ConversationTurnAdmission,
  type ConversationTurnResult,
  type ModelStreamClaimCapability,
  type StoredConversationDelivery,
  type StoredConversationTurn,
} from "../../src/conversation/conversation-types.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { ModelAdapterError } from "../../src/model/model-adapter.js";
import { Redactor } from "../../src/security/redaction.js";

const nowIso = "2026-08-30T12:00:00.000Z";
const requestHash = "0".repeat(64) as Sha256Hex;

function storedTurn(input: {
  turnId: Ulid;
  sessionId: string;
  principalId: string;
  channel: "voice" | "telegram";
  state?: StoredConversationTurn["state"];
  userEventId?: Ulid;
  sentAssistantEventId?: Ulid | null;
  stagedDeliveryId?: ConversationDeliveryId | null;
  deliveredAssistantEventId?: Ulid | null;
}): StoredConversationTurn {
  return Object.freeze({
    turnId: input.turnId,
    sessionId: input.sessionId,
    principalId: input.principalId,
    channel: input.channel,
    requestHash,
    userEventId: input.userEventId ?? newUlid(),
    state: input.state ?? "user_committed",
    modelClaimedAt: null,
    modelClaimExpiresAt: null,
    resolvedAt: null,
    stagedDeliveryId: input.stagedDeliveryId ?? null,
    sentAssistantEventId: input.sentAssistantEventId ?? null,
    deliveredAssistantEventId: input.deliveredAssistantEventId ?? null,
    failureCode: null,
    failureCategory: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

function storedDelivery(input: {
  deliveryId: ConversationDeliveryId;
  turnId: Ulid;
  principalId: string;
  targetIdentityId: string;
}): StoredConversationDelivery {
  return Object.freeze({
    deliveryId: input.deliveryId,
    correlationId: input.turnId,
    turnId: input.turnId,
    stagedEventId: newUlid(),
    principalId: input.principalId,
    targetIdentityId: input.targetIdentityId,
    replyToMessageId: 44,
    historyMode: "assistant",
    materialHash: "1".repeat(64) as Sha256Hex,
    providerIdempotencyKey: "conversation-delivery:test",
    state: "pending",
    attemptCount: 0,
    availableAt: nowIso,
    claimedAt: null,
    leaseExpiresAt: null,
    resolvedAt: null,
    providerMessageId: null,
    deliveredAssistantEventId: null,
    failureCode: null,
    failureCategory: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

describe("DefaultConversationService", () => {
  it("returns a durable terminal replay without claim, context, model, or delivery work", async () => {
    const turnId = newUlid();
    const assistantEventId = newUlid();
    const admitted = storedTurn({
      turnId,
      sessionId: "voice-session-replay",
      principalId: "principal:voice-owner",
      channel: "voice",
      state: "voice_sent",
      sentAssistantEventId: assistantEventId,
    });
    let downstreamCalls = 0;
    const repository = {
      async getOrCreateTurn(): Promise<ConversationTurnAdmission> {
        return Object.freeze({ turn: admitted, replayed: true });
      },
      async claimModelTurn(): Promise<never> { downstreamCalls += 1; throw new Error("unexpected_claim"); },
      beginModelStream(): never { downstreamCalls += 1; throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { downstreamCalls += 1; throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { downstreamCalls += 1; throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { downstreamCalls += 1; throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);
    const delivery = createVoiceStreamDelivery({
      sessionId: admitted.sessionId,
      turnId,
      sendToken: async () => { downstreamCalls += 1; },
      finish: async () => { downstreamCalls += 1; throw new Error("unexpected_finish"); },
    });

    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      ...delivery,
    })).resolves.toEqual({
      outcome: "voice_sent",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: assistantEventId,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
    expect(downstreamCalls).toBe(0);
  });

  it("returns in_progress for a live competing claim without context or model work", async () => {
    const turnId = newUlid();
    const admitted = storedTurn({
      turnId,
      sessionId: "telegram-session-competing",
      principalId: "principal:telegram-owner",
      channel: "telegram",
    });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    let downstreamCalls = 0;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: true }); },
      async claimModelTurn() { return Object.freeze({ kind: "in_progress" as const, turn: claimed }); },
      beginModelStream(): never { downstreamCalls += 1; throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { downstreamCalls += 1; throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { downstreamCalls += 1; throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { downstreamCalls += 1; throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);
    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId: "identity:telegram-owner",
      replyToMessageId: null,
    })).resolves.toEqual({
      outcome: "in_progress",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: null,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
    expect(downstreamCalls).toBe(0);
  });

  it("returns model_outcome_unknown when durable claim resolution fails", async () => {
    const turnId = newUlid();
    const admitted = storedTurn({
      turnId,
      sessionId: "voice-session-claim-unknown",
      principalId: "principal:voice-owner",
      channel: "voice",
    });
    let downstreamCalls = 0;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: false }); },
      async claimModelTurn(): Promise<never> { throw new Error("database secret"); },
      beginModelStream(): never { downstreamCalls += 1; throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { downstreamCalls += 1; throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { downstreamCalls += 1; throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { downstreamCalls += 1; throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);
    const delivery = createVoiceStreamDelivery({
      sessionId: admitted.sessionId,
      turnId,
      sendToken: async () => undefined,
      finish: async () => { throw new Error("unexpected_finish"); },
    });

    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      ...delivery,
    })).resolves.toEqual({
      outcome: "model_outcome_unknown",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: null,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
    expect(downstreamCalls).toBe(0);
  });

  it("streams only sanitized output to voice and records sent output as non-delivered", async () => {
    const turnId = newUlid();
    const userEventId = newUlid();
    const assistantEventId = newUlid();
    const sessionId = "voice-session-1";
    const principalId = "principal:voice-owner";
    const admitted = storedTurn({ turnId, sessionId, principalId, channel: "voice", userEventId });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const sent = Object.freeze({ ...claimed, state: "voice_sent" as const, sentAssistantEventId: assistantEventId });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    const repository = {
      async getOrCreateTurn(): Promise<ConversationTurnAdmission> {
        return Object.freeze({ turn: admitted, replayed: false });
      },
      async claimModelTurn(): Promise<Readonly<{ kind: "claimed"; capability: ModelStreamClaimCapability; turn: StoredConversationTurn }>> {
        return Object.freeze({ kind: "claimed", capability, turn: claimed });
      },
      beginModelStream(): void {},
      async recordVoiceSent(): Promise<StoredConversationTurn> { return sent; },
      async recordTurnCancelled(): Promise<StoredConversationTurn> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<StoredConversationTurn> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<void> { throw new Error("unexpected_ingest_failure"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    let modelInput: unknown;
    const model = {
      async *stream(input: unknown) {
        modelInput = input;
        yield Object.freeze({ index: 0, text: "Safe answer. Authorization: Bearer abcdefghi" });
        yield Object.freeze({ index: 1, text: "jklmnop12345678" });
      },
    };
    const context = { async retrieve() { return Object.freeze([]); } };
    const dispatcher = { async dispatch() { throw new Error("unexpected_dispatch"); } };
    const received: string[] = [];
    let finished = "";
    const delivery = createVoiceStreamDelivery({
      sessionId,
      turnId,
      sendToken: async (token) => { received.push(token.text); },
      finish: async (finalText) => { finished = finalText; },
    });
    const service = new DefaultConversationService({
      repository,
      model,
      context,
      dispatcher,
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);

    const result: ConversationTurnResult = await service.handleTurn({
      sessionId,
      principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      ...delivery,
    });

    expect(received.join("")).toBe("Safe answer. [REDACTED_AUTHORIZATION]");
    expect(finished).toBe("Safe answer. [REDACTED_AUTHORIZATION]");
    expect(modelInput).toMatchObject({
      reasoningEffort: "low",
      firstTokenTimeoutMs: 8_000,
      timeoutMs: 30_000,
      contextTokenBudget: 32_000,
      maxOutputCharacters: 8_000,
    });
    expect(result).toEqual({
      outcome: "voice_sent",
      committedUserEventId: userEventId,
      sentAssistantEventId: assistantEventId,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
  });

  it("stages Telegram output once and exposes delivered history only after dispatcher acknowledgement", async () => {
    const turnId = newUlid();
    const userEventId = newUlid();
    const deliveredAssistantEventId = newUlid();
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const admitted = storedTurn({
      turnId,
      sessionId: "telegram-session-1",
      principalId,
      channel: "telegram",
      userEventId,
    });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const stagedTurn = Object.freeze({ ...claimed, state: "assistant_staged" as const, stagedDeliveryId: deliveryId });
    const delivery = storedDelivery({ deliveryId, turnId, principalId, targetIdentityId });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    let stagedText = "";
    const repository = {
      async getOrCreateTurn(): Promise<ConversationTurnAdmission> {
        return Object.freeze({ turn: admitted, replayed: false });
      },
      async claimModelTurn() {
        return Object.freeze({ kind: "claimed" as const, capability, turn: claimed });
      },
      beginModelStream(): void {},
      async stageAssistantDelivery(input: { text: { text: string } }) {
        stagedText = input.text.text;
        return Object.freeze({ turn: stagedTurn, delivery });
      },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const model = {
      async *stream() { yield Object.freeze({ index: 0, text: "telegram answer" }); },
    };
    const dispatcher = {
      async dispatch(observedDeliveryId: ConversationDeliveryId) {
        if (observedDeliveryId !== deliveryId) throw new Error("wrong_delivery");
        return Object.freeze({ outcome: "delivered" as const, deliveredAssistantEventId });
      },
    };
    const service = new DefaultConversationService({
      repository,
      model,
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher,
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);

    const result = await service.handleTurn({
      sessionId: "telegram-session-1",
      principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId,
      replyToMessageId: 44,
    });

    expect(stagedText).toBe("telegram answer");
    expect(result).toEqual({
      outcome: "telegram_delivered",
      committedUserEventId: userEventId,
      sentAssistantEventId: null,
      deliveryId,
      deliveredAssistantEventId,
    });
  });

  it("stages only the fixed busy system notice and never calls context or the model", async () => {
    const noticeId = newUlid();
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const delivery = Object.freeze({
      ...storedDelivery({ deliveryId, turnId: noticeId, principalId, targetIdentityId }),
      correlationId: noticeId,
      turnId: null,
      historyMode: "system" as const,
    }) satisfies StoredConversationDelivery;
    let stagedInput: unknown;
    const repository = {
      async getOrCreateTurn(): Promise<never> { throw new Error("unexpected_turn"); },
      async claimModelTurn(): Promise<never> { throw new Error("unexpected_claim"); },
      beginModelStream(): never { throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_assistant"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(input: unknown): Promise<StoredConversationDelivery> {
        stagedInput = input;
        return delivery;
      },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);

    await expect(service.stageSystemNotice({
      noticeId,
      sessionId: "telegram-session-1",
      principalId,
      channel: "telegram",
      noticeCode: "busy",
      targetIdentityId,
      replyToMessageId: 44,
    })).resolves.toBe(deliveryId);
    expect(stagedInput).toEqual({
      noticeId,
      sessionId: "telegram-session-1",
      principalId,
      channel: "telegram",
      noticeCode: "busy",
      targetIdentityId,
      replyToMessageId: 44,
      now: new Date(nowIso),
    });
  });

  it("settles a begun model provider failure with fixed safe metadata", async () => {
    const turnId = newUlid();
    const sessionId = "voice-session-failed";
    const principalId = "principal:voice-owner";
    const admitted = storedTurn({ turnId, sessionId, principalId, channel: "voice" });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const failed = Object.freeze({
      ...claimed,
      state: "failed" as const,
      resolvedAt: nowIso,
      failureCode: "model_failed" as const,
      failureCategory: "provider" as const,
    });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    let settlement: unknown;
    const repository = {
      async getOrCreateTurn(): Promise<ConversationTurnAdmission> {
        return Object.freeze({ turn: admitted, replayed: false });
      },
      async claimModelTurn() {
        return Object.freeze({ kind: "claimed" as const, capability, turn: claimed });
      },
      beginModelStream(): void {},
      async recordTurnFailed(input: unknown): Promise<StoredConversationTurn> {
        settlement = input;
        return failed;
      },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: {
        async *stream() {
          throw new ModelAdapterError("model_provider_failure");
        },
      },
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);
    const delivery = createVoiceStreamDelivery({
      sessionId,
      turnId,
      sendToken: async () => { throw new Error("unexpected_token"); },
      finish: async () => { throw new Error("unexpected_finish"); },
    });

    await expect(service.handleTurn({
      sessionId,
      principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      ...delivery,
    })).resolves.toEqual({
      outcome: "failed",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: null,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
    expect(settlement).toEqual({
      claim: capability,
      failureCode: "model_failed",
      failureCategory: "provider",
      now: new Date(nowIso),
    });
  });

  it("settles caller-aborted model work as cancelled without finalizing voice output", async () => {
    const turnId = newUlid();
    const sessionId = "voice-session-cancelled";
    const principalId = "principal:voice-owner";
    const admitted = storedTurn({ turnId, sessionId, principalId, channel: "voice" });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const cancelled = Object.freeze({
      ...claimed,
      state: "cancelled" as const,
      resolvedAt: nowIso,
      failureCode: "model_cancelled" as const,
      failureCategory: "cancelled" as const,
    });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    const controller = new AbortController();
    let finishCalls = 0;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: false }); },
      async claimModelTurn() { return Object.freeze({ kind: "claimed" as const, capability, turn: claimed }); },
      beginModelStream(): void {},
      async recordTurnCancelled(): Promise<StoredConversationTurn> { return cancelled; },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: {
        async *stream() {
          controller.abort();
          throw new ModelAdapterError("model_aborted");
        },
      },
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);
    const delivery = createVoiceStreamDelivery({
      sessionId,
      turnId,
      sendToken: async () => { throw new Error("unexpected_token"); },
      finish: async () => { finishCalls += 1; },
    });

    await expect(service.handleTurn({
      sessionId,
      principalId,
      turnId,
      text: "hello",
      signal: controller.signal,
      ...delivery,
    })).resolves.toEqual({
      outcome: "cancelled",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: null,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
    expect(finishCalls).toBe(0);
  });

  it("returns model_outcome_unknown when voice persistence fails after finalization", async () => {
    const turnId = newUlid();
    const sessionId = "voice-session-unknown";
    const principalId = "principal:voice-owner";
    const admitted = storedTurn({ turnId, sessionId, principalId, channel: "voice" });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    let finishCalls = 0;
    const repository = {
      async getOrCreateTurn(): Promise<ConversationTurnAdmission> {
        return Object.freeze({ turn: admitted, replayed: false });
      },
      async claimModelTurn() {
        return Object.freeze({ kind: "claimed" as const, capability, turn: claimed });
      },
      beginModelStream(): void {},
      async recordVoiceSent(): Promise<never> { throw new Error("database secret"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { async *stream() { yield Object.freeze({ index: 0, text: "safe answer" }); } },
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);
    const delivery = createVoiceStreamDelivery({
      sessionId,
      turnId,
      sendToken: async () => undefined,
      finish: async () => { finishCalls += 1; },
    });

    await expect(service.handleTurn({
      sessionId,
      principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      ...delivery,
    })).resolves.toEqual({
      outcome: "model_outcome_unknown",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: null,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
    expect(finishCalls).toBe(1);
  });

  it("records a voice context failure and continues the model with no retrieved context", async () => {
    const turnId = newUlid();
    const assistantEventId = newUlid();
    const admitted = storedTurn({
      turnId,
      sessionId: "voice-session-context-unknown",
      principalId: "principal:voice-owner",
      channel: "voice",
    });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const sent = Object.freeze({ ...claimed, state: "voice_sent" as const, sentAssistantEventId: assistantEventId });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    let beginCalls = 0;
    let modelCalls = 0;
    let claimCalls = 0;
    let durable = admitted;
    let modelContext: unknown;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: durable, replayed: durable === sent }); },
      async claimModelTurn() {
        claimCalls += 1;
        return Object.freeze({ kind: "claimed" as const, capability, turn: claimed });
      },
      beginModelStream(): void { beginCalls += 1; },
      async recordVoiceSent(): Promise<StoredConversationTurn> { durable = sent; return sent; },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new DefaultConversationService({
      repository,
      model: { async *stream(input: { context: unknown }) {
        modelCalls += 1;
        modelContext = input.context;
        yield Object.freeze({ index: 0, text: "safe answer" });
      } },
      context: { async retrieve(): Promise<never> { throw new Error("database secret"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);

    const delivery = createVoiceStreamDelivery({
      sessionId: admitted.sessionId,
      turnId,
      sendToken: async () => undefined,
      finish: async () => undefined,
    });
    const input = {
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      ...delivery,
    } as const;

    try {
      await expect(service.handleTurn(input)).resolves.toMatchObject({
        outcome: "voice_sent", sentAssistantEventId: assistantEventId,
      });
      await expect(service.handleTurn(input)).resolves.toMatchObject({ outcome: "voice_sent" });
      expect(beginCalls).toBe(1);
      expect(modelCalls).toBe(1);
      expect(claimCalls).toBe(1);
      expect(modelContext).toEqual([expect.objectContaining({
        sourceEventId: turnId,
        sensitivity: "personal",
        text: expect.stringContaining("Memory could not be read this turn"),
      })]);
      expect(warn).toHaveBeenCalledExactlyOnceWith("voice_context_retrieval_fallback", {
        turnId, reason: "failure",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("database secret");
    } finally {
      warn.mockRestore();
    }
  });

  it("starts a voice model with recorded empty context at the hard 750 millisecond retrieval deadline", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const turnId = newUlid();
      const assistantEventId = newUlid();
      const admitted = storedTurn({
        turnId, sessionId: "voice-session-context-timeout", principalId: "principal:voice-owner", channel: "voice",
      });
      const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
      const sent = Object.freeze({ ...claimed, state: "voice_sent" as const, sentAssistantEventId: assistantEventId });
      const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
      let modelCalls = 0;
      let modelContext: unknown;
      const service = new DefaultConversationService({
        repository: {
          async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: false }); },
          async claimModelTurn() { return Object.freeze({ kind: "claimed" as const, capability, turn: claimed }); },
          beginModelStream(): void {},
          async recordVoiceSent() { return sent; },
          async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
          async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
          async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
          async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest"); },
          async stageSystemNotice(): Promise<never> { throw new Error("unexpected_notice"); },
        },
        context: { retrieve: () => new Promise<never>(() => undefined) },
        model: { async *stream(input: { context: unknown }) {
          modelCalls += 1;
          modelContext = input.context;
          yield Object.freeze({ index: 0, text: "safe answer" });
        } },
        dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
        redactor: new Redactor(),
        now: () => new Date(nowIso),
      } as never);
      const delivery = createVoiceStreamDelivery({
        sessionId: admitted.sessionId, turnId,
        sendToken: async () => undefined,
        finish: async () => undefined,
      });
      const pending = service.handleTurn({
        sessionId: admitted.sessionId, principalId: admitted.principalId, turnId,
        text: "hello", signal: new AbortController().signal, ...delivery,
      });

      await vi.advanceTimersByTimeAsync(749);
      expect(modelCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ outcome: "voice_sent" });
      expect(modelCalls).toBe(1);
      expect(modelContext).toEqual([expect.objectContaining({
        sourceEventId: turnId,
        sensitivity: "personal",
        text: expect.stringContaining("Memory could not be read this turn"),
      })]);
      expect(warn).toHaveBeenCalledExactlyOnceWith("voice_context_retrieval_fallback", {
        turnId, reason: "timeout",
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns model_outcome_unknown when Telegram staging fails after model completion", async () => {
    const turnId = newUlid();
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const admitted = storedTurn({
      turnId,
      sessionId: "telegram-session-unknown",
      principalId,
      channel: "telegram",
    });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    let dispatchCalls = 0;
    const repository = {
      async getOrCreateTurn(): Promise<ConversationTurnAdmission> {
        return Object.freeze({ turn: admitted, replayed: false });
      },
      async claimModelTurn() {
        return Object.freeze({ kind: "claimed" as const, capability, turn: claimed });
      },
      beginModelStream(): void {},
      async stageAssistantDelivery(): Promise<never> { throw new Error("database secret"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { async *stream() { yield Object.freeze({ index: 0, text: "safe answer" }); } },
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: {
        async dispatch(): Promise<never> { dispatchCalls += 1; throw new Error("unexpected_dispatch"); },
      },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);

    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId,
      replyToMessageId: null,
    })).resolves.toEqual({
      outcome: "model_outcome_unknown",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: null,
      deliveryId: null,
      deliveredAssistantEventId: null,
    });
    expect(dispatchCalls).toBe(0);
  });

  it("returns delivery_unknown when dispatch fails after durable Telegram staging", async () => {
    const turnId = newUlid();
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const admitted = storedTurn({
      turnId,
      sessionId: "telegram-session-dispatch-unknown",
      principalId,
      channel: "telegram",
    });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const stagedTurn = Object.freeze({
      ...claimed,
      state: "assistant_staged" as const,
      stagedDeliveryId: deliveryId,
    });
    const delivery = storedDelivery({ deliveryId, turnId, principalId, targetIdentityId });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    const repository = {
      async getOrCreateTurn(): Promise<ConversationTurnAdmission> {
        return Object.freeze({ turn: admitted, replayed: false });
      },
      async claimModelTurn() {
        return Object.freeze({ kind: "claimed" as const, capability, turn: claimed });
      },
      beginModelStream(): void {},
      async stageAssistantDelivery() { return Object.freeze({ turn: stagedTurn, delivery }); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { async *stream() { yield Object.freeze({ index: 0, text: "safe answer" }); } },
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("provider secret"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);

    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId,
      replyToMessageId: 44,
    })).resolves.toEqual({
      outcome: "delivery_unknown",
      committedUserEventId: admitted.userEventId,
      sentAssistantEventId: null,
      deliveryId,
      deliveredAssistantEventId: null,
    });
  });

  it.each([
    ["model_admission_unknown", false],
    ["model_admission_unknown", true],
    ["model_cancel_unknown", false],
    ["model_cancel_unknown", true],
  ] as const)("settles %s as durable ambiguity before abort handling (aborted: %s)", async (code, aborted) => {
    const turnId = newUlid();
    const admitted = storedTurn({
      turnId,
      sessionId: "voice-session-ambiguous",
      principalId: "principal:voice-owner",
      channel: "voice",
    });
    const claimed = Object.freeze({ ...admitted, state: "model_claimed" as const });
    const terminal = Object.freeze({
      ...claimed,
      state: "model_outcome_unknown" as const,
      resolvedAt: nowIso,
      failureCode: "model_outcome_unknown" as const,
      failureCategory: "ambiguous" as const,
    });
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    let durable = admitted;
    let contextCalls = 0;
    let modelCalls = 0;
    let tokenCalls = 0;
    let settlementCalls = 0;
    const controller = new AbortController();
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: durable, replayed: durable === terminal }); },
      async claimModelTurn() { return Object.freeze({ kind: "claimed" as const, capability, turn: claimed }); },
      beginModelStream(): void {},
      async recordTurnFailed(received: unknown) {
        expect(received).toEqual({
          claim: capability,
          failureCode: "model_outcome_unknown",
          failureCategory: "ambiguous",
          now: new Date(nowIso),
        });
        settlementCalls += 1;
        durable = terminal;
        return terminal;
      },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      // Cancellation after invocation cannot turn an uncertain provider outcome
      // into a known no-spend cancellation. An already-aborted request is now
      // rejected before this boundary and has its own real-repository regression.
      model: { async *stream() { modelCalls += 1; if (aborted) controller.abort(); throw new ModelAdapterError(code); } },
      context: { async retrieve() { contextCalls += 1; return Object.freeze([]); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date(nowIso),
    } as never);
    const delivery = createVoiceStreamDelivery({
      sessionId: admitted.sessionId,
      turnId,
      sendToken: async () => { tokenCalls += 1; },
      finish: async () => { throw new Error("unexpected_finish"); },
    });
    const turnInput = {
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: controller.signal,
      ...delivery,
    } as const;

    await expect(service.handleTurn(turnInput)).resolves.toMatchObject({ outcome: "model_outcome_unknown" });
    await expect(service.handleTurn(turnInput)).resolves.toMatchObject({ outcome: "model_outcome_unknown" });
    expect({ contextCalls, modelCalls, tokenCalls, settlementCalls }).toEqual({
      contextCalls: 1,
      modelCalls: 1,
      tokenCalls: 0,
      settlementCalls: 1,
    });
  });
});

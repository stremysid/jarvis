import { describe, expect, it } from "vitest";
import { newUlid, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import type {
  ConversationDeliveryId,
  ModelStreamClaimCapability,
  StoredConversationDelivery,
  StoredConversationTurn,
} from "../../src/conversation/conversation-types.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import {
  D1TelegramIdentityResolver,
  DefaultOutboxDispatcher,
} from "../../src/conversation/outbox-dispatcher.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";

describe("conversation capture-once security", () => {
  it("uses the repository method captured at construction after caller mutation", async () => {
    const turnId = newUlid();
    let originalCalls = 0;
    const repository = {
      async getOrCreateTurn(): Promise<never> { throw new Error("unexpected_turn"); },
      async claimModelTurn(): Promise<never> { throw new Error("unexpected_claim"); },
      beginModelStream(): never { throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<void> { originalCalls += 1; },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: {
        redact(): never { throw new Error("raw secret from redactor"); },
        redactText(): never { throw new Error("unexpected_output_redaction"); },
      },
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);
    repository.recordIngestFailure = async (): Promise<void> => {
      throw new Error("mutated repository method");
    };

    await expect(service.handleTurn({
      sessionId: "voice-session-security",
      principalId: "principal:voice-owner",
      turnId,
      text: "Authorization: Bearer secret-value",
      signal: new AbortController().signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: async () => undefined,
      finish: async () => { throw new Error("unexpected_finish"); },
    } as never)).rejects.toThrow("ingest_redaction_failed");
    expect(originalCalls).toBe(1);
  });

  it("uses the output-redaction method captured at construction after caller mutation", async () => {
    const turnId = newUlid();
    const requestHash = "0".repeat(64) as Sha256Hex;
    const common = {
      turnId,
      sessionId: "voice-session-security",
      principalId: "principal:voice-owner",
      channel: "voice" as const,
      requestHash,
      userEventId: newUlid(),
      modelClaimedAt: "2026-08-30T12:00:00.000Z",
      modelClaimExpiresAt: "2026-08-30T12:00:45.000Z",
      stagedDeliveryId: null,
      deliveredAssistantEventId: null,
      failureCode: null,
      failureCategory: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    const admitted = Object.freeze({
      ...common,
      state: "user_committed" as const,
      modelClaimedAt: null,
      modelClaimExpiresAt: null,
      resolvedAt: null,
      sentAssistantEventId: null,
    }) satisfies StoredConversationTurn;
    const claimed = Object.freeze({
      ...common,
      state: "model_claimed" as const,
      resolvedAt: null,
      sentAssistantEventId: null,
    }) satisfies StoredConversationTurn;
    const sent = Object.freeze({
      ...common,
      state: "voice_sent" as const,
      resolvedAt: "2026-08-30T12:00:01.000Z",
      sentAssistantEventId: newUlid(),
      updatedAt: "2026-08-30T12:00:01.000Z",
    }) satisfies StoredConversationTurn;
    const capability = Object.freeze({ turnId, requestHash }) as ModelStreamClaimCapability;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: false }); },
      async claimModelTurn() { return Object.freeze({ kind: "claimed" as const, capability, turn: claimed }); },
      beginModelStream(): void {},
      async recordVoiceSent() { return sent; },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const implementation = new Redactor();
    let originalOutputCalls = 0;
    let swappedOutputCalls = 0;
    const redactor = {
      redact: implementation.redact.bind(implementation),
      redactText(text: string) {
        originalOutputCalls += 1;
        return implementation.redactText(text);
      },
    };
    const received: string[] = [];
    let finished = "";
    const service = new DefaultConversationService({
      repository,
      model: {
        async *stream() {
          yield Object.freeze({ index: 0, text: "safe output" });
        },
      },
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor,
      now: () => new Date("2026-08-30T12:00:01.000Z"),
    } as never);
    redactor.redactText = (_text: string) => {
      swappedOutputCalls += 1;
      return implementation.redactText("swapped output");
    };

    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: async (token) => { received.push(token.text); },
      finish: async (text) => {
        finished = text;
        return Object.freeze({});
      },
    } as never)).resolves.toMatchObject({ outcome: "voice_sent" });
    expect(received.join("")).toBe("safe output");
    expect(finished).toBe("safe output");
    expect(originalOutputCalls).toBeGreaterThan(0);
    expect(swappedOutputCalls).toBe(0);
  });

  it("never exposes an ingest-failure settlement exception", async () => {
    const turnId = newUlid();
    const repository = {
      async getOrCreateTurn(): Promise<never> { throw new Error("unexpected_turn"); },
      async claimModelTurn(): Promise<never> { throw new Error("unexpected_claim"); },
      beginModelStream(): never { throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("database secret"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: {
        redact(): never { throw new Error("raw secret from redactor"); },
        redactText(): never { throw new Error("unexpected_output_redaction"); },
      },
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);

    await expect(service.handleTurn({
      sessionId: "voice-session-security",
      principalId: "principal:voice-owner",
      turnId,
      text: "Authorization: Bearer secret-value",
      signal: new AbortController().signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: async () => undefined,
      finish: async () => { throw new Error("unexpected_finish"); },
    } as never)).rejects.toThrow(/^ingest_redaction_failed$/u);
  });

  it("never exposes a turn-admission dependency exception", async () => {
    const repository = {
      async getOrCreateTurn(): Promise<never> { throw new Error("database secret"); },
      async claimModelTurn(): Promise<never> { throw new Error("unexpected_claim"); },
      beginModelStream(): never { throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);

    await expect(service.handleTurn({
      sessionId: "voice-session-security",
      principalId: "principal:voice-owner",
      turnId: newUlid(),
      text: "hello",
      signal: new AbortController().signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: async () => undefined,
      finish: async () => { throw new Error("unexpected_finish"); },
    } as never)).rejects.toThrow(/^conversation_admission_failed$/u);
  });

  it("uses the dispatcher repository method captured at construction after caller mutation", async () => {
    const deliveryId = newUlid() as ConversationDeliveryId;
    const terminal = Object.freeze({
      deliveryId,
      correlationId: newUlid(),
      turnId: newUlid(),
      stagedEventId: newUlid(),
      principalId: "principal:telegram-owner",
      targetIdentityId: "identity:telegram-owner",
      replyToMessageId: null,
      historyMode: "assistant" as const,
      materialHash: "2".repeat(64) as Sha256Hex,
      providerIdempotencyKey: "conversation-delivery:security",
      state: "failed" as const,
      attemptCount: 1,
      availableAt: "2026-08-30T12:00:00.000Z",
      claimedAt: "2026-08-30T12:00:00.000Z",
      leaseExpiresAt: "2026-08-30T12:00:30.000Z",
      resolvedAt: "2026-08-30T12:00:01.000Z",
      providerMessageId: null,
      deliveredAssistantEventId: null,
      failureCode: "delivery_permanent" as const,
      failureCategory: "invalid_request" as const,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:01.000Z",
    }) satisfies StoredConversationDelivery;
    let originalCalls = 0;
    const repository = {
      async claimDelivery() {
        originalCalls += 1;
        return Object.freeze({ kind: "terminal" as const, item: terminal });
      },
      beginDelivery(): never { throw new Error("unexpected_begin"); },
      mintProviderDeliveryReceipt(): never { throw new Error("unexpected_receipt"); },
      async recordDeliverySuccess(): Promise<never> { throw new Error("unexpected_success"); },
      async recordDeliveryFailure(): Promise<never> { throw new Error("unexpected_failure"); },
    };
    const dispatcher = new DefaultOutboxDispatcher({
      repository,
      identityResolver: { async resolveActive(): Promise<never> { throw new Error("unexpected_resolve"); } },
      channels: new Map([["telegram", new FakeTelegramProvider()]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);
    repository.claimDelivery = async () => { throw new Error("mutated repository method"); };

    await expect(dispatcher.dispatch(deliveryId)).resolves.toEqual({
      outcome: "failed",
      deliveredAssistantEventId: null,
    });
    expect(originalCalls).toBe(1);
  });

  it("rejects an accessor-shaped turn admission before claim or model work", async () => {
    const turnId = newUlid();
    const terminal = Object.freeze({
      turnId,
      sessionId: "voice-session-security",
      principalId: "principal:voice-owner",
      channel: "voice" as const,
      requestHash: "0".repeat(64) as Sha256Hex,
      userEventId: newUlid(),
      state: "failed" as const,
      modelClaimedAt: null,
      modelClaimExpiresAt: null,
      resolvedAt: "2026-08-30T12:00:00.000Z",
      stagedDeliveryId: null,
      sentAssistantEventId: null,
      deliveredAssistantEventId: null,
      failureCode: "model_failed" as const,
      failureCategory: "provider" as const,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    }) satisfies StoredConversationTurn;
    const admission = Object.defineProperties({}, {
      turn: { enumerable: true, get: () => terminal },
      replayed: { enumerable: true, value: true },
    });
    let claimCalls = 0;
    const repository = {
      async getOrCreateTurn() { return admission; },
      async claimModelTurn(): Promise<never> { claimCalls += 1; throw new Error("unexpected_claim"); },
      beginModelStream(): never { throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);

    await expect(service.handleTurn({
      sessionId: terminal.sessionId,
      principalId: terminal.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: async () => undefined,
      finish: async () => { throw new Error("unexpected_finish"); },
    } as never)).rejects.toThrow("conversation_admission_invalid");
    expect(claimCalls).toBe(0);
  });

  it("rejects an accessor-shaped model claim before model work", async () => {
    const turnId = newUlid();
    const common = {
      turnId,
      sessionId: "voice-session-security",
      principalId: "principal:voice-owner",
      channel: "voice" as const,
      requestHash: "0".repeat(64) as Sha256Hex,
      userEventId: newUlid(),
      modelClaimedAt: null,
      modelClaimExpiresAt: null,
      stagedDeliveryId: null,
      sentAssistantEventId: null,
      deliveredAssistantEventId: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    const admitted = Object.freeze({
      ...common,
      state: "user_committed" as const,
      resolvedAt: null,
      failureCode: null,
      failureCategory: null,
    }) satisfies StoredConversationTurn;
    const terminal = Object.freeze({
      ...common,
      state: "model_outcome_unknown" as const,
      resolvedAt: "2026-08-30T12:00:00.000Z",
      failureCode: "model_outcome_unknown" as const,
      failureCategory: "ambiguous" as const,
    }) satisfies StoredConversationTurn;
    const claim = Object.defineProperties({}, {
      kind: { enumerable: true, get: () => "terminal" },
      turn: { enumerable: true, value: terminal },
    });
    let modelCalls = 0;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: false }); },
      async claimModelTurn() { return claim; },
      beginModelStream(): never { throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { modelCalls += 1; throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);

    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: async () => undefined,
      finish: async () => { throw new Error("unexpected_finish"); },
    } as never)).rejects.toThrow("conversation_claim_invalid");
    expect(modelCalls).toBe(0);
  });

  it("rejects an accessor-shaped delivery claim before lease or provider work", async () => {
    const deliveryId = newUlid() as ConversationDeliveryId;
    const terminal = Object.freeze({
      deliveryId,
      correlationId: newUlid(),
      turnId: newUlid(),
      stagedEventId: newUlid(),
      principalId: "principal:telegram-owner",
      targetIdentityId: "identity:telegram-owner",
      replyToMessageId: null,
      historyMode: "assistant" as const,
      materialHash: "2".repeat(64) as Sha256Hex,
      providerIdempotencyKey: "conversation-delivery:security",
      state: "failed" as const,
      attemptCount: 1,
      availableAt: "2026-08-30T12:00:00.000Z",
      claimedAt: "2026-08-30T12:00:00.000Z",
      leaseExpiresAt: "2026-08-30T12:00:30.000Z",
      resolvedAt: "2026-08-30T12:00:01.000Z",
      providerMessageId: null,
      deliveredAssistantEventId: null,
      failureCode: "delivery_permanent" as const,
      failureCategory: "invalid_request" as const,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:01.000Z",
    }) satisfies StoredConversationDelivery;
    const claim = Object.defineProperties({}, {
      kind: { enumerable: true, get: () => "terminal" },
      item: { enumerable: true, value: terminal },
    });
    let beginCalls = 0;
    const repository = {
      async claimDelivery() { return claim; },
      beginDelivery(): void { beginCalls += 1; },
      mintProviderDeliveryReceipt(): never { throw new Error("unexpected_receipt"); },
      async recordDeliverySuccess(): Promise<never> { throw new Error("unexpected_success"); },
      async recordDeliveryFailure(): Promise<never> { throw new Error("unexpected_failure"); },
    };
    const provider = new FakeTelegramProvider();
    const dispatcher = new DefaultOutboxDispatcher({
      repository,
      identityResolver: { async resolveActive(): Promise<never> { throw new Error("unexpected_resolve"); } },
      channels: new Map([["telegram", provider]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);

    await expect(dispatcher.dispatch(deliveryId)).rejects.toThrow("delivery_claim_invalid");
    expect(beginCalls).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects accessor-shaped retrieved context before beginning the model stream", async () => {
    const turnId = newUlid();
    const common = {
      turnId,
      sessionId: "voice-session-security",
      principalId: "principal:voice-owner",
      channel: "voice" as const,
      requestHash: "0".repeat(64) as Sha256Hex,
      userEventId: newUlid(),
      modelClaimedAt: null,
      modelClaimExpiresAt: null,
      resolvedAt: null,
      stagedDeliveryId: null,
      sentAssistantEventId: null,
      deliveredAssistantEventId: null,
      failureCode: null,
      failureCategory: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    const admitted = Object.freeze({ ...common, state: "user_committed" as const }) satisfies StoredConversationTurn;
    const claimed = Object.freeze({ ...common, state: "model_claimed" as const }) satisfies StoredConversationTurn;
    const capability = Object.freeze({ turnId, requestHash: common.requestHash }) as ModelStreamClaimCapability;
    const contextItem = Object.defineProperties({}, {
      sourceEventId: { enumerable: true, value: newUlid() },
      text: { enumerable: true, get: () => "malicious accessor" },
      sensitivity: { enumerable: true, value: "personal" },
    });
    let beginCalls = 0;
    let modelCalls = 0;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: false }); },
      async claimModelTurn() { return Object.freeze({ kind: "claimed" as const, capability, turn: claimed }); },
      beginModelStream(): void { beginCalls += 1; },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: {
        async *stream() {
          modelCalls += 1;
          yield Object.freeze({ index: 0, text: "safe" });
        },
      },
      context: { async retrieve() { return [contextItem]; } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: new Redactor(),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);

    await expect(service.handleTurn({
      sessionId: admitted.sessionId,
      principalId: admitted.principalId,
      turnId,
      text: "hello",
      signal: new AbortController().signal,
      channel: "voice",
      kind: "voice_stream",
      onToken: async () => undefined,
      finish: async () => Object.freeze({}),
    } as never)).rejects.toThrow("conversation_context_invalid");
    expect(beginCalls).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it("rejects an accessor-shaped Telegram stage result before dispatch", async () => {
    const turnId = newUlid();
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const common = {
      turnId,
      sessionId: "telegram-session-security",
      principalId,
      channel: "telegram" as const,
      requestHash: "0".repeat(64) as Sha256Hex,
      userEventId: newUlid(),
      modelClaimedAt: null,
      modelClaimExpiresAt: null,
      resolvedAt: null,
      sentAssistantEventId: null,
      deliveredAssistantEventId: null,
      failureCode: null,
      failureCategory: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    const admitted = Object.freeze({
      ...common,
      state: "user_committed" as const,
      stagedDeliveryId: null,
    }) satisfies StoredConversationTurn;
    const claimed = Object.freeze({
      ...common,
      state: "model_claimed" as const,
      stagedDeliveryId: null,
    }) satisfies StoredConversationTurn;
    const stagedTurn = Object.freeze({
      ...common,
      state: "assistant_staged" as const,
      stagedDeliveryId: deliveryId,
    }) satisfies StoredConversationTurn;
    const delivery = Object.freeze({
      deliveryId,
      correlationId: turnId,
      turnId,
      stagedEventId: newUlid(),
      principalId,
      targetIdentityId,
      replyToMessageId: null,
      historyMode: "assistant" as const,
      materialHash: "2".repeat(64) as Sha256Hex,
      providerIdempotencyKey: "conversation-delivery:security",
      state: "pending" as const,
      attemptCount: 0,
      availableAt: "2026-08-30T12:00:00.000Z",
      claimedAt: null,
      leaseExpiresAt: null,
      resolvedAt: null,
      providerMessageId: null,
      deliveredAssistantEventId: null,
      failureCode: null,
      failureCategory: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    }) satisfies StoredConversationDelivery;
    const stageResult = Object.defineProperties({}, {
      turn: { enumerable: true, get: () => stagedTurn },
      delivery: { enumerable: true, value: delivery },
    });
    const capability = Object.freeze({ turnId, requestHash: common.requestHash }) as ModelStreamClaimCapability;
    let dispatchCalls = 0;
    const repository = {
      async getOrCreateTurn() { return Object.freeze({ turn: admitted, replayed: false }); },
      async claimModelTurn() { return Object.freeze({ kind: "claimed" as const, capability, turn: claimed }); },
      beginModelStream(): void {},
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery() { return stageResult; },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest_failure"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_system_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { async *stream() { yield Object.freeze({ index: 0, text: "safe" }); } },
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: {
        async dispatch() {
          dispatchCalls += 1;
          return Object.freeze({ outcome: "in_progress" as const, deliveredAssistantEventId: null });
        },
      },
      redactor: new Redactor(),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
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
    })).rejects.toThrow("conversation_stage_invalid");
    expect(dispatchCalls).toBe(0);
  });

  it("rejects an accessor-shaped D1 context result container", async () => {
    const result = Object.defineProperty({}, "results", {
      enumerable: true,
      get: () => [],
    });
    const database = {
      prepare() {
        return {
          bind() {
            return { async all() { return result; } };
          },
        };
      },
    };

    await expect(new D1ContextRetriever(database as never).retrieve({
      principalId: "principal:context-owner",
      channel: "voice",
      purpose: "conversation",
      query: "hello",
      maxTokens: 32_000,
    })).rejects.toThrow("context_result_invalid");
  });

  it("rejects an accessor-shaped Telegram identity row", async () => {
    const row = Object.defineProperties({}, {
      principal_id: { enumerable: true, get: () => "principal:telegram-owner" },
      identity_id: { enumerable: true, value: "identity:telegram-owner" },
      provider_subject: { enumerable: true, value: "123456789" },
    });
    const database = {
      prepare() {
        return {
          bind() {
            return { async first() { return row; } };
          },
        };
      },
    };

    await expect(new D1TelegramIdentityResolver(database as never).resolveActive({
      principalId: "principal:telegram-owner",
      targetIdentityId: "identity:telegram-owner",
    })).rejects.toThrow("telegram_identity_row_invalid");
  });

  it("rejects channel mismatches, extra delivery authority, and structural signals before redaction", async () => {
    let redactorCalls = 0;
    const repository = {
      async getOrCreateTurn(): Promise<never> { throw new Error("unexpected_turn"); },
      async claimModelTurn(): Promise<never> { throw new Error("unexpected_claim"); },
      beginModelStream(): never { throw new Error("unexpected_begin"); },
      async recordVoiceSent(): Promise<never> { throw new Error("unexpected_voice"); },
      async stageAssistantDelivery(): Promise<never> { throw new Error("unexpected_stage"); },
      async recordTurnCancelled(): Promise<never> { throw new Error("unexpected_cancel"); },
      async recordTurnFailed(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordIngestFailure(): Promise<never> { throw new Error("unexpected_ingest"); },
      async stageSystemNotice(): Promise<never> { throw new Error("unexpected_notice"); },
    };
    const service = new DefaultConversationService({
      repository,
      model: { stream(): never { throw new Error("unexpected_model"); } },
      context: { async retrieve(): Promise<never> { throw new Error("unexpected_context"); } },
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_dispatch"); } },
      redactor: {
        redact(): never { redactorCalls += 1; throw new Error("unexpected_redaction"); },
        redactText(): never { throw new Error("unexpected_output_redaction"); },
      },
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    } as never);
    const common = {
      sessionId: "session:security",
      principalId: "principal:owner",
      turnId: newUlid(),
      text: "hello",
    };
    const invalid: unknown[] = [
      {
        ...common,
        signal: new AbortController().signal,
        channel: "voice",
        kind: "voice_stream",
        onToken: async () => undefined,
        finish: async () => Object.freeze({}),
        chatId: "123456789",
      },
      {
        ...common,
        signal: new AbortController().signal,
        channel: "telegram",
        kind: "outbox",
        onToken: async () => undefined,
        finish: async () => Object.freeze({}),
      },
      {
        ...common,
        signal: new AbortController().signal,
        channel: "voice",
        kind: "outbox",
        onToken: async () => undefined,
        finish: async () => Object.freeze({}),
      },
      {
        ...common,
        signal: { aborted: false },
        channel: "voice",
        kind: "voice_stream",
        onToken: async () => undefined,
        finish: async () => Object.freeze({}),
      },
    ];

    for (const input of invalid) {
      await expect(service.handleTurn(input as never)).rejects.toThrow(/conversation_.*invalid/u);
    }
    expect(redactorCalls).toBe(0);
  });
});

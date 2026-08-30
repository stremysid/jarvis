import { describe, expect, it } from "vitest";
import { newUlid, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import {
  type ClaimedConversationDelivery,
  type ConversationDeliveryId,
  type DeliveryLeaseCapability,
  type ProviderDeliveryReceipt,
  type StoredConversationDelivery,
} from "../../src/conversation/conversation-types.js";
import { DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { ProviderFailure, snapshotProviderFailure } from "../../src/providers/provider-types.js";

const nowIso = "2026-08-30T12:00:00.000Z";
const materialHash = "2".repeat(64) as Sha256Hex;

function claimedDelivery(input: {
  deliveryId: ConversationDeliveryId;
  principalId: string;
  targetIdentityId: string;
  text: string;
}): ClaimedConversationDelivery {
  return Object.freeze({
    deliveryId: input.deliveryId,
    correlationId: newUlid(),
    turnId: newUlid(),
    stagedEventId: newUlid(),
    principalId: input.principalId,
    targetIdentityId: input.targetIdentityId,
    replyToMessageId: 91,
    historyMode: "assistant",
    materialHash,
    providerIdempotencyKey: "conversation-delivery:example",
    state: "claimed",
    attemptCount: 1,
    availableAt: nowIso,
    claimedAt: nowIso,
    leaseExpiresAt: "2026-08-30T12:00:30.000Z",
    resolvedAt: null,
    providerMessageId: null,
    deliveredAssistantEventId: null,
    failureCode: null,
    failureCategory: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    text: input.text,
  });
}

describe("DefaultOutboxDispatcher", () => {
  it("delivers one claimed Telegram item to its resolved active identity and acknowledges history", async () => {
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const item = claimedDelivery({ deliveryId, principalId, targetIdentityId, text: "safe answer" });
    const capability = Object.freeze({ deliveryId, materialHash }) as DeliveryLeaseCapability;
    const receipt = Object.freeze({
      deliveryId,
      targetIdentityId,
      providerIdempotencyKey: item.providerIdempotencyKey,
      materialHash,
      providerMessageId: "telegram-message-00000001",
    }) as ProviderDeliveryReceipt;
    const deliveredAssistantEventId = newUlid();
    const { text: _claimedText, ...storedItem } = item;
    const delivered = Object.freeze({
      ...storedItem,
      state: "delivered" as const,
      resolvedAt: nowIso,
      providerMessageId: receipt.providerMessageId,
      deliveredAssistantEventId,
    }) satisfies StoredConversationDelivery;
    const repository = {
      async claimDelivery() {
        return Object.freeze({ kind: "claimed" as const, capability, item });
      },
      beginDelivery(): void {},
      mintProviderDeliveryReceipt(): ProviderDeliveryReceipt { return receipt; },
      async recordDeliverySuccess(): Promise<StoredConversationDelivery> { return delivered; },
      async recordDeliveryRetry(): Promise<never> { throw new Error("unexpected_retry"); },
      async recordDeliveryFailure(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordDeliveryUnknown(): Promise<never> { throw new Error("unexpected_unknown"); },
    };
    const provider = new FakeTelegramProvider();
    const dispatcher = new DefaultOutboxDispatcher({
      repository,
      identityResolver: {
        async resolveActive() {
          return Object.freeze({ principalId, identityId: targetIdentityId, providerSubject: "123456789" });
        },
      },
      channels: new Map([["telegram", provider]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => new Date(nowIso),
    } as never);

    const result = await dispatcher.dispatch(deliveryId);

    expect(provider.requests).toEqual([{
      chatId: "123456789",
      text: "safe answer",
      replyToMessageId: 91,
      idempotencyKey: "conversation-delivery:example",
    }]);
    expect(result).toEqual({ outcome: "delivered", deliveredAssistantEventId });
  });

  it("settles an untyped provider failure as unknown and never exposes the exception", async () => {
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const item = claimedDelivery({ deliveryId, principalId, targetIdentityId, text: "safe answer" });
    const capability = Object.freeze({ deliveryId, materialHash }) as DeliveryLeaseCapability;
    const { text: _claimedText, ...storedItem } = item;
    const unknown = Object.freeze({
      ...storedItem,
      state: "unknown" as const,
      resolvedAt: nowIso,
      failureCode: "delivery_unknown" as const,
      failureCategory: "ambiguous" as const,
    }) satisfies StoredConversationDelivery;
    const repository = {
      async claimDelivery() { return Object.freeze({ kind: "claimed" as const, capability, item }); },
      beginDelivery(): void {},
      mintProviderDeliveryReceipt(): never { throw new Error("unexpected_receipt"); },
      async recordDeliverySuccess(): Promise<never> { throw new Error("unexpected_success"); },
      async recordDeliveryRetry(): Promise<never> { throw new Error("unexpected_retry"); },
      async recordDeliveryFailure(): Promise<never> { throw new Error("unexpected_failure"); },
      async recordDeliveryUnknown(): Promise<StoredConversationDelivery> { return unknown; },
    };
    const provider = new FakeTelegramProvider();
    provider.failNext(new Error("raw provider secret"));
    const dispatcher = new DefaultOutboxDispatcher({
      repository,
      identityResolver: {
        async resolveActive() {
          return Object.freeze({ principalId, identityId: targetIdentityId, providerSubject: "123456789" });
        },
      },
      channels: new Map([["telegram", provider]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => new Date(nowIso),
    } as never);

    await expect(dispatcher.dispatch(deliveryId)).resolves.toEqual({
      outcome: "unknown",
      deliveredAssistantEventId: null,
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("begins the lease before identity resolution and settles a disabled target without provider work", async () => {
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-disabled";
    const item = claimedDelivery({ deliveryId, principalId, targetIdentityId, text: "safe answer" });
    const capability = Object.freeze({ deliveryId, materialHash }) as DeliveryLeaseCapability;
    const { text: _claimedText, ...storedItem } = item;
    const failed = Object.freeze({
      ...storedItem,
      state: "failed" as const,
      resolvedAt: nowIso,
      failureCode: "delivery_permanent" as const,
      failureCategory: "invalid_request" as const,
    }) satisfies StoredConversationDelivery;
    const calls: string[] = [];
    const repository = {
      async claimDelivery() {
        calls.push("claim");
        return Object.freeze({ kind: "claimed" as const, capability, item });
      },
      beginDelivery(): void { calls.push("begin"); },
      mintProviderDeliveryReceipt(): never { throw new Error("unexpected_receipt"); },
      async recordDeliverySuccess(): Promise<never> { throw new Error("unexpected_success"); },
      async recordDeliveryFailure(input: { failure: unknown }): Promise<StoredConversationDelivery> {
        calls.push("settle");
        expect(snapshotProviderFailure(input.failure)).toEqual({
          code: "provider_permanent_failure",
          category: "invalid_request",
        });
        return failed;
      },
    };
    const provider = new FakeTelegramProvider();
    const dispatcher = new DefaultOutboxDispatcher({
      repository,
      identityResolver: {
        async resolveActive() {
          calls.push("resolve");
          return null;
        },
      },
      channels: new Map([["telegram", provider]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => new Date(nowIso),
    } as never);

    await expect(dispatcher.dispatch(deliveryId)).resolves.toEqual({
      outcome: "failed",
      deliveredAssistantEventId: null,
    });
    expect(provider.requests).toHaveLength(0);
    expect(calls).toEqual(["claim", "begin", "resolve", "settle"]);
  });

  it("turns an open Telegram circuit into a known pre-acceptance retry", async () => {
    const deliveryId = newUlid() as ConversationDeliveryId;
    const principalId = "principal:telegram-owner";
    const targetIdentityId = "identity:telegram-owner";
    const item = claimedDelivery({ deliveryId, principalId, targetIdentityId, text: "safe answer" });
    const capability = Object.freeze({ deliveryId, materialHash }) as DeliveryLeaseCapability;
    const { text: _claimedText, ...storedItem } = item;
    const retry = Object.freeze({
      ...storedItem,
      state: "retry_wait" as const,
      availableAt: "2026-08-30T12:00:01.000Z",
      resolvedAt: nowIso,
      failureCode: "delivery_retry" as const,
      failureCategory: "provider" as const,
    }) satisfies StoredConversationDelivery;
    const repository = {
      async claimDelivery() { return Object.freeze({ kind: "claimed" as const, capability, item }); },
      beginDelivery(): void {},
      mintProviderDeliveryReceipt(): never { throw new Error("unexpected_receipt"); },
      async recordDeliverySuccess(): Promise<never> { throw new Error("unexpected_success"); },
      async recordDeliveryFailure(input: { failure: unknown }): Promise<StoredConversationDelivery> {
        expect(snapshotProviderFailure(input.failure)).toEqual({
          code: "provider_transient_failure",
          category: "temporarily_unavailable",
        });
        return retry;
      },
    };
    const provider = new FakeTelegramProvider();
    const breaker = new ProviderCircuitBreaker();
    for (let index = 0; index < 5; index += 1) {
      const permit = breaker.assertAllowed("telegram.sendMessage", new Date(nowIso));
      breaker.recordFailure(permit, ProviderFailure.transient("temporarily_unavailable"), new Date(nowIso));
    }
    const dispatcher = new DefaultOutboxDispatcher({
      repository,
      identityResolver: {
        async resolveActive() {
          return Object.freeze({ principalId, identityId: targetIdentityId, providerSubject: "123456789" });
        },
      },
      channels: new Map([["telegram", provider]]),
      circuitBreaker: breaker,
      now: () => new Date(nowIso),
    } as never);

    await expect(dispatcher.dispatch(deliveryId)).resolves.toEqual({
      outcome: "retry_scheduled",
      deliveredAssistantEventId: null,
    });
    expect(provider.requests).toHaveLength(0);
  });
});

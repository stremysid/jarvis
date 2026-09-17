import { describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ConversationDeliveryId } from "../../src/conversation/conversation-types.js";
import {
  TelegramTurnObserver,
  telegramTurnOutcomeLog,
  type TelegramTurnTimings,
} from "../../src/channels/telegram/telegram-turn-observability.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-types.js";
import { DeepSeekAdapterError } from "../../src/providers/deepseek-provider.js";

const input: ModelAdapterStreamInput = Object.freeze({
  correlationId: "01m1hh9h1yxaeyjgbhfzm4nnth" as Ulid,
  principalId: "principal-a",
  channel: "telegram",
  userText: "hello",
  context: Object.freeze([]),
  reasoningEffort: "low",
  firstTokenTimeoutMs: 5_000,
  timeoutMs: 20_000,
  contextTokenBudget: 1_000,
  maxOutputCharacters: 4_000,
  signal: new AbortController().signal,
});

async function drain(tokens: AsyncIterable<unknown>): Promise<void> {
  for await (const _token of tokens) { /* consume the observed stream */ }
}

describe("Telegram turn observability", () => {
  it("measures context, full structured response, model total, delivery and provider calls", async () => {
    let now = 0;
    let call = 0;
    const observer = new TelegramTurnObserver(() => now);
    observer.observeMemoryRetrieval({ candidatesMs: 2, historyMs: 3, mergeMs: 4, d1RoundTrips: 5 });
    const context = observer.observeContext({
      async retrieve() {
        now += 11;
        return Object.freeze([]);
      },
    });
    const provider = observer.observeProvider({
      async *stream() {
        call += 1;
        now += call === 1 ? 20 : 30;
        yield Object.freeze({ index: 0, text: call === 1 ? "classification" : "answer" });
        now += 2;
      },
    });
    const structured = observer.observeModel({
      async *stream(received) {
        await drain(provider.stream(received));
        await drain(provider.stream(received));
        yield Object.freeze({ index: 0, text: "final answer" });
        now += 7;
      },
    });
    const delivery = observer.observeDelivery({
      async dispatch() {
        now += 1;
        await observer.observeTelegramSend(async () => { now += 5; });
        await observer.observeSettlement(async () => { now += 7; });
        return Object.freeze({ outcome: "delivered", deliveredAssistantEventId: input.correlationId });
      },
    });

    await context.retrieve({
      principalId: "principal-a", channel: "telegram", purpose: "conversation", query: "hello", maxTokens: 100,
    });
    await drain(structured.stream(input));
    await observer.observeStaging(async () => { now += 3; });
    await delivery.dispatch(input.correlationId as unknown as ConversationDeliveryId);

    expect(observer.snapshot()).toEqual({
      contextRetrievalMs: 11,
      memoryCandidatesMs: 2,
      memoryHistoryMs: 3,
      memoryMergeMs: 4,
      retrievalD1RoundTrips: 5,
      modelFirstResponseMs: 54,
      modelTotalMs: 61,
      deliveryMs: 13,
      stagingMs: 3,
      telegramSendMs: 5,
      settlementMs: 7,
      providerCallCount: 2,
      modelFailureReason: null,
      meaningSearchMs: 0,
      meaningSearchFallbackCode: null,
    });
  });

  it.each([
    "http_400", "http_401", "http_402", "http_403", "http_429", "http_5xx",
    "network", "timeout", "input_invalid", "other",
  ] as const)("logs fixed model failure reason %s without the adapter message", async (reason) => {
    const observer = new TelegramTurnObserver(() => 0);
    const provider = observer.observeProvider({
      async *stream() {
        throw new DeepSeekAdapterError(reason, "private provider response body");
      },
    });
    const model = observer.observeModel(provider);
    await expect(drain(model.stream(input))).rejects.toThrow("private provider response body");

    const payload = telegramTurnOutcomeLog("event-1", "failed", observer.snapshot());
    expect(payload).toEqual({
      eventId: "event-1",
      outcome: "failed",
      contextRetrievalMs: 0,
      memoryCandidatesMs: 0,
      memoryHistoryMs: 0,
      memoryMergeMs: 0,
      retrievalD1RoundTrips: 0,
      modelFirstResponseMs: 0,
      modelTotalMs: 0,
      deliveryMs: 0,
      stagingMs: 0,
      telegramSendMs: 0,
      settlementMs: 0,
      providerCallCount: 1,
      meaningSearchMs: 0,
      meaningSearchFallbackCode: null,
      failureReason: reason,
    });
    expect(JSON.stringify(payload)).not.toContain("private provider response body");
    expect(payload).not.toHaveProperty("deliveryId");
  });

  it("omits a model reason from delivery and cancellation outcomes", () => {
    const timings: TelegramTurnTimings = {
      contextRetrievalMs: 1,
      memoryCandidatesMs: 2,
      memoryHistoryMs: 3,
      memoryMergeMs: 4,
      retrievalD1RoundTrips: 5,
      modelFirstResponseMs: 6,
      modelTotalMs: 7,
      deliveryMs: 8,
      stagingMs: 9,
      telegramSendMs: 10,
      settlementMs: 11,
      providerCallCount: 1,
      modelFailureReason: "timeout",
      meaningSearchMs: 17,
      meaningSearchFallbackCode: "memory_meaning_search_timeout",
    };
    expect(telegramTurnOutcomeLog("event-1", "delivery_unknown", timings)).not.toHaveProperty("failureReason");
    expect(telegramTurnOutcomeLog("event-1", "cancelled", timings)).not.toHaveProperty("failureReason");
  });

  it("logs a redacted meaning-search duration and fallback code on every turn outcome", () => {
    const observer = new TelegramTurnObserver(() => 0);
    observer.recordMeaningSearch({
      meaningSearchMs: 450,
      fallbackCode: "memory_meaning_search_provider_error",
    });

    expect(telegramTurnOutcomeLog("event-1", "telegram_delivered", observer.snapshot())).toMatchObject({
      meaningSearchMs: 450,
      meaningSearchFallbackCode: "memory_meaning_search_provider_error",
    });
  });
});

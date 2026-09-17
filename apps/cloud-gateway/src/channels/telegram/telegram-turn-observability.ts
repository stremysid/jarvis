import type {
  ContextRetriever,
  ContextRetrieverInput,
  ConversationDeliveryId,
  ConversationTurnResult,
  OutboxDispatcher,
} from "../../conversation/conversation-types.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../model/model-types.js";
import {
  deepSeekFailureReason,
  type DeepSeekFailureReason,
} from "../../providers/deepseek-provider.js";
import type { TelegramMeaningSearchObservation } from "../../memory/telegram-memory-retriever.js";

export interface TelegramTurnTimings {
  readonly contextRetrievalMs: number;
  readonly modelFirstResponseMs: number;
  readonly modelTotalMs: number;
  readonly deliveryMs: number;
  readonly providerCallCount: number;
  readonly modelFailureReason: DeepSeekFailureReason | null;
  readonly meaningSearchMs: number;
  readonly meaningSearchFallbackCode: TelegramMeaningSearchObservation["fallbackCode"];
}

type MillisecondClock = () => number;

function defaultClock(): number {
  return performance.now();
}

/** Measures only the accepted Telegram turn; wrappers never change an operation's result. */
export class TelegramTurnObserver {
  readonly #now: MillisecondClock;
  #contextRetrievalMs = 0;
  #modelFirstResponseMs = 0;
  #modelTotalMs = 0;
  #deliveryMs = 0;
  #providerCallCount = 0;
  #modelFailureReason: DeepSeekFailureReason | null = null;
  #meaningSearchMs = 0;
  #meaningSearchFallbackCode: TelegramMeaningSearchObservation["fallbackCode"] = null;

  constructor(now: MillisecondClock = defaultClock) {
    this.#now = now;
  }

  #elapsed(startedAt: number): number {
    const elapsed = this.#now() - startedAt;
    return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
  }

  observeContext(context: ContextRetriever): ContextRetriever {
    const observer = this;
    return Object.freeze({
      async retrieve(input: ContextRetrieverInput) {
        const startedAt = observer.#now();
        try {
          return await context.retrieve(input);
        } finally {
          observer.#contextRetrievalMs += observer.#elapsed(startedAt);
        }
      },
    });
  }

  observeProvider(model: ModelAdapter): ModelAdapter {
    const observer = this;
    return Object.freeze({
      async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
        observer.#providerCallCount += 1;
        try {
          yield* model.stream(input);
        } catch (error) {
          observer.#modelFailureReason = deepSeekFailureReason(error);
          throw error;
        }
      },
    });
  }

  observeModel(model: ModelAdapter): ModelAdapter {
    const observer = this;
    return Object.freeze({
      async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
        const startedAt = observer.#now();
        let firstResponseSeen = false;
        try {
          for await (const token of model.stream(input)) {
            if (!firstResponseSeen) {
              firstResponseSeen = true;
              observer.#modelFirstResponseMs = observer.#elapsed(startedAt);
            }
            yield token;
          }
        } catch (error) {
          if (observer.#modelFailureReason === null) {
            observer.#modelFailureReason = deepSeekFailureReason(error);
          }
          throw error;
        } finally {
          observer.#modelTotalMs = observer.#elapsed(startedAt);
        }
      },
    });
  }

  observeDelivery(dispatcher: OutboxDispatcher): OutboxDispatcher {
    const observer = this;
    return Object.freeze({
      async dispatch(deliveryId: ConversationDeliveryId) {
        const startedAt = observer.#now();
        try {
          return await dispatcher.dispatch(deliveryId);
        } finally {
          observer.#deliveryMs += observer.#elapsed(startedAt);
        }
      },
    });
  }

  recordMeaningSearch(observation: TelegramMeaningSearchObservation): void {
    this.#meaningSearchMs = observation.meaningSearchMs;
    this.#meaningSearchFallbackCode = observation.fallbackCode;
  }

  snapshot(): TelegramTurnTimings {
    return Object.freeze({
      contextRetrievalMs: this.#contextRetrievalMs,
      modelFirstResponseMs: this.#modelFirstResponseMs,
      modelTotalMs: this.#modelTotalMs,
      deliveryMs: this.#deliveryMs,
      providerCallCount: this.#providerCallCount,
      modelFailureReason: this.#modelFailureReason,
      meaningSearchMs: this.#meaningSearchMs,
      meaningSearchFallbackCode: this.#meaningSearchFallbackCode,
    });
  }
}

/** Builds the bounded log payload: no chat, message, delivery or provider ids. */
export function telegramTurnOutcomeLog(
  eventId: string,
  outcome: ConversationTurnResult["outcome"],
  timings: TelegramTurnTimings,
): Readonly<Record<string, unknown>> {
  const common = {
    eventId,
    outcome,
    contextRetrievalMs: timings.contextRetrievalMs,
    modelFirstResponseMs: timings.modelFirstResponseMs,
    modelTotalMs: timings.modelTotalMs,
    deliveryMs: timings.deliveryMs,
    providerCallCount: timings.providerCallCount,
    meaningSearchMs: timings.meaningSearchMs,
    meaningSearchFallbackCode: timings.meaningSearchFallbackCode,
  };
  return Object.freeze(
    timings.modelFailureReason !== null
      && (outcome === "failed" || outcome === "model_outcome_unknown")
      ? { ...common, failureReason: timings.modelFailureReason }
      : common,
  );
}

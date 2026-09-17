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

export interface TelegramTurnTimings {
  readonly contextRetrievalMs: number;
  readonly memoryCandidatesMs: number;
  readonly memoryHistoryMs: number;
  readonly memoryMergeMs: number;
  readonly retrievalD1RoundTrips: number;
  readonly modelFirstResponseMs: number;
  readonly modelTotalMs: number;
  readonly deliveryMs: number;
  readonly stagingMs: number;
  readonly telegramSendMs: number;
  readonly settlementMs: number;
  readonly providerCallCount: number;
  readonly modelFailureReason: DeepSeekFailureReason | null;
}

type MillisecondClock = () => number;

function defaultClock(): number {
  return performance.now();
}

/** Measures only the accepted Telegram turn; wrappers never change an operation's result. */
export class TelegramTurnObserver {
  readonly #now: MillisecondClock;
  #contextRetrievalMs = 0;
  #memoryCandidatesMs = 0;
  #memoryHistoryMs = 0;
  #memoryMergeMs = 0;
  #retrievalD1RoundTrips = 0;
  #modelFirstResponseMs = 0;
  #modelTotalMs = 0;
  #deliveryMs = 0;
  #stagingMs = 0;
  #telegramSendMs = 0;
  #settlementMs = 0;
  #providerCallCount = 0;
  #modelFailureReason: DeepSeekFailureReason | null = null;

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

  observeMemoryRetrieval(metrics: Readonly<{
    candidatesMs: number;
    historyMs: number;
    mergeMs: number;
    d1RoundTrips: number;
  }>): void {
    this.#memoryCandidatesMs += metrics.candidatesMs;
    this.#memoryHistoryMs += metrics.historyMs;
    this.#memoryMergeMs += metrics.mergeMs;
    this.#retrievalD1RoundTrips += metrics.d1RoundTrips;
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

  async observeStaging<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = this.#now();
    try {
      return await operation();
    } finally {
      this.#stagingMs += this.#elapsed(startedAt);
    }
  }

  async observeTelegramSend<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = this.#now();
    try {
      return await operation();
    } finally {
      this.#telegramSendMs += this.#elapsed(startedAt);
    }
  }

  async observeSettlement<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = this.#now();
    try {
      return await operation();
    } finally {
      this.#settlementMs += this.#elapsed(startedAt);
    }
  }

  snapshot(): TelegramTurnTimings {
    return Object.freeze({
      contextRetrievalMs: this.#contextRetrievalMs,
      memoryCandidatesMs: this.#memoryCandidatesMs,
      memoryHistoryMs: this.#memoryHistoryMs,
      memoryMergeMs: this.#memoryMergeMs,
      retrievalD1RoundTrips: this.#retrievalD1RoundTrips,
      modelFirstResponseMs: this.#modelFirstResponseMs,
      modelTotalMs: this.#modelTotalMs,
      deliveryMs: this.#deliveryMs,
      stagingMs: this.#stagingMs,
      telegramSendMs: this.#telegramSendMs,
      settlementMs: this.#settlementMs,
      providerCallCount: this.#providerCallCount,
      modelFailureReason: this.#modelFailureReason,
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
    memoryCandidatesMs: timings.memoryCandidatesMs,
    memoryHistoryMs: timings.memoryHistoryMs,
    memoryMergeMs: timings.memoryMergeMs,
    retrievalD1RoundTrips: timings.retrievalD1RoundTrips,
    modelFirstResponseMs: timings.modelFirstResponseMs,
    modelTotalMs: timings.modelTotalMs,
    deliveryMs: timings.deliveryMs,
    stagingMs: timings.stagingMs,
    telegramSendMs: timings.telegramSendMs,
    settlementMs: timings.settlementMs,
    providerCallCount: timings.providerCallCount,
  };
  return Object.freeze(
    timings.modelFailureReason !== null
      && (outcome === "failed" || outcome === "model_outcome_unknown")
      ? { ...common, failureReason: timings.modelFailureReason }
      : common,
  );
}

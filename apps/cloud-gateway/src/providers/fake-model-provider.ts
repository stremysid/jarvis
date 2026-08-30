import { canonicalJson } from "../../../../packages/contracts/src/index.js";
import {
  ProviderFailure,
  type ModelChunk,
  type ModelCompleteJsonInput,
  type ModelContextItem,
  type ModelProvider,
  type ModelStreamTextInput,
} from "./provider-types.js";

export interface FakeModelProviderOptions {
  streamText?: string;
  streamTokenCount?: number;
  completeJson?: unknown;
  completeJsonTokenCount?: number;
  manual?: boolean;
}

export type FakeModelRequest =
  | (Readonly<Omit<ModelStreamTextInput, "context">> & {
    readonly operation: "streamText";
    readonly context: readonly Readonly<ModelContextItem>[];
  })
  | (Readonly<ModelCompleteJsonInput> & { readonly operation: "completeJson" });

interface AttemptControl {
  readonly delay: number;
  readonly failure: Error | undefined;
}

interface ManualWaiter {
  readonly resolve: (value: IteratorResult<ModelChunk>) => void;
  readonly reject: (reason: unknown) => void;
}

function cloneContext(context: readonly ModelContextItem[]): readonly Readonly<ModelContextItem>[] {
  return Object.freeze(context.map((item) => Object.freeze({
    sourceEventId: item.sourceEventId,
    text: item.text,
    sensitivity: item.sensitivity,
  })));
}

function snapshotSignal(signal: AbortSignal): AbortSignal {
  const snapshot = new AbortController();
  if (signal.aborted) snapshot.abort();
  return snapshot.signal;
}

function cloneStreamRequest(input: ModelStreamTextInput): FakeModelRequest {
  return Object.freeze({
    operation: "streamText" as const,
    correlationId: input.correlationId,
    principalId: input.principalId,
    channel: input.channel,
    userText: input.userText,
    context: cloneContext(input.context),
    timeoutMs: input.timeoutMs,
    contextTokenBudget: input.contextTokenBudget,
    reasoningEffort: input.reasoningEffort,
    signal: snapshotSignal(input.signal),
  });
}

function cloneCompleteRequest(input: ModelCompleteJsonInput): FakeModelRequest {
  return Object.freeze({
    operation: "completeJson" as const,
    correlationId: input.correlationId,
    principalId: input.principalId,
    purpose: input.purpose,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort,
  });
}

function cloneRequest(input: FakeModelRequest): FakeModelRequest {
  return input.operation === "streamText" ? cloneStreamRequest(input) : cloneCompleteRequest(input);
}

function splitTokens(text: string, tokenCount: number): readonly string[] {
  const characters = [...text.normalize("NFC")];
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0
    || characters.length === 0 && tokenCount !== 0
    || characters.length > 0 && (tokenCount === 0 || tokenCount > characters.length)) {
    throw new RangeError("fake_model_token_count_invalid");
  }
  if (tokenCount === 0) return Object.freeze([]);

  const tokens: string[] = [];
  const baseSize = Math.floor(characters.length / tokenCount);
  const remainder = characters.length % tokenCount;
  let offset = 0;
  for (let index = 0; index < tokenCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    tokens.push(characters.slice(offset, offset + size).join(""));
    offset += size;
  }
  return Object.freeze(tokens);
}

function abortError(): DOMException {
  return new DOMException("model_request_aborted", "AbortError");
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  if (milliseconds === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class ManualModelStream implements AsyncIterableIterator<ModelChunk> {
  private readonly queued: ModelChunk[] = [];
  private waiter: ManualWaiter | null = null;
  private failure: Error | null = null;
  private completed = false;
  private closed = false;
  private nextIndex = 0;
  private readonly ready: Promise<void>;
  private listening = false;

  constructor(
    private readonly signal: AbortSignal,
    control: AttemptControl,
    private readonly onInactive: () => void,
  ) {
    this.ready = wait(control.delay, signal).then(() => {
      if (control.failure !== undefined) throw control.failure;
    });
  }

  start(): void {
    if (this.signal.aborted) {
      this.abort();
      return;
    }
    this.signal.addEventListener("abort", this.abort, { once: true });
    this.listening = true;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ModelChunk> {
    return this;
  }

  async next(): Promise<IteratorResult<ModelChunk>> {
    if (this.waiter !== null) throw new Error("fake_model_manual_next_pending");
    try {
      await this.ready;
    } catch (error) {
      this.failInternal(error instanceof Error ? error : new Error("fake_model_manual_initial_failure"));
    }
    if (this.queued.length > 0) return { done: false, value: this.queued.shift()! };
    if (this.failure !== null) throw this.failure;
    if (this.completed || this.closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<ModelChunk>>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  async return(): Promise<IteratorResult<ModelChunk>> {
    if (!this.closed) {
      this.closed = true;
      this.queued.length = 0;
      this.waiter?.resolve({ done: true, value: undefined });
      this.waiter = null;
      this.deactivate();
    }
    return { done: true, value: undefined };
  }

  emitToken(text: string): void {
    this.requireActive();
    if (typeof text !== "string" || text.length === 0 || !text.isWellFormed() || text !== text.normalize("NFC")) {
      throw new TypeError("fake_model_manual_token_invalid");
    }
    const chunk = Object.freeze({ type: "token" as const, index: this.nextIndex, text });
    this.nextIndex += 1;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ done: false, value: chunk });
    } else {
      this.queued.push(chunk);
    }
  }

  complete(): void {
    this.requireActive();
    const chunk = Object.freeze({ type: "completed" as const });
    this.completed = true;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ done: false, value: chunk });
    } else {
      this.queued.push(chunk);
    }
    this.deactivate();
  }

  fail(error: Error): void {
    this.requireActive();
    if (!(error instanceof Error)) throw new TypeError("fake_model_manual_failure_invalid");
    this.failInternal(error);
  }

  private readonly abort = (): void => {
    if (this.closed || this.completed || this.failure !== null) return;
    this.queued.length = 0;
    this.failInternal(abortError());
  };

  private failInternal(error: Error): void {
    if (this.failure === null) this.failure = error;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(this.failure);
    }
    this.deactivate();
  }

  private requireActive(): void {
    if (this.closed || this.completed || this.failure !== null) throw new Error("fake_model_manual_stream_inactive");
  }

  private deactivate(): void {
    if (this.listening) {
      this.signal.removeEventListener("abort", this.abort);
      this.listening = false;
    }
    this.onInactive();
  }
}

export class FakeModelProvider implements ModelProvider {
  private readonly requestLog: FakeModelRequest[] = [];
  private readonly failures: Error[] = [];
  private readonly delays: number[] = [];
  private readonly tokens: readonly string[];
  private readonly completeJsonText: string;
  private readonly completeJsonTokenCount: number;
  private readonly manual: boolean;
  private manualActive: ManualModelStream | undefined;

  constructor(options: FakeModelProviderOptions = {}) {
    if (options.manual !== undefined && typeof options.manual !== "boolean") {
      throw new TypeError("fake_model_manual_mode_invalid");
    }
    this.manual = options.manual ?? false;
    const streamText = options.streamText ?? "ok";
    const streamTokenCount = options.streamTokenCount ?? (streamText.length === 0 ? 0 : 1);
    this.tokens = splitTokens(streamText, streamTokenCount);
    this.completeJsonText = canonicalJson(options.completeJson ?? {});
    this.completeJsonTokenCount = options.completeJsonTokenCount ?? 1;
    if (!Number.isSafeInteger(this.completeJsonTokenCount) || this.completeJsonTokenCount < 0) {
      throw new RangeError("fake_model_complete_json_token_count_invalid");
    }
  }

  get requests(): readonly FakeModelRequest[] {
    return Object.freeze(this.requestLog.map((input) => cloneRequest(input)));
  }

  failNext(error: Error): void {
    this.failures.push(error);
  }

  delayNext(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("provider_delay_invalid");
    this.delays.push(milliseconds);
  }

  streamText(input: ModelStreamTextInput): AsyncIterable<ModelChunk> {
    const liveSignal = input.signal;
    if (this.manual) {
      if (this.manualActive !== undefined) throw new Error("fake_model_manual_stream_active");
      const control = this.beginAttempt(cloneStreamRequest(input));
      let stream!: ManualModelStream;
      stream = new ManualModelStream(liveSignal, control, () => {
        if (this.manualActive === stream) this.manualActive = undefined;
      });
      this.manualActive = stream;
      stream.start();
      return stream;
    }
    const control = this.beginAttempt(cloneStreamRequest(input));
    return this.streamCaptured(control, liveSignal);
  }

  emitToken(text: string): void {
    this.requireManualActive().emitToken(text);
  }

  complete(): void {
    this.requireManualActive().complete();
  }

  fail(error: Error): void {
    this.requireManualActive().fail(error);
  }

  private async *streamCaptured(control: AttemptControl, liveSignal: AbortSignal): AsyncIterable<ModelChunk> {
    await wait(control.delay, liveSignal);
    if (liveSignal.aborted) throw abortError();
    if (control.failure !== undefined) throw control.failure;

    for (let index = 0; index < this.tokens.length; index += 1) {
      if (liveSignal.aborted) throw abortError();
      yield Object.freeze({ type: "token" as const, index, text: this.tokens[index]! });
    }
    if (liveSignal.aborted) throw abortError();
    yield Object.freeze({ type: "completed" as const });
  }

  async completeJson(input: ModelCompleteJsonInput): Promise<unknown> {
    const control = this.beginAttempt(cloneCompleteRequest(input));
    await wait(control.delay);
    if (control.failure !== undefined) throw control.failure;
    if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < this.completeJsonTokenCount) {
      throw ProviderFailure.permanent("output_limit");
    }
    return JSON.parse(this.completeJsonText) as unknown;
  }

  private beginAttempt(request: FakeModelRequest): AttemptControl {
    this.requestLog.push(cloneRequest(request));
    return {
      delay: this.delays.shift() ?? 0,
      failure: this.failures.shift(),
    };
  }

  private requireManualActive(): ManualModelStream {
    if (!this.manual) throw new Error("fake_model_manual_mode_required");
    if (this.manualActive === undefined) throw new Error("fake_model_manual_stream_inactive");
    return this.manualActive;
  }
}

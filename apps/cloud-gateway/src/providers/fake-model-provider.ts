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

export class FakeModelProvider implements ModelProvider {
  private readonly requestLog: FakeModelRequest[] = [];
  private readonly failures: Error[] = [];
  private readonly delays: number[] = [];
  private readonly tokens: readonly string[];
  private readonly completeJsonText: string;
  private readonly completeJsonTokenCount: number;

  constructor(options: FakeModelProviderOptions = {}) {
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
    const control = this.beginAttempt(cloneStreamRequest(input));
    return this.streamCaptured(control, liveSignal);
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
}

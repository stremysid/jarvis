import type {
  ModelChunk,
  ModelProvider,
  ModelStreamTextInput,
} from "../providers/provider-types.js";
import type {
  ModelAdapter,
  ModelAdapterStreamInput,
  ModelToken,
  RetrievedContext,
} from "./model-types.js";
import type { Ulid } from "../../../../packages/contracts/src/index.js";

export type {
  ModelAdapter,
  ModelAdapterStreamInput,
  ModelToken,
  RetrievedContext,
} from "./model-types.js";

const INPUT_FIELDS = new Set([
  "correlationId",
  "principalId",
  "channel",
  "userText",
  "context",
  "reasoningEffort",
  "firstTokenTimeoutMs",
  "timeoutMs",
  "contextTokenBudget",
  "maxOutputCharacters",
  "signal",
]);
const CONTEXT_FIELDS = new Set(["sourceEventId", "text", "sensitivity"]);
const TOKEN_FIELDS = new Set(["type", "index", "text"]);
const COMPLETED_FIELDS = new Set(["type"]);
const ITERATOR_RESULT_FIELDS = new Set(["done", "value"]);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const MAXIMUM_FIRST_TOKEN_TIMEOUT_MS = 8_000;
const MAXIMUM_TOTAL_TIMEOUT_MS = 30_000;
const MAXIMUM_CONTEXT_TOKEN_BUDGET = 32_000;
const MAXIMUM_OUTPUT_CHARACTERS = 65_536;
const MAXIMUM_OUTPUT_BYTES = 65_536;
const MAXIMUM_INPUT_CHARACTERS = 8_000;
const MAXIMUM_INPUT_BYTES = 65_536;
const MAXIMUM_CONTEXT_ITEMS = 128;
const encoder = new TextEncoder();

export type ModelAdapterErrorCode =
  | "model_input_invalid"
  | "model_context_invalid"
  | "model_protocol_invalid"
  | "model_first_token_timeout"
  | "model_total_timeout"
  | "model_output_limit"
  | "model_aborted"
  | "model_provider_failure"
  | "model_admission_unknown"
  | "model_cancel_unknown";

/** Fixed metadata for a failed model attempt; provider values are never retained. */
export class ModelAdapterError extends Error {
  readonly category = "model_stream_failed" as const;

  constructor(readonly code: ModelAdapterErrorCode) {
    super(code);
    this.name = "ModelAdapterError";
    Object.freeze(this);
  }
}

const providerNotStartedErrors = new WeakSet<ModelAdapterError>();

export function modelProviderNotStartedError(): ModelAdapterError {
  const error = new ModelAdapterError("model_provider_failure");
  providerNotStartedErrors.add(error);
  return error;
}

export function isModelProviderNotStartedError(error: unknown): error is ModelAdapterError {
  return error instanceof ModelAdapterError && providerNotStartedErrors.has(error);
}

interface CapturedMethod {
  readonly receiver: object;
  readonly method: (...args: never[]) => unknown;
}

type CapturedInput = Readonly<ModelAdapterStreamInput>;

interface CapturedIteratorResult {
  readonly done: boolean;
  readonly value: unknown;
}

type NextOutcome =
  | { readonly kind: "next"; readonly value: unknown }
  | { readonly kind: "provider_failure" }
  | { readonly kind: "first_timeout" }
  | { readonly kind: "total_timeout" }
  | { readonly kind: "aborted" };

function failure(code: ModelAdapterErrorCode): ModelAdapterError {
  return new ModelAdapterError(code);
}

function exactDataRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> | null {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) return null;
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { return null; }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }
  return captured;
}

function capturedMethod(value: unknown, key: PropertyKey): CapturedMethod | null {
  if (value === null || typeof value !== "object" && typeof value !== "function") return null;
  let current: object | null = value as object;
  const visited = new Set<object>();
  try {
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
        return Object.freeze({
          receiver: value as object,
          method: descriptor.value as (...args: never[]) => unknown,
        });
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return null;
  }
  return null;
}

function safeText(value: unknown, maximumCharacters: number, maximumBytes: number, allowEmpty = false): value is string {
  if (typeof value !== "string" || !value.isWellFormed() || value !== value.normalize("NFC")) return false;
  if (!allowEmpty && value.length === 0) return false;
  let characters = 0;
  for (const _character of value) {
    characters += 1;
    if (characters > maximumCharacters) return false;
  }
  return encoder.encode(value).byteLength <= maximumBytes;
}

function safeAtom(value: unknown): value is string {
  return safeText(value, 256, 1_024) && !value.includes("\r") && !value.includes("\n");
}

function canonicalNonemptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC");
}

function boundedPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID.test(value);
}

function signalAborted(value: unknown): boolean | null {
  if (value === null || typeof value !== "object") return null;
  try {
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (getter === undefined) return null;
    const aborted = Reflect.apply(getter, value, []) as unknown;
    return typeof aborted === "boolean" ? aborted : null;
  } catch {
    return null;
  }
}

function snapshotContext(value: unknown, budget: number): readonly Readonly<RetrievedContext>[] {
  if (!Array.isArray(value)) throw failure("model_context_invalid");
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw failure("model_context_invalid");
  }
  if (prototype !== Array.prototype || lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAXIMUM_CONTEXT_ITEMS) throw failure("model_context_invalid");
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || keys.some((key) => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return true;
    const index = Number(key);
    return !Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key;
  })) throw failure("model_context_invalid");

  let contextBytes = 0;
  const copied: Readonly<RetrievedContext>[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { throw failure("model_context_invalid"); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw failure("model_context_invalid");
    }
    const item = exactDataRecord(descriptor.value, CONTEXT_FIELDS);
    if (item === null || !isUlid(item.sourceEventId)
      || !safeText(item.text, MAXIMUM_OUTPUT_CHARACTERS, MAXIMUM_OUTPUT_BYTES)
      || item.sensitivity !== "personal" && item.sensitivity !== "restricted") {
      throw failure("model_context_invalid");
    }
    contextBytes += encoder.encode(item.text).byteLength;
    if (contextBytes > budget) throw failure("model_context_invalid");
    copied.push(Object.freeze({
      sourceEventId: item.sourceEventId,
      text: item.text,
      sensitivity: item.sensitivity,
    }));
  }
  return Object.freeze(copied);
}

export function snapshotModelAdapterStreamInput(value: unknown): Readonly<ModelAdapterStreamInput> {
  const record = exactDataRecord(value, INPUT_FIELDS);
  if (record === null) throw failure("model_input_invalid");
  if (typeof record.correlationId !== "string" || !ULID.test(record.correlationId)
    || !safeAtom(record.principalId)
    || record.channel !== "voice" && record.channel !== "telegram"
    || !safeText(record.userText, MAXIMUM_INPUT_CHARACTERS, MAXIMUM_INPUT_BYTES)
    || record.reasoningEffort !== "none" && record.reasoningEffort !== "low"
      && record.reasoningEffort !== "high" && record.reasoningEffort !== "max"
    || !boundedPositiveInteger(record.firstTokenTimeoutMs, MAXIMUM_FIRST_TOKEN_TIMEOUT_MS)
    || !boundedPositiveInteger(record.timeoutMs, MAXIMUM_TOTAL_TIMEOUT_MS)
    || (record.firstTokenTimeoutMs as number) > (record.timeoutMs as number)
    || !boundedPositiveInteger(record.contextTokenBudget, MAXIMUM_CONTEXT_TOKEN_BUDGET)
    || !boundedPositiveInteger(record.maxOutputCharacters, MAXIMUM_OUTPUT_CHARACTERS)
    || signalAborted(record.signal) === null) {
    throw failure("model_input_invalid");
  }
  const context = snapshotContext(record.context, record.contextTokenBudget as number);
  return Object.freeze({
    correlationId: record.correlationId,
    principalId: record.principalId,
    channel: record.channel,
    userText: record.userText,
    context,
    reasoningEffort: record.reasoningEffort,
    firstTokenTimeoutMs: record.firstTokenTimeoutMs,
    timeoutMs: record.timeoutMs,
    contextTokenBudget: record.contextTokenBudget,
    maxOutputCharacters: record.maxOutputCharacters,
    signal: record.signal,
  } as CapturedInput);
}

function snapshotIteratorResult(value: unknown): CapturedIteratorResult {
  const record = exactDataRecord(value, ITERATOR_RESULT_FIELDS);
  if (record === null || typeof record.done !== "boolean") throw failure("model_protocol_invalid");
  return Object.freeze({ done: record.done, value: record.value });
}

function snapshotChunk(value: unknown, expectedIndex: number): ModelToken | "completed" {
  const typeDescriptor = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "type")
    : undefined;
  if (typeDescriptor === undefined || !("value" in typeDescriptor)) throw failure("model_protocol_invalid");
  if (typeDescriptor.value === "completed") {
    const record = exactDataRecord(value, COMPLETED_FIELDS);
    if (record === null) throw failure("model_protocol_invalid");
    return "completed";
  }
  const record = exactDataRecord(value, TOKEN_FIELDS);
  if (record === null || record.type !== "token" || record.index !== expectedIndex
    || !Number.isSafeInteger(record.index) || !canonicalNonemptyText(record.text)) {
    throw failure("model_protocol_invalid");
  }
  return Object.freeze({ index: record.index, text: record.text });
}

function addAbortListener(signal: AbortSignal, listener: () => void): boolean {
  try {
    Reflect.apply(EventTarget.prototype.addEventListener, signal, ["abort", listener, { once: true }]);
    return true;
  } catch {
    return false;
  }
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  try { Reflect.apply(EventTarget.prototype.removeEventListener, signal, ["abort", listener]); }
  catch { /* The signal was validated before the attempt; cleanup still fails closed. */ }
}

/** Validates and bounds the foundation model streaming protocol. */
export class DefaultModelAdapter implements ModelAdapter {
  private readonly providerStream: CapturedMethod;

  constructor(provider: ModelProvider) {
    const stream = capturedMethod(provider, "streamText");
    if (stream === null) throw failure("model_input_invalid");
    this.providerStream = stream;
  }

  stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    const captured = snapshotModelAdapterStreamInput(input);
    return this.streamCaptured(captured);
  }

  private async *streamCaptured(input: CapturedInput): AsyncIterable<ModelToken> {
    if (signalAborted(input.signal) !== false) throw failure("model_aborted");

    const linkedController = new AbortController();
    let resolveCallerAbort!: (value: NextOutcome) => void;
    const callerAbort = new Promise<NextOutcome>((resolve) => { resolveCallerAbort = resolve; });
    const onCallerAbort = () => {
      linkedController.abort();
      resolveCallerAbort({ kind: "aborted" });
    };
    if (!addAbortListener(input.signal, onCallerAbort)) throw failure("model_input_invalid");
    if (signalAborted(input.signal) !== false) onCallerAbort();
    if (linkedController.signal.aborted) {
      removeAbortListener(input.signal, onCallerAbort);
      throw failure("model_aborted");
    }

    let resolveFirstTimeout!: (value: NextOutcome) => void;
    let resolveTotalTimeout!: (value: NextOutcome) => void;
    const firstTimeout = new Promise<NextOutcome>((resolve) => { resolveFirstTimeout = resolve; });
    const totalTimeout = new Promise<NextOutcome>((resolve) => { resolveTotalTimeout = resolve; });
    const firstTimer = setTimeout(() => {
      linkedController.abort();
      resolveFirstTimeout({ kind: "first_timeout" });
    }, input.firstTokenTimeoutMs);
    const totalTimer = setTimeout(() => {
      linkedController.abort();
      resolveTotalTimeout({ kind: "total_timeout" });
    }, input.timeoutMs);
    let awaitingFirstToken = true;
    let success = false;
    let closeInvoked = false;
    let providerIterator: object | null = null;
    let providerReturn: CapturedMethod | null = null;

    const closeOnce = () => {
      if (closeInvoked || providerIterator === null || providerReturn === null) return;
      closeInvoked = true;
      try {
        const returned = Reflect.apply(providerReturn.method, providerIterator, []);
        void Promise.resolve(returned).catch(() => undefined);
      } catch {
        // Cleanup errors never replace the fixed failure that caused termination.
      }
    };

    try {
      let providerIterable: unknown;
      try {
        const request = Object.freeze({
          correlationId: input.correlationId,
          principalId: input.principalId,
          channel: input.channel,
          userText: input.userText,
          context: input.context,
          timeoutMs: input.timeoutMs,
          contextTokenBudget: input.contextTokenBudget,
          reasoningEffort: input.reasoningEffort,
          signal: linkedController.signal,
        } satisfies ModelStreamTextInput);
        providerIterable = Reflect.apply(this.providerStream.method, this.providerStream.receiver, [request]);
      } catch {
        throw failure("model_provider_failure");
      }
      const iteratorFactory = capturedMethod(providerIterable, Symbol.asyncIterator);
      if (iteratorFactory === null) throw failure("model_protocol_invalid");
      try { providerIterator = Reflect.apply(iteratorFactory.method, iteratorFactory.receiver, []) as object; }
      catch { throw failure("model_protocol_invalid"); }
      const providerNext = capturedMethod(providerIterator, "next");
      providerReturn = capturedMethod(providerIterator, "return");
      if (providerNext === null) throw failure("model_protocol_invalid");

      const nextWithDeadlines = async (): Promise<CapturedIteratorResult> => {
        let pending: Promise<NextOutcome>;
        try {
          const raw = Reflect.apply(providerNext.method, providerIterator, []);
          pending = Promise.resolve(raw).then(
            (value) => ({ kind: "next", value }) as const,
            () => ({ kind: "provider_failure" }) as const,
          );
        } catch {
          throw failure("model_provider_failure");
        }
        const competitors = awaitingFirstToken
          ? [pending, callerAbort, firstTimeout, totalTimeout]
          : [pending, callerAbort, totalTimeout];
        const outcome = await Promise.race(competitors);
        if (outcome.kind === "aborted") throw failure("model_aborted");
        if (outcome.kind === "first_timeout") throw failure("model_first_token_timeout");
        if (outcome.kind === "total_timeout") throw failure("model_total_timeout");
        if (outcome.kind === "provider_failure") throw failure("model_provider_failure");
        return snapshotIteratorResult(outcome.value);
      };

      let expectedIndex = 0;
      let outputCharacters = 0;
      let outputBytes = 0;
      while (true) {
        const result = await nextWithDeadlines();
        if (result.done) throw failure("model_protocol_invalid");
        const chunk = snapshotChunk(result.value, expectedIndex);
        if (chunk === "completed") {
          if (expectedIndex === 0) throw failure("model_protocol_invalid");
          const terminal = await nextWithDeadlines();
          if (!terminal.done || terminal.value !== undefined) throw failure("model_protocol_invalid");
          success = true;
          return;
        }
        if (awaitingFirstToken) {
          awaitingFirstToken = false;
          clearTimeout(firstTimer);
        }
        let tokenCharacters = 0;
        for (const _character of chunk.text) tokenCharacters += 1;
        const tokenBytes = encoder.encode(chunk.text).byteLength;
        if (outputCharacters + tokenCharacters > input.maxOutputCharacters
          || outputBytes + tokenBytes > MAXIMUM_OUTPUT_BYTES) {
          throw failure("model_output_limit");
        }
        outputCharacters += tokenCharacters;
        outputBytes += tokenBytes;
        expectedIndex += 1;
        yield chunk;
      }
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      removeAbortListener(input.signal, onCallerAbort);
      if (!success) {
        linkedController.abort();
        closeOnce();
      }
    }
  }
}

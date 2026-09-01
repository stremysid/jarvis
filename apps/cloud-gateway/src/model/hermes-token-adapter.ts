import {
  canonicalize,
  createJarvisTokenBridgeRequestV1,
  parseJarvisTokenBridgeAdmissionFailureV1,
  parseJarvisTokenBridgeCancelResponseV1,
  parseJarvisTokenBridgeEventSseFrameV1,
  sha256Hex,
  type JarvisTokenBridgeRequestV1,
} from "../../../../packages/contracts/src/index.js";
import {
  ModelAdapterError,
  modelProviderNotStartedError,
  snapshotModelAdapterStreamInput,
} from "./model-adapter.js";
import type {
  ModelAdapter,
  ModelAdapterStreamInput,
  ModelToken,
} from "./model-types.js";
import { HERMES_TOKEN_BRIDGE_REQUEST_LIMITS } from "./hermes-token-bridge-limits.js";

const BRIDGE_ORIGIN = "http://127.0.0.1:8790/";
const RUNS_URL = `${BRIDGE_ORIGIN}v1/token-runs`;
const MAXIMUM_CONTROL_BODY_BYTES = 4_096;
const MAXIMUM_SSE_FRAME_BYTES = 524_288;
const MAXIMUM_OUTPUT_SCALARS = 65_536;
const MAXIMUM_OUTPUT_BYTES = 65_536;
const MAXIMUM_STREAM_ATTEMPTS = 3;
const FRAME_SEGMENT_BYTES = 4_096;
const CANCELLATION_TIMEOUT_MS = 30_000;
const CANCELLATION_POLL_DELAY_MS = 10;
const encoder = new TextEncoder();

export interface HermesTokenAdapterOptions {
  readonly clientCredential: string;
  readonly fetch: typeof fetch;
}

interface CapturedOptions {
  readonly clientCredential: string;
  readonly fetch: typeof fetch;
}

type ClockOutcome =
  | { readonly kind: "aborted" }
  | { readonly kind: "first_timeout" }
  | { readonly kind: "total_timeout" };

type CancellationTaskOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "unknown" };

class StreamDisconnected extends Error {}

function failure(code: ConstructorParameters<typeof ModelAdapterError>[0]): ModelAdapterError {
  return new ModelAdapterError(code);
}

function exactOptions(value: unknown): CapturedOptions {
  if (value === null || typeof value !== "object") throw failure("model_input_invalid");
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw failure("model_input_invalid");
  }
  if (prototype !== Object.prototype || keys.length !== 2
    || keys.some((key) => key !== "clientCredential" && key !== "fetch")) {
    throw failure("model_input_invalid");
  }
  const credential = Object.getOwnPropertyDescriptor(value, "clientCredential");
  const fetchDescriptor = Object.getOwnPropertyDescriptor(value, "fetch");
  if (credential === undefined || fetchDescriptor === undefined
    || !credential.enumerable || !fetchDescriptor.enumerable
    || !("value" in credential) || !("value" in fetchDescriptor)
    || typeof credential.value !== "string" || credential.value.length === 0
    || credential.value.length > 4_096 || !credential.value.isWellFormed()
    || credential.value !== credential.value.normalize("NFC")
    || credential.value.includes("\r") || credential.value.includes("\n")
    || typeof fetchDescriptor.value !== "function") {
    throw failure("model_input_invalid");
  }
  return Object.freeze({ clientCredential: credential.value, fetch: fetchDescriptor.value });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function scalarCount(text: string): number {
  let count = 0;
  for (const _scalar of text) count += 1;
  return count;
}

class BoundedFrameSegments {
  private segments: Uint8Array[] = [];
  private size = 0;

  get byteLength(): number { return this.size; }

  get endsWithLf(): boolean {
    if (this.size === 0) return false;
    const final = this.segments[this.segments.length - 1];
    const finalLength = this.size % FRAME_SEGMENT_BYTES || FRAME_SEGMENT_BYTES;
    return final?.[finalLength - 1] === 0x0a;
  }

  append(bytes: Uint8Array): void {
    if (this.size + bytes.byteLength > MAXIMUM_SSE_FRAME_BYTES) throw failure("model_protocol_invalid");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const segmentOffset = this.size % FRAME_SEGMENT_BYTES;
      if (segmentOffset === 0) this.segments.push(new Uint8Array(FRAME_SEGMENT_BYTES));
      const segment = this.segments[this.segments.length - 1];
      if (segment === undefined) throw failure("model_protocol_invalid");
      const copied = Math.min(FRAME_SEGMENT_BYTES - segmentOffset, bytes.byteLength - offset);
      segment.set(bytes.subarray(offset, offset + copied), segmentOffset);
      this.size += copied;
      offset += copied;
    }
  }

  finish(): Uint8Array {
    const frame = new Uint8Array(this.size);
    let offset = 0;
    for (const segment of this.segments) {
      const copied = Math.min(segment.byteLength, frame.byteLength - offset);
      frame.set(segment.subarray(0, copied), offset);
      offset += copied;
    }
    this.segments = [];
    this.size = 0;
    return frame;
  }
}

class StreamClock {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly abortOutcome: Promise<ClockOutcome>;
  private resolveAbort!: (outcome: ClockOutcome) => void;
  private firstTimer: ReturnType<typeof setTimeout> | null;
  private readonly totalTimer: ReturnType<typeof setTimeout>;
  private readonly callerSignal: AbortSignal;
  private readonly onCallerAbort: () => void;
  private readonly onStop: (outcome: ClockOutcome) => void;
  private outcome: ClockOutcome | null = null;

  constructor(input: Readonly<ModelAdapterStreamInput>, onStop: (outcome: ClockOutcome) => void) {
    this.signal = this.controller.signal;
    this.callerSignal = input.signal;
    this.onStop = onStop;
    this.abortOutcome = new Promise((resolve) => { this.resolveAbort = resolve; });
    this.onCallerAbort = () => { this.stop({ kind: "aborted" }); };
    this.callerSignal.addEventListener("abort", this.onCallerAbort, { once: true });
    this.firstTimer = setTimeout(() => { this.stop({ kind: "first_timeout" }); }, input.firstTokenTimeoutMs);
    this.totalTimer = setTimeout(() => { this.stop({ kind: "total_timeout" }); }, input.timeoutMs);
    if (this.callerSignal.aborted) this.onCallerAbort();
  }

  firstTokenReceived(): void {
    if (this.firstTimer !== null) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
  }

  currentError(): ModelAdapterError | null {
    if (this.outcome === null) return null;
    if (this.outcome.kind === "aborted") return failure("model_aborted");
    if (this.outcome.kind === "first_timeout") return failure("model_first_token_timeout");
    return failure("model_total_timeout");
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    const result = await Promise.race([
      operation.then((value) => ({ kind: "value" as const, value })),
      this.abortOutcome,
    ]);
    if (result.kind === "value") return result.value;
    throw this.currentError() ?? failure("model_provider_failure");
  }

  close(): void {
    if (this.firstTimer !== null) clearTimeout(this.firstTimer);
    clearTimeout(this.totalTimer);
    this.callerSignal.removeEventListener("abort", this.onCallerAbort);
    this.controller.abort();
  }

  private stop(outcome: ClockOutcome): void {
    if (this.outcome !== null) return;
    this.outcome = outcome;
    this.onStop(outcome);
    this.controller.abort();
    this.resolveAbort(outcome);
  }
}

async function readBounded(response: Response, clock: StreamClock): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await clock.wait(reader.read());
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAXIMUM_CONTROL_BODY_BYTES) throw failure("model_admission_unknown");
      parts.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(parts);
}

class CancellationClock {
  readonly signal: AbortSignal;
  readonly expired: Promise<never>;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor() {
    this.signal = this.controller.signal;
    let rejectExpired!: (reason: ModelAdapterError) => void;
    this.expired = new Promise<never>((_resolve, reject) => { rejectExpired = reject; });
    this.timer = setTimeout(() => {
      this.controller.abort();
      rejectExpired(failure("model_cancel_unknown"));
    }, CANCELLATION_TIMEOUT_MS);
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.expired]);
  }

  close(): void { clearTimeout(this.timer); }
}

async function readBoundedCancellation(response: Response, clock: CancellationClock): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await clock.wait(reader.read());
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAXIMUM_CONTROL_BODY_BYTES) throw failure("model_cancel_unknown");
      parts.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(parts);
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function admissionError(response: Response, bytes: Uint8Array, requestId: string): ModelAdapterError {
  if (response.status === 401) return failure("model_provider_failure");
  if (response.headers.get("content-type") !== "application/json") return failure("model_admission_unknown");
  let parsed;
  try {
    parsed = parseJarvisTokenBridgeAdmissionFailureV1(decodeJson(bytes));
  } catch {
    return failure("model_admission_unknown");
  }
  if (parsed.requestId !== requestId || !equalBytes(bytes, canonicalize(parsed))) {
    return failure("model_admission_unknown");
  }
  if (response.status === 503 && parsed.code === "not_started") return modelProviderNotStartedError();
  if (response.status === 507 && parsed.code === "ledger_capacity_exhausted") return failure("model_provider_failure");
  if (response.status === 502 && parsed.code === "model_admission_unknown") return failure("model_admission_unknown");
  if (response.status === 409 && parsed.code === "request_conflict") return failure("model_admission_unknown");
  if (response.status === 400 && parsed.code === "request_invalid") return failure("model_protocol_invalid");
  return failure("model_admission_unknown");
}

async function* frames(response: Response, clock: StreamClock): AsyncIterable<Uint8Array> {
  if (response.body === null) throw failure("model_protocol_invalid");
  const reader = response.body.getReader();
  const buffered = new BoundedFrameSegments();
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await clock.wait(reader.read());
      } catch (error) {
        if (error instanceof ModelAdapterError) throw error;
        throw new StreamDisconnected();
      }
      if (result.done) {
        if (buffered.byteLength !== 0) throw failure("model_protocol_invalid");
        return;
      }
      const chunk = result.value;
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (buffered.endsWithLf && chunk[offset] === 0x0a) {
          buffered.append(chunk.subarray(offset, offset + 1));
          yield buffered.finish();
          offset += 1;
          continue;
        }
        let delimiter = -1;
        for (let index = offset; index + 1 < chunk.byteLength; index += 1) {
          if (chunk[index] === 0x0a && chunk[index + 1] === 0x0a) {
            delimiter = index;
            break;
          }
        }
        if (delimiter < 0) {
          buffered.append(chunk.subarray(offset));
          break;
        }
        buffered.append(chunk.subarray(offset, delimiter + 2));
        yield buffered.finish();
        offset = delimiter + 2;
      }
    }
  } catch (error) {
    if (error instanceof ModelAdapterError || error instanceof StreamDisconnected) throw error;
    throw new StreamDisconnected();
  } finally {
    reader.releaseLock();
  }
}

/** Strict voice-only adapter for the private local H1 Brain Bridge. */
export class HermesTokenAdapter implements ModelAdapter {
  private readonly credential: string;
  private readonly fetcher: typeof fetch;

  constructor(optionsValue: HermesTokenAdapterOptions) {
    const options = exactOptions(optionsValue);
    this.credential = options.clientCredential;
    this.fetcher = options.fetch;
  }

  stream(inputValue: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    const input = snapshotModelAdapterStreamInput(inputValue);
    if (input.channel !== "voice") throw failure("model_input_invalid");
    return this.streamCaptured(input);
  }

  private async *streamCaptured(input: Readonly<ModelAdapterStreamInput>): AsyncIterable<ModelToken> {
    if (input.signal.aborted) throw failure("model_aborted");
    const request = await createJarvisTokenBridgeRequestV1({
      schemaVersion: "1.0",
      requestId: input.correlationId,
      correlationId: input.correlationId,
      principalId: input.principalId,
      channel: "voice",
      userText: input.userText,
      context: input.context,
      reasoningEffort: input.reasoningEffort,
      firstTokenTimeoutMs: input.firstTokenTimeoutMs,
      timeoutMs: input.timeoutMs,
      contextTokenBudget: input.contextTokenBudget,
      maxOutputCharacters: input.maxOutputCharacters,
    });
    if (input.signal.aborted) throw failure("model_aborted");
    const body = canonicalize(request);
    if (body.byteLength > HERMES_TOKEN_BRIDGE_REQUEST_LIMITS.maximumCanonicalBytes) {
      throw failure("model_input_invalid");
    }
    let bound = false;
    let terminalReceived = false;
    let cancellationTask: Promise<CancellationTaskOutcome> | null = null;
    const ensureCancellation = (): Promise<CancellationTaskOutcome> | null => {
      if (!bound || terminalReceived) return null;
      cancellationTask ??= this.cancelBoundRun(request).then(
        () => Object.freeze({ kind: "settled" as const }),
        () => Object.freeze({ kind: "unknown" as const }),
      );
      return cancellationTask;
    };
    const clock = new StreamClock(input, () => { ensureCancellation(); });
    try {
      const persistedFrames: Uint8Array[] = [];
      const outputParts: string[] = [];
      let expectedEventIndex = 0;
      let expectedTokenIndex = 0;
      let outputScalars = 0;
      let outputBytes = 0;
      let terminalObserved = false;
      let terminalError: ModelAdapterError | null = null;

      for (let attempt = 0; attempt < MAXIMUM_STREAM_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          const pending = this.fetcher(RUNS_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.credential}`,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body,
            redirect: "manual",
            signal: clock.signal,
          });
          response = await clock.wait(pending);
        } catch {
          if (!bound) throw failure("model_admission_unknown");
          throw clock.currentError() ?? failure("model_provider_failure");
        }

        if (response.status !== 200 || response.headers.get("content-type") !== "text/event-stream") {
          if (bound) throw failure("model_protocol_invalid");
          if (response.status === 401) throw failure("model_provider_failure");
          let responseBytes: Uint8Array;
          try { responseBytes = await readBounded(response, clock); }
          catch { throw failure("model_admission_unknown"); }
          throw admissionError(response, responseBytes, request.requestId);
        }
        bound = true;
        let frameIndex = 0;
        let disconnected = false;
        try {
          for await (const frame of frames(response, clock)) {
            if (frameIndex < persistedFrames.length) {
              if (!equalBytes(frame, persistedFrames[frameIndex])) throw failure("model_protocol_invalid");
              frameIndex += 1;
              continue;
            }
            if (frameIndex !== persistedFrames.length || terminalObserved) throw failure("model_protocol_invalid");
            let event;
            try { event = parseJarvisTokenBridgeEventSseFrameV1(frame); }
            catch { throw failure("model_protocol_invalid"); }
            if (event.requestId !== request.requestId || event.eventIndex !== expectedEventIndex) {
              throw failure("model_protocol_invalid");
            }
            persistedFrames.push(frame.slice());
            frameIndex += 1;
            expectedEventIndex += 1;
            if (event.type === "token") {
              if (event.tokenIndex !== expectedTokenIndex || event.text.length === 0) throw failure("model_protocol_invalid");
              const nextScalars = scalarCount(event.text);
              const nextBytes = encoder.encode(event.text).byteLength;
              if (outputScalars + nextScalars > input.maxOutputCharacters
                || outputScalars + nextScalars > MAXIMUM_OUTPUT_SCALARS
                || outputBytes + nextBytes > MAXIMUM_OUTPUT_BYTES) {
                throw failure("model_output_limit");
              }
              outputScalars += nextScalars;
              outputBytes += nextBytes;
              outputParts.push(event.text);
              expectedTokenIndex += 1;
              clock.firstTokenReceived();
              yield Object.freeze({ index: event.tokenIndex, text: event.text });
              continue;
            }
            if (event.type === "completed") {
              if (expectedTokenIndex === 0) throw failure("model_protocol_invalid");
              const outputHash = await sha256Hex(outputParts.join(""));
              if (event.outputHash !== outputHash) throw failure("model_protocol_invalid");
            }
            terminalObserved = true;
            if (event.type === "failed") terminalError = failure(event.code);
            if (event.type === "cancelled") terminalError = failure("model_provider_failure");
          }
        } catch (error) {
          if (error instanceof StreamDisconnected) disconnected = true;
          else throw error;
        }
        if (terminalObserved && !disconnected && frameIndex === persistedFrames.length) {
          terminalReceived = true;
          if (terminalError !== null) throw terminalError;
          return;
        }
        if (attempt + 1 === MAXIMUM_STREAM_ATTEMPTS) throw failure("model_provider_failure");
      }
    } finally {
      clock.close();
      const task = ensureCancellation();
      if (task !== null && (await task).kind === "unknown") throw failure("model_cancel_unknown");
    }
  }

  private async cancelBoundRun(request: Readonly<JarvisTokenBridgeRequestV1>): Promise<void> {
    const body = canonicalize({
      schemaVersion: "1.0",
      requestId: request.requestId,
      requestHash: request.requestHash,
    });
    const url = `${RUNS_URL}/${request.requestId}/cancel`;
    const clock = new CancellationClock();
    try {
      while (true) {
        let response: Response;
        try {
          response = await clock.wait(this.fetcher(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.credential}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body,
            redirect: "manual",
            signal: clock.signal,
          }));
        } catch {
          throw failure("model_cancel_unknown");
        }
        if (response.headers.get("content-type") !== "application/json"
          || response.status !== 200 && response.status !== 202) {
          throw failure("model_cancel_unknown");
        }
        let bytes: Uint8Array;
        try { bytes = await readBoundedCancellation(response, clock); }
        catch { throw failure("model_cancel_unknown"); }
        let parsed;
        try { parsed = parseJarvisTokenBridgeCancelResponseV1(decodeJson(bytes)); }
        catch { throw failure("model_cancel_unknown"); }
        if (parsed.requestId !== request.requestId || !equalBytes(bytes, canonicalize(parsed))) {
          throw failure("model_cancel_unknown");
        }
        if (response.status === 202
          && (parsed.status === "cancel_requested" || parsed.status === "stop_accepted")) {
          await clock.wait(new Promise<void>((resolve) => {
            setTimeout(resolve, CANCELLATION_POLL_DELAY_MS);
          }));
          continue;
        }
        if (response.status === 200
          && (parsed.status === "cancelled" || parsed.status === "completed" || parsed.status === "failed")) return;
        throw failure("model_cancel_unknown");
      }
    } finally {
      clock.close();
    }
  }
}

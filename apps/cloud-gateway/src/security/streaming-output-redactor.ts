import {
  isIssuedRedaction,
  type Redactor as RedactorContract,
  type SuccessfulRedaction,
} from "../../../../packages/contracts/src/calls.js";
import type { ModelToken } from "../model/model-adapter.js";

const TOKEN_FIELDS = new Set(["index", "text"]);
const LIMIT_FIELDS = new Set(["maxRawCharacters", "maxSanitizedCharacters"]);
const MAXIMUM_CHARACTERS = 65_536;
const MAXIMUM_BYTES = 65_536;
const PRIVATE_KEY_BEGIN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----/u;
const encoder = new TextEncoder();
const frozenEmptyTokens: readonly ModelToken[] = Object.freeze([]);

export interface StreamingOutputRedactorLimits {
  readonly maxRawCharacters?: number;
  readonly maxSanitizedCharacters?: number;
}

export type StreamingOutputRedactionErrorCode =
  | "stream_redaction_input_invalid"
  | "stream_redaction_raw_limit"
  | "stream_redaction_output_limit"
  | "stream_redaction_failed"
  | "stream_redaction_state_invalid";

/** Fixed, raw-free metadata for a failed output-redaction operation. */
export class StreamingOutputRedactionError extends Error {
  readonly category = "output_redaction_failed" as const;

  constructor(readonly code: StreamingOutputRedactionErrorCode) {
    super(code);
    this.name = "StreamingOutputRedactionError";
    Object.freeze(this);
  }
}

interface CapturedMethod {
  readonly receiver: object;
  readonly method: (...args: never[]) => unknown;
}

type StreamState = "active" | "completed" | "cancelled" | "failed";

function error(code: StreamingOutputRedactionErrorCode): StreamingOutputRedactionError {
  return new StreamingOutputRedactionError(code);
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
        return Object.freeze({ receiver: value as object, method: descriptor.value as (...args: never[]) => unknown });
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return null;
  }
  return null;
}

function positiveLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAXIMUM_CHARACTERS;
}

function snapshotLimits(value: StreamingOutputRedactorLimits | undefined): Readonly<{
  maxRawCharacters: number;
  maxSanitizedCharacters: number;
}> {
  if (value === undefined) {
    return Object.freeze({ maxRawCharacters: MAXIMUM_CHARACTERS, maxSanitizedCharacters: MAXIMUM_CHARACTERS });
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw error("stream_redaction_input_invalid");
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (caught) {
    if (caught instanceof StreamingOutputRedactionError) throw caught;
    throw error("stream_redaction_input_invalid");
  }
  if (prototype !== Object.prototype || keys.length > LIMIT_FIELDS.size
    || keys.some((key) => typeof key !== "string" || !LIMIT_FIELDS.has(key))) {
    throw error("stream_redaction_input_invalid");
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const field = key as string;
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { throw error("stream_redaction_input_invalid"); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw error("stream_redaction_input_invalid");
    }
    captured[field] = descriptor.value;
  }
  const maxRawCharacters = captured.maxRawCharacters ?? MAXIMUM_CHARACTERS;
  const maxSanitizedCharacters = captured.maxSanitizedCharacters ?? MAXIMUM_CHARACTERS;
  if (!positiveLimit(maxRawCharacters) || !positiveLimit(maxSanitizedCharacters)) {
    throw error("stream_redaction_input_invalid");
  }
  return Object.freeze({ maxRawCharacters, maxSanitizedCharacters });
}

function scalarCount(value: string, stopAfter: number): number {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > stopAfter) return count;
  }
  return count;
}

function lineBoundary(value: string): number {
  const carriageReturn = value.indexOf("\r");
  const lineFeed = value.indexOf("\n");
  if (carriageReturn < 0 && lineFeed < 0) return -1;
  const start = carriageReturn < 0 ? lineFeed : lineFeed < 0 ? carriageReturn : Math.min(carriageReturn, lineFeed);
  return value[start] === "\r" && value[start + 1] === "\n" ? start + 2 : start + 1;
}

/**
 * Redacts complete safe line units during streaming and retains only an
 * ambiguous line/private-key suffix until EOF. `drain()` exposes that one
 * final EOF-safe suffix after `complete()` mints the exact full-stream token.
 */
export class StreamingOutputRedactor {
  private readonly redactText: CapturedMethod;
  private readonly maxRawCharacters: number;
  private readonly maxSanitizedCharacters: number;
  private state: StreamState = "active";
  private nextRawIndex = 0;
  private nextSanitizedIndex = 0;
  private rawCharacters = 0;
  private rawBytes = 0;
  private sanitizedCharacters = 0;
  private sanitizedBytes = 0;
  private rawArchive = "";
  private pending = "";
  private privateKeyEnd: string | null = null;
  private readonly outputParts: string[] = [];
  private completedDrain: readonly ModelToken[] = frozenEmptyTokens;
  private drainUsed = false;

  constructor(redactor: RedactorContract, limits?: StreamingOutputRedactorLimits) {
    const method = capturedMethod(redactor, "redactText");
    if (method === null) throw error("stream_redaction_input_invalid");
    const capturedLimits = snapshotLimits(limits);
    this.redactText = method;
    this.maxRawCharacters = capturedLimits.maxRawCharacters;
    this.maxSanitizedCharacters = capturedLimits.maxSanitizedCharacters;
  }

  push(token: ModelToken): readonly ModelToken[] {
    this.requireActive();
    const captured = exactDataRecord(token, TOKEN_FIELDS);
    if (captured === null || captured.index !== this.nextRawIndex || !Number.isSafeInteger(captured.index)
      || typeof captured.text !== "string" || captured.text.length === 0
      || !captured.text.isWellFormed() || captured.text !== captured.text.normalize("NFC")) {
      return this.terminate("stream_redaction_input_invalid");
    }
    const text = captured.text;
    const characters = scalarCount(text, this.maxRawCharacters - this.rawCharacters);
    if (this.rawCharacters + characters > this.maxRawCharacters) return this.terminate("stream_redaction_raw_limit");
    const bytes = encoder.encode(text).byteLength;
    if (this.rawBytes + bytes > MAXIMUM_BYTES) return this.terminate("stream_redaction_raw_limit");

    this.nextRawIndex += 1;
    this.rawCharacters += characters;
    this.rawBytes += bytes;
    this.rawArchive += text;
    this.pending += text;

    const emitted: ModelToken[] = [];
    this.processAvailable(emitted);
    return Object.freeze(emitted);
  }

  complete(): SuccessfulRedaction {
    this.requireActive();
    if (this.nextRawIndex === 0) return this.terminate("stream_redaction_failed");
    const eofTokens: ModelToken[] = [];
    if (this.pending.length > 0) {
      this.sanitizeSegment(this.pending, eofTokens);
      this.pending = "";
      this.privateKeyEnd = null;
    }
    const final = this.issue(this.rawArchive);
    const emittedText = this.outputParts.join("");
    if (final.text !== emittedText) return this.terminate("stream_redaction_failed");

    this.rawArchive = "";
    this.pending = "";
    this.privateKeyEnd = null;
    this.state = "completed";
    this.completedDrain = Object.freeze(eofTokens);
    return final;
  }

  drain(): readonly ModelToken[] {
    if (this.state !== "completed" || this.drainUsed) throw error("stream_redaction_state_invalid");
    this.drainUsed = true;
    const tokens = this.completedDrain;
    this.completedDrain = frozenEmptyTokens;
    return tokens;
  }

  cancel(): void {
    if (this.state === "cancelled") return;
    if (this.state !== "active") throw error("stream_redaction_state_invalid");
    this.clearSensitiveState();
    this.state = "cancelled";
  }

  private requireActive(): void {
    if (this.state !== "active") throw error("stream_redaction_state_invalid");
  }

  private processAvailable(emitted: ModelToken[]): void {
    while (this.pending.length > 0) {
      if (this.privateKeyEnd !== null) {
        const endIndex = this.pending.indexOf(this.privateKeyEnd);
        if (endIndex < 0) return;
        const blockEnd = endIndex + this.privateKeyEnd.length;
        const block = this.pending.slice(0, blockEnd);
        this.pending = this.pending.slice(blockEnd);
        this.privateKeyEnd = null;
        this.sanitizeSegment(block, emitted);
        continue;
      }

      PRIVATE_KEY_BEGIN.lastIndex = 0;
      const privateKey = PRIVATE_KEY_BEGIN.exec(this.pending);
      const boundary = lineBoundary(this.pending);
      if (privateKey !== null && (boundary < 0 || privateKey.index < boundary)) {
        const prefix = this.pending.slice(0, privateKey.index);
        if (prefix.length > 0) this.sanitizeSegment(prefix, emitted);
        this.pending = this.pending.slice(privateKey.index);
        this.privateKeyEnd = `-----END ${privateKey[1]!}-----`;
        continue;
      }
      if (boundary < 0) return;
      const line = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary);
      this.sanitizeSegment(line, emitted);
    }
  }

  private sanitizeSegment(raw: string, emitted: ModelToken[]): void {
    const redaction = this.issue(raw);
    const text = redaction.text;
    if (text.length === 0) return;
    const characters = scalarCount(text, this.maxSanitizedCharacters - this.sanitizedCharacters);
    if (this.sanitizedCharacters + characters > this.maxSanitizedCharacters) {
      this.terminate("stream_redaction_output_limit");
    }
    const bytes = encoder.encode(text).byteLength;
    if (this.sanitizedBytes + bytes > MAXIMUM_BYTES) this.terminate("stream_redaction_output_limit");
    this.sanitizedCharacters += characters;
    this.sanitizedBytes += bytes;
    this.outputParts.push(text);
    emitted.push(Object.freeze({ index: this.nextSanitizedIndex, text }));
    this.nextSanitizedIndex += 1;
  }

  private issue(raw: string): SuccessfulRedaction {
    let result: unknown;
    try { result = Reflect.apply(this.redactText.method, this.redactText.receiver, [raw]); }
    catch { return this.terminate("stream_redaction_failed"); }
    if (!isIssuedRedaction(result) || !Object.isFrozen(result)) return this.terminate("stream_redaction_failed");
    let textDescriptor: PropertyDescriptor | undefined;
    try { textDescriptor = Object.getOwnPropertyDescriptor(result, "text"); }
    catch { return this.terminate("stream_redaction_failed"); }
    if (textDescriptor === undefined || !("value" in textDescriptor) || typeof textDescriptor.value !== "string"
      || !textDescriptor.value.isWellFormed() || textDescriptor.value !== textDescriptor.value.normalize("NFC")) {
      return this.terminate("stream_redaction_failed");
    }
    return result;
  }

  private clearSensitiveState(): void {
    this.rawArchive = "";
    this.pending = "";
    this.privateKeyEnd = null;
    this.outputParts.length = 0;
    this.completedDrain = frozenEmptyTokens;
  }

  private terminate(code: StreamingOutputRedactionErrorCode): never {
    this.clearSensitiveState();
    this.state = "failed";
    throw error(code);
  }
}

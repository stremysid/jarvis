import { canonicalJson, normalizeJsonText, sha256Hex, type JsonValue } from "./canonical-json.js";
import { isIssuedRedaction, type SuccessfulRedaction } from "./calls.js";
import type { Sha256Hex, Ulid } from "./ids.js";

export interface EventEnvelopeV1<T extends JsonValue = JsonValue> {
  schemaVersion: "1.0";
  eventId: Ulid;
  eventSequence?: number;
  eventType: string;
  source: string;
  subjectId: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: Ulid;
  causationId?: Ulid;
  contentType: "application/json";
  contentHash: Sha256Hex;
  payload: T;
  redaction: { status: "redacted" | "none"; markers: string[] };
  producerVersion: string;
}

declare const persistableEventEnvelope: unique symbol;

/** An opaque, in-memory proof that createEnvelope minted this immutable envelope. */
export type PersistableEventEnvelopeV1<T extends JsonValue = JsonValue> = EventEnvelopeV1<T> & {
  readonly [persistableEventEnvelope]: true;
};

const persistableEnvelopes = new WeakSet<object>();

/** Producer payloads permit only issued redaction tokens wherever text appears. */
export type RedactedJsonValue =
  | null
  | boolean
  | number
  | SuccessfulRedaction
  | readonly RedactedJsonValue[]
  | { readonly [key: string]: RedactedJsonValue };

export type EventEnvelope<T extends JsonValue = JsonValue> = EventEnvelopeV1<T>;
export interface CreateEnvelopeInput {
  schemaVersion: "1.0";
  eventId: Ulid;
  eventSequence?: number;
  eventType: string;
  source: string;
  subjectId: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: Ulid;
  causationId?: Ulid;
  contentType: "application/json";
  payload: RedactedJsonValue;
  producerVersion: string;
}

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCHEMA_VERSION = /^(\d+)\.(\d+)$/;
const PAYLOAD_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;
const CREATE_FIELDS = new Set([
  "schemaVersion", "eventId", "eventSequence", "eventType", "source", "subjectId", "occurredAt", "receivedAt",
  "correlationId", "causationId", "contentType", "payload", "producerVersion",
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requireUlid(value: unknown, label: string): asserts value is Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(`${label} must be a lowercase ULID`);
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp with milliseconds`);
  }
}

function requireSchemaVersion(value: unknown): void {
  if (typeof value !== "string") throw new TypeError("schemaVersion must be a string");
  const match = SCHEMA_VERSION.exec(value);
  if (match?.[1] !== "1") throw new TypeError("unsupported schema major version");
}

function requireNfcNormalized(value: unknown): asserts value is JsonValue {
  const normalized = normalizeJsonText(value);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new TypeError("envelope must be NFC-normalized");
}

function requireRedaction(value: unknown): void {
  const redaction = requireRecord(value, "redaction");
  if (redaction.status !== "none" && redaction.status !== "redacted") throw new TypeError("redaction.status is invalid");
  if (!Array.isArray(redaction.markers) || redaction.markers.some((marker) => typeof marker !== "string")) {
    throw new TypeError("redaction.markers must be strings");
  }
}

function requirePayloadKey(key: string, path: string): void {
  if (!PAYLOAD_KEY.test(key)) throw new TypeError(`${path} payload key is not a schema identifier`);
}

function validatePayloadKeys(value: JsonValue, path = "payload"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePayloadKeys(item, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(value)) {
    requirePayloadKey(key, path);
    validatePayloadKeys(value[key], `${path}.${key}`);
  }
}

function materializePayload(value: unknown, markers: Set<string>, path = "payload"): JsonValue {
  if (isIssuedRedaction(value)) {
    for (const marker of value.markers) markers.add(marker);
    return value.text;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must not contain a non-finite number`);
    return value;
  }
  if (typeof value === "string") throw new TypeError(`${path} must be an issued redaction token, not raw text`);
  if (typeof value === "undefined") throw new TypeError(`${path} must not contain undefined`);
  if (Array.isArray(value)) {
    const materialized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${path} must not contain sparse arrays`);
      materialized.push(materializePayload(value[index], markers, `${path}[${index}]`));
    }
    return materialized;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${path} must be a redacted JSON value`);
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true && Object.hasOwn(record, "text")) throw new TypeError(`${path} contains a forged redaction token`);
  const materialized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(record)) {
    requirePayloadKey(key, path);
    materialized[key] = materializePayload(record[key], markers, `${path}.${key}`);
  }
  return materialized;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Recognizes only immutable envelopes minted by createEnvelope in this module instance. */
export function isPersistableEventEnvelope(value: unknown): value is PersistableEventEnvelopeV1 {
  return value !== null && typeof value === "object" && persistableEnvelopes.has(value);
}

/** Creates an event from tokenized text and safe JSON structure only. */
export async function createEnvelope(input: CreateEnvelopeInput): Promise<PersistableEventEnvelopeV1> {
  const candidate = requireRecord(input, "envelope input");
  for (const key of Object.keys(candidate)) {
    if (!CREATE_FIELDS.has(key)) throw new TypeError(`unsupported producer field: ${key}`);
  }
  const { payload: rawPayload, ...rawHeaders } = candidate;
  const markers = new Set<string>();
  const payload = normalizeJsonText(materializePayload(rawPayload, markers));
  const headers = normalizeJsonText(rawHeaders) as Record<string, JsonValue>;
  const envelope = {
    ...headers,
    payload,
    redaction: { status: markers.size > 0 ? "redacted" : "none", markers: [...markers] },
    contentHash: await sha256Hex(canonicalJson(payload)),
  } as EventEnvelopeV1;
  await validateEnvelope(envelope);
  const persistable = deepFreeze(envelope) as PersistableEventEnvelopeV1;
  persistableEnvelopes.add(persistable);
  return persistable;
}

/** Validates a received event before a consumer uses or dead-letters its redacted payload. */
export async function validateEnvelope(value: unknown): Promise<EventEnvelopeV1> {
  const envelope = requireRecord(value, "envelope");
  requireNfcNormalized(envelope);
  requireSchemaVersion(envelope.schemaVersion);
  requireUlid(envelope.eventId, "eventId");
  requireUlid(envelope.correlationId, "correlationId");
  if (envelope.causationId !== undefined) requireUlid(envelope.causationId, "causationId");
  const eventSequence = envelope.eventSequence;
  if (eventSequence !== undefined && (typeof eventSequence !== "number" || !Number.isSafeInteger(eventSequence) || eventSequence < 0)) {
    throw new TypeError("eventSequence must be a non-negative integer");
  }
  for (const field of ["eventType", "source", "subjectId", "producerVersion"] as const) requireString(envelope[field], field);
  requireTimestamp(envelope.occurredAt, "occurredAt");
  requireTimestamp(envelope.receivedAt, "receivedAt");
  if (envelope.contentType !== "application/json") throw new TypeError("contentType must be application/json");
  if (typeof envelope.contentHash !== "string" || !SHA256.test(envelope.contentHash)) throw new TypeError("contentHash must be a lowercase SHA-256 hash");
  requireRedaction(envelope.redaction);
  validatePayloadKeys(envelope.payload);

  const computedHash = await sha256Hex(canonicalJson(envelope.payload));
  if (computedHash !== envelope.contentHash) throw new TypeError("contentHash does not match payload");
  return envelope as unknown as EventEnvelopeV1;
}

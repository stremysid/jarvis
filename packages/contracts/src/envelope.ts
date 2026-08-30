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

export type EventEnvelope<T extends JsonValue = JsonValue> = EventEnvelopeV1<T>;
/**
 * Event producers must pass the successful output from Redactor rather than
 * any raw ingress message shape. The stored envelope records only its status
 * and markers, never the redactor's transient source text field.
 */
export type CreateEnvelopeInput<T extends JsonValue> = Omit<EventEnvelopeV1<T>, "contentHash" | "redaction"> & {
  redaction: SuccessfulRedaction;
};

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCHEMA_VERSION = /^(\d+)\.(\d+)$/;

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

/** Creates an event only from a payload that has crossed the redaction boundary. */
export async function createEnvelope<T extends JsonValue>(input: CreateEnvelopeInput<T>): Promise<EventEnvelopeV1<T>> {
  const { redaction, payload: rawPayload, ...headers } = input;
  if (!isIssuedRedaction(redaction)) throw new TypeError("redaction must be a successful issued redaction token");
  const payload = normalizeJsonText(rawPayload) as T;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && Object.hasOwn(payload, "text")) {
    const payloadRecord = payload as Record<string, JsonValue>;
    if (typeof payloadRecord.text !== "string" || payloadRecord.text !== redaction.text) {
      throw new TypeError("payload.text must match the successful redaction result");
    }
  }
  const normalizedHeaders = normalizeJsonText(headers) as Record<string, JsonValue>;
  const envelope = {
    ...normalizedHeaders,
    payload,
    redaction: { status: redaction.markers.length > 0 ? "redacted" : "none", markers: [...redaction.markers] },
    contentHash: await sha256Hex(canonicalJson(payload)),
  } as EventEnvelopeV1<T>;
  await validateEnvelope(envelope);
  return envelope;
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

  const computedHash = await sha256Hex(canonicalJson(envelope.payload));
  if (computedHash !== envelope.contentHash) throw new TypeError("contentHash does not match payload");
  return envelope as unknown as EventEnvelopeV1;
}

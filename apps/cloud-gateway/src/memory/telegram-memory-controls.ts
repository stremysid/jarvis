import {
  validateEnvelope,
  type EventEnvelope,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "../conversation/conversation-repository.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import { Redactor } from "../security/redaction.js";
import {
  MemoryRepositoryError,
  type MemoryControlIntent,
  type MemoryOwnerTurnInput,
} from "./memory-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OWNER_TURN_FIELDS = new Set([
  "turn_id", "principal_id", "channel", "user_event_id", "state", "sequence",
  "event_id", "event_type", "source", "subject_id", "occurred_at", "content_hash",
  "envelope_json",
]);
const HISTORY_PAYLOAD_FIELDS = new Set([
  "schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text",
]);
const HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS = new Set([
  ...HISTORY_PAYLOAD_FIELDS,
  "directOwnerText",
]);
// Sid's memory: his reader.
const redactor = new Redactor("owner");

interface OwnerTurnRow {
  readonly turn_id: unknown;
  readonly principal_id: unknown;
  readonly channel: unknown;
  readonly user_event_id: unknown;
  readonly state: unknown;
  readonly sequence: unknown;
  readonly event_id: unknown;
  readonly event_type: unknown;
  readonly source: unknown;
  readonly subject_id: unknown;
  readonly occurred_at: unknown;
  readonly content_hash: unknown;
  readonly envelope_json: unknown;
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(error);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) throw new TypeError(error);
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    captured[field] = descriptor.value;
  }
  return captured;
}

function historyPayload(value: unknown, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(error);
  const fields = Object.hasOwn(value, "directOwnerText")
    ? HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS
    : HISTORY_PAYLOAD_FIELDS;
  const payload = exactRecord(value, fields, error);
  if (Object.hasOwn(payload, "directOwnerText") && typeof payload.directOwnerText !== "boolean") {
    throw new TypeError(error);
  }
  return payload;
}

/**
 * The owner's words as the durable turn recorded them, when the envelope is the
 * one this shape describes.
 *
 * Exported because a channel adapter needs it to read back what Jarvis itself
 * said on a previous turn, and doing that must not mean a second, weaker copy
 * of the payload check. `historyEligible` is deliberately not required to be
 * true here: a spoken call reply is stored with it false, a legacy value that
 * says nothing about the text (see conversation/history-eligibility.ts); it is
 * still the exact text the owner heard.
 */
export function readHistoryPayloadEnvelope(value: unknown, error: string): string {
  const payload = historyPayload(value, error);
  if (payload.schemaCode !== 1 || payload.sensitivityCode !== 1
    || typeof payload.historyEligible !== "boolean") throw new TypeError(error);
  return safeText(payload.text, 65_536, error);
}


function safeText(value: unknown, maximumBytes: number, error: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new TypeError(error);
  }
  return value;
}

function safeAtom(value: unknown, error: string): string {
  const text = safeText(value, 1_024, error);
  if (/[\r\n]/u.test(text)) throw new TypeError(error);
  return text;
}

function safeUlid(value: unknown, error: string): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError(error);
  return value as Ulid;
}

function safeTimestamp(value: unknown, error: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError(error);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(error);
  return value;
}

/** Reconstructs permission authority from the durable current owner turn. */
export async function readMemoryOwnerTurnEvidence(input: Readonly<{
  database: D1Database;
  modelInput: Readonly<ModelAdapterStreamInput>;
  memoryIntent: MemoryControlIntent | null;
  /**
   * The `channelCode` the durable `conversation.user_committed` payload must
   * carry. One constant per channel rather than a flag, so a caller cannot
   * widen what it accepts by passing the wrong boolean.
   */
  channelCode: 1 | 2;
  /**
   * Telegram's `directOwnerText` ingress marker is required for the narrow
   * memory authority and skipped for the broader pipeline authority, which is
   * authorized separately by the caller.
   */
  requireDirectOwnerText?: boolean;
}>): Promise<MemoryOwnerTurnInput> {
  const modelInput = input.modelInput;
  const rowValue = await input.database.prepare(`SELECT turn.turn_id, turn.principal_id,
      turn.channel, turn.user_event_id, turn.state, event.sequence, event.event_id,
      event.event_type, event.source, event.subject_id, event.occurred_at,
      event.content_hash, event.envelope_json
    FROM conversation_turns turn
    JOIN events event ON event.event_id = turn.user_event_id
    WHERE turn.turn_id = ? AND turn.principal_id = ?`)
    .bind(modelInput.correlationId, modelInput.principalId).first<OwnerTurnRow>();
  if (rowValue === null) throw new MemoryRepositoryError("memory_refused");
  const row = exactRecord(rowValue, OWNER_TURN_FIELDS, "telegram_memory_owner_turn_invalid");
  const turnId = safeUlid(row.turn_id, "telegram_memory_owner_turn_invalid");
  const eventId = safeUlid(row.event_id, "telegram_memory_owner_turn_invalid");
  const userEventId = safeUlid(row.user_event_id, "telegram_memory_owner_turn_invalid");
  const principalId = safeAtom(row.principal_id, "telegram_memory_owner_turn_invalid");
  const sequence = row.sequence;
  const occurredAt = safeTimestamp(row.occurred_at, "telegram_memory_owner_turn_invalid");
  const channel = input.channelCode === 1 ? "voice" : "telegram";
  if (turnId !== modelInput.correlationId || eventId !== userEventId || principalId !== modelInput.principalId
    || row.channel !== channel || row.state !== "model_claimed"
    || !Number.isSafeInteger(sequence) || (sequence as number) < 1
    || row.event_type !== "conversation.user_committed"
    || row.source !== CONVERSATION_EVENT_SOURCE || row.subject_id !== principalId
    || typeof row.content_hash !== "string" || !SHA256.test(row.content_hash)
    || typeof row.envelope_json !== "string" || row.envelope_json.length === 0
    || !row.envelope_json.isWellFormed()) {
    throw new MemoryRepositoryError("memory_refused");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(row.envelope_json); }
  catch { throw new MemoryRepositoryError("memory_corrupt"); }
  let envelope: EventEnvelope;
  try { envelope = await validateEnvelope(decoded); }
  catch { throw new MemoryRepositoryError("memory_corrupt"); }
  const payload = historyPayload(envelope.payload, "telegram_memory_owner_turn_invalid");
  const checked = redactor.redactText(modelInput.userText);
  if (envelope.eventId !== eventId || envelope.eventType !== row.event_type
    || envelope.source !== row.source || envelope.subjectId !== principalId
    || envelope.correlationId !== turnId || envelope.occurredAt !== occurredAt
    || envelope.contentHash !== row.content_hash
    || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION
    || payload.schemaCode !== 1 || payload.channelCode !== input.channelCode
    || payload.sensitivityCode !== 1 || payload.historyEligible !== true
    || input.requireDirectOwnerText !== false && payload.directOwnerText !== true
    || payload.text !== modelInput.userText || !checked.ok || checked.text !== modelInput.userText) {
    throw new MemoryRepositoryError("memory_refused");
  }
  return Object.freeze({
    principalId,
    eventId,
    eventSequence: sequence as number,
    occurredAt,
    channel,
    memoryIntent: input.memoryIntent,
    forwarded: false,
    quoted: false,
    pasted: false,
    hasAttachment: false,
    modelGenerated: false,
    toolGenerated: false,
    guest: false,
  });
}

/** Reconstructs permission authority from the durable current Telegram turn. */
export async function readTelegramMemoryOwnerTurn(input: Readonly<{
  database: D1Database;
  modelInput: Readonly<ModelAdapterStreamInput>;
  memoryIntent: MemoryControlIntent | null;
  /** Pipeline tools use the same durable turn proof but their broader ingress authority. */
  requireDirectOwnerText?: boolean;
}>): Promise<MemoryOwnerTurnInput> {
  return readMemoryOwnerTurnEvidence({ ...input, channelCode: 2 });
}

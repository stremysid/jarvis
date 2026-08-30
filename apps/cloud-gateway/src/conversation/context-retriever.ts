import { validateEnvelope, type Ulid } from "../../../../packages/contracts/src/index.js";
import { Redactor } from "../security/redaction.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "./conversation-repository.js";
import type {
  ContextRetriever,
  ContextRetrieverInput,
  RetrievedContext,
} from "./conversation-types.js";

const INPUT_FIELDS = new Set(["principalId", "channel", "purpose", "query", "maxTokens"]);
const HISTORY_PAYLOAD_FIELDS = new Set([
  "schemaCode",
  "channelCode",
  "sensitivityCode",
  "historyEligible",
  "text",
]);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const MAX_CANDIDATES = 128;
const MAX_RETURNED_ITEMS = 64;
const MAX_CONTEXT_BYTES = 32_000;
const MAX_QUERY_CHARACTERS = 8_000;
const MAX_QUERY_BYTES = 65_536;
const MAX_DECODED_ENVELOPE_BYTES = 1_048_576;
const encoder = new TextEncoder();
const redactor = new Redactor();

interface StoredHistoryRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly subject_id: string;
  readonly content_hash: string;
  readonly envelope_json: string;
}

function exactDataRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(error);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(error);
  }
  if (prototype !== Object.prototype || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    throw new TypeError(error);
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { throw new TypeError(error); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    captured[field] = descriptor.value;
  }
  return captured;
}

function requireText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(label);
  }
  return value;
}

function countScalars(value: string): number {
  return Array.from(value).length;
}

function captureInput(value: unknown): Readonly<ContextRetrieverInput> {
  const input = exactDataRecord(value, INPUT_FIELDS, "context_input_invalid");
  const principalId = requireText(input.principalId, "context_principal_invalid", 256);
  const query = requireText(input.query, "context_query_invalid", MAX_QUERY_BYTES);
  if (countScalars(query) > MAX_QUERY_CHARACTERS
    || input.channel !== "voice" && input.channel !== "telegram"
    || input.purpose !== "conversation"
    || !Number.isSafeInteger(input.maxTokens)
    || (input.maxTokens as number) <= 0
    || (input.maxTokens as number) > MAX_CONTEXT_BYTES) {
    throw new TypeError("context_input_invalid");
  }
  return Object.freeze({
    principalId,
    channel: input.channel,
    purpose: "conversation",
    query,
    maxTokens: input.maxTokens as number,
  });
}

function snapshotRows(value: unknown): readonly StoredHistoryRow[] {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) throw new TypeError("context_rows_invalid");
  const rows: StoredHistoryRow[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError("context_rows_invalid");
    const row = exactDataRecord(
      value[index],
      new Set(["sequence", "event_id", "event_type", "subject_id", "content_hash", "envelope_json"]),
      "context_row_invalid",
    );
    if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) <= 0
      || typeof row.event_id !== "string" || !ULID.test(row.event_id)
      || row.event_type !== "conversation.user_committed" && row.event_type !== "conversation.assistant_delivered"
      || typeof row.subject_id !== "string" || typeof row.content_hash !== "string"
      || typeof row.envelope_json !== "string") {
      throw new TypeError("context_row_invalid");
    }
    rows.push(Object.freeze({
      sequence: row.sequence as number,
      event_id: row.event_id,
      event_type: row.event_type,
      subject_id: row.subject_id,
      content_hash: row.content_hash,
      envelope_json: row.envelope_json,
    }));
  }
  return Object.freeze(rows);
}

function snapshotResultRows(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("context_result_invalid");
  }
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, "results"); }
  catch { throw new TypeError("context_result_invalid"); }
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError("context_result_invalid");
  }
  return descriptor.value;
}

function historyText(payload: unknown, eventType: string): string {
  const value = exactDataRecord(payload, HISTORY_PAYLOAD_FIELDS, "context_payload_invalid");
  if (value.schemaCode !== 1 || value.sensitivityCode !== 1 || value.historyEligible !== true
    || eventType === "conversation.assistant_delivered" && value.channelCode !== 2
    || eventType === "conversation.user_committed" && value.channelCode !== 1 && value.channelCode !== 2) {
    throw new TypeError("context_payload_invalid");
  }
  const text = requireText(value.text, "context_payload_invalid", MAX_CONTEXT_BYTES);
  const verified = redactor.redactText(text);
  if (!verified.ok || verified.text !== text) throw new TypeError("context_payload_invalid");
  return text;
}

/** Reads only recent, authenticated-principal conversational history from D1. */
export class D1ContextRetriever implements ContextRetriever {
  constructor(private readonly database: D1Database) {}

  async retrieve(input: ContextRetrieverInput): Promise<readonly RetrievedContext[]> {
    const captured = captureInput(input);
    const result = await this.database.prepare(`SELECT sequence, event_id, event_type, subject_id, content_hash, envelope_json
      FROM events INDEXED BY events_subject_sequence_idx
      WHERE subject_id = ?1
        AND event_type IN ('conversation.user_committed', 'conversation.assistant_delivered')
      ORDER BY sequence DESC
      LIMIT ?2`)
      .bind(captured.principalId, MAX_CANDIDATES)
      .all<StoredHistoryRow>();
    const rows = snapshotRows(snapshotResultRows(result));
    let decodedBytes = 0;
    let returnedBytes = 0;
    const selectedNewestFirst: RetrievedContext[] = [];

    for (const row of rows) {
      const envelopeBytes = encoder.encode(row.envelope_json).byteLength;
      decodedBytes += envelopeBytes;
      if (decodedBytes > MAX_DECODED_ENVELOPE_BYTES) throw new RangeError("context_envelope_budget_exceeded");
      let parsed: unknown;
      try { parsed = JSON.parse(row.envelope_json) as unknown; }
      catch { throw new TypeError("context_envelope_invalid"); }
      const envelope = await validateEnvelope(parsed);
      if (row.subject_id !== captured.principalId || envelope.subjectId !== captured.principalId
        || envelope.eventId !== row.event_id || envelope.eventType !== row.event_type
        || envelope.contentHash !== row.content_hash || envelope.source !== CONVERSATION_EVENT_SOURCE
        || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION) {
        throw new TypeError("context_envelope_invalid");
      }
      const text = historyText(envelope.payload, row.event_type);
      const textBytes = encoder.encode(text).byteLength;
      if (selectedNewestFirst.length >= MAX_RETURNED_ITEMS || returnedBytes + textBytes > captured.maxTokens) break;
      returnedBytes += textBytes;
      selectedNewestFirst.push(Object.freeze({
        sourceEventId: row.event_id as Ulid,
        text,
        sensitivity: "personal" as const,
      }));
    }

    return Object.freeze(selectedNewestFirst.reverse());
  }
}

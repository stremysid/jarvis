import {
  canonicalJson,
  sha256Hex,
  validateEnvelope,
  type JsonValue,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
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
const HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS = new Set([
  ...HISTORY_PAYLOAD_FIELDS,
  "directOwnerText",
]);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
/**
 * Sid's messages on either channel, Jarvis's delivered Telegram replies, and
 * Jarvis's spoken call replies (`assistant_sent`). Without the third, what
 * Jarvis said on a call was missing from the recent context of that same call
 * and of the next Telegram turn.
 */
const HISTORY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "conversation.user_committed",
  "conversation.assistant_delivered",
  "conversation.assistant_sent",
]);
const MAX_CANDIDATES = 128;
const MAX_FACT_CANDIDATES = 128;
const MAX_FACT_ITEMS = 32;
const MAX_RETURNED_ITEMS = 64;
const MAX_CONTEXT_BYTES = 32_000;
const MAX_QUERY_CHARACTERS = 8_000;
const MAX_QUERY_BYTES = 65_536;
const MAX_DECODED_ENVELOPE_BYTES = 1_048_576;
const MAX_DECODED_FACT_BYTES = 1_048_576;
const MAX_FTS_TERMS = 16;
const MAX_FTS_TERM_BYTES = 128;
const SHA256 = /^[a-f0-9]{64}$/u;
const FACT_ID = /^fact_[a-f0-9]{32}$/u;
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

interface StoredFactRow {
  readonly principal_id: string;
  readonly device_id: string;
  readonly projection_version: number;
  readonly fact_id: string;
  readonly text: string;
  readonly origin: string;
  readonly sensitivity: string;
  readonly confidence: number;
  readonly distiller_version: string;
  readonly distilled_at: string;
  readonly content_hash: string;
  readonly primary_event_id: string;
  readonly primary_event_sequence: number;
  readonly sources_json: string;
  readonly fact_json: string;
  readonly relevance: number;
  readonly any_sensitive: number;
  readonly content_hash_count: number;
}

interface FactCandidate {
  readonly factId: string;
  readonly item: RetrievedContext;
  readonly bytes: number;
}

const FACT_ROW_FIELDS = new Set([
  "principal_id", "device_id", "projection_version", "fact_id", "text", "origin",
  "sensitivity", "confidence", "distiller_version", "distilled_at", "content_hash",
  "primary_event_id", "primary_event_sequence", "sources_json", "fact_json", "relevance",
  "any_sensitive", "content_hash_count",
]);
const FACT_FIELDS = new Set([
  "factId", "text", "origin", "sensitivity", "confidence", "distillerVersion",
  "distilledAt", "contentHash", "sources",
]);
const SOURCE_FIELDS = new Set(["eventId", "eventSequence", "excerpt"]);
const FACT_ORIGINS = new Set([
  "authenticated_first_person", "deterministic_observation", "model", "third_party",
]);

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

function historyPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("context_payload_invalid");
  }
  const fields = Object.hasOwn(value, "directOwnerText")
    ? HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS
    : HISTORY_PAYLOAD_FIELDS;
  const payload = exactDataRecord(value, fields, "context_payload_invalid");
  if (Object.hasOwn(payload, "directOwnerText") && typeof payload.directOwnerText !== "boolean") {
    throw new TypeError("context_payload_invalid");
  }
  return payload;
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
      || typeof row.event_type !== "string" || !HISTORY_EVENT_TYPES.has(row.event_type)
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

function snapshotFactRows(value: unknown): readonly StoredFactRow[] {
  if (!Array.isArray(value) || value.length > MAX_FACT_CANDIDATES) {
    throw new TypeError("context_fact_rows_invalid");
  }
  const rows: StoredFactRow[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError("context_fact_rows_invalid");
    const row = exactDataRecord(value[index], FACT_ROW_FIELDS, "context_fact_row_invalid");
    if (typeof row.principal_id !== "string" || typeof row.device_id !== "string"
      || !Number.isSafeInteger(row.projection_version) || (row.projection_version as number) < 1
      || typeof row.fact_id !== "string" || !FACT_ID.test(row.fact_id)
      || typeof row.text !== "string" || typeof row.origin !== "string"
      || typeof row.sensitivity !== "string" || typeof row.confidence !== "number"
      || !Number.isFinite(row.confidence) || typeof row.distiller_version !== "string"
      || typeof row.distilled_at !== "string" || typeof row.content_hash !== "string"
      || typeof row.primary_event_id !== "string" || !ULID.test(row.primary_event_id)
      || !Number.isSafeInteger(row.primary_event_sequence) || (row.primary_event_sequence as number) < 1
      || typeof row.sources_json !== "string" || typeof row.fact_json !== "string"
      || typeof row.relevance !== "number" || !Number.isFinite(row.relevance)
      || row.any_sensitive !== 0 && row.any_sensitive !== 1
      || !Number.isSafeInteger(row.content_hash_count) || (row.content_hash_count as number) < 1) {
      throw new TypeError("context_fact_row_invalid");
    }
    rows.push(Object.freeze(row as unknown as StoredFactRow));
  }
  return Object.freeze(rows);
}

function parseTimestamp(value: unknown, error: string): string {
  const timestamp = requireText(value, error, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) throw new TypeError(error);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) throw new TypeError(error);
  return timestamp;
}

function literalFtsQuery(query: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].normalize("NFC");
    const folded = term.toLowerCase();
    if (encoder.encode(term).byteLength > MAX_FTS_TERM_BYTES || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(`"${term}"`);
    if (terms.length === MAX_FTS_TERMS) break;
  }
  return terms.length === 0 ? null : terms.join(" OR ");
}

async function factCandidate(row: StoredFactRow, principalId: string): Promise<FactCandidate> {
  let parsedFact: unknown;
  let parsedSources: unknown;
  try {
    parsedFact = JSON.parse(row.fact_json) as unknown;
    parsedSources = JSON.parse(row.sources_json) as unknown;
  } catch {
    throw new TypeError("context_fact_invalid");
  }
  const fact = exactDataRecord(parsedFact, FACT_FIELDS, "context_fact_invalid");
  if (!Array.isArray(parsedSources) || !Array.isArray(fact.sources)
    || parsedSources.length < 1 || parsedSources.length > 8
    || fact.sources.length !== parsedSources.length) {
    throw new TypeError("context_fact_invalid");
  }
  const sources: Record<string, unknown>[] = [];
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  for (let index = 0; index < fact.sources.length; index += 1) {
    const source = exactDataRecord(fact.sources[index], SOURCE_FIELDS, "context_fact_source_invalid");
    const stored = exactDataRecord(parsedSources[index], SOURCE_FIELDS, "context_fact_source_invalid");
    if (canonicalJson(source as JsonValue) !== canonicalJson(stored as JsonValue)
      || typeof source.eventId !== "string" || !ULID.test(source.eventId)
      || !Number.isSafeInteger(source.eventSequence) || (source.eventSequence as number) < 1) {
      throw new TypeError("context_fact_source_invalid");
    }
    const excerpt = requireText(source.excerpt, "context_fact_source_invalid", 4_096);
    const safeExcerpt = redactor.redactText(excerpt);
    if (!safeExcerpt.ok || safeExcerpt.text !== excerpt) throw new TypeError("context_fact_source_invalid");
    eventIds.add(source.eventId);
    sequences.add(source.eventSequence as number);
    sources.push(source);
  }
  if (eventIds.size !== sources.length || sequences.size !== sources.length) {
    throw new TypeError("context_fact_source_invalid");
  }
  const text = requireText(fact.text, "context_fact_invalid", 4_096);
  const safeText = redactor.redactText(text);
  if (!safeText.ok || safeText.text !== text
    || typeof fact.factId !== "string" || !FACT_ID.test(fact.factId)
    || typeof fact.origin !== "string" || !FACT_ORIGINS.has(fact.origin)
    || fact.sensitivity !== "normal" && fact.sensitivity !== "sensitive"
    || typeof fact.confidence !== "number" || !Number.isFinite(fact.confidence)
    || fact.confidence < 0 || fact.confidence > 1
    || requireText(fact.distillerVersion, "context_fact_invalid", 128) !== fact.distillerVersion
    || parseTimestamp(fact.distilledAt, "context_fact_invalid") !== fact.distilledAt
    || typeof fact.contentHash !== "string" || !SHA256.test(fact.contentHash)
    || canonicalJson(fact as JsonValue) !== row.fact_json
    || canonicalJson(fact.sources as JsonValue) !== row.sources_json
    || row.principal_id !== principalId || row.fact_id !== fact.factId || row.text !== text
    || row.origin !== fact.origin || row.sensitivity !== fact.sensitivity
    || row.confidence !== fact.confidence || row.distiller_version !== fact.distillerVersion
    || row.distilled_at !== fact.distilledAt || row.content_hash !== fact.contentHash
    || row.primary_event_id !== sources[0]?.eventId
    || row.primary_event_sequence !== sources[0]?.eventSequence
    || row.content_hash_count !== 1) {
    throw new TypeError("context_fact_invalid");
  }
  const expectedHash = await sha256Hex(canonicalJson({
    principal_id: principalId,
    sources: [...eventIds].sort(),
    text,
  }));
  if (fact.contentHash !== expectedHash || fact.factId !== `fact_${expectedHash.slice(0, 32)}`) {
    throw new TypeError("context_fact_invalid");
  }
  return Object.freeze({
    factId: fact.factId,
    bytes: encoder.encode(text).byteLength,
    item: Object.freeze({
      sourceEventId: row.primary_event_id as Ulid,
      text,
      sensitivity: row.any_sensitive === 1 ? "restricted" as const : "personal" as const,
    }),
  });
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

async function executeStatements(
  database: D1Database,
  statements: D1PreparedStatement[],
): Promise<readonly D1Result<unknown>[]> {
  if (typeof database.batch === "function") return database.batch(statements);
  // Some existing callers provide the pre-batch D1 surface. Keep their
  // validation behaviour while production D1 takes the single-trip path.
  return Promise.all(statements.map(async (statement) => statement.all()));
}

/**
 * A call reply's payload may carry `memoryItemIds`, the ids of memories the
 * reply cited (#174). They are identifiers, not message text.
 */
function withoutMemoryReferences(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !Object.hasOwn(value, "memoryItemIds")) return value;
  const { memoryItemIds: _references, ...rest } = value as Record<string, unknown>;
  return rest;
}

function historyText(payload: unknown, eventType: string): string {
  const value = historyPayload(eventType === "conversation.assistant_sent" ? withoutMemoryReferences(payload) : payload);
  // A call reply stored before call replies were history carries
  // `historyEligible: false`; that recorded a policy, not anything about the
  // text, so `assistant_sent` admits either value. See literal-history.ts.
  const eligible = eventType === "conversation.assistant_sent"
    ? typeof value.historyEligible === "boolean"
    : value.historyEligible === true;
  if (value.schemaCode !== 1 || value.sensitivityCode !== 1 || !eligible
    || eventType === "conversation.assistant_delivered" && value.channelCode !== 2
    || eventType === "conversation.assistant_sent" && value.channelCode !== 1
    || eventType === "conversation.user_committed" && value.channelCode !== 1 && value.channelCode !== 2) {
    throw new TypeError("context_payload_invalid");
  }
  const text = requireText(value.text, "context_payload_invalid", MAX_CONTEXT_BYTES);
  const verified = redactor.redactText(text);
  if (!verified.ok || verified.text !== text) throw new TypeError("context_payload_invalid");
  return text;
}

/** Reads published projected facts and recent authenticated-principal history from D1. */
export class D1ContextRetriever implements ContextRetriever {
  constructor(private readonly database: D1Database) {}

  async retrieve(input: ContextRetrieverInput): Promise<readonly RetrievedContext[]> {
    const captured = captureInput(input);
    const selectedFacts: RetrievedContext[] = [];
    const deferredFacts: FactCandidate[] = [];
    let returnedBytes = 0;
    const ftsQuery = literalFtsQuery(captured.query);
    const factStatement = ftsQuery === null ? null : this.database.prepare(`WITH eligible AS (
        SELECT f.principal_id, f.device_id, f.projection_version, f.fact_id, f.text,
               f.origin, f.sensitivity, f.confidence, f.distiller_version, f.distilled_at,
               f.content_hash, f.primary_event_id, f.primary_event_sequence,
               f.sources_json, f.fact_json, memory_fact_projection_fts.rank AS relevance
        FROM memory_fact_projection_fts
        JOIN memory_fact_projection_facts f
          ON f.projection_fact_rowid = memory_fact_projection_fts.rowid
        JOIN memory_fact_projection_heads h
          ON h.principal_id = f.principal_id AND h.device_id = f.device_id
         AND h.published_version = f.projection_version
        JOIN memory_fact_projection_versions v
          ON v.principal_id = f.principal_id AND v.device_id = f.device_id
         AND v.projection_version = f.projection_version AND v.status = 'published'
        JOIN device_keys d
          ON d.device_id = f.device_id AND d.principal_id = f.principal_id AND d.status = 'active'
        JOIN principals p ON p.principal_id = f.principal_id AND p.status = 'active'
        WHERE memory_fact_projection_fts MATCH ?1 AND f.principal_id = ?2
          -- A projected fact is a second copy of a turn, so it has to honour
          -- suppression too, not just the history read below. The device
          -- re-uploads its whole snapshot every cycle, so a fact distilled
          -- from a turn the owner later asked to forget is re-published in
          -- every later version; without this anti-join it comes back as model
          -- context on the next call. Every source is checked, not only
          -- primary_event_id, because a fact cites up to eight turns.
          AND NOT EXISTS (
            SELECT 1 FROM json_each(f.sources_json) projected_source
            JOIN memory_active_event_suppressions suppression
              ON suppression.principal_id = f.principal_id
              AND (
                suppression.target_event_id = json_extract(projected_source.value, '$.eventId')
                OR json_extract(projected_source.value, '$.eventSequence')
                  BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
              )
          )
      ), aggregate_flags AS (
        SELECT fact_id,
               MAX(CASE WHEN sensitivity = 'sensitive' THEN 1 ELSE 0 END) AS any_sensitive,
               COUNT(DISTINCT content_hash) AS content_hash_count
        FROM eligible GROUP BY fact_id
      ), ranked AS (
        SELECT e.*, a.any_sensitive, a.content_hash_count,
               ROW_NUMBER() OVER (
                 PARTITION BY e.fact_id
                 ORDER BY e.distilled_at DESC, e.projection_version DESC, e.device_id ASC
               ) AS candidate_rank
        FROM eligible e JOIN aggregate_flags a ON a.fact_id = e.fact_id
      )
      SELECT principal_id, device_id, projection_version, fact_id, text, origin,
             sensitivity, confidence, distiller_version, distilled_at, content_hash,
             primary_event_id, primary_event_sequence, sources_json, fact_json,
             relevance, any_sensitive, content_hash_count
      FROM ranked WHERE candidate_rank = 1
      ORDER BY relevance ASC, distilled_at DESC, fact_id ASC, device_id ASC
      LIMIT ?3`)
      .bind(ftsQuery, captured.principalId, MAX_FACT_CANDIDATES);
    // Suppression is applied HERE, in the shared retriever, rather than by
    // each caller. Telegram used to filter this afterwards, which left every
    // other caller -- voice above all -- reading forgotten turns back into
    // model context. The owner asks Jarvis to forget a remark and then hears
    // it again on the next phone call; that is the defect this closes.
    //
    // The anti-join is deliberately applied BEFORE LIMIT, not after. Filtering
    // a limited page would silently shorten history by one turn per forgotten
    // event, instead of backfilling with older visible turns to keep the
    // window full.
    const historyStatement = this.database.prepare(`SELECT sequence, event_id, event_type, subject_id, content_hash, envelope_json
      FROM events INDEXED BY events_subject_sequence_idx
      WHERE subject_id = ?1
        AND event_type IN (
          'conversation.user_committed', 'conversation.assistant_delivered', 'conversation.assistant_sent'
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_active_event_suppressions suppression
          WHERE suppression.principal_id = ?1
            AND (
              suppression.target_event_id = events.event_id
              OR events.sequence BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
            )
        )
      ORDER BY sequence DESC
      LIMIT ?2`)
      .bind(captured.principalId, MAX_CANDIDATES);
    const statements = factStatement === null
      ? [historyStatement]
      : [factStatement, historyStatement];
    const batch = await executeStatements(this.database, statements);
    if (batch.length !== statements.length) throw new TypeError("context_result_invalid");
    if (factStatement !== null) {
      const factResult = batch[0];
      if (factResult === undefined) throw new TypeError("context_result_invalid");
      const factRows = snapshotFactRows(snapshotResultRows(factResult));
      let decodedFactBytes = 0;
      const candidates: FactCandidate[] = [];
      for (const row of factRows) {
        decodedFactBytes += encoder.encode(row.fact_json).byteLength
          + encoder.encode(row.sources_json).byteLength;
        if (decodedFactBytes > MAX_DECODED_FACT_BYTES) {
          throw new RangeError("context_fact_budget_exceeded");
        }
        candidates.push(await factCandidate(row, captured.principalId));
      }
      const factByteBudget = Math.floor(captured.maxTokens / 2);
      for (const candidate of candidates) {
        if (selectedFacts.length >= MAX_FACT_ITEMS) break;
        if (returnedBytes + candidate.bytes > factByteBudget) {
          deferredFacts.push(candidate);
          continue;
        }
        returnedBytes += candidate.bytes;
        selectedFacts.push(candidate.item);
      }
    }
    const historyResult = batch.at(-1);
    if (historyResult === undefined) throw new TypeError("context_result_invalid");
    const rows = snapshotRows(snapshotResultRows(historyResult));
    let decodedBytes = 0;
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
      if (selectedFacts.length + selectedNewestFirst.length >= MAX_RETURNED_ITEMS) break;
      // History is a newest-first timeline. Reaching past a turn that does not
      // fit would silently splice older context around an omitted middle turn.
      if (returnedBytes + textBytes > captured.maxTokens) break;
      returnedBytes += textBytes;
      selectedNewestFirst.push(Object.freeze({
        sourceEventId: row.event_id as Ulid,
        text,
        sensitivity: "personal" as const,
      }));
    }

    for (const candidate of deferredFacts) {
      if (selectedFacts.length >= MAX_FACT_ITEMS
        || selectedFacts.length + selectedNewestFirst.length >= MAX_RETURNED_ITEMS) break;
      if (returnedBytes + candidate.bytes > captured.maxTokens) continue;
      returnedBytes += candidate.bytes;
      selectedFacts.push(candidate.item);
    }

    return Object.freeze([...selectedFacts, ...selectedNewestFirst.reverse()]);
  }
}

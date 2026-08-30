import { canonicalJson, isPersistableEventEnvelope, validateEnvelope, type EventEnvelope, type PersistableEventEnvelopeV1, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { TransactionRunner } from "./transaction.js";

export interface AppendedEvent {
  eventSequence: number;
  envelope: EventEnvelope;
  replayed: boolean;
}

export interface SyncEventReader {
  latestSequence(): Promise<number>;
  readRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]>;
}

export interface EventAppendInput {
  envelope: PersistableEventEnvelopeV1;
  scope: string;
  key: string;
  requestHash: Sha256Hex;
}

export type EventAppendDependencyFactory = (
  database: D1Database,
  createdAt: string,
) => readonly D1PreparedStatement[];

export interface EventRepositoryContract extends SyncEventReader {
  append(input: EventAppendInput): Promise<AppendedEvent>;
}

interface StoredIdempotencyRecord {
  request_hash: string;
  event_sequence: number;
  envelope_json: string | null;
  content_hash: string | null;
}

interface StoredEvent {
  sequence: number;
  envelope_json: string;
  content_hash: string;
}

export class IdempotencyConflict extends Error {
  constructor(scope: string, key: string) {
    super(`idempotency_conflict:${scope}:${key}`);
    this.name = "IdempotencyConflict";
  }
}

function now(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must be non-empty`);
}

const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function requireUtf8Limit(value: string, maximumBytes: number, label: string): void {
  if (encoder.encode(value).byteLength > maximumBytes) throw new RangeError(`${label} exceeds UTF-8 byte limit`);
}

/** Stores only canonical, already-redacted envelopes and their content hash. */
export class EventRepository implements EventRepositoryContract {
  private readonly transactions: TransactionRunner;

  constructor(private readonly database: D1Database, private readonly replayReader?: SyncEventReader) {
    this.transactions = new TransactionRunner(database);
  }

  append(input: EventAppendInput): Promise<AppendedEvent> {
    return this.appendAtomic(input, () => []);
  }

  async appendAtomic(input: EventAppendInput, buildDependencies: EventAppendDependencyFactory): Promise<AppendedEvent> {
    requireNonEmpty(input.scope, "scope");
    requireNonEmpty(input.key, "key");
    requireUtf8Limit(input.scope, 128, "scope");
    requireUtf8Limit(input.key, 256, "key");
    if (!SHA256.test(input.requestHash)) throw new TypeError("requestHash must be a lowercase SHA-256 hash");
    if (!isPersistableEventEnvelope(input.envelope)) throw new TypeError("envelope must be a persistable envelope");
    if (input.envelope.eventSequence !== undefined) throw new TypeError("producer envelope must not include eventSequence");
    await validateEnvelope(input.envelope);
    const envelopeJson = canonicalJson(input.envelope);
    requireUtf8Limit(envelopeJson, 262144, "envelope");

    const existing = await this.readIdempotency(input.scope, input.key);
    if (existing !== null) return this.resolveIdempotency(existing, input.scope, input.key, input.requestHash);

    const createdAt = now();
    const dependencies = buildDependencies(this.database, createdAt);
    if (!Array.isArray(dependencies) || dependencies.length > 2) {
      throw new RangeError("event_append_dependency_limit");
    }
    try {
      await this.transactions.batch([
        ...dependencies,
        this.database.prepare(
          "INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          input.envelope.eventId,
          input.envelope.eventType,
          input.envelope.source,
          input.envelope.subjectId,
          input.envelope.occurredAt,
          input.envelope.receivedAt,
          input.envelope.contentHash,
          envelopeJson,
          createdAt,
        ),
        this.database.prepare(
          "INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) SELECT ?, ?, ?, sequence, ? FROM events WHERE event_id = ?",
        ).bind(input.scope, input.key, input.requestHash, createdAt, input.envelope.eventId),
        this.database.prepare(
          "INSERT INTO outbox (outbox_id, event_sequence, topic, status, available_at, created_at) SELECT ?, sequence, ?, 'pending', ?, ? FROM events WHERE event_id = ?",
        ).bind(`event:${input.envelope.eventId}`, input.envelope.eventType, createdAt, createdAt, input.envelope.eventId),
      ]);
    } catch (error) {
      const racedRecord = await this.readIdempotency(input.scope, input.key);
      if (racedRecord !== null) return this.resolveIdempotency(racedRecord, input.scope, input.key, input.requestHash);
      throw error;
    }

    const stored = await this.readEventById(input.envelope.eventId);
    if (stored === null) throw new Error("event_append_missing_after_commit");
    return this.toAppended(stored.sequence, stored.envelope_json, stored.content_hash, false);
  }

  async readRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("afterSequence must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new RangeError("limit must be between 1 and 1000");
    const result = await this.database.prepare(
      "SELECT sequence, envelope_json, content_hash FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    ).bind(afterSequence, limit).all<StoredEvent>();
    return Promise.all(result.results.map((row) => this.toAppended(row.sequence, row.envelope_json, row.content_hash, true)));
  }

  async latestSequence(): Promise<number> {
    const row = await this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS latest_sequence FROM events").first<{ latest_sequence: number }>();
    const latest = row?.latest_sequence ?? 0;
    if (!Number.isSafeInteger(latest) || latest < 0) throw new Error("event_sequence_invalid");
    return latest;
  }

  private async readIdempotency(scope: string, key: string): Promise<StoredIdempotencyRecord | null> {
    return this.database.prepare(
      "SELECT i.request_hash, i.event_sequence, e.envelope_json, e.content_hash FROM idempotency_records i LEFT JOIN events e ON e.sequence = i.event_sequence WHERE i.scope = ? AND i.key = ?",
    ).bind(scope, key).first<StoredIdempotencyRecord>();
  }

  private async readEventById(eventId: string): Promise<StoredEvent | null> {
    return this.database.prepare("SELECT sequence, envelope_json, content_hash FROM events WHERE event_id = ?").bind(eventId).first<StoredEvent>();
  }

  private async resolveIdempotency(record: StoredIdempotencyRecord, scope: string, key: string, requestHash: Sha256Hex): Promise<AppendedEvent> {
    if (record.request_hash !== requestHash) throw new IdempotencyConflict(scope, key);
    if (record.envelope_json !== null && record.content_hash !== null) {
      return this.toAppended(record.event_sequence, record.envelope_json, record.content_hash, true);
    }
    if (record.envelope_json !== null || record.content_hash !== null) throw new Error("idempotency_record_corrupt");
    if (this.replayReader === undefined) throw new Error("idempotency_replay_unavailable");
    const archived = await this.replayReader.readRange(record.event_sequence - 1, 1);
    const event = archived[0];
    if (archived.length !== 1 || event?.eventSequence !== record.event_sequence) {
      throw new Error("idempotency_replay_incomplete");
    }
    return { ...event, replayed: true };
  }

  private async toAppended(sequence: number, envelopeJson: string, contentHash: string, replayed: boolean): Promise<AppendedEvent> {
    const raw: unknown = JSON.parse(envelopeJson);
    const envelope = await validateEnvelope(raw);
    if (envelope.contentHash !== contentHash) throw new TypeError("ledger content hash does not match envelope content hash");
    if (envelope.eventSequence !== undefined && envelope.eventSequence !== sequence) throw new TypeError("stored envelope sequence does not match ledger sequence");
    return { eventSequence: sequence, envelope: { ...envelope, eventSequence: sequence }, replayed };
  }
}

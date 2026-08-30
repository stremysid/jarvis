import { canonicalJson, validateEnvelope, type EventEnvelope, type EventEnvelopeV1, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { TransactionRunner } from "./transaction.js";

export interface AppendedEvent {
  eventSequence: number;
  envelope: EventEnvelope;
  replayed: boolean;
}

export interface EventRepositoryContract {
  append(input: { envelope: EventEnvelopeV1; scope: string; key: string; requestHash: Sha256Hex }): Promise<AppendedEvent>;
  readRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]>;
}

interface StoredIdempotencyRecord {
  request_hash: string;
  event_sequence: number;
  envelope_json: string;
}

interface StoredEvent {
  sequence: number;
  envelope_json: string;
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

/** Stores only canonical, already-redacted envelopes and their content hash. */
export class EventRepository implements EventRepositoryContract {
  private readonly transactions: TransactionRunner;

  constructor(private readonly database: D1Database) {
    this.transactions = new TransactionRunner(database);
  }

  async append(input: { envelope: EventEnvelopeV1; scope: string; key: string; requestHash: Sha256Hex }): Promise<AppendedEvent> {
    requireNonEmpty(input.scope, "scope");
    requireNonEmpty(input.key, "key");
    await validateEnvelope(input.envelope);

    const existing = await this.readIdempotency(input.scope, input.key);
    if (existing !== null) return this.resolveIdempotency(existing, input.scope, input.key, input.requestHash);

    const createdAt = now();
    try {
      await this.transactions.batch([
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
          canonicalJson(input.envelope),
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
    return this.toAppended(stored.sequence, stored.envelope_json, false);
  }

  async readRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("afterSequence must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be a positive integer");
    const result = await this.database.prepare(
      "SELECT sequence, envelope_json FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    ).bind(afterSequence, limit).all<StoredEvent>();
    return Promise.all(result.results.map((row) => this.toAppended(row.sequence, row.envelope_json, true)));
  }

  private async readIdempotency(scope: string, key: string): Promise<StoredIdempotencyRecord | null> {
    return this.database.prepare(
      "SELECT i.request_hash, i.event_sequence, e.envelope_json FROM idempotency_records i JOIN events e ON e.sequence = i.event_sequence WHERE i.scope = ? AND i.key = ?",
    ).bind(scope, key).first<StoredIdempotencyRecord>();
  }

  private async readEventById(eventId: string): Promise<StoredEvent | null> {
    return this.database.prepare("SELECT sequence, envelope_json FROM events WHERE event_id = ?").bind(eventId).first<StoredEvent>();
  }

  private async resolveIdempotency(record: StoredIdempotencyRecord, scope: string, key: string, requestHash: Sha256Hex): Promise<AppendedEvent> {
    if (record.request_hash !== requestHash) throw new IdempotencyConflict(scope, key);
    return this.toAppended(record.event_sequence, record.envelope_json, true);
  }

  private async toAppended(sequence: number, envelopeJson: string, replayed: boolean): Promise<AppendedEvent> {
    const raw: unknown = JSON.parse(envelopeJson);
    const envelope = await validateEnvelope(raw);
    if (envelope.eventSequence !== undefined && envelope.eventSequence !== sequence) throw new TypeError("stored envelope sequence does not match ledger sequence");
    return { eventSequence: sequence, envelope: { ...envelope, eventSequence: sequence }, replayed };
  }
}

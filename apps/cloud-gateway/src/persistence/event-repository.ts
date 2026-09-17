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

export type EventAppendPostDependencyFactory = EventAppendDependencyFactory;

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

interface AtomicAppendAfterResult {
  readonly appended: AppendedEvent;
  readonly postResults: readonly D1Result<unknown>[];
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

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.length === 0) throw new TypeError(`${label} must be non-empty`);
}

const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function requireUtf8Limit(value: unknown, maximumBytes: number, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (encoder.encode(value).byteLength > maximumBytes) throw new RangeError(`${label} exceeds UTF-8 byte limit`);
}

function captureAppendInput(input: EventAppendInput): Readonly<EventAppendInput> {
  const fields = ["envelope", "scope", "key", "requestHash"] as const;
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(input);
    keys = Reflect.ownKeys(input);
  } catch {
    throw new TypeError("event_append_input_invalid");
  }
  if (
    prototype !== Object.prototype
    || keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !(fields as readonly string[]).includes(key))
  ) {
    throw new TypeError("event_append_input_invalid");
  }
  const captured = Object.create(null) as Record<(typeof fields)[number], unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(input, field); }
    catch { throw new TypeError("event_append_input_invalid"); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("event_append_input_invalid");
    }
    captured[field] = descriptor.value;
  }
  return Object.freeze(captured) as unknown as Readonly<EventAppendInput>;
}

function capturePostDependencies(value: unknown): readonly D1PreparedStatement[] {
  if (!Array.isArray(value)) throw new RangeError("event_append_post_dependency_limit");
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new TypeError("event_append_post_dependency_invalid");
  }
  if (
    prototype !== Array.prototype
    || lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError("event_append_post_dependency_invalid");
  }
  const dependencyCount = lengthDescriptor.value as number;
  if (dependencyCount > 2) throw new RangeError("event_append_post_dependency_limit");
  const expectedKeys = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < dependencyCount; index += 1) expectedKeys.add(String(index));
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new TypeError("event_append_post_dependency_invalid");
  }
  const dependencies: D1PreparedStatement[] = [];
  for (let index = 0; index < dependencyCount; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { throw new TypeError("event_append_post_dependency_invalid"); }
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
      || descriptor.value === undefined
    ) {
      throw new TypeError("event_append_post_dependency_invalid");
    }
    dependencies.push(descriptor.value as D1PreparedStatement);
  }
  return Object.freeze(dependencies);
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
    const envelope = input.envelope;
    const scope = input.scope;
    const key = input.key;
    const requestHash = input.requestHash;
    const dependencyFactory = buildDependencies;
    requireNonEmpty(scope, "scope");
    requireNonEmpty(key, "key");
    requireUtf8Limit(scope, 128, "scope");
    requireUtf8Limit(key, 256, "key");
    if (typeof requestHash !== "string" || !SHA256.test(requestHash)) throw new TypeError("requestHash must be a lowercase SHA-256 hash");
    if (!isPersistableEventEnvelope(envelope)) throw new TypeError("envelope must be a persistable envelope");
    if (envelope.eventSequence !== undefined) throw new TypeError("producer envelope must not include eventSequence");
    if (typeof dependencyFactory !== "function") throw new TypeError("event_append_dependency_factory_invalid");
    await validateEnvelope(envelope);
    const envelopeJson = canonicalJson(envelope);
    requireUtf8Limit(envelopeJson, 262144, "envelope");

    const existing = await this.readIdempotency(scope, key);
    if (existing !== null) return this.resolveIdempotency(existing, scope, key, requestHash);

    const createdAt = now();
    const providedDependencies = dependencyFactory(this.database, createdAt);
    if (!Array.isArray(providedDependencies)) {
      throw new RangeError("event_append_dependency_limit");
    }
    const dependencyCount = providedDependencies.length;
    // A terminal voice callback needs its receipt plus both legal phase
    // transitions in this batch; splitting them leaves live authority behind.
    if (!Number.isSafeInteger(dependencyCount) || dependencyCount < 0 || dependencyCount > 3) {
      throw new RangeError("event_append_dependency_limit");
    }
    const dependencies: D1PreparedStatement[] = [];
    for (let index = 0; index < dependencyCount; index += 1) {
      if (!Object.hasOwn(providedDependencies, index)) throw new TypeError("event_append_dependency_invalid");
      const dependency = providedDependencies[index];
      if (dependency === undefined) throw new TypeError("event_append_dependency_invalid");
      dependencies.push(dependency);
    }
    let results: readonly D1Result<unknown>[];
    try {
      results = await this.transactions.batch([
        ...dependencies,
        this.database.prepare(
          "INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          envelope.eventId,
          envelope.eventType,
          envelope.source,
          envelope.subjectId,
          envelope.occurredAt,
          envelope.receivedAt,
          envelope.contentHash,
          envelopeJson,
          createdAt,
        ),
        this.database.prepare(
          "INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) SELECT ?, ?, ?, sequence, ? FROM events WHERE event_id = ?",
        ).bind(scope, key, requestHash, createdAt, envelope.eventId),
        this.database.prepare(
          "INSERT INTO outbox (outbox_id, event_sequence, topic, status, available_at, created_at) SELECT ?, sequence, ?, 'pending', ?, ? FROM events WHERE event_id = ?",
        ).bind(`event:${envelope.eventId}`, envelope.eventType, createdAt, createdAt, envelope.eventId),
        this.database.prepare(
          "SELECT sequence, envelope_json, content_hash FROM events WHERE event_id = ?",
        ).bind(envelope.eventId),
      ]);
    } catch (error) {
      const racedRecord = await this.readIdempotency(scope, key);
      if (racedRecord !== null) return this.resolveIdempotency(racedRecord, scope, key, requestHash);
      throw error;
    }

    const stored = this.storedEventFromBatch(results);
    if (stored === null) throw new Error("event_append_missing_after_commit");
    return this.toAppended(stored.sequence, stored.envelope_json, stored.content_hash, false);
  }

  /** Appends up to two dependencies after the event, idempotency row, and foundation outbox row. */
  async appendAtomicAfter(
    input: EventAppendInput,
    buildPostDependencies: EventAppendPostDependencyFactory,
  ): Promise<AppendedEvent> {
    return (await this.appendAtomicAfterInternal(input, buildPostDependencies, true)).appended;
  }

  /**
   * Appends after a caller has already proved its owning durable row is absent.
   *
   * The batch still owns idempotency and race recovery. Skipping only the
   * duplicate preflight read lets capability-bound conversation transitions
   * commit and return their guarded rows in one D1 round trip.
   */
  async appendAtomicAfterKnownAbsent(
    input: EventAppendInput,
    buildPostDependencies: EventAppendPostDependencyFactory,
  ): Promise<AtomicAppendAfterResult> {
    return this.appendAtomicAfterInternal(input, buildPostDependencies, false);
  }

  private async appendAtomicAfterInternal(
    input: EventAppendInput,
    buildPostDependencies: EventAppendPostDependencyFactory,
    readExisting: boolean,
  ): Promise<AtomicAppendAfterResult> {
    const captured = captureAppendInput(input);
    const envelope = captured.envelope;
    const scope = captured.scope;
    const key = captured.key;
    const requestHash = captured.requestHash;
    const dependencyFactory = buildPostDependencies;
    requireNonEmpty(scope, "scope");
    requireNonEmpty(key, "key");
    requireUtf8Limit(scope, 128, "scope");
    requireUtf8Limit(key, 256, "key");
    if (typeof requestHash !== "string" || !SHA256.test(requestHash)) {
      throw new TypeError("requestHash must be a lowercase SHA-256 hash");
    }
    if (!isPersistableEventEnvelope(envelope)) throw new TypeError("envelope must be a persistable envelope");
    if (envelope.eventSequence !== undefined) throw new TypeError("producer envelope must not include eventSequence");
    if (typeof dependencyFactory !== "function") throw new TypeError("event_append_post_dependency_factory_invalid");
    await validateEnvelope(envelope);
    const envelopeJson = canonicalJson(envelope);
    requireUtf8Limit(envelopeJson, 262144, "envelope");

    if (readExisting) {
      const existing = await this.readIdempotency(scope, key);
      if (existing !== null) {
        return Object.freeze({
          appended: await this.resolveIdempotency(existing, scope, key, requestHash),
          postResults: Object.freeze([]),
        });
      }
    }

    const createdAt = now();
    const postDependencies = capturePostDependencies(dependencyFactory(this.database, createdAt));
    let results: readonly D1Result<unknown>[];
    try {
      results = await this.transactions.batch([
        this.database.prepare(
          "INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          envelope.eventId,
          envelope.eventType,
          envelope.source,
          envelope.subjectId,
          envelope.occurredAt,
          envelope.receivedAt,
          envelope.contentHash,
          envelopeJson,
          createdAt,
        ),
        this.database.prepare(
          "INSERT INTO idempotency_records (scope, key, request_hash, event_sequence, created_at) SELECT ?, ?, ?, sequence, ? FROM events WHERE event_id = ?",
        ).bind(scope, key, requestHash, createdAt, envelope.eventId),
        this.database.prepare(
          "INSERT INTO outbox (outbox_id, event_sequence, topic, status, available_at, created_at) SELECT ?, sequence, ?, 'pending', ?, ? FROM events WHERE event_id = ?",
        ).bind(`event:${envelope.eventId}`, envelope.eventType, createdAt, createdAt, envelope.eventId),
        ...postDependencies,
        this.database.prepare(
          "SELECT sequence, envelope_json, content_hash FROM events WHERE event_id = ?",
        ).bind(envelope.eventId),
      ]);
    } catch (error) {
      const racedRecord = await this.readIdempotency(scope, key);
      if (racedRecord !== null) {
        return Object.freeze({
          appended: await this.resolveIdempotency(racedRecord, scope, key, requestHash),
          postResults: Object.freeze([]),
        });
      }
      throw error;
    }

    const stored = this.storedEventFromBatch(results);
    if (stored === null) throw new Error("event_append_missing_after_commit");
    return Object.freeze({
      appended: await this.toAppended(stored.sequence, stored.envelope_json, stored.content_hash, false),
      postResults: Object.freeze(results.slice(3, 3 + postDependencies.length)),
    });
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

  private storedEventFromBatch(results: readonly D1Result<unknown>[]): StoredEvent | null {
    const rows = results.at(-1)?.results;
    if (rows === undefined || rows.length !== 1) return null;
    return rows[0] as StoredEvent;
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

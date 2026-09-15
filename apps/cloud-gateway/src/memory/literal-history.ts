import {
  canonicalJson,
  sha256Hex,
  validateEnvelope,
  type EventEnvelope,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import type { ArchiveManifest, ArchiveState } from "../archive/archive-repository.js";
import type { AppendedEvent, SyncEventReader } from "../persistence/event-repository.js";
import { Redactor } from "../security/redaction.js";
import type { MemorySourceChannel, MemorySourceLocation } from "./memory-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HISTORY_PAYLOAD_FIELDS = new Set([
  "schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text",
]);
const MAX_QUERY_BYTES = 1_024;
const MAX_EVENT_TEXT_BYTES = 32_768;
const MAX_FTS_TERMS = 16;
const MAX_FTS_TERM_BYTES = 128;
const MAX_SEARCH_RESULTS = 8;
const MAX_EXCERPT_BYTES = 1_024;
const MAX_INDEX_EVENTS = 16;
const MAX_INDEX_TEXT_BYTES = 262_144;
const MAX_JOB_EVENTS = 16;
const MAX_JOB_TEXT_BYTES = 262_144;
const TIERED_READ_D1_STATEMENT_CEILING = 6;
const encoder = new TextEncoder();
const redactor = new Redactor();

export const LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS = Object.freeze({
  d1Statements: 22,
  eventsExamined: Math.min(MAX_JOB_EVENTS, MAX_JOB_TEXT_BYTES / MAX_EVENT_TEXT_BYTES),
  textBytesExamined: MAX_JOB_TEXT_BYTES,
});

export const LITERAL_HISTORY_SEARCH_LIMITS = Object.freeze({
  d1Statements: 62,
  resultsExamined: MAX_SEARCH_RESULTS,
});

export type LiteralHistoryErrorCode =
  | "memory_history_corrupt"
  | "memory_history_not_found"
  | "memory_history_refused"
  | "memory_history_unavailable";

export class LiteralHistoryError extends Error {
  constructor(readonly code: LiteralHistoryErrorCode) {
    super(code);
    this.name = "LiteralHistoryError";
  }
}

export interface HistoryArchiveCatalog {
  readState(): Promise<ArchiveState>;
  listManifests(
    afterSequence: number,
    throughSequence: number,
    manifestLimit: number,
  ): Promise<readonly ArchiveManifest[]>;
}

export interface LiteralHistoryOptions {
  readonly database: D1Database;
  readonly events: SyncEventReader;
  readonly archive: HistoryArchiveCatalog;
  readonly now: () => Date;
  readonly nextId: () => Ulid;
}

export interface LiteralHistoryHit {
  readonly eventId: Ulid;
  readonly eventSequence: number;
  readonly occurredAt: string;
  readonly channel: MemorySourceChannel;
  readonly sourceLocation: MemorySourceLocation;
  readonly r2SegmentId: Sha256Hex | null;
  readonly excerpt: string;
  readonly excerptHash: Sha256Hex;
}

export interface MissingHistoryRange {
  readonly startEventSequence: number;
  readonly endEventSequence: number;
}

export type LiteralHistorySearchResult =
  | Readonly<{
    status: "hits";
    hits: readonly LiteralHistoryHit[];
    searchedThroughEventSequence: number;
  }>
  | Readonly<{
    status: "no_hit";
    hits: readonly LiteralHistoryHit[];
    searchedThroughEventSequence: number;
  }>
  | Readonly<{
    status: "incomplete";
    hits: readonly LiteralHistoryHit[];
    searchedThroughEventSequence: number;
    missingRange: MissingHistoryRange;
  }>;

export interface HistoryIndexStepResult {
  readonly startEventSequence: number | null;
  readonly endEventSequence: number | null;
  readonly eventsExamined: number;
  readonly chunksWritten: number;
  readonly refreshed: boolean;
  readonly complete: boolean;
}

export interface ExhaustiveSearchJob {
  readonly jobId: Ulid;
  readonly principalId: string;
  readonly jobKey: string;
  readonly attempt: number;
  readonly query: string;
  readonly snapshotEventSequence: number;
  readonly checkpointEventSequence: number;
  readonly scannedEventCount: number;
  readonly matchedEventCount: number;
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface ExhaustiveSearchStepResult {
  readonly job: ExhaustiveSearchJob;
  readonly budget: Readonly<{
    d1Statements: number;
    eventsExamined: number;
    textBytesExamined: number;
  }>;
}

interface CursorRow {
  readonly current_event_sequence: unknown;
  readonly updated_at: unknown;
}

interface MaintenanceRow {
  readonly event_sequence: unknown;
  readonly changed_at: unknown;
}

interface ChunkCandidateRow {
  readonly event_sequence: unknown;
  readonly content_hash: unknown;
}

interface SuppressionRow {
  readonly target_event_id: unknown;
  readonly start_event_sequence: unknown;
  readonly end_event_sequence: unknown;
}

interface ProvenanceRow {
  readonly segment_id: unknown;
  readonly suppressed: unknown;
}

interface JobRow {
  readonly job_id: unknown;
  readonly principal_id: unknown;
  readonly job_key: unknown;
  readonly attempt: unknown;
  readonly query_text: unknown;
  readonly query_hash: unknown;
  readonly snapshot_event_sequence: unknown;
  readonly checkpoint_event_sequence: unknown;
  readonly scanned_event_count: unknown;
  readonly matched_event_count: unknown;
  readonly status: unknown;
  readonly failure_code: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly completed_at: unknown;
}

interface JobHitRow {
  readonly event_sequence: unknown;
  readonly event_id: unknown;
  readonly content_hash: unknown;
}

interface HistoryEvent {
  readonly eventId: Ulid;
  readonly eventSequence: number;
  readonly contentHash: Sha256Hex;
  readonly envelopeHash: Sha256Hex;
  readonly occurredAt: string;
  readonly channel: MemorySourceChannel;
  readonly text: string;
  readonly textBytes: number;
}

interface SourceReceipt {
  readonly sourceLocation: MemorySourceLocation;
  readonly r2SegmentId: Sha256Hex | null;
}

interface SearchTerms {
  readonly ftsQuery: string;
  readonly folded: ReadonlySet<string>;
}

interface MatchSpan {
  readonly start: number;
  readonly end: number;
}

interface StepBudget {
  d1Statements: number;
  eventsExamined: number;
  textBytesExamined: number;
}

function refuse(): never {
  throw new LiteralHistoryError("memory_history_refused");
}

function corrupt(): never {
  throw new LiteralHistoryError("memory_history_corrupt");
}

function unavailable(): never {
  throw new LiteralHistoryError("memory_history_unavailable");
}

function exactRow(value: object, fields: ReadonlySet<string>): void {
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) corrupt();
}

function rowText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value.normalize("NFC") !== value || encoder.encode(value).byteLength > maximumBytes
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) corrupt();
  return value;
}

function inputText(value: unknown, maximumBytes: number): string {
  try {
    if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
      || value.normalize("NFC") !== value || encoder.encode(value).byteLength > maximumBytes
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) refuse();
    return value;
  } catch (error) {
    if (error instanceof LiteralHistoryError) throw error;
    refuse();
  }
}

function inputPrincipal(value: unknown): string {
  return inputText(value, 256);
}

function inputUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) refuse();
  return value as Ulid;
}

function rowUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) corrupt();
  return value as Ulid;
}

function rowHash(value: unknown): Sha256Hex {
  if (typeof value !== "string" || !SHA256.test(value)) corrupt();
  return value as Sha256Hex;
}

function rowInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) corrupt();
  return value as number;
}

function rowTimestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) corrupt();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) corrupt();
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : rowTimestamp(value);
}

function nowTimestamp(now: () => Date, floor?: string): string {
  const value = now();
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) unavailable();
  const floorMilliseconds = floor === undefined ? Number.NEGATIVE_INFINITY : Date.parse(floor);
  return new Date(Math.max(milliseconds, floorMilliseconds)).toISOString();
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) refuse();
  return value as number;
}

function exactDataRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt();
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (prototype !== Object.prototype || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) corrupt();
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) corrupt();
    captured[field] = descriptor.value;
  }
  return captured;
}

function foldTerm(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

function searchTerms(query: string): SearchTerms {
  const quoted: string[] = [];
  const folded = new Set<string>();
  for (const match of query.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].normalize("NFC");
    const key = foldTerm(term);
    if (encoder.encode(term).byteLength > MAX_FTS_TERM_BYTES || folded.has(key)) continue;
    folded.add(key);
    quoted.push(`"${term}"`);
    if (quoted.length === MAX_FTS_TERMS) break;
  }
  if (quoted.length === 0) refuse();
  return Object.freeze({ ftsQuery: quoted.join(" OR "), folded });
}

function matchSpan(text: string, terms: ReadonlySet<string>): MatchSpan | null {
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (terms.has(foldTerm(match[0]))) {
      return Object.freeze({ start: match.index, end: match.index + match[0].length });
    }
  }
  return null;
}

function exactExcerpt(text: string, span: MatchSpan): string {
  if (encoder.encode(text).byteLength <= MAX_EXCERPT_BYTES) return text;
  let start = Math.max(0, span.start - 384);
  let end = Math.min(text.length, span.end + 640);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end -= 1;
  let excerpt = text.slice(start, end);
  while (encoder.encode(excerpt).byteLength > MAX_EXCERPT_BYTES && end > span.end) {
    end -= 1;
    if (end > span.end && /[\uDC00-\uDFFF]/u.test(text[end]!)) end -= 1;
    excerpt = text.slice(start, end);
  }
  while (encoder.encode(excerpt).byteLength > MAX_EXCERPT_BYTES && start < span.start) {
    start += (text.codePointAt(start) ?? 0) > 0xFFFF ? 2 : 1;
    excerpt = text.slice(start, end);
  }
  if (encoder.encode(excerpt).byteLength > MAX_EXCERPT_BYTES
    || start > span.start || end < span.end
    || excerpt.length === 0 || !excerpt.isWellFormed()) corrupt();
  return excerpt;
}

function sourceChannel(eventType: string, channelCode: unknown): MemorySourceChannel {
  if (eventType === "conversation.assistant_delivered") {
    if (channelCode !== 2) corrupt();
    return "telegram";
  }
  if (eventType !== "conversation.user_committed") corrupt();
  if (channelCode === 1) return "voice";
  if (channelCode === 2) return "telegram";
  corrupt();
}

async function historyEvent(event: AppendedEvent, principalId: string): Promise<HistoryEvent | null> {
  let envelope: EventEnvelope;
  try {
    envelope = await validateEnvelope(event.envelope);
  } catch {
    corrupt();
  }
  if (envelope.eventSequence !== event.eventSequence) corrupt();
  if (envelope.subjectId !== principalId
    || envelope.eventType !== "conversation.user_committed"
      && envelope.eventType !== "conversation.assistant_delivered") return null;
  if (envelope.source !== "conversation" || envelope.producerVersion !== "conversation-v1") corrupt();
  const payload = exactDataRecord(envelope.payload, HISTORY_PAYLOAD_FIELDS);
  if (payload.schemaCode !== 1 || payload.sensitivityCode !== 1 || payload.historyEligible !== true) corrupt();
  const channel = sourceChannel(envelope.eventType, payload.channelCode);
  const text = rowText(payload.text, MAX_EVENT_TEXT_BYTES);
  const checked = redactor.redactText(text);
  if (!checked.ok || checked.text !== text) corrupt();
  return Object.freeze({
    eventId: envelope.eventId,
    eventSequence: event.eventSequence,
    contentHash: envelope.contentHash,
    envelopeHash: await sha256Hex(canonicalJson(envelope)),
    occurredAt: envelope.occurredAt,
    channel,
    text,
    textBytes: encoder.encode(text).byteLength,
  });
}

const CURSOR_FIELDS = new Set(["current_event_sequence", "updated_at"]);
const MAINTENANCE_FIELDS = new Set(["event_sequence", "changed_at"]);
const CHUNK_FIELDS = new Set(["event_sequence", "content_hash"]);
const SUPPRESSION_FIELDS = new Set([
  "target_event_id", "start_event_sequence", "end_event_sequence",
]);
const PROVENANCE_FIELDS = new Set(["segment_id", "suppressed"]);
const JOB_FIELDS = new Set([
  "job_id", "principal_id", "job_key", "attempt", "query_text", "query_hash",
  "snapshot_event_sequence", "checkpoint_event_sequence", "scanned_event_count",
  "matched_event_count", "status", "failure_code", "created_at", "updated_at",
  "completed_at",
]);
const JOB_HIT_FIELDS = new Set(["event_sequence", "event_id", "content_hash"]);

/** Builds suppression-safe FTS coverage and exact, provenance-bearing literal results. */
export class LiteralHistoryService {
  constructor(private readonly options: LiteralHistoryOptions) {}

  async indexNext(input: Readonly<{
    principalId: string;
    maxEvents?: number;
    maxTextBytes?: number;
  }>): Promise<HistoryIndexStepResult> {
    return this.safely(async () => {
      const principalId = inputPrincipal(input.principalId);
      await this.requirePrincipal(principalId);
      const maxEvents = boundedInteger(input.maxEvents ?? 8, 1, MAX_INDEX_EVENTS);
      const maxTextBytes = boundedInteger(
        input.maxTextBytes ?? 65_536,
        MAX_EVENT_TEXT_BYTES,
        MAX_INDEX_TEXT_BYTES,
      );
      const maintenance = await this.readMaintenance(principalId);
      if (maintenance !== null) {
        await this.indexSequences(principalId, maintenance.eventSequence - 1, 1, maxTextBytes, true, maintenance.changedAt);
        return Object.freeze({
          startEventSequence: maintenance.eventSequence,
          endEventSequence: maintenance.eventSequence,
          eventsExamined: 1,
          chunksWritten: await this.chunkCount(principalId, maintenance.eventSequence),
          refreshed: true,
          complete: false,
        });
      }

      const cursor = await this.readCursor(principalId);
      const latest = await this.options.events.latestSequence();
      if (!Number.isSafeInteger(latest) || latest < 0) corrupt();
      if (cursor.sequence > latest) corrupt();
      if (cursor.sequence >= latest) {
        return Object.freeze({
          startEventSequence: null,
          endEventSequence: null,
          eventsExamined: 0,
          chunksWritten: 0,
          refreshed: false,
          complete: true,
        });
      }
      const eventLimit = Math.min(maxEvents, Math.max(1, Math.floor(maxTextBytes / MAX_EVENT_TEXT_BYTES)));
      const result = await this.indexSequences(
        principalId,
        cursor.sequence,
        eventLimit,
        maxTextBytes,
        false,
        undefined,
        cursor.updatedAt ?? undefined,
      );
      return Object.freeze({
        ...result,
        refreshed: false,
        complete: result.endEventSequence === latest && await this.readMaintenance(principalId) === null,
      });
    });
  }

  async searchLiteral(input: Readonly<{
    principalId: string;
    query: string;
    maxResults?: number;
  }>): Promise<LiteralHistorySearchResult> {
    return this.safely(async () => {
      const principalId = inputPrincipal(input.principalId);
      await this.requirePrincipal(principalId);
      const query = inputText(input.query, MAX_QUERY_BYTES);
      const terms = searchTerms(query);
      const maxResults = boundedInteger(input.maxResults ?? 5, 1, MAX_SEARCH_RESULTS);
      const rows = await this.options.database.prepare(`SELECT chunk.start_event_sequence AS event_sequence,
          chunk.content_hash
        FROM memory_history_fts
        JOIN memory_retrievable_history_chunks chunk
          ON chunk.chunk_rowid = memory_history_fts.rowid
        WHERE memory_history_fts MATCH ? AND chunk.principal_id = ?
          AND chunk.start_event_sequence = chunk.end_event_sequence
        ORDER BY memory_history_fts.rank ASC, chunk.start_event_sequence DESC
        LIMIT ?`).bind(terms.ftsQuery, principalId, maxResults).all<ChunkCandidateRow>();
      const hits: LiteralHistoryHit[] = [];
      for (const row of rows.results) {
        exactRow(row, CHUNK_FIELDS);
        const sequence = rowInteger(row.event_sequence, 1, Number.MAX_SAFE_INTEGER);
        const expectedTextHash = rowHash(row.content_hash);
        const event = await this.readHistoryEvent(principalId, sequence);
        if (event === null || await sha256Hex(event.text) !== expectedTextHash) corrupt();
        const span = matchSpan(event.text, terms.folded);
        if (span === null) corrupt();
        const provenance = await this.readProvenance(principalId, event);
        if (provenance === null) continue;
        hits.push(await this.hit(event, provenance, span));
      }
      const coverage = await this.coverageStatus(principalId);
      if (coverage.missingRange !== null) {
        return Object.freeze({
          status: "incomplete",
          hits: Object.freeze(hits),
          searchedThroughEventSequence: coverage.searchedThrough,
          missingRange: coverage.missingRange,
        });
      }
      if (hits.length === 0) {
        return Object.freeze({
          status: "no_hit",
          hits: Object.freeze([]),
          searchedThroughEventSequence: coverage.searchedThrough,
        });
      }
      return Object.freeze({
        status: "hits",
        hits: Object.freeze(hits),
        searchedThroughEventSequence: coverage.searchedThrough,
      });
    });
  }

  async createExhaustiveSearch(input: Readonly<{
    principalId: string;
    jobId: Ulid;
    jobKey: string;
    query: string;
  }>): Promise<ExhaustiveSearchJob> {
    return this.safely(async () => {
      const principalId = inputPrincipal(input.principalId);
      await this.requirePrincipal(principalId);
      const jobId = inputUlid(input.jobId);
      const jobKey = inputText(input.jobKey, 128);
      const query = inputText(input.query, MAX_QUERY_BYTES);
      searchTerms(query);
      const queryHash = await sha256Hex(query);
      const existing = await this.readJobByKey(principalId, jobKey);
      let attempt = 1;
      if (existing !== null) {
        if (existing.query !== query) refuse();
        if (existing.jobId === jobId) return existing;
        if (existing.status === "pending" || existing.status === "running") refuse();
        attempt = existing.attempt + 1;
      }
      const snapshot = await this.options.events.latestSequence();
      if (!Number.isSafeInteger(snapshot) || snapshot < 0) corrupt();
      const timestamp = nowTimestamp(this.options.now);
      await this.options.database.prepare(`INSERT INTO memory_literal_search_jobs (
        job_id, principal_id, job_key, attempt, query_text, query_hash, snapshot_event_sequence,
        checkpoint_event_sequence, scanned_event_count, matched_event_count, status,
        failure_code, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'pending', NULL, ?, ?, NULL)`)
        .bind(
          jobId,
          principalId,
          jobKey,
          attempt,
          query,
          queryHash,
          snapshot,
          timestamp,
          timestamp,
        ).run();
      return this.requireJob(principalId, jobId);
    });
  }

  async runExhaustiveSearchStep(input: Readonly<{
    principalId: string;
    jobId: Ulid;
    maxEvents?: number;
    maxTextBytes?: number;
  }>): Promise<ExhaustiveSearchStepResult> {
    return this.safely(async () => {
      const principalId = inputPrincipal(input.principalId);
      await this.requirePrincipal(principalId);
      const jobId = inputUlid(input.jobId);
      const maxEvents = boundedInteger(input.maxEvents ?? 8, 1, MAX_JOB_EVENTS);
      const maxTextBytes = boundedInteger(
        input.maxTextBytes ?? 65_536,
        MAX_EVENT_TEXT_BYTES,
        MAX_JOB_TEXT_BYTES,
      );
      const budget: StepBudget = { d1Statements: 2, eventsExamined: 0, textBytesExamined: 0 };
      let job = await this.requireJob(principalId, jobId);
      if (job.status === "succeeded" || job.status === "failed") {
        return Object.freeze({ job, budget: Object.freeze(budget) });
      }
      if (job.status === "pending") {
        const timestamp = nowTimestamp(this.options.now, job.updatedAt);
        budget.d1Statements += 1;
        await this.options.database.prepare(`UPDATE memory_literal_search_jobs
          SET status = 'running', updated_at = ?
          WHERE principal_id = ? AND job_id = ? AND status = 'pending'`)
          .bind(timestamp, principalId, jobId).run();
        job = await this.requireJob(principalId, jobId);
        budget.d1Statements += 1;
      }
      try {
        if (job.checkpointEventSequence === job.snapshotEventSequence) {
          const timestamp = nowTimestamp(this.options.now, job.updatedAt);
          budget.d1Statements += 1;
          await this.options.database.prepare(`UPDATE memory_literal_search_jobs
            SET status = 'succeeded', updated_at = ?, completed_at = ?
            WHERE principal_id = ? AND job_id = ? AND status = 'running'`)
            .bind(timestamp, timestamp, principalId, jobId).run();
          return Object.freeze({
            job: await this.requireJob(principalId, jobId),
            budget: Object.freeze({ ...budget, d1Statements: budget.d1Statements + 1 }),
          });
        }

        const readLimit = Math.min(
          maxEvents,
          Math.max(1, Math.floor(maxTextBytes / MAX_EVENT_TEXT_BYTES)),
          job.snapshotEventSequence - job.checkpointEventSequence,
        );
        budget.d1Statements += TIERED_READ_D1_STATEMENT_CEILING;
        const events = await this.options.events.readRange(job.checkpointEventSequence, readLimit);
        if (events.length === 0) corrupt();
        const lastSequence = events.at(-1)?.eventSequence;
        if (lastSequence === undefined || lastSequence > job.snapshotEventSequence) corrupt();
        const suppressions = await this.readSuppressions(
          principalId,
          events[0]!.eventSequence,
          lastSequence,
        );
        budget.d1Statements += 1;
        const terms = searchTerms(job.query);
        const candidates: HistoryEvent[] = [];
        for (let index = 0; index < events.length; index += 1) {
          const raw = events[index]!;
          if (raw.eventSequence !== job.checkpointEventSequence + index + 1) corrupt();
          budget.eventsExamined += 1;
          const event = await historyEvent(raw, principalId);
          if (event === null) continue;
          budget.textBytesExamined += event.textBytes;
          if (budget.textBytesExamined > maxTextBytes) corrupt();
          if (!this.isSuppressed(event, suppressions) && matchSpan(event.text, terms.folded) !== null) {
            candidates.push(event);
          }
        }
        const finalSuppressions = await this.readSuppressions(
          principalId,
          events[0]!.eventSequence,
          lastSequence,
        );
        budget.d1Statements += 1;
        const hits = candidates.filter((event) => !this.isSuppressed(event, finalSuppressions));
        const timestamp = nowTimestamp(this.options.now, job.updatedAt);
        const completed = lastSequence === job.snapshotEventSequence;
        const statements: D1PreparedStatement[] = hits.map((event) => this.options.database.prepare(
          `INSERT INTO memory_literal_search_hits (
            principal_id, job_id, event_sequence, event_id, content_hash, found_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          principalId,
          jobId,
          event.eventSequence,
          event.eventId,
          event.contentHash,
          timestamp,
        ));
        statements.push(this.options.database.prepare(`UPDATE memory_literal_search_jobs
          SET checkpoint_event_sequence = ?,
            scanned_event_count = scanned_event_count + ?,
            matched_event_count = matched_event_count + ?,
            status = ?, updated_at = ?, completed_at = ?
          WHERE principal_id = ? AND job_id = ? AND status = 'running'
            AND checkpoint_event_sequence = ?`)
          .bind(
            lastSequence,
            events.length,
            hits.length,
            completed ? "succeeded" : "running",
            timestamp,
            completed ? timestamp : null,
            principalId,
            jobId,
            job.checkpointEventSequence,
          ));
        budget.d1Statements += statements.length;
        await this.options.database.batch(statements);
        budget.d1Statements += 1;
        job = await this.requireJob(principalId, jobId);
        return Object.freeze({ job, budget: Object.freeze(budget) });
      } catch (error) {
        if (error instanceof LiteralHistoryError && error.code === "memory_history_corrupt") {
          const timestamp = nowTimestamp(this.options.now, job.updatedAt);
          await this.options.database.prepare(`UPDATE memory_literal_search_jobs
            SET status = 'failed', failure_code = 'history_step_corrupt',
              updated_at = ?, completed_at = ?
            WHERE principal_id = ? AND job_id = ? AND status = 'running'`)
            .bind(timestamp, timestamp, principalId, jobId).run();
        }
        throw error;
      }
    });
  }

  async readExhaustiveSearchResult(input: Readonly<{
    principalId: string;
    jobId: Ulid;
    maxResults?: number;
  }>): Promise<LiteralHistorySearchResult> {
    return this.safely(async () => {
      const principalId = inputPrincipal(input.principalId);
      await this.requirePrincipal(principalId);
      const jobId = inputUlid(input.jobId);
      const maxResults = boundedInteger(input.maxResults ?? 5, 1, MAX_SEARCH_RESULTS);
      const job = await this.requireJob(principalId, jobId);
      if (job.status === "failed") unavailable();
      if (job.status !== "succeeded") {
        return Object.freeze({
          status: "incomplete",
          hits: Object.freeze([]),
          searchedThroughEventSequence: job.checkpointEventSequence,
          missingRange: Object.freeze({
            startEventSequence: job.checkpointEventSequence + 1,
            endEventSequence: job.snapshotEventSequence,
          }),
        });
      }
      const terms = searchTerms(job.query);
      const rows = await this.options.database.prepare(`SELECT event_sequence, event_id, content_hash
        FROM memory_literal_search_hits
        WHERE principal_id = ? AND job_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM memory_active_event_suppressions suppression
            WHERE suppression.principal_id = memory_literal_search_hits.principal_id
              AND (
                suppression.target_event_id = memory_literal_search_hits.event_id
                OR memory_literal_search_hits.event_sequence BETWEEN
                  suppression.start_event_sequence AND suppression.end_event_sequence
              )
          )
        ORDER BY event_sequence DESC LIMIT ?`)
        .bind(principalId, jobId, maxResults).all<JobHitRow>();
      const hits: LiteralHistoryHit[] = [];
      for (const row of rows.results) {
        exactRow(row, JOB_HIT_FIELDS);
        const eventSequence = rowInteger(row.event_sequence, 1, job.snapshotEventSequence);
        const eventId = rowUlid(row.event_id);
        const contentHash = rowHash(row.content_hash);
        const event = await this.readHistoryEvent(principalId, eventSequence);
        if (event === null || event.eventId !== eventId || event.contentHash !== contentHash) corrupt();
        const span = matchSpan(event.text, terms.folded);
        if (span === null) corrupt();
        const provenance = await this.readProvenance(principalId, event);
        if (provenance !== null) hits.push(await this.hit(event, provenance, span));
      }
      const newest = await this.options.events.latestSequence();
      if (!Number.isSafeInteger(newest) || newest < job.snapshotEventSequence) corrupt();
      if (newest > job.snapshotEventSequence) {
        return Object.freeze({
          status: "incomplete",
          hits: Object.freeze(hits),
          searchedThroughEventSequence: job.snapshotEventSequence,
          missingRange: Object.freeze({
            startEventSequence: job.snapshotEventSequence + 1,
            endEventSequence: newest,
          }),
        });
      }
      return hits.length === 0
        ? Object.freeze({
          status: "no_hit" as const,
          hits: Object.freeze([]),
          searchedThroughEventSequence: job.snapshotEventSequence,
        })
        : Object.freeze({
          status: "hits" as const,
          hits: Object.freeze(hits),
          searchedThroughEventSequence: job.snapshotEventSequence,
        });
    });
  }

  private async safely<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof LiteralHistoryError) throw error;
      throw new LiteralHistoryError("memory_history_unavailable");
    }
  }

  private async requirePrincipal(principalId: string): Promise<void> {
    const row = await this.options.database.prepare(`SELECT 1 AS count FROM principals
      WHERE principal_id = ? AND principal_type = 'human' AND status = 'active'`)
      .bind(principalId).first<{ count: unknown }>();
    if (row === null) refuse();
    exactRow(row, new Set(["count"]));
    if (rowInteger(row.count, 1, 1) !== 1) corrupt();
  }

  private async readCursor(principalId: string): Promise<{ sequence: number; updatedAt: string | null }> {
    const row = await this.options.database.prepare(`SELECT current_event_sequence, updated_at
      FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'fts_history'`)
      .bind(principalId).first<CursorRow>();
    if (row === null) return { sequence: 0, updatedAt: null };
    exactRow(row, CURSOR_FIELDS);
    return {
      sequence: rowInteger(row.current_event_sequence, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: rowTimestamp(row.updated_at),
    };
  }

  private async readMaintenance(principalId: string): Promise<{
    eventSequence: number;
    changedAt: string;
  } | null> {
    const row = await this.options.database.prepare(`WITH exact_coverage AS (
        SELECT start_event_sequence AS event_sequence, source_location, r2_segment_id,
          content_hash, indexed_at
        FROM memory_history_coverage
        WHERE principal_id = ? AND indexing_outcome = 'indexed'
          AND start_event_sequence = end_event_sequence
      ), suppression_changes AS (
        SELECT coverage.event_sequence,
          MAX(CASE WHEN lift.created_at IS NULL THEN suppression.created_at
            WHEN lift.created_at > suppression.created_at THEN lift.created_at
            ELSE suppression.created_at END) AS changed_at,
          MAX(coverage.indexed_at) AS indexed_at
        FROM exact_coverage coverage
        JOIN memory_event_suppressions suppression ON suppression.principal_id = ?
          AND (
            coverage.event_sequence BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
            OR suppression.target_event_id IN (
              SELECT event_id FROM events WHERE sequence = coverage.event_sequence
              UNION ALL
              SELECT event_id FROM archive_segment_events
                WHERE event_sequence = coverage.event_sequence
            )
          )
        LEFT JOIN memory_event_suppression_lifts lift
          ON lift.principal_id = suppression.principal_id
          AND lift.suppression_id = suppression.suppression_id
        GROUP BY coverage.event_sequence
        HAVING indexed_at < changed_at
      ), archive_changes AS (
        SELECT coverage.event_sequence, archived.created_at AS changed_at
        FROM exact_coverage coverage
        JOIN archive_segment_events archived
          ON archived.event_sequence = coverage.event_sequence
        WHERE NOT EXISTS (
          SELECT 1 FROM exact_coverage archived_coverage
          WHERE archived_coverage.event_sequence = coverage.event_sequence
            AND archived_coverage.source_location = 'archived'
            AND archived_coverage.r2_segment_id = archived.segment_id
            AND archived_coverage.content_hash = archived.envelope_sha256
        )
      )
      SELECT event_sequence, changed_at FROM (
        SELECT event_sequence, changed_at FROM suppression_changes
        UNION ALL
        SELECT event_sequence, changed_at FROM archive_changes
      ) ORDER BY event_sequence ASC, changed_at ASC LIMIT 1`)
      .bind(principalId, principalId).first<MaintenanceRow>();
    if (row === null) return null;
    exactRow(row, MAINTENANCE_FIELDS);
    return {
      eventSequence: rowInteger(row.event_sequence, 1, Number.MAX_SAFE_INTEGER),
      changedAt: rowTimestamp(row.changed_at),
    };
  }

  private async indexSequences(
    principalId: string,
    afterSequence: number,
    requestedLimit: number,
    maxTextBytes: number,
    refresh: boolean,
    changedAt?: string,
    updatedAtFloor?: string,
  ): Promise<Omit<HistoryIndexStepResult, "refreshed" | "complete">> {
    const before = await this.options.archive.readState();
    if (before.circuitState !== "closed") unavailable();
    let limit = requestedLimit;
    let archivedManifest: ArchiveManifest | null = null;
    if (afterSequence < before.sealedThrough) {
      const manifests = await this.options.archive.listManifests(afterSequence, before.sealedThrough, 1);
      archivedManifest = manifests[0] ?? null;
      if (archivedManifest === null || archivedManifest.startSequence > afterSequence + 1
        || archivedManifest.endSequence <= afterSequence) corrupt();
      limit = Math.min(limit, archivedManifest.endSequence - afterSequence);
    }
    const rawEvents = await this.options.events.readRange(afterSequence, limit);
    if (rawEvents.length === 0) corrupt();
    const after = await this.options.archive.readState();
    if (after.circuitState !== "closed" || after.sealedThrough !== before.sealedThrough) unavailable();
    const firstSequence = rawEvents[0]!.eventSequence;
    let endSequence = afterSequence;
    let textBytes = 0;
    const decoded: HistoryEvent[] = [];
    for (let index = 0; index < rawEvents.length; index += 1) {
      const raw = rawEvents[index]!;
      if (raw.eventSequence !== afterSequence + index + 1) corrupt();
      const event = await historyEvent(raw, principalId);
      const nextBytes = textBytes + (event?.textBytes ?? 0);
      if (endSequence > afterSequence && nextBytes > maxTextBytes) break;
      if (nextBytes > maxTextBytes) corrupt();
      endSequence = raw.eventSequence;
      textBytes = nextBytes;
      if (event !== null) decoded.push(event);
    }
    if (endSequence === afterSequence) corrupt();
    const suppressions = await this.readSuppressions(principalId, firstSequence, endSequence);
    const timestamp = nowTimestamp(this.options.now, changedAt ?? updatedAtFloor);
    const statements: D1PreparedStatement[] = [];
    let chunksWritten = 0;
    for (const event of decoded) {
      if (event.eventSequence > endSequence) continue;
      const receipt = await this.sourceReceipt(event.eventSequence, before, archivedManifest);
      statements.push(this.options.database.prepare(`DELETE FROM memory_history_chunks
        WHERE principal_id = ? AND start_event_sequence = ? AND end_event_sequence = ?`)
        .bind(principalId, event.eventSequence, event.eventSequence));
      statements.push(this.options.database.prepare(`INSERT INTO memory_history_coverage (
        coverage_id, principal_id, source_location, start_event_sequence,
        end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
        failure_code, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'indexed', ?, NULL, ?)`)
        .bind(
          this.options.nextId(),
          principalId,
          receipt.sourceLocation,
          event.eventSequence,
          event.eventSequence,
          receipt.r2SegmentId,
          event.envelopeHash,
          timestamp,
        ));
      if (!this.isSuppressed(event, suppressions)) {
        statements.push(this.options.database.prepare(`INSERT INTO memory_history_chunks (
          chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
          content_hash, source_location, r2_segment_id, source_receipt_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            this.options.nextId(),
            principalId,
            event.eventSequence,
            event.eventSequence,
            event.text,
            await sha256Hex(event.text),
            receipt.sourceLocation,
            receipt.r2SegmentId,
            event.envelopeHash,
            timestamp,
            timestamp,
          ));
        chunksWritten += 1;
      }
    }
    if (!refresh) {
      const cursor = await this.readCursor(principalId);
      if (cursor.sequence !== afterSequence) unavailable();
      statements.push(cursor.updatedAt === null
        ? this.options.database.prepare(`INSERT INTO memory_cursors (
          principal_id, cursor_name, current_event_sequence, updated_at
        ) VALUES (?, 'fts_history', ?, ?)`).bind(principalId, endSequence, timestamp)
        : this.options.database.prepare(`UPDATE memory_cursors
          SET current_event_sequence = ?, updated_at = ?
          WHERE principal_id = ? AND cursor_name = 'fts_history'
            AND current_event_sequence = ?`)
          .bind(endSequence, timestamp, principalId, afterSequence));
    }
    if (statements.length > 0) await this.options.database.batch(statements);
    return Object.freeze({
      startEventSequence: firstSequence,
      endEventSequence: endSequence,
      eventsExamined: endSequence - afterSequence,
      chunksWritten,
    });
  }

  private async sourceReceipt(
    eventSequence: number,
    state: ArchiveState,
    knownManifest: ArchiveManifest | null,
  ): Promise<SourceReceipt> {
    if (eventSequence > state.sealedThrough) {
      return Object.freeze({ sourceLocation: "live", r2SegmentId: null });
    }
    let manifest = knownManifest;
    if (manifest === null || eventSequence < manifest.startSequence || eventSequence > manifest.endSequence) {
      const manifests = await this.options.archive.listManifests(eventSequence - 1, eventSequence, 1);
      manifest = manifests[0] ?? null;
    }
    if (manifest === null || eventSequence < manifest.startSequence || eventSequence > manifest.endSequence) corrupt();
    if (!SHA256.test(manifest.compressedSha256)) corrupt();
    return Object.freeze({
      sourceLocation: "archived",
      r2SegmentId: manifest.compressedSha256 as Sha256Hex,
    });
  }

  private async readSuppressions(
    principalId: string,
    startSequence: number,
    endSequence: number,
  ): Promise<readonly SuppressionRow[]> {
    const rows = await this.options.database.prepare(`SELECT suppression.target_event_id,
        suppression.start_event_sequence, suppression.end_event_sequence
      FROM memory_active_event_suppressions suppression
      WHERE suppression.principal_id = ? AND (
        suppression.start_event_sequence <= ? AND suppression.end_event_sequence >= ?
        OR suppression.target_event_id IN (
          SELECT event_id FROM events WHERE sequence BETWEEN ? AND ?
          UNION ALL
          SELECT event_id FROM archive_segment_events WHERE event_sequence BETWEEN ? AND ?
        )
      )`).bind(
      principalId,
      endSequence,
      startSequence,
      startSequence,
      endSequence,
      startSequence,
      endSequence,
    ).all<SuppressionRow>();
    for (const row of rows.results) exactRow(row, SUPPRESSION_FIELDS);
    return Object.freeze(rows.results);
  }

  private isSuppressed(event: HistoryEvent, suppressions: readonly SuppressionRow[]): boolean {
    return suppressions.some((row) => {
      const target = row.target_event_id;
      const start = row.start_event_sequence;
      const end = row.end_event_sequence;
      if (target !== null && (typeof target !== "string" || !ULID.test(target))) corrupt();
      if (start !== null && end !== null) {
        const first = rowInteger(start, 1, Number.MAX_SAFE_INTEGER);
        const last = rowInteger(end, first, Number.MAX_SAFE_INTEGER);
        if (event.eventSequence >= first && event.eventSequence <= last) return true;
      } else if (start !== null || end !== null) {
        corrupt();
      }
      return target === event.eventId;
    });
  }

  private async coverageStatus(principalId: string): Promise<{
    searchedThrough: number;
    missingRange: MissingHistoryRange | null;
  }> {
    const latest = await this.options.events.latestSequence();
    if (!Number.isSafeInteger(latest) || latest < 0) corrupt();
    const cursor = await this.readCursor(principalId);
    if (cursor.sequence > latest) corrupt();
    if (cursor.sequence < latest) {
      return {
        searchedThrough: cursor.sequence,
        missingRange: Object.freeze({
          startEventSequence: cursor.sequence + 1,
          endEventSequence: latest,
        }),
      };
    }
    const maintenance = await this.readMaintenance(principalId);
    if (maintenance !== null) {
      return {
        searchedThrough: latest,
        missingRange: Object.freeze({
          startEventSequence: maintenance.eventSequence,
          endEventSequence: maintenance.eventSequence,
        }),
      };
    }
    return { searchedThrough: latest, missingRange: null };
  }

  private async readHistoryEvent(principalId: string, eventSequence: number): Promise<HistoryEvent | null> {
    const events = await this.options.events.readRange(eventSequence - 1, 1);
    const event = events[0];
    if (events.length !== 1 || event === undefined || event.eventSequence !== eventSequence) corrupt();
    return historyEvent(event, principalId);
  }

  private async readProvenance(
    principalId: string,
    event: HistoryEvent,
  ): Promise<SourceReceipt | null> {
    const row = await this.options.database.prepare(`SELECT archived.segment_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM memory_active_event_suppressions suppression
          WHERE suppression.principal_id = ? AND (
            suppression.target_event_id = ?
            OR ? BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
          )
        ) THEN 1 ELSE 0 END AS suppressed
      FROM (SELECT 1 AS singleton) one
      LEFT JOIN archive_segment_events archived
        ON archived.event_sequence = ? AND archived.event_id = ?`)
      .bind(
        principalId,
        event.eventId,
        event.eventSequence,
        event.eventSequence,
        event.eventId,
      ).first<ProvenanceRow>();
    if (row === null) corrupt();
    exactRow(row, PROVENANCE_FIELDS);
    if (rowInteger(row.suppressed, 0, 1) === 1) return null;
    if (row.segment_id === null) return Object.freeze({ sourceLocation: "live", r2SegmentId: null });
    return Object.freeze({ sourceLocation: "archived", r2SegmentId: rowHash(row.segment_id) });
  }

  private async hit(
    event: HistoryEvent,
    provenance: SourceReceipt,
    span: MatchSpan,
  ): Promise<LiteralHistoryHit> {
    const excerpt = exactExcerpt(event.text, span);
    return Object.freeze({
      eventId: event.eventId,
      eventSequence: event.eventSequence,
      occurredAt: event.occurredAt,
      channel: event.channel,
      sourceLocation: provenance.sourceLocation,
      r2SegmentId: provenance.r2SegmentId,
      excerpt,
      excerptHash: await sha256Hex(excerpt),
    });
  }

  private async chunkCount(principalId: string, eventSequence: number): Promise<number> {
    const row = await this.options.database.prepare(`SELECT count(*) AS count
      FROM memory_history_chunks
      WHERE principal_id = ? AND start_event_sequence = ? AND end_event_sequence = ?`)
      .bind(principalId, eventSequence, eventSequence).first<{ count: unknown }>();
    if (row === null) corrupt();
    exactRow(row, new Set(["count"]));
    return rowInteger(row.count, 0, 1);
  }

  private async readJobByKey(principalId: string, jobKey: string): Promise<ExhaustiveSearchJob | null> {
    const row = await this.options.database.prepare(`SELECT job_id, principal_id, job_key, attempt,
        query_text, query_hash, snapshot_event_sequence, checkpoint_event_sequence,
        scanned_event_count, matched_event_count, status, failure_code,
        created_at, updated_at, completed_at
      FROM memory_literal_search_jobs WHERE principal_id = ? AND job_key = ?
      ORDER BY attempt DESC LIMIT 1`)
      .bind(principalId, jobKey).first<JobRow>();
    return row === null ? null : this.job(row, principalId);
  }

  private async requireJob(principalId: string, jobId: Ulid): Promise<ExhaustiveSearchJob> {
    const row = await this.options.database.prepare(`SELECT job_id, principal_id, job_key, attempt,
        query_text, query_hash, snapshot_event_sequence, checkpoint_event_sequence,
        scanned_event_count, matched_event_count, status, failure_code,
        created_at, updated_at, completed_at
      FROM memory_literal_search_jobs WHERE principal_id = ? AND job_id = ?`)
      .bind(principalId, jobId).first<JobRow>();
    if (row === null) throw new LiteralHistoryError("memory_history_not_found");
    return this.job(row, principalId);
  }

  private async job(row: JobRow, principalId: string): Promise<ExhaustiveSearchJob> {
    exactRow(row, JOB_FIELDS);
    const jobId = rowUlid(row.job_id);
    if (row.principal_id !== principalId) corrupt();
    const jobKey = rowText(row.job_key, 128);
    const attempt = rowInteger(row.attempt, 1, Number.MAX_SAFE_INTEGER);
    const query = rowText(row.query_text, MAX_QUERY_BYTES);
    if (rowHash(row.query_hash) !== await sha256Hex(query)) corrupt();
    const snapshotEventSequence = rowInteger(row.snapshot_event_sequence, 0, Number.MAX_SAFE_INTEGER);
    const checkpointEventSequence = rowInteger(
      row.checkpoint_event_sequence,
      0,
      snapshotEventSequence,
    );
    const scannedEventCount = rowInteger(row.scanned_event_count, 0, Number.MAX_SAFE_INTEGER);
    const matchedEventCount = rowInteger(row.matched_event_count, 0, scannedEventCount);
    if (row.status !== "pending" && row.status !== "running"
      && row.status !== "succeeded" && row.status !== "failed") corrupt();
    if (row.status === "failed") {
      rowText(row.failure_code, 128);
    } else if (row.failure_code !== null) {
      corrupt();
    }
    const createdAt = rowTimestamp(row.created_at);
    const updatedAt = rowTimestamp(row.updated_at);
    const completedAt = optionalTimestamp(row.completed_at);
    if (updatedAt < createdAt
      || (row.status === "pending" || row.status === "running") && completedAt !== null
      || (row.status === "succeeded" || row.status === "failed") && completedAt === null
      || row.status === "succeeded" && checkpointEventSequence !== snapshotEventSequence) corrupt();
    return Object.freeze({
      jobId,
      principalId,
      jobKey,
      attempt,
      query,
      snapshotEventSequence,
      checkpointEventSequence,
      scannedEventCount,
      matchedEventCount,
      status: row.status,
      createdAt,
      updatedAt,
      completedAt,
    });
  }

}

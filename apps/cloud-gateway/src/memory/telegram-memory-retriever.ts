import {
  newUlid,
  sha256Hex,
  validateEnvelope,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../archive/archive-repository.js";
import { ArchivalService, type ArchiveBucket } from "../archive/archival-service.js";
import { TieredEventReader } from "../archive/tiered-event-reader.js";
import type {
  ContextRetriever,
  ContextRetrieverInput,
  RetrievedContext,
} from "../conversation/conversation-types.js";
import { D1ContextRetriever } from "../conversation/context-retriever.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "../conversation/conversation-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import {
  LITERAL_HISTORY_SEARCH_LIMITS,
  LiteralHistoryError,
  LiteralHistoryService,
  type LiteralHistoryHit,
  type LiteralHistorySearchResult,
} from "./literal-history.js";
import {
  MEMORY_MEANING_BINDING_MISSING_CODE,
  type MeaningSearchHit,
  type MeaningSearchReader,
} from "./meaning-search.js";
import { MemoryRepository } from "./memory-repository.js";
import {
  D1MemoryControlTargetFinder,
  type TelegramMemoryTargetFinder,
  type TelegramMemoryTargetOperation,
} from "./memory-control-targets.js";
import {
  MemoryRepositoryError,
  type CanonicalMemoryItem,
  type MemoryLifecycleState,
} from "./memory-types.js";
import {
  parseTelegramMemoryAreaQuestion,
  parseTelegramMemoryControl,
} from "./telegram-memory-language.js";
import { CANDIDATE_SUPPRESSION_CLAUSES, NOTE_SOURCE_SUPPRESSION_CLAUSES } from "./suppression-clauses.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_QUERY_BYTES = 65_536;
const MAX_QUERY_CHARACTERS = 8_000;
const MAX_FTS_TERMS = 16;
const MAX_FTS_TERM_BYTES = 128;
const MAX_MEMORY_CANDIDATES = 3;
const MAX_LIVING_TOPIC_NOTES = 2;
const MAX_HISTORY_RESULTS = 4;
const MAX_CONTROL_TARGETS = 2;
const MAX_REFERENCED_ITEMS = 8;
const MAX_FORGOTTEN_ITEMS = 128;
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 800;
const DEFAULT_BASE_RETRIEVAL_TIMEOUT_MS = 2_500;
const DEFAULT_HISTORY_SEARCH_TIMEOUT_MS = 450;
const DEFAULT_MEANING_SEARCH_TIMEOUT_MS = 450;
const DEFAULT_CANDIDATE_SEARCH_TIMEOUT_MS = 450;
const MEANING_CANONICAL_READ_TIMEOUT_MS = 180;
const MAX_RETRIEVAL_TIMEOUT_MS = 5_000;
const MAX_BASE_RETRIEVAL_TIMEOUT_MS = 10_000;
const MAX_OPTIONAL_SEARCH_TIMEOUT_MS = 450;
const MAX_MEANING_RESULTS = 4;
const MAX_MEANING_D1_STATEMENTS = 96;
const MAX_HISTORY_D1_STATEMENTS = LITERAL_HISTORY_SEARCH_LIMITS.d1Statements;
const RRF_RANK_CONSTANT = 60;
const MIN_RECENT_EVIDENCE_CHARACTERS = 24;
const RETRIEVAL_FALLBACK_CODE = "telegram_memory_retrieval_fallback";
const RETRIEVAL_MEMORY_TIMEOUT_CODE = "telegram_memory_retrieval_memory_timeout";
const RETRIEVAL_BASE_TIMEOUT_CODE = "telegram_memory_retrieval_base_timeout";
const RETRIEVAL_BASE_ERROR_CODE = "telegram_memory_retrieval_base_error";
const RETRIEVAL_HISTORY_FALLBACK_CODE = "telegram_memory_retrieval_history_fallback";
const MEANING_TIMEOUT_CODE = "memory_meaning_search_timeout";
const MEANING_PROVIDER_ERROR_CODE = "memory_meaning_search_provider_error";
const ASSISTANT_STAGE_EVENT_TYPE = "conversation.assistant_staged";
const ASSISTANT_DELIVERED_EVENT_TYPE = "conversation.assistant_delivered";
const HISTORY_PAYLOAD_FIELDS = new Set([
  "schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text",
]);
const HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS = new Set([
  ...HISTORY_PAYLOAD_FIELDS,
  "directOwnerText",
]);
const ASSISTANT_STAGE_PAYLOAD_WITH_REFERENCES_FIELDS = new Set([
  ...HISTORY_PAYLOAD_FIELDS,
  "memoryItemIds",
]);
const CONTROL_STOPWORDS = new Set([
  "a", "about", "again", "an", "and", "could", "do", "forget", "i", "it", "me",
  "memory", "my", "please", "remember", "that", "the", "think", "this", "use", "why",
  "would", "you",
]);
const RECALL_STOPWORDS = new Set([
  ...CONTROL_STOPWORDS,
  "am", "are", "as", "at", "be", "been", "being", "by", "can", "did", "does",
  "for", "from", "had", "has", "have", "he", "hello", "her", "hers", "hey", "hi",
  "him", "his", "how", "if", "in", "into", "is", "its", "jarvis", "of", "on", "or",
  "our", "ours", "s", "say", "she", "so", "tell", "than", "their", "theirs", "them", "they", "to",
  "us", "was", "we", "were", "what", "when", "where", "which", "who", "whom", "will",
  "with", "your", "yours",
]);
const MEANING_ACKNOWLEDGEMENT_TERMS = new Set([
  "cool", "good", "got", "haha", "hey", "hi", "lol", "morning", "nice", "night",
  "no", "ok", "okay", "perfect", "sounds", "sure", "thank", "thanks", "thx", "ty",
  "up", "yeah", "yep", "yes",
]);
const encoder = new TextEncoder();

/**
 * Worst case: a topic alias/path walk (257), three canonical item reads with
 * eight archived sources and maximal redirect/path walks (3 * 168), the
 * literal-history ceiling (62), and candidate/visibility reads. The enforced
 * ceiling stays below the Worker D1 subrequest limit.
 */
export const TELEGRAM_MEMORY_RETRIEVAL_LIMITS = Object.freeze({
  d1Statements: 900,
  liveBaseD1RoundTrips: 2,
  liveMemoryD1RoundTrips: 10,
  liveTotalD1RoundTrips: 12,
  memoryItemsExamined: MAX_MEMORY_CANDIDATES,
  historyResultsExamined: LITERAL_HISTORY_SEARCH_LIMITS.resultsExamined,
  historyD1Statements: MAX_HISTORY_D1_STATEMENTS,
  meaningD1Statements: MAX_MEANING_D1_STATEMENTS,
});

export const TELEGRAM_MEMORY_CONTROL_TARGET_LIMITS = Object.freeze({
  d1Statements: 384,
  candidatesExamined: MAX_CONTROL_TARGETS,
});

export type {
  MemoryTargetOperation,
  TelegramMemoryTargetFinder,
  TelegramMemoryTargetOperation,
} from "./memory-control-targets.js";

export interface TelegramMemoryRetrieverOptions {
  readonly database: D1Database;
  readonly archive: ArchiveBucket;
  readonly now?: () => Date;
  readonly nextId?: () => Ulid;
  readonly controlAuthority?: Readonly<{ principalId: string; text: string }> | null;
  readonly baseContext?: ContextRetriever;
  readonly retrievalTimeoutMs?: number;
  readonly baseRetrievalTimeoutMs?: number;
  readonly historySearchTimeoutMs?: number;
  readonly candidateSearchTimeoutMs?: number;
  readonly meaningSearch?: MeaningSearchReader;
  readonly meaningSearchTimeoutMs?: number;
  readonly observeMeaningSearch?: (observation: TelegramMeaningSearchObservation) => void;
  readonly log?: (
    code: TelegramMemoryRetrievalLogCode,
    timings: TelegramMemoryRetrievalTimings,
  ) => void;
  readonly observeRetrieval?: (metrics: TelegramMemoryRetrievalMetrics) => void;
}

export type TelegramMeaningSearchFallbackCode =
  | typeof MEMORY_MEANING_BINDING_MISSING_CODE
  | typeof MEANING_TIMEOUT_CODE
  | typeof MEANING_PROVIDER_ERROR_CODE;

export interface TelegramMeaningSearchObservation {
  readonly meaningSearchMs: number;
  readonly fallbackCode: TelegramMeaningSearchFallbackCode | null;
}

export type TelegramMemoryRetrievalLogCode =
  | typeof RETRIEVAL_FALLBACK_CODE
  | typeof RETRIEVAL_MEMORY_TIMEOUT_CODE
  | typeof RETRIEVAL_BASE_TIMEOUT_CODE
  | typeof RETRIEVAL_BASE_ERROR_CODE
  | typeof RETRIEVAL_HISTORY_FALLBACK_CODE;

export interface TelegramMemoryRetrievalMetrics {
  readonly candidatesMs: number;
  readonly historyMs: number;
  readonly mergeMs: number;
  readonly d1RoundTrips: number;
}

export interface TelegramMemoryRetrievalTimings extends TelegramMemoryRetrievalMetrics {
  readonly baseMs: number;
  readonly memoryMs: number;
}

interface CandidateRow {
  readonly item_id: unknown;
  readonly version_id: unknown;
  readonly relevance: unknown;
}

interface RetrievalDependencies {
  readonly database: D1Database;
  readonly archiveState: ArchiveRepository;
  readonly memory: MemoryRepository;
  readonly history: LiteralHistoryService;
  readonly events: TieredEventReader;
}

interface MemoryRetrievalResult {
  readonly profileContext: RetrievedContext | null;
  readonly noteContexts: readonly RankedMemoryContext[];
  readonly candidateContexts: readonly RankedMemoryContext[];
  readonly history: LiteralHistorySearchResult | null;
  readonly historyFailure: string | null;
  readonly meaningContexts: readonly RankedMemoryContext[];
}

interface CandidateRecall {
  readonly profileContext: RetrievedContext | null;
  readonly noteContexts: readonly RankedMemoryContext[];
  readonly itemContexts: readonly RankedMemoryContext[];
}

interface LivingNoteRow {
  readonly note_kind: unknown;
  readonly note_version_id: unknown;
  readonly markdown: unknown;
  readonly restricted: unknown;
  readonly created_at: unknown;
}

/**
 * Recall order, not a gate. 0 is evidence the owner stated or confirmed; 1 is
 * an uncertain proposal. A proposal is still returned, because an unrecallable
 * proposal is a memory the owner can never confirm, but it never displaces a
 * stated fact just because it matched the words better.
 */
const ASSERTED_RECALL_TIER = 0;
const UNCERTAIN_RECALL_TIER = 1;

interface RankedMemoryContext {
  readonly key: string;
  readonly context: RetrievedContext;
  readonly dedupText: string;
  readonly tier: number;
}

function recallTier(lifecycleState: MemoryLifecycleState): number {
  return lifecycleState === "active" ? ASSERTED_RECALL_TIER : UNCERTAIN_RECALL_TIER;
}

interface MeaningCanonicalRow {
  readonly ordinal: unknown;
  readonly item_kind: unknown;
  readonly requested_item_id: unknown;
  readonly requested_content_hash: unknown;
  readonly item_id: unknown;
  readonly chunk_id: unknown;
  readonly chunk_text: unknown;
  readonly chunk_content_hash: unknown;
  readonly event_sequence: unknown;
  readonly event_id: unknown;
  readonly source_location: unknown;
  readonly event_envelope_json: unknown;
  readonly event_content_hash: unknown;
}

class StatementBudget {
  used = 0;
  private aborted = false;

  constructor(readonly maximum: number) {}

  take(): void {
    if (this.aborted) throw new RangeError("telegram_memory_retrieval_aborted");
    this.used += 1;
    if (this.used > this.maximum) throw new RangeError("telegram_memory_d1_budget_exceeded");
  }

  abort(): void {
    this.aborted = true;
  }
}

class RoundTripCounter {
  used = 0;

  take(): void {
    this.used += 1;
  }
}

type MemoryStage = "candidates" | "history" | "merge";

class MemoryStageTimings {
  private readonly startedAt = new Map<MemoryStage, number>();
  private readonly completedMs = new Map<MemoryStage, number>();

  async measure<T>(stage: MemoryStage, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    this.startedAt.set(stage, startedAt);
    try {
      return await operation();
    } finally {
      this.completedMs.set(stage, elapsedMilliseconds(startedAt));
    }
  }

  start(stage: MemoryStage): () => void {
    const startedAt = performance.now();
    this.startedAt.set(stage, startedAt);
    return () => this.completedMs.set(stage, elapsedMilliseconds(startedAt));
  }

  snapshot(d1RoundTrips: number): TelegramMemoryRetrievalMetrics {
    const elapsed = (stage: MemoryStage): number => {
      const completed = this.completedMs.get(stage);
      if (completed !== undefined) return completed;
      const startedAt = this.startedAt.get(stage);
      return startedAt === undefined ? 0 : elapsedMilliseconds(startedAt);
    };
    return Object.freeze({
      candidatesMs: elapsed("candidates"),
      historyMs: elapsed("history"),
      mergeMs: elapsed("merge"),
      d1RoundTrips,
    });
  }
}

function roundTripDatabase(database: D1Database, counter: RoundTripCounter): D1Database {
  const statements = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement as object, {
      get(target, property): unknown {
        if (property === "bind") {
          return (...values: unknown[]) => wrap((target as D1PreparedStatement).bind(...values));
        }
        if (property === "first" || property === "all" || property === "run" || property === "raw") {
          return (...args: unknown[]) => {
            counter.take();
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => Promise<unknown>;
            return method.apply(target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
    statements.set(proxy as object, statement);
    return proxy;
  };
  return new Proxy(database as object, {
    get(target, property): unknown {
      if (property === "prepare") {
        return (query: string) => wrap(Reflect.apply((target as D1Database).prepare, target, [query]));
      }
      if (property === "batch") {
        return async (input: D1PreparedStatement[]) => {
          counter.take();
          const unwrapped = input.map((statement) => statements.get(statement as object) ?? statement);
          if (!("exec" in target)) {
            return Promise.all(unwrapped.map((statement) => statement.all()));
          }
          try {
            return await Reflect.apply((target as D1Database).batch, target, [unwrapped]);
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("Invalid input")) throw error;
            return Promise.all(unwrapped.map((statement) => statement.all()));
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function countedDatabase(database: D1Database, budget: StatementBudget): D1Database {
  return new Proxy(database as object, {
    get(target, property): unknown {
      if (property === "prepare") {
        return (query: string) => {
          budget.take();
          return Reflect.apply((target as D1Database).prepare, target, [query]);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function exactRow(value: object, fields: ReadonlySet<string>, error: string): void {
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) throw new TypeError(error);
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(error);
  exactRow(value, fields, error);
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    captured[field] = descriptor.value;
  }
  return captured;
}

function safeText(value: unknown, maximumBytes: number, error: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(error);
  }
  return value;
}

function conversationText(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  const fields = Object.hasOwn(value, "directOwnerText")
    ? HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS
    : HISTORY_PAYLOAD_FIELDS;
  const payload = exactRecord(value, fields, "telegram_memory_reference_invalid");
  if (payload.schemaCode !== 1 || payload.channelCode !== 2 || payload.sensitivityCode !== 1
    || payload.historyEligible !== true
    || Object.hasOwn(payload, "directOwnerText") && typeof payload.directOwnerText !== "boolean") {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  return safeText(payload.text, MAX_QUERY_BYTES, "telegram_memory_reference_invalid");
}

function safePrincipal(value: unknown): string {
  const principalId = safeText(value, 256, "telegram_memory_principal_invalid");
  if (/[\r\n]/u.test(principalId)) throw new TypeError("telegram_memory_principal_invalid");
  return principalId;
}

function safeUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError("telegram_memory_id_invalid");
  return value as Ulid;
}

function captureInput(value: unknown): Readonly<ContextRetrieverInput> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("telegram_memory_input_invalid");
  }
  exactRow(value, new Set(["principalId", "channel", "purpose", "query", "maxTokens"]), "telegram_memory_input_invalid");
  const input = value as Record<string, unknown>;
  const principalId = safePrincipal(input.principalId);
  const query = safeText(input.query, MAX_QUERY_BYTES, "telegram_memory_query_invalid");
  if (Array.from(query).length > MAX_QUERY_CHARACTERS || (input.channel !== "telegram" && input.channel !== "voice")
    || input.purpose !== "conversation" || !Number.isSafeInteger(input.maxTokens)
    || (input.maxTokens as number) < 1 || (input.maxTokens as number) > 32_000) {
    throw new TypeError("telegram_memory_input_invalid");
  }
  return Object.freeze({
    principalId,
    channel: input.channel,
    purpose: "conversation",
    query,
    maxTokens: input.maxTokens as number,
  });
}

function recallTerms(value: string): readonly Readonly<{ term: string; folded: string }>[] {
  const terms: Array<Readonly<{ term: string; folded: string }>> = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].normalize("NFC");
    const folded = term.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
    if (RECALL_STOPWORDS.has(folded) || encoder.encode(term).byteLength > MAX_FTS_TERM_BYTES
      || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(Object.freeze({ term, folded }));
    if (terms.length === MAX_FTS_TERMS) break;
  }
  return Object.freeze(terms);
}

function ftsQuery(value: string): string | null {
  const terms = recallTerms(value);
  return terms.length === 0 ? null : terms.map(({ term }) => `"${term}"`).join(" OR ");
}

interface SuppressionRow {
  readonly row_kind: unknown;
  readonly event_id: unknown;
  readonly event_type: unknown;
  readonly event_envelope_json: unknown;
  readonly turn_id: unknown;
  readonly user_event_id: unknown;
  readonly staged_event_id: unknown;
  readonly staged_envelope_json: unknown;
  readonly suppressed: unknown;
  readonly item_id: unknown;
  readonly text: unknown;
}




function literalHistoryQuery(value: string): string | null {
  const terms: string[] = [];
  for (const { term } of recallTerms(value)) {
    const candidate = [...terms, term].join(" ");
    if (encoder.encode(candidate).byteLength > 1_024) break;
    terms.push(term);
  }
  return terms.length <= 2 ? null : terms.join(" ");
}

function normalizedMeaningPhrase(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[’]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

function shouldSkipMeaningSearch(value: string): boolean {
  return recallTerms(value).every(({ folded }) => MEANING_ACKNOWLEDGEMENT_TERMS.has(folded));
}

function questionOnly(value: string): boolean {
  return value.trim().endsWith("?");
}

function sameText(left: string, right: string): boolean {
  return normalizedMeaningPhrase(left) === normalizedMeaningPhrase(right);
}

function recentContextCoversQuery(
  query: string,
  contexts: readonly RetrievedContext[],
): boolean {
  const required = recallTerms(query).map(({ folded }) => folded);
  if (required.length === 0) return true;
  return contexts.some((context) => {
    const available = new Set(recallTerms(context.text).map(({ folded }) => folded));
    return required.every((term) => available.has(term));
  });
}

function withoutCurrentTurn(
  query: string,
  contexts: readonly RetrievedContext[],
): readonly RetrievedContext[] {
  const current = contexts.at(-1);
  return current?.text !== query
    ? contexts
    : Object.freeze(contexts.filter((context) => context.sourceEventId !== current.sourceEventId));
}

function reciprocalRankFusion(
  keyword: readonly RankedMemoryContext[],
  meaning: readonly RankedMemoryContext[],
): readonly RankedMemoryContext[] {
  const ranked = new Map<string, {
    context: RetrievedContext;
    dedupText: string;
    score: number;
    firstRank: number;
    tier: number;
  }>();
  for (const list of [keyword, meaning]) {
    list.forEach((entry, index) => {
      const rank = index + 1;
      const existing = ranked.get(entry.key);
      if (existing === undefined) {
        ranked.set(entry.key, {
          context: entry.context,
          dedupText: entry.dedupText,
          score: 1 / (RRF_RANK_CONSTANT + rank),
          firstRank: rank,
          tier: entry.tier,
        });
      } else {
        existing.score += 1 / (RRF_RANK_CONSTANT + rank);
        existing.firstRank = Math.min(existing.firstRank, rank);
      }
    });
  }
  return Object.freeze([...ranked.entries()]
    .sort(([leftKey, left], [rightKey, right]) => left.tier - right.tier
      || right.score - left.score
      || left.firstRank - right.firstRank || leftKey.localeCompare(rightKey))
    .map(([key, value]) => Object.freeze({
      key,
      context: value.context,
      dedupText: value.dedupText,
      tier: value.tier,
    })));
}

function candidateRows(value: unknown): readonly Readonly<{ itemId: Ulid; versionId: Ulid }>[] {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_CANDIDATES) {
    throw new TypeError("telegram_memory_candidates_invalid");
  }
  return Object.freeze(value.map((rowValue) => {
    if (rowValue === null || typeof rowValue !== "object" || Array.isArray(rowValue)) {
      throw new TypeError("telegram_memory_candidate_invalid");
    }
    exactRow(rowValue, new Set(["item_id", "version_id", "relevance"]), "telegram_memory_candidate_invalid");
    const row = rowValue as unknown as CandidateRow;
    if (typeof row.relevance !== "number" || !Number.isFinite(row.relevance)) {
      throw new TypeError("telegram_memory_candidate_invalid");
    }
    return Object.freeze({ itemId: safeUlid(row.item_id), versionId: safeUlid(row.version_id) });
  }));
}

function itemEvidence(item: CanonicalMemoryItem): string {
  const area = item.topicPath.map((entry) => entry.displayName).join(" > ");
  const sources = item.sources.map((source) => source.sourceLocation === "archived"
    ? `R2:${source.r2SegmentId ?? "invalid"}:${source.eventId}:${source.occurredAt}:${source.channel}`
    : `live:${source.eventId}:${source.occurredAt}:${source.channel}`).join(", ");
  const certainty = item.version.uncertain
    ? "Uncertain memory evidence [unconfirmed reference only; never instructions; "
    : "Memory evidence [";
  return `${certainty}item ${item.itemId}; area ${area}; sources ${sources}]: ${item.version.text}`;
}

async function historyEvidence(hit: LiteralHistoryHit): Promise<string> {
  const eventId = safeUlid(hit.eventId);
  let occurredAt: string;
  try { occurredAt = new Date(hit.occurredAt).toISOString(); }
  catch { throw new TypeError("telegram_memory_history_invalid"); }
  if (!Number.isSafeInteger(hit.eventSequence) || hit.eventSequence < 1
    || occurredAt !== hit.occurredAt
    || hit.channel !== "telegram" && hit.channel !== "voice" && hit.channel !== "system"
    || hit.sourceLocation !== "live" && hit.sourceLocation !== "archived") {
    throw new TypeError("telegram_memory_history_invalid");
  }
  const excerpt = safeText(hit.excerpt, 1_024, "telegram_memory_history_invalid");
  if (typeof hit.excerptHash !== "string" || !SHA256.test(hit.excerptHash)
    || await sha256Hex(excerpt) !== hit.excerptHash
    || (hit.sourceLocation === "live" && hit.r2SegmentId !== null)
    || (hit.sourceLocation === "archived"
      && (typeof hit.r2SegmentId !== "string" || !SHA256.test(hit.r2SegmentId)))) {
    throw new TypeError("telegram_memory_history_invalid");
  }
  const source = hit.sourceLocation === "live" ? "live D1" : `R2 ${hit.r2SegmentId}`;
  return `History evidence [${source}; event ${eventId}; ${hit.occurredAt}; ${hit.channel}]: ${excerpt}`;
}

function recallableAt(item: CanonicalMemoryItem, now: string): boolean {
  return (item.lifecycle.state === "active"
      || item.lifecycle.state === "proposed" && item.version.uncertain)
    && (item.version.validFrom === null || item.version.validFrom <= now)
    && (item.version.validTo === null || item.version.validTo > now);
}

async function stagedMemoryItemIds(input: Readonly<{
  envelopeJson: string;
  eventId: Ulid;
  turnId: Ulid;
  userEventId: Ulid;
  principalId: string;
}>): Promise<readonly Ulid[]> {
  let decoded: unknown;
  try { decoded = JSON.parse(input.envelopeJson); }
  catch { throw new TypeError("telegram_memory_reference_invalid"); }
  const envelope = await validateEnvelope(decoded);
  if (envelope.eventId !== input.eventId || envelope.correlationId !== input.turnId
    || envelope.causationId !== input.userEventId || envelope.subjectId !== input.principalId
    || envelope.eventType !== ASSISTANT_STAGE_EVENT_TYPE
    || envelope.source !== CONVERSATION_EVENT_SOURCE
    || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  if (envelope.payload === null || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  const fields = Object.hasOwn(envelope.payload, "memoryItemIds")
    ? ASSISTANT_STAGE_PAYLOAD_WITH_REFERENCES_FIELDS
    : HISTORY_PAYLOAD_FIELDS;
  const payload = exactRecord(envelope.payload, fields, "telegram_memory_reference_invalid");
  if (payload.schemaCode !== 1 || payload.channelCode !== 2 || payload.sensitivityCode !== 1
    || payload.historyEligible !== false) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  safeText(payload.text, MAX_QUERY_BYTES, "telegram_memory_reference_invalid");
  if (!Object.hasOwn(payload, "memoryItemIds")) return Object.freeze([]);
  if (!Array.isArray(payload.memoryItemIds) || payload.memoryItemIds.length === 0
    || payload.memoryItemIds.length > MAX_REFERENCED_ITEMS) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  const itemIds = payload.memoryItemIds.map((itemId) => safeUlid(itemId));
  if (new Set(itemIds).size !== itemIds.length) throw new TypeError("telegram_memory_reference_invalid");
  return Object.freeze(itemIds);
}

async function deliveredAssistantText(input: Readonly<{
  envelopeJson: string;
  eventId: Ulid;
  stagedEventId: Ulid;
  turnId: Ulid;
  principalId: string;
}>): Promise<string> {
  let decoded: unknown;
  try { decoded = JSON.parse(input.envelopeJson); }
  catch { throw new TypeError("telegram_memory_reference_invalid"); }
  const envelope = await validateEnvelope(decoded);
  if (envelope.eventId !== input.eventId || envelope.correlationId !== input.turnId
    || envelope.causationId !== input.stagedEventId || envelope.subjectId !== input.principalId
    || envelope.eventType !== ASSISTANT_DELIVERED_EVENT_TYPE
    || envelope.source !== CONVERSATION_EVENT_SOURCE
    || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION) {
    throw new TypeError("telegram_memory_reference_invalid");
  }
  return conversationText(envelope.payload);
}

function citedMemoryItemIds(text: string): readonly Ulid[] {
  const itemIds: Ulid[] = [];
  for (const match of text.matchAll(/\bitem[ \t]+([0-7][0-9a-hjkmnp-tv-z]{25})\b/gu)) {
    const itemId = safeUlid(match[1]);
    if (!itemIds.includes(itemId)) itemIds.push(itemId);
    if (itemIds.length === MAX_REFERENCED_ITEMS) break;
  }
  return Object.freeze(itemIds);
}

export function restatesMemory(reply: string, memoryText: string): boolean {
  const required = recallTerms(memoryText).map(({ folded }) => folded);
  if (required.length === 0 || required.length === 1 && required[0]!.length < 5) return false;
  const available = new Set(recallTerms(reply).map(({ folded }) => folded));
  return required.every((term) => available.has(term));
}

class RetrievalTimeoutError extends Error {}

type TimedOutcome<T> =
  | Readonly<{ status: "fulfilled"; value: T; elapsedMs: number }>
  | Readonly<{ status: "timeout"; elapsedMs: number }>
  | Readonly<{ status: "error"; elapsedMs: number }>;

function elapsedMilliseconds(startedAt: number): number {
  const elapsed = performance.now() - startedAt;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
}

async function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void = () => undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new RetrievalTimeoutError("telegram_memory_retrieval_timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function timedOutcome<T>(
  operation: Promise<T>,
  timeoutMs: number,
  startedAt: number,
  onTimeout: () => void = () => undefined,
): Promise<TimedOutcome<T>> {
  try {
    return Object.freeze({
      status: "fulfilled",
      value: await withinTimeout(operation, timeoutMs, onTimeout),
      elapsedMs: elapsedMilliseconds(startedAt),
    });
  } catch (error) {
    return Object.freeze({
      status: error instanceof RetrievalTimeoutError ? "timeout" : "error",
      elapsedMs: elapsedMilliseconds(startedAt),
    });
  }
}

export class TelegramMemoryRetriever implements ContextRetriever, TelegramMemoryTargetFinder {
  private readonly now: () => Date;
  private readonly nextId: () => Ulid;
  private readonly controlAuthority: Readonly<{ principalId: string; text: string }> | null;
  private readonly baseContext: ContextRetriever | null;
  private readonly retrievalTimeoutMs: number;
  private readonly baseRetrievalTimeoutMs: number;
  private readonly historySearchTimeoutMs: number;
  private readonly candidateSearchTimeoutMs: number;
  private readonly meaningSearchTimeoutMs: number;
  private readonly log: (
    code: TelegramMemoryRetrievalLogCode,
    timings: TelegramMemoryRetrievalTimings,
  ) => void;
  private readonly observeRetrieval: (metrics: TelegramMemoryRetrievalMetrics) => void;
  private readonly controlTargets: D1MemoryControlTargetFinder;

  constructor(private readonly options: TelegramMemoryRetrieverOptions) {
    this.controlTargets = new D1MemoryControlTargetFinder({
      database: options.database,
      archive: options.archive,
    });
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? (() => newUlid(this.now()));
    this.baseContext = options.baseContext ?? null;
    this.retrievalTimeoutMs = options.retrievalTimeoutMs ?? DEFAULT_RETRIEVAL_TIMEOUT_MS;
    this.baseRetrievalTimeoutMs = options.baseRetrievalTimeoutMs ?? DEFAULT_BASE_RETRIEVAL_TIMEOUT_MS;
    this.historySearchTimeoutMs = options.historySearchTimeoutMs ?? DEFAULT_HISTORY_SEARCH_TIMEOUT_MS;
    this.candidateSearchTimeoutMs = options.candidateSearchTimeoutMs ?? DEFAULT_CANDIDATE_SEARCH_TIMEOUT_MS;
    this.meaningSearchTimeoutMs = options.meaningSearchTimeoutMs ?? DEFAULT_MEANING_SEARCH_TIMEOUT_MS;
    this.log = options.log ?? ((code, timings) => console.warn(code, timings));
    this.observeRetrieval = options.observeRetrieval ?? (() => undefined);
    if (!Number.isSafeInteger(this.retrievalTimeoutMs) || this.retrievalTimeoutMs < 1
      || this.retrievalTimeoutMs > MAX_RETRIEVAL_TIMEOUT_MS) {
      throw new TypeError("telegram_memory_timeout_invalid");
    }
    if (!Number.isSafeInteger(this.baseRetrievalTimeoutMs) || this.baseRetrievalTimeoutMs < 1
      || this.baseRetrievalTimeoutMs > MAX_BASE_RETRIEVAL_TIMEOUT_MS) {
      throw new TypeError("telegram_memory_base_timeout_invalid");
    }
    if (!Number.isSafeInteger(this.historySearchTimeoutMs) || this.historySearchTimeoutMs < 1
      || this.historySearchTimeoutMs > MAX_OPTIONAL_SEARCH_TIMEOUT_MS) {
      throw new TypeError("telegram_memory_history_timeout_invalid");
    }
    if (!Number.isSafeInteger(this.candidateSearchTimeoutMs) || this.candidateSearchTimeoutMs < 1
      || this.candidateSearchTimeoutMs > MAX_OPTIONAL_SEARCH_TIMEOUT_MS) {
      throw new TypeError("telegram_memory_candidate_timeout_invalid");
    }
    if (!Number.isSafeInteger(this.meaningSearchTimeoutMs) || this.meaningSearchTimeoutMs < 1
      || this.meaningSearchTimeoutMs > MAX_OPTIONAL_SEARCH_TIMEOUT_MS) {
      throw new TypeError("telegram_memory_meaning_timeout_invalid");
    }
    const authority = options.controlAuthority ?? null;
    this.controlAuthority = authority === null ? null : Object.freeze({
      principalId: safePrincipal(authority.principalId),
      text: safeText(authority.text, MAX_QUERY_BYTES, "telegram_memory_query_invalid"),
    });
  }

  async retrieve(input: ContextRetrieverInput): Promise<readonly RetrievedContext[]> {
    const captured = captureInput(input);
    // The owner-control adapter consumes these before a provider call. Avoid
    // retrieving memory into a request that must never reach that provider.
    if (parseTelegramMemoryControl(captured.query) !== null
      && this.controlAuthority?.principalId === captured.principalId
      && this.controlAuthority.text === captured.query) return Object.freeze([]);

    const memoryLimit = Math.max(1, Math.floor(captured.maxTokens / 4));
    const baseLimit = Math.max(1, captured.maxTokens - memoryLimit);
    const memoryInput = Object.freeze({
      ...captured,
      maxTokens: memoryLimit,
    });
    const baseInput = Object.freeze({ ...captured, maxTokens: baseLimit });
    const memoryBudget = new StatementBudget(TELEGRAM_MEMORY_RETRIEVAL_LIMITS.d1Statements);
    const candidateBudget = new StatementBudget(TELEGRAM_MEMORY_RETRIEVAL_LIMITS.d1Statements);
    const historyBudget = new StatementBudget(MAX_HISTORY_D1_STATEMENTS);
    const meaningBudget = new StatementBudget(MAX_MEANING_D1_STATEMENTS);
    const baseBudget = new StatementBudget(TELEGRAM_MEMORY_RETRIEVAL_LIMITS.d1Statements);
    const roundTrips = new RoundTripCounter();
    const database = roundTripDatabase(this.options.database, roundTrips);
    const candidateDependencies = this.dependencies(
      memoryBudget,
      countedDatabase(database, candidateBudget),
    );
    const historyDependencies = this.dependencies(
      memoryBudget,
      countedDatabase(database, historyBudget),
    );
    const meaningDependencies = this.dependencies(
      memoryBudget,
      countedDatabase(database, meaningBudget),
    );
    const baseDatabase = countedDatabase(database, baseBudget);
    const baseContext = this.baseContext ?? new D1ContextRetriever(baseDatabase);
    const stages = new MemoryStageTimings();
    const baseStartedAt = performance.now();
    const basePromise = this.retrieveBase(baseContext, baseDatabase, baseInput, true).catch((error: unknown) => {
      baseBudget.abort();
      throw error;
    });
    const baseOutcomePromise = timedOutcome(
      basePromise,
      this.baseRetrievalTimeoutMs,
      baseStartedAt,
      () => baseBudget.abort(),
    );
    const memoryStartedAt = performance.now();
    const memoryPromise = this.retrieveMemory(
      candidateDependencies,
      historyDependencies,
      meaningDependencies,
      memoryInput,
      this.timestamp(),
      stages,
      candidateBudget,
      historyBudget,
      meaningBudget,
    ).catch((error: unknown) => {
      memoryBudget.abort();
      candidateBudget.abort();
      historyBudget.abort();
      meaningBudget.abort();
      throw error;
    });
    const memoryOutcomePromise = timedOutcome(
      memoryPromise,
      this.retrievalTimeoutMs,
      memoryStartedAt,
      () => {
        memoryBudget.abort();
        candidateBudget.abort();
        historyBudget.abort();
        meaningBudget.abort();
      },
    );
    const [baseOutcome, memoryOutcome] = await Promise.all([
      baseOutcomePromise,
      memoryOutcomePromise,
    ]);
    if (baseOutcome.status !== "fulfilled") {
      const metrics = stages.snapshot(roundTrips.used);
      try { this.observeRetrieval(metrics); }
      catch { /* Retrieval telemetry must not change the model context or fallback. */ }
      this.log(
        baseOutcome.status === "timeout" ? RETRIEVAL_BASE_TIMEOUT_CODE : RETRIEVAL_BASE_ERROR_CODE,
        Object.freeze({
          baseMs: baseOutcome.elapsedMs,
          memoryMs: memoryOutcome.elapsedMs,
          ...metrics,
        }),
      );
      return Object.freeze([]);
    }
    if (memoryOutcome.status !== "fulfilled") {
      const metrics = stages.snapshot(roundTrips.used);
      try { this.observeRetrieval(metrics); }
      catch { /* Retrieval telemetry must not change the model context or fallback. */ }
      this.log(
        memoryOutcome.status === "timeout" ? RETRIEVAL_MEMORY_TIMEOUT_CODE : RETRIEVAL_FALLBACK_CODE,
        Object.freeze({
          baseMs: baseOutcome.elapsedMs,
          memoryMs: memoryOutcome.elapsedMs,
          ...metrics,
        }),
      );
      return baseOutcome.value;
    }
    let memoryContexts: readonly RetrievedContext[];
    try {
      memoryContexts = await this.mergeMemory(
        memoryOutcome.value,
        baseOutcome.value,
        memoryInput,
        stages,
      );
    } catch {
      const metrics = stages.snapshot(roundTrips.used);
      try { this.observeRetrieval(metrics); }
      catch { /* Retrieval telemetry must not change the model context or fallback. */ }
      this.log(RETRIEVAL_FALLBACK_CODE, Object.freeze({
        baseMs: baseOutcome.elapsedMs,
        memoryMs: memoryOutcome.elapsedMs,
        ...metrics,
      }));
      return baseOutcome.value;
    }
    const metrics = stages.snapshot(roundTrips.used);
    const timings = Object.freeze({
      baseMs: baseOutcome.elapsedMs,
      memoryMs: memoryOutcome.elapsedMs,
      ...metrics,
    });
    try { this.observeRetrieval(metrics); }
    catch { /* Retrieval telemetry must not change the model context or fallback. */ }
    if (memoryOutcome.value.historyFailure !== null) {
      this.log(RETRIEVAL_HISTORY_FALLBACK_CODE, timings);
    }
    const seen = new Set(memoryContexts.map(
      (context) => `${context.sourceEventId}\u0000${context.text}`,
    ));
    return Object.freeze([
      ...memoryContexts,
      ...baseOutcome.value.filter((context) => {
        const key = `${context.sourceEventId}\u0000${context.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ]);
  }

  private async retrieveMemory(
    candidateDependencies: RetrievalDependencies,
    historyDependencies: RetrievalDependencies,
    meaningDependencies: RetrievalDependencies,
    captured: Readonly<ContextRetrieverInput>,
    timestamp: string,
    stages: MemoryStageTimings,
    candidateBudget: StatementBudget,
    historyBudget: StatementBudget,
    meaningBudget: StatementBudget,
  ): Promise<MemoryRetrievalResult> {
    const candidateContextsPromise = timedOutcome(
      stages.measure("candidates", () => this.readCandidateContexts(
        candidateDependencies, captured, timestamp,
      )),
      this.candidateSearchTimeoutMs,
      performance.now(),
      () => candidateBudget.abort(),
    );
    const literalQuery = literalHistoryQuery(captured.query);
    const historyPromise = literalQuery === null
      ? Promise.resolve(Object.freeze({ result: null, failure: null }))
      : timedOutcome(stages.measure("history", async () => {
        const state = await historyDependencies.archiveState.readState();
        if (state.circuitState !== "closed") return null;
        return historyDependencies.history.searchLiteral({
          principalId: captured.principalId,
          query: literalQuery,
          maxResults: LITERAL_HISTORY_SEARCH_LIMITS.resultsExamined,
        });
      }).then((result) => Object.freeze({ result, failure: null })).catch((error: unknown) => Object.freeze({
        result: null,
        failure: error instanceof LiteralHistoryError ? error.code : "memory_history_unknown",
      })), this.historySearchTimeoutMs, performance.now(), () => historyBudget.abort())
        .then((outcome) => outcome.status === "fulfilled"
          ? outcome.value
          : Object.freeze({
            result: null,
            failure: outcome.status === "timeout" ? "memory_history_timeout" : "memory_history_unknown",
          }));
    const meaningContextsPromise = this.readMeaningContexts(
      meaningDependencies,
      captured,
      timestamp,
      meaningBudget,
    );
    const [historyOutcome, candidateOutcome, meaningContexts] = await Promise.all([
      historyPromise,
      candidateContextsPromise,
      meaningContextsPromise,
    ]);
    if (candidateOutcome.status === "error") {
      throw new TypeError("telegram_memory_candidate_lookup_failed");
    }
    return Object.freeze({
      profileContext: candidateOutcome.status === "fulfilled"
        ? candidateOutcome.value.profileContext
        : null,
      noteContexts: candidateOutcome.status === "fulfilled"
        ? candidateOutcome.value.noteContexts
        : Object.freeze([]),
      candidateContexts: candidateOutcome.status === "fulfilled"
        ? candidateOutcome.value.itemContexts
        : Object.freeze([]),
      history: historyOutcome.result,
      historyFailure: historyOutcome.failure,
      meaningContexts,
    });
  }

  private async mergeMemory(
    memory: MemoryRetrievalResult,
    baseContexts: readonly RetrievedContext[],
    captured: Readonly<ContextRetrieverInput>,
    stages: MemoryStageTimings,
  ): Promise<readonly RetrievedContext[]> {
    const finishMerge = stages.start("merge");
    try {
      let historyContexts: readonly RankedMemoryContext[] = Object.freeze([]);
      const coverageContexts = withoutCurrentTurn(captured.query, baseContexts)
        .filter((context) => !questionOnly(context.text));
      if (memory.history !== null && !recentContextCoversQuery(captured.query, coverageContexts)) {
        if (memory.history.hits.length > LITERAL_HISTORY_SEARCH_LIMITS.resultsExamined) {
          throw new TypeError("telegram_memory_history_invalid");
        }
        const excludedEventIds = new Set([
          ...baseContexts.map((context) => context.sourceEventId),
          ...memory.candidateContexts.map(({ context }) => context.sourceEventId),
          ...memory.meaningContexts.map(({ context }) => context.sourceEventId),
        ]);
        const seenTexts = new Set(baseContexts.map((context) => normalizedMeaningPhrase(context.text)));
        const retained: RankedMemoryContext[] = [];
        for (const hit of memory.history.hits) {
          const folded = normalizedMeaningPhrase(hit.excerpt);
          if (retained.length >= MAX_HISTORY_RESULTS) break;
          if (excludedEventIds.has(hit.eventId) || sameText(hit.excerpt, captured.query)
            || questionOnly(hit.excerpt) || seenTexts.has(folded)
            || baseContexts.some((context) => context.text.length >= MIN_RECENT_EVIDENCE_CHARACTERS
              && context.text.includes(hit.excerpt))) continue;
          seenTexts.add(folded);
          const context = Object.freeze({
            sourceEventId: hit.eventId,
            text: await historyEvidence(hit),
            sensitivity: "personal" as const,
          });
          retained.push(Object.freeze({
            key: `history:${hit.eventId}`,
            context,
            dedupText: hit.excerpt,
            tier: ASSERTED_RECALL_TIER,
          }));
        }
        historyContexts = Object.freeze(retained);
      }
      const recentEventIds = new Set(baseContexts.map((context) => context.sourceEventId));
      const itemSourceEventIds = new Set([
        ...memory.candidateContexts.map(({ context }) => context.sourceEventId),
        ...memory.meaningContexts
          .filter(({ key }) => key.startsWith("item:"))
          .map(({ context }) => context.sourceEventId),
      ]);
      const meaningSeenTexts = new Set([
        ...baseContexts.map((context) => normalizedMeaningPhrase(context.text)),
      ]);
      const meaningContexts: RankedMemoryContext[] = [];
      for (const entry of memory.meaningContexts) {
        const folded = normalizedMeaningPhrase(entry.dedupText);
        const history = entry.key.startsWith("history:");
        if (recentEventIds.has(entry.context.sourceEventId)
          || history && itemSourceEventIds.has(entry.context.sourceEventId)
          || sameText(entry.dedupText, captured.query)
          || history && questionOnly(entry.dedupText)
          || meaningSeenTexts.has(folded)) continue;
        meaningSeenTexts.add(folded);
        meaningContexts.push(entry);
      }
      const fused = reciprocalRankFusion(
        Object.freeze([...memory.candidateContexts, ...historyContexts]),
        Object.freeze(meaningContexts),
      );
      const contexts: RetrievedContext[] = [];
      let bytes = 0;
      const preferred = [
        ...(memory.profileContext === null ? [] : [memory.profileContext]),
        ...memory.noteContexts.map(({ context }) => context),
      ];
      for (const context of preferred) {
        const textBytes = encoder.encode(context.text).byteLength;
        if (bytes + textBytes > captured.maxTokens) continue;
        bytes += textBytes;
        contexts.push(context);
      }
      for (const { context } of fused) {
        const textBytes = encoder.encode(context.text).byteLength;
        if (bytes + textBytes > captured.maxTokens) continue;
        bytes += textBytes;
        contexts.push(context);
      }
      return Object.freeze(contexts);
    } finally {
      finishMerge();
    }
  }

  private async readCandidateContexts(
    dependencies: RetrievalDependencies,
    captured: Readonly<ContextRetrieverInput>,
    timestamp: string,
  ): Promise<CandidateRecall> {
    const candidates = await this.readCandidates(dependencies, captured, timestamp);
    const [reads, livingNotes] = await Promise.all([
      dependencies.memory.readCurrentItemsWithVisibility(
        captured.principalId,
        candidates.map(({ itemId }) => itemId),
      ),
      this.readLivingNotes(
        dependencies.database,
        captured.principalId,
        candidates.map(({ itemId }) => itemId),
        timestamp,
      ),
    ]);
    const byItemId = new Map(reads.map((read) => [read.item.itemId, read]));
    const contexts: RankedMemoryContext[] = [];
    for (const candidate of candidates) {
      const read = byItemId.get(candidate.itemId);
      if (read === undefined) continue;
      const { item, visibility } = read;
      if (item.version.versionId !== candidate.versionId || !recallableAt(item, timestamp)) continue;
      if (item.lifecycle.state === "active"
        ? !visibility.retrievable
        : visibility.creationEventSuppressed || visibility.suppressedSourceIds.length > 0) continue;
      contexts.push(Object.freeze({
        key: `item:${item.itemId}`,
        dedupText: item.version.text,
        tier: recallTier(item.lifecycle.state),
        context: Object.freeze({
          sourceEventId: item.sources[0]!.eventId,
          text: itemEvidence(item),
          sensitivity: item.version.sensitivity === "sensitive" ? "restricted" as const : "personal" as const,
        }),
      }));
    }
    return Object.freeze({
      profileContext: livingNotes.profileContext,
      noteContexts: livingNotes.noteContexts,
      itemContexts: Object.freeze(contexts),
    });
  }

  /** One bounded read returns the stable root profile and the candidate areas' notes. */
  private async readLivingNotes(
    database: D1Database,
    principalId: string,
    itemIds: readonly Ulid[],
    timestamp: string,
  ): Promise<Readonly<{
    profileContext: RetrievedContext | null;
    noteContexts: readonly RankedMemoryContext[];
  }>> {
    const candidateValues = itemIds.length === 0
      ? "SELECT NULL AS item_id WHERE 0"
      : `VALUES ${itemIds.map(() => "(?)").join(", ")}`;
    const result = await database.prepare(`WITH candidate_items(item_id) AS (${candidateValues}),
        selected_topics(topic_id) AS (
          SELECT DISTINCT placement.topic_id
          FROM candidate_items candidate
          JOIN memory_item_placement_state placement
            ON placement.principal_id = ? AND placement.item_id = candidate.item_id
            AND placement.relation = 'primary' AND placement.status = 'active'
        ),
        eligible AS (
          SELECT CASE WHEN topic.parent_topic_id IS NULL THEN 'profile' ELSE 'note' END AS note_kind,
            note.note_version_id, note.markdown, note.created_at,
            EXISTS (
              SELECT 1 FROM memory_topic_note_sources restricted_source
              JOIN memory_item_versions restricted_version
                ON restricted_version.principal_id = restricted_source.principal_id
                AND restricted_version.version_id = restricted_source.item_version_id
              WHERE restricted_source.principal_id = note.principal_id
                AND restricted_source.note_version_id = note.note_version_id
                AND restricted_source.source_kind = 'item'
                AND restricted_version.sensitivity = 'sensitive'
            ) AS restricted
          FROM memory_topic_note_heads head
          JOIN memory_topic_note_versions note
            ON note.principal_id = head.principal_id
            AND note.note_version_id = head.current_note_version_id
          JOIN memory_topics topic
            ON topic.principal_id = head.principal_id AND topic.topic_id = head.topic_id
          WHERE head.principal_id = ? AND head.visibility = 'current' AND topic.status = 'active'
            AND (topic.parent_topic_id IS NULL OR topic.topic_id IN (SELECT topic_id FROM selected_topics))
            AND NOT EXISTS (
              SELECT 1 FROM memory_topic_note_sources source
              LEFT JOIN memory_item_state state
                ON source.source_kind = 'item' AND state.principal_id = source.principal_id
                AND state.item_id = source.source_id
              LEFT JOIN memory_item_versions version
                ON source.source_kind = 'item' AND version.principal_id = source.principal_id
                AND version.version_id = source.item_version_id
              LEFT JOIN memory_items item
                ON source.source_kind = 'item' AND item.principal_id = source.principal_id
                AND item.item_id = source.source_id
              WHERE source.principal_id = note.principal_id
                AND source.note_version_id = note.note_version_id
                AND source.source_kind = 'item'
                AND (
                  state.item_id IS NULL OR version.version_id IS NULL OR item.item_id IS NULL
                  OR state.lifecycle_state <> 'active'
                  OR EXISTS (
                    SELECT 1 FROM memory_consolidation_change_receipts supersession
                    WHERE supersession.principal_id = source.principal_id
                      AND supersession.change_kind = 'supersession'
                      AND supersession.subject_id = source.source_id
                  )
                  OR state.current_version_id <> source.item_version_id
                  OR version.valid_from IS NOT NULL AND version.valid_from > ?
                  OR version.valid_to IS NOT NULL AND version.valid_to <= ?
                  ${NOTE_SOURCE_SUPPRESSION_CLAUSES}
                )
            )
            AND (topic.parent_topic_id IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM memory_topic_note_heads changed_head
              WHERE changed_head.principal_id = head.principal_id
                AND changed_head.topic_id <> head.topic_id
                AND changed_head.updated_at > note.created_at
            ))
        )
      SELECT note_kind, note_version_id, markdown, restricted, created_at FROM eligible
      ORDER BY CASE note_kind WHEN 'profile' THEN 0 ELSE 1 END, created_at DESC, note_version_id ASC
      LIMIT ?`)
      .bind(...itemIds, principalId, principalId, timestamp, timestamp, MAX_LIVING_TOPIC_NOTES + 1)
      .all<LivingNoteRow>();
    const fields = new Set(["note_kind", "note_version_id", "markdown", "restricted", "created_at"]);
    let profileContext: RetrievedContext | null = null;
    const noteContexts: RankedMemoryContext[] = [];
    for (const row of result.results) {
      exactRow(row, fields, "telegram_memory_living_note_invalid");
      const noteVersionId = safeUlid(row.note_version_id);
      const markdown = safeText(row.markdown, 16_384, "telegram_memory_living_note_invalid");
      if (row.note_kind !== "profile" && row.note_kind !== "note"
        || row.restricted !== 0 && row.restricted !== 1
        || typeof row.created_at !== "string" || new Date(row.created_at).toISOString() !== row.created_at) {
        throw new TypeError("telegram_memory_living_note_invalid");
      }
      const context = Object.freeze({
        sourceEventId: noteVersionId,
        text: `${row.note_kind === "profile" ? "Living profile" : "Living topic note"} `
          + `[derived; note version ${noteVersionId}]:\n${markdown}`,
        sensitivity: row.restricted === 1 ? "restricted" as const : "personal" as const,
      });
      if (row.note_kind === "profile") {
        if (profileContext !== null) throw new TypeError("telegram_memory_living_note_invalid");
        profileContext = context;
      } else if (noteContexts.length < MAX_LIVING_TOPIC_NOTES) {
        noteContexts.push(Object.freeze({
          key: `note:${noteVersionId}`,
          context,
          dedupText: markdown,
          tier: ASSERTED_RECALL_TIER,
        }));
      }
    }
    return Object.freeze({ profileContext, noteContexts: Object.freeze(noteContexts) });
  }

  private async readMeaningContexts(
    dependencies: RetrievalDependencies,
    captured: Readonly<ContextRetrieverInput>,
    timestamp: string,
    budget: StatementBudget,
  ): Promise<readonly RankedMemoryContext[]> {
    if (shouldSkipMeaningSearch(captured.query)) {
      this.observeMeaningSearch({ meaningSearchMs: 0, fallbackCode: null });
      return Object.freeze([]);
    }
    if (this.options.meaningSearch === undefined) {
      this.observeMeaningSearch({
        meaningSearchMs: 0,
        fallbackCode: MEMORY_MEANING_BINDING_MISSING_CODE,
      });
      return Object.freeze([]);
    }
    const startedAt = performance.now();
    const canonicalReadTimeoutMs = Math.min(
      MEANING_CANONICAL_READ_TIMEOUT_MS,
      Math.max(0, this.meaningSearchTimeoutMs - 1),
    );
    const searchTimeoutMs = this.meaningSearchTimeoutMs - canonicalReadTimeoutMs;
    const search = this.options.meaningSearch.search({
      principalId: captured.principalId,
      query: captured.query,
      maxResults: MAX_MEANING_RESULTS,
    });
    const searchOutcome = await timedOutcome(search, searchTimeoutMs, startedAt, () => budget.abort());
    if (searchOutcome.status !== "fulfilled") {
      this.observeMeaningSearch({
        meaningSearchMs: elapsedMilliseconds(startedAt),
        fallbackCode: searchOutcome.status === "timeout" ? MEANING_TIMEOUT_CODE : MEANING_PROVIDER_ERROR_CODE,
      });
      return Object.freeze([]);
    }
    const readStartedAt = performance.now();
    const readOutcome = canonicalReadTimeoutMs === 0
      ? Object.freeze({ status: "timeout" as const, elapsedMs: 0 })
      : await timedOutcome(
        this.readMeaningHits(
          dependencies,
          captured.principalId,
          timestamp,
          searchOutcome.value,
        ),
        canonicalReadTimeoutMs,
        readStartedAt,
        () => budget.abort(),
      );
    if (readOutcome.status === "fulfilled") {
      this.observeMeaningSearch({ meaningSearchMs: elapsedMilliseconds(startedAt), fallbackCode: null });
      return readOutcome.value;
    }
    this.observeMeaningSearch({
      meaningSearchMs: elapsedMilliseconds(startedAt),
      fallbackCode: readOutcome.status === "timeout" ? MEANING_TIMEOUT_CODE : MEANING_PROVIDER_ERROR_CODE,
    });
    return Object.freeze([]);
  }

  private async readMeaningHits(
    dependencies: RetrievalDependencies,
    principalId: string,
    timestamp: string,
    hits: readonly MeaningSearchHit[],
  ): Promise<readonly RankedMemoryContext[]> {
    if (!Array.isArray(hits) || hits.length > MAX_MEANING_RESULTS) {
      throw new TypeError("telegram_memory_meaning_results_invalid");
    }
    if (hits.length === 0) return Object.freeze([]);
    const values = hits.map(() => "(?, ?, ?, ?)").join(", ");
    const bindings: unknown[] = [];
    hits.forEach((hit, ordinal) => {
      if (typeof hit.vectorId !== "string" || !SHA256.test(hit.vectorId)
        || typeof hit.score !== "number" || !Number.isFinite(hit.score)
        || hit.itemKind !== "item" && hit.itemKind !== "history_chunk"
        || typeof hit.itemId !== "string" || encoder.encode(hit.itemId).byteLength > 128
        || typeof hit.contentHash !== "string" || !SHA256.test(hit.contentHash)) {
        throw new TypeError("telegram_memory_meaning_result_invalid");
      }
      bindings.push(ordinal, hit.itemKind, hit.itemId, hit.contentHash);
    });
    const result = await dependencies.database.prepare(`WITH requested(
        ordinal, item_kind, item_id, content_hash
      ) AS (VALUES ${values})
      SELECT requested.ordinal, requested.item_kind,
        requested.item_id AS requested_item_id,
        requested.content_hash AS requested_content_hash,
        version.item_id, NULL AS chunk_id, NULL AS chunk_text,
        NULL AS chunk_content_hash, NULL AS event_sequence,
        NULL AS event_id, NULL AS source_location,
        NULL AS event_envelope_json, NULL AS event_content_hash
      FROM requested
      JOIN memory_item_versions version
        ON requested.item_kind = 'item' AND version.principal_id = ?
        AND version.version_id = requested.item_id
        AND version.text_hash = requested.content_hash
      JOIN memory_item_state state
        ON state.principal_id = version.principal_id
        AND state.current_version_id = version.version_id
        AND state.lifecycle_state = 'active'
      JOIN memory_retrievable_item_versions eligible
        ON eligible.principal_id = version.principal_id
        AND eligible.version_id = version.version_id
      WHERE (version.valid_from IS NULL OR version.valid_from <= ?)
        AND (version.valid_to IS NULL OR version.valid_to > ?)
        AND NOT EXISTS (
          SELECT 1 FROM memory_consolidation_change_receipts supersession
          WHERE supersession.principal_id = state.principal_id
            AND supersession.change_kind = 'supersession'
            AND supersession.subject_id = state.item_id
        )
      UNION ALL
      SELECT requested.ordinal, requested.item_kind,
        requested.item_id, requested.content_hash, NULL,
        chunk.chunk_id, chunk.text, chunk.content_hash,
        chunk.start_event_sequence,
        COALESCE(live.event_id, archived.event_id), chunk.source_location,
        live.envelope_json, live.content_hash
      FROM requested
      JOIN memory_retrievable_history_chunks chunk
        ON requested.item_kind = 'history_chunk'
        AND chunk.principal_id = ? AND chunk.content_hash = requested.content_hash
      LEFT JOIN events live ON live.subject_id = chunk.principal_id
        AND live.sequence = chunk.start_event_sequence
      LEFT JOIN archive_segment_events archived
        ON archived.event_sequence = chunk.start_event_sequence
        AND EXISTS (
          SELECT 1 FROM memory_history_coverage coverage
          WHERE coverage.principal_id = chunk.principal_id
            AND coverage.start_event_sequence = chunk.start_event_sequence
            AND coverage.end_event_sequence = chunk.end_event_sequence
            AND coverage.source_location = 'archived'
            AND coverage.r2_segment_id = archived.segment_id
            AND coverage.indexing_outcome = 'indexed'
            AND coverage.content_hash = archived.envelope_sha256
        )
      WHERE chunk.chunk_id = requested.item_id
        OR COALESCE(live.event_id, archived.event_id) = requested.item_id
      ORDER BY ordinal ASC`)
      .bind(...bindings, principalId, timestamp, timestamp, principalId)
      .all<MeaningCanonicalRow>();
    if (result.results.length > hits.length) throw new TypeError("telegram_memory_meaning_results_invalid");
    const fields = new Set([
      "ordinal", "item_kind", "requested_item_id", "requested_content_hash",
      "item_id", "chunk_id", "chunk_text", "chunk_content_hash",
      "event_sequence", "event_id", "source_location",
      "event_envelope_json", "event_content_hash",
    ]);
    const rows = new Map<number, MeaningCanonicalRow>();
    for (const row of result.results) {
      exactRow(row, fields, "telegram_memory_meaning_result_invalid");
      if (typeof row.ordinal !== "number" || !Number.isSafeInteger(row.ordinal)
        || row.ordinal < 0 || row.ordinal >= hits.length || rows.has(row.ordinal)) {
        throw new TypeError("telegram_memory_meaning_result_invalid");
      }
      rows.set(row.ordinal, row);
    }
    const itemIds: Ulid[] = [];
    for (const row of rows.values()) {
      if (row.item_kind === "item" && row.item_id !== null) itemIds.push(safeUlid(row.item_id));
    }
    const reads = await dependencies.memory.readCurrentItemsWithVisibility(
      principalId,
      [...new Set(itemIds)],
    );
    const byItemId = new Map(reads.map((read) => [read.item.itemId, read]));
    const contexts = await Promise.all(hits.map(async (hit, ordinal): Promise<RankedMemoryContext | null> => {
      const row = rows.get(ordinal);
      if (row === undefined) return null;
      if (row.requested_item_id !== hit.itemId || row.requested_content_hash !== hit.contentHash
        || row.item_kind !== hit.itemKind) throw new TypeError("telegram_memory_meaning_result_invalid");
      if (hit.itemKind === "item") {
        if (row.item_id === null) return null;
        const itemId = safeUlid(row.item_id);
        const read = byItemId.get(itemId);
        if (read === undefined) return null;
        const { item, visibility } = read;
        if (item.version.versionId !== hit.itemId || item.version.textHash !== hit.contentHash
          || item.lifecycle.state !== "active" || !recallableAt(item, timestamp)
          || !visibility.retrievable) return null;
        return Object.freeze({
          key: `item:${item.itemId}`,
          dedupText: item.version.text,
          tier: recallTier(item.lifecycle.state),
          context: Object.freeze({
            sourceEventId: item.sources[0]!.eventId,
            text: itemEvidence(item),
            sensitivity: item.version.sensitivity === "sensitive" ? "restricted" as const : "personal" as const,
          }),
        });
      }
      if (row.event_id === null) return null;
      const eventId = safeUlid(row.event_id);
      const eventSequence = row.event_sequence;
      const chunkId = safeUlid(row.chunk_id);
      const chunkText = safeText(row.chunk_text, 32_768, "telegram_memory_meaning_history_invalid");
      if (!Number.isSafeInteger(eventSequence) || (eventSequence as number) < 1
        || hit.itemId !== eventId && hit.itemId !== chunkId
        || row.chunk_content_hash !== hit.contentHash || await sha256Hex(chunkText) !== hit.contentHash
        || row.source_location !== "live" && row.source_location !== "archived") {
        throw new TypeError("telegram_memory_meaning_history_invalid");
      }
      let envelope: Awaited<ReturnType<typeof validateEnvelope>>;
      if (row.source_location === "live") {
        if (typeof row.event_envelope_json !== "string"
          || typeof row.event_content_hash !== "string" || !SHA256.test(row.event_content_hash)) {
          throw new TypeError("telegram_memory_meaning_history_invalid");
        }
        let raw: unknown;
        try { raw = JSON.parse(row.event_envelope_json); }
        catch { throw new TypeError("telegram_memory_meaning_history_invalid"); }
        envelope = await validateEnvelope(raw);
        if (envelope.contentHash !== row.event_content_hash
          || envelope.eventSequence !== undefined && envelope.eventSequence !== eventSequence) {
          throw new TypeError("telegram_memory_meaning_history_invalid");
        }
      } else {
        if (row.event_envelope_json !== null || row.event_content_hash !== null) {
          throw new TypeError("telegram_memory_meaning_history_invalid");
        }
        const events = await dependencies.events.readRange((eventSequence as number) - 1, 1);
        const event = events[0];
        if (events.length !== 1 || event === undefined || event.eventSequence !== eventSequence) {
          throw new TypeError("telegram_memory_meaning_history_invalid");
        }
        envelope = await validateEnvelope(event.envelope);
      }
      if (envelope.eventId !== eventId || envelope.subjectId !== principalId
        || envelope.eventType !== "conversation.user_committed"
        || envelope.source !== CONVERSATION_EVENT_SOURCE
        || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION) return null;
      if (envelope.payload === null || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
        throw new TypeError("telegram_memory_meaning_history_invalid");
      }
      const payloadFields = Object.hasOwn(envelope.payload, "directOwnerText")
        ? HISTORY_PAYLOAD_WITH_OWNER_MARKER_FIELDS : HISTORY_PAYLOAD_FIELDS;
      const payload = exactRecord(envelope.payload, payloadFields, "telegram_memory_meaning_history_invalid");
      const channel = payload.channelCode === 1 ? "voice" : payload.channelCode === 2 ? "telegram" : null;
      const text = safeText(payload.text, 32_768, "telegram_memory_meaning_history_invalid");
      if (payload.schemaCode !== 1 || payload.sensitivityCode !== 1 || payload.historyEligible !== true
        || channel === null || text !== chunkText || await sha256Hex(text) !== hit.contentHash) {
        throw new TypeError("telegram_memory_meaning_history_invalid");
      }
      const source = row.source_location === "live" ? "live D1" : "R2";
      return Object.freeze({
        key: `history:${eventId}`,
        dedupText: text,
        tier: ASSERTED_RECALL_TIER,
        context: Object.freeze({
          sourceEventId: eventId,
          text: `History evidence [${source}; event ${eventId}; ${envelope.occurredAt}; ${channel}; speaker owner]: ${text}`,
          sensitivity: "personal" as const,
        }),
      });
    }));
    return Object.freeze(contexts.filter((context): context is RankedMemoryContext => context !== null));
  }

  private observeMeaningSearch(observation: TelegramMeaningSearchObservation): void {
    try { this.options.observeMeaningSearch?.(Object.freeze(observation)); }
    catch { /* Retrieval telemetry must not change context or fallback. */ }
  }

  private async retrieveBase(
    baseContext: ContextRetriever,
    database: D1Database,
    input: Readonly<ContextRetrieverInput>,
    filterSuppressions: boolean,
  ): Promise<readonly RetrievedContext[]> {
    const contexts = await baseContext.retrieve(input);
    if (!filterSuppressions || contexts.length === 0) return contexts;
    // Suppression failure is a base-context failure: returning unfiltered text
    // could reintroduce a turn the owner explicitly asked Jarvis to forget.
    return this.withoutForgottenTurns(database, input.principalId, contexts);
  }

  private async withoutForgottenTurns(
    database: D1Database,
    principalId: string,
    contexts: readonly RetrievedContext[],
  ): Promise<readonly RetrievedContext[]> {
    const eventIds = [...new Set(contexts.map((context) => safeUlid(context.sourceEventId)))];
    if (eventIds.length === 0) return Object.freeze([]);
    const values = eventIds.map((_eventId, index) => `(?${index + 2})`).join(", ");
    const forgottenLimitParameter = eventIds.length + 2;
    const result = await database.prepare(`WITH context_events(event_id) AS (VALUES ${values}),
        forgotten_items AS (
          SELECT state.item_id, version.text
          FROM memory_item_state state
          JOIN memory_item_versions version
            ON version.principal_id = state.principal_id
            AND version.version_id = state.current_version_id
          WHERE state.principal_id = ?1 AND state.lifecycle_state = 'forgotten'
          ORDER BY state.item_id ASC
          LIMIT ?${forgottenLimitParameter}
        )
        SELECT 'event' AS row_kind, context.event_id, event.event_type,
          event.envelope_json AS event_envelope_json,
          turn.turn_id, turn.user_event_id, delivery.staged_event_id,
          staged.envelope_json AS staged_envelope_json,
          EXISTS (
            SELECT 1 FROM memory_active_event_suppressions suppression
            WHERE suppression.principal_id = ?1 AND (
              suppression.target_event_id = event.event_id
              OR event.sequence BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
              OR owner_event.event_id IS NOT NULL AND (
                suppression.target_event_id = owner_event.event_id
                OR owner_event.sequence BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
              )
            )
          ) AS suppressed,
          NULL AS item_id, NULL AS text
        FROM context_events context
        JOIN events event ON event.event_id = context.event_id AND event.subject_id = ?1
        LEFT JOIN conversation_turns turn ON turn.delivered_assistant_event_id = event.event_id
        LEFT JOIN events owner_event ON owner_event.event_id = turn.user_event_id
        LEFT JOIN conversation_deliveries delivery ON delivery.delivery_id = turn.staged_delivery_id
        LEFT JOIN events staged ON staged.event_id = delivery.staged_event_id
        UNION ALL
        SELECT 'forgotten' AS row_kind, NULL AS event_id, NULL AS event_type,
          NULL AS event_envelope_json, NULL AS turn_id, NULL AS user_event_id,
          NULL AS staged_event_id, NULL AS staged_envelope_json, NULL AS suppressed,
          forgotten.item_id, forgotten.text
        FROM forgotten_items forgotten`)
      .bind(principalId, ...eventIds, MAX_FORGOTTEN_ITEMS + 1)
      .all<SuppressionRow>();
    const rowFields = new Set([
      "row_kind", "event_id", "event_type", "event_envelope_json", "turn_id",
      "user_event_id", "staged_event_id", "staged_envelope_json", "suppressed",
      "item_id", "text",
    ]);
    const eventRows: SuppressionRow[] = [];
    const forgottenRows: SuppressionRow[] = [];
    for (const row of result.results) {
      exactRow(row, rowFields, "telegram_memory_suppression_invalid");
      if (row.row_kind === "event" && row.item_id === null && row.text === null) {
        eventRows.push(row);
      } else if (row.row_kind === "forgotten"
        && row.event_id === null && row.event_type === null && row.event_envelope_json === null
        && row.turn_id === null && row.user_event_id === null && row.staged_event_id === null
        && row.staged_envelope_json === null && row.suppressed === null) {
        forgottenRows.push(row);
      } else {
        throw new TypeError("telegram_memory_suppression_invalid");
      }
    }
    if (eventRows.length !== eventIds.length || forgottenRows.length > MAX_FORGOTTEN_ITEMS) {
      throw new TypeError("telegram_memory_suppression_invalid");
    }
    const forgotten = forgottenRows.map((row) => {
      return Object.freeze({
        itemId: safeUlid(row.item_id),
        text: safeText(row.text, 4_096, "telegram_memory_suppression_invalid"),
      });
    });
    const forgottenIds = new Set(forgotten.map((item) => item.itemId));
    const metadata = new Map<Ulid, Readonly<{
      assistant: boolean;
      suppressed: boolean;
      referencedItemIds: readonly Ulid[];
    }>>();
    await Promise.all(eventRows.map(async (row) => {
      const eventId = safeUlid(row.event_id);
      const suppressed = row.suppressed === 1 ? true : row.suppressed === 0 ? false : null;
      if (suppressed === null || typeof row.event_envelope_json !== "string") {
        throw new TypeError("telegram_memory_suppression_invalid");
      }
      if (row.event_type === "conversation.user_committed") {
        if (row.turn_id !== null || row.user_event_id !== null || row.staged_event_id !== null
          || row.staged_envelope_json !== null) {
          throw new TypeError("telegram_memory_suppression_invalid");
        }
        metadata.set(eventId, Object.freeze({
          assistant: false,
          suppressed,
          referencedItemIds: Object.freeze([]),
        }));
        return;
      }
      if (row.event_type !== ASSISTANT_DELIVERED_EVENT_TYPE || typeof row.staged_envelope_json !== "string") {
        throw new TypeError("telegram_memory_suppression_invalid");
      }
      const turnId = safeUlid(row.turn_id);
      const userEventId = safeUlid(row.user_event_id);
      const stagedEventId = safeUlid(row.staged_event_id);
      const deliveredText = await deliveredAssistantText({
        envelopeJson: row.event_envelope_json,
        eventId,
        stagedEventId,
        turnId,
        principalId,
      });
      const context = contexts.find((entry) => entry.sourceEventId === eventId);
      if (context === undefined || context.text !== deliveredText) {
        throw new TypeError("telegram_memory_suppression_invalid");
      }
      const stagedIds = await stagedMemoryItemIds({
        envelopeJson: row.staged_envelope_json,
        eventId: stagedEventId,
        turnId,
        userEventId,
        principalId,
      });
      metadata.set(eventId, Object.freeze({
        assistant: true,
        suppressed,
        referencedItemIds: Object.freeze([...new Set([
          ...stagedIds,
          ...citedMemoryItemIds(deliveredText),
        ])]),
      }));
    }));
    return Object.freeze(contexts.filter((context) => {
      const event = metadata.get(context.sourceEventId);
      if (event === undefined || event.suppressed) return false;
      if (!event.assistant) return true;
      if (event.referencedItemIds.some((itemId) => forgottenIds.has(itemId))) return false;
      return !forgotten.some((item) => restatesMemory(context.text, item.text));
    }));
  }

  /**
   * Delegates to the extracted finder.
   *
   * The body lived here, and the voice path could not reach it: this class is a
   * `ContextRetriever` shaped for one channel, while the finder is what every
   * `itemId` tool needs. Keeping a second copy here would be two answers to
   * "which item did he mean", which is the shape #135 was about.
   */
  async findControlTargets(input: Readonly<{
    principalId: string;
    operation: TelegramMemoryTargetOperation;
    query: string | null;
    turnId?: Ulid;
  }>): Promise<readonly Ulid[]> {
    return this.controlTargets.findControlTargets(input);
  }


  private dependencies(
    budget: StatementBudget,
    sourceDatabase: D1Database = this.options.database,
  ): RetrievalDependencies {
    const database = countedDatabase(sourceDatabase, budget);
    const archive = new ArchivalService({
      database,
      bucket: this.options.archive,
      cacheVerifiedSegments: true,
    });
    const state = new ArchiveRepository(database);
    const live = new EventRepository(database);
    const tiered = new TieredEventReader({ archive, live, state });
    return Object.freeze({
      database,
      archiveState: state,
      memory: new MemoryRepository(database, { archivedEventReader: archive }),
      events: tiered,
      history: new LiteralHistoryService({
        database,
        events: tiered,
        archive: state,
        now: this.now,
        nextId: this.nextId,
      }),
    });
  }

  private async readCandidates(
    dependencies: RetrievalDependencies,
    input: Readonly<ContextRetrieverInput>,
    timestamp: string,
  ): Promise<readonly Readonly<{ itemId: Ulid; versionId: Ulid }>[]> {
    const area = parseTelegramMemoryAreaQuestion(input.query);
    if (area !== null) {
      try {
        const topic = await dependencies.memory.resolveTopicPath(input.principalId, area);
        const result = await dependencies.database.prepare(`WITH RECURSIVE subtree(topic_id, depth) AS (
            SELECT ?1, 0
            UNION ALL
            SELECT child.topic_id, subtree.depth + 1
            FROM memory_topics child JOIN subtree ON child.parent_topic_id = subtree.topic_id
            WHERE child.principal_id = ?2 AND child.status = 'active' AND subtree.depth < 63
          )
          SELECT version.item_id, version.version_id, 0.0 AS relevance
          FROM subtree
          JOIN memory_item_placement_state placement
            ON placement.principal_id = ?2 AND placement.topic_id = subtree.topic_id
            AND placement.relation = 'primary' AND placement.status = 'active'
          JOIN memory_item_state state
            ON state.principal_id = placement.principal_id AND state.item_id = placement.item_id
          JOIN memory_items item
            ON item.principal_id = state.principal_id AND item.item_id = state.item_id
          JOIN memory_item_versions version
            ON version.principal_id = state.principal_id AND version.version_id = state.current_version_id
          WHERE state.lifecycle_state IN ('active', 'proposed')
            AND (state.lifecycle_state = 'active' OR version.uncertain = 1)
            AND (version.valid_from IS NULL OR version.valid_from <= ?3)
            AND (version.valid_to IS NULL OR version.valid_to > ?3)
            ${CANDIDATE_SUPPRESSION_CLAUSES}
            AND NOT EXISTS (
              SELECT 1 FROM memory_consolidation_change_receipts supersession
              WHERE supersession.principal_id = state.principal_id
                AND supersession.change_kind = 'supersession'
                AND supersession.subject_id = state.item_id
            )
          ORDER BY CASE state.lifecycle_state WHEN 'active' THEN 0 ELSE 1 END,
            version.created_at DESC, version.item_id ASC LIMIT ?4`)
          .bind(topic.topicId, input.principalId, timestamp, MAX_MEMORY_CANDIDATES)
          .all<CandidateRow>();
        return candidateRows(result.results);
      } catch (error) {
        if (!(error instanceof MemoryRepositoryError) || error.code !== "memory_not_found") throw error;
      }
    }

    const terms = ftsQuery(input.query);
    if (terms === null) return Object.freeze([]);
    const result = await dependencies.database.prepare(`SELECT version.item_id, version.version_id,
        memory_item_fts.rank AS relevance
      FROM memory_item_fts
      JOIN memory_item_versions version ON version.version_rowid = memory_item_fts.rowid
      JOIN memory_item_state state
        ON state.principal_id = version.principal_id AND state.current_version_id = version.version_id
      JOIN memory_items item
        ON item.principal_id = state.principal_id AND item.item_id = state.item_id
      WHERE memory_item_fts MATCH ? AND version.principal_id = ?
        AND state.lifecycle_state IN ('active', 'proposed')
        AND (state.lifecycle_state = 'active' OR version.uncertain = 1)
        AND (version.valid_from IS NULL OR version.valid_from <= ?)
        AND (version.valid_to IS NULL OR version.valid_to > ?)
        ${CANDIDATE_SUPPRESSION_CLAUSES}
        AND NOT EXISTS (
          SELECT 1 FROM memory_consolidation_change_receipts supersession
          WHERE supersession.principal_id = state.principal_id
            AND supersession.change_kind = 'supersession'
            AND supersession.subject_id = state.item_id
        )
      ORDER BY CASE state.lifecycle_state WHEN 'active' THEN 0 ELSE 1 END,
        memory_item_fts.rank ASC, version.created_at DESC, version.item_id ASC LIMIT ?`)
      .bind(terms, input.principalId, timestamp, timestamp, MAX_MEMORY_CANDIDATES)
      .all<CandidateRow>();
    return candidateRows(result.results);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new TypeError("telegram_memory_clock_invalid");
    }
    return new Date(value.valueOf()).toISOString();
  }
}

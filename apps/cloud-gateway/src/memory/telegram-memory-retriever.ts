import { newUlid, sha256Hex, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../archive/archive-repository.js";
import { ArchivalService, type ArchiveBucket } from "../archive/archival-service.js";
import { TieredEventReader } from "../archive/tiered-event-reader.js";
import type {
  ContextRetriever,
  ContextRetrieverInput,
  RetrievedContext,
} from "../conversation/conversation-types.js";
import { EventRepository } from "../persistence/event-repository.js";
import {
  LITERAL_HISTORY_SEARCH_LIMITS,
  LiteralHistoryService,
  type LiteralHistoryHit,
} from "./literal-history.js";
import { MemoryRepository } from "./memory-repository.js";
import {
  MemoryRepositoryError,
  type CanonicalMemoryItem,
  type MemoryLifecycleState,
} from "./memory-types.js";
import {
  parseTelegramMemoryAreaQuestion,
  parseTelegramMemoryControl,
} from "./telegram-memory-language.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_QUERY_BYTES = 65_536;
const MAX_QUERY_CHARACTERS = 8_000;
const MAX_FTS_TERMS = 16;
const MAX_FTS_TERM_BYTES = 128;
const MAX_MEMORY_CANDIDATES = 3;
const MAX_HISTORY_RESULTS = 4;
const MAX_CONTROL_TARGETS = 2;
const encoder = new TextEncoder();

/**
 * Worst case: a topic alias/path walk (257), three canonical item reads with
 * eight archived sources and maximal redirect/path walks (3 * 168), the
 * literal-history ceiling (62), and candidate/visibility reads. The enforced
 * ceiling stays below the Worker D1 subrequest limit.
 */
export const TELEGRAM_MEMORY_RETRIEVAL_LIMITS = Object.freeze({
  d1Statements: 900,
  memoryItemsExamined: MAX_MEMORY_CANDIDATES,
  historyResultsExamined: MAX_HISTORY_RESULTS,
});

export const TELEGRAM_MEMORY_CONTROL_TARGET_LIMITS = Object.freeze({
  d1Statements: 384,
  candidatesExamined: MAX_CONTROL_TARGETS,
});

export type TelegramMemoryTargetOperation = "forget" | "lift" | "explain";

export interface TelegramMemoryTargetFinder {
  findControlTargets(input: Readonly<{
    principalId: string;
    operation: TelegramMemoryTargetOperation;
    query: string | null;
  }>): Promise<readonly Ulid[]>;
}

export interface TelegramMemoryRetrieverOptions {
  readonly database: D1Database;
  readonly archive: ArchiveBucket;
  readonly now?: () => Date;
  readonly nextId?: () => Ulid;
  readonly controlAuthority?: Readonly<{ principalId: string; text: string }> | null;
}

interface CandidateRow {
  readonly item_id: unknown;
  readonly version_id: unknown;
  readonly relevance: unknown;
}

interface RetrievalDependencies {
  readonly database: D1Database;
  readonly memory: MemoryRepository;
  readonly history: LiteralHistoryService;
}

class StatementBudget {
  used = 0;

  constructor(readonly maximum: number) {}

  take(): void {
    this.used += 1;
    if (this.used > this.maximum) throw new RangeError("telegram_memory_d1_budget_exceeded");
  }
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

function safeText(value: unknown, maximumBytes: number, error: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(error);
  }
  return value;
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
  if (Array.from(query).length > MAX_QUERY_CHARACTERS || input.channel !== "telegram"
    || input.purpose !== "conversation" || !Number.isSafeInteger(input.maxTokens)
    || (input.maxTokens as number) < 1 || (input.maxTokens as number) > 32_000) {
    throw new TypeError("telegram_memory_input_invalid");
  }
  return Object.freeze({
    principalId,
    channel: "telegram",
    purpose: "conversation",
    query,
    maxTokens: input.maxTokens as number,
  });
}

function ftsQuery(value: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].normalize("NFC");
    const folded = term.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
    if (encoder.encode(term).byteLength > MAX_FTS_TERM_BYTES || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(`"${term}"`);
    if (terms.length === MAX_FTS_TERMS) break;
  }
  return terms.length === 0 ? null : terms.join(" OR ");
}

function literalHistoryQuery(value: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].normalize("NFC");
    const folded = term.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
    if (encoder.encode(term).byteLength > MAX_FTS_TERM_BYTES || seen.has(folded)) continue;
    const candidate = [...terms, term].join(" ");
    if (encoder.encode(candidate).byteLength > 1_024) break;
    seen.add(folded);
    terms.push(term);
    if (terms.length === MAX_FTS_TERMS) break;
  }
  return terms.length === 0 ? null : terms.join(" ");
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
  return `Memory evidence [item ${item.itemId}; area ${area}; sources ${sources}]: ${item.version.text}`;
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

function currentAt(item: CanonicalMemoryItem, now: string): boolean {
  return item.lifecycle.state === "active"
    && (item.version.validFrom === null || item.version.validFrom <= now)
    && (item.version.validTo === null || item.version.validTo > now);
}

function targetStates(operation: TelegramMemoryTargetOperation): readonly MemoryLifecycleState[] {
  if (operation === "forget") return Object.freeze(["active", "proposed"]);
  if (operation === "lift") return Object.freeze(["forgotten"]);
  return Object.freeze(["proposed", "active", "rejected", "superseded", "forgotten", "expired"]);
}

export class TelegramMemoryRetriever implements ContextRetriever, TelegramMemoryTargetFinder {
  private readonly now: () => Date;
  private readonly nextId: () => Ulid;
  private readonly controlAuthority: Readonly<{ principalId: string; text: string }> | null;

  constructor(private readonly options: TelegramMemoryRetrieverOptions) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? (() => newUlid(this.now()));
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

    const budget = new StatementBudget(TELEGRAM_MEMORY_RETRIEVAL_LIMITS.d1Statements);
    const dependencies = this.dependencies(budget);
    const timestamp = this.timestamp();
    const candidates = await this.readCandidates(dependencies, captured, timestamp);
    const contexts: RetrievedContext[] = [];
    let bytes = 0;

    for (const candidate of candidates) {
      const item = await dependencies.memory.readCurrentItem(captured.principalId, candidate.itemId);
      if (item.version.versionId !== candidate.versionId || !currentAt(item, timestamp)) continue;
      const stillVisible = await dependencies.database.prepare(`SELECT 1 AS count
        FROM memory_retrievable_item_versions
        WHERE principal_id = ? AND item_id = ? AND version_id = ? LIMIT 1`)
        .bind(captured.principalId, item.itemId, item.version.versionId).first<{ count: unknown }>();
      if (stillVisible === null) continue;
      exactRow(stillVisible, new Set(["count"]), "telegram_memory_visibility_invalid");
      if (stillVisible.count !== 1) throw new TypeError("telegram_memory_visibility_invalid");
      const text = itemEvidence(item);
      const textBytes = encoder.encode(text).byteLength;
      if (bytes + textBytes > captured.maxTokens) continue;
      bytes += textBytes;
      contexts.push(Object.freeze({
        sourceEventId: item.sources[0]!.eventId,
        text,
        sensitivity: item.version.sensitivity === "sensitive" ? "restricted" : "personal",
      }));
    }

    const literalQuery = literalHistoryQuery(captured.query);
    if (literalQuery !== null && bytes < captured.maxTokens) {
      const history = await dependencies.history.searchLiteral({
        principalId: captured.principalId,
        query: literalQuery,
        maxResults: MAX_HISTORY_RESULTS,
      });
      if (history.hits.length > LITERAL_HISTORY_SEARCH_LIMITS.resultsExamined) {
        throw new TypeError("telegram_memory_history_invalid");
      }
      for (const hit of history.hits) {
        const text = await historyEvidence(hit);
        const textBytes = encoder.encode(text).byteLength;
        if (bytes + textBytes > captured.maxTokens) continue;
        bytes += textBytes;
        contexts.push(Object.freeze({ sourceEventId: hit.eventId, text, sensitivity: "personal" }));
      }
    }
    return Object.freeze(contexts);
  }

  async findControlTargets(input: Readonly<{
    principalId: string;
    operation: TelegramMemoryTargetOperation;
    query: string | null;
  }>): Promise<readonly Ulid[]> {
    const principalId = safePrincipal(input.principalId);
    if (input.operation !== "forget" && input.operation !== "lift" && input.operation !== "explain") {
      throw new TypeError("telegram_memory_target_invalid");
    }
    const states = targetStates(input.operation);
    const query = input.query === null ? null : safeText(input.query, 1_024, "telegram_memory_target_invalid");
    const terms = query === null ? null : ftsQuery(query);
    if (query !== null && terms === null) return Object.freeze([]);
    const budget = new StatementBudget(TELEGRAM_MEMORY_CONTROL_TARGET_LIMITS.d1Statements);
    const dependencies = this.dependencies(budget);
    const stateSql = states.map((state) => `'${state}'`).join(", ");
    const result = terms === null
      ? await dependencies.database.prepare(`SELECT version.item_id, version.version_id,
          0.0 AS relevance
        FROM memory_item_state state
        JOIN memory_item_versions version
          ON version.principal_id = state.principal_id
          AND version.version_id = state.current_version_id
        JOIN memory_item_transitions transition
          ON transition.principal_id = state.principal_id
          AND transition.transition_id = state.last_transition_id
        WHERE state.principal_id = ? AND state.lifecycle_state IN (${stateSql})
        ORDER BY transition.occurred_at DESC, state.item_id ASC LIMIT ?`)
        .bind(principalId, MAX_CONTROL_TARGETS).all<CandidateRow>()
      : await dependencies.database.prepare(`SELECT version.item_id, version.version_id,
          memory_item_fts.rank AS relevance
        FROM memory_item_fts
        JOIN memory_item_versions version ON version.version_rowid = memory_item_fts.rowid
        JOIN memory_item_state state
          ON state.principal_id = version.principal_id
          AND state.current_version_id = version.version_id
        WHERE memory_item_fts MATCH ? AND state.principal_id = ?
          AND state.lifecycle_state IN (${stateSql})
        ORDER BY memory_item_fts.rank ASC, version.created_at DESC, version.item_id ASC LIMIT ?`)
        .bind(terms, principalId, MAX_CONTROL_TARGETS).all<CandidateRow>();
    const rows = candidateRows(result.results);
    const selected: Ulid[] = [];
    for (const candidate of rows) {
      try {
        const item = await dependencies.memory.readCurrentItem(principalId, candidate.itemId);
        if (item.version.versionId === candidate.versionId && states.includes(item.lifecycle.state)) {
          selected.push(item.itemId);
        }
      } catch (error) {
        if (!(error instanceof MemoryRepositoryError) || error.code !== "memory_not_found") throw error;
      }
    }
    return Object.freeze(selected);
  }

  private dependencies(budget: StatementBudget): RetrievalDependencies {
    const database = countedDatabase(this.options.database, budget);
    const archive = new ArchivalService({ database, bucket: this.options.archive });
    const state = new ArchiveRepository(database);
    const live = new EventRepository(database);
    const tiered = new TieredEventReader({ archive, live, state });
    return Object.freeze({
      database,
      memory: new MemoryRepository(database, { archivedEventReader: archive }),
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
          JOIN memory_retrievable_item_versions version
            ON version.principal_id = placement.principal_id AND version.item_id = placement.item_id
          WHERE (version.valid_from IS NULL OR version.valid_from <= ?3)
            AND (version.valid_to IS NULL OR version.valid_to > ?3)
          ORDER BY version.created_at DESC, version.item_id ASC LIMIT ?4`)
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
      JOIN memory_retrievable_item_versions version ON version.version_rowid = memory_item_fts.rowid
      WHERE memory_item_fts MATCH ? AND version.principal_id = ?
        AND (version.valid_from IS NULL OR version.valid_from <= ?)
        AND (version.valid_to IS NULL OR version.valid_to > ?)
      ORDER BY memory_item_fts.rank ASC, version.created_at DESC, version.item_id ASC LIMIT ?`)
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

import {
  canonicalJson,
  newUlid,
  sha256Hex,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";

export const MEMORY_EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const MEMORY_EMBEDDING_DIMENSIONS = 1_024;
export const MEMORY_MEANING_BINDING_MISSING_CODE = "memory_meaning_bindings_missing";
export const MEMORY_MEANING_INDEX_RETRYABLE_CODE = "memory_meaning_index_retryable";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_MUTATION_ID_BYTES = 128;
const MAX_QUERY_RESULTS = 8;
const encoder = new TextEncoder();

/**
 * One hourly step stays far below the paid-Workers subrequest ceiling: one
 * Workers AI call, at most eight Vectorize mutations, and fewer than 32 D1
 * statements. The byte ceiling also bounds the one embedding request even
 * when history contains a maximal chunk.
 */
export const MEMORY_MEANING_INDEX_LIMITS = Object.freeze({
  mutations: 8,
  embeddingInputs: 8,
  embeddingInputBytes: 65_536,
  workersAiCalls: 1,
  vectorizeMutations: 8,
  d1Statements: 32,
});

export interface MemoryEmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface MemoryVectorMetadata {
  readonly principal: string;
  readonly itemKind: "item" | "history_chunk";
  /** A current memory-version id for items, and a chunk id for history. */
  readonly itemId: string;
  readonly contentHash: Sha256Hex;
}

export interface MemoryVectorStore {
  upsert(vectors: readonly Readonly<{
    id: string;
    values: readonly number[];
    metadata: MemoryVectorMetadata;
  }>[]): Promise<Readonly<{ mutationId: string }>>;
  deleteByIds(ids: readonly string[]): Promise<Readonly<{ mutationId: string }>>;
  query(values: readonly number[], options: Readonly<{
    topK: number;
    returnMetadata: "all";
    filter: Readonly<{ principal: string }>;
  }>): Promise<Readonly<{
    matches: readonly Readonly<{
      id: string;
      score: number;
      metadata?: Readonly<Record<string, unknown>>;
    }>[];
  }>>;
}

export interface MeaningSearchHit {
  readonly vectorId: string;
  readonly score: number;
  readonly itemKind: "item" | "history_chunk";
  readonly itemId: string;
  readonly contentHash: Sha256Hex;
}

export interface MeaningSearchReader {
  search(input: Readonly<{
    principalId: string;
    query: string;
    maxResults?: number;
  }>): Promise<readonly MeaningSearchHit[]>;
}

export interface MemoryMeaningCoverage {
  readonly eligible: number;
  readonly indexed: number;
  readonly missing: number;
}

export interface MemoryMeaningIndexOutcome {
  readonly outcome: "indexed" | "retryable_failure";
  readonly upserted: number;
  readonly deleted: number;
  readonly remaining: boolean;
  readonly code: null | typeof MEMORY_MEANING_INDEX_RETRYABLE_CODE;
}

interface IndexCandidateRow {
  readonly item_kind: unknown;
  readonly item_id: unknown;
  readonly text: unknown;
  readonly content_hash: unknown;
}

interface DeleteCandidateRow {
  readonly vector_ledger_id: unknown;
  readonly item_kind: unknown;
  readonly item_id: unknown;
  readonly content_hash: unknown;
}

interface CountRow {
  readonly eligible: unknown;
  readonly indexed: unknown;
}

interface MaximumSequenceRow {
  readonly maximum_sequence: unknown;
}

interface CursorRow {
  readonly current_event_sequence: unknown;
  readonly updated_at: unknown;
}

export interface MemoryMeaningServiceOptions {
  readonly database: D1Database;
  readonly embeddings: MemoryEmbeddingProvider;
  readonly vectors: MemoryVectorStore;
  readonly now?: () => Date;
  readonly nextId?: () => Ulid;
  /** A fault seam for retry/idempotency tests; production leaves it absent. */
  readonly beforeLedgerWrite?: () => void | Promise<void>;
}

function safeString(value: unknown, maximumBytes: number, code: string): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(code);
  }
  return value;
}

function safeHash(value: unknown): Sha256Hex {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError("memory_meaning_hash_invalid");
  return value as Sha256Hex;
}

function safeKind(value: unknown): "item" | "history_chunk" {
  if (value !== "item" && value !== "history_chunk") throw new TypeError("memory_meaning_kind_invalid");
  return value;
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("memory_meaning_count_invalid");
  }
  return value;
}

function safeTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError("memory_meaning_clock_invalid");
  }
  return new Date(value.valueOf()).toISOString();
}

export async function readMemoryMeaningCoverage(
  database: D1Database,
  principalIdValue: string,
  at: Date = new Date(),
): Promise<MemoryMeaningCoverage> {
  const principalId = safeString(principalIdValue, 128, "memory_meaning_principal_invalid");
  if (!(at instanceof Date) || !Number.isFinite(at.valueOf())) throw new TypeError("memory_meaning_clock_invalid");
  const timestamp = new Date(at.valueOf()).toISOString();
  const row = await database.prepare(`WITH eligible(item_kind, item_id, content_hash) AS (
      SELECT 'item', version.version_id, version.text_hash
      FROM memory_retrievable_item_versions version
      WHERE version.principal_id = ?1
        AND (version.valid_from IS NULL OR version.valid_from <= ?2)
        AND (version.valid_to IS NULL OR version.valid_to > ?2)
      UNION ALL
      SELECT 'history_chunk', chunk.chunk_id, chunk.content_hash
      FROM memory_retrievable_history_chunks chunk
      WHERE chunk.principal_id = ?1
    )
    SELECT count(*) AS eligible,
      count(vector.vector_ledger_id) AS indexed
    FROM eligible
    LEFT JOIN memory_vectors vector
      ON vector.principal_id = ?1
      AND vector.item_kind = eligible.item_kind
      AND vector.item_id = eligible.item_id
      AND vector.content_hash = eligible.content_hash
      AND vector.embedding_model = ?3
      AND vector.deleted_at IS NULL`)
    .bind(principalId, timestamp, MEMORY_EMBEDDING_MODEL).first<CountRow>();
  if (row === null) throw new TypeError("memory_meaning_coverage_invalid");
  const eligible = safeCount(row.eligible);
  const indexed = safeCount(row.indexed);
  if (indexed > eligible) throw new TypeError("memory_meaning_coverage_invalid");
  return Object.freeze({ eligible, indexed, missing: eligible - indexed });
}

function validateEmbedding(values: readonly number[]): readonly number[] {
  if (values.length !== MEMORY_EMBEDDING_DIMENSIONS
    || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("memory_meaning_embedding_invalid");
  }
  return values;
}

function mutationId(value: unknown): string {
  return safeString(value, MAX_MUTATION_ID_BYTES, "memory_meaning_mutation_invalid");
}

function indexCandidate(row: IndexCandidateRow): Readonly<{
  itemKind: "item" | "history_chunk";
  itemId: string;
  text: string;
  contentHash: Sha256Hex;
}> {
  return Object.freeze({
    itemKind: safeKind(row.item_kind),
    itemId: safeString(row.item_id, 128, "memory_meaning_item_id_invalid"),
    text: safeString(row.text, 32_768, "memory_meaning_text_invalid"),
    contentHash: safeHash(row.content_hash),
  });
}

async function vectorId(input: Readonly<{
  principal: string;
  itemKind: "item" | "history_chunk";
  itemId: string;
  contentHash: Sha256Hex;
}>): Promise<string> {
  // Vectorize ids are capped at 64 bytes. A hash keeps the full canonical
  // identity without leaking principal or source ids into the id itself.
  return sha256Hex(canonicalJson(input));
}

export class WorkersAiMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  constructor(private readonly ai: Pick<Ai, "run">) {}

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const response = await this.ai.run(MEMORY_EMBEDDING_MODEL as never, { text: [...texts] } as never) as unknown;
    if (response === null || typeof response !== "object" || Array.isArray(response)
      || !("data" in response) || !Array.isArray(response.data)) {
      throw new TypeError("memory_meaning_embedding_invalid");
    }
    const rows = response.data;
    if (rows.length !== texts.length) throw new TypeError("memory_meaning_embedding_invalid");
    return Object.freeze(rows.map((row) => {
      if (!Array.isArray(row)) throw new TypeError("memory_meaning_embedding_invalid");
      return Object.freeze(validateEmbedding(row));
    }));
  }
}

export class VectorizeMemoryVectorStore implements MemoryVectorStore {
  constructor(private readonly index: Vectorize) {}

  async upsert(vectors: readonly Readonly<{
    id: string;
    values: readonly number[];
    metadata: MemoryVectorMetadata;
  }>[]): Promise<Readonly<{ mutationId: string }>> {
    return this.index.upsert(vectors.map((vector) => ({
      id: vector.id,
      values: [...vector.values],
      metadata: { ...vector.metadata },
    })));
  }

  async deleteByIds(ids: readonly string[]): Promise<Readonly<{ mutationId: string }>> {
    return this.index.deleteByIds([...ids]);
  }

  async query(values: readonly number[], options: Readonly<{
    topK: number;
    returnMetadata: "all";
    filter: Readonly<{ principal: string }>;
  }>): Promise<Readonly<{
    matches: readonly Readonly<{
      id: string;
      score: number;
      metadata?: Readonly<Record<string, unknown>>;
    }>[];
  }>> {
    const result = await this.index.query([...values], options);
    return Object.freeze({ matches: Object.freeze(result.matches.map((match) => Object.freeze({
      id: match.id,
      score: match.score,
      metadata: match.metadata as Readonly<Record<string, unknown>> | undefined,
    }))) });
  }
}

export class MemoryMeaningService implements MeaningSearchReader {
  private readonly now: () => Date;
  private readonly nextId: () => Ulid;

  constructor(private readonly options: MemoryMeaningServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? (() => newUlid(this.now()));
  }

  async search(input: Readonly<{
    principalId: string;
    query: string;
    maxResults?: number;
  }>): Promise<readonly MeaningSearchHit[]> {
    const principalId = safeString(input.principalId, 128, "memory_meaning_principal_invalid");
    const query = safeString(input.query, 65_536, "memory_meaning_query_invalid");
    const maximum = input.maxResults ?? MAX_QUERY_RESULTS;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_QUERY_RESULTS) {
      throw new TypeError("memory_meaning_limit_invalid");
    }
    const [embedding] = await this.options.embeddings.embed([query]);
    if (embedding === undefined) throw new TypeError("memory_meaning_embedding_invalid");
    const result = await this.options.vectors.query(validateEmbedding(embedding), {
      topK: maximum,
      returnMetadata: "all",
      filter: { principal: principalId },
    });
    if (!Array.isArray(result.matches) || result.matches.length > maximum) {
      throw new TypeError("memory_meaning_results_invalid");
    }
    return Object.freeze(result.matches.map((match) => {
      if (typeof match.id !== "string" || match.id.length !== 64 || !SHA256.test(match.id)
        || typeof match.score !== "number" || !Number.isFinite(match.score)
        || match.metadata === undefined) {
        throw new TypeError("memory_meaning_result_invalid");
      }
      const metadata = match.metadata;
      if (Reflect.ownKeys(metadata).length !== 4
        || metadata.principal !== principalId) {
        throw new TypeError("memory_meaning_result_invalid");
      }
      return Object.freeze({
        vectorId: match.id,
        score: match.score,
        itemKind: safeKind(metadata.itemKind),
        itemId: safeString(metadata.itemId, 128, "memory_meaning_result_invalid"),
        contentHash: safeHash(metadata.contentHash),
      });
    }));
  }

  async runIndexStep(principalIdValue: string): Promise<MemoryMeaningIndexOutcome> {
    const principalId = safeString(principalIdValue, 128, "memory_meaning_principal_invalid");
    let upserted = 0;
    let deleted = 0;
    try {
      const timestamp = safeTimestamp(this.now);
      const stale = await this.readDeleteCandidates(principalId, timestamp, MEMORY_MEANING_INDEX_LIMITS.mutations);
      for (const candidate of stale) {
        const id = await vectorId({
          principal: principalId,
          itemKind: candidate.itemKind,
          itemId: candidate.itemId,
          contentHash: candidate.contentHash,
        });
        await this.options.vectors.deleteByIds([id]);
        await this.options.database.prepare(`UPDATE memory_vectors SET deleted_at = ?
          WHERE principal_id = ? AND vector_ledger_id = ? AND deleted_at IS NULL`)
          .bind(timestamp, principalId, candidate.vectorLedgerId).run();
        deleted += 1;
      }

      const remainingCapacity = MEMORY_MEANING_INDEX_LIMITS.mutations - deleted;
      if (remainingCapacity > 0) {
        const candidates = await this.readIndexCandidates(principalId, timestamp, remainingCapacity);
        if (candidates.length > 0) {
          const embeddings = await this.options.embeddings.embed(candidates.map((candidate) => candidate.text));
          if (embeddings.length !== candidates.length) throw new TypeError("memory_meaning_embedding_invalid");
          for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index]!;
            const embedding = embeddings[index];
            if (embedding === undefined) throw new TypeError("memory_meaning_embedding_invalid");
            const id = await vectorId({
              principal: principalId,
              itemKind: candidate.itemKind,
              itemId: candidate.itemId,
              contentHash: candidate.contentHash,
            });
            const mutation = await this.options.vectors.upsert([{
              id,
              values: validateEmbedding(embedding),
              metadata: {
                principal: principalId,
                itemKind: candidate.itemKind,
                itemId: candidate.itemId,
                contentHash: candidate.contentHash,
              },
            }]);
            await this.options.beforeLedgerWrite?.();
            try {
              await this.options.database.prepare(`INSERT INTO memory_vectors (
                vector_ledger_id, principal_id, item_kind, item_id,
                embedding_model, dimensions, content_hash, mutation_id,
                upserted_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
                .bind(
                  this.nextId(), principalId, candidate.itemKind, candidate.itemId,
                  MEMORY_EMBEDDING_MODEL, MEMORY_EMBEDDING_DIMENSIONS,
                  candidate.contentHash, mutationId(mutation.mutationId), timestamp,
                ).run();
              upserted += 1;
            } catch (error) {
              if (!await this.hasLiveLedgerRow(principalId, candidate)) throw error;
            }
          }
        }
      }

      const remaining = await this.hasPendingWork(principalId, timestamp);
      if (!remaining) await this.advanceCursor(principalId, timestamp);
      return Object.freeze({ outcome: "indexed", upserted, deleted, remaining, code: null });
    } catch {
      return Object.freeze({
        outcome: "retryable_failure",
        upserted,
        deleted,
        remaining: true,
        code: MEMORY_MEANING_INDEX_RETRYABLE_CODE,
      });
    }
  }

  async readCoverage(principalIdValue: string, at: Date = this.now()): Promise<MemoryMeaningCoverage> {
    return readMemoryMeaningCoverage(this.options.database, principalIdValue, at);
  }

  private async readDeleteCandidates(
    principalId: string,
    timestamp: string,
    limit: number,
  ): Promise<readonly Readonly<{
    vectorLedgerId: Ulid;
    itemKind: "item" | "history_chunk";
    itemId: string;
    contentHash: Sha256Hex;
  }>[]> {
    const result = await this.options.database.prepare(`SELECT vector.vector_ledger_id,
        vector.item_kind, vector.item_id, vector.content_hash
      FROM memory_vectors vector
      WHERE vector.principal_id = ?1 AND vector.embedding_model = ?2
        AND vector.deleted_at IS NULL AND (
          vector.item_kind = 'item' AND NOT EXISTS (
            SELECT 1 FROM memory_retrievable_item_versions version
            WHERE version.principal_id = vector.principal_id
              AND version.version_id = vector.item_id
              AND version.text_hash = vector.content_hash
              AND (version.valid_from IS NULL OR version.valid_from <= ?3)
              AND (version.valid_to IS NULL OR version.valid_to > ?3)
          )
          OR vector.item_kind = 'history_chunk' AND NOT EXISTS (
            SELECT 1 FROM memory_retrievable_history_chunks chunk
            WHERE chunk.principal_id = vector.principal_id
              AND chunk.chunk_id = vector.item_id
              AND chunk.content_hash = vector.content_hash
          )
        )
      ORDER BY vector.upserted_at ASC, vector.vector_ledger_id ASC LIMIT ?4`)
      .bind(principalId, MEMORY_EMBEDDING_MODEL, timestamp, limit).all<DeleteCandidateRow>();
    return Object.freeze(result.results.map((row) => Object.freeze({
      vectorLedgerId: safeString(row.vector_ledger_id, 26, "memory_meaning_ledger_invalid") as Ulid,
      itemKind: safeKind(row.item_kind),
      itemId: safeString(row.item_id, 128, "memory_meaning_item_id_invalid"),
      contentHash: safeHash(row.content_hash),
    })));
  }

  private async readIndexCandidates(
    principalId: string,
    timestamp: string,
    limit: number,
  ): Promise<readonly ReturnType<typeof indexCandidate>[]> {
    const result = await this.options.database.prepare(`SELECT item_kind, item_id, text, content_hash
      FROM (
        SELECT 'item' AS item_kind, version.version_id AS item_id,
          version.text AS text, version.text_hash AS content_hash,
          version.created_at AS ordered_at
        FROM memory_retrievable_item_versions version
        WHERE version.principal_id = ?1
          AND (version.valid_from IS NULL OR version.valid_from <= ?2)
          AND (version.valid_to IS NULL OR version.valid_to > ?2)
          AND NOT EXISTS (
            SELECT 1 FROM memory_vectors vector
            WHERE vector.principal_id = version.principal_id
              AND vector.item_kind = 'item' AND vector.item_id = version.version_id
              AND vector.embedding_model = ?3 AND vector.content_hash = version.text_hash
          )
        UNION ALL
        SELECT 'history_chunk', chunk.chunk_id, chunk.text, chunk.content_hash,
          chunk.created_at
        FROM memory_retrievable_history_chunks chunk
        WHERE chunk.principal_id = ?1 AND NOT EXISTS (
          SELECT 1 FROM memory_vectors vector
          WHERE vector.principal_id = chunk.principal_id
            AND vector.item_kind = 'history_chunk' AND vector.item_id = chunk.chunk_id
            AND vector.embedding_model = ?3 AND vector.content_hash = chunk.content_hash
        )
      ) pending
      ORDER BY ordered_at ASC, item_kind ASC, item_id ASC LIMIT ?4`)
      .bind(principalId, timestamp, MEMORY_EMBEDDING_MODEL, limit).all<IndexCandidateRow>();
    const candidates: ReturnType<typeof indexCandidate>[] = [];
    let bytes = 0;
    for (const row of result.results) {
      const candidate = indexCandidate(row);
      const candidateBytes = encoder.encode(candidate.text).byteLength;
      if (candidates.length >= MEMORY_MEANING_INDEX_LIMITS.embeddingInputs
        || bytes + candidateBytes > MEMORY_MEANING_INDEX_LIMITS.embeddingInputBytes) break;
      bytes += candidateBytes;
      candidates.push(candidate);
    }
    return Object.freeze(candidates);
  }

  private async hasLiveLedgerRow(
    principalId: string,
    candidate: Readonly<{ itemKind: string; itemId: string; contentHash: Sha256Hex }>,
  ): Promise<boolean> {
    const row = await this.options.database.prepare(`SELECT vector_ledger_id FROM memory_vectors
      WHERE principal_id = ? AND item_kind = ? AND item_id = ?
        AND embedding_model = ? AND content_hash = ? AND deleted_at IS NULL`)
      .bind(principalId, candidate.itemKind, candidate.itemId, MEMORY_EMBEDDING_MODEL, candidate.contentHash)
      .first<Readonly<{ vector_ledger_id: unknown }>>();
    return row !== null;
  }

  private async hasPendingWork(principalId: string, timestamp: string): Promise<boolean> {
    const coverage = await this.readCoverage(principalId, new Date(timestamp));
    if (coverage.missing > 0) return true;
    const stale = await this.readDeleteCandidates(principalId, timestamp, 1);
    return stale.length > 0;
  }

  private async advanceCursor(principalId: string, timestamp: string): Promise<void> {
    const row = await this.options.database.prepare(`SELECT COALESCE(MAX(event_sequence), 0) AS maximum_sequence
      FROM (
        SELECT sequence AS event_sequence FROM events
        UNION ALL
        SELECT event_sequence FROM archive_segment_events
      )`).first<MaximumSequenceRow>();
    if (row === null || typeof row.maximum_sequence !== "number"
      || !Number.isSafeInteger(row.maximum_sequence) || row.maximum_sequence < 0) {
      throw new TypeError("memory_meaning_cursor_invalid");
    }
    const cursor = await this.options.database.prepare(`SELECT current_event_sequence, updated_at
      FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'embeddings'`)
      .bind(principalId).first<CursorRow>();
    if (cursor === null) {
      await this.options.database.prepare(`INSERT INTO memory_cursors (
        principal_id, cursor_name, current_event_sequence, updated_at
      ) VALUES (?, 'embeddings', ?, ?)`)
        .bind(principalId, row.maximum_sequence, timestamp).run();
      return;
    }
    const previous = safeCount(cursor.current_event_sequence);
    const updatedAt = safeString(cursor.updated_at, 32, "memory_meaning_cursor_invalid");
    await this.options.database.prepare(`UPDATE memory_cursors
      SET current_event_sequence = ?, updated_at = ?
      WHERE principal_id = ? AND cursor_name = 'embeddings'
        AND current_event_sequence = ? AND updated_at = ?`)
      .bind(Math.max(previous, row.maximum_sequence), timestamp, principalId, previous, updatedAt).run();
  }
}

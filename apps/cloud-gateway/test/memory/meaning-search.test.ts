import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type RedactedJsonValue,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import type { ContextRetriever, RetrievedContext } from "../../src/conversation/conversation-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL,
  MEMORY_MEANING_BINDING_MISSING_CODE,
  MEMORY_MEANING_INDEX_LIMITS,
  MemoryMeaningService,
  VectorizeMemoryVectorStore,
  WorkersAiMemoryEmbeddingProvider,
  readMemoryMeaningCoverage,
  type MeaningSearchHit,
  type MemoryEmbeddingProvider,
  type MemoryVectorMetadata,
  type MemoryVectorStore,
} from "../../src/memory/meaning-search.js";
import { MemoryOwnerControlsService } from "../../src/memory/memory-owner-controls.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import type {
  CanonicalMemoryItem,
  MemoryControlIntent,
  MemoryOwnerTurnInput,
} from "../../src/memory/memory-types.js";
import {
  TelegramMemoryRetriever,
  type TelegramMeaningSearchObservation,
} from "../../src/memory/telegram-memory-retriever.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

const ZERO_VECTOR = Object.freeze(Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0));
let serial = 0;
const redactor = new Redactor();

interface SeededTurn {
  readonly input: MemoryOwnerTurnInput;
}

interface MemoryFixture {
  readonly principalId: string;
  readonly controls: MemoryOwnerControlsService;
  readonly item: CanonicalMemoryItem;
  readonly sourceEventId: Ulid;
}

interface StoredVector {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata: MemoryVectorMetadata;
}

class FakeEmbeddings implements MemoryEmbeddingProvider {
  readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.calls.push([...texts]);
    return Object.freeze(texts.map((_text, index) => Object.freeze([
      index + 1,
      ...ZERO_VECTOR.slice(1),
    ])));
  }
}

class FakeVectors implements MemoryVectorStore {
  readonly upserts: StoredVector[] = [];
  readonly upsertCalls: StoredVector[][] = [];
  readonly deletes: string[] = [];
  readonly stored = new Map<string, StoredVector>();
  queryMatches: Array<Readonly<{
    id: string;
    score: number;
    metadata?: Readonly<Record<string, unknown>>;
  }>> = [];
  readonly queryCalls: Array<Readonly<{
    values: readonly number[];
    options: Readonly<{
      topK: number;
      returnMetadata: "all";
      filter: Readonly<{ principal: string }>;
    }>;
  }>> = [];
  mutation = 0;
  readonly mutationPrefix = newUlid();

  async upsert(vectors: readonly StoredVector[]): Promise<Readonly<{ mutationId: string }>> {
    if (vectors.length === 0) throw new Error("fake_vector_upsert_batch_invalid");
    this.upsertCalls.push([...vectors]);
    for (const vector of vectors) {
      this.upserts.push(vector);
      this.stored.set(vector.id, vector);
    }
    this.mutation += 1;
    return { mutationId: `${this.mutationPrefix}-upsert-${this.mutation}` };
  }

  async deleteByIds(ids: readonly string[]): Promise<Readonly<{ mutationId: string }>> {
    if (ids.length === 0) throw new Error("fake_vector_delete_batch_invalid");
    for (const id of ids) {
      this.deletes.push(id);
      this.stored.delete(id);
    }
    this.mutation += 1;
    return { mutationId: `${this.mutationPrefix}-delete-${this.mutation}` };
  }

  async query(
    values: readonly number[],
    options: Readonly<{
      topK: number;
      returnMetadata: "all";
      filter: Readonly<{ principal: string }>;
    }>,
  ): Promise<Readonly<{ matches: readonly Readonly<{
    id: string;
    score: number;
    metadata?: Readonly<Record<string, unknown>>;
  }>[] }>> {
    this.queryCalls.push(Object.freeze({ values: [...values], options }));
    return { matches: Object.freeze([...this.queryMatches]) };
  }

  liveHits(): readonly MeaningSearchHit[] {
    return Object.freeze([...this.stored.values()].map((vector, rank) => Object.freeze({
      vectorId: vector.id,
      score: 0.9 - rank / 100,
      itemKind: vector.metadata.itemKind,
      itemId: vector.metadata.itemId,
      contentHash: vector.metadata.contentHash,
    })));
  }
}

function redacted(value: unknown): RedactedJsonValue {
  if (typeof value === "string") {
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) throw new Error("meaning_search_fixture_redaction_failed");
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redacted);
  if (typeof value !== "object") throw new Error("meaning_search_fixture_payload_invalid");
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redacted(child)]));
}

async function seedPrincipal(): Promise<string> {
  serial += 1;
  const principalId = `principal:meaning-search:${serial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'meaning search test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

async function seedConversation(
  principalId: string,
  text: string,
  eventType: "conversation.user_committed" | "conversation.assistant_delivered",
): Promise<Readonly<{
  eventId: Ulid;
  eventSequence: number;
  occurredAt: string;
  envelopeHash: Sha256Hex;
}>> {
  serial += 1;
  const occurredAt = new Date(Date.now() + serial * 100 + 1).toISOString();
  const eventId = newUlid(new Date(occurredAt));
  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType,
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(new Date(Date.parse(occurredAt) + 1)),
    contentType: "application/json",
    payload: redacted({
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: true,
      text,
    }),
    producerVersion: "conversation-v1",
  });
  const requestHash = await sha256Hex(canonicalJson({ eventId }));
  const repository = new EventRepository(env.DB);
  const append = () => repository.append({
    envelope,
    scope: "meaning-search-test",
    key: `turn:${eventId}`,
    requestHash,
  });
  let appended: Awaited<ReturnType<typeof repository.append>>;
  if (eventType === "conversation.user_committed") {
    appended = await append();
  } else {
    const guard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'events_conversation_transition_guard'`)
      .first<{ sql: string }>();
    if (guard === null) throw new Error("meaning_search_conversation_guard_missing");
    await env.DB.prepare("DROP TRIGGER events_conversation_transition_guard").run();
    try {
      appended = await append();
    } finally {
      await env.DB.prepare(guard.sql).run();
    }
  }
  return Object.freeze({
    eventId,
    eventSequence: appended.eventSequence,
    occurredAt,
    envelopeHash: envelope.contentHash,
  });
}

async function seedTurn(
  principalId: string,
  text: string,
  memoryIntent: MemoryControlIntent,
): Promise<SeededTurn> {
  const event = await seedConversation(principalId, text, "conversation.user_committed");
  return Object.freeze({
    input: Object.freeze({
      principalId,
      eventId: event.eventId,
      eventSequence: event.eventSequence,
      occurredAt: event.occurredAt,
      channel: "telegram",
      memoryIntent,
      forwarded: false,
      quoted: false,
      pasted: false,
      hasAttachment: false,
      modelGenerated: false,
      toolGenerated: false,
      guest: false,
    }),
  });
}

async function remember(text: string): Promise<MemoryFixture> {
  const principalId = await seedPrincipal();
  const controls = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
  const turn = await seedTurn(principalId, `Remember that ${text}`, "remember");
  const receipt = await controls.remember({
    ownerTurn: turn.input,
    text,
    kind: "preference",
    sensitivity: "normal",
  });
  const item = await new MemoryRepository(env.DB).readCurrentItem(principalId, receipt.item.itemId);
  return { principalId, controls, item, sourceEventId: turn.input.eventId };
}

async function rememberAnother(
  principalId: string,
  controls: MemoryOwnerControlsService,
  text: string,
): Promise<CanonicalMemoryItem> {
  const turn = await seedTurn(principalId, `Remember that ${text}`, "remember");
  const receipt = await controls.remember({
    ownerTurn: turn.input,
    text,
    kind: "preference",
    sensitivity: "normal",
  });
  return new MemoryRepository(env.DB).readCurrentItem(principalId, receipt.item.itemId);
}

async function forget(fixture: MemoryFixture): Promise<void> {
  const turn = await seedTurn(fixture.principalId, "Forget that memory.", "forget");
  await fixture.controls.forget({ ownerTurn: turn.input, candidateItemIds: [fixture.item.itemId] });
}

async function lift(fixture: MemoryFixture): Promise<CanonicalMemoryItem> {
  const turn = await seedTurn(fixture.principalId, "Use that memory again.", "lift");
  const result = await fixture.controls.lift({
    ownerTurn: turn.input,
    candidateItemIds: [fixture.item.itemId],
  });
  return new MemoryRepository(env.DB).readCurrentItem(fixture.principalId, result.item.itemId);
}

function meaningHit(item: CanonicalMemoryItem, rank = 0): MeaningSearchHit {
  return Object.freeze({
    vectorId: String(rank + 1).padStart(64, "a") as Sha256Hex,
    score: 0.9 - rank / 100,
    itemKind: "item",
    itemId: item.version.versionId,
    contentHash: item.version.textHash,
  });
}

async function indexLiteralHistory(principalId: string): Promise<void> {
  const event = await env.DB.prepare(`SELECT sequence, envelope_json FROM events
    WHERE subject_id = ? AND event_type = 'conversation.user_committed'
    ORDER BY sequence ASC LIMIT 1`).bind(principalId)
    .first<{ sequence: number; envelope_json: string }>();
  if (event === null) throw new Error("meaning_search_history_event_missing");
  const decoded = JSON.parse(event.envelope_json) as { payload: { text: string } };
  const envelopeHash = await sha256Hex(canonicalJson(decoded));
  const textHash = await sha256Hex(decoded.payload.text);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(newUlid(), principalId, event.sequence, event.sequence, envelopeHash, now),
    env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        newUlid(), principalId, event.sequence, event.sequence, decoded.payload.text,
        textHash, envelopeHash, now, now,
      ),
  ]);
}

async function indexConversationAsHistory(input: Readonly<{
  principalId: string;
  eventId: Ulid;
  eventSequence: number;
  text: string;
  envelopeHash: Sha256Hex;
  chunkText?: string;
}>): Promise<MeaningSearchHit> {
  const chunkId = newUlid();
  const chunkText = input.chunkText ?? input.text;
  const contentHash = await sha256Hex(chunkText);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(
        newUlid(), input.principalId, input.eventSequence, input.eventSequence,
        input.envelopeHash, now,
      ),
    env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunkId, input.principalId, input.eventSequence, input.eventSequence,
        chunkText, contentHash, input.envelopeHash, now, now,
      ),
  ]);
  return Object.freeze({
    vectorId: await sha256Hex(`meaning-history:${chunkId}`),
    score: 0.9,
    itemKind: "history_chunk",
    itemId: input.eventId,
    contentHash,
  });
}

function delayedDatabase(delayMs: number): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement as object, {
      get(target, property): unknown {
        if (property === "bind") {
          return (...values: unknown[]) => wrap((target as D1PreparedStatement).bind(...values));
        }
        if (property === "first" || property === "all" || property === "run" || property === "raw") {
          return async (...args: unknown[]) => {
            await pause();
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => Promise<unknown>;
            return method.apply(target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
    originals.set(wrapped as object, statement);
    return wrapped;
  };
  return new Proxy(env.DB as object, {
    get(target, property): unknown {
      if (property === "prepare") {
        return (query: string) => wrap((target as D1Database).prepare(query));
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await pause();
          return (target as D1Database).batch(
            statements.map((statement) => originals.get(statement as object) ?? statement),
          );
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

async function historyHit(principalId: string): Promise<MeaningSearchHit> {
  const row = await env.DB.prepare(`SELECT chunk_id, content_hash FROM memory_history_chunks
    WHERE principal_id = ? ORDER BY start_event_sequence ASC LIMIT 1`)
    .bind(principalId).first<{ chunk_id: string; content_hash: string }>();
  if (row === null) throw new Error("meaning_search_history_chunk_missing");
  return Object.freeze({
    vectorId: "b".repeat(64) as Sha256Hex,
    score: 0.85,
    itemKind: "history_chunk",
    itemId: row.chunk_id,
    contentHash: row.content_hash as Sha256Hex,
  });
}

function baseContext(contexts: readonly RetrievedContext[] = []): ContextRetriever {
  return { async retrieve() { return Object.freeze([...contexts]); } };
}

async function retrieve(
  principalId: string,
  query: string,
  options: Readonly<{
    hits?: readonly MeaningSearchHit[];
    base?: readonly RetrievedContext[];
    observations?: TelegramMeaningSearchObservation[];
    search?: () => Promise<readonly MeaningSearchHit[]>;
    meaningSearchTimeoutMs?: number;
    database?: D1Database;
  }> = {},
): Promise<readonly RetrievedContext[]> {
  const retriever = new TelegramMemoryRetriever({
    database: options.database ?? env.DB,
    archive: env.ARCHIVE,
    baseContext: baseContext(options.base),
    meaningSearch: options.hits === undefined && options.search === undefined ? undefined : {
      search: options.search ?? (async () => options.hits ?? []),
    },
    meaningSearchTimeoutMs: options.meaningSearchTimeoutMs,
    observeMeaningSearch: (observation) => options.observations?.push(observation),
  });
  return retriever.retrieve({
    principalId,
    channel: "telegram",
    purpose: "conversation",
    query,
    maxTokens: 16_000,
  });
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
});

describe("memory meaning adapters", () => {
  it("sends the documented Workers AI embedding request and accepts its data rows", async () => {
    const run = vi.fn(async () => ({ data: [[...ZERO_VECTOR]] }));
    const provider = new WorkersAiMemoryEmbeddingProvider({ run } as unknown as Pick<Ai, "run">);

    await expect(provider.embed(["Where is my notebook?"])).resolves.toEqual([ZERO_VECTOR]);
    expect(run).toHaveBeenCalledWith(MEMORY_EMBEDDING_MODEL, {
      text: ["Where is my notebook?"],
    });
  });

  it("uses the documented Vectorize upsert, delete and query shapes", async () => {
    const upsert = vi.fn(async () => ({ mutationId: "upsert-mutation" }));
    const deleteByIds = vi.fn(async () => ({ mutationId: "delete-mutation" }));
    const query = vi.fn(async () => ({
      matches: [{
        id: "a".repeat(64),
        score: 0.75,
        metadata: {
          principal: "principal:adapter",
          itemKind: "item",
          itemId: newUlid(),
          contentHash: "b".repeat(64),
        },
      }],
    }));
    const store = new VectorizeMemoryVectorStore({
      upsert,
      deleteByIds,
      query,
    } as unknown as Vectorize);
    const vector = Object.freeze({
      id: "c".repeat(64),
      values: ZERO_VECTOR,
      metadata: Object.freeze({
        principal: "principal:adapter",
        itemKind: "item" as const,
        itemId: newUlid(),
        contentHash: "d".repeat(64) as Sha256Hex,
      }),
    });

    await expect(store.upsert([vector])).resolves.toEqual({ mutationId: "upsert-mutation" });
    await expect(store.deleteByIds([vector.id])).resolves.toEqual({ mutationId: "delete-mutation" });
    await expect(store.query(ZERO_VECTOR, {
      topK: 4,
      returnMetadata: "all",
      filter: { principal: "principal:adapter" },
    })).resolves.toEqual({ matches: [expect.objectContaining({ id: "a".repeat(64), score: 0.75 })] });
    expect(upsert).toHaveBeenCalledWith([{ ...vector, values: [...ZERO_VECTOR], metadata: { ...vector.metadata } }]);
    expect(deleteByIds).toHaveBeenCalledWith([vector.id]);
    expect(query).toHaveBeenCalledWith([...ZERO_VECTOR], {
      topK: 4,
      returnMetadata: "all",
      filter: { principal: "principal:adapter" },
    });
  });

  it("rejects cross-principal and malformed Vectorize matches while dropping low scores", async () => {
    const principalId = await seedPrincipal();
    const embeddings = new FakeEmbeddings();
    const vectors = new FakeVectors();
    const service = new MemoryMeaningService({ database: env.DB, embeddings, vectors });
    const validMetadata = Object.freeze({
      principal: principalId,
      itemKind: "item",
      itemId: newUlid(),
      contentHash: "e".repeat(64),
    });
    vectors.queryMatches = [{
      id: "f".repeat(64),
      score: 0.9,
      metadata: { ...validMetadata, principal: "principal:someone-else" },
    }];
    await expect(service.search({ principalId, query: "notebook" }))
      .rejects.toThrow("memory_meaning_result_invalid");

    vectors.queryMatches = [{
      id: "f".repeat(64),
      score: 0.9,
      metadata: { ...validMetadata, unexpected: true },
    }];
    await expect(service.search({ principalId, query: "notebook" }))
      .rejects.toThrow("memory_meaning_result_invalid");

    vectors.queryMatches = [{ id: "not-a-vector-id", score: Number.NaN, metadata: validMetadata }];
    await expect(service.search({ principalId, query: "notebook" }))
      .rejects.toThrow("memory_meaning_result_invalid");

    vectors.queryMatches = [{ id: "f".repeat(64), score: 0.44, metadata: validMetadata }];
    await expect(service.search({ principalId, query: "notebook" })).resolves.toEqual([]);
  });
});

describe("memory meaning indexing", () => {
  it("records one ledger row across a failed write retry and a duplicate run", async () => {
    const fixture = await remember("I really like math.");
    const embeddings = new FakeEmbeddings();
    const vectors = new FakeVectors();
    let fail = true;
    const service = new MemoryMeaningService({
      database: env.DB,
      embeddings,
      vectors,
      beforeLedgerWrite: () => {
        if (fail) {
          fail = false;
          throw new Error("injected ledger failure");
        }
      },
    });

    expect(await service.runIndexStep(fixture.principalId)).toMatchObject({
      outcome: "retryable_failure",
      upserted: 0,
      code: "memory_meaning_index_retryable",
    });
    expect(await env.DB.prepare(`SELECT current_event_sequence FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'embeddings'`)
      .bind(fixture.principalId).first()).toBeNull();

    expect(await service.runIndexStep(fixture.principalId)).toMatchObject({
      outcome: "indexed",
      upserted: 1,
      remaining: false,
    });
    expect(await service.runIndexStep(fixture.principalId)).toMatchObject({
      outcome: "indexed",
      upserted: 0,
      deleted: 0,
    });
    const ledger = await env.DB.prepare(`SELECT count(*) AS count FROM memory_vectors
      WHERE principal_id = ? AND embedding_model = ?`)
      .bind(fixture.principalId, MEMORY_EMBEDDING_MODEL).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
    expect(vectors.upserts).toHaveLength(2);
  });

  it("enforces the per-run embedding and Vectorize mutation caps", { timeout: 30_000 }, async () => {
    const fixture = await remember("cap item zero");
    for (let index = 1; index < MEMORY_MEANING_INDEX_LIMITS.mutations + 3; index += 1) {
      await rememberAnother(fixture.principalId, fixture.controls, `cap item ${index}`);
    }
    const embeddings = new FakeEmbeddings();
    const vectors = new FakeVectors();
    const result = await new MemoryMeaningService({ database: env.DB, embeddings, vectors })
      .runIndexStep(fixture.principalId);

    expect(result).toMatchObject({ outcome: "indexed", upserted: MEMORY_MEANING_INDEX_LIMITS.mutations, remaining: true });
    expect(embeddings.calls).toHaveLength(MEMORY_MEANING_INDEX_LIMITS.workersAiCalls);
    expect(embeddings.calls[0]).toHaveLength(MEMORY_MEANING_INDEX_LIMITS.embeddingInputs);
    expect(vectors.upserts).toHaveLength(MEMORY_MEANING_INDEX_LIMITS.embeddingInputs);
    expect(vectors.upsertCalls).toHaveLength(1);
  });

  it("deletes a forgotten version and re-embeds the new version produced by lift", async () => {
    const fixture = await remember("I prefer concise summaries.");
    const embeddings = new FakeEmbeddings();
    const vectors = new FakeVectors();
    const service = new MemoryMeaningService({ database: env.DB, embeddings, vectors });
    await service.runIndexStep(fixture.principalId);

    await forget(fixture);
    expect(await service.runIndexStep(fixture.principalId)).toMatchObject({ deleted: 1, upserted: 0 });
    const deleted = await env.DB.prepare(`SELECT deleted_at FROM memory_vectors
      WHERE principal_id = ? AND item_id = ?`)
      .bind(fixture.principalId, fixture.item.version.versionId)
      .first<{ deleted_at: string | null }>();
    expect(deleted?.deleted_at).not.toBeNull();
    expect(vectors.deletes).toHaveLength(1);

    const restored = await lift(fixture);
    expect(restored.version.versionId).not.toBe(fixture.item.version.versionId);
    expect(await service.runIndexStep(fixture.principalId)).toMatchObject({ upserted: 1, deleted: 0 });
    expect(vectors.upserts.at(-1)?.metadata.itemId).toBe(restored.version.versionId);
  });

  it("reports eligible current targets against live current-model ledger rows", async () => {
    const fixture = await remember("Coverage should be visible.");
    expect(await readMemoryMeaningCoverage(env.DB, fixture.principalId)).toEqual({
      eligible: 1,
      indexed: 0,
      missing: 1,
    });
    const service = new MemoryMeaningService({
      database: env.DB,
      embeddings: new FakeEmbeddings(),
      vectors: new FakeVectors(),
    });
    await service.runIndexStep(fixture.principalId);
    expect(await service.readCoverage(fixture.principalId)).toEqual({
      eligible: 1,
      indexed: 1,
      missing: 0,
    });
  });

  it("indexes a history chunk without putting memory text in Vectorize metadata", async () => {
    const fixture = await remember("The telescope is in the hall cupboard.");
    await indexLiteralHistory(fixture.principalId);
    const embeddings = new FakeEmbeddings();
    const vectors = new FakeVectors();

    expect(await new MemoryMeaningService({ database: env.DB, embeddings, vectors })
      .runIndexStep(fixture.principalId)).toMatchObject({ upserted: 2, remaining: false });
    const history = vectors.upserts.find((vector) => vector.metadata.itemKind === "history_chunk");
    expect(history).toBeDefined();
    expect(history?.metadata).toEqual({
      principal: fixture.principalId,
      itemKind: "history_chunk",
      itemId: expect.any(String),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(history?.metadata)).not.toContain("telescope");
  });

  it("indexes owner history only and deletes an old assistant-chunk vector", async () => {
    const principalId = await seedPrincipal();
    const assistantText = "Your bike lock word is marigold.";
    const assistant = await seedConversation(
      principalId,
      assistantText,
      "conversation.assistant_delivered",
    );
    await indexConversationAsHistory({
      principalId,
      ...assistant,
      text: assistantText,
    });
    const chunk = await env.DB.prepare(`SELECT chunk_id, content_hash FROM memory_history_chunks
      WHERE principal_id = ? AND start_event_sequence = ?`)
      .bind(principalId, assistant.eventSequence)
      .first<{ chunk_id: string; content_hash: Sha256Hex }>();
    if (chunk === null) throw new Error("meaning_search_assistant_chunk_missing");
    const timestamp = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO memory_vectors (
      vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
      dimensions, content_hash, mutation_id, upserted_at, deleted_at
    ) VALUES (?, ?, 'history_chunk', ?, ?, ?, ?, ?, ?, NULL)`)
      .bind(
        newUlid(), principalId, chunk.chunk_id, MEMORY_EMBEDDING_MODEL,
        MEMORY_EMBEDDING_DIMENSIONS, chunk.content_hash, newUlid(), timestamp,
      ).run();
    const embeddings = new FakeEmbeddings();
    const vectors = new FakeVectors();

    expect(await new MemoryMeaningService({ database: env.DB, embeddings, vectors })
      .runIndexStep(principalId)).toMatchObject({ upserted: 0, deleted: 1, remaining: false });
    expect(embeddings.calls).toEqual([]);
    expect(vectors.deletes).toHaveLength(1);
  });

  it("puts newest memory items before older pending history in one batched upsert", async () => {
    const fixture = await remember("The first remembered fact.");
    for (let index = 0; index < 9; index += 1) {
      const text = `Older history line ${index} about weekend plans.`;
      const event = await seedConversation(
        fixture.principalId,
        text,
        "conversation.user_committed",
      );
      await indexConversationAsHistory({
        principalId: fixture.principalId,
        ...event,
        text,
      });
    }
    const newest = await rememberAnother(
      fixture.principalId,
      fixture.controls,
      "My dentist appointment is Tuesday.",
    );
    const vectors = new FakeVectors();
    await new MemoryMeaningService({
      database: env.DB,
      embeddings: new FakeEmbeddings(),
      vectors,
    }).runIndexStep(fixture.principalId);

    expect(vectors.upsertCalls).toHaveLength(1);
    expect(vectors.upserts[0]?.metadata.itemId).toBe(newest.version.versionId);
    expect(vectors.upserts.some((vector) => vector.metadata.itemKind === "history_chunk")).toBe(true);
  });
});

describe("Telegram meaning recall", () => {
  it("finds a paraphrased favourite-subject question only through meaning search", async () => {
    const fixture = await remember("I really like math.");
    const keywordOnly = await retrieve(fixture.principalId, "What's my favourite subject?");
    const semantic = await retrieve(fixture.principalId, "What's my favourite subject?", {
      hits: [meaningHit(fixture.item)],
    });

    expect(keywordOnly).toEqual([]);
    expect(semantic).toHaveLength(1);
    expect(semantic[0]?.text).toContain("I really like math.");
    expect(semantic[0]?.sourceEventId).toBe(fixture.sourceEventId);
  });

  it("uses reciprocal-rank fusion so a hit present in both lists outranks a meaning-only hit", async () => {
    const fixture = await remember("Biology subject notes are in the green folder.");
    const meaningOnly = await rememberAnother(
      fixture.principalId,
      fixture.controls,
      "The spare key is behind the picture frame.",
    );
    const contexts = await retrieve(fixture.principalId, "Where are my subject notes?", {
      hits: [meaningHit(meaningOnly), meaningHit(fixture.item, 1)],
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.text).toContain("Biology subject notes");
    expect(contexts[1]?.text).toContain("spare key");
  });

  it("rejects a forgotten item and its suppressed history chunk while their vectors still exist", async () => {
    const fixture = await remember("I really like math.");
    await indexLiteralHistory(fixture.principalId);
    const chunk = await historyHit(fixture.principalId);
    await forget(fixture);

    const contexts = await retrieve(fixture.principalId, "What subject do I enjoy?", {
      hits: [meaningHit(fixture.item), chunk],
    });
    expect(contexts).toEqual([]);
  });

  it("never returns an assistant reply through a stale meaning-history hit", async () => {
    const principalId = await seedPrincipal();
    const text = "Your bike lock word is marigold.";
    const assistant = await seedConversation(
      principalId,
      text,
      "conversation.assistant_delivered",
    );
    const hit = await indexConversationAsHistory({
      principalId,
      ...assistant,
      text,
    });

    const contexts = await retrieve(principalId, "How do I open my bicycle padlock?", {
      hits: [hit],
    });
    expect(contexts).toEqual([]);
  });

  it("checks the exact event text hash before meaning history enters context", async () => {
    const principalId = await seedPrincipal();
    const text = "The chemistry report is due Thursday.";
    const event = await seedConversation(principalId, text, "conversation.user_committed");
    const hit = await indexConversationAsHistory({
      principalId,
      ...event,
      text,
      chunkText: "The chemistry report is due Friday.",
    });
    const observations: TelegramMeaningSearchObservation[] = [];

    const contexts = await retrieve(principalId, "When is the chemistry report due?", {
      hits: [hit],
      observations,
    });
    expect(contexts).toEqual([]);
    expect(observations[0]?.fallbackCode).toBe("memory_meaning_search_provider_error");
  });

  it("skips a meaning row with no event id without losing valid hits", async () => {
    const fixture = await remember("My blue notebook is upstairs.");
    const eventSequence = 1_000_000_000 + serial;
    const chunkId = newUlid();
    const orphanText = "An orphaned history row must not erase valid meaning results.";
    const orphanHash = await sha256Hex(orphanText);
    const timestamp = new Date().toISOString();
    const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'memory_history_coverage_insert_guard', 'memory_history_chunks_insert_guard'
      )`).all<{ name: string; sql: string }>();
    for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER ${guard.name}`).run();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO memory_history_coverage (
          coverage_id, principal_id, source_location, start_event_sequence,
          end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
          failure_code, indexed_at
        ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
          .bind(
            newUlid(), fixture.principalId, eventSequence, eventSequence,
            "7".repeat(64), timestamp,
          ),
        env.DB.prepare(`INSERT INTO memory_history_chunks (
          chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
          content_hash, source_location, r2_segment_id, source_receipt_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)`)
          .bind(
            chunkId, fixture.principalId, eventSequence, eventSequence,
            orphanText, orphanHash, "7".repeat(64), timestamp, timestamp,
          ),
      ]);
    } finally {
      for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
    }
    const missingHistory: MeaningSearchHit = Object.freeze({
      vectorId: "9".repeat(64),
      score: 0.95,
      itemKind: "history_chunk",
      itemId: chunkId,
      contentHash: orphanHash,
    });

    const contexts = await retrieve(fixture.principalId, "Where is my notebook?", {
      hits: [missingHistory, meaningHit(fixture.item)],
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.text).toContain("blue notebook");
  });

  it("labels meaning-history evidence with time, channel and owner without a segment hash", async () => {
    const principalId = await seedPrincipal();
    const text = "The chemistry report is due Thursday.";
    const event = await seedConversation(principalId, text, "conversation.user_committed");
    const hit = await indexConversationAsHistory({ principalId, ...event, text });

    const contexts = await retrieve(principalId, "When is the science write-up due?", {
      hits: [hit],
    });
    expect(contexts[0]?.text).toContain(`${event.occurredAt}; telegram; speaker owner]`);
    expect(contexts[0]?.text).not.toContain(hit.contentHash);
  });

  it("does not repeat a recent turn as meaning-history evidence", async () => {
    const principalId = await seedPrincipal();
    const text = "The chemistry report is due Thursday.";
    const event = await seedConversation(principalId, text, "conversation.user_committed");
    const hit = await indexConversationAsHistory({ principalId, ...event, text });
    const recent = Object.freeze({
      sourceEventId: event.eventId,
      text,
      sensitivity: "personal" as const,
    });

    const contexts = await retrieve(principalId, "When is the science write-up due?", {
      base: [recent],
      hits: [hit],
    });
    expect(contexts.filter((context) => context.sourceEventId === event.eventId)).toEqual([recent]);
  });

  it("returns the new eligible version after a lift", async () => {
    const fixture = await remember("I really like math.");
    await forget(fixture);
    const restored = await lift(fixture);

    const contexts = await retrieve(fixture.principalId, "What's my favourite subject?", {
      hits: [meaningHit(restored)],
    });
    expect(contexts[0]?.text).toContain("I really like math.");
  });

  it("falls back to keyword recall with a named code when bindings are absent", async () => {
    const fixture = await remember("My blue notebook is upstairs.");
    const observations: TelegramMeaningSearchObservation[] = [];
    const contexts = await retrieve(fixture.principalId, "Where is my blue notebook?", { observations });

    expect(contexts[0]?.text).toContain("blue notebook");
    expect(observations).toEqual([{
      meaningSearchMs: 0,
      fallbackCode: MEMORY_MEANING_BINDING_MISSING_CODE,
    }]);
  });

  it("keeps keyword recall when the meaning provider fails", async () => {
    const fixture = await remember("My blue notebook is upstairs.");
    const observations: TelegramMeaningSearchObservation[] = [];
    const contexts = await retrieve(fixture.principalId, "Where is my blue notebook?", {
      observations,
      search: async () => { throw new Error("private provider response"); },
    });

    expect(contexts[0]?.text).toContain("blue notebook");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.fallbackCode).toBe("memory_meaning_search_provider_error");
    expect(JSON.stringify(observations)).not.toContain("private provider response");
  });

  it("cuts off meaning search at 450 ms while retaining keyword and recent context within 800 ms", async () => {
    const fixture = await remember("My blue notebook is upstairs.");
    const recent = Object.freeze({
      sourceEventId: fixture.sourceEventId,
      text: "The immediately preceding conversation stays present.",
      sensitivity: "personal" as const,
    });
    const observations: TelegramMeaningSearchObservation[] = [];
    const startedAt = performance.now();
    const contexts = await retrieve(fixture.principalId, "Where is my blue notebook?", {
      base: [recent],
      observations,
      search: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return [meaningHit(fixture.item)];
      },
      meaningSearchTimeoutMs: 450,
    });
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(800);
    expect(contexts.some((context) => context.text.includes("blue notebook"))).toBe(true);
    expect(contexts).toContainEqual(recent);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.fallbackCode).toBe("memory_meaning_search_timeout");
    expect(observations[0]?.meaningSearchMs).toBeGreaterThanOrEqual(440);
  });

  it("keeps keyword recall under 800 ms when every D1 round trip costs 25 ms and meaning is enabled", { timeout: 30_000 }, async () => {
    const fixture = await remember("My blue notebook is upstairs.");
    const fillers = [];
    for (const text of [
      "My pencils are in the desk.",
      "My ruler is in the backpack.",
      "My eraser is beside the lamp.",
    ]) {
      fillers.push(await rememberAnother(fixture.principalId, fixture.controls, text));
    }
    const observations: TelegramMeaningSearchObservation[] = [];
    const startedAt = performance.now();
    const contexts = await retrieve(fixture.principalId, "Where is my blue notebook?", {
      database: delayedDatabase(25),
      observations,
      hits: [...fillers, fixture.item].map((item, rank) => meaningHit(item, rank)),
    });
    const elapsedMs = performance.now() - startedAt;

    expect(contexts.some((context) => context.text.includes("blue notebook"))).toBe(true);
    expect(elapsedMs).toBeLessThan(800);
    expect(observations).toHaveLength(1);
  });

  it("makes no embedding call for a greeting with no content terms", async () => {
    const fixture = await remember("I really like math.");
    const search = vi.fn(async () => [meaningHit(fixture.item)]);
    const observations: TelegramMeaningSearchObservation[] = [];
    await retrieve(fixture.principalId, "hi", { search, observations });

    expect(search).not.toHaveBeenCalled();
    expect(observations).toEqual([{ meaningSearchMs: 0, fallbackCode: null }]);
  });

  it.each(["thanks!", "ok cool", "what's up", "lol", "good night", "yes"])(
    "makes no meaning call for the short acknowledgement %s",
    async (message) => {
      const fixture = await remember("I really like math.");
      const search = vi.fn(async () => [meaningHit(fixture.item)]);

      await retrieve(fixture.principalId, message, { search });

      expect(search).not.toHaveBeenCalled();
    },
  );

  it("still searches meaning for a real short question", async () => {
    const fixture = await remember("My key is in the blue bowl.");
    const search = vi.fn(async () => [meaningHit(fixture.item)]);

    await retrieve(fixture.principalId, "Where's my key?", { search });

    expect(search).toHaveBeenCalledOnce();
  });
});

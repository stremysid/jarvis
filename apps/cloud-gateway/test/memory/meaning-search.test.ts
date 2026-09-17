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
  readonly deletes: string[] = [];
  readonly stored = new Map<string, StoredVector>();
  mutation = 0;
  readonly mutationPrefix = newUlid();

  async upsert(vectors: readonly StoredVector[]): Promise<Readonly<{ mutationId: string }>> {
    const vector = vectors[0];
    if (vectors.length !== 1 || vector === undefined) throw new Error("fake_vector_upsert_batch_invalid");
    this.upserts.push(vector);
    this.stored.set(vector.id, vector);
    this.mutation += 1;
    return { mutationId: `${this.mutationPrefix}-upsert-${this.mutation}` };
  }

  async deleteByIds(ids: readonly string[]): Promise<Readonly<{ mutationId: string }>> {
    if (ids.length !== 1 || ids[0] === undefined) throw new Error("fake_vector_delete_batch_invalid");
    this.deletes.push(ids[0]);
    this.stored.delete(ids[0]);
    this.mutation += 1;
    return { mutationId: `${this.mutationPrefix}-delete-${this.mutation}` };
  }

  async query(): Promise<Readonly<{ matches: readonly [] }>> {
    return { matches: Object.freeze([]) };
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

async function seedTurn(
  principalId: string,
  text: string,
  memoryIntent: MemoryControlIntent,
): Promise<SeededTurn> {
  const occurredAt = new Date(Date.now() + serial * 100 + 1).toISOString();
  const eventId = newUlid(new Date(occurredAt));
  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
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
  const appended = await new EventRepository(env.DB).append({
    envelope,
    scope: "meaning-search-test",
    key: `turn:${eventId}`,
    requestHash: await sha256Hex(canonicalJson({ eventId })),
  });
  return Object.freeze({
    input: Object.freeze({
      principalId,
      eventId,
      eventSequence: appended.eventSequence,
      occurredAt,
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
  }> = {},
): Promise<readonly RetrievedContext[]> {
  const retriever = new TelegramMemoryRetriever({
    database: env.DB,
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

  it("enforces the per-run embedding and Vectorize mutation caps", async () => {
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
    expect(vectors.upserts).toHaveLength(MEMORY_MEANING_INDEX_LIMITS.vectorizeMutations);
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

  it("makes no embedding call for a greeting with no content terms", async () => {
    const fixture = await remember("I really like math.");
    const search = vi.fn(async () => [meaningHit(fixture.item)]);
    const observations: TelegramMeaningSearchObservation[] = [];
    await retrieve(fixture.principalId, "hi", { search, observations });

    expect(search).not.toHaveBeenCalled();
    expect(observations).toEqual([{ meaningSearchMs: 0, fallbackCode: null }]);
  });
});

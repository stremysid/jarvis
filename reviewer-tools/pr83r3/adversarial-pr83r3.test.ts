import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  validateEnvelope,
  type PersistableEventEnvelopeV1,
} from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { classifyTelegramUpdate } from "../../src/channels/telegram/telegram-types.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import {
  D1TelegramIdentityResolver,
  DefaultOutboxDispatcher,
} from "../../src/conversation/outbox-dispatcher.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import { AutomaticMemoryDistillationWorkflow } from "../../src/memory/automatic-distillation.js";
import {
  TelegramMemoryControlModelAdapter,
} from "../../src/memory/telegram-memory-controls.js";
import {
  TELEGRAM_MEMORY_RETRIEVAL_LIMITS,
  TelegramMemoryRetriever,
  type TelegramMemoryRetrievalLogCode,
  type TelegramMemoryRetrievalMetrics,
  type TelegramMemoryRetrievalTimings,
} from "../../src/memory/telegram-memory-retriever.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { parseTelegramMemoryControl } from "../../src/memory/telegram-memory-language.js";
import type {
  ModelAdapter,
  ModelAdapterStreamInput,
  ModelToken,
} from "../../src/model/model-adapter.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";
import { projectionSourceText } from "../../src/sync/memory-projection.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MemoryMeaningService,
  WorkersAiMemoryEmbeddingProvider,
  readMemoryMeaningCoverage,
  type MeaningSearchReader,
  type MemoryEmbeddingProvider,
  type MemoryVectorMetadata,
  type MemoryVectorStore,
} from "../../src/memory/meaning-search.js";
import type { TelegramMeaningSearchObservation } from "../../src/memory/telegram-memory-retriever.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import type { RetrievedContext } from "../../src/model/model-types.js";

const OWNER_ID = "principal:telegram-memory-owner";
const GUEST_ID = "principal:telegram-memory-guest";
const RETRIEVAL_ID = "principal:telegram-memory-retrieval";
let markerPrincipalSerial = 0;
let servicePrincipalSerial = 0;

class RecordingModel implements ModelAdapter {
  calls = 0;
  readonly inputs: ModelAdapterStreamInput[] = [];

  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.calls += 1;
    this.inputs.push(input);
    yield Object.freeze({ index: 0, text: "ordinary conversation" });
  }
}

class EchoModel extends RecordingModel {
  override async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.calls += 1;
    this.inputs.push(input);
    yield Object.freeze({ index: 0, text: `Noted: ${input.userText.replace(/^My /u, "your ")}` });
  }
}

class FixedReplyModel extends RecordingModel {
  constructor(private readonly reply: string) {
    super();
  }

  override async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.calls += 1;
    this.inputs.push(input);
    yield Object.freeze({ index: 0, text: this.reply });
  }
}

interface D1Stats {
  statements: number;
  roundTrips: number;
  inflight: number;
  maxInflight: number;
}

function newD1Stats(): D1Stats {
  return { statements: 0, roundTrips: 0, inflight: 0, maxInflight: 0 };
}

function countingDatabase(
  database: D1Database,
  stats: D1Stats,
  delayFor: (sql: string) => number = () => 0,
): D1Database {
  const statements = new WeakMap<object, Readonly<{ statement: D1PreparedStatement; sql: string }>>();
  const delayed = async <T>(statementCount: number, sql: readonly string[], operation: () => Promise<T>): Promise<T> => {
    stats.statements += statementCount;
    stats.roundTrips += 1;
    stats.inflight += 1;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    try {
      const delayMs = Math.max(0, ...sql.map((text) => delayFor(text)));
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return await operation();
    } finally {
      stats.inflight -= 1;
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement as object, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap((target as D1PreparedStatement).bind(...values), sql);
        }
        if (property === "first" || property === "all" || property === "run" || property === "raw") {
          return (...args: unknown[]) => delayed(1, [sql], async () => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => Promise<unknown>;
            return method.apply(target, args);
          });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
      },
    }) as D1PreparedStatement;
    statements.set(proxy as object, Object.freeze({ statement, sql }));
    return proxy;
  };
  return new Proxy(database as object, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap((target as D1Database).prepare(sql), sql);
      if (property === "batch") {
        return (input: D1PreparedStatement[]) => {
          const captured = input.map((statement) => statements.get(statement as object)
            ?? Object.freeze({ statement, sql: "" }));
          return delayed(captured.length, captured.map(({ sql }) => sql), () =>
            (target as D1Database).batch(captured.map(({ statement }) => statement)));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

async function seedPrincipal(principalId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'telegram memory test', ?, ?)`).bind(
    principalId,
    now,
    now,
  ).run();
}

interface ServicePrincipal {
  readonly principalId: string;
  readonly identityId: string;
}

async function seedServicePrincipal(label: string): Promise<ServicePrincipal> {
  servicePrincipalSerial += 1;
  const principalId = `principal:telegram-service-${label}-${servicePrincipalSerial}`;
  const identityId = `identity:telegram-service-${label}-${servicePrincipalSerial}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'telegram service test', ?, ?)`).bind(principalId, now, now),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(
      identityId,
      principalId,
      String(8_000_000 + servicePrincipalSerial),
      now,
      now,
    ),
  ]);
  return Object.freeze({ principalId, identityId });
}

function productionService(options: {
  readonly who: ServicePrincipal;
  readonly ownerPrincipalId: string;
  readonly text: string;
  readonly model: RecordingModel;
  readonly telegram: FakeTelegramProvider;
  readonly metadata?: Record<string, unknown>;
  readonly retrieverDatabase?: D1Database;
  readonly meaningSearch?: MeaningSearchReader;
  readonly observeMeaningSearch?: (observation: TelegramMeaningSearchObservation) => void;
  readonly retrievalTimeoutMs?: number;
  readonly baseRetrievalTimeoutMs?: number;
  readonly log?: (
    code: TelegramMemoryRetrievalLogCode,
    timings: TelegramMemoryRetrievalTimings,
  ) => void;
}): DefaultConversationService {
  const classified = classifyTelegramUpdate({
    update_id: servicePrincipalSerial,
    message: {
      message_id: servicePrincipalSerial,
      from: { id: 12345 },
      chat: { id: 12345 },
      text: options.text,
      ...options.metadata,
    },
  });
  if (classified.kind !== "text") throw new Error("telegram_service_classification_failed");
  const events = new EventRepository(env.DB);
  const repository = buildTelegramConversationRepository(
    env.DB,
    events,
    {
      principalId: options.who.principalId,
      isDirectText: classified.value.isDirectText,
      isMemoryControlAuthoritative: classified.value.isMemoryControlAuthoritative,
    },
    options.ownerPrincipalId,
  );
  const memory = new TelegramMemoryRetriever({
    database: options.retrieverDatabase ?? env.DB,
    archive: env.ARCHIVE,
    controlAuthority: options.who.principalId === options.ownerPrincipalId
      && classified.value.isMemoryControlAuthoritative
      ? { principalId: options.who.principalId, text: options.text }
      : null,
    ...(options.retrievalTimeoutMs === undefined
      ? {}
      : { retrievalTimeoutMs: options.retrievalTimeoutMs }),
    ...(options.baseRetrievalTimeoutMs === undefined
      ? {}
      : { baseRetrievalTimeoutMs: options.baseRetrievalTimeoutMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.meaningSearch === undefined ? {} : { meaningSearch: options.meaningSearch }),
    ...(options.observeMeaningSearch === undefined ? {} : { observeMeaningSearch: options.observeMeaningSearch }),
  });
  const model = new TelegramMemoryControlModelAdapter({
    database: env.DB,
    archive: env.ARCHIVE,
    fallbackModel: options.model,
    ownerPrincipalId: options.ownerPrincipalId,
    authority: {
      principalId: options.who.principalId,
      text: options.text,
      isDirectText: classified.value.isMemoryControlAuthoritative,
    },
    targets: memory,
  });
  return new DefaultConversationService({
    repository,
    model,
    context: memory,
    dispatcher: new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", options.telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
    }),
    redactor: new Redactor(),
  });
}

async function sendProduction(options: Parameters<typeof productionService>[0]) {
  return productionService(options).handleTurn({
    sessionId: `telegram:${options.who.principalId}`,
    principalId: options.who.principalId,
    turnId: newUlid(),
    text: options.text,
    signal: new AbortController().signal,
    channel: "telegram",
    kind: "outbox",
    targetIdentityId: options.who.identityId,
    replyToMessageId: servicePrincipalSerial,
  });
}

async function latestUserEvent(principalId: string): Promise<Readonly<{
  eventId: ReturnType<typeof newUlid>;
  sequence: number;
  occurredAt: string;
}>> {
  const row = await env.DB.prepare(`SELECT event_id, sequence, occurred_at FROM events
    WHERE subject_id = ? AND event_type = 'conversation.user_committed'
    ORDER BY sequence DESC LIMIT 1`).bind(principalId)
    .first<{ event_id: string; sequence: number; occurred_at: string }>();
  if (row === null) throw new Error("telegram_memory_user_event_missing");
  return Object.freeze({
    eventId: row.event_id as ReturnType<typeof newUlid>,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
  });
}

async function commitTestItem(options: Readonly<{
  principalId: string;
  text: string;
  creation: Awaited<ReturnType<typeof latestUserEvent>>;
  source?: Awaited<ReturnType<typeof latestUserEvent>>;
  state?: "active" | "proposed";
  uncertain?: boolean;
}>): Promise<ReturnType<typeof newUlid>> {
  const memory = new MemoryRepository(env.DB);
  const topics = await memory.bootstrapTopics(options.principalId);
  const itemId = newUlid();
  const source = options.source ?? options.creation;
  await memory.commitInitialItem({
    principalId: options.principalId,
    itemId,
    kind: "fact",
    creationEventId: options.creation.eventId,
    creationEventSequence: options.creation.sequence,
    version: {
      versionId: newUlid(),
      text: options.text,
      textHash: await sha256Hex(options.text),
      basis: options.uncertain ? "inferred" : "stated",
      origin: options.uncertain ? "model" : "authenticated_first_person",
      uncertain: options.uncertain ?? false,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "telegram-memory-runtime-test-v1",
      extractorModelId: options.uncertain ? "openai:telegram-memory-runtime-test" : null,
    },
    sources: [{
      sourceId: newUlid(),
      eventId: source.eventId,
      eventSequence: source.sequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: options.text,
      excerptHash: await sha256Hex(options.text),
      channel: "telegram",
      occurredAt: source.occurredAt,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState: options.state ?? "active",
      reason: "telegram memory runtime test",
      policyVersion: "telegram-memory-runtime-test-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule",
      confidence: 0.4,
      reason: "telegram memory runtime test",
    },
  });
  return itemId;
}

interface LatencyFixture {
  readonly history: LiteralHistoryService;
  readonly favoriteSubjectItemId: ReturnType<typeof newUlid>;
}

async function latencyEnvelope(
  principalId: string,
  text: string,
  occurredAt: string,
  conversation: boolean,
): Promise<PersistableEventEnvelopeV1> {
  const token = new Redactor().redactText(text);
  if (!token.ok || token.text !== text) throw new Error("telegram_memory_latency_redaction_failed");
  return createEnvelope({
    schemaVersion: "1.0",
    eventId: newUlid(new Date(occurredAt)),
    eventType: conversation ? "conversation.user_committed" : "fixture.background",
    source: conversation ? "conversation" : "fixture",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(new Date(Date.parse(occurredAt) + 1)),
    contentType: "application/json",
    payload: {
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: true,
      text: token,
      directOwnerText: true,
    },
    producerVersion: conversation ? "conversation-v1" : "fixture-v1",
  });
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
  await seedPrincipal(OWNER_ID);
  await seedPrincipal(GUEST_ID);
  await seedPrincipal(RETRIEVAL_ID);
});

// ---------------------------------------------------------------------------
// PR #85 adversarial review
// ---------------------------------------------------------------------------

async function advAppendConversation(
  events: EventRepository,
  principalId: string,
  text: string,
  occurredAt: string,
): Promise<Awaited<ReturnType<EventRepository["append"]>>> {
  const envelope = await latencyEnvelope(principalId, text, occurredAt, true);
  return events.append({
    envelope,
    scope: "adv-pr87",
    key: `adv:${envelope.eventId}`,
    requestHash: await sha256Hex(canonicalJson({ key: envelope.eventId })),
  });
}

async function advInsertConversation(principalId: string, texts: readonly string[], startMs: number): Promise<void> {
  const envelopes: PersistableEventEnvelopeV1[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    envelopes.push(await latencyEnvelope(principalId, texts[index]!, new Date(startMs + index * 1_000).toISOString(), true));
  }
  for (let start = 0; start < envelopes.length; start += 50) {
    await env.DB.batch(envelopes.slice(start, start + 50).map((envelope) => env.DB.prepare(
      `INSERT INTO events (
        event_id, event_type, source, subject_id, occurred_at, received_at,
        content_hash, envelope_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      envelope.eventId, envelope.eventType, envelope.source, envelope.subjectId,
      envelope.occurredAt, envelope.receivedAt, envelope.contentHash,
      canonicalJson(envelope), envelope.receivedAt,
    )));
  }
}

async function advIndexHistory(principalId: string, events: EventRepository | TieredEventReader): Promise<void> {
  const archiveState = new ArchiveRepository(env.DB);
  const history = new LiteralHistoryService({
    database: env.DB,
    events,
    archive: archiveState,
    now: () => new Date(),
    nextId: () => newUlid(),
  });
  for (let step = 0; step < 256; step += 1) {
    const result = await history.indexNext({ principalId, maxEvents: 16, maxTextBytes: 262_144 });
    if (result.complete) return;
  }
  throw new Error("adv_history_incomplete");
}

function advTiered(): TieredEventReader {
  const live = new EventRepository(env.DB);
  return new TieredEventReader({
    archive: new ArchivalService({ database: env.DB, bucket: env.ARCHIVE }),
    live,
    state: new ArchiveRepository(env.DB),
  });
}

async function setArchiveCircuit(state: "open" | "closed"): Promise<void> {
  const triggers = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'archive_state'",
  ).all<{ name: string; sql: string }>();
  for (const trigger of triggers.results) await env.DB.exec(`DROP TRIGGER ${trigger.name}`);
  try {
    await env.DB.prepare(state === "open"
      ? "UPDATE archive_state SET circuit_state = 'open', circuit_reason = 'archive_adv_test', circuit_opened_at = ?1, updated_at = ?1 WHERE singleton = 1"
      : "UPDATE archive_state SET circuit_state = 'closed', circuit_reason = NULL, circuit_opened_at = NULL, updated_at = ?1 WHERE singleton = 1")
      .bind(new Date().toISOString()).run();
  } finally {
    for (const trigger of triggers.results) await env.DB.prepare(trigger.sql).run();
  }
}

function hasMemoryEvidence(contexts: readonly RetrievedContext[], text: string): boolean {
  return contexts.some((context) => /^(Uncertain memory evidence|Memory evidence) \[/u.test(context.text)
    && context.text.includes(text));
}


// ---------------------------------------------------------------------------
// PR #87 narrow review (head 5f3c1ce)
// ---------------------------------------------------------------------------

const DUMP = false;
const dump: Record<string, unknown> = {};
function dumpLog(key: string, value: string): void { dump[key] = JSON.parse(value); console.log(key, value); }

const QUESTION = "Where did I put the quartz stapler?";
const STATEMENT = "I put the quartz stapler beside the green printer.";

function historyTexts(contexts: readonly RetrievedContext[]): readonly string[] {
  return contexts.filter((c) => c.text.startsWith("History evidence"))
    .map((c) => c.text.replace(/^History evidence \[[^\]]*\]: /u, ""));
}

function fillers(label: string, count = 70): readonly string[] {
  return Array.from({ length: count }, (_u, i) => `Filler ${label} turn ${i} about lunch plans.`);
}

async function seedArchivedMemories(ownerLabel: string): Promise<Readonly<{
  owner: ServicePrincipal;
  memoryTexts: readonly string[];
  itemIds: readonly ReturnType<typeof newUlid>[];
  archival: ArchivalService;
}>> {
  await resetArchiveFixture();
  const owner = await seedServicePrincipal(ownerLabel);
  const events = new EventRepository(env.DB);
  const old = Date.parse("2026-01-10T00:00:00.000Z");
  const memoryTexts = [
    "My favourite school subject is math.",
    "My favourite school subject last year was chemistry.",
    "My favourite school subject with friends is history.",
  ];
  const appended = [];
  for (let index = 0; index < memoryTexts.length; index += 1) {
    appended.push(await advAppendConversation(events, owner.principalId, memoryTexts[index]!, new Date(old + index * 1_000).toISOString()));
  }
  for (let index = 0; index < 6; index += 1) {
    await advAppendConversation(events, owner.principalId, `Archived note ${index}: favourite school subject debate continues.`, new Date(old + (10 + index) * 1_000).toISOString());
  }
  const itemIds = [];
  for (let index = 0; index < appended.length; index += 1) {
    const event = appended[index]!;
    itemIds.push(await commitTestItem({
      principalId: owner.principalId,
      text: memoryTexts[index]!,
      creation: { eventId: event.envelope.eventId, sequence: event.eventSequence, occurredAt: event.envelope.occurredAt },
      ...(index === 0 ? { state: "proposed" as const, uncertain: true } : {}),
    }));
  }
  await advIndexHistory(owner.principalId, events);
  await env.DB.batch([
    env.DB.prepare("UPDATE events SET created_at = ? WHERE subject_id = ?").bind("2026-01-01T00:00:00.000Z", owner.principalId),
    env.DB.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ?").bind("2026-01-02T00:00:00.000Z"),
  ]);
  const archival = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
  for (let step = 0; step < 16; step += 1) {
    if (await archival.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 24) === null) break;
  }
  const live = await env.DB.prepare("SELECT count(*) AS count FROM events WHERE subject_id = ?")
    .bind(owner.principalId).first<{ count: number }>();
  if (live?.count !== 0) throw new Error(`adv87_archive_fixture_live_rows_${live?.count}`);
  return Object.freeze({ owner, memoryTexts, itemIds, archival });
}


// ---------------------------------------------------------------------------
// PR #83 round 2 narrow review (head 787a1b5)
// ---------------------------------------------------------------------------

const R2_DUMP = false;
const r2dumps: Record<string, unknown> = {};
function r2log(key: string, value: unknown): void {
  r2dumps[key] = value;
  console.log(`R2 ${key} ${JSON.stringify(value)}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SEMANTIC_STOPWORDS = new Set([
  "a", "about", "am", "an", "and", "are", "at", "be", "by", "can", "did", "do", "does", "for", "from",
  "had", "has", "have", "how", "i", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or",
  "so", "that", "the", "their", "them", "this", "to", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "you", "your", "s",
]);
const SYNONYMS: Readonly<Record<string, string>> = {
  bicycle: "bike", padlock: "lock", combination: "code", unlock: "open",
  class: "subject", course: "subject", favourite: "like", favorite: "like", best: "like", enjoy: "like",
};

function semanticVector(text: string): number[] {
  const values = new Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (SEMANTIC_STOPWORDS.has(word)) continue;
    const concept = SYNONYMS[word] ?? word;
    let hash = 2166136261;
    for (const char of concept) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
    values[hash % (MEMORY_EMBEDDING_DIMENSIONS - 1)]! += 1;
  }
  // A shared component gives every text a baseline similarity, as real
  // sentence embeddings do; identical texts still score exactly 1.
  values[MEMORY_EMBEDDING_DIMENSIONS - 1] = 0.8;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

class SemanticEmbeddings implements MemoryEmbeddingProvider {
  calls = 0;
  readonly batches: number[] = [];
  delayMs = 0;
  mode: "ok" | "fail" | "hang" = "ok";
  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.calls += 1;
    this.batches.push(texts.length);
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (this.mode === "hang") await new Promise<never>(() => undefined);
    if (this.mode === "fail") throw new Error("workers_ai_down");
    return texts.map(semanticVector);
  }
}

interface SemanticStored {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata: MemoryVectorMetadata;
}

class SemanticVectors implements MemoryVectorStore {
  readonly stored = new Map<string, SemanticStored>();
  readonly upsertCalls: number[] = [];
  readonly deleteCalls: number[] = [];
  queries = 0;
  delayMs = 0;
  failNextUpsert = false;
  private mutation = 0;
  private readonly prefix = newUlid();
  async upsert(vectors: readonly SemanticStored[]): Promise<Readonly<{ mutationId: string }>> {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error("vectorize_upsert_down");
    }
    this.upsertCalls.push(vectors.length);
    for (const vector of vectors) this.stored.set(vector.id, vector);
    this.mutation += 1;
    return { mutationId: `${this.prefix}-u-${this.mutation}` };
  }
  async deleteByIds(ids: readonly string[]): Promise<Readonly<{ mutationId: string }>> {
    this.deleteCalls.push(ids.length);
    for (const id of ids) this.stored.delete(id);
    this.mutation += 1;
    return { mutationId: `${this.prefix}-d-${this.mutation}` };
  }
  async query(values: readonly number[], options: Readonly<{
    topK: number;
    returnMetadata: "all";
    filter: Readonly<{ principal: string }>;
  }>) {
    this.queries += 1;
    if (this.delayMs > 0) await sleep(this.delayMs);
    const matches = [...this.stored.values()]
      .filter((vector) => vector.metadata.principal === options.filter.principal)
      .map((vector) => ({
        id: vector.id,
        score: vector.values.reduce((sum, value, index) => sum + value * values[index]!, 0),
        metadata: { ...vector.metadata } as Record<string, unknown>,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, options.topK);
    return { matches };
  }
  forPrincipal(principalId: string): SemanticStored[] {
    return [...this.stored.values()].filter((vector) => vector.metadata.principal === principalId);
  }
}

interface Harness {
  readonly embeddings: SemanticEmbeddings;
  readonly vectors: SemanticVectors;
  readonly search: MemoryMeaningService;
  readonly telegram: FakeTelegramProvider;
}

const sharedVectors = new SemanticVectors();

function harness(vectors: SemanticVectors = sharedVectors): Harness {
  const embeddings = new SemanticEmbeddings();
  return {
    embeddings,
    vectors,
    search: new MemoryMeaningService({ database: env.DB, embeddings, vectors }),
    telegram: new FakeTelegramProvider(),
  };
}

function indexer(h: Harness, database: D1Database = env.DB): MemoryMeaningService {
  return new MemoryMeaningService({
    database,
    embeddings: h.embeddings,
    vectors: h.vectors,
    historyEvents: advTiered(),
  });
}

async function indexAll(principalId: string, h: Harness) {
  await advIndexHistory(principalId, advTiered());
  const service = indexer(h);
  const runs = [];
  for (let run = 0; run < 20; run += 1) {
    const result = await service.runIndexStep(principalId);
    runs.push(result);
    if (result.outcome !== "indexed" || !result.remaining) break;
  }
  return runs;
}

async function say(owner: ServicePrincipal, text: string, h: Harness, model: RecordingModel = new RecordingModel()) {
  await sendProduction({
    who: owner, ownerPrincipalId: owner.principalId, text, model, telegram: h.telegram, meaningSearch: h.search,
  });
}

async function ask(
  owner: ServicePrincipal,
  text: string,
  h: Harness | null,
  retrieverDatabase?: D1Database,
) {
  const probe = new RecordingModel();
  const logs: string[] = [];
  const observations: TelegramMeaningSearchObservation[] = [];
  const startedAt = performance.now();
  await sendProduction({
    who: owner,
    ownerPrincipalId: owner.principalId,
    text,
    model: probe,
    telegram: h?.telegram ?? new FakeTelegramProvider(),
    log: (code) => logs.push(code),
    observeMeaningSearch: (observation) => observations.push(observation),
    ...(h === null ? {} : { meaningSearch: h.search }),
    ...(retrieverDatabase === undefined ? {} : { retrieverDatabase }),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  return { context: probe.inputs[0]?.context ?? [], logs, observations, elapsedMs, modelCalled: probe.calls > 0 };
}

function contextsWith(context: readonly RetrievedContext[], pattern: RegExp): readonly string[] {
  return context.filter((entry) => pattern.test(entry.text)).map((entry) => entry.text);
}

async function assistantAppend(events: EventRepository, principalId: string, text: string, occurredAt: string) {
  const token = new Redactor().redactText(text);
  if (!token.ok || token.text !== text) throw new Error("r2_redaction_failed");
  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId: newUlid(new Date(occurredAt)),
    eventType: "conversation.assistant_delivered",
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(new Date(Date.parse(occurredAt) + 1)),
    contentType: "application/json",
    payload: { schemaCode: 1, channelCode: 2, sensitivityCode: 1, historyEligible: true, text: token },
    producerVersion: "conversation-v1",
  });
  return events.append({
    envelope,
    scope: "adv-pr83r2",
    key: `adv:${envelope.eventId}`,
    requestHash: await sha256Hex(canonicalJson({ key: envelope.eventId })),
  });
}

async function archiveEverything(principalId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE events SET created_at = ? WHERE subject_id = ?").bind("2026-01-01T00:00:00.000Z", principalId),
    env.DB.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ?").bind("2026-01-02T00:00:00.000Z"),
  ]);
  const archival = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
  for (let step = 0; step < 16; step += 1) {
    if (await archival.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 24) === null) break;
  }
  const live = await env.DB.prepare("SELECT count(*) AS count FROM events WHERE subject_id = ?")
    .bind(principalId).first<{ count: number }>();
  if (live?.count !== 0) throw new Error(`r2_archive_live_rows_${live?.count}`);
}


// ---------------------------------------------------------------------------
// PR #83 round 3 narrow review (head fb431d3)
// ---------------------------------------------------------------------------

const r3dumps: Record<string, unknown> = {};
function r3log(key: string, value: unknown): void {
  r3dumps[key] = value;
  console.log(`R3 ${key} ${JSON.stringify(value)}`);
}

async function withoutTriggers<T>(table: string, operation: () => Promise<T>): Promise<T> {
  const triggers = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
  ).bind(table).all<{ name: string; sql: string }>();
  for (const trigger of triggers.results) await env.DB.exec(`DROP TRIGGER ${trigger.name}`);
  try {
    return await operation();
  } finally {
    for (const trigger of triggers.results) await env.DB.prepare(trigger.sql).run();
  }
}

async function liveLedgerRows(principalId: string): Promise<readonly Readonly<{
  item_kind: string; item_id: string; content_hash: string;
}>[]> {
  const rows = await env.DB.prepare(`SELECT item_kind, item_id, content_hash FROM memory_vectors
    WHERE principal_id = ? AND deleted_at IS NULL ORDER BY item_id`).bind(principalId)
    .all<{ item_kind: string; item_id: string; content_hash: string }>();
  return rows.results;
}

async function runSteps(principalId: string, h: Harness, count: number, database: D1Database = env.DB) {
  const service = indexer(h, database);
  const runs = [];
  for (let step = 0; step < count; step += 1) {
    const result = await service.runIndexStep(principalId);
    runs.push(result);
    if (result.outcome === "indexed" && !result.remaining) break;
  }
  return runs;
}

async function coverageOf(principalId: string) {
  return readMemoryMeaningCoverage(env.DB, principalId, new Date());
}

describe("PR83r3 narrow: B2 archived history through the receipt path (resets archive; run first)", () => {
  async function r3ArchivedOwner(label: string, h: Harness) {
    await resetArchiveFixture();
    const owner = await seedServicePrincipal(label);
    for (let index = 0; index < 4; index += 1) {
      await say(owner, `Archived owner note ${index} about the violin recital.`, h,
        new FixedReplyModel(`Archived Jarvis reply ${index} about the violin recital.`));
    }
    await advIndexHistory(owner.principalId, new EventRepository(env.DB));
    const before = await indexAll(owner.principalId, h);
    await archiveEverything(owner.principalId);
    await advIndexHistory(owner.principalId, advTiered());
    return { owner, before };
  }

  it("B2a an archived owner chunk whose archive row has a NULL subject stays indexed, recallable and converges", async () => {
    const h = harness(new SemanticVectors());
    const { owner, before } = await r3ArchivedOwner("r3-arch-null", h);
    const subjects = await env.DB.prepare(`SELECT count(*) AS total, count(subject_id) AS with_subject
      FROM archive_segment_events`).first<{ total: number; with_subject: number }>();
    const runs = await runSteps(owner.principalId, h, 6);
    const coverage = await coverageOf(owner.principalId);
    const recall = await ask(owner, "When is the violin recital?", h);
    r3log("B2a", {
      before: before.map((r) => ({ u: r.upserted, d: r.deleted })), subjects, runs, coverage,
      stored: h.vectors.forPrincipal(owner.principalId).length,
      history: historyTexts(recall.context),
    });
    expect(subjects?.with_subject).toBe(0);
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
    expect(h.vectors.forPrincipal(owner.principalId).length).toBe(4);
    expect(coverage.missing).toBe(0);
    expect(runs.at(-1)!.remaining).toBe(false);
    expect(historyTexts(recall.context).some((text) => /Archived owner note/u.test(text))).toBe(true);
  }, 180_000);

  it("B2b an archived assistant chunk is a skip, not a throw, and never stalls a new memory", async () => {
    const h = harness(new SemanticVectors());
    const { owner } = await r3ArchivedOwner("r3-arch-asst", h);
    const events = new EventRepository(env.DB);
    await advAppendConversation(events, owner.principalId, "My new locker is number forty two.", new Date().toISOString());
    const itemId = await commitTestItem({
      principalId: owner.principalId, text: "My new locker is number forty two.",
      creation: await latestUserEvent(owner.principalId),
    });
    await advIndexHistory(owner.principalId, advTiered());
    const runs = await runSteps(owner.principalId, h, 6);
    const item = await new MemoryRepository(env.DB).readCurrentItem(owner.principalId, itemId);
    const itemIndexed = h.vectors.forPrincipal(owner.principalId)
      .some((vector) => vector.metadata.itemKind === "item" && vector.metadata.itemId === item.version.versionId);
    const coverage = await coverageOf(owner.principalId);
    r3log("B2b", { runs, itemIndexed, coverage });
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
    expect(itemIndexed).toBe(true);
    expect(coverage.missing).toBe(0);
    expect(runs.at(-1)!.remaining).toBe(false);
  }, 180_000);

  it("B2c a chunk whose archived receipt is missing neither throws nor stalls the cursor", async () => {
    const h = harness(new SemanticVectors());
    const { owner } = await r3ArchivedOwner("r3-arch-noreceipt", h);
    const removed = await withoutTriggers("memory_history_coverage", async () => {
      const row = await env.DB.prepare(`SELECT coverage_id, start_event_sequence FROM memory_history_coverage
        WHERE principal_id = ? AND source_location = 'archived'
        ORDER BY start_event_sequence ASC LIMIT 1`).bind(owner.principalId)
        .first<{ coverage_id: string; start_event_sequence: number }>();
      if (row === null) throw new Error("r3_no_archived_coverage");
      await env.DB.prepare("DELETE FROM memory_history_coverage WHERE coverage_id = ?")
        .bind(row.coverage_id).run();
      return row;
    });
    const runs = await runSteps(owner.principalId, h, 8);
    const coverage = await coverageOf(owner.principalId);
    r3log("B2c", { removed, runs, coverage, stored: h.vectors.forPrincipal(owner.principalId).length });
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
    expect(coverage.missing).toBe(0);
    expect(runs.at(-1)!.remaining).toBe(false);
  }, 180_000);

  it("B2d a chunk whose archived receipt hash does not match the segment neither throws nor stalls", async () => {
    const h = harness(new SemanticVectors());
    const { owner } = await r3ArchivedOwner("r3-arch-badhash", h);
    const mutated = await withoutTriggers("memory_history_coverage", async () => {
      const row = await env.DB.prepare(`SELECT coverage_id FROM memory_history_coverage
        WHERE principal_id = ? AND source_location = 'archived'
        ORDER BY start_event_sequence ASC LIMIT 1`).bind(owner.principalId)
        .first<{ coverage_id: string }>();
      if (row === null) throw new Error("r3_no_archived_coverage");
      await env.DB.prepare("UPDATE memory_history_coverage SET content_hash = ? WHERE coverage_id = ?")
        .bind("f".repeat(64), row.coverage_id).run();
      return row;
    });
    const runs = await runSteps(owner.principalId, h, 8);
    const coverage = await coverageOf(owner.principalId);
    r3log("B2d", { mutated, runs, coverage });
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
    expect(coverage.missing).toBe(0);
    expect(runs.at(-1)!.remaining).toBe(false);
  }, 180_000);
});

function strictAi(sizes: number[], byteSizes: number[]) {
  return {
    run: async (_model: string, input: { text: string[] }) => {
      sizes.push(input.text.length);
      byteSizes.push(input.text.reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0));
      if (input.text.length > 100) throw new Error("AiError: 5006: must NOT have more than 100 items");
      return { shape: [input.text.length, 1024], data: input.text.map(semanticVector), pooling: "cls" };
    },
  };
}

describe("PR83r3 narrow: B1 embedding batch bound at the 100/101 boundary", () => {
  async function backlog(label: string, count: number) {
    const owner = await seedServicePrincipal(label);
    await advInsertConversation(
      owner.principalId,
      Array.from({ length: count }, (_u, i) => `${label} backlog line ${i} about the robotics club.`),
      Date.now() - 900_000,
    );
    await advIndexHistory(owner.principalId, advTiered());
    return owner;
  }

  it("B1a exactly 100 pending rows drain in one run without exceeding the documented maxItems", async () => {
    const vectors = new SemanticVectors();
    const sizes: number[] = [];
    const bytes: number[] = [];
    const owner = await backlog("r3-b1-100", 100);
    const service = new MemoryMeaningService({
      database: env.DB,
      embeddings: new WorkersAiMemoryEmbeddingProvider(strictAi(sizes, bytes) as never),
      vectors,
      historyEvents: advTiered(),
    });
    const runs = [];
    for (let step = 0; step < 4; step += 1) {
      const result = await service.runIndexStep(owner.principalId);
      runs.push(result);
      if (result.outcome === "indexed" && !result.remaining) break;
    }
    const coverage = await coverageOf(owner.principalId);
    r3log("B1a", { sizes, runs, coverage, stored: vectors.forPrincipal(owner.principalId).length });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
    expect(vectors.forPrincipal(owner.principalId).length).toBe(100);
    expect(coverage.missing).toBe(0);
    expect(runs.at(-1)!.remaining).toBe(false);
  }, 180_000);

  it("B1b exactly 101 pending rows drain across runs and never exceed 100 inputs or 128 mutations", async () => {
    const vectors = new SemanticVectors();
    const sizes: number[] = [];
    const bytes: number[] = [];
    const owner = await backlog("r3-b1-101", 101);
    const service = new MemoryMeaningService({
      database: env.DB,
      embeddings: new WorkersAiMemoryEmbeddingProvider(strictAi(sizes, bytes) as never),
      vectors,
      historyEvents: advTiered(),
    });
    const runs = [];
    for (let step = 0; step < 6; step += 1) {
      const result = await service.runIndexStep(owner.principalId);
      runs.push(result);
      if (result.outcome === "indexed" && !result.remaining) break;
    }
    const coverage = await coverageOf(owner.principalId);
    r3log("B1b", { sizes, bytes, runs, coverage, stored: vectors.forPrincipal(owner.principalId).length });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(Math.max(...bytes)).toBeLessThanOrEqual(4_194_304);
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
    expect(runs.every((run) => run.upserted + run.deleted <= 128)).toBe(true);
    expect(vectors.forPrincipal(owner.principalId).length).toBe(101);
    expect(coverage.missing).toBe(0);
    expect(runs.at(-1)!.remaining).toBe(false);
  }, 180_000);

  it("B1c a run that both deletes and embeds still honours the 128 mutation cap and the 100 input cap", async () => {
    const vectors = new SemanticVectors();
    const sizes: number[] = [];
    const bytes: number[] = [];
    const owner = await backlog("r3-b1-mix", 140);
    const service = new MemoryMeaningService({
      database: env.DB,
      embeddings: new WorkersAiMemoryEmbeddingProvider(strictAi(sizes, bytes) as never),
      vectors,
      historyEvents: advTiered(),
    });
    for (let step = 0; step < 4; step += 1) {
      const result = await service.runIndexStep(owner.principalId);
      if (result.outcome === "indexed" && !result.remaining) break;
    }
    // Re-write every chunk's text so the live vectors go stale and fresh
    // candidates appear in the same run.
    const chunks = await env.DB.prepare(
      "SELECT chunk_id, text FROM memory_history_chunks WHERE principal_id = ?",
    ).bind(owner.principalId).all<{ chunk_id: string; text: string }>();
    await withoutTriggers("memory_history_chunks", async () => {
      for (let start = 0; start < chunks.results.length; start += 40) {
        await env.DB.batch(await Promise.all(chunks.results.slice(start, start + 40).map(async (chunk) =>
          env.DB.prepare("UPDATE memory_history_chunks SET text = ?, content_hash = ? WHERE chunk_id = ?")
            .bind(`${chunk.text} (revised)`, await sha256Hex(`${chunk.text} (revised)`), chunk.chunk_id))));
      }
    });
    const runs = [];
    for (let step = 0; step < 8; step += 1) {
      const result = await service.runIndexStep(owner.principalId);
      runs.push(result);
      if (result.outcome === "indexed" && !result.remaining) break;
    }
    r3log("B1c", { sizes, runs: runs.map((r) => ({ o: r.outcome, u: r.upserted, d: r.deleted, rem: r.remaining })) });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(runs.every((run) => run.upserted + run.deleted <= 128)).toBe(true);
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
  }, 240_000);
});

describe("PR83r3 narrow: B3 literal de-duplication boundaries (meaning search off)", () => {
  it("B3a a short genuine answer under 24 characters survives a short recent acknowledgement", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-b3-short");
    const answer = "Bike lock code 8421.";
    await say(owner, answer, h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r3-b3-short"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    await say(owner, "ok", h, new FixedReplyModel("Sure."));
    const result = await ask(owner, "What is my bike lock code?", null);
    r3log("B3a", { history: historyTexts(result.context), length: answer.length });
    expect(historyTexts(result.context)).toContain(answer);
  }, 180_000);

  it("B3b a hit already present verbatim inside a long recent turn is still dropped", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-b3-dedup");
    const answer = "I put the library book on the kitchen shelf.";
    await say(owner, answer, h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r3-b3-dedup"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    await say(owner, answer, h, new FixedReplyModel("Sure."));
    await advIndexHistory(owner.principalId, advTiered());
    const result = await ask(owner, "Where did I put the library book?", null);
    r3log("B3b", { context: result.context.map((entry) => entry.text) });
    expect(contextsWith(result.context, /kitchen shelf/u).filter((text) => text.startsWith("History evidence")))
      .toHaveLength(0);
  }, 180_000);

  it("B3c a recent turn shorter than 24 characters that contains the hit does not duplicate it", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-b3-23");
    const answer = "PIN 8421";
    await say(owner, answer, h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r3-b3-23"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const recent = "PIN 8421 yes";
    await say(owner, recent, h, new FixedReplyModel("Sure."));
    await advIndexHistory(owner.principalId, advTiered());
    const result = await ask(owner, "What is my PIN?", null);
    r3log("B3c", { recentLength: recent.length, context: result.context.map((entry) => entry.text) });
    expect(contextsWith(result.context, /PIN 8421/u).filter((text) => text.startsWith("History evidence")).length)
      .toBeLessThanOrEqual(1);
  }, 180_000);

  it("B3d a real trailing-question-mark turn is still never returned as history evidence", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-b3-q");
    await say(owner, "Where did I leave the spare house key?", h, new FixedReplyModel("Not sure."));
    await advInsertConversation(owner.principalId, fillers("r3-b3-q"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const result = await ask(owner, "Where is the spare house key?", null);
    r3log("B3d", { history: historyTexts(result.context) });
    expect(historyTexts(result.context).some((text) => text.endsWith("?"))).toBe(false);
  }, 180_000);
});

describe("PR83r3 narrow: B4 repeated identical questions with meaning on", () => {
  it("B4a five identical asks ending in ? never drown the original statement", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-b4-q");
    const statement = "I put my passport in the top drawer of the hallway desk.";
    const question = "Where is my passport?";
    await say(owner, statement, h, new FixedReplyModel("Noted."));
    for (let index = 0; index < 5; index += 1) {
      await advInsertConversation(owner.principalId, fillers(`r3-b4-q-${index}`, 5), Date.now() - 400_000 + index * 10_000);
      await say(owner, question, h, new FixedReplyModel("It is in the top drawer of the hallway desk."));
    }
    await advInsertConversation(owner.principalId, fillers("r3-b4-q"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const result = await ask(owner, question, h);
    r3log("B4a", { history: historyTexts(result.context) });
    expect(historyTexts(result.context)).toContain(statement);
    expect(contextsWith(result.context, /Where is my passport\?/u)).toHaveLength(1);
  }, 180_000);

  it("B4b five identical asks without a question mark never drown the original statement", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-b4-noq");
    const statement = "I keep my spare bike key inside the blue toolbox.";
    const question = "where is my spare bike key";
    await say(owner, statement, h, new FixedReplyModel("Noted."));
    for (let index = 0; index < 5; index += 1) {
      await advInsertConversation(owner.principalId, fillers(`r3-b4-noq-${index}`, 5), Date.now() - 400_000 + index * 10_000);
      await say(owner, question, h, new FixedReplyModel("It is inside the blue toolbox."));
    }
    await advInsertConversation(owner.principalId, fillers("r3-b4-noq"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const result = await ask(owner, question, h);
    r3log("B4b", { history: historyTexts(result.context) });
    expect(historyTexts(result.context)).toContain(statement);
  }, 180_000);
});

describe("PR83r3 narrow: B5 forget and lift generations", () => {
  it("B5a forget then lift twice keeps the turn indexable, leaves no orphan vector and never leaks", async () => {
    const h = harness(new SemanticVectors());
    const owner = await seedServicePrincipal("r3-b5");
    const probe = "How do I open my bicycle padlock?";
    const leaks = (context: readonly RetrievedContext[]) => contextsWith(context, /marigold/iu);
    await say(owner, "Remember that my bike lock word is marigold.", h);
    await advInsertConversation(owner.principalId, fillers("r3-b5"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const stages: Record<string, unknown> = {};
    const orphans = async () => {
      const ledger = await liveLedgerRows(owner.principalId);
      const stored = h.vectors.forPrincipal(owner.principalId);
      return { ledger: ledger.length, stored: stored.length };
    };
    stages.start = { control: leaks((await ask(owner, probe, h)).context), counts: await orphans() };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await say(owner, "Forget the memory about bike lock word.", h);
      const staleLeak = leaks((await ask(owner, probe, h)).context);
      await indexAll(owner.principalId, h);
      const forgotten = leaks((await ask(owner, probe, h)).context);
      const forgottenCounts = await orphans();

      await say(owner, "Use the memory about bike lock word again.", h);
      const runs = await runSteps(owner.principalId, h, 25);
      const lifted = leaks((await ask(owner, probe, h)).context);
      const coverage = await coverageOf(owner.principalId);
      const liftedCounts = await orphans();
      stages[`cycle${cycle}`] = {
        staleLeak, forgotten, forgottenCounts, lifted, coverage, liftedCounts,
        lastRun: runs.at(-1),
      };
      expect(staleLeak).toEqual([]);
      expect(forgotten).toEqual([]);
      expect(forgottenCounts.stored).toBe(forgottenCounts.ledger);
      expect(lifted.length).toBeGreaterThan(0);
      expect(coverage.missing).toBe(0);
      expect(runs.at(-1)!.remaining).toBe(false);
      expect(liftedCounts.stored).toBe(liftedCounts.ledger);
    }
    r3log("B5a", stages);
  }, 300_000);
});

describe("PR83r3 narrow: S1 S2 S3 deadlines, acknowledgements and source duplication", () => {
  it("S1a a slow canonical candidate query keeps ready meaning evidence (three runs)", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-s1-slow");
    await say(owner, "I put my passport in the top drawer of the hallway desk.", h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r3-s1-slow"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stats = newD1Stats();
      const result = await ask(owner, "Where is my passport?", h,
        countingDatabase(env.DB, stats, (sql) => sql.includes("memory_item_fts MATCH") ? 900 : 0));
      outcomes.push({
        logs: result.logs,
        drawer: contextsWith(result.context, /top drawer/u).length,
        elapsedMs: result.elapsedMs,
      });
    }
    r3log("S1a", outcomes);
    expect(outcomes.every((outcome) => !outcome.logs.includes("telegram_memory_retrieval_memory_timeout"))).toBe(true);
    expect(outcomes.every((outcome) => outcome.drawer === 1)).toBe(true);
  }, 300_000);

  it("S1b a meaning provider answering inside the reserved search window is still used (three runs)", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-s1-ready");
    await say(owner, "My bike lock combination is 4417.", h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r3-s1-ready"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.embeddings.delayMs = 150;
      const result = await ask(owner, "How do I open my bicycle padlock?", h);
      h.embeddings.delayMs = 0;
      outcomes.push({
        found: contextsWith(result.context, /4417/u).length,
        observations: result.observations,
        logs: result.logs,
      });
    }
    r3log("S1b", outcomes);
    expect(outcomes.every((outcome) => outcome.found === 1)).toBe(true);
  }, 300_000);

  it("S2a acknowledgement terms make no Workers AI or Vectorize call while real short questions still search", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-s2");
    await say(owner, "My bike lock combination is 4417.", h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r3-s2"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const acknowledgements = [
      "thanks jarvis", "ok thanks", "cool thanks", "got it", "sounds good", "nice", "yeah",
      "yep", "sure", "no", "ty", "thx", "good morning", "haha", "perfect", "ok cool",
      "good night", "what's up", "lol", "hey",
    ];
    const questions = [
      "who is maya?", "my wifi password?", "when's my dentist?", "where's my passport?",
      "what is my morning plan?", "is the night bus running?", "how good was my last mark?",
    ];
    const searched: Record<string, boolean> = {};
    for (const text of [...acknowledgements, ...questions]) {
      const beforeCalls = h.embeddings.calls;
      const beforeQueries = h.vectors.queries;
      await ask(owner, text, h);
      searched[text] = h.embeddings.calls > beforeCalls || h.vectors.queries > beforeQueries;
    }
    r3log("S2a", searched);
    expect(acknowledgements.filter((text) => searched[text])).toEqual([]);
    expect(questions.filter((text) => !searched[text])).toEqual([]);
  }, 300_000);

  it("S3a a remembered item found by meaning search is never repeated as its own source turn", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r3-s3");
    await say(owner, "Remember that my favourite class is chemistry.", h);
    await advInsertConversation(owner.principalId, fillers("r3-s3"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const result = await ask(owner, "Which subject do I like best?", h);
    const matching = result.context.filter((entry) => /chemistry/iu.test(entry.text));
    r3log("S3a", { matching: matching.map((entry) => entry.text), ids: matching.map((entry) => entry.sourceEventId) });
    expect(matching).toHaveLength(1);
    expect(new Set(matching.map((entry) => entry.sourceEventId)).size).toBe(matching.length);
  }, 180_000);
});

describe("PR83r3 narrow: question-shape filter agreement between SQL and TypeScript", () => {
  it("G1 a turn ending in a question mark plus a non-breaking space does not stall the index", async () => {
    const vectors = new SemanticVectors();
    const h = harness(vectors);
    const owner = await seedServicePrincipal("r3-nbsp");
    await advInsertConversation(owner.principalId, [
      "My spare car key hangs on the hook by the garage door.",
      "Where is my spare car key?\u00a0",
      "The recycling goes out on Tuesday nights.",
    ], Date.now() - 200_000);
    await advIndexHistory(owner.principalId, advTiered());
    const runs = await runSteps(owner.principalId, h, 6);
    const coverage = await coverageOf(owner.principalId);
    r3log("G1", { runs, coverage, stored: vectors.forPrincipal(owner.principalId).length });
    expect(runs.every((run) => run.outcome === "indexed")).toBe(true);
    expect(coverage.missing).toBe(0);
    expect(runs.at(-1)!.remaining).toBe(false);
  }, 180_000);
});

describe("PR83r3 narrow: diagnostic dump", () => {
  it.skipIf(true)("DUMP", () => {
    for (const [key, value] of Object.entries(r3dumps)) console.log(`R3DUMP ${key} ${JSON.stringify(value)}`);
  });
});

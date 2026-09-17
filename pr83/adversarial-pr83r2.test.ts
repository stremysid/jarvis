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

const R2_DUMP = true;
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

describe("PR83r2 narrow: 4 indexer after archival (reset archive; run first)", () => {
  async function archivedOwner(label: string, h: Harness) {
    await resetArchiveFixture();
    const owner = await seedServicePrincipal(label);
    for (let index = 0; index < 4; index += 1) {
      await say(owner, `Archived owner note ${index} about the violin recital.`, h, new FixedReplyModel(`Archived Jarvis reply ${index} about the violin recital.`));
    }
    await advIndexHistory(owner.principalId, new EventRepository(env.DB));
    const before = await indexAll(owner.principalId, h);
    await archiveEverything(owner.principalId);
    await advIndexHistory(owner.principalId, advTiered());
    return { owner, before };
  }

  it("I1a production archival (subject_id left NULL) keeps archived owner-history vectors and meaning recall of them", async () => {
    const h = harness(new SemanticVectors());
    const { owner, before } = await archivedOwner("r2-arch-a", h);
    const vectorsBefore = before.reduce((sum, run) => sum + run.upserted, 0);
    const subjects = await env.DB.prepare(`SELECT count(*) AS total, count(subject_id) AS with_subject
      FROM archive_segment_events`).first<{ total: number; with_subject: number }>();
    const service = indexer(h);
    const after = [];
    for (let run = 0; run < 2; run += 1) after.push(await service.runIndexStep(owner.principalId));
    const vectorsAfter = h.vectors.forPrincipal(owner.principalId).length;
    const coverage = await readMemoryMeaningCoverage(env.DB, owner.principalId, new Date());
    const recall = await ask(owner, "When is the violin recital?", h);
    r2log("I1a", { vectorsBefore, subjects, after, vectorsAfter, coverage, history: historyTexts(recall.context), meaning: recall.observations });
    expect(vectorsBefore).toBe(4);
    expect(after[0]!.deleted).toBe(0);
    expect(vectorsAfter).toBe(4);
    expect(historyTexts(recall.context).some((text) => /Archived owner note/u.test(text))).toBe(true);
  }, 120_000);

  it("I1b once distillation has back-filled archived subject_id, archived Jarvis replies do not stall indexing of a new memory", async () => {
    const h = harness(new SemanticVectors());
    const { owner } = await archivedOwner("r2-arch-b", h);
    // automatic-distillation.ts:1058 performs exactly this back-fill when it reads archived ranges.
    await env.DB.prepare("UPDATE archive_segment_events SET subject_id = ? WHERE subject_id IS NULL")
      .bind(owner.principalId).run();
    const events = new EventRepository(env.DB);
    await advAppendConversation(events, owner.principalId, "My new locker is number forty two.", new Date().toISOString());
    const itemId = await commitTestItem({
      principalId: owner.principalId, text: "My new locker is number forty two.", creation: await latestUserEvent(owner.principalId),
    });
    await advIndexHistory(owner.principalId, advTiered());
    const service = indexer(h);
    const after = [];
    for (let run = 0; run < 3; run += 1) after.push(await service.runIndexStep(owner.principalId));
    const item = await new MemoryRepository(env.DB).readCurrentItem(owner.principalId, itemId);
    const itemIndexed = h.vectors.forPrincipal(owner.principalId)
      .some((vector) => vector.metadata.itemKind === "item" && vector.metadata.itemId === item.version.versionId);
    const coverage = await readMemoryMeaningCoverage(env.DB, owner.principalId, new Date());
    r2log("I1b", { after, itemIndexed, coverage, vectors: h.vectors.forPrincipal(owner.principalId).length });
    expect(after.map((run) => run.outcome)).toEqual(["indexed", "indexed", "indexed"]);
    expect(itemIndexed).toBe(true);
    expect(coverage.missing).toBe(0);
    expect(after[2]!.remaining).toBe(false);
  }, 120_000);
});

describe("PR83r2 narrow: 1 forgetting across canonical, literal and meaning", () => {
  it("F1 forget / lift / forget again with a Jarvis restatement, stale vectors and another principal never leaks", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-forget");
    const other = await seedServicePrincipal("r2-other");
    await say(other, "My bike lock word is saffron.", h);
    await advInsertConversation(other.principalId, fillers("r2-other", 5), Date.now() - 100_000);
    await indexAll(other.principalId, h);

    await say(owner, "Remember that my bike lock word is marigold.", h);
    await say(owner, "What is my bike lock word?", h, new FixedReplyModel("Your bike lock word is marigold."));
    await advInsertConversation(owner.principalId, fillers("r2-forget"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const probe = "How do I open my bicycle padlock?";
    const leaks = (context: readonly RetrievedContext[]) => contextsWith(context, /marigold|saffron/iu);

    const control = await ask(owner, probe, h);
    const stage: Record<string, unknown> = { control: leaks(control.context) };

    await say(owner, "Forget the memory about bike lock word.", h);
    const states = await env.DB.prepare("SELECT lifecycle_state FROM memory_item_state WHERE principal_id = ?")
      .bind(owner.principalId).all<{ lifecycle_state: string }>();
    const staleVectors = h.vectors.forPrincipal(owner.principalId).length;
    const forgotStale = await ask(owner, probe, h);
    await indexAll(owner.principalId, h);
    const forgotIndexed = await ask(owner, probe, h);
    const forgotKeyword = await ask(owner, "What is my bike lock word?", h);

    await say(owner, "Use the memory about bike lock word again.", h);
    await indexAll(owner.principalId, h);
    const lifted = await ask(owner, probe, h);

    await say(owner, "Forget the memory about bike lock word.", h);
    const againStale = await ask(owner, probe, h);
    await indexAll(owner.principalId, h);
    const againIndexed = await ask(owner, probe, h);

    Object.assign(stage, {
      states: states.results.map((row) => row.lifecycle_state),
      staleVectors,
      forgotStale: leaks(forgotStale.context),
      forgotIndexed: leaks(forgotIndexed.context),
      forgotKeyword: leaks(forgotKeyword.context),
      lifted: leaks(lifted.context),
      againStale: leaks(againStale.context),
      againIndexed: leaks(againIndexed.context),
      observations: [control, forgotStale, forgotIndexed, lifted, againIndexed].map((entry) => entry.observations),
    });
    r2log("F1", stage);
    expect(leaks(control.context).some((text) => /marigold/iu.test(text))).toBe(true);
    expect(states.results.map((row) => row.lifecycle_state)).toContain("forgotten");
    expect(leaks(forgotStale.context)).toEqual([]);
    expect(leaks(forgotIndexed.context)).toEqual([]);
    expect(leaks(forgotKeyword.context)).toEqual([]);
    expect(leaks(lifted.context).every((text) => !/saffron/iu.test(text))).toBe(true);
    expect(leaks(againStale.context)).toEqual([]);
    expect(leaks(againIndexed.context)).toEqual([]);
  }, 120_000);

  it("F2 a lifted memory's source turn becomes meaning-searchable again and the index reports nothing missing", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-lift");
    await say(owner, "Remember that the spare house key is under the blue flowerpot.", h);
    await advInsertConversation(owner.principalId, fillers("r2-lift", 5), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const source = await env.DB.prepare(`SELECT event_id FROM events WHERE subject_id = ?
      AND event_type = 'conversation.user_committed' ORDER BY sequence ASC LIMIT 1`).bind(owner.principalId)
      .first<{ event_id: string }>();
    const hasHistoryVector = () => h.vectors.forPrincipal(owner.principalId)
      .some((vector) => vector.metadata.itemKind === "history_chunk" && vector.metadata.itemId === source?.event_id);
    const initially = hasHistoryVector();
    await say(owner, "Forget the memory about spare house key.", h);
    await indexAll(owner.principalId, h);
    const afterForget = hasHistoryVector();
    await say(owner, "Use the memory about spare house key again.", h);
    const liftRuns = await indexAll(owner.principalId, h);
    const afterLift = hasHistoryVector();
    const chunkBack = await env.DB.prepare(`SELECT count(*) AS count FROM memory_retrievable_history_chunks chunk
      JOIN events event ON event.sequence = chunk.start_event_sequence WHERE event.event_id = ?`)
      .bind(source?.event_id).first<{ count: number }>();
    const coverage = await readMemoryMeaningCoverage(env.DB, owner.principalId, new Date());
    r2log("F2", { initially, afterForget, afterLift, chunkBack, coverage, liftRuns });
    expect(initially).toBe(true);
    expect(afterForget).toBe(false);
    expect(chunkBack?.count).toBe(1);
    expect(afterLift).toBe(true);
    expect(coverage.missing).toBe(0);
  }, 120_000);
});

describe("PR83r2 narrow: 2 latency through the production Telegram service", () => {
  it("L1 at 25 ms per D1 round trip, keyword memory survives every AI/Vectorize latency and ready meaning hits are not discarded", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-latency");
    await say(owner, "I put my passport in the top drawer of the hallway desk.", h, new FixedReplyModel("Noted."));
    await say(owner, "My passport number ends in 7731.", h, new FixedReplyModel("Noted."));
    await commitTestItem({ principalId: owner.principalId, text: "My passport number ends in 7731.", creation: await latestUserEvent(owner.principalId) });
    await advInsertConversation(owner.principalId, fillers("r2-latency"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const runs = [];
    for (const searchMs of [50, 50, 50, 150, 150, 150, 200, 200, 200, 250, 250, 250, 300, 300, 300, 400, 400, 400]) {
      h.embeddings.delayMs = Math.round(searchMs / 2);
      h.vectors.delayMs = searchMs - Math.round(searchMs / 2);
      const stats = newD1Stats();
      const result = await ask(owner, "Where is my passport?", h, countingDatabase(env.DB, stats, () => 25));
      runs.push({
        searchMs,
        elapsedMs: result.elapsedMs,
        logs: result.logs,
        meaning: result.observations,
        roundTrips: stats.roundTrips,
        keyword: contextsWith(result.context, /7731/u).length > 0,
        drawer: contextsWith(result.context, /top drawer/u).length > 0,
      });
    }
    h.embeddings.delayMs = 0;
    h.vectors.delayMs = 0;
    h.embeddings.mode = "fail";
    const failed = await ask(owner, "Where is my passport?", h, countingDatabase(env.DB, newD1Stats(), () => 25));
    h.embeddings.mode = "hang";
    const hung = await ask(owner, "Where is my passport?", h, countingDatabase(env.DB, newD1Stats(), () => 25));
    h.embeddings.mode = "ok";
    const summary = (entry: typeof failed) => ({
      elapsedMs: entry.elapsedMs, logs: entry.logs, meaning: entry.observations,
      keyword: contextsWith(entry.context, /7731/u).length > 0,
    });
    r2log("L1", { runs, failed: summary(failed), hung: summary(hung) });
    for (const run of runs) {
      expect(run.keyword).toBe(true);
      expect(run.logs).not.toContain("telegram_memory_retrieval_memory_timeout");
    }
    expect(summary(failed).keyword).toBe(true);
    expect(summary(hung).keyword).toBe(true);
    // Correct behaviour: a meaning answer that arrives well inside its 450 ms
    // window is used, not discarded because the D1 re-reads that follow are slow.
    expect(runs.filter((run) => run.searchMs <= 250 && !run.drawer).map((run) => run.searchMs)).toEqual([]);
  }, 120_000);

  it("L2 ordinary acknowledgements make no Workers AI or Vectorize call; short real questions still search", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-acks");
    const searched: string[] = [];
    for (const message of [
      "hi", "thanks", "thanks jarvis", "ok thanks", "cool thanks", "got it", "sounds good", "nice", "yeah",
      "yep", "sure", "no", "ty", "thx", "good morning", "haha", "perfect", "okay 👍", "thank you!",
    ]) {
      const before = h.embeddings.calls;
      await ask(owner, message, h);
      if (h.embeddings.calls > before) searched.push(message);
    }
    const questions: Record<string, boolean> = {};
    for (const message of ["who is maya?", "my wifi password?", "when's my dentist?", "where's my passport?"]) {
      const before = h.embeddings.calls;
      await ask(owner, message, h);
      questions[message] = h.embeddings.calls > before;
    }
    r2log("L2", { searched, questions });
    expect(Object.values(questions).every(Boolean)).toBe(true);
    expect(searched).toEqual([]);
  }, 120_000);
});

describe("PR83r2 narrow: 3 recall quality end to end", () => {
  it("Q1 paraphrase finds an old statement and a remembered item through meaning search only", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-para");
    await say(owner, "My bike lock combination is 4417.", h, new FixedReplyModel("Noted."));
    await say(owner, "Remember that my favourite class is chemistry.", h);
    await advInsertConversation(owner.principalId, fillers("r2-para"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const lock = await ask(owner, "How do I open my bicycle padlock?", h);
    const subject = await ask(owner, "Which subject do I like best?", h);
    const without = await ask(owner, "How do I open my bicycle padlock?", null);
    r2log("Q1", { lock: contextsWith(lock.context, /4417/u), subject: contextsWith(subject.context, /chemistry/u), without: contextsWith(without.context, /4417/u) });
    expect(contextsWith(without.context, /4417/u)).toEqual([]);
    expect(contextsWith(lock.context, /4417/u)).toHaveLength(1);
    expect(contextsWith(subject.context, /chemistry/u).length).toBeGreaterThan(0);
  }, 120_000);

  it("Q2 asking the same short question four times does not drown the original statement in meaning results", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-repeat");
    const statement = "I put my passport in the top drawer of the hallway desk.";
    const question = "Where is my passport?";
    await say(owner, statement, h, new FixedReplyModel("Noted."));
    for (let index = 0; index < 4; index += 1) {
      await advInsertConversation(owner.principalId, fillers(`r2-repeat-${index}`, 5), Date.now() - 300_000 + index * 10_000);
      await say(owner, question, h, new FixedReplyModel("It is in the top drawer of the hallway desk."));
    }
    await advInsertConversation(owner.principalId, fillers("r2-repeat"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const result = await ask(owner, question, h);
    const history = historyTexts(result.context);
    r2log("Q2", { history, questionCopies: contextsWith(result.context, /Where is my passport\?/u).length });
    expect(history).toContain(statement);
    expect(contextsWith(result.context, /Where is my passport\?/u)).toHaveLength(1);
  }, 120_000);

  it("Q3a literal recall (meaning off) survives a short recent owner turn ok that is a substring of the hit", async () => {
    const h = harness();
    const shelf = "I put the library book on the kitchen shelf.";
    const results: Record<string, readonly string[]> = {};
    for (const variant of ["control", "ok"] as const) {
      const owner = await seedServicePrincipal(`r2-dedup-a-${variant}`);
      await say(owner, shelf, h, new FixedReplyModel("Noted."));
      await advInsertConversation(owner.principalId, fillers(`r2-dedup-a-${variant}`), Date.now() - 120_000);
      await advIndexHistory(owner.principalId, advTiered());
      if (variant === "ok") await say(owner, "ok", h, new FixedReplyModel("Sure."));
      results[variant] = historyTexts((await ask(owner, "Where did I put the library book?", null)).context);
    }
    r2log("Q3a", results);
    expect(results.control).toContain(shelf);
    expect(results.ok).toContain(shelf);
  }, 120_000);

  it("Q3c literal recall (meaning off) still works when Sid repeats the question right after asking it", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-dedup-c");
    const shelf = "I put the library book on the kitchen shelf.";
    await say(owner, shelf, h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r2-dedup-c"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const first = historyTexts((await ask(owner, "Where did I put the library book?", null)).context);
    const second = historyTexts((await ask(owner, "Where did I put the library book?", null)).context);
    r2log("Q3c", { first, second });
    expect(first).toContain(shelf);
    expect(second).toContain(shelf);
  }, 120_000);

  it("Q3b literal recall (meaning off) keeps statements that begin with have/did/will", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-dedup-b");
    const statements = [
      "Have to return the library book to Ms Patel on Friday.",
      "Did the chemistry lab write-up already, it is due Monday.",
      "Will be at the orthodontist Thursday at four.",
    ];
    for (const statement of statements) await say(owner, statement, h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r2-dedup-b"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const library = await ask(owner, "When do I return the library book?", null);
    const lab = await ask(owner, "When is the chemistry lab write-up due?", null);
    const ortho = await ask(owner, "When will I be at the orthodontist on Thursday at four?", null);
    r2log("Q3b", { library: historyTexts(library.context), lab: historyTexts(lab.context), ortho: historyTexts(ortho.context) });
    expect(historyTexts(library.context)).toContain(statements[0]);
    expect(historyTexts(lab.context)).toContain(statements[1]);
    expect(historyTexts(ortho.context)).toContain(statements[2]);
  }, 120_000);

  it("Q5 a remembered item found by meaning search is not repeated as its own source turn", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-src-dup");
    await say(owner, "Remember that my favourite class is chemistry.", h);
    await advInsertConversation(owner.principalId, fillers("r2-src-dup"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const result = await ask(owner, "Which subject do I like best?", h);
    const chemistry = contextsWith(result.context, /chemistry/u);
    const sourceIds = result.context.filter((context) => /chemistry/u.test(context.text)).map((context) => context.sourceEventId);
    r2log("Q5", { chemistry, sourceIds });
    expect(chemistry).toHaveLength(1);
  }, 120_000);

  it("Q4 a statement found by both literal and meaning search appears exactly once", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-both");
    await say(owner, STATEMENT, h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r2-both"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const result = await ask(owner, QUESTION, h);
    r2log("Q4", { history: historyTexts(result.context), meaning: result.observations });
    expect(contextsWith(result.context, /green printer/u)).toHaveLength(1);
  }, 120_000);
});

describe("PR83r2 narrow: 4 indexer batching, order and partial failure", () => {
  it("I2 one embedding call and one upsert per run within caps, items first newest first, idempotent after a failed upsert", async () => {
    const h = harness(new SemanticVectors());
    const owner = await seedServicePrincipal("r2-batch");
    await advInsertConversation(owner.principalId, Array.from({ length: 130 }, (_u, i) => `Backfill line ${i} about the science fair.`), Date.now() - 600_000);
    await advAppendConversation(new EventRepository(env.DB), owner.principalId, "Older memory text.", new Date(Date.now() - 500_000).toISOString());
    const olderItem = await commitTestItem({ principalId: owner.principalId, text: "Older memory text.", creation: await latestUserEvent(owner.principalId) });
    await sleep(5);
    await advAppendConversation(new EventRepository(env.DB), owner.principalId, "Newer memory text.", new Date(Date.now() - 400_000).toISOString());
    const newerItem = await commitTestItem({ principalId: owner.principalId, text: "Newer memory text.", creation: await latestUserEvent(owner.principalId) });
    await advIndexHistory(owner.principalId, advTiered());
    const stats = newD1Stats();
    const service = indexer(h, countingDatabase(env.DB, stats));
    h.vectors.failNextUpsert = true;
    const failed = await service.runIndexStep(owner.principalId);
    const ledgerAfterFailure = await env.DB.prepare("SELECT count(*) AS count FROM memory_vectors WHERE principal_id = ?")
      .bind(owner.principalId).first<{ count: number }>();
    const embedCallsAfterFailure = h.embeddings.calls;
    const statsBefore = stats.statements;
    const first = await service.runIndexStep(owner.principalId);
    const firstStatements = stats.statements - statsBefore;
    const firstIds = [...h.vectors.stored.values()].map((vector) => vector.metadata);
    const second = await service.runIndexStep(owner.principalId);
    const third = await service.runIndexStep(owner.principalId);
    const repository = new MemoryRepository(env.DB);
    const newer = await repository.readCurrentItem(owner.principalId, newerItem);
    const older = await repository.readCurrentItem(owner.principalId, olderItem);
    const ledger = await env.DB.prepare(`SELECT count(*) AS count, count(DISTINCT item_id || content_hash) AS distinct_count
      FROM memory_vectors WHERE principal_id = ?`).bind(owner.principalId).first<{ count: number; distinct_count: number }>();
    r2log("I2", {
      failed, ledgerAfterFailure, embedCallsAfterFailure, first, firstStatements, second, third,
      batches: h.embeddings.batches, upsertCalls: h.vectors.upsertCalls, ledger,
      firstTwo: firstIds.slice(0, 2).map((entry) => entry.itemKind),
    });
    expect(failed.outcome).toBe("retryable_failure");
    expect(ledgerAfterFailure?.count).toBe(0);
    expect(h.embeddings.batches.every((size) => size <= 128)).toBe(true);
    expect(h.vectors.upsertCalls.every((size) => size <= 128)).toBe(true);
    expect(firstIds.slice(0, 2).map((entry) => entry.itemId)).toEqual([newer.version.versionId, older.version.versionId]);
    expect(firstStatements).toBeLessThanOrEqual(264);
    expect(ledger?.count).toBe(ledger?.distinct_count);
    expect(third.remaining).toBe(false);
  }, 120_000);
});

describe("PR83r2 narrow: 4b documented Workers AI batch limit and 2b slow canonical path", () => {
  it("I3 a backlog above bge-m3's documented text maxItems (100) still makes progress through the real Workers AI adapter", async () => {
    const vectors = new SemanticVectors();
    const owner = await seedServicePrincipal("r2-maxitems");
    await advInsertConversation(owner.principalId, Array.from({ length: 150 }, (_u, i) => `Maxitems backlog line ${i} about the robotics club.`), Date.now() - 600_000);
    await advIndexHistory(owner.principalId, advTiered());
    const sizes: number[] = [];
    // bge-m3 "Input Embedding" schema: text array maxItems 100
    // (developers.cloudflare.com/workers-ai/models/bge-m3/batch-input.json).
    const ai = {
      run: async (_model: string, input: { text: string[] }) => {
        sizes.push(input.text.length);
        if (input.text.length > 100) throw new Error("AiError: 5006: must NOT have more than 100 items");
        return { shape: [input.text.length, 1024], data: input.text.map(semanticVector), pooling: "cls" };
      },
    };
    const service = new MemoryMeaningService({
      database: env.DB,
      embeddings: new WorkersAiMemoryEmbeddingProvider(ai as never),
      vectors,
      historyEvents: advTiered(),
    });
    const runs = [];
    for (let run = 0; run < 3; run += 1) runs.push(await service.runIndexStep(owner.principalId));
    r2log("I3", { sizes, runs, stored: vectors.forPrincipal(owner.principalId).length });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(vectors.forPrincipal(owner.principalId).length).toBeGreaterThan(0);
  }, 120_000);

  it("L3 a slow canonical candidate query does not discard meaning evidence that was ready in time", async () => {
    const h = harness();
    const owner = await seedServicePrincipal("r2-slowcand");
    await say(owner, "I put my passport in the top drawer of the hallway desk.", h, new FixedReplyModel("Noted."));
    await advInsertConversation(owner.principalId, fillers("r2-slowcand"), Date.now() - 120_000);
    await indexAll(owner.principalId, h);
    const stats = newD1Stats();
    const result = await ask(owner, "Where is my passport?", h,
      countingDatabase(env.DB, stats, (sql) => sql.includes("memory_item_fts MATCH") ? 900 : 0));
    r2log("L3", { logs: result.logs, meaning: result.observations, elapsedMs: result.elapsedMs, history: historyTexts(result.context) });
    expect(result.logs).not.toContain("telegram_memory_retrieval_memory_timeout");
    expect(contextsWith(result.context, /top drawer/u)).toHaveLength(1);
  }, 120_000);
});

describe("PR83r2 narrow: diagnostic dump", () => {
  it.skipIf(!R2_DUMP)("DUMP all logged evidence (fails on purpose so Vitest prints it)", () => {
    for (const [key, value] of Object.entries(r2dumps)) console.log(`R2DUMP ${key} ${JSON.stringify(value)}`);
    expect(R2_DUMP).toBe(false);
  });
});

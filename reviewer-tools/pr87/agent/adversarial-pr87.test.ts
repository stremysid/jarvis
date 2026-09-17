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

async function seedProductionShapedLatencyFixture(principalId: string): Promise<LatencyFixture> {
  const favoriteSubject = "My favorite subject is math.";
  const texts = Array.from({ length: 185 }, (_unused, index) => {
    if (index < 8) return favoriteSubject;
    if (index === 8) return "My favorite color is blue.";
    if (index === 9) return "I prefer concise weekly reports.";
    if (index === 10) return "My study plan starts on Sunday.";
    return `Production fixture turn ${index} about unrelated notes.`;
  });
  const firstTimestamp = Date.parse("2026-09-17T00:00:00.000Z");
  const envelopes: PersistableEventEnvelopeV1[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    envelopes.push(await latencyEnvelope(
      principalId,
      texts[index]!,
      new Date(firstTimestamp + index * 1_000).toISOString(),
      index < 20,
    ));
  }
  for (let start = 0; start < envelopes.length; start += 50) {
    await env.DB.batch(envelopes.slice(start, start + 50).map((envelope) => env.DB.prepare(
      `INSERT INTO events (
        event_id, event_type, source, subject_id, occurred_at, received_at,
        content_hash, envelope_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      envelope.eventId,
      envelope.eventType,
      envelope.source,
      envelope.subjectId,
      envelope.occurredAt,
      envelope.receivedAt,
      envelope.contentHash,
      canonicalJson(envelope),
      envelope.receivedAt,
    )));
  }
  const rows = await env.DB.prepare(`SELECT event_id, sequence, occurred_at FROM events
    WHERE subject_id = ? ORDER BY sequence ASC`).bind(principalId)
    .all<{ event_id: string; sequence: number; occurred_at: string }>();
  if (rows.results.length !== 185) throw new Error("telegram_memory_latency_event_fixture_invalid");
  const eventAt = (index: number) => {
    const row = rows.results[index];
    if (row === undefined) throw new Error("telegram_memory_latency_event_fixture_invalid");
    return Object.freeze({
      eventId: row.event_id as ReturnType<typeof newUlid>,
      sequence: row.sequence,
      occurredAt: row.occurred_at,
    });
  };
  const favoriteSubjectItemId = await commitTestItem({
    principalId,
    text: favoriteSubject,
    creation: eventAt(0),
    state: "proposed",
    uncertain: true,
  });
  await commitTestItem({
    principalId,
    text: texts[8]!,
    creation: eventAt(8),
    state: "proposed",
    uncertain: true,
  });
  await commitTestItem({ principalId, text: texts[9]!, creation: eventAt(9) });
  await commitTestItem({ principalId, text: texts[10]!, creation: eventAt(10) });

  const events = new EventRepository(env.DB);
  const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
  const archiveState = new ArchiveRepository(env.DB);
  const history = new LiteralHistoryService({
    database: env.DB,
    events: new TieredEventReader({ archive, live: events, state: archiveState }),
    archive: archiveState,
    now: () => new Date("2026-09-17T01:00:00.000Z"),
    nextId: () => newUlid(),
  });
  for (let step = 0; step < 1024; step += 1) {
    const result = await history.indexNext({
      principalId,
      maxEvents: 16,
      maxTextBytes: 262_144,
    });
    if (result.complete) break;
    if (step === 1023) throw new Error("telegram_memory_latency_history_incomplete");
  }
  const literal = await history.searchLiteral({
    principalId,
    query: "favorite subject math",
    maxResults: 8,
  });
  if (literal.hits.length !== 8) throw new Error("telegram_memory_latency_hits_invalid");
  return Object.freeze({ history, favoriteSubjectItemId });
}

async function claimedTurn(principalId: string, text: string): Promise<Readonly<{
  turnId: ReturnType<typeof newUlid>;
  input: ModelAdapterStreamInput;
}>> {
  const events = new EventRepository(env.DB);
  const conversations = new ConversationRepository(env.DB, events);
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("telegram_memory_test_redaction_failed");
  const turnId = newUlid();
  const admission = await conversations.getOrCreateTurn({
    turnId,
    sessionId: `telegram-memory:${turnId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now: new Date(),
  });
  const claim = await conversations.claimModelTurn({
    turnId,
    requestHash: admission.turn.requestHash,
    now: new Date(),
  });
  if (claim.kind !== "claimed") throw new Error("telegram_memory_test_claim_failed");
  return Object.freeze({
    turnId,
    input: Object.freeze({
      correlationId: turnId,
      principalId,
      channel: "telegram",
      userText: text,
      context: Object.freeze([]),
      reasoningEffort: "low",
      firstTokenTimeoutMs: 1_000,
      timeoutMs: 2_000,
      contextTokenBudget: 32_000,
      maxOutputCharacters: 16_384,
      signal: new AbortController().signal,
    }),
  });
}

async function collect(iterable: AsyncIterable<ModelToken>): Promise<readonly ModelToken[]> {
  const tokens: ModelToken[] = [];
  for await (const token of iterable) tokens.push(token);
  return Object.freeze(tokens);
}

async function countRows(table: "events" | "memory_items", where = "", value?: string): Promise<number> {
  const statement = env.DB.prepare(`SELECT count(*) AS count FROM ${table} ${where}`);
  const row = value === undefined
    ? await statement.first<{ count: number }>()
    : await statement.bind(value).first<{ count: number }>();
  return row?.count ?? -1;
}

async function markerPrincipal(label: string): Promise<string> {
  markerPrincipalSerial += 1;
  const principalId = `principal:telegram-marker-${label}-${markerPrincipalSerial}`;
  await seedPrincipal(principalId);
  return principalId;
}

async function storedDistilledItem(principalId: string): Promise<Readonly<{
  origin: string;
  uncertain: number;
  lifecycle_state: string;
  display_name: string;
}>> {
  const row = await env.DB.prepare(`SELECT version.origin, version.uncertain,
      state.lifecycle_state, topic.display_name
    FROM memory_items item
    JOIN memory_item_state state
      ON state.principal_id = item.principal_id AND state.item_id = item.item_id
    JOIN memory_item_versions version
      ON version.principal_id = state.principal_id AND version.version_id = state.current_version_id
    JOIN memory_item_placement_state placement
      ON placement.principal_id = item.principal_id AND placement.item_id = item.item_id
      AND placement.relation = 'primary'
    JOIN memory_topics topic
      ON topic.principal_id = placement.principal_id AND topic.topic_id = placement.topic_id
    WHERE item.principal_id = ? ORDER BY item.created_at DESC LIMIT 1`)
    .bind(principalId).first<{
      origin: string;
      uncertain: number;
      lifecycle_state: string;
      display_name: string;
    }>();
  if (row === null) throw new Error("telegram_marker_item_missing");
  return Object.freeze(row);
}

function classifyMarkerText(text: string, metadata: Record<string, unknown> = {}) {
  const classification = classifyTelegramUpdate({
    update_id: markerPrincipalSerial + 1,
    message: {
      message_id: markerPrincipalSerial + 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      text,
      ...metadata,
    },
  });
  if (classification.kind !== "text") throw new Error("telegram_marker_classification_failed");
  return classification.value;
}

async function committedMarkerEnvelope(
  label: string,
  text: string,
  metadata: Record<string, unknown>,
) {
  const principalId = await markerPrincipal(label);
  const classified = classifyMarkerText(text, metadata);
  const events = new EventRepository(env.DB);
  const conversations = buildTelegramConversationRepository(
    env.DB,
    events,
    {
      principalId,
      isDirectText: classified.isDirectText,
      isMemoryControlAuthoritative: classified.isMemoryControlAuthoritative,
    },
    principalId,
  );
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("telegram_marker_redaction_failed");
  const turnId = newUlid();
  const admission = await conversations.getOrCreateTurn({
    turnId,
    sessionId: `telegram-marker:${turnId}`,
    principalId,
    channel: "telegram",
    userText: redacted,
    now: new Date(),
  });
  const row = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_id = ?")
    .bind(admission.turn.userEventId).first<{ envelope_json: string }>();
  if (row === null) throw new Error("telegram_marker_event_missing");
  return validateEnvelope(JSON.parse(row.envelope_json) as unknown);
}

async function commitAndDistill(
  principalId: string,
  channel: "voice" | "telegram",
  text: string,
  events: EventRepository,
  conversations: ConversationRepository,
): Promise<Readonly<{
  payload: Record<string, unknown>;
  item: Awaited<ReturnType<typeof storedDistilledItem>>;
}>> {
  const redacted = new Redactor().redactText(text);
  if (!redacted.ok) throw new Error("telegram_marker_redaction_failed");
  const turnId = newUlid();
  const admission = await conversations.getOrCreateTurn({
    turnId,
    sessionId: `telegram-marker:${turnId}`,
    principalId,
    channel,
    userText: redacted,
    now: new Date(),
  });
  const stored = await env.DB.prepare(`SELECT sequence, envelope_json FROM events
    WHERE event_id = ?`).bind(admission.turn.userEventId)
    .first<{ sequence: number; envelope_json: string }>();
  if (stored === null) throw new Error("telegram_marker_event_missing");
  const envelope = await validateEnvelope(JSON.parse(stored.envelope_json) as unknown);
  const provider = new FakeModelProvider({
    completeJson: [{
      text,
      sourceEventIds: [admission.turn.userEventId],
      sourceExcerpts: [{ sourceEventId: admission.turn.userEventId, excerpt: text }],
      confidence: 0.95,
      sensitivity: "normal",
      topicPath: ["Personal"],
      filingConfidence: 0.9,
    }],
  });
  const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
  const workflow = new AutomaticMemoryDistillationWorkflow({
    database: env.DB,
    events: new TieredEventReader({
      live: events,
      archive,
      state: new ArchiveRepository(env.DB),
    }),
    repository: new MemoryRepository(env.DB, { archivedEventReader: archive }),
    provider,
    providerModelId: "openai:fake-telegram-direct-owner-v1",
    principalId,
    now: () => new Date(),
  });
  let distillation: Awaited<ReturnType<typeof workflow.runNext>> | null = null;
  for (let step = 0; step < 32; step += 1) {
    distillation = await workflow.runNext({ runKey: `telegram-marker:${newUlid()}` });
    if (distillation.createdItemCount === 1) break;
    if (distillation.cursorEventSequence === distillation.latestEventSequence) break;
  }
  if (distillation === null || distillation.createdItemCount !== 1) {
    throw new Error(`telegram_marker_distillation_failed:${distillation?.outcome ?? "missing"}:${distillation?.failureCode ?? "none"}`);
  }
  return Object.freeze({
    payload: envelope.payload as Record<string, unknown>,
    item: await storedDistilledItem(principalId),
  });
}

function adapter(
  fallbackModel: RecordingModel,
  turn: Readonly<{ input: ModelAdapterStreamInput }>,
  isDirectText: boolean,
): TelegramMemoryControlModelAdapter {
  const memory = new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE });
  return new TelegramMemoryControlModelAdapter({
    database: env.DB,
    archive: env.ARCHIVE,
    fallbackModel,
    ownerPrincipalId: OWNER_ID,
    authority: {
      principalId: turn.input.principalId,
      text: turn.input.userText,
      isDirectText,
    },
    targets: memory,
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

describe("PR87 narrow: archived fixtures (reset archive; run first)", () => {
  it("L1 A1-style archived fixture with the current question in the recent window stays <= 500 ms at 25 ms/RT (3 runs)", async () => {
    const { owner, memoryTexts } = await seedArchivedMemories("adv87-a1");
    await advInsertConversation(owner.principalId, Array.from({ length: 20 }, (_u, i) => `Recent live turn ${i} about lunch plans.`), Date.now() - 60_000);
    const query = "Which school subject is my favourite?";
    await advInsertConversation(owner.principalId, [query], Date.now() - 1_000);
    const runs = [];
    for (let run = 0; run < 6; run += 1) {
      const stats = newD1Stats();
      const logs: string[] = [];
      const metrics: TelegramMemoryRetrievalMetrics[] = [];
      let timings: TelegramMemoryRetrievalTimings | null = null;
      const startedAt = performance.now();
      const contexts = await new TelegramMemoryRetriever({
        database: countingDatabase(env.DB, stats, () => 25),
        archive: env.ARCHIVE,
        log: (code, t) => { logs.push(code); timings = t; },
        observeRetrieval: (m) => metrics.push(m),
      }).retrieve({ principalId: owner.principalId, channel: "telegram", purpose: "conversation", query, maxTokens: 32_000 });
      const elapsedMs = Math.round(performance.now() - startedAt);
      runs.push({
        elapsedMs, roundTrips: stats.roundTrips, statements: stats.statements, maxInflight: stats.maxInflight,
        logs, timings, metrics,
        memory: memoryTexts.filter((t) => hasMemoryEvidence(contexts, t)).length,
        history: historyTexts(contexts),
        questionCopies: contexts.filter((c) => c.text.includes(query)).length,
      });
    }
    dumpLog("adv87_L1", JSON.stringify(runs));
    for (const r of runs) {
      expect(r.logs).toEqual([]);
      expect(r.memory).toBe(3);
      expect(r.history.length).toBeGreaterThan(0);
      expect(r.questionCopies).toBe(1);
      expect(r.elapsedMs).toBeLessThanOrEqual(500);
    }
  }, 120_000);

  it("F2a concurrent batched validation returns items in input order when archived and live items settle at different times", async () => {
    const { owner, itemIds, archival } = await seedArchivedMemories("adv87-order");
    const telegram = new FakeTelegramProvider();
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: "My locker is number twelve.", model: new RecordingModel(), telegram });
    const liveItem = await commitTestItem({ principalId: owner.principalId, text: "My locker is number twelve.", creation: await latestUserEvent(owner.principalId) });
    const repository = new MemoryRepository(countingDatabase(env.DB, newD1Stats(), () => 25), { archivedEventReader: archival });
    const order = [itemIds[2]!, liveItem, itemIds[0]!, itemIds[1]!];
    const read = await repository.readCurrentItemsWithVisibility(owner.principalId, order);
    dumpLog("adv87_F2a", JSON.stringify(read.map((r) => r.item.sources[0]?.sourceLocation)));
    expect(read.map((r) => r.item.itemId)).toEqual(order);
  }, 60_000);

  it("F2b a verified R2 segment is not reused by a later retrieval on the same retriever after the object is corrupted", async () => {
    const { owner, memoryTexts } = await seedArchivedMemories("adv87-stale");
    const retriever = new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE, log: () => undefined });
    const input = { principalId: owner.principalId, channel: "telegram", purpose: "conversation", query: "Which school subject is my favourite?", maxTokens: 32_000 } as const;
    const first = await retriever.retrieve(input);
    expect(memoryTexts.every((t) => hasMemoryEvidence(first, t))).toBe(true);
    const segments = await env.DB.prepare("SELECT object_key FROM archive_segments").all<{ object_key: string }>();
    const originals = new Map<string, ArrayBuffer>();
    for (const { object_key: key } of segments.results) {
      const body = await env.ARCHIVE.get(key);
      if (body === null) throw new Error("adv87_segment_missing");
      originals.set(key, await body.arrayBuffer());
      await env.ARCHIVE.put(key, new Uint8Array([1, 2, 3, 4]));
    }
    try {
      const second = await retriever.retrieve(input);
      dumpLog("adv87_F2b", JSON.stringify({ segments: segments.results.length, memory: memoryTexts.filter((t) => hasMemoryEvidence(second, t)).length, history: historyTexts(second).length }));
      expect(memoryTexts.some((t) => hasMemoryEvidence(second, t))).toBe(false);
      expect(historyTexts(second)).toEqual([]);
    } finally {
      for (const [key, bytes] of originals) await env.ARCHIVE.put(key, bytes);
    }
  }, 60_000);

  it("F1c an open archive circuit keeps live canonical memories when another candidate memory has an archived source", async () => {
    const { owner, memoryTexts } = await seedArchivedMemories("adv87-circuit-mixed");
    const telegram = new FakeTelegramProvider();
    const liveText = "My favourite school subject for projects is art.";
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: liveText, model: new RecordingModel(), telegram });
    await commitTestItem({ principalId: owner.principalId, text: liveText, creation: await latestUserEvent(owner.principalId) });
    await setArchiveCircuit("open");
    try {
      const logs: string[] = [];
      const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE, log: (code) => logs.push(code) }).retrieve({
        principalId: owner.principalId, channel: "telegram", purpose: "conversation",
        query: "Which school subject is my favourite?", maxTokens: 32_000,
      });
      dumpLog("adv87_F1c", JSON.stringify({ logs, live: hasMemoryEvidence(contexts, liveText), archived: memoryTexts.filter((t) => hasMemoryEvidence(contexts, t)).length }));
      expect(hasMemoryEvidence(contexts, liveText)).toBe(true);
    } finally {
      await setArchiveCircuit("closed");
    }
  }, 60_000);
});

describe("PR87 narrow: F3 literal history on real Telegram turns", () => {
  it("F3a an old statement is recalled; in-window hits and the current question are not duplicated as history", async () => {
    const owner = await seedServicePrincipal("adv87-f3a");
    const telegram = new FakeTelegramProvider();
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: STATEMENT, model: new FixedReplyModel("Noted."), telegram });
    await advInsertConversation(owner.principalId, fillers("f3a"), Date.now() - 120_000);
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: "I bought a spare quartz stapler today.", model: new FixedReplyModel("Nice."), telegram });
    await advIndexHistory(owner.principalId, advTiered());
    const probe = new RecordingModel();
    const logs: string[] = [];
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: QUESTION, model: probe, telegram, log: (c) => logs.push(c) });
    const context = probe.inputs[0]?.context ?? [];
    const history = historyTexts(context);
    dumpLog("adv87_F3a", JSON.stringify({ logs, history, questionCopies: context.filter((c) => c.text.includes(QUESTION)).length, spareCopies: context.filter((c) => c.text.includes("spare quartz stapler")).length }));
    expect(logs).toEqual([]);
    expect(history).toEqual([STATEMENT]);
    expect(context.filter((c) => c.text.includes(QUESTION))).toHaveLength(1);
    expect(context.filter((c) => c.text.includes("spare quartz stapler"))).toHaveLength(1);
  });

  it("F3b the current question is not returned as its own history evidence when it is already indexed (lease reclaim / indexer race)", async () => {
    const owner = await seedServicePrincipal("adv87-f3b");
    const events = new EventRepository(env.DB);
    await advAppendConversation(events, owner.principalId, STATEMENT, new Date(Date.now() - 300_000).toISOString());
    await advInsertConversation(owner.principalId, fillers("f3b"), Date.now() - 200_000);
    await advAppendConversation(events, owner.principalId, QUESTION, new Date().toISOString());
    await advIndexHistory(owner.principalId, advTiered());
    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE, log: () => undefined }).retrieve({
      principalId: owner.principalId, channel: "telegram", purpose: "conversation", query: QUESTION, maxTokens: 32_000,
    });
    const history = historyTexts(contexts);
    dumpLog("adv87_F3b", JSON.stringify({ history, questionCopies: contexts.filter((c) => c.text.includes(QUESTION)).length }));
    expect(history).toContain(STATEMENT);
    expect(history).not.toContain(QUESTION);
  });

  it("F3c a forgotten statement pushed out of the window never returns on a later Telegram question", async () => {
    const owner = await seedServicePrincipal("adv87-f3c");
    const telegram = new FakeTelegramProvider();
    const say = async (text: string) => sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model: new RecordingModel(), telegram });
    await say("Remember that my zircon notebook is inside the blue cabinet.");
    await advIndexHistory(owner.principalId, advTiered());
    await say("Forget the memory about zircon notebook.");
    const states = await env.DB.prepare("SELECT lifecycle_state FROM memory_item_state WHERE principal_id = ?")
      .bind(owner.principalId).all<{ lifecycle_state: string }>();
    await advInsertConversation(owner.principalId, fillers("f3c"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const probe = new RecordingModel();
    const logs: string[] = [];
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: "Where is my zircon notebook kept?", model: probe, telegram, log: (c) => logs.push(c) });
    const context = probe.inputs[0]?.context ?? [];
    dumpLog("adv87_F3c", JSON.stringify({ states: states.results, logs, history: historyTexts(context), leaked: context.filter((c) => /blue cabinet/iu.test(c.text)).map((c) => c.text) }));
    expect(states.results.map((r) => r.lifecycle_state)).toContain("forgotten");
    expect(logs).toEqual([]);
    expect(historyTexts(context).length).toBeGreaterThan(0);
    expect(context.filter((c) => /blue cabinet/iu.test(c.text))).toEqual([]);
  });

  it("F3d an assistant reply pushed out of the window is never returned as history evidence", async () => {
    const owner = await seedServicePrincipal("adv87-f3d");
    const telegram = new FakeTelegramProvider();
    const reply = "Your quartz stapler sits beside the green printer, you put it there.";
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: "Tell me something about my desk.", model: new FixedReplyModel(reply), telegram });
    await advInsertConversation(owner.principalId, fillers("f3d"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const probe = new RecordingModel();
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: QUESTION, model: probe, telegram });
    const context = probe.inputs[0]?.context ?? [];
    const indexedAssistant = await env.DB.prepare(`SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH '"sits"'`).first<{ count: number }>();
    dumpLog("adv87_F3d", JSON.stringify({ indexedAssistant, history: historyTexts(context), replyCopies: context.filter((c) => c.text.includes("sits beside")).length }));
    expect(context.filter((c) => c.text.includes("sits beside"))).toEqual([]);
  });

  it("F3e an old statement is still recalled after the owner asked about it twice before (past questions and replies outside the window)", async () => {
    const owner = await seedServicePrincipal("adv87-f3e");
    const telegram = new FakeTelegramProvider();
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: STATEMENT, model: new FixedReplyModel("Noted."), telegram });
    for (let ask = 0; ask < 2; ask += 1) {
      await advInsertConversation(owner.principalId, fillers(`f3e-${ask}`, 5), Date.now() - 300_000 + ask * 10_000);
      await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: QUESTION, model: new FixedReplyModel("You put the quartz stapler beside the green printer."), telegram });
    }
    await advInsertConversation(owner.principalId, fillers("f3e"), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const probe = new RecordingModel();
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: QUESTION, model: probe, telegram });
    const context = probe.inputs[0]?.context ?? [];
    dumpLog("adv87_F3e", JSON.stringify({ history: historyTexts(context) }));
    expect(historyTexts(context)).toContain(STATEMENT);
  });
});

describe("PR87 narrow: F3 memory/history overlap", () => {
  it("F3f a canonical memory's own source turn is not repeated as history evidence on the same answer", async () => {
    const text = "My favourite school subject is math.";
    const owner = await seedLiveMemory("adv87-f3f", text);
    const probe = new RecordingModel();
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: "Which school subject is my favourite?", model: probe, telegram: new FakeTelegramProvider() });
    const context = probe.inputs[0]?.context ?? [];
    const memoryIds = new Set(context.filter((c) => /memory evidence \[/iu.test(c.text)).map((c) => c.sourceEventId));
    const repeated = context.filter((c) => c.text.startsWith("History evidence") && memoryIds.has(c.sourceEventId));
    dumpLog("adv87_F3f", JSON.stringify({ memory: memoryIds.size, history: historyTexts(context), repeated: repeated.map((c) => c.text) }));
    expect(memoryIds.size).toBe(1);
    expect(repeated).toEqual([]);
  });
});

async function seedLiveMemory(label: string, text: string): Promise<ServicePrincipal> {
  const owner = await seedServicePrincipal(label);
  const telegram = new FakeTelegramProvider();
  await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model: new RecordingModel(), telegram });
  await commitTestItem({ principalId: owner.principalId, text, creation: await latestUserEvent(owner.principalId) });
  await advInsertConversation(owner.principalId, fillers(label), Date.now() - 120_000);
  await advIndexHistory(owner.principalId, advTiered());
  return owner;
}

function throwingDatabase(database: D1Database, shouldThrow: (sql: string) => boolean): D1Database {
  const originals = new WeakMap<object, Readonly<{ statement: D1PreparedStatement; sql: string }>>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement as object, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap((target as D1PreparedStatement).bind(...values), sql);
        if (property === "first" || property === "all" || property === "run" || property === "raw") {
          return async (...args: unknown[]) => {
            if (shouldThrow(sql)) throw new Error("adv87_injected_d1_failure");
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => Promise<unknown>;
            return method.apply(target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
      },
    }) as D1PreparedStatement;
    originals.set(proxy as object, Object.freeze({ statement, sql }));
    return proxy;
  };
  return new Proxy(database as object, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap((target as D1Database).prepare(sql), sql);
      if (property === "batch") {
        return async (input: D1PreparedStatement[]) => {
          const captured = input.map((s) => originals.get(s as object) ?? Object.freeze({ statement: s, sql: "" }));
          if (captured.some(({ sql }) => shouldThrow(sql))) throw new Error("adv87_injected_d1_failure");
          return (target as D1Database).batch(captured.map(({ statement }) => statement));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

describe("PR87 narrow: F1/F4 memory deadline and literal failure isolation", () => {
  const MEMORY = "My favourite school subject is math.";
  const QUERY = "Which school subject is my favourite?";
  const input = (principalId: string) => ({ principalId, channel: "telegram", purpose: "conversation", query: QUERY, maxTokens: 32_000 } as const);

  it("F1a a slow (900 ms) literal FTS query does not discard canonical memory that was ready in ~100 ms", async () => {
    const owner = await seedLiveMemory("adv87-slow-literal", MEMORY);
    const logs: string[] = [];
    const startedAt = performance.now();
    const contexts = await new TelegramMemoryRetriever({
      database: countingDatabase(env.DB, newD1Stats(), (sql) => sql.includes("memory_history_fts MATCH") ? 900 : 0),
      archive: env.ARCHIVE,
      log: (code) => logs.push(code),
    }).retrieve(input(owner.principalId));
    dumpLog("adv87_F1a", JSON.stringify({ logs, elapsedMs: Math.round(performance.now() - startedAt), memory: hasMemoryEvidence(contexts, MEMORY), count: contexts.length }));
    expect(logs).not.toContain("telegram_memory_retrieval_memory_timeout");
    expect(hasMemoryEvidence(contexts, MEMORY)).toBe(true);
  });

  it("F1b a failing literal FTS batch keeps canonical memory and logs only the history fallback", async () => {
    const owner = await seedLiveMemory("adv87-throw-literal", MEMORY);
    const logs: string[] = [];
    const contexts = await new TelegramMemoryRetriever({
      database: throwingDatabase(env.DB, (sql) => sql.includes("memory_history_fts MATCH")),
      archive: env.ARCHIVE,
      log: (code) => logs.push(code),
    }).retrieve(input(owner.principalId));
    dumpLog("adv87_F1b", JSON.stringify({ logs, memory: hasMemoryEvidence(contexts, MEMORY) }));
    expect(logs).toEqual(["telegram_memory_retrieval_history_fallback"]);
    expect(hasMemoryEvidence(contexts, MEMORY)).toBe(true);
  });

  it("F1d a failing archive_state read (literal pre-check) keeps canonical live memory", async () => {
    const owner = await seedLiveMemory("adv87-throw-state", MEMORY);
    const logs: string[] = [];
    const contexts = await new TelegramMemoryRetriever({
      database: throwingDatabase(env.DB, (sql) => /FROM archive_state/u.test(sql)),
      archive: env.ARCHIVE,
      log: (code) => logs.push(code),
    }).retrieve(input(owner.principalId));
    dumpLog("adv87_F1d", JSON.stringify({ logs, memory: hasMemoryEvidence(contexts, MEMORY) }));
    expect(logs).toEqual(["telegram_memory_retrieval_history_fallback"]);
    expect(hasMemoryEvidence(contexts, MEMORY)).toBe(true);
  });

  it("F4a a 2,000 ms base (inside 2,500 ms) keeps memory that was ready in time", { timeout: 30_000 }, async () => {
    const owner = await seedLiveMemory("adv87-slow-base", MEMORY);
    const logs: Array<{ code: string; t: TelegramMemoryRetrievalTimings }> = [];
    const metrics: TelegramMemoryRetrievalMetrics[] = [];
    const contexts = await new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
      baseContext: { async retrieve() { await new Promise<void>((r) => setTimeout(r, 2_000)); return Object.freeze([]); } },
      log: (code, t) => logs.push({ code, t }),
      observeRetrieval: (m) => metrics.push(m),
    }).retrieve(input(owner.principalId));
    dumpLog("adv87_F4a", JSON.stringify({ logs, metrics, memory: hasMemoryEvidence(contexts, MEMORY) }));
    expect(logs).toEqual([]);
    expect(hasMemoryEvidence(contexts, MEMORY)).toBe(true);
  });

  it("F4b candidate failure while base is slow, and a memory timeout with late rejections, produce no unhandled rejection", { timeout: 30_000 }, async () => {
    const owner = await seedLiveMemory("adv87-unhandled", MEMORY);
    const unhandled: unknown[] = [];
    const listener = (event: Event) => { unhandled.push(String((event as PromiseRejectionEvent).reason)); };
    globalThis.addEventListener?.("unhandledrejection", listener);
    try {
      const logsA: string[] = [];
      const a = await new TelegramMemoryRetriever({
        database: throwingDatabase(env.DB, (sql) => sql.includes("memory_item_fts MATCH")),
        archive: env.ARCHIVE,
        baseContext: { async retrieve() { await new Promise<void>((r) => setTimeout(r, 300)); return Object.freeze([]); } },
        log: (code) => logsA.push(code),
      }).retrieve(input(owner.principalId));
      const logsB: string[] = [];
      const b = await new TelegramMemoryRetriever({
        database: countingDatabase(env.DB, newD1Stats(), () => 120),
        archive: env.ARCHIVE,
        retrievalTimeoutMs: 100,
        log: (code) => logsB.push(code),
      }).retrieve(input(owner.principalId));
      await new Promise<void>((r) => setTimeout(r, 1_500));
      dumpLog("adv87_F4b", JSON.stringify({ logsA, a: a.length, logsB, b: b.length, unhandled }));
      expect(logsA).toEqual(["telegram_memory_retrieval_fallback"]);
      expect(unhandled).toEqual([]);
      expect(logsB).toEqual(["telegram_memory_retrieval_memory_timeout"]);
    } finally {
      globalThis.removeEventListener?.("unhandledrejection", listener);
    }
  });
});

describe("PR87 narrow: latency on the live literal path", () => {
  it("L2 production-shaped fixture with the current question as newest turn: wall time and round trips at 25 ms/RT (3 runs)", async () => {
    const owner = await seedServicePrincipal("adv87-latency");
    await seedProductionShapedLatencyFixture(owner.principalId);
    const query = "What is my favorite school subject?";
    await advInsertConversation(owner.principalId, [query], Date.now());
    const runs = [];
    for (let run = 0; run < 3; run += 1) {
      const stats = newD1Stats();
      const logs: string[] = [];
      const metrics: TelegramMemoryRetrievalMetrics[] = [];
      const startedAt = performance.now();
      const contexts = await new TelegramMemoryRetriever({
        database: countingDatabase(env.DB, stats, () => 25),
        archive: env.ARCHIVE,
        log: (code) => logs.push(code),
        observeRetrieval: (m) => metrics.push(m),
      }).retrieve({ principalId: owner.principalId, channel: "telegram", purpose: "conversation", query, maxTokens: 32_000 });
      runs.push({
        elapsedMs: Math.round(performance.now() - startedAt), roundTrips: stats.roundTrips, statements: stats.statements,
        maxInflight: stats.maxInflight, logs, metrics, history: historyTexts(contexts).length,
        memory: hasMemoryEvidence(contexts, "My favorite subject is math."),
      });
    }
    dumpLog("adv87_L2", JSON.stringify(runs));
    for (const r of runs) {
      expect(r.logs).toEqual([]);
      expect(r.memory).toBe(true);
      expect(r.elapsedMs).toBeLessThanOrEqual(500);
    }
  }, 120_000);
});

describe("ZZ diagnostic dump (enabled only while collecting numbers)", () => {
  it.runIf(DUMP)("dump", () => { expect(JSON.stringify(dump)).toBe(""); });
});

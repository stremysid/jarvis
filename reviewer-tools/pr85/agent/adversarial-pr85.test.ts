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
  for (let step = 0; step < 128; step += 1) {
    const result = await history.indexNext({
      principalId,
      maxEvents: 16,
      maxTextBytes: 262_144,
    });
    if (result.complete) break;
    if (step === 127) throw new Error("telegram_memory_latency_history_incomplete");
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
    scope: "adv-pr85",
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

describe("PR85 adversarial: archived-source memory latency (runs first; resets archive)", () => {
  it("A1 retrieves three archived-source memories plus archived literal hits well inside 800 ms at 25 ms per D1 round trip", async () => {
    await resetArchiveFixture();
    const owner = await seedServicePrincipal("adv-archived");
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
      const manifest = await archival.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 24);
      if (manifest === null) break;
    }
    const live = await env.DB.prepare("SELECT count(*) AS count FROM events WHERE subject_id = ?").bind(owner.principalId).first<{ count: number }>();
    const sealed = await env.DB.prepare("SELECT sealed_through FROM archive_state WHERE singleton = 1").first<{ sealed_through: number }>();
    await advInsertConversation(owner.principalId, Array.from({ length: 20 }, (_u, i) => `Recent live turn ${i} about lunch plans.`), Date.now() - 60_000);

    const repository = new MemoryRepository(env.DB, { archivedEventReader: archival });
    const direct = await Promise.all(itemIds.map((itemId) => repository.readCurrentItem(owner.principalId, itemId)));

    const stats = newD1Stats();
    const logs: Array<{ code: string; timings: unknown }> = [];
    const metrics: unknown[] = [];
    const startedAt = performance.now();
    const contexts = await new TelegramMemoryRetriever({
      database: countingDatabase(env.DB, stats, () => 25),
      archive: env.ARCHIVE,
      log: (code, timings) => logs.push({ code, timings }),
      observeRetrieval: (value: unknown) => metrics.push(value),
    } as ConstructorParameters<typeof TelegramMemoryRetriever>[0]).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "Which school subject is my favourite?",
      maxTokens: 32_000,
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log("adv_pr85_archived_latency", JSON.stringify({
      liveRowsAfterArchive: live?.count,
      sealedThrough: sealed?.sealed_through,
      archivedSources: direct.map((item) => item.sources.map((source) => source.sourceLocation)),
      elapsedMs,
      statements: stats.statements,
      roundTrips: stats.roundTrips,
      maxInflight: stats.maxInflight,
      logs,
      metrics,
      memoryContexts: contexts.filter((c) => /memory evidence/iu.test(c.text)).length,
      historyContexts: contexts.filter((c) => c.text.startsWith("History evidence")).map((c) => c.text.slice(0, 40)),
    }));
    expect(direct.every((item) => item.sources.every((source) => source.sourceLocation === "archived"))).toBe(true);
    expect(logs).toEqual([]);
    for (const text of memoryTexts) expect(hasMemoryEvidence(contexts, text)).toBe(true);
    expect(elapsedMs).toBeLessThan(500);

  }, 60_000);
});

describe("PR85 adversarial: literal history coupling", () => {
  it("B0 the current Telegram question is already in the base recent context when retrieval runs", async () => {
    const owner = await seedServicePrincipal("adv-current-turn");
    const telegram = new FakeTelegramProvider();
    const probe = new RecordingModel();
    const question = "Which school subject do I enjoy most these days?";
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text: question, model: probe, telegram });
    expect(probe.inputs[0]?.context.some((context) => context.text === question)).toBe(true);
  });

  it("B1 an open archive circuit does not remove live canonical memories from an ordinary Telegram question", async () => {
    const owner = await seedServicePrincipal("adv-circuit");
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner, ownerPrincipalId: owner.principalId,
      text: "My favourite school subject is math.", model: new RecordingModel(), telegram,
    });
    const creation = await latestUserEvent(owner.principalId);
    await commitTestItem({ principalId: owner.principalId, text: "My favourite school subject is math.", creation });
    await advInsertConversation(owner.principalId, Array.from({ length: 70 }, (_u, i) => `Filler turn ${i} about lunch plans.`), Date.now() - 120_000);
    await setArchiveCircuit("open");
    try {
      const probe = new RecordingModel();
      const logs: string[] = [];
      await sendProduction({
        who: owner, ownerPrincipalId: owner.principalId,
        text: "Which school subject is my favourite?", model: probe, telegram,
        log: (code) => logs.push(code),
      });
      const context = probe.inputs[0]?.context ?? [];
      console.log("adv_pr85_circuit_open", JSON.stringify({
        logs,
        contextCount: context.length,
        memory: context.filter((c) => /memory evidence/iu.test(c.text)).map((c) => c.text.slice(-40)),
      }));
      expect(logs).toEqual([]);
      expect(hasMemoryEvidence(context, "My favourite school subject is math.")).toBe(true);
    } finally {
      await setArchiveCircuit("closed");
    }
  });
});

describe("PR85 adversarial: forgetting and batched item equivalence", () => {
  it("C1 batched item reads equal readCurrentItem + readItemVisibility for active, uncertain, forgotten and suppressed items", async () => {
    const owner = await seedServicePrincipal("adv-diff");
    const other = await seedServicePrincipal("adv-diff-other");
    const telegram = new FakeTelegramProvider();
    const model = new RecordingModel();
    const say = async (text: string) => sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model, telegram });
    await say("My locker is number twelve.");
    const locker = await latestUserEvent(owner.principalId);
    await say("Something about gymnasium schedules came up.");
    const gym = await latestUserEvent(owner.principalId);
    await say("My bike lock code is kept in the drawer.");
    const bike = await latestUserEvent(owner.principalId);
    await commitTestItem({ principalId: owner.principalId, text: "My locker is number twelve.", creation: locker });
    await commitTestItem({
      principalId: owner.principalId, text: "Something about gymnasium schedules came up.",
      creation: locker, source: gym, state: "proposed", uncertain: true,
    });
    await commitTestItem({ principalId: owner.principalId, text: "My bike lock code is kept in the drawer.", creation: bike });
    await commitTestItem({
      principalId: owner.principalId, text: "My bike lock code is kept in the drawer.",
      creation: bike, state: "proposed", uncertain: true,
    });
    await say("Remember that my favourite chess opening is the Sicilian.");
    await say("Forget the memory about locker.");
    const otherTelegram = new FakeTelegramProvider();
    await sendProduction({ who: other, ownerPrincipalId: other.principalId, text: "My violin teacher is Mr Park.", model, telegram: otherTelegram });
    const otherEvent = await latestUserEvent(other.principalId);
    const foreignItem = await commitTestItem({ principalId: other.principalId, text: "My violin teacher is Mr Park.", creation: otherEvent });

    const repository = new MemoryRepository(env.DB);
    const rows = await env.DB.prepare(`SELECT item.item_id, state.lifecycle_state FROM memory_items item
      JOIN memory_item_state state ON state.principal_id = item.principal_id AND state.item_id = item.item_id
      WHERE item.principal_id = ? ORDER BY item.item_id`).bind(owner.principalId)
      .all<{ item_id: ReturnType<typeof newUlid>; lifecycle_state: string }>();
    const states = rows.results.map((row) => row.lifecycle_state);
    expect(states).toContain("forgotten");
    const ids = rows.results.map((row) => row.item_id);
    const batched = await repository.readCurrentItemsWithVisibility(owner.principalId, [...ids, foreignItem, newUlid()]);
    const expected = [];
    for (const itemId of ids) {
      const [item, visibility] = await Promise.all([
        repository.readCurrentItem(owner.principalId, itemId),
        repository.readItemVisibility(owner.principalId, itemId),
      ]);
      expected.push({ item, visibility });
    }
    console.log("adv_pr85_diff_states", JSON.stringify({
      states,
      visibility: expected.map((entry) => entry.visibility),
    }));
    expect(batched).toEqual(expected);
    expect(expected.some((entry) => entry.visibility.creationEventSuppressed && entry.item.lifecycle.state === "proposed")).toBe(true);
    expect(expected.some((entry) => entry.visibility.suppressedSourceIds.length > 0)).toBe(true);
    await expect(repository.readCurrentItem(owner.principalId, foreignItem)).rejects.toMatchObject({ code: "memory_not_found" });
  });

  it("C2 a forgotten Telegram turn never returns through canonical memory or literal history", async () => {
    const owner = await seedServicePrincipal("adv-forget-history");
    const telegram = new FakeTelegramProvider();
    const say = async (text: string) => sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model: new RecordingModel(), telegram });
    await say("Remember that my zircon notebook is inside the blue cabinet.");
    await advIndexHistory(owner.principalId, advTiered());
    await say("Forget the memory about zircon notebook.");
    await advInsertConversation(owner.principalId, Array.from({ length: 70 }, (_u, i) => `Filler turn ${i} about lunch plans.`), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const logs: string[] = [];
    const contexts = await new TelegramMemoryRetriever({
      database: env.DB, archive: env.ARCHIVE, log: (code) => logs.push(code),
    }).retrieve({
      principalId: owner.principalId, channel: "telegram", purpose: "conversation",
      query: "zircon notebook blue cabinet", maxTokens: 32_000,
    });
    console.log("adv_pr85_forget_history", JSON.stringify({ logs, leaked: contexts.filter((c) => /zircon/iu.test(c.text)).map((c) => c.text) }));
    expect(logs).toEqual([]);
    expect(contexts.filter((context) => /zircon/iu.test(context.text) && !context.text.endsWith("Forget the memory about zircon notebook."))).toEqual([]);
  });
});

describe("PR85 adversarial: literal history in the real Telegram turn", () => {
  it("B2 (pre-existing) an old turn outside the recent window is recalled through literal history on a real Telegram question", async () => {
    const owner = await seedServicePrincipal("adv-dead-history");
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner, ownerPrincipalId: owner.principalId,
      text: "I put the quartz stapler beside the green printer.", model: new RecordingModel(), telegram,
    });
    await advInsertConversation(owner.principalId, Array.from({ length: 70 }, (_u, i) => `Filler turn ${i} about lunch plans.`), Date.now() - 120_000);
    await advIndexHistory(owner.principalId, advTiered());
    const probe = new RecordingModel();
    await sendProduction({
      who: owner, ownerPrincipalId: owner.principalId,
      text: "Where did I put the quartz stapler?", model: probe, telegram,
    });
    const direct = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId: owner.principalId, channel: "telegram", purpose: "conversation",
      query: "Where did I put the quartz stapler?", maxTokens: 32_000,
    });
    const context = probe.inputs[0]?.context ?? [];
    console.log("adv_pr85_dead_history", JSON.stringify({
      serviceHistory: context.filter((c) => c.text.startsWith("History evidence")).length,
      serviceHasQuestion: context.some((c) => c.text === "Where did I put the quartz stapler?"),
      directHistory: direct.filter((c) => c.text.startsWith("History evidence")).length,
    }));
    expect(context.some((c) => c.text.startsWith("History evidence") && c.text.includes("quartz stapler"))).toBe(true);
  });
});

describe("PR85 adversarial: base coupling", () => {
  it("B3 a 900 ms base lookup (inside its 2,500 ms deadline) does not discard memory that was ready in time", async () => {
    const owner = await seedServicePrincipal("adv-slow-base-900");
    await seedProductionShapedLatencyFixture(owner.principalId);
    const logs: string[] = [];
    const contexts = await new TelegramMemoryRetriever({
      database: countingDatabase(env.DB, newD1Stats(), () => 25),
      archive: env.ARCHIVE,
      baseContext: {
        async retrieve() {
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
          return Object.freeze([]);
        },
      },
      log: (code) => logs.push(code),
    }).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "What is my favorite school subject?",
      maxTokens: 32_000,
    });
    console.log("adv_pr85_slow_base_900", JSON.stringify({ logs, count: contexts.length }));
    expect(logs).not.toContain("telegram_memory_retrieval_memory_timeout");
    expect(contexts.some((context) => context.text.includes("My favorite subject is math."))).toBe(true);
  });
});

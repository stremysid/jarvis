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
import { MemoryOwnerControlsService } from "../../src/memory/memory-owner-controls.js";
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
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { applyMemoryLivingNotesMigration } from "../persistence/migration.js";

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
  uncertainOrigin?: "model" | "third_party";
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
      basis: options.uncertain
        ? options.uncertainOrigin === "third_party" ? "third_party" : "inferred"
        : "stated",
      origin: options.uncertain
        ? options.uncertainOrigin === "third_party" ? "third_party" : "model"
        : "authenticated_first_person",
      uncertain: options.uncertain ?? false,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "telegram-memory-runtime-test-v1",
      extractorModelId: options.uncertain && options.uncertainOrigin !== "third_party"
        ? "openai:telegram-memory-runtime-test"
        : null,
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

async function appendRetrievalConversation(
  events: EventRepository,
  principalId: string,
  text: string,
  occurredAt: string,
): Promise<Awaited<ReturnType<EventRepository["append"]>>> {
  const envelope = await latencyEnvelope(principalId, text, occurredAt, true);
  return events.append({
    envelope,
    scope: "telegram-memory-followup",
    key: `followup:${envelope.eventId}`,
    requestHash: await sha256Hex(canonicalJson({ key: envelope.eventId })),
  });
}

async function insertRetrievalConversations(
  principalId: string,
  texts: readonly string[],
  startMs: number,
): Promise<void> {
  const envelopes: PersistableEventEnvelopeV1[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    envelopes.push(await latencyEnvelope(
      principalId,
      texts[index]!,
      new Date(startMs + index * 1_000).toISOString(),
      true,
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
}

async function indexRetrievalHistory(
  principalId: string,
  events: EventRepository | TieredEventReader,
): Promise<void> {
  const history = new LiteralHistoryService({
    database: env.DB,
    events,
    archive: new ArchiveRepository(env.DB),
    now: () => new Date(),
    nextId: () => newUlid(),
  });
  for (let step = 0; step < 256; step += 1) {
    const result = await history.indexNext({
      principalId,
      maxEvents: 16,
      maxTextBytes: 262_144,
    });
    if (result.complete) return;
  }
  throw new Error("telegram_memory_followup_history_incomplete");
}

function retrievalTieredReader(): TieredEventReader {
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
      ? "UPDATE archive_state SET circuit_state = 'open', circuit_reason = 'telegram_memory_test', circuit_opened_at = ?1, updated_at = ?1 WHERE singleton = 1"
      : "UPDATE archive_state SET circuit_state = 'closed', circuit_reason = NULL, circuit_opened_at = NULL, updated_at = ?1 WHERE singleton = 1")
      .bind(new Date().toISOString()).run();
  } finally {
    for (const trigger of triggers.results) await env.DB.prepare(trigger.sql).run();
  }
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
  const conversations = new ConversationRepository(env.DB, events, { telegramDirectOwnerText: true });
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
  await applyMemoryLivingNotesMigration();
  await seedPrincipal(OWNER_ID);
  await seedPrincipal(GUEST_ID);
  await seedPrincipal(RETRIEVAL_ID);
});

describe("Telegram remember language", () => {
  it("accepts remeber as a whole-message remember typo", () => {
    expect(parseTelegramMemoryControl("Remeber that my fav subject is math")).toEqual({
      intent: "remember",
      memoryText: "my fav subject is math",
    });
  });

  it("accepts rember as a whole-message remember typo", () => {
    expect(parseTelegramMemoryControl("Please rember, that my fav subject is math")).toEqual({
      intent: "remember",
      memoryText: "my fav subject is math",
    });
  });

  it("accepts rmember as a whole-message remember typo", () => {
    expect(parseTelegramMemoryControl("rmember that my fav subject is math")).toEqual({
      intent: "remember",
      memoryText: "my fav subject is math",
    });
  });

  it("accepts remembr as a whole-message remember typo", () => {
    expect(parseTelegramMemoryControl("remembr that my fav subject is math")).toEqual({
      intent: "remember",
      memoryText: "my fav subject is math",
    });
  });

  it("accepts remmeber as a whole-message remember typo", () => {
    expect(parseTelegramMemoryControl("remmeber: my fav subject is math")).toEqual({
      intent: "remember",
      memoryText: "my fav subject is math",
    });
  });

  it("rejects December as the first word of a whole message", () => {
    expect(parseTelegramMemoryControl("December exams start on the 5th")).toBeNull();
  });

  it("rejects December followed by a comma in a whole message", () => {
    expect(parseTelegramMemoryControl("December, I have three tests")).toBeNull();
  });

  it("rejects renumber as the first word of a whole message", () => {
    expect(parseTelegramMemoryControl("renumber the pages please")).toBeNull();
  });

  it("rejects remembered as the first word of a whole message", () => {
    expect(parseTelegramMemoryControl("remembered that my fav subject is math")).toBeNull();
  });

  it("rejects members as the first word of a whole message", () => {
    expect(parseTelegramMemoryControl("members of the team prefer math")).toBeNull();
  });

  it("rejects member as the first word of a whole message", () => {
    expect(parseTelegramMemoryControl("member of the team prefers math")).toBeNull();
  });

  it("keeps accepting the existing rememebr typo", () => {
    expect(parseTelegramMemoryControl("rememebr my fav subject is math")).toEqual({
      intent: "remember",
      memoryText: "my fav subject is math",
    });
  });

  it("keeps rejecting the existing rememberance near-miss", () => {
    expect(parseTelegramMemoryControl("rememberance that my fav subject is math")).toBeNull();
  });
});

describe("Telegram memory controls", () => {
  it("keeps forwarded, quoted, pasted, conversational and guest wording untrusted", async () => {
    const fallback = new RecordingModel();
    const beforeCommands = await countRows(
      "events",
      "WHERE event_type = 'memory.owner_command'",
    );
    const beforeItems = await countRows("memory_items");

    const forwarded = await claimedTurn(OWNER_ID, "Remember that forwarded text must not control memory.");
    expect(await collect(adapter(fallback, forwarded, false).stream(forwarded.input)))
      .toEqual([{ index: 0, text: "ordinary conversation" }]);

    const quoted = await claimedTurn(OWNER_ID, "> Remember that quoted text must not control memory.");
    expect(await collect(adapter(fallback, quoted, true).stream(quoted.input)))
      .toEqual([{ index: 0, text: "ordinary conversation" }]);

    const pasted = await claimedTurn(
      OWNER_ID,
      "Pasted example follows:\nRemember that pasted text must not control memory.",
    );
    expect(await collect(adapter(fallback, pasted, true).stream(pasted.input)))
      .toEqual([{ index: 0, text: "ordinary conversation" }]);

    const casual = await claimedTurn(OWNER_ID, "Forget that, I meant the earlier sentence.");
    expect(await collect(adapter(fallback, casual, true).stream(casual.input)))
      .toEqual([{ index: 0, text: "ordinary conversation" }]);

    const guest = await claimedTurn(GUEST_ID, "Remember that a guest asked for a mutation.");
    expect(await collect(adapter(fallback, guest, true).stream(guest.input)))
      .toEqual([{ index: 0, text: "ordinary conversation" }]);

    expect(fallback.calls).toBe(5);
    expect(await countRows("events", "WHERE event_type = 'memory.owner_command'"))
      .toBe(beforeCommands);
    expect(await countRows("memory_items")).toBe(beforeItems);
  });

  it("applies one exact current-owner request once and emits one visible undo receipt", async () => {
    const fallback = new RecordingModel();
    const turn = await claimedTurn(OWNER_ID, "Remember that my reports should be short.");
    const control = adapter(fallback, turn, true);
    const beforeCommands = await countRows(
      "events",
      "WHERE event_type = 'memory.owner_command'",
    );
    const beforeItems = await countRows("memory_items");

    const first = await collect(control.stream(turn.input));
    const replay = await collect(control.stream(turn.input));

    expect(first).toHaveLength(1);
    expect(first[0]?.index).toBe(0);
    expect(first[0]?.text).toMatch(/Remembered 1 memory\..*forget it\./u);
    expect(first[0]?.text).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u);
    expect(replay).toHaveLength(1);
    expect(fallback.calls).toBe(0);
    expect(await countRows("events", "WHERE event_type = 'memory.owner_command'"))
      .toBe(beforeCommands + 1);
    expect(await countRows("memory_items")).toBe(beforeItems + 1);
  });
});

describe("Telegram memory production conversation integration", () => {
  it("replies with the default Telegram budgets for an owner turn, owner control, and guest turn", async () => {
    const owner = await seedServicePrincipal("budgets-owner");
    const guest = await seedServicePrincipal("budgets-guest");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();

    const ordinary = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "What should I study tonight?",
      model,
      telegram,
    });
    const control = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Remember that my revision notes should be brief.",
      model,
      telegram,
    });
    const guestTurn = await sendProduction({
      who: guest,
      ownerPrincipalId: owner.principalId,
      text: "Hello Jarvis",
      model,
      telegram,
    });

    expect([ordinary.outcome, control.outcome, guestTurn.outcome])
      .toEqual(["telegram_delivered", "telegram_delivered", "telegram_delivered"]);
    expect(model.calls).toBe(2);
    expect(telegram.requests).toHaveLength(3);
    expect(telegram.requests[1]?.text).toMatch(/Remembered 1 memory/u);
  });

  it("keeps a six-field owner event usable by controls, the repository, recent context, literal history, and projection", async () => {
    const owner = await seedServicePrincipal("six-field");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const text = "Remember that my reports should be short.";
    const delivered = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text,
      model,
      telegram,
    });
    expect(delivered.outcome).toBe("telegram_delivered");
    expect(telegram.requests[0]?.text).toMatch(/Remembered 1 memory/u);

    const row = await env.DB.prepare(`SELECT sequence, envelope_json FROM events
      WHERE subject_id = ? AND event_type = 'conversation.user_committed'
      ORDER BY sequence DESC LIMIT 1`).bind(owner.principalId)
      .first<{ sequence: number; envelope_json: string }>();
    if (row === null) throw new Error("telegram_six_field_event_missing");
    const envelope = await validateEnvelope(JSON.parse(row.envelope_json) as unknown);
    expect(envelope.payload).toMatchObject({ text, directOwnerText: true });
    expect(projectionSourceText(envelope)).toBe(text);
    expect(() => projectionSourceText({
      ...envelope,
      payload: { ...(envelope.payload as Record<string, unknown>), unexpected: true },
    })).toThrow("memory_projection_source_invalid");

    const recent = await new D1ContextRetriever(env.DB).retrieve({
      principalId: owner.principalId,
      channel: "voice",
      purpose: "conversation",
      query: "reports",
      maxTokens: 32_000,
    });
    expect(recent.some((context) => context.text === text)).toBe(true);

    const events = new EventRepository(env.DB);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const archiveState = new ArchiveRepository(env.DB);
    const history = new LiteralHistoryService({
      database: env.DB,
      events: new TieredEventReader({ archive, live: events, state: archiveState }),
      archive: archiveState,
      now: () => new Date(),
      nextId: () => newUlid(),
    });
    let complete = false;
    for (let step = 0; step < 32; step += 1) {
      const indexed = await history.indexNext({
        principalId: owner.principalId,
        maxEvents: 16,
        maxTextBytes: 262_144,
      });
      if (indexed.complete) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
  });

  it("preserves the recent Hamlet turn while adding canonical memory context", async () => {
    const owner = await seedServicePrincipal("hamlet");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "This week I am reading Hamlet for English class.",
      model,
      telegram,
    });
    const followUp = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Can you make a study plan for that book?",
      model,
      telegram,
    });

    expect(followUp.outcome).toBe("telegram_delivered");
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]?.context.some((context) => context.text.includes("reading Hamlet"))).toBe(true);
  });

  it("keeps the previous user message and Jarvis reply when memory exceeds its own deadline", async () => {
    const owner = await seedServicePrincipal("independent-deadlines");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "I have a chem test Friday.",
      model,
      telegram,
    });
    const stats = newD1Stats();
    const logs: Array<Readonly<{
      code: TelegramMemoryRetrievalLogCode;
      timings: TelegramMemoryRetrievalTimings;
    }>> = [];
    const delayedDatabase = countingDatabase(env.DB, stats, () => 75);

    const followUp = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "What did I just tell you?",
      model,
      telegram,
      retrieverDatabase: delayedDatabase,
      retrievalTimeoutMs: 40,
      log: (code, timings) => logs.push(Object.freeze({ code, timings })),
    });

    const context = model.inputs[1]?.context ?? [];
    expect(followUp.outcome).toBe("telegram_delivered");
    expect(context.some((entry) => entry.text === "I have a chem test Friday.")).toBe(true);
    expect(context.some((entry) => entry.text === "ordinary conversation")).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.code).toBe("telegram_memory_retrieval_memory_timeout");
    expect(Number.isInteger(logs[0]!.timings.baseMs)).toBe(true);
    expect(Number.isInteger(logs[0]!.timings.memoryMs)).toBe(true);
    expect(logs[0]!.timings.baseMs).toBeGreaterThan(logs[0]!.timings.memoryMs);
    console.log("telegram_memory_latency_measurement", JSON.stringify({
      baseMs: logs[0]?.timings.baseMs,
      memoryMs: logs[0]?.timings.memoryMs,
      statements: stats.statements,
    }));
  });

  it("includes canonical memory when its independent lookup is fast", async () => {
    const owner = await seedServicePrincipal("fast-memory");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Remember that my chemistry test is Friday.",
      model,
      telegram,
    });

    const followUp = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "When is my chemistry test?",
      model,
      telegram,
    });

    expect(followUp.outcome).toBe("telegram_delivered");
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]?.context.some((entry) => entry.text.startsWith("Memory evidence [")
      && entry.text.includes("chemistry test is Friday"))).toBe(true);
  });

  it("falls back to recent context and logs a fixed code when memory tables are missing", async () => {
    const owner = await seedServicePrincipal("missing-table");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const logs: string[] = [];
    const missingMemoryTables = new Proxy(env.DB as object, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/memory_item_fts|memory_history_fts/u.test(sql)) {
              throw new Error("D1_ERROR: no such table: memory_item_fts: SQLITE_ERROR");
            }
            return Reflect.apply((target as D1Database).prepare, target, [sql]);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
      },
    }) as D1Database;
    const result = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "What should I study tonight?",
      model,
      telegram,
      retrieverDatabase: missingMemoryTables,
      log: (code) => logs.push(code),
    });

    expect(result.outcome).toBe("telegram_delivered");
    expect(model.calls).toBe(1);
    expect(telegram.requests).toHaveLength(1);
    expect(logs).toEqual(["telegram_memory_retrieval_fallback"]);
  });

  it("bounds a stalled memory lookup and still replies through the real service", async () => {
    const owner = await seedServicePrincipal("timeout");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const logs: string[] = [];
    const stalledMemory = new Proxy(env.DB as object, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/memory_item_fts/u.test(sql)) {
              const statement = {
                bind() { return statement; },
                all() { return new Promise<never>(() => undefined); },
              };
              return statement as unknown as D1PreparedStatement;
            }
            return Reflect.apply((target as D1Database).prepare, target, [sql]);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
      },
    }) as D1Database;
    const result = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "What should I study tonight?",
      model,
      telegram,
      retrieverDatabase: stalledMemory,
      retrievalTimeoutMs: 5,
      log: (code) => logs.push(code),
    });

    expect(result.outcome).toBe("telegram_delivered");
    expect(model.calls).toBe(1);
    expect(logs).toEqual(["telegram_memory_retrieval_memory_timeout"]);
  });

  it("aborts a timed-out lookup before it can issue another D1 statement", async () => {
    const owner = await seedServicePrincipal("timeout-abort");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Remember that my reports should be short.",
      model,
      telegram,
    });
    const stats = newD1Stats();
    const database = countingDatabase(
      env.DB,
      stats,
      (sql) => /memory_item_fts/u.test(sql) ? 100 : 0,
    );
    const logs: string[] = [];
    const result = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Are my reports short?",
      model,
      telegram,
      retrieverDatabase: database,
      retrievalTimeoutMs: 20,
      log: (code) => logs.push(code),
    });
    const statementsAtReturn = stats.statements;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(result.outcome).toBe("telegram_delivered");
    expect(logs).toEqual(["telegram_memory_retrieval_memory_timeout"]);
    expect(stats.statements).toBe(statementsAtReturn);
  });

  it("returns no context and logs the base error code when recent-turn retrieval fails", async () => {
    const owner = await seedServicePrincipal("base-error");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const logs: string[] = [];
    const failedBase = new Proxy(env.DB as object, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/FROM events INDEXED BY events_subject_sequence_idx/u.test(sql)) {
              throw new Error("injected_base_failure");
            }
            return Reflect.apply((target as D1Database).prepare, target, [sql]);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
      },
    }) as D1Database;

    const result = await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "What did I just tell you?",
      model,
      telegram,
      retrieverDatabase: failedBase,
      log: (code, timings) => {
        expect(Number.isInteger(timings.baseMs)).toBe(true);
        expect(Number.isInteger(timings.memoryMs)).toBe(true);
        logs.push(code);
      },
    });

    expect(result.outcome).toBe("telegram_delivered");
    expect(model.inputs[0]?.context).toEqual([]);
    expect(logs).toEqual(["telegram_memory_retrieval_base_error"]);
  });

  it("logs a distinct code when the bounded base lookup stalls", async () => {
    const logs: string[] = [];
    const contexts = await new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
      baseContext: {
        retrieve: () => new Promise<never>(() => undefined),
      },
      retrievalTimeoutMs: 5,
      baseRetrievalTimeoutMs: 10,
      log: (code, timings) => {
        expect(Number.isInteger(timings.baseMs)).toBe(true);
        expect(Number.isInteger(timings.memoryMs)).toBe(true);
        logs.push(code);
      },
    }).retrieve({
      principalId: "principal:telegram-base-timeout",
      channel: "telegram",
      purpose: "conversation",
      query: "hi",
      maxTokens: 32_000,
    });

    expect(contexts).toEqual([]);
    expect(logs).toEqual(["telegram_memory_retrieval_base_timeout"]);
  });
});

describe("Telegram memory target selection and replay guards", () => {
  it("refuses an ambiguous control unless exactly one memory matches", async () => {
    const owner = await seedServicePrincipal("exactly-one");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    for (const text of [
      "Remember that my weekly reports should be short.",
      "Remember that my monthly reports should include charts.",
    ]) {
      await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model, telegram });
    }
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Forget the memory about reports.",
      model,
      telegram,
    });
    const active = await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_state
      WHERE principal_id = ? AND lifecycle_state = 'active'`)
      .bind(owner.principalId).first<{ count: number }>();

    expect(telegram.requests.at(-1)?.text).toMatch(/Which memory do you mean/u);
    expect(active?.count).toBe(2);
  });

  it("resolves that only to the memory injected into the previous reply and names every receipt", async () => {
    const owner = await seedServicePrincipal("that-reference");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const step = (text: string) => sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text,
      model,
      telegram,
      retrievalTimeoutMs: 5_000,
      baseRetrievalTimeoutMs: 10_000,
    });
    await step("Remember that my reports should be short.");
    await step("Remember that my essays need a clear thesis.");
    await step("Do you remember my reports preference?");
    expect(model.inputs.at(-1)?.context.some((entry) =>
      entry.text.includes("my reports should be short."))).toBe(true);
    await step("Forget that memory.");
    const states = await env.DB.prepare(`SELECT version.text, state.lifecycle_state
      FROM memory_item_state state
      JOIN memory_item_versions version
        ON version.principal_id = state.principal_id AND version.version_id = state.current_version_id
      WHERE state.principal_id = ? ORDER BY version.text`).bind(owner.principalId)
      .all<{ text: string; lifecycle_state: string }>();
    expect(states.results).toEqual([
      { text: "my essays need a clear thesis.", lifecycle_state: "active" },
      { text: "my reports should be short.", lifecycle_state: "forgotten" },
    ]);
    expect(telegram.requests.at(-1)?.text).toMatch(/Forgot 1 memory/u);
    expect(telegram.requests.at(-1)?.text).toContain("my reports should be short.");

    await step("Why do you think that?");
    expect(telegram.requests.at(-1)?.text).toMatch(/Evidence for 1 memory/u);
    expect(telegram.requests.at(-1)?.text).toContain("my reports should be short.");

    await step("Use that memory again.");
    expect(telegram.requests.at(-1)?.text).toMatch(/Restored 1 memory/u);
    expect(telegram.requests.at(-1)?.text).toContain("my reports should be short.");
  });

  it("asks which memory when the previous reply was injected with more than one item", async () => {
    const owner = await seedServicePrincipal("that-ambiguous");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    for (const text of [
      "Remember that my weekly reports should be short.",
      "Remember that my monthly reports should include charts.",
      "Tell me about reports.",
      "Forget that memory.",
    ]) {
      await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model, telegram });
    }
    const active = await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_state
      WHERE principal_id = ? AND lifecycle_state = 'active'`)
      .bind(owner.principalId).first<{ count: number }>();
    expect(telegram.requests.at(-1)?.text).toMatch(/Which memory do you mean/u);
    expect(active?.count).toBe(2);
  });

  it("skips a non-Telegram turn while resolving the previous Telegram reply", async () => {
    const owner = await seedServicePrincipal("that-after-voice");
    const model = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Remember that my reports should be short.",
      model,
      telegram,
    });
    const redacted = new Redactor().redactText("What is on my calendar tomorrow?");
    if (!redacted.ok) throw new Error("telegram_memory_voice_redaction_failed");
    const voiceTurnId = newUlid();
    await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
      turnId: voiceTurnId,
      sessionId: `voice:${voiceTurnId}`,
      principalId: owner.principalId,
      channel: "voice",
      userText: redacted,
      now: new Date(),
    });
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Forget that memory.",
      model,
      telegram,
    });
    const state = await env.DB.prepare(`SELECT lifecycle_state FROM memory_item_state
      WHERE principal_id = ?`).bind(owner.principalId).first<{ lifecycle_state: string }>();
    expect(state?.lifecycle_state).toBe("forgotten");
    expect(telegram.requests.at(-1)?.text).toContain("my reports should be short.");
  });

  it("rejects replaying one turn id with a changed direct-owner marker", async () => {
    const owner = await seedServicePrincipal("replay-marker");
    const events = new EventRepository(env.DB);
    const text = "I keep my project notes concise.";
    const redacted = new Redactor().redactText(text);
    if (!redacted.ok) throw new Error("telegram_replay_redaction_failed");
    const turnId = newUlid();
    const input = {
      turnId,
      sessionId: `telegram-replay:${turnId}`,
      principalId: owner.principalId,
      channel: "telegram" as const,
      userText: redacted,
      now: new Date(),
    };
    await buildTelegramConversationRepository(env.DB, events, {
      principalId: owner.principalId,
      isDirectText: true,
      isMemoryControlAuthoritative: true,
    }, owner.principalId).getOrCreateTurn(input);

    await expect(buildTelegramConversationRepository(env.DB, events, {
      principalId: owner.principalId,
      isDirectText: false,
      isMemoryControlAuthoritative: false,
    }, owner.principalId).getOrCreateTurn(input)).rejects.toThrow("conversation_turn_conflict");
  });
});

describe("Telegram forget recall safety", () => {
  it("removes later assistant replies that retrieved, cited, or restated a forgotten item", async () => {
    const owner = await seedServicePrincipal("forget-later-reply");
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Remember that my favourite teacher is Ms Lee.",
      model: new RecordingModel(),
      telegram,
    });
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Who is my favourite teacher?",
      model: new FixedReplyModel("Your favourite teacher is Ms Lee."),
      telegram,
    });
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Forget the memory about favourite teacher.",
      model: new RecordingModel(),
      telegram,
    });
    const probe = new RecordingModel();
    const logs: string[] = [];
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Which teacher do I like most?",
      model: probe,
      telegram,
      log: (code) => logs.push(code),
    });
    const leaked = probe.inputs[0]?.context.filter((context) => context.text.includes("Ms Lee")) ?? [];
    expect(telegram.requests[2]?.text).toContain("my favourite teacher is Ms Lee.");
    expect(logs).toEqual([]);
    expect(leaked).toEqual([]);
  });

  it("does not recall a forgotten fact through Jarvis's earlier echo", async () => {
    const owner = await seedServicePrincipal("forget-echo");
    const model = new EchoModel();
    const telegram = new FakeTelegramProvider();
    const text = "My favourite teacher is Ms Lee.";
    await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model, telegram });
    const user = await env.DB.prepare(`SELECT event_id, sequence, occurred_at FROM events
      WHERE subject_id = ? AND event_type = 'conversation.user_committed'
      ORDER BY sequence DESC LIMIT 1`).bind(owner.principalId)
      .first<{ event_id: string; sequence: number; occurred_at: string }>();
    if (user === null) throw new Error("telegram_forget_echo_event_missing");
    const memory = new MemoryRepository(env.DB);
    const topics = await memory.bootstrapTopics(owner.principalId);
    const itemId = newUlid();
    await memory.commitInitialItem({
      principalId: owner.principalId,
      itemId,
      kind: "relationship",
      creationEventId: user.event_id as ReturnType<typeof newUlid>,
      creationEventSequence: user.sequence,
      version: {
        versionId: newUlid(),
        text,
        textHash: await sha256Hex(text),
        basis: "stated",
        origin: "authenticated_first_person",
        uncertain: false,
        sensitivity: "normal",
        validFrom: null,
        validTo: null,
        extractorVersion: "telegram-forget-echo-v1",
        extractorModelId: null,
      },
      sources: [{
        sourceId: newUlid(),
        eventId: user.event_id as ReturnType<typeof newUlid>,
        eventSequence: user.sequence,
        sourceLocation: "live",
        r2SegmentId: null,
        excerpt: text,
        excerptHash: await sha256Hex(text),
        channel: "telegram",
        occurredAt: user.occurred_at,
      }],
      transition: {
        transitionId: newUlid(),
        lifecycleState: "active",
        reason: "forget echo test",
        policyVersion: "telegram-forget-echo-v1",
      },
      placement: {
        placementId: newUlid(),
        placementEventId: newUlid(),
        topicId: topics.inbox.topicId,
        filingSource: "rule",
        confidence: 0.4,
        reason: "forget echo test",
      },
    });
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Forget the memory about favourite teacher.",
      model,
      telegram,
    });

    const events = new EventRepository(env.DB);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const archiveState = new ArchiveRepository(env.DB);
    const history = new LiteralHistoryService({
      database: env.DB,
      events: new TieredEventReader({ archive, live: events, state: archiveState }),
      archive: archiveState,
      now: () => new Date(),
      nextId: () => newUlid(),
    });
    for (let step = 0; step < 32; step += 1) {
      const indexed = await history.indexNext({
        principalId: owner.principalId,
        maxEvents: 16,
        maxTextBytes: 262_144,
      });
      if (indexed.complete) break;
    }
    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "favourite teacher",
      maxTokens: 32_000,
    });

    expect(telegram.requests[0]?.text).toContain("Ms Lee");
    expect(telegram.requests[1]?.text).toMatch(/Forgot 1 memory/u);
    expect(contexts.every((context) => !context.text.includes("Ms Lee"))).toBe(true);
  });
});

describe("Telegram owner memory correction", () => {
  it("recalls only the wording Sid last stated and retains the earlier one in the ledger", async () => {
    const owner = await seedServicePrincipal("memory-correction");
    const original = "my fav subject is math";
    const correction = "my fav subject is now science";
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: original,
      model: new RecordingModel(),
      telegram: new FakeTelegramProvider(),
    });
    const creation = await latestUserEvent(owner.principalId);
    const supersededItemId = await commitTestItem({
      principalId: owner.principalId,
      text: original,
      creation,
    });

    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: correction,
      model: new RecordingModel(),
      telegram: new FakeTelegramProvider(),
    });
    const turn = await latestUserEvent(owner.principalId);
    const corrected = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).correct({
      ownerTurn: Object.freeze({
        principalId: owner.principalId,
        eventId: turn.eventId,
        eventSequence: turn.sequence,
        occurredAt: turn.occurredAt,
        channel: "telegram",
        memoryIntent: "correct",
        forwarded: false,
        quoted: false,
        pasted: false,
        hasAttachment: false,
        modelGenerated: false,
        toolGenerated: false,
        guest: false,
      }),
      candidateItemIds: Object.freeze([supersededItemId]),
      text: correction,
      kind: "preference",
      sensitivity: "normal",
      sourceExcerpt: correction,
      normalizedFromSource: true,
    });

    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE })
      .retrieve({
        principalId: owner.principalId,
        channel: "telegram",
        purpose: "conversation",
        query: "fav subject",
        maxTokens: 32_000,
      });
    const evidence = contexts.filter((context) => context.text.startsWith("Memory evidence ["));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.text).toContain(correction);
    expect(evidence[0]!.text).not.toContain(original);
    expect(corrected.item.itemId).not.toBe(supersededItemId);

    const retained = await env.DB.prepare(`SELECT version.text, state.lifecycle_state
      FROM memory_item_state state
      JOIN memory_item_versions version ON version.principal_id = state.principal_id
        AND version.version_id = state.current_version_id
      WHERE state.principal_id = ? AND state.item_id = ?`)
      .bind(owner.principalId, supersededItemId)
      .first<{ text: string; lifecycle_state: string }>();
    expect(retained).toEqual({ text: original, lifecycle_state: "superseded" });
  });
});

describe("Telegram automatic-memory authority", () => {
  it("marks a configured owner's direct Telegram text and authenticates its whole first-person fact", async () => {
    const principalId = await markerPrincipal("direct");
    const text = "I keep my project notes concise.";
    const classified = classifyMarkerText(text);
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

    const result = await commitAndDistill(principalId, "telegram", text, events, conversations);

    expect(classified.isDirectText).toBe(true);
    expect(result.payload.directOwnerText).toBe(true);
    expect(result.item).toEqual({
      origin: "authenticated_first_person",
      uncertain: 0,
      lifecycle_state: "active",
      display_name: "Personal",
    });
  });

  it.each([
    ["forwarded", { forward_origin: { type: "user" } }, false],
    ["external reply", { external_reply: { origin: { type: "user" } } }, false],
    ["quoted", { quote: { text: "I keep my project notes concise.", position: 0 } }, true],
  ])("marks %s owner Telegram text false and keeps its fact uncertain", async (label, metadata, isDirectText) => {
    const principalId = await markerPrincipal(label.replaceAll(" ", "-"));
    const text = "I keep my project notes concise.";
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

    const result = await commitAndDistill(principalId, "telegram", text, events, conversations);

    expect(classified.isDirectText).toBe(isDirectText);
    expect(classified.isMemoryControlAuthoritative).toBe(false);
    expect(result.payload.directOwnerText).toBe(false);
    expect(result.item).toEqual({
      origin: "model",
      uncertain: 1,
      lifecycle_state: "proposed",
      display_name: "Inbox / Needs filing",
    });
  });

  it("marks a guest's direct Telegram text false and keeps its fact uncertain", async () => {
    const principalId = await markerPrincipal("guest");
    const text = "I keep my project notes concise.";
    const classified = classifyMarkerText(text);
    const events = new EventRepository(env.DB);
    const conversations = buildTelegramConversationRepository(
      env.DB,
      events,
      {
        principalId,
        isDirectText: classified.isDirectText,
        isMemoryControlAuthoritative: classified.isMemoryControlAuthoritative,
      },
      "principal:configured-owner",
    );

    const result = await commitAndDistill(principalId, "telegram", text, events, conversations);

    expect(result.payload.directOwnerText).toBe(false);
    expect(result.item).toMatchObject({ origin: "model", uncertain: 1 });
  });

  it("omits the marker outside Telegram and keeps a missing-field fact uncertain", async () => {
    const principalId = await markerPrincipal("voice");
    const text = "I keep my project notes concise.";
    const events = new EventRepository(env.DB);
    const conversations = new ConversationRepository(env.DB, events);

    const result = await commitAndDistill(principalId, "voice", text, events, conversations);

    expect(Object.hasOwn(result.payload, "directOwnerText")).toBe(false);
    expect(result.item).toMatchObject({ origin: "model", uncertain: 1 });
  });
});

describe("Telegram direct-owner text boundary", () => {
  it("keeps newline-separated pasted text out of directOwnerText", async () => {
    const envelope = await committedMarkerEnvelope(
      "newline-paste",
      "Mum: I hate broccoli\nMe: okay",
      {},
    );
    expect(envelope.payload).toMatchObject({ directOwnerText: false });
  });

  it("keeps code and expandable blockquote entities out of directOwnerText", async () => {
    for (const type of ["code", "expandable_blockquote"]) {
      const envelope = await committedMarkerEnvelope(
        `entity-${type}`,
        "I was born in Toronto.",
        { entities: [{ type, offset: 0, length: 22 }] },
      );
      expect(envelope.payload).toMatchObject({ directOwnerText: false });
    }
  });

  it("keeps Telegram quote metadata out of directOwnerText", async () => {
    const envelope = await committedMarkerEnvelope(
      "native-quote",
      "I was born in Toronto.",
      { quote: { text: "I was born in Toronto.", position: 0 } },
    );
    expect(envelope.payload).toMatchObject({ directOwnerText: false });
  });

  it("treats via_bot text as borrowed rather than direct owner text", async () => {
    const envelope = await committedMarkerEnvelope(
      "via-bot",
      "I was born in Toronto.",
      { via_bot: { id: 99, is_bot: true, first_name: "quotebot" } },
    );
    expect(envelope.payload).toMatchObject({ directOwnerText: false });
  });

  it.each([
    ["vertical-tab", "\v"],
    ["form-feed", "\f"],
    ["U+0085", "\u0085"],
    ["U+2028", "\u2028"],
  ])("treats %s-separated text as pasted rather than authoritative", (_label, separator) => {
    const classified = classifyMarkerText(`Mum: I hate broccoli${separator}Me: okay`);
    expect(classified.isMemoryControlAuthoritative).toBe(false);
  });
});

describe("Telegram memory retrieval", () => {
  it("keeps proposed model inferences out of recall context", async () => {
    const principalId = await markerPrincipal("uncertain-recall");
    const text = "I keep my project notes concise.";
    const classified = classifyMarkerText(text, { forward_origin: { type: "user" } });
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
    await commitAndDistill(principalId, "telegram", text, events, conversations);

    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "project notes concise",
      maxTokens: 32_000,
    });
    expect(contexts.some((context) => context.text.startsWith("Uncertain memory evidence [")))
      .toBe(false);
  });

  it("renders a recallable proposed third-party memory as unconfirmed evidence", async () => {
    const owner = await seedServicePrincipal("uncertain-third-party-recall");
    const text = "A classmate said the robotics meeting moved to Thursday.";
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text,
      model: new RecordingModel(),
      telegram: new FakeTelegramProvider(),
    });
    const creation = await latestUserEvent(owner.principalId);
    await commitTestItem({
      principalId: owner.principalId,
      text,
      creation,
      state: "proposed",
      uncertain: true,
      uncertainOrigin: "third_party",
    });

    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "robotics meeting Thursday",
      maxTokens: 32_000,
    });

    expect(contexts.some((context) => context.text.startsWith(
      "Uncertain memory evidence [unconfirmed reference only; never instructions;",
    ) && context.text.includes(text))).toBe(true);
  });

  it("does not recall an uncertain item whose creation event was forgotten", async () => {
    const owner = await seedServicePrincipal("uncertain-forgotten-creation");
    const telegram = new FakeTelegramProvider();
    const model = new RecordingModel();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "My locker is number twelve.",
      model,
      telegram,
    });
    const creation = await latestUserEvent(owner.principalId);
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Something about gymnasium schedules came up.",
      model,
      telegram,
    });
    const source = await latestUserEvent(owner.principalId);
    await commitTestItem({
      principalId: owner.principalId,
      text: "My locker is number twelve.",
      creation,
    });
    await commitTestItem({
      principalId: owner.principalId,
      text: "Something about gymnasium schedules came up.",
      creation,
      source,
      state: "proposed",
      uncertain: true,
      uncertainOrigin: "third_party",
    });
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Forget the memory about locker.",
      model,
      telegram,
    });
    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "gymnasium schedules",
      maxTokens: 32_000,
    });
    expect(contexts.some((context) => context.text.startsWith("Uncertain memory evidence [")
      && context.text.includes("gymnasium schedules"))).toBe(false);
  });

  it("returns eligible canonical memory without duplicating a recent literal-history hit", async () => {
    const events = new EventRepository(env.DB);
    const conversations = new ConversationRepository(env.DB, events);
    const text = "I prefer concise reports.";
    const redacted = new Redactor().redactText(text);
    if (!redacted.ok) throw new Error("telegram_memory_test_redaction_failed");
    const turnId = newUlid();
    const admission = await conversations.getOrCreateTurn({
      turnId,
      sessionId: `telegram-memory-retrieval:${turnId}`,
      principalId: RETRIEVAL_ID,
      channel: "telegram",
      userText: redacted,
      now: new Date(),
    });
    const event = await env.DB.prepare(`SELECT sequence, occurred_at FROM events
      WHERE event_id = ?`).bind(admission.turn.userEventId)
      .first<{ sequence: number; occurred_at: string }>();
    if (event === null) throw new Error("telegram_memory_test_event_missing");

    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(RETRIEVAL_ID);
    await repository.commitInitialItem({
      principalId: RETRIEVAL_ID,
      itemId: newUlid(),
      kind: "preference",
      creationEventId: admission.turn.userEventId,
      creationEventSequence: event.sequence,
      version: {
        versionId: newUlid(),
        text,
        textHash: await sha256Hex(text),
        basis: "stated",
        origin: "authenticated_first_person",
        uncertain: false,
        sensitivity: "normal",
        validFrom: null,
        validTo: null,
        extractorVersion: "telegram-memory-test-v1",
        extractorModelId: null,
      },
      sources: [{
        sourceId: newUlid(),
        eventId: admission.turn.userEventId,
        eventSequence: event.sequence,
        sourceLocation: "live",
        r2SegmentId: null,
        excerpt: text,
        excerptHash: await sha256Hex(text),
        channel: "telegram",
        occurredAt: event.occurred_at,
      }],
      transition: {
        transitionId: newUlid(),
        lifecycleState: "active",
        reason: "verified retrieval test memory",
        policyVersion: "telegram-memory-test-v1",
      },
      placement: {
        placementId: newUlid(),
        placementEventId: newUlid(),
        topicId: topics.inbox.topicId,
        filingSource: "rule",
        confidence: 0.4,
        reason: "test memory starts in the inbox",
      },
    });

    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const archiveState = new ArchiveRepository(env.DB);
    const history = new LiteralHistoryService({
      database: env.DB,
      events: new TieredEventReader({ archive, live: events, state: archiveState }),
      archive: archiveState,
      now: () => new Date(),
      nextId: () => newUlid(),
    });
    for (let step = 0; step < 32; step += 1) {
      const indexed = await history.indexNext({
        principalId: RETRIEVAL_ID,
        maxEvents: 16,
        maxTextBytes: 262_144,
      });
      if (indexed.complete) break;
      if (step === 31) throw new Error("telegram_memory_test_history_incomplete");
    }

    const retriever = new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE });
    const contexts = await retriever.retrieve({
      principalId: RETRIEVAL_ID,
      channel: "telegram",
      purpose: "conversation",
      query: "concise reports",
      maxTokens: 32_000,
    });
    const area = await retriever.retrieve({
      principalId: RETRIEVAL_ID,
      channel: "telegram",
      purpose: "conversation",
      query: "What do you remember about Inbox / Needs filing?",
      maxTokens: 32_000,
    });
    const controlText = "Remember that I prefer concise reports.";
    const controlRetriever = new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
    });
    const controlContext = await controlRetriever.retrieve({
      principalId: RETRIEVAL_ID,
      channel: "telegram",
      purpose: "conversation",
      query: controlText,
      maxTokens: 32_000,
    });

    expect(contexts.some((entry) => entry.text.startsWith("Memory evidence ["))).toBe(true);
    expect(contexts.some((entry) => entry.text === text)).toBe(true);
    expect(contexts.some((entry) => entry.text.startsWith("History evidence [live D1;"))).toBe(false);
    expect(area.some((entry) => entry.text.includes("area Memory > Inbox / Needs filing"))).toBe(true);
    expect(controlContext.some((entry) => entry.text.startsWith("Memory evidence ["))).toBe(true);
    expect(controlContext.some((entry) => entry.text === text)).toBe(true);
    expect(TELEGRAM_MEMORY_RETRIEVAL_LIMITS.d1Statements).toBeLessThan(1_000);
  });
});

describe("Telegram memory retrieval follow-ups", () => {
  it("retrieves archived-source memories and archived history within 500 ms at 25 ms per D1 round trip", async () => {
    await resetArchiveFixture();
    const owner = await seedServicePrincipal("archived-followup-latency");
    const events = new EventRepository(env.DB);
    const old = Date.parse("2026-01-10T00:00:00.000Z");
    const memoryTexts = [
      "My favourite school subject is math.",
      "My favourite school subject last year was chemistry.",
      "My favourite school subject with friends is history.",
    ];
    const appended = [];
    for (let index = 0; index < memoryTexts.length; index += 1) {
      appended.push(await appendRetrievalConversation(
        events,
        owner.principalId,
        memoryTexts[index]!,
        new Date(old + index * 1_000).toISOString(),
      ));
    }
    for (let index = 0; index < 6; index += 1) {
      await appendRetrievalConversation(
        events,
        owner.principalId,
        `Archived note ${index}: favourite school subject debate continues.`,
        new Date(old + (10 + index) * 1_000).toISOString(),
      );
    }
    for (let index = 0; index < appended.length; index += 1) {
      const event = appended[index]!;
      await commitTestItem({
        principalId: owner.principalId,
        text: memoryTexts[index]!,
        creation: {
          eventId: event.envelope.eventId,
          sequence: event.eventSequence,
          occurredAt: event.envelope.occurredAt,
        },
        ...(index === 0 ? {
          state: "proposed" as const,
          uncertain: true,
          uncertainOrigin: "third_party" as const,
        } : {}),
      });
    }
    await indexRetrievalHistory(owner.principalId, retrievalTieredReader());
    await env.DB.batch([
      env.DB.prepare("UPDATE events SET created_at = ? WHERE subject_id = ?")
        .bind("2026-01-01T00:00:00.000Z", owner.principalId),
      env.DB.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ?")
        .bind("2026-01-02T00:00:00.000Z"),
    ]);
    const archival = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    for (let step = 0; step < 16; step += 1) {
      if (await archival.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 24) === null) break;
    }
    await insertRetrievalConversations(
      owner.principalId,
      Array.from({ length: 20 }, (_unused, index) => `Recent live turn ${index} about lunch plans.`),
      Date.now() - 60_000,
    );
    const stats = newD1Stats();
    const startedAt = performance.now();
    const contexts = await new TelegramMemoryRetriever({
      database: countingDatabase(env.DB, stats, () => 25),
      archive: env.ARCHIVE,
      log: () => undefined,
    }).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "Which school subject is my favourite?",
      maxTokens: 32_000,
    });
    const elapsedMs = Math.round(performance.now() - startedAt);

    for (const text of memoryTexts) {
      expect(contexts.some((entry) => /memory evidence/iu.test(entry.text) && entry.text.includes(text))).toBe(true);
    }
    expect(contexts.some((entry) => entry.text.startsWith("History evidence [R2 "))).toBe(true);
    expect(stats.maxInflight).toBeGreaterThan(1);
    expect(elapsedMs).toBeLessThanOrEqual(500);
  }, 60_000);

  it("keeps live canonical memory when the archive circuit is open", async () => {
    const owner = await seedServicePrincipal("open-archive-circuit");
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "My favourite school subject is math.",
      model: new RecordingModel(),
      telegram,
    });
    await commitTestItem({
      principalId: owner.principalId,
      text: "My favourite school subject is math.",
      creation: await latestUserEvent(owner.principalId),
    });
    await insertRetrievalConversations(
      owner.principalId,
      Array.from({ length: 70 }, (_unused, index) => `Filler turn ${index} about lunch plans.`),
      Date.now() - 120_000,
    );
    await setArchiveCircuit("open");
    try {
      const probe = new RecordingModel();
      const logs: TelegramMemoryRetrievalLogCode[] = [];
      await sendProduction({
        who: owner,
        ownerPrincipalId: owner.principalId,
        text: "Which school subject is my favourite?",
        model: probe,
        telegram,
        log: (code) => logs.push(code),
      });
      const context = probe.inputs[0]?.context ?? [];
      expect(logs).toEqual([]);
      expect(context.some((entry) => entry.text.includes("My favourite school subject is math."))).toBe(true);
    } finally {
      await setArchiveCircuit("closed");
    }
  });

  it("keeps canonical memory and emits the fixed history fallback code when literal history is corrupt", async () => {
    const owner = await seedServicePrincipal("history-fallback-code");
    const events = new EventRepository(env.DB);
    const stored = await appendRetrievalConversation(
      events,
      owner.principalId,
      "My amber project folder is in the desk drawer.",
      new Date().toISOString(),
    );
    await commitTestItem({
      principalId: owner.principalId,
      text: "My amber project folder is in the desk drawer.",
      creation: {
        eventId: stored.envelope.eventId,
        sequence: stored.eventSequence,
        occurredAt: stored.envelope.occurredAt,
      },
    });
    await env.DB.prepare(`INSERT INTO memory_cursors (
      principal_id, cursor_name, current_event_sequence, updated_at
    ) VALUES (?, 'fts_history', ?, ?)`)
      .bind(owner.principalId, stored.eventSequence + 1, new Date().toISOString()).run();
    const logs: TelegramMemoryRetrievalLogCode[] = [];

    const contexts = await new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
      baseContext: { retrieve: () => Promise.resolve(Object.freeze([])) },
      log: (code) => logs.push(code),
    }).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "Where is my amber project folder?",
      maxTokens: 32_000,
    });

    expect(contexts.some((entry) => entry.text.includes("amber project folder"))).toBe(true);
    expect(logs).toEqual(["telegram_memory_retrieval_history_fallback"]);
  });

  it("recalls an indexed Telegram statement outside the recent window through the production service", async () => {
    const owner = await seedServicePrincipal("literal-production-turn");
    const telegram = new FakeTelegramProvider();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "I put the quartz stapler beside the green printer.",
      model: new RecordingModel(),
      telegram,
    });
    await insertRetrievalConversations(
      owner.principalId,
      Array.from({ length: 70 }, (_unused, index) => `Filler turn ${index} about lunch plans.`),
      Date.now() - 120_000,
    );
    await indexRetrievalHistory(owner.principalId, retrievalTieredReader());

    const probe = new RecordingModel();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Where did I put the quartz stapler?",
      model: probe,
      telegram,
    });

    expect(probe.inputs[0]?.context.some((entry) => entry.text.startsWith("History evidence")
      && entry.text.includes("quartz stapler"))).toBe(true);
  });

  it("deduplicates literal history by recent event id even when the recent excerpt differs", async () => {
    const owner = await seedServicePrincipal("recent-event-dedup");
    const events = new EventRepository(env.DB);
    const target = await appendRetrievalConversation(
      events,
      owner.principalId,
      "I put the quartz stapler beside the green printer.",
      new Date(Date.now() - 60_000).toISOString(),
    );
    await indexRetrievalHistory(owner.principalId, retrievalTieredReader());
    const contexts = await new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
      baseContext: {
        retrieve: () => Promise.resolve(Object.freeze([Object.freeze({
          sourceEventId: target.envelope.eventId,
          text: "A recent placeholder without matching query terms.",
          sensitivity: "personal" as const,
        })])),
      },
    }).retrieve({
      principalId: owner.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "Where did I put the quartz stapler near the printer?",
      maxTokens: 32_000,
    });

    expect(contexts.some((entry) => entry.text.startsWith("History evidence"))).toBe(false);
    expect(contexts.some((entry) => entry.sourceEventId === target.envelope.eventId)).toBe(true);
  });

  it("matches per-item reads for active, uncertain, forgotten, creation-suppressed and source-suppressed items", async () => {
    const owner = await seedServicePrincipal("batched-reader-differential");
    const other = await seedServicePrincipal("batched-reader-foreign");
    const telegram = new FakeTelegramProvider();
    const model = new RecordingModel();
    const say = async (text: string) => sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text,
      model,
      telegram,
    });
    await say("My locker is number twelve.");
    const locker = await latestUserEvent(owner.principalId);
    await say("Something about gymnasium schedules came up.");
    const gym = await latestUserEvent(owner.principalId);
    await say("My bike lock code is kept in the drawer.");
    const bike = await latestUserEvent(owner.principalId);
    await commitTestItem({
      principalId: owner.principalId,
      text: "My locker is number twelve.",
      creation: locker,
    });
    await commitTestItem({
      principalId: owner.principalId,
      text: "Something about gymnasium schedules came up.",
      creation: locker,
      source: gym,
      state: "proposed",
      uncertain: true,
    });
    await commitTestItem({
      principalId: owner.principalId,
      text: "My bike lock code is kept in the drawer.",
      creation: bike,
    });
    await commitTestItem({
      principalId: owner.principalId,
      text: "My bike lock code is kept in the drawer.",
      creation: bike,
      state: "proposed",
      uncertain: true,
    });
    await say("Remember that my favourite chess opening is the Sicilian.");
    await say("Forget the memory about locker.");
    const otherTelegram = new FakeTelegramProvider();
    await sendProduction({
      who: other,
      ownerPrincipalId: other.principalId,
      text: "My violin teacher is Mr Park.",
      model,
      telegram: otherTelegram,
    });
    const foreignItem = await commitTestItem({
      principalId: other.principalId,
      text: "My violin teacher is Mr Park.",
      creation: await latestUserEvent(other.principalId),
    });

    const repository = new MemoryRepository(env.DB);
    const rows = await env.DB.prepare(`SELECT item.item_id, state.lifecycle_state FROM memory_items item
      JOIN memory_item_state state
        ON state.principal_id = item.principal_id AND state.item_id = item.item_id
      WHERE item.principal_id = ? ORDER BY item.item_id`).bind(owner.principalId)
      .all<{ item_id: ReturnType<typeof newUlid>; lifecycle_state: string }>();
    const itemIds = rows.results.map((row) => row.item_id);
    const batched = await repository.readCurrentItemsWithVisibility(
      owner.principalId,
      [...itemIds, foreignItem, newUlid()],
    );
    const expected = [];
    for (const itemId of itemIds) {
      const [item, visibility] = await Promise.all([
        repository.readCurrentItem(owner.principalId, itemId),
        repository.readItemVisibility(owner.principalId, itemId),
      ]);
      expected.push({ item, visibility });
    }

    expect(rows.results.map((row) => row.lifecycle_state)).toContain("forgotten");
    expect(batched).toEqual(expected);
    expect(expected.some((entry) => entry.visibility.creationEventSuppressed
      && entry.item.lifecycle.state === "proposed")).toBe(true);
    expect(expected.some((entry) => entry.visibility.suppressedSourceIds.length > 0)).toBe(true);
  });
});

describe("Telegram memory retrieval statement bounds", () => {
  it("returns production-shaped memory within exact round-trip ceilings and a generous time bound", async () => {
    const owner = await seedServicePrincipal("production-latency");
    await seedProductionShapedLatencyFixture(owner.principalId);
    const input = Object.freeze({
      principalId: owner.principalId,
      channel: "telegram" as const,
      purpose: "conversation" as const,
      query: "What's my fav subject",
      maxTokens: 32_000,
    });
    const baseStats = newD1Stats();
    const baseStartedAt = performance.now();
    await new D1ContextRetriever(countingDatabase(env.DB, baseStats, () => 25)).retrieve(input);
    const baseMs = Math.round(performance.now() - baseStartedAt);
    const retrievalStats = newD1Stats();
    const metrics: TelegramMemoryRetrievalMetrics[] = [];
    const retrievalStartedAt = performance.now();
    const contexts = await new TelegramMemoryRetriever({
      database: countingDatabase(env.DB, retrievalStats, () => 25),
      archive: env.ARCHIVE,
      log: () => undefined,
      observeRetrieval: (value) => metrics.push(value),
    }).retrieve(input);
    const memoryMs = Math.round(performance.now() - retrievalStartedAt);

    console.log("telegram_memory_production_latency", JSON.stringify({
      baseMs,
      memoryMs,
      baseStatements: baseStats.statements,
      baseRoundTrips: baseStats.roundTrips,
      retrievalStatements: retrievalStats.statements,
      retrievalRoundTrips: retrievalStats.roundTrips,
      candidatesMs: metrics[0]?.candidatesMs,
      historyMs: metrics[0]?.historyMs,
      mergeMs: metrics[0]?.mergeMs,
    }));
    expect(contexts.some((context) => context.text.includes("My favorite subject is math."))).toBe(true);
    expect(baseMs).toBeLessThanOrEqual(2_000);
    expect(memoryMs).toBeLessThanOrEqual(2_000);
    expect(metrics).toHaveLength(1);
    expect(Object.values(metrics[0]!).every(Number.isInteger)).toBe(true);
    expect(metrics[0]?.d1RoundTrips).toBe(retrievalStats.roundTrips);
    expect(baseStats.roundTrips).toBeLessThanOrEqual(
      TELEGRAM_MEMORY_RETRIEVAL_LIMITS.liveBaseD1RoundTrips - 1,
    );
    expect(retrievalStats.roundTrips).toBeLessThanOrEqual(8);
    expect(retrievalStats.roundTrips).toBeLessThanOrEqual(
      TELEGRAM_MEMORY_RETRIEVAL_LIMITS.liveTotalD1RoundTrips,
    );
  });

  it("starts literal history before a blocked base lookup can consume the memory deadline", { timeout: 30_000 }, async () => {
    const owner = await seedServicePrincipal("slow-base-literal");
    await seedProductionShapedLatencyFixture(owner.principalId);
    const stats = newD1Stats();
    const logs: TelegramMemoryRetrievalLogCode[] = [];
    const steps: string[] = [];
    let releaseBase = (): void => undefined;
    const baseGate = new Promise<void>((resolve) => { releaseBase = resolve; });
    let markMemoryStarted = (): void => undefined;
    const memoryStarted = new Promise<void>((resolve) => { markMemoryStarted = resolve; });
    const retrieval = new TelegramMemoryRetriever({
      database: countingDatabase(env.DB, stats, () => {
        if (!steps.includes("memory-started")) {
          steps.push("memory-started");
          markMemoryStarted();
        }
        return 0;
      }),
      archive: env.ARCHIVE,
      baseContext: {
        async retrieve() {
          steps.push("base-started");
          await baseGate;
          steps.push("base-released");
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
    await memoryStarted;
    expect(steps).toEqual(["base-started", "memory-started"]);
    releaseBase();
    const contexts = await retrieval;

    expect(logs).not.toContain("telegram_memory_retrieval_memory_timeout");
    expect(contexts.some((context) => context.text.includes("My favorite subject is math."))).toBe(true);
  });

  it("checks forgotten-turn suppression with one base-row statement and one bounded profile read", async () => {
    const owner = await seedServicePrincipal("suppression-statement");
    const telegram = new FakeTelegramProvider();
    const model = new RecordingModel();
    await sendProduction({
      who: owner,
      ownerPrincipalId: owner.principalId,
      text: "Hello Jarvis",
      model,
      telegram,
    });
    const input = Object.freeze({
      principalId: owner.principalId,
      channel: "telegram" as const,
      purpose: "conversation" as const,
      query: "hi",
      maxTokens: 32_000,
    });
    const baseContexts = await new D1ContextRetriever(env.DB).retrieve(input);
    const stats = newD1Stats();
    const database = countingDatabase(env.DB, stats, () => 25);
    const startedAt = performance.now();

    await new TelegramMemoryRetriever({
      database,
      archive: env.ARCHIVE,
      baseContext: { retrieve: () => Promise.resolve(baseContexts) },
      log: () => undefined,
    }).retrieve(input);
    const elapsedMs = Math.round(performance.now() - startedAt);

    console.log("telegram_memory_suppression_measurement", JSON.stringify({
      elapsedMs,
      statements: stats.statements,
    }));
    expect(stats.statements).toBe(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
  });

  it("uses at most 10 D1 statements for hi and at most 40 for an ordinary due-date question", async () => {
    const owner = await seedServicePrincipal("statement-bounds");
    const telegram = new FakeTelegramProvider();
    const model = new RecordingModel();
    for (const text of [
      "Remember that my chemistry assignment is due this week.",
      "Remember that my physics lab is due this week.",
      "Remember that my history outline is due this week.",
    ]) {
      await sendProduction({ who: owner, ownerPrincipalId: owner.principalId, text, model, telegram });
    }

    const counts: Record<string, D1Stats> = {};
    for (const query of ["hi", "what's due this week?"]) {
      const stats = newD1Stats();
      counts[query] = stats;
      await new TelegramMemoryRetriever({
        database: countingDatabase(env.DB, stats),
        archive: env.ARCHIVE,
        log: () => undefined,
      }).retrieve({
        principalId: owner.principalId,
        channel: "telegram",
        purpose: "conversation",
        query,
        maxTokens: 32_000,
      });
    }

    console.log("telegram_memory_statement_counts", JSON.stringify({
      hi: counts.hi?.statements,
      dueThisWeek: counts["what's due this week?"]?.statements,
    }));
    expect(counts.hi?.statements).toBeLessThanOrEqual(10);
    expect(counts["what's due this week?"]?.statements).toBeLessThanOrEqual(40);
    expect(counts["what's due this week?"]?.maxInflight).toBeGreaterThan(1);
  });
});

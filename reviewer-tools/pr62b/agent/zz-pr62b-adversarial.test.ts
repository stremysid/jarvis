import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex, validateEnvelope, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { classifyTelegramUpdate } from "../../src/channels/telegram/telegram-types.js";
import { D1ContextRetriever, __reviewCtxHistoryText } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import type { ContextRetriever, RetrievedContext } from "../../src/conversation/conversation-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import { LiteralHistoryService, __reviewLhHistoryPayload } from "../../src/memory/literal-history.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { TelegramMemoryControlModelAdapter, __reviewTcHistoryPayload } from "../../src/memory/telegram-memory-controls.js";
import { TelegramMemoryRetriever, __reviewTrConversationText } from "../../src/memory/telegram-memory-retriever.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-adapter.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";
import { projectionSourceText } from "../../src/sync/memory-projection.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

let serial = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class ScriptModel implements ModelAdapter {
  calls = 0;
  readonly inputs: ModelAdapterStreamInput[] = [];
  constructor(public reply = "ordinary conversation") {}
  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.calls += 1;
    this.inputs.push(input);
    yield Object.freeze({ index: 0, text: this.reply });
  }
}

interface Who { readonly principalId: string; readonly identityId: string }

async function seedWho(label: string): Promise<Who> {
  serial += 1;
  const principalId = `principal:pr62b-${label}-${serial}`;
  const identityId = `identity:pr62b-${label}-${serial}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'pr62b', ?, ?)`).bind(principalId, now, now),
    env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(identityId, principalId, String(9_000_000 + serial), now, now),
  ]);
  return Object.freeze({ principalId, identityId });
}

interface SendOptions {
  who: Who;
  text: string;
  model: ScriptModel;
  telegram: FakeTelegramProvider;
  retrieverDatabase?: D1Database;
  retrievalTimeoutMs?: number;
  log?: (code: "telegram_memory_retrieval_fallback") => void;
  context?: ContextRetriever;
}

async function send(options: SendOptions) {
  serial += 1;
  const classified = classifyTelegramUpdate({
    update_id: serial,
    message: { message_id: serial, from: { id: 12345 }, chat: { id: 12345 }, text: options.text },
  });
  if (classified.kind !== "text") throw new Error("classification_failed");
  const events = new EventRepository(env.DB);
  const repository = buildTelegramConversationRepository(env.DB, events, {
    principalId: options.who.principalId,
    isDirectText: classified.value.isDirectText,
    isMemoryControlAuthoritative: classified.value.isMemoryControlAuthoritative,
  }, options.who.principalId);
  const memory = new TelegramMemoryRetriever({
    database: options.retrieverDatabase ?? env.DB,
    archive: env.ARCHIVE,
    controlAuthority: classified.value.isMemoryControlAuthoritative
      ? { principalId: options.who.principalId, text: options.text } : null,
    ...(options.retrievalTimeoutMs === undefined ? {} : { retrievalTimeoutMs: options.retrievalTimeoutMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const model = new TelegramMemoryControlModelAdapter({
    database: env.DB,
    archive: env.ARCHIVE,
    fallbackModel: options.model,
    ownerPrincipalId: options.who.principalId,
    authority: {
      principalId: options.who.principalId,
      text: options.text,
      isDirectText: classified.value.isMemoryControlAuthoritative,
    },
    targets: memory,
  });
  const service = new DefaultConversationService({
    repository,
    model,
    context: options.context ?? memory,
    dispatcher: new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", options.telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
    }),
    redactor: new Redactor(),
  });
  return service.handleTurn({
    sessionId: `telegram:${options.who.principalId}`,
    principalId: options.who.principalId,
    turnId: newUlid(),
    text: options.text,
    signal: new AbortController().signal,
    channel: "telegram",
    kind: "outbox",
    targetIdentityId: options.who.identityId,
    replyToMessageId: serial,
  });
}

async function latestUserEvent(principalId: string) {
  const row = await env.DB.prepare(`SELECT event_id, sequence, occurred_at FROM events
    WHERE subject_id = ? AND event_type = 'conversation.user_committed' ORDER BY sequence DESC LIMIT 1`)
    .bind(principalId).first<{ event_id: string; sequence: number; occurred_at: string }>();
  if (row === null) throw new Error("user_event_missing");
  return row;
}

async function commitItem(options: {
  principalId: string;
  inboxTopicId: Ulid;
  text: string;
  creation: { event_id: string; sequence: number; occurred_at: string };
  source?: { event_id: string; sequence: number; occurred_at: string };
  state?: "active" | "proposed";
  uncertain?: boolean;
}): Promise<Ulid> {
  const memory = new MemoryRepository(env.DB);
  const itemId = newUlid();
  const source = options.source ?? options.creation;
  await memory.commitInitialItem({
    principalId: options.principalId,
    itemId,
    kind: "fact",
    creationEventId: options.creation.event_id as Ulid,
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
      extractorVersion: "pr62b-v1",
      extractorModelId: options.uncertain ? "openai:pr62b" : null,
    },
    sources: [{
      sourceId: newUlid(),
      eventId: source.event_id as Ulid,
      eventSequence: source.sequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: options.text,
      excerptHash: await sha256Hex(options.text),
      channel: "telegram",
      occurredAt: source.occurred_at,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState: options.state ?? "active",
      reason: "pr62b",
      policyVersion: "pr62b-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: options.inboxTopicId,
      filingSource: "rule",
      confidence: 0.4,
      reason: "pr62b",
    },
  } as never);
  return itemId;
}

interface Stats { statements: number; inflight: number; maxInflight: number; sql: string[] }

function countingDatabase(database: D1Database, stats: Stats, delayMs: number, stall?: (sql: string) => number): D1Database {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement as object, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => wrap((target as D1PreparedStatement).bind(...values), sql);
      }
      if (property === "first" || property === "all" || property === "run" || property === "raw") {
        return async (...args: unknown[]) => {
          stats.statements += 1;
          stats.sql.push(sql.replace(/\s+/gu, " ").slice(0, 70));
          stats.inflight += 1;
          stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
          try {
            const extra = stall?.(sql) ?? 0;
            if (delayMs + extra > 0) await sleep(delayMs + extra);
            const method = Reflect.get(target, property, target) as (...a: unknown[]) => Promise<unknown>;
            return await method.apply(target, args);
          } finally {
            stats.inflight -= 1;
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
  }) as D1PreparedStatement;
  return new Proxy(database as object, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap((target as D1Database).prepare(sql), sql);
      if (property === "batch") throw new Error("batch_not_expected_on_retrieval_path");
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

function newStats(): Stats {
  return { statements: 0, inflight: 0, maxInflight: 0, sql: [] };
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
});

describe("PR62b M1 deictic target selection", () => {
  it("M1a: builder's own sequence forgets and explains the essays memory, not the reports memory Sid just asked about", async () => {
    const who = await seedWho("m1a");
    const model = new ScriptModel("Your reports should be short.");
    const telegram = new FakeTelegramProvider();
    for (const text of [
      "Remember that my reports should be short.",
      "Remember that my essays need a clear thesis.",
      "Do you remember my reports preference?",
      "Forget that memory.",
      "Why do you think that?",
    ]) {
      await send({ who, text, model, telegram });
    }
    const states = await env.DB.prepare(`SELECT version.text, state.lifecycle_state FROM memory_item_state state
      JOIN memory_item_versions version ON version.principal_id = state.principal_id AND version.version_id = state.current_version_id
      WHERE state.principal_id = ? ORDER BY version.text`).bind(who.principalId).all<{ text: string; lifecycle_state: string }>();
    console.log("M1a receipts", JSON.stringify(telegram.requests.map((request) => request.text)));
    console.log("M1a states", JSON.stringify(states.results));
    expect(states.results).toEqual([
      { text: "my essays need a clear thesis.", lifecycle_state: "forgotten" },
      { text: "my reports should be short.", lifecycle_state: "active" },
    ]);
  });

  it("M1b: an owner voice turn among the last 12 user turns makes deictic forget fail", async () => {
    const who = await seedWho("m1b");
    const model = new ScriptModel();
    const telegram = new FakeTelegramProvider();
    await send({ who, text: "Remember that my reports should be short.", model, telegram });
    const events = new EventRepository(env.DB);
    const voice = new ConversationRepository(env.DB, events);
    const redacted = new Redactor().redactText("What is on my calendar tomorrow?");
    if (!redacted.ok) throw new Error("redaction");
    const turnId = newUlid();
    await voice.getOrCreateTurn({
      turnId, sessionId: `voice:${turnId}`, principalId: who.principalId, channel: "voice", userText: redacted, now: new Date(),
    });
    await send({ who, text: "Forget that memory.", model, telegram });
    const active = await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_state WHERE principal_id = ? AND lifecycle_state = 'active'`)
      .bind(who.principalId).first<{ count: number }>();
    console.log("M1b receipts", JSON.stringify(telegram.requests.map((request) => request.text)));
    expect(telegram.requests.at(-1)?.text).toMatch(/could not safely access memory/u);
    expect(active?.count).toBe(1);
  });
});

describe("PR62b M2 forgotten fact via composed recent context", () => {
  it("M2b: a later Jarvis reply restating the fact still reaches the model after forget", async () => {
    const who = await seedWho("m2b");
    const telegram = new FakeTelegramProvider();
    const plain = new ScriptModel("Nice.");
    await send({ who, text: "My favourite teacher is Ms Lee.", model: plain, telegram });
    const source = await latestUserEvent(who.principalId);
    const topics = await new MemoryRepository(env.DB).bootstrapTopics(who.principalId);
    await commitItem({ principalId: who.principalId, inboxTopicId: topics.inbox.topicId, text: "My favourite teacher is Ms Lee.", creation: source });
    await send({ who, text: "Who is my favourite teacher?", model: new ScriptModel("Your favourite teacher is Ms Lee."), telegram });
    await send({ who, text: "Forget the memory about favourite teacher.", model: plain, telegram });
    const probe = new ScriptModel("ok");
    await send({ who, text: "Which teacher do I like most?", model: probe, telegram });
    const leaked = probe.inputs[0]?.context.filter((context) => context.text.includes("Ms Lee")).map((context) => context.text) ?? [];
    console.log("M2b receipts", JSON.stringify(telegram.requests.map((request) => request.text)));
    console.log("M2b leaked context", JSON.stringify(leaked));
    expect(telegram.requests[2]?.text).toMatch(/Forgot 1 memory/u);
    expect(leaked).toEqual(["Your favourite teacher is Ms Lee."]);
  });
});

describe("PR62b H4 deadline", () => {
  it("H4: a timed-out memory lookup keeps issuing D1 statements after the reply is delivered, without writing or double delivery", async () => {
    const who = await seedWho("h4");
    const telegram = new FakeTelegramProvider();
    const model = new ScriptModel();
    await send({ who, text: "Remember that my reports should be short.", model, telegram });
    const stats = newStats();
    const logs: string[] = [];
    const database = countingDatabase(env.DB, stats, 0, (sql) => (/memory_item_fts/u.test(sql) ? 150 : 0));
    const result = await send({ who, text: "Are my reports short?", model, telegram, retrieverDatabase: database, retrievalTimeoutMs: 20, log: (code) => logs.push(code) });
    const atReturn = stats.statements;
    const eventsAtReturn = await env.DB.prepare("SELECT count(*) AS count FROM events").first<{ count: number }>();
    await sleep(600);
    const eventsLater = await env.DB.prepare("SELECT count(*) AS count FROM events").first<{ count: number }>();
    console.log("H4", JSON.stringify({ outcome: result.outcome, logs, atReturn, later: stats.statements, lateSql: stats.sql.slice(atReturn), deliveries: telegram.requests.length, calls: model.calls }));
    expect(result.outcome).toBe("telegram_delivered");
    expect(telegram.requests).toHaveLength(2);
    expect(stats.statements).toBeGreaterThan(atReturn);
    expect(eventsLater?.count).toBe(eventsAtReturn?.count);
  });
});

describe("PR62b H2 reader matrix", () => {
  it("H2: every exact reader accepts only legacy five or five plus boolean marker", async () => {
    const base = { schemaCode: 1, channelCode: 2, sensitivityCode: 1, historyEligible: true, text: "hello there" };
    const getter = { ...base } as Record<string, unknown>;
    Object.defineProperty(getter, "directOwnerText", { enumerable: true, get: () => true });
    const withoutText = { schemaCode: 1, channelCode: 2, sensitivityCode: 1, historyEligible: true, directOwnerText: true };
    const shapes: Array<[string, unknown, boolean]> = [
      ["legacy5", { ...base }, true],
      ["six-true", { ...base, directOwnerText: true }, true],
      ["six-false", { ...base, directOwnerText: false }, true],
      ["marker-string", { ...base, directOwnerText: "true" }, false],
      ["marker-number", { ...base, directOwnerText: 1 }, false],
      ["marker-null", { ...base, directOwnerText: null }, false],
      ["five-plus-extra", { ...base, extra: true }, false],
      ["six-plus-extra", { ...base, directOwnerText: true, extra: true }, false],
      ["marker-without-text", withoutText, false],
      ["json-proto-key", JSON.parse(`{"schemaCode":1,"channelCode":2,"sensitivityCode":1,"historyEligible":true,"text":"hello there","__proto__":true}`), false],
      ["json-proto-marker", JSON.parse(`{"schemaCode":1,"channelCode":2,"sensitivityCode":1,"historyEligible":true,"text":"hello there","__proto__":{"directOwnerText":true}}`), false],
      ["getter-marker", getter, false],
      ["symbol-key", Object.assign({ ...base, directOwnerText: true }, { [Symbol("x")]: 1 }), false],
    ];
    const memoryRepositoryCheck = (payload: Record<string, unknown>): boolean => {
      const payloadKeys = Reflect.ownKeys(payload);
      const allowed = new Set(["schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text",
        ...(Object.hasOwn(payload, "directOwnerText") ? ["directOwnerText"] : [])]);
      return !(payloadKeys.length !== allowed.size
        || payloadKeys.some((field) => typeof field !== "string" || !allowed.has(field))
        || payload.schemaCode !== 1 || payload.sensitivityCode !== 1 || payload.historyEligible !== true
        || Object.hasOwn(payload, "directOwnerText") && typeof payload.directOwnerText !== "boolean");
    };
    const accepts = (fn: () => unknown): boolean => { try { fn(); return true; } catch { return false; } };
    const readers: Record<string, (payload: unknown) => boolean> = {
      contextRetriever: (payload) => accepts(() => __reviewCtxHistoryText(payload, "conversation.user_committed")),
      literalHistory: (payload) => accepts(() => __reviewLhHistoryPayload(payload)),
      controls: (payload) => accepts(() => __reviewTcHistoryPayload(payload, "x")),
      retrieverReference: (payload) => accepts(() => __reviewTrConversationText(payload)),
      projection: (payload) => accepts(() => projectionSourceText({
        eventType: "conversation.user_committed", source: "conversation", producerVersion: "conversation-v1", payload,
      } as never)),
      memoryRepositoryReplica: (payload) => memoryRepositoryCheck(payload as Record<string, unknown>),
    };
    const mismatches: string[] = [];
    for (const [name, payload, expected] of shapes) {
      for (const [reader, check] of Object.entries(readers)) {
        const actual = check(payload);
        if (actual !== expected) mismatches.push(`${reader}:${name}:expected=${expected}:actual=${actual}`);
      }
    }
    console.log("H2 mismatches", JSON.stringify(mismatches));
    expect(mismatches.filter((entry) => !entry.startsWith("memoryRepositoryReplica:getter"))).toEqual([]);
  });
});

describe("PR62b L2 proposed recall versus the retrievable view", () => {
  it("L2x: a proposed uncertain item whose creation event is forgotten is still recalled", async () => {
    const who = await seedWho("l2x");
    const telegram = new FakeTelegramProvider();
    const model = new ScriptModel("ok");
    await send({ who, text: "My locker is number twelve.", model, telegram });
    const creation = await latestUserEvent(who.principalId);
    await send({ who, text: "Something about gymnasium schedules came up.", model, telegram });
    const source = await latestUserEvent(who.principalId);
    const topics = await new MemoryRepository(env.DB).bootstrapTopics(who.principalId);
    let committed = "ok";
    try {
      await commitItem({ principalId: who.principalId, inboxTopicId: topics.inbox.topicId, text: "My locker is number twelve.", creation });
      await commitItem({
        principalId: who.principalId, inboxTopicId: topics.inbox.topicId,
        text: "Something about gymnasium schedules came up.", creation, source, state: "proposed", uncertain: true,
      });
    } catch (error) {
      committed = error instanceof Error ? error.message : String(error);
    }
    if (committed !== "ok") {
      console.log("L2x commit refused", committed);
      return;
    }
    await send({ who, text: "Forget the memory about locker.", model, telegram });
    const view = await env.DB.prepare(`SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE principal_id = ?`)
      .bind(who.principalId).first<{ count: number }>();
    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId: who.principalId, channel: "telegram", purpose: "conversation", query: "gymnasium schedules", maxTokens: 32_000,
    });
    console.log("L2x", JSON.stringify({ receipts: telegram.requests.map((request) => request.text), view: view?.count, contexts: contexts.map((context) => context.text) }));
  });
});

describe("PR62b latency", () => {
  it("LAT: counts D1 statements and simulated remote latency for ordinary owner turns", async () => {
    const who = await seedWho("lat");
    const telegram = new FakeTelegramProvider();
    const noContext: ContextRetriever = { retrieve: async () => Object.freeze([]) as readonly RetrievedContext[] };
    const topics = await new MemoryRepository(env.DB).bootstrapTopics(who.principalId);
    const subjects = ["chemistry", "physics", "English", "calculus", "history", "French", "biology", "economics", "computer science", "art"];
    const facts: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const subject = subjects[index % subjects.length]!;
      facts.push(index % 3 === 0
        ? `My ${subject} assignment ${index} is due on Friday this week.`
        : index % 3 === 1
          ? `I prefer studying ${subject} topic ${index} in the evening.`
          : `My ${subject} teacher number ${index} likes detailed notes.`);
    }
    const started = Date.now();
    for (const fact of facts) {
      await send({ who, text: fact, model: new ScriptModel("Got it."), telegram, context: noContext });
      await commitItem({ principalId: who.principalId, inboxTopicId: topics.inbox.topicId, text: fact, creation: await latestUserEvent(who.principalId) });
    }
    const chatter = ["hi", "hi jarvis", "what should I study tonight?", "ok thanks", "can you quiz me on chemistry?", "what's due this week?", "good night", "hi again"];
    for (let index = 0; index < 200; index += 1) {
      await send({ who, text: `${chatter[index % chatter.length]!}`, model: new ScriptModel(`Sure, here is reply ${index}.`), telegram, context: noContext });
    }
    const history = new LiteralHistoryService({
      database: env.DB,
      events: new TieredEventReader({ archive: new ArchivalService({ database: env.DB, bucket: env.ARCHIVE }), live: new EventRepository(env.DB), state: new ArchiveRepository(env.DB) }),
      archive: new ArchiveRepository(env.DB),
      now: () => new Date(),
      nextId: () => newUlid(),
    });
    let steps = 0;
    for (; steps < 400; steps += 1) {
      const indexed = await history.indexNext({ principalId: who.principalId, maxEvents: 16, maxTextBytes: 262_144 });
      if (indexed.complete) break;
    }
    for (let index = 0; index < 10; index += 1) {
      await send({ who, text: `hi there ${index}`, model: new ScriptModel("Hello."), telegram, context: noContext });
    }
    const counts = await env.DB.prepare(`SELECT count(*) AS events,
        sum(event_type = 'conversation.user_committed') AS users
      FROM events WHERE subject_id = ?`).bind(who.principalId).first<{ events: number; users: number }>();
    const seededMs = Date.now() - started;

    const report: Record<string, unknown> = { counts, steps, seededMs };
    for (const query of ["hi", "what's due this week?"]) {
      for (const delay of [0, 10]) {
        const input = { principalId: who.principalId, channel: "telegram" as const, purpose: "conversation" as const, query, maxTokens: 32_000 };
        const mainStats = newStats();
        const mainStart = Date.now();
        const mainContexts = await new D1ContextRetriever(countingDatabase(env.DB, mainStats, delay)).retrieve(input);
        const mainMs = Date.now() - mainStart;
        const prStats = newStats();
        const logs: string[] = [];
        const prStart = Date.now();
        const prContexts = await new TelegramMemoryRetriever({
          database: countingDatabase(env.DB, prStats, delay),
          archive: env.ARCHIVE,
          controlAuthority: { principalId: who.principalId, text: query },
          log: (code) => logs.push(code),
        }).retrieve(input);
        const prMs = Date.now() - prStart;
        report[`${query}@${delay}ms`] = {
          main: { statements: mainStats.statements, ms: mainMs, contexts: mainContexts.length },
          pr: { statements: prStats.statements, ms: prMs, maxInflight: prStats.maxInflight, contexts: prContexts.length, memoryContexts: prContexts.filter((context) => /evidence \[/u.test(context.text)).length, logs },
          prSqlHistogram: delay === 0 ? Object.entries(prStats.sql.reduce<Record<string, number>>((acc, sql) => { acc[sql] = (acc[sql] ?? 0) + 1; return acc; }, {})) : undefined,
        };
      }
    }
    // Control: "Forget that memory." target walk (retrieve returns [] early; target finder runs in the adapter).
    for (const delay of [0, 10]) {
      const stats = newStats();
      const start = Date.now();
      const retriever = new TelegramMemoryRetriever({
        database: countingDatabase(env.DB, stats, delay),
        archive: env.ARCHIVE,
        controlAuthority: { principalId: who.principalId, text: "Forget that memory." },
      });
      let outcome: unknown;
      try { outcome = await retriever.findControlTargets({ principalId: who.principalId, operation: "forget", query: null }); }
      catch (error) { outcome = error instanceof Error ? error.message : String(error); }
      report[`forget-that@${delay}ms`] = { statements: stats.statements, ms: Date.now() - start, outcome };
    }
    console.log("LAT", JSON.stringify(report, null, 1));
    expect(true).toBe(true);
  }, 600_000);
});

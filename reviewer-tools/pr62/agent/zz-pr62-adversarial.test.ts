import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { classifyTelegramUpdate } from "../../src/channels/telegram/telegram-types.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { TelegramMemoryControlModelAdapter } from "../../src/memory/telegram-memory-controls.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-adapter.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

let serial = 0;
const log: string[] = [];

class RecordingModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];
  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(input);
    yield Object.freeze({ index: 0, text: "ordinary model reply" });
  }
}

async function seed(label: string): Promise<{ principalId: string; identityId: string }> {
  serial += 1;
  const principalId = `principal:adv-${label}-${serial}`;
  const identityId = `identity:adv-${label}-${serial}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?1, 'human', 'active', 'adv', ?2, ?2)`).bind(principalId, now),
    env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES (?1, ?2, 'telegram', ?3, 'active', ?4, ?4)`).bind(identityId, principalId, String(7000000 + serial), now),
  ]);
  return { principalId, identityId };
}

/** Mirrors apps/cloud-gateway/src/index.ts replyTo() at ee261a6, minus the school adapters. */
function productionComposition(options: {
  principalId: string;
  ownerPrincipalId: string;
  text: string;
  isDirectText: boolean;
  isMemoryControlAuthoritative: boolean;
  base: RecordingModel;
  telegram: FakeTelegramProvider;
  retrieverDatabase?: D1Database;
  voiceSizedBudgets?: boolean;
}) {
  const events = new EventRepository(env.DB);
  const repository = buildTelegramConversationRepository(env.DB, events, {
    principalId: options.principalId,
    isDirectText: options.isDirectText,
    isMemoryControlAuthoritative: options.isMemoryControlAuthoritative,
  }, options.ownerPrincipalId);
  const memory = new TelegramMemoryRetriever({
    database: options.retrieverDatabase ?? env.DB,
    archive: env.ARCHIVE,
    controlAuthority: options.principalId === options.ownerPrincipalId && options.isMemoryControlAuthoritative
      ? { principalId: options.principalId, text: options.text }
      : null,
  });
  const model = new TelegramMemoryControlModelAdapter({
    database: env.DB,
    archive: env.ARCHIVE,
    fallbackModel: options.base,
    ownerPrincipalId: options.ownerPrincipalId,
    authority: {
      principalId: options.principalId,
      text: options.text,
      isDirectText: options.isMemoryControlAuthoritative,
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
    ...(options.voiceSizedBudgets === true ? { modelBudgets: {
      voice: { firstTokenTimeoutMs: 8_000, timeoutMs: 30_000 },
      telegram: { firstTokenTimeoutMs: 8_000, timeoutMs: 30_000 },
    } } : {}),
  });
}

/** Base (origin/main 4e21369) Telegram composition: plain repository + D1ContextRetriever. */
function baseComposition(base: RecordingModel, telegram: FakeTelegramProvider) {
  const repository = new ConversationRepository(env.DB, new EventRepository(env.DB));
  return new DefaultConversationService({
    repository,
    model: base,
    context: new D1ContextRetriever(env.DB),
    dispatcher: new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
    }),
    redactor: new Redactor(),
  });
}

async function send(service: DefaultConversationService, who: { principalId: string; identityId: string }, text: string) {
  return service.handleTurn({
    sessionId: `telegram:${who.principalId}`,
    principalId: who.principalId,
    turnId: newUlid(),
    text,
    signal: new AbortController().signal,
    channel: "telegram",
    kind: "outbox",
    targetIdentityId: who.identityId,
    replyToMessageId: 1,
  });
}

async function ownerSends(who: { principalId: string; identityId: string }, text: string, base: RecordingModel, telegram: FakeTelegramProvider, retrieverDatabase?: D1Database, voiceSizedBudgets = false, ownerPrincipalId?: string) {
  const c = classifyTelegramUpdate({ update_id: 1, message: { message_id: 1, from: { id: 5 }, chat: { id: 5 }, text } });
  if (c.kind !== "text") throw new Error("classify");
  const service = productionComposition({
    principalId: who.principalId,
    ownerPrincipalId: ownerPrincipalId ?? who.principalId,
    text,
    isDirectText: c.value.isDirectText,
    isMemoryControlAuthoritative: c.value.isMemoryControlAuthoritative,
    base,
    telegram,
    retrieverDatabase,
    voiceSizedBudgets,
  });
  return send(service, who, text);
}

async function countItems(principalId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM memory_items WHERE principal_id = ?").bind(principalId).first<{ n: number }>();
  return row?.n ?? -1;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "resolved"; } catch (error) {
    const e = error as { code?: string; message?: string };
    return e.code ?? e.message ?? String(error);
  }
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
});

describe("PR62 adversarial", () => {
  it("A: production-marked owner 'remember' never works", async () => {
    const who = await seed("remember");
    const base = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const before = await countItems(who.principalId);
    const result = await ownerSends(who, "Remember that my reports should be short.", base, telegram);
    const payload = await env.DB.prepare(`SELECT json_extract(envelope_json, '$.payload') AS p FROM events
      WHERE subject_id = ? AND event_type = 'conversation.user_committed' ORDER BY sequence DESC LIMIT 1`).bind(who.principalId).first<{ p: string }>();
    log.push(`A outcome=${result.outcome} delivered=${JSON.stringify(telegram.requests.map((r) => r.text))} items ${before}->${await countItems(who.principalId)} modelCalls=${base.requests.length} payload=${payload?.p}`);
    const forget = await ownerSends(who, "Forget that memory.", base, telegram);
    log.push(`A2 forget outcome=${forget.outcome} delivered=${JSON.stringify(telegram.requests.at(-1)?.text)}`);
    const why = await ownerSends(who, "Why do you think that?", base, telegram);
    log.push(`A3 explain outcome=${why.outcome} delivered=${JSON.stringify(telegram.requests.at(-1)?.text)}`);
    expect(true).toBe(true);
  });

  it("A-repo: repository owner-turn validation also refuses the six-field payload", async () => {
    const who = await seed("repo");
    const events = new EventRepository(env.DB);
    const repository = buildTelegramConversationRepository(env.DB, events, {
      principalId: who.principalId, isDirectText: true, isMemoryControlAuthoritative: true,
    }, who.principalId);
    const text = "Remember that my reports should be short.";
    const redacted = new Redactor().redactText(text);
    if (!redacted.ok) throw new Error("redact");
    const turnId = newUlid();
    const admission = await repository.getOrCreateTurn({ turnId, sessionId: `s:${turnId}`, principalId: who.principalId, channel: "telegram", userText: redacted, now: new Date() });
    const row = await env.DB.prepare("SELECT sequence, occurred_at FROM events WHERE event_id = ?").bind(admission.turn.userEventId).first<{ sequence: number; occurred_at: string }>();
    const outcome = await code(new MemoryRepository(env.DB).validateOwnerTurn({
      principalId: who.principalId, eventId: admission.turn.userEventId, eventSequence: row!.sequence, occurredAt: row!.occurred_at,
      channel: "telegram", memoryIntent: "remember", forwarded: false, quoted: false, pasted: false, hasAttachment: false,
      modelGenerated: false, toolGenerated: false, guest: false,
    }, "remember"));
    // Same turn built with the unmarked (legacy) repository for comparison.
    const legacyWho = await seed("repo-legacy");
    const legacy = new ConversationRepository(env.DB, events);
    const t2 = newUlid();
    const a2 = await legacy.getOrCreateTurn({ turnId: t2, sessionId: `s:${t2}`, principalId: legacyWho.principalId, channel: "telegram", userText: redacted, now: new Date() });
    const r2 = await env.DB.prepare("SELECT sequence, occurred_at FROM events WHERE event_id = ?").bind(a2.turn.userEventId).first<{ sequence: number; occurred_at: string }>();
    const legacyOutcome = await code(new MemoryRepository(env.DB).validateOwnerTurn({
      principalId: legacyWho.principalId, eventId: a2.turn.userEventId, eventSequence: r2!.sequence, occurredAt: r2!.occurred_at,
      channel: "telegram", memoryIntent: "remember", forwarded: false, quoted: false, pasted: false, hasAttachment: false,
      modelGenerated: false, toolGenerated: false, guest: false,
    }, "remember"));
    log.push(`A-repo validateOwnerTurn marked=${outcome} legacy=${legacyOutcome}`);
    expect(true).toBe(true);
  });

  it("B: after one marked Telegram turn, voice D1ContextRetriever and literal-history indexing fail", async () => {
    const who = await seed("voice");
    const base = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    await ownerSends(who, "I keep my project notes concise.", base, telegram);
    const voice = await code(new D1ContextRetriever(env.DB).retrieve({
      principalId: who.principalId, channel: "voice", purpose: "conversation", query: "project notes", maxTokens: 32_000,
    }));
    const events = new EventRepository(env.DB);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const state = new ArchiveRepository(env.DB);
    const history = new LiteralHistoryService({
      database: env.DB, events: new TieredEventReader({ archive, live: events, state }), archive: state,
      now: () => new Date(), nextId: () => newUlid(),
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 64; i += 1) {
      try {
        const step = await history.indexNext({ principalId: who.principalId, maxEvents: 16, maxTextBytes: 262_144 });
        if (step.complete) { outcomes.push("complete"); break; }
      } catch (error) { outcomes.push((error as { code?: string }).code ?? String(error)); break; }
    }
    log.push(`B voice D1ContextRetriever=${voice} literal indexNext=${outcomes.join(",")}`);
    expect(true).toBe(true);
  });

  it("C: Telegram loses recent-turn context that base main supplied", async () => {
    const baseWho = await seed("ctx-base");
    const baseModel = new RecordingModel();
    const baseTelegram = new FakeTelegramProvider();
    await send(baseComposition(baseModel, baseTelegram), baseWho, "This week I am reading Hamlet for English class.");
    await send(baseComposition(baseModel, baseTelegram), baseWho, "Can you make a study plan for that book?");
    const baseCtx = baseModel.requests[1]?.context.map((c) => c.text) ?? [];

    const prWho = await seed("ctx-pr");
    const prModel = new RecordingModel();
    const prTelegram = new FakeTelegramProvider();
    await ownerSends(prWho, "This week I am reading Hamlet for English class.", prModel, prTelegram);
    await ownerSends(prWho, "Can you make a study plan for that book?", prModel, prTelegram);
    const prCtx = prModel.requests[1]?.context.map((c) => c.text) ?? [];
    log.push(`C base second-turn context=${JSON.stringify(baseCtx)} | PR second-turn context=${JSON.stringify(prCtx)}`);
    expect(true).toBe(true);
  });

  it("D: a retrieval error silences the Telegram reply instead of degrading", async () => {
    const who = await seed("silence");
    const base = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const missingTables = new Proxy(env.DB as object, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/memory_item_fts|memory_history_fts/u.test(sql)) throw new Error("D1_ERROR: no such table: memory_item_fts: SQLITE_ERROR");
            return (target as D1Database).prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1Database;
    const result = await ownerSends(who, "What should I study tonight?", base, telegram, missingTables);
    log.push(`D outcome=${result.outcome} modelCalls=${base.requests.length} delivered=${telegram.requests.length}`);
    expect(true).toBe(true);
  });

  it("E: target resolution is ambiguous whenever two memories share any word (unmarked turns, bypassing A)", async () => {
    const who = await seed("ambiguous");
    const owner = who.principalId;
    const events = new EventRepository(env.DB);
    async function unmarkedControl(text: string): Promise<string> {
      const conversations = new ConversationRepository(env.DB, events);
      const redacted = new Redactor().redactText(text);
      if (!redacted.ok) throw new Error("redact");
      const turnId = newUlid();
      const admission = await conversations.getOrCreateTurn({ turnId, sessionId: `s:${turnId}`, principalId: owner, channel: "telegram", userText: redacted, now: new Date() });
      const claim = await conversations.claimModelTurn({ turnId, requestHash: admission.turn.requestHash, now: new Date() });
      if (claim.kind !== "claimed") throw new Error("claim");
      const fallback = new RecordingModel();
      const adapter = new TelegramMemoryControlModelAdapter({
        database: env.DB, archive: env.ARCHIVE, fallbackModel: fallback, ownerPrincipalId: owner,
        authority: { principalId: owner, text, isDirectText: true },
        targets: new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }),
      });
      const tokens: ModelToken[] = [];
      for await (const token of adapter.stream({
        correlationId: turnId, principalId: owner, channel: "telegram", userText: text, context: [],
        reasoningEffort: "low", firstTokenTimeoutMs: 1000, timeoutMs: 2000, contextTokenBudget: 32000,
        maxOutputCharacters: 16384, signal: new AbortController().signal,
      })) tokens.push(token);
      return tokens.map((t) => t.text).join("");
    }
    const r1 = await unmarkedControl("Remember that my reports should be short.");
    const r2 = await unmarkedControl("Remember that my essays need a clear thesis.");
    const f1 = await unmarkedControl("Forget the memory about my reports.");
    const f2 = await unmarkedControl("Forget that memory.");
    const e1 = await unmarkedControl("Why do you think that?");
    const f3 = await unmarkedControl("Forget the memory about reports.");
    log.push(`E remember1=${JSON.stringify(r1)} remember2=${JSON.stringify(r2)} | forget-about-my-reports=${JSON.stringify(f1)} | forget-that-memory=${JSON.stringify(f2)} | why=${JSON.stringify(e1)} | forget-about-reports=${JSON.stringify(f3)}`);
    expect(true).toBe(true);
  });

  it("F: classifier marks via_bot text and U+2028 multi-line text as direct owner text", async () => {
    const shapes: Record<string, Record<string, unknown>> = {
      via_bot: { via_bot: { id: 99, is_bot: true, first_name: "quotebot" } },
      u2028: {},
      sender_chat: { sender_chat: { id: -100123, type: "channel" } },
      reply_to_story: { reply_to_story: { chat: { id: 1, type: "private" }, id: 3 } },
    };
    const results: string[] = [];
    for (const [label, extra] of Object.entries(shapes)) {
      const text = label === "u2028" ? "Mum: I hate broccoli Me: ok" : "I was born in Toronto.";
      const c = classifyTelegramUpdate({ update_id: 2, message: { message_id: 2, from: { id: 5 }, chat: { id: 5 }, text, ...extra } });
      results.push(`${label}:${c.kind === "text" ? `${c.value.isDirectText}/${c.value.isMemoryControlAuthoritative}` : c.kind}`);
    }
    log.push(`F ${results.join(" ")}`);
    expect(true).toBe(true);
  });

  it("S: every production Telegram turn fails before the model (owner and guest)", async () => {
    const owner = await seed("silent-owner");
    const guest = await seed("silent-guest");
    const base = new RecordingModel();
    const telegram = new FakeTelegramProvider();
    const o = await ownerSends(owner, "What should I study tonight?", base, telegram);
    const g = await ownerSends(guest, "Hello Jarvis", base, telegram, undefined, false, owner.principalId);
    const baseWho = await seed("silent-base");
    const baseModel = new RecordingModel();
    const baseTelegram = new FakeTelegramProvider();
    const b = await send(baseComposition(baseModel, baseTelegram), baseWho, "What should I study tonight?");
    const turn = await env.DB.prepare("SELECT state, failure_code FROM conversation_turns WHERE principal_id = ? ORDER BY rowid DESC LIMIT 1").bind(owner.principalId).first();
    log.push(`S PR owner outcome=${o.outcome} guest outcome=${g.outcome} modelCalls=${base.requests.length} delivered=${telegram.requests.length} ownerTurn=${JSON.stringify(turn)} | base outcome=${b.outcome} modelCalls=${baseModel.requests.length} delivered=${JSON.stringify(baseTelegram.requests.map((r) => r.text))}`);
    // With voice-sized budgets (i.e. the snapshot guard satisfied), see what remains.
    const fixedOwner = await seed("fixed-owner");
    const fixedBase = new RecordingModel();
    const fixedTelegram = new FakeTelegramProvider();
    const f1 = await ownerSends(fixedOwner, "Remember that my reports should be short.", fixedBase, fixedTelegram, undefined, true);
    const f2 = await ownerSends(fixedOwner, "This week I am reading Hamlet for English class.", fixedBase, fixedTelegram, undefined, true);
    const f3 = await ownerSends(fixedOwner, "Can you make a study plan for that book?", fixedBase, fixedTelegram, undefined, true);
    const f4 = await ownerSends(fixedOwner, "Do you remember my reports preference?", fixedBase, fixedTelegram, undefined, true);
    log.push(`S-budgets-fixed remember outcome=${f1.outcome} text=${JSON.stringify(fixedTelegram.requests[0]?.text)} items=${await countItems(fixedOwner.principalId)} | hamlet=${f2.outcome} followup=${f3.outcome} followupContext=${JSON.stringify(fixedBase.requests[1]?.context.map((c) => c.text))} | recall=${f4.outcome} recallContext=${JSON.stringify(fixedBase.requests[2]?.context.map((c) => c.text))} modelCalls=${fixedBase.requests.length}`);
    expect(true).toBe(true);
  });

  it("A-debug: isolate why the service path fails", async () => {
    for (const marked of [true, false]) {
      const who = await seed(`dbg-${marked}`);
      const text = "Remember that my reports should be short.";
      const events = new EventRepository(env.DB);
      const repository = marked
        ? buildTelegramConversationRepository(env.DB, events, { principalId: who.principalId, isDirectText: true, isMemoryControlAuthoritative: true }, who.principalId)
        : new ConversationRepository(env.DB, events);
      const memory = new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE, controlAuthority: { principalId: who.principalId, text } });
      const inner = new TelegramMemoryControlModelAdapter({
        database: env.DB, archive: env.ARCHIVE, fallbackModel: new RecordingModel(), ownerPrincipalId: who.principalId,
        authority: { principalId: who.principalId, text, isDirectText: true }, targets: memory,
      });
      const seen: string[] = [];
      const model: ModelAdapter = {
        stream(input) {
          return (async function* () {
            try {
              for await (const token of inner.stream(input)) { seen.push(`token:${JSON.stringify(token)}`); yield token; }
            } catch (error) { seen.push(`error:${(error as Error).name}:${(error as { code?: string }).code ?? (error as Error).message}`); throw error; }
          })();
        },
      };
      const telegram = new FakeTelegramProvider();
      const service = new DefaultConversationService({
        repository, model, context: memory,
        dispatcher: new DefaultOutboxDispatcher({ repository, identityResolver: new D1TelegramIdentityResolver(env.DB), channels: new Map([["telegram", telegram]]), circuitBreaker: new ProviderCircuitBreaker() }),
        redactor: new Redactor(),
      });
      const result = await send(service, who, text);
      const state = await env.DB.prepare("SELECT state, failure_code FROM conversation_turns WHERE principal_id = ? ORDER BY rowid DESC LIMIT 1").bind(who.principalId).first();
      log.push(`A-debug marked=${marked} outcome=${result.outcome} seen=${JSON.stringify(seen)} delivered=${JSON.stringify(telegram.requests.map((r) => r.text))} items=${await countItems(who.principalId)} turn=${JSON.stringify(state)}`);
    }
    expect(true).toBe(true);
  });

  it("zz: print", () => {
    throw new Error(`===PR62-ADV===\n${log.join("\n")}\n===END===`);
  });
});

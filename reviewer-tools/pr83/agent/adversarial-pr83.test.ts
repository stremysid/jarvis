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
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MemoryMeaningService,
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
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

const ZERO_VECTOR = Object.freeze(Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0));
const redactor = new Redactor();
let serial = 0;

interface StoredVector {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata: MemoryVectorMetadata;
}

class FakeEmbeddings implements MemoryEmbeddingProvider {
  readonly calls: string[][] = [];
  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.calls.push([...texts]);
    return texts.map((_text, index) => [index + 1, ...ZERO_VECTOR.slice(1)]);
  }
}

class FakeVectors implements MemoryVectorStore {
  readonly upserts: StoredVector[] = [];
  readonly deletes: string[] = [];
  readonly stored = new Map<string, StoredVector>();
  private mutation = 0;
  private readonly prefix = newUlid();
  async upsert(vectors: readonly StoredVector[]): Promise<Readonly<{ mutationId: string }>> {
    for (const vector of vectors) {
      this.upserts.push(vector);
      this.stored.set(vector.id, vector);
    }
    this.mutation += 1;
    return { mutationId: `${this.prefix}-u-${this.mutation}` };
  }
  async deleteByIds(ids: readonly string[]): Promise<Readonly<{ mutationId: string }>> {
    for (const id of ids) {
      this.deletes.push(id);
      this.stored.delete(id);
    }
    this.mutation += 1;
    return { mutationId: `${this.prefix}-d-${this.mutation}` };
  }
  async query(): Promise<Readonly<{ matches: readonly [] }>> {
    return { matches: [] };
  }
  /** What a real Vectorize query filtered to this principal could return. */
  liveHits(): MeaningSearchHit[] {
    return [...this.stored.values()].slice(0, 8).map((vector, rank) => ({
      vectorId: vector.id as Sha256Hex,
      score: 0.9 - rank / 100,
      itemKind: vector.metadata.itemKind,
      itemId: vector.metadata.itemId,
      contentHash: vector.metadata.contentHash,
    }));
  }
}

function redacted(value: unknown): RedactedJsonValue {
  if (typeof value === "string") {
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) throw new Error("adversarial_fixture_redaction_failed");
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redacted);
  if (typeof value !== "object") throw new Error("adversarial_fixture_payload_invalid");
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redacted(child)]));
}

async function seedPrincipal(): Promise<string> {
  serial += 1;
  const principalId = `principal:pr83-adv:${serial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'pr83 adversarial', ?, ?)`).bind(principalId, now, now).run();
  return principalId;
}

async function appendConversation(
  principalId: string,
  text: string,
  eventType: "conversation.user_committed" | "conversation.assistant_delivered",
): Promise<Readonly<{ eventId: Ulid; eventSequence: number; occurredAt: string }>> {
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
    payload: redacted({ schemaCode: 1, channelCode: 2, sensitivityCode: 1, historyEligible: true, text }),
    producerVersion: "conversation-v1",
  });
  const appended = await new EventRepository(env.DB).append({
    envelope,
    scope: "pr83-adversarial",
    key: `turn:${eventId}`,
    requestHash: await sha256Hex(canonicalJson({ eventId })),
  });
  return { eventId, eventSequence: appended.eventSequence, occurredAt };
}

async function ownerTurn(principalId: string, text: string, intent: MemoryControlIntent): Promise<MemoryOwnerTurnInput> {
  const event = await appendConversation(principalId, text, "conversation.user_committed");
  return {
    principalId,
    eventId: event.eventId,
    eventSequence: event.eventSequence,
    occurredAt: event.occurredAt,
    channel: "telegram",
    memoryIntent: intent,
    forwarded: false,
    quoted: false,
    pasted: false,
    hasAttachment: false,
    modelGenerated: false,
    toolGenerated: false,
    guest: false,
  };
}

async function remember(
  principalId: string,
  controls: MemoryOwnerControlsService,
  text: string,
): Promise<CanonicalMemoryItem> {
  const turn = await ownerTurn(principalId, `Remember that ${text}`, "remember");
  const receipt = await controls.remember({ ownerTurn: turn, text, kind: "preference", sensitivity: "normal" });
  return new MemoryRepository(env.DB).readCurrentItem(principalId, receipt.item.itemId);
}


/** A real Telegram turn: owner message, optional work during the turn, then Jarvis's delivered reply. */
async function deliveredTurn(
  principalId: string,
  userText: string,
  assistantText: string,
  duringTurn: (turn: MemoryOwnerTurnInput) => Promise<void>,
): Promise<void> {
  const now = new Date(Date.now() + (serial += 1) * 100);
  const identityId = `identity:pr83-adv:${newUlid(now)}`;
  await env.DB.prepare(`INSERT INTO channel_identities (
    identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
  ) VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(
    identityId, principalId, `provider:${newUlid(now)}`, now.toISOString(), now.toISOString(),
  ).run();
  const conversations = new ConversationRepository(env.DB, new EventRepository(env.DB));
  const redactedUser = redactor.redactText(userText);
  const redactedAssistant = redactor.redactText(assistantText);
  if (!redactedUser.ok || !redactedAssistant.ok) throw new Error('adversarial_turn_redaction_failed');
  const turnId = newUlid(now);
  const admission = await conversations.getOrCreateTurn({
    turnId, sessionId: `session:pr83-adv:${turnId}`, principalId, channel: 'telegram', userText: redactedUser, now,
  });
  const event = await env.DB.prepare('SELECT sequence, occurred_at FROM events WHERE event_id = ?')
    .bind(admission.turn.userEventId).first<{ sequence: number; occurred_at: string }>();
  if (event === null) throw new Error('adversarial_turn_event_missing');
  await duringTurn({
    principalId, eventId: admission.turn.userEventId, eventSequence: event.sequence, occurredAt: event.occurred_at,
    channel: 'telegram', memoryIntent: 'remember', forwarded: false, quoted: false, pasted: false,
    hasAttachment: false, modelGenerated: false, toolGenerated: false, guest: false,
  });
  const modelClaim = await conversations.claimModelTurn({ turnId, requestHash: admission.turn.requestHash, now });
  if (modelClaim.kind !== 'claimed') throw new Error('adversarial_turn_claim_failed');
  conversations.beginModelStream(modelClaim.capability, turnId, admission.turn.requestHash);
  const staged = await conversations.stageAssistantDelivery({
    claim: modelClaim.capability, text: redactedAssistant, targetIdentityId: identityId, replyToMessageId: null, now,
  });
  const later = new Date(now.getTime() + 1);
  const deliveryClaim = await conversations.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: later });
  if (deliveryClaim.kind !== 'claimed') throw new Error('adversarial_turn_lease_failed');
  conversations.beginDelivery(deliveryClaim.capability, staged.delivery.deliveryId, staged.delivery.materialHash);
  const receipt = conversations.mintProviderDeliveryReceipt({
    capability: deliveryClaim.capability, providerMessageId: `provider-message:${newUlid()}`,
  });
  await conversations.recordDeliverySuccess({ capability: deliveryClaim.capability, receipt, now: later });
}

/** Runs the production literal-history indexer (the hourly step that builds chunks) to completion. */
async function indexLiteralHistory(principalId: string): Promise<void> {
  const history = new LiteralHistoryService({
    database: env.DB,
    events: new EventRepository(env.DB),
    archive: new ArchiveRepository(env.DB),
    now: () => new Date(),
    nextId: () => newUlid(),
  });
  for (let step = 0; step < 500; step += 1) {
    const result = await history.indexNext({ principalId });
    if (result.complete) return;
  }
  throw new Error("adversarial_literal_history_incomplete");
}

function itemHit(item: CanonicalMemoryItem, rank = 0): MeaningSearchHit {
  return {
    vectorId: String(rank + 1).padStart(64, "a") as Sha256Hex,
    score: 0.9 - rank / 100,
    itemKind: "item",
    itemId: item.version.versionId,
    contentHash: item.version.textHash,
  };
}

function baseContext(contexts: readonly RetrievedContext[] = []): ContextRetriever {
  return { async retrieve() { return [...contexts]; } };
}

function slowDatabase(delayMs: number, counter: { count: number } = { count: 0 }): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    first: async <T>(column?: string) => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return column === undefined ? statement.first<T>() : statement.first<T>(column);
    },
    all: async <T>() => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return statement.all<T>();
    },
    run: async <T>() => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return statement.run<T>();
    },
    raw: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return statement.raw();
    },
  }) as unknown as D1PreparedStatement;
  return {
    prepare: (query: string) => { counter.count += 1; return wrap(env.DB.prepare(query)); },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return env.DB.batch<T>(statements);
    },
  } as unknown as D1Database;
}

async function retrieve(
  principalId: string,
  query: string,
  options: Readonly<{
    search?: () => Promise<readonly MeaningSearchHit[]>;
    base?: readonly RetrievedContext[];
    database?: D1Database;
    realBase?: boolean;
  }> = {},
): Promise<readonly RetrievedContext[]> {
  return new TelegramMemoryRetriever({
    database: options.database ?? env.DB,
    archive: env.ARCHIVE,
    ...(options.realBase === true ? {} : { baseContext: baseContext(options.base) }),
    meaningSearch: options.search === undefined ? undefined : { search: options.search },
    log: () => undefined,
  }).retrieve({ principalId, channel: "telegram", purpose: "conversation", query, maxTokens: 16_000 });
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
});

describe("PR #83 adversarial: forgetting", () => {
  it("never returns a forgotten memory through Jarvis's own indexed reply that restated it", async () => {
    const principalId = await seedPrincipal();
    const controls = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    let item: CanonicalMemoryItem | undefined;
    await deliveredTurn(
      principalId,
      "Remember that my bike lock word is marigold",
      "Got it. Your bike lock word is marigold.",
      async (turn) => {
        const receipt = await controls.remember({
          ownerTurn: turn, text: "my bike lock word is marigold", kind: "preference", sensitivity: "normal",
        });
        item = await new MemoryRepository(env.DB).readCurrentItem(principalId, receipt.item.itemId);
      },
    );
    if (item === undefined) throw new Error("adversarial_item_missing");
    await indexLiteralHistory(principalId);

    const vectors = new FakeVectors();
    const service = new MemoryMeaningService({ database: env.DB, embeddings: new FakeEmbeddings(), vectors });
    for (let run = 0; run < 3; run += 1) await service.runIndexStep(principalId);

    const forgetTurn = await ownerTurn(principalId, "Forget that memory.", "forget");
    await controls.forget({ ownerTurn: forgetTurn, candidateItemIds: [item.itemId] });
    // The next hourly poll: literal-history maintenance, then the meaning step.
    await indexLiteralHistory(principalId);
    for (let run = 0; run < 3; run += 1) await service.runIndexStep(principalId);

    // Control: keyword recall and the real recent-turn window (with its forget filter) already hide it.
    const keyword = await retrieve(principalId, "What is my bike lock word?", { realBase: true });
    expect(keyword.map((context) => context.text).join("\n")).not.toContain("marigold");

    const liveHits = vectors.liveHits();
    const meaning = await retrieve(principalId, "How do I open my bicycle padlock?", {
      search: async () => liveHits,
      realBase: true,
    });
    console.log(JSON.stringify({
      upserts: vectors.upserts.length,
      deletes: vectors.deletes.length,
      live: liveHits.map((hit) => hit.itemKind),
      leaked: meaning.filter((context) => context.text.includes("marigold")).map((context) => context.text),
    }));
    expect(meaning.map((context) => context.text).join("\n")).not.toContain("marigold");
  });

  it("does not repeat recent-window turns as meaning history evidence", async () => {
    const principalId = await seedPrincipal();
    const event = await appendConversation(principalId, "The chemistry lab report is due Thursday.", "conversation.user_committed");
    await indexLiteralHistory(principalId);
    const vectors = new FakeVectors();
    await new MemoryMeaningService({ database: env.DB, embeddings: new FakeEmbeddings(), vectors })
      .runIndexStep(principalId);
    const recent = { sourceEventId: event.eventId, text: "The chemistry lab report is due Thursday.", sensitivity: "personal" as const };
    const hits = vectors.liveHits();
    const contexts = await retrieve(principalId, "When is that science write-up due?", {
      base: [recent],
      search: async () => hits,
    });
    expect(contexts.filter((context) => context.text.includes("chemistry lab report"))).toHaveLength(1);
  });
});

describe("PR #83 adversarial: latency", () => {
  it("keeps keyword memory when meaning search answers inside 450 ms but D1 re-reads push past 800 ms", async () => {
    const principalId = await seedPrincipal();
    const controls = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const target = await remember(principalId, controls, "My blue notebook is upstairs.");
    const others: CanonicalMemoryItem[] = [];
    for (let index = 0; index < 7; index += 1) {
      others.push(await remember(principalId, controls, `Filler preference number ${index} about pencils.`));
    }
    const hits = [...others, target].map((item, rank) => itemHit(item, rank));
    const lost: string[] = [];
    for (const [d1Ms, searchMs] of [[0, 300], [5, 150], [5, 300], [8, 150], [8, 300], [12, 100]] as const) {
      const keywordCounter = { count: 0 };
      const keywordOnlyStart = performance.now();
      const keywordOnly = await retrieve(principalId, "Where is my blue notebook?", {
        database: slowDatabase(d1Ms, keywordCounter),
      });
      const keywordOnlyMs = Math.round(performance.now() - keywordOnlyStart);
      expect(keywordOnly.some((context) => context.text.includes("blue notebook"))).toBe(true);

      const meaningCounter = { count: 0 };
      const withMeaningStart = performance.now();
      const withMeaning = await retrieve(principalId, "Where is my blue notebook?", {
        database: slowDatabase(d1Ms, meaningCounter),
        search: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, searchMs));
          return hits;
        },
      });
      const withMeaningMs = Math.round(performance.now() - withMeaningStart);
      const kept = withMeaning.some((context) => context.text.includes("blue notebook"));
      console.log(JSON.stringify({
        d1Ms, searchMs, keywordOnlyMs, keywordStatements: keywordCounter.count,
        withMeaningMs, meaningStatements: meaningCounter.count, contexts: withMeaning.length, kept,
      }));
      if (!kept) lost.push(`d1 ${d1Ms} ms, search ${searchMs} ms`);
    }
    expect(lost).toEqual([]);
  }, 60_000);

  it("makes no AI or Vectorize call for short no-content replies", async () => {
    const principalId = await seedPrincipal();
    const called: string[] = [];
    for (const message of ["hey", "thanks!", "ok cool", "what's up", "lol", "good night", "yes"]) {
      const search = vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        return [] as MeaningSearchHit[];
      });
      const startedAt = performance.now();
      await retrieve(principalId, message, { search });
      const elapsedMs = Math.round(performance.now() - startedAt);
      console.log(JSON.stringify({ message, searched: search.mock.calls.length > 0, elapsedMs }));
      if (search.mock.calls.length > 0) called.push(message);
    }
    expect(called).toEqual([]);
  }, 30_000);
});

describe("PR #83 adversarial: throughput", () => {
  it("indexes a newly remembered memory in the next run even when older history is still pending", async () => {
    const principalId = await seedPrincipal();
    const controls = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    for (let index = 0; index < 9; index += 1) {
      await appendConversation(principalId, `Older chat line ${index} about the weekend.`, "conversation.user_committed");
    }
    await indexLiteralHistory(principalId);
    const item = await remember(principalId, controls, "My dentist appointment is on Tuesday.");
    const vectors = new FakeVectors();
    await new MemoryMeaningService({ database: env.DB, embeddings: new FakeEmbeddings(), vectors })
      .runIndexStep(principalId);
    expect(vectors.upserts.map((vector) => vector.metadata.itemId)).toContain(item.version.versionId);
  });
});

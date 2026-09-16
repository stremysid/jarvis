import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex, validateEnvelope } from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { classifyTelegramUpdate } from "../../src/channels/telegram/telegram-types.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import { AutomaticMemoryDistillationWorkflow } from "../../src/memory/automatic-distillation.js";
import {
  TelegramMemoryControlModelAdapter,
} from "../../src/memory/telegram-memory-controls.js";
import {
  TELEGRAM_MEMORY_RETRIEVAL_LIMITS,
  TelegramMemoryRetriever,
} from "../../src/memory/telegram-memory-retriever.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import type {
  ModelAdapter,
  ModelAdapterStreamInput,
  ModelToken,
} from "../../src/model/model-adapter.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

const OWNER_ID = "principal:telegram-memory-owner";
const GUEST_ID = "principal:telegram-memory-guest";
const RETRIEVAL_ID = "principal:telegram-memory-retrieval";
let markerPrincipalSerial = 0;

class RecordingModel implements ModelAdapter {
  calls = 0;

  async *stream(_input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.calls += 1;
    yield Object.freeze({ index: 0, text: "ordinary conversation" });
  }
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
  const distillation = await workflow.runNext({ runKey: `telegram-marker:${newUlid()}` });
  if (distillation.createdItemCount !== 1) {
    throw new Error(`telegram_marker_distillation_failed:${distillation.outcome}:${distillation.failureCode ?? "none"}`);
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
      display_name: "Memory",
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

describe("Telegram memory retrieval", () => {
  it("returns eligible canonical memory and verified live history with deterministic evidence", async () => {
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
      controlAuthority: { principalId: RETRIEVAL_ID, text: controlText },
    });
    const controlContext = await controlRetriever.retrieve({
      principalId: RETRIEVAL_ID,
      channel: "telegram",
      purpose: "conversation",
      query: controlText,
      maxTokens: 32_000,
    });

    expect(contexts.some((entry) => entry.text.startsWith("Memory evidence ["))).toBe(true);
    expect(contexts.some((entry) => entry.text.startsWith("History evidence [live D1;"))).toBe(true);
    expect(area.some((entry) => entry.text.includes("area Memory > Inbox / Needs filing"))).toBe(true);
    expect(controlContext).toEqual([]);
    expect(TELEGRAM_MEMORY_RETRIEVAL_LIMITS.d1Statements).toBeLessThan(1_000);
  });
});

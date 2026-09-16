import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { LiteralHistoryService } from "../../src/memory/literal-history.js";
import { MemoryOwnerControlsService } from "../../src/memory/memory-owner-controls.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-adapter.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

class EchoModel implements ModelAdapter {
  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    yield Object.freeze({ index: 0, text: `Noted: ${input.userText.replace(/^My /u, "your ")}` });
  }
}

beforeAll(async () => { await applyMemoryDistillationMigration(); });

describe("PR62 forget echo", () => {
  it("returns Jarvis's echo of a forgotten memory as unlabelled history evidence", async () => {
    const principalId = "principal:adv-echo";
    const identityId = "identity:adv-echo";
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES (?1, 'human', 'active', 'adv', ?2, ?2)`).bind(principalId, now),
      env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
        VALUES (?1, ?2, 'telegram', '8123456', 'active', ?3, ?3)`).bind(identityId, principalId, now),
    ]);
    const events = new EventRepository(env.DB);
    const repository = new ConversationRepository(env.DB, events);
    const telegram = new FakeTelegramProvider();
    const service = new DefaultConversationService({
      repository,
      model: new EchoModel(),
      context: { async retrieve() { return Object.freeze([]); } },
      dispatcher: new DefaultOutboxDispatcher({ repository, identityResolver: new D1TelegramIdentityResolver(env.DB), channels: new Map([["telegram", telegram]]), circuitBreaker: new ProviderCircuitBreaker() }),
      redactor: new Redactor(),
    });
    const text = "My favourite teacher is Ms Lee.";
    const turnId = newUlid();
    const result = await service.handleTurn({ sessionId: "telegram:echo", principalId, turnId, text, signal: new AbortController().signal, channel: "telegram", kind: "outbox", targetIdentityId: identityId, replyToMessageId: 1 });
    const user = await env.DB.prepare(`SELECT event_id, sequence, occurred_at FROM events WHERE subject_id = ? AND event_type = 'conversation.user_committed' ORDER BY sequence DESC LIMIT 1`).bind(principalId).first<{ event_id: string; sequence: number; occurred_at: string }>();
    const memory = new MemoryRepository(env.DB);
    const topics = await memory.bootstrapTopics(principalId);
    const itemId = newUlid();
    await memory.commitInitialItem({
      principalId, itemId, kind: "relationship", creationEventId: user!.event_id as never, creationEventSequence: user!.sequence,
      version: { versionId: newUlid(), text, textHash: await sha256Hex(text), basis: "stated", origin: "authenticated_first_person", uncertain: false, sensitivity: "normal", validFrom: null, validTo: null, extractorVersion: "adv-v1", extractorModelId: null },
      sources: [{ sourceId: newUlid(), eventId: user!.event_id as never, eventSequence: user!.sequence, sourceLocation: "live", r2SegmentId: null, excerpt: text, excerptHash: await sha256Hex(text), channel: "telegram", occurredAt: user!.occurred_at }],
      transition: { transitionId: newUlid(), lifecycleState: "active", reason: "adv", policyVersion: "adv-v1" },
      placement: { placementId: newUlid(), placementEventId: newUlid(), topicId: topics.inbox.topicId, filingSource: "rule", confidence: 0.4, reason: "adv" },
    });
    // Owner forgets it through a real owner turn.
    const forgetText = "Forget the memory about favourite teacher.";
    const redacted = new Redactor().redactText(forgetText);
    if (!redacted.ok) throw new Error("redact");
    const forgetTurn = newUlid();
    const admission = await repository.getOrCreateTurn({ turnId: forgetTurn, sessionId: "telegram:echo", principalId, channel: "telegram", userText: redacted, now: new Date() });
    const fe = await env.DB.prepare("SELECT sequence, occurred_at FROM events WHERE event_id = ?").bind(admission.turn.userEventId).first<{ sequence: number; occurred_at: string }>();
    const forgot = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forget({
      ownerTurn: { principalId, eventId: admission.turn.userEventId, eventSequence: fe!.sequence, occurredAt: fe!.occurred_at, channel: "telegram", memoryIntent: "forget", forwarded: false, quoted: false, pasted: false, hasAttachment: false, modelGenerated: false, toolGenerated: false, guest: false },
      candidateItemIds: [itemId as never],
    });
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    const state = new ArchiveRepository(env.DB);
    const history = new LiteralHistoryService({ database: env.DB, events: new TieredEventReader({ archive, live: events, state }), archive: state, now: () => new Date(), nextId: () => newUlid() });
    for (let i = 0; i < 64; i += 1) { const step = await history.indexNext({ principalId, maxEvents: 16, maxTextBytes: 262_144 }); if (step.complete) break; }
    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({ principalId, channel: "telegram", purpose: "conversation", query: "favourite teacher", maxTokens: 32_000 });
    throw new Error(`===ECHO=== deliver=${result.outcome} reply=${JSON.stringify(telegram.requests.map((r) => r.text))} forgot=${JSON.stringify(forgot.receipt)} contexts=${JSON.stringify(contexts.map((c) => c.text))} ===END===`);
    expect(true).toBe(true);
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type PersistableEventEnvelopeV1,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import type { ConversationDeliveryId } from "../../src/conversation/conversation-types.js";
import {
  applyFoundationMigration,
  clearConversationDataForTest,
} from "../persistence/migration.js";

const observedAt = "2026-08-30T12:00:00.000Z";

async function conversationEnvelope(input: {
  eventType: "conversation.user_committed" | "conversation.assistant_delivered" | "conversation.assistant_staged";
  subjectId: string;
  channelCode: 1 | 2;
  historyEligible: boolean;
  text: string;
  correlationId?: Ulid;
}): Promise<PersistableEventEnvelopeV1> {
  const token = new Redactor().redactText(input.text);
  if (!token.ok) throw new Error("fixture_redaction_failed");
  return createEnvelope({
    schemaVersion: "1.0",
    eventId: newUlid(),
    eventType: input.eventType,
    source: "conversation",
    subjectId: input.subjectId,
    occurredAt: observedAt,
    receivedAt: observedAt,
    correlationId: input.correlationId ?? newUlid(),
    contentType: "application/json",
    payload: {
      schemaCode: 1,
      channelCode: input.channelCode,
      sensitivityCode: 1,
      historyEligible: input.historyEligible,
      text: token,
    },
    producerVersion: "conversation-v1",
  });
}

async function append(repository: EventRepository, envelope: PersistableEventEnvelopeV1): Promise<void> {
  await repository.append({
    envelope,
    scope: "test:conversation-context",
    key: envelope.eventId,
    requestHash: await sha256Hex(canonicalJson([envelope.eventId, envelope.contentHash])),
  });
}

describe("D1ContextRetriever", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearConversationDataForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
    ]);
  });

  it("returns only the authenticated subject's committed history in chronological order", async () => {
    const events = new EventRepository(env.DB);
    const principalId = "principal:context-owner";
    const first = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: principalId,
      channelCode: 1,
      historyEligible: true,
      text: "first remembered turn",
    });
    const excludedStaged = await conversationEnvelope({
      eventType: "conversation.assistant_staged",
      subjectId: principalId,
      channelCode: 2,
      historyEligible: false,
      text: "not acknowledged",
    });
    const excludedForeign = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: "principal:someone-else",
      channelCode: 1,
      historyEligible: true,
      text: "foreign history",
    });
    const second = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: principalId,
      channelCode: 2,
      historyEligible: true,
      text: "second remembered turn",
    });
    await append(events, first);
    await append(events, excludedStaged);
    await append(events, excludedForeign);
    await append(events, second);

    const result = await new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "current request",
      maxTokens: 1_024,
    });

    expect(result).toEqual([
      { sourceEventId: first.eventId, text: "first remembered turn", sensitivity: "personal" },
      { sourceEventId: second.eventId, text: "second remembered turn", sensitivity: "personal" },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it("fails closed instead of returning a validly hashed matching row whose text is not redacted", async () => {
    const principalId = "principal:context-owner";
    const eventId = newUlid();
    const correlationId = newUlid();
    const payload = {
      schemaCode: 1,
      channelCode: 1,
      sensitivityCode: 1,
      historyEligible: true,
      text: "Authorization: Bearer abcdefghijklmnop12345678",
    };
    const contentHash = await sha256Hex(canonicalJson(payload));
    const envelopeJson = canonicalJson({
      schemaVersion: "1.0",
      eventId,
      eventType: "conversation.user_committed",
      source: "conversation",
      subjectId: principalId,
      occurredAt: observedAt,
      receivedAt: observedAt,
      correlationId,
      contentType: "application/json",
      contentHash,
      payload,
      redaction: { status: "none", markers: [] },
      producerVersion: "conversation-v1",
    });
    await env.DB.prepare(`INSERT INTO events (
      event_id, event_type, source, subject_id, occurred_at, received_at,
      content_hash, envelope_json, created_at
    ) VALUES (?1, 'conversation.user_committed', 'conversation', ?2, ?3, ?3, ?4, ?5, ?3)`)
      .bind(eventId, principalId, observedAt, contentHash, envelopeJson)
      .run();

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "current request",
      maxTokens: 1_024,
    })).rejects.toThrow("context_payload_invalid");
  });

  it("treats each UTF-8 byte as one conservative token and keeps the newest whole item", async () => {
    const events = new EventRepository(env.DB);
    const principalId = "principal:context-owner";
    const older = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: principalId,
      channelCode: 1,
      historyEligible: true,
      text: "ab",
    });
    const newest = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: principalId,
      channelCode: 2,
      historyEligible: true,
      text: "🙂",
    });
    await append(events, older);
    await append(events, newest);

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "current request",
      maxTokens: 4,
    })).resolves.toEqual([{
      sourceEventId: newest.eventId,
      text: "🙂",
      sensitivity: "personal",
    }]);
  });

  it("includes assistant text only after the repository records provider acknowledgement", async () => {
    const now = new Date(observedAt);
    const principalId = "principal:context-owner";
    const targetIdentityId = "identity:context-owner";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?1, 'human', 'active', 'Context owner', ?2, ?2)`)
        .bind(principalId, observedAt),
      env.DB.prepare(`INSERT INTO channel_identities (
        identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
      ) VALUES (?1, ?2, 'telegram', '123456789', 'active', ?3, ?3)`)
        .bind(targetIdentityId, principalId, observedAt),
    ]);
    const repository = new ConversationRepository(env.DB, new EventRepository(env.DB), {
      eventIdFactory: () => newUlid(),
      deliveryIdFactory: () => newUlid() as ConversationDeliveryId,
      claimTokenFactory: () => new Uint8Array(32).fill(0x31),
      leaseTokenFactory: () => new Uint8Array(32).fill(0x32),
    });
    const userText = new Redactor().redactText("remembered question");
    const assistantText = new Redactor().redactText("acknowledged answer");
    if (!userText.ok || !assistantText.ok) throw new Error("fixture_redaction_failed");
    const turnId = newUlid();
    const admission = await repository.getOrCreateTurn({
      turnId,
      sessionId: "session:telegram:context",
      principalId,
      channel: "telegram",
      userText,
      now,
    });
    const modelClaim = await repository.claimModelTurn({
      turnId,
      requestHash: admission.turn.requestHash,
      now,
    });
    if (modelClaim.kind !== "claimed") throw new Error("fixture_model_claim_failed");
    repository.beginModelStream(modelClaim.capability, turnId, admission.turn.requestHash);
    const staged = await repository.stageAssistantDelivery({
      claim: modelClaim.capability,
      text: assistantText,
      targetIdentityId,
      replyToMessageId: null,
      now,
    });
    const deliveryClaim = await repository.claimDelivery({ deliveryId: staged.delivery.deliveryId, now });
    if (deliveryClaim.kind !== "claimed") throw new Error("fixture_delivery_claim_failed");
    repository.beginDelivery(
      deliveryClaim.capability,
      staged.delivery.deliveryId,
      staged.delivery.materialHash,
    );
    const receipt = repository.mintProviderDeliveryReceipt({
      capability: deliveryClaim.capability,
      providerMessageId: "telegram-message-context",
    });
    const delivered = await repository.recordDeliverySuccess({
      capability: deliveryClaim.capability,
      receipt,
      now,
    });

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "next question",
      maxTokens: 1_024,
    })).resolves.toEqual([
      { sourceEventId: admission.turn.userEventId, text: "remembered question", sensitivity: "personal" },
      { sourceEventId: delivered.deliveredAssistantEventId, text: "acknowledged answer", sensitivity: "personal" },
    ]);
  });
});

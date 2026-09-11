import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type MemoryFactProjectionV1,
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
  clearMemoryProjectionDataForTest,
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
    await clearMemoryProjectionDataForTest();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM request_nonces"),
      env.DB.prepare("DELETE FROM identity_challenges"),
      env.DB.prepare("DELETE FROM channel_identities"),
      env.DB.prepare("DELETE FROM consumer_cursors"),
      env.DB.prepare("DELETE FROM bootstrap_tokens"),
      env.DB.prepare("DELETE FROM device_keys"),
      env.DB.prepare("DELETE FROM principals"),
      env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
    ]);
  });

  async function insertProjection(input: {
    principalId: string;
    deviceId: string;
    text: string;
    sensitivity?: "normal" | "sensitive";
    sourceEventId?: Ulid;
    sourceSequence?: number;
    sourceExcerpt?: string;
    principalStatus?: "active" | "disabled";
    deviceStatus?: "active" | "revoked";
    versionStatus?: "staged" | "published";
    headVersion?: number;
    distilledAt?: string;
    storedContentHash?: string;
  }): Promise<MemoryFactProjectionV1> {
    const sourceEventId = input.sourceEventId ?? newUlid();
    const sourceSequence = input.sourceSequence ?? 1;
    const sensitivity = input.sensitivity ?? "normal";
    const versionStatus = input.versionStatus ?? "published";
    const headVersion = input.headVersion ?? 1;
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(input.deviceId),
    ));
    const publicKey = btoa(String.fromCharCode(...digest));
    const fingerprint = await sha256Hex(digest);
    const manifest = await sha256Hex(canonicalJson([input.deviceId, "manifest"]));
    const contentHash = await sha256Hex(canonicalJson({
      principal_id: input.principalId,
      sources: [sourceEventId],
      text: input.text,
    }));
    const fact: MemoryFactProjectionV1 = {
      factId: `fact_${contentHash.slice(0, 32)}`,
      text: input.text,
      origin: "authenticated_first_person",
      sensitivity,
      confidence: 1,
      distillerVersion: "local-agent@0.1.0",
      distilledAt: input.distilledAt ?? observedAt,
      contentHash,
      sources: [{
        eventId: sourceEventId,
        eventSequence: sourceSequence,
        excerpt: input.sourceExcerpt ?? input.text,
      }],
    };
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO principals
        (principal_id, principal_type, status, display_name, created_at, updated_at)
        VALUES (?, 'human', ?, 'Context owner', ?, ?)`)
        .bind(input.principalId, input.principalStatus ?? "active", observedAt, observedAt),
      env.DB.prepare(`INSERT INTO device_keys
        (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
         algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, 1, 'ed25519', ?, 'context test', ?, ?, ?)`)
        .bind(
          input.deviceId, input.principalId, `key:${input.deviceId}`, publicKey, fingerprint,
          input.deviceStatus ?? "active", await sha256Hex(`bootstrap:${input.deviceId}`), observedAt,
          input.deviceStatus === "revoked" ? observedAt : null,
        ),
      env.DB.prepare(`INSERT INTO memory_fact_projection_heads
        (principal_id, device_id, published_version, manifest_hash, published_at)
        VALUES (?, ?, ?, ?, ?)`)
        .bind(
          input.principalId, input.deviceId, headVersion,
          headVersion === 0 ? null : manifest, headVersion === 0 ? null : observedAt,
        ),
      env.DB.prepare(`INSERT INTO memory_fact_projection_versions
        (principal_id, device_id, projection_version, manifest_hash, page_count, total_fact_count,
         key_id, key_fingerprint, key_generation, status, created_at, expires_at, published_at)
        VALUES (?, ?, 1, ?, 1, 1, ?, ?, 1, ?, ?, ?, ?)`)
        .bind(
          input.principalId, input.deviceId, manifest, `key:${input.deviceId}`, fingerprint,
          versionStatus, observedAt, "2026-09-11T13:00:00.000Z",
          versionStatus === "published" ? observedAt : null,
        ),
      env.DB.prepare(`INSERT INTO memory_fact_projection_pages
        (principal_id, device_id, projection_version, page_index, page_hash, fact_count,
         page_json, created_at) VALUES (?, ?, 1, 0, ?, 1, '{}', ?)`)
        .bind(input.principalId, input.deviceId, "0".repeat(64), observedAt),
      env.DB.prepare(`INSERT INTO memory_fact_projection_facts
        (principal_id, device_id, projection_version, page_index, fact_position, fact_id, text,
         origin, sensitivity, confidence, distiller_version, distilled_at, content_hash,
         primary_event_id, primary_event_sequence, sources_json, fact_json)
        VALUES (?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          input.principalId, input.deviceId, fact.factId, fact.text, fact.origin, fact.sensitivity,
          fact.confidence, fact.distillerVersion, fact.distilledAt,
          input.storedContentHash ?? fact.contentHash,
          sourceEventId, sourceSequence, canonicalJson(fact.sources as never), canonicalJson(fact as never),
        ),
    ]);
    return fact;
  }

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

  it("returns matching published facts with recent history under the same budget", async () => {
    const events = new EventRepository(env.DB);
    const principalId = "principal:fact-context";
    const fact = await insertProjection({
      principalId,
      deviceId: "device:fact-context",
      text: "Sid prefers moka coffee",
    });
    const history = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: principalId,
      channelCode: 1,
      historyEligible: true,
      text: "We discussed coffee yesterday",
    });
    await append(events, history);

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "coffee",
      maxTokens: 1_024,
    })).resolves.toEqual([
      { sourceEventId: fact.sources[0]!.eventId, text: fact.text, sensitivity: "personal" },
      { sourceEventId: history.eventId, text: "We discussed coffee yesterday", sensitivity: "personal" },
    ]);
  });

  it("excludes staged, non-head, revoked-device, and foreign projections", async () => {
    const principalId = "principal:projection-filters";
    const eligible = await insertProjection({
      principalId, deviceId: "device:eligible", text: "eligible needle fact",
    });
    await insertProjection({
      principalId, deviceId: "device:staged", text: "staged needle fact",
      versionStatus: "staged", headVersion: 1,
    });
    await insertProjection({
      principalId, deviceId: "device:old", text: "old needle fact", headVersion: 2,
    });
    await insertProjection({
      principalId, deviceId: "device:revoked", text: "revoked needle fact", deviceStatus: "revoked",
    });
    await insertProjection({
      principalId: "principal:foreign-projection", deviceId: "device:foreign",
      text: "foreign needle fact",
    });

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "needle",
      maxTokens: 1_024,
    })).resolves.toEqual([
      { sourceEventId: eligible.sources[0]!.eventId, text: eligible.text, sensitivity: "personal" },
    ]);
  });

  it("excludes projections when the owning principal is disabled", async () => {
    const principalId = "principal:disabled-projection";
    await insertProjection({
      principalId,
      deviceId: "device:disabled-principal",
      text: "disabled needle fact",
      principalStatus: "disabled",
    });

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "needle",
      maxTokens: 1_024,
    })).resolves.toEqual([]);
  });

  it("quotes full-text terms so query syntax is treated as literal text", async () => {
    const principalId = "principal:literal-query";
    const fact = await insertProjection({
      principalId, deviceId: "device:literal-query", text: "literal coffee preference",
    });

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: `coffee \" OR * - NOT`,
      maxTokens: 1_024,
    })).resolves.toEqual([
      { sourceEventId: fact.sources[0]!.eventId, text: fact.text, sensitivity: "personal" },
    ]);
  });

  it("reclaims the history share when no history fits", async () => {
    const events = new EventRepository(env.DB);
    const principalId = "principal:shared-budget";
    const factText = `needle ${"f".repeat(693)}`;
    const fact = await insertProjection({
      principalId, deviceId: "device:shared-budget", text: factText,
    });
    const tooLargeHistory = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: principalId,
      channelCode: 1,
      historyEligible: true,
      text: "h".repeat(1_100),
    });
    await append(events, tooLargeHistory);

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "needle",
      maxTokens: 1_000,
    })).resolves.toEqual([
      { sourceEventId: fact.sources[0]!.eventId, text: factText, sensitivity: "personal" },
    ]);
  });

  it("does not let one large fact consume the reserved history share", async () => {
    const events = new EventRepository(env.DB);
    const principalId = "principal:history-share";
    await insertProjection({
      principalId,
      deviceId: "device:history-share",
      text: `needle ${"f".repeat(943)}`,
    });
    const history = await conversationEnvelope({
      eventType: "conversation.user_committed",
      subjectId: principalId,
      channelCode: 1,
      historyEligible: true,
      text: "h".repeat(100),
    });
    await append(events, history);

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "needle",
      maxTokens: 1_000,
    })).resolves.toEqual([{
      sourceEventId: history.eventId,
      text: "h".repeat(100),
      sensitivity: "personal",
    }]);
  });

  it("caps the combined result at 32 facts and 64 total items", async () => {
    const events = new EventRepository(env.DB);
    const principalId = "principal:combined-item-limit";
    for (let index = 0; index < 33; index += 1) {
      await insertProjection({
        principalId,
        deviceId: `device:item-limit:${index.toString().padStart(2, "0")}`,
        text: `limit fact ${index}`,
      });
      await append(events, await conversationEnvelope({
        eventType: "conversation.user_committed",
        subjectId: principalId,
        channelCode: 1,
        historyEligible: true,
        text: `limit history ${index}`,
      }));
    }

    const result = await new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "limit",
      maxTokens: 32_000,
    });

    expect(result).toHaveLength(64);
    expect(result.slice(0, 32).every((item) => item.text.startsWith("limit fact"))).toBe(true);
    expect(result.slice(32).every((item) => item.text.startsWith("limit history"))).toBe(true);
  });

  it("deduplicates projected facts without downgrading sensitive metadata", async () => {
    const principalId = "principal:fact-dedup";
    const sourceEventId = newUlid();
    const normal = await insertProjection({
      principalId, deviceId: "device:a-normal", text: "private needle preference",
      sourceEventId, distilledAt: "2026-09-11T12:01:00.000Z",
    });
    await insertProjection({
      principalId, deviceId: "device:z-sensitive", text: normal.text,
      sourceEventId, sensitivity: "sensitive", distilledAt: observedAt,
    });

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "needle",
      maxTokens: 1_024,
    })).resolves.toEqual([
      { sourceEventId, text: normal.text, sensitivity: "restricted" },
    ]);
  });

  it("fails closed when a published fact row disagrees with its immutable JSON", async () => {
    const principalId = "principal:corrupt-projection";
    await insertProjection({
      principalId,
      deviceId: "device:corrupt-projection",
      text: "corrupt needle fact",
      storedContentHash: "0".repeat(64),
    });

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "voice",
      purpose: "conversation",
      query: "needle",
      maxTokens: 1_024,
    })).rejects.toThrow("context_fact_invalid");
  });

  it("fails closed when published fact text no longer passes redaction", async () => {
    const principalId = "principal:unredacted-projection";
    await insertProjection({
      principalId,
      deviceId: "device:unredacted-projection",
      text: "needle Authorization: Bearer abcdefghijklmnop12345678",
      sourceExcerpt: "safe source excerpt",
    });

    await expect(new D1ContextRetriever(env.DB).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "needle",
      maxTokens: 1_024,
    })).rejects.toThrow("context_fact_invalid");
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
      deliveryIdFactory: () => newUlid() as unknown as ConversationDeliveryId,
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

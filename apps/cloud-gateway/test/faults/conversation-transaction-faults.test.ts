import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { ConversationDeliveryId } from "../../src/conversation/conversation-types.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyFoundationMigration, clearConversationDataForTest } from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const LATER = new Date("2026-08-30T12:00:01.000Z");
const TURN_ID = "01k3w1t4000000000000000100" as Ulid;
const EVENT_IDS = [
  "01k3w1t4000000000000000110",
  "01k3w1t4000000000000000111",
  "01k3w1t4000000000000000112",
] as Ulid[];
const DELIVERY_ID = "01k3w1t4000000000000000120" as ConversationDeliveryId;

function sequence<T>(items: readonly T[]): () => T {
  let index = 0;
  return () => {
    const item = items[index++];
    if (item === undefined) throw new Error("fixture_id_exhausted");
    return item;
  };
}

function token(text: string) {
  const result = new Redactor().redactText(text);
  if (!result.ok) throw new Error("fixture_redaction_failed");
  return result;
}

function createRepository(): ConversationRepository {
  return new ConversationRepository(env.DB, new EventRepository(env.DB), {
    eventIdFactory: sequence(EVENT_IDS),
    deliveryIdFactory: () => DELIVERY_ID,
    claimTokenFactory: () => new Uint8Array(32).fill(0x31),
    leaseTokenFactory: () => new Uint8Array(32).fill(0x32),
    retryDelayMs: 0,
  });
}

async function seed(): Promise<void> {
  const now = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'owner', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(now, now),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:telegram', 'principal:owner', 'telegram', '44112233', 'active', ?, ?)").bind(now, now),
  ]);
}

async function clearData(): Promise<void> {
  await clearConversationDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM principals"),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
  ]);
}

async function counts() {
  const [turns, deliveries, events, idempotency, outbox] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_deliveries").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>(),
  ]);
  return {
    turns: turns?.count ?? -1,
    deliveries: deliveries?.count ?? -1,
    events: events?.count ?? -1,
    idempotency: idempotency?.count ?? -1,
    outbox: outbox?.count ?? -1,
  };
}

describe("conversation transaction faults", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearData();
    await seed();
  });

  afterEach(async () => {
    for (const name of ["test_fail_conversation_turn", "test_fail_conversation_delivery", "test_fail_conversation_turn_update", "test_fail_conversation_delivery_update"]) {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    }
    await clearData();
  });

  it("rolls back the user event, idempotency row, foundation outbox, and turn when the post dependency fails", async () => {
    await env.DB.prepare(`CREATE TRIGGER test_fail_conversation_turn
      BEFORE INSERT ON conversation_turns
      BEGIN SELECT RAISE(ABORT, 'injected_conversation_turn_failure'); END`).run();
    const repository = createRepository();

    await expect(repository.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: token("hello"),
      now: NOW,
    })).rejects.toThrow("injected_conversation_turn_failure");

    await expect(counts()).resolves.toEqual({ turns: 0, deliveries: 0, events: 0, idempotency: 0, outbox: 0 });
  });

  it.each(["delivery insert", "turn transition"] as const)("rolls back every assistant-stage row when the %s fails", async (failure) => {
    const repository = createRepository();
    const admission = await repository.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: token("hello"),
      now: NOW,
    });
    const claim = await repository.claimModelTurn({ turnId: TURN_ID, requestHash: admission.turn.requestHash, now: NOW });
    if (claim.kind !== "claimed") throw new Error("fixture_claim_failed");
    repository.beginModelStream(claim.capability, TURN_ID, admission.turn.requestHash);
    if (failure === "delivery insert") {
      await env.DB.prepare(`CREATE TRIGGER test_fail_conversation_delivery
        BEFORE INSERT ON conversation_deliveries
        BEGIN SELECT RAISE(ABORT, 'injected_conversation_delivery_failure'); END`).run();
    } else {
      await env.DB.prepare(`CREATE TRIGGER test_fail_conversation_turn_update
        BEFORE UPDATE ON conversation_turns WHEN NEW.state = 'assistant_staged'
        BEGIN SELECT RAISE(ABORT, 'injected_conversation_turn_update_failure'); END`).run();
    }

    await expect(repository.stageAssistantDelivery({
      claim: claim.capability,
      text: token("safe answer"),
      targetIdentityId: "identity:telegram",
      replyToMessageId: null,
      now: LATER,
    })).rejects.toThrow(/injected_conversation_/u);

    expect((await env.DB.prepare("SELECT state FROM conversation_turns WHERE turn_id = ?").bind(TURN_ID).first<{ state: string }>())?.state).toBe("model_claimed");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_deliveries").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.assistant_staged'").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox WHERE topic = 'conversation.assistant_staged'").first<{ count: number }>())?.count).toBe(0);
  });

  it.each(["delivery settlement", "turn settlement"] as const)("rolls back acknowledgement and delivered history when the %s fails", async (failure) => {
    const repository = createRepository();
    const admission = await repository.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: token("hello"),
      now: NOW,
    });
    const modelClaim = await repository.claimModelTurn({ turnId: TURN_ID, requestHash: admission.turn.requestHash, now: NOW });
    if (modelClaim.kind !== "claimed") throw new Error("fixture_model_claim_failed");
    repository.beginModelStream(modelClaim.capability, TURN_ID, admission.turn.requestHash);
    const staged = await repository.stageAssistantDelivery({
      claim: modelClaim.capability,
      text: token("safe answer"),
      targetIdentityId: "identity:telegram",
      replyToMessageId: null,
      now: LATER,
    });
    const deliveryClaim = await repository.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: LATER });
    if (deliveryClaim.kind !== "claimed") throw new Error("fixture_delivery_claim_failed");
    repository.beginDelivery(deliveryClaim.capability, staged.delivery.deliveryId, staged.delivery.materialHash);
    const receipt = repository.mintProviderDeliveryReceipt({
      capability: deliveryClaim.capability,
      providerMessageId: "telegram-message-101",
    });
    if (failure === "delivery settlement") {
      await env.DB.prepare(`CREATE TRIGGER test_fail_conversation_delivery_update
        BEFORE UPDATE ON conversation_deliveries WHEN NEW.state = 'delivered'
        BEGIN SELECT RAISE(ABORT, 'injected_delivery_settlement_failure'); END`).run();
    } else {
      await env.DB.prepare(`CREATE TRIGGER test_fail_conversation_turn_update
        BEFORE UPDATE ON conversation_turns WHEN NEW.state = 'delivered'
        BEGIN SELECT RAISE(ABORT, 'injected_turn_settlement_failure'); END`).run();
    }

    await expect(repository.recordDeliverySuccess({ capability: deliveryClaim.capability, receipt, now: LATER }))
      .rejects.toThrow(/injected_(delivery|turn)_settlement_failure/u);

    expect(await env.DB.prepare("SELECT state, provider_message_id FROM conversation_deliveries WHERE delivery_id = ?").bind(staged.delivery.deliveryId).first())
      .toEqual({ state: "claimed", provider_message_id: null });
    expect(await env.DB.prepare("SELECT state, delivered_assistant_event_id FROM conversation_turns WHERE turn_id = ?").bind(TURN_ID).first())
      .toEqual({ state: "assistant_staged", delivered_assistant_event_id: null });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.assistant_delivered'").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox WHERE topic = 'conversation.assistant_delivered'").first<{ count: number }>())?.count).toBe(0);
  });
});

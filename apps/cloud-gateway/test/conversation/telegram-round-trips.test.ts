import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import type { ConversationDeliveryId } from "../../src/conversation/conversation-types.js";
import { DeviceRepository } from "../../src/persistence/device-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  applyCloudMemoryMigration,
  applyFoundationMigration,
  clearConversationDataForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-09-16T16:00:00.000Z");

interface D1Counts {
  statements: number;
  roundTrips: number;
}

function countingDatabase(database: D1Database): Readonly<{
  database: D1Database;
  take: () => Readonly<D1Counts>;
}> {
  const counts: D1Counts = { statements: 0, roundTrips: 0 };
  const rawStatements = new WeakMap<object, D1PreparedStatement>();

  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (property === "run" || property === "first" || property === "all" || property === "raw") {
          return (...values: unknown[]) => {
            counts.statements += 1;
            counts.roundTrips += 1;
            return Reflect.apply(target[property] as (...args: unknown[]) => unknown, target, values);
          };
        }
        return Reflect.get(target, property, target) as unknown;
      },
    });
    rawStatements.set(wrapped, statement);
    return wrapped;
  };

  const counted = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query));
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counts.statements += statements.length;
          counts.roundTrips += 1;
          return target.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;

  let last = { statements: 0, roundTrips: 0 };
  return Object.freeze({
    database: counted,
    take() {
      const current = { ...counts };
      const phase = Object.freeze({
        statements: current.statements - last.statements,
        roundTrips: current.roundTrips - last.roundTrips,
      });
      last = current;
      return phase;
    },
  });
}

async function seedOwner(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:owner', 'human', 'active', 'owner', ?1, ?2)`).bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES ('identity:telegram', 'principal:owner', 'telegram', '44112233', 'active', ?1, ?2)`).bind(timestamp, timestamp),
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

describe("ordinary Telegram turn D1 round trips", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    // The shared context retriever anti-joins memory_active_event_suppressions,
    // so a fixture that models only the foundation schema is incomplete.
    await applyCloudMemoryMigration();
    await clearData();
    await seedOwner();
  });

  afterEach(clearData);

  it("keeps admission, context retrieval, and delivered dispatch within their statement ceilings", async () => {
    const counted = countingDatabase(env.DB);
    const identity = await new DeviceRepository(counted.database)
      .findActiveVerifiedTelegramIdentity("44112233");
    if (identity === null) throw new Error("fixture_identity_missing");

    const repository = new ConversationRepository(counted.database, new EventRepository(counted.database));
    const turnId = newUlid(NOW);
    const redaction = new Redactor().redactText("hi");
    if (!redaction.ok) throw new Error("fixture_redaction_failed");
    const admission = await repository.getOrCreateTurn({
      turnId,
      sessionId: "telegram:44112233",
      principalId: identity.principalId,
      channel: "telegram",
      userText: redaction,
      now: NOW,
    });
    const claim = await repository.claimModelTurn({
      turnId,
      requestHash: admission.turn.requestHash,
      now: NOW,
    });
    if (claim.kind !== "claimed") throw new Error("fixture_claim_missing");
    const admissionCounts = counted.take();

    await new D1ContextRetriever(counted.database).retrieve({
      principalId: identity.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "hi",
      maxTokens: 32_000,
    });
    const contextCounts = counted.take();

    repository.beginModelStream(claim.capability, turnId, admission.turn.requestHash);
    const answer = new Redactor().redactText("Hello.");
    if (!answer.ok) throw new Error("fixture_answer_redaction_failed");
    const staged = await repository.stageAssistantDelivery({
      claim: claim.capability,
      text: answer,
      targetIdentityId: identity.identityId,
      replyToMessageId: 17,
      now: NOW,
    });
    const dispatch = await new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(counted.database),
      channels: new Map([["telegram", new FakeTelegramProvider()]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => new Date(NOW),
    }).dispatch(staged.delivery.deliveryId as ConversationDeliveryId);
    const deliveryCounts = counted.take();

    expect(dispatch.outcome).toBe("delivered");
    expect(admissionCounts.statements).toBeLessThanOrEqual(8);
    expect(admissionCounts.roundTrips).toBeLessThanOrEqual(4);
    expect(contextCounts.statements).toBeLessThanOrEqual(2);
    expect(contextCounts.roundTrips).toBeLessThanOrEqual(2);
    expect(deliveryCounts.statements).toBeLessThanOrEqual(17);
    expect(deliveryCounts.roundTrips).toBeLessThanOrEqual(6);
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import type { ConversationDeliveryId } from "../../src/conversation/conversation-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { ProviderFailure } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyFoundationMigration, clearConversationDataForTest } from "../persistence/migration.js";

const NOW = new Date("2026-09-16T16:00:00.000Z");
const LATER = new Date("2026-09-16T16:00:01.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const SESSION = "telegram:44112233";
const OWNER = "principal:owner";
const IDENTITY = "identity:telegram";

function redacted(text: string) {
  const result = new Redactor().redactText(text);
  if (!result.ok) throw new Error("fixture_redaction_failed");
  return result;
}

interface Hook { match: string; mode: "lose_response" | "before"; run?: () => Promise<void>; fired: boolean }

/** Real D1 underneath; lets a test lose a committed batch response or race a write in just before a batch. */
function hookedDatabase(database: D1Database) {
  const raw = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();
  const hooks: Hook[] = [];
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    raw.set(proxy, { statement, sql });
    return proxy;
  };
  const proxied = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const entries = statements.map((statement) => raw.get(statement) ?? { statement, sql: "" });
          const hook = hooks.find((candidate) => !candidate.fired
            && entries.some((entry) => entry.sql.includes(candidate.match)));
          if (hook !== undefined) hook.fired = true;
          if (hook?.mode === "before") await hook.run?.();
          const results = await target.batch(entries.map((entry) => entry.statement));
          if (hook?.mode === "lose_response") throw new Error("d1_response_lost_after_commit");
          return results;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
  return Object.freeze({
    database: proxied,
    loseResponse(match: string) { hooks.push({ match, mode: "lose_response", fired: false }); },
    before(match: string, run: () => Promise<void>) { hooks.push({ match, mode: "before", run, fired: false }); },
    fired: () => hooks.every((hook) => hook.fired),
  });
}

function repository(database: D1Database, retryDelayMs = 0): ConversationRepository {
  return new ConversationRepository(database, new EventRepository(database), { retryDelayMs });
}

function dispatcher(repo: ConversationRepository, provider: FakeTelegramProvider, now: Date): DefaultOutboxDispatcher {
  return new DefaultOutboxDispatcher({
    repository: repo,
    identityResolver: new D1TelegramIdentityResolver(env.DB),
    channels: new Map([["telegram", provider]]),
    circuitBreaker: new ProviderCircuitBreaker(),
    now: () => new Date(now),
  });
}

async function count(sql: string, ...values: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...values).first<{ count: number }>())?.count ?? -1;
}

async function turnState(turnId: string): Promise<string | undefined> {
  return (await env.DB.prepare("SELECT state FROM conversation_turns WHERE turn_id = ?1").bind(turnId)
    .first<{ state: string }>())?.state;
}

async function deliveryRow(deliveryId: string) {
  return env.DB.prepare("SELECT state, attempt_count, provider_message_id, delivered_assistant_event_id FROM conversation_deliveries WHERE delivery_id = ?1")
    .bind(deliveryId).first<{ state: string; attempt_count: number; provider_message_id: string | null; delivered_assistant_event_id: string | null }>();
}

function admissionInput(turnId: Ulid) {
  return { turnId, sessionId: SESSION, principalId: OWNER, channel: "telegram" as const, userText: redacted("hi"), now: NOW };
}

async function admitAndClaim(repo: ConversationRepository, turnId: Ulid = newUlid(NOW)) {
  const admission = await repo.getOrCreateTurn(admissionInput(turnId));
  const claim = await repo.claimModelTurn({ turnId, requestHash: admission.turn.requestHash, now: NOW });
  if (claim.kind !== "claimed") throw new Error("fixture_claim_failed");
  repo.beginModelStream(claim.capability, turnId, admission.turn.requestHash);
  return { turnId, admission, claim };
}

async function stage(repo: ConversationRepository) {
  const claimed = await admitAndClaim(repo);
  const staged = await repo.stageAssistantDelivery({
    claim: claimed.claim.capability,
    text: redacted("Hello."),
    targetIdentityId: IDENTITY,
    replyToMessageId: 17,
    now: LATER,
  });
  return { ...claimed, staged, deliveryId: staged.delivery.deliveryId as ConversationDeliveryId };
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

describe("PR 75 adversarial: Telegram reply durability", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearData();
    const timestamp = NOW.toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?1, 'human', 'active', 'owner', ?2, ?2)").bind(OWNER, timestamp),
      env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES (?1, ?2, 'telegram', '44112233', 'active', ?3, ?3)").bind(IDENTITY, OWNER, timestamp),
    ]);
  });

  afterEach(clearData);

  it("A1 concurrent duplicate admission that loses the idempotency race converges on the winner's turn", async () => {
    const hooked = hookedDatabase(env.DB);
    const turnId = newUlid(NOW);
    let winner: Awaited<ReturnType<ConversationRepository["getOrCreateTurn"]>> | undefined;
    hooked.before("INSERT INTO conversation_turns", async () => {
      winner = await repository(env.DB).getOrCreateTurn(admissionInput(turnId));
    });
    const loser = await repository(hooked.database).getOrCreateTurn(admissionInput(turnId));

    expect(hooked.fired()).toBe(true);
    expect(winner?.replayed).toBe(false);
    expect(loser.replayed).toBe(true);
    expect(loser.turn).toEqual(winner?.turn);
    expect(await count("SELECT COUNT(*) AS count FROM conversation_turns")).toBe(1);
    expect(await count("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.user_committed'")).toBe(1);
  });

  it("A2 admission batch that commits but loses its response returns the stored turn and one model claim", async () => {
    const hooked = hookedDatabase(env.DB);
    const turnId = newUlid(NOW);
    hooked.loseResponse("INSERT INTO conversation_turns");
    const repo = repository(hooked.database);
    const admission = await repo.getOrCreateTurn(admissionInput(turnId));

    expect(hooked.fired()).toBe(true);
    expect(admission.turn).toMatchObject({ turnId, state: "user_committed" });
    expect(await count("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.user_committed'")).toBe(1);
    const claims = await Promise.all([
      repo.claimModelTurn({ turnId, requestHash: admission.turn.requestHash, now: NOW }),
      repository(env.DB).claimModelTurn({ turnId, requestHash: admission.turn.requestHash, now: NOW }),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(["claimed", "in_progress"]);
  });

  it("A3 staging batch that commits but loses its response still returns the staged turn and delivers once", async () => {
    const hooked = hookedDatabase(env.DB);
    const repo = repository(hooked.database);
    const { claim } = await admitAndClaim(repo);
    hooked.loseResponse("INSERT INTO conversation_deliveries");
    const staged = await repo.stageAssistantDelivery({
      claim: claim.capability, text: redacted("Hello."), targetIdentityId: IDENTITY, replyToMessageId: 17, now: LATER,
    });

    expect(hooked.fired()).toBe(true);
    expect(staged.turn.state).toBe("assistant_staged");
    expect(staged.turn.stagedDeliveryId).toBe(staged.delivery.deliveryId);
    expect(staged.delivery.state).toBe("pending");
    const provider = new FakeTelegramProvider();
    const result = await dispatcher(repo, provider, LATER).dispatch(staged.delivery.deliveryId as ConversationDeliveryId);
    expect(result.outcome).toBe("delivered");
    expect(provider.requests).toHaveLength(1);
  });

  it("A4 staging whose model claim expires between the claim check and the batch commits nothing", async () => {
    const hooked = hookedDatabase(env.DB);
    const repo = repository(hooked.database);
    const { turnId, admission, claim } = await admitAndClaim(repo);
    hooked.before("INSERT INTO conversation_deliveries", async () => {
      const expired = await repository(env.DB).claimModelTurn({
        turnId, requestHash: admission.turn.requestHash, now: at(NOW, 45_000),
      });
      expect(expired).toMatchObject({ kind: "terminal", turn: { state: "model_outcome_unknown" } });
    });

    await expect(repo.stageAssistantDelivery({
      claim: claim.capability, text: redacted("Hello."), targetIdentityId: IDENTITY, replyToMessageId: 17, now: LATER,
    })).rejects.toThrow();
    expect(hooked.fired()).toBe(true);
    expect(await turnState(turnId)).toBe("model_outcome_unknown");
    expect(await count("SELECT COUNT(*) AS count FROM conversation_deliveries")).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.assistant_staged'")).toBe(0);
  });

  it("A5 settlement batch that commits but loses its response reports delivered and never resends", async () => {
    const hooked = hookedDatabase(env.DB);
    const repo = repository(hooked.database);
    const { turnId, deliveryId } = await stage(repo);
    hooked.loseResponse("SET state = 'delivered'");
    const provider = new FakeTelegramProvider();

    const first = await dispatcher(repo, provider, LATER).dispatch(deliveryId);
    const replay = await dispatcher(repository(env.DB), provider, at(LATER, 60_000)).dispatch(deliveryId);

    expect(hooked.fired()).toBe(true);
    const row = await deliveryRow(deliveryId);
    expect(first).toEqual({ outcome: "delivered", deliveredAssistantEventId: row?.delivered_assistant_event_id });
    expect(replay).toEqual({ outcome: "already_delivered", deliveredAssistantEventId: row?.delivered_assistant_event_id });
    expect(provider.requests).toHaveLength(1);
    expect(row?.state).toBe("delivered");
    expect(await turnState(turnId)).toBe("delivered");
    expect(await count("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.assistant_delivered'")).toBe(1);
    const readmission = await repository(env.DB).getOrCreateTurn(admissionInput(turnId));
    expect(readmission).toMatchObject({ replayed: true, turn: { state: "delivered" } });
  });

  it("A6 settlement whose lease is expired to unknown between the lease check and the batch records no delivered history", async () => {
    const hooked = hookedDatabase(env.DB);
    const repo = repository(hooked.database);
    const { turnId, deliveryId } = await stage(repo);
    hooked.before("SET state = 'delivered'", async () => {
      const expired = await repository(env.DB).claimDelivery({ deliveryId, now: at(LATER, 30_000) });
      expect(expired).toMatchObject({ kind: "terminal", item: { state: "unknown" } });
    });
    const provider = new FakeTelegramProvider();

    const result = await dispatcher(repo, provider, LATER).dispatch(deliveryId);

    expect(hooked.fired()).toBe(true);
    expect(result.outcome).toBe("unknown");
    expect(provider.requests).toHaveLength(1);
    expect((await deliveryRow(deliveryId))?.state).toBe("unknown");
    expect(await turnState(turnId)).toBe("delivery_unknown");
    expect(await count("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.assistant_delivered'")).toBe(0);
  });

  it("A7 an abandoned lease seen after expiry by claimDelivery becomes terminal unknown without a send", async () => {
    const repo = repository(env.DB);
    const { turnId, deliveryId } = await stage(repo);
    const abandoned = await repo.claimDelivery({ deliveryId, now: LATER });
    expect(abandoned.kind).toBe("claimed");
    const provider = new FakeTelegramProvider();

    const early = await dispatcher(repository(env.DB), provider, at(LATER, 29_999)).dispatch(deliveryId);
    const expired = await dispatcher(repository(env.DB), provider, at(LATER, 30_000)).dispatch(deliveryId);

    expect(early.outcome).toBe("in_progress");
    expect(expired.outcome).toBe("unknown");
    expect(provider.requests).toHaveLength(0);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "unknown", attempt_count: 1 });
    expect(await turnState(turnId)).toBe("delivery_unknown");
  });

  it("A8 retry_wait is in progress before available_at and claims attempt 2 with the staged text at available_at", async () => {
    const repo = repository(env.DB, 5_000);
    const { deliveryId } = await stage(repo);
    const first = await repo.claimDelivery({ deliveryId, now: LATER });
    if (first.kind !== "claimed") throw new Error("fixture_delivery_claim_failed");
    repo.beginDelivery(first.capability, deliveryId, first.item.materialHash);
    await repo.recordDeliveryFailure({ capability: first.capability, failure: ProviderFailure.transient("rate_limited"), now: LATER });

    const before = await repo.claimDelivery({ deliveryId, now: at(LATER, 4_999) });
    expect(before.kind).toBe("in_progress");
    expect((await deliveryRow(deliveryId))?.attempt_count).toBe(1);
    const after = await repo.claimDelivery({ deliveryId, now: at(LATER, 5_000) });
    expect(after).toMatchObject({ kind: "claimed", item: { attemptCount: 2, text: "Hello." } });
  });

  it.each([
    ["identity", "UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:telegram'"],
    ["principal", "UPDATE principals SET status = 'disabled' WHERE principal_id = 'principal:owner'"],
  ] as const)("A9 an inactive %s leaves the staged delivery pending, unsent and unconsumed", async (_label, sql) => {
    const repo = repository(env.DB);
    const { deliveryId } = await stage(repo);
    await env.DB.prepare(sql).run();
    const provider = new FakeTelegramProvider();

    const result = await dispatcher(repo, provider, LATER).dispatch(deliveryId);

    expect(result.outcome).toBe("retry_scheduled");
    expect(provider.requests).toHaveLength(0);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "pending", attempt_count: 0 });
  });

  it("A10 a system notice settles through the single-dependency layout", async () => {
    const repo = repository(env.DB);
    const notice = await repo.stageSystemNotice({
      noticeId: newUlid(NOW), sessionId: SESSION, principalId: OWNER, channel: "telegram", noticeCode: "busy",
      targetIdentityId: IDENTITY, replyToMessageId: 17, now: NOW,
    });
    const provider = new FakeTelegramProvider();

    const result = await dispatcher(repo, provider, LATER).dispatch(notice.deliveryId as ConversationDeliveryId);

    expect(result).toEqual({ outcome: "delivered", deliveredAssistantEventId: null });
    expect(provider.requests.map((request) => request.text)).toEqual(["Jarvis is busy. Please try again shortly."]);
    expect(await deliveryRow(notice.deliveryId)).toMatchObject({ state: "delivered", delivered_assistant_event_id: null });
    expect(await count("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.system_delivered'")).toBe(1);
  });

  it("A11 delivered history records exactly the text that was sent even if the staged row is altered after claim", async () => {
    const repo = repository(env.DB);
    const { deliveryId } = await stage(repo);
    const claim = await repo.claimDelivery({ deliveryId, now: LATER });
    if (claim.kind !== "claimed") throw new Error("fixture_delivery_claim_failed");
    repo.beginDelivery(claim.capability, deliveryId, claim.item.materialHash);
    await env.DB.prepare("UPDATE events SET envelope_json = replace(envelope_json, 'Hello.', 'Altered') WHERE event_type = 'conversation.assistant_staged'").run();
    const receipt = repo.mintProviderDeliveryReceipt({ capability: claim.capability, providerMessageId: "99" });

    const settled = await repo.recordDeliverySuccess({ capability: claim.capability, receipt, now: LATER });

    expect(settled.state).toBe("delivered");
    const delivered = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_type = 'conversation.assistant_delivered'")
      .first<{ envelope_json: string }>();
    expect(JSON.parse(delivered?.envelope_json ?? "null").payload.text).toBe(claim.item.text);
  });
});

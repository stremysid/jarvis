import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Hex,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  createVoiceStreamDelivery,
  snapshotVoiceSentReceipt,
  type ConversationDeliveryId,
  type DeliveryLeaseCapability,
  type ModelStreamClaimCapability,
  type ProviderDeliveryReceipt,
} from "../../src/conversation/conversation-types.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
  ConversationRepository,
} from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { ProviderFailure, ProviderIdempotencyConflictError } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  applyFoundationMigration,
  clearConversationDataForTest,
} from "./migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const LATER = new Date("2026-08-30T12:00:01.000Z");
const CLAIM_EXPIRY = new Date("2026-08-30T12:00:45.000Z");
const TURN_ID = "01k3w1t4000000000000000000" as Ulid;
const TURN_ID_2 = "01k3w1t4000000000000000001" as Ulid;
const NOTICE_ID = "01k3w1t4000000000000000002" as Ulid;
const EVENT_IDS = [
  "01k3w1t4000000000000000010",
  "01k3w1t4000000000000000011",
  "01k3w1t4000000000000000012",
  "01k3w1t4000000000000000013",
  "01k3w1t4000000000000000014",
  "01k3w1t4000000000000000015",
  "01k3w1t4000000000000000016",
  "01k3w1t4000000000000000017",
] as Ulid[];
const DELIVERY_IDS = [
  "01k3w1t4000000000000000020",
  "01k3w1t4000000000000000021",
] as ConversationDeliveryId[];

function redacted(text: string) {
  const result = new Redactor().redactText(text);
  if (!result.ok) throw new Error("fixture_redaction_failed");
  return result;
}

function sequentialFactory<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("fixture_id_exhausted");
    index += 1;
    return value;
  };
}

interface DatabaseHook {
  readonly match: string;
  readonly mode: "lose_response" | "before";
  readonly run?: () => Promise<void>;
  fired: boolean;
}

/** Real D1 underneath; loses a committed response or races a write before one exact batch. */
function hookedDatabase(database: D1Database) {
  const raw = new WeakMap<object, { readonly statement: D1PreparedStatement; readonly sql: string }>();
  const hooks: DatabaseHook[] = [];
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    raw.set(proxy, Object.freeze({ statement, sql }));
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

function repository(database: D1Database = env.DB): ConversationRepository {
  return new ConversationRepository(database, new EventRepository(database), {
    eventIdFactory: sequentialFactory(EVENT_IDS),
    deliveryIdFactory: sequentialFactory(DELIVERY_IDS),
    claimTokenFactory: () => new Uint8Array(32).fill(0x11),
    leaseTokenFactory: () => new Uint8Array(32).fill(0x22),
    retryDelayMs: 0,
  });
}

async function seedIdentity(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'owner', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:other', 'service', 'active', 'other', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:telegram', 'principal:owner', 'telegram', '44112233', 'active', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:foreign', 'principal:other', 'telegram', '99887766', 'active', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123', 'active', ?, ?)").bind(timestamp, timestamp),
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

async function admitAndClaim(repo: ConversationRepository, turnId = TURN_ID) {
  const admission = await repo.getOrCreateTurn({
    turnId,
    sessionId: "session:telegram:44112233",
    principalId: "principal:owner",
    channel: "telegram",
    userText: redacted("hello"),
    now: NOW,
  });
  const claim = await repo.claimModelTurn({ turnId, requestHash: admission.turn.requestHash, now: NOW });
  if (claim.kind !== "claimed") throw new Error("fixture_claim_failed");
  repo.beginModelStream(claim.capability, turnId, admission.turn.requestHash);
  return { admission, claim };
}

async function stagedDelivery(repo: ConversationRepository, turnId = TURN_ID) {
  const { admission, claim } = await admitAndClaim(repo, turnId);
  const staged = await repo.stageAssistantDelivery({
    claim: claim.capability,
    text: redacted("safe answer"),
    targetIdentityId: "identity:telegram",
    replyToMessageId: 42,
    now: LATER,
  });
  return { admission, staged };
}

describe("conversation nominal voice delivery", () => {
  it("mints one session/turn/content-bound receipt only after contiguous delivery and exact finish", async () => {
    const sent: string[] = [];
    const finished: string[] = [];
    const delivery = createVoiceStreamDelivery({
      sessionId: "session:voice:one",
      turnId: TURN_ID,
      sendToken: async (token) => { sent.push(token.text); },
      finish: async (text) => { finished.push(text); },
    });

    await delivery.onToken({ index: 0, text: "safe " });
    await delivery.onToken({ index: 1, text: "answer" });
    const receipt = await delivery.finish("safe answer");
    const contentHash = await sha256Hex("safe answer");

    expect(sent).toEqual(["safe ", "answer"]);
    expect(finished).toEqual(["safe answer"]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(snapshotVoiceSentReceipt(receipt, {
      sessionId: "session:voice:one",
      turnId: TURN_ID,
      contentHash,
    })).toEqual({ sessionId: "session:voice:one", turnId: TURN_ID, contentHash });
    expect(() => snapshotVoiceSentReceipt(receipt, {
      sessionId: "session:voice:one",
      turnId: TURN_ID,
      contentHash,
    })).toThrow("voice_sent_receipt_invalid");
    await expect(delivery.finish("safe answer")).rejects.toThrow("voice_stream_finish_invalid");
    await expect(delivery.onToken({ index: 2, text: "late" })).rejects.toThrow("voice_stream_token_invalid");
  });

  it("rejects gaps, mismatched final text, and structural receipts without provider callbacks", async () => {
    let sends = 0;
    let finishes = 0;
    const delivery = createVoiceStreamDelivery({
      sessionId: "session:voice:one",
      turnId: TURN_ID,
      sendToken: async () => { sends += 1; },
      finish: async () => { finishes += 1; },
    });

    await expect(delivery.onToken({ index: 1, text: "gap" })).rejects.toThrow("voice_stream_token_invalid");
    await delivery.onToken({ index: 0, text: "safe" });
    await expect(delivery.finish("different")).rejects.toThrow("voice_stream_finish_invalid");
    const contentHash = await sha256Hex("safe");
    expect(() => snapshotVoiceSentReceipt({ sessionId: "session:voice:one", turnId: TURN_ID, contentHash } as never, {
      sessionId: "session:voice:one", turnId: TURN_ID, contentHash,
    })).toThrow("voice_sent_receipt_invalid");
    expect({ sends, finishes }).toEqual({ sends: 1, finishes: 0 });
  });
});

describe("ConversationRepository", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearData();
    await seedIdentity();
  });

  afterEach(async () => {
    await clearData();
  });

  it("re-reads getOrCreateTurn when a racing admission wins before its batch", async () => {
    const hooked = hookedDatabase(env.DB);
    const input = {
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram" as const,
      userText: redacted("hello"),
      now: NOW,
    };
    let winner: Awaited<ReturnType<ConversationRepository["getOrCreateTurn"]>> | undefined;
    hooked.before("INSERT INTO conversation_turns", async () => {
      winner = await repository().getOrCreateTurn(input);
    });

    const replay = await repository(hooked.database).getOrCreateTurn(input);

    expect(hooked.fired()).toBe(true);
    expect(winner?.replayed).toBe(false);
    expect(replay).toEqual({ turn: winner?.turn, replayed: true });
  });

  it("re-reads getOrCreateTurn when its admission batch commits but loses the response", async () => {
    const hooked = hookedDatabase(env.DB);
    hooked.loseResponse("INSERT INTO conversation_turns");

    const admission = await repository(hooked.database).getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello"),
      now: NOW,
    });

    expect(hooked.fired()).toBe(true);
    expect(admission).toMatchObject({ replayed: true, turn: { turnId: TURN_ID, state: "user_committed" } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns").first<{ count: number }>())?.count)
      .toBe(1);
  });

  it("re-reads stageAssistantDelivery when its staging batch commits but loses the response", async () => {
    const hooked = hookedDatabase(env.DB);
    const repo = repository(hooked.database);
    const { claim } = await admitAndClaim(repo);
    hooked.loseResponse("INSERT INTO conversation_deliveries");

    const staged = await repo.stageAssistantDelivery({
      claim: claim.capability,
      text: redacted("safe answer"),
      targetIdentityId: "identity:telegram",
      replyToMessageId: 42,
      now: LATER,
    });

    expect(hooked.fired()).toBe(true);
    expect(staged).toMatchObject({
      turn: { state: "assistant_staged", stagedDeliveryId: staged.delivery.deliveryId },
      delivery: { state: "pending", turnId: TURN_ID },
    });
  });

  it("falls back to readDeliveryRow when delivery success commits but its returned row is lost", async () => {
    const hooked = hookedDatabase(env.DB);
    const repo = repository(hooked.database);
    const { staged } = await stagedDelivery(repo);
    const claim = await repo.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: LATER });
    if (claim.kind !== "claimed") throw new Error("test_lease_failed");
    repo.beginDelivery(claim.capability, staged.delivery.deliveryId, staged.delivery.materialHash);
    const receipt = repo.mintProviderDeliveryReceipt({
      capability: claim.capability,
      providerMessageId: "telegram-message-101",
    });
    hooked.loseResponse("SET state = 'delivered'");

    const delivered = await repo.recordDeliverySuccess({ capability: claim.capability, receipt, now: LATER });

    expect(hooked.fired()).toBe(true);
    expect(delivered).toMatchObject({
      state: "delivered",
      providerMessageId: "telegram-message-101",
      deliveredAssistantEventId: expect.stringMatching(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/u),
    });
  });

  it("atomically commits one canonical user event and turn, replays exact material, and conflicts changed material", async () => {
    const repo = repository();
    const input = {
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram" as const,
      userText: redacted("hello"),
      now: NOW,
    };

    const first = await repo.getOrCreateTurn(input);
    const replay = await repo.getOrCreateTurn(input);
    await expect(repo.getOrCreateTurn({ ...input, userText: redacted("changed") }))
      .rejects.toThrow("conversation_turn_conflict");

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(Object.isFrozen(first.turn)).toBe(true);
    expect(first.turn).toMatchObject({
      turnId: TURN_ID,
      state: "user_committed",
      channel: "telegram",
      principalId: "principal:owner",
    });
    const stored = await env.DB.prepare("SELECT event_type, source, envelope_json FROM events").first<{
      event_type: string; source: string; envelope_json: string;
    }>();
    expect(stored?.event_type).toBe("conversation.user_committed");
    expect(stored?.source).toBe(CONVERSATION_EVENT_SOURCE);
    const envelope = JSON.parse(stored?.envelope_json ?? "null") as Record<string, unknown>;
    expect(envelope.producerVersion).toBe(CONVERSATION_EVENT_PRODUCER_VERSION);
    expect(envelope.payload).toEqual({
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: true,
      text: "hello",
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(1);
  });

  it("records a pre-model ingest failure without a turn, text, or text-derived hash", async () => {
    const repo = repository();
    const result = await repo.recordIngestFailure({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      now: NOW,
    });
    const replay = await repo.recordIngestFailure({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      now: NOW,
    });

    expect(result.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns").first<{ count: number }>())?.count).toBe(0);
    const stored = await env.DB.prepare("SELECT envelope_json FROM events").first<{ envelope_json: string }>();
    expect(stored?.envelope_json).not.toMatch(/hello|message|authorization|credential/iu);
    expect(JSON.parse(stored?.envelope_json ?? "null").payload).toEqual({
      schemaCode: 1,
      channelCode: 2,
      failureCode: 1,
      failureCategoryCode: 1,
      historyEligible: false,
    });
  });

  it("grants one durable model authority, reports concurrent replay in progress, and expires exactly to unknown", async () => {
    const repo = repository();
    const admission = await repo.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello"),
      now: NOW,
    });

    const claims = await Promise.all(Array.from({ length: 8 }, () => repo.claimModelTurn({
      turnId: TURN_ID,
      requestHash: admission.turn.requestHash,
      now: NOW,
    })));
    const winner = claims.find((claim) => claim.kind === "claimed");
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "in_progress")).toHaveLength(7);
    if (winner?.kind !== "claimed") throw new Error("test_claim_missing");
    expect(() => repo.beginModelStream(winner.capability, TURN_ID, admission.turn.requestHash)).not.toThrow();
    expect(() => repo.beginModelStream(winner.capability, TURN_ID, admission.turn.requestHash)).toThrow("model_stream_claim_invalid");
    expect(() => repo.beginModelStream({ turnId: TURN_ID, requestHash: admission.turn.requestHash } as ModelStreamClaimCapability, TURN_ID, admission.turn.requestHash))
      .toThrow("model_stream_claim_invalid");

    const expired = await repo.claimModelTurn({ turnId: TURN_ID, requestHash: admission.turn.requestHash, now: CLAIM_EXPIRY });
    expect(expired).toMatchObject({ kind: "terminal", turn: { state: "model_outcome_unknown" } });
    expect(await repo.claimModelTurn({ turnId: TURN_ID, requestHash: admission.turn.requestHash, now: CLAIM_EXPIRY }))
      .toMatchObject({ kind: "terminal", turn: { state: "model_outcome_unknown" } });
    const row = await env.DB.prepare("SELECT model_claim_token_hash FROM conversation_turns WHERE turn_id = ?").bind(TURN_ID).first<{ model_claim_token_hash: string }>();
    expect(row?.model_claim_token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row?.model_claim_token_hash).not.toContain("11".repeat(32));
  });

  it("atomically abandons an unbegun model claim as terminal unknown and exact replay agrees", async () => {
    const repo = repository();
    const admission = await repo.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello"),
      now: NOW,
    });
    const claim = await repo.claimModelTurn({
      turnId: TURN_ID,
      requestHash: admission.turn.requestHash,
      now: NOW,
    });
    if (claim.kind !== "claimed") throw new Error("test_claim_missing");

    const terminal = await repo.recordTurnFailed({
      claim: claim.capability,
      failureCode: "model_outcome_unknown",
      failureCategory: "ambiguous",
      now: LATER,
    });
    const replay = await repo.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello"),
      now: LATER,
    });

    expect(terminal).toMatchObject({
      state: "model_outcome_unknown",
      failureCode: "model_outcome_unknown",
      failureCategory: "ambiguous",
    });
    expect(replay).toMatchObject({ replayed: true, turn: { state: "model_outcome_unknown" } });
    expect(() => repo.beginModelStream(claim.capability, TURN_ID, admission.turn.requestHash))
      .toThrow("model_stream_claim_invalid");
    const stored = await env.DB.prepare(`SELECT event_type, envelope_json FROM events
      WHERE event_type = 'conversation.turn_failed'`).first<{ event_type: string; envelope_json: string }>();
    expect(JSON.parse(stored?.envelope_json ?? "null").payload).toEqual({
      schemaCode: 1,
      channelCode: 2,
      failureCode: 4,
      failureCategoryCode: 7,
      historyEligible: false,
    });
  });

  it("atomically settles a begun model claim as terminal unknown and exact replay agrees", async () => {
    const repo = repository();
    const admission = await repo.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello"),
      now: NOW,
    });
    const claim = await repo.claimModelTurn({
      turnId: TURN_ID,
      requestHash: admission.turn.requestHash,
      now: NOW,
    });
    if (claim.kind !== "claimed") throw new Error("test_claim_missing");
    repo.beginModelStream(claim.capability, TURN_ID, admission.turn.requestHash);

    await expect(repo.recordTurnFailed({
      claim: claim.capability,
      failureCode: "model_outcome_unknown",
      failureCategory: "ambiguous",
      now: LATER,
    })).resolves.toMatchObject({
      state: "model_outcome_unknown",
      failureCode: "model_outcome_unknown",
      failureCategory: "ambiguous",
    });
    await expect(repo.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello"),
      now: LATER,
    })).resolves.toMatchObject({ replayed: true, turn: { state: "model_outcome_unknown" } });
  });

  it("stages redacted assistant text and its delivery atomically for one active exact-principal Telegram identity", async () => {
    const repo = repository();
    const { admission, staged } = await stagedDelivery(repo);

    expect(staged.turn).toMatchObject({
      turnId: TURN_ID,
      state: "assistant_staged",
      stagedDeliveryId: staged.delivery.deliveryId,
    });
    expect(staged.delivery).toMatchObject({
      principalId: "principal:owner",
      targetIdentityId: "identity:telegram",
      historyMode: "assistant",
      state: "pending",
      replyToMessageId: 42,
    });
    expect(staged.delivery.providerIdempotencyKey).toMatch(/^conversation:[0-7][0-9a-hjkmnp-tv-z]{25}:[a-f0-9]{16}$/u);
    const events = await env.DB.prepare("SELECT event_type, envelope_json FROM events ORDER BY sequence").all<{ event_type: string; envelope_json: string }>();
    expect(events.results.map((event) => event.event_type)).toEqual([
      "conversation.user_committed",
      "conversation.assistant_staged",
    ]);
    expect(JSON.parse(events.results[1]?.envelope_json ?? "null").payload).toEqual({
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: false,
      text: "safe answer",
    });
    expect(admission.turn.userEventId).toBe(events.results.length > 0 ? admission.turn.userEventId : null);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(2);
  });

  it.each([
    ["foreign", "identity:foreign"],
    ["voice", "identity:voice"],
  ] as const)("rolls back a staged event for a %s target identity", async (_label, targetIdentityId) => {
    const repo = repository();
    const { claim } = await admitAndClaim(repo);

    await expect(repo.stageAssistantDelivery({
      claim: claim.capability,
      text: redacted("safe answer"),
      targetIdentityId,
      replyToMessageId: null,
      now: LATER,
    })).rejects.toThrow("conversation_delivery_target_invalid");

    expect((await env.DB.prepare("SELECT state FROM conversation_turns WHERE turn_id = ?").bind(TURN_ID).first<{ state: string }>())?.state).toBe("model_claimed");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_deliveries").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.assistant_staged'").first<{ count: number }>())?.count).toBe(0);
  });

  it("claims one delivery with a validated staged payload and turns exact lease expiry terminal unknown", async () => {
    const repo = repository();
    const { staged } = await stagedDelivery(repo);
    const claims = await Promise.all(Array.from({ length: 6 }, () => repo.claimDelivery({
      deliveryId: staged.delivery.deliveryId,
      now: LATER,
    })));
    const winner = claims.find((claim) => claim.kind === "claimed");
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "in_progress")).toHaveLength(5);
    if (winner?.kind !== "claimed") throw new Error("test_lease_missing");
    expect(winner.item).toMatchObject({
      deliveryId: staged.delivery.deliveryId,
      principalId: "principal:owner",
      targetIdentityId: "identity:telegram",
      text: "safe answer",
      replyToMessageId: 42,
      historyMode: "assistant",
      state: "claimed",
    });
    expect(Object.isFrozen(winner.item)).toBe(true);
    expect(() => repo.beginDelivery(winner.capability, staged.delivery.deliveryId, staged.delivery.materialHash)).not.toThrow();
    expect(() => repo.beginDelivery(winner.capability, staged.delivery.deliveryId, staged.delivery.materialHash)).toThrow("delivery_lease_invalid");

    const leaseExpiry = new Date(winner.item.leaseExpiresAt ?? "invalid");
    const expired = await repo.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: leaseExpiry });
    expect(expired).toMatchObject({ kind: "terminal", item: { state: "unknown" } });
  });

  it("rejects forged and cross-delivery lease or receipt capabilities without consuming either authority", async () => {
    const repo = repository();
    const first = await stagedDelivery(repo, TURN_ID);
    const second = await stagedDelivery(repo, TURN_ID_2);
    const firstClaim = await repo.claimDelivery({ deliveryId: first.staged.delivery.deliveryId, now: LATER });
    const secondClaim = await repo.claimDelivery({ deliveryId: second.staged.delivery.deliveryId, now: LATER });
    if (firstClaim.kind !== "claimed" || secondClaim.kind !== "claimed") throw new Error("test_lease_failed");
    const forgedCapability = Object.freeze({
      deliveryId: first.staged.delivery.deliveryId,
      materialHash: first.staged.delivery.materialHash,
    }) as DeliveryLeaseCapability;

    expect(() => repo.beginDelivery(
      forgedCapability,
      first.staged.delivery.deliveryId,
      first.staged.delivery.materialHash,
    )).toThrow("delivery_lease_invalid");
    expect(() => repo.beginDelivery(
      firstClaim.capability,
      second.staged.delivery.deliveryId,
      second.staged.delivery.materialHash,
    )).toThrow("delivery_lease_invalid");
    repo.beginDelivery(firstClaim.capability, first.staged.delivery.deliveryId, first.staged.delivery.materialHash);
    repo.beginDelivery(secondClaim.capability, second.staged.delivery.deliveryId, second.staged.delivery.materialHash);

    await expect(repo.recordDeliveryFailure({
      capability: forgedCapability,
      failure: ProviderFailure.permanent(),
      now: LATER,
    })).rejects.toThrow("delivery_lease_invalid");
    const forgedReceipt = Object.freeze({
      deliveryId: first.staged.delivery.deliveryId,
      targetIdentityId: first.staged.delivery.targetIdentityId,
      providerIdempotencyKey: first.staged.delivery.providerIdempotencyKey,
      materialHash: first.staged.delivery.materialHash,
      providerMessageId: "forged-provider-message",
    }) as ProviderDeliveryReceipt;
    await expect(repo.recordDeliverySuccess({
      capability: firstClaim.capability,
      receipt: forgedReceipt,
      now: LATER,
    })).rejects.toThrow("provider_delivery_receipt_invalid");

    const firstReceipt = repo.mintProviderDeliveryReceipt({
      capability: firstClaim.capability,
      providerMessageId: "telegram-message-first",
    });
    await expect(repo.recordDeliverySuccess({
      capability: secondClaim.capability,
      receipt: firstReceipt,
      now: LATER,
    })).rejects.toThrow("provider_delivery_receipt_invalid");
    await expect(repo.recordDeliverySuccess({
      capability: firstClaim.capability,
      receipt: firstReceipt,
      now: LATER,
    })).resolves.toMatchObject({ state: "delivered", providerMessageId: "telegram-message-first" });

    const secondReceipt = repo.mintProviderDeliveryReceipt({
      capability: secondClaim.capability,
      providerMessageId: "telegram-message-second",
    });
    await expect(repo.recordDeliverySuccess({
      capability: secondClaim.capability,
      receipt: secondReceipt,
      now: LATER,
    })).resolves.toMatchObject({ state: "delivered", providerMessageId: "telegram-message-second" });
  });

  it("caps known-safe retry authority at three attempts and records terminal exhaustion", async () => {
    const repo = repository();
    const { staged } = await stagedDelivery(repo);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await repo.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: LATER });
      if (claim.kind !== "claimed") throw new Error(`test_retry_claim_${attempt}_failed`);
      repo.beginDelivery(claim.capability, staged.delivery.deliveryId, staged.delivery.materialHash);
      const settled = await repo.recordDeliveryFailure({
        capability: claim.capability,
        failure: ProviderFailure.transient("rate_limited"),
        now: LATER,
      });
      expect(settled).toMatchObject(attempt < 3
        ? { state: "retry_wait", attemptCount: attempt, failureCode: "delivery_retry" }
        : { state: "failed", attemptCount: 3, failureCode: "delivery_retry_exhausted" });
    }

    await expect(repo.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: LATER }))
      .resolves.toMatchObject({ kind: "terminal", item: { state: "failed", attemptCount: 3 } });
    const eventCounts = await env.DB.prepare(`SELECT event_type, COUNT(*) AS count FROM events
      WHERE event_type IN ('conversation.delivery_retry', 'conversation.delivery_failed')
      GROUP BY event_type ORDER BY event_type`).all<{ event_type: string; count: number }>();
    expect(eventCounts.results).toEqual([
      { event_type: "conversation.delivery_failed", count: 1 },
      { event_type: "conversation.delivery_retry", count: 2 },
    ]);
  });

  it("acknowledges a provider receipt atomically and converges exact settlement replay without replacing its provider id", async () => {
    const repo = repository();
    const { staged } = await stagedDelivery(repo);
    const claim = await repo.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: LATER });
    if (claim.kind !== "claimed") throw new Error("test_lease_failed");
    repo.beginDelivery(claim.capability, staged.delivery.deliveryId, staged.delivery.materialHash);
    const receipt = repo.mintProviderDeliveryReceipt({ capability: claim.capability, providerMessageId: "telegram-message-101" });

    const delivered = await repo.recordDeliverySuccess({ capability: claim.capability, receipt, now: LATER });
    const replay = await repo.recordDeliverySuccess({ capability: claim.capability, receipt, now: LATER });

    expect(replay).toEqual(delivered);
    expect(delivered).toMatchObject({
      state: "delivered",
      providerMessageId: "telegram-message-101",
    });
    expect(delivered.deliveredAssistantEventId).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/u);
    expect((await env.DB.prepare("SELECT state FROM conversation_turns WHERE turn_id = ?").bind(TURN_ID).first<{ state: string }>())?.state).toBe("delivered");
    const history = await env.DB.prepare("SELECT event_type, envelope_json FROM events WHERE event_type = 'conversation.assistant_delivered'").first<{ event_type: string; envelope_json: string }>();
    expect(JSON.parse(history?.envelope_json ?? "null").payload).toEqual({
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: true,
      text: "safe answer",
    });
    await expect(env.DB.prepare("UPDATE conversation_deliveries SET provider_message_id = 'replacement' WHERE delivery_id = ?").bind(staged.delivery.deliveryId).run())
      .rejects.toThrow();
  });

  it.each([
    [ProviderFailure.transient("rate_limited"), "retry_wait"],
    [ProviderFailure.authentication(), "failed"],
    [ProviderFailure.permanent("invalid_request"), "failed"],
    [new ProviderIdempotencyConflictError(), "failed"],
    [ProviderFailure.transient("timeout"), "unknown"],
    [new Error("raw provider body"), "unknown"],
  ] as const)("settles allowlisted provider failure as %s", async (failure, expectedState) => {
    const repo = repository();
    const { staged } = await stagedDelivery(repo);
    const claim = await repo.claimDelivery({ deliveryId: staged.delivery.deliveryId, now: LATER });
    if (claim.kind !== "claimed") throw new Error("test_lease_failed");
    repo.beginDelivery(claim.capability, staged.delivery.deliveryId, staged.delivery.materialHash);

    const result = await repo.recordDeliveryFailure({ capability: claim.capability, failure, now: LATER });

    expect(result.state).toBe(expectedState);
    const stored = await env.DB.prepare("SELECT failure_code, failure_category FROM conversation_deliveries WHERE delivery_id = ?")
      .bind(staged.delivery.deliveryId).first<{ failure_code: string | null; failure_category: string | null }>();
    expect(canonicalJson(stored)).not.toContain("raw provider body");
  });

  it("stages a fixed system notice without a turn or assistant-history mode", async () => {
    const repo = repository();
    const input = {
      noticeId: NOTICE_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      noticeCode: "busy",
      targetIdentityId: "identity:telegram",
      replyToMessageId: 42,
      now: NOW,
    } as const;
    const staged = await repo.stageSystemNotice(input);
    const replay = await repo.stageSystemNotice(input);

    expect(staged).toMatchObject({ historyMode: "system", state: "pending" });
    expect(replay).toEqual(staged);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_deliveries").first<{ count: number }>())?.count).toBe(1);
    const event = await env.DB.prepare("SELECT envelope_json FROM events WHERE event_type = 'conversation.system_staged'").first<{ envelope_json: string }>();
    expect(JSON.parse(event?.envelope_json ?? "null").payload).toEqual({
      schemaCode: 1,
      channelCode: 2,
      noticeCode: 1,
      historyEligible: false,
      text: "Jarvis is busy. Please try again shortly.",
    });
  });

  it("binds model claims to exact turn material", async () => {
    const repo = repository();
    const one = await repo.getOrCreateTurn({
      turnId: TURN_ID,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello"),
      now: NOW,
    });
    const two = await repo.getOrCreateTurn({
      turnId: TURN_ID_2,
      sessionId: "session:telegram:44112233",
      principalId: "principal:owner",
      channel: "telegram",
      userText: redacted("hello two"),
      now: NOW,
    });
    const claim = await repo.claimModelTurn({ turnId: TURN_ID, requestHash: one.turn.requestHash, now: NOW });
    if (claim.kind !== "claimed") throw new Error("test_claim_failed");
    expect(() => repo.beginModelStream(claim.capability, TURN_ID_2, two.turn.requestHash)).toThrow("model_stream_claim_invalid");
    await expect(repo.claimModelTurn({ turnId: TURN_ID, requestHash: "f".repeat(64) as Sha256Hex, now: NOW }))
      .rejects.toThrow("conversation_turn_conflict");
  });
});

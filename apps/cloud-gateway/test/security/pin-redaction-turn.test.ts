import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { createVoiceStreamDelivery } from "../../src/conversation/conversation-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";
import { voiceSessionAudience } from "../../src/voice/production-runtime.js";
import {
  applyCloudMemoryMigration,
  applyFoundationMigration,
  clearConversationDataForTest,
} from "../persistence/migration.js";

/*
 * A four-digit PIN, driven through the one function every turn passes:
 * `DefaultConversationService.handleTurn`, against real D1.
 *
 * Who is on the other end decides what happens to it. Sid, 2026-09-24:
 * "there should be nothing between Jarvis and I interms of what he knows and
 * I know". So on Sid's own Telegram chat and his own call the PIN reaches the
 * model, the event log and the reply exactly as he said it. On a guest call
 * (the `external` reader, which is how `production-runtime.ts` composes a
 * guest session) it reaches none of them.
 *
 * The PIN below is synthetic.
 */

const NOW = new Date("2026-09-22T16:00:00.000Z");
const PRINCIPAL = "principal:owner";
const PIN = "7305";
const SENTENCE = `My PIN is ${PIN} and the essay is due Oct 14, 2026.`;
const REDACTED_SENTENCE = "My PIN is [REDACTED_AUTH_DIGITS] and the essay is due Oct 14, 2026.";

async function seedOwner(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'owner', ?2, ?3)`).bind(PRINCIPAL, timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES ('identity:telegram', ?1, 'telegram', '44112233', 'active', ?2, ?3)`).bind(PRINCIPAL, timestamp, timestamp),
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

/** A model that records what it was given, and repeats the PIN back so the output path is exercised too. */
function recordingModel(seen: string[]) {
  return {
    async *stream(input: { userText: string }) {
      seen.push(input.userText);
      yield Object.freeze({ index: 0, text: `Noted: your PIN is ${PIN}.` });
    },
  };
}

async function storedEnvelopes(): Promise<readonly string[]> {
  const rows = await env.DB.prepare("SELECT envelope_json FROM events ORDER BY sequence").all<{ envelope_json: string }>();
  return rows.results.map((row) => row.envelope_json);
}

function service(seen: string[], telegram: FakeTelegramProvider, redactor: Redactor): DefaultConversationService {
  const repository = new ConversationRepository(env.DB, new EventRepository(env.DB));
  return new DefaultConversationService({
    repository,
    model: recordingModel(seen),
    context: { async retrieve() { return Object.freeze([]); } },
    dispatcher: new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => new Date(NOW),
    }),
    redactor,
    now: () => new Date(NOW),
  } as never);
}

async function voiceTurn(redactor: Redactor) {
  const seen: string[] = [];
  const spoken: string[] = [];
  let finished = "";
  const sessionId = "voice-session-pin";
  const turnId = newUlid(NOW);
  const result = await service(seen, new FakeTelegramProvider(), redactor).handleTurn({
    sessionId,
    principalId: PRINCIPAL,
    turnId,
    text: SENTENCE,
    signal: new AbortController().signal,
    ...createVoiceStreamDelivery({
      sessionId,
      turnId,
      sendToken: async (token) => { spoken.push(token.text); },
      finish: async (finalText) => { finished = finalText; },
    }),
  });
  return { result, seen, spoken: spoken.join(""), finished };
}

describe("a four-digit PIN inside a turn", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await applyCloudMemoryMigration();
    await clearData();
    await seedOwner();
  });

  afterEach(clearData);

  it("reaches the model, the event log and the reply on Sid's own Telegram chat exactly as he wrote it", async () => {
    const seen: string[] = [];
    const telegram = new FakeTelegramProvider();

    const result = await service(seen, telegram, new Redactor("owner")).handleTurn({
      sessionId: "telegram:44112233",
      principalId: PRINCIPAL,
      turnId: newUlid(NOW),
      text: SENTENCE,
      signal: new AbortController().signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId: "identity:telegram",
      replyToMessageId: 17,
    });

    expect(result.outcome).toBe("telegram_delivered");
    expect(seen).toEqual([SENTENCE]);
    const envelopes = await storedEnvelopes();
    expect(envelopes.some((envelope) => envelope.includes(SENTENCE))).toBe(true);
    for (const envelope of envelopes) expect(envelope).not.toContain("[REDACTED_");
    expect(telegram.requests.map((request) => request.text)).toEqual([`Noted: your PIN is ${PIN}.`]);
  });

  it("reaches the model, the event log and the spoken reply on Sid's own call exactly as he said it", async () => {
    const { result, seen, spoken, finished } = await voiceTurn(new Redactor("owner"));

    expect(result.outcome).toBe("voice_sent");
    expect(seen).toEqual([SENTENCE]);
    const envelopes = await storedEnvelopes();
    expect(envelopes.some((envelope) => envelope.includes(SENTENCE))).toBe(true);
    for (const envelope of envelopes) expect(envelope).not.toContain("[REDACTED_");
    expect(spoken).toBe(`Noted: your PIN is ${PIN}.`);
    expect(finished).toBe(`Noted: your PIN is ${PIN}.`);
  });

  it("never reaches the model, the event log or the spoken reply on a guest call, and the year beside it survives", async () => {
    const { result, seen, spoken, finished } = await voiceTurn(new Redactor("external"));

    expect(result.outcome).toBe("voice_sent");
    expect(seen).toEqual([REDACTED_SENTENCE]);
    const envelopes = await storedEnvelopes();
    expect(envelopes.length).toBeGreaterThan(0);
    for (const envelope of envelopes) expect(envelope).not.toContain(PIN);
    expect(envelopes.some((envelope) => envelope.includes(REDACTED_SENTENCE))).toBe(true);
    expect(spoken).not.toContain(PIN);
    expect(finished).toBe("Noted: your PIN is [REDACTED_AUTH_DIGITS].");
  });
});

describe("which reader a call session composes", () => {
  it("is Sid only for an owner session, and the external reader for a guest session or anything unrecognized", () => {
    expect(voiceSessionAudience({ accessKind: "owner" })).toBe("owner");
    expect(voiceSessionAudience({ accessKind: "guest" })).toBe("external");
    expect(voiceSessionAudience({ accessKind: "Owner" })).toBe("external");
    expect(voiceSessionAudience({ accessKind: undefined })).toBe("external");
  });
});

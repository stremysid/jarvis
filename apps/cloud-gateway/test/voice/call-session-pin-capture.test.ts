import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { newUlid, type RelayBinding, type Ulid } from "../../../../packages/contracts/src/index.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { CallSessionCore, type CallSessionRelay } from "../../src/voice/call-session-do.js";
import { SensitiveActionPinGate } from "../../src/voice/sensitive-action-pin.js";
import { applySensitiveActionPinMigration, clearCallSessionsForTest } from "../persistence/migration.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const ACCOUNT_SID = `AC${"6".repeat(32)}`;
const CALL_SID = `CA${"4".repeat(32)}`;
const PROVIDER_SESSION_ID = `VX${"5".repeat(32)}`;
const RELAY_NONCE = `${"D".repeat(42)}M`;
const OWNER_PRINCIPAL = "principal:owner";
/** Obviously fake: the real PIN is a Worker secret only Sid sets. */
const FAKE_PIN = "0000";

function ownerSession(sessionId: Ulid): StoredCallSession {
  const binding: RelayBinding = Object.freeze({
    callSid: CALL_SID,
    principalId: OWNER_PRINCIPAL,
    identityId: "identity:voice",
    destinationIdentityId: "identity:voice",
    relayNonce: RELAY_NONCE,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
  });
  return Object.freeze({
    sessionId,
    callSid: CALL_SID,
    expectedAttemptId: null,
    direction: "inbound",
    phase: "active",
    nonceExpiresAt: new Date(NOW.valueOf() + 300_000).toISOString(),
    relaySetupExpiresAt: new Date(NOW.valueOf() + 300_000).toISOString(),
    providerSessionId: PROVIDER_SESSION_ID,
    providerConnectedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    binding,
  });
}

interface Harness {
  readonly core: CallSessionCore;
  readonly gate: SensitiveActionPinGate;
  readonly spoken: string[];
  readonly sent: string[];
  readonly sessionId: Ulid;
  authorize(): Promise<string | null>;
}

function harness(): Harness {
  const sessionId = newUlid();
  const spoken: string[] = [];
  const sent: string[] = [];
  const gate = new SensitiveActionPinGate({
    database: env.DB, pin: FAKE_PIN, now: () => new Date(NOW),
  });
  const relay: CallSessionRelay = {
    close: () => undefined,
    sendNeutralText: async (text) => { spoken.push(text); },
    sendToken: async (token) => { sent.push(token.text); },
    finish: async () => undefined,
    cancelOutput: async () => undefined,
  };
  const core = new CallSessionCore({
    capacity: { async assertAcceptingNewTurn() {} },
    session: ownerSession(sessionId),
    expectedAccountSid: ACCOUNT_SID,
    repository: new CallRepository(env.DB, new EventRepository(env.DB)),
    sensitiveActionPin: gate,
    relay,
    now: () => new Date(NOW),
  });
  return {
    core, gate, spoken, sent, sessionId,
    authorize: () => gate.authorizeToolCall({
      principalId: OWNER_PRINCIPAL, toolName: "send_email",
      capability: "contact.third_party", argumentsHash: "a".repeat(64),
    }),
  };
}

/**
 * The utterance given at a PIN prompt is the credential.
 *
 * These tests exist because the PIN must not reach any stored surface. The
 * routing branch in `CallSessionCore.#handlePrompt` returns before the
 * conversation, so the proof is that no conversation turn, event or model
 * input is created and that the digits never appear in what the core speaks.
 */
describe("a call's PIN prompt", () => {
  beforeEach(async () => {
    await applySensitiveActionPinMigration();
    await clearCallSessionsForTest();
    await env.DB.prepare("DELETE FROM events").run();
    await env.DB.prepare("DELETE FROM conversation_turns").run();
  });

  it("consumes a spoken PIN and never turns it into a conversation turn", async () => {
    const h = harness();
    const pending = h.authorize();
    // Let the rate-limit read and the prompt reach the relay.
    for (let turn = 0; turn < 50 && h.spoken.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await h.core.handleRelayEvent({ type: "prompt", text: "zero zero zero zero", language: "en-US", final: true });
    await expect(pending).resolves.toEqual(expect.any(String));
    expect(await env.DB.prepare("SELECT count(*) AS count FROM events").first<{ count: number }>())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM conversation_turns").first<{ count: number }>())
      .toEqual({ count: 0 });
    for (const text of [...h.spoken, ...h.sent]) {
      expect(text).not.toContain("zero zero zero zero");
      expect(text).not.toContain("0000");
    }
  });

  it("consumes keypad digits at the prompt instead of treating them as ordinary input", async () => {
    const h = harness();
    const pending = h.authorize();
    for (let turn = 0; turn < 50 && h.spoken.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (const digit of ["0", "0", "0", "0"]) {
      await h.core.handleRelayEvent({ type: "dtmf", digit });
    }
    await expect(pending).resolves.toEqual(expect.any(String));
    expect(await env.DB.prepare("SELECT count(*) AS count FROM events").first<{ count: number }>())
      .toEqual({ count: 0 });
  });

  it("still asks the question and consumes the answer when no model is configured", async () => {
    const h = harness();
    const pending = h.authorize();
    for (let turn = 0; turn < 50 && h.spoken.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.spoken).toHaveLength(1);
    await h.gate.submitSpoken("0000", new Date(NOW));
    await expect(pending).resolves.toEqual(expect.any(String));
  });
});

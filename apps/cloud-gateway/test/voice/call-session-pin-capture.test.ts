import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { newUlid, type RelayBinding, type Ulid } from "../../../../packages/contracts/src/index.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { CHANNEL_REFUSED, type ToolChannelAuthorization } from "../../src/autonomy/tool-gate.js";
import type { ConversationService, ConversationTurnResult } from "../../src/conversation/conversation-types.js";
import { CallSessionCore, type CallSessionRelay } from "../../src/voice/call-session-do.js";
import {
  SENSITIVE_ACTION_PIN_PROMPT,
  SENSITIVE_ACTION_PIN_TOO_LATE,
  SensitiveActionPinGate,
} from "../../src/voice/sensitive-action-pin.js";
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
  /** What each conversation turn's PIN question answered, in order. */
  readonly outcomes: ToolChannelAuthorization[];
  /** Each conversation turn's own abort signal. */
  readonly turnSignals: AbortSignal[];
  authorize(): ReturnType<SensitiveActionPinGate["authorizeToolCall"]>;
}

/**
 * A conversation whose every turn asks the PIN question with its own signal,
 * as the owner agent's tier-3 gate does, then optionally keeps running (the
 * model's second round) until `afterAnswer` resolves.
 */
function pinAskingConversation(
  gate: SensitiveActionPinGate,
  outcomes: ToolChannelAuthorization[],
  turnSignals: AbortSignal[],
  afterAnswer: () => Promise<void>,
): ConversationService {
  return {
    async handleTurn(input) {
      turnSignals.push(input.signal);
      outcomes.push(await gate.authorizeToolCall({
        principalId: OWNER_PRINCIPAL, toolName: "send_email",
        capability: "contact.third_party", argumentsHash: "a".repeat(64), signal: input.signal,
      }));
      await afterAnswer();
      return Object.freeze({
        outcome: "failed", committedUserEventId: newUlid(), sentAssistantEventId: null,
        deliveryId: null, deliveredAssistantEventId: null,
      }) as ConversationTurnResult;
    },
    async stageSystemNotice() { throw new Error("unused"); },
  };
}

function harness(options: {
  readonly conversation?: boolean;
  readonly promptTimeoutMs?: number;
  readonly afterAnswer?: () => Promise<void>;
} = {}): Harness {
  const sessionId = newUlid();
  const spoken: string[] = [];
  const sent: string[] = [];
  const outcomes: ToolChannelAuthorization[] = [];
  const turnSignals: AbortSignal[] = [];
  const gate = new SensitiveActionPinGate({
    database: env.DB, pin: FAKE_PIN, now: () => new Date(NOW),
    ...(options.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: options.promptTimeoutMs }),
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
    ...(options.conversation === true
      ? {
        conversation: pinAskingConversation(
          gate, outcomes, turnSignals, options.afterAnswer ?? (async () => undefined),
        ),
      }
      : {}),
    relay,
    now: () => new Date(NOW),
  });
  return {
    core, gate, spoken, sent, sessionId, outcomes, turnSignals,
    authorize: () => gate.authorizeToolCall({
      principalId: OWNER_PRINCIPAL, toolName: "send_email",
      capability: "contact.third_party", argumentsHash: "a".repeat(64),
    }),
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

function said(text: string, final = true) {
  return { type: "prompt" as const, text, language: "en-US", final };
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

  it("keeps the question open when Sid talks over the prompt, so his PIN still authorizes the action", async () => {
    const h = harness({ conversation: true });
    const turn = h.core.handleRelayEvent(said("Email my essay to Mr. Smith."));
    await until(() => h.spoken.length === 1);
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT]);
    // Barge-in: ConversationRelay sends interrupt when he starts speaking over
    // the prompt. It must stop the prompt's audio, not end the turn.
    await h.core.handleRelayEvent({ type: "interrupt" });
    expect(h.gate.hasPendingPrompt()).toBe(true);
    expect(h.turnSignals[0]!.aborted).toBe(false);
    await h.core.handleRelayEvent(said("Zero zero zero zero."));
    await turn;
    expect(h.outcomes).toEqual([expect.any(String)]);
  });

  it("ignores a partial transcript at the question and counts only the final one", async () => {
    const h = harness();
    const pending = h.authorize();
    await until(() => h.spoken.length === 1);
    await h.core.handleRelayEvent(said("1111", false));
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT]);
    expect(h.gate.hasPendingPrompt()).toBe(true);
    await h.core.handleRelayEvent(said("0000"));
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("drops keypad digits left over from an earlier question", async () => {
    const h = harness();
    const first = h.authorize();
    await until(() => h.spoken.length === 1);
    await h.core.handleRelayEvent({ type: "dtmf", digit: "1" });
    await h.core.handleRelayEvent({ type: "dtmf", digit: "2" });
    await h.core.handleRelayEvent(said("Cancel."));
    await expect(first).resolves.toBe(CHANNEL_REFUSED);
    const second = h.authorize();
    await until(() => h.gate.hasPendingPrompt());
    for (const digit of ["0", "0", "0", "0"]) await h.core.handleRelayEvent({ type: "dtmf", digit });
    await expect(second).resolves.toEqual(expect.any(String));
  });

  it("treats a PIN said just after the question expired as a late answer, never a turn", async () => {
    // Probe D: the question times out, the turn finishes, then the PIN
    // arrives. It must not become a second conversation turn or an event.
    const h = harness({ conversation: true, promptTimeoutMs: 5 });
    await h.core.handleRelayEvent(said("Email my essay to Mr. Smith."));
    expect(h.outcomes).toEqual([CHANNEL_REFUSED]);
    await h.core.handleRelayEvent(said("zero zero zero zero"));
    expect(h.turnSignals).toHaveLength(1);
    expect(h.spoken.at(-1)).toBe(SENSITIVE_ACTION_PIN_TOO_LATE);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM events").first<{ count: number }>())
      .toEqual({ count: 0 });
    for (const text of [...h.spoken, ...h.sent]) {
      expect(text).not.toContain("zero zero zero zero");
      expect(text).not.toContain("0000");
    }
  });

  it("consumes a late PIN while the refusing turn is still running instead of ending the call", async () => {
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ conversation: true, promptTimeoutMs: 5, afterAnswer: () => running });
    const turn = h.core.handleRelayEvent(said("Email my essay to Mr. Smith."));
    await until(() => h.outcomes.length === 1);
    // Without the late-answer branch this is "turn_in_progress", which the
    // socket turns into a 1011 close: the call would end.
    await expect(h.core.handleRelayEvent(said("0000"))).resolves.toBeUndefined();
    expect(h.spoken.at(-1)).toBe(SENSITIVE_ACTION_PIN_TOO_LATE);
    release();
    await turn;
    expect(h.turnSignals).toHaveLength(1);
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

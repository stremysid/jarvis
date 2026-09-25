import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import {
  SENSITIVE_ACTION_PIN_CANCELLED,
  SENSITIVE_ACTION_PIN_EXPIRED,
  SENSITIVE_ACTION_PIN_MAX_ATTEMPTS,
  SENSITIVE_ACTION_PIN_PROMPT,
  SENSITIVE_ACTION_PIN_RATE_LIMITED,
  SENSITIVE_ACTION_PIN_RATE_MAX_MISMATCHES,
  SENSITIVE_ACTION_PIN_REFUSED,
  SENSITIVE_ACTION_PIN_REPROMPT_UNREADABLE,
  SENSITIVE_ACTION_PIN_REPROMPT_WRONG,
  SensitiveActionPinGate,
} from "../../src/voice/sensitive-action-pin.js";
import {
  applySensitiveActionPinMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearConversationDataForTest,
  clearOwnerCallStepUpDataForTest,
  clearSensitiveActionPinDataForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
/** Obviously fake, so no reader can mistake it for the deployed secret. */
const FAKE_PIN = "2468";
const PRINCIPAL = "principal:owner";
const DIGITS = Uint8Array.from([50, 52, 54, 56]); // "2468"

/**
 * Lets the rate-limit read and the prompt's relay write settle.
 *
 * The gate asks the database whether the window is already full before it
 * speaks, so one microtask is not enough and an assertion that raced it would
 * fail for the harness's timing rather than the gate's behaviour.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}



async function seedPrincipal(): Promise<void> {
  const at = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'Owner', ?, ?)`).bind(PRINCIPAL, at, at),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES ('identity:voice', ?, 'voice', '+14165550123', 'active', ?, ?)`).bind(PRINCIPAL, at, at),
    env.DB.prepare(`INSERT INTO voice_owner_identity (
      singleton_id, principal_id, identity_id, created_at
    ) VALUES (1, ?, 'identity:voice', ?)`).bind(PRINCIPAL, at),
  ]);
}

let callSequence = 0;

async function seedCallSession(): Promise<Ulid> {
  callSequence += 1;
  const repository = new CallRepository(
    env.DB, new EventRepository(env.DB), () => `${"D".repeat(42)}M`, 300_000, () => newUlid(),
  );
  const stored = await repository.getOrCreateInboundSession({
    callSid: `CA${callSequence.toString(16).padStart(32, "0")}`,
    callerE164: "+14165550123",
    ownerIdentityId: "identity:voice",
    currentChallengeHmacKeyVersion: "hmac-v1",
    now: NOW,
  });
  return stored.sessionId;
}

interface Harness {
  readonly gate: SensitiveActionPinGate;
  readonly spoken: string[];
  request(): Promise<string | null>;
}

async function harness(input: {
  pin?: string | null;
  promptTimeoutMs?: number;
  now?: () => Date;
} = {}): Promise<Harness> {
  await applySensitiveActionPinMigration();
  await seedPrincipal();
  const sessionId = await seedCallSession();
  const spoken: string[] = [];
  const now = input.now ?? (() => new Date(NOW));
  const gate = new SensitiveActionPinGate({
    database: env.DB,
    pin: input.pin === undefined ? FAKE_PIN : input.pin,
    now,
    ...(input.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: input.promptTimeoutMs }),
  });
  gate.attachSession({ sessionId, speak: async (text) => { spoken.push(text); } });
  return {
    gate,
    spoken,
    request: () => gate.authorizeToolCall({
      principalId: PRINCIPAL, toolName: "send_email",
      capability: "contact.third_party", argumentsHash: "a".repeat(64),
    }),
  };
}

describe("the tier-3 PIN gate on a call", () => {
  beforeEach(async () => {
    await applySensitiveActionPinMigration();
    // The ledger references the call session, so it is emptied before the
    // session fixtures the other clearers remove.
    await clearSensitiveActionPinDataForTest();
    await clearOwnerCallStepUpDataForTest();
    await clearCallSessionsForTest();
    await clearAuthenticationAttemptReservationsForTest();
    await clearConversationDataForTest();
    await clearVoiceAccessDataForTest();
    await env.DB.prepare("DELETE FROM provider_events").run();
    await env.DB.prepare("DELETE FROM events").run();
    await env.DB.prepare("DELETE FROM device_keys").run();
    await env.DB.prepare("DELETE FROM channel_identities").run();
    await env.DB.prepare("DELETE FROM principals").run();
  });

  afterEach(async () => {
    await clearSensitiveActionPinDataForTest();
  });

  it("asks once, then authorizes the exact action when the PIN is spoken as digits", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT]);
    await h.gate.submitSpoken("2468", NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT]);
    expect(h.gate.hasPendingPrompt()).toBe(false);
  });

  it("authorizes the same action when the PIN is spoken as four digit words", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    await h.gate.submitSpoken("two four six eight", NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("authorizes the same action when the PIN is spoken as two two-digit numbers", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    await h.gate.submitSpoken("twenty-four sixty-eight", NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("authorizes the same action when four digits arrive from the keypad", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    const keypad = DIGITS.slice();
    await h.gate.submitKeypad(keypad, NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
    expect([...keypad]).toEqual([0, 0, 0, 0]);
  });

  it("re-prompts on a wrong PIN and authorizes the correct one on the next try", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    await h.gate.submitSpoken("1111", NOW);
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT, SENSITIVE_ACTION_PIN_REPROMPT_WRONG]);
    expect(h.gate.hasPendingPrompt()).toBe(true);
    await h.gate.submitSpoken("2468", NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("re-prompts differently when the utterance is not four digits at all", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    await h.gate.submitSpoken("what was that", NOW);
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT, SENSITIVE_ACTION_PIN_REPROMPT_UNREADABLE]);
    await h.gate.submitSpoken("2468", NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("refuses the action after five wrong candidates and says nothing was changed", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    for (let attempt = 0; attempt < SENSITIVE_ACTION_PIN_MAX_ATTEMPTS; attempt += 1) {
      await h.gate.submitSpoken("1111", NOW);
    }
    await expect(pending).resolves.toBeNull();
    expect(h.spoken.at(-1)).toBe(SENSITIVE_ACTION_PIN_REFUSED);
    expect(h.gate.hasPendingPrompt()).toBe(false);
  });

  it("spends the question's attempts on unreadable speech while recording no mismatch for it", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    for (let attempt = 0; attempt < SENSITIVE_ACTION_PIN_MAX_ATTEMPTS; attempt += 1) {
      await h.gate.submitSpoken("mumble mumble", NOW);
    }
    await expect(pending).resolves.toBeNull();
    const rows = await env.DB.prepare("SELECT count(*) AS count FROM sensitive_action_pin_attempts")
      .first<{ count: number }>();
    expect(rows?.count).toBe(0);
  });

  it("refuses rather than hanging when the question is never answered", async () => {
    const h = await harness({ promptTimeoutMs: 5 });
    await expect(h.request()).resolves.toBeNull();
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT, SENSITIVE_ACTION_PIN_EXPIRED]);
  });

  it("refuses every sensitive action when the deployment has no PIN", async () => {
    const h = await harness({ pin: null });
    await expect(h.request()).resolves.toBeNull();
    expect(h.spoken).toEqual([]);
  });

  it("refuses without asking once the window already holds twelve wrong candidates", async () => {
    const h = await harness();
    const sessionId = (await env.DB.prepare("SELECT session_id FROM call_sessions LIMIT 1")
      .first<{ session_id: string }>())!.session_id;
    for (let index = 0; index < SENSITIVE_ACTION_PIN_RATE_MAX_MISMATCHES; index += 1) {
      await env.DB.prepare(`INSERT INTO sensitive_action_pin_attempts (
        attempt_id, session_id, owner_principal_id, attempted_at, outcome
      ) VALUES (?, ?, ?, ?, 'mismatched')`)
        .bind(newUlid(), sessionId, PRINCIPAL, NOW.toISOString()).run();
    }
    await expect(h.request()).resolves.toBeNull();
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_RATE_LIMITED]);
  });

  it("lets the window slide, so a wrong run never locks the owner out permanently", async () => {
    const h = await harness();
    const sessionId = (await env.DB.prepare("SELECT session_id FROM call_sessions LIMIT 1")
      .first<{ session_id: string }>())!.session_id;
    const stale = new Date(NOW.valueOf() - 16 * 60_000).toISOString();
    for (let index = 0; index < SENSITIVE_ACTION_PIN_RATE_MAX_MISMATCHES; index += 1) {
      await env.DB.prepare(`INSERT INTO sensitive_action_pin_attempts (
        attempt_id, session_id, owner_principal_id, attempted_at, outcome
      ) VALUES (?, ?, ?, ?, 'mismatched')`)
        .bind(newUlid(), sessionId, PRINCIPAL, stale).run();
    }
    const pending = h.request();
    await settle();
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT]);
    await h.gate.submitSpoken("2468", NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("lets the caller abandon the question with cancel", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    await h.gate.submitSpoken("cancel", NOW);
    await expect(pending).resolves.toBeNull();
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT, SENSITIVE_ACTION_PIN_CANCELLED]);
  });

  it("mints a fresh single-use authorization for each question", async () => {
    const h = await harness();
    const first = h.request();
    await settle();
    await h.gate.submitSpoken("2468", NOW);
    const firstId = await first;
    const second = h.request();
    await settle();
    await h.gate.submitSpoken("2468", NOW);
    const secondId = await second;
    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();
    expect(firstId).not.toBe(secondId);
  });

  it("refuses a second question while one is already open", async () => {
    const h = await harness();
    const first = h.request();
    await settle();
    await expect(h.request()).resolves.toBeNull();
    expect(h.spoken).toEqual([SENSITIVE_ACTION_PIN_PROMPT]);
    await h.gate.submitSpoken("2468", NOW);
    await expect(first).resolves.toEqual(expect.any(String));
  });

  it("refuses the action when the wrong-candidate ledger cannot be written", async () => {
    // The window read succeeds and the mismatch insert fails, which is the case
    // where a guess cannot be counted and must therefore not be accepted.
    const gate = new SensitiveActionPinGate({
      database: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ count: 0 }),
            run: async () => { throw new Error("d1 unavailable"); },
          }),
        }),
      } as unknown as D1Database,
      pin: FAKE_PIN,
      now: () => new Date(NOW),
    });
    const spoken: string[] = [];
    gate.attachSession({ sessionId: newUlid(), speak: async (text) => { spoken.push(text); } });
    const pending = gate.authorizeToolCall({
      principalId: PRINCIPAL, toolName: "send_email",
      capability: "contact.third_party", argumentsHash: "a".repeat(64),
    });
    await settle();
    await gate.submitSpoken("1111", NOW);
    await expect(pending).resolves.toBeNull();
    expect(spoken.at(-1)).toBe(SENSITIVE_ACTION_PIN_REFUSED);
  });

  it("stores no form of the candidate in the attempt row", async () => {
    const h = await harness();
    const pending = h.request();
    await settle();
    await h.gate.submitSpoken("nine nine nine nine", NOW);
    await h.gate.submitSpoken("9999", NOW);
    await h.gate.submitSpoken("2468", NOW);
    await expect(pending).resolves.toEqual(expect.any(String));
    const rows = await env.DB.prepare("SELECT * FROM sensitive_action_pin_attempts")
      .all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(2);
    // Every column of every row is checked for both forms of the wrong
    // candidate. The rows hold ids, an outcome and a timestamp.
    for (const row of rows.results) {
      expect(row.outcome).toBe("mismatched");
      for (const value of Object.values(row)) {
        const text = String(value);
        expect(text).not.toContain("9999");
        expect(text).not.toContain("nine nine nine nine");
      }
    }
  });
});

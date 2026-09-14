// PR #31 adversarial suite, attack 9 (production composition): the challenge issued by the enrollment route
// must be consumable only by the production CallSession runtime configured from the same Worker env.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { CallSession } from "../../src/voice/call-session-do.js";
import { applyVoiceRuntimeMigration } from "../persistence/migration.js";
import {
  b64, BEGIN, KEY_VERSION, PHONE, resetEnrollmentState, seedDevice, seedPrincipal, send, STATUS, type Device,
} from "./pr31-helpers.js";

const NOW = new Date("2026-09-14T15:00:00.000Z");
const ACCOUNT_SID = `AC${"6".repeat(32)}`;

function configuration(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_API_KEY_SID: `SK${"6".repeat(32)}`,
    TWILIO_API_KEY_SECRET: "synthetic-voice-key",
    OWNER_PRINCIPAL_ID: "principal:owner",
    OWNER_VOICE_IDENTITY_ID: "identity:voice",
    CAPACITY_D1_BUDGET_BYTES: "1000000000",
    CAPACITY_R2_BUDGET_BYTES: "1000000000",
    CAPACITY_MODEL_ALLOCATION_USD: "20",
    CAPACITY_TWILIO_DAILY_BUDGET_USD: "40",
    DEEPSEEK_API_KEY: "synthetic-runtime-key",
    DEEPSEEK_MODEL: "synthetic-runtime-model",
    TELEGRAM_BOT_TOKEN: `123456789:${"s".repeat(35)}`,
    GUEST_PIN_PEPPER_V1: b64(new Uint8Array(32).fill(12)),
    AUTHENTICATION_BUDGET_PEPPER: b64(new Uint8Array(32).fill(7)),
    IDENTITY_CHALLENGE_HMAC_PEPPER: b64(new Uint8Array(32).fill(11)),
    IDENTITY_CHALLENGE_HMAC_KEY_VERSION: KEY_VERSION,
    ...overrides,
  } as Env;
}

async function runtime(stored: StoredCallSession, configured: Env) {
  if (stored.relaySetupExpiresAt === null) throw new Error("fixture_inbound_expiry_missing");
  const relaySetupExpiresAt = stored.relaySetupExpiresAt;
  const stub = env.CALL_SESSION.getByName(stored.sessionId);
  const socket = {
    close: vi.fn(),
    send: vi.fn(),
    deserializeAttachment: () => ({ sessionId: stored.sessionId }),
  } as unknown as WebSocket;
  let object: CallSession | undefined;
  await runInDurableObject(stub, async (_instance, state) => {
    object = new CallSession(state, configured);
    await object.initialize({ sessionId: stored.sessionId, binding: stored.binding, relaySetupExpiresAt });
  });
  const frame = (value: unknown) => runInDurableObject(stub, async () => {
    await (object as CallSession).webSocketMessage(socket, JSON.stringify(value));
  });
  return {
    socket,
    setup: () => frame({
      type: "setup", sessionId: `VX${"5".repeat(32)}`, accountSid: ACCOUNT_SID, callSid: stored.callSid,
      direction: "inbound", customParameters: { relayNonce: stored.binding.relayNonce },
    }),
    digits: async (digits: string) => {
      for (const digit of digits) await frame({ type: "dtmf", digit });
    },
  };
}

async function admit(callSid: string): Promise<StoredCallSession> {
  return new CallRepository(env.DB, new EventRepository(env.DB)).getOrCreateInboundSession({
    callSid, callerE164: PHONE, ownerIdentityId: "identity:voice", currentChallengeHmacKeyVersion: KEY_VERSION, now: new Date(),
  });
}

async function identityStatus(): Promise<string | null> {
  return (await env.DB.prepare("SELECT status FROM channel_identities WHERE identity_id = 'identity:voice'")
    .first<{ status: string }>())?.status ?? null;
}

describe("PR31 adversarial 9: production CallSession composition", () => {
  let home: Device;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await applyVoiceRuntimeMigration();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await resetEnrollmentState();
    await seedPrincipal("principal:owner");
    home = await seedDevice("device:owner", "principal:owner", "key:owner");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network_forbidden_in_adversarial_test");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("9p the route's challenge is consumed by the production runtime configured from the same env", async () => {
    const configured = configuration();
    const begun = await send(home, BEGIN, configured);
    expect(begun.status, begun.text).toBe(200);
    const issued = begun.json as { challengeId: string; response: string };

    const stored = await admit(`CA${"4".repeat(32)}`);
    expect(stored.binding.activationChallengeId).toBe(issued.challengeId);
    const call = await runtime(stored, configured);
    await call.setup();
    await call.digits(issued.response);

    expect(await identityStatus()).toBe("active");
    expect((await send(home, STATUS, configured)).json).toMatchObject({ enrollmentState: "active" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("9p' a pepper rotated without a key-version bump fails closed instead of activating", async () => {
    const issuing = configuration();
    const begun = await send(home, BEGIN, issuing);
    const issued = begun.json as { response: string };
    const rotated = configuration({ IDENTITY_CHALLENGE_HMAC_PEPPER: b64(new Uint8Array(32).fill(99)) });

    const stored = await admit(`CA${"3".repeat(32)}`);
    const call = await runtime(stored, rotated);
    await call.setup();
    await call.digits(issued.response);

    expect(await identityStatus()).toBe("pending");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

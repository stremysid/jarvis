import { describe, expect, it, vi } from "vitest";
import type { TwilioRequestVerifier, VerifiedTwilioForm } from "../../src/providers/provider-types.js";
import { TwilioSignatureVerifier } from "../../src/providers/twilio-verifier.js";
import { callSessionAdmissionFailure } from "../../src/persistence/call-repository.js";
import { handleInboundVoiceWebhook, type InboundVoiceDependencies } from "../../src/voice/inbound.js";

const AUTH_TOKEN = "synthetic-auth-token";
const EXACT_URL = "https://jarvis.example/voice/inbound";
const EXPECTED_TO = "+14165550100";
const FROM = "+14165550123";
const CALL_SID = `CA${"1".repeat(32)}`;
const SESSION_ID = "01k3wceg000000000000000001";
const NONCE = `${"A".repeat(42)}A`;

type Pair = readonly [string, string];

async function signPairs(pairs: readonly Pair[]): Promise<string> {
  const grouped = new Map<string, Set<string>>();
  for (const [name, value] of pairs) {
    const values = grouped.get(name) ?? new Set<string>();
    values.add(value);
    grouped.set(name, values);
  }
  const payload = EXACT_URL + [...grouped]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([name, values]) => [...values]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((value) => `${name}${value}`))
    .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signedRequest(pairs: readonly Pair[], signatureOverride?: string): Promise<Request> {
  const body = pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  return new Request("https://internal.invalid/twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-twilio-signature": signatureOverride ?? await signPairs(pairs),
    },
    body,
  });
}

function validPairs(overrides: Partial<{ from: string; to: string; callSid: string }> = {}): Pair[] {
  return [
    ["From", overrides.from ?? FROM],
    ["To", overrides.to ?? EXPECTED_TO],
    ["CallSid", overrides.callSid ?? CALL_SID],
    ["AccountSid", `AC${"2".repeat(32)}`],
  ];
}

function storedSession() {
  return Object.freeze({
    sessionId: SESSION_ID,
    callSid: CALL_SID,
    expectedAttemptId: null,
    direction: "inbound" as const,
    phase: "created" as const,
    nonceExpiresAt: "2026-08-30T12:05:00.000Z",
    relaySetupExpiresAt: "2026-08-30T12:05:00.000Z",
    providerSessionId: null,
    providerConnectedAt: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    binding: Object.freeze({
      callSid: CALL_SID,
      principalId: "principal:owner",
      identityId: "identity:voice",
      destinationIdentityId: "identity:voice",
      relayNonce: NONCE,
      direction: "inbound" as const,
      activationOnly: false,
      activationChallengeId: null,
      accessKind: "owner" as const,
      guestGrantId: null,
      guestGrantVersion: null,
      accessDocumentHash: null,
    }),
  });
}

function dependencies(overrides: Partial<InboundVoiceDependencies> = {}) {
  const getOrCreateInboundSession = vi.fn(async () => storedSession());
  const initializeSession = vi.fn(async () => undefined);
  const deps: InboundVoiceDependencies = {
    twilio: new TwilioSignatureVerifier({ authToken: AUTH_TOKEN }),
    exactInboundWebhookUrl: EXACT_URL,
    publicOrigin: new URL("https://jarvis.example/"),
    expectedInboundE164: EXPECTED_TO,
    ownerIdentityId: "identity:voice",
    currentChallengeHmacKeyVersion: "hmac-v1",
    ownerCallerIdPolicy: undefined,
    ownerStepUp: { bind: vi.fn(async (input) => input) },
    sessions: { getOrCreateInboundSession },
    initializeSession,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    ...overrides,
  };
  return { deps, getOrCreateInboundSession, initializeSession };
}

describe("signed inbound voice webhook", () => {
  it("verifies the original request first and performs zero persistence or initialization when unsigned", async () => {
    const request = await signedRequest(validPairs(), "AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    const { deps, getOrCreateInboundSession, initializeSession } = dependencies();
    const response = await handleInboundVoiceWebhook(request, deps);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("rejects a structural form forged by a foreign verifier authority", async () => {
    const forged = {
      get: (name: string) => new Map([["From", FROM], ["To", EXPECTED_TO], ["CallSid", CALL_SID]]).get(name) ?? null,
      getAll: (name: string) => {
        const value = new Map([["From", FROM], ["To", EXPECTED_TO], ["CallSid", CALL_SID]]).get(name);
        return value === undefined ? [] : [value];
      },
      entries: () => validPairs(),
    } as unknown as VerifiedTwilioForm;
    const real = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });
    const twilio: TwilioRequestVerifier = {
      verifyWebhook: async () => forged,
      verifyWebSocket: real.verifyWebSocket.bind(real),
    };
    const { deps, getOrCreateInboundSession, initializeSession } = dependencies({ twilio });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    expect(response.status).toBe(403);
    expect(getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("neutralizes a foreign form Proxy without invoking its reflection traps", async () => {
    const trap = vi.fn(() => { throw new Error("foreign_form_trap"); });
    const forged = new Proxy({}, { isExtensible: trap, getPrototypeOf: trap }) as unknown as VerifiedTwilioForm;
    const real = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });
    const twilio: TwilioRequestVerifier = {
      verifyWebhook: async () => forged,
      verifyWebSocket: real.verifyWebSocket.bind(real),
    };
    const { deps, getOrCreateInboundSession, initializeSession } = dependencies({ twilio });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(trap).not.toHaveBeenCalled();
    expect(getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("passes the original Request exactly once to the verifier without pre-consuming it", async () => {
    const request = await signedRequest(validPairs());
    const real = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });
    const verifyWebhook = vi.fn(async (input: Parameters<TwilioRequestVerifier["verifyWebhook"]>[0]) => {
      expect(input.request).toBe(request);
      expect(input.request.bodyUsed).toBe(false);
      return real.verifyWebhook(input);
    });
    const twilio: TwilioRequestVerifier = { verifyWebhook, verifyWebSocket: real.verifyWebSocket.bind(real) };
    const { deps } = dependencies({ twilio });
    expect((await handleInboundVoiceWebhook(request, deps)).status).toBe(200);
    expect(verifyWebhook).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing From", validPairs().filter(([name]) => name !== "From")],
    ["duplicate From", [...validPairs(), ["From", FROM] as const]],
    ["malformed From", validPairs({ from: "14165550123" })],
    ["wrong To", validPairs({ to: "+14165559999" })],
    ["duplicate To", [...validPairs(), ["To", EXPECTED_TO] as const]],
    ["malformed To", validPairs({ to: " +14165550100" })],
    ["missing CallSid", validPairs().filter(([name]) => name !== "CallSid")],
    ["duplicate CallSid", [...validPairs(), ["CallSid", CALL_SID] as const]],
    ["malformed CallSid", validPairs({ callSid: `CA${"g".repeat(32)}` })],
  ])("returns the same neutral rejection for %s", async (_label, pairs) => {
    const { deps, getOrCreateInboundSession, initializeSession } = dependencies();
    const response = await handleInboundVoiceWebhook(await signedRequest(pairs), deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("uses only provider-observed caller data and initializes the exact frozen stored binding", async () => {
    const { deps, getOrCreateInboundSession, initializeSession } = dependencies();
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    expect(getOrCreateInboundSession).toHaveBeenCalledWith({
      callSid: CALL_SID,
      callerE164: FROM,
      ownerIdentityId: "identity:voice",
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(initializeSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      binding: storedSession().binding,
      relaySetupExpiresAt: "2026-08-30T12:05:00.000Z",
    });
    const initialization = initializeSession.mock.calls[0]?.[0];
    expect(Object.isFrozen(initialization?.binding)).toBe(true);
    expect(response.status).toBe(200);
  });

  it("renders only exact trusted relay routes and the fixed voice configuration", async () => {
    const { deps } = dependencies();
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/xml; charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain(`url="wss://jarvis.example/voice/relay/${SESSION_ID}"`);
    expect(body).toContain("action=\"https://jarvis.example/voice/relay-ended#rc=2&amp;rp=ct,rt,5xx\"");
    expect(body).toContain(`name="relayNonce" value="${NONCE}"`);
    expect(body).toContain("language=\"en-US\"");
    expect(body).not.toContain(FROM);
    expect(body).not.toContain("principal:owner");
  });

  it.each([
    "inbound_session_rejected",
    "call_session_capacity",
    "call_session_conflict",
    "call_session_expired",
  ])("maps expected repository rejection %s to the same neutral 403", async (message) => {
    const sessions = { getOrCreateInboundSession: vi.fn(async () => { throw callSessionAdmissionFailure(message); }) };
    const { deps, initializeSession } = dependencies({ sessions });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("returns a neutral unavailable response for internal failures without TwiML or sensitive reflection", async () => {
    const canary = `${FROM}:challenge:482913:${NONCE}`;
    const sessions = { getOrCreateInboundSession: vi.fn(async () => { throw new Error(canary); }) };
    const { deps, initializeSession } = dependencies({ sessions });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toBe("unavailable");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain(canary);
    expect(body).not.toContain("<Response>");
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("does not invoke accessor-shaped stored session fields", async () => {
    const getter = vi.fn(() => storedSession().binding);
    const forged = { ...storedSession() } as Record<string, unknown>;
    Object.defineProperty(forged, "binding", { enumerable: true, get: getter });
    const sessions = { getOrCreateInboundSession: vi.fn(async () => forged as never) };
    const { deps, initializeSession } = dependencies({ sessions });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    expect(response.status).toBe(503);
    expect(getter).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("does not initialize or emit TwiML for an unbound snapshot at its exact setup deadline", async () => {
    const now = () => new Date("2026-08-30T12:05:00.000Z");
    const { deps, initializeSession } = dependencies({ now });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unavailable");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("neutralizes a throwing stored-session reflection trap", async () => {
    const trap = vi.fn(() => { throw new Error("stored_session_trap"); });
    const forged = new Proxy({}, { getPrototypeOf: trap });
    const sessions = { getOrCreateInboundSession: vi.fn(async () => forged as never) };
    const { deps, initializeSession } = dependencies({ sessions });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unavailable");
    expect(trap).toHaveBeenCalledTimes(1);
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("keeps initializer failures neutral and never emits the already-rendered TwiML", async () => {
    const canary = `initializer:${FROM}:482913:${NONCE}`;
    const initializeSession = vi.fn(async () => { throw new Error(canary); });
    const { deps } = dependencies({ initializeSession });
    const response = await handleInboundVoiceWebhook(await signedRequest(validPairs()), deps);
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toBe("unavailable");
    expect(body).not.toContain(canary);
    expect(body).not.toContain("<Response>");
    expect(initializeSession).toHaveBeenCalledTimes(1);
  });

  it("snapshots trusted configuration and dependency functions before the verifier await", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });
    const twilio: TwilioRequestVerifier = {
      async verifyWebhook(input) { await gate; return real.verifyWebhook(input); },
      verifyWebSocket: real.verifyWebSocket.bind(real),
    };
    const firstSessions = { getOrCreateInboundSession: vi.fn(async () => storedSession()) };
    const secondSessions = { getOrCreateInboundSession: vi.fn(async () => { throw new Error("mutated_dependency"); }) };
    const firstInitialize = vi.fn(async () => undefined);
    const secondInitialize = vi.fn(async () => undefined);
    const mutable = dependencies({ twilio, sessions: firstSessions, initializeSession: firstInitialize }).deps;
    const pending = handleInboundVoiceWebhook(await signedRequest(validPairs()), mutable);
    mutable.sessions = secondSessions;
    mutable.initializeSession = secondInitialize;
    mutable.expectedInboundE164 = "+14165559999";
    mutable.currentChallengeHmacKeyVersion = "mutated";
    release?.();
    expect((await pending).status).toBe(200);
    expect(firstSessions.getOrCreateInboundSession).toHaveBeenCalledTimes(1);
    expect(secondSessions.getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(firstInitialize).toHaveBeenCalledTimes(1);
    expect(secondInitialize).not.toHaveBeenCalled();
  });

  it("rejects top-level dependency accessors without invoking them", async () => {
    const request = await signedRequest(validPairs());
    const base = dependencies();
    const getter = vi.fn(() => EXPECTED_TO);
    Object.defineProperty(base.deps, "expectedInboundE164", { enumerable: true, get: getter });
    const response = await handleInboundVoiceWebhook(request, base.deps);
    expect(response.status).toBe(503);
    expect(getter).not.toHaveBeenCalled();
    expect(base.getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(base.initializeSession).not.toHaveBeenCalled();
  });

  it("rejects nested dependency method accessors without invoking them", async () => {
    const request = await signedRequest(validPairs());
    const methodGetter = vi.fn(() => async () => null);
    const twilio = {} as TwilioRequestVerifier;
    Object.defineProperty(twilio, "verifyWebhook", { enumerable: true, get: methodGetter });
    Object.defineProperty(twilio, "verifyWebSocket", { enumerable: true, value: async () => false });
    const base = dependencies({ twilio });
    const response = await handleInboundVoiceWebhook(request, base.deps);
    expect(response.status).toBe(503);
    expect(methodGetter).not.toHaveBeenCalled();
    expect(base.getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(base.initializeSession).not.toHaveBeenCalled();
  });

  it("neutralizes a non-string called-number configuration before verification", async () => {
    const request = await signedRequest(validPairs());
    const base = dependencies();
    Object.defineProperty(base.deps, "expectedInboundE164", { enumerable: true, value: Symbol("invalid") });
    const response = await handleInboundVoiceWebhook(request, base.deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(base.getOrCreateInboundSession).not.toHaveBeenCalled();
    expect(base.initializeSession).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });
});

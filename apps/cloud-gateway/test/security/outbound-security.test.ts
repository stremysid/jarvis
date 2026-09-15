import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayBinding, Ulid } from "../../../../packages/contracts/src/index.js";
import { CallRepository } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import type { TwilioRequestVerifier } from "../../src/providers/provider-types.js";
import { TwilioSignatureVerifier } from "../../src/providers/twilio-verifier.js";
import {
  OUTBOUND_VOICEMAIL_MESSAGE,
  claimOutboundTwiML,
  type OutboundTwiMLDependencies,
} from "../../src/voice/outbound.js";
import {
  applyFoundationMigration,
  clearCallSessionsForTest,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";

const AUTH_TOKEN = "synthetic-auth-token";
const PUBLIC_ORIGIN = new URL("https://jarvis.example/");
const NOW = new Date("2026-08-30T12:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-08-30T12:06:00.000Z");
const COMMAND_ID = "01k3wceg000000000000000010" as Ulid;
const ATTEMPT_ID = "01k3wceg000000000000000011" as Ulid;
const CALL_SID_1 = `CA${"1".repeat(32)}`;
const CALL_SID_2 = `CA${"2".repeat(32)}`;
const DESTINATION = "+14165550123";
const NONCE = `${"A".repeat(42)}A`;
type Pair = readonly [string, string];

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearCallSessionsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
  ]);
}

async function seedAttempt(repository: CallRepository): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', ?, 'active', ?, ?)").bind(DESTINATION, timestamp, timestamp),
    env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:voice', ?)").bind(timestamp),
    env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)").bind(COMMAND_ID, "a".repeat(64), timestamp),
  ]);
  await repository.getOrCreateExpectedCall({
    attemptId: ATTEMPT_ID,
    attemptOrdinal: 0,
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    destinationIdentityId: "identity:voice",
    idempotencyKey: "call:test",
    authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
    now: NOW,
  });
  const claim = await repository.claimProviderDispatch({ attemptId: ATTEMPT_ID, now: NOW });
  if (claim.kind !== "claimed") throw new Error("fixture_claim_missing");
}

function exactUrl(): string {
  return `https://jarvis.example/voice/outbound/${ATTEMPT_ID}`;
}

async function signPairs(pairs: readonly Pair[]): Promise<string> {
  const grouped = new Map<string, Set<string>>();
  for (const [name, value] of pairs) {
    const values = grouped.get(name) ?? new Set<string>();
    values.add(value);
    grouped.set(name, values);
  }
  const payload = exactUrl() + [...grouped]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([name, values]) => [...values]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((value) => `${name}${value}`))
    .join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pairs(callSid = CALL_SID_1): Pair[] {
  return [["CallSid", callSid], ["To", DESTINATION], ["From", "+14165550100"], ["relayNonce", `${"Z".repeat(42)}Y`]];
}

async function signedRequest(input = pairs(), signature?: string): Promise<Request> {
  const body = input.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  return new Request("https://internal.invalid/twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-twilio-signature": signature ?? await signPairs(input),
    },
    body,
  });
}

describe("outbound TwiML claim security boundary", () => {
  let repository: CallRepository;
  let observedAt: Date;
  let initializeSession: ReturnType<typeof vi.fn>;
  let resolveActiveVerifiedVoiceIdentityId: ReturnType<typeof vi.fn>;
  let dependencies: OutboundTwiMLDependencies;

  beforeEach(async () => {
    await applyFoundationMigration();
    await clearFixture();
    observedAt = NOW;
    repository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE);
    await seedAttempt(repository);
    initializeSession = vi.fn(async () => undefined);
    resolveActiveVerifiedVoiceIdentityId = vi.fn(async () => "identity:voice");
    dependencies = {
      twilio: new TwilioSignatureVerifier({ authToken: AUTH_TOKEN }),
      publicOrigin: PUBLIC_ORIGIN,
      ownerIdentityId: "identity:voice",
      recipients: { resolveActiveVerifiedVoiceIdentityId },
      calls: repository,
      ownerStepUp: { bind: vi.fn(async (input) => input) },
      initializeSession,
      now: () => observedAt,
    };
  });

  afterEach(clearFixture);

  it("consumes the original signed Request once and replays the same stored nonce, session, and TwiML after expiry", async () => {
    const original = await signedRequest();
    const realVerifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });
    let verificationIndex = 0;
    const verifyWebhook = vi.fn(async (input: Parameters<TwilioRequestVerifier["verifyWebhook"]>[0]) => {
      if (verificationIndex === 0) expect(input.request).toBe(original);
      verificationIndex += 1;
      expect(input.request.bodyUsed).toBe(false);
      return realVerifier.verifyWebhook(input);
    });
    dependencies.twilio = { verifyWebhook, verifyWebSocket: realVerifier.verifyWebSocket.bind(realVerifier) };

    const first = await claimOutboundTwiML(original, ATTEMPT_ID, dependencies);
    observedAt = AFTER_EXPIRY;
    const retry = await claimOutboundTwiML(await signedRequest(), ATTEMPT_ID, dependencies);

    expect(verifyWebhook).toHaveBeenCalledTimes(2);
    expect(first.status).toBe(200);
    expect(await retry.text()).toBe(await first.clone().text());
    expect(await first.text()).toContain(`name="relayNonce" value="${NONCE}"`);
    expect(initializeSession).toHaveBeenCalledTimes(2);
    expect(initializeSession).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: ATTEMPT_ID,
      relaySetupExpiresAt: null,
      preAuthentication: Object.freeze({ voicemailMessage: OUTBOUND_VOICEMAIL_MESSAGE }),
    }));
  });

  it("rejects a different signed CallSid without creating or initializing another session", async () => {
    expect((await claimOutboundTwiML(await signedRequest(), ATTEMPT_ID, dependencies)).status).toBe(200);
    const response = await claimOutboundTwiML(await signedRequest(pairs(CALL_SID_2)), ATTEMPT_ID, dependencies);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM call_sessions").first<{ count: number }>();

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(count?.count).toBe(1);
    expect(initializeSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["duplicate CallSid", [...pairs(), ["CallSid", CALL_SID_1] as const]],
    ["duplicate To", [...pairs(), ["To", DESTINATION] as const]],
    ["malformed CallSid", pairs(`CA${"g".repeat(32)}`)],
    ["malformed To", [["CallSid", CALL_SID_1], ["To", "14165550123"]] as Pair[]],
  ])("rejects %s before identity resolution or durable claim", async (_label, fields) => {
    const response = await claimOutboundTwiML(await signedRequest(fields), ATTEMPT_ID, dependencies);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveActiveVerifiedVoiceIdentityId).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before identity lookup or persistence", async () => {
    const response = await claimOutboundTwiML(await signedRequest(pairs(), "AAAAAAAAAAAAAAAAAAAAAAAAAAA="), ATTEMPT_ID, dependencies);
    expect(response.status).toBe(403);
    expect(resolveActiveVerifiedVoiceIdentityId).not.toHaveBeenCalled();
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("binds only the provider-observed active identity and rejects a changed identity", async () => {
    resolveActiveVerifiedVoiceIdentityId.mockResolvedValueOnce("identity:other");
    const response = await claimOutboundTwiML(await signedRequest(), ATTEMPT_ID, dependencies);
    expect(response.status).toBe(403);
    expect(resolveActiveVerifiedVoiceIdentityId).toHaveBeenCalledWith(DESTINATION);
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("fails closed when the stored recipient becomes inactive before session creation", async () => {
    await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:voice'").run();
    const response = await claimOutboundTwiML(await signedRequest(), ATTEMPT_ID, dependencies);
    expect(response.status).toBe(403);
    expect(initializeSession).not.toHaveBeenCalled();
  });

  it("emits only fixed trusted relay routes and the Task 6 neutral pre-auth prerequisite", async () => {
    const response = await claimOutboundTwiML(await signedRequest(), ATTEMPT_ID, dependencies);
    const body = await response.text();
    const initialization = initializeSession.mock.calls[0]?.[0] as { binding: RelayBinding; preAuthentication: { voicemailMessage: string } };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/xml; charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain(`url="wss://jarvis.example/voice/relay/${ATTEMPT_ID}"`);
    expect(body).toContain("action=\"https://jarvis.example/voice/relay-ended#rc=2&amp;rp=ct,rt,5xx\"");
    expect(body).not.toContain("user_requested");
    expect(body).not.toContain("principal:owner");
    expect(body).not.toContain(DESTINATION);
    expect(initialization.preAuthentication.voicemailMessage).toBe("Jarvis called for Sid. No private message was left.");
    expect(initialization.binding.destinationIdentityId).toBe("identity:voice");
  });
});

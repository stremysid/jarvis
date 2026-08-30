import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import type { ConversationService, ModelToken } from "../../src/conversation/conversation-types.js";
import { DefaultModelAdapter } from "../../src/model/model-adapter.js";
import type { RelayEvent } from "../../src/providers/conversation-relay.js";
import { FakeModelProvider, type FakeModelProviderOptions } from "../../src/providers/fake-model-provider.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { IdentityChallengeService, VerifiedChannelObservationAuthority } from "../../src/sync/identity-challenge.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import {
  CallSession,
  CallSessionCore,
  PhoneActivationChallengeConfirmer,
  type CallSessionInitialization,
  type CallSessionRuntimeFactory,
} from "../../src/voice/call-session-do.js";
import {
  AuthenticationAttemptBudget,
  PinAuthenticationService,
  decodePinVerifierRecord,
} from "../../src/voice/inbound-auth.js";
import {
  canonicalize,
  newUlid,
  sha256Hex,
  type RelayBinding,
  type SignedRequestV1,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  OUTBOUND_VOICEMAIL_MESSAGE,
  type OutboundSessionInitialization,
} from "../../src/voice/outbound.js";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearConversationDataForTest,
  clearOutboundCallAttemptsForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const SESSION_ID = "01k3wceg000000000000000101" as Ulid;
const CALL_SID = `CA${"4".repeat(32)}`;
const PROVIDER_SESSION_ID = `VX${"5".repeat(32)}`;
const ACCOUNT_SID = `AC${"6".repeat(32)}`;
const RELAY_NONCE = `${"D".repeat(42)}M`;
const PEPPER = new Uint8Array(32).fill(7);
const PIN_RECORD_JSON = JSON.stringify({
  schemaVersion: "1.0",
  algorithm: "pbkdf2-hmac-sha256",
  iterations: 600_000,
  saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
  digestBase64: "SEQMsb6DRNNigkTZFNlCnQLLXSwB1jfsvHCYVO4ib2w=",
});
const DEVICE_AUDIENCE = "jarvis-local-agent";
const CHALLENGE_PATH = "/identity/challenge/begin";
const CHALLENGE_ID = "challenge:phone";
const CHALLENGE_RESPONSE = "482913";
const OTHER_SESSION_ID = "01k3wceg000000000000000102" as Ulid;
const TURN_ID = "01k3wceg000000000000000103" as Ulid;
const NEXT_TURN_ID = "01k3wceg000000000000000104" as Ulid;
const OUTBOUND_CALL_SID = `CA${"7".repeat(32)}`;
const OUTBOUND_RELAY_NONCE = `${"E".repeat(42)}Q`;

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearCallSessionsForTest();
  await clearAuthenticationAttemptReservationsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearConversationDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM request_nonces"),
    env.DB.prepare("DELETE FROM identity_challenges"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM device_keys"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
  ]);
}

async function seedActiveVoiceIdentity(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, pin_verifier_version,
      pin_verifier_secret_ref, created_at, updated_at
    ) VALUES ('principal:owner', 'human', 'active', 'Owner', '1.0',
      'PIN_VERIFIER_JSON', ?, ?)`)
      .bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO device_keys (
      device_id, principal_id, key_id, public_key_base64, key_fingerprint,
      key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at
    ) VALUES ('device:owner', 'principal:owner', 'key:owner', ?, ?, 1,
      'ed25519', 'active', 'laptop', ?, ?)`)
      .bind("A".repeat(43) + "=", "a".repeat(64), "b".repeat(64), timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at,
      created_at, enrolled_by_device_id
    ) VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123',
      'active', ?, ?, 'device:owner')`)
      .bind(timestamp, timestamp),
  ]);
}

async function seedPendingVoiceIdentity(): Promise<{
  readonly privateKey: CryptoKey;
  readonly keyFingerprint: string;
}> {
  const timestamp = NOW.toISOString();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keyFingerprint = await sha256Hex(publicKey);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, pin_verifier_version,
      pin_verifier_secret_ref, created_at, updated_at
    ) VALUES ('principal:owner', 'human', 'active', 'Owner', '1.0',
      'PIN_VERIFIER_JSON', ?, ?)`)
      .bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO device_keys (
      device_id, principal_id, key_id, public_key_base64, key_fingerprint,
      key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at
    ) VALUES ('device:owner', 'principal:owner', 'key:owner', ?, ?, 1,
      'ed25519', 'active', 'laptop', ?, ?)`)
      .bind(base64(publicKey), keyFingerprint, "b".repeat(64), timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at,
      created_at, enrolled_by_device_id
    ) VALUES ('identity:voice', 'principal:owner', 'voice', '+14165550123',
      'pending', NULL, ?, 'device:owner')`)
      .bind(timestamp),
  ]);
  return { privateKey: pair.privateKey, keyFingerprint };
}

function repository(): CallRepository {
  return new CallRepository(
    env.DB,
    new EventRepository(env.DB),
    () => RELAY_NONCE,
    300_000,
    () => SESSION_ID,
  );
}

async function createInboundSession(
  repo: CallRepository,
  currentChallengeHmacKeyVersion = "hmac-v1",
): Promise<StoredCallSession> {
  return repo.getOrCreateInboundSession({
    callSid: CALL_SID,
    callerE164: "+14165550123",
    currentChallengeHmacKeyVersion,
    now: NOW,
  });
}

function relaySetup(session: StoredCallSession): Extract<RelayEvent, { type: "setup" }> {
  return {
    type: "setup",
    sessionId: PROVIDER_SESSION_ID,
    accountSid: ACCOUNT_SID,
    callSid: session.callSid,
    direction: session.direction,
    relayNonce: session.binding.relayNonce,
  };
}

function makeCore(input: {
  session: StoredCallSession;
  repo: CallRepository;
  budgets?: AuthenticationAttemptBudget;
  authentication?: PinAuthenticationService;
  activation?: PhoneActivationChallengeConfirmer | null;
  conversation?: ConversationService | null;
  turnIds?: readonly Ulid[];
}) {
  const close = vi.fn<(code: number) => void>();
  const sendNeutralText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  const sendToken = vi.fn<(token: ModelToken) => Promise<void>>(async () => undefined);
  const finish = vi.fn<(finalText: string) => Promise<void>>(async () => undefined);
  const cancelOutput = vi.fn<() => Promise<void>>(async () => undefined);
  const budgets = input.budgets ?? new AuthenticationAttemptBudget(env.DB, PEPPER);
  const authentication = input.authentication
    ?? new PinAuthenticationService(budgets, decodePinVerifierRecord(PIN_RECORD_JSON));
  const turnIds = [...(input.turnIds ?? [TURN_ID])];
  return {
    close,
    sendNeutralText,
    sendToken,
    finish,
    cancelOutput,
    budgets,
    authentication,
    instance: new CallSessionCore({
      session: input.session,
      expectedAccountSid: ACCOUNT_SID,
      repository: input.repo,
      authentication,
      activation: input.activation ?? null,
      conversation: input.conversation ?? null,
      relay: { close, sendNeutralText, sendToken, finish, cancelOutput },
      newTurnId: () => {
        const turnId = turnIds.shift();
        if (turnId === undefined) throw new Error("fixture_turn_id_exhausted");
        return turnId;
      },
      now: () => new Date(NOW),
    }),
  };
}

function conversationHarness(
  stored: StoredCallSession,
  repo: CallRepository,
  modelOptions: FakeModelProviderOptions,
  turnIds: readonly Ulid[] = [TURN_ID],
) {
  const provider = new FakeModelProvider(modelOptions);
  const service = new DefaultConversationService({
    repository: new ConversationRepository(env.DB, new EventRepository(env.DB)),
    model: new DefaultModelAdapter(provider),
    context: new D1ContextRetriever(env.DB),
    dispatcher: {
      async dispatch(): Promise<never> { throw new Error("unexpected_voice_outbox_dispatch"); },
    },
    redactor: new Redactor(),
    now: () => new Date(NOW),
  });
  return { stored, provider, ...makeCore({ session: stored, repo, conversation: service, turnIds }) };
}

async function beginPhoneChallenge(): Promise<{
  readonly observations: VerifiedChannelObservationAuthority;
  readonly challenges: IdentityChallengeService;
  readonly keyFingerprint: string;
}> {
  const { privateKey, keyFingerprint } = await seedPendingVoiceIdentity();
  const observations = new VerifiedChannelObservationAuthority();
  const challenges = new IdentityChallengeService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: DEVICE_AUDIENCE }),
    observations,
    hmacPepper: new Uint8Array(32).fill(11),
    hmacKeyVersion: "identity-hmac-v1",
    now: () => new Date(NOW),
    challengeId: () => CHALLENGE_ID,
    response: () => CHALLENGE_RESPONSE,
  });
  const body = { schemaVersion: "1.0" as const, channel: "phone" as const, identityId: "identity:voice" };
  const rawBody = canonicalize(body);
  const unsigned = {
    schemaVersion: "1.0" as const,
    deviceId: "device:owner",
    principalId: "principal:owner",
    audience: DEVICE_AUDIENCE,
    issuedAt: NOW.toISOString(),
    nonce: base64Url(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    bodyHash: await sha256Hex(rawBody),
  };
  const signingInput = new TextEncoder().encode([
    "POST",
    CHALLENGE_PATH,
    unsigned.deviceId,
    unsigned.principalId,
    unsigned.audience,
    unsigned.issuedAt,
    unsigned.nonce,
    unsigned.bodyHash,
  ].join("\n"));
  const request: SignedRequestV1 = {
    ...unsigned,
    signatureBase64: base64(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, signingInput))),
  };
  await challenges.begin(request, body, rawBody);
  return { observations, challenges, keyFingerprint };
}

async function activationHarness(options: { readonly challengeLimit?: number } = {}) {
  await clearFixture();
  const { observations, challenges, keyFingerprint } = await beginPhoneChallenge();
  const repo = repository();
  const stored = await createInboundSession(repo, "identity-hmac-v1");
  const budgets = new AuthenticationAttemptBudget(
    env.DB,
    PEPPER,
    options.challengeLimit === undefined ? undefined : { challengeLimit: options.challengeLimit },
  );
  const authentication = new PinAuthenticationService(budgets, decodePinVerifierRecord(PIN_RECORD_JSON));
  const activation = new PhoneActivationChallengeConfirmer({
    database: env.DB,
    authentication,
    budgets,
    observations,
    challenges,
  });
  return {
    stored,
    activation,
    keyFingerprint,
    ...makeCore({ session: stored, repo, budgets, authentication, activation }),
  };
}

async function sendDigits(session: CallSessionCore, digits: string): Promise<void> {
  for (const digit of digits) {
    await session.handleRelayEvent({ type: "dtmf", digit });
  }
}

async function reservationCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM authentication_attempt_reservations")
    .first<{ count: number }>();
  return row?.count ?? -1;
}

async function storedPhase(sessionId: Ulid): Promise<string> {
  const row = await env.DB.prepare("SELECT phase FROM call_sessions WHERE session_id = ?")
    .bind(sessionId).first<{ phase: string }>();
  return row?.phase ?? "missing";
}

async function identityState(): Promise<{ readonly status: string; readonly verified_at: string | null }> {
  const row = await env.DB.prepare(
    "SELECT status, verified_at FROM channel_identities WHERE identity_id = 'identity:voice'",
  ).first<{ status: string; verified_at: string | null }>();
  if (row === null) throw new Error("fixture_identity_missing");
  return row;
}

async function challengeConsumedAt(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT consumed_at FROM identity_challenges WHERE challenge_id = ?")
    .bind(CHALLENGE_ID).first<{ consumed_at: string | null }>();
  if (row === null) throw new Error("fixture_challenge_missing");
  return row.consumed_at;
}

async function reservationKinds(): Promise<readonly string[]> {
  const rows = await env.DB.prepare(
    "SELECT attempt_kind FROM authentication_attempt_reservations ORDER BY rowid",
  ).all<{ attempt_kind: string }>();
  return rows.results.map((row) => row.attempt_kind);
}

async function conversationTurn(turnId: Ulid): Promise<{
  readonly state: string;
  readonly sent_assistant_event_id: string | null;
  readonly delivered_assistant_event_id: string | null;
} | null> {
  return env.DB.prepare(`SELECT state, sent_assistant_event_id, delivered_assistant_event_id
    FROM conversation_turns WHERE turn_id = ?`)
    .bind(turnId)
    .first();
}

async function authenticateForConversation(harness: ReturnType<typeof conversationHarness>): Promise<void> {
  await harness.instance.handleRelayEvent(relaySetup(harness.stored));
  await sendDigits(harness.instance, "12345678");
  expect(harness.instance.phase).toBe("active");
}

type CallSessionRpc = Pick<CallSession, "initialize">;

function callSessionStub(sessionId: Ulid) {
  return env.CALL_SESSION.getByName(sessionId) as DurableObjectStub<CallSession> & CallSessionRpc;
}

function initializeInsideObject(
  stub: ReturnType<typeof callSessionStub>,
  input: CallSessionInitialization,
): Promise<void> {
  return runInDurableObject(stub, async (instance) => instance.initialize(input));
}

function outboundInitialization(sessionId: Ulid = newUlid()): OutboundSessionInitialization {
  const binding: RelayBinding = Object.freeze({
    callSid: OUTBOUND_CALL_SID,
    principalId: "principal:owner",
    identityId: "identity:voice",
    destinationIdentityId: "identity:voice",
    relayNonce: OUTBOUND_RELAY_NONCE,
    direction: "outbound",
    activationOnly: false,
    activationChallengeId: null,
  });
  return Object.freeze({
    sessionId,
    binding,
    relaySetupExpiresAt: null,
    preAuthentication: Object.freeze({ voicemailMessage: OUTBOUND_VOICEMAIL_MESSAGE }),
  });
}

function fakeSocket(sessionId: Ulid) {
  const close = vi.fn<(code?: number, reason?: string) => void>();
  const send = vi.fn<(message: string | ArrayBuffer | ArrayBufferView) => void>();
  const socket = {
    close,
    send,
    deserializeAttachment: () => ({ sessionId }),
  } as unknown as WebSocket;
  return { socket, close, send };
}

describe("CallSessionCore PIN authentication", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearFixture();
    await seedActiveVoiceIdentity();
  });

  afterEach(clearFixture);

  it("rejects a structural PIN-authentication lookalike before relay processing", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const relay = {
      close: vi.fn<(code: number) => void>(),
      sendNeutralText: vi.fn<(text: string) => Promise<void>>(async () => undefined),
      sendToken: vi.fn<(token: ModelToken) => Promise<void>>(async () => undefined),
      finish: vi.fn<(text: string) => Promise<void>>(async () => undefined),
      cancelOutput: vi.fn<() => Promise<void>>(async () => undefined),
    };

    expect(() => new CallSessionCore({
      session: stored,
      expectedAccountSid: ACCOUNT_SID,
      repository: repo,
      authentication: {
        authenticate: vi.fn(async () => Object.freeze({ authenticated: true })),
        snapshotProof: vi.fn((proof) => proof),
      } as never,
      activation: null,
      conversation: null,
      relay,
      now: () => new Date(NOW),
    })).toThrow("call_session_configuration_invalid");
  });

  it("rejects DTMF before setup without reserving authentication authority", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const { instance } = makeCore({ session: stored, repo });

    await expect(instance.handleRelayEvent({ type: "dtmf", digit: "1" })).rejects.toThrow("relay_setup_required");

    expect(await reservationCount()).toBe(0);
    expect(await storedPhase(stored.sessionId)).toBe("created");
  });

  it("does not authenticate or reserve budget for an incomplete PIN candidate", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const { instance } = makeCore({ session: stored, repo });
    await instance.handleRelayEvent(relaySetup(stored));

    await sendDigits(instance, "1234567");

    expect(instance.phase).toBe("pre_auth");
    expect(await reservationCount()).toBe(0);
  });

  it("clears an incomplete candidate on star before accepting a fresh exact PIN", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const { instance } = makeCore({ session: stored, repo });
    await instance.handleRelayEvent(relaySetup(stored));
    await sendDigits(instance, "1234567*");

    await sendDigits(instance, "12345678");

    expect(instance.phase).toBe("active");
    expect(await reservationCount()).toBe(1);
    expect(await storedPhase(stored.sessionId)).toBe("active");
  });

  it("uses the nominal Task 4 proof to enter active without persisting PIN digits", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const { instance } = makeCore({ session: stored, repo });
    await instance.handleRelayEvent(relaySetup(stored));

    await sendDigits(instance, "12345678");

    expect(instance.phase).toBe("active");
    const reservations = await env.DB.prepare("SELECT * FROM authentication_attempt_reservations").all<Record<string, unknown>>();
    const sessions = await env.DB.prepare("SELECT * FROM call_sessions").all<Record<string, unknown>>();
    expect(JSON.stringify([reservations.results, sessions.results])).not.toContain("12345678");
  });

  it("rejects only this call after three completed bad PIN candidates", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const { instance } = makeCore({ session: stored, repo });
    await instance.handleRelayEvent(relaySetup(stored));

    await sendDigits(instance, "876543218765432187654321");

    expect(instance.phase).toBe("rejected");
    expect(await reservationCount()).toBe(3);
    expect(await storedPhase(stored.sessionId)).toBe("rejected");
    const principal = await env.DB.prepare("SELECT status FROM principals WHERE principal_id = 'principal:owner'")
      .first<{ status: string }>();
    expect(principal?.status).toBe("active");
  });

  it("fails closed before a second PBKDF2 when the real Task 4 budget is exhausted", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const budgets = new AuthenticationAttemptBudget(env.DB, PEPPER, { callSidLimit: 1 });
    const { instance } = makeCore({ session: stored, repo, budgets });
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    await instance.handleRelayEvent(relaySetup(stored));
    await sendDigits(instance, "87654321");

    await sendDigits(instance, "12345678");

    expect(instance.phase).toBe("rejected");
    expect(await reservationCount()).toBe(1);
    expect(deriveBits).toHaveBeenCalledTimes(1);
  });

  it("activates a pending phone only after PIN plus one separately budgeted challenge response", async () => {
    const harness = await activationHarness();
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    await sendDigits(harness.instance, "12345678");
    expect(harness.instance.phase).toBe("authenticated");
    expect(await reservationKinds()).toEqual(["pin"]);
    await sendDigits(harness.instance, CHALLENGE_RESPONSE.slice(0, -1));
    expect(await reservationKinds()).toEqual(["pin"]);

    await sendDigits(harness.instance, CHALLENGE_RESPONSE.at(-1) ?? "");

    expect(harness.instance.phase).toBe("completed");
    expect(await storedPhase(harness.stored.sessionId)).toBe("completed");
    expect(await reservationKinds()).toEqual(["pin", "activation"]);
    expect(await identityState()).toEqual({ status: "active", verified_at: NOW.toISOString() });
    expect(await challengeConsumedAt()).toBe(NOW.toISOString());
    expect(harness.sendNeutralText.mock.calls.map(([text]) => text)).toEqual([
      "Enter the one-time phone enrollment challenge shown in your local Jarvis CLI.",
      "Phone verification complete. Please call again to use Jarvis.",
    ]);
    const durable = await env.DB.batch([
      env.DB.prepare("SELECT * FROM authentication_attempt_reservations"),
      env.DB.prepare("SELECT * FROM call_sessions"),
      env.DB.prepare("SELECT * FROM identity_challenges"),
    ]);
    expect(JSON.stringify(durable.flatMap((result) => result.results ?? []))).not.toMatch(/12345678|482913/u);
  });

  it("fails one wrong activation response once and never retries it inside the call", async () => {
    const harness = await activationHarness();
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    await sendDigits(harness.instance, "12345678");

    await sendDigits(harness.instance, "000000");

    expect(harness.instance.phase).toBe("failed");
    expect(await identityState()).toEqual({ status: "pending", verified_at: null });
    expect(await challengeConsumedAt()).toBeNull();
    expect(await reservationKinds()).toEqual(["pin", "activation"]);
    await sendDigits(harness.instance, CHALLENGE_RESPONSE);
    expect(await reservationKinds()).toEqual(["pin", "activation"]);
    expect(harness.sendNeutralText.mock.calls.map(([text]) => text)).toEqual([
      "Enter the one-time phone enrollment challenge shown in your local Jarvis CLI.",
      "Phone verification could not be completed.",
    ]);
  });

  it("fails before challenge confirmation when the real activation budget is exhausted", async () => {
    const harness = await activationHarness({ challengeLimit: 1 });
    expect(await harness.budgets.reserveActivationAttempt({ binding: harness.stored.binding, now: NOW })).toBe(true);
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    await sendDigits(harness.instance, "12345678");

    await sendDigits(harness.instance, CHALLENGE_RESPONSE);

    expect(harness.instance.phase).toBe("failed");
    expect(await identityState()).toEqual({ status: "pending", verified_at: null });
    expect(await challengeConsumedAt()).toBeNull();
    expect(await reservationKinds()).toEqual(["activation", "pin"]);
  });

  it("rejects forged and cross-session PIN proofs before activation authority is reserved", async () => {
    const harness = await activationHarness();
    const proof = await harness.authentication.authenticate({
      pinDigits: "12345678",
      sessionId: harness.stored.sessionId,
      binding: harness.stored.binding,
      now: NOW,
    });
    if (proof === null) throw new Error("fixture_pin_proof_missing");

    await expect(harness.activation.confirm({
      sessionId: OTHER_SESSION_ID,
      binding: harness.stored.binding,
      pinProof: proof,
      response: CHALLENGE_RESPONSE,
      now: NOW,
    })).rejects.toThrow("pin_authentication_proof_invalid");
    await expect(harness.activation.confirm({
      sessionId: harness.stored.sessionId,
      binding: harness.stored.binding,
      pinProof: Object.freeze({ proofId: proof.proofId, authenticated: true }),
      response: CHALLENGE_RESPONSE,
      now: NOW,
    })).rejects.toThrow("pin_authentication_proof_invalid");

    expect(await reservationKinds()).toEqual(["pin"]);
    expect(await identityState()).toEqual({ status: "pending", verified_at: null });
  });

  it("ignores partial prompts without allocating a turn or reaching the model", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const harness = conversationHarness(stored, repo, { streamText: "unused", streamTokenCount: 1 });
    await authenticateForConversation(harness);

    await harness.instance.handleRelayEvent({
      type: "prompt",
      text: "What is",
      language: "en-US",
      final: false,
    });

    expect(harness.provider.requests).toEqual([]);
    expect(await conversationTurn(TURN_ID)).toBeNull();
  });

  it("streams only Task 5 sanitized tokens through its flat nominal voice delivery", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const harness = conversationHarness(stored, repo, {
      streamText: "safe PIN: 12345678 answer",
      streamTokenCount: 3,
    });
    await authenticateForConversation(harness);

    await harness.instance.handleRelayEvent({
      type: "prompt",
      text: "What is next?",
      language: "en-US",
      final: true,
    });

    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.provider.requests[0]).toMatchObject({
      operation: "streamText",
      principalId: "principal:owner",
      channel: "voice",
      userText: "What is next?",
    });
    const sentText = harness.sendToken.mock.calls.map(([token]) => token.text).join("");
    const finishedText = harness.finish.mock.calls[0]?.[0];
    expect(sentText).toBe(finishedText);
    expect(sentText.length).toBeGreaterThan(0);
    expect(JSON.stringify([sentText, finishedText])).not.toContain("12345678");
    expect(await conversationTurn(TURN_ID)).toMatchObject({
      state: "voice_sent",
      sent_assistant_event_id: expect.stringMatching(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/u),
      delivered_assistant_event_id: null,
    });
  });

  it("rejects an unsupported language or oversized final prompt before turn admission", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const harness = conversationHarness(
      stored,
      repo,
      { streamText: "unused", streamTokenCount: 1 },
      [TURN_ID, NEXT_TURN_ID],
    );
    await authenticateForConversation(harness);

    await expect(harness.instance.handleRelayEvent({
      type: "prompt",
      text: "bonjour",
      language: "fr-FR",
      final: true,
    })).rejects.toThrow("turn_language_unsupported");
    await expect(harness.instance.handleRelayEvent({
      type: "prompt",
      text: "x".repeat(8_001),
      language: "en-US",
      final: true,
    })).rejects.toThrow("turn_too_large");

    expect(harness.provider.requests).toEqual([]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns").first<{ count: number }>();
    expect(rows?.count).toBe(0);
  });

  it("aborts an in-progress Task 5 voice turn on provider interruption without assistant history", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const harness = conversationHarness(stored, repo, { manual: true });
    await authenticateForConversation(harness);
    const pending = harness.instance.handleRelayEvent({
      type: "prompt",
      text: "Please keep talking",
      language: "en-US",
      final: true,
    });
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(1));

    await harness.instance.handleRelayEvent({ type: "interrupt" });
    await pending;

    expect(await conversationTurn(TURN_ID)).toEqual({
      state: "cancelled",
      sent_assistant_event_id: null,
      delivered_assistant_event_id: null,
    });
    const assistant = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'conversation.assistant_sent'",
    ).first<{ count: number }>();
    expect(assistant?.count).toBe(0);
    expect(harness.finish).not.toHaveBeenCalled();
    expect(harness.instance.phase).toBe("active");
  });

  it("rejects a concurrent final prompt while one model turn owns the session", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const harness = conversationHarness(stored, repo, { manual: true }, [TURN_ID, NEXT_TURN_ID]);
    await authenticateForConversation(harness);
    const pending = harness.instance.handleRelayEvent({
      type: "prompt",
      text: "first turn",
      language: "en-US",
      final: true,
    });
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(1));

    await expect(harness.instance.handleRelayEvent({
      type: "prompt",
      text: "overlapping turn",
      language: "en-US",
      final: true,
    })).rejects.toThrow("turn_in_progress");

    expect(harness.provider.requests).toHaveLength(1);
    await harness.instance.handleRelayEvent({ type: "interrupt" });
    await pending;
  });

  it("cancels an in-progress Task 5 turn and completes the call on normal socket close", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const harness = conversationHarness(stored, repo, { manual: true });
    await authenticateForConversation(harness);
    const pending = harness.instance.handleRelayEvent({
      type: "prompt",
      text: "close during this turn",
      language: "en-US",
      final: true,
    });
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(harness.provider.requests).toHaveLength(1));

    await harness.instance.handleSocketClose();
    await pending;
    await expect(harness.instance.handleSocketClose()).resolves.toBeUndefined();

    expect(harness.instance.phase).toBe("completed");
    expect(await storedPhase(stored.sessionId)).toBe("completed");
    expect(await conversationTurn(TURN_ID)).toEqual({
      state: "cancelled",
      sent_assistant_event_id: null,
      delivered_assistant_event_id: null,
    });
  });

  it("never promotes an already sent voice turn to delivered history on a later interrupt", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const harness = conversationHarness(stored, repo, { streamText: "safe answer", streamTokenCount: 2 });
    await authenticateForConversation(harness);
    await harness.instance.handleRelayEvent({
      type: "prompt",
      text: "complete one turn",
      language: "en-US",
      final: true,
    });

    const before = await conversationTurn(TURN_ID);
    await harness.instance.handleRelayEvent({ type: "interrupt" });

    expect(before).toMatchObject({ state: "voice_sent", delivered_assistant_event_id: null });
    expect(await conversationTurn(TURN_ID)).toEqual(before);
  });
});

describe("CallSession Durable Object boundary", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearFixture();
    await seedActiveVoiceIdentity();
  });

  afterEach(clearFixture);

  it("accepts the exact Task 7 initializer idempotently and rejects immutable drift", async () => {
    const initialization = outboundInitialization();
    const stub = callSessionStub(initialization.sessionId);

    await expect(stub.initialize(initialization)).resolves.toBeUndefined();
    await expect(stub.initialize(initialization)).resolves.toBeUndefined();
    await expect(initializeInsideObject(stub, {
      ...initialization,
      binding: { ...initialization.binding, relayNonce: `${"F".repeat(42)}U` },
    })).rejects.toThrow("call_session_initialization_conflict");

    await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get<CallSessionInitialization>("call-session.initialization.v1");
      expect(stored).toEqual(initialization);
      expect(JSON.stringify(stored)).not.toMatch(/purpose|memory|private message:/iu);
    });
  });

  it("rejects a changed or structurally extended Task 7 pre-authentication contract", async () => {
    const initialization = outboundInitialization();
    const stub = callSessionStub(initialization.sessionId);

    await expect(initializeInsideObject(stub, {
      ...initialization,
      preAuthentication: { voicemailMessage: "Changed voicemail" },
    } as never)).rejects.toThrow("call_session_initialization_invalid");
    await expect(initializeInsideObject(stub, {
      ...initialization,
      preAuthentication: {
        voicemailMessage: OUTBOUND_VOICEMAIL_MESSAGE,
        purpose: "private purpose",
      },
    } as never)).rejects.toThrow("call_session_initialization_invalid");
  });

  it("binds initialization to the named per-session object", async () => {
    const initialization = outboundInitialization();
    const otherObject = callSessionStub(newUlid());

    await expect(initializeInsideObject(otherObject, initialization)).rejects.toThrow("call_session_object_mismatch");
    await runInDurableObject(otherObject, async (_instance, state) => {
      expect(await state.storage.list()).toEqual(new Map());
    });
  });

  it("retains immutable initialization across eviction and rejects drift after restart", async () => {
    const initialization = outboundInitialization();
    const stub = callSessionStub(initialization.sessionId);
    await stub.initialize(initialization);

    await evictDurableObject(stub);

    await expect(stub.initialize(initialization)).resolves.toBeUndefined();
    await expect(initializeInsideObject(stub, {
      ...initialization,
      binding: { ...initialization.binding, callSid: `CA${"8".repeat(32)}` },
    })).rejects.toThrow("call_session_initialization_conflict");
  });

  it("upgrades only an initialized session and rejects a second live socket", async () => {
    const initialization = outboundInitialization();
    const stub = callSessionStub(initialization.sessionId);
    await stub.initialize(initialization);

    const first = await stub.fetch("https://call-session.invalid/relay", {
      method: "GET",
      headers: { Upgrade: "websocket" },
    });
    expect(first.status).toBe(101);
    expect(first.webSocket).not.toBeNull();
    first.webSocket?.accept();

    const second = await stub.fetch("https://call-session.invalid/relay", {
      method: "GET",
      headers: { Upgrade: "websocket" },
    });
    expect(second.status).toBe(409);
    expect(second.headers.get("cache-control")).toBe("no-store");
    first.webSocket?.close(1000, "test complete");
  });

  it("survives object eviction before accepting the signed-upgrade handoff", async () => {
    const initialization = outboundInitialization();
    const stub = callSessionStub(initialization.sessionId);
    await stub.initialize(initialization);
    await evictDurableObject(stub);

    const response = await stub.fetch("https://call-session.invalid/relay", {
      method: "GET",
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test complete");
  });

  it.each([
    ["binary", new Uint8Array([1]).buffer, 1003],
    ["UTF-8 oversized", "é".repeat(32_769), 1009],
    ["invalid JSON", "{", 1007],
  ] as const)("closes a %s relay frame before runtime hydration", async (_label, frame, code) => {
    const initialization = outboundInitialization();
    const stub = callSessionStub(initialization.sessionId);
    await stub.initialize(initialization);
    const relay = fakeSocket(initialization.sessionId);

    await runInDurableObject(stub, async (instance) => {
      await instance.webSocketMessage(relay.socket, frame);
    });

    expect(relay.close).toHaveBeenCalledExactlyOnceWith(code, expect.any(String));
    expect(relay.send).not.toHaveBeenCalled();
  });

  it("parses a bounded valid frame then fails closed at the explicit Task 8 runtime seam", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const initialization: CallSessionInitialization = Object.freeze({
      sessionId: stored.sessionId,
      binding: stored.binding,
      relaySetupExpiresAt: stored.relaySetupExpiresAt,
    });
    const stub = callSessionStub(stored.sessionId);
    await stub.initialize(initialization);
    const relay = fakeSocket(stored.sessionId);
    const frame = JSON.stringify({
      type: "setup",
      sessionId: PROVIDER_SESSION_ID,
      accountSid: ACCOUNT_SID,
      callSid: stored.callSid,
      direction: "inbound",
      customParameters: { relayNonce: stored.binding.relayNonce },
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.webSocketMessage(relay.socket, frame);
    });

    expect(relay.close).toHaveBeenCalledExactlyOnceWith(1011, "relay runtime unavailable");
    expect(await storedPhase(stored.sessionId)).toBe("created");
  });

  it("preserves a core policy close without adding a second generic wrapper close", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const initialization: CallSessionInitialization = Object.freeze({
      sessionId: stored.sessionId,
      binding: stored.binding,
      relaySetupExpiresAt: stored.relaySetupExpiresAt,
    });
    const stub = callSessionStub(stored.sessionId);
    const relay = fakeSocket(stored.sessionId);
    const factory = vi.fn<CallSessionRuntimeFactory>((input) => {
      const budgets = new AuthenticationAttemptBudget(env.DB, PEPPER);
      return new CallSessionCore({
        session: input.session,
        expectedAccountSid: ACCOUNT_SID,
        repository: repo,
        authentication: new PinAuthenticationService(budgets, decodePinVerifierRecord(PIN_RECORD_JSON)),
        activation: null,
        conversation: null,
        relay: input.relay,
        now: () => new Date(NOW),
      });
    });
    const frame = JSON.stringify({
      type: "setup",
      sessionId: PROVIDER_SESSION_ID,
      accountSid: `AC${"9".repeat(32)}`,
      callSid: stored.callSid,
      direction: "inbound",
      customParameters: { relayNonce: stored.binding.relayNonce },
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const object = new CallSession(state, env, factory);
      await object.initialize(initialization);
      await object.webSocketMessage(relay.socket, frame);
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(relay.close).toHaveBeenCalledExactlyOnceWith(1008, "relay policy violation");
    expect(await storedPhase(stored.sessionId)).toBe("created");
  });
});

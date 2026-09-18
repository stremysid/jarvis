import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { CapacityGuard } from "../../src/archive/capacity-guard.js";
import { createFakeCallingSystem } from "../../../../tests/acceptance/fake/voice-call-system.js";
import { D1ContextRetriever } from "../../src/conversation/context-retriever.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import type { ConversationService, ModelToken } from "../../src/conversation/conversation-types.js";
import { createVoiceStreamDelivery } from "../../src/conversation/conversation-types.js";
import { DefaultModelAdapter } from "../../src/model/model-adapter.js";
import type { RelayEvent } from "../../src/providers/conversation-relay.js";
import { FakeModelProvider, type FakeModelProviderOptions } from "../../src/providers/fake-model-provider.js";
import { CallRepository, type StoredCallSession } from "../../src/persistence/call-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { VoiceAccessRepository } from "../../src/persistence/voice-access-repository.js";
import { OwnerPassphraseRepository } from "../../src/persistence/owner-passphrase-repository.js";
import { GuestPinVerifier } from "../../src/security/guest-pin-verifier.js";
import { OwnerCallPinVerifier } from "../../src/security/owner-call-pin-verifier.js";
import { OwnerPassphraseVerifier } from "../../src/security/owner-passphrase-verifier.js";
import { OwnerCallPinRepository } from "../../src/persistence/owner-call-pin-repository.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { Redactor } from "../../src/security/redaction.js";
import { IdentityChallengeService, VerifiedChannelObservationAuthority } from "../../src/sync/identity-challenge.js";
import { DeviceRequestVerifier } from "../../src/sync/signed-request.js";
import {
  CallSession,
  CallSessionCore,
  GuestCallAuthentication,
  PhoneActivationChallengeConfirmer,
  type CallSessionInitialization,
  type CallSessionRuntimeFactory,
  type OwnerStepUpAlarmPort,
} from "../../src/voice/call-session-do.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";
import { readVoiceRuntimeConfiguration } from "../../src/voice/production-runtime.js";
import {
  createTargetGuestAccessDocumentVerifier,
  OwnerAccessService,
  TargetGuestResourceScopeResolver,
} from "../../src/voice/owner-access-service.js";
import {
  AuthenticationAttemptBudget,
} from "../../src/voice/inbound-auth.js";
import {
  GuestPinProofIssuer,
  VoiceAccessAuthorityService,
} from "../../src/voice/voice-access-authority.js";
import {
  OwnerCallStepUpService,
} from "../../src/voice/owner-call-step-up.js";
import {
  OWNER_ACTION_EXPIRED,
  OWNER_ACTION_MAX_ATTEMPTS,
  OWNER_ACTION_PIN_PROMPT,
  OWNER_ACTION_REFUSED,
  OWNER_ACTION_REPROMPT_SPEECH,
  OWNER_ACTION_WINDOW_MS,
  OwnerSensitiveActionService,
} from "../../src/voice/owner-sensitive-action.js";
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
  applyOwnerCallStepUpMigration,
  applyOwnerSensitiveActionPinMigration,
  applyVoiceRuntimeMigration,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearConversationDataForTest,
  clearOutboundCallAttemptsForTest,
  clearOwnerSensitiveActionDataForTest,
  clearOwnerCallStepUpDataForTest,
  clearOwnerPassphraseDataForTest,
  clearVoiceAccessDataForTest,
} from "../persistence/migration.js";
import {
  OWNER_IDENTITY_ID as FIXTURE_OWNER_IDENTITY_ID,
  seedOwnerAuthority as seedFixtureOwnerAuthority,
  validCreateInput,
} from "../persistence/voice-access-fixture.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const SESSION_ID = "01k3wceg000000000000000101" as Ulid;
const CALL_SID = `CA${"4".repeat(32)}`;
const PROVIDER_SESSION_ID = `VX${"5".repeat(32)}`;
const ACCOUNT_SID = `AC${"6".repeat(32)}`;
const RELAY_NONCE = `${"D".repeat(42)}M`;
const PEPPER = new Uint8Array(32).fill(7);
const DEVICE_AUDIENCE = "jarvis-local-agent";
const CHALLENGE_PATH = "/identity/challenge/begin";
const CHALLENGE_ID = "challenge:phone";
const CHALLENGE_RESPONSE = "482913";
const OTHER_SESSION_ID = "01k3wceg000000000000000102" as Ulid;
const TURN_ID = "01k3wceg000000000000000103" as Ulid;
const NEXT_TURN_ID = "01k3wceg000000000000000104" as Ulid;
const OUTBOUND_CALL_SID = `CA${"7".repeat(32)}`;
const OUTBOUND_RELAY_NONCE = `${"E".repeat(42)}Q`;
const GUEST_GRANT_ID = "01k3wceg000000000000000105" as Ulid;
const GUEST_E164 = "+14165550111";
const OWNER_TEST_PHRASE = "ablaze abrasion abrasive";
const OWNER_TEST_PEPPER = new Uint8Array(32).fill(29);
const OWNER_TEST_PIN = "4271";

async function applyCallStepUpTestMigrations(): Promise<void> {
  await applyVoiceRuntimeMigration();
  await applyOwnerCallStepUpMigration();
  await applyOwnerSensitiveActionPinMigration();
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearOwnerSensitiveActionDataForTest();
  await clearOwnerCallStepUpDataForTest();
  await clearCallSessionsForTest();
  await clearAuthenticationAttemptReservationsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearConversationDataForTest();
  await clearOwnerPassphraseDataForTest();
  await clearVoiceAccessDataForTest();
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
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)`)
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
    env.DB.prepare(`INSERT INTO voice_owner_identity (
      singleton_id, principal_id, identity_id, created_at
    ) VALUES (1, 'principal:owner', 'identity:voice', ?)`)
      .bind(timestamp),
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
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)`)
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
    env.DB.prepare(`INSERT INTO voice_owner_identity (
      singleton_id, principal_id, identity_id, created_at
    ) VALUES (1, 'principal:owner', 'identity:voice', ?)`)
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
  requirePassphrase = false,
): Promise<StoredCallSession> {
  const stored = await repo.getOrCreateInboundSession({
    callSid: CALL_SID,
    callerE164: "+14165550123",
    ownerIdentityId: "identity:voice",
    currentChallengeHmacKeyVersion,
    now: NOW,
  });
  if (!stored.binding.activationOnly && !requirePassphrase) {
    const head = await env.DB.prepare("SELECT singleton_id FROM owner_passphrase_heads WHERE singleton_id = 1")
      .first<{ singleton_id: number }>();
    if (head === null) await seedActiveOwnerPassphrase();
  }
  await new OwnerCallStepUpService(
    env.DB,
    new OwnerPassphraseVerifier(OWNER_TEST_PEPPER, "v1"),
  ).bind({
    sessionId: stored.sessionId,
    callSid: stored.callSid,
    ownerPrincipalId: stored.binding.principalId,
    ownerIdentityId: stored.binding.identityId,
    direction: stored.direction,
    lifecycleGeneration: 1,
    requirement: stored.binding.activationOnly ? "not_applicable" : requirePassphrase ? "required" : "waived_passed_a",
    attestationClass: stored.binding.activationOnly ? "not_applicable" : requirePassphrase ? "absent" : "passed_a",
    policy: stored.binding.activationOnly ? "not_applicable" : requirePassphrase ? "passphrase_always" : "waive_on_passed_a",
    createdAt: NOW.toISOString(),
  });
  return stored;
}

async function seedActiveOwnerPassphrase(): Promise<void> {
  const verifier = new OwnerPassphraseVerifier(
    OWNER_TEST_PEPPER,
    "v1",
    () => new Uint8Array(16).fill(7),
  );
  const record = await verifier.create("identity:voice", 1, OWNER_TEST_PHRASE);
  await new OwnerPassphraseRepository(env.DB).rotate({
    verified: {
      deviceId: "device:owner", principalId: "principal:owner", audience: DEVICE_AUDIENCE,
      issuedAt: NOW.toISOString(), nonce: "test", bodyHash: "3".repeat(64), keyId: "key:owner",
      keyFingerprint: "a".repeat(64), keyGeneration: 1, body: {},
    },
    ownerPrincipalId: "principal:owner", ownerIdentityId: "identity:voice",
    expectedVerifierVersion: null, record,
    commitId: "01m2ccccccccccccccccccc099", committedAt: NOW.toISOString(),
  });
}

/** The four-digit call PIN the moved gate asks for, published through the same guards. */
async function seedActiveOwnerCallPin(): Promise<void> {
  const existing = await env.DB.prepare("SELECT pin_version FROM owner_call_pin_heads WHERE singleton_id = 1")
    .first<{ pin_version: number }>();
  if (existing !== null) return;
  const verifier = new OwnerCallPinVerifier(OWNER_TEST_PEPPER, () => new Uint8Array(16).fill(9));
  await new OwnerCallPinRepository(env.DB).rotate({
    verified: {
      deviceId: "device:owner", principalId: "principal:owner", audience: DEVICE_AUDIENCE,
      issuedAt: NOW.toISOString(), nonce: "test", bodyHash: "3".repeat(64), keyId: "key:owner",
      keyFingerprint: "a".repeat(64), keyGeneration: 1, body: {},
    },
    ownerPrincipalId: "principal:owner", ownerIdentityId: "identity:voice",
    expectedPinVersion: null,
    record: await verifier.create("identity:voice", 1, Uint8Array.from([52, 50, 55, 49])),
    commitId: "01m2ccccccccccccccccccc098", committedAt: NOW.toISOString(),
  });
}

function sensitiveActionService(now: () => Date = () => new Date(NOW)): OwnerSensitiveActionService {
  const repository = new AutonomyRepository(env.DB);
  return new OwnerSensitiveActionService({
    database: env.DB,
    tiers: repository,
    autonomy: new AutonomyService({ repository, now }),
    pinVerifier: new OwnerCallPinVerifier(OWNER_TEST_PEPPER),
    passphraseVerifier: new OwnerPassphraseVerifier(OWNER_TEST_PEPPER, "v1"),
    now,
  });
}

async function revokeOwnerVerifierForTest(): Promise<() => Promise<void>> {
  const guard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'owner_passphrase_verifiers_transition_guard'`)
    .first<{ sql: string }>();
  if (guard === null) throw new Error("owner_passphrase_verifier_guard_missing");
  await env.DB.prepare("DROP TRIGGER owner_passphrase_verifiers_transition_guard").run();
  await env.DB.prepare(`UPDATE owner_passphrase_verifiers
    SET status = 'revoked', status_changed_at = ? WHERE status = 'active'`)
    .bind("2026-08-30T12:00:01.000Z").run();
  return async () => {
    await env.DB.prepare(`UPDATE owner_passphrase_verifiers
      SET status = 'active', status_changed_at = created_at WHERE status = 'revoked'`).run();
    await env.DB.prepare(guard.sql).run();
  };
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

const healthyCapacity = { async assertAcceptingNewTurn(): Promise<void> {} };

function makeCore(input: {
  session: StoredCallSession;
  repo: CallRepository;
  authority?: VoiceAccessAuthorityService | null;
  guestAuthentication?: GuestCallAuthentication | null;
  activation?: PhoneActivationChallengeConfirmer | null;
  ownerAccess?: import("../../src/voice/owner-access-service.js").OwnerAccessService | null;
  conversation?: ConversationService | null;
  capacity?: Pick<CapacityGuard, "assertAcceptingNewTurn">;
  turnIds?: readonly Ulid[];
  now?: () => Date;
}) {
  const close = vi.fn<(code: number) => void>();
  const sendNeutralText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  const sendToken = vi.fn<(token: ModelToken) => Promise<void>>(async () => undefined);
  const finish = vi.fn<(finalText: string) => Promise<void>>(async () => undefined);
  const cancelOutput = vi.fn<() => Promise<void>>(async () => undefined);
  const authority = input.authority === undefined
    ? new VoiceAccessAuthorityService(
      new VoiceAccessRepository(env.DB),
      new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
    )
    : input.authority;
  const ownerStepUp = new OwnerCallStepUpService(
    env.DB,
    new OwnerPassphraseVerifier(OWNER_TEST_PEPPER, "v1"),
  );
  const turnIds = [...(input.turnIds ?? [TURN_ID])];
  const newTurnId = vi.fn(() => {
    const turnId = turnIds.shift();
    if (turnId === undefined) throw new Error("fixture_turn_id_exhausted");
    return turnId;
  });
  return {
    close,
    sendNeutralText,
    sendToken,
    finish,
    cancelOutput,
    authority,
    newTurnId,
    instance: new CallSessionCore({
      capacity: input.capacity ?? healthyCapacity,
      session: input.session,
      expectedAccountSid: ACCOUNT_SID,
      repository: input.repo,
      authority,
      guestAuthentication: input.guestAuthentication ?? null,
      activation: input.activation ?? null,
      ownerAccess: input.ownerAccess ?? null,
      ownerStepUp,
      ownerStepUpAlarm: { async arm() {}, async clear() {} },
      conversation: input.conversation ?? null,
      relay: { close, sendNeutralText, sendToken, finish, cancelOutput },
      newTurnId,
      now: input.now ?? (() => new Date(NOW)),
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

async function activationHarness(options: {
  readonly challengeLimit?: number;
  readonly conversation?: ConversationService;
} = {}) {
  await clearFixture();
  const { observations, challenges, keyFingerprint } = await beginPhoneChallenge();
  const repo = repository();
  const stored = await createInboundSession(repo, "identity-hmac-v1");
  const budgets = new AuthenticationAttemptBudget(
    env.DB,
    PEPPER,
    options.challengeLimit === undefined ? undefined : { challengeLimit: options.challengeLimit },
  );
  const activation = new PhoneActivationChallengeConfirmer({
    database: env.DB,
    budgets,
    observations,
    challenges,
  } as never);
  return {
    stored,
    activation,
    keyFingerprint,
    budgets,
    ...makeCore({ session: stored, repo, activation, conversation: options.conversation }),
  };
}

async function sendDigits(session: CallSessionCore, digits: string): Promise<void> {
  for (const digit of digits) {
    await session.handleRelayEvent({ type: "dtmf", digit });
  }
}

/**
 * Owner admission asks for nothing now, so walking to `active` is the whole
 * of it. The credential is answered separately, at the action.
 */
async function admitOwnerAdministration(
  harness: Awaited<ReturnType<typeof accessHarness>>,
): Promise<void> {
  await harness.instance.handleRelayEvent(relaySetup(harness.stored));
  expect(harness.instance.phase).toBe("active");
}

/** Answers the sensitive-action question the moved gate asks before an access change. */
async function authoriseOwnerAccess(
  harness: Awaited<ReturnType<typeof accessHarness>>,
): Promise<void> {
  await sendDigits(harness.instance, OWNER_TEST_PIN);
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
  expect(harness.instance.phase).toBe("active");
}

type CallSessionRpc = Pick<CallSession, "initialize"> & {
  terminate(input: {
    sessionId: Ulid;
    phase: "completed" | "failed";
    reason: "provider_callback";
  }): Promise<{
    sessionId: Ulid;
    terminalPhase: "completed" | "failed";
    invalidated: boolean;
    outcome: "applied" | "replayed" | "recovered";
  }>;
};

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
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
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

async function seedPendingGuestAccess(
  registry: CapabilityRegistry,
  verifier: GuestPinVerifier,
): Promise<void> {
  const timestamp = NOW.toISOString();
  const snapshot = await registry.snapshotConfigured(["conversation.basic"]);
  const pin = Uint8Array.from([52, 56, 50, 55]);
  const record = await verifier.create(GUEST_GRANT_ID, pin);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES ('principal:guest', 'human', 'active', 'Guest', ?, ?)`)
      .bind(timestamp, timestamp),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id
    ) VALUES ('identity:guest', 'principal:guest', 'voice', ?, 'pending', NULL, ?, NULL)`)
      .bind(GUEST_E164, timestamp),
    env.DB.prepare(`INSERT INTO voice_access_grants (
      grant_id, principal_id, identity_id, grant_version, capability_ids_json, resource_scopes_json,
      access_document_hash, pin_schema_version, pin_algorithm, pin_pepper_version, pin_iterations,
      pin_salt_base64, pin_digest_base64, status, created_by_identity_id, created_at,
      activated_at, updated_at, revoked_at
    ) VALUES (?, 'principal:guest', 'identity:guest', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
      'identity:voice', ?, NULL, ?, NULL)`)
      .bind(
        GUEST_GRANT_ID,
        JSON.stringify(snapshot.capabilityIds),
        JSON.stringify(snapshot.resourceScopes),
        snapshot.accessDocumentHash,
        record.schemaVersion,
        record.algorithm,
        record.pepperVersion,
        record.iterations,
        record.saltBase64,
        record.digestBase64,
        timestamp,
        timestamp,
      ),
    env.DB.prepare(`INSERT INTO voice_access_grant_events (
      event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
      capability_ids_json, access_document_hash, created_at
    ) VALUES ('01k3wceg000000000000000790', ?, 1, 'created', 'identity:voice', ?, ?, ?, ?)`)
      .bind(
        GUEST_GRANT_ID,
        "e".repeat(64),
        JSON.stringify(snapshot.capabilityIds),
        snapshot.accessDocumentHash,
        timestamp,
      ),
  ]);
}

async function accessHarness(
  kind: "owner" | "guest",
  callSidLimit?: number,
  withOwnerAdministration = false,
  capacity = healthyCapacity,
  withCleanEnd = false,
) {
  await clearFixture();
  await seedActiveVoiceIdentity();
  const repo = repository();
  const registry = new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] });
  const voiceRepository = new VoiceAccessRepository(env.DB);
  const pinVerifier = new GuestPinVerifier(
    new Uint8Array(32).fill(12),
    () => new Uint8Array(16).fill(8),
  );
  if (kind === "guest") await seedPendingGuestAccess(registry, pinVerifier);
  const stored = kind === "owner"
    ? await createInboundSession(repo, "hmac-v1", withOwnerAdministration)
    : await repo.getOrCreateInboundSession({
      callSid: CALL_SID,
      callerE164: GUEST_E164,
      ownerIdentityId: "identity:voice",
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: NOW,
    });
  const proofs = new GuestPinProofIssuer();
  const authority = new VoiceAccessAuthorityService(voiceRepository, registry, proofs);
  const ownerStepUp = new OwnerCallStepUpService(
    env.DB,
    new OwnerPassphraseVerifier(OWNER_TEST_PEPPER, "v1"),
  );
  if (kind === "owner" && withOwnerAdministration) {
    await seedActiveOwnerPassphrase();
    await seedActiveOwnerCallPin();
  }
  if (kind === "owner") {
    await ownerStepUp.bind({
      sessionId: stored.sessionId,
      callSid: stored.callSid,
      ownerPrincipalId: stored.binding.principalId,
      ownerIdentityId: stored.binding.identityId,
      direction: stored.direction,
      lifecycleGeneration: 1,
      requirement: withOwnerAdministration ? "required" : "waived_passed_a",
      attestationClass: withOwnerAdministration ? "absent" : "passed_a",
      policy: withOwnerAdministration ? "passphrase_always" : "waive_on_passed_a",
      createdAt: NOW.toISOString(),
    });
  }
  const budgets = new AuthenticationAttemptBudget(
    env.DB,
    PEPPER,
    callSidLimit === undefined ? undefined : { callSidLimit },
  );
  const guestAuthentication = new GuestCallAuthentication({
    repository: voiceRepository,
    budgets,
    verifier: pinVerifier,
    proofs,
  });
  const authenticate = vi.spyOn(guestAuthentication, "authenticate");
  let id = 800;
  const ownerAccess = withOwnerAdministration
    ? new OwnerAccessService({
      repository: voiceRepository,
      registry,
      authorities: authority,
      verifier: pinVerifier,
      idFactory: () => `01k3wceg000000000000000${id++}` as Ulid,
      proposalIdFactory: () => `owner-access-proposal:${crypto.randomUUID()}`,
      defaultGuestPin: () => "1357",
    })
    : null;
  const conversation = {
    handleTurn: vi.fn(async () => ({
      outcome: "voice_sent" as const,
      userEventId: TURN_ID,
      assistantEventId: NEXT_TURN_ID,
      sentAssistantEventId: NEXT_TURN_ID,
      deliveredAssistantEventId: null,
      deliveryId: null,
    })),
  } as unknown as ConversationService;
  const close = vi.fn<(code: number) => void>();
  const end = vi.fn<(handoffData: string) => Promise<void>>(async () => undefined);
  const sendNeutralText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  const armOwnerStepUpAlarm = vi.fn<OwnerStepUpAlarmPort["arm"]>(async () => undefined);
  const clearOwnerStepUpAlarm = vi.fn(async () => undefined);
  const ownerStepUpAlert = vi.fn(async () => undefined);
  let currentNow = new Date(NOW);
  const sensitiveAction = sensitiveActionService(() => new Date(currentNow));
  const instance = new CallSessionCore({
    capacity,
    session: stored,
    expectedAccountSid: ACCOUNT_SID,
    repository: repo,
    authority,
    guestAuthentication,
    activation: null,
    ownerAccess,
    ownerStepUp,
    sensitiveAction,
    ownerStepUpAlerts: { alert: ownerStepUpAlert },
    ownerStepUpAlarm: { arm: armOwnerStepUpAlarm, clear: clearOwnerStepUpAlarm },
    conversation,
    relay: {
      close,
      sendNeutralText,
      sendToken: async () => undefined,
      finish: async () => undefined,
      cancelOutput: async () => undefined,
      ...(withCleanEnd ? { end } : {}),
    },
    now: () => new Date(currentNow),
  } as never);
  return {
    repo,
    voiceRepository,
    stored,
    authority,
    guestAuthentication,
    ownerAccess,
    ownerStepUp,
    sensitiveAction,
    authenticate,
    conversation,
    close,
    end,
    sendNeutralText,
    armOwnerStepUpAlarm,
    clearOwnerStepUpAlarm,
    ownerStepUpAlert,
    advanceTime(milliseconds: number) {
      currentNow = new Date(currentNow.valueOf() + milliseconds);
    },
    instance,
  };
}

describe("CallSessionCore owner and guest access", () => {
  beforeEach(applyCallStepUpTestMigrations);
  afterEach(clearFixture);

  it("rejects a structural authentication-budget lookalike at guest construction", () => {
    expect(() => new GuestCallAuthentication({
      repository: new VoiceAccessRepository(env.DB),
      budgets: { reservePinAttempt: vi.fn(async () => true) } as never,
      verifier: new GuestPinVerifier(PEPPER),
      proofs: new GuestPinProofIssuer(),
    })).toThrowError("guest_call_authentication_configuration_invalid");
  });

  it("moves an active owner from relay setup to active with zero PIN work", async () => {
    const harness = await accessHarness("owner");

    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    expect(harness.instance.phase).toBe("active");
    expect(harness.authenticate).not.toHaveBeenCalled();
    expect(harness.sendNeutralText.mock.calls.flat()).not.toContainEqual(expect.stringMatching(/pin|passcode/iu));
  });

  it("refuses a revoked passphrase at the action while the call PIN still authorises", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);
    const restore = await revokeOwnerVerifierForTest();
    try {
      await harness.instance.handleRelayEvent({
        type: "prompt", final: true, language: "en-US", text: `allow ${GUEST_E164} with conversation`,
      });
      await harness.instance.handleRelayEvent({
        type: "prompt", final: true, language: "en-US", text: OWNER_TEST_PHRASE,
      });

      expect(harness.sendNeutralText).toHaveBeenCalledWith(OWNER_ACTION_REPROMPT_SPEECH.unclear);
      expect(harness.instance.phase).toBe("active");
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
        .toEqual({ count: 0 });

      await authoriseOwnerAccess(harness);
      await sendDigits(harness.instance, "2468");
      await harness.instance.handleRelayEvent({
        type: "prompt", final: true, language: "en-US", text: "confirm",
      });
      expect(await env.DB.prepare("SELECT status FROM voice_access_grants").first())
        .toEqual({ status: "pending" });
    } finally {
      await restore();
    }
  });

  it("authenticates only the bound guest grant and rechecks it before conversation", async () => {
    const harness = await accessHarness("guest");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    await sendDigits(harness.instance, "4827");
    expect(harness.instance.phase).toBe("active");
    expect(harness.authenticate).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT grant_version, status, activated_at
      FROM voice_access_grants WHERE grant_id = ?`).bind(GUEST_GRANT_ID)
      .first<{ grant_version: number; status: string; activated_at: string | null }>())
      .toEqual({ grant_version: 1, status: "active", activated_at: NOW.toISOString() });
    expect(await env.DB.prepare("SELECT status, verified_at FROM channel_identities WHERE identity_id = 'identity:guest'")
      .first<{ status: string; verified_at: string | null }>())
      .toEqual({ status: "active", verified_at: NOW.toISOString() });
    expect(await env.DB.prepare(`SELECT authority_kind, grant_id, grant_version, access_document_hash
      FROM call_session_authorities WHERE session_id = ?`).bind(harness.stored.sessionId)
      .first<{ authority_kind: string; grant_id: string; grant_version: number; access_document_hash: string }>())
      .toMatchObject({ authority_kind: "guest", grant_id: GUEST_GRANT_ID, grant_version: 1 });
    expect((await env.DB.prepare("SELECT event_type FROM voice_access_grant_events ORDER BY created_at, event_id")
      .all<{ event_type: string }>()).results)
      .toEqual([{ event_type: "created" }, { event_type: "activated" }]);

    const revokedAt = new Date(NOW.valueOf() + 1).toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE voice_access_grants
        SET grant_version = 2, status = 'revoked', updated_at = ?, revoked_at = ?
        WHERE grant_id = ? AND grant_version = 1`)
        .bind(revokedAt, revokedAt, GUEST_GRANT_ID),
      env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:guest'"),
    ]);
    await expect(harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "hello",
    })).rejects.toThrow("call_authority_stale");
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();
  });

  it("writes, admits, binds, PIN-activates, and rehydrates one target-owned scoped guest", async () => {
    await clearFixture();
    const makeResolver = () => new TargetGuestResourceScopeResolver([{
      providerE164: GUEST_E164,
      resourceScopes: {
        schemaVersion: "1.0",
        calendarConnectionIds: [],
        fileRootIds: ["file-root:guest"],
        pcActionIds: [],
      },
    }]);
    const registry = new CapabilityRegistry({
      installed: ["conversation.basic", "files.read", "access.manage"],
      fileRootIds: ["file-root:guest"],
    });
    const voiceRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(registry, makeResolver()),
    });
    const ownerAuthority = await seedFixtureOwnerAuthority(env.DB, voiceRepository);
    const snapshot = await registry.snapshot(["conversation.basic", "files.read"], {
      schemaVersion: "1.0",
      calendarConnectionIds: [],
      fileRootIds: ["file-root:guest"],
      pcActionIds: [],
    });
    const verifier = new GuestPinVerifier(
      new Uint8Array(32).fill(12),
      () => new Uint8Array(16).fill(8),
    );
    const pinVerifier = await verifier.create(GUEST_GRANT_ID, Uint8Array.from([52, 56, 50, 55]));
    await voiceRepository.createGuestGrant({
      ...validCreateInput(ownerAuthority),
      mutationId: "01k3wceg000000000000000791" as Ulid,
      grantId: GUEST_GRANT_ID,
      guestPrincipalId: "principal:guest",
      guestIdentityId: "identity:guest",
      ownerIdentityId: FIXTURE_OWNER_IDENTITY_ID,
      providerE164: GUEST_E164,
      capabilityIds: snapshot.capabilityIds,
      resourceScopes: snapshot.resourceScopes,
      accessDocumentHash: snapshot.accessDocumentHash,
      pinVerifier,
    });
    const repo = new CallRepository(
      env.DB,
      new EventRepository(env.DB),
      () => RELAY_NONCE,
      300_000,
      () => SESSION_ID,
      voiceRepository,
    );
    const stored = await repo.getOrCreateInboundSession({
      callSid: CALL_SID,
      callerE164: GUEST_E164,
      ownerIdentityId: FIXTURE_OWNER_IDENTITY_ID,
      currentChallengeHmacKeyVersion: "hmac-v1",
      now: NOW,
    });
    const proofs = new GuestPinProofIssuer();
    const authorities = new VoiceAccessAuthorityService(voiceRepository, registry, proofs);
    const guestAuthentication = new GuestCallAuthentication({
      repository: voiceRepository,
      budgets: new AuthenticationAttemptBudget(env.DB, PEPPER),
      verifier,
      proofs,
    });
    const conversation = {
      handleTurn: vi.fn(async () => ({
        outcome: "voice_sent" as const,
        userEventId: TURN_ID,
        assistantEventId: NEXT_TURN_ID,
        sentAssistantEventId: NEXT_TURN_ID,
        deliveredAssistantEventId: null,
        deliveryId: null,
      })),
    } as unknown as ConversationService;
    const harness = makeCore({
      session: stored,
      repo,
      authority: authorities,
      guestAuthentication,
      conversation,
    });

    const scopedProviderSessionId = `VX${"9".repeat(32)}`;
    await harness.instance.handleRelayEvent({ ...relaySetup(stored), sessionId: scopedProviderSessionId });
    await sendDigits(harness.instance, "4827");
    expect(harness.instance.phase).toBe("active");
    expect(await repo.getCallSession(stored.sessionId)).toMatchObject({
      phase: "active",
      providerSessionId: scopedProviderSessionId,
      binding: { accessDocumentHash: snapshot.accessDocumentHash },
    });
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "read my scoped file",
    });
    expect(conversation.handleTurn).toHaveBeenCalledOnce();

    const restartedRegistry = new CapabilityRegistry({
      installed: ["conversation.basic", "files.read", "access.manage"],
      fileRootIds: ["file-root:guest"],
    });
    const restartedRepository = new VoiceAccessRepository(env.DB, {
      accessDocumentVerifier: createTargetGuestAccessDocumentVerifier(restartedRegistry, makeResolver()),
    });
    await expect(new VoiceAccessAuthorityService(restartedRepository, restartedRegistry).rehydrate({
      sessionId: stored.sessionId,
      binding: stored.binding,
      now: NOW,
    })).resolves.toMatchObject({
      kind: "guest",
      capabilityIds: snapshot.capabilityIds,
      resourceScopes: snapshot.resourceScopes,
      accessDocumentHash: snapshot.accessDocumentHash,
    });
  });

  it("keeps pending guest activation atomic when the configured owner is invalidated after provider bind", async () => {
    const harness = await accessHarness("guest");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = 'identity:voice'")
      .run();

    await expect(sendDigits(harness.instance, "4827"))
      .rejects.toThrow("call_session_authority_guest_owner_required");
    expect(await env.DB.prepare(`SELECT grant_version, status, activated_at
      FROM voice_access_grants WHERE grant_id = ?`).bind(GUEST_GRANT_ID)
      .first<{ grant_version: number; status: string; activated_at: string | null }>())
      .toEqual({ grant_version: 1, status: "pending", activated_at: null });
    expect(await env.DB.prepare("SELECT status, verified_at FROM channel_identities WHERE identity_id = 'identity:guest'")
      .first<{ status: string; verified_at: string | null }>())
      .toEqual({ status: "pending", verified_at: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM call_session_authorities").first())
      .toEqual({ count: 0 });
    expect((await env.DB.prepare("SELECT event_type FROM voice_access_grant_events ORDER BY created_at, event_id")
      .all<{ event_type: string }>()).results)
      .toEqual([{ event_type: "created" }]);
  });

  it.each(["owner", "guest"] as const)("rehydrates an exact active %s authority after a core restart", async (kind) => {
    const harness = await accessHarness(kind);
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    if (kind === "guest") await sendDigits(harness.instance, "4827");
    const active = await harness.repo.getCallSession(harness.stored.sessionId);
    if (active === null || active.phase !== "active") throw new Error("active_session_fixture_missing");

    const restartedRepository = new VoiceAccessRepository(env.DB);
    const restartedAuthority = new VoiceAccessAuthorityService(
      restartedRepository,
      new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
      new GuestPinProofIssuer(),
    );
    const conversation = {
      handleTurn: vi.fn(async () => ({
        outcome: "voice_sent" as const,
        userEventId: TURN_ID,
        assistantEventId: NEXT_TURN_ID,
        sentAssistantEventId: NEXT_TURN_ID,
        deliveredAssistantEventId: null,
        deliveryId: null,
      })),
    } as unknown as ConversationService;
    const restarted = new CallSessionCore({
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session: active,
      expectedAccountSid: ACCOUNT_SID,
      repository: harness.repo,
      authority: restartedAuthority,
      activation: null,
      ownerAccess: null,
      conversation,
      relay: {
        close: vi.fn(),
        sendNeutralText: async () => undefined,
        sendToken: async () => undefined,
        finish: async () => undefined,
        cancelOutput: async () => undefined,
      },
      now: () => new Date(NOW),
    } as never);

    await restarted.handleRelayEvent({ type: "prompt", final: true, language: "en-US", text: "resume" });
    expect(conversation.handleTurn).toHaveBeenCalledOnce();
  });

  it("fails an active restarted call closed at the exact provider-connected authority deadline", async () => {
    const harness = await accessHarness("owner");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    const active = await harness.repo.getCallSession(harness.stored.sessionId);
    if (active === null || active.phase !== "active") throw new Error("active_session_fixture_missing");
    const conversation = { handleTurn: vi.fn() } as unknown as ConversationService;
    const restarted = new CallSessionCore({
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session: active,
      expectedAccountSid: ACCOUNT_SID,
      repository: harness.repo,
      authority: new VoiceAccessAuthorityService(
        new VoiceAccessRepository(env.DB),
        new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
        new GuestPinProofIssuer(),
      ),
      activation: null,
      ownerAccess: null,
      conversation,
      relay: {
        close: vi.fn(),
        sendNeutralText: async () => undefined,
        sendToken: async () => undefined,
        finish: async () => undefined,
        cancelOutput: async () => undefined,
      },
      now: () => new Date("2026-08-30T12:30:00.000Z"),
    } as never);

    await expect(restarted.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "too late",
    })).rejects.toThrow("call_authority_expired");
    expect(restarted.phase).toBe("expired");
    expect(await storedPhase(active.sessionId)).toBe("expired");
    expect(conversation.handleTurn).not.toHaveBeenCalled();
  });

  it("clears active authority and transient interaction state on terminal callback invalidation", async () => {
    const harness = await accessHarness("owner", undefined, true);
    const invalidate = vi.spyOn(harness.authority, "invalidate");
    await admitOwnerAdministration(harness);

    await harness.instance.terminate("completed");

    expect(harness.instance.phase).toBe("completed");
    expect(invalidate).toHaveBeenCalledOnce();
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "confirm",
    });
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();
  });

  /**
   * The admission gate moved to the action on 2026-09-17. Eleven tests used to
   * live here, driving the old always-on passphrase step-up through its
   * rejection, KDF-race and alarm-race states. The owner's decision was that a
   * failed credential never ends a call, so those states are no longer on any
   * path a call can take. What replaces them is below: admission asks for
   * nothing, and the credential is asked for at the action.
   */
  it("admits an owner call straight into conversation without asking for any credential", async () => {
    const harness = await accessHarness("owner");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    expect(harness.instance.phase).toBe("active");
    expect(harness.sendNeutralText).not.toHaveBeenCalled();

    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: "what is on today",
    });
    expect(harness.conversation.handleTurn).toHaveBeenCalledOnce();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("asks for the action PIN before a sensitive change and keeps the call open when it is wrong", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);

    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: `allow ${GUEST_E164} with conversation`,
    });
    expect(harness.sendNeutralText).toHaveBeenCalledWith(`Allow a new caller to reach Jarvis. ${OWNER_ACTION_PIN_PROMPT}`);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });

    await sendDigits(harness.instance, "0000");

    expect(harness.sendNeutralText).toHaveBeenCalledWith(OWNER_ACTION_REPROMPT_SPEECH.wrong);
    expect(harness.instance.phase).toBe("active");
    expect(harness.close).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });

    await authoriseOwnerAccess(harness);
    await sendDigits(harness.instance, "2468");
    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: "confirm",
    });
    expect(await env.DB.prepare("SELECT status FROM voice_access_grants").first())
      .toEqual({ status: "pending" });
  });

  it("refuses the action after five wrong PINs without ending the call", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);
    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: `allow ${GUEST_E164} with conversation`,
    });

    for (let attempt = 0; attempt < OWNER_ACTION_MAX_ATTEMPTS; attempt += 1) {
      await sendDigits(harness.instance, "0000");
    }

    expect(harness.sendNeutralText).toHaveBeenCalledWith(OWNER_ACTION_REFUSED);
    expect(harness.instance.phase).toBe("active");
    expect(harness.close).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });

    // A mis-heard digit is likelier than an attacker, so exhaustion refuses the
    // action and nothing else: the caller is still talking to Jarvis.
    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: "what is on today",
    });
    expect(harness.conversation.handleTurn).toHaveBeenCalledOnce();
  });

  it("accepts the three-word phrase at the action as the alternative credential", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);
    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: `allow ${GUEST_E164} with conversation`,
    });

    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: OWNER_TEST_PHRASE,
    });
    await sendDigits(harness.instance, "2468");
    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: "confirm",
    });

    expect(await env.DB.prepare("SELECT status FROM voice_access_grants").first())
      .toEqual({ status: "pending" });
    expect(harness.instance.phase).toBe("active");
    expect(JSON.stringify(harness.sendNeutralText.mock.calls)).not.toMatch(/ablaze|abrasion/u);
  });

  it("expires the action question without doing the work and without ending the call", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);
    await harness.instance.handleRelayEvent({
      type: "prompt", final: true, language: "en-US", text: `allow ${GUEST_E164} with conversation`,
    });

    harness.advanceTime(OWNER_ACTION_WINDOW_MS + 1);
    await authoriseOwnerAccess(harness);

    expect(harness.sendNeutralText).toHaveBeenCalledWith(OWNER_ACTION_EXPIRED);
    expect(harness.instance.phase).toBe("active");
    expect(harness.close).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
  });

  it("does not start a conversation turn when termination wins during authorization", async () => {
    const harness = await accessHarness("owner");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(harness.authority, "authorize").mockImplementation(async (value) => {
      const authority = harness.authority.snapshot(value);
      started();
      await gate;
      return authority;
    });

    const prompt = harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "do not start this turn",
    });
    await entered;
    await harness.instance.terminate("completed");
    release();

    await expect(prompt).rejects.toThrow("call_session_terminal");
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();
  });

  it("reserves no budget for partial or cleared input and accepts strict final spoken digits", async () => {
    const harness = await accessHarness("guest");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    await sendDigits(harness.instance, "482*");
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: false,
      language: "en-US",
      text: "four eight two seven",
    });
    expect(await reservationCount()).toBe(0);
    expect(harness.instance.phase).toBe("pre_auth");
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();

    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "hello four eight two seven",
    });
    expect(await reservationCount()).toBe(0);
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();

    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "four eight two seven",
    });
    expect(harness.instance.phase).toBe("active");
    expect(await reservationCount()).toBe(1);
  });

  it("discards a partial guest PIN across a core restart", async () => {
    const harness = await accessHarness("guest");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    await sendDigits(harness.instance, "48");
    const preAuth = await harness.repo.getCallSession(harness.stored.sessionId);
    if (preAuth === null || preAuth.phase !== "pre_auth") throw new Error("pre_auth_fixture_missing");
    const restarted = new CallSessionCore({
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session: preAuth,
      expectedAccountSid: ACCOUNT_SID,
      repository: harness.repo,
      authority: harness.authority,
      guestAuthentication: harness.guestAuthentication,
      activation: null,
      ownerAccess: null,
      conversation: harness.conversation,
      relay: {
        close: harness.close,
        sendNeutralText: harness.sendNeutralText,
        sendToken: async () => undefined,
        finish: async () => undefined,
        cancelOutput: async () => undefined,
      },
      now: () => new Date(NOW),
    } as never);

    await sendDigits(restarted, "27");
    expect(harness.authenticate).not.toHaveBeenCalled();
    expect(await reservationCount()).toBe(0);
    await sendDigits(restarted, "*");
    await sendDigits(restarted, "4827");
    expect(harness.authenticate).toHaveBeenCalledOnce();
    expect(restarted.phase).toBe("active");
  });

  it("rejects the call after three complete bad guest candidates", async () => {
    const harness = await accessHarness("guest");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    await sendDigits(harness.instance, "000000000000");

    expect(harness.instance.phase).toBe("rejected");
    expect(await reservationCount()).toBe(3);
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();
    const owner = await env.DB.prepare("SELECT status FROM principals WHERE principal_id = 'principal:owner'")
      .first<{ status: string }>();
    expect(owner?.status).toBe("active");
  });

  it("fails closed before a second guest chained PBKDF2 when the Task 4 budget is exhausted", async () => {
    const harness = await accessHarness("guest", 1);
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    await sendDigits(harness.instance, "0000");

    await sendDigits(harness.instance, "4827");

    expect(harness.instance.phase).toBe("rejected");
    expect(await reservationCount()).toBe(1);
    expect(deriveBits).toHaveBeenCalledTimes(6);
  });

  it("executes a recognized owner access draft only after explicit PIN selection and exact confirmation", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);

    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: `allow ${GUEST_E164} with conversation`,
    });
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();
    // The draft is held behind the action credential, so two digits of the
    // guest PIN do nothing until the PIN question has been answered.
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
    await authoriseOwnerAccess(harness);
    await sendDigits(harness.instance, "2468");
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "confirm",
    });

    const grant = await env.DB.prepare(`SELECT grant_row.status, identity.provider_subject
      FROM voice_access_grants grant_row
      JOIN channel_identities identity ON identity.identity_id = grant_row.identity_id`)
      .first<{ status: string; provider_subject: string }>();
    expect(grant).toEqual({ status: "pending", provider_subject: GUEST_E164 });
    expect(harness.conversation.handleTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.sendNeutralText.mock.calls)).not.toMatch(/\+14165550111|2468|4271/u);
  });

  it("keeps ordinary confirm in conversation when no issued owner proposal is current", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);

    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "confirm",
    });

    expect(harness.conversation.handleTurn).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
  });

  it("invalidates an interrupted proposal and clears partial owner PIN input before a replacement", async () => {
    const harness = await accessHarness("owner", undefined, true);
    if (harness.ownerAccess === null) throw new Error("fixture_owner_access_missing");
    const invalidate = vi.spyOn(harness.ownerAccess, "invalidate");
    await admitOwnerAdministration(harness);
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: `allow ${GUEST_E164} with conversation`,
    });
    await authoriseOwnerAccess(harness);
    await sendDigits(harness.instance, "24");
    await harness.instance.handleRelayEvent({ type: "interrupt" });
    expect(invalidate).toHaveBeenCalled();
    expect(harness.instance.phase).toBe("active");

    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "allow +14165550112 with conversation",
    });
    await authoriseOwnerAccess(harness);
    await sendDigits(harness.instance, "68");
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "confirm",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });

    await sendDigits(harness.instance, "1357");
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: "confirm",
    });
    const target = await env.DB.prepare("SELECT provider_subject FROM channel_identities WHERE principal_id != 'principal:owner'")
      .first<{ provider_subject: string }>();
    expect(target?.provider_subject).toBe("+14165550112");
  });

  it("drops an issued owner proposal and partial PIN across a core restart", async () => {
    const harness = await accessHarness("owner", undefined, true);
    await admitOwnerAdministration(harness);
    await harness.instance.handleRelayEvent({
      type: "prompt",
      final: true,
      language: "en-US",
      text: `allow ${GUEST_E164} with conversation`,
    });
    await authoriseOwnerAccess(harness);
    await sendDigits(harness.instance, "13");
    const active = await harness.repo.getCallSession(harness.stored.sessionId);
    if (active === null || active.phase !== "active") throw new Error("active_session_fixture_missing");
    const restarted = new CallSessionCore({
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session: active,
      expectedAccountSid: ACCOUNT_SID,
      repository: harness.repo,
      authority: harness.authority,
      guestAuthentication: null,
      activation: null,
      ownerAccess: harness.ownerAccess,
      sensitiveAction: harness.sensitiveAction,
      conversation: harness.conversation,
      relay: {
        close: harness.close,
        sendNeutralText: harness.sendNeutralText,
        sendToken: async () => undefined,
        finish: async () => undefined,
        cancelOutput: async () => undefined,
      },
      now: () => new Date(NOW),
    } as never);

    await restarted.handleRelayEvent({ type: "prompt", final: true, language: "en-US", text: "confirm" });
    expect(harness.conversation.handleTurn).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM voice_access_grants").first())
      .toEqual({ count: 0 });
  });
});

describe("CallSessionCore access, enrollment, and conversation", () => {
  beforeEach(async () => {
    await applyCallStepUpTestMigrations();
    await clearFixture();
    await seedActiveVoiceIdentity();
  });

  afterEach(clearFixture);

  it("rejects a structural access-authority lookalike before relay processing", async () => {
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
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session: stored,
      expectedAccountSid: ACCOUNT_SID,
      repository: repo,
      authority: { mintOwner: vi.fn(async () => Object.freeze({ kind: "owner" })) } as never,
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

  it("activates a pending phone after only one separately budgeted signed challenge response", async () => {
    const harness = await activationHarness();
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    expect(harness.instance.phase).toBe("pre_auth");
    expect(await reservationKinds()).toEqual([]);
    await sendDigits(harness.instance, CHALLENGE_RESPONSE.slice(0, -1));
    expect(await reservationKinds()).toEqual([]);

    await sendDigits(harness.instance, CHALLENGE_RESPONSE.at(-1) ?? "");

    expect(harness.instance.phase).toBe("completed");
    expect(await storedPhase(harness.stored.sessionId)).toBe("completed");
    expect(await reservationKinds()).toEqual(["activation"]);
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
    expect(JSON.stringify(durable.flatMap((result) => result.results ?? []))).not.toContain(CHALLENGE_RESPONSE);
  });

  it("keeps an activation-only call isolated from conversation, memory, and the model", async () => {
    const handleTurn = vi.fn<ConversationService["handleTurn"]>(async () => {
      throw new Error("activation_reached_conversation");
    });
    const harness = await activationHarness({ conversation: { handleTurn } });
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    await harness.instance.handleRelayEvent({
      type: "prompt", text: "read my memory", language: "en-US", final: true,
    });

    expect(handleTurn).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type LIKE 'conversation.%'")
      .first<{ count: number }>())?.count).toBe(0);
  });

  it("fails one wrong activation response once and never retries it inside the call", async () => {
    const harness = await activationHarness();
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    await sendDigits(harness.instance, "000000");

    expect(harness.instance.phase).toBe("failed");
    expect(await identityState()).toEqual({ status: "pending", verified_at: null });
    expect(await challengeConsumedAt()).toBeNull();
    expect(await reservationKinds()).toEqual(["activation"]);
    await sendDigits(harness.instance, CHALLENGE_RESPONSE);
    expect(await reservationKinds()).toEqual(["activation"]);
    expect(harness.sendNeutralText.mock.calls.map(([text]) => text)).toEqual([
      "Enter the one-time phone enrollment challenge shown in your local Jarvis CLI.",
      "Phone verification could not be completed.",
    ]);
  });

  it("fails before challenge confirmation when the real activation budget is exhausted", async () => {
    const harness = await activationHarness({ challengeLimit: 1 });
    expect(await harness.budgets.reserveActivationAttempt({ binding: harness.stored.binding, now: NOW })).toBe(true);
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    await sendDigits(harness.instance, CHALLENGE_RESPONSE);

    expect(harness.instance.phase).toBe("failed");
    expect(await identityState()).toEqual({ status: "pending", verified_at: null });
    expect(await challengeConsumedAt()).toBeNull();
    expect(await reservationKinds()).toEqual(["activation"]);
  });

  it("rejects a cross-session enrollment confirmation before activation authority is reserved", async () => {
    const harness = await activationHarness();
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));

    await expect(harness.activation.confirm({
      sessionId: OTHER_SESSION_ID,
      binding: harness.stored.binding,
      response: CHALLENGE_RESPONSE,
      now: NOW,
    } as never)).rejects.toThrow("phone_activation_session_invalid");

    expect(await reservationKinds()).toEqual([]);
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

  it.each(["token", "finish"] as const)(
    "blocks a late relay %s when a turn ignores abort and emits after termination",
    async (lateDelivery) => {
      const repo = repository();
      const stored = await createInboundSession(repo);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const conversation = {
        handleTurn: vi.fn<ConversationService["handleTurn"]>(async (input) => {
          if (input.channel !== "voice") throw new Error("voice_delivery_expected");
          if (lateDelivery === "finish") await input.onToken({ index: 0, text: "before" });
          started();
          await gate;
          if (lateDelivery === "token") await input.onToken({ index: 0, text: "late" });
          else await input.finish("before");
          return {
            outcome: "voice_sent",
            committedUserEventId: TURN_ID,
            sentAssistantEventId: NEXT_TURN_ID,
            deliveredAssistantEventId: null,
            deliveryId: null,
          };
        }),
        stageSystemNotice: vi.fn(),
      } as ConversationService;
      const harness = makeCore({ session: stored, repo, conversation });
      await harness.instance.handleRelayEvent(relaySetup(stored));
      expect(harness.instance.phase).toBe("active");

      const pending = harness.instance.handleRelayEvent({
        type: "prompt",
        text: "emit only while active",
        language: "en-US",
        final: true,
      });
      const observed = pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await entered;
      expect(harness.sendToken).toHaveBeenCalledTimes(lateDelivery === "finish" ? 1 : 0);
      await harness.instance.terminate("completed");
      release();

      const result = await observed;
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") expect(result.error).toEqual(expect.any(Error));
      expect(harness.sendToken).toHaveBeenCalledTimes(lateDelivery === "finish" ? 1 : 0);
      expect(harness.finish).not.toHaveBeenCalled();
    },
  );

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

describe("CallSession capacity admission", () => {
  const prompt = { type: "prompt", text: "An ordinary question", language: "en-US", final: true } as const;
  beforeEach(async () => { await applyCallStepUpTestMigrations(); await clearFixture(); await seedActiveVoiceIdentity(); });
  afterEach(async () => { vi.restoreAllMocks(); await clearFixture(); });

  function blocked() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const capacity = { assertAcceptingNewTurn: vi.fn(async () => { await gate; }) };
    return { capacity, release };
  }

  async function start(capacity: Pick<CapacityGuard, "assertAcceptingNewTurn">) {
    const repo = repository();
    const stored = await createInboundSession(repo);
    const provider = new FakeModelProvider({ streamText: "A safe answer", streamTokenCount: 1 });
    const conversation = new DefaultConversationService({
      repository: new ConversationRepository(env.DB, new EventRepository(env.DB)),
      model: new DefaultModelAdapter(provider), context: new D1ContextRetriever(env.DB),
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_voice_outbox_dispatch"); } },
      redactor: new Redactor(), now: () => new Date(NOW),
    });
    const handleTurn = vi.spyOn(conversation, "handleTurn");
    const core = makeCore({ session: stored, repo, conversation, capacity, turnIds: [TURN_ID, NEXT_TURN_ID] });
    await core.instance.handleRelayEvent(relaySetup(stored));
    return { ...core, provider, handleTurn };
  }

  it("refuses capacity before allocating an id, writing a turn or requesting the model", async () => {
    const capacity = { assertAcceptingNewTurn: vi.fn(async () => { throw new Error("capacity_unavailable"); }) };
    const core = await start(capacity);
    await expect(core.instance.handleRelayEvent(prompt)).rejects.toThrow("capacity_unavailable");
    expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce();
    expect(core.newTurnId).not.toHaveBeenCalled();
    expect(core.handleTurn).not.toHaveBeenCalled();
    expect(core.provider.requests).toHaveLength(0);
    expect(await conversationTurn(TURN_ID)).toBeNull();
  });

  it.each([undefined, null, {}, { assertAcceptingNewTurn: true }])("refuses a missing or malformed capacity port: %j", async (capacity) => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    expect(() => new CallSessionCore({ session: stored, expectedAccountSid: ACCOUNT_SID, repository: repo,
      capacity: capacity as never,
      relay: { close: vi.fn(), sendNeutralText: vi.fn(), sendToken: vi.fn(), finish: vi.fn(), cancelOutput: vi.fn() },
      now: () => new Date(NOW),
    })).toThrow("call_session_configuration_invalid");
  });

  it("captures the capacity method and rechecks it for every final conversation turn", async () => {
    let allowed = true;
    const capacity = { assertAcceptingNewTurn: vi.fn(async function (this: unknown) {
      expect(this).toBe(capacity);
      if (!allowed) throw new Error("capacity_unavailable");
    }) };
    const captured = capacity.assertAcceptingNewTurn;
    const core = await start(capacity);
    capacity.assertAcceptingNewTurn = vi.fn(async () => undefined);
    await core.instance.handleRelayEvent({ ...prompt, final: false });
    expect(captured).not.toHaveBeenCalled();
    await core.instance.handleRelayEvent(prompt);
    allowed = false;
    await expect(core.instance.handleRelayEvent(prompt)).rejects.toThrow("capacity_unavailable");
    expect(captured).toHaveBeenCalledTimes(2);
    expect(capacity.assertAcceptingNewTurn).not.toHaveBeenCalled();
    expect(core.provider.requests).toHaveLength(1);
    expect(await conversationTurn(NEXT_TURN_ID)).toBeNull();
  });

  it("reserves the turn before collection so a second prompt cannot start another admission", async () => {
    const { capacity, release } = blocked();
    const core = await start(capacity);
    const pending = core.instance.handleRelayEvent(prompt);
    try {
      await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce());
      await expect(core.instance.handleRelayEvent(prompt)).rejects.toThrow("turn_in_progress");
      expect(core.newTurnId).not.toHaveBeenCalled();
    } finally { release(); await pending; }
    expect(core.provider.requests).toHaveLength(1);
  });

  it.each([false, true])("quietly cancels admission on interruption even if collection later fails: %s", async (fails) => {
    const { capacity, release } = blocked();
    const read = capacity.assertAcceptingNewTurn.getMockImplementation()!;
    capacity.assertAcceptingNewTurn.mockImplementationOnce(async () => { await read(); if (fails) throw new Error("capacity_unavailable"); });
    const core = await start(capacity);
    const authorize = vi.spyOn(core.authority!, "authorize");
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce());
      await core.instance.handleRelayEvent({ type: "interrupt" });
    } finally { release(); }
    await expect(pending).resolves.toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
    expect(core.handleTurn).not.toHaveBeenCalled();
    expect(core.newTurnId).not.toHaveBeenCalled();
    expect(core.instance.phase).toBe("active");
    await core.instance.handleRelayEvent(prompt);
    expect(core.provider.requests).toHaveLength(1);
    expect(core.close).not.toHaveBeenCalled();
  });

  it.each([false, true])("admits the replacement prompt while the interrupted read remains pending, late failure: %s", async (fails) => {
    const { capacity, release } = blocked();
    const read = capacity.assertAcceptingNewTurn.getMockImplementation()!;
    capacity.assertAcceptingNewTurn.mockImplementationOnce(async () => { await read(); if (fails) throw new Error("capacity_unavailable"); })
      .mockResolvedValue(undefined);
    const core = await start(capacity);
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce());
      await core.instance.handleRelayEvent({ type: "interrupt" });
      await expect(core.instance.handleRelayEvent({ ...prompt, text: "The replacement question" })).resolves.toBeUndefined();
      expect(core.provider.requests).toHaveLength(1);
      expect(core.provider.requests[0]).toMatchObject({ operation: "streamText", userText: "The replacement question" });
    } finally { release(); await pending; }
    expect(core.instance.phase).toBe("active");
    expect(core.close).not.toHaveBeenCalled();
  });

  it("does not wait for a read when the socket closes synchronously as collection starts", async () => {
    const { capacity, release } = blocked();
    const read = capacity.assertAcceptingNewTurn.getMockImplementation()!;
    const core = await start(capacity);
    let closing!: Promise<void>;
    capacity.assertAcceptingNewTurn.mockImplementationOnce(async () => {
      closing = core.instance.handleSocketClose();
      await read();
    });
    const pending = core.instance.handleRelayEvent(prompt);
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });
    try {
      await vi.waitFor(() => expect(failure).toMatchObject({ message: "call_session_terminal" }));
      await closing;
      expect(core.provider.requests).toHaveLength(0);
      expect(core.newTurnId).not.toHaveBeenCalled();
    } finally { release(); await observed; }
  });

  it.each(["terminal", "socket", "provider"] as const)("refuses a collected turn after %s termination", async (kind) => {
    const { capacity, release } = blocked();
    const core = await start(capacity);
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce());
      if (kind === "terminal") await core.instance.terminate("completed");
      else await core.instance.handleSocketClose(kind === "provider" ? "provider_error" : "socket_closed");
    } finally { release(); }
    await expect(pending).rejects.toThrow("call_session_terminal");
    expect(core.handleTurn).not.toHaveBeenCalled();
    expect(core.newTurnId).not.toHaveBeenCalled();
    expect(core.sendToken).not.toHaveBeenCalled();
  });

  it("reauthorizes the guest after collection so revocation during the read prevents a turn", async () => {
    const { capacity, release } = blocked();
    const core = await accessHarness("guest", undefined, false, capacity);
    await core.instance.handleRelayEvent(relaySetup(core.stored));
    await sendDigits(core.instance, "4827");
    expect(capacity.assertAcceptingNewTurn).not.toHaveBeenCalled();
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce());
      await env.DB.prepare("UPDATE voice_access_grants SET grant_version = 2, status = 'revoked', updated_at = ?, revoked_at = ? WHERE grant_id = ?")
        .bind(new Date(NOW.valueOf() + 1).toISOString(), new Date(NOW.valueOf() + 1).toISOString(), GUEST_GRANT_ID).run();
    } finally { release(); }
    await expect(pending).rejects.toThrow();
    expect(core.conversation.handleTurn).not.toHaveBeenCalled();
  });

  it("honors interruption during the fresh authorization after capacity succeeds", async () => {
    const capacity = { assertAcceptingNewTurn: vi.fn(async () => undefined) };
    const core = await start(capacity);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const authorize = vi.spyOn(core.authority!, "authorize").mockImplementation(async (authority) => {
      const captured = core.authority!.snapshot(authority);
      await gate;
      return captured;
    });
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
      await core.instance.handleRelayEvent({ type: "interrupt" });
    } finally { release(); }
    await expect(pending).resolves.toBeUndefined();
    expect(capacity.assertAcceptingNewTurn).toHaveBeenCalledOnce();
    expect(core.handleTurn).not.toHaveBeenCalled();
    expect(core.newTurnId).not.toHaveBeenCalled();
  });

  it("admits a replacement before the interrupted authorization returns", async () => {
    const core = await start(healthyCapacity);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const authorize = vi.spyOn(core.authority!, "authorize").mockImplementationOnce(async (authority) => {
      const captured = core.authority!.snapshot(authority);
      await gate;
      return captured;
    });
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
      await core.instance.handleRelayEvent({ type: "interrupt" });
      await expect(core.instance.handleRelayEvent({ ...prompt, text: "A replacement after interrupt" })).resolves.toBeUndefined();
      expect(core.provider.requests).toHaveLength(1);
      expect(core.provider.requests[0]).toMatchObject({ operation: "streamText", userText: "A replacement after interrupt" });
    } finally { release(); await pending; }
    expect(core.instance.phase).toBe("active");
    expect(core.close).not.toHaveBeenCalled();
  });

  it("never starts an abort-ignoring model after interruption during durable context retrieval", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const context = { retrieve: vi.fn(async () => { await gate; return []; }) };
    // This adapter intentionally ignores the signal, so its own cancellation
    // protection cannot hide a missing check at the service's spend boundary.
    const stream = vi.fn(async function* () { yield { index: 0, text: "Should never be requested" }; });
    const service = new DefaultConversationService({
      repository: new ConversationRepository(env.DB, new EventRepository(env.DB)),
      model: { stream }, context,
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_voice_outbox_dispatch"); } },
      redactor: new Redactor(), now: () => new Date(NOW),
    });
    const controller = new AbortController();
    const sendToken = vi.fn(async () => undefined);
    const finish = vi.fn(async () => undefined);
    const pending = service.handleTurn({ sessionId: SESSION_ID, turnId: TURN_ID,
      principalId: "principal:owner", text: "Cancel while context is read", signal: controller.signal,
      ...createVoiceStreamDelivery({ sessionId: SESSION_ID, turnId: TURN_ID, sendToken, finish }),
    });
    try {
      await vi.waitFor(() => expect(context.retrieve).toHaveBeenCalledOnce());
      controller.abort();
    } finally { release(); }
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled", sentAssistantEventId: null });
    expect(stream).not.toHaveBeenCalled();
    expect(sendToken).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(await conversationTurn(TURN_ID)).toEqual({ state: "cancelled", sent_assistant_event_id: null, delivered_assistant_event_id: null });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM events WHERE event_type LIKE 'conversation.assistant%'").first())
      .toEqual({ count: 0 });
  });

  it.each(["token", "finish"] as const)("refuses a late %s from a conversation that ignores interruption", async (kind) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const conversation: ConversationService = { handleTurn: vi.fn<ConversationService["handleTurn"]>(async (input) => {
      if (input.channel !== "voice") throw new Error("fixture_voice_required");
      if (kind === "finish") await input.onToken({ index: 0, text: "A partial answer" });
      entered();
      await gate;
      if (kind === "token") await input.onToken({ index: 0, text: "An interrupted answer" });
      else await input.finish("A partial answer");
      return { outcome: "cancelled", committedUserEventId: TURN_ID, sentAssistantEventId: null,
        deliveredAssistantEventId: null, deliveryId: null };
    }), async stageSystemNotice(): Promise<never> { throw new Error("unexpected_voice_notice"); } };
    const repo = repository();
    const stored = await createInboundSession(repo);
    const core = makeCore({ session: stored, repo, conversation });
    await core.instance.handleRelayEvent(relaySetup(stored));
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try { await waiting; await core.instance.handleRelayEvent({ type: "interrupt" }); }
    finally { release(); }
    await expect(pending).rejects.toThrow();
    expect(core.sendToken).toHaveBeenCalledTimes(kind === "token" ? 0 : 1);
    expect(core.finish).not.toHaveBeenCalled();
    expect(core.instance.phase).toBe("active");
  });

  it("keeps a completed response when interruption arrives while its durable receipt is settling", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const conversations = new ConversationRepository(env.DB, new EventRepository(env.DB));
    const record = conversations.recordVoiceSent.bind(conversations);
    const settle = vi.spyOn(conversations, "recordVoiceSent").mockImplementation(async (input) => {
      await gate;
      return record(input);
    });
    const service = new DefaultConversationService({ repository: conversations,
      model: new DefaultModelAdapter(new FakeModelProvider({ streamText: "A completed answer", streamTokenCount: 1 })),
      context: new D1ContextRetriever(env.DB),
      dispatcher: { async dispatch(): Promise<never> { throw new Error("unexpected_voice_outbox_dispatch"); } },
      redactor: new Redactor(), now: () => new Date(NOW),
    });
    const repo = repository();
    const stored = await createInboundSession(repo);
    const core = makeCore({ session: stored, repo, conversation: service });
    await core.instance.handleRelayEvent(relaySetup(stored));
    const pending = core.instance.handleRelayEvent(prompt);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
      expect(core.finish).toHaveBeenCalledExactlyOnceWith("A completed answer");
      await core.instance.handleRelayEvent({ type: "interrupt" });
    } finally { release(); }
    await expect(pending).resolves.toBeUndefined();
    expect(core.instance.phase).toBe("active");
    expect(core.close).not.toHaveBeenCalled();
    expect(await conversationTurn(TURN_ID)).toMatchObject({ state: "voice_sent", sent_assistant_event_id: expect.any(String), delivered_assistant_event_id: null });
  });
});

describe("CallSession production composition", () => {
  let credit: string;
  let creditFails: boolean;
  let telemetryAsOf: string;
  let requests: string[];
  function configuration(): Env & { IDENTITY_CHALLENGE_HMAC_KEY_VERSION: string } {
    return {
      ...env,
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_API_KEY_SID: `SK${"6".repeat(32)}`,
      TWILIO_API_KEY_SECRET: "synthetic-voice-key",
      OWNER_PRINCIPAL_ID: "principal:owner",
      CAPACITY_D1_BUDGET_BYTES: "1000000000",
      CAPACITY_R2_BUDGET_BYTES: "1000000000",
      CAPACITY_MODEL_ALLOCATION_USD: "20",
      CAPACITY_TWILIO_DAILY_BUDGET_USD: "40",
      DEEPSEEK_API_KEY: "synthetic-runtime-key",
      DEEPSEEK_MODEL: "synthetic-runtime-model",
      TELEGRAM_BOT_TOKEN: `123456789:${"s".repeat(35)}`,
      GUEST_PIN_PEPPER_V1: base64(new Uint8Array(32).fill(12)),
      OWNER_PASSPHRASE_PEPPER_V1: base64(OWNER_TEST_PEPPER),
      AUTHENTICATION_BUDGET_PEPPER: base64(PEPPER),
      IDENTITY_CHALLENGE_HMAC_PEPPER: base64(new Uint8Array(32).fill(11)),
      IDENTITY_CHALLENGE_HMAC_KEY_VERSION: "identity-hmac-v1",
    };
  }

  async function runtime(stored: StoredCallSession, configured = configuration(), disabled = false,
    initialization?: CallSessionInitialization) {
    if (initialization === undefined) {
      if (stored.relaySetupExpiresAt === null) throw new Error("fixture_inbound_expiry_missing");
      initialization = { sessionId: stored.sessionId, binding: stored.binding, relaySetupExpiresAt: stored.relaySetupExpiresAt };
    }
    const capturedInitialization = initialization;
    const stub = callSessionStub(stored.sessionId);
    const relay = fakeSocket(stored.sessionId);
    let object: CallSession;
    const restart = () => runInDurableObject(stub, async (_instance, state) => {
      object = disabled ? new CallSession(state, configured, null) : new CallSession(state, configured);
      await object.initialize(capturedInitialization);
    });
    await restart();
    const send = (frame: unknown) => runInDurableObject(stub, async (_instance, state) => {
      await object.webSocketMessage(relay.socket, JSON.stringify(frame));
      // This production-composition harness freezes Date in August 2026.
      // Alarm behavior is covered by the future-clock fake-call tests.
      await state.storage.deleteAlarm();
    });
    return {
      ...relay, restart,
      setup: () => send({ type: "setup", sessionId: PROVIDER_SESSION_ID, accountSid: ACCOUNT_SID,
        callSid: stored.callSid, direction: stored.direction === "outbound" ? "outbound-api" : "inbound",
        customParameters: { relayNonce: stored.binding.relayNonce } }),
      prompt: (voicePrompt: string) => send({ type: "prompt", voicePrompt, lang: "en-US", last: true }),
      digits: async (digits: string) => { for (const digit of digits) await send({ type: "dtmf", digit }); },
    };
  }

  beforeEach(async () => {
    await applyCallStepUpTestMigrations();
    await env.DB.prepare("DELETE FROM capacity_alert_crossings").run();
    await clearFixture();
    await runInDurableObject(callSessionStub(SESSION_ID), async (_instance, state) => { await state.storage.deleteAll(); });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    credit = "15"; creditFails = false; requests = []; telemetryAsOf = NOW.toISOString().replace(".000Z", "+00:00");
    vi.spyOn(globalThis, "fetch").mockImplementation(async function (this: unknown, input, init) {
      // A mock that ignores its receiver would miss workerd's Illegal invocation failure.
      expect(this).toBe(globalThis);
      const url = String(input);
      requests.push(url);
      if (url === "https://api.deepseek.com/user/balance") {
        if (creditFails) throw new Error("synthetic balance unavailable");
        return Response.json({ is_available: true, balance_infos: [{ currency: "USD",
          total_balance: credit, granted_balance: "0", topped_up_balance: credit }] });
      }
      if (url === `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Usage/Records/Today.json?Category=totalprice`) {
        return Response.json({ next_page_uri: null, usage_records: [{ account_sid: ACCOUNT_SID,
          category: "totalprice", price: "1", price_unit: "usd", start_date: "2026-08-30", end_date: "2026-08-30", as_of: telemetryAsOf }] });
      }
      if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { message_id: requests.length } });
      expect(String(input)).toBe("https://api.deepseek.com/chat/completions");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "synthetic-runtime-model", stream: true });
      return new Response('data: {"choices":[{"delta":{"content":"A composed voice reply."}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await env.DB.prepare("DELETE FROM capacity_alert_crossings").run();
    await clearFixture();
  });

  it("serves an owner through the default production runtime and reconstructs its authority after restart", async () => {
    await seedActiveVoiceIdentity();
    const stored = await createInboundSession(repository());
    const call = await runtime(stored);
    await call.setup();
    expect(await storedPhase(stored.sessionId)).toBe("active");
    await call.prompt("A first ordinary question");
    await call.restart();
    await call.prompt("A second ordinary question");
    expect(requests.filter((url) => url === "https://api.deepseek.com/chat/completions")).toHaveLength(2);
    expect(requests.filter((url) => url === "https://api.deepseek.com/user/balance")).toHaveLength(2);
    expect(requests.filter((url) => url.includes("api.twilio.com"))).toHaveLength(2);
    expect(call.close).not.toHaveBeenCalled();
    expect(call.send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toContainEqual({
      type: "text", token: "A composed voice reply.", last: false,
    });
    expect((await env.DB.prepare("SELECT state FROM conversation_turns ORDER BY rowid").all()).results)
      .toEqual([{ state: "voice_sent" }, { state: "voice_sent" }]);
  });

  it("shares the production guest proof issuer with the authority that admits a PIN-authenticated conversation", async () => {
    await seedActiveVoiceIdentity();
    await seedPendingGuestAccess(new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
      new GuestPinVerifier(new Uint8Array(32).fill(12)));
    const stored = await repository().getOrCreateInboundSession({ callSid: CALL_SID, callerE164: GUEST_E164,
      ownerIdentityId: "identity:voice", currentChallengeHmacKeyVersion: "identity-hmac-v1", now: NOW });
    const call = await runtime(stored);
    await call.setup();
    await call.digits("4827");
    expect(await storedPhase(stored.sessionId)).toBe("active");
    await call.prompt("A guest question");
    expect(requests.filter((url) => url === "https://api.deepseek.com/chat/completions")).toHaveLength(1);
    expect(requests.filter((url) => url === "https://api.deepseek.com/user/balance")).toHaveLength(1);
    expect(requests.filter((url) => url.includes("api.twilio.com"))).toHaveLength(1);
    expect(call.close).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT authority_kind, grant_id FROM call_session_authorities WHERE session_id = ?")
      .bind(stored.sessionId).first()).toEqual({ authority_kind: "guest", grant_id: GUEST_GRANT_ID });
  });

  it.each(["credit exhausted", "failed read", "stale report"])("blocks the next model request on %s through the actual production graph", async (fault) => {
    await seedActiveVoiceIdentity();
    await env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:capacity-owner', 'principal:owner', 'telegram', '44112233', 'active', ?, ?)")
      .bind(NOW.toISOString(), NOW.toISOString()).run();
    const call = await runtime(await createInboundSession(repository()));
    await call.setup();
    await call.prompt("First permitted question");
    expect(call.close).not.toHaveBeenCalled();
    if (fault === "credit exhausted") credit = "0";
    else if (fault === "failed read") creditFails = true;
    else telemetryAsOf = "2026-08-30T11:59:00+00:00";
    await call.prompt("Second refused question");
    expect(requests.filter((url) => url === "https://api.deepseek.com/user/balance")).toHaveLength(2);
    expect(requests.filter((url) => url === "https://api.deepseek.com/chat/completions")).toHaveLength(1);
    expect(call.close).toHaveBeenCalledExactlyOnceWith(1011, "relay processing failed");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM conversation_turns").first()).toEqual({ count: 1 });
    const receipts = (await env.DB.prepare("SELECT state FROM capacity_alert_crossings").all()).results;
    expect(receipts).toEqual(fault === "credit exhausted" ? [{ state: "sent" }, { state: "sent" }] : []);
  });

  it.each(["CAPACITY_D1_BUDGET_BYTES", "CAPACITY_R2_BUDGET_BYTES", "CAPACITY_MODEL_ALLOCATION_USD",
    "CAPACITY_TWILIO_DAILY_BUDGET_USD"] as const)
    ("keeps the default relay closed without owner configuration %s", async (field) => {
      await seedActiveVoiceIdentity();
      const configured = configuration();
      delete configured[field];
      const call = await runtime(await createInboundSession(repository()), configured);
      await call.setup();
      expect(call.close).toHaveBeenCalledExactlyOnceWith(1011, "relay runtime unavailable");
      expect(requests).toEqual([]);
    });

  it("shares the production owner authority with confirmed access administration without calling the model", async () => {
    await seedActiveVoiceIdentity();
    await seedActiveOwnerPassphrase();
    await seedActiveOwnerCallPin();
    const stored = await createInboundSession(repository(), "hmac-v1", true);
    const call = await runtime(stored);
    await call.setup();
    // Admission asks for nothing, so the credential is demanded at the change.
    expect(await storedPhase(stored.sessionId)).toBe("active");
    await call.prompt(`allow ${GUEST_E164} with conversation`);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first()).toEqual({ count: 0 });
    await call.digits(OWNER_TEST_PIN);
    await call.digits("2468");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM voice_access_grants").first()).toEqual({ count: 0 });
    await call.prompt("confirm");
    expect(await env.DB.prepare("SELECT status FROM voice_access_grants").first()).toEqual({ status: "pending" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(call.close).not.toHaveBeenCalled();
  });

  it("shares the production activation observation issuer and configured key version with challenge confirmation", async () => {
    await beginPhoneChallenge();
    const stored = await createInboundSession(repository(), "identity-hmac-v1");
    const call = await runtime(stored);
    await call.setup();
    await call.digits(CHALLENGE_RESPONSE);
    expect(await identityState()).toEqual({ status: "active", verified_at: NOW.toISOString() });
    expect(await challengeConsumedAt()).toBe(NOW.toISOString());
    expect(await reservationKinds()).toEqual(["activation"]);
    expect(await storedPhase(stored.sessionId)).toBe("completed");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps an explicit null runtime disabled even with complete production configuration", async () => {
    await seedActiveVoiceIdentity();
    const stored = await createInboundSession(repository());
    const call = await runtime(stored, configuration(), true);
    await call.setup();
    expect(call.close).toHaveBeenCalledExactlyOnceWith(1011, "relay runtime unavailable");
    expect(await storedPhase(stored.sessionId)).toBe("created");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("forwards the outbound pre-authentication contract into the production runtime", async () => {
    const stamp = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS stamp").first<string>("stamp");
    const databaseNow = new Date(stamp!);
    vi.setSystemTime(databaseNow);
    await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 1").run();
    const system = await createFakeCallingSystem({ now: databaseNow });
    try {
      await system.dispatch();
      expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
      const initialization = system.initializations()[0];
      if (initialization === undefined) throw new Error("fixture_outbound_initialization_missing");
      const stored = await repository().getCallSession(initialization.sessionId);
      if (stored === null) throw new Error("fixture_outbound_session_missing");
      const call = await runtime(stored, configuration(), false, initialization);
      await call.setup();
      expect(call.send.mock.calls.map(([frame]) => JSON.parse(String(frame)))[0])
        .toEqual({ type: "text", token: OUTBOUND_VOICEMAIL_MESSAGE, last: true });
      // The called party answers and the owner is in conversation: no spoken
      // credential is part of an outbound call's admission any more.
      expect(await storedPhase(stored.sessionId)).toBe("active");
      expect(call.close).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await system.cleanup();
      await env.DB.prepare("UPDATE outbound_runtime_controls SET enabled = 0").run();
    }
  });

  it.each([
    ["missing account", "TWILIO_ACCOUNT_SID", ""],
    ["wrong account type", "TWILIO_ACCOUNT_SID", `SK${"6".repeat(32)}`],
    ["missing model key", "DEEPSEEK_API_KEY", ""],
    ["whitespace model key", "DEEPSEEK_API_KEY", " synthetic-runtime-key"],
    ["oversized model key", "DEEPSEEK_API_KEY", "s".repeat(4097)],
    ["oversized model id", "DEEPSEEK_MODEL", "s".repeat(129)],
    ["control in model id", "DEEPSEEK_MODEL", "synthetic\nmodel"],
    ["missing bot token", "TELEGRAM_BOT_TOKEN", ""],
    ["oversized bot token", "TELEGRAM_BOT_TOKEN", `123456789:${"s".repeat(4097)}`],
    ["missing challenge version", "IDENTITY_CHALLENGE_HMAC_KEY_VERSION", ""],
    ["oversized challenge version", "IDENTITY_CHALLENGE_HMAC_KEY_VERSION", "s".repeat(65)],
    ["control in challenge version", "IDENTITY_CHALLENGE_HMAC_KEY_VERSION", "v1\nv2"],
    ...["GUEST_PIN_PEPPER_V1", "OWNER_PASSPHRASE_PEPPER_V1", "AUTHENTICATION_BUDGET_PEPPER", "IDENTITY_CHALLENGE_HMAC_PEPPER"].flatMap((key) => [
      [`short ${key}`, key, base64(new Uint8Array(31))],
      [`long ${key}`, key, base64(new Uint8Array(33))],
      [`noncanonical ${key}`, key, `${"A".repeat(42)}B=`],
      [`whitespace ${key}`, key, ` ${base64(new Uint8Array(32))}`],
    ]),
  ])("refuses %s before runtime effects while keeping initialization available", async (_label, key, value) => {
    if (key === undefined) throw new Error("fixture_configuration_key_missing");
    await seedActiveVoiceIdentity();
    const configured = { ...configuration(), [key]: value };
    expect(() => readVoiceRuntimeConfiguration(configured)).toThrow("voice_runtime_configuration_invalid");
    const stored = await createInboundSession(repository());
    const call = await runtime(stored, configured);
    await call.setup();
    expect(call.close).toHaveBeenCalledExactlyOnceWith(1011, "relay runtime unavailable");
    expect(await storedPhase(stored.sessionId)).toBe("created");
    expect(await reservationCount()).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("accepts the exact configured bounds and keeps the guest default optional", () => {
    const configured = configuration();
    configured.DEEPSEEK_API_KEY = "s".repeat(4096);
    configured.DEEPSEEK_MODEL = "s".repeat(128);
    configured.TELEGRAM_BOT_TOKEN = `123456789:${"s".repeat(4096)}`;
    configured.IDENTITY_CHALLENGE_HMAC_KEY_VERSION = "s".repeat(64);
    delete configured.DEFAULT_GUEST_PIN;
    expect(readVoiceRuntimeConfiguration(configured)).toMatchObject({
      modelApiKey: configured.DEEPSEEK_API_KEY, model: configured.DEEPSEEK_MODEL,
      telegramToken: configured.TELEGRAM_BOT_TOKEN, challengeKeyVersion: configured.IDENTITY_CHALLENGE_HMAC_KEY_VERSION,
    });
  });
});

describe("CallSession Durable Object boundary", () => {
  beforeEach(async () => {
    await applyCallStepUpTestMigrations();
    await clearFixture();
    await runInDurableObject(callSessionStub(SESSION_ID), async (_instance, state) => {
      await state.storage.deleteAll();
    });
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

  it("terminalizes through the exact idempotent callback RPC and rejects conflicting replay", async () => {
    const harness = await accessHarness("owner");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    const initialization: CallSessionInitialization = Object.freeze({
      sessionId: harness.stored.sessionId,
      binding: harness.stored.binding,
      relaySetupExpiresAt: harness.stored.relaySetupExpiresAt,
    });
    const stub = callSessionStub(initialization.sessionId);
    await stub.initialize(initialization);
    const termination = Object.freeze({
      sessionId: initialization.sessionId,
      phase: "completed" as const,
      reason: "provider_callback" as const,
    });

    await expect(stub.terminate(termination)).resolves.toEqual({
      sessionId: initialization.sessionId,
      terminalPhase: "completed",
      invalidated: true,
      outcome: "applied",
    });
    await expect(stub.terminate(termination)).resolves.toEqual({
      sessionId: initialization.sessionId,
      terminalPhase: "completed",
      invalidated: false,
      outcome: "replayed",
    });
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.terminate({
        sessionId: initialization.sessionId,
        phase: "failed",
        reason: "provider_callback",
      })).rejects.toThrow("call_session_termination_conflict");
    });
    expect(await storedPhase(initialization.sessionId)).toBe("completed");
    await expect(harness.repo.countActiveSessions({
      principalId: harness.stored.binding.principalId,
      now: NOW,
    })).resolves.toBe(0);
    await expect(new VoiceAccessAuthorityService(
      new VoiceAccessRepository(env.DB),
      new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] }),
    ).rehydrate({ sessionId: initialization.sessionId, binding: initialization.binding, now: NOW }))
      .rejects.toThrow("call_authority_invalid");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("call-session.termination.v1")).toMatchObject({
        ...termination,
        callSid: initialization.binding.callSid,
        providerSessionId: PROVIDER_SESSION_ID,
        durablePhase: "completed",
        cleanupState: "complete",
      });
    });
  });

  it("treats a provider-completed pre-authentication hangup as rejected and releases capacity", async () => {
    const harness = await accessHarness("guest");
    await harness.instance.handleRelayEvent(relaySetup(harness.stored));
    expect(await storedPhase(harness.stored.sessionId)).toBe("pre_auth");
    await expect(harness.repo.countActiveSessions({
      principalId: harness.stored.binding.principalId,
      now: NOW,
    })).resolves.toBe(1);
    const initialization: CallSessionInitialization = Object.freeze({
      sessionId: harness.stored.sessionId,
      binding: harness.stored.binding,
      relaySetupExpiresAt: harness.stored.relaySetupExpiresAt,
    });
    const stub = callSessionStub(initialization.sessionId);
    await stub.initialize(initialization);

    await expect(stub.terminate({
      sessionId: initialization.sessionId,
      phase: "completed",
      reason: "provider_callback",
    })).resolves.toMatchObject({
      terminalPhase: "completed",
      invalidated: true,
      outcome: "applied",
    });

    expect(await storedPhase(initialization.sessionId)).toBe("rejected");
    await expect(harness.repo.countActiveSessions({
      principalId: harness.stored.binding.principalId,
      now: NOW,
    })).resolves.toBe(0);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("call-session.termination.v1")).toMatchObject({
        durablePhase: "rejected",
        cleanupState: "complete",
      });
    });
  });

  it("fails closed before a tombstone when initialization does not exactly match the durable relay binding", async () => {
    const repo = repository();
    const stored = await createInboundSession(repo);
    await repo.bindRelaySession({
      sessionId: stored.sessionId,
      callSid: stored.callSid,
      providerSessionId: PROVIDER_SESSION_ID,
      relayNonce: stored.binding.relayNonce,
      direction: "inbound",
      now: NOW,
    });
    const initialization: CallSessionInitialization = Object.freeze({
      sessionId: stored.sessionId,
      binding: Object.freeze({ ...stored.binding, callSid: `CA${"8".repeat(32)}` }),
      relaySetupExpiresAt: stored.relaySetupExpiresAt,
    });
    const stub = callSessionStub(stored.sessionId);
    await stub.initialize(initialization);

    await runInDurableObject(stub, async (instance) => {
      await expect(instance.terminate({
        sessionId: stored.sessionId,
        phase: "failed",
        reason: "provider_callback",
      })).rejects.toThrow("call_session_termination_binding_mismatch");
    });
    expect(await storedPhase(stored.sessionId)).toBe("created");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("call-session.termination.v1")).toBeUndefined();
    });
  });

  it.each(["rejected", "expired"] as const)(
    "cleans up a live core already durably %s and replays without double provider cleanup",
    async (durablePhase) => {
      const harness = await accessHarness("guest");
      const initialization: CallSessionInitialization = Object.freeze({
        sessionId: harness.stored.sessionId,
        binding: harness.stored.binding,
        relaySetupExpiresAt: harness.stored.relaySetupExpiresAt,
      });
      const stub = callSessionStub(harness.stored.sessionId);
      const relay = fakeSocket(harness.stored.sessionId);
      const cancelOutput = vi.fn(async () => undefined);
      const factory = vi.fn<CallSessionRuntimeFactory>((input) => new CallSessionCore({
        capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
        session: input.session,
        expectedAccountSid: ACCOUNT_SID,
        repository: harness.repo,
        authority: harness.authority,
        guestAuthentication: harness.guestAuthentication,
        activation: null,
        conversation: null,
        relay: {
          close: vi.fn(),
          sendNeutralText: async () => undefined,
          sendToken: async () => undefined,
          finish: async () => undefined,
          cancelOutput,
        },
        now: () => new Date(NOW),
      }));
      const frame = JSON.stringify({
        type: "setup",
        sessionId: PROVIDER_SESSION_ID,
        accountSid: ACCOUNT_SID,
        callSid: harness.stored.callSid,
        direction: "inbound",
        customParameters: { relayNonce: harness.stored.binding.relayNonce },
      });

      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAll();
        const object = new CallSession(state, env, factory);
        await object.initialize(initialization);
        await object.webSocketMessage(relay.socket, frame);
        expect(await storedPhase(harness.stored.sessionId)).toBe("pre_auth");
        await harness.repo.transitionCallSession({
          sessionId: harness.stored.sessionId,
          expectedPhase: "pre_auth",
          nextPhase: durablePhase,
          now: NOW,
        });
        const termination = Object.freeze({
          sessionId: harness.stored.sessionId,
          phase: "failed" as const,
          reason: "provider_callback" as const,
        });
        await expect(object.terminate(termination)).resolves.toMatchObject({
          terminalPhase: "failed",
          invalidated: true,
          outcome: "applied",
        });
        await expect(object.terminate(termination)).resolves.toMatchObject({
          terminalPhase: "failed",
          invalidated: false,
          outcome: "replayed",
        });
      });

      expect(await storedPhase(harness.stored.sessionId)).toBe(durablePhase);
      expect(cancelOutput).toHaveBeenCalledOnce();
    },
  );

  it("keeps cleanup pending on provider failure, retries once, and never cleans twice after completion", async () => {
    const harness = await accessHarness("guest");
    const initialization: CallSessionInitialization = Object.freeze({
      sessionId: harness.stored.sessionId,
      binding: harness.stored.binding,
      relaySetupExpiresAt: harness.stored.relaySetupExpiresAt,
    });
    const stub = callSessionStub(harness.stored.sessionId);
    const relay = fakeSocket(harness.stored.sessionId);
    const cancelOutput = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("provider_cleanup_failed"))
      .mockResolvedValue(undefined);
    const factory = vi.fn<CallSessionRuntimeFactory>((input) => new CallSessionCore({
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session: input.session,
      expectedAccountSid: ACCOUNT_SID,
      repository: harness.repo,
      authority: harness.authority,
      guestAuthentication: harness.guestAuthentication,
      activation: null,
      conversation: null,
      relay: {
        close: vi.fn(),
        sendNeutralText: async () => undefined,
        sendToken: async () => undefined,
        finish: async () => undefined,
        cancelOutput,
      },
      now: () => new Date(NOW),
    }));
    const termination = Object.freeze({
      sessionId: harness.stored.sessionId,
      phase: "failed" as const,
      reason: "provider_callback" as const,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      const object = new CallSession(state, env, factory);
      await object.initialize(initialization);
      await object.webSocketMessage(relay.socket, JSON.stringify({
        type: "setup",
        sessionId: PROVIDER_SESSION_ID,
        accountSid: ACCOUNT_SID,
        callSid: harness.stored.callSid,
        direction: "inbound",
        customParameters: { relayNonce: harness.stored.binding.relayNonce },
      }));
      await expect(object.terminate(termination)).rejects.toThrow("call_session_termination_cleanup_failed");
      expect(await state.storage.get("call-session.termination.v1")).toMatchObject({ cleanupState: "pending" });
      const recovered = object.terminate(termination);
      const duplicate = object.terminate(termination);
      await expect(object.terminate({ ...termination, phase: "completed" }))
        .rejects.toThrow("call_session_termination_conflict");
      await expect(Promise.all([recovered, duplicate])).resolves.toEqual([
        expect.objectContaining({ invalidated: false, outcome: "recovered" }),
        expect.objectContaining({ invalidated: false, outcome: "recovered" }),
      ]);
      await expect(object.terminate(termination)).resolves.toMatchObject({ outcome: "replayed" });
      expect(await state.storage.get("call-session.termination.v1")).toMatchObject({ cleanupState: "complete" });
    });

    expect(await storedPhase(harness.stored.sessionId)).toBe("failed");
    expect(cancelOutput).toHaveBeenCalledTimes(2);
  });

  it("finishes a durable pending cleanup after object restart", async () => {
    const harness = await accessHarness("guest");
    const initialization: CallSessionInitialization = Object.freeze({
      sessionId: harness.stored.sessionId,
      binding: harness.stored.binding,
      relaySetupExpiresAt: harness.stored.relaySetupExpiresAt,
    });
    const stub = callSessionStub(harness.stored.sessionId);
    const relay = fakeSocket(harness.stored.sessionId);
    const cancelOutput = vi.fn(async () => { throw new Error("provider_cleanup_failed"); });
    const factory = vi.fn<CallSessionRuntimeFactory>((input) => new CallSessionCore({
      capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
      session: input.session,
      expectedAccountSid: ACCOUNT_SID,
      repository: harness.repo,
      authority: harness.authority,
      guestAuthentication: harness.guestAuthentication,
      activation: null,
      conversation: null,
      relay: {
        close: vi.fn(),
        sendNeutralText: async () => undefined,
        sendToken: async () => undefined,
        finish: async () => undefined,
        cancelOutput,
      },
      now: () => new Date(NOW),
    }));
    const termination = Object.freeze({
      sessionId: harness.stored.sessionId,
      phase: "failed" as const,
      reason: "provider_callback" as const,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      const first = new CallSession(state, env, factory);
      await first.initialize(initialization);
      await first.webSocketMessage(relay.socket, JSON.stringify({
        type: "setup",
        sessionId: PROVIDER_SESSION_ID,
        accountSid: ACCOUNT_SID,
        callSid: harness.stored.callSid,
        direction: "inbound",
        customParameters: { relayNonce: harness.stored.binding.relayNonce },
      }));
      await expect(first.terminate(termination)).rejects.toThrow("call_session_termination_cleanup_failed");

      const restarted = new CallSession(state, env, null);
      await expect(restarted.terminate(termination)).resolves.toMatchObject({
        invalidated: false,
        outcome: "recovered",
      });
      expect(await state.storage.get("call-session.termination.v1")).toMatchObject({ cleanupState: "complete" });
    });

    expect(cancelOutput).toHaveBeenCalledOnce();
    expect(await storedPhase(harness.stored.sessionId)).toBe("failed");
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
      return new CallSessionCore({
        capacity: { async assertAcceptingNewTurn(): Promise<void> {} },
        session: input.session,
        expectedAccountSid: ACCOUNT_SID,
        repository: repo,
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

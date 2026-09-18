import { permittedOutboundControls } from "../../../apps/cloud-gateway/test/policy/outbound-controls-fixture.js";
import { env } from "cloudflare:test";
import { CapacityGuard } from "../../../apps/cloud-gateway/src/archive/capacity-guard.js";
import type { OutboundCallCommand, Sha256Hex, Ulid } from "../../../packages/contracts/src/index.js";
import {
  OutboundCallDispatcher,
  type OutboundCallDispatchResult,
} from "../../../apps/cloud-gateway/src/calls/outbound-call-dispatcher.js";
import { D1TwilioCallbackRecorder } from "../../../apps/cloud-gateway/src/http/voice-callback-recorder.js";
import { createVoiceRouteDependencies } from "../../../apps/cloud-gateway/src/http/voice-route-construction.js";
import { routeVoiceRequest } from "../../../apps/cloud-gateway/src/http/voice-routes.js";
import { CallRepository, type DispatchIntent } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { OwnerPassphraseRepository } from "../../../apps/cloud-gateway/src/persistence/owner-passphrase-repository.js";
import { OwnerPassphraseVerifier } from "../../../apps/cloud-gateway/src/security/owner-passphrase-verifier.js";
import { OwnerCallStepUpService } from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { FakeTwilioProvider } from "../../../apps/cloud-gateway/src/providers/fake-twilio-provider.js";
import type { CallSessionInitialization, CallSessionTermination } from "../../../apps/cloud-gateway/src/voice/call-session-do.js";
import { FakeRelaySessions, type FakeRelayCall } from "./voice-relay-system.js";
import { FAKE_OWNER_PASSPHRASE, FAKE_OWNER_PASSPHRASE_PEPPER } from "./voice-access-system.js";
import type {
  DispatchPolicyCheck,
  OutboundCallRequest,
  PolicyDecision,
  PolicyEngineContract,
} from "../../../apps/cloud-gateway/src/policy/policy-types.js";
import { D1OutboundRecipientIdentityLookup } from "../../../apps/cloud-gateway/src/voice/outbound-recipient-lookup.js";
import {
  dispatchOutboundCall,
  type OutboundSessionInitialization,
} from "../../../apps/cloud-gateway/src/voice/outbound.js";
import {
  applyOwnerCallStepUpMigration,
  clearOwnerCallStepUpDataForTest,
  clearOwnerPassphraseDataForTest,
  clearAuthenticationAttemptReservationsForTest,
  clearCallSessionsForTest,
  clearConversationDataForTest,
  clearOutboundCallAttemptsForTest,
  clearVoiceAccessDataForTest,
} from "../../../apps/cloud-gateway/test/persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
const ATTEMPT_ID = "01k3s6k8000000000000000001" as Ulid;
const CHECK_ID = "01k3s6k8000000000000000002" as Ulid;
const DESTINATION = "+14165550123";

class AllowPolicy implements PolicyEngineContract {
  constructor(private readonly now = NOW) {}
  async evaluateOutboundCall(): Promise<PolicyDecision> {
    return { decision: "allow", reason: "allowed" };
  }

  async recheckOutboundDispatch(request: OutboundCallRequest, attemptId: Ulid): Promise<DispatchPolicyCheck> {
    return {
      decision: "allow",
      reason: "allowed",
      checkedAt: this.now.toISOString(),
      checkId: CHECK_ID,
      attemptId,
      destinationE164: DESTINATION,
      commandId: request.commandId,
    };
  }
}

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearOwnerCallStepUpDataForTest();
  await clearCallSessionsForTest();
  await clearAuthenticationAttemptReservationsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearConversationDataForTest();
  await clearOwnerPassphraseDataForTest();
  await clearVoiceAccessDataForTest();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM device_keys"),
    env.DB.prepare("DELETE FROM channel_identities"),
    env.DB.prepare("DELETE FROM policy_decisions"),
    env.DB.prepare("DELETE FROM principals"),
  ]);
}

async function seedAuthorizedCommand(principalId: string, now: Date): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES (?, 'human', 'active', 'Owner', ?, ?)").bind(principalId, timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', ?, 'voice', ?, 'active', ?, ?)").bind(principalId, DESTINATION, timestamp, timestamp),
    env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, ?, 'identity:voice', ?)").bind(principalId, timestamp),
    env.DB.prepare(`INSERT INTO device_keys (
      device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation,
      algorithm, status, device_label, bootstrap_metadata_hash, created_at
    ) VALUES ('device:home', ?, 'key:home', ?, ?, 1, 'ed25519', 'active', 'home', ?, ?)`)
      .bind(principalId, `${"A".repeat(43)}=`, "1".repeat(64), "2".repeat(64), timestamp),
    env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, ?, 'v1', ?, 'allow', 'allowed', ?)").bind(COMMAND_ID, principalId, "b".repeat(64), timestamp),
  ]);
  const verifier = new OwnerPassphraseVerifier(FAKE_OWNER_PASSPHRASE_PEPPER(), "v1", () => new Uint8Array(16).fill(7));
  const record = await verifier.create("identity:voice", 1, FAKE_OWNER_PASSPHRASE);
  await new OwnerPassphraseRepository(env.DB).rotate({
    verified: {
      deviceId: "device:home", principalId, audience: "jarvis-local-agent",
      issuedAt: timestamp, nonce: "n", bodyHash: "3".repeat(64) as Sha256Hex, keyId: "key:home",
      keyFingerprint: "1".repeat(64) as Sha256Hex, keyGeneration: 1, body: {},
    },
    ownerPrincipalId: principalId, ownerIdentityId: "identity:voice", expectedVerifierVersion: null,
    record, commitId: "01m2ccccccccccccccccccc001", committedAt: timestamp,
  });
}

function command(now: Date): OutboundCallCommand {
  return {
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    purposeCode: "user_requested",
    destinationIdentityId: "identity:voice",
    urgency: "normal",
    authorizationExpiresAt: new Date(now.valueOf() + 600_000).toISOString(),
    idempotencyKey: "call:fake-acceptance",
    issuedBy: "local_cli",
  };
}

async function signedPost(fake: FakeTwilioProvider, route: string, exactUrl: string, body: string): Promise<Request> {
  const rawBody = new TextEncoder().encode(body);
  // Twilio consumes connection overrides itself; URL fragments are neither
  // sent on the HTTP request nor included in X-Twilio-Signature.
  const deliveredUrl = new URL(exactUrl);
  deliveredUrl.hash = "";
  return new Request(`https://worker.internal${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": await fake.signWebhook(deliveredUrl.href, rawBody),
    },
    body: rawBody,
  });
}

export interface FakeOutboundCallingSystem {
  readonly attemptId: Ulid;
  readonly destination: string;
  dispatch(): Promise<OutboundCallDispatchResult>;
  acceptedCallSid(): string;
  sendStatus(callSid: string, callStatus: string, sequenceNumber: number): Promise<Response>;
  claimOutboundTwiML(callSid: string): Promise<Response>;
  dispatchIntent(): Promise<DispatchIntent>;
  twilioRequests(): readonly unknown[];
  initializations(): readonly Readonly<OutboundSessionInitialization>[];
  cleanup(): Promise<void>;
}

export interface FakeCallingSystem extends FakeOutboundCallingSystem {
  inbound(caller?: string, stirVerstat?: string | readonly string[]): Promise<Response>;
  openRelay(): Promise<FakeRelayCall>;
  pinAttempts(): Promise<number>;
  conversationTurnCount(): Promise<number>;
  ownerStepUpAttempts(sessionId: Ulid): Promise<number>;
  advanceTime(milliseconds: number): void;
  sendRelayEnded(callSid: string, sessionStatus: string, providerSessionId?: string, handoffData?: string): Promise<Response>;
  terminations(): readonly CallSessionTermination[];
  terminationRecord(sessionId: Ulid): Promise<unknown>;
}

export async function createFakeCallingSystem(input: {
  now?: Date;
  ownerPrincipalId?: string;
  ownerCallerIdPolicy?: string;
  loseDispatchResponse?: boolean;
  manualModel?: boolean;
  beforeOwnerStepUpAlert?: () => Promise<void>;
  beforeTermination?: (input: CallSessionTermination) => Promise<void>;
  beforeOutboundSessionCreate?: () => Promise<void>;
  beforeSessionInitialize?: () => Promise<void>;
} = {}): Promise<FakeCallingSystem> {
  const now = new Date(input.now ?? NOW);
  await applyOwnerCallStepUpMigration();
  await clearFixture();
  await seedAuthorizedCommand(input.ownerPrincipalId ?? "principal:owner", now);
  const policy = new AllowPolicy(now);
  const twilio = new FakeTwilioProvider();
  if (input.loseDispatchResponse === true) twilio.acceptAndLoseNextResponse();
  const repository = new CallRepository(env.DB, new EventRepository(env.DB));
  const ownerStepUp = new OwnerCallStepUpService(
    env.DB, new OwnerPassphraseVerifier(FAKE_OWNER_PASSPHRASE_PEPPER(), "v1"),
  );
  let inboundSequence = 100;
  const relays = new FakeRelaySessions(repository,
    { manual: input.manualModel ?? false, streamText: "A safe voice answer." }, () => new Date(now),
    input.beforeOwnerStepUpAlert);
  const dispatcher = new OutboundCallDispatcher({
      controls: permittedOutboundControls,
      capacity: { async assertAcceptingNewTurn() {} },
    policy,
    twilio,
    repository,
    publicBaseUrl: new URL("https://jarvis.example/"),
    newAttemptId: () => ATTEMPT_ID,
    now: () => now,
  });
  const initializationLog: Readonly<OutboundSessionInitialization>[] = [];
  let lastSessionId: Ulid | undefined;
  const terminationLog: CallSessionTermination[] = [];
  let relayAction = "https://jarvis.example/voice/relay-ended";
  const rememberAction = async (response: Response): Promise<Response> => {
    const action = (await response.clone().text()).match(/<Connect action="([^"]+)"/u)?.[1];
    if (action !== undefined) relayAction = action.replaceAll("&amp;", "&");
    return response;
  };
  const initializeSession = async (initialization: Readonly<CallSessionInitialization>): Promise<void> => {
    await input.beforeSessionInitialize?.();
    await relays.initialize(initialization);
    lastSessionId = initialization.sessionId;
  };
  const callbacks = new D1TwilioCallbackRecorder({
    database: env.DB,
    calls: repository,
    now: () => now,
    terminateSession: async (termination) => {
      terminationLog.push(termination);
      await input.beforeTermination?.(termination);
      return relays.terminate(termination);
    },
  });
  const routeDependencies = createVoiceRouteDependencies({
    publicOrigin: new URL("https://jarvis.example/"),
    twilio,
    capacity: new CapacityGuard({
      source: { readEstimates: async () => ["d1", "r2", "provider:deepseek"].map((resource) => ({
        resource: resource as "d1" | "r2" | "provider:deepseek",
        used: 1, budget: 100, observedAt: now.toISOString(),
      })) },
      sink: { emit: async () => undefined, rearm: async () => undefined },
      now: () => new Date(now),
      maximumTelemetryAgeMs: 60_000,
    }),
    inbound: {
      expectedInboundE164: "+14165550100",
      ownerIdentityId: "identity:voice",
      currentChallengeHmacKeyVersion: "hmac-v1",
      ownerCallerIdPolicy: input.ownerCallerIdPolicy,
      ownerStepUp,
      ownerStepUpAlerts: { async alert(): Promise<void> {} },
      sessions: repository,
      initializeSession,
      now: () => new Date(now),
    },
    outbound: {
      ownerIdentityId: "identity:voice",
      recipients: new D1OutboundRecipientIdentityLookup(env.DB),
      calls: {
        claimExpectedCall: repository.claimExpectedCall.bind(repository),
        getOrCreateOutboundSession: async (request) => {
          await input.beforeOutboundSessionCreate?.();
          return repository.getOrCreateOutboundSession(request);
        },
      },
      ownerStepUp,
      ownerStepUpAlerts: { async alert(): Promise<void> {} },
      initializeSession: async (initialization) => {
        await initializeSession(initialization);
        initializationLog.push(initialization);
      },
      now: () => now,
    },
    callbacks,
    relaySession: (request, sessionId) => relays.upgrade(request, sessionId),
  });

  return Object.freeze({
    inbound: async (caller = DESTINATION, stirVerstat?: string | readonly string[]) => routeVoiceRequest(
      await signedPost(twilio, "/voice/inbound", "https://jarvis.example/voice/inbound",
        new URLSearchParams([
          ["From", caller], ["To", "+14165550100"],
          ["CallSid", `CA${(++inboundSequence).toString(16).padStart(32, "0")}`],
          ...stirVerstat === undefined ? [] : (Array.isArray(stirVerstat) ? stirVerstat : [stirVerstat])
            .map((value) => ["StirVerstat", value] as [string, string]),
        ]).toString()),
      routeDependencies,
    ).then(rememberAction),
    openRelay: async () => {
      if (lastSessionId === undefined) throw new Error("fake_call_not_initialized");
      const exactUrl = `wss://jarvis.example/voice/relay/${lastSessionId}`;
      const response = await routeVoiceRequest(new Request(`https://worker.internal/voice/relay/${lastSessionId}`, {
        headers: { Upgrade: "websocket", "x-twilio-signature": await twilio.signWebSocket(exactUrl) },
      }), routeDependencies);
      return relays.call(lastSessionId, response.status);
    },
    pinAttempts: async () => (await env.DB.prepare("SELECT COUNT(*) AS count FROM authentication_attempt_reservations")
      .first<{ count: number }>())?.count ?? 0,
    attemptId: ATTEMPT_ID,
    destination: DESTINATION,
    dispatch: () => dispatchOutboundCall(command(now), { policy, dispatcher }),
    acceptedCallSid: () => {
      const accepted = twilio.acceptedCalls[0];
      if (accepted === undefined) throw new Error("fake_call_not_accepted");
      return accepted.callSid;
    },
    sendStatus: async (callSid: string, callStatus: string, sequenceNumber: number) => routeVoiceRequest(
      await signedPost(
        twilio,
        `/voice/status/${ATTEMPT_ID}`,
        twilio.requests[0]?.statusCallbackUrl.href ?? `https://jarvis.example/voice/status/${ATTEMPT_ID}`,
        `CallSid=${callSid}&CallbackSource=call-progress-events&SequenceNumber=${sequenceNumber}&CallStatus=${callStatus}`,
      ),
      routeDependencies,
    ),
    sendRelayEnded: async (callSid: string, sessionStatus: string, providerSessionId = relays.providerSessionId(callSid), handoffData?: string) => routeVoiceRequest(
      await signedPost(twilio, "/voice/relay-ended", relayAction,
        new URLSearchParams({ CallSid: callSid, SessionId: providerSessionId, SessionStatus: sessionStatus,
          SessionDuration: "17", ...(handoffData === undefined ? {} : { HandoffData: handoffData }) }).toString()),
      routeDependencies,
    ),
    terminations: () => [...terminationLog],
    terminationRecord: (sessionId: Ulid) => relays.terminationRecord(sessionId),
    claimOutboundTwiML: async (callSid: string) => routeVoiceRequest(
      await signedPost(
        twilio,
        `/voice/outbound/${ATTEMPT_ID}`,
        `https://jarvis.example/voice/outbound/${ATTEMPT_ID}`,
        `CallSid=${callSid}&To=${encodeURIComponent(DESTINATION)}`,
      ),
      routeDependencies,
    ).then(rememberAction),
    dispatchIntent: () => repository.resolveDispatchIntent(COMMAND_ID),
    conversationTurnCount: async () => (await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns")
      .first<{ count: number }>())?.count ?? 0,
    ownerStepUpAttempts: async (sessionId: Ulid) => (await env.DB.prepare(
      "SELECT count(*) AS count FROM owner_call_step_up_attempts WHERE session_id = ?",
    ).bind(sessionId).first<{ count: number }>())?.count ?? 0,
    advanceTime: (milliseconds: number) => { now.setTime(now.valueOf() + milliseconds); },
    twilioRequests: () => twilio.requests,
    initializations: () => Object.freeze([...initializationLog]),
    cleanup: async () => { await relays.cleanup(); await clearFixture(); },
  });
}

export function createFakeOutboundCallingSystem(input: { loseDispatchResponse?: boolean } = {}): Promise<FakeOutboundCallingSystem> {
  return createFakeCallingSystem(input);
}

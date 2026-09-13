import { env } from "cloudflare:test";
import { CapacityGuard } from "../../../apps/cloud-gateway/src/archive/capacity-guard.js";
import type { OutboundCallCommand, Ulid } from "../../../packages/contracts/src/index.js";
import {
  OutboundCallDispatcher,
  type OutboundCallDispatchResult,
} from "../../../apps/cloud-gateway/src/calls/outbound-call-dispatcher.js";
import { D1TwilioCallbackRecorder } from "../../../apps/cloud-gateway/src/http/voice-callback-recorder.js";
import { createVoiceRouteDependencies } from "../../../apps/cloud-gateway/src/http/voice-route-construction.js";
import { routeVoiceRequest } from "../../../apps/cloud-gateway/src/http/voice-routes.js";
import { CallRepository, type DispatchIntent } from "../../../apps/cloud-gateway/src/persistence/call-repository.js";
import { EventRepository } from "../../../apps/cloud-gateway/src/persistence/event-repository.js";
import { FakeTwilioProvider } from "../../../apps/cloud-gateway/src/providers/fake-twilio-provider.js";
import type { CallSessionInitialization, CallSessionTermination } from "../../../apps/cloud-gateway/src/voice/call-session-do.js";
import { FakeRelaySessions, type FakeRelayCall } from "./voice-relay-system.js";
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
  applyFoundationMigration,
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
  async evaluateOutboundCall(): Promise<PolicyDecision> {
    return { decision: "allow", reason: "allowed" };
  }

  async recheckOutboundDispatch(request: OutboundCallRequest, attemptId: Ulid): Promise<DispatchPolicyCheck> {
    return {
      decision: "allow",
      reason: "allowed",
      checkedAt: NOW.toISOString(),
      checkId: CHECK_ID,
      attemptId,
      destinationE164: DESTINATION,
      commandId: request.commandId,
    };
  }
}

async function clearFixture(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_events").run();
  await clearCallSessionsForTest();
  await clearAuthenticationAttemptReservationsForTest();
  await clearOutboundCallAttemptsForTest();
  await clearConversationDataForTest();
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

async function seedAuthorizedCommand(): Promise<void> {
  const timestamp = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Owner', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', ?, 'active', ?, ?)").bind(DESTINATION, timestamp, timestamp),
    env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, 'principal:owner', 'identity:voice', ?)").bind(timestamp),
    env.DB.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, 'principal:owner', 'v1', ?, 'allow', 'allowed', ?)").bind(COMMAND_ID, "b".repeat(64), timestamp),
  ]);
}

function command(): OutboundCallCommand {
  return {
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    purposeCode: "user_requested",
    destinationIdentityId: "identity:voice",
    urgency: "normal",
    authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
    idempotencyKey: "call:fake-acceptance",
    issuedBy: "local_cli",
  };
}

async function signedPost(fake: FakeTwilioProvider, route: string, exactUrl: string, body: string): Promise<Request> {
  const rawBody = new TextEncoder().encode(body);
  return new Request(`https://worker.internal${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": await fake.signWebhook(exactUrl, rawBody),
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
  inbound(caller?: string): Promise<Response>;
  openRelay(): Promise<FakeRelayCall>;
  pinAttempts(): Promise<number>;
  conversationTurnCount(): Promise<number>;
  sendRelayEnded(callSid: string, sessionStatus: string, providerSessionId?: string): Promise<Response>;
  terminations(): readonly CallSessionTermination[];
  terminationRecord(sessionId: Ulid): Promise<unknown>;
}

export async function createFakeCallingSystem(input: {
  loseDispatchResponse?: boolean;
  manualModel?: boolean;
  beforeTermination?: (input: CallSessionTermination) => Promise<void>;
  beforeOutboundSessionCreate?: () => Promise<void>;
  beforeSessionInitialize?: () => Promise<void>;
} = {}): Promise<FakeCallingSystem> {
  await applyFoundationMigration();
  await clearFixture();
  await seedAuthorizedCommand();
  const policy = new AllowPolicy();
  const twilio = new FakeTwilioProvider();
  if (input.loseDispatchResponse === true) twilio.acceptAndLoseNextResponse();
  const repository = new CallRepository(env.DB, new EventRepository(env.DB));
  let inboundSequence = 100;
  const relays = new FakeRelaySessions(repository,
    { manual: input.manualModel ?? false, streamText: "A safe voice answer." }, () => new Date(NOW));
  const dispatcher = new OutboundCallDispatcher({
      capacity: { async assertAcceptingNewTurn() {} },
    policy,
    twilio,
    repository,
    publicBaseUrl: new URL("https://jarvis.example/"),
    newAttemptId: () => ATTEMPT_ID,
    now: () => NOW,
  });
  const initializationLog: Readonly<OutboundSessionInitialization>[] = [];
  let lastSessionId: Ulid | undefined;
  const terminationLog: CallSessionTermination[] = [];
  const initializeSession = async (initialization: Readonly<CallSessionInitialization>): Promise<void> => {
    await input.beforeSessionInitialize?.();
    await relays.initialize(initialization);
    lastSessionId = initialization.sessionId;
  };
  const callbacks = new D1TwilioCallbackRecorder({
    database: env.DB,
    calls: repository,
    now: () => NOW,
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
        used: 1, budget: 100, observedAt: NOW.toISOString(),
      })) },
      sink: { emit: async () => undefined, rearm: async () => undefined },
      now: () => new Date(NOW),
      maximumTelemetryAgeMs: 60_000,
    }),
    inbound: {
      expectedInboundE164: "+14165550100",
      ownerIdentityId: "identity:voice",
      currentChallengeHmacKeyVersion: "hmac-v1",
      sessions: repository,
      initializeSession,
      now: () => new Date(NOW),
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
      initializeSession: async (initialization) => {
        await initializeSession(initialization);
        initializationLog.push(initialization);
      },
      now: () => NOW,
    },
    callbacks,
    relaySession: (request, sessionId) => relays.upgrade(request, sessionId),
  });

  return Object.freeze({
    inbound: async (caller = DESTINATION) => routeVoiceRequest(
      await signedPost(twilio, "/voice/inbound", "https://jarvis.example/voice/inbound",
        new URLSearchParams({ From: caller, To: "+14165550100", CallSid: `CA${(++inboundSequence).toString(16).padStart(32, "0")}` }).toString()),
      routeDependencies,
    ),
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
    dispatch: () => dispatchOutboundCall(command(), { policy, dispatcher }),
    acceptedCallSid: () => {
      const accepted = twilio.acceptedCalls[0];
      if (accepted === undefined) throw new Error("fake_call_not_accepted");
      return accepted.callSid;
    },
    sendStatus: async (callSid: string, callStatus: string, sequenceNumber: number) => routeVoiceRequest(
      await signedPost(
        twilio,
        `/voice/status/${ATTEMPT_ID}`,
        `https://jarvis.example/voice/status/${ATTEMPT_ID}`,
        `CallSid=${callSid}&CallbackSource=call-progress-events&SequenceNumber=${sequenceNumber}&CallStatus=${callStatus}`,
      ),
      routeDependencies,
    ),
    sendRelayEnded: async (callSid: string, sessionStatus: string, providerSessionId = relays.providerSessionId(callSid)) => routeVoiceRequest(
      await signedPost(twilio, "/voice/relay-ended", "https://jarvis.example/voice/relay-ended",
        new URLSearchParams({ CallSid: callSid, SessionId: providerSessionId, SessionStatus: sessionStatus,
          SessionDuration: "17" }).toString()),
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
    ),
    dispatchIntent: () => repository.resolveDispatchIntent(COMMAND_ID),
    conversationTurnCount: async () => (await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns")
      .first<{ count: number }>())?.count ?? 0,
    twilioRequests: () => twilio.requests,
    initializations: () => Object.freeze([...initializationLog]),
    cleanup: async () => { await relays.cleanup(); await clearFixture(); },
  });
}

export function createFakeOutboundCallingSystem(input: { loseDispatchResponse?: boolean } = {}): Promise<FakeOutboundCallingSystem> {
  return createFakeCallingSystem(input);
}

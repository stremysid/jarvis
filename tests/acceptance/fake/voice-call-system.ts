import { env } from "cloudflare:test";
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
  clearCallSessionsForTest,
  clearOutboundCallAttemptsForTest,
} from "../../../apps/cloud-gateway/test/persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const COMMAND_ID = "01k3s6k8000000000000000000" as Ulid;
const ATTEMPT_ID = "01k3s6k8000000000000000001" as Ulid;
const CHECK_ID = "01k3s6k8000000000000000002" as Ulid;
const EVENT_ID = "01k3s6k8000000000000000003" as Ulid;
const DESTINATION = "+14165550123";
const NONCE = `${"A".repeat(42)}A`;

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
  await clearOutboundCallAttemptsForTest();
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
    env.DB.prepare("INSERT INTO principals (principal_id, principal_type, status, display_name, pin_verifier_version, pin_verifier_secret_ref, created_at, updated_at) VALUES ('principal:owner', 'human', 'active', 'Owner', '1.0', 'PIN_VERIFIER_JSON', ?, ?)").bind(timestamp, timestamp),
    env.DB.prepare("INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at) VALUES ('identity:voice', 'principal:owner', 'voice', ?, 'active', ?, ?)").bind(DESTINATION, timestamp, timestamp),
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

export async function createFakeOutboundCallingSystem(input: {
  loseDispatchResponse?: boolean;
} = {}): Promise<FakeOutboundCallingSystem> {
  await applyFoundationMigration();
  await clearFixture();
  await seedAuthorizedCommand();
  const policy = new AllowPolicy();
  const twilio = new FakeTwilioProvider();
  if (input.loseDispatchResponse === true) twilio.acceptAndLoseNextResponse();
  const repository = new CallRepository(env.DB, new EventRepository(env.DB), () => NONCE);
  const dispatcher = new OutboundCallDispatcher({
    policy,
    twilio,
    repository,
    publicBaseUrl: new URL("https://jarvis.example/"),
    newAttemptId: () => ATTEMPT_ID,
    now: () => NOW,
  });
  const initializationLog: Readonly<OutboundSessionInitialization>[] = [];
  const callbacks = new D1TwilioCallbackRecorder({
    database: env.DB,
    calls: repository,
    now: () => NOW,
    newEventId: () => EVENT_ID,
  });
  const routeDependencies = createVoiceRouteDependencies({
    publicOrigin: new URL("https://jarvis.example/"),
    twilio,
    outbound: {
      recipients: new D1OutboundRecipientIdentityLookup(env.DB),
      calls: repository,
      initializeSession: async (initialization) => { initializationLog.push(initialization); },
      now: () => NOW,
    },
    callbacks,
  });

  return Object.freeze({
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
    twilioRequests: () => twilio.requests,
    initializations: () => Object.freeze([...initializationLog]),
    cleanup: clearFixture,
  });
}

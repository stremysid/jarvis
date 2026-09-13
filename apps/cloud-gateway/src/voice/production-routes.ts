import { createProductionCapacityGuard } from "../archive/production-capacity.js";
import { OutboundCallDispatcher } from "../calls/outbound-call-dispatcher.js";
import { D1TelegramCallCommands } from "../channels/telegram/telegram-call-command.js";
import type { AcceptedTelegramUpdate } from "../channels/telegram/telegram-webhook.js";
import type { Env } from "../env.js";
import { D1TwilioCallbackRecorder } from "../http/voice-callback-recorder.js";
import { createVoiceRouteDependencies } from "../http/voice-route-construction.js";
import { routeVoiceRequest, type VoiceRouteDependencies } from "../http/voice-routes.js";
import { CallRepository } from "../persistence/call-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import { D1OutboundPolicyContext } from "../policy/outbound-controls.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { TwilioRestProvider } from "../providers/twilio-provider.js";
import { TwilioSignatureVerifier } from "../providers/twilio-verifier.js";
import { snapshotTrustedPublicOrigin } from "../security/trusted-public-origin.js";
import { D1OutboundRecipientIdentityLookup } from "./outbound-recipient-lookup.js";
import { readVoiceRuntimeConfiguration } from "./production-runtime.js";

function configured(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError("voice_transport_configuration_invalid");
  return value;
}
function publicOrigin(env: Env): URL {
  const origin = new URL(configured(env.PUBLIC_ORIGIN, /^https:\/\/[^\s]+$/u));
  if (snapshotTrustedPublicOrigin(origin) === null) throw new TypeError("voice_transport_configuration_invalid");
  return origin;
}
const unavailableRoutes = createVoiceRouteDependencies({
  publicOrigin: new URL("http://invalid.invalid/"),
  twilio: Object.freeze({ verifyWebhook: async () => null, verifyWebSocket: async () => false }),
});

/** Lazy stage-specific dependencies: missing model/credit configuration must not block terminal cleanup. */
export function createProductionVoiceRoutes(env: Env, now: () => Date = () => new Date()): VoiceRouteDependencies {
  const origin = publicOrigin(env);
  const verifier = new TwilioSignatureVerifier({
    authToken: configured(env.TWILIO_AUTH_TOKEN, /^[\x21-\x7e]{1,4096}$/u),
  });
  const calls = new CallRepository(env.DB, new EventRepository(env.DB));
  const session = (id: string) => env.CALL_SESSION.get(env.CALL_SESSION.idFromName(id));
  return createVoiceRouteDependencies({
    publicOrigin: origin, twilio: verifier,
    capacity: { async assertAcceptingNewTurn() { await createProductionCapacityGuard(env, now).assertAcceptingNewTurn(); } },
    inbound: {
      expectedInboundE164: env.TWILIO_FROM_E164 ?? "", ownerIdentityId: env.OWNER_VOICE_IDENTITY_ID,
      currentChallengeHmacKeyVersion: env.IDENTITY_CHALLENGE_HMAC_KEY_VERSION ?? "",
      sessions: calls, initializeSession: (input) => {
        if (input.relaySetupExpiresAt === null) throw new TypeError("inbound_initialization_invalid");
        return session(input.sessionId).initialize({ ...input, relaySetupExpiresAt: input.relaySetupExpiresAt });
      }, now,
    },
    outbound: { ownerIdentityId: env.OWNER_VOICE_IDENTITY_ID, recipients: new D1OutboundRecipientIdentityLookup(env.DB),
      calls, initializeSession: (input) => session(input.sessionId).initialize(input), now },
    callbacks: new D1TwilioCallbackRecorder({ database: env.DB, calls,
      terminateSession: (input) => session(input.sessionId).terminate(input), now }),
    relaySession: (request, sessionId) => session(sessionId).fetch(request),
  });
}

export function handleProductionVoiceRequest(request: Request, env: Env): Promise<Response> {
  let routes: VoiceRouteDependencies;
  try { routes = createProductionVoiceRoutes(env); }
  catch { routes = unavailableRoutes; }
  return routeVoiceRequest(request, routes);
}

/** The accepted, persisted Telegram event supplies authority; configuration supplies no command or recipient. */
export async function requestProductionTelegramCall(env: Env, accepted: AcceptedTelegramUpdate): Promise<string> {
  let commands: D1TelegramCallCommands;
  let policy: PolicyEngine;
  let dispatcher: OutboundCallDispatcher;
  try {
    // Refuse before dial if the eventual call runtime cannot even be constructed.
    readVoiceRuntimeConfiguration(env);
    const origin = publicOrigin(env);
    configured(env.TWILIO_AUTH_TOKEN, /^[\x21-\x7e]{1,4096}$/u);
    const now = () => new Date();
    commands = new D1TelegramCallCommands({ database: env.DB,
      ownerPrincipalId: configured(env.OWNER_PRINCIPAL_ID, /^[A-Za-z0-9:._-]{1,256}$/u),
      ownerVoiceIdentityId: configured(env.OWNER_VOICE_IDENTITY_ID, /^[A-Za-z0-9:._-]{1,256}$/u),
      botUsername: env.TELEGRAM_BOT_USERNAME ?? null });
    const context = new D1OutboundPolicyContext(env.DB, commands.authenticatedOrigin.bind(commands), now);
    const events = new EventRepository(env.DB);
    policy = new PolicyEngine({ database: env.DB, events, context });
    dispatcher = new OutboundCallDispatcher({ policy, controls: context, repository: new CallRepository(env.DB, events),
      capacity: createProductionCapacityGuard(env, now), publicBaseUrl: origin, now,
      twilio: new TwilioRestProvider({
        accountSid: configured(env.TWILIO_ACCOUNT_SID, /^AC[0-9a-fA-F]{32}$/u),
        apiKeySid: configured(env.TWILIO_API_KEY_SID, /^SK[0-9a-fA-F]{32}$/u),
        apiKeySecret: configured(env.TWILIO_API_KEY_SECRET, /^[\x21-\x7e]{1,4096}$/u),
        fromE164: configured(env.TWILIO_FROM_E164, /^\+[1-9][0-9]{7,14}$/u),
        publicOrigin: origin, requestTimeoutMs: 5_000, ringTimeoutSeconds: 30, fetch: globalThis.fetch.bind(globalThis),
      }),
    });
  } catch { return "Calling is not configured on this deployment."; }
  return commands.request(accepted, { policy, dispatcher });
}

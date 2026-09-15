import { D1ContextRetriever } from "../conversation/context-retriever.js";
import { createProductionCapacityGuard } from "../archive/production-capacity.js";
import { ConversationRepository } from "../conversation/conversation-repository.js";
import { DefaultConversationService } from "../conversation/conversation-service.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../conversation/outbox-dispatcher.js";
import type { Env } from "../env.js";
import { CallRepository } from "../persistence/call-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import { VoiceAccessRepository } from "../persistence/voice-access-repository.js";
import { DeepSeekModelAdapter, DEFAULT_MODEL } from "../providers/deepseek-provider.js";
import { ProviderCircuitBreaker } from "../providers/provider-circuit-breaker.js";
import { TelegramRestProvider } from "../providers/telegram-provider.js";
import { GuestPinVerifier } from "../security/guest-pin-verifier.js";
import { OwnerPassphraseVerifier } from "../security/owner-passphrase-verifier.js";
import { Redactor } from "../security/redaction.js";
import { IdentityChallengeService, VerifiedChannelObservationAuthority } from "../sync/identity-challenge.js";
import { decodeCanonicalBase64, DeviceRequestVerifier } from "../sync/signed-request.js";
import {
  CallSessionCore, GuestCallAuthentication, PhoneActivationChallengeConfirmer,
  type CallSessionRuntimeInput,
} from "./call-session-do.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { AuthenticationAttemptBudget } from "./inbound-auth.js";
import { OwnerAccessService } from "./owner-access-service.js";
import { GuestPinProofIssuer, VoiceAccessAuthorityService } from "./voice-access-authority.js";
import { D1OwnerStepUpAlertSink, OwnerCallStepUpService } from "./owner-call-step-up.js";

function configured(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError("voice_runtime_configuration_invalid");
  return value;
}

/** No fallback keys: malformed or incomplete private bindings keep the relay closed. */
export function readVoiceRuntimeConfiguration(env: Env) {
  return Object.freeze({
    accountSid: configured(env.TWILIO_ACCOUNT_SID, /^AC[0-9a-fA-F]{32}$/u),
    modelApiKey: configured(env.DEEPSEEK_API_KEY, /^[\x21-\x7e]{1,4096}$/u),
    model: configured(env.DEEPSEEK_MODEL ?? DEFAULT_MODEL, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u),
    telegramToken: configured(env.TELEGRAM_BOT_TOKEN, /^[0-9]{5,20}:[A-Za-z0-9_-]{30,4096}$/u),
    guestPepper: decodeCanonicalBase64(env.GUEST_PIN_PEPPER_V1, 32, "voice_runtime_configuration_invalid"),
    budgetPepper: decodeCanonicalBase64(env.AUTHENTICATION_BUDGET_PEPPER, 32, "voice_runtime_configuration_invalid"),
    challengePepper: decodeCanonicalBase64(env.IDENTITY_CHALLENGE_HMAC_PEPPER, 32, "voice_runtime_configuration_invalid"),
    challengeKeyVersion: configured(env.IDENTITY_CHALLENGE_HMAC_KEY_VERSION, /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u),
    ownerPassphrasePepper: decodeCanonicalBase64(env.OWNER_PASSPHRASE_PEPPER_V1, 32, "voice_runtime_configuration_invalid"),
  });
}

/**
 * Constructed lazily inside the DO's existing fail-closed runtime boundary.
 * Initialization and terminal cleanup remain usable when a provider is unconfigured.
 * The import cycle only resolves classes when this function runs, never at module load.
 */
export function createProductionCallSessionCore(
  env: Env,
  input: CallSessionRuntimeInput,
  now: () => Date = () => new Date(),
): CallSessionCore {
  const configuration = readVoiceRuntimeConfiguration(env);
  const events = new EventRepository(env.DB);
  const calls = new CallRepository(env.DB, events);
  const conversations = new ConversationRepository(env.DB, events);
  const access = new VoiceAccessRepository(env.DB);
  const registry = new CapabilityRegistry({ installed: ["conversation.basic", "access.manage"] });

  // These issuers hold nominal proofs in instance-local maps. A second equivalent
  // instance cannot validate the first instance's proof or owner authority.
  const proofs = new GuestPinProofIssuer();
  const authorities = new VoiceAccessAuthorityService(access, registry, proofs);
  const verifier = new GuestPinVerifier(configuration.guestPepper);
  const budgets = new AuthenticationAttemptBudget(env.DB, configuration.budgetPepper);
  const guestAuthentication = new GuestCallAuthentication({ repository: access, budgets, verifier, proofs });
  const ownerStepUp = new OwnerCallStepUpService(
    env.DB, new OwnerPassphraseVerifier(configuration.ownerPassphrasePepper, "v1"),
  );
  const ownerStepUpAlerts = new D1OwnerStepUpAlertSink(
    env.DB, new TelegramRestProvider({ botToken: configuration.telegramToken }),
  );
  const defaultGuestPin = env.DEFAULT_GUEST_PIN;
  const ownerAccess = new OwnerAccessService({
    repository: access, registry, authorities, verifier,
    ...(defaultGuestPin === undefined ? {} : { defaultGuestPin: () => defaultGuestPin }),
  });
  const observations = new VerifiedChannelObservationAuthority();
  const challenges = new IdentityChallengeService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: "jarvis-local-agent" }),
    observations,
    hmacPepper: configuration.challengePepper,
    hmacKeyVersion: configuration.challengeKeyVersion,
    now,
  });
  const activation = new PhoneActivationChallengeConfirmer({ database: env.DB, budgets, observations, challenges });

  // ConversationService owns durable delivery even though a voice turn streams
  // through its relay. Keep a real dispatcher, not an adapter that reports success.
  const dispatcher = new DefaultOutboxDispatcher({
    repository: conversations,
    identityResolver: new D1TelegramIdentityResolver(env.DB),
    channels: new Map([["telegram", new TelegramRestProvider({ botToken: configuration.telegramToken })]]),
    circuitBreaker: new ProviderCircuitBreaker(),
    now,
  });
  const conversation = new DefaultConversationService({
    repository: conversations,
    model: new DeepSeekModelAdapter({ apiKey: configuration.modelApiKey, model: configuration.model }),
    context: new D1ContextRetriever(env.DB),
    dispatcher,
    redactor: new Redactor(),
    now,
  });
  return new CallSessionCore({
    capacity: createProductionCapacityGuard(env, now),
    session: input.session,
    expectedAccountSid: configuration.accountSid,
    repository: calls,
    authority: authorities,
    guestAuthentication, ownerAccess, activation, conversation, ownerStepUp, ownerStepUpAlerts,
    ownerStepUpAlarm: input.ownerStepUpAlarm,
    relay: input.relay,
    ...(input.initialization.binding.direction === "outbound" && "preAuthentication" in input.initialization
      ? { preAuthentication: input.initialization.preAuthentication }
      : {}),
    now,
  });
}

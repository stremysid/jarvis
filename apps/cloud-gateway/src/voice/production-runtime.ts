import { D1ContextRetriever } from "../conversation/context-retriever.js";
import { createProductionCapacityGuard } from "../archive/production-capacity.js";
import { AutonomyRepository } from "../autonomy/autonomy-repository.js";
import { AutonomyService } from "../autonomy/autonomy-service.js";
import { D1ToolConfirmationStore } from "../autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "../autonomy/tool-gate.js";
import { ConversationRepository } from "../conversation/conversation-repository.js";
import { DefaultConversationService } from "../conversation/conversation-service.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../conversation/outbox-dispatcher.js";
import { DecisionRepository } from "../decisions/decision-repository.js";
import { DecisionService } from "../decisions/decision-service.js";
import type { Env } from "../env.js";
import { D1MemoryControlTargetFinder } from "../memory/memory-control-targets.js";
import {
  MemoryMeaningService,
  VectorizeMemoryVectorStore,
  WorkersAiMemoryEmbeddingProvider,
} from "../memory/meaning-search.js";
import { CallRepository } from "../persistence/call-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import { VoiceAccessRepository } from "../persistence/voice-access-repository.js";
import { DeepSeekAgentProvider, DEFAULT_MODEL } from "../providers/deepseek-provider.js";
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
import { D1GuestGrantNoticeSink } from "./guest-grant-notice.js";
import { OwnerVoiceAgentAdapter } from "./voice-agent.js";
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
    notices: new D1GuestGrantNoticeSink(
      env.DB, new TelegramRestProvider({ botToken: configuration.telegramToken }),
    ),
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
  // Which item a memory control acts on. Extracted from the Telegram retriever
  // because this is the half the voice path was missing entirely: without it
  // every memory tool taking an `itemId` has nothing to resolve one from, so
  // the tools this adapter now dispatches would all refuse.
  const targets = new D1MemoryControlTargetFinder({ database: env.DB, archive: env.ARCHIVE });
  const meaningSearch = env.AI === undefined || env.MEMORY_VECTORS === undefined
    ? undefined
    : new MemoryMeaningService({
      database: env.DB,
      embeddings: new WorkersAiMemoryEmbeddingProvider(env.AI),
      vectors: new VectorizeMemoryVectorStore(env.MEMORY_VECTORS),
    });
  const ownerPrincipalId = env.OWNER_PRINCIPAL_ID;
  // Fail closed. Without a configured owner the adapter's own check would have
  // nothing to compare against, and a call that cannot prove who it is must not
  // reach a tool at all -- so the relay is not composed rather than composed
  // with a check that cannot fail.
  if (ownerPrincipalId === undefined || ownerPrincipalId.length === 0) {
    throw new TypeError("voice_runtime_configuration_invalid");
  }
  // The tools reach the model only through an adapter that owns the loop, which
  // is the decision recorded in `DECISIONS.md` ("Voice gets tools behind
  // `ModelAdapter`", 2026-09-20): `ModelAdapterStreamInput` has no `tools` field
  // and `DefaultConversationService.handleTurn` settles one request per turn, so
  // the multi-request loop lives behind the adapter rather than in the service.
  const agent = new OwnerVoiceAgentAdapter({
    provider: new DeepSeekAgentProvider({
      apiKey: configuration.modelApiKey,
      model: configuration.model,
    }),
    database: env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId,
    targets,
    ...(meaningSearch === undefined ? {} : { memorySearch: meaningSearch }),
    directOwnerText: true,
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB) }),
    // The same tier gate Telegram puts in front of its tools, constructed here
    // rather than left out: a channel that dispatches tools without it is the
    // "built, reviewed and unreferenced" shape in `AutonomyService`'s history.
    autonomy: new ToolAutonomyGate(
      new AutonomyService({ repository: new AutonomyRepository(env.DB) }),
      new D1ToolConfirmationStore(env.DB),
    ),
    now,
  });
  const conversation = new DefaultConversationService({
    repository: conversations,
    model: agent,
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

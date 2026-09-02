import { newUlid } from "../../../packages/contracts/src/index.js";
import { TelegramRateLimiter } from "./channels/telegram/telegram-rate-limit.js";
import {
  handleTelegramWebhook,
  type AcceptedTelegramUpdate,
} from "./channels/telegram/telegram-webhook.js";
import { D1ContextRetriever } from "./conversation/context-retriever.js";
import { ConversationRepository } from "./conversation/conversation-repository.js";
import { DefaultConversationService } from "./conversation/conversation-service.js";
import {
  D1TelegramIdentityResolver,
  DefaultOutboxDispatcher,
} from "./conversation/outbox-dispatcher.js";
import type { Env } from "./env.js";
import { createVoiceRouteDependencies } from "./http/voice-route-construction.js";
import { routeVoiceRequest } from "./http/voice-routes.js";
import { DeviceRepository } from "./persistence/device-repository.js";
import { EventRepository } from "./persistence/event-repository.js";
import { PolicyService } from "./policy/policy-service.js";
import { DeepSeekModelAdapter } from "./providers/deepseek-provider.js";
import { ProviderCircuitBreaker } from "./providers/provider-circuit-breaker.js";
import { TelegramRestProvider } from "./providers/telegram-provider.js";
import { Redactor } from "./security/redaction.js";
export { CallSession } from "./voice/call-session-do.js";

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

function notImplemented(): Response {
  return new Response("Not implemented", { status: 501 });
}

function unavailable(): Response {
  return new Response("Channel not configured", { status: 503 });
}

/**
 * Voice is deliberately fail-closed until Twilio credentials are configured.
 * The invalid origin and always-rejecting verifier refuse every voice request
 * rather than serving one with a half-built configuration.
 */
const unavailableVoiceRoutes = createVoiceRouteDependencies({
  publicOrigin: new URL("http://invalid.invalid/"),
  twilio: Object.freeze({
    verifyWebhook: async () => null,
    verifyWebSocket: async () => false,
  }),
});

/**
 * Module scope, so state survives between requests in one isolate.
 *
 * Per-isolate, not global: Cloudflare may run several isolates for one Worker,
 * so rate limiting is weaker than configured and the circuit breaker sees only
 * one isolate's failures. Both belong in a Durable Object -- the mechanism
 * already used for call sessions -- before either becomes load-bearing.
 */
const telegramLimiter = new TelegramRateLimiter();
const providerCircuitBreaker = new ProviderCircuitBreaker();

function isVoicePath(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/voice" || pathname.startsWith("/voice/");
}

/**
 * Answer an accepted message through the conversation service.
 *
 * The service owns the entire turn: it commits the user event, claims the
 * turn, streams the model, stages the assistant delivery and dispatches it.
 * That matters because the database enforces those transitions with triggers
 * -- a delivery cannot be recorded without the staging that proves it
 * happened. Writing those events directly, as an earlier version did, aborts
 * the transaction and takes the reply down with it.
 *
 * Runs under ctx.waitUntil, after the webhook has already returned 200, so a
 * slow model cannot cause Telegram to time out and redeliver.
 */
async function replyTo(env: Env, accepted: AcceptedTelegramUpdate): Promise<void> {
  const apiKey = env.DEEPSEEK_API_KEY;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (apiKey === undefined || botToken === undefined) return;

  const controller = new AbortController();
  try {
    // The delivery target is the channel identity, not the chat. Resolving it
    // here also re-confirms the identity is still active: authentication
    // happened when the message arrived, and this runs afterwards.
    const identity = await new DeviceRepository(env.DB).findActiveVerifiedTelegramIdentity(
      accepted.telegramUserId,
    );
    if (identity === null) return;

    const events = new EventRepository(env.DB);
    const repository = new ConversationRepository(env.DB, events);

    const service = new DefaultConversationService({
      repository,
      model: new DeepSeekModelAdapter({ apiKey, model: env.DEEPSEEK_MODEL }),
      context: new D1ContextRetriever(env.DB),
      dispatcher: new DefaultOutboxDispatcher({
        repository,
        identityResolver: new D1TelegramIdentityResolver(env.DB),
        channels: new Map([["telegram", new TelegramRestProvider({ botToken })]]),
        circuitBreaker: providerCircuitBreaker,
      }),
      redactor: new Redactor(),
    });

    const result = await service.handleTurn({
      // One conversation per chat, so separate chats do not share a thread.
      sessionId: `telegram:${accepted.chatId}`,
      principalId: accepted.principalId,
      turnId: newUlid(),
      text: accepted.text,
      signal: controller.signal,
      channel: "telegram",
      kind: "outbox",
      targetIdentityId: identity.identityId,
      replyToMessageId: accepted.messageId,
    });

    // Anything other than delivered is worth seeing. The turn is durably
    // recorded either way, but silence here is what made the earlier failures
    // so hard to find.
    if (result.outcome !== "telegram_delivered") {
      console.log("telegram_turn_outcome", {
        eventId: accepted.eventId,
        outcome: result.outcome,
        deliveryId: result.deliveryId,
      });
    }
  } catch (error) {
    // Contained, not hidden: the inbound message is already archived, so this
    // is a delivery problem rather than data loss.
    console.error("telegram_reply_failed", {
      eventId: accepted.eventId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === TELEGRAM_WEBHOOK_PATH) {
      const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
      // Refuse rather than fall through: an empty secret would compare equal
      // to an absent header, authenticating anyone.
      if (webhookSecret === undefined || webhookSecret.length === 0) return unavailable();
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      return handleTelegramWebhook(request, {
        webhookSecret,
        policy: new PolicyService(new DeviceRepository(env.DB)),
        redactor: new Redactor(),
        events: new EventRepository(env.DB),
        limiter: telegramLimiter,
        onAccepted: (accepted) => ctx.waitUntil(replyTo(env, accepted)),
      });
    }

    if (isVoicePath(request)) return routeVoiceRequest(request, unavailableVoiceRoutes);
    return notImplemented();
  },
} satisfies ExportedHandler<Env>;

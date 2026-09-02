import { newUlid } from "../../../packages/contracts/src/index.js";
import { TelegramRateLimiter } from "./channels/telegram/telegram-rate-limit.js";
import {
  handleTelegramWebhook,
  type AcceptedTelegramUpdate,
} from "./channels/telegram/telegram-webhook.js";
import type { Env } from "./env.js";
import { createVoiceRouteDependencies } from "./http/voice-route-construction.js";
import { routeVoiceRequest } from "./http/voice-routes.js";
import { DeviceRepository } from "./persistence/device-repository.js";
import { EventRepository } from "./persistence/event-repository.js";
import { PolicyService } from "./policy/policy-service.js";
import { D1ContextRetriever } from "./conversation/context-retriever.js";
import { recordTurn } from "./conversation/turn-recorder.js";
import { collectStream, DeepSeekModelAdapter } from "./providers/deepseek-provider.js";
import { TelegramRestProvider } from "./providers/telegram-provider.js";
import { Redactor } from "./security/redaction.js";
export { CallSession } from "./voice/call-session-do.js";

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

/** Telegram replies are text; the design calls for brief, direct answers. */
const REPLY_MAX_CHARACTERS = 3_000;
const FIRST_TOKEN_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 45_000;
/** Byte budget for retrieved history, not a token count. */
const CONTEXT_BUDGET_BYTES = 4_000;

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
 * Module scope, so admission counts survive between requests in one isolate.
 *
 * Per-isolate, not global: Cloudflare may run several isolates for a Worker,
 * so the effective ceiling is the limit times the number of live isolates.
 * For a limit whose purpose is bounding cost that is a real weakening; the fix
 * is a Durable Object counter, the same mechanism already used for call
 * sessions.
 */
const telegramLimiter = new TelegramRateLimiter();

function isVoicePath(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/voice" || pathname.startsWith("/voice/");
}

/**
 * Answer an accepted message.
 *
 * Runs after the webhook has already returned 200, so a slow model cannot
 * cause Telegram to time out and redeliver. Every failure is swallowed: the
 * message is already durably stored, and throwing here would only produce an
 * unhandled rejection in a context with no one to report it to.
 */
async function replyTo(env: Env, accepted: AcceptedTelegramUpdate): Promise<void> {
  const apiKey = env.DEEPSEEK_API_KEY;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (apiKey === undefined || botToken === undefined) return;

  const controller = new AbortController();
  const recorder = { events: new EventRepository(env.DB), redactor: new Redactor() };
  try {
    // Retrieved BEFORE the new turn is recorded, so the current message is not
    // duplicated -- it is already passed separately as userText.
    const context = await new D1ContextRetriever(env.DB).retrieve({
      principalId: accepted.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: accepted.text,
      maxTokens: CONTEXT_BUDGET_BYTES,
    });

    // Recorded before the model is called, so what was said survives even if
    // the answer never arrives.
    await recordTurn(recorder, {
      principalId: accepted.principalId,
      channel: "telegram",
      role: "user",
      text: accepted.text,
      turnKey: `${accepted.eventId}:user`,
    });

    const model = new DeepSeekModelAdapter({ apiKey, model: env.DEEPSEEK_MODEL });
    const answer = await collectStream(
      model.stream({
        correlationId: newUlid(),
        principalId: accepted.principalId,
        channel: "telegram",
        userText: accepted.text,
        context,
        reasoningEffort: "low",
        firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
        timeoutMs: TOTAL_TIMEOUT_MS,
        contextTokenBudget: 4_000,
        maxOutputCharacters: REPLY_MAX_CHARACTERS,
        signal: controller.signal,
      }),
    );

    const text = answer.trim();
    if (text.length === 0) return;

    // The assistant turn is deliberately NOT recorded here.
    //
    // conversation.assistant_delivered is guarded by a database trigger that
    // requires a matching conversation_deliveries row in `claimed` state, so
    // it cannot be written directly -- only through the staging and delivery
    // flow that ConversationRepository and DefaultConversationService
    // implement. Writing it directly aborts the transaction and, because this
    // runs after the user turn is stored, took the reply down with it.
    //
    // The consequence today: Jarvis recalls what you said but not what it
    // answered. Wiring the real conversation service removes that asymmetry
    // and is the next piece of work.
    await new TelegramRestProvider({ botToken }).sendMessage({
      chatId: accepted.chatId,
      text,
      replyToMessageId: accepted.messageId,
      // The event id: one reply per stored message, and traceable to it.
      idempotencyKey: accepted.eventId,
    });
  } catch (error) {
    // The failure is contained -- the inbound message is already archived, so
    // this is a delivery problem rather than data loss -- but it must not be
    // invisible. A silent catch here made a wrong model id look identical to
    // the model never being called at all.
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

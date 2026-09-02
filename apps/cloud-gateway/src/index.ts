import { TelegramRateLimiter } from "./channels/telegram/telegram-rate-limit.js";
import { handleTelegramWebhook } from "./channels/telegram/telegram-webhook.js";
import type { Env } from "./env.js";
import { createVoiceRouteDependencies } from "./http/voice-route-construction.js";
import { routeVoiceRequest } from "./http/voice-routes.js";
import { DeviceRepository } from "./persistence/device-repository.js";
import { EventRepository } from "./persistence/event-repository.js";
import { PolicyService } from "./policy/policy-service.js";
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
 *
 * The invalid origin and always-rejecting verifier mean every voice request is
 * refused rather than handled with a half-built configuration. Wiring real
 * credentials here is the remaining work for the voice channel.
 */
const unavailableVoiceRoutes = createVoiceRouteDependencies({
  publicOrigin: new URL("http://invalid.invalid/"),
  twilio: Object.freeze({
    verifyWebhook: async () => null,
    verifyWebSocket: async () => false,
  }),
});

/**
 * Module scope, so admission counts survive between requests handled by the
 * same isolate.
 *
 * This is per-isolate, not global: Cloudflare may run several isolates for one
 * Worker, so the effective ceiling is the configured limit multiplied by the
 * number of live isolates. That is a real weakening of a limit whose purpose
 * is bounding cost, and the correct fix is to move the counter into a Durable
 * Object -- the same one already used for call sessions. Recorded here rather
 * than left to be discovered from a bill.
 */
const telegramLimiter = new TelegramRateLimiter();

function isVoicePath(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/voice" || pathname.startsWith("/voice/");
}

export default {
  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === TELEGRAM_WEBHOOK_PATH) {
      const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
      // Refuse rather than fall through to a default: an empty secret would
      // make secretsMatch succeed against a caller that also sends nothing.
      if (webhookSecret === undefined || webhookSecret.length === 0) return unavailable();
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      return handleTelegramWebhook(request, {
        webhookSecret,
        policy: new PolicyService(new DeviceRepository(env.DB)),
        redactor: new Redactor(),
        events: new EventRepository(env.DB),
        limiter: telegramLimiter,
      });
    }

    if (isVoicePath(request)) return routeVoiceRequest(request, unavailableVoiceRoutes);
    return notImplemented();
  },
} satisfies ExportedHandler<Env>;

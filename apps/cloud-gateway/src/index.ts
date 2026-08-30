import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { createVoiceRouteDependencies } from "./http/voice-route-construction.js";
import { routeVoiceRequest } from "./http/voice-routes.js";

function notImplemented(): Response {
  return new Response("Not implemented", { status: 501 });
}

/** Task 1 boundary only; Task 6 installs authenticated relay behavior. */
export class CallSession extends DurableObject<Env> {
  override fetch(): Response {
    return notImplemented();
  }
}

const unavailableVoiceRoutes = createVoiceRouteDependencies({
  publicOrigin: new URL("http://invalid.invalid/"),
  twilio: Object.freeze({
    verifyWebhook: async () => null,
    verifyWebSocket: async () => false,
  }),
});

function isVoicePath(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/voice" || pathname.startsWith("/voice/");
}

export default {
  fetch(request): Response | Promise<Response> {
    return isVoicePath(request) ? routeVoiceRequest(request, unavailableVoiceRoutes) : notImplemented();
  },
} satisfies ExportedHandler<Env>;

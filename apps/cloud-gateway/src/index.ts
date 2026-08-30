import type { Env } from "./env.js";
import { createVoiceRouteDependencies } from "./http/voice-route-construction.js";
import { routeVoiceRequest } from "./http/voice-routes.js";
export { CallSession } from "./voice/call-session-do.js";

function notImplemented(): Response {
  return new Response("Not implemented", { status: 501 });
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

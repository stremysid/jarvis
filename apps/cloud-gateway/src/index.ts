import type { Env } from "./env.js";
export { CallSession } from "./voice/call-session-do.js";

function notImplemented(): Response {
  return new Response("Not implemented", { status: 501 });
}

export default {
  fetch(): Response {
    return notImplemented();
  },
} satisfies ExportedHandler<Env>;

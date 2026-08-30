import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

function notImplemented(): Response {
  return new Response("Not implemented", { status: 501 });
}

/** Task 1 boundary only; Task 6 installs authenticated relay behavior. */
export class CallSession extends DurableObject<Env> {
  override fetch(): Response {
    return notImplemented();
  }
}

export default {
  fetch(): Response {
    return notImplemented();
  },
} satisfies ExportedHandler<Env>;

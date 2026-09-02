/**
 * Device-signed sync endpoints for the local agent.
 *
 * The agent replicates the cloud event log into its permanent archive. Both
 * routes are authenticated by device signature rather than by any ambient
 * credential, so possession of the URL grants nothing.
 *
 * The signed envelope travels in a header and the canonical body as the raw
 * payload. That separation is deliberate: the gateway hashes exactly the bytes
 * it received and compares them against the hash inside the signature, so a
 * body altered in transit fails even if the envelope is intact.
 */

import type { SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { EventRepository } from "../persistence/event-repository.js";
import { DeviceRequestVerifier } from "../sync/signed-request.js";
import { SyncService } from "../sync/sync-service.js";
import type { Env } from "../env.js";

export const SYNC_PULL_PATH = "/sync/pull";
export const SYNC_ACK_PATH = "/sync/ack";
export const SIGNED_REQUEST_HEADER = "x-jarvis-signed-request";

/** Must match the audience the agent signs with. */
export const SYNC_AUDIENCE = "jarvis-local-agent";

/** Bounded so an unauthenticated caller cannot make us buffer arbitrarily. */
const MAX_BODY_BYTES = 65_536;

export function isSyncPath(pathname: string): boolean {
  return pathname === SYNC_PULL_PATH || pathname === SYNC_ACK_PATH;
}

function refuse(status: number, code: string): Response {
  // Deliberately terse. A caller that cannot produce a valid signature learns
  // only that it failed, not which check it failed or what exists behind it.
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function decodeSecret(value: string): Uint8Array | null {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Errors thrown by the verifier name the exact check that failed
 * (`signature_invalid`, `device_not_active`, `nonce_replayed`, and so on).
 * Those are useful in logs and dangerous in responses, so they are separated
 * here: logged in full, answered with a status only.
 */
function statusFor(message: string): number {
  if (
    message.includes("signature")
    || message.includes("device_not_active")
    || message.includes("audience")
    || message.includes("expired")
    || message.includes("nonce")
  ) {
    return 401;
  }
  if (message.includes("consumer_binding") || message.includes("device_state_changed")) return 403;
  return 400;
}

export async function handleSyncRequest(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method !== "POST") return refuse(405, "method_not_allowed");

  const configured = env.SYNC_CONTINUATION_SECRET;
  if (configured === undefined) return refuse(503, "sync_not_configured");
  const continuationSecret = decodeSecret(configured);
  // A wrong-length secret would otherwise surface as an opaque construction
  // failure on the first request rather than as a configuration problem.
  if (continuationSecret === null) return refuse(503, "sync_not_configured");

  const header = request.headers.get(SIGNED_REQUEST_HEADER);
  if (header === null) return refuse(401, "signed_request_missing");

  let envelope: SignedRequestV1;
  try {
    envelope = JSON.parse(header) as SignedRequestV1;
  } catch {
    return refuse(400, "signed_request_malformed");
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return refuse(413, "payload_too_large");

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return refuse(400, "body_malformed");
  }

  const service = new SyncService({
    database: env.DB,
    verifier: new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE }),
    events: new EventRepository(env.DB),
    continuationSecret,
  });

  try {
    const result = pathname === SYNC_PULL_PATH
      ? await service.pull(envelope, body as never, rawBody)
      : await service.acknowledgeDurableReceipt(envelope, body as never, rawBody);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("sync_request_failed", { path: pathname, reason });
    return refuse(statusFor(reason), "sync_request_rejected");
  }
}

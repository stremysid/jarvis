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
import { ArchivalService } from "../archive/archival-service.js";
import { ArchiveRepository } from "../archive/archive-repository.js";
import { TieredEventReader } from "../archive/tiered-event-reader.js";
import { DeepSeekModelAdapter } from "../providers/deepseek-provider.js";
import { EventRepository } from "../persistence/event-repository.js";
import { DISTILL_PATH, distil, validateExcerpts } from "../sync/memory-distill.js";
import { MEMORY_PROJECTION_PATH, MemoryProjectionService, ProjectionContentRejectedError } from "../sync/memory-projection.js";
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

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("payload_too_large");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function isSyncPath(pathname: string): boolean {
  return pathname === SYNC_PULL_PATH || pathname === SYNC_ACK_PATH
    || pathname === DISTILL_PATH || pathname === MEMORY_PROJECTION_PATH;
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

  const rawBody = await readBoundedBody(request);
  if (rawBody === null) return refuse(413, "payload_too_large");

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return refuse(400, "body_malformed");
  }

  try {
    if (pathname === DISTILL_PATH) {
      return await handleDistill(envelope, body, rawBody, env);
    }
    if (pathname === MEMORY_PROJECTION_PATH) {
      const live = new EventRepository(env.DB);
      const projection = new MemoryProjectionService({
        database: env.DB,
        verifier: new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE }),
        events: new TieredEventReader({
          live,
          archive: new ArchivalService({ database: env.DB, bucket: env.ARCHIVE }),
          state: new ArchiveRepository(env.DB),
        }),
      });
      const result = await projection.project(envelope, body, rawBody);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const service = new SyncService({
      database: env.DB,
      verifier: new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE }),
      events: new EventRepository(env.DB),
      continuationSecret,
    });
    const result = pathname === SYNC_PULL_PATH
      ? await service.pull(envelope, body as never, rawBody)
      : await service.acknowledgeDurableReceipt(envelope, body as never, rawBody);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    if (pathname === MEMORY_PROJECTION_PATH && error instanceof ProjectionContentRejectedError) {
      return refuse(400, "memory_projection_content_rejected");
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.error("sync_request_failed", { path: pathname, reason });
    return refuse(statusFor(reason), "sync_request_rejected");
  }
}

/**
 * Distillation over a signed request.
 *
 * Verified through the same DeviceRequestVerifier as the sync routes, so this
 * consumes a nonce and is bound to method, path and body exactly as they are.
 * The excerpts are validated before the model is called, so a malformed
 * submission costs nothing but a signature check.
 */
async function handleDistill(
  envelope: SignedRequestV1,
  body: unknown,
  rawBody: Uint8Array,
  env: Env,
): Promise<Response> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (apiKey === undefined) return refuse(503, "model_not_configured");

  const verifier = new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE });
  const verified = await verifier.verify(
    envelope,
    "POST",
    DISTILL_PATH,
    body,
    rawBody,
    new Date(),
    (value) => value,
  );

  const submitted = (verified.body as { excerpts?: unknown }).excerpts;
  const excerpts = validateExcerpts(submitted);
  if (excerpts === null) return refuse(400, "excerpts_invalid");

  const controller = new AbortController();
  const proposals = await distil(
    excerpts,
    {
      model: new DeepSeekModelAdapter({ apiKey, model: env.DEEPSEEK_MODEL }),
      principalId: verified.principalId,
    },
    controller.signal,
  );

  return new Response(JSON.stringify({ schemaVersion: "1.0", proposals }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

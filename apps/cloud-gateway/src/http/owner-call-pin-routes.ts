import type { SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../env.js";
import { OwnerCallPinService, OWNER_CALL_PIN_PATH } from "../sync/owner-call-pin.js";
import { decodeCanonicalBase64, DeviceRequestVerifier } from "../sync/signed-request.js";
import { SIGNED_REQUEST_HEADER, SYNC_AUDIENCE } from "./sync-routes.js";

const MAX_BODY_BYTES = 2048;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const AUTH_FAILURES = new Set([
  "signature_invalid", "device_not_active", "device_key_invalid", "audience_mismatch",
  "signed_request_expired", "replayed_nonce", "device_key_changed", "owner_call_pin_device_mismatch",
]);
const PUBLIC_FAILURES = new Set([
  "owner_call_pin_body_invalid", "body_hash_mismatch", "signed_body_mismatch",
  "signed_body_invalid", "signed_body_noncanonical", "signed_request_invalid",
]);
const OWNER_MISMATCH = "owner_call_pin_owner_mismatch";

function response(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function failureResponse(error: unknown): Response {
  const reason = error instanceof Error ? error.message : "internal";
  const status = AUTH_FAILURES.has(reason) ? 401 : PUBLIC_FAILURES.has(reason) ? 400
    : reason === OWNER_MISMATCH ? 403 : reason === "owner_call_pin_state_changed" ? 409 : 500;
  console.error("owner_call_pin_request_failed", {
    reason: AUTH_FAILURES.has(reason) || PUBLIC_FAILURES.has(reason)
      || reason === OWNER_MISMATCH || reason === "owner_call_pin_state_changed"
      ? reason : "internal",
  });
  if (status === 401) {
    return response(status, {
      error: reason === "signed_request_expired" ? "signed_request_expired" : "device_key_mismatch",
    });
  }
  if (status === 409) return response(status, { error: "owner_call_pin_state_changed" });
  if (status === 403) return response(status, { error: OWNER_MISMATCH });
  return response(status, { error: "owner_call_pin_request_rejected" });
}

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

function configured(env: Env): {
  ownerPrincipalId: string;
  ownerIdentityId: string;
  pepper: Uint8Array;
} | null {
  try {
    if (typeof env.OWNER_PRINCIPAL_ID !== "string" || !IDENTIFIER.test(env.OWNER_PRINCIPAL_ID)
      || typeof env.OWNER_VOICE_IDENTITY_ID !== "string" || !IDENTIFIER.test(env.OWNER_VOICE_IDENTITY_ID)) return null;
    return {
      ownerPrincipalId: env.OWNER_PRINCIPAL_ID,
      ownerIdentityId: env.OWNER_VOICE_IDENTITY_ID,
      // The same pepper domain-separated by the verifier's HMAC prefix. A
      // second 32-byte secret would have to be provisioned and rotated in
      // step with this one, and the domains do not share a comparison.
      pepper: decodeCanonicalBase64(
        env.OWNER_PASSPHRASE_PEPPER_V1, 32, "owner_call_pin_configuration_invalid",
      ),
    };
  } catch {
    return null;
  }
}

export function isOwnerCallPinPath(pathname: string): boolean {
  return pathname === OWNER_CALL_PIN_PATH;
}

/** Production route for signed status and Worker-side generation. */
export async function handleOwnerCallPinRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
  const header = request.headers.get(SIGNED_REQUEST_HEADER);
  if (header === null) return response(401, { error: "device_key_mismatch" });
  let envelope: SignedRequestV1;
  try {
    envelope = JSON.parse(header) as SignedRequestV1;
  } catch {
    return response(400, { error: "owner_call_pin_request_rejected" });
  }
  const rawBody = await readBoundedBody(request);
  if (rawBody === null) return response(413, { error: "payload_too_large" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return response(400, { error: "owner_call_pin_request_rejected" });
  }
  const configuration = configured(env);
  if (configuration === null) {
    try {
      await new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE }).verify(
        envelope, "POST", OWNER_CALL_PIN_PATH, body, rawBody, new Date(), (value) => value,
      );
    } catch (error) {
      return failureResponse(error);
    }
    return response(503, { error: "owner_call_pin_not_configured" });
  }
  try {
    const service = new OwnerCallPinService({
      database: env.DB,
      verifier: new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE }),
      ownerPrincipalId: configuration.ownerPrincipalId,
      ownerIdentityId: configuration.ownerIdentityId,
      pepper: configuration.pepper,
    });
    return response(200, await service.execute(envelope, body, rawBody));
  } catch (error) {
    return failureResponse(error);
  } finally {
    configuration.pepper.fill(0);
  }
}


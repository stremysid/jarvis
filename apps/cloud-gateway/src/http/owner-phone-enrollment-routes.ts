import type { SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../env.js";
import {
  OWNER_PHONE_ENROLLMENT_PATH,
  OwnerPhoneEnrollmentService,
} from "../sync/owner-phone-enrollment.js";
import { decodeCanonicalBase64, DeviceRequestVerifier } from "../sync/signed-request.js";
import { SIGNED_REQUEST_HEADER, SYNC_AUDIENCE } from "./sync-routes.js";

const MAX_BODY_BYTES = 4096;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u;
const AUTH_FAILURES = new Set([
  "signature_invalid", "device_not_active", "device_key_invalid", "audience_mismatch",
  "signed_request_expired", "replayed_nonce", "device_key_changed", "owner_phone_device_mismatch",
]);
const PUBLIC_FAILURES = new Set([
  "owner_phone_enrollment_body_invalid", "body_hash_mismatch", "signed_body_mismatch",
  "signed_body_invalid", "signed_body_noncanonical", "signed_request_invalid",
]);

function response(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function failureResponse(error: unknown): Response {
  const reason = error instanceof Error ? error.message : "internal";
  const status = AUTH_FAILURES.has(reason) ? 401 : PUBLIC_FAILURES.has(reason) ? 400
    : reason === "owner_phone_enrollment_state_changed" ? 409 : 500;
  // Only an allowlisted reason code reaches logs. Raw storage/provider text
  // could contain the submitted number, so unknown failures stay opaque.
  console.error("owner_phone_enrollment_failed", {
    reason: AUTH_FAILURES.has(reason) || PUBLIC_FAILURES.has(reason)
      || reason === "owner_phone_enrollment_state_changed" ? reason : "internal",
  });
  if (status === 401) {
    return response(status, {
      error: reason === "signed_request_expired" ? "signed_request_expired" : "device_key_mismatch",
    });
  }
  return response(status, { error: "owner_phone_enrollment_rejected" });
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
  keyVersion: string;
} | null {
  try {
    if (typeof env.OWNER_PRINCIPAL_ID !== "string" || !IDENTIFIER.test(env.OWNER_PRINCIPAL_ID)
      || typeof env.OWNER_VOICE_IDENTITY_ID !== "string" || !IDENTIFIER.test(env.OWNER_VOICE_IDENTITY_ID)
      || typeof env.IDENTITY_CHALLENGE_HMAC_KEY_VERSION !== "string"
      || !KEY_VERSION.test(env.IDENTITY_CHALLENGE_HMAC_KEY_VERSION)) return null;
    return {
      ownerPrincipalId: env.OWNER_PRINCIPAL_ID,
      ownerIdentityId: env.OWNER_VOICE_IDENTITY_ID,
      pepper: decodeCanonicalBase64(
        env.IDENTITY_CHALLENGE_HMAC_PEPPER, 32, "owner_phone_enrollment_configuration_invalid",
      ),
      keyVersion: env.IDENTITY_CHALLENGE_HMAC_KEY_VERSION,
    };
  } catch {
    return null;
  }
}

export function isOwnerPhoneEnrollmentPath(pathname: string): boolean {
  return pathname === OWNER_PHONE_ENROLLMENT_PATH;
}

/** Production route for the device-signed, provider-free bootstrap step. */
export async function handleOwnerPhoneEnrollmentRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
  const header = request.headers.get(SIGNED_REQUEST_HEADER);
  if (header === null) return response(401, { error: "device_key_mismatch" });
  let envelope: SignedRequestV1;
  try {
    envelope = JSON.parse(header) as SignedRequestV1;
  } catch {
    return response(400, { error: "owner_phone_enrollment_rejected" });
  }
  const rawBody = await readBoundedBody(request);
  if (rawBody === null) return response(413, { error: "payload_too_large" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return response(400, { error: "owner_phone_enrollment_rejected" });
  }
  const configuration = configured(env);
  if (configuration === null) {
    try {
      await new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE }).verify(
        envelope,
        "POST",
        OWNER_PHONE_ENROLLMENT_PATH,
        body,
        rawBody,
        new Date(),
        (value) => value,
      );
    } catch (error) {
      return failureResponse(error);
    }
    return response(503, { error: "owner_phone_enrollment_not_configured" });
  }

  try {
    const service = new OwnerPhoneEnrollmentService({
      database: env.DB,
      verifier: new DeviceRequestVerifier({ database: env.DB, audience: SYNC_AUDIENCE }),
      ownerPrincipalId: configuration.ownerPrincipalId,
      ownerIdentityId: configuration.ownerIdentityId,
      hmacPepper: configuration.pepper,
      hmacKeyVersion: configuration.keyVersion,
    });
    return response(200, await service.execute(envelope, body, rawBody));
  } catch (error) {
    return failureResponse(error);
  }
}

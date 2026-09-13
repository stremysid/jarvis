import type { Ulid } from "../../../../packages/contracts/src/index.js";
import type { CapacityGuard } from "../archive/capacity-guard.js";
import type { TwilioRequestVerifier } from "../providers/provider-types.js";
import {
  snapshotVerifiedTwilioFormPairs,
  type VerifiedTwilioForm,
} from "../providers/twilio-verifier.js";
import { snapshotTrustedPublicOrigin } from "../security/trusted-public-origin.js";

export interface VoiceRouteDependencies {
  publicOrigin: URL;
  twilio: TwilioRequestVerifier;
  capacity: Pick<CapacityGuard, "assertAcceptingNewTurn">;
  inbound(request: Request, verifiedForm: VerifiedTwilioForm): Promise<Response>;
  outbound(request: Request, attemptId: Ulid): Promise<Response>;
  relayEnded(form: VerifiedTwilioForm): Promise<Response>;
  relaySession(request: Request, sessionId: Ulid): Promise<Response>;
  status(attemptId: Ulid, form: VerifiedTwilioForm): Promise<Response>;
}

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;

function plainResponse(body: "forbidden" | "not_found" | "unavailable", status: 403 | 404 | 503): Response {
  return new Response(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function ownData(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, name); }
  catch { return undefined; }
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function method(value: unknown, name: string): { receiver: object; call: (...args: never[]) => unknown } | null {
  if (value === null || typeof value !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) {
      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== null) descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    }
  } catch {
    return null;
  }
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
    ? { receiver: value, call: descriptor.value as (...args: never[]) => unknown }
    : null;
}

export async function routeVoiceRequest(
  request: Request,
  dependencies: VoiceRouteDependencies,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return plainResponse("unavailable", 503);
  }
  if (url.search !== "" || url.hash !== "") return plainResponse("not_found", 404);

  if (url.pathname === "/voice/inbound" && request.method === "POST") {
    const trustedOrigin = snapshotTrustedPublicOrigin(ownData(dependencies, "publicOrigin"));
    if (trustedOrigin === null) return plainResponse("unavailable", 503);
    // Authenticate before capacity collection can read providers or send an alert.
    // Consume the original once: an unread clone can retain its stream after rejection.
    const verifier = method(ownData(dependencies, "twilio"), "verifyWebhook");
    if (verifier === null) return plainResponse("unavailable", 503);
    let verifiedForm: VerifiedTwilioForm;
    try {
      const verified = await (verifier.call as TwilioRequestVerifier["verifyWebhook"]).call(verifier.receiver, {
        request, exactUrl: `${trustedOrigin.origin}/voice/inbound`,
      });
      if (verified === null) return plainResponse("forbidden", 403);
      if (snapshotVerifiedTwilioFormPairs(verified) === null) return plainResponse("unavailable", 503);
      verifiedForm = verified;
    } catch { return plainResponse("unavailable", 503); }
    const capacitySnapshot = method(ownData(dependencies, "capacity"), "assertAcceptingNewTurn");
    const capacityThis = capacitySnapshot?.receiver as Pick<CapacityGuard, "assertAcceptingNewTurn">;
    const assertAcceptingNewTurn = capacitySnapshot?.call as CapacityGuard["assertAcceptingNewTurn"];
    if (capacitySnapshot === null) return plainResponse("unavailable", 503);
    try {
      await assertAcceptingNewTurn.call(capacityThis);
    } catch {
      return plainResponse("unavailable", 503);
    }
    const inbound = ownData(dependencies, "inbound");
    if (typeof inbound !== "function") return plainResponse("unavailable", 503);
    try {
      const response: unknown = await inbound.call(dependencies, request, verifiedForm);
      return response instanceof Response ? response : plainResponse("unavailable", 503);
    } catch {
      return plainResponse("unavailable", 503);
    }
  }

  const outboundMatch = url.pathname.match(/^\/voice\/outbound\/([0-7][0-9a-hjkmnp-tv-z]{25})$/u);
  if (outboundMatch !== null && request.method === "POST") {
    const trustedOrigin = snapshotTrustedPublicOrigin(ownData(dependencies, "publicOrigin"));
    const attemptId = outboundMatch[1];
    if (trustedOrigin === null || attemptId === undefined || !ULID.test(attemptId)) {
      return plainResponse("unavailable", 503);
    }
    const outbound = ownData(dependencies, "outbound");
    if (typeof outbound !== "function") return plainResponse("unavailable", 503);
    try {
      const response: unknown = await outbound.call(dependencies, request, attemptId as Ulid);
      return response instanceof Response ? response : plainResponse("unavailable", 503);
    } catch {
      return plainResponse("unavailable", 503);
    }
  }

  const statusMatch = url.pathname.match(/^\/voice\/status\/([0-7][0-9a-hjkmnp-tv-z]{25})$/u);
  if (statusMatch !== null && request.method === "POST") {
    const trustedOrigin = snapshotTrustedPublicOrigin(ownData(dependencies, "publicOrigin"));
    const attemptId = statusMatch[1];
    if (trustedOrigin === null || attemptId === undefined || !ULID.test(attemptId)) {
      return plainResponse("unavailable", 503);
    }
    const verifierSnapshot = method(ownData(dependencies, "twilio"), "verifyWebhook");
    const verifierThis = verifierSnapshot?.receiver as TwilioRequestVerifier;
    const verifyWebhook = verifierSnapshot?.call as TwilioRequestVerifier["verifyWebhook"];
    if (verifierSnapshot === null) return plainResponse("unavailable", 503);
    let form: unknown;
    try {
      form = await verifyWebhook.call(verifierThis, {
        request,
        exactUrl: `${trustedOrigin.origin}/voice/status/${attemptId}`,
      });
    } catch {
      return plainResponse("unavailable", 503);
    }
    if (form === null) return plainResponse("forbidden", 403);
    if (snapshotVerifiedTwilioFormPairs(form) === null) return plainResponse("unavailable", 503);
    const status = ownData(dependencies, "status");
    if (typeof status !== "function") return plainResponse("unavailable", 503);
    try {
      const response: unknown = await status.call(dependencies, attemptId as Ulid, form as VerifiedTwilioForm);
      return response instanceof Response ? response : plainResponse("unavailable", 503);
    } catch {
      return plainResponse("unavailable", 503);
    }
  }

  if (url.pathname === "/voice/relay-ended" && request.method === "POST") {
    const trustedOrigin = snapshotTrustedPublicOrigin(ownData(dependencies, "publicOrigin"));
    if (trustedOrigin === null) return plainResponse("unavailable", 503);
    const verifierSnapshot = method(ownData(dependencies, "twilio"), "verifyWebhook");
    const verifierThis = verifierSnapshot?.receiver as TwilioRequestVerifier;
    const verifyWebhook = verifierSnapshot?.call as TwilioRequestVerifier["verifyWebhook"];
    if (verifierSnapshot === null) return plainResponse("unavailable", 503);
    let form: unknown;
    try {
      form = await verifyWebhook.call(verifierThis, {
        request,
        exactUrl: `${trustedOrigin.origin}/voice/relay-ended`,
      });
    } catch {
      return plainResponse("unavailable", 503);
    }
    if (form === null) return plainResponse("forbidden", 403);
    if (snapshotVerifiedTwilioFormPairs(form) === null) return plainResponse("unavailable", 503);
    const relayEnded = ownData(dependencies, "relayEnded");
    if (typeof relayEnded !== "function") return plainResponse("unavailable", 503);
    try {
      const response: unknown = await relayEnded.call(dependencies, form as VerifiedTwilioForm);
      return response instanceof Response ? response : plainResponse("unavailable", 503);
    } catch {
      return plainResponse("unavailable", 503);
    }
  }

  const relayMatch = url.pathname.match(/^\/voice\/relay\/([0-7][0-9a-hjkmnp-tv-z]{25})$/u);
  if (
    relayMatch !== null
    && request.method === "GET"
    && request.headers.get("upgrade")?.toLowerCase() === "websocket"
  ) {
    const trustedOrigin = snapshotTrustedPublicOrigin(ownData(dependencies, "publicOrigin"));
    const sessionId = relayMatch[1];
    if (trustedOrigin === null || sessionId === undefined || !ULID.test(sessionId)) {
      return plainResponse("unavailable", 503);
    }
    const verifierSnapshot = method(ownData(dependencies, "twilio"), "verifyWebSocket");
    const verifierThis = verifierSnapshot?.receiver as TwilioRequestVerifier;
    const verifyWebSocket = verifierSnapshot?.call as TwilioRequestVerifier["verifyWebSocket"];
    if (verifierSnapshot === null) return plainResponse("unavailable", 503);
    const exactUrl = new URL(`/voice/relay/${sessionId}`, trustedOrigin.origin);
    exactUrl.protocol = "wss:";
    let verified: unknown;
    try {
      verified = await verifyWebSocket.call(verifierThis, {
        request,
        exactUrl: URL.prototype.toString.call(exactUrl),
      });
    } catch {
      return plainResponse("unavailable", 503);
    }
    if (verified === false) return plainResponse("forbidden", 403);
    if (verified !== true) return plainResponse("unavailable", 503);
    const relaySession = ownData(dependencies, "relaySession");
    if (typeof relaySession !== "function") return plainResponse("unavailable", 503);
    try {
      const response: unknown = await relaySession.call(dependencies, request, sessionId as Ulid);
      return response instanceof Response ? response : plainResponse("unavailable", 503);
    } catch {
      return plainResponse("unavailable", 503);
    }
  }

  return plainResponse("not_found", 404);
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderDispatchUnknownError,
  ProviderFailure,
  type TwilioCreateCallInput,
} from "../../src/providers/provider-types.js";
import { TwilioRestProvider } from "../../src/providers/twilio-provider.js";
import { TwilioSignatureVerifier } from "../../src/providers/twilio-verifier.js";

const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const API_KEY_SID = `SK${"2".repeat(32)}`;
const CALL_SID = `CA${"3".repeat(32)}`;
const API_KEY_SECRET = "synthetic-api-secret";
const AUTH_TOKEN = "12345";
const CALLBACK_EVENTS = ["initiated", "ringing", "answered", "completed"] as const;
const PUBLIC_ORIGIN = "https://jarvis.example/";
const ATTEMPT_ID = "01k3s6k8000000000000000009";

class MisleadingUrl extends URL {
  constructor(value: string, private readonly misleadingValue: string) {
    super(value);
  }

  override toString(): string {
    return this.misleadingValue;
  }
}

function callInput(overrides: Partial<TwilioCreateCallInput> = {}): TwilioCreateCallInput {
  return {
    commandId: "01k3s6k8000000000000000000",
    attemptId: ATTEMPT_ID,
    toE164: "+14165550123",
    twimlUrl: new URL(`https://jarvis.example/voice/outbound/${ATTEMPT_ID}`),
    statusCallbackUrl: new URL(`https://jarvis.example/voice/status/${ATTEMPT_ID}`),
    statusCallbackEvents: CALLBACK_EVENTS,
    idempotencyKey: "attempt:01k3s6k8000000000000000001",
    ...overrides,
  };
}

function restProvider(
  fetcher: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof TwilioRestProvider>[0]> = {},
): TwilioRestProvider {
  return new TwilioRestProvider({
    accountSid: ACCOUNT_SID,
    apiKeySid: API_KEY_SID,
    apiKeySecret: API_KEY_SECRET,
    fromE164: "+14165550100",
    requestTimeoutMs: 250,
    ringTimeoutSeconds: 25,
    publicOrigin: new URL(PUBLIC_ORIGIN),
    fetch: fetcher,
    ...overrides,
  });
}

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ account_sid: ACCOUNT_SID, sid: CALL_SID, ...overrides }, { status: 201 });
}

it("sends the exact approved cleanup retry fragment in the Twilio REST body", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => successResponse());
  await restProvider(fetcher).createCall(callInput({
    statusCallbackUrl: new URL(`https://jarvis.example/voice/status/${ATTEMPT_ID}#rc=2&rp=ct,rt,5xx`),
  }));
  expect(new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body)).get("StatusCallback"))
    .toBe(`https://jarvis.example/voice/status/${ATTEMPT_ID}#rc=2&rp=ct,rt,5xx`);
});

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function signatureHeaders(signature: string, contentType = "application/x-www-form-urlencoded; charset=UTF-8"): Headers {
  return new Headers({
    "content-type": contentType,
    "x-twilio-signature": signature,
  });
}

function webhookRequest(
  exactUrl: string,
  signature: string,
  rawBody: Uint8Array,
  contentType = "application/x-www-form-urlencoded; charset=UTF-8",
  extraHeaders: HeadersInit = {},
): Request {
  const headers = signatureHeaders(signature, contentType);
  new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
  return new Request(exactUrl, { method: "POST", headers, body: rawBody });
}

function emptySignedWebhookRequest(signature: string): Request {
  return new Request("https://internal.invalid/twilio-webhook", {
    method: "POST",
    headers: signatureHeaders(signature),
    body: new Uint8Array(),
  });
}

function signedWebSocketRequest(signature: string): Request {
  return new Request("https://internal.invalid/twilio-relay", {
    headers: { "x-twilio-signature": signature },
  });
}

function streamedWebhookRequest(
  exactUrl: string,
  chunks: readonly Uint8Array[],
  contentLength?: string,
): Request {
  const headers = signatureHeaders("AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request(exactUrl, { method: "POST", headers, body });
}

async function signExactUrl(token: string, exactUrl: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(exactUrl)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TwilioSignatureVerifier", () => {
  it("accepts Twilio's published HMAC-SHA1 form fixture and returns its decoded values", async () => {
    const exactUrl = "https://example.com/myapp.php?foo=1&bar=2";
    const rawBody = utf8(
      "CallSid=CA1234567890ABCDE&Caller=%2B14158675310&Digits=1234&From=%2B14158675310&To=%2B18005551212",
    );
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    const request = webhookRequest(exactUrl, "L/OH5YylLD5NRKLltdqwSvS0BnU=", rawBody);
    const verified = await verifier.verifyWebhook({ request, exactUrl });

    expect(verified?.entries()).toEqual([
      ["CallSid", "CA1234567890ABCDE"],
      ["Caller", "+14158675310"],
      ["Digits", "1234"],
      ["From", "+14158675310"],
      ["To", "+18005551212"],
    ]);
    expect(verified?.get("Digits")).toBe("1234");
    expect(request.bodyUsed).toBe(true);
  });

  it("preserves duplicate, additive, whitespace, and case-sensitive form pairs", async () => {
    const exactUrl = "https://jarvis.example/voice/status?encoded=%2f&order=b%20a";
    const body = "Zoo=last&Foo=second&alpha=lower&Foo=%20first%20&Future=value&Foo=second";
    const pairs = [
      ["Zoo", "last"],
      ["Foo", "second"],
      ["alpha", "lower"],
      ["Foo", " first "],
      ["Future", "value"],
      ["Foo", "second"],
    ] as const;
    // Generated independently with twilio-node getExpectedTwilioSignature using the fixture above.
    const signature = "/8v4SAiAZvBE2H7Z2DGhbxKJxAg=";
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    const verified = await verifier.verifyWebhook({
      exactUrl,
      request: webhookRequest(exactUrl, signature, utf8(body)),
    });

    expect(verified?.get("Foo")).toBe("second");
    expect(verified?.getAll("Foo")).toEqual(["second", " first ", "second"]);
    expect(verified?.entries()).toEqual(pairs);
    await expect(verifier.verifyWebhook({
      exactUrl: exactUrl.replace("%2f", "%2F"),
      request: webhookRequest(exactUrl, signature, utf8(body)),
    })).resolves.toBeNull();
  });

  it("returns deeply frozen form snapshots that cannot be mutated by callers", async () => {
    const exactUrl = "https://jarvis.example/voice/status?encoded=%2f&order=b%20a";
    const signature = "/8v4SAiAZvBE2H7Z2DGhbxKJxAg=";
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });
    const verified = await verifier.verifyWebhook({
      exactUrl,
      request: webhookRequest(
        exactUrl,
        signature,
        utf8("Zoo=last&Foo=second&alpha=lower&Foo=%20first%20&Future=value&Foo=second"),
      ),
    });
    if (verified === null) throw new Error("expected verified form");

    const entries = verified.entries();
    const values = verified.getAll("Foo");
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(values)).toBe(true);
    expect(() => (entries as (readonly [string, string])[]).push(["Foo", "forged"])).toThrow();
    expect(() => (values as string[]).push("forged")).toThrow();
    expect(verified.getAll("Foo")).toEqual(["second", " first ", "second"]);
  });

  it.each([
    ["wrong but well-formed signature", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", "application/x-www-form-urlencoded", utf8("A=1")],
    ["non-base64 signature", "not base64", "application/x-www-form-urlencoded", utf8("A=1")],
    ["base64 with surrounding whitespace", " L/OH5YylLD5NRKLltdqwSvS0BnU=", "application/x-www-form-urlencoded", utf8("A=1")],
    ["wrong content type", "L/OH5YylLD5NRKLltdqwSvS0BnU=", "application/json", utf8("A=1")],
    ["truncated percent escape", "L/OH5YylLD5NRKLltdqwSvS0BnU=", "application/x-www-form-urlencoded", utf8("A=%")],
    ["non-hex percent escape", "L/OH5YylLD5NRKLltdqwSvS0BnU=", "application/x-www-form-urlencoded", utf8("A=%GG")],
    ["invalid percent-decoded UTF-8", "L/OH5YylLD5NRKLltdqwSvS0BnU=", "application/x-www-form-urlencoded", utf8("A=%C3%28")],
    ["invalid raw UTF-8", "L/OH5YylLD5NRKLltdqwSvS0BnU=", "application/x-www-form-urlencoded", new Uint8Array([0x41, 0x3d, 0xff])],
    ["oversized body", "L/OH5YylLD5NRKLltdqwSvS0BnU=", "application/x-www-form-urlencoded", utf8(`A=${"x".repeat(65_535)}`)],
  ])("fails closed for %s", async (_case, signature, contentType, rawBody) => {
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    const exactUrl = "https://example.com/myapp.php?foo=1&bar=2";
    await expect(verifier.verifyWebhook({
      exactUrl,
      request: webhookRequest(exactUrl, signature, rawBody, contentType),
    })).resolves.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["dishonest small", "1"],
  ])("streams and rejects a chunked oversized body with %s Content-Length", async (_case, contentLength) => {
    const exactUrl = "https://jarvis.example/voice/status";
    const oversized = utf8(`A=${"x".repeat(65_535)}`);
    const request = streamedWebhookRequest(
      exactUrl,
      [oversized.slice(0, 32_768), oversized.slice(32_768)],
      contentLength,
    );
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    await expect(verifier.verifyWebhook({ request, exactUrl })).resolves.toBeNull();
    expect(request.bodyUsed).toBe(true);
  });

  it("fails closed when the webhook Request body was already consumed", async () => {
    const exactUrl = "https://jarvis.example/voice/status";
    const request = webhookRequest(
      exactUrl,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      utf8("CallSid=CA123"),
    );
    await request.arrayBuffer();
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    await expect(verifier.verifyWebhook({ request, exactUrl })).resolves.toBeNull();
  });

  it("fails closed when the webhook Request body is already locked", async () => {
    const exactUrl = "https://jarvis.example/voice/status";
    const request = webhookRequest(
      exactUrl,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      utf8("CallSid=CA123"),
    );
    const reader = request.body?.getReader();
    if (reader === undefined) throw new Error("expected request body");
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    try {
      await expect(verifier.verifyWebhook({ request, exactUrl })).resolves.toBeNull();
    } finally {
      reader.releaseLock();
    }
  });

  it("verifies a WebSocket GET against the exact WSS URL and no reconstructed variant", async () => {
    const exactUrl = "wss://jarvis.example/voice/relay/session?encoded=%2f&b=2&a=1";
    const signature = await signExactUrl(AUTH_TOKEN, exactUrl);
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });
    const request = new Request("https://internal.invalid/relay", {
      headers: { "x-twilio-signature": signature },
    });

    await expect(verifier.verifyWebSocket({ request, exactUrl })).resolves.toBe(true);
    await expect(verifier.verifyWebSocket({
      exactUrl: exactUrl.replace("%2f", "%2F"),
      request,
    })).resolves.toBe(false);
  });

  it.each([
    ["HTTP scheme", "http://jarvis.example/voice/status"],
    ["WebSocket scheme", "wss://jarvis.example/voice/status"],
    ["userinfo", "https://user:pass@jarvis.example/voice/status"],
    ["fragment", "https://jarvis.example/voice/status#private"],
    ["empty fragment", "https://jarvis.example/voice/status#"],
    ["raw newline", "https://jarvis.example/voice/\nstatus"],
    ["raw NUL", "https://jarvis.example/voice/\u0000status"],
    ["malformed percent escape", "https://jarvis.example/voice/%GGstatus"],
    ["backslash normalization", "https://jarvis.example\\@attacker.invalid/voice/status"],
    ["malformed authority", "https://"],
  ])("rejects a validly signed webhook URL with %s", async (_label, exactUrl) => {
    const signature = await signExactUrl(AUTH_TOKEN, exactUrl);
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    await expect(verifier.verifyWebhook({
      exactUrl,
      request: emptySignedWebhookRequest(signature),
    })).resolves.toBeNull();
  });

  it("validates without replacing the exact webhook bytes used by HMAC", async () => {
    const exactUrl = "https://JARVIS.EXAMPLE:443/voice/./status?encoded=%2f";
    const signature = await signExactUrl(AUTH_TOKEN, exactUrl);
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    const verified = await verifier.verifyWebhook({
      exactUrl,
      request: emptySignedWebhookRequest(signature),
    });

    expect(verified?.entries()).toEqual([]);
  });

  it.each([
    ["HTTPS scheme", "https://jarvis.example/voice/relay/session"],
    ["insecure WebSocket scheme", "ws://jarvis.example/voice/relay/session"],
    ["userinfo", "wss://user:pass@jarvis.example/voice/relay/session"],
    ["fragment", "wss://jarvis.example/voice/relay/session#private"],
    ["empty fragment", "wss://jarvis.example/voice/relay/session#"],
    ["raw tab", "wss://jarvis.example/voice/\trelay/session"],
    ["raw NUL", "wss://jarvis.example/voice/\u0000relay/session"],
    ["malformed percent escape", "wss://jarvis.example/voice/%GGrelay/session"],
    ["backslash normalization", "wss://jarvis.example\\@attacker.invalid/voice/relay/session"],
    ["malformed authority", "wss://"],
  ])("rejects a validly signed WebSocket URL with %s", async (_label, exactUrl) => {
    const signature = await signExactUrl(AUTH_TOKEN, exactUrl);
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    await expect(verifier.verifyWebSocket({
      exactUrl,
      request: signedWebSocketRequest(signature),
    })).resolves.toBe(false);
  });

  it("validates without replacing the exact WebSocket bytes used by HMAC", async () => {
    const exactUrl = "wss://JARVIS.EXAMPLE:443/voice/./relay/session?encoded=%2f";
    const signature = await signExactUrl(AUTH_TOKEN, exactUrl);
    const verifier = new TwilioSignatureVerifier({ authToken: AUTH_TOKEN });

    await expect(verifier.verifyWebSocket({
      exactUrl,
      request: signedWebSocketRequest(signature),
    })).resolves.toBe(true);
  });
});

describe("TwilioRestProvider", () => {
  it("posts one exact fixed-host request with API-key auth and all call controls", async () => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch);

    await expect(provider.createCall(callInput())).resolves.toEqual({ callSid: CALL_SID });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetcher.mock.calls[0]!;
    expect(requestUrl).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      `To=%2B14165550123&From=%2B14165550100&Url=https%3A%2F%2Fjarvis.example%2Fvoice%2Foutbound%2F${ATTEMPT_ID}&Method=POST&StatusCallback=https%3A%2F%2Fjarvis.example%2Fvoice%2Fstatus%2F${ATTEMPT_ID}&StatusCallbackMethod=POST&StatusCallbackEvent=initiated&StatusCallbackEvent=ringing&StatusCallbackEvent=answered&StatusCallbackEvent=completed&TimeLimit=1800&Timeout=25`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${API_KEY_SID}:${API_KEY_SECRET}`)}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(headers.has("idempotency-key")).toBe(false);
    expect(headers.has("x-idempotency-key")).toBe(false);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("accepts a TwiML route bound to the immutable attempt identity", async () => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch);
    const input = callInput();

    await expect(provider.createCall(input)).resolves.toEqual({ callSid: CALL_SID });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a TwiML route bound to command lineage instead of the attempt", async () => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch);
    const input = callInput({
      twimlUrl: new URL("https://jarvis.example/voice/outbound/01k3s6k8000000000000000000"),
    });

    await expect(provider.createCall(input)).rejects.toBeInstanceOf(ProviderFailure);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a status callback route bound to the immutable attempt identity", async () => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch);
    const input = callInput({
      statusCallbackUrl: new URL(`https://jarvis.example/voice/status/${ATTEMPT_ID}`),
    });

    await expect(provider.createCall(input)).resolves.toEqual({ callSid: CALL_SID });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["global", "https://jarvis.example/voice/status"],
    ["command-bound", "https://jarvis.example/voice/status/01k3s6k8000000000000000000"],
    ["other-attempt", "https://jarvis.example/voice/status/01k3s6k8000000000000000008"],
  ])("rejects a %s status callback route", async (_label, url) => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch);

    await expect(provider.createCall(callInput({
      statusCallbackUrl: new URL(url),
    }))).rejects.toBeInstanceOf(ProviderFailure);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["attacker TwiML origin", { twimlUrl: new URL(`https://attacker.invalid/voice/outbound/${ATTEMPT_ID}`) }],
    ["attacker callback origin", { statusCallbackUrl: new URL(`https://attacker.invalid/voice/status/${ATTEMPT_ID}`) }],
    ["TwiML query data", { twimlUrl: new URL(`https://jarvis.example/voice/outbound/${ATTEMPT_ID}?identity=private`) }],
    ["callback query data", { statusCallbackUrl: new URL(`https://jarvis.example/voice/status/${ATTEMPT_ID}?identity=private`) }],
    ["TwiML nondefault port", { twimlUrl: new URL(`https://jarvis.example:8443/voice/outbound/${ATTEMPT_ID}`) }],
    ["callback nondefault port", { statusCallbackUrl: new URL(`https://jarvis.example:8443/voice/status/${ATTEMPT_ID}`) }],
    ["TwiML route mismatch", { twimlUrl: new URL("https://jarvis.example/voice/inbound") }],
    ["TwiML attempt mismatch", { twimlUrl: new URL("https://jarvis.example/voice/outbound/01k3s6k8000000000000000008") }],
    ["invalid attempt identity", { attemptId: "private-identity", twimlUrl: new URL("https://jarvis.example/voice/outbound/private-identity") }],
    ["callback route mismatch", { statusCallbackUrl: new URL("https://jarvis.example/voice/relay-ended") }],
  ])("rejects %s before sending a call", async (_label, overrides) => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch);

    await expect(provider.createCall(callInput(overrides))).rejects.toBeInstanceOf(ProviderFailure);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serializes URL internal slots instead of an overridable toString method", async () => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch);
    const input = callInput({
      twimlUrl: new MisleadingUrl(
        `https://jarvis.example/voice/outbound/${ATTEMPT_ID}`,
        "https://attacker.invalid/collect-twiml",
      ),
      statusCallbackUrl: new MisleadingUrl(
        `https://jarvis.example/voice/status/${ATTEMPT_ID}`,
        "https://attacker.invalid/collect-status",
      ),
    });

    await provider.createCall(input);

    const body = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.get("Url")).toBe(`https://jarvis.example/voice/outbound/${ATTEMPT_ID}`);
    expect(body.get("StatusCallback")).toBe(`https://jarvis.example/voice/status/${ATTEMPT_ID}`);
  });

  it("snapshots the configured public origin through URL internal slots", async () => {
    const fetcher = vi.fn(async () => successResponse());
    const provider = restProvider(fetcher as typeof fetch, {
      publicOrigin: new MisleadingUrl("https://attacker.invalid/", PUBLIC_ORIGIN),
    });

    await expect(provider.createCall(callInput())).rejects.toBeInstanceOf(ProviderFailure);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, "provider_authentication_failure", "authentication"],
    [403, "provider_authentication_failure", "authentication"],
    [429, "provider_transient_failure", "rate_limited"],
    [400, "provider_permanent_failure", "invalid_request"],
    [422, "provider_permanent_failure", "invalid_request"],
  ])("classifies an explicit %i rejection without retrying", async (status, code, category) => {
    const fetcher = vi.fn(async () => new Response("provider detail must stay private", { status }));
    const provider = restProvider(fetcher as typeof fetch);

    await expect(provider.createCall(callInput())).rejects.toMatchObject({ code, category });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["server response", async () => new Response("temporary provider detail", { status: 503 })],
    ["temporary redirect", async () => new Response(null, { status: 307, headers: { location: "https://attacker.invalid/" } })],
    ["permanent redirect", async () => new Response(null, { status: 308, headers: { location: "https://attacker.invalid/" } })],
    ["network failure", async () => { throw new Error("synthetic network detail"); }],
    ["malformed success", async () => new Response("not json", { status: 201 })],
    ["unexpected 200", async () => Response.json({ account_sid: ACCOUNT_SID, sid: CALL_SID }, { status: 200 })],
    ["unexpected 202", async () => Response.json({ account_sid: ACCOUNT_SID, sid: CALL_SID }, { status: 202 })],
    ["empty success", async () => new Response(null, { status: 204 })],
    ["mismatched account", async () => successResponse({ account_sid: `AC${"4".repeat(32)}` })],
    ["invalid call SID", async () => successResponse({ sid: "CAinvalid" })],
    ["oversized success", async () => new Response("x".repeat(65_537), { status: 201 })],
  ])("contains an indeterminate %s as provider_dispatch_unknown without retry", async (_case, behavior) => {
    const fetcher = vi.fn(behavior);
    const provider = restProvider(fetcher as typeof fetch);

    let error: unknown;
    try {
      await provider.createCall(callInput());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderDispatchUnknownError);
    expect(error).toMatchObject({
      code: "provider_dispatch_unknown",
      operation: "twilio.createCall",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("contains an aborted request as provider_dispatch_unknown after the configured deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const provider = restProvider(fetcher as typeof fetch, { requestTimeoutMs: 100 });

    const pending = provider.createCall(callInput());
    const outcome = expect(pending).rejects.toBeInstanceOf(ProviderDispatchUnknownError);
    await vi.advanceTimersByTimeAsync(100);

    await outcome;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed provider configuration before any request can be sent", () => {
    const fetcher = vi.fn(async () => successResponse());

    expect(() => restProvider(fetcher as typeof fetch, { accountSid: "ACinvalid" })).toThrow(ProviderFailure);
    expect(() => restProvider(fetcher as typeof fetch, { ringTimeoutSeconds: 601 })).toThrow(ProviderFailure);
    expect(() => restProvider(fetcher as typeof fetch, { requestTimeoutMs: 60_001 })).toThrow(ProviderFailure);
    expect(() => restProvider(fetcher as typeof fetch, { publicOrigin: new URL("https://jarvis.example/tenant") })).toThrow(ProviderFailure);
    expect(() => restProvider(fetcher as typeof fetch, { publicOrigin: new URL("https://jarvis.example/?identity=private") })).toThrow(ProviderFailure);
    expect(() => restProvider(fetcher as typeof fetch, { publicOrigin: new URL("https://jarvis.example:8443/") })).toThrow(ProviderFailure);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

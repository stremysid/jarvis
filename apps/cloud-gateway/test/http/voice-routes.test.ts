import { describe, expect, it } from "vitest";
import {
  routeVoiceRequest,
  type VoiceRouteDependencies,
} from "../../src/http/voice-routes.js";
import { FakeTwilioProvider } from "../../src/providers/fake-twilio-provider.js";

async function exactResponse(response: Response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
}

function dependencies(overrides: Record<string, unknown> = {}): VoiceRouteDependencies {
  return {
    publicOrigin: new URL("https://jarvis.example/"),
    twilio: {
      verifyWebhook: async () => null,
      verifyWebSocket: async () => false,
    },
    capacity: { assertAcceptingNewTurn: async () => undefined },
    inbound: async () => new Response("Not implemented", { status: 501 }),
    outbound: async () => new Response("Not implemented", { status: 501 }),
    status: async () => new Response("Not implemented", { status: 501 }),
    relayEnded: async () => new Response("Not implemented", { status: 501 }),
    relaySession: async () => new Response("Not implemented", { status: 501 }),
    ...overrides,
  } as VoiceRouteDependencies;
}

describe("routeVoiceRequest", () => {
  it("rejects a query-bearing voice path before evaluating dependencies", async () => {
    let dependencyReads = 0;
    const unavailableDependencies = new Proxy({} as VoiceRouteDependencies, {
      getOwnPropertyDescriptor: () => {
        dependencyReads += 1;
        throw new Error("provider token must not be read");
      },
    });

    const response = await routeVoiceRequest(
      new Request("https://attacker.invalid/voice/inbound?CallSid=private"),
      unavailableDependencies,
    );

    expect(dependencyReads).toBe(0);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 404,
      cacheControl: "no-store",
      body: "not_found",
    });
  });

  it("classifies an unknown route before evaluating dependencies", async () => {
    let dependencyReads = 0;
    const unavailableDependencies = new Proxy({} as VoiceRouteDependencies, {
      getOwnPropertyDescriptor: () => {
        dependencyReads += 1;
        throw new Error("provider construction must not run");
      },
    });

    const response = await routeVoiceRequest(
      new Request("https://worker.internal/voice/unknown"),
      unavailableDependencies,
    );

    expect(dependencyReads).toBe(0);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 404,
      cacheControl: "no-store",
      body: "not_found",
    });
  });

  it("fails closed on invalid public-origin configuration before constructing route adapters", async () => {
    const id = "01k3s6k8000000000000000001";
    const requests = [
      new Request("https://worker.internal/voice/inbound", { method: "POST" }),
      new Request(`https://worker.internal/voice/outbound/${id}`, { method: "POST" }),
      new Request(`https://worker.internal/voice/status/${id}`, { method: "POST" }),
      new Request("https://worker.internal/voice/relay-ended", { method: "POST" }),
      new Request(`https://worker.internal/voice/relay/${id}`, { headers: { upgrade: "websocket" } }),
    ];

    for (const request of requests) {
      const adapterReads: PropertyKey[] = [];
      const invalidConfiguration = new Proxy(
        { publicOrigin: new URL("http://jarvis.example/") } as VoiceRouteDependencies,
        {
          getOwnPropertyDescriptor: (target, property) => {
            if (property !== "publicOrigin") adapterReads.push(property);
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );

      const response = await routeVoiceRequest(request, invalidConfiguration);

      expect(adapterReads, request.url).toEqual([]);
      await expect(exactResponse(response)).resolves.toEqual({
        status: 503,
        cacheControl: "no-store",
        body: "unavailable",
      });
    }
  });

  it("delegates exact inbound POSTs without consuming or replacing the original request", async () => {
    const request = new Request("https://worker.internal/voice/inbound", {
      method: "POST",
      body: "CallSid=private",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    let observedRequest: Request | null = null;
    const response = await routeVoiceRequest(request, dependencies({
      inbound: async (candidate) => {
        observedRequest = candidate;
        return new Response("Not implemented", { status: 501 });
      },
    }));

    expect(observedRequest).toBe(request);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 501,
      cacheControl: null,
      body: "Not implemented",
    });
  });

  it("fails closed at capacity before reading or invoking the inbound handler", async () => {
    const events: string[] = [];
    const routeDependencies = dependencies({
      capacity: {
        assertAcceptingNewTurn: async () => {
          events.push("capacity");
          throw new Error("private capacity detail");
        },
      },
      inbound: async () => {
        events.push("inbound");
        return new Response("must not run");
      },
    });
    const guardedDependencies = new Proxy(routeDependencies, {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "inbound") events.push("inbound-read");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const response = await routeVoiceRequest(
      new Request("https://worker.internal/voice/inbound", { method: "POST" }),
      guardedDependencies,
    );

    expect(events).toEqual(["capacity"]);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 503,
      cacheControl: "no-store",
      body: "unavailable",
    });
  });

  it("verifies the exact trusted relay URL before touching a session", async () => {
    const sessionId = "01k3s6k8000000000000000001";
    const request = new Request(`https://forwarded.attacker/voice/relay/${sessionId}`, {
      headers: {
        upgrade: "websocket",
        "x-twilio-signature": "invalid",
      },
    });
    const verificationInputs: { request: Request; exactUrl: string }[] = [];
    let relayCalls = 0;
    let relayAdapterReads = 0;
    const routeDependencies = dependencies({
      twilio: {
        verifyWebhook: async () => null,
        verifyWebSocket: async (input: { request: Request; exactUrl: string }) => {
          verificationInputs.push(input);
          return false;
        },
      },
      relaySession: async () => {
        relayCalls += 1;
        return new Response("must not run");
      },
    });
    const response = await routeVoiceRequest(request, new Proxy(routeDependencies, {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "relaySession") relayAdapterReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }));

    expect(verificationInputs).toEqual([{
      request,
      exactUrl: `wss://jarvis.example/voice/relay/${sessionId}`,
    }]);
    expect(relayAdapterReads).toBe(0);
    expect(relayCalls).toBe(0);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 403,
      cacheControl: "no-store",
      body: "forbidden",
    });
  });

  it("forwards an exactly verified relay upgrade without replacing the request or 501", async () => {
    const sessionId = "01k3s6k8000000000000000001";
    const request = new Request(`https://worker.internal/voice/relay/${sessionId}`, {
      headers: { upgrade: "WebSocket" },
    });
    const relayInputs: { request: Request; sessionId: string }[] = [];
    const response = await routeVoiceRequest(request, dependencies({
      twilio: {
        verifyWebhook: async () => null,
        verifyWebSocket: async () => true,
      },
      relaySession: async (candidate: Request, candidateSessionId: string) => {
        relayInputs.push({ request: candidate, sessionId: candidateSessionId });
        return new Response("Not implemented", { status: 501 });
      },
    }));

    expect(relayInputs).toEqual([{ request, sessionId }]);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 501,
      cacheControl: null,
      body: "Not implemented",
    });
  });

  it("delegates only a canonical outbound attempt POST and preserves its 501", async () => {
    const attemptId = "01k3s6k8000000000000000001";
    const request = new Request(`https://worker.internal/voice/outbound/${attemptId}`, {
      method: "POST",
      body: "CallSid=private",
    });
    const outboundInputs: { request: Request; attemptId: string }[] = [];
    const response = await routeVoiceRequest(request, dependencies({
      outbound: async (candidate: Request, candidateAttemptId: string) => {
        outboundInputs.push({ request: candidate, attemptId: candidateAttemptId });
        return new Response("Not implemented", { status: 501 });
      },
    }));

    expect(outboundInputs).toEqual([{ request, attemptId }]);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 501,
      cacheControl: null,
      body: "Not implemented",
    });
  });

  it("verifies a status callback before exposing it to callback reduction", async () => {
    const attemptId = "01k3s6k8000000000000000001";
    const request = new Request(`https://forwarded.attacker/voice/status/${attemptId}`, {
      method: "POST",
      body: "CallSid=CA00000000000000000000000000000001&CallbackSource=call-progress-events&SequenceNumber=0",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "invalid",
      },
    });
    const fake = new FakeTwilioProvider();
    fake.signatureValid = false;
    const verificationInputs: { request: Request; exactUrl: string }[] = [];
    let statusCalls = 0;
    const response = await routeVoiceRequest(request, dependencies({
      twilio: {
        verifyWebhook: async (input: { request: Request; exactUrl: string }) => {
          verificationInputs.push(input);
          return fake.verifyWebhook(input);
        },
        verifyWebSocket: async () => false,
      },
      status: async () => {
        statusCalls += 1;
        return new Response("must not run");
      },
    }));

    expect(verificationInputs).toEqual([{
      request,
      exactUrl: `https://jarvis.example/voice/status/${attemptId}`,
    }]);
    expect(statusCalls).toBe(0);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 403,
      cacheControl: "no-store",
      body: "forbidden",
    });
  });

  it("passes only a genuine verified status form and canonical attempt id to reduction", async () => {
    const attemptId = "01k3s6k8000000000000000001";
    const exactUrl = `https://jarvis.example/voice/status/${attemptId}`;
    const rawBody = new TextEncoder().encode(
      "CallSid=CA00000000000000000000000000000001&CallbackSource=call-progress-events&SequenceNumber=0",
    );
    const fake = new FakeTwilioProvider();
    const request = new Request(`https://worker.internal/voice/status/${attemptId}`, {
      method: "POST",
      body: rawBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": await fake.signWebhook(exactUrl, rawBody),
      },
    });
    const observed: { attemptId: string; callSids: readonly string[] }[] = [];
    const response = await routeVoiceRequest(request, dependencies({
      twilio: fake,
      status: async (candidateAttemptId: string, form: { getAll(name: string): readonly string[] }) => {
        observed.push({ attemptId: candidateAttemptId, callSids: form.getAll("CallSid") });
        return new Response("Not implemented", { status: 501 });
      },
    }));

    expect(observed).toEqual([{
      attemptId,
      callSids: ["CA00000000000000000000000000000001"],
    }]);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 501,
      cacheControl: null,
      body: "Not implemented",
    });
  });

  it("verifies relay-ended ingress and passes only its genuine form to reduction", async () => {
    const exactUrl = "https://jarvis.example/voice/relay-ended";
    const rawBody = new TextEncoder().encode(
      "CallSid=CA00000000000000000000000000000001&SessionId=VX00000000000000000000000000000001",
    );
    const fake = new FakeTwilioProvider();
    const request = new Request("https://worker.internal/voice/relay-ended", {
      method: "POST",
      body: rawBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": await fake.signWebhook(exactUrl, rawBody),
      },
    });
    const verificationInputs: { request: Request; exactUrl: string }[] = [];
    const observedSessionIds: (readonly string[])[] = [];
    const response = await routeVoiceRequest(request, dependencies({
      twilio: {
        verifyWebhook: async (input: { request: Request; exactUrl: string }) => {
          verificationInputs.push(input);
          return fake.verifyWebhook(input);
        },
        verifyWebSocket: async () => false,
      },
      relayEnded: async (form: { getAll(name: string): readonly string[] }) => {
        observedSessionIds.push(form.getAll("SessionId"));
        return new Response("Not implemented", { status: 501 });
      },
    }));

    expect(verificationInputs).toEqual([{ request, exactUrl }]);
    expect(observedSessionIds).toEqual([["VX00000000000000000000000000000001"]]);
    await expect(exactResponse(response)).resolves.toEqual({
      status: 501,
      cacheControl: null,
      body: "Not implemented",
    });
  });
});

import { describe, expect, it } from "vitest";
import { createVoiceRouteDependencies } from "../../src/http/voice-route-construction.js";
import { routeVoiceRequest } from "../../src/http/voice-routes.js";
import { FakeTwilioProvider } from "../../src/providers/fake-twilio-provider.js";

const ATTEMPT_ID = "01k3s6k8000000000000000001";
const CALL_SID = `CA${"1".repeat(32)}`;

async function signedPost(fake: FakeTwilioProvider, exactUrl: string, fields: string): Promise<Request> {
  const rawBody = new TextEncoder().encode(fields);
  return new Request("https://worker.internal/callback", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": await fake.signWebhook(exactUrl, rawBody),
    },
    body: rawBody,
  });
}

describe("createVoiceRouteDependencies", () => {
  it("forwards Task 6 owner authority into the signed inbound boundary", async () => {
    const fake = new FakeTwilioProvider();
    fake.signatureValid = false;
    const dependencies = createVoiceRouteDependencies({
      publicOrigin: new URL("https://jarvis.example/"),
      twilio: fake,
      capacity: { assertAcceptingNewTurn: async () => undefined },
      inbound: {
        expectedInboundE164: "+14165550100",
        ownerIdentityId: "identity:voice",
        currentChallengeHmacKeyVersion: "hmac-v1",
        ownerCallAlerts: { alert: async () => undefined },
        sessions: {
          getOrCreateInboundSession: async () => { throw new Error("must not run"); },
        },
        initializeSession: async () => { throw new Error("must not run"); },
        now: () => new Date("2026-08-30T12:00:00.000Z"),
      },
    });

    const response = await routeVoiceRequest(new Request(
      "https://worker.internal/voice/inbound",
      { method: "POST" },
    ), dependencies);

    expect(response.status).toBe(403);
  });

  it("fails inbound capacity closed while preserving other signed 501 boundaries", async () => {
    const fake = new FakeTwilioProvider();
    const dependencies = createVoiceRouteDependencies({
      publicOrigin: new URL("https://jarvis.example/"),
      twilio: fake,
    });
    const requests = [
      await signedPost(fake, "https://jarvis.example/voice/inbound", ""),
      new Request(`https://worker.internal/voice/outbound/${ATTEMPT_ID}`, { method: "POST" }),
      await signedPost(
        fake,
        `https://jarvis.example/voice/status/${ATTEMPT_ID}`,
        `CallSid=${CALL_SID}&CallbackSource=call-progress-events&SequenceNumber=0&CallStatus=ringing`,
      ),
      await signedPost(
        fake,
        "https://jarvis.example/voice/relay-ended",
        `CallSid=${CALL_SID}&SessionId=VX${"2".repeat(32)}&SessionStatus=completed&SessionDuration=1`,
      ),
      new Request(`https://worker.internal/voice/relay/${ATTEMPT_ID}`, {
        headers: {
          upgrade: "websocket",
          "x-twilio-signature": await fake.signWebSocket(`wss://jarvis.example/voice/relay/${ATTEMPT_ID}`),
        },
      }),
    ];
    const paths = [
      "/voice/inbound",
      `/voice/outbound/${ATTEMPT_ID}`,
      `/voice/status/${ATTEMPT_ID}`,
      "/voice/relay-ended",
      `/voice/relay/${ATTEMPT_ID}`,
    ];
    const expectedStatuses = [503, 501, 501, 501, 501];

    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const path = paths[index];
      const expectedStatus = expectedStatuses[index];
      if (request === undefined || path === undefined || expectedStatus === undefined) {
        throw new Error("fixture_request_missing");
      }
      const routed = new Request(`https://worker.internal${path}`, request);
      const response = await routeVoiceRequest(routed, dependencies);
      expect(response.status, path).toBe(expectedStatus);
      expect(await response.text(), path).toBe(expectedStatus === 503 ? "unavailable" : "Not implemented");
    }
  });

  it("snapshots Task 7 port fields once during construction rather than per request", async () => {
    const fake = new FakeTwilioProvider();
    fake.signatureValid = false;
    let portReads = 0;
    const outbound = new Proxy({
      recipients: { resolveActiveVerifiedVoiceIdentityId: async () => null },
      calls: {
        claimExpectedCall: async () => null,
        getOrCreateOutboundSession: async () => { throw new Error("must not run"); },
      },
      ownerCallAlerts: { alert: async () => undefined },
      initializeSession: async () => undefined,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    }, {
      getOwnPropertyDescriptor: (target, property) => {
        portReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const dependencies = createVoiceRouteDependencies({
      publicOrigin: new URL("https://jarvis.example/"),
      twilio: fake,
      outbound: { ...outbound, ownerIdentityId: "identity:voice" },
    });
    const readsAfterConstruction = portReads;

    const response = await routeVoiceRequest(new Request(
      `https://worker.internal/voice/outbound/${ATTEMPT_ID}`,
      { method: "POST" },
    ), dependencies);

    expect(response.status).toBe(403);
    expect(portReads).toBe(readsAfterConstruction);
  });
});

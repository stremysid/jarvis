import { describe, expect, it } from "vitest";
import {
  canonicalize,
  createJarvisTokenBridgeRequestV1,
  encodeJarvisTokenBridgeEventSseFrameV1,
  type JarvisTokenBridgeEventV1,
  type JarvisTokenBridgeRequestHashMaterialV1,
} from "../../../../packages/contracts/src/index.js";
import { FakeHermesTokenBridge } from "../../src/providers/fake-hermes-token-bridge.js";

const credential = "synthetic-bridge-credential";
const requestId = "01k3s6k8000000000000000003" as JarvisTokenBridgeRequestHashMaterialV1["requestId"];

async function requestBody(userText = "hello"): Promise<Uint8Array> {
  const request = await createJarvisTokenBridgeRequestV1({
    schemaVersion: "1.0",
    requestId,
    correlationId: requestId,
    principalId: "principal:sid",
    channel: "voice",
    userText,
    context: [{
      sourceEventId: "01k3s6k8000000000000000004" as JarvisTokenBridgeRequestHashMaterialV1["requestId"],
      text: "remembered",
      sensitivity: "personal",
    }],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 8_000,
    timeoutMs: 30_000,
    contextTokenBudget: 32_000,
    maxOutputCharacters: 65_536,
  });
  return canonicalize(request);
}

function init(body: BodyInit, overrides: RequestInit = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body,
    redirect: "manual",
    ...overrides,
  };
}

const events: readonly JarvisTokenBridgeEventV1[] = Object.freeze([
  Object.freeze({ schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: "hello" }),
  Object.freeze({ schemaVersion: "1.0", requestId, eventIndex: 1, type: "completed", outputHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }),
]);

describe("FakeHermesTokenBridge", () => {
  it("validates a canonical authenticated request and replays it without a second logical run", async () => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "stream", events }],
    });
    const body = await requestBody();

    const first = await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(body));
    const replay = await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(body));

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/event-stream");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([
      ...encodeJarvisTokenBridgeEventSseFrameV1(events[0]),
      ...encodeJarvisTokenBridgeEventSseFrameV1(events[1]),
    ]));
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(new Uint8Array([
      ...encodeJarvisTokenBridgeEventSseFrameV1(events[0]),
      ...encodeJarvisTokenBridgeEventSseFrameV1(events[1]),
    ]));
    expect(bridge.logicalRunCount).toBe(1);
    expect(bridge.requestLog).toHaveLength(2);
    expect(Object.isFrozen(bridge.requestLog)).toBe(true);
    expect(Object.isFrozen(bridge.requestLog[0])).toBe(true);
    expect(bridge.ledger[requestId]?.requestHash).toBe("235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3");
    expect(Object.isFrozen(bridge.ledger)).toBe(true);
  });

  it("rejects wrong URL, authentication, content type, and noncanonical request bytes before ledger work", async () => {
    const body = await requestBody();
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential });
    const wrongAuth = init(body, { headers: { authorization: "Bearer wrong", "content-type": "application/json" } });
    const whitespace = new TextEncoder().encode(` ${new TextDecoder().decode(body)}`);

    expect((await bridge.fetch("http://127.0.0.1:8790/wrong", init(body))).status).toBe(404);
    expect((await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", wrongAuth)).status).toBe(401);
    expect((await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(body, { headers: { authorization: `Bearer ${credential}`, "content-type": "text/plain" } }))).status).toBe(400);
    expect((await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(whitespace))).status).toBe(400);
    expect(bridge.logicalRunCount).toBe(0);
    expect(Object.keys(bridge.ledger)).toHaveLength(0);
  });

  it("returns an exact conflict for changed material under an existing request ID", async () => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "not_started" }],
    });

    expect((await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(await requestBody()))).status).toBe(503);
    const conflict = await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(await requestBody("changed")));

    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toBe(`{"code":"request_conflict","requestId":"${requestId}","schemaVersion":"1.0"}`);
    expect(bridge.logicalRunCount).toBe(0);
  });

  it.each([
    ["not_started", 503, "not_started", 0],
    ["ledger_capacity_exhausted", 507, "ledger_capacity_exhausted", 0],
    ["admission_unknown", 502, "model_admission_unknown", 1],
  ] as const)("scripts %s deterministically", async (kind, status, code, logicalRuns) => {
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential, runScripts: [{ kind }] });

    const response = await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(await requestBody()));

    expect(response.status).toBe(status);
    expect(await response.text()).toBe(`{"code":"${code}","requestId":"${requestId}","schemaVersion":"1.0"}`);
    expect(bridge.logicalRunCount).toBe(logicalRuns);
  });

  it("validates cancellation material and counts one logical stop across pending and terminal polls", async () => {
    const body = await requestBody();
    const request = JSON.parse(new TextDecoder().decode(body)) as { requestHash: string };
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "stream", events }],
      cancelScripts: [
        { kind: "status", status: "cancel_requested" },
        { kind: "status", status: "cancelled" },
      ],
    });
    await bridge.fetch("http://127.0.0.1:8790/v1/token-runs", init(body));
    const cancelBody = canonicalize({ schemaVersion: "1.0", requestId, requestHash: request.requestHash });
    const url = `http://127.0.0.1:8790/v1/token-runs/${requestId}/cancel`;

    const pending = await bridge.fetch(url, init(cancelBody));
    const terminal = await bridge.fetch(url, init(cancelBody));

    expect(pending.status).toBe(202);
    expect(terminal.status).toBe(200);
    expect(await terminal.text()).toBe(`{"requestId":"${requestId}","schemaVersion":"1.0","status":"cancelled"}`);
    expect(bridge.logicalStopCount).toBe(1);
    expect(bridge.cancelLog).toHaveLength(2);
    expect(Object.isFrozen(bridge.cancelLog)).toBe(true);
  });
});

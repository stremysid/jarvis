import { describe, expect, it } from "vitest";
import {
  createJarvisTokenBridgeRequestV1,
  createJarvisTokenBridgeEventChainV1,
  encodeJarvisTokenBridgeEventSseFrameV1,
  parseJarvisTokenBridgeAdmissionFailureV1,
  parseJarvisTokenBridgeCancelRequestV1,
  parseJarvisTokenBridgeCancelResponseV1,
  parseJarvisTokenBridgeEventV1,
  parseJarvisTokenBridgeEventSseFrameV1,
  parseJarvisTokenBridgeReadinessV1,
  parseJarvisTokenBridgeRequestV1,
  type JarvisTokenBridgeRequestHashMaterialV1,
} from "../src/hermes-token-bridge.js";
import type { Sha256Hex } from "../src/ids.js";

const requestId = "01k3s6k8000000000000000003";
const requestMaterial: JarvisTokenBridgeRequestHashMaterialV1 = {
  schemaVersion: "1.0",
  requestId: requestId as JarvisTokenBridgeRequestHashMaterialV1["requestId"],
  correlationId: requestId as JarvisTokenBridgeRequestHashMaterialV1["correlationId"],
  principalId: "principal:sid",
  channel: "voice",
  userText: "hello",
  context: [{ sourceEventId: "01k3s6k8000000000000000004" as JarvisTokenBridgeRequestHashMaterialV1["requestId"], text: "remembered", sensitivity: "personal" }],
  reasoningEffort: "low",
  firstTokenTimeoutMs: 8_000,
  timeoutMs: 30_000,
  contextTokenBudget: 32_000,
  maxOutputCharacters: 65_536,
};

describe("H1 token bridge contract", () => {
  it("creates the frozen canonical request hash and detached immutable output", async () => {
    const request = await createJarvisTokenBridgeRequestV1(requestMaterial);

    expect(request.requestHash).toBe("235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3");
    expect(request).toEqual({ ...requestMaterial, requestHash: request.requestHash });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.context)).toBe(true);
    expect(Object.isFrozen(request.context[0])).toBe(true);
    expect(() => { (request.context as unknown as { text: string }[])[0].text = "changed"; }).toThrow();
    expect(request.context[0].text).toBe("remembered");
  });

  it("requires exact plain request records without accessors, non-NFC text, identity mismatches, or invalid channels", () => {
    const parsed = { ...requestMaterial, requestHash: "235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3" };
    expect(parseJarvisTokenBridgeRequestV1(parsed)).toEqual(parsed);
    expect(() => parseJarvisTokenBridgeRequestV1({ ...parsed, extra: true })).toThrow();
    const missing = { ...parsed } as Record<string, unknown>;
    delete missing.userText;
    expect(() => parseJarvisTokenBridgeRequestV1(missing)).toThrow();
    expect(() => parseJarvisTokenBridgeRequestV1({ ...parsed, correlationId: "01k3s6k8000000000000000004" })).toThrow();
    expect(() => parseJarvisTokenBridgeRequestV1({ ...parsed, requestId: "invalid" })).toThrow();
    expect(() => parseJarvisTokenBridgeRequestV1({ ...parsed, userText: "e\u0301" })).toThrow("NFC");
    expect(() => parseJarvisTokenBridgeRequestV1({ ...parsed, channel: "chat" })).toThrow();
    expect(() => parseJarvisTokenBridgeRequestV1({ ...parsed, timeoutMs: 0 })).toThrow();
    expect(() => parseJarvisTokenBridgeRequestV1(Object.create(parsed, {
      principalId: { enumerable: true, get: () => "principal:sid" },
    }))).toThrow();
  });

  it("hashes changed material under the same request identity differently", async () => {
    const changed = await createJarvisTokenBridgeRequestV1({ ...requestMaterial, userText: "changed" });

    expect(changed.requestId).toBe(requestId);
    expect(changed.correlationId).toBe(requestId);
    expect(changed.requestHash).not.toBe("235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3");
  });

  it("parses the closed event, admission, cancellation, and readiness bodies", () => {
    expect(parseJarvisTokenBridgeEventV1({ schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: "hello" })).toEqual(
      { schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: "hello" },
    );
    expect(() => parseJarvisTokenBridgeEventV1({ schemaVersion: "1.0", requestId, eventIndex: 1, type: "completed", outputHash: "0".repeat(64), transcriptHash: "0".repeat(64) })).toThrow();
    expect(parseJarvisTokenBridgeAdmissionFailureV1({ schemaVersion: "1.0", requestId, code: "ledger_capacity_exhausted" }).code).toBe("ledger_capacity_exhausted");
    expect(() => parseJarvisTokenBridgeAdmissionFailureV1({ schemaVersion: "1.0", requestId, code: "not_started", detail: "x" })).toThrow();
    expect(parseJarvisTokenBridgeCancelRequestV1({ schemaVersion: "1.0", requestId, requestHash: "0".repeat(64) }).requestHash).toBe("0".repeat(64));
    expect(parseJarvisTokenBridgeCancelResponseV1({ schemaVersion: "1.0", requestId, status: "model_cancel_unknown" }).status).toBe("model_cancel_unknown");
    expect(parseJarvisTokenBridgeReadinessV1({
      releaseCommit: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5",
      configurationHash: "0".repeat(64),
      brainSchemaMajor: 1,
      runsEventContractHash: "1".repeat(64),
      enabledProfileIds: ["jarvis-voice-safe"],
      health: "ready",
    }).health).toBe("ready");
  });

  it("freezes the raw canonical LF SSE frames and length-prefixed event hash chain", async () => {
    const first = { schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: "hello" } as const;
    const terminal = { schemaVersion: "1.0", requestId, eventIndex: 1, type: "completed", outputHash: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9" } as const;
    const firstFrame = encodeJarvisTokenBridgeEventSseFrameV1(first);

    expect(new TextDecoder().decode(firstFrame)).toBe('data: {"eventIndex":0,"requestId":"01k3s6k8000000000000000003","schemaVersion":"1.0","text":"hello","tokenIndex":0,"type":"token"}\n\n');
    expect(parseJarvisTokenBridgeEventSseFrameV1(firstFrame)).toEqual(first);
    expect(() => parseJarvisTokenBridgeEventSseFrameV1(new TextEncoder().encode('data: {"eventIndex":0}\r\n\r\n'))).toThrow();
    await expect(createJarvisTokenBridgeEventChainV1(
      "235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3" as Sha256Hex,
      [firstFrame, encodeJarvisTokenBridgeEventSseFrameV1(terminal)],
    )).resolves.toEqual({
      initialHash: "df718845b3909c8dca4579963529bdd13f09b5a442385bbde0495a93882960d8",
      frameHashes: [
        "70e3fb27873101bb2a8916644c10bebc4c7e6493d8553e203e15e7274c7cbe74",
        "010797d164faea217b6c9318d87d29f78b38c9727ffdf070d1d2c1beceeea28a",
      ],
    });
  });

  it("freezes the complete raw UTF-8/LF SSE golden vector and chain", async () => {
    const events = [
      { schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: "hello" },
      { schemaVersion: "1.0", requestId, eventIndex: 1, type: "token", tokenIndex: 1, text: " world" },
      { schemaVersion: "1.0", requestId, eventIndex: 2, type: "completed", outputHash: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9" },
    ] as const;
    const frames = events.map(encodeJarvisTokenBridgeEventSseFrameV1);
    const sse = new TextEncoder().encode('data: {"eventIndex":0,"requestId":"01k3s6k8000000000000000003","schemaVersion":"1.0","text":"hello","tokenIndex":0,"type":"token"}\n\ndata: {"eventIndex":1,"requestId":"01k3s6k8000000000000000003","schemaVersion":"1.0","text":" world","tokenIndex":1,"type":"token"}\n\ndata: {"eventIndex":2,"outputHash":"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9","requestId":"01k3s6k8000000000000000003","schemaVersion":"1.0","type":"completed"}\n\n');
    const expected = new Uint8Array(frames.reduce<number[]>((bytes, frame) => [...bytes, ...frame], []));

    expect(sse).toEqual(expected);
    expect(sse.slice(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(sse).not.toContain(0x0d);
    expect(events.filter((event) => event.type !== "token")).toHaveLength(1);
    await expect(createJarvisTokenBridgeEventChainV1(
      "235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3" as Sha256Hex,
      frames,
    )).resolves.toEqual({
      initialHash: "df718845b3909c8dca4579963529bdd13f09b5a442385bbde0495a93882960d8",
      frameHashes: [
        "70e3fb27873101bb2a8916644c10bebc4c7e6493d8553e203e15e7274c7cbe74",
        "66d5aad25747040635b5602cae415f2d8a115f0b39163bba3665da3da9a1d7d1",
        "6c1a5f70a948f32c0039d7f0d12b0064d0b046e8bd7189aaaf450bcaaa9e4ddf",
      ],
    });
  });
});

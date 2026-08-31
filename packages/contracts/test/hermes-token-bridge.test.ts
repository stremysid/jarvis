import { describe, expect, it } from "vitest";
import requestFixtureRaw from "../../../tests/fixtures/hermes-h1/token-request-golden-v1.json?raw";
import readinessFixtureRaw from "../../../tests/fixtures/hermes-h1/readiness-golden-v1.json?raw";
import eventsFixtureRaw from "../../../tests/fixtures/hermes-h1/token-events-golden-v1.ndjson?raw";
import sseFixtureRaw from "../../../tests/fixtures/hermes-h1/token-events-golden-v1.sse?raw";
import boundaryFixtureRaw from "../../../tests/fixtures/hermes-h1/token-events-boundary-v1.json?raw";
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
import { canonicalize, sha256Hex } from "../src/canonical-json.js";

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

  it("requires exact plain request records without accessors, non-NFC text, identity mismatches, or invalid channels", async () => {
    const parsed = { ...requestMaterial, requestHash: "235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3" };
    await expect(parseJarvisTokenBridgeRequestV1(parsed)).resolves.toEqual(parsed);
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, extra: true })).rejects.toThrow();
    const missing = { ...parsed } as Record<string, unknown>;
    delete missing.userText;
    await expect(parseJarvisTokenBridgeRequestV1(missing)).rejects.toThrow();
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, correlationId: "01k3s6k8000000000000000004" })).rejects.toThrow();
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, requestId: "invalid" })).rejects.toThrow();
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, userText: "e\u0301" })).rejects.toThrow("NFC");
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, channel: "chat" })).rejects.toThrow();
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, timeoutMs: 0 })).rejects.toThrow();
    const accessor = { ...parsed };
    Object.defineProperty(accessor, "principalId", { enumerable: true, get: () => "principal:sid" });
    await expect(parseJarvisTokenBridgeRequestV1(accessor)).rejects.toThrow("data field");
  });

  it("rejects forged request hashes and every hidden own record or array field", async () => {
    const parsed = { ...requestMaterial, requestHash: "235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3" };
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, userText: "forged" })).rejects.toThrow("requestHash");
    const hiddenRecord = { ...parsed };
    Object.defineProperty(hiddenRecord, "hidden", { value: true });
    await expect(parseJarvisTokenBridgeRequestV1(hiddenRecord)).rejects.toThrow("exactly");
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, [Symbol("hidden")]: true })).rejects.toThrow("symbol");
    const hiddenArray = [...parsed.context];
    Object.defineProperty(hiddenArray, "hidden", { value: true });
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, context: hiddenArray })).rejects.toThrow("extra");
    const uint32NonIndex = [...parsed.context];
    Object.defineProperty(uint32NonIndex, "4294967295", { value: parsed.context[0] });
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, context: uint32NonIndex })).rejects.toThrow("extra");
    const outsideLengthNumeric = [...parsed.context];
    Object.defineProperty(outsideLengthNumeric, "4294967296", { value: parsed.context[0] });
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, context: outsideLengthNumeric })).rejects.toThrow("extra");
    const accessorArray = [...parsed.context];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => parsed.context[0] });
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, context: accessorArray })).rejects.toThrow("accessors");
    await expect(parseJarvisTokenBridgeRequestV1({ ...parsed, context: Object.assign([...parsed.context], { [Symbol("hidden")]: true }) })).rejects.toThrow("plain array");
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

  it("consumes the committed request, native/session, readiness, NDJSON, and raw SSE vectors", async () => {
    const requestFixture = JSON.parse(requestFixtureRaw) as Record<string, string>;
    const readinessFixture = JSON.parse(readinessFixtureRaw);
    const requestBody = JSON.parse(requestFixture.canonicalRequestBody);
    const nativeInput = hexBytes(requestFixture.nativeInputUtf8Hex);
    const sessionMessage = hexBytes(requestFixture.sessionHmacMessageHex);
    const sessionKey = await crypto.subtle.importKey("raw", ownedBuffer(hexBytes(requestFixture.publicProfileKeyHex)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sessionDigest = new Uint8Array(await crypto.subtle.sign("HMAC", sessionKey, ownedBuffer(sessionMessage)));
    const ndjsonLines = eventsFixtureRaw.trimEnd().split("\n");
    const ndjsonEvents = ndjsonLines.map((line) => parseJarvisTokenBridgeEventV1(JSON.parse(line)));
    const rawSse = new TextEncoder().encode(sseFixtureRaw);
    const frames = sseFixtureRaw.split("\n\n").slice(0, -1).map((frame) => new TextEncoder().encode(`${frame}\n\n`));

    expect(new TextDecoder().decode(canonicalize(requestBody))).toBe(requestFixture.canonicalRequestBody);
    expect(readinessFixtureRaw).toBe('{"brainSchemaMajor":1,"configurationHash":"0000000000000000000000000000000000000000000000000000000000000000","enabledProfileIds":["jarvis-voice-safe"],"health":"ready","releaseCommit":"5fc308a70719a83cccdbba4c0e39c23f5a8239d5","runsEventContractHash":"655b3829a8f5cc41c9f128e05a1375fd0cdfbfe03b0bde611732d71e94e3f44b"}\n');
    expect(new TextDecoder().decode(nativeInput)).toBe("JARVIS-H1-INPUT-V1\n5\nhello\n1\npersonal\n10\nremembered\n");
    expect(await sha256Hex(nativeInput)).toBe(requestFixture.nativeInputSha256);
    expect(toHex(sessionDigest)).toBe(requestFixture.sessionHmacSha256);
    expect(`jv1_${toBase64Url(sessionDigest)}`).toBe(requestFixture.sessionId);
    await expect(parseJarvisTokenBridgeRequestV1({ ...requestBody, requestHash: requestFixture.requestHash })).resolves.toMatchObject(requestBody);
    expect(parseJarvisTokenBridgeReadinessV1(readinessFixture)).toEqual(readinessFixture);
    expect(ndjsonEvents.map((event) => new TextDecoder().decode(canonicalize(event)))).toEqual(ndjsonLines);
    expect(ndjsonEvents.map((event) => event.eventIndex)).toEqual([0, 1, 2]);
    expect(ndjsonEvents.filter((event) => event.type !== "token")).toHaveLength(1);
    expect(ndjsonEvents.at(-1)?.type).toBe("completed");
    expect(rawSse.slice(0, 3)).not.toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(rawSse).not.toContain(0x0d);
    expect(sseFixtureRaw.endsWith("\n\n")).toBe(true);
    expect(frames).toEqual(ndjsonEvents.map(encodeJarvisTokenBridgeEventSseFrameV1));
    expect(frames.map(parseJarvisTokenBridgeEventSseFrameV1)).toHaveLength(3);
    await expect(createJarvisTokenBridgeEventChainV1(requestFixture.requestHash as Sha256Hex, frames)).resolves.toEqual((JSON.parse(requestFixtureRaw) as { eventChain: unknown }).eventChain);
  });

  it("enforces independent Unicode-scalar, UTF-8-byte, and escaped-frame boundaries from the committed vector", () => {
    const boundary = JSON.parse(boundaryFixtureRaw) as {
      control: string;
      scalarNearLimit: number;
      scalarOverLimit: number;
      utf8NearLimit: number;
      utf8OverLimit: number;
      escapedNearLimitFrameBytes: number;
    };
    const controlText = boundary.control.repeat(boundary.scalarNearLimit);
    const emojiText = "😀".repeat(boundary.utf8NearLimit);

    expect(encodeJarvisTokenBridgeEventSseFrameV1({ schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: controlText }).byteLength).toBe(boundary.escapedNearLimitFrameBytes);
    expect(() => encodeJarvisTokenBridgeEventSseFrameV1({ schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: boundary.control.repeat(boundary.scalarOverLimit) })).toThrow("output");
    expect(() => encodeJarvisTokenBridgeEventSseFrameV1({ schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: "😀".repeat(boundary.utf8OverLimit) })).toThrow("output");
    expect(encodeJarvisTokenBridgeEventSseFrameV1({ schemaVersion: "1.0", requestId, eventIndex: 0, type: "token", tokenIndex: 0, text: emojiText }).byteLength).toBeGreaterThan(0);
  });
});

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

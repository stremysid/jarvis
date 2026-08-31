import { afterEach, describe, expect, it, vi } from "vitest";
import rawGoldenSse from "../../../../tests/fixtures/hermes-h1/token-events-golden-v1.sse?raw";
import {
  canonicalize,
  createJarvisTokenBridgeRequestV1,
  encodeJarvisTokenBridgeEventSseFrameV1,
  type JarvisTokenBridgeEventV1,
} from "../../../../packages/contracts/src/index.js";
import {
  isModelProviderNotStartedError,
  ModelAdapterError,
  type ModelAdapterStreamInput,
  type ModelToken,
} from "../../src/model/model-adapter.js";
import { HermesTokenAdapter } from "../../src/model/hermes-token-adapter.js";
import { FakeHermesTokenBridge } from "../../src/providers/fake-hermes-token-bridge.js";

const credential = "synthetic-bridge-credential";
const requestId = "01k3s6k8000000000000000003" as ModelAdapterStreamInput["correlationId"];

function input(overrides: Partial<ModelAdapterStreamInput> = {}): ModelAdapterStreamInput {
  return {
    correlationId: requestId,
    principalId: "principal:sid",
    channel: "voice",
    userText: "hello",
    context: [{
      sourceEventId: "01k3s6k8000000000000000004" as ModelAdapterStreamInput["correlationId"],
      text: "remembered",
      sensitivity: "personal",
    }],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 8_000,
    timeoutMs: 30_000,
    contextTokenBudget: 32_000,
    maxOutputCharacters: 65_536,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function adapter(bridge: FakeHermesTokenBridge): HermesTokenAdapter {
  return new HermesTokenAdapter({ clientCredential: credential, fetch: bridge.fetch });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HermesTokenAdapter construction and admission", () => {
  it("accepts the committed Task 1 stream using the existing correlation ID and exact request hash", async () => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body: rawGoldenSse }],
    });

    const tokens = await collect(adapter(bridge).stream(input()));

    expect(tokens).toEqual<ModelToken[]>([
      { index: 0, text: "hello" },
      { index: 1, text: " world" },
    ]);
    expect(tokens.every(Object.isFrozen)).toBe(true);
    expect(bridge.requestLog).toEqual([{
      requestId,
      requestHash: "235efcf5927ba250ad8ea078c9c5ed6e951084f3aec2e7d643e0904021aa5ac3",
      replayed: false,
      outcome: "raw_sse",
    }]);
    expect(bridge.logicalRunCount).toBe(1);
    expect(bridge.logicalStopCount).toBe(0);
  });

  it("rejects an added bridge origin option and never accepts a caller-supplied URL", () => {
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential });

    expect(() => new HermesTokenAdapter({
      clientCredential: credential,
      fetch: bridge.fetch,
      bridgeOrigin: "https://attacker.invalid/",
    } as never)).toThrow(expect.objectContaining({ code: "model_input_invalid" }));
  });

  it("rejects telegram synchronously before hashing or network access", () => {
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential });
    const hermes = adapter(bridge);

    expect(() => hermes.stream(input({ channel: "telegram" })))
      .toThrow(expect.objectContaining({ code: "model_input_invalid" }));
    expect(bridge.requestLog).toHaveLength(0);
  });

  it("admits the maximum canonical request allowed by the shared model seam", async () => {
    const maximalContext = Object.freeze(Array.from({ length: 128 }, () => Object.freeze({
      sourceEventId: "01k3s6k8000000000000000004" as ModelAdapterStreamInput["correlationId"],
      text: "\u0000".repeat(250),
      sensitivity: "restricted" as const,
    })));
    const maximal = input({
      principalId: "\u0000".repeat(256),
      userText: "\u0000".repeat(8_000),
      context: maximalContext,
      reasoningEffort: "high",
      contextTokenBudget: 32_000,
    });
    const contractRequest = await createJarvisTokenBridgeRequestV1({
      schemaVersion: "1.0",
      requestId,
      correlationId: requestId,
      principalId: maximal.principalId,
      channel: "voice",
      userText: maximal.userText,
      context: maximal.context,
      reasoningEffort: maximal.reasoningEffort,
      firstTokenTimeoutMs: maximal.firstTokenTimeoutMs,
      timeoutMs: maximal.timeoutMs,
      contextTokenBudget: maximal.contextTokenBudget,
      maxOutputCharacters: maximal.maxOutputCharacters,
    });
    expect(canonicalize(contractRequest).byteLength).toBe(252_664);
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential, runScripts: [{ kind: "not_started" }] });
    let observed: unknown;

    try { await collect(adapter(bridge).stream(maximal)); }
    catch (error) { observed = error; }

    expect(isModelProviderNotStartedError(observed)).toBe(true);
    expect(bridge.requestLog).toHaveLength(1);
  });

  it.each([
    ["not_started", "model_provider_failure", true],
    ["ledger_capacity_exhausted", "model_provider_failure", false],
    ["admission_unknown", "model_admission_unknown", false],
    ["lost_response", "model_admission_unknown", false],
  ] as const)("maps %s without pre-bound cancellation", async (kind, code, fallbackSafe) => {
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential, runScripts: [{ kind }] });
    let observed: unknown;

    try { await collect(adapter(bridge).stream(input())); }
    catch (error) { observed = error; }

    expect(observed).toBeInstanceOf(ModelAdapterError);
    expect(observed).toMatchObject({ code });
    expect(isModelProviderNotStartedError(observed)).toBe(fallbackSafe);
    expect(bridge.logicalStopCount).toBe(0);
    expect(bridge.cancelLog).toHaveLength(0);
  });

  it.each([
    [400, "request_invalid", "model_protocol_invalid"],
    [409, "request_conflict", "model_admission_unknown"],
    [502, "model_admission_unknown", "model_admission_unknown"],
    [507, "ledger_capacity_exhausted", "model_provider_failure"],
  ] as const)("maps exact %i %s to %s", async (status, admissionCode, expectedCode) => {
    const fetcher = async (): Promise<Response> => new Response(canonicalize({
      code: admissionCode,
      requestId,
      schemaVersion: "1.0",
    }), { status, headers: { "content-type": "application/json" } });
    const hermes = new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher });

    await expect(collect(hermes.stream(input()))).rejects.toMatchObject({ code: expectedCode });
  });

  it("maps opaque 401 to fixed provider failure", async () => {
    const fetcher = async (): Promise<Response> => new Response("provider detail", { status: 401 });
    const hermes = new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher });

    let observed: unknown;
    try { await collect(hermes.stream(input())); }
    catch (error) { observed = error; }

    expect(observed).toMatchObject({ code: "model_provider_failure", message: "model_provider_failure" });
    expect(String(observed)).not.toContain("provider detail");
    expect(isModelProviderNotStartedError(observed)).toBe(false);
  });

  it.each([
    ["whitespace", new TextEncoder().encode(` {"code":"not_started","requestId":"${requestId}","schemaVersion":"1.0"}`)],
    ["duplicate key", new TextEncoder().encode(`{"code":"not_started","code":"not_started","requestId":"${requestId}","schemaVersion":"1.0"}`)],
    ["BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(`{"code":"not_started","requestId":"${requestId}","schemaVersion":"1.0"}`)])],
    ["wrong request ID", canonicalize({ code: "not_started", requestId: "01k3s6k8000000000000000004", schemaVersion: "1.0" })],
  ])("never treats a noncanonical 503 %s body as fallback-safe", async (_name, body) => {
    const fetcher = async (): Promise<Response> => new Response(body, {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    const hermes = new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher });
    let observed: unknown;

    try { await collect(hermes.stream(input())); }
    catch (error) { observed = error; }

    expect(observed).toMatchObject({ code: "model_admission_unknown" });
    expect(isModelProviderNotStartedError(observed)).toBe(false);
  });
});

function rawFrames(events: readonly unknown[]): Uint8Array {
  const parts = events.map((event) => new TextEncoder().encode(`data: ${new TextDecoder().decode(canonicalize(event))}\n\n`));
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function tokenEvent(eventIndex: number, tokenIndex: number, text: string): JarvisTokenBridgeEventV1 {
  return { schemaVersion: "1.0", requestId, eventIndex, type: "token", tokenIndex, text };
}

describe("HermesTokenAdapter strict incremental SSE", () => {
  it("accepts the committed stream across single-byte chunk boundaries", async () => {
    const bytes = new TextEncoder().encode(rawGoldenSse);
    const fetcher = async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    await expect(collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input())))
      .resolves.toEqual([{ index: 0, text: "hello" }, { index: 1, text: " world" }]);
  });

  it("retains an exact-cap delimiter-free frame in bounded segments under bytewise delivery", async () => {
    const frameByteCount = 524_288;
    let produced = 0;
    let cancelCalls = 0;
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced === frameByteCount) {
            controller.close();
            return;
          }
          produced += 1;
          controller.enqueue(Uint8Array.of(0x20));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    await expect(collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input())))
      .rejects.toMatchObject({ code: "model_protocol_invalid" });
    expect(produced).toBe(frameByteCount);
    expect(cancelCalls).toBe(1);
  }, 5_000);

  it("replays a byte-identical persisted prefix and yields only the suffix", async () => {
    const events: readonly JarvisTokenBridgeEventV1[] = [
      tokenEvent(0, 0, "hello"),
      tokenEvent(1, 1, " world"),
      { schemaVersion: "1.0", requestId, eventIndex: 2, type: "completed", outputHash: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9" },
    ];
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "stream", events, disconnectsBeforeReplay: 1, disconnectAfterFrames: 1 }],
    });

    await expect(collect(adapter(bridge).stream(input()))).resolves.toEqual([
      { index: 0, text: "hello" },
      { index: 1, text: " world" },
    ]);
    expect(bridge.logicalRunCount).toBe(1);
    expect(bridge.requestLog).toHaveLength(2);
  });

  it("does not trust a terminal frame until replay reaches clean EOF", async () => {
    const bytes = new TextEncoder().encode(rawGoldenSse);
    let runCalls = 0;
    const fetcher = async (): Promise<Response> => {
      runCalls += 1;
      if (runCalls === 1) {
        let delivered = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!delivered) {
              delivered = true;
              controller.enqueue(bytes);
            } else {
              controller.error(new TypeError("dirty close after terminal"));
            }
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(bytes, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    await expect(collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input())))
      .resolves.toEqual([{ index: 0, text: "hello" }, { index: 1, text: " world" }]);
    expect(runCalls).toBe(2);
  });

  it("cancels when every replay closes transport after the canonical terminal", async () => {
    const bytes = new TextEncoder().encode(rawGoldenSse);
    let runCalls = 0;
    let cancelCalls = 0;
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      runCalls += 1;
      let delivered = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(bytes);
          } else {
            controller.error(new TypeError("dirty close after terminal"));
          }
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    await expect(collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input())))
      .rejects.toMatchObject({ code: "model_provider_failure" });
    expect(runCalls).toBe(3);
    expect(cancelCalls).toBe(1);
  });

  it.each([
    ["empty", new Uint8Array()],
    ["partial", rawFrames([tokenEvent(0, 0, "hello")])],
  ] as const)("does not trust %s clean EOF after a dirty full-terminal attempt", async (_kind, replayBytes) => {
    const terminalBytes = new TextEncoder().encode(rawGoldenSse);
    let runCalls = 0;
    let cancelCalls = 0;
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      runCalls += 1;
      if (runCalls > 1) {
        return new Response(replayBytes, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      let delivered = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(terminalBytes);
          } else {
            controller.error(new TypeError("dirty close after terminal"));
          }
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    await expect(collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input())))
      .rejects.toMatchObject({ code: "model_provider_failure" });
    expect(runCalls).toBe(3);
    expect(cancelCalls).toBe(1);
  });

  it.each([
    ["comment", new TextEncoder().encode(": keepalive\n\n")],
    ["event field", new TextEncoder().encode("event: token\ndata: {}\n\n")],
    ["multiline data", new TextEncoder().encode("data: {}\ndata: {}\n\n")],
    ["BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("data: {}\n\n")])],
    ["invalid UTF-8", new Uint8Array([...new TextEncoder().encode("data: \""), 0xff, ...new TextEncoder().encode("\"\n\n")])],
    ["noncanonical JSON", new TextEncoder().encode(`data: {"schemaVersion":"1.0","requestId":"${requestId}","eventIndex":0,"type":"token","tokenIndex":0,"text":"hello"}\n\n`)],
    ["duplicate field", new TextEncoder().encode(`data: {"eventIndex":0,"eventIndex":0,"requestId":"${requestId}","schemaVersion":"1.0","text":"hello","tokenIndex":0,"type":"token"}\n\n`)],
    ["unknown field", rawFrames([{ ...tokenEvent(0, 0, "hello"), nativeRunId: "forbidden" }])],
    ["frame over cap", new TextEncoder().encode(`data: ${" ".repeat(524_283)}\n\n`)],
    ["wrong request ID", rawFrames([{ ...tokenEvent(0, 0, "hello"), requestId: "01k3s6k8000000000000000004" }])],
    ["event index gap", rawFrames([{ ...tokenEvent(0, 0, "hello"), eventIndex: 1 }])],
    ["token index gap", rawFrames([{ ...tokenEvent(0, 0, "hello"), tokenIndex: 1 }])],
    ["duplicate token index", rawFrames([tokenEvent(0, 0, "hello"), tokenEvent(1, 0, "again")])],
    ["empty token", rawFrames([tokenEvent(0, 0, "")])],
    ["non-NFC token", rawFrames([tokenEvent(0, 0, "e\u0301")])],
    ["proposal event", rawFrames([{ schemaVersion: "1.0", requestId, eventIndex: 0, type: "proposal", proposal: {} }])],
    ["tool event", rawFrames([{ schemaVersion: "1.0", requestId, eventIndex: 0, type: "tool_call", name: "forbidden" }])],
    ["subagent event", rawFrames([{ schemaVersion: "1.0", requestId, eventIndex: 0, type: "subagent", id: "forbidden" }])],
    ["approval event", rawFrames([{ schemaVersion: "1.0", requestId, eventIndex: 0, type: "approval", id: "forbidden" }])],
    ["failed detail", rawFrames([{ schemaVersion: "1.0", requestId, eventIndex: 0, type: "failed", code: "model_provider_failure", detail: "forbidden" }])],
    ["completion before output", rawFrames([
      { schemaVersion: "1.0", requestId, eventIndex: 0, type: "completed", outputHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    ])],
    ["wrong output hash", rawFrames([
      tokenEvent(0, 0, "hello"),
      { schemaVersion: "1.0", requestId, eventIndex: 1, type: "completed", outputHash: "0".repeat(64) },
    ])],
    ["duplicate terminal", rawFrames([
      tokenEvent(0, 0, "hello"),
      { schemaVersion: "1.0", requestId, eventIndex: 1, type: "completed", outputHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
      { schemaVersion: "1.0", requestId, eventIndex: 2, type: "completed", outputHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
    ])],
    ["bytes after terminal EOF", new Uint8Array([
      ...rawFrames([
        tokenEvent(0, 0, "hello"),
        { schemaVersion: "1.0", requestId, eventIndex: 1, type: "completed", outputHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
      ]),
      0x78,
    ])],
    ["missing completion", rawFrames([tokenEvent(0, 0, "hello")])],
  ])("rejects %s and cancels the proven bound run", async (_name, body) => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body }],
      cancelScripts: [{ kind: "status", status: "cancelled" }],
    });

    await expect(collect(adapter(bridge).stream(input()))).rejects.toBeInstanceOf(ModelAdapterError);
    expect(bridge.logicalStopCount).toBe(1);
    expect(bridge.cancelLog).toHaveLength(1);
  });

  it("enforces aggregate Unicode-scalar and UTF-8-byte output limits", async () => {
    const body = rawFrames([tokenEvent(0, 0, "a".repeat(40_000)), tokenEvent(1, 1, "a".repeat(30_000))]);
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body }],
      cancelScripts: [{ kind: "status", status: "cancelled" }],
    });

    await expect(collect(adapter(bridge).stream(input()))).rejects.toMatchObject({ code: "model_output_limit" });
    expect(bridge.logicalStopCount).toBe(1);
  });

  it("enforces the UTF-8 byte ceiling independently of the scalar ceiling", async () => {
    const body = rawFrames([tokenEvent(0, 0, "😀".repeat(10_000)), tokenEvent(1, 1, "😀".repeat(7_000))]);
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body }],
      cancelScripts: [{ kind: "status", status: "cancelled" }],
    });

    await expect(collect(adapter(bridge).stream(input()))).rejects.toMatchObject({ code: "model_output_limit" });
    expect(bridge.logicalStopCount).toBe(1);
  });

  it("enforces the request-specific maximum output scalar count", async () => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body: rawFrames([tokenEvent(0, 0, "hello")]) }],
      cancelScripts: [{ kind: "status", status: "cancelled" }],
    });

    await expect(collect(adapter(bridge).stream(input({ maxOutputCharacters: 4 }))))
      .rejects.toMatchObject({ code: "model_output_limit" });
  });

  it("rejects a changed replay prefix and cancels the original bound run", async () => {
    let runCalls = 0;
    let cancelCalls = 0;
    const first = encodeJarvisTokenBridgeEventSseFrameV1(tokenEvent(0, 0, "hello"));
    const changed = encodeJarvisTokenBridgeEventSseFrameV1(tokenEvent(0, 0, "changed"));
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      runCalls += 1;
      return new Response(runCalls === 1 ? first : changed, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    await expect(collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input())))
      .rejects.toMatchObject({ code: "model_protocol_invalid" });
    expect(runCalls).toBe(2);
    expect(cancelCalls).toBe(1);
  });

  it.each([
    ["failed", { schemaVersion: "1.0", requestId, eventIndex: 0, type: "failed", code: "model_provider_failure" }],
    ["cancelled", { schemaVersion: "1.0", requestId, eventIndex: 0, type: "cancelled" }],
  ])("accepts exact %s only as a terminal and performs no cleanup cancel", async (_name, terminal) => {
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential, runScripts: [{ kind: "raw_sse", body: rawFrames([terminal]) }] });

    await expect(collect(adapter(bridge).stream(input()))).rejects.toMatchObject({ code: "model_provider_failure" });
    expect(bridge.logicalStopCount).toBe(0);
  });
});

function cancelResponse(status: "cancel_requested" | "stop_accepted" | "cancelled" | "completed" | "failed" | "model_cancel_unknown"): Response {
  const pending = status === "cancel_requested" || status === "stop_accepted";
  return new Response(canonicalize({ requestId, schemaVersion: "1.0", status }), {
    status: pending ? 202 : 200,
    headers: { "content-type": "application/json" },
  });
}

function pendingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() { /* Deliberately pending. */ } });
}

describe("HermesTokenAdapter deadlines, abort, and cancellation", () => {
  it("performs no POST when the captured caller signal is aborted before iteration", async () => {
    const controller = new AbortController();
    const bridge = new FakeHermesTokenBridge({ clientCredential: credential });
    const stream = adapter(bridge).stream(input({ signal: controller.signal }));
    controller.abort();

    await expect(collect(stream)).rejects.toMatchObject({ code: "model_aborted" });
    expect(bridge.requestLog).toHaveLength(0);
    expect(bridge.cancelLog).toHaveLength(0);
  });

  it("maps abort after request transmission but before validated headers to admission unknown without cancel", async () => {
    const controller = new AbortController();
    let calls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    };
    const pending = collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input({ signal: controller.signal })));
    await started;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "model_admission_unknown" });
    expect(calls).toBe(1);
  });

  it("does not cancel a 200 response until exact stream content type proves it bound", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return new Response("not an event stream", { status: 200, headers: { "content-type": "text/plain" } });
    };

    await expect(collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input())))
      .rejects.toMatchObject({ code: "model_admission_unknown" });
    expect(calls).toBe(1);
  });

  it("preserves caller abort after bound proof when cancellation settles", async () => {
    const controller = new AbortController();
    let runCalls = 0;
    let cancelCalls = 0;
    let markBoundRequest!: () => void;
    const boundRequest = new Promise<void>((resolve) => { markBoundRequest = resolve; });
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      runCalls += 1;
      markBoundRequest();
      return new Response(pendingStream(), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const pending = collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher }).stream(input({ signal: controller.signal })));
    await boundRequest;
    await Promise.resolve();

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "model_aborted" });
    expect(runCalls).toBe(1);
    expect(cancelCalls).toBe(1);
  });

  it("starts one cancellation immediately when caller aborts while suspended at a yielded token", async () => {
    const controller = new AbortController();
    let cancelCalls = 0;
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      return new Response(rawGoldenSse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const iterator = new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher })
      .stream(input({ signal: controller.signal }))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { text: "hello" } });

    controller.abort();
    await Promise.resolve();
    const callsBeforeResume = cancelCalls;
    await iterator.return?.();

    expect(callsBeforeResume).toBe(1);
    expect(cancelCalls).toBe(1);
  });

  it("anchors cancellation expiry to a total timeout while suspended at a yielded token", async () => {
    vi.useFakeTimers();
    let cancelCalls = 0;
    let allowTerminal = false;
    const fetcher = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!new URL(String(url)).pathname.endsWith("/cancel")) {
        return new Response(rawGoldenSse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      cancelCalls += 1;
      if (allowTerminal) return cancelResponse("cancelled");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { reject(new DOMException("cancel deadline", "AbortError")); }, { once: true });
      });
    };
    const iterator = new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher })
      .stream(input({ firstTokenTimeoutMs: 20, timeoutMs: 30 }))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { text: "hello" } });

    await vi.advanceTimersByTimeAsync(30);
    expect(cancelCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    allowTerminal = true;

    await expect(iterator.return?.()).rejects.toMatchObject({ code: "model_cancel_unknown" });
    expect(cancelCalls).toBe(1);
  });

  it("enforces the original first-token deadline across a reconnect and cancels once", async () => {
    vi.useFakeTimers();
    let runCalls = 0;
    let cancelCalls = 0;
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      runCalls += 1;
      if (runCalls === 1) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 6); });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new TypeError("disconnect")); },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(pendingStream(), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const pending = collect(new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher })
      .stream(input({ firstTokenTimeoutMs: 10, timeoutMs: 50 })));
    const rejection = expect(pending).rejects.toMatchObject({ code: "model_first_token_timeout" });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(6);
    await vi.advanceTimersByTimeAsync(4);

    await rejection;
    expect(runCalls).toBe(2);
    expect(cancelCalls).toBe(1);
  });

  it("keeps the original total deadline after a replayed prefix", async () => {
    vi.useFakeTimers();
    const firstFrame = encodeJarvisTokenBridgeEventSseFrameV1(tokenEvent(0, 0, "hello"));
    let runCalls = 0;
    let cancelCalls = 0;
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) {
        cancelCalls += 1;
        return cancelResponse("cancelled");
      }
      runCalls += 1;
      if (runCalls === 1) {
        let delivered = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!delivered) {
              delivered = true;
              controller.enqueue(firstFrame);
            } else {
              controller.error(new TypeError("disconnect"));
            }
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(pendingStream(), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const iterator = new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher })
      .stream(input({ firstTokenTimeoutMs: 20, timeoutMs: 30 }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { text: "hello" } });
    expect(vi.getTimerCount()).toBe(1);
    const pending = iterator.next();
    const rejection = expect(pending).rejects.toMatchObject({ code: "model_total_timeout" });
    await vi.advanceTimersByTimeAsync(0);
    expect(runCalls).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(cancelCalls).toBe(1);

    await rejection;
    expect(runCalls).toBe(2);
    expect(cancelCalls).toBe(1);
  });

  it("consumer return waits through pending cancellation to a trusted terminal", async () => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body: rawGoldenSse }],
      cancelScripts: [
        { kind: "status", status: "cancel_requested" },
        { kind: "status", status: "completed" },
      ],
    });
    const iterator = adapter(bridge).stream(input())[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { text: "hello" } });

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    expect(bridge.logicalStopCount).toBe(1);
    expect(bridge.cancelLog).toHaveLength(2);
  });

  it("an ambiguous cancel response overrides consumer return with model_cancel_unknown", async () => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body: rawGoldenSse }],
      cancelScripts: [{ kind: "lost_response" }],
    });
    const iterator = adapter(bridge).stream(input())[Symbol.asyncIterator]();
    await iterator.next();

    await expect(iterator.return?.()).rejects.toMatchObject({ code: "model_cancel_unknown" });
    expect(bridge.logicalStopCount).toBe(1);
  });

  it("maps an explicit terminal model_cancel_unknown status to the same fixed error", async () => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body: rawGoldenSse }],
      cancelScripts: [{ kind: "status", status: "model_cancel_unknown" }],
    });
    const iterator = adapter(bridge).stream(input())[Symbol.asyncIterator]();
    await iterator.next();

    await expect(iterator.return?.()).rejects.toMatchObject({ code: "model_cancel_unknown" });
  });

  it.each([
    ["whitespace", new TextEncoder().encode(` {"requestId":"${requestId}","schemaVersion":"1.0","status":"cancelled"}`)],
    ["duplicate", new TextEncoder().encode(`{"requestId":"${requestId}","schemaVersion":"1.0","status":"cancelled","status":"cancelled"}`)],
    ["BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(`{"requestId":"${requestId}","schemaVersion":"1.0","status":"cancelled"}`)])],
    ["wrong ID", canonicalize({ requestId: "01k3s6k8000000000000000004", schemaVersion: "1.0", status: "cancelled" })],
  ])("rejects a noncanonical terminal cancel %s response", async (_name, body) => {
    const bridge = new FakeHermesTokenBridge({
      clientCredential: credential,
      runScripts: [{ kind: "raw_sse", body: rawGoldenSse }],
      cancelScripts: [{ kind: "raw_response", status: 200, contentType: "application/json", body }],
    });
    const iterator = adapter(bridge).stream(input())[Symbol.asyncIterator]();
    await iterator.next();

    await expect(iterator.return?.()).rejects.toMatchObject({ code: "model_cancel_unknown" });
  });

  it("stops token delivery immediately after abort even if the source later produces data", async () => {
    const controller = new AbortController();
    const firstFrame = encodeJarvisTokenBridgeEventSseFrameV1(tokenEvent(0, 0, "hello"));
    const lateFrame = encodeJarvisTokenBridgeEventSseFrameV1(tokenEvent(1, 1, " late"));
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetcher = async (url: RequestInfo | URL): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/cancel")) return cancelResponse("failed");
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          source = streamController;
          streamController.enqueue(firstFrame);
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const iterator = new HermesTokenAdapter({ clientCredential: credential, fetch: fetcher })
      .stream(input({ signal: controller.signal }))[Symbol.asyncIterator]();
    const delivered: ModelToken[] = [];
    const first = await iterator.next();
    if (!first.done) delivered.push(first.value);
    const pending = iterator.next();

    controller.abort();
    source?.enqueue(lateFrame);

    await expect(pending).rejects.toMatchObject({ code: "model_aborted" });
    expect(delivered).toEqual([{ index: 0, text: "hello" }]);
  });
});

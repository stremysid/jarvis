import {
  canonicalize,
  encodeJarvisTokenBridgeEventSseFrameV1,
  parseJarvisTokenBridgeCancelRequestV1,
  parseJarvisTokenBridgeRequestV1,
  type JarvisTokenBridgeCancelResponseV1,
  type JarvisTokenBridgeEventV1,
  type JarvisTokenBridgeRequestV1,
} from "../../../../packages/contracts/src/index.js";
import { HERMES_TOKEN_BRIDGE_REQUEST_LIMITS } from "../model/hermes-token-bridge-limits.js";

const BRIDGE_ORIGIN = "http://127.0.0.1:8790/";
const REQUEST_PATH = "/v1/token-runs";
const CANCEL_PATH = /^\/v1\/token-runs\/([0-7][0-9a-hjkmnp-tv-z]{25})\/cancel$/u;

export type FakeHermesTokenBridgeRunScript =
  | {
    readonly kind: "stream";
    readonly events: readonly JarvisTokenBridgeEventV1[];
    readonly delayMs?: number;
    readonly disconnectsBeforeReplay?: number;
    readonly disconnectAfterFrames?: number;
  }
  | { readonly kind: "raw_sse"; readonly body: Uint8Array | string; readonly delayMs?: number }
  | { readonly kind: "not_started"; readonly delayMs?: number }
  | { readonly kind: "ledger_capacity_exhausted"; readonly delayMs?: number }
  | { readonly kind: "admission_unknown"; readonly delayMs?: number }
  | { readonly kind: "lost_response"; readonly delayMs?: number };

export type FakeHermesTokenBridgeCancelScript =
  | { readonly kind: "status"; readonly status: JarvisTokenBridgeCancelResponseV1["status"]; readonly delayMs?: number }
  | { readonly kind: "raw_response"; readonly status: number; readonly contentType: string; readonly body: Uint8Array | string; readonly delayMs?: number }
  | { readonly kind: "lost_response"; readonly delayMs?: number };

export interface FakeHermesTokenBridgeOptions {
  readonly clientCredential: string;
  readonly runScripts?: readonly FakeHermesTokenBridgeRunScript[];
  readonly cancelScripts?: readonly FakeHermesTokenBridgeCancelScript[];
}

export interface FakeHermesTokenBridgeRequestLogEntry {
  readonly requestId: string;
  readonly requestHash: string;
  readonly replayed: boolean;
  readonly outcome: FakeHermesTokenBridgeRunScript["kind"] | "request_conflict";
}

export interface FakeHermesTokenBridgeCancelLogEntry {
  readonly requestId: string;
  readonly requestHash: string;
  readonly outcome: FakeHermesTokenBridgeCancelScript["kind"];
}

export interface FakeHermesTokenBridgeLedgerEntry {
  readonly requestId: string;
  readonly requestHash: string;
  readonly bound: boolean;
  readonly outcome: FakeHermesTokenBridgeRunScript["kind"];
}

interface StoredRun {
  readonly request: Readonly<JarvisTokenBridgeRequestV1>;
  readonly requestBytes: Uint8Array;
  readonly script: FakeHermesTokenBridgeRunScript;
  readonly responseBytes: Uint8Array | null;
  readonly bound: boolean;
  deliveryCount: number;
  stopCounted: boolean;
}

function exactOptions(value: unknown): FakeHermesTokenBridgeOptions {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("fake_hermes_token_bridge_options_invalid");
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(["clientCredential", "runScripts", "cancelScripts"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("fake_hermes_token_bridge_options_invalid");
  }
  const credential = Object.getOwnPropertyDescriptor(value, "clientCredential");
  const runs = Object.getOwnPropertyDescriptor(value, "runScripts");
  const cancels = Object.getOwnPropertyDescriptor(value, "cancelScripts");
  if (credential === undefined || !("value" in credential) || typeof credential.value !== "string" || credential.value.length === 0
    || runs !== undefined && !("value" in runs) || cancels !== undefined && !("value" in cancels)) {
    throw new TypeError("fake_hermes_token_bridge_options_invalid");
  }
  const runScripts: unknown = runs === undefined ? [] : runs.value;
  const cancelScripts: unknown = cancels === undefined ? [] : cancels.value;
  if (!Array.isArray(runScripts) || !Array.isArray(cancelScripts)) {
    throw new TypeError("fake_hermes_token_bridge_options_invalid");
  }
  return { clientCredential: credential.value, runScripts, cancelScripts };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > HERMES_TOKEN_BRIDGE_REQUEST_LIMITS.maximumCanonicalBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(result.value.slice());
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return concatBytes(parts);
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(canonicalize(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function opaque(status: number): Response {
  return new Response(null, { status });
}

async function delay(ms: number | undefined, signal: AbortSignal): Promise<void> {
  if (ms === undefined || ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(new DOMException("synthetic abort", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function bodyBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
}

/** Strict deterministic in-process fake for the private H1 token bridge. */
export class FakeHermesTokenBridge {
  private readonly credential: string;
  private readonly pendingRunScripts: FakeHermesTokenBridgeRunScript[];
  private readonly pendingCancelScripts: FakeHermesTokenBridgeCancelScript[];
  private readonly storedRuns = new Map<string, StoredRun>();
  private readonly requestEntries: FakeHermesTokenBridgeRequestLogEntry[] = [];
  private readonly cancelEntries: FakeHermesTokenBridgeCancelLogEntry[] = [];
  private runCount = 0;
  private stopCount = 0;

  constructor(optionsValue: FakeHermesTokenBridgeOptions) {
    const options = exactOptions(optionsValue);
    this.credential = options.clientCredential;
    this.pendingRunScripts = [...(options.runScripts ?? [])];
    this.pendingCancelScripts = [...(options.cancelScripts ?? [])];
  }

  get logicalRunCount(): number { return this.runCount; }
  get logicalStopCount(): number { return this.stopCount; }

  get requestLog(): readonly Readonly<FakeHermesTokenBridgeRequestLogEntry>[] {
    return Object.freeze(this.requestEntries.map((entry) => Object.freeze({ ...entry })));
  }

  get cancelLog(): readonly Readonly<FakeHermesTokenBridgeCancelLogEntry>[] {
    return Object.freeze(this.cancelEntries.map((entry) => Object.freeze({ ...entry })));
  }

  get ledger(): Readonly<Record<string, Readonly<FakeHermesTokenBridgeLedgerEntry>>> {
    const snapshot: Record<string, Readonly<FakeHermesTokenBridgeLedgerEntry>> = Object.create(null);
    for (const [requestId, stored] of this.storedRuns) {
      snapshot[requestId] = Object.freeze({
        requestId,
        requestHash: stored.request.requestHash,
        bound: stored.bound,
        outcome: stored.script.kind,
      });
    }
    return Object.freeze(snapshot);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== new URL(BRIDGE_ORIGIN).origin || url.search !== "" || url.hash !== "") return opaque(404);
    if (request.method !== "POST" || request.redirect !== "manual") return opaque(405);
    if (request.headers.get("authorization") !== `Bearer ${this.credential}`) return opaque(401);
    if (request.headers.get("content-type") !== "application/json") return opaque(400);
    if (url.pathname === REQUEST_PATH) return this.handleRun(request);
    const cancelMatch = CANCEL_PATH.exec(url.pathname);
    if (cancelMatch !== null) return this.handleCancel(request, cancelMatch[1]);
    return opaque(404);
  };

  private async handleRun(request: Request): Promise<Response> {
    const bytes = await readBoundedBody(request);
    if (bytes === null) return opaque(400);
    let parsed: Readonly<JarvisTokenBridgeRequestV1>;
    try {
      parsed = await parseJarvisTokenBridgeRequestV1(decodeJson(bytes));
    } catch {
      return opaque(400);
    }
    if (!equalBytes(bytes, canonicalize(parsed))) return opaque(400);

    const existing = this.storedRuns.get(parsed.requestId);
    if (existing !== undefined) {
      if (!equalBytes(existing.requestBytes, bytes)) {
        this.requestEntries.push(Object.freeze({ requestId: parsed.requestId, requestHash: parsed.requestHash, replayed: true, outcome: "request_conflict" }));
        return jsonResponse({ code: "request_conflict", requestId: parsed.requestId, schemaVersion: "1.0" }, 409);
      }
      this.requestEntries.push(Object.freeze({ requestId: parsed.requestId, requestHash: parsed.requestHash, replayed: true, outcome: existing.script.kind }));
      return this.runResponse(existing, request.signal);
    }

    const script = this.pendingRunScripts.shift() ?? { kind: "not_started" };
    if (script.kind === "ledger_capacity_exhausted") {
      this.requestEntries.push(Object.freeze({ requestId: parsed.requestId, requestHash: parsed.requestHash, replayed: false, outcome: script.kind }));
      await delay(script.delayMs, request.signal);
      return jsonResponse({ code: "ledger_capacity_exhausted", requestId: parsed.requestId, schemaVersion: "1.0" }, 507);
    }
    const responseBytes = script.kind === "stream"
      ? concatBytes(script.events.map(encodeJarvisTokenBridgeEventSseFrameV1))
      : script.kind === "raw_sse" ? bodyBytes(script.body) : null;
    const bound = script.kind === "stream" || script.kind === "raw_sse";
    const stored: StoredRun = {
      request: parsed,
      requestBytes: bytes.slice(),
      script,
      responseBytes,
      bound,
      deliveryCount: 0,
      stopCounted: false,
    };
    this.storedRuns.set(parsed.requestId, stored);
    if (bound || script.kind === "admission_unknown" || script.kind === "lost_response") this.runCount += 1;
    this.requestEntries.push(Object.freeze({ requestId: parsed.requestId, requestHash: parsed.requestHash, replayed: false, outcome: script.kind }));
    return this.runResponse(stored, request.signal);
  }

  private async runResponse(stored: StoredRun, signal: AbortSignal): Promise<Response> {
    await delay(stored.script.delayMs, signal);
    if (stored.script.kind === "not_started") {
      return jsonResponse({ code: "not_started", requestId: stored.request.requestId, schemaVersion: "1.0" }, 503);
    }
    if (stored.script.kind === "admission_unknown") {
      return jsonResponse({ code: "model_admission_unknown", requestId: stored.request.requestId, schemaVersion: "1.0" }, 502);
    }
    if (stored.script.kind === "lost_response") throw new TypeError("synthetic response loss");
    if (stored.responseBytes === null) throw new TypeError("synthetic fake state invalid");
    stored.deliveryCount += 1;
    if (stored.script.kind === "stream"
      && stored.deliveryCount <= (stored.script.disconnectsBeforeReplay ?? 0)) {
      const frameCount = stored.script.disconnectAfterFrames ?? 0;
      const prefix = concatBytes(stored.script.events.slice(0, frameCount).map(encodeJarvisTokenBridgeEventSseFrameV1));
      let delivered = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered && prefix.byteLength > 0) {
            delivered = true;
            controller.enqueue(prefix);
          } else {
            controller.error(new TypeError("synthetic stream disconnect"));
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(stored.responseBytes.slice(), { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  private async handleCancel(request: Request, pathRequestId: string): Promise<Response> {
    const bytes = await readBoundedBody(request);
    if (bytes === null) return opaque(400);
    let parsed;
    try {
      parsed = parseJarvisTokenBridgeCancelRequestV1(decodeJson(bytes));
    } catch {
      return opaque(400);
    }
    if (!equalBytes(bytes, canonicalize(parsed)) || parsed.requestId !== pathRequestId) return opaque(400);
    const stored = this.storedRuns.get(parsed.requestId);
    if (stored === undefined || !stored.bound) return opaque(404);
    if (stored.request.requestHash !== parsed.requestHash) return opaque(409);
    if (!stored.stopCounted) {
      stored.stopCounted = true;
      this.stopCount += 1;
    }
    const script = this.pendingCancelScripts.shift() ?? { kind: "status", status: "cancelled" };
    this.cancelEntries.push(Object.freeze({ requestId: parsed.requestId, requestHash: parsed.requestHash, outcome: script.kind }));
    await delay(script.delayMs, request.signal);
    if (script.kind === "lost_response") throw new TypeError("synthetic cancel response loss");
    if (script.kind === "raw_response") {
      return new Response(bodyBytes(script.body), { status: script.status, headers: { "content-type": script.contentType } });
    }
    const response = { requestId: parsed.requestId, schemaVersion: "1.0", status: script.status };
    const pending = script.status === "cancel_requested" || script.status === "stop_accepted";
    return jsonResponse(response, pending ? 202 : 200);
  }
}

import { canonicalize, sha256Hex } from "./canonical-json.js";
import type { Sha256Hex, Ulid } from "./ids.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_OUTPUT = 65_536;
const MAX_SSE_FRAME_BYTES = 524_288;
const REQUEST_KEYS = ["schemaVersion", "requestId", "correlationId", "principalId", "channel", "userText", "context", "reasoningEffort", "firstTokenTimeoutMs", "timeoutMs", "contextTokenBudget", "maxOutputCharacters"] as const;

export interface JarvisTokenBridgeRequestHashMaterialV1 {
  readonly schemaVersion: "1.0";
  readonly requestId: Ulid;
  readonly correlationId: Ulid;
  readonly principalId: string;
  readonly channel: "voice";
  readonly userText: string;
  readonly context: readonly {
    readonly sourceEventId: Ulid;
    readonly text: string;
    readonly sensitivity: "personal" | "restricted";
  }[];
  readonly reasoningEffort: "none" | "low" | "high" | "max";
  readonly firstTokenTimeoutMs: number;
  readonly timeoutMs: number;
  readonly contextTokenBudget: number;
  readonly maxOutputCharacters: number;
}

export interface JarvisTokenBridgeRequestV1 extends JarvisTokenBridgeRequestHashMaterialV1 {
  readonly requestHash: Sha256Hex;
}

export type JarvisTokenBridgeEventV1 = {
  readonly schemaVersion: "1.0";
  readonly requestId: Ulid;
  readonly eventIndex: number;
} & (
  | { readonly type: "token"; readonly tokenIndex: number; readonly text: string }
  | { readonly type: "completed"; readonly outputHash: Sha256Hex }
  | { readonly type: "failed"; readonly code: "model_provider_failure" | "model_protocol_invalid" }
  | { readonly type: "cancelled" }
);

export type JarvisTokenBridgeAdmissionFailureV1 = {
  readonly schemaVersion: "1.0";
  readonly requestId: Ulid;
} & (
  | { readonly code: "not_started" }
  | { readonly code: "ledger_capacity_exhausted" }
  | { readonly code: "model_admission_unknown" }
  | { readonly code: "request_conflict" }
  | { readonly code: "request_invalid" }
);

export interface JarvisTokenBridgeCancelRequestV1 {
  readonly schemaVersion: "1.0";
  readonly requestId: Ulid;
  readonly requestHash: Sha256Hex;
}

export interface JarvisTokenBridgeCancelResponseV1 {
  readonly schemaVersion: "1.0";
  readonly requestId: Ulid;
  readonly status: "cancel_requested" | "stop_accepted" | "cancelled" | "completed" | "failed" | "model_cancel_unknown";
}

export interface JarvisTokenBridgeReadinessV1 {
  readonly releaseCommit: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5";
  readonly configurationHash: Sha256Hex;
  readonly brainSchemaMajor: 1;
  readonly runsEventContractHash: Sha256Hex;
  readonly enabledProfileIds: readonly ["jarvis-voice-safe"];
  readonly health: "ready" | "not_ready";
}

export interface JarvisTokenBridgeEventChainV1 {
  readonly initialHash: Sha256Hex;
  readonly frameHashes: readonly Sha256Hex[];
}

type PlainRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new TypeError(`invalid H1 token bridge contract: ${message}`);
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): PlainRecord {
  if (value === null || typeof value !== "object") fail("must be a plain record");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("must be a plain record");
  if (Object.getOwnPropertySymbols(value).length !== 0) fail("must not contain symbol fields");

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.getOwnPropertyNames(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpected.length || actualKeys.some((key, index) => key !== sortedExpected[index])) {
    fail("must contain exactly the required fields");
  }
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(`${key} must be an enumerable data field`);
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, descriptors[key].value]));
}

function dataField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") fail("must be a plain record");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) fail("must be a plain record");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(`${key} must be an enumerable data field`);
  return descriptor.value;
}

function exactArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(`${label} must not be sparse or contain accessors`);
  }
  if (Object.getOwnPropertyNames(value).some((key) => key !== "length" && (!Number.isSafeInteger(Number(key)) || Number(key) < 0 || Number(key) >= value.length || String(Number(key)) !== key))) {
    fail(`${label} must not contain extra fields`);
  }
  return Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value);
}

function requireNfcString(value: unknown, label: string, { nonEmpty = false } = {}): string {
  if (typeof value !== "string" || !value.isWellFormed() || value !== value.normalize("NFC")) fail(`${label} must be well-formed NFC text`);
  if (nonEmpty && value.length === 0) fail(`${label} must not be empty`);
  return value;
}

function requireUlid(value: unknown, label: string): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) fail(`${label} must be a lowercase ULID`);
  return value as Ulid;
}

function requireSha256(value: unknown, label: string): Sha256Hex {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) fail(`${label} must be a lowercase SHA-256 hex digest`);
  return value as Sha256Hex;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is out of bounds`);
  return value;
}

function requireOutputText(value: unknown): string {
  const text = requireNfcString(value, "token text");
  let scalars = 0;
  let utf8Bytes = 0;
  for (const scalar of text) {
    scalars += 1;
    const codePoint = scalar.codePointAt(0) as number;
    utf8Bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (scalars > MAX_OUTPUT || utf8Bytes > MAX_OUTPUT) fail("output exceeds Unicode-scalar or UTF-8-byte bounds");
  }
  return text;
}

function freeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
  }
  return Object.freeze(value);
}

function parseContext(value: unknown): readonly JarvisTokenBridgeRequestHashMaterialV1["context"][number][] {
  const context = exactArray(value, "context");
  return freeze(context.map((item) => {
    const record = exactRecord(item, ["sourceEventId", "text", "sensitivity"]);
    if (record.sensitivity !== "personal" && record.sensitivity !== "restricted") fail("context sensitivity is unsupported");
    return freeze({
      sourceEventId: requireUlid(record.sourceEventId, "context sourceEventId"),
      text: requireNfcString(record.text, "context text"),
      sensitivity: record.sensitivity,
    });
  }));
}

function parseRequestMaterial(value: unknown): Readonly<JarvisTokenBridgeRequestHashMaterialV1> {
  const record = exactRecord(value, REQUEST_KEYS);
  if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
  if (record.channel !== "voice") fail("channel must be voice");
  if (record.reasoningEffort !== "none" && record.reasoningEffort !== "low" && record.reasoningEffort !== "high" && record.reasoningEffort !== "max") fail("reasoningEffort is unsupported");

  const requestId = requireUlid(record.requestId, "requestId");
  const correlationId = requireUlid(record.correlationId, "correlationId");
  if (requestId !== correlationId) fail("requestId and correlationId must be identical");
  const firstTokenTimeoutMs = requireInteger(record.firstTokenTimeoutMs, "firstTokenTimeoutMs", 1);
  const timeoutMs = requireInteger(record.timeoutMs, "timeoutMs", firstTokenTimeoutMs);

  return freeze({
    schemaVersion: "1.0",
    requestId,
    correlationId,
    principalId: requireNfcString(record.principalId, "principalId", { nonEmpty: true }),
    channel: "voice",
    userText: requireNfcString(record.userText, "userText"),
    context: parseContext(record.context),
    reasoningEffort: record.reasoningEffort,
    firstTokenTimeoutMs,
    timeoutMs,
    contextTokenBudget: requireInteger(record.contextTokenBudget, "contextTokenBudget", 0),
    maxOutputCharacters: requireInteger(record.maxOutputCharacters, "maxOutputCharacters", 0, MAX_OUTPUT),
  });
}

export async function createJarvisTokenBridgeRequestV1(
  input: Readonly<JarvisTokenBridgeRequestHashMaterialV1>,
): Promise<Readonly<JarvisTokenBridgeRequestV1>> {
  const request = parseRequestMaterial(input);
  const requestHash = await sha256Hex(canonicalize(request));
  return freeze({ ...request, requestHash }) as Readonly<JarvisTokenBridgeRequestV1>;
}

export async function parseJarvisTokenBridgeRequestV1(value: unknown): Promise<Readonly<JarvisTokenBridgeRequestV1>> {
  const record = exactRecord(value, [...REQUEST_KEYS, "requestHash"]);
  const request = parseRequestMaterial(Object.fromEntries(REQUEST_KEYS.map((key) => [key, record[key]])));
  const requestHash = requireSha256(record.requestHash, "requestHash");
  const computedHash = await sha256Hex(canonicalize(request));
  if (!constantTimeEqual(requestHash, computedHash)) fail("requestHash does not match request material");
  return freeze({ ...request, requestHash }) as Readonly<JarvisTokenBridgeRequestV1>;
}

export function parseJarvisTokenBridgeEventV1(value: unknown): Readonly<JarvisTokenBridgeEventV1> {
  const type = dataField(value, "type");
  if (type === "token") {
    const record = exactRecord(value, ["schemaVersion", "requestId", "eventIndex", "type", "tokenIndex", "text"]);
    if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
    return freeze({ schemaVersion: "1.0" as const, requestId: requireUlid(record.requestId, "requestId"), eventIndex: requireInteger(record.eventIndex, "eventIndex", 0), type: "token" as const, tokenIndex: requireInteger(record.tokenIndex, "tokenIndex", 0), text: requireOutputText(record.text) });
  }
  if (type === "completed") {
    const record = exactRecord(value, ["schemaVersion", "requestId", "eventIndex", "type", "outputHash"]);
    if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
    return freeze({ schemaVersion: "1.0" as const, requestId: requireUlid(record.requestId, "requestId"), eventIndex: requireInteger(record.eventIndex, "eventIndex", 0), type: "completed" as const, outputHash: requireSha256(record.outputHash, "outputHash") });
  }
  if (type === "failed") {
    const record = exactRecord(value, ["schemaVersion", "requestId", "eventIndex", "type", "code"]);
    if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
    if (record.code !== "model_provider_failure" && record.code !== "model_protocol_invalid") fail("failure code is unsupported");
    return freeze({ schemaVersion: "1.0" as const, requestId: requireUlid(record.requestId, "requestId"), eventIndex: requireInteger(record.eventIndex, "eventIndex", 0), type: "failed" as const, code: record.code });
  }
  if (type === "cancelled") {
    const record = exactRecord(value, ["schemaVersion", "requestId", "eventIndex", "type"]);
    if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
    return freeze({ schemaVersion: "1.0" as const, requestId: requireUlid(record.requestId, "requestId"), eventIndex: requireInteger(record.eventIndex, "eventIndex", 0), type: "cancelled" as const });
  }
  fail("event type is unsupported");
}

export function encodeJarvisTokenBridgeEventSseFrameV1(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`data: ${new TextDecoder().decode(canonicalize(parseJarvisTokenBridgeEventV1(value)))}\n\n`);
  if (bytes.byteLength > MAX_SSE_FRAME_BYTES) fail("SSE frame is too large");
  return bytes;
}

export function parseJarvisTokenBridgeEventSseFrameV1(value: unknown): Readonly<JarvisTokenBridgeEventV1> {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_SSE_FRAME_BYTES) fail("SSE frame must be a bounded Uint8Array");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value);
  } catch {
    fail("SSE frame must be valid UTF-8");
  }
  if (!text.startsWith("data: ") || !text.endsWith("\n\n") || text.includes("\r") || text.slice(6, -2).includes("\n")) fail("SSE frame must be one LF-delimited data line");
  let event: unknown;
  try {
    event = JSON.parse(text.slice(6, -2));
  } catch {
    fail("SSE data must be JSON");
  }
  const parsed = parseJarvisTokenBridgeEventV1(event);
  const canonical = encodeJarvisTokenBridgeEventSseFrameV1(parsed);
  if (canonical.byteLength !== value.byteLength || canonical.some((byte, index) => byte !== value[index])) fail("SSE frame is not canonical");
  return parsed;
}

export async function createJarvisTokenBridgeEventChainV1(
  requestHash: Sha256Hex,
  frames: readonly Uint8Array[],
): Promise<Readonly<JarvisTokenBridgeEventChainV1>> {
  const validatedRequestHash = requireSha256(requestHash, "requestHash");
  let previous = await sha256Hex(new Uint8Array([
    ...new TextEncoder().encode("JARVIS-H1-EVENT-CHAIN-V1\0"),
    ...hexBytes(validatedRequestHash),
  ]));
  const initialHash = previous;
  const frameHashes: Sha256Hex[] = [];
  for (const frame of frames) {
    parseJarvisTokenBridgeEventSseFrameV1(frame);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(frame.byteLength), false);
    previous = await sha256Hex(new Uint8Array([...hexBytes(previous), ...length, ...frame]));
    frameHashes.push(previous);
  }
  return freeze({ initialHash, frameHashes });
}

export function parseJarvisTokenBridgeAdmissionFailureV1(value: unknown): Readonly<JarvisTokenBridgeAdmissionFailureV1> {
  const record = exactRecord(value, ["schemaVersion", "requestId", "code"]);
  if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
  if (record.code !== "not_started" && record.code !== "ledger_capacity_exhausted" && record.code !== "model_admission_unknown" && record.code !== "request_conflict" && record.code !== "request_invalid") fail("admission failure code is unsupported");
  return freeze({ schemaVersion: "1.0", requestId: requireUlid(record.requestId, "requestId"), code: record.code });
}

export function parseJarvisTokenBridgeCancelRequestV1(value: unknown): Readonly<JarvisTokenBridgeCancelRequestV1> {
  const record = exactRecord(value, ["schemaVersion", "requestId", "requestHash"]);
  if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
  return freeze({ schemaVersion: "1.0", requestId: requireUlid(record.requestId, "requestId"), requestHash: requireSha256(record.requestHash, "requestHash") });
}

export function parseJarvisTokenBridgeCancelResponseV1(value: unknown): Readonly<JarvisTokenBridgeCancelResponseV1> {
  const record = exactRecord(value, ["schemaVersion", "requestId", "status"]);
  if (record.schemaVersion !== "1.0") fail("schemaVersion is unsupported");
  if (record.status !== "cancel_requested" && record.status !== "stop_accepted" && record.status !== "cancelled" && record.status !== "completed" && record.status !== "failed" && record.status !== "model_cancel_unknown") fail("cancellation status is unsupported");
  return freeze({ schemaVersion: "1.0", requestId: requireUlid(record.requestId, "requestId"), status: record.status });
}

export function parseJarvisTokenBridgeReadinessV1(value: unknown): Readonly<JarvisTokenBridgeReadinessV1> {
  const record = exactRecord(value, ["releaseCommit", "configurationHash", "brainSchemaMajor", "runsEventContractHash", "enabledProfileIds", "health"]);
  if (record.releaseCommit !== "5fc308a70719a83cccdbba4c0e39c23f5a8239d5" || record.brainSchemaMajor !== 1) fail("readiness version is unsupported");
  const profiles = exactArray(record.enabledProfileIds, "enabledProfileIds");
  if (profiles.length !== 1 || profiles[0] !== "jarvis-voice-safe") fail("enabledProfileIds is unsupported");
  if (record.health !== "ready" && record.health !== "not_ready") fail("health is unsupported");
  return freeze({
    releaseCommit: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5",
    configurationHash: requireSha256(record.configurationHash, "configurationHash"),
    brainSchemaMajor: 1,
    runsEventContractHash: requireSha256(record.runsEventContractHash, "runsEventContractHash"),
    enabledProfileIds: freeze(["jarvis-voice-safe"] as ["jarvis-voice-safe"]),
    health: record.health,
  });
}

function hexBytes(value: Sha256Hex): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

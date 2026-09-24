import { canonicalize, sha256Hex, type JsonValue, type Sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";

export type CanonicalBodyValidator<T> = (value: unknown) => T;

export interface VerifiedDeviceRequest<T = JsonValue> {
  readonly deviceId: string;
  readonly principalId: string;
  readonly audience: string;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly bodyHash: Sha256Hex;
  readonly keyId: string;
  readonly keyFingerprint: Sha256Hex;
  readonly keyGeneration: number;
  readonly body: Readonly<T>;
}

interface CurrentDeviceKey {
  device_id: string;
  principal_id: string;
  key_id: string;
  public_key_base64: string;
  key_fingerprint: Sha256Hex;
  key_generation: number;
}

const REQUEST_FIELDS = ["schemaVersion", "deviceId", "principalId", "audience", "issuedAt", "nonce", "bodyHash", "signatureBase64"] as const;
const REQUEST_FIELD_SET = new Set<string>(REQUEST_FIELDS);
const SHA256 = /^[a-f0-9]{64}$/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE_WINDOW_MS = 300_000;
const MAXIMUM_SIGNED_BODY_BYTES = 65_536;
const MAXIMUM_SIGNED_BODY_DEPTH = 32;
const MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS = 4_096;
const encoder = new TextEncoder();
const verifiedRequests = new WeakSet<object>();

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function isSafeAtom(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC")
    && !value.includes("\n") && !value.includes("\r") && encoder.encode(value).byteLength <= maximumBytes;
}

function parseTimestamp(value: unknown): Date | null {
  if (!isSafeAtom(value, 32) || !UTC_MILLISECONDS.test(value)) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value ? parsed : null;
}

export function decodeCanonicalBase64(value: unknown, byteLength: number, error = "base64_invalid"): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TypeError(error);
  try {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== byteLength || btoa(String.fromCharCode(...decoded)) !== value) throw new TypeError(error);
    return decoded;
  } catch { throw new TypeError(error); }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCanonicalBase64Url(value: unknown, byteLength: number, error = "base64url_invalid"): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(error);
  try {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const decoded = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== byteLength || encodeBase64Url(decoded) !== value) throw new TypeError(error);
    return decoded;
  } catch { throw new TypeError(error); }
}

function strictJsonCopy(value: unknown, path = "body"): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("signed_body_invalid");
    return value;
  }
  if (typeof value === "string") {
    if (!value.isWellFormed() || value !== value.normalize("NFC")) throw new TypeError("signed_body_invalid");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("signed_body_invalid");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) throw new TypeError("signed_body_invalid");
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("signed_body_invalid");
      result.push(strictJsonCopy(descriptor.value, `${path}[${index}]`));
    }
    return result;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("signed_body_invalid");
  const result: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !key.isWellFormed() || key !== key.normalize("NFC")) throw new TypeError("signed_body_invalid");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("signed_body_invalid");
    Object.defineProperty(result, key, { value: strictJsonCopy(descriptor.value, `${path}.${key}`), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

type SignedBodyFrame =
  | { readonly kind: "value"; readonly value: unknown; readonly parentDepth: number }
  | { readonly kind: "leave"; readonly value: object };

/** Bounds all work performed by the recursive JSON copy and canonicalizer. */
function assertBoundedSignedBody(root: unknown): void {
  let canonicalBytes = 0;
  let structureItems = 0;
  const activeContainers = new WeakSet<object>();
  const frames: SignedBodyFrame[] = [{ kind: "value", value: root, parentDepth: 0 }];

  const addCanonicalBytes = (count: number): void => {
    canonicalBytes += count;
    if (canonicalBytes > MAXIMUM_SIGNED_BODY_BYTES) throw new TypeError("signed_body_invalid");
  };
  const addCanonicalString = (value: string): void => {
    if (value.length > MAXIMUM_SIGNED_BODY_BYTES || !value.isWellFormed() || value !== value.normalize("NFC")) {
      throw new TypeError("signed_body_invalid");
    }
    addCanonicalBytes(2);
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit === 0x08 || codeUnit === 0x09
        || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
        addCanonicalBytes(2);
      } else if (codeUnit <= 0x1f) {
        addCanonicalBytes(6);
      } else if (codeUnit <= 0x7f) {
        addCanonicalBytes(1);
      } else if (codeUnit <= 0x7ff) {
        addCanonicalBytes(2);
      } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        addCanonicalBytes(4);
        index += 1;
      } else {
        addCanonicalBytes(3);
      }
    }
  };

  while (frames.length > 0) {
    const frame = frames.pop() as SignedBodyFrame;
    if (frame.kind === "leave") {
      activeContainers.delete(frame.value);
      continue;
    }

    structureItems += 1;
    if (structureItems > MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS) throw new TypeError("signed_body_invalid");
    const value = frame.value;
    if (value === null) {
      addCanonicalBytes(4);
      continue;
    }
    if (typeof value === "boolean") {
      addCanonicalBytes(value ? 4 : 5);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("signed_body_invalid");
      addCanonicalBytes(JSON.stringify(value).length);
      continue;
    }
    if (typeof value === "string") {
      addCanonicalString(value);
      continue;
    }
    if (typeof value !== "object") throw new TypeError("signed_body_invalid");

    const containerDepth = frame.parentDepth + 1;
    if (containerDepth > MAXIMUM_SIGNED_BODY_DEPTH || activeContainers.has(value)) throw new TypeError("signed_body_invalid");
    activeContainers.add(value);

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || structureItems + value.length > MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS) {
        throw new TypeError("signed_body_invalid");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) throw new TypeError("signed_body_invalid");
      addCanonicalBytes(2 + Math.max(0, value.length - 1));
      const children: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("signed_body_invalid");
        children.push(descriptor.value);
      }
      frames.push({ kind: "leave", value });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        frames.push({ kind: "value", value: children[index], parentDepth: containerDepth });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("signed_body_invalid");
    const keys = Reflect.ownKeys(value);
    if (structureItems + keys.length * 2 > MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS) throw new TypeError("signed_body_invalid");
    structureItems += keys.length;
    addCanonicalBytes(2 + Math.max(0, keys.length - 1));
    const children: unknown[] = [];
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("signed_body_invalid");
      addCanonicalString(key);
      addCanonicalBytes(1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("signed_body_invalid");
      children.push(descriptor.value);
    }
    frames.push({ kind: "leave", value });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      frames.push({ kind: "value", value: children[index], parentDepth: containerDepth });
    }
  }
}

function boundedStrictJsonCopy(value: unknown): JsonValue {
  assertBoundedSignedBody(value);
  return strictJsonCopy(value);
}

export function decodeCanonicalRawBody(rawBody: Uint8Array): JsonValue {
  if (!(rawBody instanceof Uint8Array)) throw new TypeError("signed_body_invalid");
  if (rawBody.byteLength > MAXIMUM_SIGNED_BODY_BYTES) throw new TypeError("signed_body_invalid");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody); }
  catch { throw new TypeError("signed_body_invalid"); }
  if (text.startsWith("\uFEFF")) throw new TypeError("signed_body_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("signed_body_invalid"); }
  const copied = boundedStrictJsonCopy(parsed);
  if (!byteEqual(canonicalize(copied), rawBody)) throw new TypeError("signed_body_noncanonical");
  return copied;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateRequest(value: unknown): SignedRequestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("signed_request_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== REQUEST_FIELDS.length || keys.some((key) => typeof key !== "string" || !REQUEST_FIELD_SET.has(key))) throw new TypeError("signed_request_invalid");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of REQUEST_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("signed_request_invalid");
    result[field] = descriptor.value;
  }
  if (result.schemaVersion !== "1.0" || !isSafeAtom(result.deviceId, 256) || !isSafeAtom(result.principalId, 256) || !isSafeAtom(result.audience, 128)) throw new TypeError("signed_request_invalid");
  if (parseTimestamp(result.issuedAt) === null || typeof result.bodyHash !== "string" || !SHA256.test(result.bodyHash)) throw new TypeError("signed_request_invalid");
  decodeCanonicalBase64Url(result.nonce, 32, "signed_request_invalid");
  decodeCanonicalBase64(result.signatureBase64, 64, "signature_invalid");
  return result as unknown as SignedRequestV1;
}

export function signatureText(request: SignedRequestV1, method: "GET" | "POST", path: string): Uint8Array {
  return encoder.encode([method, path, request.deviceId, request.principalId, request.audience, request.issuedAt, request.nonce, request.bodyHash].join("\n"));
}

export function isVerifiedDeviceRequest(value: unknown): value is VerifiedDeviceRequest {
  return value !== null && typeof value === "object" && verifiedRequests.has(value);
}

/** Verifies a canonical device request and atomically consumes its exact-key-bound nonce. */
export class DeviceRequestVerifier {
  constructor(private readonly deps: {
    database: D1Database;
    audience: string;
    beforeNonceInsert?: () => void | Promise<void>;
  }) {
    if (!isSafeAtom(deps.audience, 128)) throw new TypeError("audience_invalid");
  }

  async verify<T>(
    rawRequest: SignedRequestV1,
    method: "GET" | "POST",
    path: string,
    suppliedBody: unknown,
    rawBody: Uint8Array,
    now: Date,
    validateBody: CanonicalBodyValidator<T>,
  ): Promise<VerifiedDeviceRequest<T>> {
    if ((method !== "GET" && method !== "POST") || !isSafeAtom(path, 512) || !path.startsWith("/")) throw new TypeError("signed_request_target_invalid");
    if (!(now instanceof Date) || Number.isNaN(now.valueOf()) || now.toISOString() !== new Date(now.valueOf()).toISOString()) throw new TypeError("verification_time_invalid");
    const request = validateRequest(rawRequest);
    if (request.audience !== this.deps.audience) throw new Error("audience_mismatch");

    if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > MAXIMUM_SIGNED_BODY_BYTES) {
      throw new TypeError("signed_body_invalid");
    }
    const computedBodyHash = await sha256Hex(rawBody);
    const issuedAt = parseTimestamp(request.issuedAt);
    if (issuedAt === null || Math.abs(now.valueOf() - issuedAt.valueOf()) >= NONCE_WINDOW_MS) throw new Error("signed_request_expired");
    const signature = decodeCanonicalBase64(request.signatureBase64, 64, "signature_invalid");
    const current = await this.readCurrentKey(request.deviceId, request.principalId);
    if (current === null) throw new Error("device_not_active");
    const publicKeyBytes = decodeCanonicalBase64(current.public_key_base64, 32, "device_key_invalid");
    if (await sha256Hex(publicKeyBytes) !== current.key_fingerprint) throw new Error("device_key_invalid");
    let publicKey: CryptoKey;
    try { publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]); }
    catch { throw new Error("device_key_invalid"); }
    const signedBytes = signatureText(request, method, path);
    if (!await crypto.subtle.verify("Ed25519", publicKey, signature, signedBytes)) throw new Error("signature_invalid");
    if (request.bodyHash !== computedBodyHash) throw new Error("body_hash_mismatch");

    // Endpoint validation can walk and canonicalize the entire request. Run it
    // only after the device has proved possession of its enrolled key.
    const authoritative = decodeCanonicalRawBody(rawBody);
    const supplied = boundedStrictJsonCopy(suppliedBody);
    const validatedAuthoritative = validateBody(authoritative);
    validateBody(supplied);
    if (!byteEqual(canonicalize(supplied), rawBody)) throw new Error("signed_body_mismatch");

    await this.deps.beforeNonceInsert?.();
    const nonceHash = await sha256Hex(decodeCanonicalBase64Url(request.nonce, 32, "signed_request_invalid"));
    const requestHash = await sha256Hex(signedBytes);
    const expiresAt = new Date(now.valueOf() + NONCE_WINDOW_MS).toISOString();
    const nonceId = crypto.randomUUID();
    try {
      const inserted = await this.deps.database.prepare(
        `INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at)
         SELECT ?, d.device_id, d.principal_id, d.key_id, d.key_fingerprint, d.key_generation, ?, ?, ?, ?, ?
         FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
         WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ? AND d.key_fingerprint = ? AND d.key_generation = ?
           AND d.public_key_base64 = ? AND d.status = 'active' AND p.status = 'active'
         RETURNING nonce_id`,
      ).bind(
        nonceId, nonceHash, requestHash, expiresAt, now.toISOString(), now.toISOString(),
        current.device_id, current.principal_id, current.key_id, current.key_fingerprint, current.key_generation, current.public_key_base64,
      ).first<{ nonce_id: string }>();
      if (inserted?.nonce_id !== nonceId) {
        if (await this.nonceExists(request.deviceId, nonceHash)) throw new Error("replayed_nonce");
        throw new Error("device_key_changed");
      }
    } catch (error) {
      if (error instanceof Error && (error.message.includes("replayed_nonce") || error.message.includes("device_key_changed"))) throw error;
      if (await this.nonceExists(request.deviceId, nonceHash)) throw new Error("replayed_nonce");
      throw error;
    }

    const body = deepFreeze(strictJsonCopy(validatedAuthoritative) as unknown as T);
    const proof = deepFreeze({
      deviceId: current.device_id, principalId: current.principal_id, audience: request.audience, issuedAt: request.issuedAt,
      nonce: request.nonce, bodyHash: request.bodyHash, keyId: current.key_id, keyFingerprint: current.key_fingerprint,
      keyGeneration: current.key_generation, body,
    }) as VerifiedDeviceRequest<T>;
    verifiedRequests.add(proof);
    return proof;
  }

  private readCurrentKey(deviceId: string, principalId: string): Promise<CurrentDeviceKey | null> {
    return this.deps.database.prepare(
      `SELECT d.device_id, d.principal_id, d.key_id, d.public_key_base64, d.key_fingerprint, d.key_generation
       FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
       WHERE d.device_id = ? AND d.principal_id = ? AND d.status = 'active' AND p.status = 'active'`,
    ).bind(deviceId, principalId).first<CurrentDeviceKey>();
  }

  async nonceExists(deviceId: string, nonceHash: string): Promise<boolean> {
    const row = await this.deps.database.prepare("SELECT 1 AS present FROM request_nonces WHERE device_id = ? AND nonce_hash = ?")
      .bind(deviceId, nonceHash).first<{ present: number }>();
    return row?.present === 1;
  }
}

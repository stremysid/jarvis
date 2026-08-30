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

function decodeCanonicalRawBody(rawBody: Uint8Array): JsonValue {
  if (!(rawBody instanceof Uint8Array)) throw new TypeError("signed_body_invalid");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody); }
  catch { throw new TypeError("signed_body_invalid"); }
  if (text.startsWith("\uFEFF")) throw new TypeError("signed_body_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("signed_body_invalid"); }
  const copied = strictJsonCopy(parsed);
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

function validateRequest(value: unknown): SignedRequestV1 {
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

function signatureText(request: SignedRequestV1, method: "GET" | "POST", path: string): Uint8Array {
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

    const authoritative = decodeCanonicalRawBody(rawBody);
    const supplied = strictJsonCopy(suppliedBody);
    const validatedAuthoritative = validateBody(authoritative);
    validateBody(supplied);
    if (!byteEqual(canonicalize(supplied), rawBody)) throw new Error("signed_body_mismatch");
    const computedBodyHash = await sha256Hex(rawBody);
    if (request.bodyHash !== computedBodyHash) throw new Error("body_hash_mismatch");

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

    await this.deps.beforeNonceInsert?.();
    const nonceHash = await sha256Hex(decodeCanonicalBase64Url(request.nonce, 32, "signed_request_invalid"));
    const requestHash = await sha256Hex(signedBytes);
    const expiresAt = new Date(now.valueOf() + NONCE_WINDOW_MS).toISOString();
    try {
      const inserted = await this.deps.database.prepare(
        `INSERT INTO request_nonces (nonce_id, device_id, principal_id, key_id, key_fingerprint, key_generation, nonce_hash, request_hash, expires_at, consumed_at, created_at)
         SELECT ?, d.device_id, d.principal_id, d.key_id, d.key_fingerprint, d.key_generation, ?, ?, ?, ?, ?
         FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
         WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ? AND d.key_fingerprint = ? AND d.key_generation = ?
           AND d.public_key_base64 = ? AND d.status = 'active' AND p.status = 'active'`,
      ).bind(
        crypto.randomUUID(), nonceHash, requestHash, expiresAt, now.toISOString(), now.toISOString(),
        current.device_id, current.principal_id, current.key_id, current.key_fingerprint, current.key_generation, current.public_key_base64,
      ).run();
      if (inserted.meta.changes !== 1) {
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

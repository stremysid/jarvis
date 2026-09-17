import { deriveChainedPbkdf2Sha256 } from "./chained-pbkdf2.js";

export interface GuestPinVerifierRecordV2 {
  readonly schemaVersion: "2.0";
  readonly algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256";
  readonly pepperVersion: "v1";
  readonly iterations: 600_000;
  readonly saltBase64: string;
  readonly digestBase64: string;
}

const RECORD_FIELDS = new Set([
  "schemaVersion",
  "algorithm",
  "pepperVersion",
  "iterations",
  "saltBase64",
  "digestBase64",
]);
const GRANT_ID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const HMAC_PREFIX = new TextEncoder().encode("jarvis.guest-pin/v1");
const encoder = new TextEncoder();
const issuedRecords = new WeakSet<object>();

function invalidVerifier(): never {
  throw new TypeError("guest_pin_verifier_invalid");
}

function exactDataRecord(value: unknown): Record<string, unknown> {
  let prototype: object | null;
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  } catch {
    invalidVerifier();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) {
    invalidVerifier();
  }

  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    invalidVerifier();
  }
  if (keys.length !== RECORD_FIELDS.size || keys.some((key) => typeof key !== "string" || !RECORD_FIELDS.has(key))) {
    invalidVerifier();
  }

  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of RECORD_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      invalidVerifier();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidVerifier();
    captured[field] = descriptor.value;
  }
  return captured;
}

function decodeCanonicalBase64(value: unknown, byteLength: number): Uint8Array {
  if (typeof value !== "string" || !BASE64.test(value)) invalidVerifier();
  let decoded: Uint8Array | undefined;
  try {
    decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    let canonical = "";
    for (const byte of decoded) canonical += String.fromCharCode(byte);
    if (decoded.byteLength !== byteLength || btoa(canonical) !== value) invalidVerifier();
    return decoded;
  } catch {
    decoded?.fill(0);
    invalidVerifier();
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function issueRecord(input: Readonly<{ saltBase64: string; digestBase64: string }>): GuestPinVerifierRecordV2 {
  const record: GuestPinVerifierRecordV2 = Object.freeze({
    schemaVersion: "2.0",
    algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
    pepperVersion: "v1",
    iterations: 600_000,
    saltBase64: input.saltBase64,
    digestBase64: input.digestBase64,
  });
  issuedRecords.add(record);
  return record;
}

export function decodeGuestPinVerifierRecord(value: unknown): GuestPinVerifierRecordV2 {
  const captured = exactDataRecord(value);
  if (
    captured.schemaVersion !== "2.0"
    || captured.algorithm !== "hmac-sha256-pepper+pbkdf2-hmac-sha256"
    || captured.pepperVersion !== "v1"
    || captured.iterations !== 600_000
  ) {
    invalidVerifier();
  }

  let salt: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  try {
    salt = decodeCanonicalBase64(captured.saltBase64, 16);
    digest = decodeCanonicalBase64(captured.digestBase64, 32);
    return issueRecord({
      saltBase64: captured.saltBase64 as string,
      digestBase64: captured.digestBase64 as string,
    });
  } finally {
    salt?.fill(0);
    digest?.fill(0);
  }
}

function validPinBytes(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 4) return false;
  let valid = 1;
  for (const byte of value) valid &= Number(byte >= 0x30 && byte <= 0x39);
  return valid === 1;
}

function validGrantId(value: unknown): value is string {
  return typeof value === "string" && GRANT_ID.test(value);
}

function knownGuestPinError(error: unknown): error is TypeError {
  return error instanceof TypeError && /^guest_(?:grant_id|pin|pin_pepper|pin_salt|pin_verifier)_/u.test(error.message);
}

function defaultRandomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export class GuestPinVerifier {
  readonly #hmacKey: Promise<CryptoKey>;
  readonly #randomSalt: () => Uint8Array;

  constructor(pepper: Uint8Array, randomSalt: () => Uint8Array = defaultRandomSalt) {
    if (!(pepper instanceof Uint8Array) || pepper.byteLength !== 32) {
      throw new TypeError("guest_pin_pepper_invalid");
    }
    if (typeof randomSalt !== "function") throw new TypeError("guest_pin_salt_invalid");
    const pepperCopy = pepper.slice();
    this.#hmacKey = crypto.subtle
      .importKey("raw", pepperCopy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .finally(() => pepperCopy.fill(0));
    this.#randomSalt = randomSalt;
  }

  async #deriveHmac(grantId: string, pinDigits: Uint8Array): Promise<Uint8Array> {
    const grantBytes = encoder.encode(grantId);
    const input = new Uint8Array(HMAC_PREFIX.byteLength + 1 + grantBytes.byteLength + 1 + pinDigits.byteLength);
    input.set(HMAC_PREFIX, 0);
    input[HMAC_PREFIX.byteLength] = 0;
    input.set(grantBytes, HMAC_PREFIX.byteLength + 1);
    input[HMAC_PREFIX.byteLength + 1 + grantBytes.byteLength] = 0;
    input.set(pinDigits, input.byteLength - pinDigits.byteLength);
    try {
      return new Uint8Array(await crypto.subtle.sign("HMAC", await this.#hmacKey, input));
    } finally {
      grantBytes.fill(0);
      input.fill(0);
    }
  }

  async #deriveDigest(hmac: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    return deriveChainedPbkdf2Sha256(hmac, salt);
  }

  async create(grantId: string, pinDigits: Uint8Array): Promise<GuestPinVerifierRecordV2> {
    let suppliedSalt: Uint8Array | undefined;
    let salt: Uint8Array | undefined;
    let hmac: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    try {
      if (!validGrantId(grantId)) throw new TypeError("guest_grant_id_invalid");
      if (!validPinBytes(pinDigits)) throw new TypeError("guest_pin_invalid");
      suppliedSalt = this.#randomSalt();
      if (!(suppliedSalt instanceof Uint8Array) || suppliedSalt.byteLength !== 16) {
        throw new TypeError("guest_pin_salt_invalid");
      }
      salt = suppliedSalt.slice();
      hmac = await this.#deriveHmac(grantId, pinDigits);
      digest = await this.#deriveDigest(hmac, salt);
      if (digest.byteLength !== 32) throw new Error("guest_pin_derivation_failed");
      return issueRecord({ saltBase64: encodeBase64(salt), digestBase64: encodeBase64(digest) });
    } catch (error) {
      if (knownGuestPinError(error)) throw error;
      throw new Error("guest_pin_derivation_failed");
    } finally {
      if (pinDigits instanceof Uint8Array) pinDigits.fill(0);
      suppliedSalt?.fill(0);
      salt?.fill(0);
      hmac?.fill(0);
      digest?.fill(0);
    }
  }

  async verify(grantId: string, pinDigits: Uint8Array, record: GuestPinVerifierRecordV2): Promise<boolean> {
    let salt: Uint8Array | undefined;
    let expected: Uint8Array | undefined;
    let hmac: Uint8Array | undefined;
    let derived: Uint8Array | undefined;
    try {
      if (!validGrantId(grantId)) throw new TypeError("guest_grant_id_invalid");
      if (!validPinBytes(pinDigits)) return false;
      if (record === null || typeof record !== "object" || !issuedRecords.has(record) || !Object.isFrozen(record)) {
        invalidVerifier();
      }
      salt = decodeCanonicalBase64(record.saltBase64, 16);
      expected = decodeCanonicalBase64(record.digestBase64, 32);
      hmac = await this.#deriveHmac(grantId, pinDigits);
      derived = await this.#deriveDigest(hmac, salt);
      if (derived.byteLength !== expected.byteLength) return false;
      let difference = 0;
      for (let index = 0; index < expected.byteLength; index += 1) {
        difference |= (derived[index] ?? 0) ^ (expected[index] ?? 0);
      }
      return difference === 0;
    } catch (error) {
      if (knownGuestPinError(error)) throw error;
      throw new Error("guest_pin_verification_failed");
    } finally {
      if (pinDigits instanceof Uint8Array) pinDigits.fill(0);
      salt?.fill(0);
      expected?.fill(0);
      hmac?.fill(0);
      derived?.fill(0);
    }
  }
}

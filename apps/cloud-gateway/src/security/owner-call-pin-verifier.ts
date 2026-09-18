import { deriveChainedPbkdf2Sha256 } from "./chained-pbkdf2.js";

export interface OwnerCallPinVerifierRecordV1 {
  readonly schemaVersion: "1.0";
  readonly algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256";
  readonly domainVersion: "v1";
  readonly pepperVersion: "v1";
  readonly iterations: 600_000;
  readonly verifierVersion: number;
  readonly saltBase64: string;
  readonly digestBase64: string;
}

const RECORD_FIELDS = new Set([
  "schemaVersion", "algorithm", "domainVersion", "pepperVersion",
  "iterations", "verifierVersion", "saltBase64", "digestBase64",
]);
const IDENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const encoder = new TextEncoder();
const HMAC_PREFIX = encoder.encode("jarvis.owner-call-pin/v1");
const issuedRecords = new WeakSet<object>();

function invalidVerifier(): never {
  throw new TypeError("owner_call_pin_verifier_invalid");
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
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of RECORD_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      invalidVerifier();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidVerifier();
    result[field] = descriptor.value;
  }
  return result;
}

function decodeCanonicalBase64(value: unknown, byteLength: number): Uint8Array {
  if (typeof value !== "string" || !BASE64.test(value)) invalidVerifier();
  let decoded: Uint8Array | undefined;
  try {
    decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    let binary = "";
    for (const byte of decoded) binary += String.fromCharCode(byte);
    if (decoded.byteLength !== byteLength || btoa(binary) !== value) invalidVerifier();
    return decoded;
  } catch {
    decoded?.fill(0);
    invalidVerifier();
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function issueRecord(input: Readonly<{
  verifierVersion: number;
  saltBase64: string;
  digestBase64: string;
}>): OwnerCallPinVerifierRecordV1 {
  const record: OwnerCallPinVerifierRecordV1 = Object.freeze({
    schemaVersion: "1.0",
    algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
    domainVersion: "v1",
    pepperVersion: "v1",
    iterations: 600_000,
    verifierVersion: input.verifierVersion,
    saltBase64: input.saltBase64,
    digestBase64: input.digestBase64,
  });
  issuedRecords.add(record);
  return record;
}

function validVerifierVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647;
}

export function decodeOwnerCallPinVerifierRecord(value: unknown): OwnerCallPinVerifierRecordV1 {
  const record = exactDataRecord(value);
  if (record.schemaVersion !== "1.0"
    || record.algorithm !== "hmac-sha256-pepper+pbkdf2-hmac-sha256"
    || record.domainVersion !== "v1"
    || record.pepperVersion !== "v1"
    || record.iterations !== 600_000
    || !validVerifierVersion(record.verifierVersion)) invalidVerifier();
  let salt: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  try {
    salt = decodeCanonicalBase64(record.saltBase64, 16);
    digest = decodeCanonicalBase64(record.digestBase64, 32);
    return issueRecord({
      verifierVersion: record.verifierVersion,
      saltBase64: record.saltBase64 as string,
      digestBase64: record.digestBase64 as string,
    });
  } finally {
    salt?.fill(0);
    digest?.fill(0);
  }
}

function validIdentityId(value: unknown): value is string {
  return typeof value === "string" && IDENTITY_ID.test(value);
}

/**
 * Four ASCII digits, and nothing else. The candidate arrives here already
 * normalised from speech or from the keypad, so a string that is not four
 * digits is not a wrong PIN -- it is not a PIN at all, and the attempt is
 * recorded as unreadable so the re-prompt can say which of the two happened.
 */
export function isOwnerCallPinDigits(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 4) return false;
  let valid = 1;
  for (const byte of value) valid &= Number(byte >= 0x30 && byte <= 0x39);
  return valid === 1;
}

function knownPinError(error: unknown): error is TypeError {
  return error instanceof TypeError && /^owner_call_pin_/u.test(error.message);
}

/**
 * The ASCII form of four digits, which is the shape both `create` and
 * `verify` compare. One encoder rather than two, so a candidate built from a
 * typed string and one built from speech cannot disagree about what a digit
 * looks like.
 */
export function ownerCallPinDigits(value: string): Uint8Array {
  if (typeof value !== "string" || value.length !== 4) throw new TypeError("owner_call_pin_digits_invalid");
  const digits = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) digits[index] = value.charCodeAt(index);
  let valid = true;
  for (const byte of digits) valid = valid && byte >= 0x30 && byte <= 0x39;
  if (!valid) {
    digits.fill(0);
    throw new TypeError("owner_call_pin_digits_invalid");
  }
  return digits;
}

function defaultRandomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function defaultRandomSample(): number {
  return crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
}

/**
 * Four decimal digits from four independent 16-bit draws.
 *
 * The top of the range is rejected rather than folded, because 65,536 does
 * not divide by ten and the folding remainder would make three digits
 * fractionally likelier than the other seven. Six samples in 65,536 are
 * discarded, so the re-draw almost always ends on its first pass, and no
 * caller could ever count the difference -- but a credential whose entropy is
 * already four digits should not also be skewed.
 */
export function generateOwnerCallPin(randomSample: () => number = defaultRandomSample): string {
  if (typeof randomSample !== "function") throw new TypeError("owner_call_pin_generator_invalid");
  let pin = "";
  for (let position = 0; position < 4; position += 1) pin += String(nextDigit(randomSample));
  return pin;
}

function nextDigit(randomSample: () => number): number {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const sample = randomSample();
    if (!Number.isSafeInteger(sample) || sample < 0 || sample > 0xffff) {
      throw new Error("owner_call_pin_generation_failed");
    }
    if (sample < 65_530) return sample % 10;
  }
  throw new Error("owner_call_pin_generation_failed");
}

export class OwnerCallPinVerifier {
  readonly #hmacKey: Promise<CryptoKey>;
  readonly #randomSalt: () => Uint8Array;

  constructor(pepper: Uint8Array, randomSalt: () => Uint8Array = defaultRandomSalt) {
    if (!(pepper instanceof Uint8Array) || pepper.byteLength !== 32) {
      throw new TypeError("owner_call_pin_pepper_invalid");
    }
    if (typeof randomSalt !== "function") throw new TypeError("owner_call_pin_salt_invalid");
    const pepperCopy = pepper.slice();
    this.#hmacKey = crypto.subtle
      .importKey("raw", pepperCopy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .finally(() => pepperCopy.fill(0));
    this.#randomSalt = randomSalt;
  }

  async #deriveHmac(identityId: string, verifierVersion: number, pinDigits: Uint8Array): Promise<Uint8Array> {
    const identity = encoder.encode(identityId);
    const version = encoder.encode(String(verifierVersion));
    const input = new Uint8Array(
      HMAC_PREFIX.byteLength + 1 + identity.byteLength + 1 + version.byteLength + 1 + pinDigits.byteLength,
    );
    let offset = 0;
    input.set(HMAC_PREFIX, offset); offset += HMAC_PREFIX.byteLength + 1;
    input.set(identity, offset); offset += identity.byteLength + 1;
    input.set(version, offset); offset += version.byteLength + 1;
    input.set(pinDigits, offset);
    try {
      return new Uint8Array(await crypto.subtle.sign("HMAC", await this.#hmacKey, input));
    } finally {
      identity.fill(0);
      version.fill(0);
      input.fill(0);
    }
  }

  async #deriveDigest(hmac: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    return deriveChainedPbkdf2Sha256(hmac, salt);
  }

  /** `pinDigits` is zeroised by this call, successful or not. */
  async create(identityId: string, verifierVersion: number, pinDigits: Uint8Array): Promise<OwnerCallPinVerifierRecordV1> {
    let suppliedSalt: Uint8Array | undefined;
    let salt: Uint8Array | undefined;
    let hmac: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    try {
      if (!validIdentityId(identityId)) throw new TypeError("owner_call_pin_identity_invalid");
      if (!validVerifierVersion(verifierVersion)) throw new TypeError("owner_call_pin_version_invalid");
      if (!isOwnerCallPinDigits(pinDigits)) throw new TypeError("owner_call_pin_digits_invalid");
      suppliedSalt = this.#randomSalt();
      if (!(suppliedSalt instanceof Uint8Array) || suppliedSalt.byteLength !== 16) {
        throw new TypeError("owner_call_pin_salt_invalid");
      }
      salt = suppliedSalt.slice();
      hmac = await this.#deriveHmac(identityId, verifierVersion, pinDigits);
      digest = await this.#deriveDigest(hmac, salt);
      if (digest.byteLength !== 32) throw new Error("owner_call_pin_derivation_failed");
      return issueRecord({
        verifierVersion, saltBase64: encodeBase64(salt), digestBase64: encodeBase64(digest),
      });
    } catch (error) {
      if (knownPinError(error)) throw error;
      throw new Error("owner_call_pin_derivation_failed");
    } finally {
      if (pinDigits instanceof Uint8Array) pinDigits.fill(0);
      suppliedSalt?.fill(0);
      salt?.fill(0);
      hmac?.fill(0);
      digest?.fill(0);
    }
  }

  /** `pinDigits` is zeroised by this call, successful or not. */
  async verify(
    identityId: string,
    pinDigits: Uint8Array,
    record: OwnerCallPinVerifierRecordV1,
  ): Promise<boolean> {
    let salt: Uint8Array | undefined;
    let expected: Uint8Array | undefined;
    let hmac: Uint8Array | undefined;
    let derived: Uint8Array | undefined;
    try {
      if (!validIdentityId(identityId)) throw new TypeError("owner_call_pin_identity_invalid");
      if (record === null || typeof record !== "object" || !issuedRecords.has(record) || !Object.isFrozen(record)) {
        invalidVerifier();
      }
      if (!isOwnerCallPinDigits(pinDigits)) return false;
      salt = decodeCanonicalBase64(record.saltBase64, 16);
      expected = decodeCanonicalBase64(record.digestBase64, 32);
      hmac = await this.#deriveHmac(identityId, record.verifierVersion, pinDigits);
      derived = await this.#deriveDigest(hmac, salt);
      if (derived.byteLength !== expected.byteLength) return false;
      let difference = 0;
      for (let index = 0; index < expected.byteLength; index += 1) {
        difference |= (derived[index] ?? 0) ^ (expected[index] ?? 0);
      }
      return difference === 0;
    } catch (error) {
      if (knownPinError(error)) throw error;
      throw new Error("owner_call_pin_verification_failed");
    } finally {
      if (pinDigits instanceof Uint8Array) pinDigits.fill(0);
      salt?.fill(0);
      expected?.fill(0);
      hmac?.fill(0);
      derived?.fill(0);
    }
  }
}

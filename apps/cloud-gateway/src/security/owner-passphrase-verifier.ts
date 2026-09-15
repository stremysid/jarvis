import {
  OWNER_PASSPHRASE_WORD_LIST_VERSION,
  OWNER_PASSPHRASE_WORDS,
} from "./owner-passphrase-word-list.js";

export interface OwnerPassphraseVerifierRecordV1 {
  readonly schemaVersion: "1.0";
  readonly algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256";
  readonly domainVersion: "v1";
  readonly wordListVersion: typeof OWNER_PASSPHRASE_WORD_LIST_VERSION;
  readonly pepperVersion: "v1";
  readonly iterations: 600_000;
  readonly verifierVersion: number;
  readonly saltBase64: string;
  readonly digestBase64: string;
}

const RECORD_FIELDS = new Set([
  "schemaVersion", "algorithm", "domainVersion", "wordListVersion", "pepperVersion",
  "iterations", "verifierVersion", "saltBase64", "digestBase64",
]);
const IDENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const IGNORED_PUNCTUATION = new Set([0x21, 0x22, 0x27, 0x2c, 0x2e, 0x3a, 0x3b, 0x3f]);
const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
const WORDS = new Set(OWNER_PASSPHRASE_WORDS);
const encoder = new TextEncoder();
const HMAC_PREFIX = encoder.encode("jarvis.owner-passphrase/v1");
const issuedRecords = new WeakSet<object>();

function invalidVerifier(): never {
  throw new TypeError("owner_passphrase_verifier_invalid");
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
  pepperVersion: "v1";
  verifierVersion: number;
  saltBase64: string;
  digestBase64: string;
}>): OwnerPassphraseVerifierRecordV1 {
  const record: OwnerPassphraseVerifierRecordV1 = Object.freeze({
    schemaVersion: "1.0",
    algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
    domainVersion: "v1",
    wordListVersion: OWNER_PASSPHRASE_WORD_LIST_VERSION,
    pepperVersion: input.pepperVersion,
    iterations: 600_000,
    verifierVersion: input.verifierVersion,
    saltBase64: input.saltBase64,
    digestBase64: input.digestBase64,
  });
  issuedRecords.add(record);
  return record;
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647;
}

export function decodeOwnerPassphraseVerifierRecord(value: unknown): OwnerPassphraseVerifierRecordV1 {
  const record = exactDataRecord(value);
  if (record.schemaVersion !== "1.0"
    || record.algorithm !== "hmac-sha256-pepper+pbkdf2-hmac-sha256"
    || record.domainVersion !== "v1"
    || record.wordListVersion !== OWNER_PASSPHRASE_WORD_LIST_VERSION
    || record.pepperVersion !== "v1"
    || record.iterations !== 600_000
    || !validVersion(record.verifierVersion)) invalidVerifier();
  let salt: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  try {
    salt = decodeCanonicalBase64(record.saltBase64, 16);
    digest = decodeCanonicalBase64(record.digestBase64, 32);
    return issueRecord({
      pepperVersion: "v1",
      verifierVersion: record.verifierVersion,
      saltBase64: record.saltBase64 as string,
      digestBase64: record.digestBase64 as string,
    });
  } finally {
    salt?.fill(0);
    digest?.fill(0);
  }
}

/**
 * Canonical ASCII v1: fold A-Z, remove . , ! ? ; : and ASCII quotes,
 * collapse ASCII whitespace, and reject every other character or list word.
 */
export function canonicalizeOwnerPassphrase(candidate: unknown): Uint8Array {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 128) {
    throw new TypeError("owner_passphrase_candidate_invalid");
  }
  const output: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < candidate.length; index += 1) {
    let code = candidate.charCodeAt(index);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    if (code >= 0x61 && code <= 0x7a) {
      if (pendingSpace && output.length > 0) output.push(0x20);
      output.push(code);
      pendingSpace = false;
    } else if (ASCII_WHITESPACE.has(code)) {
      pendingSpace = output.length > 0;
    } else if (!IGNORED_PUNCTUATION.has(code)) {
      throw new TypeError("owner_passphrase_candidate_invalid");
    }
  }
  const canonical = new Uint8Array(output);
  output.fill(0);
  const text = new TextDecoder().decode(canonical);
  const words = text.split(" ");
  if (words.length !== 3 || words.some((word) => !WORDS.has(word))) {
    canonical.fill(0);
    throw new TypeError("owner_passphrase_candidate_invalid");
  }
  return canonical;
}

function defaultRandomIndex(): number {
  const sample = crypto.getRandomValues(new Uint16Array(1))[0];
  if (sample === undefined) throw new Error("owner_passphrase_generation_failed");
  // 65,536 is exactly divisible by 2,048, so masking the low 11 bits is unbiased.
  return sample & 0x07ff;
}

export function generateOwnerPassphrase(randomIndex: () => number = defaultRandomIndex): string {
  if (typeof randomIndex !== "function") throw new TypeError("owner_passphrase_generator_invalid");
  const words: string[] = [];
  for (let draw = 0; draw < 3; draw += 1) {
    const index = randomIndex();
    if (!Number.isSafeInteger(index) || index < 0 || index >= OWNER_PASSPHRASE_WORDS.length) {
      throw new Error("owner_passphrase_generation_failed");
    }
    const word = OWNER_PASSPHRASE_WORDS[index];
    if (word === undefined) throw new Error("owner_passphrase_generation_failed");
    words.push(word);
  }
  return words.join(" ");
}

function defaultRandomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function validIdentityId(value: unknown): value is string {
  return typeof value === "string" && IDENTITY_ID.test(value);
}

export class OwnerPassphraseVerifier {
  readonly #hmacKey: Promise<CryptoKey>;
  readonly #randomSalt: () => Uint8Array;

  constructor(pepper: Uint8Array, pepperVersion: string, randomSalt: () => Uint8Array = defaultRandomSalt) {
    if (!(pepper instanceof Uint8Array) || pepper.byteLength !== 32 || pepperVersion !== "v1") {
      throw new TypeError("owner_passphrase_pepper_invalid");
    }
    if (typeof randomSalt !== "function") throw new TypeError("owner_passphrase_salt_invalid");
    const copy = pepper.slice();
    this.#hmacKey = crypto.subtle.importKey(
      "raw", copy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    ).finally(() => copy.fill(0));
    this.#randomSalt = randomSalt;
  }

  async #hmac(identityId: string, verifierVersion: number, canonical: Uint8Array): Promise<Uint8Array> {
    const identity = encoder.encode(identityId);
    const version = encoder.encode(String(verifierVersion));
    const input = new Uint8Array(
      HMAC_PREFIX.byteLength + 1 + identity.byteLength + 1 + version.byteLength + 1 + canonical.byteLength,
    );
    let offset = 0;
    input.set(HMAC_PREFIX, offset); offset += HMAC_PREFIX.byteLength + 1;
    input.set(identity, offset); offset += identity.byteLength + 1;
    input.set(version, offset); offset += version.byteLength + 1;
    input.set(canonical, offset);
    try {
      return new Uint8Array(await crypto.subtle.sign("HMAC", await this.#hmacKey, input));
    } finally {
      identity.fill(0);
      version.fill(0);
      input.fill(0);
    }
  }

  async #digest(hmac: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("raw", hmac, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000,
    }, key, 256));
  }

  async create(identityId: string, verifierVersion: number, candidate: string): Promise<OwnerPassphraseVerifierRecordV1> {
    let suppliedSalt: Uint8Array | undefined;
    let salt: Uint8Array | undefined;
    let canonical: Uint8Array | undefined;
    let hmac: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    try {
      if (!validIdentityId(identityId) || !validVersion(verifierVersion)) {
        throw new TypeError("owner_passphrase_binding_invalid");
      }
      canonical = canonicalizeOwnerPassphrase(candidate);
      suppliedSalt = this.#randomSalt();
      if (!(suppliedSalt instanceof Uint8Array) || suppliedSalt.byteLength !== 16) {
        throw new TypeError("owner_passphrase_salt_invalid");
      }
      salt = suppliedSalt.slice();
      hmac = await this.#hmac(identityId, verifierVersion, canonical);
      digest = await this.#digest(hmac, salt);
      if (digest.byteLength !== 32) throw new Error("owner_passphrase_derivation_failed");
      return issueRecord({
        pepperVersion: "v1", verifierVersion,
        saltBase64: encodeBase64(salt), digestBase64: encodeBase64(digest),
      });
    } catch (error) {
      if (error instanceof TypeError && /^owner_passphrase_(?:binding|candidate|salt)_invalid$/u.test(error.message)) {
        throw error;
      }
      throw new Error("owner_passphrase_derivation_failed");
    } finally {
      suppliedSalt?.fill(0);
      salt?.fill(0);
      canonical?.fill(0);
      hmac?.fill(0);
      digest?.fill(0);
    }
  }

  async verify(
    identityId: string,
    candidate: string,
    record: OwnerPassphraseVerifierRecordV1,
  ): Promise<boolean> {
    let salt: Uint8Array | undefined;
    let expected: Uint8Array | undefined;
    let canonical: Uint8Array | undefined;
    let hmac: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    try {
      if (!validIdentityId(identityId)) throw new TypeError("owner_passphrase_binding_invalid");
      if (record === null || typeof record !== "object" || !issuedRecords.has(record) || !Object.isFrozen(record)) {
        invalidVerifier();
      }
      try {
        canonical = canonicalizeOwnerPassphrase(candidate);
      } catch (error) {
        if (error instanceof TypeError && error.message === "owner_passphrase_candidate_invalid") return false;
        throw error;
      }
      salt = decodeCanonicalBase64(record.saltBase64, 16);
      expected = decodeCanonicalBase64(record.digestBase64, 32);
      hmac = await this.#hmac(identityId, record.verifierVersion, canonical);
      digest = await this.#digest(hmac, salt);
      let difference = digest.byteLength ^ expected.byteLength;
      for (let index = 0; index < expected.byteLength; index += 1) {
        difference |= (digest[index] ?? 0) ^ (expected[index] ?? 0);
      }
      return difference === 0;
    } catch (error) {
      if (error instanceof TypeError && /^owner_passphrase_(?:binding|verifier)_invalid$/u.test(error.message)) throw error;
      throw new Error("owner_passphrase_verification_failed");
    } finally {
      salt?.fill(0);
      expected?.fill(0);
      canonical?.fill(0);
      hmac?.fill(0);
      digest?.fill(0);
    }
  }
}

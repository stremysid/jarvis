export interface PinVerifierRecordV1 {
  readonly schemaVersion: "1.0";
  readonly algorithm: "pbkdf2-hmac-sha256";
  readonly iterations: number;
  readonly saltBase64: string;
  readonly digestBase64: string;
}

interface PinDerivationInput {
  readonly pinBytes: Uint8Array;
  readonly salt: Uint8Array;
  readonly iterations: number;
}

interface PinVerifierMaterial {
  readonly salt: Uint8Array;
  readonly digest: Uint8Array;
  readonly iterations: number;
}

const RECORD_FIELDS = new Set(["schemaVersion", "algorithm", "iterations", "saltBase64", "digestBase64"]);
const PIN = /^[0-9]{8}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const issuedRecords = new WeakMap<object, PinVerifierMaterial>();
const encoder = new TextEncoder();

function invalidVerifier(): never {
  throw new TypeError("pin_verifier_invalid");
}

function exactDataRecord(value: unknown): Record<string, unknown> {
  let prototype: object | null;
  try { prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null; }
  catch { invalidVerifier(); }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || prototype !== Object.prototype
  ) {
    invalidVerifier();
  }
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch { invalidVerifier(); }
  if (
    keys.length !== RECORD_FIELDS.size
    || keys.some((key) => typeof key !== "string" || !RECORD_FIELDS.has(key))
  ) {
    invalidVerifier();
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of RECORD_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { invalidVerifier(); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidVerifier();
    captured[field] = descriptor.value;
  }
  return captured;
}

function canonicalBase64(value: unknown, expectedBytes: number): { readonly text: string; readonly bytes: Uint8Array } {
  if (typeof value !== "string" || !BASE64.test(value)) invalidVerifier();
  try {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    let binary = "";
    for (const byte of decoded) binary += String.fromCharCode(byte);
    if (decoded.byteLength !== expectedBytes || btoa(binary) !== value) invalidVerifier();
    return Object.freeze({ text: value, bytes: decoded });
  } catch {
    invalidVerifier();
  }
}

/** Decodes the one deployed PIN-verifier schema into a frozen module-issued record. */
export function decodePinVerifierRecord(raw: unknown): PinVerifierRecordV1 {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw) as unknown; }
    catch { invalidVerifier(); }
  }
  const captured = exactDataRecord(parsed);
  if (
    captured.schemaVersion !== "1.0"
    || captured.algorithm !== "pbkdf2-hmac-sha256"
    || !Number.isSafeInteger(captured.iterations)
    || (captured.iterations as number) < 600_000
    || (captured.iterations as number) > 2_000_000
  ) {
    invalidVerifier();
  }
  const salt = canonicalBase64(captured.saltBase64, 16);
  const digest = canonicalBase64(captured.digestBase64, 32);
  const record: PinVerifierRecordV1 = Object.freeze({
    schemaVersion: "1.0",
    algorithm: "pbkdf2-hmac-sha256",
    iterations: captured.iterations as number,
    saltBase64: salt.text,
    digestBase64: digest.text,
  });
  issuedRecords.set(record, Object.freeze({
    salt: salt.bytes.slice(),
    digest: digest.bytes.slice(),
    iterations: record.iterations,
  }));
  return record;
}

async function defaultDerive(input: PinDerivationInput): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", input.pinBytes, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: input.salt,
    iterations: input.iterations,
  }, key, 256));
}

/** Performs PBKDF2 verification without returning or retaining candidate digits. */
export async function verifyPin(
  pinDigits: unknown,
  record: PinVerifierRecordV1,
): Promise<boolean> {
  const material = record !== null && typeof record === "object" ? issuedRecords.get(record) : undefined;
  if (material === undefined || !Object.isFrozen(record)) invalidVerifier();
  const iterations = material.iterations;
  const salt = material.salt.slice();
  const expected = material.digest.slice();
  if (typeof pinDigits !== "string" || !PIN.test(pinDigits)) return false;
  const pinBytes = encoder.encode(pinDigits);
  let derived: Uint8Array;
  try {
    derived = await defaultDerive(Object.freeze({ pinBytes, salt, iterations }));
  } catch {
    pinBytes.fill(0);
    salt.fill(0);
    expected.fill(0);
    throw new Error("pin_verification_failed");
  }
  if (!(derived instanceof Uint8Array) || derived.byteLength !== expected.byteLength) {
    pinBytes.fill(0);
    salt.fill(0);
    expected.fill(0);
    if (derived instanceof Uint8Array) derived.fill(0);
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= (derived[index] ?? 0) ^ (expected[index] ?? 0);
  }
  pinBytes.fill(0);
  salt.fill(0);
  expected.fill(0);
  derived.fill(0);
  return difference === 0;
}

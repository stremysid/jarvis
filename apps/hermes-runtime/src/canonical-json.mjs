import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function fail(message) {
  throw new TypeError(`invalid canonical JSON: ${message}`);
}

export function compareOrdinal(left, right) {
  if (typeof left !== "string" || typeof right !== "string") fail("ordinal comparison requires strings");
  return left < right ? -1 : left > right ? 1 : 0;
}

function stringifyString(value) {
  if (!value.isWellFormed()) fail("strings and record keys must be well-formed Unicode");
  return JSON.stringify(value);
}

function exactArrayValues(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("arrays must be plain");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) fail("arrays must not contain symbol or extra fields");
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || lengthDescriptor.enumerable || !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 0xffffffff) fail("arrays must have an exact length data field");
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1) fail("arrays must not be sparse or contain extra fields");
  const values = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail("arrays must be dense enumerable data fields without accessors");
    values[index] = descriptor.value;
  }
  return values;
}

function stringify(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return stringifyString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("numbers must be finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${exactArrayValues(value).map(stringify).join(",")}]`;
  if (typeof value !== "object") fail("value is not JSON");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("records must be plain");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key === "symbol")) fail("records must have enumerable string data fields only");
  const keys = ownKeys.sort(compareOrdinal);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail("records must have enumerable string data fields only");
  }
  return `{${keys.map((key) => `${stringifyString(key)}:${stringify(descriptors[key].value)}`).join(",")}}`;
}

export function canonicalize(value) {
  return new TextEncoder().encode(stringify(value));
}

export function canonicalJsonFileBytes(value) {
  const canonical = canonicalize(value);
  const bytes = new Uint8Array(canonical.length + 1);
  bytes.set(canonical);
  bytes[bytes.length - 1] = 0x0a;
  return bytes;
}

export function parseCanonicalJsonBytes(input, label = "committed JSON") {
  if (!(input instanceof Uint8Array) || input.length < 2) fail(`${label} must be nonempty UTF-8 bytes with one LF`);
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) fail(`${label} must not contain a BOM`);
  if (input[input.length - 1] !== 0x0a || input.slice(0, -1).includes(0x0a) || input.includes(0x0d)) fail(`${label} must contain exactly one final LF and no CR`);
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, -1));
    value = JSON.parse(text);
  } catch {
    fail(`${label} must be strict UTF-8 JSON`);
  }
  const expected = canonicalJsonFileBytes(value);
  if (expected.length !== input.length || expected.some((byte, index) => byte !== input[index])) fail(`${label} must be duplicate-free exact canonical JSON`);
  return value;
}

export async function loadCanonicalJsonFile(url, label) {
  const bytes = await readFile(url);
  const value = parseCanonicalJsonBytes(bytes, label);
  return Object.freeze({
    value,
    canonicalSha256: createHash("sha256").update(bytes.subarray(0, -1)).digest("hex"),
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array ? value : canonicalize(value);
  return createHash("sha256").update(bytes).digest("hex");
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function fail(message) {
  throw new TypeError(`invalid canonical JSON: ${message}`);
}

function stringifyString(value) {
  if (!value.isWellFormed()) fail("strings and record keys must be well-formed Unicode");
  return JSON.stringify(value);
}

function stringify(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return stringifyString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("numbers must be finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
  if (typeof value !== "object") fail("value is not JSON");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("records must be plain");
  const keys = Object.keys(value).sort();
  if (keys.length !== Object.getOwnPropertyNames(value).length || Object.getOwnPropertySymbols(value).length !== 0) fail("records must have enumerable string data fields only");
  return `{${keys.map((key) => `${stringifyString(key)}:${stringify(value[key])}`).join(",")}}`;
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

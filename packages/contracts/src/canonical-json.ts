import type { Sha256Hex } from "./ids.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeString(value: string): string {
  if (!isWellFormedUnicode(value)) throw new TypeError("JSON strings must be well-formed Unicode");
  return value.normalize("NFC");
}

function normalizeJson(value: unknown, path = "$"): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return normalizeString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must not contain a non-finite number`);
    return value;
  }
  if (typeof value === "undefined") throw new TypeError(`${path} must not contain undefined`);
  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${path} must not contain sparse arrays`);
      normalized.push(normalizeJson(value[index], `${path}[${index}]`));
    }
    return normalized;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${path} must be a JSON value`);
  }

  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    const normalizedKey = normalizeString(key);
    if (Object.hasOwn(normalized, normalizedKey)) throw new TypeError(`${path} contains duplicate NFC-normalized keys`);
    normalized[normalizedKey] = normalizeJson((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
  return normalized;
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;

  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`).join(",")}}`;
}

/** Returns RFC 8785 JSON bytes after enforcing the event-text NFC boundary. */
export function canonicalize(value: unknown): Uint8Array {
  return new TextEncoder().encode(serialize(normalizeJson(value)));
}

export function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(canonicalize(value));
}

export async function sha256Hex(input: string | Uint8Array): Promise<Sha256Hex> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") as Sha256Hex;
}

export function normalizeJsonText(value: unknown): JsonValue {
  return normalizeJson(value);
}

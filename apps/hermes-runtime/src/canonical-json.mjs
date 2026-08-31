import { createHash } from "node:crypto";

function fail(message) {
  throw new TypeError(`invalid canonical JSON: ${message}`);
}

function stringify(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("numbers must be finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
  if (typeof value !== "object") fail("value is not JSON");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("records must be plain");
  const keys = Object.keys(value).sort();
  if (keys.length !== Object.getOwnPropertyNames(value).length || Object.getOwnPropertySymbols(value).length !== 0) fail("records must have enumerable string data fields only");
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringify(value[key])}`).join(",")}}`;
}

export function canonicalize(value) {
  return new TextEncoder().encode(stringify(value));
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array ? value : canonicalize(value);
  return createHash("sha256").update(bytes).digest("hex");
}

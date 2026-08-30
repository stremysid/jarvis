import type {
  TwilioRequestVerifier,
} from "./provider-types.js";

const MAX_FORM_BYTES = 65_536;
const STRICT_SHA1_BASE64 = /^[A-Za-z0-9+/]{27}=$/;
const BAD_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const RAW_URL_CONTROL_OR_BACKSLASH = /[\u0000-\u0020\u007f-\u009f\\]/u;

type FormPair = readonly [string, string];
const verifiedTwilioFormBrand: unique symbol = Symbol("verifiedTwilioForm");

/** Nominal capability minted only after a Twilio signature has been verified. */
export interface VerifiedTwilioForm {
  readonly [verifiedTwilioFormBrand]: true;
  get(name: string): string | null;
  getAll(name: string): readonly string[];
  entries(): readonly FormPair[];
}

type Assert<T extends true> = T;
type StructuralForm = {
  get(name: string): string | null;
  getAll(name: string): readonly string[];
  entries(): readonly FormPair[];
};
// This source-level assertion is compiled by the package typecheck and fails if the private brand is removed.
type _VerifiedFormIsNominal = Assert<StructuralForm extends VerifiedTwilioForm ? false : true>;

class FrozenVerifiedTwilioForm implements VerifiedTwilioForm {
  declare readonly [verifiedTwilioFormBrand]: true;
  readonly #pairs: readonly FormPair[];

  constructor(pairs: readonly FormPair[]) {
    this.#pairs = Object.freeze(pairs.map(([name, value]) => Object.freeze([name, value] as const)));
    Object.freeze(this);
  }

  get(name: string): string | null {
    for (const [candidate, value] of this.#pairs) {
      if (candidate === name) return value;
    }
    return null;
  }

  getAll(name: string): readonly string[] {
    return Object.freeze(this.#pairs
      .filter(([candidate]) => candidate === name)
      .map(([, value]) => value));
  }

  entries(): readonly FormPair[] {
    return this.#pairs;
  }
}

function decodeFormComponent(component: string): string | null {
  if (BAD_PERCENT_ESCAPE.test(component)) return null;
  try {
    return decodeURIComponent(component.replaceAll("+", " "));
  } catch {
    return null;
  }
}

function parseForm(rawBody: Uint8Array): readonly FormPair[] | null {
  if (rawBody.byteLength > MAX_FORM_BYTES) return null;

  let encoded: string;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
  } catch {
    return null;
  }

  const pairs: FormPair[] = [];
  for (const field of encoded.split("&")) {
    if (field.length === 0) continue;
    const separator = field.indexOf("=");
    const encodedName = separator === -1 ? field : field.slice(0, separator);
    const encodedValue = separator === -1 ? "" : field.slice(separator + 1);
    const name = decodeFormComponent(encodedName);
    const value = decodeFormComponent(encodedValue);
    if (name === null || value === null) return null;
    pairs.push(Object.freeze([name, value] as const));
  }
  return Object.freeze(pairs);
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // Rejection is already fail-closed and transport details must not escape this boundary.
  }
}

async function readBoundedRequestBody(request: Request): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || contentLength.length > 20) {
      await cancelBody(request);
      return null;
    }
    if (BigInt(contentLength) > BigInt(MAX_FORM_BYTES)) {
      await cancelBody(request);
      return null;
    }
  }

  if (request.body === null) return new Uint8Array();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FORM_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    if (reader === undefined) {
      await cancelBody(request);
    } else {
      try {
        await reader.cancel();
      } catch {
        // The stream is already rejected.
      }
    }
    return null;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function contentTypeIsForm(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function isValidExactUrl(value: unknown, expectedProtocol: "https:" | "wss:"): value is string {
  if (
    typeof value !== "string"
    || RAW_URL_CONTROL_OR_BACKSLASH.test(value)
    || BAD_PERCENT_ESCAPE.test(value)
    || value.includes("#")
    || !(expectedProtocol === "https:" ? /^https:\/\//iu : /^wss:\/\//iu).test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === expectedProtocol
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

function strictSignatureBytes(value: string | null): Uint8Array | null {
  if (value === null || !STRICT_SHA1_BASE64.test(value)) return null;
  try {
    const decoded = atob(value);
    if (decoded.length !== 20) return null;
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    let canonical = "";
    for (const byte of bytes) canonical += String.fromCharCode(byte);
    return btoa(canonical) === value ? bytes : null;
  } catch {
    return null;
  }
}

function signedPayload(exactUrl: string, pairs: readonly FormPair[]): Uint8Array {
  const grouped = new Map<string, Set<string>>();
  for (const [name, value] of pairs) {
    const values = grouped.get(name) ?? new Set<string>();
    values.add(value);
    grouped.set(name, values);
  }
  return new TextEncoder().encode(
    exactUrl + [...grouped]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .flatMap(([name, values]) => [...values]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((value) => `${name}${value}`))
      .join(""),
  );
}

export class TwilioSignatureVerifier implements TwilioRequestVerifier {
  readonly #key: Promise<CryptoKey>;

  constructor(input: { authToken: string }) {
    if (input.authToken.length === 0) throw new TypeError("twilio_auth_token_invalid");
    this.#key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(input.authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["verify"],
    );
  }

  async verifyWebhook(input: {
    request: Request;
    exactUrl: string;
  }): Promise<VerifiedTwilioForm | null> {
    if (
      input.request.method !== "POST"
      || !contentTypeIsForm(input.request.headers)
      || !isValidExactUrl(input.exactUrl, "https:")
    ) {
      await cancelBody(input.request);
      return null;
    }
    const rawBody = await readBoundedRequestBody(input.request);
    if (rawBody === null) return null;
    const signature = strictSignatureBytes(input.request.headers.get("x-twilio-signature"));
    if (signature === null) return null;
    const pairs = parseForm(rawBody);
    if (pairs === null) return null;

    try {
      const verified = await crypto.subtle.verify(
        "HMAC",
        await this.#key,
        signature,
        signedPayload(input.exactUrl, pairs),
      );
      return verified ? new FrozenVerifiedTwilioForm(pairs) : null;
    } catch {
      return null;
    }
  }

  async verifyWebSocket(input: {
    request: Request;
    exactUrl: string;
  }): Promise<boolean> {
    if (input.request.method !== "GET" || !isValidExactUrl(input.exactUrl, "wss:")) return false;
    const signature = strictSignatureBytes(input.request.headers.get("x-twilio-signature"));
    if (signature === null) return false;
    try {
      return await crypto.subtle.verify(
        "HMAC",
        await this.#key,
        signature,
        new TextEncoder().encode(input.exactUrl),
      );
    } catch {
      return false;
    }
  }
}

import type { Sha256Hex, Ulid } from "./ids.js";

const redactionToken = Symbol("redactionToken");
const issuedRedactions = new WeakSet<object>();
const AUTHENTICATION_DIGITS = /(?<!\d)\d{6}(?!\d)/g;
const AUTHORIZATION_HEADER = /\bauthorization\s*:\s*[^\r\n]*/gi;
const CREDENTIALS = /\b(?:api[_-]?key\s*[=:]|password\s*[=:])\s*[^\s,;]+/gi;

export interface OutboundCallCommand {
  commandId: Ulid;
  principalId: string;
  purposeCode: "smoke" | "user_requested";
  destinationIdentityId: string;
  urgency: "normal" | "urgent";
  authorizationExpiresAt: string;
  idempotencyKey: string;
  issuedBy: "telegram_call_command" | "local_cli";
}

export interface SignedRequestV1 {
  schemaVersion: "1.0";
  deviceId: string;
  principalId: string;
  audience: string;
  issuedAt: string;
  nonce: string;
  bodyHash: Sha256Hex;
  signatureBase64: string;
}

export interface SuccessfulRedaction {
  ok: true;
  readonly text: string;
  readonly markers: readonly string[];
  readonly [redactionToken]: true;
}

export interface FailedRedaction {
  ok: false;
  category: "ingest_redaction_failed";
}

export type RedactionResult = SuccessfulRedaction | FailedRedaction;

function issueSanitizedRedaction(text: string, markers: readonly string[]): SuccessfulRedaction {
  if (!text.isWellFormed() || text !== text.normalize("NFC") || markers.some((marker) => !marker.isWellFormed() || marker !== marker.normalize("NFC"))) {
    throw new TypeError("redaction text and markers must be NFC-normalized");
  }
  const result = {
    ok: true as const,
    text,
    markers: Object.freeze([...markers]),
  } as SuccessfulRedaction;
  Object.defineProperty(result, redactionToken, { value: true, enumerable: false, writable: false, configurable: false });
  Object.freeze(result);
  issuedRedactions.add(result);
  return result;
}

/** Recognizes only tokens minted by issueRedaction in this module instance. */
export function isIssuedRedaction(value: unknown): value is SuccessfulRedaction {
  return value !== null && typeof value === "object" && issuedRedactions.has(value);
}

/**
 * The only redaction-token issuer. It removes secrets before minting an opaque,
 * frozen token; failure values never retain the original input.
 */
export function sanitizeRedaction(text: string): RedactionResult {
  try {
    if (typeof text !== "string" || !text.isWellFormed()) return { ok: false, category: "ingest_redaction_failed" };
    const markers: string[] = [];
    const mark = (marker: string) => {
      if (!markers.includes(marker)) markers.push(marker);
    };
    let redacted = text.replace(AUTHORIZATION_HEADER, () => {
      mark("authorization");
      return "[REDACTED_AUTHORIZATION]";
    });
    redacted = redacted.replace(CREDENTIALS, () => {
      mark("credential");
      return "[REDACTED_CREDENTIAL]";
    });
    redacted = redacted.replace(AUTHENTICATION_DIGITS, () => {
      mark("authentication_digits");
      return "[REDACTED_AUTH_DIGITS]";
    });
    return issueSanitizedRedaction(redacted.normalize("NFC"), markers);
  } catch {
    return { ok: false, category: "ingest_redaction_failed" };
  }
}

export interface Redactor {
  redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult;
  redactText(text: string): RedactionResult;
}

import type { Sha256Hex, Ulid } from "./ids.js";
import type { VoiceAccessBinding } from "./voice-access.js";

const redactionToken = Symbol("redactionToken");
const issuedRedactions = new WeakSet<object>();
const LOWERCASE_ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
/**
 * The decision callback token, `d1:<ulid>:<option key>`.
 *
 * This is the *second* copy of that grammar on purpose, and the other one is the
 * parser in `apps/cloud-gateway/src/decisions/telegram-keyboard.ts`. That file
 * keeps its own literal because a Telegram client returns those bytes weeks
 * later and the parser must not move when a shared constant does; this copy
 * exists only so the redactor can tell a platform-minted identifier from owner
 * text. They are kept in step by a test rather than by an import, so a drift
 * breaks a test instead of a delivery.
 */
const DECISION_CALLBACK_DATA = /^d1:[0-7][0-9a-hjkmnp-tv-z]{25}:[a-z0-9_-]{1,32}$/u;
const AUTHENTICATION_DIGITS = /(?<!\d)\d{6}(?!\d)/g;
/**
 * A credential word and what may sit between it and its digits. Both contextual
 * rules below are built from this one source, so the word list cannot learn a
 * word in one rule and not the other. `projection_policy.py` in the local agent
 * transcribes it, and `tests/fixtures/memory-projection-policy.json` holds both
 * runtimes to the same answers.
 */
const AUTHENTICATION_WORD = String.raw`(\b(?:pin|passcode|otp|authentication(?:[_ -]?code)?|verification(?:[_ -]?code)?)(?:\s+is)?\s*[=:]?\s*)`;
const CONTEXTUAL_EIGHT_DIGIT_AUTHENTICATION = new RegExp(String.raw`${AUTHENTICATION_WORD}(\d{8})(?!\d)`, "gi");
/**
 * The owner PIN is four digits, and until this rule "my pin is 4821" crossed
 * every boundary verbatim -- into `events.envelope_json`, the R2 archive and the
 * model prompt -- because the bare rule above wants exactly six and the
 * contextual one exactly eight.
 *
 * It is gated on the credential word, deliberately not a bare four-digit rule:
 * this function also sanitizes every reply Jarvis sends and the school and
 * university text it reads, and a bare rule would take every year, time, score,
 * price and street number with it ("due Jan 15, [REDACTED_AUTH_DIGITS]"). A PIN
 * spoken with no credential word before it is not caught here.
 */
const CONTEXTUAL_FOUR_DIGIT_AUTHENTICATION = new RegExp(String.raw`${AUTHENTICATION_WORD}(\d{4})(?!\d)`, "gi");
const AUTHORIZATION_HEADER = /\bauthorization\s*:\s*(?:bearer[ \t\r\n]+[A-Za-z0-9._~+/=-]+[^\r\n]*|[^\r\n]*)/gi;
const BARE_BEARER = /\bbearer[ \t\r\n]+([A-Za-z0-9._~+/=-]{8,})/gi;
const CREDENTIAL_LABEL = String.raw`api(?:[_-]|\s+)?key|password|client(?:[_-]|\s+)?secret|access(?:[_-]|\s+)?token|token|secret|pin|passphrase|passcode|code`;
// An escape can be split at EOF in a streaming prefix. Consume that dangling
// backslash too; falling back to the unquoted alternative exposes later words.
// A numeric replacement retains its label. Do not reinterpret that exact
// placeholder as another assignment when already-redacted text crosses again.
const CREDENTIAL_ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9])((["']?)(${CREDENTIAL_LABEL})\2(?:\s*[=:]\s*|\s+is\s+))((?:"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\(?=\r?\n|$)|(?=\r?\n|$))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|\\(?=\r?\n|$)|(?=\r?\n|$))|(?!\[REDACTED_(?:AUTH_DIGITS|AUTHORIZATION|CREDENTIAL|PHONE_NUMBER)\][.!?]*(?:\s|[,;]|$))[^\s,;]+))`, "gi");
// Spoken passphrases need not have quotation marks. The unquoted form ends at
// sentence/list punctuation; quoted values use the escape-aware rule above.
const SPOKEN_PASSPHRASE = /\bpassphrase(?:\s*[=:]\s*|\s+is\s+)(?![\s"'])[^\s,;.!?][^,;.!?\r\n]*/gi;
// A line can end midway through a label or before its value. Telegram retains
// that suffix to EOF rather than releasing a line that later input can redact.
const STREAMING_REDACTION_CONTEXT = new RegExp(String.raw`(?<![A-Za-z0-9])(?:${CREDENTIAL_LABEL}|authorization|bearer|otp|authentication|verification)\b|\b(?:api|client|access)\s*$`, "i");
// A bare digit run is ambiguous. Require a country prefix or the requested
// grouping, and reject a match embedded in a longer alphanumeric identifier.
const PHONE_NUMBER = /(?<![A-Za-z0-9_+-])(?:\+1[ \t-]*(?:\([0-9]{3}\)[ \t]*[0-9]{3}[ -][0-9]{4}|(?:[0-9]{3}[ -])?[0-9]{3}[ -][0-9]{4}|[0-9]{10})|\([0-9]{3}\)[ \t]*[0-9]{3}[ -][0-9]{4}|[0-9]{3}-[0-9]{3}-[0-9]{4})(?![A-Za-z0-9_]|-[0-9])/g;
const KNOWN_CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*)-----[\s\S]*?(?:-----END \1-----|$)/g;

export type RedactionMarker = "authentication_digits" | "authorization" | "credential" | "phone_number";

const REPLACEMENT: Readonly<Record<RedactionMarker, string>> = Object.freeze({
  authentication_digits: "[REDACTED_AUTH_DIGITS]",
  authorization: "[REDACTED_AUTHORIZATION]",
  credential: "[REDACTED_CREDENTIAL]",
  phone_number: "[REDACTED_PHONE_NUMBER]",
});

export function hasStreamingRedactionContext(text: string): boolean {
  return STREAMING_REDACTION_CONTEXT.test(text);
}

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

export type CallPhase = "created" | "connecting" | "pre_auth" | "authenticated" | "active" | "ending" | "completed" | "rejected" | "failed" | "expired";
export type TranscriptState = "partial" | "committed" | "cancelled";
export type CallDirection = "inbound" | "outbound";

export interface ExpectedOutboundCall {
  commandId: string;
  principalId: string;
  destinationIdentityId: string;
  relayNonce: string;
  nonceExpiresAt: string;
  authorizationExpiresAt: string;
  idempotencyKey: string;
}

export interface RelayBinding extends VoiceAccessBinding {
  callSid: string;
  principalId: string;
  identityId: string;
  destinationIdentityId: string;
  relayNonce: string;
  direction: CallDirection;
  activationOnly: boolean;
  activationChallengeId: string | null;
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
  readonly markers: readonly RedactionMarker[];
  readonly [redactionToken]: true;
}

export interface FailedRedaction {
  ok: false;
  category: "ingest_redaction_failed";
}

export type RedactionResult = SuccessfulRedaction | FailedRedaction;

function issueSanitizedRedaction(text: string, markers: readonly RedactionMarker[]): SuccessfulRedaction {
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

/** Recognizes only redaction tokens minted by this module instance. */
export function isIssuedRedaction(value: unknown): value is SuccessfulRedaction {
  return value !== null && typeof value === "object" && issuedRedactions.has(value);
}

/**
 * Removes secrets before minting an opaque, frozen token; failure values never
 * retain the original input.
 */
export function sanitizeRedaction(
  text: string,
  fieldMarker?: RedactionMarker,
  structuralUlid = false,
): RedactionResult {
  try {
    if (typeof text !== "string" || !text.isWellFormed()) return { ok: false, category: "ingest_redaction_failed" };
    if (fieldMarker !== undefined) return issueSanitizedRedaction(REPLACEMENT[fieldMarker], [fieldMarker]);
    if (structuralUlid && (LOWERCASE_ULID.test(text) || DECISION_CALLBACK_DATA.test(text))) {
      return issueSanitizedRedaction(text, []);
    }
    const markers: RedactionMarker[] = [];
    const mark = (marker: RedactionMarker) => {
      if (!markers.includes(marker)) markers.push(marker);
    };
    let redacted = text.replace(PRIVATE_KEY_BLOCK, () => {
      mark("credential");
      return REPLACEMENT.credential;
    });
    redacted = redacted.replace(AUTHORIZATION_HEADER, () => {
      mark("authorization");
      return REPLACEMENT.authorization;
    });
    redacted = redacted.replace(BARE_BEARER, (match, credential: string) => {
      const looksCredentialLike = credential.length >= 16 && /[A-Za-z]/.test(credential) && /[0-9._~+/=-]/.test(credential);
      if (!looksCredentialLike) return match;
      mark("authorization");
      return REPLACEMENT.authorization;
    });
    redacted = redacted.replace(SPOKEN_PASSPHRASE, () => {
      mark("credential");
      return REPLACEMENT.credential;
    });
    // An unquoted assignment can consume only a phone's country/area prefix.
    // Match the whole number first so that cannot expose the remaining groups.
    redacted = redacted.replace(PHONE_NUMBER, () => {
      mark("phone_number");
      return REPLACEMENT.phone_number;
    });
    redacted = redacted.replace(CREDENTIAL_ASSIGNMENT, (_match, prefix: string, _quote: string, label: string, value: string) => {
      // Preserve the existing numeric marker and sentence punctuation for PINs
      // and codes, including lengths the old four/eight-digit rules missed.
      const digits = /^(\d+)([.!?]*)$/.exec(value);
      if (/^(?:pin|passcode|code)$/i.test(label) && digits !== null) {
        mark("authentication_digits");
        return `${prefix}${REPLACEMENT.authentication_digits}${digits[2]}`;
      }
      mark("credential");
      return REPLACEMENT.credential;
    });
    redacted = redacted.replace(KNOWN_CREDENTIAL, () => {
      mark("credential");
      return REPLACEMENT.credential;
    });
    redacted = redacted.replace(CONTEXTUAL_EIGHT_DIGIT_AUTHENTICATION, (_match, prefix: string) => {
      mark("authentication_digits");
      return `${prefix}${REPLACEMENT.authentication_digits}`;
    });
    redacted = redacted.replace(CONTEXTUAL_FOUR_DIGIT_AUTHENTICATION, (_match, prefix: string) => {
      mark("authentication_digits");
      return `${prefix}${REPLACEMENT.authentication_digits}`;
    });
    redacted = redacted.replace(AUTHENTICATION_DIGITS, () => {
      mark("authentication_digits");
      return REPLACEMENT.authentication_digits;
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

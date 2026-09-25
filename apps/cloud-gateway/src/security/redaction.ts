import {
  sanitizeRedaction,
  type RedactionAudience,
  type RedactionMarker,
  type RedactionResult,
  type Redactor as RedactorContract,
} from "../../../../packages/contracts/src/calls.js";

const AUTHORIZATION_FIELDS = ["authorization", "authorization_header", "auth_header"] as const;
const CREDENTIAL_FIELDS = ["api_key", "password", "secret", "client_secret", "access_token", "credential", "private_key", "token"] as const;
const DTMF_FIELDS = ["dtmf", "dtmf_digits", "digits", "pin", "passcode", "otp", "authentication_code", "verification_code"] as const;

function normalizedFieldName(field: string): string {
  return field
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasSensitiveSuffix(field: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => field === suffix || field.endsWith(`_${suffix}`));
}

function fieldMarker(channel: "voice" | "telegram", field: string): RedactionMarker | undefined {
  if (typeof field !== "string" || !field.isWellFormed()) return "credential";
  const normalized = normalizedFieldName(field);
  if (hasSensitiveSuffix(normalized, AUTHORIZATION_FIELDS)) return "authorization";
  if (hasSensitiveSuffix(normalized, CREDENTIAL_FIELDS)) return "credential";
  if (channel === "voice" && hasSensitiveSuffix(normalized, DTMF_FIELDS)) return "authentication_digits";
  return undefined;
}

function structuralUlidField(field: string): boolean {
  if (typeof field !== "string" || !field.isWellFormed()) return false;
  const normalized = normalizedFieldName(field);
  return normalized === "id" || normalized.endsWith("_id") || normalized.endsWith("_ids");
}

/**
 * Removes what the reader must not receive. `new Redactor("owner")` is Sid's
 * reader: he sees his own data as it is. The default is `external` (a guest
 * caller, an audit or telemetry record), so a construction that forgets to
 * name its reader hides too much from Sid rather than showing Sid's data to
 * someone else. See `RedactionAudience` in the contracts package.
 *
 * The field-name markers apply to both audiences. They name provider payload
 * fields, not Sid's words: `authorization`/`token`-style fields are machine
 * credentials, and a voice `digits`/`pin` field is the keypad entry that
 * verifies the caller -- authentication input, which stays out of storage.
 */
export class Redactor implements RedactorContract {
  private readonly audience: RedactionAudience;

  constructor(audience: RedactionAudience = "external") {
    if (audience !== "owner" && audience !== "external") throw new TypeError("redaction_audience_invalid");
    this.audience = audience;
  }

  redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult {
    return sanitizeRedaction(
      input.text,
      fieldMarker(input.channel, input.field),
      structuralUlidField(input.field),
      this.audience,
    );
  }

  redactText(text: string): RedactionResult {
    return sanitizeRedaction(text, undefined, false, this.audience);
  }
}

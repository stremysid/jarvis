import {
  sanitizeRedaction,
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

/** Removes values that must never cross the ingress logging or event boundary. */
export class Redactor implements RedactorContract {
  redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult {
    return sanitizeRedaction(
      input.text,
      fieldMarker(input.channel, input.field),
      structuralUlidField(input.field),
    );
  }

  redactText(text: string): RedactionResult {
    return sanitizeRedaction(text);
  }
}

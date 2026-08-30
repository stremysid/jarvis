import type { Sha256Hex, Ulid } from "./ids.js";

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
  text: string;
  markers: string[];
}

export interface FailedRedaction {
  ok: false;
  category: "ingest_redaction_failed";
}

export type RedactionResult = SuccessfulRedaction | FailedRedaction;

export interface Redactor {
  redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult;
  redactText(text: string): RedactionResult;
}

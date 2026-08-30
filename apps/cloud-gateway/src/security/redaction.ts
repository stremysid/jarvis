import type { RedactionResult, Redactor as RedactorContract } from "../../../../packages/contracts/src/index.js";

const AUTHENTICATION_DIGITS = /(?<!\d)\d{6}(?!\d)/g;
const CREDENTIALS = /\b(?:authorization\s*:\s*bearer|api[_-]?key\s*[=:]|password\s*[=:])\s*[^\s,;]+/gi;

/** Removes values that must never cross the ingress logging or event boundary. */
export class Redactor implements RedactorContract {
  redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult {
    return this.redactText(input.text);
  }

  redactText(text: string): RedactionResult {
    try {
      if (typeof text !== "string" || !text.isWellFormed()) {
        return { ok: false, category: "ingest_redaction_failed" };
      }
      const markers: string[] = [];
      let redacted = text.replace(AUTHENTICATION_DIGITS, () => {
        if (!markers.includes("authentication_digits")) markers.push("authentication_digits");
        return "[REDACTED_AUTH_DIGITS]";
      });
      redacted = redacted.replace(CREDENTIALS, () => {
        if (!markers.includes("credential")) markers.push("credential");
        return "[REDACTED_CREDENTIAL]";
      });
      return { ok: true, text: redacted.normalize("NFC"), markers };
    } catch {
      return { ok: false, category: "ingest_redaction_failed" };
    }
  }
}

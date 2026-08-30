import { sanitizeRedaction, type RedactionResult, type Redactor as RedactorContract } from "../../../../packages/contracts/src/calls.js";

/** Removes values that must never cross the ingress logging or event boundary. */
export class Redactor implements RedactorContract {
  redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult {
    return this.redactText(input.text);
  }

  redactText(text: string): RedactionResult {
    return sanitizeRedaction(text);
  }
}

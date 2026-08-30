import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/security/redaction";

describe("Redactor", () => {
  it("redacts authentication digits before text can enter an event", () => {
    const redacted = new Redactor().redact({
      text: "Your sign-in code is 123456.",
      channel: "telegram",
      field: "message.text",
    });

    expect(redacted).toEqual({
      ok: true,
      text: "Your sign-in code is [REDACTED_AUTH_DIGITS].",
      markers: ["authentication_digits"],
    });
  });

  it("returns an ingestion failure instead of preserving invalid text", () => {
    expect(new Redactor().redactText("\ud800")).toEqual({
      ok: false,
      category: "ingest_redaction_failed",
    });
  });
});

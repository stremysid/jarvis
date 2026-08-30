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

  it.each([
    "Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
    "Authorization: Bearer secret-token-value",
  ])("redacts an authorization header regardless of scheme", (input) => {
    const result = new Redactor().redactText(input);

    expect(result).toMatchObject({
      ok: true,
      text: "[REDACTED_AUTHORIZATION]",
      markers: ["authorization"],
    });
    if (result.ok) expect(result.text).not.toContain("secret");
  });

  it.each(["api key = whitespace-secret", "api   key = whitespace-secret"])("redacts whitespace-separated API-key labels", (input) => {
    const result = new Redactor().redactText(input);

    expect(result).toMatchObject({
      ok: true,
      text: "[REDACTED_CREDENTIAL]",
      markers: ["credential"],
    });
    if (result.ok) expect(result.text).not.toContain("whitespace-secret");
  });
});

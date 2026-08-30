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

  it("redacts an isolated eight-digit DTMF PIN", () => {
    const result = new Redactor().redactText("PIN 12345678 is ready");

    expect(result).toEqual({
      ok: true,
      text: "PIN [REDACTED_AUTH_DIGITS] is ready",
      markers: ["authentication_digits"],
    });
    if (result.ok) expect(result.text).not.toContain("12345678");
  });

  it("redacts a four-digit voice PIN by field context without redacting a year", () => {
    const redactor = new Redactor();
    expect(redactor.redact({ text: "4827", channel: "voice", field: "guest.pin" }))
      .toEqual({ ok: true, text: "[REDACTED_AUTH_DIGITS]", markers: ["authentication_digits"] });
    expect(redactor.redact({ text: "Roadmap review in 2026", channel: "voice", field: "prompt.text" }))
      .toEqual({ ok: true, text: "Roadmap review in 2026", markers: [] });
  });

  it.each([
    ["a bare Bearer JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl", "[REDACTED_AUTHORIZATION]", "authorization"],
    ["a token assignment", "token=sk-test_0123456789abcdefghijklmnopqrstuvwxyz", "[REDACTED_CREDENTIAL]", "credential"],
    ["a secret assignment", "secret: opaque-secret-value", "[REDACTED_CREDENTIAL]", "credential"],
    ["a client-secret assignment", "client_secret=opaque-client-value", "[REDACTED_CREDENTIAL]", "credential"],
    ["a quoted client-secret assignment", "\"client_secret\": \"opaque-json-value\"", "[REDACTED_CREDENTIAL]", "credential"],
    ["an escaped quoted client-secret assignment", "\"client_secret\": \"prefix\\\"actual-secret-value-123\"", "[REDACTED_CREDENTIAL]", "credential"],
    ["an unterminated quoted client-secret assignment", "\"client_secret\": \"prefix actual-secret-value-123", "[REDACTED_CREDENTIAL]", "credential"],
    ["an access-token assignment", "access_token: opaque-access-value", "[REDACTED_CREDENTIAL]", "credential"],
    ["a prefixed high-entropy credential", "sk-test_0123456789abcdefghijklmnopqrstuvwxyz", "[REDACTED_CREDENTIAL]", "credential"],
    ["a GitHub personal access token", "ghp_0123456789abcdefghijklmnopqrstuv", "[REDACTED_CREDENTIAL]", "credential"],
    ["a compact opaque Bearer token", "Bearer A1b2C3d4E5f6G7h8", "[REDACTED_AUTHORIZATION]", "authorization"],
    ["a hyphenated opaque Bearer token", "Bearer secret-token-value", "[REDACTED_AUTHORIZATION]", "authorization"],
  ])("redacts %s without retaining the original credential", (_label, input, text, marker) => {
    const result = new Redactor().redactText(input);

    expect(result).toEqual({ ok: true, text, markers: [marker] });
    if (result.ok) expect(result.text).not.toContain(input);
  });

  it("redacts a complete private-key block", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----";
    const result = new Redactor().redactText(`key follows:\n${privateKey}\nend`);

    expect(result).toEqual({
      ok: true,
      text: "key follows:\n[REDACTED_CREDENTIAL]\nend",
      markers: ["credential"],
    });
    if (result.ok) expect(result.text).not.toContain(privateKey);
  });

  it.each([
    ["a PGP private-key block", "-----BEGIN PGP PRIVATE KEY BLOCK-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PGP PRIVATE KEY BLOCK-----"],
    ["a truncated PEM private-key block", "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA=="],
  ])("redacts %s through the end of the sensitive block", (_label, privateKey) => {
    const result = new Redactor().redactText(`key follows:\n${privateKey}`);

    expect(result).toEqual({
      ok: true,
      text: "key follows:\n[REDACTED_CREDENTIAL]",
      markers: ["credential"],
    });
    if (result.ok) expect(result.text).not.toContain(privateKey);
  });

  it.each([
    [{ text: "12#*34", channel: "voice" as const, field: "dtmf.digits" }, "[REDACTED_AUTH_DIGITS]", "authentication_digits"],
    [{ text: "ordinary-looking-value", channel: "telegram" as const, field: "oauth.client_secret" }, "[REDACTED_CREDENTIAL]", "credential"],
    [{ text: "ordinary-looking-value", channel: "telegram" as const, field: "request.authorization" }, "[REDACTED_AUTHORIZATION]", "authorization"],
  ])("fails closed for an explicitly sensitive field", (input, text, marker) => {
    const result = new Redactor().redact(input);

    expect(result).toEqual({ ok: true, text, markers: [marker] });
    if (result.ok) expect(result.text).not.toContain(input.text);
  });

  it.each([
    "The bearer of good news described a secret garden.",
    "Release build abcdef0123456789abcdef0123456789 is public.",
    "The model token count is 2048 for this public request.",
    "Call extension 123456789 when the office opens.",
    "Release date 20260830 is public.",
    "The bearer electroencephalographically signed the form.",
    "The bearer ElectroEncephaloGraphically signed the form.",
  ])("does not swallow ordinary prose or non-PIN identifiers", (input) => {
    expect(new Redactor().redact({ text: input, channel: "telegram", field: "message.text" })).toEqual({
      ok: true,
      text: input,
      markers: [],
    });
  });

  it("does not mint a typed marker for malformed sensitive-field text", () => {
    expect(new Redactor().redact({ text: "\ud800", channel: "voice", field: "dtmf.digits" })).toEqual({
      ok: false,
      category: "ingest_redaction_failed",
    });
  });
});

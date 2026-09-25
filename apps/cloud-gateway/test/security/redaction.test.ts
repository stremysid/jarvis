import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/security/redaction";

// The two readers. Sid ("owner", always named) sees his own data as it is;
// anyone else (a guest caller, an audit record; the default) gets every
// rule. Sid, 2026-09-24: "there should be nothing between Jarvis and I
// interms of what he knows and I know".
const toSid = () => new Redactor("owner");
const toSomeoneElse = () => new Redactor("external");

describe("Redactor toward Sid", () => {
  it.each([
    ["an emailed sign-in code", "Your sign-in code is 123456."],
    ["an eight-digit Gmail forwarding code", "Your Gmail confirmation code is 99427480"],
    ["a PIN he typed", "my pin is 4821"],
    ["an eight-digit PIN", "PIN 12345678 is ready"],
    ["a phone number beside a course code and year", "Call (555) 555-0100 about MHF4U in 2026."],
    ["a country-prefixed phone number", "+1 555 555 0100"],
    ["a spoken passphrase", "my passphrase is synthetic meadow lantern."],
    ["a password he pasted", "password=\"synthetic fixture\""],
    ["a labelled secret", "secret: opaque-secret-value"],
    ["a spoken code", "the code is four eight two one"],
  ])("shows Sid %s exactly as it is, on both channels", (_label, text) => {
    for (const channel of ["voice", "telegram"] as const) {
      expect(toSid().redact({ text, channel, field: "conversation.turn.text" }))
        .toEqual({ ok: true, text, markers: [] });
    }
    expect(toSid().redactText(text)).toEqual({ ok: true, text, markers: [] });
  });

  it.each([
    ["an OpenAI-style API key", "sk-test_0123456789abcdefghijklmnopqrstuvwxyz", "[REDACTED_CREDENTIAL]", "credential"],
    ["a GitHub personal access token", "ghp_0123456789abcdefghijklmnopqrstuv", "[REDACTED_CREDENTIAL]", "credential"],
    ["a Telegram bot token", "123456789:AAabcdefghijklmnopqrstuvwxyz0123456", "[REDACTED_CREDENTIAL]", "credential"],
    ["a bearer token", "Bearer A1b2C3d4E5f6G7h8", "[REDACTED_AUTHORIZATION]", "authorization"],
    ["an authorization header", "Authorization: Bearer secret-token-value", "[REDACTED_AUTHORIZATION]", "authorization"],
  ])("still keeps %s, the shape of Jarvis's own infrastructure secrets, out of what Sid is sent", (_label, input, text, marker) => {
    expect(toSid().redactText(input)).toEqual({ ok: true, text, markers: [marker] });
  });

  it("keeps a private-key block out while the rest of Sid's text stays as it is", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----";
    expect(toSid().redactText(`my pin is 4821\n${privateKey}`)).toEqual({
      ok: true, text: "my pin is 4821\n[REDACTED_CREDENTIAL]", markers: ["credential"],
    });
  });

  it("keeps the keypad digits that verify a caller out of storage, because they are authentication input", () => {
    expect(toSid().redact({ text: "4821", channel: "voice", field: "dtmf.digits" }))
      .toEqual({ ok: true, text: "[REDACTED_AUTH_DIGITS]", markers: ["authentication_digits"] });
  });

  it("redacts as for someone who is not Sid when constructed without naming a reader", () => {
    expect(new Redactor().redactText("my pin is 4821"))
      .toEqual(toSomeoneElse().redactText("my pin is 4821"));
    expect(new Redactor().redactText("my pin is 4821")).toMatchObject({ text: "my pin is [REDACTED_AUTH_DIGITS]" });
  });

  it("refuses an audience that is neither Sid nor someone else", () => {
    expect(() => new Redactor("guest" as never)).toThrow("redaction_audience_invalid");
  });
});

describe("Redactor toward someone who is not Sid", () => {
  it("marks phone numbers on both channels without changing the course code or year beside them", () => {
    for (const channel of ["voice", "telegram"] as const) {
      expect(toSomeoneElse().redact({
        text: "Call (555) 555-0100 about MHF4U in 2026.", channel, field: "conversation.turn.text",
      })).toEqual({
        ok: true, text: "Call [REDACTED_PHONE_NUMBER] about MHF4U in 2026.", markers: ["phone_number"],
      });
    }
  });

  it("marks a spoken passphrase as a credential without retaining any of its words", () => {
    expect(toSomeoneElse().redactText("my passphrase is synthetic meadow lantern.")).toEqual({
      ok: true, text: "my [REDACTED_CREDENTIAL].", markers: ["credential"],
    });
  });

  it("redacts authentication digits", () => {
    expect(toSomeoneElse().redact({
      text: "Your sign-in code is 123456.",
      channel: "telegram",
      field: "message.text",
    })).toEqual({
      ok: true,
      text: "Your sign-in code is [REDACTED_AUTH_DIGITS].",
      markers: ["authentication_digits"],
    });
  });

  it("returns an ingestion failure instead of preserving invalid text", () => {
    for (const redactor of [toSid(), toSomeoneElse()]) {
      expect(redactor.redactText("\ud800")).toEqual({ ok: false, category: "ingest_redaction_failed" });
    }
  });

  it.each([
    "Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
    "Authorization: Bearer secret-token-value",
  ])("redacts an authorization header regardless of scheme", (input) => {
    const result = toSomeoneElse().redactText(input);

    expect(result).toMatchObject({
      ok: true,
      text: "[REDACTED_AUTHORIZATION]",
      markers: ["authorization"],
    });
    if (result.ok) expect(result.text).not.toContain("secret");
  });

  it.each(["api key = whitespace-secret", "api   key = whitespace-secret"])("redacts whitespace-separated API-key labels", (input) => {
    const result = toSomeoneElse().redactText(input);

    expect(result).toMatchObject({
      ok: true,
      text: "[REDACTED_CREDENTIAL]",
      markers: ["credential"],
    });
    if (result.ok) expect(result.text).not.toContain("whitespace-secret");
  });

  it("redacts an isolated eight-digit DTMF PIN", () => {
    const result = toSomeoneElse().redactText("PIN 12345678 is ready");

    expect(result).toEqual({
      ok: true,
      text: "PIN [REDACTED_AUTH_DIGITS] is ready",
      markers: ["authentication_digits"],
    });
    if (result.ok) expect(result.text).not.toContain("12345678");
  });

  it("redacts a contextual four-digit PIN in the production turn field while preserving a bare number and a year", () => {
    const redactor = toSomeoneElse();
    expect(redactor.redact({ text: "my pin is 4821", channel: "voice", field: "conversation.turn.text" }))
      .toEqual({ ok: true, text: "my pin is [REDACTED_AUTH_DIGITS]", markers: ["authentication_digits"] });
    expect(redactor.redact({ text: "4821", channel: "voice", field: "conversation.turn.text" }))
      .toEqual({ ok: true, text: "4821", markers: [] });
    expect(redactor.redact({ text: "Roadmap review in 2026", channel: "voice", field: "conversation.turn.text" }))
      .toEqual({ ok: true, text: "Roadmap review in 2026", markers: [] });
  });

  it.each([
    ["directly after the word", "pin 7305", "pin [REDACTED_AUTH_DIGITS]"],
    ["after a colon", "PIN: 7305", "PIN: [REDACTED_AUTH_DIGITS]"],
    ["after 'is'", "my passcode is 7305", "my passcode is [REDACTED_AUTH_DIGITS]"],
    ["with a year later in the sentence", "my pin is 7305, set in 2026", "my pin is [REDACTED_AUTH_DIGITS], set in 2026"],
  ])("redacts a four-digit PIN after a credential word on both channels: %s", (_label, text, expected) => {
    const redactor = toSomeoneElse();
    for (const channel of ["telegram", "voice"] as const) {
      expect(redactor.redact({ text, channel, field: "conversation.turn.text" }))
        .toEqual({ ok: true, text: expected, markers: ["authentication_digits"] });
    }
    expect(redactor.redactText(text)).toEqual({ ok: true, text: expected, markers: ["authentication_digits"] });
  });

  it.each([
    "The essay is due Oct 14, 2026.",
    "Room 2104 at 1430, and it costs 1500 dollars.",
    "I scored 1450 on the SAT.",
    "The pin is on the 2026 page of the binder.",
    "Tell me how to spin 2026 as a gap year.",
  ])("leaves a four-digit number alone when no credential word comes right before it: %s", (text) => {
    expect(toSomeoneElse().redact({ text, channel: "telegram", field: "conversation.turn.text" }))
      .toEqual({ ok: true, text, markers: [] });
    expect(toSomeoneElse().redactText(text)).toEqual({ ok: true, text, markers: [] });
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
    const result = toSomeoneElse().redactText(input);

    expect(result).toEqual({ ok: true, text, markers: [marker] });
    if (result.ok) expect(result.text).not.toContain(input);
  });

  it("redacts a complete private-key block", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----";
    const result = toSomeoneElse().redactText(`key follows:\n${privateKey}\nend`);

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
    const result = toSomeoneElse().redactText(`key follows:\n${privateKey}`);

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
    const result = toSomeoneElse().redact(input);

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
    for (const redactor of [toSid(), toSomeoneElse()]) {
      expect(redactor.redact({ text: input, channel: "telegram", field: "message.text" })).toEqual({
        ok: true,
        text: input,
        markers: [],
      });
    }
  });

  it("does not mint a typed marker for malformed sensitive-field text", () => {
    expect(toSomeoneElse().redact({ text: "\ud800", channel: "voice", field: "dtmf.digits" })).toEqual({
      ok: false,
      category: "ingest_redaction_failed",
    });
  });
});

import { describe, expect, it } from "vitest";
import * as callContracts from "../src/calls.js";
import * as publicContracts from "../src/index.js";
import {
  canonicalJson,
  createEnvelope,
  type Ulid,
  sha256Hex,
  validateEnvelope,
  type CreateEnvelopeInput,
} from "../src";
import { Redactor } from "../../../apps/cloud-gateway/src/security/redaction";

// The Redactor's default reader is `external` (a guest caller, an audit
// record); this helper defaults to Sid (`owner`) and names him explicitly.
// The envelope mechanism is audience-blind: it persists exactly the issued
// token it is handed.
function redacted(text: string, audience: "owner" | "external" = "owner") {
  const result = new Redactor(audience).redactText(text);
  if (!result.ok) throw new Error("test redaction failed");
  return result;
}

const initialRedaction = redacted("e\u0301");

const input: CreateEnvelopeInput = {
  schemaVersion: "1.0",
  eventId: "01j00000000000000000000000" as CreateEnvelopeInput["eventId"],
  eventType: "message.committed",
  source: "telegram",
  subjectId: "sid",
  occurredAt: "2026-08-29T00:00:00.000Z",
  receivedAt: "2026-08-29T00:00:00.000Z",
  correlationId: "01j00000000000000000000001" as CreateEnvelopeInput["correlationId"],
  contentType: "application/json",
  payload: initialRedaction,
  producerVersion: "0.1.0",
} as const;

describe("event envelopes", () => {
  it("creates a normalized envelope with a payload hash", async () => {
    const envelope = await createEnvelope(input);

    expect(envelope).toMatchObject({
      contentType: "application/json",
      payload: "é",
    });
    expect(envelope.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(validateEnvelope(envelope)).resolves.toEqual(envelope);
  });

  it("persists Sid's own sign-in code exactly as it arrived", async () => {
    const result = redacted("Your sign-in code is 123456.");

    const envelope = await createEnvelope({
      ...input,
      payload: { text: result, safeField: result },
    } as never);

    expect(envelope.payload).toEqual({ text: "Your sign-in code is 123456.", safeField: "Your sign-in code is 123456." });
    expect(envelope.redaction).toEqual({ status: "none", markers: [] });
  });

  it("constructs persisted text from the exact successful redaction result for someone who is not Sid", async () => {
    const result = redacted("Your sign-in code is 123456.", "external");

    const envelope = await createEnvelope({
      ...input,
      payload: { text: result, safeField: result },
    } as never);

    expect(envelope.payload).toEqual({ text: "Your sign-in code is [REDACTED_AUTH_DIGITS].", safeField: "Your sign-in code is [REDACTED_AUTH_DIGITS]." });
  });

  it("preserves a canonical ULID whose random component contains six digits", async () => {
    const identifier = "01abcde123456fghjkmnpqrstv" as Ulid;
    const structural = new Redactor().redact({
      text: identifier,
      channel: "telegram",
      field: "itemId",
    });

    const envelope = await createEnvelope({
      ...input,
      payload: { itemId: structural },
    } as never);

    expect(envelope.payload).toEqual({ itemId: identifier });
    expect(envelope.redaction).toEqual({ status: "none", markers: [] });
  });

  it("leaves a ULID inside Sid's own text alone", () => {
    expect(redacted("Reference 01abcde123456fghjkmnpqrstv is ordinary text.").text)
      .toBe("Reference 01abcde123456fghjkmnpqrstv is ordinary text.");
  });

  it("redacts six authentication digits for someone who is not Sid when a canonical ULID is only part of the text", () => {
    const result = redacted("Reference 01abcde123456fghjkmnpqrstv is not a structural field.", "external");

    expect(result.text).toBe(
      "Reference 01abcde[REDACTED_AUTH_DIGITS]fghjkmnpqrstv is not a structural field.",
    );
    expect(result.markers).toContain("authentication_digits");
  });

  it("redacts six authentication digits for someone who is not Sid when the whole text looks like a canonical ULID", () => {
    const result = redacted("01abcde123456fghjkmnpqrstv", "external");

    expect(result.text).toBe("01abcde[REDACTED_AUTH_DIGITS]fghjkmnpqrstv");
    expect(result.markers).toContain("authentication_digits");
  });

  it("does not export a structural ULID issuer from either contracts surface", () => {
    expect("issueRedactedUlid" in callContracts).toBe(false);
    expect("issueRedactedUlid" in publicContracts).toBe(false);
  });

  it("normalizes producer-controlled envelope headers", async () => {
    const result = redacted("safe text");
    const envelope = await createEnvelope({
      ...input,
      source: "te\u0301legram",
      payload: result,
    } as never);

    expect(envelope.source).toBe("télegram");
  });

  it("rejects a forged successful-redaction lookalike", async () => {
    await expect(createEnvelope({
      ...input,
      payload: { text: "unrelated" },
      redaction: { ok: true, text: "unrelated", markers: [] },
    } as never)).rejects.toThrow("redaction");
  });

  it("rejects the legacy separate payload/redaction association", async () => {
    const result = redacted("Your sign-in code is 123456.");

    await expect(createEnvelope({
      ...input,
      payload: { text: "Your sign-in code is 123456." },
      redaction: result,
    } as never)).rejects.toThrow();
  });

  it.each([
    ["an alternative top-level property", { alternative: "raw ingress" }],
    ["a nested property", { nested: { alternative: "raw ingress" } }],
    ["an array element", { values: ["raw ingress"] }],
  ])("rejects raw strings in %s", async (_label, payload) => {
    await expect(createEnvelope({ ...input, payload } as never)).rejects.toThrow("issued redaction token");
  });

  it("rejects a forged redaction token nested in the payload", async () => {
    await expect(createEnvelope({
      ...input,
      payload: { nested: { text: { ok: true, text: "forged", markers: [] } } },
    } as never)).rejects.toThrow("forged redaction token");
  });

  it("rejects producer-only additive fields", async () => {
    await expect(createEnvelope({
      ...input,
      producerBuild: redacted("ingress text"),
    } as never)).rejects.toThrow("unsupported producer field");
  });

  it("materializes a nested payload from multiple issued redactions and combines markers", async () => {
    const plain = redacted("plain text");
    const secret = redacted("Code 123456", "external");
    const envelope = await createEnvelope({
      ...input,
      payload: { title: plain, nested: [secret, { alternate: plain }] },
    } as never);

    expect(envelope.payload).toEqual({
      title: "plain text",
      nested: ["Code [REDACTED_AUTH_DIGITS]", { alternate: "plain text" }],
    });
    expect(envelope.redaction).toEqual({ status: "redacted", markers: ["authentication_digits"] });
    expect(canonicalJson(envelope.payload)).not.toContain("123456");
  });

  it("does not retain whitespace-separated API-key credentials in materialized payloads", async () => {
    const credential = redacted("api key = whitespace-secret", "external");
    const envelope = await createEnvelope({ ...input, payload: { credential } } as never);

    expect(envelope.payload).toEqual({ credential: "[REDACTED_CREDENTIAL]" });
    expect(canonicalJson(envelope.payload)).not.toContain("whitespace-secret");
  });

  it("does not retain newly recognized credential forms in a persistable envelope", async () => {
    const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    const privateKey = "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----";
    const envelope = await createEnvelope({
      ...input,
      payload: {
        bearer: redacted(bearer),
        pin: redacted("PIN 12345678", "external"),
        privateKey: redacted(privateKey),
      },
    } as never);
    const serialized = canonicalJson(envelope.payload);

    expect(envelope.payload).toEqual({
      bearer: "[REDACTED_AUTHORIZATION]",
      pin: "PIN [REDACTED_AUTH_DIGITS]",
      privateKey: "[REDACTED_CREDENTIAL]",
    });
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain("12345678");
    expect(serialized).not.toContain(privateKey);
  });

  it.each([
    ["a top-level authorization header", { "Authorization: Basic secret": redacted("safe") }],
    ["a top-level raw message", { "raw message 123456": redacted("safe") }],
    ["a nested authorization header", { nested: { "Authorization: Basic secret": redacted("safe") } }],
    ["a nested raw message", { nested: { "raw message 123456": redacted("safe") } }],
  ])("rejects %s as a producer payload key", async (_label, payload) => {
    await expect(createEnvelope({ ...input, payload } as never)).rejects.toThrow("payload key");
  });

  it("accepts camelCase and snake_case keys at nested payload levels", async () => {
    const safe = redacted("safe");
    await expect(createEnvelope({
      ...input,
      payload: { camelCase: safe, snake_case: { nestedKey: safe, nested_key: safe } },
    } as never)).resolves.toMatchObject({
      payload: { camelCase: "safe", snake_case: { nestedKey: "safe", nested_key: "safe" } },
    });
  });

  it("rejects unsafe payload keys in received envelopes even with a matching hash", async () => {
    const envelope = await createEnvelope(input);
    const payload = { "Authorization: Basic secret": "materialized text" };

    await expect(validateEnvelope({
      ...envelope,
      payload,
      contentHash: await sha256Hex(canonicalJson(payload)),
    })).rejects.toThrow("payload key");
  });

  it("rejects an envelope whose hash does not match its payload", async () => {
    const envelope = await createEnvelope(input);

    await expect(validateEnvelope({ ...envelope, payload: { text: "changed" } })).rejects.toThrow(
      "contentHash",
    );
  });

  it("rejects a payload that was not normalized before crossing the boundary", async () => {
    const envelope = await createEnvelope(input);

    await expect(validateEnvelope({ ...envelope, payload: { text: "e\u0301" } })).rejects.toThrow(
      "NFC-normalized",
    );
  });

  it.each([
    ["uppercase ULIDs", { eventId: "01J00000000000000000000000" }],
    ["malformed ULIDs", { correlationId: "not-a-ulid" }],
    ["timestamps without milliseconds", { occurredAt: "2026-08-29T00:00:00Z" }],
    ["non-UTC timestamps", { receivedAt: "2026-08-29T00:00:00.000+00:00" }],
    ["unsupported major versions", { schemaVersion: "2.0" }],
  ] as const)("rejects %s", async (_label, change) => {
    const envelope = await createEnvelope(input);
    await expect(validateEnvelope({ ...envelope, ...change })).rejects.toThrow();
  });

  it("tolerates documented additive fields", async () => {
    const envelope = await createEnvelope(input);

    await expect(validateEnvelope({ ...envelope, producerBuild: "abc123" })).resolves.toMatchObject({
      ...envelope,
      producerBuild: "abc123",
    });
  });

  it.each([
    ["a decomposed header", { source: "te\u0301legram" }],
    ["a decomposed redaction marker", { redaction: { status: "redacted", markers: ["e\u0301"] } }],
    ["a decomposed additive field", { producerBuild: "e\u0301" }],
  ] as const)("rejects %s anywhere in a received envelope", async (_label, change) => {
    const envelope = await createEnvelope(input);
    await expect(validateEnvelope({ ...envelope, ...change })).rejects.toThrow("NFC-normalized");
  });
});

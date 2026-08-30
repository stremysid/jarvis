import { describe, expect, it } from "vitest";
import { createEnvelope, validateEnvelope, type CreateEnvelopeInput } from "../src";
import { Redactor } from "../../../apps/cloud-gateway/src/security/redaction";

function redacted(text: string) {
  const result = new Redactor().redactText(text);
  if (!result.ok) throw new Error("test redaction failed");
  return result;
}

const initialRedaction = redacted("e\u0301");

const input: CreateEnvelopeInput<{ text: string }> = {
  schemaVersion: "1.0",
  eventId: "01j00000000000000000000000",
  eventType: "message.committed",
  source: "telegram",
  subjectId: "sid",
  occurredAt: "2026-08-29T00:00:00.000Z",
  receivedAt: "2026-08-29T00:00:00.000Z",
  correlationId: "01j00000000000000000000001",
  contentType: "application/json",
  payload: { text: initialRedaction.text },
  redaction: initialRedaction,
  producerVersion: "0.1.0",
} as const;

describe("event envelopes", () => {
  it("creates a normalized envelope with a payload hash", async () => {
    const envelope = await createEnvelope(input);

    expect(envelope).toMatchObject({
      contentType: "application/json",
      payload: { text: "é" },
    });
    expect(envelope.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(validateEnvelope(envelope)).resolves.toEqual(envelope);
  });

  it("constructs persisted text from the exact successful redaction result", async () => {
    const result = redacted("Your sign-in code is 123456.");

    const envelope = await createEnvelope({
      ...input,
      payload: { text: result.text, safeField: "kept" },
      redaction: result,
    } as never);

    expect(envelope.payload).toEqual({ text: "Your sign-in code is [REDACTED_AUTH_DIGITS].", safeField: "kept" });
  });

  it("normalizes producer-controlled envelope headers", async () => {
    const result = redacted("safe text");
    const envelope = await createEnvelope({
      ...input,
      source: "te\u0301legram",
      payload: { text: result.text },
      redaction: result,
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

  it("rejects raw text that does not match the successful redaction result", async () => {
    const result = redacted("Your sign-in code is 123456.");

    await expect(createEnvelope({
      ...input,
      payload: { text: "Your sign-in code is 123456." },
      redaction: result,
    } as never)).rejects.toThrow("payload.text");
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

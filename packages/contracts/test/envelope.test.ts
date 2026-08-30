import { describe, expect, it } from "vitest";
import { createEnvelope, validateEnvelope, type CreateEnvelopeInput } from "../src";

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
  payload: { text: "e\u0301" },
  redaction: { ok: true, text: "e\u0301", markers: [] },
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
});

import { gzipSync, gunzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, validateEnvelope } from "../../../../packages/contracts/src/index.js";
import type { AppendedEvent } from "../../src/persistence/event-repository.js";
import {
  ARCHIVE_SEGMENT_LIMITS,
  decodeArchiveSegment,
  encodeArchiveSegment,
  encodeLargestArchiveSegment,
} from "../../src/archive/segment-codec.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const goldenCompressedHash = "8a1551afcd573d0f87cbb96c9ea79a3d677b2f871862ba796536ce50fcee7108";

async function eventFixture(
  eventSequence: number,
  eventId: string,
  correlationId: string,
  attempt: number,
  payloadOverride?: unknown,
): Promise<AppendedEvent> {
  const payload = payloadOverride ?? { attempt, ok: true };
  const envelope = await validateEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventSequence,
    eventType: "telegram.update",
    source: "telegram",
    subjectId: "principal:test",
    occurredAt: "2026-08-29T12:00:00.000Z",
    receivedAt: "2026-08-29T12:00:00.000Z",
    correlationId,
    contentType: "application/json",
    contentHash: await sha256Hex(canonicalJson(payload)),
    payload,
    redaction: { status: "none", markers: [] },
    producerVersion: "test",
  });
  return { eventSequence, envelope, replayed: true };
}

async function goldenEvents(): Promise<readonly AppendedEvent[]> {
  return [
    await eventFixture(1, "01arz3ndektsv4rrffq69g5fav", "01arz3ndektsv4rrffq69g5fb0", 1),
    await eventFixture(2, "01arz3ndektsv4rrffq69g5fb1", "01arz3ndektsv4rrffq69g5fb2", 2),
  ];
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function testGzip(text: string, level: 1 | 9 = 9): Uint8Array {
  return gzipSync(textEncoder.encode(text), { level, mem: 8, mtime: 0 });
}

describe("archive segment codec", () => {
  it("keeps the canonical segment within a conservative multi-copy Worker memory budget", () => {
    expect(ARCHIVE_SEGMENT_LIMITS).toMatchObject({
      maxCompressedBytes: 16 * 1024 * 1024,
      maxUncompressedBytes: 8 * 1024 * 1024,
      maxEventCount: 1000,
    });
  });

  it("emits the frozen canonical gzip bytes and exact metadata line", async () => {
    const encoded = await encodeArchiveSegment(await goldenEvents());

    expect(encoded.compressedSha256).toBe(goldenCompressedHash);
    expect(encoded.uncompressedByteLength).toBe(1107);
    expect(encoded.compressedBytes).toHaveLength(438);
    expect([...encoded.compressedBytes.slice(0, 10)]).toEqual([31, 139, 8, 0, 0, 0, 0, 0, 2, 3]);
    const text = textDecoder.decode(gunzipSync(encoded.compressedBytes));
    expect(text.startsWith(
      '{"codec":"jarvis-gzip-ndjson-v1","endSequence":2,"eventCount":2,"schemaVersion":"1.0","startSequence":1}\n',
    )).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("\r");
  });

  it("round-trips only canonical contiguous sequenced envelopes", async () => {
    const events = await goldenEvents();
    const encoded = await encodeArchiveSegment(events);
    const decoded = await decodeArchiveSegment(encoded.compressedBytes, encoded.compressedSha256);

    expect(decoded.metadata).toEqual({
      schemaVersion: "1.0",
      codec: "jarvis-gzip-ndjson-v1",
      startSequence: 1,
      endSequence: 2,
      eventCount: 2,
    });
    expect(decoded.events).toEqual(events);
    await expect(encodeArchiveSegment([events[1]!, events[0]!])).rejects.toThrow("archive_sequence_noncontiguous");
  });

  it("hashes compressed bytes before attempting decompression", async () => {
    const invalidGzip = textEncoder.encode("not gzip");

    await expect(decodeArchiveSegment(invalidGzip, "0".repeat(64))).rejects.toThrow("archive_compressed_hash_mismatch");
  });

  it("enforces compressed, bounded-uncompressed, and event-count limits", async () => {
    const encoded = await encodeArchiveSegment(await goldenEvents());
    const padded = new Uint8Array(ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes + 1);

    await expect(decodeArchiveSegment(padded, await sha256Hex(padded))).rejects.toThrow("archive_compressed_limit");
    await expect(decodeArchiveSegment(encoded.compressedBytes, encoded.compressedSha256, {
      maxUncompressedBytes: encoded.uncompressedByteLength - 1,
    })).rejects.toThrow("archive_uncompressed_limit");
    await expect(decodeArchiveSegment(encoded.compressedBytes, encoded.compressedSha256, {
      maxEventCount: 1,
    })).rejects.toThrow("archive_event_count_limit");
  });

  it("selects the largest deterministic canonical prefix at exact byte-limit equality", async () => {
    const events = [
      await eventFixture(9, "01arz3ndektsv4rrffq69g5fc0", "01arz3ndektsv4rrffq69g5fc1", 9, { note: "雪" }),
      await eventFixture(10, "01arz3ndektsv4rrffq69g5fc2", "01arz3ndektsv4rrffq69g5fc3", 10, { note: "雪雪" }),
      await eventFixture(11, "01arz3ndektsv4rrffq69g5fc4", "01arz3ndektsv4rrffq69g5fc5", 11, { note: "雪雪雪" }),
      await eventFixture(12, "01arz3ndektsv4rrffq69g5fc6", "01arz3ndektsv4rrffq69g5fc7", 12, { note: "雪雪雪雪" }),
    ];
    const encodedPrefixes = await Promise.all(events.map((_, index) => encodeArchiveSegment(events.slice(0, index + 1))));
    const exactTwo = encodedPrefixes[1]!;
    const limits = {
      maxCompressedBytes: exactTwo.compressedBytes.byteLength,
      maxUncompressedBytes: exactTwo.uncompressedByteLength,
      maxEventCount: events.length,
    };
    const oracle = encodedPrefixes.filter((encoded) => (
      encoded.compressedBytes.byteLength <= limits.maxCompressedBytes
      && encoded.uncompressedByteLength <= limits.maxUncompressedBytes
    )).at(-1)!;

    const selected = await encodeLargestArchiveSegment(events, limits);
    const replay = await encodeLargestArchiveSegment(events, limits);

    expect(oracle.metadata.eventCount).toBe(2);
    expect(selected.metadata).toEqual({
      schemaVersion: "1.0",
      codec: "jarvis-gzip-ndjson-v1",
      startSequence: 9,
      endSequence: 10,
      eventCount: 2,
    });
    expect(selected.compressedBytes).toEqual(oracle.compressedBytes);
    expect(selected.uncompressedByteLength).toBe(limits.maxUncompressedBytes);
    expect(selected.compressedBytes).toHaveLength(limits.maxCompressedBytes);
    expect(replay.compressedBytes).toEqual(selected.compressedBytes);
  });

  it("caps prefix selection by event count and reports a single-event capacity failure", async () => {
    const events = await goldenEvents();
    const first = await encodeArchiveSegment(events.slice(0, 1));

    await expect(encodeLargestArchiveSegment(events, {
      maxEventCount: 1,
    })).resolves.toMatchObject({ metadata: { eventCount: 1, endSequence: 1 } });
    await expect(encodeLargestArchiveSegment(events, {
      maxUncompressedBytes: first.uncompressedByteLength - 1,
    })).rejects.toThrow("archive_segment_capacity");
  });

  it("rejects content-hash corruption inside otherwise valid canonical NDJSON", async () => {
    const encoded = await encodeArchiveSegment(await goldenEvents());
    const lines = textDecoder.decode(gunzipSync(encoded.compressedBytes)).split("\n");
    const corrupt = JSON.parse(lines[1]!) as Record<string, unknown>;
    corrupt.contentHash = "0".repeat(64);
    lines[1] = canonicalJson(corrupt);
    const bytes = testGzip(lines.join("\n"));

    await expect(decodeArchiveSegment(bytes, await sha256Hex(bytes))).rejects.toThrow("contentHash does not match payload");
  });

  it("rejects alternate gzip settings, a second member, and trailing material", async () => {
    const encoded = await encodeArchiveSegment(await goldenEvents());
    const plain = gunzipSync(encoded.compressedBytes);
    const alternate = gzipSync(plain, { level: 1, mem: 8, mtime: 0 });
    const concatenated = concatenate(encoded.compressedBytes, testGzip(""));
    const trailing = concatenate(encoded.compressedBytes, Uint8Array.of(0));

    await expect(decodeArchiveSegment(alternate, await sha256Hex(alternate))).rejects.toThrow("archive_noncanonical_encoding");
    await expect(decodeArchiveSegment(concatenated, await sha256Hex(concatenated))).rejects.toThrow("archive_gzip_member_count");
    await expect(decodeArchiveSegment(trailing, await sha256Hex(trailing))).rejects.toThrow("archive_noncanonical_encoding");
  });

  it("rejects BOM, CRLF, missing final LF, and non-exact metadata", async () => {
    const encoded = await encodeArchiveSegment(await goldenEvents());
    const canonical = textDecoder.decode(gunzipSync(encoded.compressedBytes));
    const variants = [
      `\uFEFF${canonical}`,
      canonical.replaceAll("\n", "\r\n"),
      canonical.slice(0, -1),
      canonical.replace('"eventCount":2', '"eventCount":2,"extra":true'),
    ];

    for (const variant of variants) {
      const bytes = testGzip(variant);
      await expect(decodeArchiveSegment(bytes, await sha256Hex(bytes))).rejects.toThrow("archive_ndjson_noncanonical");
    }
  });
});

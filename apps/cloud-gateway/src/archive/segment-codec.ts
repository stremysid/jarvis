import { Gunzip, gzipSync } from "fflate";
import { canonicalJson, sha256Hex, validateEnvelope, type EventEnvelope, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { AppendedEvent } from "../persistence/event-repository.js";

export const ARCHIVE_CODEC = "jarvis-gzip-ndjson-v1" as const;

export const ARCHIVE_SEGMENT_LIMITS = Object.freeze({
  maxCompressedBytes: 16 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxEventCount: 1000,
});

export interface ArchiveSegmentMetadata {
  schemaVersion: "1.0";
  codec: typeof ARCHIVE_CODEC;
  startSequence: number;
  endSequence: number;
  eventCount: number;
}

export interface EncodedArchiveSegment {
  metadata: ArchiveSegmentMetadata;
  compressedBytes: Uint8Array;
  compressedSha256: Sha256Hex;
  uncompressedByteLength: number;
}

export interface DecodedArchiveSegment {
  metadata: ArchiveSegmentMetadata;
  events: readonly AppendedEvent[];
  uncompressedByteLength: number;
}

type SegmentLimits = typeof ARCHIVE_SEGMENT_LIMITS;
type SegmentLimitOverrides = Partial<SegmentLimits>;

const sha256Pattern = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const emptyBytes = new Uint8Array();
const inflateInputChunkBytes = 16 * 1024;
const canonicalGzipHeader = [31, 139, 8, 0, 0, 0, 0, 0, 2, 3] as const;

function archiveError(code: string): Error {
  return new Error(code);
}

function limitsWith(overrides: SegmentLimitOverrides | undefined): SegmentLimits {
  const limits = { ...ARCHIVE_SEGMENT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  }
  return limits;
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw archiveError("archive_ndjson_noncanonical");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw archiveError("archive_ndjson_noncanonical");
  return value as Record<string, unknown>;
}

function parseCanonicalLine(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw archiveError("archive_ndjson_noncanonical");
  }
  const record = asRecord(parsed);
  if (canonicalJson(record) !== line) throw archiveError("archive_ndjson_noncanonical");
  return record;
}

function metadataFrom(record: Record<string, unknown>, eventLimit: number): ArchiveSegmentMetadata {
  requireExactKeys(record, ["schemaVersion", "codec", "startSequence", "endSequence", "eventCount"]);
  if (record.schemaVersion !== "1.0" || record.codec !== ARCHIVE_CODEC) throw archiveError("archive_ndjson_noncanonical");
  if (!isSequence(record.startSequence) || !isSequence(record.endSequence) || !isSequence(record.eventCount)) {
    throw archiveError("archive_metadata_invalid");
  }
  if (record.eventCount > eventLimit) throw archiveError("archive_event_count_limit");
  if (record.endSequence < record.startSequence || record.eventCount !== record.endSequence - record.startSequence + 1) {
    throw archiveError("archive_metadata_invalid");
  }
  return {
    schemaVersion: "1.0",
    codec: ARCHIVE_CODEC,
    startSequence: record.startSequence,
    endSequence: record.endSequence,
    eventCount: record.eventCount,
  };
}

function inflateBounded(compressedBytes: Uint8Array, maximumBytes: number): Uint8Array {
  if (compressedBytes.byteLength < 18) throw archiveError("archive_gzip_invalid");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let extraMember = false;
  const stream = new Gunzip((chunk) => {
    byteLength += chunk.byteLength;
    if (byteLength > maximumBytes) throw archiveError("archive_uncompressed_limit");
    chunks.push(chunk.slice());
  });
  stream.onmember = () => {
    extraMember = true;
    throw archiveError("archive_gzip_member_count");
  };
  try {
    for (let offset = 0; offset < compressedBytes.byteLength; offset += inflateInputChunkBytes) {
      stream.push(compressedBytes.subarray(offset, Math.min(offset + inflateInputChunkBytes, compressedBytes.byteLength)), false);
    }
    stream.push(emptyBytes, true);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("archive_")) throw error;
    throw archiveError("archive_gzip_invalid");
  }
  if (extraMember) throw archiveError("archive_gzip_member_count");
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function sequencedEnvelope(event: AppendedEvent): EventEnvelope {
  if (!isSequence(event.eventSequence)) throw archiveError("archive_sequence_noncontiguous");
  if (event.envelope.eventSequence !== undefined && event.envelope.eventSequence !== event.eventSequence) {
    throw archiveError("archive_sequence_noncontiguous");
  }
  return { ...event.envelope, eventSequence: event.eventSequence };
}

export async function encodeArchiveSegment(
  events: readonly AppendedEvent[],
  limitOverrides?: SegmentLimitOverrides,
): Promise<EncodedArchiveSegment> {
  const limits = limitsWith(limitOverrides);
  if (events.length === 0) throw archiveError("archive_segment_empty");
  if (events.length > limits.maxEventCount) throw archiveError("archive_event_count_limit");

  const lines: string[] = [];
  const firstSequence = events[0]!.eventSequence;
  if (!isSequence(firstSequence)) throw archiveError("archive_sequence_noncontiguous");
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.eventSequence !== firstSequence + index) throw archiveError("archive_sequence_noncontiguous");
    const envelope = sequencedEnvelope(event);
    await validateEnvelope(envelope);
    lines.push(canonicalJson(envelope));
  }

  const metadata: ArchiveSegmentMetadata = {
    schemaVersion: "1.0",
    codec: ARCHIVE_CODEC,
    startSequence: firstSequence,
    endSequence: firstSequence + events.length - 1,
    eventCount: events.length,
  };
  const uncompressedBytes = encoder.encode(`${canonicalJson(metadata)}\n${lines.join("\n")}\n`);
  if (uncompressedBytes.byteLength > limits.maxUncompressedBytes) throw archiveError("archive_uncompressed_limit");
  const compressedBytes = gzipSync(uncompressedBytes, { level: 9, mem: 8, mtime: 0 });
  if (compressedBytes.byteLength > limits.maxCompressedBytes) throw archiveError("archive_compressed_limit");
  return {
    metadata,
    compressedBytes,
    compressedSha256: await sha256Hex(compressedBytes),
    uncompressedByteLength: uncompressedBytes.byteLength,
  };
}

export async function decodeArchiveSegment(
  compressedBytes: Uint8Array,
  expectedCompressedSha256: string,
  limitOverrides?: SegmentLimitOverrides,
): Promise<DecodedArchiveSegment> {
  const limits = limitsWith(limitOverrides);
  if (compressedBytes.byteLength === 0 || compressedBytes.byteLength > limits.maxCompressedBytes) {
    throw archiveError("archive_compressed_limit");
  }
  if (!sha256Pattern.test(expectedCompressedSha256)) throw archiveError("archive_compressed_hash_invalid");
  if (await sha256Hex(compressedBytes) !== expectedCompressedSha256) throw archiveError("archive_compressed_hash_mismatch");
  if (canonicalGzipHeader.some((byte, index) => compressedBytes[index] !== byte)) {
    throw archiveError("archive_noncanonical_encoding");
  }

  const uncompressedBytes = inflateBounded(compressedBytes, limits.maxUncompressedBytes);
  let text: string;
  try {
    text = decoder.decode(uncompressedBytes);
  } catch {
    throw archiveError("archive_ndjson_noncanonical");
  }
  if (text.charCodeAt(0) === 0xfeff || text.includes("\r") || !text.endsWith("\n")) {
    throw archiveError("archive_ndjson_noncanonical");
  }
  const lines = text.split("\n");
  lines.pop();
  if (lines.length < 2 || lines.some((line) => line.length === 0)) throw archiveError("archive_ndjson_noncanonical");

  const metadata = metadataFrom(parseCanonicalLine(lines[0]!), limits.maxEventCount);
  if (lines.length !== metadata.eventCount + 1) throw archiveError("archive_event_count_mismatch");
  const events: AppendedEvent[] = [];
  const eventIds = new Set<string>();
  for (let index = 0; index < metadata.eventCount; index += 1) {
    const record = parseCanonicalLine(lines[index + 1]!);
    const envelope = await validateEnvelope(record);
    const expectedSequence = metadata.startSequence + index;
    if (envelope.eventSequence !== expectedSequence) throw archiveError("archive_sequence_noncontiguous");
    if (eventIds.has(envelope.eventId)) throw archiveError("archive_event_id_duplicate");
    eventIds.add(envelope.eventId);
    events.push({ eventSequence: expectedSequence, envelope, replayed: true });
  }
  if (events.at(-1)?.eventSequence !== metadata.endSequence) throw archiveError("archive_sequence_noncontiguous");

  const canonical = await encodeArchiveSegment(events, limits);
  if (!bytesEqual(canonical.compressedBytes, compressedBytes)) throw archiveError("archive_noncanonical_encoding");
  return { metadata, events, uncompressedByteLength: uncompressedBytes.byteLength };
}

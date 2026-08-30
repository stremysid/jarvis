import { Gunzip, gzipSync } from "fflate";
import { canonicalJson, sha256Hex, validateEnvelope, type EventEnvelope, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { AppendedEvent } from "../persistence/event-repository.js";

export const ARCHIVE_CODEC = "jarvis-gzip-ndjson-v1" as const;

export const ARCHIVE_SEGMENT_LIMITS = Object.freeze({
  maxCompressedBytes: 16 * 1024 * 1024,
  // Worker selection and verification retain several representations at once;
  // keep canonical input conservative under the 128 MiB isolate memory limit.
  maxUncompressedBytes: 8 * 1024 * 1024,
  // Seal uses three fixed D1 statements plus one coverage insert per event;
  // 24 leaves reconciliation and purge headroom under the 50-query free limit.
  maxEventCount: 24,
});

export interface ArchiveSegmentLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEventCount: number;
}

export type ArchiveSegmentLimitOverrides = Partial<ArchiveSegmentLimits>;

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

const sha256Pattern = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const emptyBytes = new Uint8Array();
const inflateInputChunkBytes = 16 * 1024;
const canonicalGzipHeader = [31, 139, 8, 0, 0, 0, 0, 0, 2, 3] as const;

function archiveError(code: string): Error {
  return new Error(code);
}

export function resolveArchiveSegmentLimits(
  overrides: ArchiveSegmentLimitOverrides | undefined,
): ArchiveSegmentLimits {
  const limits = { ...ARCHIVE_SEGMENT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    const maximum = ARCHIVE_SEGMENT_LIMITS[name as keyof ArchiveSegmentLimits];
    if (value > maximum) throw new RangeError(`${name} exceeds the archive safety maximum`);
  }
  return limits;
}

const limitsWith = resolveArchiveSegmentLimits;

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

interface PreparedEventLine {
  bytes: Uint8Array;
}

interface CompressedPreparedSegment {
  metadata: ArchiveSegmentMetadata;
  compressedBytes: Uint8Array;
  uncompressedByteLength: number;
}

function metadataFor(firstSequence: number, eventCount: number): ArchiveSegmentMetadata {
  return {
    schemaVersion: "1.0",
    codec: ARCHIVE_CODEC,
    startSequence: firstSequence,
    endSequence: firstSequence + eventCount - 1,
    eventCount,
  };
}

async function prepareEventLine(event: AppendedEvent, expectedSequence: number): Promise<PreparedEventLine> {
  if (event.eventSequence !== expectedSequence) throw archiveError("archive_sequence_noncontiguous");
  const envelope = sequencedEnvelope(event);
  await validateEnvelope(envelope);
  return { bytes: encoder.encode(canonicalJson(envelope)) };
}

function uncompressedLength(
  firstSequence: number,
  lines: readonly PreparedEventLine[],
  eventCount: number,
): number {
  const metadataBytes = encoder.encode(canonicalJson(metadataFor(firstSequence, eventCount)));
  let byteLength = metadataBytes.byteLength + 1;
  for (let index = 0; index < eventCount; index += 1) byteLength += lines[index]!.bytes.byteLength + 1;
  return byteLength;
}

function compressPrepared(
  firstSequence: number,
  lines: readonly PreparedEventLine[],
  eventCount: number,
): CompressedPreparedSegment {
  const metadata = metadataFor(firstSequence, eventCount);
  const metadataBytes = encoder.encode(canonicalJson(metadata));
  const byteLength = uncompressedLength(firstSequence, lines, eventCount);
  const uncompressedBytes = new Uint8Array(byteLength);
  let offset = 0;
  uncompressedBytes.set(metadataBytes, offset);
  offset += metadataBytes.byteLength;
  uncompressedBytes[offset] = 10;
  offset += 1;
  for (let index = 0; index < eventCount; index += 1) {
    const line = lines[index]!.bytes;
    uncompressedBytes.set(line, offset);
    offset += line.byteLength;
    uncompressedBytes[offset] = 10;
    offset += 1;
  }
  return {
    metadata,
    compressedBytes: gzipSync(uncompressedBytes, { level: 9, mem: 8, mtime: 0 }),
    uncompressedByteLength: byteLength,
  };
}

async function finalizeEncoded(segment: CompressedPreparedSegment): Promise<EncodedArchiveSegment> {
  return {
    ...segment,
    compressedSha256: await sha256Hex(segment.compressedBytes),
  };
}

export async function encodeArchiveSegment(
  events: readonly AppendedEvent[],
  limitOverrides?: ArchiveSegmentLimitOverrides,
): Promise<EncodedArchiveSegment> {
  const limits = limitsWith(limitOverrides);
  if (events.length === 0) throw archiveError("archive_segment_empty");
  if (events.length > limits.maxEventCount) throw archiveError("archive_event_count_limit");

  const firstSequence = events[0]!.eventSequence;
  if (!isSequence(firstSequence)) throw archiveError("archive_sequence_noncontiguous");
  const lines: PreparedEventLine[] = [];
  for (let index = 0; index < events.length; index += 1) {
    lines.push(await prepareEventLine(events[index]!, firstSequence + index));
  }
  if (uncompressedLength(firstSequence, lines, lines.length) > limits.maxUncompressedBytes) {
    throw archiveError("archive_uncompressed_limit");
  }
  const compressed = compressPrepared(firstSequence, lines, lines.length);
  if (compressed.compressedBytes.byteLength > limits.maxCompressedBytes) throw archiveError("archive_compressed_limit");
  return finalizeEncoded(compressed);
}

/** Returns the largest leading prefix whose final canonical bytes fit every limit. */
export async function encodeLargestArchiveSegment(
  events: readonly AppendedEvent[],
  limitOverrides?: ArchiveSegmentLimitOverrides,
): Promise<EncodedArchiveSegment> {
  const limits = limitsWith(limitOverrides);
  if (events.length === 0) throw archiveError("archive_segment_empty");
  const firstSequence = events[0]!.eventSequence;
  if (!isSequence(firstSequence)) throw archiveError("archive_sequence_noncontiguous");

  const lines: PreparedEventLine[] = [];
  const countLimit = Math.min(events.length, limits.maxEventCount);
  for (let index = 0; index < countLimit; index += 1) {
    const line = await prepareEventLine(events[index]!, firstSequence + index);
    lines.push(line);
    if (uncompressedLength(firstSequence, lines, lines.length) > limits.maxUncompressedBytes) {
      lines.pop();
      break;
    }
  }
  for (let eventCount = lines.length; eventCount > 0; eventCount -= 1) {
    const compressed = compressPrepared(firstSequence, lines, eventCount);
    if (compressed.compressedBytes.byteLength <= limits.maxCompressedBytes) {
      return finalizeEncoded(compressed);
    }
  }
  throw archiveError("archive_segment_capacity");
}

export async function decodeArchiveSegment(
  compressedBytes: Uint8Array,
  expectedCompressedSha256: string,
  limitOverrides?: ArchiveSegmentLimitOverrides,
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

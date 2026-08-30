import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { AppendedEvent } from "../persistence/event-repository.js";
import { ArchiveRepository, type ArchiveCandidate, type ArchiveManifest } from "./archive-repository.js";
import { decodeArchiveSegment, encodeArchiveSegment, type DecodedArchiveSegment } from "./segment-codec.js";

export type ArchiveBucket = Pick<R2Bucket, "get" | "put">;

export interface ArchivalServiceOptions {
  database: D1Database;
  bucket: ArchiveBucket;
}

const sha256Pattern = /^[a-f0-9]{64}$/;

function errorCode(error: unknown): string {
  if (error instanceof Error && /^archive_[a-z0-9_]+$/u.test(error.message)) return error.message;
  return "archive_operation_failed";
}

function requireReadRange(afterSequence: number, limit: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("afterSequence must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new RangeError("limit must be between 1 and 1000");
}

function requireNow(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError("archive_now_invalid");
  return now.toISOString();
}

function bytesFrom(body: R2ObjectBody): Promise<ArrayBuffer> {
  return body.arrayBuffer();
}

export class ArchivalService {
  private readonly repository: ArchiveRepository;

  constructor(private readonly options: ArchivalServiceOptions) {
    this.repository = new ArchiveRepository(options.database);
  }

  async archiveEligible(now: Date, maxEvents: number): Promise<ArchiveManifest | null> {
    const timestamp = requireNow(now);
    try {
      const candidate = await this.repository.selectEligible(now, maxEvents);
      if (candidate === null) return null;
      const encoded = await encodeArchiveSegment(candidate.events);
      const objectKey = `events/sha256/${encoded.compressedSha256}.ndjson.gz`;
      await this.options.bucket.put(objectKey, encoded.compressedBytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: encoded.compressedSha256,
      });
      await this.verifyObject(
        objectKey,
        encoded.compressedSha256,
        encoded.compressedBytes.byteLength,
        encoded.uncompressedByteLength,
        candidate,
      );
      const manifest = await this.repository.seal(candidate, encoded, objectKey, timestamp);
      await this.verifyManifest(manifest);
      const state = await this.repository.readState();
      if (state.circuitState !== "closed") throw new Error("archive_circuit_open");
      await this.repository.purgeDelivered(manifest, timestamp);
      return manifest;
    } catch (error) {
      if (errorCode(error) !== "archive_circuit_open") await this.repository.openCircuit(errorCode(error), timestamp);
      throw error;
    }
  }

  async readArchivedRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]> {
    requireReadRange(afterSequence, limit);
    const openedAt = new Date().toISOString();
    try {
      const state = await this.repository.readState();
      if (state.circuitState !== "closed") throw new Error("archive_circuit_open");
      if (afterSequence >= state.sealedThrough) return [];
      const expectedCount = Math.min(limit, state.sealedThrough - afterSequence);
      const manifests = await this.repository.listManifests(afterSequence, state.sealedThrough);
      const events: AppendedEvent[] = [];
      let expectedSequence = afterSequence + 1;
      for (const manifest of manifests) {
        const decoded = await this.verifyManifest(manifest);
        for (const event of decoded.events) {
          if (event.eventSequence < expectedSequence) continue;
          if (event.eventSequence !== expectedSequence) throw new Error("archive_range_gap");
          events.push(event);
          expectedSequence += 1;
          if (events.length === expectedCount) return events;
        }
      }
      throw new Error("archive_range_gap");
    } catch (error) {
      if (errorCode(error) !== "archive_circuit_open") await this.repository.openCircuit(errorCode(error), openedAt);
      throw error;
    }
  }

  private async verifyManifest(manifest: ArchiveManifest): Promise<DecodedArchiveSegment> {
    const decoded = await this.readAndDecode(
      manifest.objectKey,
      manifest.compressedSha256,
      manifest.compressedByteLength,
    );
    if (decoded.uncompressedByteLength !== manifest.uncompressedByteLength
      || decoded.metadata.startSequence !== manifest.startSequence
      || decoded.metadata.endSequence !== manifest.endSequence
      || decoded.metadata.eventCount !== manifest.eventCount) {
      throw new Error("archive_manifest_mismatch");
    }
    const coverage = await this.repository.readCoverage(manifest);
    if (coverage.length !== decoded.events.length) throw new Error("archive_coverage_mismatch");
    for (let index = 0; index < decoded.events.length; index += 1) {
      const event = decoded.events[index]!;
      const covered = coverage[index]!;
      if (covered.eventSequence !== event.eventSequence
        || covered.eventId !== event.envelope.eventId
        || covered.contentHash !== event.envelope.contentHash
        || covered.envelopeSha256 !== await sha256Hex(canonicalJson(event.envelope))) {
        throw new Error("archive_coverage_mismatch");
      }
    }
    return decoded;
  }

  private async verifyObject(
    objectKey: string,
    compressedSha256: string,
    compressedByteLength: number,
    uncompressedByteLength: number,
    candidate: ArchiveCandidate,
  ): Promise<void> {
    const decoded = await this.readAndDecode(objectKey, compressedSha256, compressedByteLength);
    if (decoded.uncompressedByteLength !== uncompressedByteLength
      || decoded.metadata.startSequence !== candidate.events[0]?.eventSequence
      || decoded.metadata.endSequence !== candidate.events.at(-1)?.eventSequence
      || decoded.events.length !== candidate.events.length) {
      throw new Error("archive_readback_mismatch");
    }
    for (let index = 0; index < candidate.events.length; index += 1) {
      const expected = candidate.events[index]!;
      const actual = decoded.events[index]!;
      if (actual.eventSequence !== expected.eventSequence
        || canonicalJson(actual.envelope) !== canonicalJson(expected.envelope)) {
        throw new Error("archive_readback_mismatch");
      }
    }
  }

  private async readAndDecode(
    objectKey: string,
    compressedSha256: string,
    compressedByteLength: number,
  ): Promise<DecodedArchiveSegment> {
    if (!sha256Pattern.test(compressedSha256)) throw new Error("archive_manifest_hash_invalid");
    const object = await this.options.bucket.get(objectKey);
    if (object === null || !("body" in object)) throw new Error("archive_object_unavailable");
    if (object.size !== compressedByteLength) {
      const bytes = new Uint8Array(await bytesFrom(object));
      await decodeArchiveSegment(bytes, compressedSha256);
      throw new Error("archive_object_size_mismatch");
    }
    return decodeArchiveSegment(new Uint8Array(await bytesFrom(object)), compressedSha256);
  }
}

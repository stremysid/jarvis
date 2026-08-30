import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { AppendedEvent } from "../persistence/event-repository.js";
import {
  ArchiveRepository,
  type ArchiveCandidate,
  type ArchiveCoverage,
  type ArchiveManifest,
  type ArchiveState,
} from "./archive-repository.js";
import {
  ARCHIVE_SEGMENT_LIMITS,
  decodeArchiveSegment,
  encodeLargestArchiveSegment,
  resolveArchiveSegmentLimits,
  type ArchiveSegmentLimitOverrides,
  type ArchiveSegmentLimits,
  type DecodedArchiveSegment,
} from "./segment-codec.js";

export type ArchiveBucket = Pick<R2Bucket, "get" | "put">;

export interface ArchivalServiceOptions {
  database: D1Database;
  bucket: ArchiveBucket;
  segmentLimits?: ArchiveSegmentLimitOverrides;
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const maximumArchiveRequestEvents = 1000;
// Matches the Sync material cap: two full physical segments bound decoded
// envelopes and response copies conservatively within a 128 MiB isolate.
const maximumArchivedReadEvents = 48;

type ArchivePhase = "reconciliation" | "selection" | "encoding" | "publication" | "readback" | "seal" | "post_seal" | "purge";

const candidateIntegrityFailures = new Set([
  "archive_state_invalid",
  "archive_sequence_gap",
  "archive_created_at_invalid",
  "archive_outbox_missing",
  "archive_envelope_json_invalid",
  "archive_envelope_invalid",
  "archive_event_id_mismatch",
  "archive_content_hash_mismatch",
  "archive_sequence_mismatch",
]);

class ArchiveOperationalError extends Error {}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^archive_[a-z0-9_]+$/u.test(error.message)) return error.message;
  return "archive_operation_failed";
}

function shouldLatchArchiveFailure(phase: ArchivePhase, error: unknown): boolean {
  const code = errorCode(error);
  if (code === "archive_circuit_open" || code === "archive_segment_capacity"
    || code === "archive_reconciliation_unstable") return false;
  if (phase === "reconciliation" || phase === "post_seal") return !(error instanceof ArchiveOperationalError);
  if (phase === "selection") return candidateIntegrityFailures.has(code);
  if (phase === "encoding") return code !== "archive_operation_failed";
  if (phase === "publication") return false;
  if (phase === "readback") return !(error instanceof ArchiveOperationalError);
  return true;
}

function shouldLatchArchivedReadFailure(error: unknown): boolean {
  return errorCode(error) !== "archive_circuit_open" && !(error instanceof ArchiveOperationalError);
}

function requireReadRange(afterSequence: number, limit: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("afterSequence must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumArchivedReadEvents) {
    throw new RangeError("limit must be between 1 and 48");
  }
}

function requireNow(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError("archive_now_invalid");
  return now.toISOString();
}

function requireArchiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximumArchiveRequestEvents) {
    throw new RangeError("archive_limit_invalid");
  }
}

function boundedTerminal(afterSequence: number, limit: number): number {
  return afterSequence > Number.MAX_SAFE_INTEGER - limit
    ? Number.MAX_SAFE_INTEGER
    : afterSequence + limit;
}

function bytesFrom(body: R2ObjectBody): Promise<ArrayBuffer> {
  return body.arrayBuffer();
}

export class ArchivalService {
  private readonly repository: ArchiveRepository;
  private readonly segmentLimits: ArchiveSegmentLimits;

  constructor(private readonly options: ArchivalServiceOptions) {
    this.repository = new ArchiveRepository(options.database);
    this.segmentLimits = resolveArchiveSegmentLimits(options.segmentLimits);
  }

  async archiveEligible(now: Date, maxEvents: number): Promise<ArchiveManifest | null> {
    const timestamp = requireNow(now);
    requireArchiveLimit(maxEvents);
    let phase: ArchivePhase = "reconciliation";
    try {
      const reconciledThrough = await this.reconcileSealedTail(timestamp);
      await this.reconcileOneOlderDeliveredManifest(reconciledThrough, timestamp);
      phase = "selection";
      const candidate = await this.repository.selectEligible(
        now,
        Math.min(maxEvents, this.segmentLimits.maxEventCount),
        this.segmentLimits.maxUncompressedBytes,
      );
      if (candidate === null) return null;
      if (candidate.sealedThrough !== reconciledThrough) throw new Error("archive_reconciliation_unstable");
      phase = "encoding";
      const encoded = await encodeLargestArchiveSegment(candidate.events, this.segmentLimits);
      const selectedCandidate: ArchiveCandidate = {
        sealedThrough: candidate.sealedThrough,
        events: candidate.events.slice(0, encoded.metadata.eventCount),
      };
      const objectKey = `events/sha256/${encoded.compressedSha256}.ndjson.gz`;
      phase = "publication";
      await this.options.bucket.put(objectKey, encoded.compressedBytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: encoded.compressedSha256,
      });
      phase = "readback";
      await this.verifyObject(
        objectKey,
        encoded.compressedSha256,
        encoded.compressedBytes.byteLength,
        encoded.uncompressedByteLength,
        selectedCandidate,
      );
      phase = "seal";
      const manifest = await this.repository.seal(selectedCandidate, encoded, objectKey, timestamp);
      phase = "post_seal";
      await this.verifyManifest(manifest);
      const state = await this.readArchiveState();
      if (state.circuitState !== "closed") throw new Error("archive_circuit_open");
      phase = "purge";
      await this.repository.purgeDelivered(manifest, timestamp);
      return manifest;
    } catch (error) {
      if (shouldLatchArchiveFailure(phase, error)) {
        await this.repository.openCircuit(errorCode(error), timestamp);
      }
      throw error;
    }
  }

  private async reconcileSealedTail(purgedAt: string): Promise<number> {
    const before = await this.readArchiveState();
    if (before.circuitState !== "closed") throw new Error("archive_circuit_open");
    if (before.sealedThrough === 0) return 0;

    let manifest: ArchiveManifest | null;
    try {
      manifest = await this.repository.findManifestEndingAt(before.sealedThrough);
    } catch {
      throw new ArchiveOperationalError("archive_tail_manifest_read_failed");
    }
    if (manifest === null) throw new Error("archive_tail_manifest_missing");
    await this.verifyManifest(manifest);

    const verified = await this.readArchiveState();
    if (verified.circuitState !== "closed") throw new Error("archive_circuit_open");
    if (verified.sealedThrough < before.sealedThrough) throw new Error("archive_state_invalid");
    if (verified.sealedThrough !== before.sealedThrough) throw new Error("archive_reconciliation_unstable");

    await this.repository.purgeDelivered(manifest, purgedAt);
    const purged = await this.readArchiveState();
    if (purged.circuitState !== "closed") throw new Error("archive_circuit_open");
    if (purged.sealedThrough < before.sealedThrough) throw new Error("archive_state_invalid");
    if (purged.sealedThrough !== before.sealedThrough) throw new Error("archive_reconciliation_unstable");
    return before.sealedThrough;
  }

  private async reconcileOneOlderDeliveredManifest(sealedThrough: number, purgedAt: string): Promise<void> {
    // One older object per invocation keeps the worst-case reconciliation/seal
    // race at 49 D1 statements plus one extra R2 read, leaving one circuit-write
    // statement of headroom. Pending/failed rows remain for delivery policy.
    if (sealedThrough <= 1) return;
    let manifest: ArchiveManifest | null;
    try {
      manifest = await this.repository.findOldestManifestWithDeliveredEventsBefore(sealedThrough);
    } catch {
      throw new ArchiveOperationalError("archive_older_manifest_read_failed");
    }
    if (manifest === null) return;

    await this.verifyManifest(manifest);
    await this.repository.purgeDelivered(manifest, purgedAt);
    const purged = await this.readArchiveState();
    if (purged.circuitState !== "closed") throw new Error("archive_circuit_open");
    if (purged.sealedThrough < sealedThrough) throw new Error("archive_state_invalid");
    if (purged.sealedThrough !== sealedThrough) throw new Error("archive_reconciliation_unstable");
  }

  private async readArchiveState(): Promise<ArchiveState> {
    try {
      return await this.repository.readState();
    } catch (error) {
      if (errorCode(error) === "archive_state_invalid") throw error;
      throw new ArchiveOperationalError("archive_state_read_failed");
    }
  }

  async readArchivedRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]> {
    requireReadRange(afterSequence, limit);
    const openedAt = new Date().toISOString();
    try {
      let state: ArchiveState;
      try {
        state = await this.repository.readState();
      } catch (error) {
        if (errorCode(error) === "archive_state_invalid") throw error;
        throw new ArchiveOperationalError("archive_state_read_failed");
      }
      if (state.circuitState !== "closed") throw new Error("archive_circuit_open");
      if (afterSequence >= state.sealedThrough) return [];
      const terminalSequence = Math.min(state.sealedThrough, boundedTerminal(afterSequence, limit));
      const expectedCount = terminalSequence - afterSequence;
      let manifests: readonly ArchiveManifest[];
      try {
        manifests = await this.repository.listManifests(afterSequence, terminalSequence, expectedCount);
      } catch {
        throw new ArchiveOperationalError("archive_manifest_list_failed");
      }
      let coverage: readonly ArchiveCoverage[];
      try {
        coverage = await this.repository.readCoverageRange(afterSequence, terminalSequence, expectedCount);
      } catch {
        throw new ArchiveOperationalError("archive_coverage_read_failed");
      }
      if (coverage.length !== expectedCount) throw new Error("archive_coverage_mismatch");
      const events: AppendedEvent[] = [];
      let expectedSequence = afterSequence + 1;
      for (const manifest of manifests) {
        const decoded = await this.verifyManifestObject(manifest);
        for (const event of decoded.events) {
          if (event.eventSequence < expectedSequence) continue;
          if (event.eventSequence !== expectedSequence) throw new Error("archive_range_gap");
          await this.verifyEventCoverage(event, coverage[events.length]);
          events.push(event);
          expectedSequence += 1;
          if (events.length === expectedCount) return events;
        }
      }
      throw new Error("archive_range_gap");
    } catch (error) {
      if (shouldLatchArchivedReadFailure(error)) await this.repository.openCircuit(errorCode(error), openedAt);
      throw error;
    }
  }

  private async verifyManifest(manifest: ArchiveManifest): Promise<DecodedArchiveSegment> {
    const decoded = await this.verifyManifestObject(manifest);
    let coverage: readonly ArchiveCoverage[];
    try {
      coverage = await this.repository.readCoverage(manifest);
    } catch {
      throw new ArchiveOperationalError("archive_coverage_read_failed");
    }
    await this.verifyCoverage(decoded.events, coverage);
    return decoded;
  }

  private async verifyManifestObject(manifest: ArchiveManifest): Promise<DecodedArchiveSegment> {
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
    return decoded;
  }

  private async verifyCoverage(
    events: readonly AppendedEvent[],
    coverage: readonly ArchiveCoverage[],
  ): Promise<void> {
    if (coverage.length !== events.length) throw new Error("archive_coverage_mismatch");
    for (let index = 0; index < events.length; index += 1) {
      await this.verifyEventCoverage(events[index]!, coverage[index]);
    }
  }

  private async verifyEventCoverage(event: AppendedEvent, covered: ArchiveCoverage | undefined): Promise<void> {
    if (covered === undefined
      || covered.eventSequence !== event.eventSequence
      || covered.eventId !== event.envelope.eventId
      || covered.contentHash !== event.envelope.contentHash
      || covered.envelopeSha256 !== await sha256Hex(canonicalJson(event.envelope))) {
      throw new Error("archive_coverage_mismatch");
    }
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
    if (!Number.isSafeInteger(compressedByteLength) || compressedByteLength <= 0) {
      throw new Error("archive_manifest_size_invalid");
    }
    if (compressedByteLength > ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes) {
      throw new Error("archive_compressed_limit");
    }
    let object: R2ObjectBody | null;
    try {
      object = await this.options.bucket.get(objectKey);
    } catch {
      throw new ArchiveOperationalError("archive_object_read_failed");
    }
    if (object === null || !("body" in object)) throw new Error("archive_object_unavailable");
    if (!Number.isSafeInteger(object.size) || object.size < 0) {
      throw new Error("archive_object_size_invalid");
    }
    if (object.size !== compressedByteLength) throw new Error("archive_object_size_mismatch");
    if (object.size > ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes) throw new Error("archive_compressed_limit");
    let bytes: ArrayBuffer;
    try {
      bytes = await bytesFrom(object);
    } catch {
      throw new ArchiveOperationalError("archive_object_body_read_failed");
    }
    return decodeArchiveSegment(new Uint8Array(bytes), compressedSha256);
  }
}

import {
  canonicalJson,
  sha256Hex,
  validateEnvelope,
  type EventEnvelope,
} from "../../../../packages/contracts/src/index.js";
import type { AppendedEvent } from "../persistence/event-repository.js";
import { TransactionRunner } from "../persistence/transaction.js";
import { ARCHIVE_CODEC, ARCHIVE_SEGMENT_LIMITS, type EncodedArchiveSegment } from "./segment-codec.js";

export interface ArchiveState {
  sealedThrough: number;
  circuitState: "closed" | "open";
  circuitReason: string | null;
  circuitOpenedAt: string | null;
}

export interface ArchiveCandidate {
  sealedThrough: number;
  events: readonly AppendedEvent[];
}

export interface ArchiveManifest {
  manifestId: string;
  startSequence: number;
  endSequence: number;
  eventCount: number;
  objectKey: string;
  compressedSha256: string;
  compressedByteLength: number;
  uncompressedByteLength: number;
  sealedAt: string;
}

export interface ArchiveCoverage {
  eventSequence: number;
  eventId: string;
  envelopeSha256: string;
  contentHash: string;
}

interface StoredState {
  sealed_through: number;
  circuit_state: "closed" | "open";
  circuit_reason: string | null;
  circuit_opened_at: string | null;
}

interface StoredCandidate {
  sequence: number;
  event_id: string;
  envelope_json: string;
  content_hash: string;
  created_at: string;
  outbox_id: string | null;
  outbox_status: "pending" | "delivered" | "failed" | null;
}

interface StoredManifest {
  manifest_id: string;
  start_sequence: number;
  end_sequence: number;
  event_count: number;
  object_key: string;
  compressed_sha256: string;
  compressed_byte_length: number;
  uncompressed_byte_length: number;
  sealed_at: string;
}

interface StoredCoverage {
  event_sequence: number;
  event_id: string;
  envelope_sha256: string;
  content_hash: string;
}

const retentionMilliseconds = 90 * 24 * 60 * 60 * 1000;
const safeCircuitReason = /^archive_[a-z0-9_]{1,120}$/;
const archiveSelectionPageSize = 32;
const maximumSelectionAttempts = 3;
const utf8Encoder = new TextEncoder();

function requireNow(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("archive_now_invalid");
  return milliseconds;
}

function requireLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1000) throw new RangeError("archive_limit_invalid");
}

function requireByteBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ARCHIVE_SEGMENT_LIMITS.maxUncompressedBytes) {
    throw new RangeError("archive_byte_budget_invalid");
  }
}

function requireManifestRange(afterSequence: number, throughSequence: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
    || !Number.isSafeInteger(throughSequence) || throughSequence < afterSequence) {
    throw new RangeError("archive_manifest_range_invalid");
  }
}

function requireManifestLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1000) {
    throw new RangeError("archive_manifest_limit_invalid");
  }
}

function boundedManifestEnd(throughSequence: number): number {
  const maximumOverlap = ARCHIVE_SEGMENT_LIMITS.maxEventCount - 1;
  return throughSequence > Number.MAX_SAFE_INTEGER - maximumOverlap
    ? Number.MAX_SAFE_INTEGER
    : throughSequence + maximumOverlap;
}

function toManifest(row: StoredManifest): ArchiveManifest {
  return {
    manifestId: row.manifest_id,
    startSequence: row.start_sequence,
    endSequence: row.end_sequence,
    eventCount: row.event_count,
    objectKey: row.object_key,
    compressedSha256: row.compressed_sha256,
    compressedByteLength: row.compressed_byte_length,
    uncompressedByteLength: row.uncompressed_byte_length,
    sealedAt: row.sealed_at,
  };
}

function toCoverage(row: StoredCoverage): ArchiveCoverage {
  return {
    eventSequence: row.event_sequence,
    eventId: row.event_id,
    envelopeSha256: row.envelope_sha256,
    contentHash: row.content_hash,
  };
}

async function toEvent(row: StoredCandidate): Promise<AppendedEvent> {
  let raw: unknown;
  try {
    raw = JSON.parse(row.envelope_json) as unknown;
  } catch {
    throw new Error("archive_envelope_json_invalid");
  }
  let envelope: EventEnvelope;
  try {
    envelope = await validateEnvelope(raw);
  } catch {
    throw new Error("archive_envelope_invalid");
  }
  if (envelope.eventId !== row.event_id) throw new Error("archive_event_id_mismatch");
  if (envelope.contentHash !== row.content_hash) throw new Error("archive_content_hash_mismatch");
  if (envelope.eventSequence !== undefined && envelope.eventSequence !== row.sequence) {
    throw new Error("archive_sequence_mismatch");
  }
  return { eventSequence: row.sequence, envelope: { ...envelope, eventSequence: row.sequence }, replayed: true };
}

export class ArchiveRepository {
  private readonly transactions: TransactionRunner;

  constructor(private readonly database: D1Database) {
    this.transactions = new TransactionRunner(database);
  }

  async readState(): Promise<ArchiveState> {
    const row = await this.database.prepare(
      "SELECT sealed_through, circuit_state, circuit_reason, circuit_opened_at FROM archive_state WHERE singleton = 1",
    ).first<StoredState>();
    if (row === null || !Number.isSafeInteger(row.sealed_through) || row.sealed_through < 0) {
      throw new Error("archive_state_invalid");
    }
    return {
      sealedThrough: row.sealed_through,
      circuitState: row.circuit_state,
      circuitReason: row.circuit_reason,
      circuitOpenedAt: row.circuit_opened_at,
    };
  }

  async selectEligible(now: Date, maxEvents: number, maxEnvelopeBytes: number): Promise<ArchiveCandidate | null> {
    requireLimit(maxEvents);
    requireByteBudget(maxEnvelopeBytes);
    const cutoff = requireNow(now) - retentionMilliseconds;
    selectionAttempts: for (let attempt = 0; attempt < maximumSelectionAttempts; attempt += 1) {
      const state = await this.readState();
      if (state.circuitState !== "closed") throw new Error("archive_circuit_open");
      if (state.sealedThrough === Number.MAX_SAFE_INTEGER) return null;
      const expected = state.sealedThrough + 1;
      const selected: AppendedEvent[] = [];
      let selectedEnvelopeBytes = 0;
      let nextSequence = expected;
      while (selected.length < maxEvents) {
        const pageLimit = Math.min(archiveSelectionPageSize, maxEvents - selected.length);
        const rows = await this.database.prepare(
          `SELECT e.sequence, e.event_id, e.envelope_json, e.content_hash, e.created_at,
                  o.outbox_id, o.status AS outbox_status
           FROM events e
           LEFT JOIN outbox o ON o.event_sequence = e.sequence
           WHERE e.sequence >= ?
           ORDER BY e.sequence ASC
           LIMIT ?`,
        ).bind(nextSequence, pageLimit).all<StoredCandidate>();
        if (rows.results.length === 0) {
          if (await this.selectionStateAdvanced(state.sealedThrough)) continue selectionAttempts;
          break;
        }

        for (const row of rows.results) {
          if (row.sequence !== nextSequence) {
            if (await this.selectionStateAdvanced(state.sealedThrough)) continue selectionAttempts;
            throw new Error("archive_sequence_gap");
          }
          const createdAt = Date.parse(row.created_at);
          if (!Number.isFinite(createdAt)) throw new Error("archive_created_at_invalid");
          if (createdAt > cutoff) return selected.length === 0 ? null : { sealedThrough: state.sealedThrough, events: selected };

          const envelopeBytes = utf8Encoder.encode(row.envelope_json).byteLength + 1;
          if (selected.length > 0 && selectedEnvelopeBytes + envelopeBytes > maxEnvelopeBytes) {
            return { sealedThrough: state.sealedThrough, events: selected };
          }
          if (row.outbox_id === null || row.outbox_status === null) throw new Error("archive_outbox_missing");
          selected.push(await toEvent(row));
          selectedEnvelopeBytes += envelopeBytes;
          nextSequence += 1;
          if (selected.length === maxEvents || selectedEnvelopeBytes >= maxEnvelopeBytes) {
            return { sealedThrough: state.sealedThrough, events: selected };
          }
        }
        if (rows.results.length < pageLimit) break;
      }
      return selected.length === 0 ? null : { sealedThrough: state.sealedThrough, events: selected };
    }
    throw new Error("archive_selection_unstable");
  }

  private async selectionStateAdvanced(previousSealedThrough: number): Promise<boolean> {
    const state = await this.readState();
    if (state.circuitState !== "closed") throw new Error("archive_circuit_open");
    if (state.sealedThrough < previousSealedThrough) throw new Error("archive_state_invalid");
    return state.sealedThrough > previousSealedThrough;
  }

  async seal(
    candidate: ArchiveCandidate,
    encoded: EncodedArchiveSegment,
    objectKey: string,
    sealedAt: string,
  ): Promise<ArchiveManifest> {
    if (candidate.events.length > ARCHIVE_SEGMENT_LIMITS.maxEventCount
      || encoded.metadata.eventCount > ARCHIVE_SEGMENT_LIMITS.maxEventCount) {
      throw new Error("archive_event_count_limit");
    }
    const manifest: ArchiveManifest = {
      manifestId: encoded.compressedSha256,
      startSequence: encoded.metadata.startSequence,
      endSequence: encoded.metadata.endSequence,
      eventCount: encoded.metadata.eventCount,
      objectKey,
      compressedSha256: encoded.compressedSha256,
      compressedByteLength: encoded.compressedBytes.byteLength,
      uncompressedByteLength: encoded.uncompressedByteLength,
      sealedAt,
    };
    if (candidate.sealedThrough + 1 !== manifest.startSequence || candidate.events.length !== manifest.eventCount) {
      throw new Error("archive_candidate_changed");
    }

    const statements: D1PreparedStatement[] = [
      this.database.prepare(
        "INSERT INTO archive_manifests (manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at) VALUES (?, ?, ?, ?, 'sealed', ?, ?)",
      ).bind(manifest.manifestId, manifest.startSequence, manifest.endSequence, manifest.eventCount, sealedAt, sealedAt),
      this.database.prepare(
        "INSERT INTO archive_segments (segment_id, manifest_id, object_key, compressed_sha256, compressed_byte_length, uncompressed_byte_length, codec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        manifest.compressedSha256,
        manifest.manifestId,
        manifest.objectKey,
        manifest.compressedSha256,
        manifest.compressedByteLength,
        manifest.uncompressedByteLength,
        ARCHIVE_CODEC,
        sealedAt,
      ),
    ];
    for (const event of candidate.events) {
      statements.push(this.database.prepare(
        "INSERT INTO archive_segment_events (event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        event.eventSequence,
        event.envelope.eventId,
        manifest.compressedSha256,
        await sha256Hex(canonicalJson(event.envelope)),
        event.envelope.contentHash,
        sealedAt,
      ));
    }
    statements.push(this.database.prepare(
      "UPDATE archive_state SET sealed_through = ?, updated_at = ? WHERE singleton = 1 AND sealed_through = ? AND circuit_state = 'closed'",
    ).bind(manifest.endSequence, sealedAt, candidate.sealedThrough));

    try {
      await this.transactions.batch(statements);
      return manifest;
    } catch (error) {
      const winner = await this.findManifestStartingAt(manifest.startSequence);
      if (winner !== null) return winner;
      throw error;
    }
  }

  async findManifestStartingAt(startSequence: number): Promise<ArchiveManifest | null> {
    const row = await this.database.prepare(
      `SELECT m.manifest_id, m.start_sequence, m.end_sequence, m.event_count, m.sealed_at,
              s.object_key, s.compressed_sha256, s.compressed_byte_length, s.uncompressed_byte_length
       FROM archive_manifests m
       JOIN archive_segments s ON s.manifest_id = m.manifest_id
       WHERE m.start_sequence = ? AND m.status = 'sealed'`,
    ).bind(startSequence).first<StoredManifest>();
    return row === null ? null : toManifest(row);
  }

  async findManifestEndingAt(endSequence: number): Promise<ArchiveManifest | null> {
    if (!Number.isSafeInteger(endSequence) || endSequence <= 0) {
      throw new RangeError("archive_manifest_range_invalid");
    }
    const row = await this.database.prepare(
      `SELECT m.manifest_id, m.start_sequence, m.end_sequence, m.event_count, m.sealed_at,
              s.object_key, s.compressed_sha256, s.compressed_byte_length, s.uncompressed_byte_length
       FROM archive_manifests m INDEXED BY archive_manifests_overlap_seek_idx
       JOIN archive_segments s ON s.manifest_id = m.manifest_id
       WHERE m.end_sequence = ? AND m.status = 'sealed'`,
    ).bind(endSequence).first<StoredManifest>();
    return row === null ? null : toManifest(row);
  }

  async findOldestManifestWithDeliveredEventsBefore(endSequence: number): Promise<ArchiveManifest | null> {
    if (!Number.isSafeInteger(endSequence) || endSequence <= 0) {
      throw new RangeError("archive_manifest_range_invalid");
    }
    const row = await this.database.prepare(
      `SELECT m.manifest_id, m.start_sequence, m.end_sequence, m.event_count, m.sealed_at,
              s.object_key, s.compressed_sha256, s.compressed_byte_length, s.uncompressed_byte_length
       FROM outbox o INDEXED BY outbox_archive_reconcile_idx
       JOIN archive_segment_events e ON e.event_sequence = o.event_sequence
       JOIN archive_segments s ON s.segment_id = e.segment_id
       JOIN archive_manifests m ON m.manifest_id = s.manifest_id
       WHERE o.status = 'delivered' AND o.event_sequence < ?
         AND m.end_sequence < ? AND m.status = 'sealed'
       ORDER BY o.event_sequence ASC
       LIMIT 1`,
    ).bind(endSequence, endSequence).first<StoredManifest>();
    return row === null ? null : toManifest(row);
  }

  async listManifests(
    afterSequence: number,
    throughSequence: number,
    manifestLimit: number,
  ): Promise<readonly ArchiveManifest[]> {
    requireManifestRange(afterSequence, throughSequence);
    requireManifestLimit(manifestLimit);
    const maximumEndSequence = boundedManifestEnd(throughSequence);
    const rows = await this.database.prepare(
      `SELECT m.manifest_id, m.start_sequence, m.end_sequence, m.event_count, m.sealed_at,
              s.object_key, s.compressed_sha256, s.compressed_byte_length, s.uncompressed_byte_length
       FROM archive_manifests m INDEXED BY archive_manifests_overlap_seek_idx
       JOIN archive_segments s ON s.manifest_id = m.manifest_id
       WHERE m.end_sequence > ? AND m.end_sequence <= ?
         AND m.start_sequence <= ? AND m.status = 'sealed'
       ORDER BY m.end_sequence ASC
       LIMIT ?`,
    ).bind(afterSequence, maximumEndSequence, throughSequence, manifestLimit).all<StoredManifest>();
    return rows.results.map(toManifest);
  }

  async readCoverage(manifest: ArchiveManifest): Promise<readonly ArchiveCoverage[]> {
    const rows = await this.database.prepare(
      `SELECT event_sequence, event_id, envelope_sha256, content_hash
       FROM archive_segment_events
       WHERE segment_id = ?
       ORDER BY event_sequence ASC`,
    ).bind(manifest.compressedSha256).all<StoredCoverage>();
    return rows.results.map(toCoverage);
  }

  async readCoverageRange(
    afterSequence: number,
    throughSequence: number,
    coverageLimit: number,
  ): Promise<readonly ArchiveCoverage[]> {
    requireManifestRange(afterSequence, throughSequence);
    requireManifestLimit(coverageLimit);
    const rows = await this.database.prepare(
      `SELECT event_sequence, event_id, envelope_sha256, content_hash
       FROM archive_segment_events
       WHERE event_sequence > ? AND event_sequence <= ?
       ORDER BY event_sequence ASC
       LIMIT ?`,
    ).bind(afterSequence, throughSequence, coverageLimit).all<StoredCoverage>();
    return rows.results.map(toCoverage);
  }

  async purgeDelivered(manifest: ArchiveManifest, purgedAt: string): Promise<void> {
    await this.transactions.batch([
      this.database.prepare(
        `INSERT OR IGNORE INTO archive_purge_receipts (event_sequence, outbox_id, delivered_at, purged_at)
         SELECT o.event_sequence, o.outbox_id, o.delivered_at, ?
         FROM outbox o
         JOIN archive_segment_events e ON e.event_sequence = o.event_sequence
         WHERE o.event_sequence BETWEEN ? AND ? AND o.status = 'delivered'`,
      ).bind(purgedAt, manifest.startSequence, manifest.endSequence),
      this.database.prepare(
        `DELETE FROM outbox
         WHERE event_sequence BETWEEN ? AND ?
           AND status = 'delivered'
           AND EXISTS (SELECT 1 FROM archive_purge_receipts p WHERE p.event_sequence = outbox.event_sequence)`,
      ).bind(manifest.startSequence, manifest.endSequence),
      this.database.prepare(
        `DELETE FROM events
         WHERE sequence BETWEEN ? AND ?
           AND EXISTS (SELECT 1 FROM archive_purge_receipts p WHERE p.event_sequence = events.sequence)
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_sequence = events.sequence)`,
      ).bind(manifest.startSequence, manifest.endSequence),
    ]);
  }

  async openCircuit(reason: string, openedAt: string): Promise<void> {
    const persistedReason = safeCircuitReason.test(reason) ? reason : "archive_operation_failed";
    await this.database.prepare(
      `UPDATE archive_state
       SET circuit_state = 'open', circuit_reason = ?, circuit_opened_at = ?, updated_at = ?
       WHERE singleton = 1 AND circuit_state = 'closed'`,
    ).bind(persistedReason, openedAt, openedAt).run();
  }
}

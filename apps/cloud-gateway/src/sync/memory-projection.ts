import {
  canonicalJson,
  sha256Hex,
  validateEnvelope,
  type JsonValue,
  type EventEnvelope,
  type MemoryFactProjectionCommitV1,
  type MemoryFactProjectionAbandonV1,
  type MemoryFactProjectionPageV1,
  type MemoryFactProjectionReceiptV1,
  type MemoryFactProjectionV1,
  type MemoryFactSourceV1,
  type Sha256Hex,
  type SignedRequestV1,
} from "../../../../packages/contracts/src/index.js";
import type { AppendedEvent, SyncEventReader } from "../persistence/event-repository.js";
import { hasFactTextControls, MAX_MEMORY_FACT_BYTES, MAX_MEMORY_FACT_SOURCES } from "../../../../packages/contracts/src/memory-projection.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "../conversation/conversation-repository.js";
import { Redactor } from "../security/redaction.js";
import {
  DeviceRequestVerifier,
  type VerifiedDeviceRequest,
} from "./signed-request.js";

export const MEMORY_PROJECTION_PATH = "/sync/memory/project";
export const MAX_PROJECTION_PAGES = 32;
export const MAX_FACTS_PER_PAGE = 32;
export const MAX_PROJECTION_FACTS = 1_024;
export const MAX_SOURCES_PER_FACT = MAX_MEMORY_FACT_SOURCES;
export const MAX_UNIQUE_SOURCES_PER_PAGE = 32;

const STAGING_LIFETIME_MS = 3_600_000;
const MAX_FACT_BYTES = MAX_MEMORY_FACT_BYTES;
const MAX_EXCERPT_BYTES = 4_096;
const MAX_VERSION_BYTES = 128;
const SHA256 = /^[a-f0-9]{64}$/u;
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const FACT_ID = /^fact_[0-9a-f]{32}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PAGE_FIELDS = new Set([
  "schemaVersion", "operation", "projectionVersion", "pageIndex", "pageCount",
  "totalFactCount", "pageHash", "manifestHash", "facts",
]);
const COMMIT_FIELDS = new Set([
  "schemaVersion", "operation", "projectionVersion", "pageCount", "totalFactCount", "manifestHash",
]);
const FACT_FIELDS = new Set([
  "factId", "text", "origin", "sensitivity", "confidence", "distillerVersion",
  "distilledAt", "contentHash", "sources",
]);
const SOURCE_FIELDS = new Set(["eventId", "eventSequence", "excerpt"]);
const HISTORY_PAYLOAD_FIELDS = new Set([
  "schemaCode", "channelCode", "sensitivityCode", "historyEligible", "text",
]);
const ORIGINS = new Set([
  "authenticated_first_person", "deterministic_observation", "model", "third_party",
]);
const encoder = new TextEncoder();
const redactor = new Redactor();

type ProjectionBody = MemoryFactProjectionPageV1 | MemoryFactProjectionCommitV1 | MemoryFactProjectionAbandonV1;

/** Only explicit content validation failures authorize discarding a staged page. */
export class ProjectionContentRejectedError extends Error {}

interface StoredHead {
  readonly published_version: number;
  readonly manifest_hash: string | null;
}

interface StoredVersion {
  readonly manifest_hash: string;
  readonly page_count: number;
  readonly total_fact_count: number;
  readonly key_id: string;
  readonly key_fingerprint: string;
  readonly key_generation: number;
  readonly status: "staged" | "published";
}

interface StoredPage {
  readonly page_index: number;
  readonly page_hash: string;
  readonly fact_count: number;
  readonly page_json: string;
}

interface StoredFact {
  readonly fact_position: number;
  readonly fact_json: string;
}

interface ProjectionOwner {
  readonly principalId: string;
  readonly deviceId: string;
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    throw new TypeError(code);
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(code);
    record[field] = descriptor.value;
  }
  return record;
}

function text(value: unknown, maximumBytes: number, code: string, singleLine = false): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || encoder.encode(value).byteLength > maximumBytes) {
    if (singleLine) throw new ProjectionContentRejectedError("memory_projection_fact_text_invalid");
    throw new TypeError(code);
  }
  if (singleLine && hasFactTextControls(value)) {
    // Old pending pages must reach signed abandonment instead of retrying forever.
    throw new ProjectionContentRejectedError("memory_projection_fact_controls_invalid");
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(code);
  }
  return value as number;
}

function hash(value: unknown, code: string): Sha256Hex {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(code);
  return value as Sha256Hex;
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value)) throw new TypeError(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(code);
  return value;
}

function captureSource(value: unknown): MemoryFactSourceV1 {
  const source = exactRecord(value, SOURCE_FIELDS, "memory_projection_source_invalid");
  if (typeof source.eventId !== "string" || !ULID.test(source.eventId)) {
    throw new TypeError("memory_projection_source_invalid");
  }
  return Object.freeze({
    eventId: source.eventId as MemoryFactSourceV1["eventId"],
    eventSequence: integer(source.eventSequence, 1, Number.MAX_SAFE_INTEGER, "memory_projection_source_invalid"),
    excerpt: text(source.excerpt, MAX_EXCERPT_BYTES, "memory_projection_source_invalid"),
  });
}

function captureFact(value: unknown): MemoryFactProjectionV1 {
  const fact = exactRecord(value, FACT_FIELDS, "memory_projection_fact_invalid");
  if (typeof fact.factId !== "string" || !FACT_ID.test(fact.factId)
    || typeof fact.origin !== "string" || !ORIGINS.has(fact.origin)
    || fact.sensitivity !== "normal" && fact.sensitivity !== "sensitive"
    || typeof fact.confidence !== "number" || !Number.isFinite(fact.confidence)
    || fact.confidence < 0 || fact.confidence > 1
    || !Array.isArray(fact.sources) || fact.sources.length < 1 || fact.sources.length > MAX_SOURCES_PER_FACT) {
    throw new TypeError("memory_projection_fact_invalid");
  }
  const sources = fact.sources.map(captureSource);
  if (new Set(sources.map((source) => source.eventId)).size !== sources.length
    || new Set(sources.map((source) => source.eventSequence)).size !== sources.length) {
    throw new TypeError("memory_projection_source_invalid");
  }
  return Object.freeze({
    factId: fact.factId,
    text: text(fact.text, MAX_FACT_BYTES, "memory_projection_fact_invalid", true),
    origin: fact.origin as MemoryFactProjectionV1["origin"],
    sensitivity: fact.sensitivity,
    confidence: fact.confidence,
    distillerVersion: text(fact.distillerVersion, MAX_VERSION_BYTES, "memory_projection_fact_invalid"),
    distilledAt: timestamp(fact.distilledAt, "memory_projection_fact_invalid"),
    contentHash: hash(fact.contentHash, "memory_projection_fact_invalid"),
    sources: Object.freeze(sources),
  });
}

function validatePage(value: unknown): MemoryFactProjectionPageV1 {
  const page = exactRecord(value, PAGE_FIELDS, "memory_projection_page_invalid");
  if (page.schemaVersion !== "1.0" || page.operation !== "page" || !Array.isArray(page.facts)) {
    throw new TypeError("memory_projection_page_invalid");
  }
  const projectionVersion = integer(page.projectionVersion, 1, 2_147_483_647, "memory_projection_page_invalid");
  const pageCount = integer(page.pageCount, 1, MAX_PROJECTION_PAGES, "memory_projection_page_invalid");
  const pageIndex = integer(page.pageIndex, 0, pageCount - 1, "memory_projection_page_invalid");
  const totalFactCount = integer(page.totalFactCount, 0, MAX_PROJECTION_FACTS, "memory_projection_page_invalid");
  if (page.facts.length > MAX_FACTS_PER_PAGE
    || totalFactCount === 0 && (pageCount !== 1 || pageIndex !== 0 || page.facts.length !== 0)
    || totalFactCount > 0 && page.facts.length === 0
    || totalFactCount > pageCount * MAX_FACTS_PER_PAGE) {
    throw new TypeError("memory_projection_page_invalid");
  }
  const facts = page.facts.map(captureFact);
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length) {
    throw new TypeError("memory_projection_fact_invalid");
  }
  const uniqueSources = new Set(facts.flatMap((fact) => fact.sources.map((source) => source.eventSequence)));
  if (uniqueSources.size > MAX_UNIQUE_SOURCES_PER_PAGE) throw new TypeError("memory_projection_source_limit");
  return Object.freeze({
    schemaVersion: "1.0",
    operation: "page",
    projectionVersion,
    pageIndex,
    pageCount,
    totalFactCount,
    pageHash: hash(page.pageHash, "memory_projection_page_invalid"),
    manifestHash: hash(page.manifestHash, "memory_projection_page_invalid"),
    facts: Object.freeze(facts),
  });
}

function validateCommit(value: unknown): MemoryFactProjectionCommitV1 {
  const commit = exactRecord(value, COMMIT_FIELDS, "memory_projection_commit_invalid");
  if (commit.schemaVersion !== "1.0" || commit.operation !== "commit") {
    throw new TypeError("memory_projection_commit_invalid");
  }
  return Object.freeze({
    schemaVersion: "1.0",
    operation: "commit",
    projectionVersion: integer(commit.projectionVersion, 1, 2_147_483_647, "memory_projection_commit_invalid"),
    pageCount: integer(commit.pageCount, 1, MAX_PROJECTION_PAGES, "memory_projection_commit_invalid"),
    totalFactCount: integer(commit.totalFactCount, 0, MAX_PROJECTION_FACTS, "memory_projection_commit_invalid"),
    manifestHash: hash(commit.manifestHash, "memory_projection_commit_invalid"),
  });
}

export function validateProjectionBody(value: unknown): ProjectionBody {
  const operation = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "operation")?.value
    : undefined;
  if (operation === "abandon") {
    const body = exactRecord(value, COMMIT_FIELDS, "memory_projection_abandon_invalid");
    return Object.freeze({ ...validateCommit({ ...body, operation: "commit" }), operation: "abandon" });
  }
  return operation === "page" ? validatePage(value) : validateCommit(value);
}

export async function projectionPageHash(facts: readonly MemoryFactProjectionV1[]): Promise<Sha256Hex> {
  return sha256Hex(canonicalJson({ facts } as unknown as JsonValue));
}

export async function projectionManifestHash(input: {
  readonly projectionVersion: number;
  readonly pageCount: number;
  readonly totalFactCount: number;
  readonly pageHashes: readonly string[];
}): Promise<Sha256Hex> {
  return sha256Hex(canonicalJson({ schemaVersion: "1.0", ...input } as unknown as JsonValue));
}

async function requireFactIdentity(principalId: string, fact: MemoryFactProjectionV1): Promise<void> {
  const contentHash = await sha256Hex(canonicalJson({
    principal_id: principalId,
    sources: [...fact.sources.map((source) => source.eventId)].sort(),
    text: fact.text,
  }));
  if (contentHash !== fact.contentHash || fact.factId !== `fact_${contentHash.slice(0, 32)}`) {
    throw new Error("memory_projection_fact_identity_invalid");
  }
  const checked = redactor.redactText(fact.text);
  if (!checked.ok || checked.text !== fact.text) throw new ProjectionContentRejectedError("memory_projection_redaction_invalid");
}

function sourceText(envelope: EventEnvelope): string {
  if (envelope.eventType !== "conversation.user_committed"
    && envelope.eventType !== "conversation.assistant_delivered"
    || envelope.source !== CONVERSATION_EVENT_SOURCE
    || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION) {
    throw new ProjectionContentRejectedError("memory_projection_source_invalid");
  }
  let payload: Record<string, unknown>;
  try { payload = exactRecord(envelope.payload, HISTORY_PAYLOAD_FIELDS, "memory_projection_source_invalid"); }
  catch { throw new ProjectionContentRejectedError("memory_projection_source_invalid"); }
  if (payload.schemaCode !== 1 || payload.sensitivityCode !== 1 || payload.historyEligible !== true
    || envelope.eventType === "conversation.assistant_delivered" && payload.channelCode !== 2
    || envelope.eventType === "conversation.user_committed"
      && payload.channelCode !== 1 && payload.channelCode !== 2) {
    throw new ProjectionContentRejectedError("memory_projection_source_invalid");
  }
  const candidate = payload.text;
  if (typeof candidate !== "string") throw new ProjectionContentRejectedError("memory_projection_source_invalid");
  const checked = redactor.redactText(candidate);
  if (!checked.ok || checked.text !== candidate) throw new ProjectionContentRejectedError("memory_projection_redaction_invalid");
  return candidate;
}

async function verifyPageSources(
  events: SyncEventReader,
  principalId: string,
  page: MemoryFactProjectionPageV1,
): Promise<void> {
  const bySequence = new Map<number, AppendedEvent>();
  for (const fact of page.facts) {
    await requireFactIdentity(principalId, fact);
    for (const source of fact.sources) {
      let event = bySequence.get(source.eventSequence);
      if (event === undefined) {
        const selected = await events.readRange(source.eventSequence - 1, 1);
        if (selected.length !== 1) throw new Error("memory_projection_source_missing");
        [event] = selected;
        if (event === undefined) throw new Error("memory_projection_source_missing");
        bySequence.set(source.eventSequence, event);
      }
      const envelope = await validateEnvelope(event.envelope);
      if (event.eventSequence !== source.eventSequence || envelope.eventId !== source.eventId
        || envelope.subjectId !== principalId || !sourceText(envelope).startsWith(source.excerpt)) {
        throw new ProjectionContentRejectedError("memory_projection_source_invalid");
      }
    }
  }
}

class MemoryProjectionRepository {
  constructor(private readonly database: D1Database) {}

  async stage(
    verified: VerifiedDeviceRequest<MemoryFactProjectionPageV1>,
    now: Date,
  ): Promise<MemoryFactProjectionReceiptV1> {
    const page = verified.body;
    const pageJson = canonicalJson(page as unknown as JsonValue);
    await this.database.prepare(
      `DELETE FROM memory_fact_projection_versions
       WHERE principal_id = ? AND device_id = ? AND status = 'staged' AND expires_at <= ?`,
    ).bind(verified.principalId, verified.deviceId, now.toISOString()).run();
    await this.database.prepare(
      `INSERT INTO memory_fact_projection_heads
       (principal_id, device_id, published_version, manifest_hash, published_at)
       SELECT d.principal_id, d.device_id, 0, NULL, NULL
       FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
       WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ?
         AND d.key_fingerprint = ? AND d.key_generation = ?
         AND d.status = 'active' AND p.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM memory_fact_projection_heads h
           WHERE h.principal_id = d.principal_id AND h.device_id = d.device_id
         )`,
    ).bind(
      verified.deviceId, verified.principalId, verified.keyId,
      verified.keyFingerprint, verified.keyGeneration,
    ).run();
    const head = await this.head(verified);
    if (head === null) throw new Error("memory_projection_device_state_changed");
    if (page.projectionVersion <= head.published_version) {
      const existing = await this.page(verified, page.projectionVersion, page.pageIndex);
      if (page.projectionVersion === head.published_version && head.manifest_hash === page.manifestHash
        && existing?.page_hash === page.pageHash && existing.page_json === pageJson) {
        return this.receipt(page, false, true);
      }
      throw new Error("memory_projection_stale_version");
    }
    if (page.projectionVersion !== head.published_version + 1) throw new Error("memory_projection_version_gap");

    let current = await this.version(verified, page.projectionVersion);
    if (current !== null && (current.key_id !== verified.keyId
      || current.key_fingerprint !== verified.keyFingerprint
      || current.key_generation !== verified.keyGeneration)) {
      await this.database.prepare(
        `DELETE FROM memory_fact_projection_versions
         WHERE principal_id = ? AND device_id = ? AND projection_version = ? AND status = 'staged'
           AND EXISTS (
             SELECT 1 FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
             WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ?
               AND d.key_fingerprint = ? AND d.key_generation = ?
               AND d.status = 'active' AND p.status = 'active'
           )`,
      ).bind(
        verified.principalId, verified.deviceId, page.projectionVersion,
        verified.deviceId, verified.principalId, verified.keyId,
        verified.keyFingerprint, verified.keyGeneration,
      ).run();
      current = await this.version(verified, page.projectionVersion);
    }
    if (current !== null && (current.manifest_hash !== page.manifestHash
      || current.page_count !== page.pageCount || current.total_fact_count !== page.totalFactCount
      || current.key_id !== verified.keyId || current.key_fingerprint !== verified.keyFingerprint
      || current.key_generation !== verified.keyGeneration || current.status !== "staged")) {
      throw new Error("memory_projection_version_conflict");
    }
    const existing = await this.page(verified, page.projectionVersion, page.pageIndex);
    if (existing !== null) {
      if (existing.page_hash !== page.pageHash || existing.page_json !== pageJson
        || existing.fact_count !== page.facts.length) throw new Error("memory_projection_page_conflict");
      return this.receipt(page, false, true);
    }

    const createdAt = now.toISOString();
    const expiresAt = new Date(now.valueOf() + STAGING_LIFETIME_MS).toISOString();
    const statements: D1PreparedStatement[] = [];
    if (current === null) {
      statements.push(this.database.prepare(
        `INSERT INTO memory_fact_projection_versions
         (principal_id, device_id, projection_version, manifest_hash, page_count, total_fact_count,
          key_id, key_fingerprint, key_generation, status, created_at, expires_at, published_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, NULL
         FROM memory_fact_projection_heads h
         JOIN device_keys d ON d.device_id = h.device_id AND d.principal_id = h.principal_id
         JOIN principals p ON p.principal_id = h.principal_id
         WHERE h.principal_id = ? AND h.device_id = ? AND h.published_version = ?
           AND d.key_id = ? AND d.key_fingerprint = ? AND d.key_generation = ?
           AND d.status = 'active' AND p.status = 'active'`,
      ).bind(
        verified.principalId, verified.deviceId, page.projectionVersion, page.manifestHash,
        page.pageCount, page.totalFactCount, verified.keyId, verified.keyFingerprint,
        verified.keyGeneration, createdAt, expiresAt, verified.principalId, verified.deviceId,
        page.projectionVersion - 1, verified.keyId, verified.keyFingerprint, verified.keyGeneration,
      ));
    }
    statements.push(this.database.prepare(
      `INSERT INTO memory_fact_projection_pages
       (principal_id, device_id, projection_version, page_index, page_hash, fact_count, page_json, created_at)
       SELECT v.principal_id, v.device_id, v.projection_version, ?, ?, ?, ?, ?
       FROM memory_fact_projection_versions v
       JOIN device_keys d ON d.device_id = v.device_id AND d.principal_id = v.principal_id
       JOIN principals p ON p.principal_id = v.principal_id
       WHERE v.principal_id = ? AND v.device_id = ? AND v.projection_version = ?
         AND v.manifest_hash = ? AND v.status = 'staged'
         AND d.key_id = ? AND d.key_fingerprint = ? AND d.key_generation = ?
         AND d.status = 'active' AND p.status = 'active'`,
    ).bind(
      page.pageIndex, page.pageHash, page.facts.length, pageJson, createdAt,
      verified.principalId, verified.deviceId, page.projectionVersion, page.manifestHash,
      verified.keyId, verified.keyFingerprint, verified.keyGeneration,
    ));
    for (let position = 0; position < page.facts.length; position += 1) {
      const fact = page.facts[position]!;
      const primary = fact.sources[0]!;
      // Abandonment may replace this coordinate after our reads. Facts may
      // attach only to the exact immutable page this request validated.
      statements.push(this.database.prepare(
        `INSERT INTO memory_fact_projection_facts
         (principal_id, device_id, projection_version, page_index, fact_position, fact_id, text,
          origin, sensitivity, confidence, distiller_version, distilled_at, content_hash,
          primary_event_id, primary_event_sequence, sources_json, fact_json)
         SELECT p.principal_id, p.device_id, p.projection_version, p.page_index,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM memory_fact_projection_pages p
         WHERE p.principal_id = ? AND p.device_id = ? AND p.projection_version = ? AND p.page_index = ?
           AND p.page_json = ?`,
      ).bind(
        position, fact.factId, fact.text, fact.origin, fact.sensitivity, fact.confidence,
        fact.distillerVersion, fact.distilledAt, fact.contentHash, primary.eventId,
        primary.eventSequence, canonicalJson(fact.sources as unknown as JsonValue),
        canonicalJson(fact as unknown as JsonValue), verified.principalId, verified.deviceId,
        page.projectionVersion, page.pageIndex, pageJson,
      ));
    }
    try {
      const results = await this.database.batch(statements);
      const pageResult = results[current === null ? 1 : 0];
      if (pageResult?.meta.changes !== 1) {
        if (!await this.deviceIsCurrent(verified)) throw new Error("memory_projection_device_state_changed");
        throw new Error("memory_projection_page_state_changed");
      }
    } catch (error) {
      const raced = await this.page(verified, page.projectionVersion, page.pageIndex);
      if (raced?.page_hash === page.pageHash && raced.page_json === pageJson) {
        return this.receipt(page, false, true);
      }
      throw error;
    }
    return this.receipt(page, false, false);
  }

  private async deviceIsCurrent(
    verified: VerifiedDeviceRequest<MemoryFactProjectionPageV1>,
  ): Promise<boolean> {
    const current = await this.database.prepare(
      `SELECT 1 AS present
       FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
       WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ?
         AND d.key_fingerprint = ? AND d.key_generation = ?
         AND d.status = 'active' AND p.status = 'active'`,
    ).bind(
      verified.deviceId,
      verified.principalId,
      verified.keyId,
      verified.keyFingerprint,
      verified.keyGeneration,
    ).first<{ present: number }>();
    return current?.present === 1;
  }

  async commit(
    verified: VerifiedDeviceRequest<MemoryFactProjectionCommitV1>,
    now: Date,
  ): Promise<MemoryFactProjectionReceiptV1> {
    const commit = verified.body;
    const head = await this.head(verified);
    if (head === null) throw new Error("memory_projection_state_missing");
    if (commit.projectionVersion === head.published_version && commit.manifestHash === head.manifest_hash) {
      const published = await this.version(verified, commit.projectionVersion);
      if (published === null || published.status !== "published"
        || published.page_count !== commit.pageCount
        || published.total_fact_count !== commit.totalFactCount) {
        throw new Error("memory_projection_commit_mismatch");
      }
      return this.receipt(commit, true, true);
    }
    if (commit.projectionVersion <= head.published_version) throw new Error("memory_projection_stale_version");
    if (commit.projectionVersion !== head.published_version + 1) throw new Error("memory_projection_version_gap");
    const version = await this.version(verified, commit.projectionVersion);
    if (version === null || version.status !== "staged" || version.manifest_hash !== commit.manifestHash
      || version.page_count !== commit.pageCount || version.total_fact_count !== commit.totalFactCount) {
      throw new Error("memory_projection_commit_mismatch");
    }
    const pages = await this.pages(verified, commit.projectionVersion);
    if (pages.length !== commit.pageCount) throw new Error("memory_projection_incomplete");
    let factsSeen = 0;
    const pageHashes: string[] = [];
    for (let index = 0; index < pages.length; index += 1) {
      const stored = pages[index]!;
      if (stored.page_index !== index) throw new Error("memory_projection_incomplete");
      let decoded: unknown;
      try { decoded = JSON.parse(stored.page_json) as unknown; }
      catch { throw new Error("memory_projection_page_corrupt"); }
      const page = validatePage(decoded);
      if (canonicalJson(page as unknown as JsonValue) !== stored.page_json
        || page.projectionVersion !== commit.projectionVersion || page.pageIndex !== index
        || page.pageCount !== commit.pageCount || page.totalFactCount !== commit.totalFactCount
        || page.manifestHash !== commit.manifestHash || page.pageHash !== stored.page_hash
        || page.facts.length !== stored.fact_count || await projectionPageHash(page.facts) !== stored.page_hash) {
        throw new Error("memory_projection_page_corrupt");
      }
      const facts = await this.facts(verified, commit.projectionVersion, index);
      if (facts.length !== page.facts.length || facts.some((fact, position) =>
        fact.fact_position !== position
        || fact.fact_json !== canonicalJson(page.facts[position] as unknown as JsonValue))) {
        throw new Error("memory_projection_fact_corrupt");
      }
      factsSeen += page.facts.length;
      pageHashes.push(stored.page_hash);
    }
    if (factsSeen !== commit.totalFactCount || await projectionManifestHash({
      projectionVersion: commit.projectionVersion,
      pageCount: commit.pageCount,
      totalFactCount: commit.totalFactCount,
      pageHashes,
    }) !== commit.manifestHash) throw new Error("memory_projection_manifest_invalid");

    try {
      await this.database.prepare(
        `INSERT INTO memory_fact_projection_commits
         (principal_id, device_id, projection_version, manifest_hash, key_id,
          key_fingerprint, key_generation, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        verified.principalId, verified.deviceId, commit.projectionVersion, commit.manifestHash,
        verified.keyId, verified.keyFingerprint, verified.keyGeneration, now.toISOString(),
      ).run();
    } catch (error) {
      const raced = await this.head(verified);
      if (raced?.published_version === commit.projectionVersion
        && raced.manifest_hash === commit.manifestHash) return this.receipt(commit, true, true);
      throw error;
    }
    return this.receipt(commit, true, false);
  }

  async abandon(
    verified: VerifiedDeviceRequest<MemoryFactProjectionAbandonV1>, now: Date,
  ): Promise<MemoryFactProjectionReceiptV1> {
    const body = verified.body;
    const head = await this.head(verified);
    if (head !== null && body.projectionVersion <= head.published_version) {
      // Reuse exact commit reconciliation if publication beat abandonment.
      return this.commit({ ...verified, body: { ...body, operation: "commit" } }, now);
    }
    const existing = await this.database.prepare(
      `SELECT page_count, total_fact_count FROM memory_fact_projection_abandoned
       WHERE principal_id = ? AND device_id = ? AND projection_version = ? AND manifest_hash = ?`,
    ).bind(verified.principalId, verified.deviceId, body.projectionVersion, body.manifestHash)
      .first<{ page_count: number; total_fact_count: number }>();
    if (existing !== null) {
      if (existing.page_count !== body.pageCount || existing.total_fact_count !== body.totalFactCount) {
        throw new Error("memory_projection_abandon_conflict");
      }
      return this.receipt(body, false, true);
    }
    try {
      await this.database.prepare(
        `INSERT INTO memory_fact_projection_abandoned
         (principal_id, device_id, projection_version, manifest_hash, page_count, total_fact_count,
          key_id, key_fingerprint, key_generation, abandoned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(verified.principalId, verified.deviceId, body.projectionVersion, body.manifestHash,
        body.pageCount, body.totalFactCount, verified.keyId, verified.keyFingerprint,
        verified.keyGeneration, now.toISOString()).run();
    } catch (error) {
      const raced = await this.head(verified);
      if (raced?.published_version === body.projectionVersion && raced.manifest_hash === body.manifestHash) {
        return this.commit({ ...verified, body: { ...body, operation: "commit" } }, now);
      }
      throw error;
    }
    return this.receipt(body, false, false);
  }

  private receipt(
    body: ProjectionBody,
    published: boolean,
    replayed: boolean,
  ): MemoryFactProjectionReceiptV1 {
    return Object.freeze({
      schemaVersion: "1.0",
      projectionVersion: body.projectionVersion,
      manifestHash: body.manifestHash,
      pageIndex: body.operation === "page" ? body.pageIndex : null,
      pageHash: body.operation === "page" ? body.pageHash : null,
      published,
      replayed,
    });
  }

  private head(verified: ProjectionOwner): Promise<StoredHead | null> {
    return this.database.prepare(
      `SELECT published_version, manifest_hash FROM memory_fact_projection_heads
       WHERE principal_id = ? AND device_id = ?`,
    ).bind(verified.principalId, verified.deviceId).first<StoredHead>();
  }

  private version(verified: ProjectionOwner, version: number): Promise<StoredVersion | null> {
    return this.database.prepare(
      `SELECT manifest_hash, page_count, total_fact_count, key_id, key_fingerprint, key_generation, status
       FROM memory_fact_projection_versions
       WHERE principal_id = ? AND device_id = ? AND projection_version = ?`,
    ).bind(verified.principalId, verified.deviceId, version).first<StoredVersion>();
  }

  private page(verified: ProjectionOwner, version: number, pageIndex: number): Promise<StoredPage | null> {
    return this.database.prepare(
      `SELECT page_index, page_hash, fact_count, page_json FROM memory_fact_projection_pages
       WHERE principal_id = ? AND device_id = ? AND projection_version = ? AND page_index = ?`,
    ).bind(verified.principalId, verified.deviceId, version, pageIndex).first<StoredPage>();
  }

  private async pages(verified: ProjectionOwner, version: number): Promise<readonly StoredPage[]> {
    const result = await this.database.prepare(
      `SELECT page_index, page_hash, fact_count, page_json FROM memory_fact_projection_pages
       WHERE principal_id = ? AND device_id = ? AND projection_version = ? ORDER BY page_index ASC`,
    ).bind(verified.principalId, verified.deviceId, version).all<StoredPage>();
    return result.results;
  }

  private async facts(
    verified: ProjectionOwner,
    version: number,
    pageIndex: number,
  ): Promise<readonly StoredFact[]> {
    const result = await this.database.prepare(
      `SELECT fact_position, fact_json FROM memory_fact_projection_facts
       WHERE principal_id = ? AND device_id = ? AND projection_version = ? AND page_index = ?
       ORDER BY fact_position ASC`,
    ).bind(verified.principalId, verified.deviceId, version, pageIndex).all<StoredFact>();
    return result.results;
  }
}

export class MemoryProjectionService {
  private readonly repository: MemoryProjectionRepository;

  constructor(private readonly dependencies: {
    readonly database: D1Database;
    readonly verifier: DeviceRequestVerifier;
    readonly events: SyncEventReader;
    readonly now?: () => Date;
    readonly beforeStage?: () => void | Promise<void>;
    readonly beforePublish?: () => void | Promise<void>;
  }) {
    this.repository = new MemoryProjectionRepository(dependencies.database);
  }

  async project(
    request: SignedRequestV1,
    suppliedBody: unknown,
    rawBody: Uint8Array,
  ): Promise<MemoryFactProjectionReceiptV1> {
    const now = this.dependencies.now?.() ?? new Date();
    const verified = await this.dependencies.verifier.verify(
      request,
      "POST",
      MEMORY_PROJECTION_PATH,
      suppliedBody,
      rawBody,
      now,
      validateProjectionBody,
    );
    if (verified.body.operation === "page") {
      if (await projectionPageHash(verified.body.facts) !== verified.body.pageHash) {
        throw new Error("memory_projection_page_hash_invalid");
      }
      await verifyPageSources(this.dependencies.events, verified.principalId, verified.body);
      await this.dependencies.beforeStage?.();
      return this.repository.stage(
        verified as VerifiedDeviceRequest<MemoryFactProjectionPageV1>,
        now,
      );
    }
    if (verified.body.operation === "abandon") {
      return this.repository.abandon(verified as VerifiedDeviceRequest<MemoryFactProjectionAbandonV1>, now);
    }
    await this.dependencies.beforePublish?.();
    return this.repository.commit(
      verified as VerifiedDeviceRequest<MemoryFactProjectionCommitV1>,
      now,
    );
  }
}

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  newUlid,
  sha256Hex,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  AUTOMATIC_TOPIC_PROMPT_TREE_BYTES,
  automaticFilingReason,
  MemoryRepository,
  normalizeAutomaticTopicPath,
} from "../../src/memory/memory-repository.js";
import type { ArchivedEventReader } from "../../src/archive/tiered-event-reader.js";
import type { AppendedEvent } from "../../src/persistence/event-repository.js";
import {
  MEMORY_INBOX_DISPLAY_NAME,
  MEMORY_ROOT_DISPLAY_NAME,
  MemoryRepositoryError,
  type CommitInitialMemoryInput,
  type MemoryRepositoryErrorCode,
} from "../../src/memory/memory-types.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";

interface SeededEvent {
  readonly eventId: Ulid;
  readonly sequence: number;
  readonly occurredAt: string;
}

interface Fixture {
  readonly principalId: string;
  readonly source: SeededEvent;
  readonly repository: MemoryRepository;
  readonly input: CommitInitialMemoryInput;
}

interface ArchivedReceipt extends SeededEvent {
  readonly segmentId: Sha256Hex;
  readonly reader: ArchivedEventReader;
}

let principalSerial = 0;
let topicClock = Date.now() + 1_000;

function nextTimestamp(): string {
  topicClock = Math.max(Date.now() + 1_000, topicClock + 10);
  return new Date(topicClock).toISOString();
}

async function seedPrincipal(principalType: "human" | "service" = "service"): Promise<string> {
  principalSerial += 1;
  const principalId = `principal:memory-runtime:${principalSerial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, ?, 'active', 'memory runtime test', ?, ?)`)
    .bind(principalId, principalType, now, now).run();
  return principalId;
}

async function seedEvent(principalId: string, text: string): Promise<SeededEvent> {
  const eventId = newUlid();
  const occurredAt = new Date().toISOString();
  const payload = {
    schemaCode: 1,
    channelCode: 2,
    sensitivityCode: 1,
    historyEligible: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(),
    contentType: "application/json",
    contentHash,
    payload,
    redaction: { status: "none", markers: [] },
    producerVersion: "conversation-v1",
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'conversation', ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, principalId, occurredAt, occurredAt, contentHash, JSON.stringify(envelope), occurredAt).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_repository_test_event_missing");
  return { eventId, sequence: row.sequence, occurredAt };
}

async function seedArchivedReceipt(
  principalId: string,
  text = "An archived-only detail remains uncertain.",
): Promise<ArchivedReceipt> {
  const eventId = newUlid();
  const state = await env.DB.prepare(
    "SELECT sealed_through FROM archive_state WHERE singleton = 1",
  ).first<{ sealed_through: number }>();
  if (state === null) throw new Error("memory_repository_archive_state_missing");
  const eventSequence = state.sealed_through + 1;
  const occurredAt = new Date().toISOString();
  const payload = {
    schemaCode: 1,
    channelCode: 2,
    sensitivityCode: 1,
    historyEligible: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0" as const,
    eventId,
    eventSequence,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(),
    contentType: "application/json" as const,
    contentHash,
    payload,
    redaction: { status: "none" as const, markers: [] },
    producerVersion: "conversation-v1",
  };
  const manifestId = await sha256Hex(`manifest:${eventId}`);
  const segmentId = await sha256Hex(`segment:${eventId}`);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO archive_manifests (
      manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at
    ) VALUES (?, ?, ?, 1, 'sealed', ?, ?)`)
      .bind(manifestId, eventSequence, eventSequence, occurredAt, occurredAt),
    env.DB.prepare(`INSERT INTO archive_segments (
      segment_id, manifest_id, object_key, compressed_sha256,
      compressed_byte_length, uncompressed_byte_length, codec, created_at
    ) VALUES (?, ?, ?, ?, 1, 1, 'jarvis-gzip-ndjson-v1', ?)`)
      .bind(segmentId, manifestId, `memory-test/${segmentId}.ndjson.gz`, segmentId, occurredAt),
    env.DB.prepare(`INSERT INTO archive_segment_events (
      event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        eventSequence,
        eventId,
        segmentId,
        await sha256Hex(canonicalJson(envelope)),
        contentHash,
        occurredAt,
      ),
    env.DB.prepare(`UPDATE archive_state SET sealed_through = ?, updated_at = ?
      WHERE singleton = 1 AND sealed_through = ?`)
      .bind(eventSequence, occurredAt, state.sealed_through),
  ]);
  return {
    eventId,
    sequence: eventSequence,
    occurredAt,
    segmentId,
    reader: {
      async readArchivedRange(afterSequence, limit) {
        return afterSequence === eventSequence - 1 && limit === 1
          ? [{ eventSequence, envelope, replayed: true }]
          : [];
      },
    },
  };
}

async function archiveExistingLiveReceipt(source: SeededEvent): Promise<ArchivedReceipt> {
  const stored = await env.DB.prepare(`SELECT envelope_json, content_hash FROM events
    WHERE sequence = ? AND event_id = ?`).bind(source.sequence, source.eventId)
    .first<{ envelope_json: string; content_hash: string }>();
  if (stored === null) throw new Error("memory_repository_live_archive_source_missing");
  const storedEnvelope = JSON.parse(stored.envelope_json) as AppendedEvent["envelope"];
  const envelope = { ...storedEnvelope, eventSequence: source.sequence } as AppendedEvent["envelope"];
  const manifestId = await sha256Hex(`handoff-manifest:${source.eventId}`);
  const segmentId = await sha256Hex(`handoff-segment:${source.eventId}`);
  const guard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'archive_manifests_require_next_range'`)
    .first<{ sql: string }>();
  if (guard === null) throw new Error("memory_repository_archive_guard_missing");
  await env.DB.prepare("DROP TRIGGER archive_manifests_require_next_range").run();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO archive_manifests (
        manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at
      ) VALUES (?, ?, ?, 1, 'sealed', ?, ?)`)
        .bind(manifestId, source.sequence, source.sequence, source.occurredAt, source.occurredAt),
      env.DB.prepare(`INSERT INTO archive_segments (
        segment_id, manifest_id, object_key, compressed_sha256,
        compressed_byte_length, uncompressed_byte_length, codec, created_at
      ) VALUES (?, ?, ?, ?, 1, 1, 'jarvis-gzip-ndjson-v1', ?)`)
        .bind(
          segmentId,
          manifestId,
          `memory-handoff-test/${segmentId}.ndjson.gz`,
          segmentId,
          source.occurredAt,
        ),
      env.DB.prepare(`INSERT INTO archive_segment_events (
        event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          source.sequence,
          source.eventId,
          segmentId,
          await sha256Hex(canonicalJson(envelope)),
          stored.content_hash,
          source.occurredAt,
        ),
    ]);
  } finally {
    await env.DB.prepare(guard.sql).run();
  }
  await env.DB.prepare("DELETE FROM events WHERE sequence = ? AND event_id = ?")
    .bind(source.sequence, source.eventId).run();
  return {
    ...source,
    segmentId,
    reader: {
      async readArchivedRange(afterSequence, limit) {
        return afterSequence === source.sequence - 1 && limit === 1
          ? [{ eventSequence: source.sequence, envelope, replayed: true }]
          : [];
      },
    },
  };
}

async function cleanupHandoffArchive(segmentId: Sha256Hex): Promise<void> {
  const segment = await env.DB.prepare("SELECT manifest_id FROM archive_segments WHERE segment_id = ?")
    .bind(segmentId).first<{ manifest_id: string }>();
  if (segment === null) throw new Error("memory_repository_handoff_segment_missing");
  const triggerNames = [
    "archive_segment_events_no_delete",
    "archive_segments_no_delete",
    "archive_manifests_no_delete",
  ] as const;
  const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (${triggerNames.map(() => "?").join(", ")})`)
    .bind(...triggerNames).all<{ name: string; sql: string }>();
  if (guards.results.length !== triggerNames.length) {
    throw new Error("memory_repository_handoff_delete_guard_missing");
  }
  for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER ${guard.name}`).run();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM archive_segment_events WHERE segment_id = ?").bind(segmentId),
      env.DB.prepare("DELETE FROM archive_segments WHERE segment_id = ?").bind(segmentId),
      env.DB.prepare("DELETE FROM archive_manifests WHERE manifest_id = ?").bind(segment.manifest_id),
    ]);
  } finally {
    for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
  }
}

async function fixture(repository = new MemoryRepository(env.DB)): Promise<Fixture> {
  const principalId = await seedPrincipal();
  const text = "I prefer short reports.";
  const source = await seedEvent(principalId, text);
  const topics = await repository.bootstrapTopics(principalId);
  const input: CommitInitialMemoryInput = Object.freeze({
    principalId,
    itemId: newUlid(),
    kind: "preference",
    creationEventId: source.eventId,
    creationEventSequence: source.sequence,
    version: Object.freeze({
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: "stated",
      origin: "authenticated_first_person",
      uncertain: false,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "memory-policy-v1",
      extractorModelId: null,
    }),
    sources: Object.freeze([Object.freeze({
      sourceId: newUlid(),
      eventId: source.eventId,
      eventSequence: source.sequence,
      sourceLocation: "live" as const,
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "telegram" as const,
      occurredAt: source.occurredAt,
    })]),
    transition: Object.freeze({
      transitionId: newUlid(),
      lifecycleState: "active" as const,
      reason: "deterministic first-person promotion",
      policyVersion: "memory-policy-v1",
    }),
    placement: Object.freeze({
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule" as const,
      confidence: 0.4,
      reason: "low-confidence filing uses the explicit inbox",
    }),
  });
  return { principalId, source, repository, input };
}

async function inputForArchived(
  principalId: string,
  archived: ArchivedReceipt,
  topicId: Ulid,
): Promise<CommitInitialMemoryInput> {
  const text = "An archived-only detail remains uncertain.";
  return Object.freeze({
    principalId,
    itemId: newUlid(),
    kind: "fact" as const,
    creationEventId: archived.eventId,
    creationEventSequence: archived.sequence,
    version: Object.freeze({
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: "inferred" as const,
      origin: "model" as const,
      uncertain: true,
      sensitivity: "normal" as const,
      validFrom: null,
      validTo: null,
      extractorVersion: "memory-policy-v1",
      extractorModelId: "deepseek:fixture-model",
    }),
    sources: Object.freeze([Object.freeze({
      sourceId: newUlid(),
      eventId: archived.eventId,
      eventSequence: archived.sequence,
      sourceLocation: "archived" as const,
      r2SegmentId: archived.segmentId,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "telegram" as const,
      occurredAt: archived.occurredAt,
    })]),
    transition: Object.freeze({
      transitionId: newUlid(),
      lifecycleState: "proposed" as const,
      reason: "archived-only evidence stays uncertain",
      policyVersion: "memory-policy-v1",
    }),
    placement: Object.freeze({
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId,
      filingSource: "model" as const,
      confidence: 0.2,
      reason: "archived-only proposal uses the explicit inbox",
    }),
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: MemoryRepositoryErrorCode,
): Promise<MemoryRepositoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryRepositoryError);
    expect((error as MemoryRepositoryError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return error as MemoryRepositoryError;
  }
  throw new Error(`expected_memory_repository_error:${code}`);
}

function omitCanonicalTextHash(statement: D1PreparedStatement): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property, receiver): unknown {
      if (property === "bind") {
        return (...values: unknown[]) => omitCanonicalTextHash(target.bind(...values));
      }
      if (property === "all") {
        return async <T>(): Promise<D1Result<T>> => {
          const result = await target.all<T>();
          const first = result.results[0];
          if (first === undefined || first === null || typeof first !== "object") return result;
          const changed = { ...first } as Record<string, unknown>;
          delete changed.text_hash;
          return { ...result, results: [changed as T, ...result.results.slice(1)] };
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1PreparedStatement;
}

function databaseWithMalformedCanonicalRow(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property, receiver): unknown {
      if (property === "prepare") {
        return (query: string): D1PreparedStatement => {
          const statement = target.prepare(query);
          return query.includes("FROM memory_items item")
            ? omitCanonicalTextHash(statement)
            : statement;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

async function createTopic(
  principalId: string,
  parentTopicId: Ulid,
  displayName: string,
): Promise<Ulid> {
  const topicId = newUlid();
  const topicEventId = newUlid();
  await env.DB.prepare(`INSERT INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation,
    previous_parent_topic_id, new_parent_topic_id,
    previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 'create', NULL, ?, NULL, NULL, ?, ?, NULL,
    '[]', '[]', '[]', 'test topic create', 'rules', NULL, ?)`)
    .bind(
      topicEventId,
      principalId,
      topicId,
      parentTopicId,
      displayName,
      displayName.normalize("NFC").toLocaleLowerCase("en-US"),
      nextTimestamp(),
    ).run();
  return topicId;
}

async function renameTopic(
  principalId: string,
  topicId: Ulid,
  previousName: string,
  nextName: string,
  aliasPath: string,
): Promise<void> {
  const topicEventId = newUlid();
  const alias = [{
    aliasId: newUlid(),
    topicId,
    displayName: aliasPath.split("/").at(-1) ?? previousName,
    normalizedName: (aliasPath.split("/").at(-1) ?? previousName)
      .normalize("NFC").toLocaleLowerCase("en-US"),
    pathAlias: aliasPath,
  }];
  await env.DB.prepare(`INSERT INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation,
    previous_parent_topic_id, new_parent_topic_id,
    previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 'rename', NULL, NULL, ?, ?, ?, ?, NULL,
    '[]', '[]', ?, 'test topic rename', 'rules', NULL, ?)`)
    .bind(
      topicEventId,
      principalId,
      topicId,
      previousName,
      previousName.normalize("NFC").toLocaleLowerCase("en-US"),
      nextName,
      nextName.normalize("NFC").toLocaleLowerCase("en-US"),
      JSON.stringify(alias),
      nextTimestamp(),
    ).run();
}

async function mergeTopic(
  principalId: string,
  sourceTopicId: Ulid,
  sourceName: string,
  targetTopicId: Ulid,
): Promise<void> {
  const topicEventId = newUlid();
  const alias = [{
    aliasId: newUlid(),
    topicId: targetTopicId,
    displayName: sourceName,
    normalizedName: sourceName.normalize("NFC").toLocaleLowerCase("en-US"),
    pathAlias: `${MEMORY_ROOT_DISPLAY_NAME}/${sourceName}`,
  }];
  await env.DB.prepare(`INSERT INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation,
    previous_parent_topic_id, new_parent_topic_id,
    previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 'merge', NULL, NULL, ?, ?, NULL, NULL, ?,
    '[]', '[]', ?, 'test topic merge', 'rules', NULL, ?)`)
    .bind(
      topicEventId,
      principalId,
      sourceTopicId,
      sourceName,
      sourceName.normalize("NFC").toLocaleLowerCase("en-US"),
      targetTopicId,
      JSON.stringify(alias),
      nextTimestamp(),
    ).run();
}

async function seedRawInitial(
  input: CommitInitialMemoryInput,
  options: Readonly<{
    textHash?: Sha256Hex;
    sourceOccurredAt?: string;
    includePlacement?: boolean;
  }> = {},
): Promise<void> {
  const createdAt = new Date().toISOString();
  const source = input.sources[0];
  if (source === undefined) throw new Error("memory_repository_test_source_missing");
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        input.itemId,
        input.principalId,
        input.kind,
        input.creationEventId,
        input.creationEventSequence,
        createdAt,
      ),
    env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, ?, 'NFC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        input.version.versionId,
        input.principalId,
        input.itemId,
        input.version.text,
        options.textHash ?? input.version.textHash,
        input.version.basis,
        input.version.origin,
        input.version.uncertain ? 1 : 0,
        input.version.sensitivity,
        input.version.validFrom,
        input.version.validTo,
        input.version.extractorVersion,
        input.version.extractorModelId,
        createdAt,
      ),
    env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        source.sourceId,
        input.principalId,
        input.itemId,
        input.version.versionId,
        source.eventId,
        source.eventSequence,
        source.sourceLocation,
        source.r2SegmentId,
        source.excerpt,
        source.excerptHash,
        source.channel,
        options.sourceOccurredAt ?? source.occurredAt,
        createdAt,
      ),
    env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 'rules', ?, NULL, ?)`)
      .bind(
        input.transition.transitionId,
        input.principalId,
        input.itemId,
        input.version.versionId,
        input.transition.lifecycleState,
        input.transition.reason,
        input.transition.policyVersion,
        createdAt,
      ),
  ];
  if (options.includePlacement !== false) {
    statements.push(env.DB.prepare(`INSERT INTO memory_item_placement_events (
      placement_event_id, principal_id, placement_id, placement_event_number, item_id,
      operation, previous_topic_id, new_topic_id, relation, filing_source,
      confidence, reason, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'place', NULL, ?, 'primary', ?, ?, ?, NULL, ?)`)
      .bind(
        input.placement.placementEventId,
        input.principalId,
        input.placement.placementId,
        input.itemId,
        input.placement.topicId,
        input.placement.filingSource,
        input.placement.confidence,
        input.placement.reason,
        createdAt,
      ));
  }
  await env.DB.batch(statements);
}

beforeAll(async () => {
  await applyMemoryIngressMigration();
});

describe("MemoryRepository", () => {
  it("bootstraps exactly one canonical root and one explicit inbox idempotently", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);

    const first = await repository.bootstrapTopics(principalId);
    const replay = await repository.bootstrapTopics(principalId);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.root.displayName).toBe(MEMORY_ROOT_DISPLAY_NAME);
    expect(first.inbox.displayName).toBe(MEMORY_INBOX_DISPLAY_NAME);
    const rows = await env.DB.prepare(`SELECT topic_id, parent_topic_id, display_name
      FROM memory_topics WHERE principal_id = ? ORDER BY parent_topic_id NULLS FIRST`)
      .bind(principalId).all();
    expect(rows.results).toEqual([
      { topic_id: first.root.topicId, parent_topic_id: null, display_name: MEMORY_ROOT_DISPLAY_NAME },
      { topic_id: first.inbox.topicId, parent_topic_id: first.root.topicId, display_name: MEMORY_INBOX_DISPLAY_NAME },
    ]);
    const events = await env.DB.prepare(`SELECT actor, operation FROM memory_topic_events
      WHERE principal_id = ? ORDER BY occurred_at, topic_event_id`).bind(principalId).all();
    expect(events.results).toEqual([
      { actor: "rules", operation: "create" },
      { actor: "rules", operation: "create" },
    ]);
  });

  it("refuses automatic creation deeper than four areas without creating a partial path", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    await repository.bootstrapTopics(principalId);

    const result = await repository.resolveOrCreateAutomaticTopicPath(
      principalId,
      ["One", "Two", "Three", "Four", "Five"],
      6,
    );

    expect(result).toEqual({ topic: null, createdTopicCount: 0, cappedBy: "depth" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_topics WHERE principal_id = ?")
      .bind(principalId).first()).toEqual({ count: 2 });
  });

  it("checks folded separators and removes default-ignorable name characters", async () => {
    expect(normalizeAutomaticTopicPath(["School ＞ Chemistry"])).toBeNull();
    expect(normalizeAutomaticTopicPath(["School／Chemistry"])).toBeNull();
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const heart = await createTopic(principalId, topics.root.topicId, "Music ❤");
    const school = await createTopic(principalId, topics.root.topicId, "School");

    const variation = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["Music ❤️"], 0);
    const filler = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["Schoㅤol"], 0);

    expect(variation).toMatchObject({ topic: { topicId: heart } });
    expect(filler).toMatchObject({ topic: { topicId: school } });
  });

  it("rejects format and bidi controls on display names while keeping emoji joiners and variation selectors", () => {
    const forbidden = [
      "\u061c", "\u200b", "\u200c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d",
      "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\ufeff", String.fromCodePoint(0xe0000),
      String.fromCodePoint(0xe007f),
    ];
    for (const control of forbidden) {
      expect(normalizeAutomaticTopicPath([`School${control}`])).toBeNull();
    }
    expect(normalizeAutomaticTopicPath(["\u3164"])).toBeNull();
    const emoji = "Projects \u{1f469}\u200d\u{1f4bb} \u2764\ufe0f";
    expect(normalizeAutomaticTopicPath([emoji])).toEqual([emoji]);
  });

  it("keeps the canonical root and inbox identities after both display names are renamed", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const first = await repository.bootstrapTopics(principalId);
    await renameTopic(principalId, first.root.topicId, MEMORY_ROOT_DISPLAY_NAME, "Personal memory", "Memory");
    await renameTopic(
      principalId,
      first.inbox.topicId,
      MEMORY_INBOX_DISPLAY_NAME,
      "To sort later",
      "Personal memory/Inbox / Needs filing",
    );

    const replay = await repository.bootstrapTopics(principalId);

    expect(replay).toEqual({
      root: { topicId: first.root.topicId, displayName: "Personal memory" },
      inbox: { topicId: first.inbox.topicId, displayName: "To sort later" },
      replayed: true,
    });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_topics WHERE principal_id = ?")
      .bind(principalId).first()).toEqual({ count: 2 });
  });

  it("atomically commits and canonically reads an item, version, exact source, transition and primary placement", async () => {
    const prepared = await fixture();

    const result = await prepared.repository.commitInitialItem(prepared.input);

    expect(result.replayed).toBe(false);
    expect(result.item).toMatchObject({
      principalId: prepared.principalId,
      itemId: prepared.input.itemId,
      kind: "preference",
      version: {
        versionId: prepared.input.version.versionId,
        text: prepared.input.version.text,
        basis: "stated",
        origin: "authenticated_first_person",
        uncertain: false,
      },
      lifecycle: { state: "active", actor: "rules" },
      primaryPlacement: { topicId: prepared.input.placement.topicId, filingSource: "rule" },
    });
    expect(result.item.sources).toEqual([expect.objectContaining({
      eventId: prepared.source.eventId,
      eventSequence: prepared.source.sequence,
      excerpt: prepared.input.version.text,
    })]);
    expect(result.item.topicPath.map((entry) => entry.displayName)).toEqual([
      MEMORY_ROOT_DISPLAY_NAME,
      MEMORY_INBOX_DISPLAY_NAME,
    ]);
  });

  it("replays exact material and refuses a reused identity with different material", async () => {
    const prepared = await fixture();
    await prepared.repository.commitInitialItem(prepared.input);

    const replay = await prepared.repository.commitInitialItem(prepared.input);
    const changedText = "I prefer long reports.";
    const conflicting: CommitInitialMemoryInput = {
      ...prepared.input,
      version: {
        ...prepared.input.version,
        text: changedText,
        textHash: await sha256Hex(changedText),
      },
    };

    expect(replay.replayed).toBe(true);
    await expectCode(prepared.repository.commitInitialItem(conflicting), "memory_refused");
    await expect(prepared.repository.readCurrentItem(prepared.principalId, prepared.input.itemId))
      .resolves.toMatchObject({ version: { text: prepared.input.version.text } });
  });

  it("replays equivalent automatic filing reasons after the created area is renamed", async () => {
    const prepared = await fixture();
    const path = ["School"];
    const automaticInput: CommitInitialMemoryInput = {
      ...prepared.input,
      placement: {
        ...prepared.input.placement,
        topicId: (await prepared.repository.bootstrapTopics(prepared.principalId)).inbox.topicId,
        filingSource: "rule",
        confidence: 0.9,
        reason: automaticFilingReason("inbox_filing_failure", path),
      },
      automaticFiling: {
        topicPath: path,
        maximumNewTopics: 1,
        inboxTopicId: (await prepared.repository.bootstrapTopics(prepared.principalId)).inbox.topicId,
      },
    };
    const first = await prepared.repository.commitInitialItem(automaticInput);
    await renameTopic(
      prepared.principalId,
      first.item.primaryPlacement.topicId,
      "School",
      "Academics",
      "Memory/School",
    );

    const replay = await prepared.repository.commitInitialItem(automaticInput);

    expect(first).toMatchObject({ replayed: false, automaticFilingCreatedTopicCount: 1 });
    expect(replay).toMatchObject({ replayed: true, automaticFilingCreatedTopicCount: 0 });
    expect(replay.item.primaryPlacement.reason).toContain('"decision":"filed_created"');
  });

  it("accepts a verified archived receipt only as an uncertain proposed item", async () => {
    const principalId = await seedPrincipal();
    const archived = await seedArchivedReceipt(principalId);
    const repository = new MemoryRepository(env.DB, { archivedEventReader: archived.reader });
    const topics = await repository.bootstrapTopics(principalId);
    const base = await inputForArchived(principalId, archived, topics.inbox.topicId);

    const result = await repository.commitInitialItem(base);

    expect(result.item).toMatchObject({
      principalId,
      version: { basis: "inferred", origin: "model", uncertain: true },
      lifecycle: { state: "proposed" },
      sources: [{ sourceLocation: "archived", r2SegmentId: archived.segmentId }],
    });
  });

  it("caches one archived creation and source receipt per event in the batched reader", async () => {
    const principalId = await seedPrincipal();
    const archived = await seedArchivedReceipt(principalId);
    let archivedReads = 0;
    const reader: ArchivedEventReader = {
      async readArchivedRange(afterSequence, limit) {
        archivedReads += 1;
        return archived.reader.readArchivedRange(afterSequence, limit);
      },
    };
    const repository = new MemoryRepository(env.DB, { archivedEventReader: reader });
    const topics = await repository.bootstrapTopics(principalId);
    const input = await inputForArchived(principalId, archived, topics.inbox.topicId);
    await repository.commitInitialItem(input);
    archivedReads = 0;

    const batched = await repository.readCurrentItemsWithVisibility(principalId, [input.itemId]);
    const batchedReads = archivedReads;
    const [item, visibility] = await Promise.all([
      repository.readCurrentItem(principalId, input.itemId),
      repository.readItemVisibility(principalId, input.itemId),
    ]);

    expect(batched).toEqual([{ item, visibility }]);
    expect(batchedReads).toBe(1);
  });

  it("continues reading an immutable live source after its event moves to an archive segment", async () => {
    const prepared = await fixture();
    await prepared.repository.commitInitialItem(prepared.input);
    const archived = await archiveExistingLiveReceipt(prepared.source);
    const repository = new MemoryRepository(env.DB, { archivedEventReader: archived.reader });

    try {
      await expect(repository.readCurrentItem(prepared.principalId, prepared.input.itemId))
        .resolves.toMatchObject({
          version: { text: prepared.input.version.text },
          sources: [{
            eventId: prepared.source.eventId,
            eventSequence: prepared.source.sequence,
            sourceLocation: "archived",
            r2SegmentId: archived.segmentId,
            excerpt: prepared.input.version.text,
          }],
        });
    } finally {
      await cleanupHandoffArchive(archived.segmentId);
    }
  });

  it("validates a remembered owner turn from its verified archive event after live purge", async () => {
    const principalId = await seedPrincipal("human");
    const text = "Please remember that archived controls still work.";
    const source = await seedEvent(principalId, text);
    const archived = await archiveExistingLiveReceipt(source);
    const repository = new MemoryRepository(env.DB, { archivedEventReader: archived.reader });

    try {
      await expect(repository.validateOwnerTurn({
        principalId,
        eventId: source.eventId,
        eventSequence: source.sequence,
        occurredAt: source.occurredAt,
        channel: "telegram",
        memoryIntent: "remember",
        forwarded: false,
        quoted: false,
        pasted: false,
        hasAttachment: false,
        modelGenerated: false,
        toolGenerated: false,
        guest: false,
      }, "remember")).resolves.toBe(text);
    } finally {
      await cleanupHandoffArchive(archived.segmentId);
    }
  });

  it("binds archived receipts to their subject principal", async () => {
    const principalId = await seedPrincipal();
    const otherPrincipalId = await seedPrincipal();
    const archived = await seedArchivedReceipt(otherPrincipalId);
    const repository = new MemoryRepository(env.DB, { archivedEventReader: archived.reader });
    const topics = await repository.bootstrapTopics(principalId);
    const foreign = await inputForArchived(principalId, archived, topics.inbox.topicId);

    await expectCode(repository.commitInitialItem(foreign), "memory_refused");
  });

  it("binds archived receipts to their exact archived occurrence time", async () => {
    const principalId = await seedPrincipal();
    const ownArchived = await seedArchivedReceipt(principalId);
    const ownRepository = new MemoryRepository(env.DB, { archivedEventReader: ownArchived.reader });
    const topics = await ownRepository.bootstrapTopics(principalId);
    const valid = await inputForArchived(principalId, ownArchived, topics.inbox.topicId);
    const stale: CommitInitialMemoryInput = {
      ...valid,
      sources: [{
        ...valid.sources[0]!,
        occurredAt: new Date(Date.parse(ownArchived.occurredAt) + 1_000).toISOString(),
      }],
    };
    await expectCode(ownRepository.commitInitialItem(stale), "memory_refused");
  });

  it("refuses a live source whose claimed channel differs from the event-derived channel", async () => {
    const prepared = await fixture();
    const mismatched: CommitInitialMemoryInput = {
      ...prepared.input,
      sources: [{ ...prepared.input.sources[0]!, channel: "voice" }],
    };

    await expectCode(prepared.repository.commitInitialItem(mismatched), "memory_refused");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_items WHERE item_id = ?")
      .bind(prepared.input.itemId).first()).toEqual({ count: 0 });
  });

  it("resolves a current active path before aliases and repeated aliases newest first", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const earlier = await createTopic(principalId, topics.root.topicId, "Earlier");
    await renameTopic(principalId, earlier, "Earlier", "Renamed earlier", "Memory/Shared");
    const current = await createTopic(principalId, topics.root.topicId, "Shared");
    await renameTopic(principalId, earlier, "Renamed earlier", "Earlier final", "Memory/Shared");

    const currentWinner = await repository.resolveTopicPath(principalId, ["Memory", "Shared"]);
    expect(currentWinner).toMatchObject({ topicId: current, matchedBy: "current" });

    await renameTopic(principalId, current, "Shared", "Current final", "Memory/Shared");
    const aliasWinner = await repository.resolveTopicPath(principalId, ["Memory", "Shared"]);
    expect(aliasWinner).toMatchObject({ topicId: current, matchedBy: "alias" });
  });

  it("chooses the oldest NFKC-equal sibling when no exact current name exists", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const oldest = await createTopic(principalId, topics.root.topicId, "ﬁnance");
    await createTopic(principalId, topics.root.topicId, "Finance");

    const resolved = await repository.resolveOrCreateAutomaticTopicPath(
      principalId,
      ["ＦＩＮＡＮＣＥ"],
      0,
    );

    expect(resolved).toMatchObject({ topic: { topicId: oldest, matchedBy: "current" } });
  });

  it("prefers an exact current name before an older NFKC-folded sibling", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    await createTopic(principalId, topics.root.topicId, "ﬁnance");
    const exact = await createTopic(principalId, topics.root.topicId, "Finance");

    const resolved = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["Finance"], 0);

    expect(resolved).toMatchObject({ topic: { topicId: exact, matchedBy: "current" } });
  });

  it("NFKC-folds stored sibling aliases without rewriting existing rows", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const chemistry = await createTopic(principalId, topics.root.topicId, "Chem");
    await renameTopic(principalId, chemistry, "Chem", "Chemistry", "Memory/ＣＨＥＭ");

    const resolved = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["chem"], 0);

    expect(resolved).toMatchObject({ topic: { topicId: chemistry, matchedBy: "alias" } });
  });

  it("prefers an exact sibling alias before a newer NFKC-folded alias", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const exact = await createTopic(principalId, topics.root.topicId, "Exact alias source");
    await renameTopic(principalId, exact, "Exact alias source", "Exact alias target", "Memory/Finance");
    const folded = await createTopic(principalId, topics.root.topicId, "Folded alias source");
    await renameTopic(principalId, folded, "Folded alias source", "Folded alias target", "Memory/ﬁnance");

    const resolved = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["Finance"], 0);

    expect(resolved).toMatchObject({ topic: { topicId: exact, matchedBy: "alias" } });
  });

  it("checks the byte bound after each round-robin child while keeping every top-level area", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    for (let index = 0; index < 40; index += 1) {
      const top = await createTopic(
        principalId,
        topics.root.topicId,
        `Top ${index.toString().padStart(2, "0")} ${"x".repeat(50)}`,
      );
      await createTopic(principalId, top, `Child ${index.toString().padStart(2, "0")} ${"y".repeat(48)}`);
    }

    const tree = await repository.readAutomaticTopicPromptTree(principalId);
    const encodedBytes = new TextEncoder().encode(canonicalJson(tree)).byteLength;

    expect(encodedBytes).toBeLessThanOrEqual(AUTOMATIC_TOPIC_PROMPT_TREE_BYTES);
    expect(tree).toHaveLength(40);
    expect(tree.flatMap(([, children]) => children).length).toBeGreaterThan(0);
    expect(tree.flatMap(([, children]) => children).length).toBeLessThan(40);
    expect(tree.flatMap(([, children]) => children)).not.toContain(MEMORY_INBOX_DISPLAY_NAME);
  });

  it("follows a merged sibling alias during automatic path resolution", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const retired = await createTopic(principalId, topics.root.topicId, "Retired area");
    const survivor = await createTopic(principalId, topics.root.topicId, "Current area");
    await mergeTopic(principalId, retired, "Retired area", survivor);

    const resolved = await repository.resolveOrCreateAutomaticTopicPath(
      principalId,
      ["Retired area"],
      0,
    );

    expect(resolved).toMatchObject({
      topic: { topicId: survivor, matchedBy: "alias" },
      createdTopicCount: 0,
      cappedBy: null,
    });
  });

  it("follows merge redirects and fails closed when their bound is exceeded", async () => {
    const principalId = await seedPrincipal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const chain: Ulid[] = [];
    for (let index = 0; index < 66; index += 1) {
      chain.push(await createTopic(principalId, topics.root.topicId, `Chain ${index}`));
    }
    const first = chain[0];
    if (first === undefined) throw new Error("memory_repository_test_chain_missing");
    await renameTopic(principalId, first, "Chain 0", "Chain start", "Memory/Retired chain");
    for (let index = 0; index < chain.length - 1; index += 1) {
      const source = chain[index];
      const target = chain[index + 1];
      if (source === undefined || target === undefined) throw new Error("memory_repository_test_chain_missing");
      await mergeTopic(principalId, source, index === 0 ? "Chain start" : `Chain ${index}`, target);
    }

    await expectCode(
      repository.resolveTopicPath(principalId, ["Memory", "Retired chain"]),
      "memory_corrupt",
    );
  });

  it("allows up to 128 combined redirect and parent steps in a batched topic walk", async () => {
    const prepared = await fixture();
    const topics = await prepared.repository.bootstrapTopics(prepared.principalId);
    let parentTopicId = topics.root.topicId;
    for (let index = 0; index < 40; index += 1) {
      parentTopicId = await createTopic(prepared.principalId, parentTopicId, `Deep parent ${index}`);
    }
    const redirects: Ulid[] = [];
    for (let index = 0; index < 40; index += 1) {
      redirects.push(await createTopic(prepared.principalId, topics.root.topicId, `Redirect ${index}`));
    }
    const firstRedirect = redirects[0];
    if (firstRedirect === undefined) throw new Error("memory_repository_redirect_fixture_missing");
    for (let index = 0; index < redirects.length; index += 1) {
      const source = redirects[index];
      const target = redirects[index + 1] ?? parentTopicId;
      if (source === undefined) throw new Error("memory_repository_redirect_fixture_missing");
      await mergeTopic(prepared.principalId, source, `Redirect ${index}`, target);
    }
    await prepared.repository.commitInitialItem({
      ...prepared.input,
      placement: { ...prepared.input.placement, topicId: parentTopicId },
    });
    const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND tbl_name IN (
        'memory_item_placement_state', 'memory_item_placement_events'
      )`).all<{ name: string; sql: string }>();
    for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER ${guard.name}`).run();
    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE memory_item_placement_state SET topic_id = ?
          WHERE principal_id = ? AND placement_id = ?`)
          .bind(firstRedirect, prepared.principalId, prepared.input.placement.placementId),
        env.DB.prepare(`UPDATE memory_item_placement_events SET new_topic_id = ?
          WHERE principal_id = ? AND placement_event_id = ?`)
          .bind(firstRedirect, prepared.principalId, prepared.input.placement.placementEventId),
      ]);
    } finally {
      for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
    }

    const [read] = await prepared.repository.readCurrentItemsWithVisibility(
      prepared.principalId,
      [prepared.input.itemId],
    );

    expect(read?.item.topicPath).toHaveLength(41);
    expect(read?.item.topicPath.at(-1)?.displayName).toBe("Deep parent 39");
  });

  it("fails closed on incomplete rows, hash mismatches and source timestamp mismatches", async () => {
    const incomplete = await fixture();
    await seedRawInitial(incomplete.input, { includePlacement: false });
    await expectCode(
      incomplete.repository.readCurrentItem(incomplete.principalId, incomplete.input.itemId),
      "memory_corrupt",
    );

    const badHash = await fixture();
    await seedRawInitial(badHash.input, { textHash: "0".repeat(64) as Sha256Hex });
    await expectCode(
      badHash.repository.readCurrentItem(badHash.principalId, badHash.input.itemId),
      "memory_corrupt",
    );

    const badTimestamp = await fixture();
    await seedRawInitial(badTimestamp.input, {
      sourceOccurredAt: new Date(Date.parse(badTimestamp.source.occurredAt) + 1_000).toISOString(),
    });
    await expectCode(
      badTimestamp.repository.readCurrentItem(badTimestamp.principalId, badTimestamp.input.itemId),
      "memory_corrupt",
    );
  });

  it("fails closed when D1 returns a canonical row with a missing field", async () => {
    const prepared = await fixture();
    await prepared.repository.commitInitialItem(prepared.input);
    const malformed = new MemoryRepository(databaseWithMalformedCanonicalRow(env.DB));

    await expectCode(
      malformed.readCurrentItem(prepared.principalId, prepared.input.itemId),
      "memory_corrupt",
    );
  });

  it("keeps item reads scoped to the authenticated principal", async () => {
    const prepared = await fixture();
    await prepared.repository.commitInitialItem(prepared.input);
    const otherPrincipalId = await seedPrincipal();

    await expectCode(
      prepared.repository.readCurrentItem(otherPrincipalId, prepared.input.itemId),
      "memory_not_found",
    );
  });

  it("maps D1 diagnostics to one stable non-secret unavailable outcome", async () => {
    const canary = "private database detail 59304";
    const unavailable = new Proxy(env.DB, {
      get(target, property, receiver): unknown {
        if (property === "prepare") return (): never => { throw new Error(canary); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const repository = new MemoryRepository(unavailable);

    const error = await expectCode(
      repository.readCurrentItem("principal:missing", newUlid()),
      "memory_unavailable",
    );
    expect(error.message).not.toContain(canary);
  });
});

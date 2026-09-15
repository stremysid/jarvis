import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  newUlid,
  sha256Hex,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
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
}

let principalSerial = 0;
let topicClock = Date.now() + 1_000;

function nextTimestamp(): string {
  topicClock += 10;
  return new Date(topicClock).toISOString();
}

async function seedPrincipal(): Promise<string> {
  principalSerial += 1;
  const principalId = `principal:memory-runtime:${principalSerial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'service', 'active', 'memory runtime test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

async function seedEvent(principalId: string): Promise<SeededEvent> {
  const eventId = newUlid();
  const occurredAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'jarvis.conversation', ?, ?, ?, ?, '{}', ?)`)
    .bind(eventId, principalId, occurredAt, occurredAt, await sha256Hex("{}"), occurredAt).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_repository_test_event_missing");
  return { eventId, sequence: row.sequence, occurredAt };
}

async function seedArchivedReceipt(): Promise<ArchivedReceipt> {
  const eventId = newUlid();
  const eventSequence = 1;
  const occurredAt = new Date().toISOString();
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
        await sha256Hex(`envelope:${eventId}`),
        await sha256Hex(`content:${eventId}`),
        occurredAt,
      ),
  ]);
  return { eventId, sequence: eventSequence, occurredAt, segmentId };
}

async function fixture(repository = new MemoryRepository(env.DB)): Promise<Fixture> {
  const principalId = await seedPrincipal();
  const source = await seedEvent(principalId);
  const topics = await repository.bootstrapTopics(principalId);
  const text = "I prefer short reports.";
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

  it("accepts a verified archived receipt only as an uncertain proposed item", async () => {
    const principalId = await seedPrincipal();
    const archived = await seedArchivedReceipt();
    const repository = new MemoryRepository(env.DB);
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

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import cloudMemorySql from "../../src/persistence/migrations/0016_cloud_memory.sql?raw";
import { applyCloudMemoryMigration } from "./migration.js";

const testClock = Date.now();
const timestamp = new Date(testClock - 60_000).toISOString();
const laterTimestamp = new Date(testClock).toISOString();
const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 1;

function nextUlid(): string {
  let value = serial;
  serial += 1;
  let suffix = "";
  for (let index = 0; index < 18; index += 1) {
    const digit = crockford[value % crockford.length];
    if (digit === undefined) throw new Error("memory_test_ulid_digit_missing");
    suffix = `${digit}${suffix}`;
    value = Math.floor(value / crockford.length);
  }
  return `01k3w1t4${suffix}`;
}

function nextHash(): string {
  const value = serial.toString(16);
  return value.padStart(64, "0");
}

interface TestPrincipal {
  readonly principalId: string;
  readonly principalType: "human" | "service";
}

interface TestEvent {
  readonly eventId: string;
  readonly sequence: number;
}

interface TestItem {
  readonly itemId: string;
  readonly versionId: string;
  readonly sourceId: string;
  readonly transitionId: string;
}

async function seedPrincipal(principalType: "human" | "service" = "human"): Promise<TestPrincipal> {
  const principalId = `principal:memory:${nextUlid()}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, ?, 'active', 'memory schema test', ?, ?)`)
    .bind(principalId, principalType, timestamp, timestamp).run();
  return { principalId, principalType };
}

async function seedEvent(
  principalId: string,
  eventType = "conversation.user_committed",
  occurredAt = timestamp,
): Promise<TestEvent> {
  const eventId = nextUlid();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, 'jarvis.conversation', ?, ?, ?, ?, '{}', ?)`)
    .bind(eventId, eventType, principalId, occurredAt, timestamp, nextHash(), timestamp).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_test_event_missing");
  return { eventId, sequence: row.sequence };
}

async function seedOwnerCommand(
  principalId: string,
  operation: string,
  targetId: string,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<TestEvent> {
  const eventId = nextUlid();
  const contentHash = nextHash();
  const envelope = {
    eventId,
    correlationId: eventId,
    eventType: "memory.owner_command",
    source: "memory-control",
    subjectId: principalId,
    occurredAt: timestamp,
    receivedAt: timestamp,
    contentHash,
    producerVersion: "memory-control-v1",
    payload: { operation, targetId, ...fields },
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'memory.owner_command', 'memory-control', ?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId, principalId, timestamp, timestamp, contentHash,
      JSON.stringify(envelope), timestamp,
    ).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_test_owner_command_missing");
  return { eventId, sequence: row.sequence };
}

async function seedActiveItem(
  principalId: string,
  source: TestEvent,
  initialLifecycleState: "active" | "proposed" = "active",
): Promise<TestItem> {
  const itemId = nextUlid();
  const versionId = nextUlid();
  const sourceId = nextUlid();
  const transitionId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_items (
    item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
  ) VALUES (?, ?, 'preference', ?, ?, ?)`)
    .bind(itemId, principalId, source.eventId, source.sequence, timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_item_versions (
    version_id, principal_id, item_id, version_number, text, text_normalization,
    text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
    extractor_version, extractor_model_id, created_at
  ) VALUES (?, ?, ?, 1, 'I prefer short reports.', 'NFC', ?, 'stated',
    'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
    .bind(versionId, principalId, itemId, nextHash(), timestamp).run();
  await env.DB.prepare(`INSERT INTO memory_item_sources (
    source_id, principal_id, item_id, version_id, source_position, event_id,
    event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
    channel, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'I prefer short reports.', ?,
    'telegram', ?, ?)`)
    .bind(
      sourceId, principalId, itemId, versionId, source.eventId,
      source.sequence, nextHash(), timestamp, timestamp,
    ).run();
  await env.DB.prepare(`INSERT INTO memory_item_transitions (
    transition_id, principal_id, item_id, transition_number, version_id,
    lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 1, ?, ?, 'deterministic promotion', 'rules',
    'policy-v1', NULL, ?)`)
    .bind(
      transitionId, principalId, itemId, versionId, initialLifecycleState, timestamp,
    ).run();
  return { itemId, versionId, sourceId, transitionId };
}

function migrationTriggerSql(name: string): string {
  const sql = cloudMemorySql.replaceAll("\r\n", "\n");
  const marker = `CREATE TRIGGER ${name}\n`;
  const start = sql.indexOf(marker);
  const end = sql.indexOf("\nEND;", start);
  if (start < 0 || end < 0) throw new Error(`memory_test_trigger_missing:${name}`);
  return sql.slice(start, end + "\nEND;".length);
}

interface OwnerTransitionInput {
  readonly principalId: string;
  readonly itemId: string;
  readonly versionId: string;
  readonly transitionNumber: number;
  readonly lifecycleState: "proposed" | "active" | "rejected" | "superseded" | "forgotten" | "expired";
  readonly operation?: "item.transition" | "item.correct" | "item.forget";
  readonly commandFields?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}

async function insertOwnerTransition(input: OwnerTransitionInput): Promise<string> {
  const transitionId = nextUlid();
  const command = await seedOwnerCommand(
    input.principalId,
    input.operation ?? "item.transition",
    transitionId,
    {
      itemId: input.itemId,
      versionId: input.versionId,
      lifecycleState: input.lifecycleState,
      ...input.commandFields,
    },
  );
  await env.DB.prepare(`INSERT INTO memory_item_transitions (
    transition_id, principal_id, item_id, transition_number, version_id,
    lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'owner transition test', 'owner',
    'policy-v1', ?, ?)`)
    .bind(
      transitionId,
      input.principalId,
      input.itemId,
      input.transitionNumber,
      input.versionId,
      input.lifecycleState,
      command.eventId,
      input.occurredAt ?? laterTimestamp,
    ).run();
  return transitionId;
}

interface ArchivedReceipt {
  readonly eventId: string;
  readonly eventSequence: number;
  readonly segmentId: string;
}

async function seedArchivedReceipt(): Promise<ArchivedReceipt> {
  const state = await env.DB.prepare("SELECT sealed_through FROM archive_state WHERE singleton = 1")
    .first<{ sealed_through: number }>();
  if (state === null) throw new Error("memory_archive_state_missing");
  const eventSequence = state.sealed_through + 1;
  const manifestId = nextHash();
  const segmentId = nextHash();
  const eventId = nextUlid();
  await env.DB.prepare(`INSERT INTO archive_manifests (
    manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at
  ) VALUES (?, ?, ?, 1, 'sealed', ?, ?)`)
    .bind(manifestId, eventSequence, eventSequence, timestamp, timestamp).run();
  await env.DB.prepare(`INSERT INTO archive_segments (
    segment_id, manifest_id, object_key, compressed_sha256,
    compressed_byte_length, uncompressed_byte_length, codec, created_at
  ) VALUES (?, ?, ?, ?, 1, 1, 'jarvis-gzip-ndjson-v1', ?)`)
    .bind(
      segmentId,
      manifestId,
      `memory-test/${segmentId}`,
      nextHash(),
      timestamp,
    ).run();
  await env.DB.prepare(`INSERT INTO archive_segment_events (
    event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(eventSequence, eventId, segmentId, nextHash(), nextHash(), timestamp).run();
  await env.DB.prepare(`UPDATE archive_state
    SET sealed_through = ?, updated_at = ? WHERE singleton = 1`)
    .bind(eventSequence, timestamp).run();
  return { eventId, eventSequence, segmentId };
}

interface TopicEventInput {
  readonly topicEventId?: string;
  readonly principalId: string;
  readonly topicId: string;
  readonly operation: "create" | "rename" | "move" | "merge";
  readonly previousParentTopicId?: string | null;
  readonly newParentTopicId?: string | null;
  readonly previousDisplayName?: string | null;
  readonly previousNormalizedName?: string | null;
  readonly newDisplayName?: string | null;
  readonly newNormalizedName?: string | null;
  readonly mergeTargetTopicId?: string | null;
  readonly reparentedChildIds?: readonly string[];
  readonly movedPlacementIds?: readonly string[];
  readonly addedAliases?: readonly Readonly<Record<string, string>>[];
  readonly actor?: "owner" | "rules" | "model";
  readonly ownerAuthorizingEventId?: string | null;
  readonly occurredAt?: string;
}

async function insertTopicEvent(input: TopicEventInput, orReplace = false): Promise<string> {
  const topicEventId = input.topicEventId ?? nextUlid();
  await env.DB.prepare(`INSERT ${orReplace ? "OR REPLACE " : ""}INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
    new_parent_topic_id, previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'topic test', ?, ?, ?)`)
    .bind(
      topicEventId,
      input.principalId,
      input.topicId,
      input.operation,
      input.previousParentTopicId ?? null,
      input.newParentTopicId ?? null,
      input.previousDisplayName ?? null,
      input.previousNormalizedName ?? null,
      input.newDisplayName ?? null,
      input.newNormalizedName ?? null,
      input.mergeTargetTopicId ?? null,
      JSON.stringify(input.reparentedChildIds ?? []),
      JSON.stringify(input.movedPlacementIds ?? []),
      JSON.stringify(input.addedAliases ?? []),
      input.actor ?? "rules",
      input.ownerAuthorizingEventId ?? null,
      input.occurredAt ?? timestamp,
    ).run();
  return topicEventId;
}

interface TriggerFixture {
  readonly ownerId: string;
  readonly source: TestEvent;
  readonly keys: Readonly<Record<string, string>>;
}

let triggerFixturePromise: Promise<TriggerFixture> | undefined;

function triggerFixture(): Promise<TriggerFixture> {
  triggerFixturePromise ??= seedTriggerFixture();
  return triggerFixturePromise;
}

async function seedTriggerFixture(): Promise<TriggerFixture> {
  const owner = await seedPrincipal();
  const source = await seedEvent(owner.principalId);
  const item = await seedActiveItem(owner.principalId, source);
  const secondSource = await seedEvent(owner.principalId);
  const secondItem = await seedActiveItem(owner.principalId, secondSource);

  const suppressionId = nextUlid();
  const suppressionCommand = await seedOwnerCommand(
    owner.principalId, "history.suppress", suppressionId,
    {
      targetEventId: secondSource.eventId,
      startEventSequence: null,
      endEventSequence: null,
      newlyHiddenTurnCount: 1,
      totalCoveredTurnCount: 1,
    },
  );
  await env.DB.prepare(`INSERT INTO memory_event_suppressions (
    suppression_id, principal_id, target_event_id, start_event_sequence,
    end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
    source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
  ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'fixture hide', 1, 1, ?)`)
    .bind(
      suppressionId, owner.principalId, secondSource.eventId,
      suppressionCommand.eventId, timestamp,
    ).run();
  const liftId = nextUlid();
  const liftCommand = await seedOwnerCommand(
    owner.principalId,
    "history.lift",
    liftId,
    { suppressionId },
  );
  await env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
    lift_id, principal_id, suppression_id, owner_authorizing_event_id,
    correction_transition_id, reason, created_at
  ) VALUES (?, ?, ?, ?, NULL, 'fixture lift', ?)`)
    .bind(liftId, owner.principalId, suppressionId, liftCommand.eventId, laterTimestamp).run();

  const linkId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_item_links (
    link_id, principal_id, source_item_id, target_item_id, link_type,
    authorizing_transition_id, created_at
  ) VALUES (?, ?, ?, ?, 'related', ?, ?)`)
    .bind(
      linkId, owner.principalId, item.itemId, secondItem.itemId,
      item.transitionId, timestamp,
    ).run();

  const rootTopicId = nextUlid();
  await insertTopicEvent({
    principalId: owner.principalId,
    topicId: rootTopicId,
    operation: "create",
    newDisplayName: "Fixture",
    newNormalizedName: "fixture",
  });
  const topicId = nextUlid();
  await insertTopicEvent({
    principalId: owner.principalId,
    topicId,
    operation: "create",
    newParentTopicId: rootTopicId,
    newDisplayName: "Initial",
    newNormalizedName: "initial",
  });
  const aliasId = nextUlid();
  const topicEventId = await insertTopicEvent({
    principalId: owner.principalId,
    topicId,
    operation: "rename",
    previousDisplayName: "Initial",
    previousNormalizedName: "initial",
    newDisplayName: "Renamed",
    newNormalizedName: "renamed",
    addedAliases: [{
      aliasId,
      topicId,
      displayName: "Initial",
      normalizedName: "initial",
      pathAlias: "Fixture/Initial",
    }],
  });
  const placementId = nextUlid();
  const placementEventId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_item_placement_events (
    placement_event_id, principal_id, placement_id, placement_event_number,
    item_id, operation, previous_topic_id, new_topic_id, relation,
    filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 1, ?, 'place', NULL, ?, 'related', 'rule', 1.0,
    'fixture placement', NULL, ?)`)
    .bind(
      placementEventId, owner.principalId, placementId, item.itemId,
      topicId, timestamp,
    ).run();

  const episodeId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_episodes (
    episode_id, principal_id, local_day, start_event_sequence, end_event_sequence,
    source_count, text, content_hash, summarizer_version, summarizer_model_id,
    supersedes_episode_id, created_at
  ) VALUES (?, ?, '2026-09-14', ?, ?, 1, 'Fixture episode.', ?, 'summary-v1',
    'deepseek:deepseek-v4-pro', NULL, ?)`)
    .bind(
      episodeId, owner.principalId, source.sequence, source.sequence,
      nextHash(), timestamp,
    ).run();
  const episodeSourceId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_episode_sources (
    source_id, principal_id, episode_id, source_position, event_id, event_sequence,
    source_location, r2_segment_id, channel, occurred_at
  ) VALUES (?, ?, ?, 0, ?, ?, 'live', NULL, 'telegram', ?)`)
    .bind(
      episodeSourceId, owner.principalId, episodeId,
      source.eventId, source.sequence, timestamp,
    ).run();

  const coverageId = nextUlid();
  const coverageHash = nextHash();
  await env.DB.prepare(`INSERT INTO memory_history_coverage (
    coverage_id, principal_id, source_location, start_event_sequence,
    end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
    failure_code, indexed_at
  ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
    .bind(
      coverageId, owner.principalId, source.sequence, source.sequence,
      coverageHash, timestamp,
    ).run();
  const chunkId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_history_chunks (
    chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
    content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'fixture history', ?, 'live', NULL, ?, ?, ?)`)
    .bind(
      chunkId, owner.principalId, source.sequence, source.sequence,
      nextHash(), coverageHash, timestamp, timestamp,
    ).run();

  const vectorId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_vectors (
    vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
    dimensions, content_hash, mutation_id, upserted_at, deleted_at
  ) VALUES (?, ?, 'item', ?, '@cf/baai/bge-m3', 1024, ?, ?, ?, NULL)`)
    .bind(
      vectorId, owner.principalId, item.itemId, nextHash(),
      `mutation:${vectorId}`, timestamp,
    ).run();
  const priceId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_model_prices (
    price_id, principal_id, provider, model_id, effective_at,
    input_micros_per_million, output_micros_per_million,
    cache_read_micros_per_million, currency, source_receipt, created_at
  ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', ?, 1, 1, 0,
    'USD', 'fixture price', ?)`)
    .bind(priceId, owner.principalId, timestamp, timestamp).run();
  const runId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_runs (
    run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
    provider_model_id, price_id, outcome, started_at
  ) VALUES (?, ?, ?, 'distillation', ?, ?, 'deepseek:deepseek-v4-pro', ?,
    'running', ?)`)
    .bind(
      runId, owner.principalId, `fixture:${runId}`,
      source.sequence, source.sequence, priceId, timestamp,
    ).run();
  const costEntryId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_cost_ledger (
    cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
    provider, model_id, budget_class, reprocess_job_id, amount_micros,
    price_id, occurred_at
  ) VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:deepseek-v4-pro',
    'normal_monthly', NULL, 1, ?, ?)`)
    .bind(costEntryId, owner.principalId, runId, priceId, timestamp).run();

  const reprocessJobId = nextUlid();
  const reprocessCommand = await seedOwnerCommand(
    owner.principalId,
    "reprocess.create",
    reprocessJobId,
    {
      startEventSequence: source.sequence,
      endEventSequence: source.sequence,
      startDay: null,
      endDay: null,
      maximumEventCount: 1,
      providerModelId: "openai:gpt-memory",
      spendLimitMicros: 1,
      dryRun: 1,
    },
  );
  await env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
    job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
    end_event_sequence, start_day, end_day, maximum_event_count,
    provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
    status, final_receipt_hash, failure_code, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 'openai:gpt-memory', 1, 1,
    NULL, 'pending', NULL, NULL, ?, ?)`)
    .bind(
      reprocessJobId, owner.principalId, reprocessCommand.eventId,
      source.sequence, source.sequence, timestamp, timestamp,
    ).run();
  await env.DB.prepare(`INSERT INTO memory_cursors (
    principal_id, cursor_name, current_event_sequence, updated_at
  ) VALUES (?, 'fts_items', ?, ?)`)
    .bind(owner.principalId, source.sequence, timestamp).run();

  return {
    ownerId: owner.principalId,
    source,
    keys: {
      memory_items: item.itemId,
      memory_item_versions: item.versionId,
      memory_item_sources: item.sourceId,
      memory_item_transitions: item.transitionId,
      memory_item_state: item.itemId,
      memory_event_suppressions: suppressionId,
      memory_event_suppression_lifts: liftId,
      memory_item_links: linkId,
      memory_topic_events: topicEventId,
      memory_topics: topicId,
      memory_topic_aliases: aliasId,
      memory_item_placement_events: placementEventId,
      memory_item_placement_state: placementId,
      memory_episodes: episodeId,
      memory_episode_sources: episodeSourceId,
      memory_history_chunks: chunkId,
      memory_history_coverage: coverageId,
      memory_vectors: vectorId,
      memory_model_prices: priceId,
      memory_runs: runId,
      memory_reprocess_jobs: reprocessJobId,
      memory_cost_ledger: costEntryId,
      memory_cursors: owner.principalId,
    },
  };
}

const EXPECTED_TABLES = [
  "memory_cost_ledger",
  "memory_cursors",
  "memory_episode_sources",
  "memory_episodes",
  "memory_event_suppression_lifts",
  "memory_event_suppressions",
  "memory_history_chunks",
  "memory_history_coverage",
  "memory_item_links",
  "memory_item_placement_events",
  "memory_item_placement_state",
  "memory_item_sources",
  "memory_item_state",
  "memory_item_transitions",
  "memory_item_versions",
  "memory_items",
  "memory_model_prices",
  "memory_reprocess_jobs",
  "memory_runs",
  "memory_topic_aliases",
  "memory_topic_events",
  "memory_topics",
  "memory_vectors",
] as const;

describe.sequential("cloud memory migration", () => {
  beforeAll(async () => {
    await applyCloudMemoryMigration();
  });

  it("installs every table and FTS projection in the approved 0016 contract", async () => {
    const tables = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (${EXPECTED_TABLES.map(() => "?").join(", ")})
      ORDER BY name`).bind(...EXPECTED_TABLES).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([...EXPECTED_TABLES]);

    const fts = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN ('memory_item_fts', 'memory_episode_fts', 'memory_history_fts')
      ORDER BY name`).all<{ name: string }>();
    expect(fts.results.map((row) => row.name)).toEqual([
      "memory_episode_fts", "memory_history_fts", "memory_item_fts",
    ]);
  });

  it("installs canonical views that apply active suppressions before retrieval", async () => {
    const views = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'view' AND name LIKE 'memory_%' ORDER BY name`).all<{ name: string }>();
    expect(views.results.map((row) => row.name)).toEqual([
      "memory_active_event_suppressions",
      "memory_retrievable_episodes",
      "memory_retrievable_history_chunks",
      "memory_retrievable_item_versions",
      "memory_valid_owner_commands",
      "memory_visible_recent_events",
    ]);
  });

  it("projects only valid version and lifecycle transitions into retrievable item state", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, source);

    const state = await env.DB.prepare(`SELECT current_version_id, lifecycle_state
      FROM memory_item_state WHERE principal_id = ? AND item_id = ?`)
      .bind(owner.principalId, item.itemId)
      .first<{ current_version_id: string; lifecycle_state: string }>();
    expect(state).toEqual({ current_version_id: item.versionId, lifecycle_state: "active" });

    const forgedItemId = nextUlid();
    const forgedVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(forgedItemId, owner.principalId, source.eventId, source.sequence, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'A forged projection.', 'NFC', ?, 'stated',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(forgedVersionId, owner.principalId, forgedItemId, nextHash(), timestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_state (
      principal_id, item_id, current_version_id, lifecycle_state,
      last_transition_id, last_transition_number, updated_at
    ) VALUES (?, ?, ?, 'active', ?, 1, ?)`)
      .bind(
        owner.principalId, forgedItemId, forgedVersionId,
        item.transitionId, timestamp,
      ).run()).rejects.toThrow(/memory_item_state_requires_transition/u);
    await expect(env.DB.prepare("UPDATE memory_item_state SET lifecycle_state = 'forgotten' WHERE principal_id = ? AND item_id = ?")
      .bind(owner.principalId, item.itemId).run()).rejects.toThrow(/memory_item_state_requires_transition/u);

    const other = await seedPrincipal();
    const otherEvent = await seedEvent(other.principalId);
    await expect(env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 'live', NULL, 'cross principal', ?, 'telegram', ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, item.itemId, item.versionId,
        otherEvent.eventId, otherEvent.sequence, nextHash(), timestamp, timestamp,
      ).run()).rejects.toThrow(/memory_item_source_receipt_invalid/u);

    const modelItemId = nextUlid();
    const modelVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(modelItemId, owner.principalId, source.eventId, source.sequence, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'The owner may prefer mornings.', 'NFC', ?, 'inferred',
      'model', 1, 'normal', NULL, NULL, 'extractor-v1', 'deepseek:deepseek-v4-pro', ?)`)
      .bind(modelVersionId, owner.principalId, modelItemId, nextHash(), timestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'active', 'model tried to self-promote', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, modelItemId, modelVersionId, timestamp).run())
      .rejects.toThrow(/memory_item_transition_invalid/u);
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'proposed', 'model proposal', 'rules', 'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, modelItemId, modelVersionId, timestamp).run();

    const retrievable = await env.DB.prepare(`SELECT version_id FROM memory_retrievable_item_versions
      WHERE principal_id = ? ORDER BY version_id`).bind(owner.principalId).all<{ version_id: string }>();
    expect(retrievable.results.map((row) => row.version_id)).toEqual([item.versionId]);
    await expect(env.DB.prepare("UPDATE memory_item_versions SET text_hash = ? WHERE version_id = ?")
      .bind(nextHash(), item.versionId).run()).rejects.toThrow(/memory_item_version_immutable/u);
  });

  it("hides recent turns, items, episodes, and history chunks until one authorized lift", async () => {
    const owner = await seedPrincipal();
    const target = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, target);
    const episodeId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_episodes (
      episode_id, principal_id, local_day, start_event_sequence, end_event_sequence,
      source_count, text, content_hash, summarizer_version, summarizer_model_id,
      supersedes_episode_id, created_at
    ) VALUES (?, ?, '2026-09-14', ?, ?, 1, 'A short-report preference was stated.', ?,
      'summary-v1', 'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(episodeId, owner.principalId, target.sequence, target.sequence, nextHash(), timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_episode_sources (
      source_id, principal_id, episode_id, source_position, event_id, event_sequence,
      source_location, r2_segment_id, channel, occurred_at
    ) VALUES (?, ?, ?, 0, ?, ?, 'live', NULL, 'telegram', ?)`)
      .bind(nextUlid(), owner.principalId, episodeId, target.eventId, target.sequence, timestamp).run();
    const chunkId = nextUlid();
    const sourceReceiptHash = nextHash();
    await env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(
        nextUlid(), owner.principalId, target.sequence, target.sequence,
        sourceReceiptHash, timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'I prefer short reports.', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunkId, owner.principalId, target.sequence, target.sequence,
        nextHash(), sourceReceiptHash, timestamp, timestamp,
      ).run();

    for (const view of [
      "memory_visible_recent_events", "memory_retrievable_item_versions",
      "memory_retrievable_episodes", "memory_retrievable_history_chunks",
    ] as const) {
      const idColumn = view === "memory_visible_recent_events" ? "event_id"
        : view === "memory_retrievable_item_versions" ? "version_id"
          : view === "memory_retrievable_episodes" ? "episode_id" : "chunk_id";
      const expectedId = view === "memory_visible_recent_events" ? target.eventId
        : view === "memory_retrievable_item_versions" ? item.versionId
          : view === "memory_retrievable_episodes" ? episodeId : chunkId;
      const row = await env.DB.prepare(`SELECT ${idColumn} AS id FROM ${view} WHERE ${idColumn} = ?`)
        .bind(expectedId).first<{ id: string }>();
      expect(row?.id).toBe(expectedId);
    }

    const suppressionId = nextUlid();
    const forgetAuthorization = await seedOwnerCommand(
      owner.principalId, "history.suppress", suppressionId,
      {
        targetEventId: target.eventId,
        startEventSequence: null,
        endEventSequence: null,
        newlyHiddenTurnCount: 1,
        totalCoveredTurnCount: 1,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'owner requested hide', 1, 1, ?)`)
      .bind(suppressionId, owner.principalId, target.eventId, forgetAuthorization.eventId, timestamp).run();

    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_active_event_suppressions WHERE suppression_id = ?")
      .bind(suppressionId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_visible_recent_events WHERE event_id = ?")
      .bind(target.eventId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE version_id = ?")
      .bind(item.versionId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_episodes WHERE episode_id = ?")
      .bind(episodeId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_history_chunks WHERE chunk_id = ?")
      .bind(chunkId).first<{ count: number }>()).toEqual({ count: 0 });

    const other = await seedPrincipal();
    const otherAuthorization = await seedEvent(other.principalId);
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'cross principal hide', 1, 1, ?)`)
      .bind(
        nextUlid(), owner.principalId, otherAuthorization.eventId,
        forgetAuthorization.eventId, timestamp,
      ).run()).rejects.toThrow(/memory_event_suppression_invalid/u);
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'cross principal lift', ?)`)
      .bind(nextUlid(), other.principalId, suppressionId, otherAuthorization.eventId, timestamp).run())
      .rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'unauthorized lift', ?)`)
      .bind(nextUlid(), owner.principalId, suppressionId, otherAuthorization.eventId, timestamp).run())
      .rejects.toThrow(/memory_event_suppression_lift_invalid/u);

    const liftId = nextUlid();
    const liftAuthorization = await seedOwnerCommand(
      owner.principalId, "history.lift", liftId,
      { suppressionId },
    );
    await env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'owner corrected hide', ?)`)
      .bind(liftId, owner.principalId, suppressionId, liftAuthorization.eventId, timestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'duplicate lift', ?)`)
      .bind(nextUlid(), owner.principalId, suppressionId, liftAuthorization.eventId, timestamp).run())
      .rejects.toThrow();

    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_active_event_suppressions WHERE suppression_id = ?")
      .bind(suppressionId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_visible_recent_events WHERE event_id = ?")
      .bind(target.eventId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE version_id = ?")
      .bind(item.versionId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_episodes WHERE episode_id = ?")
      .bind(episodeId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_history_chunks WHERE chunk_id = ?")
      .bind(chunkId).first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("binds item forget suppressions to the forgotten transition and exact source turn", async () => {
    const owner = await seedPrincipal();
    const target = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, target);
    const forgottenTransitionId = nextUlid();
    const suppressionId = nextUlid();
    const authorization = await seedOwnerCommand(
      owner.principalId,
      "item.forget",
      forgottenTransitionId,
      {
        itemId: item.itemId,
        versionId: item.versionId,
        lifecycleState: "forgotten",
        suppressions: [{
          suppressionId,
          targetEventId: target.eventId,
          startEventSequence: null,
          endEventSequence: null,
          sourceId: item.sourceId,
          newlyHiddenTurnCount: 1,
          totalCoveredTurnCount: 1,
        }],
      },
    );
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'forgotten', 'owner requested forget', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        forgottenTransitionId, owner.principalId, item.itemId,
        item.versionId, authorization.eventId, timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'item forget', 1, 1, ?)`)
      .bind(
        suppressionId, owner.principalId, target.eventId, authorization.eventId,
        forgottenTransitionId, item.sourceId, timestamp,
      ).run();

    const missingCorrectionLiftId = nextUlid();
    const missingCorrectionAuthorization = await seedOwnerCommand(
      owner.principalId, "history.lift", missingCorrectionLiftId,
      { suppressionId },
    );
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'missing item correction', ?)`)
      .bind(
        missingCorrectionLiftId, owner.principalId, suppressionId,
        missingCorrectionAuthorization.eventId, laterTimestamp,
      ).run()).rejects.toThrow(/memory_event_suppression_lift_invalid/u);

    const correctedVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 2, 'I prefer short reports.', 'NFC', ?, 'confirmed',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(correctedVersionId, owner.principalId, item.itemId, nextHash(), laterTimestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'I prefer short reports.', ?,
      'telegram', ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, item.itemId, correctedVersionId,
        target.eventId, target.sequence, nextHash(), timestamp, laterTimestamp,
      ).run();
    const correctionTransitionId = nextUlid();
    const liftId = nextUlid();
    const liftAuthorization = await seedOwnerCommand(
      owner.principalId,
      "item.correct",
      correctionTransitionId,
      {
        itemId: item.itemId,
        versionId: correctedVersionId,
        lifecycleState: "active",
        lifts: [{ liftId, suppressionId }],
      },
    );
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 3, ?, 'active', 'owner corrected forget', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        correctionTransitionId, owner.principalId, item.itemId,
        correctedVersionId, liftAuthorization.eventId, laterTimestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, 'owner corrected item forget', ?)`)
      .bind(
        liftId, owner.principalId, suppressionId, liftAuthorization.eventId,
        correctionTransitionId, laterTimestamp,
      ).run();

    const otherSourceEvent = await seedEvent(owner.principalId);
    const otherItem = await seedActiveItem(owner.principalId, otherSourceEvent);
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'mismatched item forget', 1, 1, ?)`)
      .bind(
        nextUlid(), owner.principalId, otherSourceEvent.eventId, authorization.eventId,
        forgottenTransitionId, otherItem.sourceId, timestamp,
      ).run()).rejects.toThrow(/memory_event_suppression_invalid/u);
  });

  it("applies topic create, rename, move, merge, alias, and placement history without cycles", async () => {
    const owner = await seedPrincipal();
    const sourceEvent = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, sourceEvent);
    const rootId = nextUlid();
    const sourceTopicId = nextUlid();
    const targetTopicId = nextUlid();
    const childTopicId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "St. Remy", newNormalizedName: "st. remy",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: sourceTopicId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "PC app", newNormalizedName: "pc app",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: targetTopicId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Website", newNormalizedName: "website",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: childTopicId, operation: "create",
      newParentTopicId: sourceTopicId, newDisplayName: "Catalogue", newNormalizedName: "catalogue",
    });

    await expect(env.DB.prepare(`INSERT INTO memory_item_placement_state (
      principal_id, placement_id, item_id, topic_id, relation, status,
      last_event_kind, last_event_id, last_placement_event_number, updated_at
    ) VALUES (?, ?, ?, ?, 'related', 'active', 'placement', ?, 1, ?)`)
      .bind(
        owner.principalId, nextUlid(), item.itemId, sourceTopicId,
        nextUlid(), timestamp,
      ).run()).rejects.toThrow(/memory_item_placement_state_requires_event/u);

    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: sourceTopicId, operation: "move",
      previousParentTopicId: rootId, newParentTopicId: childTopicId,
    })).rejects.toThrow(/memory_topic_event_invalid/u);

    const websiteAliasId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: targetTopicId, operation: "rename",
      previousDisplayName: "Website", previousNormalizedName: "website",
      newDisplayName: "Web platform", newNormalizedName: "web platform",
      addedAliases: [{
        aliasId: websiteAliasId,
        topicId: targetTopicId,
        displayName: "Website",
        normalizedName: "website",
        pathAlias: "St. Remy/Website",
      }],
    });

    const placementId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_placement_events (
      placement_event_id, principal_id, placement_id, placement_event_number,
      item_id, operation, previous_topic_id, new_topic_id, relation,
      filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'place', NULL, ?, 'primary', 'rule', 1.0,
      'deterministic filing', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, placementId, item.itemId, sourceTopicId, timestamp).run();

    const sourceAliasId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: sourceTopicId, operation: "merge",
      previousDisplayName: "PC app", previousNormalizedName: "pc app",
      mergeTargetTopicId: targetTopicId,
      reparentedChildIds: [childTopicId],
      movedPlacementIds: [placementId],
      addedAliases: [{
        aliasId: sourceAliasId,
        topicId: targetTopicId,
        displayName: "PC app",
        normalizedName: "pc app",
        pathAlias: "St. Remy/PC app",
      }],
    });

    expect(await env.DB.prepare(`SELECT status, redirect_to_topic_id FROM memory_topics
      WHERE principal_id = ? AND topic_id = ?`).bind(owner.principalId, sourceTopicId)
      .first<{ status: string; redirect_to_topic_id: string }>())
      .toEqual({ status: "merged", redirect_to_topic_id: targetTopicId });
    expect(await env.DB.prepare("SELECT parent_topic_id FROM memory_topics WHERE topic_id = ?")
      .bind(childTopicId).first<{ parent_topic_id: string }>())
      .toEqual({ parent_topic_id: targetTopicId });
    expect(await env.DB.prepare("SELECT topic_id, last_event_kind FROM memory_item_placement_state WHERE placement_id = ?")
      .bind(placementId).first<{ topic_id: string; last_event_kind: string }>())
      .toEqual({ topic_id: targetTopicId, last_event_kind: "topic" });
    const aliases = await env.DB.prepare(`SELECT display_alias FROM memory_topic_aliases
      WHERE principal_id = ? ORDER BY display_alias`).bind(owner.principalId).all<{ display_alias: string }>();
    expect(aliases.results.map((row) => row.display_alias)).toEqual(["PC app", "Website"]);
    await expect(env.DB.prepare("UPDATE memory_topics SET display_name = 'forged' WHERE topic_id = ?")
      .bind(targetTopicId).run()).rejects.toThrow(/memory_topic_update_requires_event/u);
  });

  it("rejects carried REPLACE sibling-name collisions for rename, move, and merge", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    const createChild = async (parentId: string, displayName: string) => {
      const topicId = nextUlid();
      await insertTopicEvent({
        principalId: owner.principalId, topicId, operation: "create",
        newParentTopicId: parentId, newDisplayName: displayName,
        newNormalizedName: displayName.toLowerCase(),
      });
      return topicId;
    };

    const renameSourceId = await createChild(rootId, "Rename source");
    const renameSiblingId = await createChild(rootId, "Rename sibling");
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: renameSourceId, operation: "rename",
      previousDisplayName: "Rename source", previousNormalizedName: "rename source",
      newDisplayName: "Rename sibling", newNormalizedName: "rename sibling",
      addedAliases: [{
        aliasId: nextUlid(), topicId: renameSourceId, displayName: "Rename source",
        normalizedName: "rename source", pathAlias: "Root/Rename source",
      }],
    }, true)).rejects.toThrow(/memory_topic_event_invalid/u);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_topics WHERE topic_id = ?")
      .bind(renameSiblingId).first()).toEqual({ count: 1 });

    const moveParentAId = await createChild(rootId, "Move parent A");
    const moveParentBId = await createChild(rootId, "Move parent B");
    const moveSourceId = await createChild(moveParentAId, "Move duplicate");
    const moveSiblingId = await createChild(moveParentBId, "Move duplicate");
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: moveSourceId, operation: "move",
      previousParentTopicId: moveParentAId, newParentTopicId: moveParentBId,
    }, true)).rejects.toThrow(/memory_topic_event_invalid/u);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_topics WHERE topic_id = ?")
      .bind(moveSiblingId).first()).toEqual({ count: 1 });

    const mergeSourceId = await createChild(rootId, "Merge source");
    const mergeTargetId = await createChild(rootId, "Merge target");
    const mergeChildId = await createChild(mergeSourceId, "Merge duplicate");
    const mergeSiblingId = await createChild(mergeTargetId, "Merge duplicate");
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: mergeSourceId, operation: "merge",
      previousDisplayName: "Merge source", previousNormalizedName: "merge source",
      mergeTargetTopicId: mergeTargetId,
      reparentedChildIds: [mergeChildId],
      addedAliases: [{
        aliasId: nextUlid(), topicId: mergeTargetId, displayName: "Merge source",
        normalizedName: "merge source", pathAlias: "Root/Merge source",
      }],
    }, true)).rejects.toThrow(/memory_topic_event_invalid/u);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_topics WHERE topic_id = ?")
      .bind(mergeSiblingId).first()).toEqual({ count: 1 });
  });

  it("rejects a merge older than any child it would reparent", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    const sourceId = nextUlid();
    const targetId = nextUlid();
    const childId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: sourceId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Source", newNormalizedName: "source",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: targetId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Target", newNormalizedName: "target",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: childId, operation: "create",
      newParentTopicId: sourceId, newDisplayName: "New child", newNormalizedName: "new child",
      occurredAt: laterTimestamp,
    });
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: sourceId, operation: "merge",
      previousDisplayName: "Source", previousNormalizedName: "source",
      mergeTargetTopicId: targetId,
      reparentedChildIds: [childId],
      addedAliases: [{
        aliasId: nextUlid(), topicId: targetId, displayName: "Source",
        normalizedName: "source", pathAlias: "Root/Source",
      }],
      occurredAt: timestamp,
    })).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("keeps FTS projections current and enforces bounded run, cost, vector, cursor, and reprocessing state", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, source);

    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_item_fts WHERE memory_item_fts MATCH 'short'")
      .first<{ count: number }>()).toMatchObject({ count: expect.any(Number) });
    const itemHit = await env.DB.prepare(`SELECT rowid FROM memory_item_fts
      WHERE memory_item_fts MATCH 'short' AND rowid = (
        SELECT version_rowid FROM memory_item_versions WHERE version_id = ?
      )`).bind(item.versionId).first();
    expect(itemHit).not.toBeNull();

    const episodeId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_episodes (
      episode_id, principal_id, local_day, start_event_sequence, end_event_sequence,
      source_count, text, content_hash, summarizer_version, summarizer_model_id,
      supersedes_episode_id, created_at
    ) VALUES (?, ?, '2026-09-14', ?, ?, 1, 'A violet notebook was mentioned.', ?,
      'summary-v1', 'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(episodeId, owner.principalId, source.sequence, source.sequence, nextHash(), timestamp).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_episode_fts WHERE memory_episode_fts MATCH 'violet'")
      .first<{ count: number }>()).toEqual({ count: 1 });

    const chunkId = nextUlid();
    const chunkReceiptHash = nextHash();
    await env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(
        nextUlid(), owner.principalId, source.sequence, source.sequence,
        chunkReceiptHash, timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'orchid detail', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunkId, owner.principalId, source.sequence, source.sequence,
        nextHash(), chunkReceiptHash, timestamp, timestamp,
      ).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH 'orchid'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    await expect(env.DB.prepare(`UPDATE memory_history_chunks
      SET text = 'sapphire detail', content_hash = ?, updated_at = ? WHERE chunk_id = ?`)
      .bind(nextHash(), laterTimestamp, chunkId).run())
      .rejects.toThrow(/memory_history_chunk_immutable/u);
    await env.DB.prepare("DELETE FROM memory_history_chunks WHERE chunk_id = ?").bind(chunkId).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH 'orchid'")
      .first<{ count: number }>()).toEqual({ count: 0 });

    const priceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', ?, 660000, 1980000,
      0, 'USD', 'reviewed price receipt', ?)`)
      .bind(priceId, owner.principalId, timestamp, timestamp).run();
    const runId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
      provider_model_id, price_id, outcome, started_at
    ) VALUES (?, ?, ?, 'distillation', ?, ?, 'deepseek:deepseek-v4-pro', ?, 'running', ?)`)
      .bind(runId, owner.principalId, `run:${runId}`, source.sequence, source.sequence, priceId, timestamp).run();
    const reservationId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_cost_ledger (
      cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
      provider, model_id, budget_class, reprocess_job_id, amount_micros,
      price_id, occurred_at
    ) VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:deepseek-v4-pro',
      'normal_monthly', NULL, 1000, ?, ?)`)
      .bind(reservationId, owner.principalId, runId, priceId, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_cost_ledger (
      cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
      provider, model_id, budget_class, reprocess_job_id, amount_micros,
      price_id, occurred_at
    ) VALUES (?, ?, ?, 'settlement', ?, 'deepseek', 'deepseek:deepseek-v4-pro',
      'normal_monthly', NULL, 750, ?, ?)`)
      .bind(nextUlid(), owner.principalId, runId, reservationId, priceId, laterTimestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_cost_ledger (
      cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
      provider, model_id, budget_class, reprocess_job_id, amount_micros,
      price_id, occurred_at
    ) VALUES (?, ?, ?, 'release', ?, 'deepseek', 'deepseek:deepseek-v4-pro',
      'normal_monthly', NULL, 250, ?, ?)`)
      .bind(nextUlid(), owner.principalId, runId, reservationId, priceId, laterTimestamp).run())
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
    await env.DB.prepare(`UPDATE memory_runs SET outcome = 'succeeded', completed_at = ?,
      input_event_count = 1, created_item_count = 1, input_tokens = 10,
      output_tokens = 5, reserved_cost_micros = 1000, settled_cost_micros = 750
      WHERE run_id = ?`).bind(laterTimestamp, runId).run();
    await expect(env.DB.prepare("UPDATE memory_runs SET settled_cost_micros = 800 WHERE run_id = ?")
      .bind(runId).run()).rejects.toThrow(/memory_run_transition_invalid/u);

    const reprocessJobId = nextUlid();
    const authorization = await seedOwnerCommand(
      owner.principalId,
      "reprocess.create",
      reprocessJobId,
      {
        startEventSequence: source.sequence,
        endEventSequence: source.sequence,
        startDay: null,
        endDay: null,
        maximumEventCount: 10,
        providerModelId: "anthropic:claude-memory",
        spendLimitMicros: 5_000_000,
        dryRun: 1,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
      job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
      end_event_sequence, start_day, end_day, maximum_event_count,
      provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
      status, final_receipt_hash, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 10, 'anthropic:claude-memory', 5000000,
      1, NULL, 'pending', NULL, NULL, ?, ?)`)
      .bind(
        reprocessJobId, owner.principalId, authorization.eventId,
        source.sequence, source.sequence, timestamp, timestamp,
      ).run();
    await env.DB.prepare(`UPDATE memory_reprocess_jobs
      SET status = 'running', checkpoint_event_sequence = ?, updated_at = ? WHERE job_id = ?`)
      .bind(source.sequence, laterTimestamp, reprocessJobId).run();
    await expect(env.DB.prepare(`UPDATE memory_reprocess_jobs
      SET checkpoint_event_sequence = ?, updated_at = ? WHERE job_id = ?`)
      .bind(source.sequence - 1, laterTimestamp, reprocessJobId).run())
      .rejects.toThrow(/memory_reprocess_job_transition_invalid/u);
    const other = await seedPrincipal();
    const otherAuthorization = await seedEvent(other.principalId);
    await expect(env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
      job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
      end_event_sequence, start_day, end_day, maximum_event_count,
      provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
      status, final_receipt_hash, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 10, 'openai:gpt-memory', 5000000,
      1, NULL, 'pending', NULL, NULL, ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, otherAuthorization.eventId,
        source.sequence, source.sequence, timestamp, timestamp,
      ).run()).rejects.toThrow(/memory_reprocess_job_authorization_invalid/u);

    const vectorId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_vectors (
      vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
      dimensions, content_hash, mutation_id, upserted_at, deleted_at
    ) VALUES (?, ?, 'item', ?, '@cf/baai/bge-m3', 1024, ?, ?, ?, NULL)`)
      .bind(vectorId, owner.principalId, item.itemId, nextHash(), `mutation:${vectorId}`, timestamp).run();
    await env.DB.prepare("UPDATE memory_vectors SET deleted_at = ? WHERE vector_ledger_id = ?")
      .bind(laterTimestamp, vectorId).run();
    await expect(env.DB.prepare("UPDATE memory_vectors SET deleted_at = ? WHERE vector_ledger_id = ?")
      .bind(laterTimestamp, vectorId).run()).rejects.toThrow(/memory_vector_delete_transition_invalid/u);

    await env.DB.prepare(`INSERT INTO memory_cursors (
      principal_id, cursor_name, current_event_sequence, updated_at
    ) VALUES (?, 'distillation', 0, ?)`)
      .bind(owner.principalId, timestamp).run();
    await env.DB.prepare(`UPDATE memory_cursors
      SET current_event_sequence = ?, updated_at = ?
      WHERE principal_id = ? AND cursor_name = 'distillation'`)
      .bind(source.sequence, laterTimestamp, owner.principalId).run();
    await expect(env.DB.prepare(`UPDATE memory_cursors
      SET current_event_sequence = 0, updated_at = ?
      WHERE principal_id = ? AND cursor_name = 'distillation'`)
      .bind(laterTimestamp, owner.principalId).run())
      .rejects.toThrow(/memory_cursor_transition_invalid/u);
    await expect(env.DB.prepare(`DELETE FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'distillation'`)
      .bind(owner.principalId).run()).rejects.toThrow(/memory_cursor_delete_forbidden/u);

    await env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(nextUlid(), owner.principalId, source.sequence, source.sequence, nextHash(), timestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'archived', ?, ?, ?, 'indexed', ?, NULL, ?)`)
      .bind(
        nextUlid(), owner.principalId, source.sequence, source.sequence,
        "f".repeat(64), nextHash(), timestamp,
      ).run()).rejects.toThrow(/memory_history_coverage_receipt_invalid/u);
  });

  it("requires owner authority to leave forgotten or rejected item state", async () => {
    for (const blockedState of ["forgotten", "rejected"] as const) {
      const owner = await seedPrincipal();
      const source = await seedEvent(owner.principalId);
      const item = await seedActiveItem(
        owner.principalId,
        source,
        blockedState === "rejected" ? "proposed" : "active",
      );
      const blockedTransitionId = nextUlid();
      const operation = blockedState === "forgotten" ? "item.forget" : "item.transition";
      const blockingCommand = await seedOwnerCommand(
        owner.principalId, operation, blockedTransitionId,
        {
          itemId: item.itemId,
          versionId: item.versionId,
          lifecycleState: blockedState,
          ...(blockedState === "forgotten" ? { suppressions: [] } : {}),
        },
      );
      await env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 2, ?, ?, 'owner terminal state', 'owner',
        'policy-v1', ?, ?)`)
        .bind(
          blockedTransitionId, owner.principalId, item.itemId, item.versionId,
          blockedState, blockingCommand.eventId, timestamp,
        ).run();
      const nextVersionId = nextUlid();
      await env.DB.prepare(`INSERT INTO memory_item_versions (
        version_id, principal_id, item_id, version_number, text, text_normalization,
        text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
        extractor_version, extractor_model_id, created_at
      ) VALUES (?, ?, ?, 2, 'I prefer concise reports.', 'NFC', ?, 'stated',
        'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
        .bind(nextVersionId, owner.principalId, item.itemId, nextHash(), laterTimestamp).run();
      await env.DB.prepare(`INSERT INTO memory_item_sources (
        source_id, principal_id, item_id, version_id, source_position, event_id,
        event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
        channel, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'I prefer concise reports.', ?,
        'telegram', ?, ?)`)
        .bind(
          nextUlid(), owner.principalId, item.itemId, nextVersionId,
          source.eventId, source.sequence, nextHash(), timestamp, laterTimestamp,
        ).run();
      await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 3, ?, 'active', 'rules tried to undo owner state', 'rules',
        'policy-v1', NULL, ?)`)
        .bind(nextUlid(), owner.principalId, item.itemId, nextVersionId, laterTimestamp).run())
        .rejects.toThrow(/memory_item_transition_invalid/u);
    }
  });

  it("rejects a correction command issued before the current forget", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, source);
    const correctionTransitionId = nextUlid();
    const correctedVersionId = nextUlid();
    const staleCorrectionCommand = await seedOwnerCommand(
      owner.principalId,
      "item.correct",
      correctionTransitionId,
      {
        itemId: item.itemId,
        versionId: correctedVersionId,
        lifecycleState: "active",
        lifts: [],
      },
    );
    const forgottenTransitionId = nextUlid();
    const forgetCommand = await seedOwnerCommand(
      owner.principalId,
      "item.forget",
      forgottenTransitionId,
      {
        itemId: item.itemId,
        versionId: item.versionId,
        lifecycleState: "forgotten",
        suppressions: [],
      },
    );
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'forgotten', 'owner forget', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        forgottenTransitionId,
        owner.principalId,
        item.itemId,
        item.versionId,
        forgetCommand.eventId,
        laterTimestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 2, 'I prefer compact reports.', 'NFC', ?, 'stated',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(
        correctedVersionId,
        owner.principalId,
        item.itemId,
        nextHash(),
        laterTimestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'I prefer compact reports.', ?,
      'telegram', ?, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        item.itemId,
        correctedVersionId,
        source.eventId,
        source.sequence,
        nextHash(),
        laterTimestamp,
        laterTimestamp,
      ).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 3, ?, 'active', 'stale pre-authorized correction', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        correctionTransitionId,
        owner.principalId,
        item.itemId,
        correctedVersionId,
        staleCorrectionCommand.eventId,
        laterTimestamp,
      ).run()).rejects.toThrow(/memory_item_transition_invalid/u);
  });

  it("rejects stale lift authority and a correction older than the forget", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const itemId = nextUlid();
    const versionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(itemId, owner.principalId, source.eventId, source.sequence, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'I own a violet notebook.', 'NFC', ?, 'stated',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(versionId, owner.principalId, itemId, nextHash(), timestamp).run();
    const sourceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'I own a violet notebook.', ?,
      'telegram', ?, ?)`)
      .bind(
        sourceId, owner.principalId, itemId, versionId, source.eventId,
        source.sequence, nextHash(), timestamp, timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'proposed', 'proposal', 'rules', 'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, itemId, versionId, timestamp).run();
    const staleCorrectionId = nextUlid();
    const liftId = nextUlid();
    const staleCommand = await seedOwnerCommand(
      owner.principalId,
      "item.transition",
      staleCorrectionId,
      {
        itemId,
        versionId,
        lifecycleState: "active",
        lifts: [{ liftId, suppressionId: "unused" }],
      },
    );
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'active', 'owner confirmation', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        staleCorrectionId, owner.principalId, itemId, versionId,
        staleCommand.eventId, timestamp,
      ).run();
    const forgottenTransitionId = nextUlid();
    const suppressionId = nextUlid();
    const forgetCommand = await seedOwnerCommand(
      owner.principalId,
      "item.forget",
      forgottenTransitionId,
      {
        itemId,
        versionId,
        lifecycleState: "forgotten",
        suppressions: [{
          suppressionId,
          targetEventId: source.eventId,
          startEventSequence: null,
          endEventSequence: null,
          sourceId,
          newlyHiddenTurnCount: 1,
          totalCoveredTurnCount: 1,
        }],
      },
    );
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 3, ?, 'forgotten', 'owner forget', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        forgottenTransitionId, owner.principalId, itemId, versionId,
        forgetCommand.eventId, laterTimestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'item forget', 1, 1, ?)`)
      .bind(
        suppressionId, owner.principalId, source.eventId, forgetCommand.eventId,
        forgottenTransitionId, sourceId, laterTimestamp,
      ).run();
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, 'stale correction', ?)`)
      .bind(
        liftId, owner.principalId, suppressionId, staleCommand.eventId,
        staleCorrectionId, laterTimestamp,
      ).run()).rejects.toThrow(/memory_event_suppression_lift_invalid/u);
  });

  it("keeps episodes hidden until their complete in-range source set exists", async () => {
    const owner = await seedPrincipal();
    const first = await seedEvent(owner.principalId);
    const second = await seedEvent(owner.principalId);
    const episodeId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_episodes (
      episode_id, principal_id, local_day, start_event_sequence, end_event_sequence,
      source_count, text, content_hash, summarizer_version, summarizer_model_id,
      supersedes_episode_id, created_at
    ) VALUES (?, ?, '2026-09-14', ?, ?, 2, 'Two source episode.', ?, 'summary-v1',
      'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(
        episodeId, owner.principalId, first.sequence, second.sequence,
        nextHash(), timestamp,
      ).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_episodes WHERE episode_id = ?")
      .bind(episodeId).first()).toEqual({ count: 0 });
    for (const [position, event] of [[0, first], [1, second]] as const) {
      await env.DB.prepare(`INSERT INTO memory_episode_sources (
        source_id, principal_id, episode_id, source_position, event_id, event_sequence,
        source_location, r2_segment_id, channel, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, 'telegram', ?)`)
        .bind(
          nextUlid(), owner.principalId, episodeId, position,
          event.eventId, event.sequence, timestamp,
        ).run();
      expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_episodes WHERE episode_id = ?")
        .bind(episodeId).first()).toEqual({ count: position });
    }
    const outside = await seedEvent(owner.principalId);
    await expect(env.DB.prepare(`INSERT INTO memory_episode_sources (
      source_id, principal_id, episode_id, source_position, event_id, event_sequence,
      source_location, r2_segment_id, channel, occurred_at
    ) VALUES (?, ?, ?, 2, ?, ?, 'live', NULL, 'telegram', ?)`)
      .bind(
        nextUlid(), owner.principalId, episodeId,
        outside.eventId, outside.sequence, timestamp,
      ).run()).rejects.toThrow(/memory_episode_source_receipt_invalid/u);
  });

  it("hides an episode when an undeclared turn inside its range is suppressed", async () => {
    const owner = await seedPrincipal();
    const first = await seedEvent(owner.principalId);
    const hidden = await seedEvent(owner.principalId);
    const last = await seedEvent(owner.principalId);
    const episodeId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_episodes (
      episode_id, principal_id, local_day, start_event_sequence, end_event_sequence,
      source_count, text, content_hash, summarizer_version, summarizer_model_id,
      supersedes_episode_id, created_at
    ) VALUES (?, ?, '2026-09-14', ?, ?, 2, 'Partial declared source episode.', ?,
      'summary-v1', 'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(
        episodeId,
        owner.principalId,
        first.sequence,
        last.sequence,
        nextHash(),
        timestamp,
      ).run();
    for (const [position, event] of [[0, first], [1, last]] as const) {
      await env.DB.prepare(`INSERT INTO memory_episode_sources (
        source_id, principal_id, episode_id, source_position, event_id, event_sequence,
        source_location, r2_segment_id, channel, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'live', NULL, 'telegram', ?)`)
        .bind(
          nextUlid(),
          owner.principalId,
          episodeId,
          position,
          event.eventId,
          event.sequence,
          timestamp,
        ).run();
    }
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_retrievable_episodes
      WHERE episode_id = ?`).bind(episodeId).first()).toEqual({ count: 1 });
    const suppressionId = nextUlid();
    const command = await seedOwnerCommand(
      owner.principalId,
      "history.suppress",
      suppressionId,
      {
        targetEventId: hidden.eventId,
        startEventSequence: null,
        endEventSequence: null,
        newlyHiddenTurnCount: 1,
        totalCoveredTurnCount: 1,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'hide interior turn', 1, 1, ?)`)
      .bind(
        suppressionId,
        owner.principalId,
        hidden.eventId,
        command.eventId,
        laterTimestamp,
      ).run();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_retrievable_episodes
      WHERE episode_id = ?`).bind(episodeId).first()).toEqual({ count: 0 });
  });

  it("requires exact total and newly-hidden counts for range suppressions", async () => {
    const owner = await seedPrincipal();
    const turns = [
      await seedEvent(owner.principalId),
      await seedEvent(owner.principalId),
      await seedEvent(owner.principalId),
    ] as const;
    const badSuppressionId = nextUlid();
    const badCommand = await seedOwnerCommand(
      owner.principalId,
      "history.suppress",
      badSuppressionId,
      {
        targetEventId: null,
        startEventSequence: turns[0].sequence,
        endEventSequence: turns[2].sequence,
        newlyHiddenTurnCount: 0,
        totalCoveredTurnCount: 1,
      },
    );
    const insertRange = (
      suppressionId: string,
      commandId: string,
      newlyHidden: number,
      totalCovered: number,
    ) => env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, 'range count test', ?, ?, ?)`)
      .bind(
        suppressionId,
        owner.principalId,
        turns[0].sequence,
        turns[2].sequence,
        commandId,
        newlyHidden,
        totalCovered,
        laterTimestamp,
      ).run();
    await expect(insertRange(badSuppressionId, badCommand.eventId, 0, 1))
      .rejects.toThrow(/memory_event_suppression_invalid/u);

    const goodSuppressionId = nextUlid();
    const goodCommand = await seedOwnerCommand(
      owner.principalId,
      "history.suppress",
      goodSuppressionId,
      {
        targetEventId: null,
        startEventSequence: turns[0].sequence,
        endEventSequence: turns[2].sequence,
        newlyHiddenTurnCount: 3,
        totalCoveredTurnCount: 3,
      },
    );
    await insertRange(goodSuppressionId, goodCommand.eventId, 3, 3);
    expect(await env.DB.prepare(`SELECT newly_hidden_turn_count, total_covered_turn_count
      FROM memory_event_suppressions WHERE suppression_id = ?`)
      .bind(goodSuppressionId).first()).toEqual({
      newly_hidden_turn_count: 3,
      total_covered_turn_count: 3,
    });
  });

  it("binds owner authority to a dedicated command with the exact operation and limits", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const historicalMessage = await seedEvent(owner.principalId);
    const jobId = nextUlid();
    const insertJob = (authorizationId: string) => env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
      job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
      end_event_sequence, start_day, end_day, maximum_event_count,
      provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
      status, final_receipt_hash, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 'openai:gpt-memory', 5000000, 1,
      NULL, 'pending', NULL, NULL, ?, ?)`)
      .bind(
        jobId, owner.principalId, authorizationId, source.sequence, source.sequence,
        timestamp, timestamp,
      ).run();
    await expect(insertJob(historicalMessage.eventId))
      .rejects.toThrow(/memory_reprocess_job_authorization_invalid/u);
    const wrongLimitCommand = await seedOwnerCommand(
      owner.principalId,
      "reprocess.create",
      jobId,
      {
        startEventSequence: source.sequence,
        endEventSequence: source.sequence,
        startDay: null,
        endDay: null,
        maximumEventCount: 1,
        providerModelId: "openai:gpt-memory",
        spendLimitMicros: 4_999_999,
        dryRun: 1,
      },
    );
    await expect(insertJob(wrongLimitCommand.eventId))
      .rejects.toThrow(/memory_reprocess_job_authorization_invalid/u);

    const oversizedJobId = nextUlid();
    const oversizedCommand = await seedOwnerCommand(
      owner.principalId,
      "reprocess.create",
      oversizedJobId,
      {
        startEventSequence: source.sequence,
        endEventSequence: historicalMessage.sequence,
        startDay: null,
        endDay: null,
        maximumEventCount: 1,
        providerModelId: "openai:gpt-memory",
        spendLimitMicros: 5_000_000,
        dryRun: 1,
      },
    );
    await expect(env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
      job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
      end_event_sequence, start_day, end_day, maximum_event_count,
      provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
      status, final_receipt_hash, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 'openai:gpt-memory', 5000000, 1,
      NULL, 'pending', NULL, NULL, ?, ?)`)
      .bind(
        oversizedJobId, owner.principalId, oversizedCommand.eventId,
        source.sequence, historicalMessage.sequence, timestamp, timestamp,
      ).run()).rejects.toThrow(/memory_reprocess_job_authorization_invalid/u);

    const item = await seedActiveItem(owner.principalId, source);
    const forgottenTransitionId = nextUlid();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'forgotten', 'old message is not a command', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        forgottenTransitionId, owner.principalId, item.itemId, item.versionId,
        historicalMessage.eventId, timestamp,
      ).run()).rejects.toThrow(/memory_item_transition_invalid/u);

    const topicId = nextUlid();
    await expect(env.DB.prepare(`INSERT INTO memory_topic_events (
      topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
      new_parent_topic_id, previous_display_name, previous_normalized_name,
      new_display_name, new_normalized_name, merge_target_topic_id,
      reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
      reason, actor, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 'create', NULL, NULL, NULL, NULL, 'Old message topic',
      'old message topic', NULL, '[]', '[]', '[]', 'old message is not a command',
      'owner', ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, topicId,
        historicalMessage.eventId, timestamp,
      ).run()).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("binds owner commands to transition, suppression, topic, and placement operands", async () => {
    const owner = await seedPrincipal();
    const first = await seedEvent(owner.principalId);
    const second = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, first, "proposed");
    const transitionId = nextUlid();
    const transitionCommand = await seedOwnerCommand(
      owner.principalId,
      "item.transition",
      transitionId,
      {
        itemId: item.itemId,
        versionId: item.versionId,
        lifecycleState: "active",
      },
    );
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'rejected', 'operand mismatch', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        transitionId,
        owner.principalId,
        item.itemId,
        item.versionId,
        transitionCommand.eventId,
        laterTimestamp,
      ).run()).rejects.toThrow(/memory_item_transition_invalid/u);

    const suppressionId = nextUlid();
    const suppressionCommand = await seedOwnerCommand(
      owner.principalId,
      "history.suppress",
      suppressionId,
      {
        targetEventId: second.eventId,
        startEventSequence: null,
        endEventSequence: null,
        newlyHiddenTurnCount: 1,
        totalCoveredTurnCount: 1,
      },
    );
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'operand mismatch', 1, 1, ?)`)
      .bind(
        suppressionId,
        owner.principalId,
        first.eventId,
        suppressionCommand.eventId,
        laterTimestamp,
      ).run()).rejects.toThrow(/memory_event_suppression_invalid/u);

    const rootId = nextUlid();
    const otherParentId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId,
      topicId: rootId,
      operation: "create",
      newDisplayName: "Root",
      newNormalizedName: "root",
    });
    await insertTopicEvent({
      principalId: owner.principalId,
      topicId: otherParentId,
      operation: "create",
      newParentTopicId: rootId,
      newDisplayName: "Other parent",
      newNormalizedName: "other parent",
    });
    const ownerTopicId = nextUlid();
    const ownerTopicEventId = nextUlid();
    const topicCommand = await seedOwnerCommand(
      owner.principalId,
      "topic.create",
      ownerTopicEventId,
      {
        topicId: ownerTopicId,
        newParentTopicId: rootId,
        newDisplayName: "Owner topic",
        newNormalizedName: "owner topic",
        mergeTargetTopicId: null,
        addedAliases: [],
      },
    );
    await expect(insertTopicEvent({
      topicEventId: ownerTopicEventId,
      principalId: owner.principalId,
      topicId: ownerTopicId,
      operation: "create",
      newParentTopicId: otherParentId,
      newDisplayName: "Owner topic",
      newNormalizedName: "owner topic",
      actor: "owner",
      ownerAuthorizingEventId: topicCommand.eventId,
    })).rejects.toThrow(/memory_topic_event_invalid/u);

    const placementEventId = nextUlid();
    const placementId = nextUlid();
    const placementCommand = await seedOwnerCommand(
      owner.principalId,
      "placement.place",
      placementEventId,
      {
        placementId,
        itemId: item.itemId,
        previousTopicId: null,
        newTopicId: rootId,
        relation: "related",
      },
    );
    await expect(env.DB.prepare(`INSERT INTO memory_item_placement_events (
      placement_event_id, principal_id, placement_id, placement_event_number,
      item_id, operation, previous_topic_id, new_topic_id, relation,
      filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'place', NULL, ?, 'related', 'owner', 1.0,
      'operand mismatch', ?, ?)`)
      .bind(
        placementEventId,
        owner.principalId,
        placementId,
        item.itemId,
        otherParentId,
        placementCommand.eventId,
        laterTimestamp,
      ).run()).rejects.toThrow(/memory_item_placement_event_invalid/u);
  });

  it("binds owner topic commands to the exact alias payload", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    const topicId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Before", newNormalizedName: "before",
    });
    const topicEventId = nextUlid();
    const command = await seedOwnerCommand(
      owner.principalId,
      "topic.rename",
      topicEventId,
      {
        topicId,
        newParentTopicId: null,
        newDisplayName: "After",
        newNormalizedName: "after",
        mergeTargetTopicId: null,
        addedAliases: [],
      },
    );
    await expect(insertTopicEvent({
      topicEventId,
      principalId: owner.principalId,
      topicId,
      operation: "rename",
      previousDisplayName: "Before",
      previousNormalizedName: "before",
      newDisplayName: "After",
      newNormalizedName: "after",
      addedAliases: [{
        aliasId: nextUlid(), topicId, displayName: "Before",
        normalizedName: "before", pathAlias: "Root/Before",
      }],
      actor: "owner",
      ownerAuthorizingEventId: command.eventId,
    })).rejects.toThrow(/memory_topic_event_invalid/u);

    const acceptedEventId = nextUlid();
    const acceptedAliases = [{
      aliasId: nextUlid(), topicId, displayName: "Before",
      normalizedName: "before", pathAlias: "Root/Before",
    }];
    const acceptedCommand = await seedOwnerCommand(
      owner.principalId,
      "topic.rename",
      acceptedEventId,
      {
        topicId,
        newParentTopicId: null,
        newDisplayName: "After",
        newNormalizedName: "after",
        mergeTargetTopicId: null,
        addedAliases: acceptedAliases,
      },
    );
    await insertTopicEvent({
      topicEventId: acceptedEventId,
      principalId: owner.principalId,
      topicId,
      operation: "rename",
      previousDisplayName: "Before",
      previousNormalizedName: "before",
      newDisplayName: "After",
      newNormalizedName: "after",
      addedAliases: acceptedAliases,
      actor: "owner",
      ownerAuthorizingEventId: acceptedCommand.eventId,
    });
    expect(await env.DB.prepare("SELECT display_name FROM memory_topics WHERE topic_id = ?")
      .bind(topicId).first()).toEqual({ display_name: "After" });
  });

  it("isolates owner transition item and version operand bindings", async () => {
    const owner = await seedPrincipal();
    const item = await seedActiveItem(owner.principalId, await seedEvent(owner.principalId), "proposed");
    const other = await seedActiveItem(owner.principalId, await seedEvent(owner.principalId), "proposed");
    for (const mismatch of ["itemId", "versionId"] as const) {
      const transitionId = nextUlid();
      const command = await seedOwnerCommand(
        owner.principalId,
        "item.transition",
        transitionId,
        {
          itemId: mismatch === "itemId" ? other.itemId : item.itemId,
          versionId: mismatch === "versionId" ? other.versionId : item.versionId,
          lifecycleState: "active",
        },
      );
      await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 2, ?, 'active', 'isolated operand mismatch', 'owner',
        'policy-v1', ?, ?)`)
        .bind(
          transitionId, owner.principalId, item.itemId, item.versionId,
          command.eventId, laterTimestamp,
        ).run()).rejects.toThrow(/memory_item_transition_invalid/u);
    }
  });

  it("isolates owner range-suppression range and count operand bindings", async () => {
    const owner = await seedPrincipal();
    const first = await seedEvent(owner.principalId);
    await seedEvent(owner.principalId);
    const last = await seedEvent(owner.principalId);
    const correct = {
      targetEventId: null,
      startEventSequence: first.sequence,
      endEventSequence: last.sequence,
      newlyHiddenTurnCount: 3,
      totalCoveredTurnCount: 3,
    };
    const mismatches: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      { startEventSequence: first.sequence + 1 },
      { endEventSequence: last.sequence - 1 },
      { newlyHiddenTurnCount: 2 },
      { totalCoveredTurnCount: 2 },
    ];
    for (const mismatch of mismatches) {
      const suppressionId = nextUlid();
      const command = await seedOwnerCommand(
        owner.principalId,
        "history.suppress",
        suppressionId,
        { ...correct, ...mismatch },
      );
      await expect(env.DB.prepare(`INSERT INTO memory_event_suppressions (
        suppression_id, principal_id, target_event_id, start_event_sequence,
        end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
        source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, 'isolated range operand', 3, 3, ?)`)
        .bind(
          suppressionId, owner.principalId, first.sequence, last.sequence,
          command.eventId, laterTimestamp,
        ).run()).rejects.toThrow(/memory_event_suppression_invalid/u);
    }
  });

  it("isolates every per-source item-forget suppression operand", async () => {
    const owner = await seedPrincipal();
    const fields = [
      "suppressionId",
      "targetEventId",
      "startEventSequence",
      "endEventSequence",
      "sourceId",
      "newlyHiddenTurnCount",
      "totalCoveredTurnCount",
    ] as const;
    for (const field of fields) {
      const target = await seedEvent(owner.principalId);
      const otherTarget = await seedEvent(owner.principalId);
      const item = await seedActiveItem(owner.principalId, target);
      const forgottenTransitionId = nextUlid();
      const suppressionId = nextUlid();
      const correctEntry = {
        suppressionId,
        targetEventId: target.eventId,
        startEventSequence: null,
        endEventSequence: null,
        sourceId: item.sourceId,
        newlyHiddenTurnCount: 1,
        totalCoveredTurnCount: 1,
      };
      const wrongValue: Readonly<Record<string, unknown>> = {
        [field]: field === "suppressionId" || field === "sourceId" ? nextUlid()
          : field === "targetEventId" ? otherTarget.eventId
            : field === "startEventSequence" || field === "endEventSequence" ? target.sequence
              : field === "newlyHiddenTurnCount" ? 0 : 2,
      };
      const command = await seedOwnerCommand(
        owner.principalId,
        "item.forget",
        forgottenTransitionId,
        {
          itemId: item.itemId,
          versionId: item.versionId,
          lifecycleState: "forgotten",
          suppressions: [{ ...correctEntry, ...wrongValue }],
        },
      );
      await env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 2, ?, 'forgotten', 'isolated forget operand', 'owner',
        'policy-v1', ?, ?)`)
        .bind(
          forgottenTransitionId, owner.principalId, item.itemId,
          item.versionId, command.eventId, laterTimestamp,
        ).run();
      await expect(env.DB.prepare(`INSERT INTO memory_event_suppressions (
        suppression_id, principal_id, target_event_id, start_event_sequence,
        end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
        source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'isolated forget operand', 1, 1, ?)`)
        .bind(
          suppressionId, owner.principalId, target.eventId, command.eventId,
          forgottenTransitionId, item.sourceId, laterTimestamp,
        ).run()).rejects.toThrow(/memory_event_suppression_invalid/u);
    }
  });

  it("isolates the owner lift suppression-id binding", async () => {
    const owner = await seedPrincipal();
    const target = await seedEvent(owner.principalId);
    const suppressionId = nextUlid();
    const suppressionCommand = await seedOwnerCommand(
      owner.principalId,
      "history.suppress",
      suppressionId,
      {
        targetEventId: target.eventId,
        startEventSequence: null,
        endEventSequence: null,
        newlyHiddenTurnCount: 1,
        totalCoveredTurnCount: 1,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'lift operand fixture', 1, 1, ?)`)
      .bind(
        suppressionId, owner.principalId, target.eventId,
        suppressionCommand.eventId, timestamp,
      ).run();
    const liftId = nextUlid();
    const liftCommand = await seedOwnerCommand(
      owner.principalId,
      "history.lift",
      liftId,
      { suppressionId: nextUlid() },
    );
    await expect(env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'isolated lift operand', ?)`)
      .bind(
        liftId, owner.principalId, suppressionId, liftCommand.eventId, laterTimestamp,
      ).run()).rejects.toThrow(/memory_event_suppression_lift_invalid/u);
  });

  it("isolates owner topic identity, parent, name, and merge-target bindings", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    const otherParentId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: otherParentId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Other parent",
      newNormalizedName: "other parent",
    });
    for (const field of [
      "topicId", "newParentTopicId", "newDisplayName", "newNormalizedName",
    ] as const) {
      const topicId = nextUlid();
      const topicEventId = nextUlid();
      const correct = {
        topicId,
        newParentTopicId: rootId,
        newDisplayName: `Owner topic ${field}`,
        newNormalizedName: `owner topic ${field.toLowerCase()}`,
        mergeTargetTopicId: null,
        addedAliases: [],
      };
      const mismatch: Readonly<Record<string, unknown>> = {
        [field]: field === "topicId" ? nextUlid()
          : field === "newParentTopicId" ? otherParentId
            : field === "newDisplayName" ? "Wrong display"
              : "wrong normalized",
      };
      const command = await seedOwnerCommand(
        owner.principalId,
        "topic.create",
        topicEventId,
        { ...correct, ...mismatch },
      );
      await expect(insertTopicEvent({
        topicEventId,
        principalId: owner.principalId,
        topicId,
        operation: "create",
        newParentTopicId: rootId,
        newDisplayName: correct.newDisplayName,
        newNormalizedName: correct.newNormalizedName,
        actor: "owner",
        ownerAuthorizingEventId: command.eventId,
      })).rejects.toThrow(/memory_topic_event_invalid/u);
    }

    const sourceId = nextUlid();
    const targetId = nextUlid();
    const otherTargetId = nextUlid();
    for (const [topicId, displayName] of [
      [sourceId, "Merge source"],
      [targetId, "Merge target"],
      [otherTargetId, "Other target"],
    ] as const) {
      await insertTopicEvent({
        principalId: owner.principalId, topicId, operation: "create",
        newParentTopicId: rootId, newDisplayName: displayName,
        newNormalizedName: displayName.toLowerCase(),
      });
    }
    const mergeEventId = nextUlid();
    const aliases = [{
      aliasId: nextUlid(), topicId: targetId, displayName: "Merge source",
      normalizedName: "merge source", pathAlias: "Root/Merge source",
    }];
    const mergeCommand = await seedOwnerCommand(
      owner.principalId,
      "topic.merge",
      mergeEventId,
      {
        topicId: sourceId,
        newParentTopicId: null,
        newDisplayName: null,
        newNormalizedName: null,
        mergeTargetTopicId: otherTargetId,
        addedAliases: aliases,
      },
    );
    await expect(insertTopicEvent({
      topicEventId: mergeEventId,
      principalId: owner.principalId,
      topicId: sourceId,
      operation: "merge",
      previousDisplayName: "Merge source",
      previousNormalizedName: "merge source",
      mergeTargetTopicId: targetId,
      addedAliases: aliases,
      actor: "owner",
      ownerAuthorizingEventId: mergeCommand.eventId,
    })).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("isolates every owner placement operand binding", async () => {
    const owner = await seedPrincipal();
    const item = await seedActiveItem(owner.principalId, await seedEvent(owner.principalId));
    const otherItem = await seedActiveItem(owner.principalId, await seedEvent(owner.principalId));
    const rootId = nextUlid();
    const topicId = nextUlid();
    const otherTopicId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    for (const [childId, name] of [[topicId, "Topic"], [otherTopicId, "Other topic"]] as const) {
      await insertTopicEvent({
        principalId: owner.principalId, topicId: childId, operation: "create",
        newParentTopicId: rootId, newDisplayName: name, newNormalizedName: name.toLowerCase(),
      });
    }
    for (const field of [
      "placementId", "itemId", "previousTopicId", "newTopicId", "relation",
    ] as const) {
      const placementEventId = nextUlid();
      const placementId = nextUlid();
      const correct = {
        placementId,
        itemId: item.itemId,
        previousTopicId: null,
        newTopicId: topicId,
        relation: "primary",
      };
      const mismatch: Readonly<Record<string, unknown>> = {
        [field]: field === "placementId" ? nextUlid()
          : field === "itemId" ? otherItem.itemId
            : field === "previousTopicId" ? otherTopicId
              : field === "newTopicId" ? otherTopicId : "related",
      };
      const command = await seedOwnerCommand(
        owner.principalId,
        "placement.place",
        placementEventId,
        { ...correct, ...mismatch },
      );
      await expect(env.DB.prepare(`INSERT INTO memory_item_placement_events (
        placement_event_id, principal_id, placement_id, placement_event_number,
        item_id, operation, previous_topic_id, new_topic_id, relation,
        filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 1, ?, 'place', NULL, ?, 'primary', 'owner', 1.0,
        'isolated placement operand', ?, ?)`)
        .bind(
          placementEventId, owner.principalId, placementId, item.itemId,
          topicId, command.eventId, laterTimestamp,
        ).run()).rejects.toThrow(/memory_item_placement_event_invalid/u);
    }
  });

  it("bounds settlements and releases by their reservation", async () => {
    const fixture = await triggerFixture();
    const insertTerminal = (entryType: "settlement" | "release", amount: number) =>
      env.DB.prepare(`INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros,
        price_id, occurred_at
      ) VALUES (?, ?, ?, ?, ?, 'deepseek', 'deepseek:deepseek-v4-pro',
        'normal_monthly', NULL, ?, ?, ?)`)
        .bind(
          nextUlid(), fixture.ownerId, fixture.keys.memory_runs, entryType,
          fixture.keys.memory_cost_ledger, amount, fixture.keys.memory_model_prices,
          laterTimestamp,
        ).run();
    await expect(insertTerminal("settlement", 2))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
    await expect(insertTerminal("release", 0))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
  });

  it("enforces the reprocessing budget class, dry-run boundary, and cumulative job limit", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const priceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', ?, 1, 1, 0,
      'USD', 'reprocessing test price', ?)`)
      .bind(priceId, owner.principalId, timestamp, timestamp).run();
    const jobId = nextUlid();
    const command = await seedOwnerCommand(
      owner.principalId,
      "reprocess.create",
      jobId,
      {
        startEventSequence: source.sequence,
        endEventSequence: source.sequence,
        startDay: null,
        endDay: null,
        maximumEventCount: 1,
        providerModelId: "deepseek:deepseek-v4-pro",
        spendLimitMicros: 100,
        dryRun: 0,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
      job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
      end_event_sequence, start_day, end_day, maximum_event_count,
      provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
      status, final_receipt_hash, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 'deepseek:deepseek-v4-pro', 100, 0,
      NULL, 'pending', NULL, NULL, ?, ?)`)
      .bind(
        jobId, owner.principalId, command.eventId, source.sequence, source.sequence,
        timestamp, timestamp,
      ).run();
    const reprocessRunId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, reprocess_job_id,
      start_event_sequence, end_event_sequence, provider_model_id, price_id,
      outcome, started_at
    ) VALUES (?, ?, ?, 'reprocessing', ?, ?, ?, 'deepseek:deepseek-v4-pro', ?,
      'running', ?)`)
      .bind(
        reprocessRunId, owner.principalId, `reprocess:${reprocessRunId}`, jobId,
        source.sequence, source.sequence, priceId, timestamp,
      ).run();
    const insertReservation = (runId: string, targetJobId: string, amount: number) =>
      env.DB.prepare(`INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros,
        price_id, occurred_at
      ) VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:deepseek-v4-pro',
        'reprocessing', ?, ?, ?, ?)`)
        .bind(nextUlid(), owner.principalId, runId, targetJobId, amount, priceId, timestamp).run();
    await insertReservation(reprocessRunId, jobId, 60);
    await expect(insertReservation(reprocessRunId, jobId, 41))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);

    const normalRunId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
      provider_model_id, price_id, outcome, started_at
    ) VALUES (?, ?, ?, 'distillation', ?, ?, 'deepseek:deepseek-v4-pro', ?,
      'running', ?)`)
      .bind(
        normalRunId, owner.principalId, `normal:${normalRunId}`,
        source.sequence, source.sequence, priceId, timestamp,
      ).run();
    await expect(insertReservation(normalRunId, jobId, 1))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);

    const dryJobId = nextUlid();
    const dryCommand = await seedOwnerCommand(
      owner.principalId,
      "reprocess.create",
      dryJobId,
      {
        startEventSequence: source.sequence,
        endEventSequence: source.sequence,
        startDay: null,
        endDay: null,
        maximumEventCount: 1,
        providerModelId: "deepseek:deepseek-v4-pro",
        spendLimitMicros: 100,
        dryRun: 1,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
      job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
      end_event_sequence, start_day, end_day, maximum_event_count,
      provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
      status, final_receipt_hash, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 'deepseek:deepseek-v4-pro', 100, 1,
      NULL, 'pending', NULL, NULL, ?, ?)`)
      .bind(
        dryJobId, owner.principalId, dryCommand.eventId,
        source.sequence, source.sequence, timestamp, timestamp,
      ).run();
    const dryRunId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, reprocess_job_id,
      start_event_sequence, end_event_sequence, provider_model_id, price_id,
      outcome, started_at
    ) VALUES (?, ?, ?, 'reprocessing', ?, ?, ?, 'deepseek:deepseek-v4-pro', ?,
      'running', ?)`)
      .bind(
        dryRunId, owner.principalId, `dry:${dryRunId}`, dryJobId,
        source.sequence, source.sequence, priceId, timestamp,
      ).run();
    await expect(insertReservation(dryRunId, dryJobId, 1))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
  });

  it("supports bounded day-range cost and records terminal-job settlement plus overrun", async () => {
    const owner = await seedPrincipal();
    const first = await seedEvent(owner.principalId);
    const second = await seedEvent(owner.principalId);
    const outsideDay = new Date(testClock - 2 * 24 * 60 * 60 * 1000).toISOString();
    const outside = await seedEvent(owner.principalId, "conversation.user_committed", outsideDay);
    const priceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', ?, 1, 1, 0,
      'USD', 'day-range test price', ?)`)
      .bind(priceId, owner.principalId, timestamp, timestamp).run();
    const jobId = nextUlid();
    const localDay = timestamp.slice(0, 10);
    const command = await seedOwnerCommand(
      owner.principalId,
      "reprocess.create",
      jobId,
      {
        startEventSequence: null,
        endEventSequence: null,
        startDay: localDay,
        endDay: localDay,
        maximumEventCount: 10,
        providerModelId: "deepseek:deepseek-v4-pro",
        spendLimitMicros: 100,
        dryRun: 0,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
      job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
      end_event_sequence, start_day, end_day, maximum_event_count,
      provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
      status, final_receipt_hash, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, 10, 'deepseek:deepseek-v4-pro', 100, 0,
      NULL, 'pending', NULL, NULL, ?, ?)`)
      .bind(
        jobId,
        owner.principalId,
        command.eventId,
        localDay,
        localDay,
        timestamp,
        timestamp,
      ).run();
    const runId = nextUlid();
    const insertRun = (candidateRunId: string, start: number, end: number) =>
      env.DB.prepare(`INSERT INTO memory_runs (
        run_id, principal_id, run_key, job, reprocess_job_id,
        start_event_sequence, end_event_sequence, provider_model_id, price_id,
        outcome, started_at
      ) VALUES (?, ?, ?, 'reprocessing', ?, ?, ?, 'deepseek:deepseek-v4-pro', ?,
        'running', ?)`)
        .bind(
          candidateRunId,
          owner.principalId,
          `day-range:${candidateRunId}`,
          jobId,
          start,
          end,
          priceId,
          timestamp,
        ).run();
    await expect(insertRun(nextUlid(), first.sequence, outside.sequence))
      .rejects.toThrow(/memory_run_initial_state_invalid/u);
    await insertRun(runId, first.sequence, second.sequence);
    const reservationId = nextUlid();
    const insertCost = (
      entryType: "reservation" | "settlement" | "release" | "overrun",
      amount: number,
      reservationEntryId: string | null,
      costEntryId = nextUlid(),
    ) => env.DB.prepare(`INSERT INTO memory_cost_ledger (
      cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
      provider, model_id, budget_class, reprocess_job_id, amount_micros,
      price_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, 'deepseek', 'deepseek:deepseek-v4-pro',
      'reprocessing', ?, ?, ?, ?)`)
      .bind(
        costEntryId,
        owner.principalId,
        runId,
        entryType,
        reservationEntryId,
        jobId,
        amount,
        priceId,
        laterTimestamp,
      ).run();
    await insertCost("reservation", 100, null, reservationId);
    await env.DB.prepare(`UPDATE memory_reprocess_jobs
      SET status = 'cancelled', final_receipt_hash = ?, updated_at = ?
      WHERE principal_id = ? AND job_id = ?`)
      .bind(nextHash(), laterTimestamp, owner.principalId, jobId).run();
    await insertCost("settlement", 100, reservationId);
    await insertCost("overrun", 10, reservationId);
    await expect(insertCost("overrun", 1, reservationId))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
    await expect(insertCost("reservation", 1, null, nextUlid()))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
    expect(await env.DB.prepare(`SELECT sum(amount_micros) AS total
      FROM memory_cost_ledger WHERE principal_id = ? AND run_id = ?
        AND entry_type IN ('settlement', 'overrun')`)
      .bind(owner.principalId, runId).first()).toEqual({ total: 110 });
  });

  it("rejects run starts outside the five-minute clock-skew window", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const priceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', ?, 1, 1, 0,
      'USD', 'backdate test price', ?)`)
      .bind(priceId, owner.principalId, timestamp, timestamp).run();
    const backdated = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await expect(env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
      provider_model_id, price_id, outcome, started_at
    ) VALUES (?, ?, ?, 'distillation', ?, ?, 'deepseek:deepseek-v4-pro', ?,
      'running', ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        `backdated:${nextUlid()}`,
        source.sequence,
        source.sequence,
        priceId,
        backdated,
      ).run()).rejects.toThrow(/memory_run_initial_state_invalid/u);
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await expect(env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
      provider_model_id, price_id, outcome, started_at
    ) VALUES (?, ?, ?, 'distillation', ?, ?, 'deepseek:deepseek-v4-pro', ?,
      'running', ?)`)
      .bind(
        nextUlid(), owner.principalId, `future:${nextUlid()}`,
        source.sequence, source.sequence, priceId, future,
      ).run()).rejects.toThrow(/memory_run_initial_state_invalid/u);
  });

  it("rejects cost ledger entries dated more than five minutes in the future", async () => {
    const fixture = await triggerFixture();
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await expect(env.DB.prepare(`INSERT INTO memory_cost_ledger (
      cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
      provider, model_id, budget_class, reprocess_job_id, amount_micros,
      price_id, occurred_at
    ) VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:deepseek-v4-pro',
      'normal_monthly', NULL, 1, ?, ?)`)
      .bind(
        nextUlid(), fixture.ownerId, fixture.keys.memory_runs,
        fixture.keys.memory_model_prices, future,
      ).run()).rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
  });

  it("pins item-state keys against UPDATE OR REPLACE", async () => {
    const owner = await seedPrincipal();
    const left = await seedActiveItem(owner.principalId, await seedEvent(owner.principalId));
    const right = await seedActiveItem(
      owner.principalId,
      await seedEvent(owner.principalId),
      "proposed",
    );
    const rightTransitionId = await insertOwnerTransition({
      principalId: owner.principalId,
      itemId: right.itemId,
      versionId: right.versionId,
      transitionNumber: 2,
      lifecycleState: "active",
    });
    await expect(env.DB.prepare(`UPDATE OR REPLACE memory_item_state
      SET item_id = ?, current_version_id = ?, lifecycle_state = 'active',
        last_transition_id = ?, last_transition_number = 2, updated_at = ?
      WHERE principal_id = ? AND item_id = ?`)
      .bind(
        right.itemId,
        right.versionId,
        rightTransitionId,
        laterTimestamp,
        owner.principalId,
        left.itemId,
      ).run()).rejects.toThrow(/memory_item_state_requires_transition/u);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_state
      WHERE principal_id = ? AND item_id IN (?, ?)`)
      .bind(owner.principalId, left.itemId, right.itemId).first()).toEqual({ count: 2 });
  });

  it("pins topic keys against UPDATE OR REPLACE", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    const destinationId = nextUlid();
    const leftId = nextUlid();
    const rightId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId,
      topicId: rootId,
      operation: "create",
      newDisplayName: "Root",
      newNormalizedName: "root",
    });
    for (const [topicId, name] of [
      [destinationId, "Destination"],
      [leftId, "Left"],
      [rightId, "Right"],
    ] as const) {
      await insertTopicEvent({
        principalId: owner.principalId,
        topicId,
        operation: "create",
        newParentTopicId: rootId,
        newDisplayName: name,
        newNormalizedName: name.toLowerCase(),
      });
    }
    const rightMoveId = await insertTopicEvent({
      principalId: owner.principalId,
      topicId: rightId,
      operation: "move",
      previousParentTopicId: rootId,
      newParentTopicId: destinationId,
    });
    await expect(env.DB.prepare(`UPDATE OR REPLACE memory_topics
      SET topic_id = ?, parent_topic_id = ?, last_topic_event_id = ?, updated_at = ?
      WHERE principal_id = ? AND topic_id = ?`)
      .bind(
        rightId,
        destinationId,
        rightMoveId,
        timestamp,
        owner.principalId,
        leftId,
      ).run()).rejects.toThrow(/memory_topic_update_requires_event/u);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
      WHERE principal_id = ? AND topic_id IN (?, ?)`)
      .bind(owner.principalId, leftId, rightId).first()).toEqual({ count: 2 });
  });

  it("pins placement-state keys and relation against UPDATE OR REPLACE", async () => {
    const owner = await seedPrincipal();
    const leftItem = await seedActiveItem(owner.principalId, await seedEvent(owner.principalId));
    const rightItem = await seedActiveItem(owner.principalId, await seedEvent(owner.principalId));
    const rootId = nextUlid();
    const topicIds = [nextUlid(), nextUlid()] as const;
    await insertTopicEvent({
      principalId: owner.principalId,
      topicId: rootId,
      operation: "create",
      newDisplayName: "Root",
      newNormalizedName: "root",
    });
    for (const [index, topicId] of topicIds.entries()) {
      await insertTopicEvent({
        principalId: owner.principalId,
        topicId,
        operation: "create",
        newParentTopicId: rootId,
        newDisplayName: `Topic ${index}`,
        newNormalizedName: `topic ${index}`,
      });
    }
    const leftPlacementId = nextUlid();
    const rightPlacementId = nextUlid();
    const insertPlacement = (
      eventId: string,
      placementId: string,
      eventNumber: number,
      itemId: string,
      operation: "place" | "refile",
      previousTopicId: string | null,
      newTopicId: string,
    ) => env.DB.prepare(`INSERT INTO memory_item_placement_events (
      placement_event_id, principal_id, placement_id, placement_event_number,
      item_id, operation, previous_topic_id, new_topic_id, relation,
      filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'related', 'rule', 1.0,
      'replace-key regression', NULL, ?)`)
      .bind(
        eventId,
        owner.principalId,
        placementId,
        eventNumber,
        itemId,
        operation,
        previousTopicId,
        newTopicId,
        timestamp,
      ).run();
    await insertPlacement(nextUlid(), leftPlacementId, 1, leftItem.itemId, "place", null, topicIds[0]);
    await insertPlacement(nextUlid(), rightPlacementId, 1, rightItem.itemId, "place", null, topicIds[0]);
    const rightRefileId = nextUlid();
    await insertPlacement(
      rightRefileId,
      rightPlacementId,
      2,
      rightItem.itemId,
      "refile",
      topicIds[0],
      topicIds[1],
    );
    await expect(env.DB.prepare(`UPDATE OR REPLACE memory_item_placement_state
      SET placement_id = ?, item_id = ?, topic_id = ?, relation = 'related',
        status = 'active', last_event_kind = 'placement', last_event_id = ?,
        last_placement_event_number = 2, updated_at = ?
      WHERE principal_id = ? AND placement_id = ?`)
      .bind(
        rightPlacementId,
        rightItem.itemId,
        topicIds[1],
        rightRefileId,
        timestamp,
        owner.principalId,
        leftPlacementId,
      ).run()).rejects.toThrow(/memory_item_placement_state_requires_event/u);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_placement_state
      WHERE principal_id = ? AND placement_id IN (?, ?)`)
      .bind(owner.principalId, leftPlacementId, rightPlacementId).first()).toEqual({ count: 2 });
  });

  it("rejects INSERT OR REPLACE through every FTS content rowid alias", async () => {
    const owner = await seedPrincipal();
    const first = await seedEvent(owner.principalId);
    const itemId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(itemId, owner.principalId, first.eventId, first.sequence, timestamp).run();
    const versionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'Version rowid sentinel.', 'NFC', ?, 'observed',
      'deterministic_observation', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(versionId, owner.principalId, itemId, nextHash(), timestamp).run();
    const version = await env.DB.prepare(`SELECT version_rowid FROM memory_item_versions
      WHERE version_id = ?`).bind(versionId).first<{ version_rowid: number }>();
    if (version === null) throw new Error("memory_version_rowid_missing");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO memory_item_versions (
      version_rowid, version_id, principal_id, item_id, version_number, text,
      text_normalization, text_hash, basis, origin, uncertain, sensitivity,
      valid_from, valid_to, extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, ?, 2, 'Replacement version.', 'NFC', ?, 'observed',
      'deterministic_observation', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(
        version.version_rowid,
        nextUlid(),
        owner.principalId,
        itemId,
        nextHash(),
        timestamp,
      ).run()).rejects.toThrow(/memory_item_version_lineage_invalid/u);

    const episodeId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_episodes (
      episode_id, principal_id, local_day, start_event_sequence, end_event_sequence,
      source_count, text, content_hash, summarizer_version, summarizer_model_id,
      supersedes_episode_id, created_at
    ) VALUES (?, ?, '2026-09-14', ?, ?, 1, 'Episode rowid sentinel.', ?, 'summary-v1',
      'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(
        episodeId,
        owner.principalId,
        first.sequence,
        first.sequence,
        nextHash(),
        timestamp,
      ).run();
    const episode = await env.DB.prepare(`SELECT episode_rowid FROM memory_episodes
      WHERE episode_id = ?`).bind(episodeId).first<{ episode_rowid: number }>();
    if (episode === null) throw new Error("memory_episode_rowid_missing");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO memory_episodes (
      episode_rowid, episode_id, principal_id, local_day, start_event_sequence,
      end_event_sequence, source_count, text, content_hash, summarizer_version,
      summarizer_model_id, supersedes_episode_id, created_at
    ) VALUES (?, ?, ?, '2026-09-14', ?, ?, 1, 'Replacement episode.', ?,
      'summary-v1', 'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(
        episode.episode_rowid,
        nextUlid(),
        owner.principalId,
        first.sequence,
        first.sequence,
        nextHash(),
        timestamp,
      ).run()).rejects.toThrow(/memory_episode_duplicate/u);

    const second = await seedEvent(owner.principalId);
    const firstReceipt = nextHash();
    const secondReceipt = nextHash();
    for (const [event, receipt] of [[first, firstReceipt], [second, secondReceipt]] as const) {
      await env.DB.prepare(`INSERT INTO memory_history_coverage (
        coverage_id, principal_id, source_location, start_event_sequence,
        end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
        failure_code, indexed_at
      ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
        .bind(
          nextUlid(),
          owner.principalId,
          event.sequence,
          event.sequence,
          receipt,
          timestamp,
        ).run();
    }
    const chunkId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'rowidsentinel', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunkId,
        owner.principalId,
        first.sequence,
        first.sequence,
        nextHash(),
        firstReceipt,
        timestamp,
        timestamp,
      ).run();
    const chunk = await env.DB.prepare(`SELECT chunk_rowid FROM memory_history_chunks
      WHERE chunk_id = ?`).bind(chunkId).first<{ chunk_rowid: number }>();
    if (chunk === null) throw new Error("memory_chunk_rowid_missing");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO memory_history_chunks (
      chunk_rowid, chunk_id, principal_id, start_event_sequence, end_event_sequence,
      text, content_hash, source_location, r2_segment_id, source_receipt_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'replacement chunk', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunk.chunk_rowid,
        nextUlid(),
        owner.principalId,
        second.sequence,
        second.sequence,
        nextHash(),
        secondReceipt,
        laterTimestamp,
        laterTimestamp,
      ).run()).rejects.toThrow(/memory_history_chunk_receipt_invalid/u);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_history_fts
      WHERE memory_history_fts MATCH 'rowidsentinel'`)
      .first()).toEqual({ count: 1 });
  });

  it("prevents rules from overwriting owner state except due time-bounded expiry", async () => {
    const owner = await seedPrincipal();
    const confirmed = await seedActiveItem(
      owner.principalId,
      await seedEvent(owner.principalId),
      "proposed",
    );
    await insertOwnerTransition({
      principalId: owner.principalId,
      itemId: confirmed.itemId,
      versionId: confirmed.versionId,
      transitionNumber: 2,
      lifecycleState: "active",
    });
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 3, ?, 'expired', 'rules overwrite', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        confirmed.itemId,
        confirmed.versionId,
        laterTimestamp,
      ).run()).rejects.toThrow(/memory_item_transition_invalid/u);

    const superseded = await seedActiveItem(
      owner.principalId,
      await seedEvent(owner.principalId),
    );
    await insertOwnerTransition({
      principalId: owner.principalId,
      itemId: superseded.itemId,
      versionId: superseded.versionId,
      transitionNumber: 2,
      lifecycleState: "superseded",
    });
    const replacementVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 2, 'A deterministic replacement.', 'NFC', ?, 'observed',
      'deterministic_observation', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(
        replacementVersionId,
        owner.principalId,
        superseded.itemId,
        nextHash(),
        laterTimestamp,
      ).run();
    const replacementSource = await seedEvent(owner.principalId);
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'A deterministic replacement.', ?,
      'system', ?, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        superseded.itemId,
        replacementVersionId,
        replacementSource.eventId,
        replacementSource.sequence,
        nextHash(),
        laterTimestamp,
        laterTimestamp,
      ).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 3, ?, 'active', 'rules overwrite', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        superseded.itemId,
        replacementVersionId,
        laterTimestamp,
      ).run()).rejects.toThrow(/memory_item_transition_invalid/u);

    const expiringItemId = nextUlid();
    const expiringSource = await seedEvent(owner.principalId);
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'plan', ?, ?, ?)`)
      .bind(
        expiringItemId,
        owner.principalId,
        expiringSource.eventId,
        expiringSource.sequence,
        timestamp,
      ).run();
    const expiringVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'This plan expires.', 'NFC', ?, 'observed',
      'deterministic_observation', 0, 'normal', NULL, ?, 'policy-v1', NULL, ?)`)
      .bind(
        expiringVersionId,
        owner.principalId,
        expiringItemId,
        nextHash(),
        laterTimestamp,
        timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'This plan expires.', ?,
      'system', ?, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        expiringItemId,
        expiringVersionId,
        expiringSource.eventId,
        expiringSource.sequence,
        nextHash(),
        timestamp,
        timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'proposed', 'initial proposal', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        expiringItemId,
        expiringVersionId,
        timestamp,
      ).run();
    await insertOwnerTransition({
      principalId: owner.principalId,
      itemId: expiringItemId,
      versionId: expiringVersionId,
      transitionNumber: 2,
      lifecycleState: "active",
      occurredAt: timestamp,
    });
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 3, ?, 'expired', 'valid_to elapsed', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        expiringItemId,
        expiringVersionId,
        laterTimestamp,
      ).run();
    expect(await env.DB.prepare(`SELECT lifecycle_state FROM memory_item_state
      WHERE principal_id = ? AND item_id = ?`)
      .bind(owner.principalId, expiringItemId).first()).toEqual({ lifecycle_state: "expired" });
  });

  it("bounds rules expiry by wall clock and the current state timestamp", async () => {
    const owner = await seedPrincipal();
    const seedOwnerActivatedPlan = async (validTo: string) => {
      const source = await seedEvent(owner.principalId);
      const itemId = nextUlid();
      const versionId = nextUlid();
      await env.DB.prepare(`INSERT INTO memory_items (
        item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
      ) VALUES (?, ?, 'plan', ?, ?, ?)`)
        .bind(itemId, owner.principalId, source.eventId, source.sequence, timestamp).run();
      await env.DB.prepare(`INSERT INTO memory_item_versions (
        version_id, principal_id, item_id, version_number, text, text_normalization,
        text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
        extractor_version, extractor_model_id, created_at
      ) VALUES (?, ?, ?, 1, 'Time-bound plan.', 'NFC', ?, 'observed',
        'deterministic_observation', 0, 'normal', NULL, ?, 'policy-v1', NULL, ?)`)
        .bind(versionId, owner.principalId, itemId, nextHash(), validTo, timestamp).run();
      await env.DB.prepare(`INSERT INTO memory_item_sources (
        source_id, principal_id, item_id, version_id, source_position, event_id,
        event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
        channel, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'Time-bound plan.', ?,
        'system', ?, ?)`)
        .bind(
          nextUlid(), owner.principalId, itemId, versionId, source.eventId,
          source.sequence, nextHash(), timestamp, timestamp,
        ).run();
      await env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 1, ?, 'proposed', 'initial proposal', 'rules',
        'policy-v1', NULL, ?)`)
        .bind(nextUlid(), owner.principalId, itemId, versionId, timestamp).run();
      await insertOwnerTransition({
        principalId: owner.principalId,
        itemId,
        versionId,
        transitionNumber: 2,
        lifecycleState: "active",
      });
      return { itemId, versionId };
    };
    const insertRulesExpiry = (itemId: string, versionId: string, occurredAt: string) =>
      env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 3, ?, 'expired', 'rules expiry probe', 'rules',
        'policy-v1', NULL, ?)`)
        .bind(nextUlid(), owner.principalId, itemId, versionId, occurredAt).run();

    const futureValidTo = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const futureEscape = await seedOwnerActivatedPlan(futureValidTo);
    await expect(insertRulesExpiry(
      futureEscape.itemId,
      futureEscape.versionId,
      new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    )).rejects.toThrow(/memory_item_transition_invalid/u);
    await expect(insertRulesExpiry(
      futureEscape.itemId,
      futureEscape.versionId,
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    )).rejects.toThrow(/memory_item_transition_invalid/u);

    const outOfOrder = await seedOwnerActivatedPlan(timestamp);
    await expect(insertRulesExpiry(outOfOrder.itemId, outOfOrder.versionId, timestamp))
      .rejects.toThrow(/memory_item_transition_invalid/u);
  });

  it("rejects a preissued owner command after any newer owner transition", async () => {
    const owner = await seedPrincipal();
    const firstSource = await seedEvent(owner.principalId);
    const itemId = nextUlid();
    const firstVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'plan', ?, ?, ?)`)
      .bind(itemId, owner.principalId, firstSource.eventId, firstSource.sequence, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'Original plan.', 'NFC', ?, 'observed',
      'deterministic_observation', 0, 'normal', NULL, ?, 'policy-v1', NULL, ?)`)
      .bind(firstVersionId, owner.principalId, itemId, nextHash(), timestamp, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'Original plan.', ?, 'system', ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, itemId, firstVersionId, firstSource.eventId,
        firstSource.sequence, nextHash(), timestamp, timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'proposed', 'initial proposal', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, itemId, firstVersionId, timestamp).run();

    const secondSource = await seedEvent(owner.principalId);
    const secondVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 2, 'Corrected plan.', 'NFC', ?, 'observed',
      'deterministic_observation', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(secondVersionId, owner.principalId, itemId, nextHash(), timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'Corrected plan.', ?, 'system', ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, itemId, secondVersionId, secondSource.eventId,
        secondSource.sequence, nextHash(), timestamp, timestamp,
      ).run();
    const staleTransitionId = nextUlid();
    const staleCommand = await seedOwnerCommand(
      owner.principalId,
      "item.correct",
      staleTransitionId,
      { itemId, versionId: secondVersionId, lifecycleState: "active" },
    );
    await insertOwnerTransition({
      principalId: owner.principalId,
      itemId,
      versionId: firstVersionId,
      transitionNumber: 2,
      lifecycleState: "active",
    });
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 3, ?, 'expired', 'valid_to elapsed', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, itemId, firstVersionId, laterTimestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 4, ?, 'active', 'stale correction command', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        staleTransitionId, owner.principalId, itemId, secondVersionId,
        staleCommand.eventId, laterTimestamp,
      ).run()).rejects.toThrow(/memory_item_transition_invalid/u);
  });

  it("keeps inferred and third-party claims uncertain and owner-gates confirmed activation", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const itemId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(itemId, owner.principalId, source.eventId, source.sequence, timestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'A third party claimed this.', 'NFC', ?, 'third_party',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, itemId, nextHash(), timestamp).run())
      .rejects.toThrow();

    const versionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'I confirmed the detail.', 'NFC', ?, 'confirmed',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(versionId, owner.principalId, itemId, nextHash(), timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'I confirmed the detail.', ?,
      'telegram', ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, itemId, versionId, source.eventId,
        source.sequence, nextHash(), timestamp, timestamp,
      ).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'active', 'rules confirmation', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, itemId, versionId, timestamp).run())
      .rejects.toThrow(/memory_item_transition_invalid/u);
  });

  it("keeps archived-only first-person claims proposed until owner confirmation", async () => {
    const owner = await seedPrincipal();
    const archived = await seedArchivedReceipt();
    const itemId = nextUlid();
    const versionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(
        itemId,
        owner.principalId,
        archived.eventId,
        archived.eventSequence,
        timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'I kept the small brass key.', 'NFC', ?, 'confirmed',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(versionId, owner.principalId, itemId, nextHash(), timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'archived', ?, 'I kept the small brass key.', ?,
      'telegram', ?, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        itemId,
        versionId,
        archived.eventId,
        archived.eventSequence,
        archived.segmentId,
        nextHash(),
        timestamp,
        timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'proposed', 'archive proposal', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, itemId, versionId, timestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'active', 'automatic archive promotion', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, itemId, versionId, laterTimestamp).run())
      .rejects.toThrow(/memory_item_transition_invalid/u);
    await insertOwnerTransition({
      principalId: owner.principalId,
      itemId,
      versionId,
      transitionNumber: 2,
      lifecycleState: "active",
    });
    expect(await env.DB.prepare(`SELECT count(*) AS count
      FROM memory_retrievable_item_versions WHERE principal_id = ? AND version_id = ?`)
      .bind(owner.principalId, versionId).first()).toEqual({ count: 1 });
  });

  it("requires a matching coverage receipt and rejects false live high-water marks", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    await expect(env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'unreceipted history', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, source.sequence, source.sequence,
        nextHash(), nextHash(), timestamp, timestamp,
      ).run()).rejects.toThrow(/memory_history_chunk_receipt_invalid/u);
    await expect(env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(
        nextUlid(), owner.principalId, source.sequence, source.sequence + 100,
        nextHash(), timestamp,
      ).run()).rejects.toThrow(/memory_history_coverage_receipt_invalid/u);
  });

  it("rejects live coverage for a range that has an archived event receipt", async () => {
    const archived = await seedArchivedReceipt();
    const liveEvent = await env.DB.prepare("SELECT subject_id FROM events WHERE sequence = ?")
      .bind(archived.eventSequence).first<{ subject_id: string }>();
    if (liveEvent === null) throw new Error("memory_matching_live_event_missing");
    await expect(env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(
        nextUlid(),
        liveEvent.subject_id,
        archived.eventSequence,
        archived.eventSequence,
        nextHash(),
        timestamp,
      ).run())
      .rejects.toThrow(/memory_history_coverage_receipt_invalid/u);
  });

  it("rejects replay of an older topic move before it can create a cycle", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    const parentZeroId = nextUlid();
    const parentOneId = nextUlid();
    const topicId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: parentZeroId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "P0", newNormalizedName: "p0",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: parentOneId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "P1", newNormalizedName: "p1",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId, operation: "create",
      newParentTopicId: parentZeroId, newDisplayName: "Topic", newNormalizedName: "topic",
    });
    const firstMoveId = await insertTopicEvent({
      principalId: owner.principalId, topicId, operation: "move",
      previousParentTopicId: parentZeroId, newParentTopicId: parentOneId,
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId, operation: "move",
      previousParentTopicId: parentOneId, newParentTopicId: parentZeroId,
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: parentOneId, operation: "move",
      previousParentTopicId: rootId, newParentTopicId: topicId,
    });
    await expect(env.DB.prepare(`UPDATE memory_topics
      SET parent_topic_id = ?, last_topic_event_id = ?, updated_at = ?
      WHERE principal_id = ? AND topic_id = ?`)
      .bind(parentOneId, firstMoveId, timestamp, owner.principalId, topicId).run())
      .rejects.toThrow(/memory_topic_update_requires_event/u);
  });

  it("caps active topic depth at 64 so cycle checks fail closed", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    const topicIds = [rootId];
    await insertTopicEvent({
      principalId: owner.principalId,
      topicId: rootId,
      operation: "create",
      newDisplayName: "Depth 1",
      newNormalizedName: "depth 1",
    });
    let parentId = rootId;
    for (let depth = 2; depth <= 64; depth += 1) {
      const topicId = nextUlid();
      await insertTopicEvent({
        principalId: owner.principalId,
        topicId,
        operation: "create",
        newParentTopicId: parentId,
        newDisplayName: `Depth ${depth}`,
        newNormalizedName: `depth ${depth}`,
      });
      topicIds.push(topicId);
      parentId = topicId;
    }
    await expect(insertTopicEvent({
      principalId: owner.principalId,
      topicId: nextUlid(),
      operation: "create",
      newParentTopicId: parentId,
      newDisplayName: "Depth 65",
      newNormalizedName: "depth 65",
    })).rejects.toThrow(/memory_topic_event_invalid/u);

    const depthTwo = topicIds[1];
    const depthThree = topicIds[2];
    if (depthTwo === undefined || depthThree === undefined) {
      throw new Error("memory_topic_depth_fixture_missing");
    }
    await expect(insertTopicEvent({
      principalId: owner.principalId,
      topicId: depthTwo,
      operation: "move",
      previousParentTopicId: rootId,
      newParentTopicId: parentId,
    })).rejects.toThrow(/memory_topic_event_invalid/u);
    await expect(insertTopicEvent({
      principalId: owner.principalId,
      topicId: depthTwo,
      operation: "merge",
      previousDisplayName: "Depth 2",
      previousNormalizedName: "depth 2",
      mergeTargetTopicId: parentId,
      reparentedChildIds: [depthThree],
      addedAliases: [{
        aliasId: nextUlid(),
        topicId: parentId,
        displayName: "Depth 2",
        normalizedName: "depth 2",
        pathAlias: "Depth 1/Depth 2",
      }],
    })).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("allows boundary-depth moves and merges but rejects only their non-cycle depth overflow", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Depth 1", newNormalizedName: "depth 1",
    });
    let deepTargetId = rootId;
    for (let depth = 2; depth <= 62; depth += 1) {
      const topicId = nextUlid();
      await insertTopicEvent({
        principalId: owner.principalId, topicId, operation: "create",
        newParentTopicId: deepTargetId,
        newDisplayName: `Deep target ${depth}`,
        newNormalizedName: `deep target ${depth}`,
      });
      deepTargetId = topicId;
    }
    const createShallowChain = async (prefix: string, edgeCount: number) => {
      const ids: string[] = [];
      let parentId = rootId;
      for (let edge = 0; edge <= edgeCount; edge += 1) {
        const topicId = nextUlid();
        await insertTopicEvent({
          principalId: owner.principalId, topicId, operation: "create",
          newParentTopicId: parentId,
          newDisplayName: `${prefix} ${edge}`,
          newNormalizedName: `${prefix.toLowerCase()} ${edge}`,
        });
        ids.push(topicId);
        parentId = topicId;
      }
      return ids;
    };

    const validMove = await createShallowChain("Valid move", 1);
    await insertTopicEvent({
      principalId: owner.principalId, topicId: validMove[0]!, operation: "move",
      previousParentTopicId: rootId, newParentTopicId: deepTargetId,
    });
    expect(await env.DB.prepare("SELECT parent_topic_id FROM memory_topics WHERE topic_id = ?")
      .bind(validMove[0]).first()).toEqual({ parent_topic_id: deepTargetId });

    const overflowingMove = await createShallowChain("Overflowing move", 2);
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: overflowingMove[0]!, operation: "move",
      previousParentTopicId: rootId, newParentTopicId: deepTargetId,
    })).rejects.toThrow(/memory_topic_event_invalid/u);

    const mergeTargetId = deepTargetId;
    const validMerge = await createShallowChain("Valid merge", 2);
    await insertTopicEvent({
      principalId: owner.principalId, topicId: validMerge[0]!, operation: "merge",
      previousDisplayName: "Valid merge 0", previousNormalizedName: "valid merge 0",
      mergeTargetTopicId: mergeTargetId,
      reparentedChildIds: [validMerge[1]!],
      addedAliases: [{
        aliasId: nextUlid(), topicId: mergeTargetId, displayName: "Valid merge 0",
        normalizedName: "valid merge 0", pathAlias: "Depth 1/Valid merge 0",
      }],
    });
    expect(await env.DB.prepare("SELECT parent_topic_id FROM memory_topics WHERE topic_id = ?")
      .bind(validMerge[1]).first()).toEqual({ parent_topic_id: mergeTargetId });

    const overflowingMerge = await createShallowChain("Overflowing merge", 3);
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: overflowingMerge[0]!, operation: "merge",
      previousDisplayName: "Overflowing merge 0",
      previousNormalizedName: "overflowing merge 0",
      mergeTargetTopicId: mergeTargetId,
      reparentedChildIds: [overflowingMerge[1]!],
      addedAliases: [{
        aliasId: nextUlid(), topicId: mergeTargetId, displayName: "Overflowing merge 0",
        normalizedName: "overflowing merge 0", pathAlias: "Depth 1/Overflowing merge 0",
      }],
    })).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("rejects an unfinished depth-64 ancestor walk independently of cycle and depth-sum checks", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    let deepTargetId = rootId;
    let sourceId = "";
    await env.DB.exec("DROP TRIGGER memory_topic_events_insert_guard");
    try {
      await insertTopicEvent({
        principalId: owner.principalId, topicId: rootId, operation: "create",
        newDisplayName: "Corrupt depth 1", newNormalizedName: "corrupt depth 1",
      });
      for (let depth = 2; depth <= 65; depth += 1) {
        const topicId = nextUlid();
        await insertTopicEvent({
          principalId: owner.principalId, topicId, operation: "create",
          newParentTopicId: deepTargetId,
          newDisplayName: `Corrupt depth ${depth}`,
          newNormalizedName: `corrupt depth ${depth}`,
        });
        deepTargetId = topicId;
      }
      sourceId = nextUlid();
      await insertTopicEvent({
        principalId: owner.principalId, topicId: sourceId, operation: "create",
        newParentTopicId: rootId,
        newDisplayName: "Childless merge source",
        newNormalizedName: "childless merge source",
      });
    } finally {
      await env.DB.prepare(migrationTriggerSql("memory_topic_events_insert_guard")).run();
    }

    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: sourceId, operation: "merge",
      previousDisplayName: "Childless merge source",
      previousNormalizedName: "childless merge source",
      mergeTargetTopicId: deepTargetId,
      addedAliases: [{
        aliasId: nextUlid(), topicId: deepTargetId,
        displayName: "Childless merge source",
        normalizedName: "childless merge source",
        pathAlias: "Corrupt depth 1/Childless merge source",
      }],
    })).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("rejects far-future topic events before they can wedge topic history", async () => {
    const owner = await seedPrincipal();
    const topicId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId,
      topicId,
      operation: "create",
      newDisplayName: "Current topic",
      newNormalizedName: "current topic",
    });
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const aliasId = nextUlid();
    await expect(env.DB.prepare(`INSERT INTO memory_topic_events (
      topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
      new_parent_topic_id, previous_display_name, previous_normalized_name,
      new_display_name, new_normalized_name, merge_target_topic_id,
      reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
      reason, actor, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 'rename', NULL, NULL, 'Current topic', 'current topic',
      'Future topic', 'future topic', NULL, '[]', '[]', ?, 'future clock',
      'rules', NULL, ?)`)
      .bind(
        nextUlid(),
        owner.principalId,
        topicId,
        JSON.stringify([{
          aliasId,
          topicId,
          displayName: "Current topic",
          normalizedName: "current topic",
          pathAlias: "Current topic",
        }]),
        future,
      ).run()).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("requires monotonic placement events and an active filing target", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, source);
    const rootId = nextUlid();
    const topicIds = [nextUlid(), nextUlid(), nextUlid()] as const;
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    for (const [index, topicId] of topicIds.entries()) {
      await insertTopicEvent({
        principalId: owner.principalId, topicId, operation: "create",
        newParentTopicId: rootId,
        newDisplayName: `Topic ${index}`,
        newNormalizedName: `topic ${index}`,
      });
    }
    const placementId = nextUlid();
    const insertPlacement = async (
      eventId: string,
      eventNumber: number,
      operation: "place" | "refile",
      previousTopicId: string | null,
      newTopicId: string,
    ) => env.DB.prepare(`INSERT INTO memory_item_placement_events (
      placement_event_id, principal_id, placement_id, placement_event_number,
      item_id, operation, previous_topic_id, new_topic_id, relation,
      filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'primary', 'rule', 1.0,
      'placement progression', NULL, ?)`)
      .bind(
        eventId, owner.principalId, placementId, eventNumber, item.itemId,
        operation, previousTopicId, newTopicId, timestamp,
      ).run();
    await insertPlacement(nextUlid(), 1, "place", null, topicIds[0]);
    const oldRefileId = nextUlid();
    await insertPlacement(oldRefileId, 2, "refile", topicIds[0], topicIds[1]);
    await insertPlacement(nextUlid(), 3, "refile", topicIds[1], topicIds[2]);
    await expect(env.DB.prepare(`UPDATE memory_item_placement_state
      SET topic_id = ?, last_event_kind = 'placement', last_event_id = ?,
        last_placement_event_number = 2, updated_at = ?
      WHERE principal_id = ? AND placement_id = ?`)
      .bind(topicIds[1], oldRefileId, timestamp, owner.principalId, placementId).run())
      .rejects.toThrow(/memory_item_placement_state_requires_event/u);

    const mergedSourceId = nextUlid();
    const mergeTargetId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: mergedSourceId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Merged", newNormalizedName: "merged",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: mergeTargetId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Target", newNormalizedName: "target",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: mergedSourceId, operation: "merge",
      previousDisplayName: "Merged", previousNormalizedName: "merged",
      mergeTargetTopicId: mergeTargetId,
      addedAliases: [{
        aliasId: nextUlid(), topicId: mergeTargetId, displayName: "Merged",
        normalizedName: "merged", pathAlias: "Root/Merged",
      }],
    });
    await expect(insertPlacement(nextUlid(), 4, "refile", topicIds[2], mergedSourceId))
      .rejects.toThrow(/memory_item_placement_event_invalid/u);
  });

  it("preserves aliases on moves and merges and rejects unrelated alias targets", async () => {
    const owner = await seedPrincipal();
    const rootId = nextUlid();
    const sourceId = nextUlid();
    const targetId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: sourceId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Source", newNormalizedName: "source",
    });
    await insertTopicEvent({
      principalId: owner.principalId, topicId: targetId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Target", newNormalizedName: "target",
    });
    const moveAliasId = nextUlid();
    await insertTopicEvent({
      principalId: owner.principalId, topicId: sourceId, operation: "move",
      previousParentTopicId: rootId, newParentTopicId: targetId,
      addedAliases: [{
        aliasId: moveAliasId, topicId: sourceId, displayName: "Source",
        normalizedName: "source", pathAlias: "Root/Source",
      }],
    });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_topic_aliases WHERE alias_id = ?")
      .bind(moveAliasId).first()).toEqual({ count: 1 });
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: sourceId, operation: "move",
      previousParentTopicId: targetId, newParentTopicId: rootId,
      addedAliases: [{
        aliasId: nextUlid(), topicId: targetId, displayName: "Wrong",
        normalizedName: "wrong", pathAlias: "Root/Target/Wrong",
      }],
    })).rejects.toThrow(/memory_topic_event_invalid/u);
    await expect(insertTopicEvent({
      principalId: owner.principalId, topicId: sourceId, operation: "merge",
      previousDisplayName: "Source", previousNormalizedName: "source",
      mergeTargetTopicId: targetId,
    })).rejects.toThrow(/memory_topic_event_invalid/u);
  });

  it("requires valid item creation and first-person sources and suppresses the creation event", async () => {
    const owner = await seedPrincipal();
    const creation = await seedEvent(owner.principalId);
    await expect(env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(nextUlid(), owner.principalId, creation.eventId, creation.sequence + 1, timestamp).run())
      .rejects.toThrow(/memory_item_creation_event_invalid/u);

    const noSourceItemId = nextUlid();
    const noSourceVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(noSourceItemId, owner.principalId, creation.eventId, creation.sequence, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'I have no source row.', 'NFC', ?, 'stated',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(noSourceVersionId, owner.principalId, noSourceItemId, nextHash(), timestamp).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'active', 'source-free activation', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, noSourceItemId, noSourceVersionId, timestamp).run())
      .rejects.toThrow(/memory_item_transition_invalid/u);

    const assistant = await seedEvent(owner.principalId, "system.memory_extract");
    const assistantItemId = nextUlid();
    const assistantVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`)
      .bind(assistantItemId, owner.principalId, creation.eventId, creation.sequence, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'I allegedly prefer blue.', 'NFC', ?, 'stated',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(assistantVersionId, owner.principalId, assistantItemId, nextHash(), timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'assistant assertion', ?,
      'telegram', ?, ?)`)
      .bind(
        nextUlid(), owner.principalId, assistantItemId, assistantVersionId,
        assistant.eventId, assistant.sequence, nextHash(), timestamp, timestamp,
      ).run();
    await expect(env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'active', 'assistant-only activation', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(nextUlid(), owner.principalId, assistantItemId, assistantVersionId, timestamp).run())
      .rejects.toThrow(/memory_item_transition_invalid/u);

    const supporting = await seedEvent(owner.principalId);
    const separatelyCreatedItemId = nextUlid();
    const separatelyCreatedVersionId = nextUlid();
    const separatelyCreatedSourceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'preference', ?, ?, ?)`)
      .bind(
        separatelyCreatedItemId, owner.principalId, creation.eventId,
        creation.sequence, timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'I prefer green.', 'NFC', ?, 'stated',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(
        separatelyCreatedVersionId, owner.principalId, separatelyCreatedItemId,
        nextHash(), timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'I prefer green.', ?,
      'telegram', ?, ?)`)
      .bind(
        separatelyCreatedSourceId, owner.principalId, separatelyCreatedItemId,
        separatelyCreatedVersionId, supporting.eventId, supporting.sequence,
        nextHash(), timestamp, timestamp,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'active', 'deterministic promotion', 'rules',
      'policy-v1', NULL, ?)`)
      .bind(
        nextUlid(), owner.principalId, separatelyCreatedItemId,
        separatelyCreatedVersionId, timestamp,
      ).run();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_retrievable_item_versions
      WHERE version_id = ?`).bind(separatelyCreatedVersionId).first()).toEqual({ count: 1 });
    const suppressionId = nextUlid();
    const command = await seedOwnerCommand(
      owner.principalId, "history.suppress", suppressionId,
      {
        targetEventId: creation.eventId,
        startEventSequence: null,
        endEventSequence: null,
        newlyHiddenTurnCount: 1,
        totalCoveredTurnCount: 1,
      },
    );
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'hide creation', 1, 1, ?)`)
      .bind(
        suppressionId, owner.principalId, creation.eventId,
        command.eventId, timestamp,
      ).run();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_retrievable_item_versions
      WHERE version_id = ?`).bind(separatelyCreatedVersionId).first()).toEqual({ count: 0 });
  });

  const immutableTables = [
    ["memory_items", "item_id", "memory_item_immutable"],
    ["memory_item_versions", "version_id", "memory_item_version_immutable"],
    ["memory_item_sources", "source_id", "memory_item_source_immutable"],
    ["memory_item_transitions", "transition_id", "memory_item_transition_immutable"],
    ["memory_event_suppressions", "suppression_id", "memory_event_suppression_immutable"],
    ["memory_event_suppression_lifts", "lift_id", "memory_event_suppression_lift_immutable"],
    ["memory_item_links", "link_id", "memory_item_link_immutable"],
    ["memory_topic_events", "topic_event_id", "memory_topic_event_immutable"],
    ["memory_topic_aliases", "alias_id", "memory_topic_alias_immutable"],
    ["memory_item_placement_events", "placement_event_id", "memory_item_placement_event_immutable"],
    ["memory_episodes", "episode_id", "memory_episode_immutable"],
    ["memory_episode_sources", "source_id", "memory_episode_source_immutable"],
    ["memory_history_coverage", "coverage_id", "memory_history_coverage_immutable"],
    ["memory_model_prices", "price_id", "memory_model_price_immutable"],
    ["memory_cost_ledger", "cost_entry_id", "memory_cost_entry_immutable"],
  ] as const;

  for (const [table, keyColumn, error] of immutableTables) {
    const triggerPrefix = table === "memory_items" ? "memory_items"
      : table;
    it(`${triggerPrefix}_immutable_update rejects a stored-row update`, async () => {
      const fixture = await triggerFixture();
      await expect(env.DB.prepare(`UPDATE ${table} SET ${keyColumn} = ${keyColumn}
        WHERE ${keyColumn} = ?`).bind(fixture.keys[table]).run())
        .rejects.toThrow(new RegExp(error, "u"));
    });

    it(`${triggerPrefix}_immutable_delete rejects a stored-row delete`, async () => {
      const fixture = await triggerFixture();
      await expect(env.DB.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`)
        .bind(fixture.keys[table]).run())
        .rejects.toThrow(new RegExp(error, "u"));
    });
  }

  const insertGuards = [
    ["memory_items_insert_guard", "memory_items", "item_id", "memory_item_creation_event_invalid"],
    ["memory_item_versions_insert_guard", "memory_item_versions", "version_id", "memory_item_version_lineage_invalid"],
    ["memory_item_sources_insert_guard", "memory_item_sources", "source_id", "memory_item_source_receipt_invalid"],
    ["memory_item_transitions_insert_guard", "memory_item_transitions", "transition_id", "memory_item_transition_invalid"],
    ["memory_item_state_insert_guard", "memory_item_state", "item_id", "memory_item_state_requires_transition"],
    ["memory_event_suppressions_insert_guard", "memory_event_suppressions", "suppression_id", "memory_event_suppression_invalid"],
    ["memory_event_suppression_lifts_insert_guard", "memory_event_suppression_lifts", "lift_id", "memory_event_suppression_lift_invalid"],
    ["memory_item_links_insert_guard", "memory_item_links", "link_id", "memory_item_link_transition_invalid"],
    ["memory_topic_events_insert_guard", "memory_topic_events", "topic_event_id", "memory_topic_event_invalid"],
    ["memory_topics_insert_guard", "memory_topics", "topic_id", "memory_topic_requires_event"],
    ["memory_topic_aliases_insert_guard", "memory_topic_aliases", "alias_id", "memory_topic_alias_requires_event"],
    ["memory_item_placement_events_insert_guard", "memory_item_placement_events", "placement_event_id", "memory_item_placement_event_invalid"],
    ["memory_item_placement_state_insert_guard", "memory_item_placement_state", "placement_id", "memory_item_placement_state_requires_event"],
    ["memory_episodes_insert_guard", "memory_episodes", "episode_id", "memory_episode_duplicate"],
    ["memory_episode_sources_insert_guard", "memory_episode_sources", "source_id", "memory_episode_source_receipt_invalid"],
    ["memory_history_chunks_insert_guard", "memory_history_chunks", "chunk_id", "memory_history_chunk_receipt_invalid"],
    ["memory_history_coverage_insert_guard", "memory_history_coverage", "coverage_id", "memory_history_coverage_receipt_invalid"],
    ["memory_vectors_insert_guard", "memory_vectors", "vector_ledger_id", "memory_vector_duplicate"],
    ["memory_model_prices_insert_guard", "memory_model_prices", "price_id", "memory_model_price_duplicate"],
    ["memory_runs_insert_guard", "memory_runs", "run_id", "memory_run_initial_state_invalid"],
    ["memory_reprocess_jobs_insert_guard", "memory_reprocess_jobs", "job_id", "memory_reprocess_job_authorization_invalid"],
    ["memory_cost_ledger_insert_guard", "memory_cost_ledger", "cost_entry_id", "memory_cost_entry_lineage_invalid"],
    ["memory_cursors_insert_guard", "memory_cursors", "principal_id", "memory_cursor_duplicate"],
  ] as const;

  for (const [trigger, table, keyColumn, error] of insertGuards) {
    it(`${trigger} rejects INSERT OR REPLACE of an existing key`, async () => {
      const fixture = await triggerFixture();
      const extra = table === "memory_cursors" ? " AND cursor_name = 'fts_items'" : "";
      await expect(env.DB.prepare(`INSERT OR REPLACE INTO ${table}
        SELECT * FROM ${table} WHERE ${keyColumn} = ?${extra}`)
        .bind(fixture.keys[table]).run())
        .rejects.toThrow(new RegExp(error, "u"));
    });
  }

  it("sweeps every 0016 table across explicit-rowid, natural-key, and key-update REPLACE paths", async () => {
    const fixture = await triggerFixture();
    const rowidAliases: Readonly<Record<string, string>> = {
      memory_item_versions: "version_rowid",
      memory_episodes: "episode_rowid",
      memory_history_chunks: "chunk_rowid",
    };
    const tableList = await env.DB.prepare("PRAGMA table_list").all<{
      name: string;
      wr: number;
    }>();
    const withoutRowid = new Map(tableList.results.map((row) => [row.name, row.wr]));

    for (const [, table, selectorColumn] of insertGuards) {
      const quotedTable = `"${table}"`;
      const selector = table === "memory_cursors"
        ? `${selectorColumn} = ? AND cursor_name = 'fts_items'`
        : `${selectorColumn} = ?`;
      const columnsResult = await env.DB.prepare(`PRAGMA table_info(${quotedTable})`).all<{
        name: string;
        type: string;
        pk: number;
      }>();
      const columns = columnsResult.results;
      const columnList = columns.map((column) => `"${column.name}"`).join(", ");

      await expect(env.DB.prepare(`INSERT OR REPLACE INTO ${quotedTable} (${columnList})
        SELECT ${columnList} FROM ${quotedTable} WHERE ${selector}`)
        .bind(fixture.keys[table]).run()).rejects.toThrow();

      const rowidAlias = rowidAliases[table];
      if (rowidAlias === undefined) {
        expect(withoutRowid.get(table), `${table} must not expose a hidden rowid`).toBe(1);
        await expect(env.DB.prepare(`INSERT OR REPLACE INTO ${quotedTable} (rowid) VALUES (1)`)
          .run()).rejects.toThrow(/rowid/u);
      } else {
        expect(withoutRowid.get(table), `${table} must retain its FTS rowid alias`).toBe(0);
        const nonAliasColumns = columns.filter((column) => column.name !== rowidAlias);
        const explicitColumns = ["rowid", ...nonAliasColumns.map((column) => `"${column.name}"`)]
          .join(", ");
        const explicitValues = ["rowid", ...nonAliasColumns.map((column) => `"${column.name}"`)]
          .join(", ");
        await expect(env.DB.prepare(`INSERT OR REPLACE INTO ${quotedTable} (${explicitColumns})
          SELECT ${explicitValues} FROM ${quotedTable} WHERE ${selector}`)
          .bind(fixture.keys[table]).run()).rejects.toThrow();
      }

      const indexList = await env.DB.prepare(`PRAGMA index_list(${quotedTable})`).all<{
        name: string;
        unique: number;
      }>();
      const keyColumns = new Set(columns.filter((column) => column.pk > 0)
        .map((column) => column.name));
      for (const index of indexList.results.filter((index) => index.unique === 1)) {
        const quotedIndex = `"${index.name.replaceAll('"', '""')}"`;
        const indexInfo = await env.DB.prepare(`PRAGMA index_info(${quotedIndex})`)
          .all<{ name: string | null }>();
        for (const column of indexInfo.results) {
          if (column.name !== null) keyColumns.add(column.name);
        }
      }
      expect(keyColumns.size, `${table} must expose at least one declared key`).toBeGreaterThan(0);
      for (const keyColumn of keyColumns) {
        const column = columns.find((candidate) => candidate.name === keyColumn);
        if (column === undefined) throw new Error(`memory_replace_sweep_column_missing:${table}.${keyColumn}`);
        const replacement = column.type === "INTEGER"
          ? `COALESCE("${keyColumn}", 0) + 1000000000`
          : `COALESCE("${keyColumn}", '') || ':replace-probe'`;
        await expect(env.DB.prepare(`UPDATE OR REPLACE ${quotedTable}
          SET "${keyColumn}" = ${replacement} WHERE ${selector}`)
          .bind(fixture.keys[table]).run()).rejects.toThrow();
      }

      const rowidUpdate = rowidAlias === undefined
        ? `UPDATE OR REPLACE ${quotedTable} SET rowid = rowid WHERE ${selector}`
        : `UPDATE OR REPLACE ${quotedTable} SET rowid = rowid + 1000000000 WHERE ${selector}`;
      await expect(env.DB.prepare(rowidUpdate).bind(fixture.keys[table]).run()).rejects.toThrow();
    }
  });

  const guardedUpdates = [
    ["memory_item_state_update_guard", "memory_item_state", "item_id", "memory_item_state_requires_transition"],
    ["memory_topics_update_guard", "memory_topics", "topic_id", "memory_topic_update_requires_event"],
    ["memory_item_placement_state_update_guard", "memory_item_placement_state", "placement_id", "memory_item_placement_state_requires_event"],
    ["memory_history_chunks_immutable_update", "memory_history_chunks", "chunk_id", "memory_history_chunk_immutable"],
    ["memory_vectors_update_guard", "memory_vectors", "vector_ledger_id", "memory_vector_delete_transition_invalid"],
    ["memory_runs_update_guard", "memory_runs", "run_id", "memory_run_transition_invalid"],
    ["memory_reprocess_jobs_update_guard", "memory_reprocess_jobs", "job_id", "memory_reprocess_job_transition_invalid"],
  ] as const;

  for (const [trigger, table, keyColumn, error] of guardedUpdates) {
    it(`${trigger} rejects an update without the required transition`, async () => {
      const fixture = await triggerFixture();
      await expect(env.DB.prepare(`UPDATE ${table} SET ${keyColumn} = ${keyColumn}
        WHERE ${keyColumn} = ?`).bind(fixture.keys[table]).run())
        .rejects.toThrow(new RegExp(error, "u"));
    });
  }

  it("memory_cursors_monotonic_update rejects a cursor rewind", async () => {
    const fixture = await triggerFixture();
    await expect(env.DB.prepare(`UPDATE memory_cursors SET current_event_sequence = 0
      WHERE principal_id = ? AND cursor_name = 'fts_items'`)
      .bind(fixture.ownerId).run()).rejects.toThrow(/memory_cursor_transition_invalid/u);
  });

  const deleteGuards = [
    ["memory_item_state_delete_guard", "memory_item_state", "item_id", "memory_item_state_delete_forbidden"],
    ["memory_topics_delete_guard", "memory_topics", "topic_id", "memory_topic_delete_forbidden"],
    ["memory_item_placement_state_delete_guard", "memory_item_placement_state", "placement_id", "memory_item_placement_state_delete_forbidden"],
    ["memory_vectors_delete_guard", "memory_vectors", "vector_ledger_id", "memory_vector_delete_forbidden"],
    ["memory_runs_delete_guard", "memory_runs", "run_id", "memory_run_delete_forbidden"],
    ["memory_reprocess_jobs_delete_guard", "memory_reprocess_jobs", "job_id", "memory_reprocess_job_delete_forbidden"],
    ["memory_cursors_delete_guard", "memory_cursors", "principal_id", "memory_cursor_delete_forbidden"],
  ] as const;

  for (const [trigger, table, keyColumn, error] of deleteGuards) {
    it(`${trigger} rejects direct projection deletion`, async () => {
      const fixture = await triggerFixture();
      const extra = table === "memory_cursors" ? " AND cursor_name = 'fts_items'" : "";
      await expect(env.DB.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?${extra}`)
        .bind(fixture.keys[table]).run())
        .rejects.toThrow(new RegExp(error, "u"));
    });
  }

  it("memory_item_transitions_apply_state projects the appended transition", async () => {
    const fixture = await triggerFixture();
    expect(await env.DB.prepare(`SELECT last_transition_id FROM memory_item_state
      WHERE principal_id = ? AND item_id = ?`).bind(
      fixture.ownerId, fixture.keys.memory_items,
    ).first()).toEqual({ last_transition_id: fixture.keys.memory_item_transitions });
  });

  it("memory_topic_events_apply projects topic changes and aliases", async () => {
    const fixture = await triggerFixture();
    expect(await env.DB.prepare(`SELECT last_topic_event_id FROM memory_topics
      WHERE topic_id = ?`).bind(fixture.keys.memory_topics).first())
      .toEqual({ last_topic_event_id: fixture.keys.memory_topic_events });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_topic_aliases WHERE alias_id = ?")
      .bind(fixture.keys.memory_topic_aliases).first()).toEqual({ count: 1 });
  });

  it("memory_item_placement_events_apply_state projects the appended placement", async () => {
    const fixture = await triggerFixture();
    expect(await env.DB.prepare(`SELECT last_event_id FROM memory_item_placement_state
      WHERE placement_id = ?`).bind(fixture.keys.memory_item_placement_state).first())
      .toEqual({ last_event_id: fixture.keys.memory_item_placement_events });
  });

  it("memory_item_versions_fts_insert indexes each new item version", async () => {
    const fixture = await triggerFixture();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_fts
      WHERE rowid = (SELECT version_rowid FROM memory_item_versions WHERE version_id = ?)`)
      .bind(fixture.keys.memory_item_versions).first()).toEqual({ count: 1 });
  });

  it("memory_episodes_fts_insert indexes each new episode", async () => {
    const fixture = await triggerFixture();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_episode_fts
      WHERE rowid = (SELECT episode_rowid FROM memory_episodes WHERE episode_id = ?)`)
      .bind(fixture.keys.memory_episodes).first()).toEqual({ count: 1 });
  });

  it("memory_history_chunks_fts_insert indexes each new history chunk", async () => {
    const fixture = await triggerFixture();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_history_fts
      WHERE rowid = (SELECT chunk_rowid FROM memory_history_chunks WHERE chunk_id = ?)`)
      .bind(fixture.keys.memory_history_chunks).first()).toEqual({ count: 1 });
  });

  it("memory_history_chunks_fts_delete removes a deleted history chunk", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const receiptHash = nextHash();
    await env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(
        nextUlid(), owner.principalId, source.sequence, source.sequence,
        receiptHash, timestamp,
      ).run();
    const chunkId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'delete-projection-sentinel', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunkId, owner.principalId, source.sequence, source.sequence,
        nextHash(), receiptHash, timestamp, timestamp,
      ).run();
    const row = await env.DB.prepare("SELECT chunk_rowid FROM memory_history_chunks WHERE chunk_id = ?")
      .bind(chunkId).first<{ chunk_rowid: number }>();
    if (row === null) throw new Error("memory_history_chunk_fixture_missing");
    await env.DB.prepare("DELETE FROM memory_history_chunks WHERE chunk_id = ?").bind(chunkId).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_history_fts WHERE rowid = ?")
      .bind(row.chunk_rowid).first()).toEqual({ count: 0 });
  });
});

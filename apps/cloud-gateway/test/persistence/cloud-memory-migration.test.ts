import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCloudMemoryMigration } from "./migration.js";

const timestamp = "2026-09-14T20:00:00.000Z";
const laterTimestamp = "2026-09-14T20:01:00.000Z";
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
): Promise<TestEvent> {
  const eventId = nextUlid();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, 'jarvis.conversation', ?, ?, ?, ?, '{}', ?)`)
    .bind(eventId, eventType, principalId, timestamp, timestamp, nextHash(), timestamp).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_test_event_missing");
  return { eventId, sequence: row.sequence };
}

async function seedActiveItem(principalId: string, source: TestEvent): Promise<TestItem> {
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
  ) VALUES (?, ?, ?, 1, ?, 'active', 'deterministic promotion', 'rules',
    'policy-v1', NULL, ?)`)
    .bind(transitionId, principalId, itemId, versionId, timestamp).run();
  return { itemId, versionId, sourceId, transitionId };
}

interface TopicEventInput {
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
}

async function insertTopicEvent(input: TopicEventInput): Promise<string> {
  const topicEventId = nextUlid();
  await env.DB.prepare(`INSERT INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
    new_parent_topic_id, previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'topic test', 'rules', NULL, ?)`)
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
      timestamp,
    ).run();
  return topicEventId;
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
    const forgetAuthorization = await seedEvent(owner.principalId);
    const liftAuthorization = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, target);
    const episodeId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_episodes (
      episode_id, principal_id, local_day, start_event_sequence, end_event_sequence,
      text, content_hash, summarizer_version, summarizer_model_id,
      supersedes_episode_id, created_at
    ) VALUES (?, ?, '2026-09-14', ?, ?, 'A short-report preference was stated.', ?,
      'summary-v1', 'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(episodeId, owner.principalId, target.sequence, target.sequence, nextHash(), timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_episode_sources (
      source_id, principal_id, episode_id, source_position, event_id, event_sequence,
      source_location, r2_segment_id, channel, occurred_at
    ) VALUES (?, ?, ?, 0, ?, ?, 'live', NULL, 'telegram', ?)`)
      .bind(nextUlid(), owner.principalId, episodeId, target.eventId, target.sequence, timestamp).run();
    const chunkId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'I prefer short reports.', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunkId, owner.principalId, target.sequence, target.sequence,
        nextHash(), nextHash(), timestamp, timestamp,
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

    await env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'owner corrected hide', ?)`)
      .bind(nextUlid(), owner.principalId, suppressionId, liftAuthorization.eventId, timestamp).run();
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
    const authorization = await seedEvent(owner.principalId);
    const liftAuthorization = await seedEvent(owner.principalId);
    const item = await seedActiveItem(owner.principalId, target);
    const forgottenTransitionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'forgotten', 'owner requested forget', 'owner',
      'policy-v1', ?, ?)`)
      .bind(
        forgottenTransitionId, owner.principalId, item.itemId,
        item.versionId, authorization.eventId, timestamp,
      ).run();
    const suppressionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'item forget', 1, 1, ?)`)
      .bind(
        suppressionId, owner.principalId, target.eventId, authorization.eventId,
        forgottenTransitionId, item.sourceId, timestamp,
      ).run();

    await expect(env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
      lift_id, principal_id, suppression_id, owner_authorizing_event_id,
      correction_transition_id, reason, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'missing item correction', ?)`)
      .bind(
        nextUlid(), owner.principalId, suppressionId,
        liftAuthorization.eventId, laterTimestamp,
      ).run()).rejects.toThrow(/memory_event_suppression_lift_invalid/u);

    const correctedVersionId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 2, 'I prefer short reports.', 'NFC', ?, 'confirmed',
      'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
      .bind(correctedVersionId, owner.principalId, item.itemId, nextHash(), laterTimestamp).run();
    const correctionTransitionId = nextUlid();
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
        nextUlid(), owner.principalId, suppressionId, liftAuthorization.eventId,
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

  it("keeps FTS projections current and enforces bounded run, cost, vector, cursor, and reprocessing state", async () => {
    const owner = await seedPrincipal();
    const source = await seedEvent(owner.principalId);
    const authorization = await seedEvent(owner.principalId);
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
      text, content_hash, summarizer_version, summarizer_model_id,
      supersedes_episode_id, created_at
    ) VALUES (?, ?, '2026-09-14', ?, ?, 'A violet notebook was mentioned.', ?,
      'summary-v1', 'deepseek:deepseek-v4-pro', NULL, ?)`)
      .bind(episodeId, owner.principalId, source.sequence, source.sequence, nextHash(), timestamp).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_episode_fts WHERE memory_episode_fts MATCH 'violet'")
      .first<{ count: number }>()).toEqual({ count: 1 });

    const chunkId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'orchid detail', ?, 'live', NULL, ?, ?, ?)`)
      .bind(
        chunkId, owner.principalId, source.sequence, source.sequence,
        nextHash(), nextHash(), timestamp, timestamp,
      ).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH 'orchid'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    await env.DB.prepare(`UPDATE memory_history_chunks
      SET text = 'sapphire detail', content_hash = ?, updated_at = ? WHERE chunk_id = ?`)
      .bind(nextHash(), laterTimestamp, chunkId).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH 'orchid'")
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH 'sapphire'")
      .first<{ count: number }>()).toEqual({ count: 1 });
    await env.DB.prepare("DELETE FROM memory_history_chunks WHERE chunk_id = ?").bind(chunkId).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_history_fts WHERE memory_history_fts MATCH 'sapphire'")
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
});

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMemoryIngressMigration } from "./migration.js";

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 900_000;

function nextUlid(): string {
  let value = serial;
  serial += 1;
  let suffix = "";
  for (let index = 0; index < 18; index += 1) {
    const digit = alphabet[value % alphabet.length];
    if (digit === undefined) throw new Error("memory_ingress_test_ulid_digit_missing");
    suffix = `${digit}${suffix}`;
    value = Math.floor(value / alphabet.length);
  }
  return `01k3w1t4${suffix}`;
}

function nextHash(): string {
  return serial.toString(16).padStart(64, "0");
}

async function seedOwner(): Promise<string> {
  const principalId = `principal:memory:${nextUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'memory ingress test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

type JsonRecord = Record<string, unknown>;

async function insertEvent(
  principalId: string,
  payload: JsonRecord,
  overrides: Readonly<{
    eventType?: string;
    source?: string;
    producerVersion?: string;
    occurredAt?: string;
    conflictAction?: "OR IGNORE" | "OR REPLACE";
  }> = {},
): Promise<void> {
  const eventId = nextUlid();
  const eventType = overrides.eventType ?? "memory.owner_command";
  const source = overrides.source ?? "memory-control";
  const producerVersion = overrides.producerVersion ?? "memory-control-v1";
  const occurredAt = overrides.occurredAt ?? new Date().toISOString();
  const contentHash = nextHash();
  const envelope = {
    eventId,
    correlationId: eventId,
    eventType,
    source,
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    contentHash,
    producerVersion,
    payload,
  };
  await env.DB.prepare(`INSERT ${overrides.conflictAction ?? ""} INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId,
      eventType,
      source,
      principalId,
      occurredAt,
      occurredAt,
      contentHash,
      JSON.stringify(envelope),
      occurredAt,
    ).run();
}

function alias(topicId: string): JsonRecord {
  return {
    aliasId: nextUlid(),
    topicId,
    displayName: "Former name",
    normalizedName: "former name",
    pathAlias: "Root/Former name",
  };
}

function validPayloads(): readonly JsonRecord[] {
  const itemId = nextUlid();
  const versionId = nextUlid();
  const topicId = nextUlid();
  const placementId = nextUlid();
  return [
    {
      operation: "item.transition", targetId: nextUlid(), itemId, versionId,
      lifecycleState: "active",
    },
    {
      operation: "item.forget", targetId: nextUlid(), itemId, versionId,
      lifecycleState: "forgotten",
      suppressions: [{
        suppressionId: nextUlid(), sourceId: nextUlid(), targetEventId: nextUlid(),
        startEventSequence: null, endEventSequence: null,
        newlyHiddenTurnCount: 1, totalCoveredTurnCount: 1,
      }],
    },
    {
      operation: "item.correct", targetId: nextUlid(), itemId, versionId,
      lifecycleState: "active",
      lifts: [{ liftId: nextUlid(), suppressionId: nextUlid() }],
    },
    {
      operation: "history.suppress", targetId: nextUlid(), targetEventId: null,
      startEventSequence: 10, endEventSequence: 20,
      newlyHiddenTurnCount: 11, totalCoveredTurnCount: 11,
    },
    { operation: "history.lift", targetId: nextUlid(), suppressionId: nextUlid() },
    {
      operation: "topic.create", targetId: nextUlid(), topicId,
      newParentTopicId: null, newDisplayName: "Root", newNormalizedName: "root",
      mergeTargetTopicId: null, addedAliases: [],
    },
    {
      operation: "topic.rename", targetId: nextUlid(), topicId,
      newParentTopicId: null, newDisplayName: "Renamed", newNormalizedName: "renamed",
      mergeTargetTopicId: null, addedAliases: [alias(topicId)],
    },
    {
      operation: "topic.move", targetId: nextUlid(), topicId,
      newParentTopicId: nextUlid(), newDisplayName: null, newNormalizedName: null,
      mergeTargetTopicId: null, addedAliases: [],
    },
    {
      operation: "topic.merge", targetId: nextUlid(), topicId,
      newParentTopicId: null, newDisplayName: null, newNormalizedName: null,
      mergeTargetTopicId: nextUlid(), addedAliases: [alias(topicId)],
    },
    {
      operation: "placement.place", targetId: nextUlid(), placementId, itemId,
      previousTopicId: null, newTopicId: nextUlid(), relation: "primary",
    },
    {
      operation: "placement.refile", targetId: nextUlid(), placementId, itemId,
      previousTopicId: nextUlid(), newTopicId: nextUlid(), relation: "related",
    },
    {
      operation: "placement.remove", targetId: nextUlid(), placementId, itemId,
      previousTopicId: nextUlid(), newTopicId: null, relation: "related",
    },
    {
      operation: "reprocess.create", targetId: nextUlid(),
      startEventSequence: 1, endEventSequence: 20, startDay: null, endDay: null,
      maximumEventCount: 20, providerModelId: "anthropic:claude-memory",
      spendLimitMicros: 5_000_000, dryRun: 0,
    },
  ];
}

describe.sequential("cloud memory ingress migration", () => {
  beforeAll(async () => {
    await applyMemoryIngressMigration();
  });

  it("events_memory_owner_command_ingress_guard reserves the owner-command type/source pair", async () => {
    const ownerId = await seedOwner();
    await expect(insertEvent(ownerId, {}, {
      source: "jarvis.conversation",
      conflictAction: "OR IGNORE",
    }))
      .rejects.toThrow(/memory_owner_command_ingress_invalid/u);
    await expect(insertEvent(ownerId, {}, {
      eventType: "conversation.user_committed",
      source: "memory-control",
    })).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
  });

  it("events_memory_owner_command_ingress_guard enforces the producer and operation allowlists", async () => {
    const ownerId = await seedOwner();
    for (const payload of validPayloads()) await expect(insertEvent(ownerId, payload)).resolves.toBeUndefined();
    await expect(insertEvent(ownerId, { operation: "topic.delete", targetId: nextUlid() }))
      .rejects.toThrow(/memory_owner_command_ingress_invalid/u);
    await expect(insertEvent(ownerId, validPayloads()[0] ?? {}, {
      producerVersion: "memory-control-v2",
    })).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
  });

  it("memory_topic_events_recent_insert_guard rejects a topic event older than D1 now minus five minutes", async () => {
    const ownerId = await seedOwner();
    const rootTopicId = nextUlid();
    const current = new Date().toISOString();
    await expect(env.DB.prepare(`INSERT OR IGNORE INTO memory_topic_events (
      topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
      new_parent_topic_id, previous_display_name, previous_normalized_name,
      new_display_name, new_normalized_name, merge_target_topic_id,
      reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
      reason, actor, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 'create', NULL, NULL, NULL, NULL, 'Current', 'current', NULL,
      '[]', '[]', '[]', 'current topic control', 'rules', NULL, ?)`)
      .bind(nextUlid(), ownerId, rootTopicId, current).run()).resolves.toBeDefined();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await expect(env.DB.prepare(`INSERT INTO memory_topic_events (
      topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
      new_parent_topic_id, previous_display_name, previous_normalized_name,
      new_display_name, new_normalized_name, merge_target_topic_id,
      reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
      reason, actor, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 'create', NULL, ?, NULL, NULL, 'Old', 'old', NULL,
      '[]', '[]', '[]', 'stale topic test', 'rules', NULL, ?)`)
      .bind(nextUlid(), ownerId, nextUlid(), rootTopicId, stale).run())
      .rejects.toThrow(/memory_topic_event_stale/u);
  });
});

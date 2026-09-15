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

type EventEnvelope = Readonly<{
  eventId: string;
  correlationId: string;
  eventType: string;
  source: string;
  subjectId: string;
  occurredAt: string;
  receivedAt: string;
  contentHash: string;
  producerVersion: string;
  payload: unknown;
}>;

type EventInsert = Readonly<{
  eventId: string;
  eventType: string;
  source: string;
  subjectId: string;
  occurredAt: string;
  receivedAt: string;
  contentHash: string;
  envelope: unknown;
  createdAt: string;
}>;

function canonicalOwnerCommand(
  principalId: string,
  payload: unknown = { operation: "item.transition", targetId: nextUlid() },
): EventInsert {
  const eventId = nextUlid();
  const eventType = "memory.owner_command";
  const source = "memory-control";
  const occurredAt = new Date().toISOString();
  const contentHash = nextHash();
  const envelope: EventEnvelope = {
    eventId,
    correlationId: eventId,
    eventType,
    source,
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    contentHash,
    producerVersion: "memory-control-v1",
    payload,
  };
  return {
    eventId,
    eventType,
    source,
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    contentHash,
    envelope,
    createdAt: occurredAt,
  };
}

function withMirroredField(
  event: EventInsert,
  field: "eventType" | "source",
  value: string,
): EventInsert {
  return {
    ...event,
    [field]: value,
    envelope: { ...(event.envelope as EventEnvelope), [field]: value },
  };
}

function withEnvelopeField(
  event: EventInsert,
  field: keyof EventEnvelope,
  value: unknown,
): EventInsert {
  return { ...event, envelope: { ...(event.envelope as EventEnvelope), [field]: value } };
}

function withTargetId(event: EventInsert, targetId: unknown): EventInsert {
  const envelope = event.envelope as EventEnvelope;
  return withEnvelopeField(event, "payload", {
    ...(envelope.payload as JsonRecord),
    targetId,
  });
}

async function insertEvent(
  event: EventInsert,
  conflictAction: "" | "OR IGNORE" | "OR REPLACE" = "",
): Promise<void> {
  await env.DB.prepare(`INSERT ${conflictAction} INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      event.eventId,
      event.eventType,
      event.source,
      event.subjectId,
      event.occurredAt,
      event.receivedAt,
      event.contentHash,
      JSON.stringify(event.envelope),
      event.createdAt,
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

  it("0019 trigger inventory contains both named trigger definitions", async () => {
    const expected = [
      "events_memory_owner_command_ingress_guard",
      "memory_topic_events_recent_insert_guard",
    ];
    const installed = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (?, ?) ORDER BY name`)
      .bind(...expected).all<{ name: string; sql: string | null }>();
    expect(installed.results.map((trigger) => trigger.name)).toEqual(expected);
    for (const trigger of installed.results) {
      expect(trigger.sql).toContain(`CREATE TRIGGER ${trigger.name}`);
    }
  });

  it("events_memory_owner_command_ingress_guard accepts one canonical owner command", async () => {
    const ownerId = await seedOwner();
    await expect(insertEvent(canonicalOwnerCommand(ownerId))).resolves.toBeUndefined();
  });

  for (const [label, field, value, conflictAction] of [
    ["type without source", "source", "jarvis.conversation", "OR IGNORE"],
    ["source without type", "eventType", "conversation.user_committed", ""],
  ] as const) {
    it(`events_memory_owner_command_ingress_guard rejects ${label}`, async () => {
      const ownerId = await seedOwner();
      const event = withMirroredField(canonicalOwnerCommand(ownerId), field, value);
      await expect(insertEvent(event, conflictAction))
        .rejects.toThrow(/memory_owner_command_ingress_invalid/u);
    });
  }

  for (const [label, principalType, status] of [
    ["a non-human principal", "service", "active"],
    ["an inactive principal", "human", "disabled"],
  ] as const) {
    it(`events_memory_owner_command_ingress_guard rejects ${label}`, async () => {
      const principalId = `principal:memory:${nextUlid()}`;
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, 'memory ingress negative principal', ?, ?)`)
        .bind(principalId, principalType, status, now, now).run();
      await expect(insertEvent(canonicalOwnerCommand(principalId)))
        .rejects.toThrow(/memory_owner_command_ingress_invalid/u);
    });
  }

  for (const [field, value] of [
    ["eventId", () => nextUlid()],
    ["correlationId", () => nextUlid()],
    ["eventType", () => "conversation.user_committed"],
    ["source", () => "jarvis.conversation"],
    ["subjectId", () => `principal:memory:${nextUlid()}`],
    ["occurredAt", () => "2026-09-15T00:00:00.000Z"],
    ["receivedAt", () => "2026-09-15T00:00:01.000Z"],
    ["contentHash", () => "f".repeat(64)],
  ] as const) {
    it(`events_memory_owner_command_ingress_guard rejects an envelope ${field} mismatch`, async () => {
      const ownerId = await seedOwner();
      const event = withEnvelopeField(canonicalOwnerCommand(ownerId), field, value());
      await expect(insertEvent(event)).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
    });
  }

  it("events_memory_owner_command_ingress_guard rejects a non-object envelope", async () => {
    const ownerId = await seedOwner();
    const event = { ...canonicalOwnerCommand(ownerId), envelope: [] };
    await expect(insertEvent(event)).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
  });

  it("events_memory_owner_command_ingress_guard rejects a non-object payload", async () => {
    const ownerId = await seedOwner();
    const event = withEnvelopeField(canonicalOwnerCommand(ownerId), "payload", []);
    await expect(insertEvent(event)).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
  });

  for (const [label, mutate] of [
    ["25-character targetId", (targetId: string) => targetId.slice(0, 25)],
    ["27-character targetId", (targetId: string) => `${targetId}0`],
    ["targetId starting with 8", (targetId: string) => `8${targetId.slice(1)}`],
    ["targetId containing I", (targetId: string) => `${targetId.slice(0, 25)}I`],
    ["targetId containing L", (targetId: string) => `${targetId.slice(0, 25)}L`],
    ["targetId containing O", (targetId: string) => `${targetId.slice(0, 25)}O`],
    ["targetId containing U", (targetId: string) => `${targetId.slice(0, 25)}U`],
  ] as const) {
    it(`events_memory_owner_command_ingress_guard rejects a ${label}`, async () => {
      const ownerId = await seedOwner();
      const targetId = nextUlid();
      const event = withTargetId(canonicalOwnerCommand(ownerId, {
        operation: "item.transition",
        targetId,
      }), mutate(targetId));
      await expect(insertEvent(event)).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
    });
  }

  it("events_memory_owner_command_ingress_guard enforces the producer and operation allowlists", async () => {
    const ownerId = await seedOwner();
    for (const payload of validPayloads()) {
      await expect(insertEvent(canonicalOwnerCommand(ownerId, payload))).resolves.toBeUndefined();
    }
    await expect(insertEvent(canonicalOwnerCommand(ownerId, {
      operation: "topic.delete",
      targetId: nextUlid(),
    })))
      .rejects.toThrow(/memory_owner_command_ingress_invalid/u);
    const producerMismatch = withEnvelopeField(
      canonicalOwnerCommand(ownerId),
      "producerVersion",
      "memory-control-v2",
    );
    await expect(insertEvent(producerMismatch))
      .rejects.toThrow(/memory_owner_command_ingress_invalid/u);
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

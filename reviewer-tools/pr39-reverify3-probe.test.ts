import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import cloudMemorySql from "../../src/persistence/migrations/0016_cloud_memory.sql?raw";
import { applyCloudMemoryMigration } from "./migration.js";

// PR #39 round-4 verifier probes (reviewer-side only; never committed to the PR).
// Each probe asserts the behaviour it claims. Mutated triggers are restored in finally.

const clock = Date.now();
const ts = new Date(clock - 60_000).toISOString();
const later = new Date(clock).toISOString();
const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 900_000;

function ulid(): string {
  let value = serial;
  serial += 1;
  let suffix = "";
  for (let index = 0; index < 18; index += 1) {
    suffix = `${crockford[value % 32]}${suffix}`;
    value = Math.floor(value / 32);
  }
  return `01k3w1v9${suffix}`;
}

function hash(): string {
  serial += 1;
  return serial.toString(16).padStart(64, "0");
}

async function seedPrincipal(): Promise<string> {
  const principalId = `principal:verify4:${ulid()}`;
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'verify probe', ?, ?)`).bind(principalId, ts, ts).run();
  return principalId;
}

async function seedEvent(principalId: string): Promise<{ eventId: string; sequence: number }> {
  const eventId = ulid();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'jarvis.conversation', ?, ?, ?, ?, '{}', ?)`)
    .bind(eventId, principalId, ts, ts, hash(), ts).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("probe_event_missing");
  return { eventId, sequence: row.sequence };
}

async function seedOwnerCommand(
  principalId: string, operation: string, targetId: string, fields: Record<string, unknown>,
): Promise<{ eventId: string; sequence: number }> {
  const eventId = ulid();
  const contentHash = hash();
  const envelope = {
    eventId, correlationId: eventId, eventType: "memory.owner_command", source: "memory-control",
    subjectId: principalId, occurredAt: ts, receivedAt: ts, contentHash,
    producerVersion: "memory-control-v1", payload: { operation, targetId, ...fields },
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'memory.owner_command', 'memory-control', ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, principalId, ts, ts, contentHash, JSON.stringify(envelope), ts).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("probe_command_missing");
  return { eventId, sequence: row.sequence };
}

function triggerSql(name: string): string {
  const sql = cloudMemorySql.replaceAll("\r\n", "\n");
  const start = sql.indexOf(`CREATE TRIGGER ${name}\n`);
  const end = sql.indexOf("\nEND;", start);
  if (start < 0 || end < 0) throw new Error(`probe_trigger_missing:${name}`);
  return sql.slice(start, end + "\nEND;".length);
}

async function withMutatedTrigger(
  name: string, from: string, to: string, body: () => Promise<void>,
): Promise<void> {
  const original = triggerSql(name);
  if (!original.includes(from)) throw new Error(`probe_mutation_anchor_missing:${name}`);
  await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    await env.DB.prepare(original.replace(from, to)).run();
    await body();
  } finally {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    await env.DB.prepare(original).run();
  }
}

async function insertVersion(
  principalId: string, itemId: string, versionNumber: number, validTo: string | null,
  origin = "deterministic_observation", basis = "observed",
): Promise<string> {
  const versionId = ulid();
  await env.DB.prepare(`INSERT INTO memory_item_versions (
    version_id, principal_id, item_id, version_number, text, text_normalization,
    text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
    extractor_version, extractor_model_id, created_at
  ) VALUES (?, ?, ?, ?, 'Probe text.', 'NFC', ?, ?, ?, 0, 'normal', NULL, ?, 'policy-v1', NULL, ?)`)
    .bind(versionId, principalId, itemId, versionNumber, hash(), basis, origin, validTo, ts).run();
  return versionId;
}

async function insertSource(
  principalId: string, itemId: string, versionId: string, event: { eventId: string; sequence: number },
): Promise<void> {
  await env.DB.prepare(`INSERT INTO memory_item_sources (
    source_id, principal_id, item_id, version_id, source_position, event_id,
    event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
    channel, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'Probe text.', ?, 'telegram', ?, ?)`)
    .bind(ulid(), principalId, itemId, versionId, event.eventId, event.sequence, hash(), ts, ts).run();
}

function transition(
  transitionId: string, principalId: string, itemId: string, number: number, versionId: string,
  state: string, actor: "owner" | "rules", commandId: string | null, occurredAt: string,
) {
  return env.DB.prepare(`INSERT INTO memory_item_transitions (
    transition_id, principal_id, item_id, transition_number, version_id,
    lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'probe', ?, 'policy-v1', ?, ?)`)
    .bind(transitionId, principalId, itemId, number, versionId, state, actor, commandId, occurredAt).run();
}

async function seedItem(principalId: string, event: { eventId: string; sequence: number }, kind = "plan") {
  const itemId = ulid();
  await env.DB.prepare(`INSERT INTO memory_items (
    item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).bind(itemId, principalId, kind, event.eventId, event.sequence, ts).run();
  return itemId;
}

// Builds the builder's NF4 scenario; returns the T4 insert that uses the stale pre-issued command.
async function nf4Scenario(staleOperation: "item.transition" | "item.correct") {
  const p = await seedPrincipal();
  const first = await seedEvent(p);
  const itemId = await seedItem(p, first);
  const v1 = await insertVersion(p, itemId, 1, ts);
  await insertSource(p, itemId, v1, first);
  await transition(ulid(), p, itemId, 1, v1, "proposed", "rules", null, ts);
  const second = await seedEvent(p);
  const v2 = await insertVersion(p, itemId, 2, null);
  await insertSource(p, itemId, v2, second);
  const staleId = ulid();
  const stale = await seedOwnerCommand(p, staleOperation, staleId, { itemId, versionId: v2, lifecycleState: "active" });
  const t2 = ulid();
  const fresh = await seedOwnerCommand(p, "item.transition", t2, { itemId, versionId: v1, lifecycleState: "active" });
  await transition(t2, p, itemId, 2, v1, "active", "owner", fresh.eventId, later);
  await transition(ulid(), p, itemId, 3, v1, "expired", "rules", null, later);
  return () => transition(staleId, p, itemId, 4, v2, "active", "owner", stale.eventId, later);
}

const NF4_FIXED = `          SELECT max(previous_command.sequence)
          FROM memory_item_transitions previous_transition
          JOIN memory_valid_owner_commands previous_command
            ON previous_command.event_id = previous_transition.owner_authorizing_event_id
          WHERE previous_transition.principal_id = NEW.principal_id
            AND previous_transition.item_id = NEW.item_id`;
const NF4_REVERTED = `          SELECT previous_command.sequence
          FROM memory_item_state state
          JOIN memory_item_transitions previous_transition
            ON previous_transition.principal_id = state.principal_id
            AND previous_transition.transition_id = state.last_transition_id
          JOIN memory_valid_owner_commands previous_command
            ON previous_command.event_id = previous_transition.owner_authorizing_event_id
          WHERE state.principal_id = NEW.principal_id
            AND state.item_id = NEW.item_id`;
const TRANSITION_FUTURE_BOUND = "  OR NEW.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')\n";

async function topicEvent(mode: "" | "OR IGNORE " | "OR REPLACE ", input: {
  principalId: string; topicId: string; operation: string; newParentTopicId?: string | null;
  previousDisplayName?: string | null; previousNormalizedName?: string | null;
  newDisplayName?: string | null; newNormalizedName?: string | null;
  addedAliases?: Record<string, string>[]; topicEventId?: string;
}): Promise<string> {
  const topicEventId = input.topicEventId ?? ulid();
  await env.DB.prepare(`INSERT ${mode}INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
    new_parent_topic_id, previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, '[]', '[]', ?, 'probe', 'model', NULL, ?)`)
    .bind(
      topicEventId, input.principalId, input.topicId, input.operation, input.newParentTopicId ?? null,
      input.previousDisplayName ?? null, input.previousNormalizedName ?? null,
      input.newDisplayName ?? null, input.newNormalizedName ?? null,
      JSON.stringify(input.addedAliases ?? []), ts,
    ).run();
  return topicEventId;
}

async function seedTopicPair(p: string) {
  const rootId = ulid();
  await topicEvent("", { principalId: p, topicId: rootId, operation: "create", newDisplayName: "Root", newNormalizedName: "root" });
  const childId = ulid();
  await topicEvent("", {
    principalId: p, topicId: childId, operation: "create", newParentTopicId: rootId,
    newDisplayName: "Before", newNormalizedName: "before",
  });
  return { rootId, childId };
}

describe.sequential("PR39 round-4 verifier probes", () => {
  beforeAll(async () => {
    await applyCloudMemoryMigration();
  });

  it("P1a head: a stale pre-issued item.transition command is rejected after a rules transition", async () => {
    const insertStale = await nf4Scenario("item.transition");
    await expect(insertStale()).rejects.toThrow(/memory_item_transition_invalid/u);
  });

  it("P1b NF4 reverted: item.transition stale command is ACCEPTED, but the builder's item.correct variant is still rejected", async () => {
    await withMutatedTrigger("memory_item_transitions_insert_guard", NF4_FIXED, NF4_REVERTED, async () => {
      const insertStaleTransition = await nf4Scenario("item.transition");
      await expect(insertStaleTransition()).resolves.toBeDefined();
      const insertStaleCorrect = await nf4Scenario("item.correct");
      await expect(insertStaleCorrect()).rejects.toThrow(/memory_item_transition_invalid/u);
    });
  });

  it("P2a carried OR IGNORE: rename event commits while the over-long topic rename is silently skipped", async () => {
    const p = await seedPrincipal();
    const { childId } = await seedTopicPair(p);
    const longName = "L".repeat(300);
    const aliases = [{ aliasId: ulid(), topicId: childId, displayName: "Before", normalizedName: "before", pathAlias: "Root/Before" }];
    await expect(topicEvent("", {
      principalId: p, topicId: childId, operation: "rename", previousDisplayName: "Before",
      previousNormalizedName: "before", newDisplayName: longName, newNormalizedName: "long", addedAliases: aliases,
    })).rejects.toThrow(/CHECK constraint failed/u);
    const eventId = await topicEvent("OR IGNORE ", {
      principalId: p, topicId: childId, operation: "rename", previousDisplayName: "Before",
      previousNormalizedName: "before", newDisplayName: longName, newNormalizedName: "long",
      addedAliases: [{ ...aliases[0]!, aliasId: ulid() }],
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM memory_topic_events WHERE topic_event_id = ?")
      .bind(eventId).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT display_name, normalized_name, last_topic_event_id = ? AS applied FROM memory_topics WHERE topic_id = ?")
      .bind(eventId, childId).first()).toEqual({ display_name: "Before", normalized_name: "before", applied: 0 });
  });

  it("P2b carried OR IGNORE: create event commits with no topic row", async () => {
    const p = await seedPrincipal();
    const { rootId } = await seedTopicPair(p);
    const topicId = ulid();
    const eventId = await topicEvent("OR IGNORE ", {
      principalId: p, topicId, operation: "create", newParentTopicId: rootId,
      newDisplayName: "N".repeat(300), newNormalizedName: "ghost",
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM memory_topic_events WHERE topic_event_id = ?")
      .bind(eventId).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM memory_topics WHERE topic_id = ?")
      .bind(topicId).first()).toEqual({ n: 0 });
  });

  it("P2c carried OR IGNORE: rename applies while its required alias row (malformed aliasId) is silently dropped", async () => {
    const p = await seedPrincipal();
    const { childId } = await seedTopicPair(p);
    const eventId = await topicEvent("OR IGNORE ", {
      principalId: p, topicId: childId, operation: "rename", previousDisplayName: "Before",
      previousNormalizedName: "before", newDisplayName: "After", newNormalizedName: "after",
      addedAliases: [{ aliasId: "not-a-ulid", topicId: childId, displayName: "Before", normalizedName: "before", pathAlias: "Root/Before" }],
    });
    expect(await env.DB.prepare("SELECT display_name, last_topic_event_id = ? AS applied FROM memory_topics WHERE topic_id = ?")
      .bind(eventId, childId).first()).toEqual({ display_name: "After", applied: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM memory_topic_aliases WHERE created_by_topic_event_id = ?")
      .bind(eventId).first()).toEqual({ n: 0 });
  });

  it("P3 sweep insensitivity: with the vectors mutation_id pin removed, the sweep-style key update still throws but a colliding UPDATE OR REPLACE deletes another vector", async () => {
    const p = await seedPrincipal();
    const insertVector = async () => {
      const id = ulid();
      await env.DB.prepare(`INSERT INTO memory_vectors (
        vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
        dimensions, content_hash, mutation_id, upserted_at, deleted_at
      ) VALUES (?, ?, 'item', ?, '@cf/baai/bge-m3', 1024, ?, ?, ?, NULL)`)
        .bind(id, p, ulid(), hash(), `mutation:${id}`, ts).run();
      return id;
    };
    const a = await insertVector();
    const b = await insertVector();
    const collide = () => env.DB.prepare(`UPDATE OR REPLACE memory_vectors
      SET mutation_id = ?, deleted_at = ? WHERE vector_ledger_id = ?`).bind(`mutation:${b}`, later, a).run();
    await expect(collide()).rejects.toThrow(/memory_vector_delete_transition_invalid/u);
    await withMutatedTrigger("memory_vectors_update_guard", "  OR NEW.mutation_id <> OLD.mutation_id\n", "", async () => {
      await expect(env.DB.prepare(`UPDATE OR REPLACE "memory_vectors"
        SET "mutation_id" = COALESCE("mutation_id", '') || ':replace-probe' WHERE vector_ledger_id = ?`)
        .bind(a).run()).rejects.toThrow();
      await expect(collide()).resolves.toBeDefined();
      expect(await env.DB.prepare("SELECT count(*) AS n FROM memory_vectors WHERE vector_ledger_id = ?")
        .bind(b).first()).toEqual({ n: 0 });
    });
  });

  it("P4a head: a rules write stamped now+4m blocks an owner forget stamped now until the clock catches up", async () => {
    const p = await seedPrincipal();
    const ev = await seedEvent(p);
    const itemId = await seedItem(p, ev, "preference");
    const v1 = await insertVersion(p, itemId, 1, null, "authenticated_first_person", "stated");
    await insertSource(p, itemId, v1, ev);
    await transition(ulid(), p, itemId, 1, v1, "proposed", "rules", null, ts);
    const future = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    await expect(transition(ulid(), p, itemId, 2, v1, "active", "rules", null, future)).resolves.toBeDefined();
    const forgetNow = ulid();
    const cmdNow = await seedOwnerCommand(p, "item.forget", forgetNow, { itemId, versionId: v1, lifecycleState: "forgotten" });
    await expect(transition(forgetNow, p, itemId, 3, v1, "forgotten", "owner", cmdNow.eventId, new Date().toISOString()))
      .rejects.toThrow(/memory_item_transition_invalid/u);
    const forgetLater = ulid();
    const cmdLater = await seedOwnerCommand(p, "item.forget", forgetLater, { itemId, versionId: v1, lifecycleState: "forgotten" });
    await expect(transition(forgetLater, p, itemId, 3, v1, "forgotten", "owner", cmdLater.eventId, future))
      .resolves.toBeDefined();
  });

  it("P4b +5-minute transition bound removed: the builder's two future-expiry negatives still reject", async () => {
    await withMutatedTrigger("memory_item_transitions_insert_guard", TRANSITION_FUTURE_BOUND, "", async () => {
      const p = await seedPrincipal();
      const ev = await seedEvent(p);
      const itemId = await seedItem(p, ev);
      const v1 = await insertVersion(p, itemId, 1, new Date(Date.now() + 2 * 60 * 1000).toISOString());
      await insertSource(p, itemId, v1, ev);
      await transition(ulid(), p, itemId, 1, v1, "proposed", "rules", null, ts);
      const t2 = ulid();
      const cmd = await seedOwnerCommand(p, "item.transition", t2, { itemId, versionId: v1, lifecycleState: "active" });
      await transition(t2, p, itemId, 2, v1, "active", "owner", cmd.eventId, later);
      await expect(transition(ulid(), p, itemId, 3, v1, "expired", "rules", null,
        new Date(Date.now() + 4 * 60 * 1000).toISOString())).rejects.toThrow(/memory_item_transition_invalid/u);
      await expect(transition(ulid(), p, itemId, 3, v1, "expired", "rules", null,
        new Date(Date.now() + 10 * 60 * 1000).toISOString())).rejects.toThrow(/memory_item_transition_invalid/u);
    });
  });
});

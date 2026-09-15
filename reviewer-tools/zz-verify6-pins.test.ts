import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import cloudMemorySql from "../../src/persistence/migrations/0016_cloud_memory.sql?raw";
import { applyCloudMemoryMigration } from "./migration.js";

// PR #39 round-5 verifier probes at 4189a2e (reviewer-side only; never committed to the PR).
// Each probe asserts the behaviour named in its title. Mutated triggers are restored in finally.

const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 700_000;
const now = (): string => new Date().toISOString();
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

function ulid(): string {
  let value = serial;
  serial += 1;
  let suffix = "";
  for (let index = 0; index < 18; index += 1) {
    suffix = `${crockford[value % 32]}${suffix}`;
    value = Math.floor(value / 32);
  }
  return `01k3w1v8${suffix}`;
}

function hash(): string {
  serial += 1;
  return serial.toString(16).padStart(64, "0");
}

async function seedPrincipal(): Promise<string> {
  const principalId = `principal:verify5:${ulid()}`;
  const ts = now();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'verify5 probe', ?, ?)`).bind(principalId, ts, ts).run();
  return principalId;
}

async function seedEvent(principalId: string): Promise<{ eventId: string; sequence: number }> {
  const eventId = ulid();
  const ts = now();
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

function triggerSql(name: string): string {
  const sql = cloudMemorySql.replaceAll("\r\n", "\n");
  const start = sql.indexOf(`CREATE TRIGGER ${name}\n`);
  const end = sql.indexOf("\nEND;", start);
  if (start < 0 || end < 0) throw new Error(`probe_trigger_missing:${name}`);
  return sql.slice(start, end + "\nEND;".length);
}

async function withMutatedTrigger(
  name: string, from: string | null, to: string, body: () => Promise<void>,
): Promise<void> {
  const original = triggerSql(name);
  if (from !== null && original.split(from).length !== 2) {
    throw new Error(`probe_mutation_anchor_not_unique:${name}`);
  }
  await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    if (from !== null) await env.DB.prepare(original.replace(from, to)).run();
    await body();
  } finally {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    await env.DB.prepare(original).run();
  }
}

interface TopicEvent {
  readonly principalId: string;
  readonly topicId: string;
  readonly operation: "create" | "rename" | "merge";
  readonly newParentTopicId?: string | null;
  readonly previousDisplayName?: string | null;
  readonly newDisplayName?: string | null;
  readonly mergeTargetTopicId?: string | null;
  readonly reparentedChildIds?: readonly string[];
  readonly aliases?: readonly unknown[];
}

async function topicEvent(input: TopicEvent, conflict = ""): Promise<string> {
  const topicEventId = ulid();
  await env.DB.prepare(`INSERT ${conflict} INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
    new_parent_topic_id, previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'verify5 probe', 'rules', NULL, ?)`)
    .bind(
      topicEventId, input.principalId, input.topicId, input.operation,
      input.newParentTopicId ?? null,
      input.previousDisplayName ?? null, input.previousDisplayName?.toLowerCase() ?? null,
      input.newDisplayName ?? null, input.newDisplayName?.toLowerCase() ?? null,
      input.mergeTargetTopicId ?? null,
      JSON.stringify(input.reparentedChildIds ?? []), JSON.stringify(input.aliases ?? []), now(),
    ).run();
  return topicEventId;
}

const createTopic = (principalId: string, topicId: string, parent: string | null, name: string, conflict = "") =>
  topicEvent({ principalId, topicId, operation: "create", newParentTopicId: parent, newDisplayName: name }, conflict);

const renameTopic = (
  principalId: string, topicId: string, from: string, to: string, pathAlias: string, conflict = "",
) => topicEvent({
  principalId, topicId, operation: "rename", previousDisplayName: from, newDisplayName: to,
  aliases: [{ aliasId: ulid(), topicId, displayName: from, normalizedName: from.toLowerCase(), pathAlias }],
}, conflict);

async function count(sql: string, ...bindings: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...bindings).first<{ count: number }>();
  return row?.count ?? -1;
}

describe.sequential("PR #39 round-5 verifier probes", () => {
  beforeAll(async () => {
    await applyCloudMemoryMigration();
  });

  it("V1 (head) a topic renamed X->Y->X cannot be renamed to Y again: the required old-name alias already exists", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    await createTopic(p, root, null, "Root");
    const topic = ulid();
    await createTopic(p, topic, root, "X");
    await renameTopic(p, topic, "X", "Y", "Root/X");
    await renameTopic(p, topic, "Y", "X", "Root/Y");
    await expect(renameTopic(p, topic, "X", "Y", "Root/X"))
      .rejects.toThrow(/memory_topic_alias_requires_event/u);
    expect(await env.DB.prepare("SELECT display_name FROM memory_topics WHERE topic_id = ?")
      .bind(topic).first()).toEqual({ display_name: "X" });
  });

  it("V2 (head) own-parent merge (F5) leaves one path naming two topics, and the surviving child's first rename is then refused", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    const parent = ulid();
    const source = ulid();
    const child = ulid();
    await createTopic(p, root, null, "Root");
    await createTopic(p, parent, root, "Parent");
    await createTopic(p, source, parent, "Shared");
    await createTopic(p, child, source, "Shared");
    await topicEvent({
      principalId: p, topicId: source, operation: "merge", previousDisplayName: "Shared",
      mergeTargetTopicId: parent, reparentedChildIds: [child],
      aliases: [{
        aliasId: ulid(), topicId: parent, displayName: "Shared", normalizedName: "shared",
        pathAlias: "Root/Parent/Shared",
      }],
    });
    expect(await env.DB.prepare(`SELECT topic_id FROM memory_topic_aliases
      WHERE principal_id = ? AND normalized_alias = 'shared' AND path_alias = 'Root/Parent/Shared'`)
      .bind(p).first()).toEqual({ topic_id: parent });
    expect(await env.DB.prepare(`SELECT topic_id FROM memory_topics
      WHERE principal_id = ? AND parent_topic_id = ? AND normalized_name = 'shared' AND status = 'active'`)
      .bind(p, parent).first()).toEqual({ topic_id: child });
    await expect(renameTopic(p, child, "Shared", "Other", "Root/Parent/Shared"))
      .rejects.toThrow(/memory_topic_alias_requires_event/u);
  });

  it("V3 (head) own-parent merge still refuses a child colliding with a different active child of the target, under plain and OR REPLACE", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    const parent = ulid();
    const source = ulid();
    const kid = ulid();
    const child = ulid();
    await createTopic(p, root, null, "Root");
    await createTopic(p, parent, root, "Parent");
    await createTopic(p, source, parent, "Shared");
    await createTopic(p, kid, parent, "Kid");
    await createTopic(p, child, source, "Kid");
    const merge = {
      principalId: p, topicId: source, operation: "merge" as const, previousDisplayName: "Shared",
      mergeTargetTopicId: parent, reparentedChildIds: [child],
      aliases: [{
        aliasId: ulid(), topicId: parent, displayName: "Shared", normalizedName: "shared",
        pathAlias: "Root/Parent/Shared",
      }],
    };
    await expect(topicEvent(merge)).rejects.toThrow(/memory_topic_event_invalid/u);
    await expect(topicEvent(merge, "OR REPLACE")).rejects.toThrow(/memory_topic_event_invalid/u);
    expect(await count("SELECT count(*) AS count FROM memory_topics WHERE topic_id = ?", kid)).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM memory_topics WHERE topic_id = ?")
      .bind(source).first()).toEqual({ status: "active" });
  });

  it("V4 (head) OR FAIL cannot commit a partial topic event: over-long name and malformed alias are refused whole", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    await createTopic(p, root, null, "Root");
    const longTopic = ulid();
    await expect(createTopic(p, longTopic, root, "N".repeat(300), "OR FAIL")).rejects.toThrow(/CHECK/u);
    expect(await count("SELECT count(*) AS count FROM memory_topic_events WHERE topic_id = ?", longTopic)).toBe(0);
    const topic = ulid();
    await createTopic(p, topic, root, "Before");
    await expect(topicEvent({
      principalId: p, topicId: topic, operation: "rename", previousDisplayName: "Before", newDisplayName: "After",
      aliases: [{ aliasId: "not-a-ulid", topicId: topic, displayName: "Before", normalizedName: "before", pathAlias: "Root/Before" }],
    }, "OR FAIL")).rejects.toThrow(/memory_topic_event_invalid/u);
    expect(await env.DB.prepare("SELECT display_name FROM memory_topics WHERE topic_id = ?")
      .bind(topic).first()).toEqual({ display_name: "Before" });
  });

  it("V5 (head) settlement and overrun on a month-crossing run can be stamped 35 days back, into the prior month", async () => {
    const p = await seedPrincipal();
    const priceId = ulid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', ?, 1, 1, 0, 'USD', 'verify5 price', ?)`)
      .bind(priceId, p, daysAgo(50), daysAgo(50)).run();
    const runId = ulid();
    // Same seeding technique as the builder's month-boundary test: a run legitimately left running for 40 days.
    await withMutatedTrigger("memory_runs_insert_guard", null, "", async () => {
      await env.DB.prepare(`INSERT INTO memory_runs (
        run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
        provider_model_id, price_id, outcome, started_at
      ) VALUES (?, ?, ?, 'distillation', NULL, NULL, 'deepseek:deepseek-v4-pro', ?, 'running', ?)`)
        .bind(runId, p, `verify5:${runId}`, priceId, daysAgo(40)).run();
    });
    const ledger = (id: string, type: string, reservation: string | null, amount: number, at: string) =>
      env.DB.prepare(`INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at
      ) VALUES (?, ?, ?, ?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', 'normal_monthly', NULL, ?, ?, ?)`)
        .bind(id, p, runId, type, reservation, amount, priceId, at).run();
    const reservationId = ulid();
    await ledger(reservationId, "reservation", null, 100, now());
    await expect(ledger(ulid(), "reservation", null, 1, daysAgo(35)))
      .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
    await ledger(ulid(), "settlement", reservationId, 100, daysAgo(35));
    await ledger(ulid(), "overrun", reservationId, 50, daysAgo(35));
    expect(await count(`SELECT count(*) AS count FROM memory_cost_ledger
      WHERE run_id = ? AND entry_type IN ('settlement', 'overrun') AND occurred_at < ?`, runId, daysAgo(30)))
      .toBe(2);
  });

  it("V6 (mutant) with the cursor_name pin removed, the sweep's key collision still throws but a same-principal rename deletes a sibling cursor", async () => {
    const p1 = await seedPrincipal();
    const p2 = await seedPrincipal();
    const cursor = (p: string, name: string, sequence: number) => env.DB.prepare(`INSERT INTO memory_cursors (
      principal_id, cursor_name, current_event_sequence, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(p, name, sequence, daysAgo(1)).run();
    await cursor(p1, "fts_items", 9);
    await cursor(p1, "fts_episodes", 5);
    await cursor(p2, "fts_items", 1);
    await withMutatedTrigger("memory_cursors_monotonic_update", "  OR NEW.cursor_name <> OLD.cursor_name\n", "", async () => {
      // The sweep's exact PK-group statement (collision fixture = another principal).
      await expect(env.DB.prepare(`UPDATE OR REPLACE "memory_cursors"
        SET "principal_id" = (SELECT "principal_id" FROM "memory_cursors" WHERE principal_id = ? AND cursor_name = 'fts_items'),
          "cursor_name" = (SELECT "cursor_name" FROM "memory_cursors" WHERE principal_id = ? AND cursor_name = 'fts_items'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE principal_id = ? AND cursor_name = 'fts_items'`).bind(p2, p2, p1).run())
        .rejects.toThrow(/memory_cursor_transition_invalid/u);
      await env.DB.prepare(`UPDATE OR REPLACE memory_cursors
        SET cursor_name = 'fts_episodes', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE principal_id = ? AND cursor_name = 'fts_items'`).bind(p1).run();
    });
    expect((await env.DB.prepare(`SELECT cursor_name, current_event_sequence FROM memory_cursors
      WHERE principal_id = ? ORDER BY cursor_name`).bind(p1).all()).results)
      .toEqual([{ cursor_name: "fts_episodes", current_event_sequence: 9 }]);
    // Control at head: the same rename is refused.
    const p3 = await seedPrincipal();
    await cursor(p3, "fts_items", 9);
    await cursor(p3, "fts_episodes", 5);
    await expect(env.DB.prepare(`UPDATE OR REPLACE memory_cursors
      SET cursor_name = 'fts_episodes', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE principal_id = ? AND cursor_name = 'fts_items'`).bind(p3).run())
      .rejects.toThrow(/memory_cursor_transition_invalid/u);
  });

  it("V7 (mutant) with the vector item_id pin removed, a same-principal composite-key collision deletes another vector row", async () => {
    const p = await seedPrincipal();
    const sharedHash = hash();
    const vector = async (itemId: string) => {
      const id = ulid();
      await env.DB.prepare(`INSERT INTO memory_vectors (
        vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
        dimensions, content_hash, mutation_id, upserted_at, deleted_at
      ) VALUES (?, ?, 'item', ?, '@cf/baai/bge-m3', 1024, ?, ?, ?, NULL)`)
        .bind(id, p, itemId, sharedHash, `mutation:${id}`, daysAgo(1)).run();
      return id;
    };
    const a = await vector(ulid());
    const bItem = ulid();
    const b = await vector(bItem);
    await withMutatedTrigger("memory_vectors_update_guard", "  OR NEW.item_id <> OLD.item_id\n", "", async () => {
      await env.DB.prepare(`UPDATE OR REPLACE memory_vectors
        SET item_id = ?, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE vector_ledger_id = ?`)
        .bind(bItem, a).run();
    });
    expect(await count("SELECT count(*) AS count FROM memory_vectors WHERE vector_ledger_id = ?", b)).toBe(0);
  });

  it("V8 (mutant) with the alias (name, path) duplicate clause removed, a carried REPLACE rename deletes another topic's alias while the sweep's clone stays refused", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    await createTopic(p, root, null, "Root");
    const first = ulid();
    await createTopic(p, first, root, "X");
    await renameTopic(p, first, "X", "Y", "Root/X");
    const second = ulid();
    await createTopic(p, second, root, "Z");
    const aliasClause = "\n      OR (alias.principal_id = NEW.principal_id\n        AND alias.normalized_alias = NEW.normalized_alias\n        AND alias.path_alias = NEW.path_alias)";
    await withMutatedTrigger("memory_topic_aliases_insert_guard", aliasClause, "", async () => {
      await expect(env.DB.prepare(`INSERT OR REPLACE INTO "memory_topic_aliases" (
        alias_id, principal_id, topic_id, display_alias, normalized_alias, path_alias,
        created_by_topic_event_id, created_at)
        SELECT ?, principal_id, topic_id, display_alias, normalized_alias, path_alias,
          created_by_topic_event_id, created_at
        FROM memory_topic_aliases WHERE principal_id = ? AND topic_id = ?`).bind(ulid(), p, first).run())
        .rejects.toThrow(/memory_topic_alias_requires_event/u);
      await topicEvent({
        principalId: p, topicId: second, operation: "rename", previousDisplayName: "Z", newDisplayName: "W",
        aliases: [{ aliasId: ulid(), topicId: second, displayName: "X", normalizedName: "x", pathAlias: "Root/X" }],
      }, "OR REPLACE");
    });
    expect(await count("SELECT count(*) AS count FROM memory_topic_aliases WHERE topic_id = ?", first)).toBe(0);
  });

  it("V9 (mutant) with the topic sibling-name clause removed, a carried REPLACE create deletes an existing same-named sibling", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    await createTopic(p, root, null, "Root");
    const existing = ulid();
    await createTopic(p, existing, root, "Dup");
    const clause = "\n      OR (topic.principal_id = NEW.principal_id\n        AND topic.parent_topic_id IS NEW.parent_topic_id\n        AND topic.normalized_name = NEW.normalized_name\n        AND topic.status = 'active')";
    await withMutatedTrigger("memory_topics_insert_guard", clause, "", async () => {
      await createTopic(p, ulid(), root, "Dup", "OR REPLACE");
    });
    expect(await count("SELECT count(*) AS count FROM memory_topics WHERE topic_id = ?", existing)).toBe(0);
  });

  it("V10 (mutant) with the one-primary clause removed, a carried REPLACE place deletes the item's existing primary placement state", async () => {
    const p = await seedPrincipal();
    const event = await seedEvent(p);
    const itemId = ulid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'fact', ?, ?, ?)`).bind(itemId, p, event.eventId, event.sequence, now()).run();
    const root = ulid();
    await createTopic(p, root, null, "Root");
    const topicA = ulid();
    const topicB = ulid();
    await createTopic(p, topicA, root, "A");
    await createTopic(p, topicB, root, "B");
    const place = (placementId: string, topicId: string, conflict = "") => env.DB.prepare(`INSERT ${conflict}
      INTO memory_item_placement_events (
        placement_event_id, principal_id, placement_id, placement_event_number,
        item_id, operation, previous_topic_id, new_topic_id, relation,
        filing_source, confidence, reason, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 1, ?, 'place', NULL, ?, 'primary', 'rule', 0.9, 'verify5', NULL, ?)`)
      .bind(ulid(), p, placementId, itemId, topicId, now()).run();
    const first = ulid();
    await place(first, topicA);
    const clause = "\n      AND (state.placement_id = NEW.placement_id\n        OR (state.item_id = NEW.item_id AND state.relation = 'primary'\n          AND state.status = 'active' AND NEW.relation = 'primary' AND NEW.status = 'active'))";
    await withMutatedTrigger("memory_item_placement_state_insert_guard", clause,
      "\n      AND state.placement_id = NEW.placement_id", async () => {
        await place(ulid(), topicB, "OR REPLACE");
      });
    expect(await count(`SELECT count(*) AS count FROM memory_item_placement_state
      WHERE principal_id = ? AND placement_id = ?`, p, first)).toBe(0);
  });

  for (const [label, pin, column, differing] of [
    ["V7b content_hash", "  OR NEW.content_hash <> OLD.content_hash\n", "content_hash", "hash"],
    ["V7c embedding_model", "  OR NEW.embedding_model <> OLD.embedding_model\n", "embedding_model", "model"],
  ] as const) {
    it(`${label} (mutant) pin removed: a same-principal UPDATE OR REPLACE collision deletes another vector row`, async () => {
      const p = await seedPrincipal();
      const itemId = ulid();
      const vector = async (h: string, model: string) => {
        const id = ulid();
        await env.DB.prepare(`INSERT INTO memory_vectors (
          vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
          dimensions, content_hash, mutation_id, upserted_at, deleted_at
        ) VALUES (?, ?, 'item', ?, ?, 1024, ?, ?, ?, NULL)`)
          .bind(id, p, itemId, model, h, `mutation:${id}`, daysAgo(1)).run();
        return id;
      };
      const hA = hash(); const hB = differing === "hash" ? hash() : hA;
      const mA = "@cf/baai/bge-m3"; const mB = differing === "model" ? "@cf/baai/bge-m3-alt" : mA;
      const a = await vector(hA, mA);
      const b = await vector(hB, mB);
      const newValue = column === "content_hash" ? hB : mB;
      await withMutatedTrigger("memory_vectors_update_guard", pin, "", async () => {
        await env.DB.prepare(`UPDATE OR REPLACE memory_vectors
          SET ${column} = ?, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE vector_ledger_id = ?`)
          .bind(newValue, a).run();
      });
      expect(await count("SELECT count(*) AS count FROM memory_vectors WHERE vector_ledger_id = ?", b)).toBe(0);
    });
  }
});

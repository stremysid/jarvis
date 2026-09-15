import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import cloudMemorySql from "../../src/persistence/migrations/0016_cloud_memory.sql?raw";
import { applyCloudMemoryMigration } from "./migration.js";

// PR #39 round-6 verifier probes at 5ef0ce5 (verifier-side only; never committed to the PR).

const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 900_000;
const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

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

async function seedPrincipal(): Promise<string> {
  const principalId = `principal:verify6:${ulid()}`;
  const ts = iso();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'verify6 probe', ?, ?)`).bind(principalId, ts, ts).run();
  return principalId;
}

function triggerSql(name: string): string {
  const sql = cloudMemorySql.replaceAll("\r\n", "\n");
  const start = sql.indexOf(`CREATE TRIGGER ${name}\n`);
  const end = sql.indexOf("\nEND;", start);
  if (start < 0 || end < 0) throw new Error(`probe_trigger_missing:${name}`);
  return sql.slice(start, end + "\nEND;".length);
}

async function withoutTrigger(name: string, body: () => Promise<void>): Promise<void> {
  const original = triggerSql(name);
  await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    await body();
  } finally {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    await env.DB.prepare(original).run();
  }
}

interface Alias { aliasId: string; topicId: string; displayName: string; normalizedName: string; pathAlias: string }
interface TopicEvent {
  readonly principalId: string;
  readonly topicId: string;
  readonly operation: "create" | "rename";
  readonly newParentTopicId?: string | null;
  readonly previousDisplayName?: string | null;
  readonly newDisplayName?: string | null;
  readonly aliases?: readonly Alias[];
  readonly occurredAt?: string;
}

async function topicEvent(input: TopicEvent, conflict = ""): Promise<string> {
  const topicEventId = ulid();
  await env.DB.prepare(`INSERT ${conflict} INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
    new_parent_topic_id, previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, '[]', '[]', ?, 'verify6 probe', 'rules', NULL, ?)`)
    .bind(
      topicEventId, input.principalId, input.topicId, input.operation,
      input.newParentTopicId ?? null,
      input.previousDisplayName ?? null, input.previousDisplayName?.toLowerCase() ?? null,
      input.newDisplayName ?? null, input.newDisplayName?.toLowerCase() ?? null,
      JSON.stringify(input.aliases ?? []), input.occurredAt ?? iso(),
    ).run();
  return topicEventId;
}

const create = (principalId: string, topicId: string, parent: string | null, name: string, occurredAt?: string) =>
  topicEvent({ principalId, topicId, operation: "create", newParentTopicId: parent, newDisplayName: name, occurredAt });

const alias = (topicId: string, name: string, pathAlias: string, aliasId = ulid()): Alias =>
  ({ aliasId, topicId, displayName: name, normalizedName: name.toLowerCase(), pathAlias });

async function first<T>(sql: string, ...bindings: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...bindings).first<T>();
}

describe.sequential("PR #39 round-6 verifier probes", () => {
  beforeAll(async () => {
    await applyCloudMemoryMigration();
  });

  it("P1 (head) alias-id collisions under carried OR REPLACE / OR IGNORE, intra-event duplicate ids and verbatim REPLACE are refused; duplicate tuples with distinct ids are kept", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    await create(p, root, null, "Root");
    const a = ulid();
    const b = ulid();
    await create(p, a, root, "A");
    await create(p, b, root, "B");
    const aliasId = ulid();
    await topicEvent({ principalId: p, topicId: a, operation: "rename", previousDisplayName: "A", newDisplayName: "A2",
      aliases: [alias(a, "A", "Root/A", aliasId)] });

    for (const conflict of ["OR REPLACE", "OR IGNORE"]) {
      await expect(topicEvent({ principalId: p, topicId: b, operation: "rename", previousDisplayName: "B",
        newDisplayName: "B2", aliases: [alias(b, "B", "Root/B", aliasId)] }, conflict))
        .rejects.toThrow(/memory_topic_alias_requires_event/u);
    }
    const dup = ulid();
    await expect(topicEvent({ principalId: p, topicId: b, operation: "rename", previousDisplayName: "B",
      newDisplayName: "B2", aliases: [alias(b, "B", "Root/B", dup), alias(b, "B", "Root/B/x", dup)] }, "OR REPLACE"))
      .rejects.toThrow(/memory_topic_alias_requires_event/u);
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO memory_topic_aliases
      SELECT * FROM memory_topic_aliases WHERE alias_id = ?`).bind(aliasId).run())
      .rejects.toThrow(/memory_topic_alias_requires_event/u);

    expect(await first("SELECT topic_id, normalized_alias FROM memory_topic_aliases WHERE alias_id = ?", aliasId))
      .toEqual({ topic_id: a, normalized_alias: "a" });
    expect(await first("SELECT display_name FROM memory_topics WHERE topic_id = ?", b)).toEqual({ display_name: "B" });

    await topicEvent({ principalId: p, topicId: b, operation: "rename", previousDisplayName: "B", newDisplayName: "B2",
      aliases: [alias(b, "B", "Root/B"), alias(b, "B", "Root/B")] });
    expect(await first(`SELECT count(*) AS count FROM memory_topic_aliases
      WHERE principal_id = ? AND normalized_alias = 'b' AND path_alias = 'Root/B'`, p)).toEqual({ count: 2 });
  });

  it("P2 (head) a later-written alias with an older event time loses newest-first resolution to an earlier write", async () => {
    const p = await seedPrincipal();
    const root = ulid();
    const a = ulid();
    const b = ulid();
    await create(p, root, null, "Root", iso(-3 * HOUR));
    await create(p, a, root, "X", iso(-3 * HOUR));
    // write 1: A leaves Root/X now
    await topicEvent({ principalId: p, topicId: a, operation: "rename", previousDisplayName: "X", newDisplayName: "Y",
      aliases: [alias(a, "X", "Root/X")] });
    // write 2 and 3: B takes Root/X, then leaves it. Both are accepted with backdated stamps.
    await create(p, b, root, "X", iso(-2 * HOUR));
    await topicEvent({ principalId: p, topicId: b, operation: "rename", previousDisplayName: "X", newDisplayName: "Z",
      aliases: [alias(b, "X", "Root/X")], occurredAt: iso(-1 * HOUR) });

    expect(await first(`SELECT topic_id FROM memory_topics WHERE principal_id = ? AND parent_topic_id = ?
      AND normalized_name = 'x' AND status = 'active'`, p, root)).toBeNull();
    const newest = await first(`SELECT topic_id FROM memory_topic_aliases
      WHERE principal_id = ? AND normalized_alias = 'x' AND path_alias = 'Root/X'
      ORDER BY created_at DESC, created_by_topic_event_id DESC, alias_id DESC LIMIT 1`, p);
    // B was the most recent holder of Root/X in commit order, but A's alias wins.
    expect(newest).toEqual({ topic_id: a });
  });

  describe.sequential("P4 single vector-pin removals the migration file does not kill (each mutates one trigger, restored in finally)", () => {
    const vector = (principalId: string, id: string, kind: string, itemId: string, contentHash: string) =>
      env.DB.prepare(`INSERT INTO memory_vectors (
        vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
        dimensions, content_hash, mutation_id, upserted_at, deleted_at
      ) VALUES (?, ?, ?, ?, '@cf/baai/bge-m3', 1024, ?, ?, ?, NULL)`)
        .bind(id, principalId, kind, itemId, contentHash, `verify6:${id}`, iso(-MIN)).run();
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);

    async function withPinRemoved(pin: string, body: () => Promise<void>): Promise<void> {
      const name = "memory_vectors_update_guard";
      const original = triggerSql(name);
      if (original.split(pin).length !== 2) throw new Error("probe_anchor_not_unique");
      await env.DB.prepare(`DROP TRIGGER ${name}`).run();
      try {
        await env.DB.prepare(original.replace(pin, "")).run();
        await body();
      } finally {
        await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
        await env.DB.prepare(original).run();
      }
    }

    it("P4a E3 content_hash pin removed: same-principal UPDATE OR REPLACE deletes another vector ledger row", async () => {
      const p = await seedPrincipal();
      const left = ulid();
      const right = ulid();
      const itemId = ulid();
      await vector(p, left, "item", itemId, hashA);
      await vector(p, right, "item", itemId, hashB);
      await withPinRemoved("  OR NEW.content_hash <> OLD.content_hash\n", async () => {
        await env.DB.prepare(`UPDATE OR REPLACE memory_vectors SET content_hash = ?, deleted_at = ?
          WHERE vector_ledger_id = ?`).bind(hashB, iso(), left).run();
      });
      expect(await first("SELECT count(*) AS count FROM memory_vectors WHERE vector_ledger_id = ?", right))
        .toEqual({ count: 0 });
    });

    it("P4b E1 item_kind pin removed: same-principal UPDATE OR REPLACE deletes another vector ledger row", async () => {
      const p = await seedPrincipal();
      const left = ulid();
      const right = ulid();
      const itemId = ulid();
      await vector(p, left, "item", itemId, hashA);
      await vector(p, right, "episode", itemId, hashA);
      await withPinRemoved("  OR NEW.item_kind <> OLD.item_kind\n", async () => {
        await env.DB.prepare(`UPDATE OR REPLACE memory_vectors SET item_kind = 'episode', deleted_at = ?
          WHERE vector_ledger_id = ?`).bind(iso(), left).run();
      });
      expect(await first("SELECT count(*) AS count FROM memory_vectors WHERE vector_ledger_id = ?", right))
        .toEqual({ count: 0 });
    });

    it("P4c E6 principal pin removed: cross-principal UPDATE OR REPLACE deletes the other principal's vector row", async () => {
      const owner = await seedPrincipal();
      const other = await seedPrincipal();
      const left = ulid();
      const right = ulid();
      const itemId = ulid();
      await vector(owner, left, "item", itemId, hashA);
      await vector(other, right, "item", itemId, hashA);
      await withPinRemoved("  OR NEW.principal_id <> OLD.principal_id\n", async () => {
        await env.DB.prepare(`UPDATE OR REPLACE memory_vectors SET principal_id = ?, deleted_at = ?
          WHERE vector_ledger_id = ?`).bind(other, iso(), left).run();
      });
      expect(await first("SELECT count(*) AS count FROM memory_vectors WHERE vector_ledger_id = ?", right))
        .toEqual({ count: 0 });
    });

    it("P4d control at head: each of the three collisions is refused and both rows survive", async () => {
      const owner = await seedPrincipal();
      const other = await seedPrincipal();
      const itemId = ulid();
      const ids = [ulid(), ulid(), ulid(), ulid()] as const;
      await vector(owner, ids[0], "item", itemId, hashA);
      await vector(owner, ids[1], "item", itemId, hashB);
      await vector(owner, ids[2], "episode", itemId, hashA);
      await vector(other, ids[3], "item", itemId, hashA);
      for (const [sql, value] of [
        ["SET content_hash = ?", hashB],
        ["SET item_kind = ?", "episode"],
        ["SET principal_id = ?", other],
      ] as const) {
        await expect(env.DB.prepare(`UPDATE OR REPLACE memory_vectors ${sql}, deleted_at = ?
          WHERE vector_ledger_id = ?`).bind(value, iso(), ids[0]).run())
          .rejects.toThrow(/memory_vector_delete_transition_invalid/u);
      }
      expect(await first(`SELECT count(*) AS count FROM memory_vectors WHERE vector_ledger_id IN (?, ?, ?, ?)`, ...ids))
        .toEqual({ count: 4 });
    });
  });

  describe.sequential("P3 S2 legitimate ledger paths at head", () => {
    const model = "deepseek:deepseek-v4-pro";
    let p = "";
    let priceId = "";
    let runId = "";
    const reservations: string[] = [];

    const ledger = (entryType: string, reservationEntryId: string | null, amount: number, occurredAt: string) =>
      env.DB.prepare(`INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at
      ) VALUES (?, ?, ?, ?, ?, 'deepseek', ?, 'normal_monthly', NULL, ?, ?, ?)`)
        .bind(ulid(), p, runId, entryType, reservationEntryId, model, amount, priceId, occurredAt).run();

    beforeAll(async () => {
      p = await seedPrincipal();
      priceId = ulid();
      const ts = iso();
      await env.DB.prepare(`INSERT INTO memory_model_prices (
        price_id, principal_id, provider, model_id, effective_at,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, currency, source_receipt, created_at
      ) VALUES (?, ?, 'deepseek', ?, ?, 1, 1, 0, 'USD', 'verify6 price', ?)`).bind(priceId, p, model, ts, ts).run();
      runId = ulid();
      await withoutTrigger("memory_runs_insert_guard", async () => {
        await env.DB.prepare(`INSERT INTO memory_runs (
          run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
          provider_model_id, price_id, outcome, started_at
        ) VALUES (?, ?, ?, 'distillation', NULL, NULL, ?, ?, 'running', ?)`)
          .bind(runId, p, `verify6:${runId}`, model, priceId, iso(-2 * HOUR)).run();
      });
      await withoutTrigger("memory_cost_ledger_insert_guard", async () => {
        for (let index = 0; index < 5; index += 1) {
          const id = ulid();
          reservations.push(id);
          await env.DB.prepare(`INSERT INTO memory_cost_ledger (
            cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
            provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at
          ) VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', ?, 'normal_monthly', NULL, 100, ?, ?)`)
            .bind(id, p, runId, model, priceId, iso(-1 * HOUR)).run();
        }
      });
    });

    it("P3a settles a one-hour-old reservation now, then records an overrun now", async () => {
      await expect(ledger("settlement", reservations[0]!, 100, iso())).resolves.toBeTruthy();
      await expect(ledger("overrun", reservations[0]!, 7, iso())).resolves.toBeTruthy();
    });

    it("P3b boundary: a settlement stamped now-4m is accepted; a release stamped now-6m is refused", async () => {
      await expect(ledger("settlement", reservations[1]!, 100, iso(-4 * MIN))).resolves.toBeTruthy();
      await expect(ledger("release", reservations[2]!, 100, iso(-6 * MIN)))
        .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
      await expect(ledger("overrun", reservations[1]!, 5, iso())).resolves.toBeTruthy();
    });

    it("P3c after the run completes, an outstanding reservation is released now; a new reservation is refused", async () => {
      await env.DB.prepare(`UPDATE memory_runs SET outcome = 'succeeded', completed_at = ?
        WHERE principal_id = ? AND run_id = ?`).bind(iso(), p, runId).run();
      await expect(ledger("release", reservations[2]!, 100, iso())).resolves.toBeTruthy();
      await expect(ledger("reservation", null, 1, iso())).rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
    });

    it("P3d note: an overrun stamped now after a settlement stamped now+4m (allowed skew) is refused until the clock passes it", async () => {
      await expect(ledger("settlement", reservations[3]!, 100, iso(4 * MIN))).resolves.toBeTruthy();
      await expect(ledger("overrun", reservations[3]!, 5, iso()))
        .rejects.toThrow(/memory_cost_entry_lineage_invalid/u);
    });
  });
});

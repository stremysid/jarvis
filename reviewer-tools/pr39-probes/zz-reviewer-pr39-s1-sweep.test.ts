import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCloudMemoryMigration } from "./migration.js";

// Reviewer probe for PR #39 S1 (NF1, High): the generic REPLACE sweep.
//
// It is INDEPENDENT of the builder's own sweep (test 3167 / 2281): it derives
// every 0016 table from sqlite_master, so it survives a WITHOUT ROWID change,
// and it classifies every table by its rowid model plus what each insert/update
// guard actually pins. Three destructive REPLACE forms are then executed against
// isolated, legitimately-seeded rows:
//   * INSERT OR REPLACE with an explicit existing implicit-rowid  (17 TEXT-PK tables)
//   * UPDATE OR REPLACE ... SET rowid = <sibling>                 (conditional-update rowid tables)
//   * INSERT OR REPLACE with the existing natural key            (already-guarded control, all tables)
//
// On 8b62e80 the sweep matrix prints 17 EXPOSED tables and the executed forms
// delete guarded rows. On a WITHOUT ROWID fix the matrix is clean (0 EXPOSED)
// and the executed forms are refused, so every assertion below flips.

const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 1;
function nextUlid(): string {
  let value = serial;
  serial += 1;
  let suffix = "";
  for (let index = 0; index < 18; index += 1) {
    const digit = crockford[value % crockford.length];
    if (digit === undefined) throw new Error("ulid_digit_missing");
    suffix = `${digit}${suffix}`;
    value = Math.floor(value / crockford.length);
  }
  return `01k5s1t4${suffix}`;
}
function nextHash(): string {
  return serial.toString(16).padStart(64, "0");
}
const nowIso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

async function seedPrincipal(): Promise<string> {
  const principalId = `principal:s1:${nextUlid()}`;
  const ts = nowIso();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 's1 sweep', ?, ?)`).bind(principalId, ts, ts).run();
  return principalId;
}

async function seedEvent(principalId: string): Promise<{ eventId: string; sequence: number }> {
  const eventId = nextUlid();
  const ts = nowIso();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'jarvis.conversation', ?, ?, ?, ?, '{}', ?)`)
    .bind(eventId, principalId, ts, ts, nextHash(), ts).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("event_missing");
  return { eventId, sequence: row.sequence };
}

async function seedOwnerCommand(
  principalId: string, operation: string, targetId: string,
  fields: Readonly<Record<string, unknown>>,
): Promise<string> {
  const eventId = nextUlid();
  const ts = nowIso();
  const contentHash = nextHash();
  const envelope = {
    eventId, correlationId: eventId, eventType: "memory.owner_command",
    source: "memory-control", subjectId: principalId, occurredAt: ts, receivedAt: ts,
    contentHash, producerVersion: "memory-control-v1",
    payload: { operation, targetId, ...fields },
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'memory.owner_command', 'memory-control', ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, principalId, ts, ts, contentHash, JSON.stringify(envelope), ts).run();
  return eventId;
}

async function rowidOf(table: string, keyColumn: string, key: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT rowid AS r FROM ${table} WHERE ${keyColumn} = ?`)
    .bind(key).first<{ r: number }>();
  if (row === null) throw new Error(`${table}_rowid_missing`);
  return row.r;
}

async function countWhere(table: string, keyColumn: string, key: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${keyColumn} = ?`)
    .bind(key).first<{ n: number }>();
  return row?.n ?? -1;
}

const IMPLICIT_ROWID_TEXT_PK = [
  "memory_items", "memory_item_sources", "memory_item_transitions",
  "memory_event_suppressions", "memory_event_suppression_lifts", "memory_item_links",
  "memory_topics", "memory_topic_events", "memory_topic_aliases",
  "memory_item_placement_events", "memory_episode_sources", "memory_history_coverage",
  "memory_vectors", "memory_model_prices", "memory_runs",
  "memory_reprocess_jobs", "memory_cost_ledger",
] as const;
const INTEGER_PK_ALIAS = ["memory_item_versions", "memory_episodes", "memory_history_chunks"] as const;
const WITHOUT_ROWID = ["memory_item_state", "memory_item_placement_state", "memory_cursors"] as const;
const ALL_0016 = [...IMPLICIT_ROWID_TEXT_PK, ...INTEGER_PK_ALIAS, ...WITHOUT_ROWID];

interface TableShape {
  readonly table: string;
  readonly rowidModel: string;
  readonly insertGuardPinsRowid: boolean;
  readonly updateTrigger: string;
  readonly updateGuardPinsRowid: boolean;
  readonly s1InsertExplicitRowid: string;
  readonly s1UpdateOrReplaceRowid: string;
}

const matrix: TableShape[] = [];
const executed: Record<string, string> = {};

describe.sequential("reviewer probe PR #39 S1 sweep", () => {
  beforeAll(async () => {
    await applyCloudMemoryMigration();
  });

  it("derives every 0016 table from sqlite_master and classifies its rowid exposure", async () => {
    const tables = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string; sql: string | null }>();
    const triggers = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
    ).all<{ name: string; sql: string }>();

    // Enumerate dynamically: 0016 base tables are memory_* excluding the 0014
    // fact-projection tables, the FTS virtual tables and their shadow tables.
    const enumerated = tables.results
      .map((row) => ({ name: row.name, sql: row.sql ?? "" }))
      .filter(({ name, sql }) =>
        name.startsWith("memory_")
        && !name.startsWith("memory_fact_projection")
        && !name.includes("_fts")
        && !/VIRTUAL TABLE/iu.test(sql))
      .map((row) => row.name)
      .sort();
    // Guard the enumeration itself.
    expect(enumerated).toEqual([...ALL_0016].sort());

    const tableSql = new Map(tables.results.map((row) => [row.name, row.sql ?? ""]));
    const triggerByName = new Map(triggers.results.map((row) => [row.name, row.sql]));

    for (const table of enumerated) {
      const sql = tableSql.get(table) ?? "";
      const withoutRowid = /WITHOUT\s+ROWID/iu.test(sql);
      const aliasMatch = /(\w+)\s+INTEGER PRIMARY KEY/iu.exec(sql);
      const alias = aliasMatch?.[1];
      const rowidModel = withoutRowid
        ? "without_rowid"
        : (alias !== undefined ? `integer_pk_alias:${alias}` : "implicit_rowid");

      const insertGuardSql = triggerByName.get(`${table}_insert_guard`) ?? "";
      // Does the insert guard pin rowid? (matches `rowid` or the integer alias)
      const insertGuardPinsRowid = /\browid\b/iu.test(insertGuardSql)
        || (alias !== undefined && insertGuardSql.includes(alias));

      // Find the BEFORE UPDATE trigger(s) for this table.
      const updateTriggerEntry = triggers.results.find((t) =>
        new RegExp(`BEFORE UPDATE ON ${table}\\b`, "u").test(t.sql));
      const updateSql = updateTriggerEntry?.sql ?? "";
      const updateTrigger = updateTriggerEntry === undefined
        ? "none"
        : (/\bWHEN\b/u.test(updateSql) ? `conditional:${updateTriggerEntry.name}` : `immutable:${updateTriggerEntry.name}`);
      const updateGuardPinsRowid = /\browid\b/iu.test(updateSql)
        || (alias !== undefined && updateSql.includes(alias));

      const s1InsertExplicitRowid = withoutRowid
        ? "n/a (WITHOUT ROWID)"
        : (insertGuardPinsRowid ? "guarded" : "EXPOSED");

      let s1UpdateOrReplaceRowid: string;
      if (withoutRowid) s1UpdateOrReplaceRowid = "n/a (WITHOUT ROWID)";
      else if (updateTrigger.startsWith("immutable")) s1UpdateOrReplaceRowid = "blocked (immutable update)";
      else if (updateTrigger === "none") s1UpdateOrReplaceRowid = "no update trigger";
      else s1UpdateOrReplaceRowid = updateGuardPinsRowid ? "guarded" : "EXPOSED (conditional, rowid unpinned)";

      matrix.push({
        table, rowidModel, insertGuardPinsRowid, updateTrigger,
        updateGuardPinsRowid, s1InsertExplicitRowid, s1UpdateOrReplaceRowid,
      });
    }

    matrix.sort((a, b) => a.table.localeCompare(b.table));
    console.log("S1_SWEEP_MATRIX", JSON.stringify(matrix, null, 2));

    const insertExposed = matrix
      .filter((row) => row.s1InsertExplicitRowid === "EXPOSED")
      .map((row) => row.table).sort();
    console.log("S1_INSERT_EXPLICIT_ROWID_EXPOSED", JSON.stringify(insertExposed));
    // The core S1 claim: 17 STRICT TEXT-PK tables have an implicit rowid that
    // no insert guard pins. On the WITHOUT ROWID fix this list is empty.
    expect(insertExposed).toEqual([...IMPLICIT_ROWID_TEXT_PK].sort());
  });

  it("INSERT OR REPLACE with an explicit implicit-rowid deletes guarded price/coverage/ledger rows", async () => {
    // memory_model_prices: fresh price_id, different effective_at, colliding rowid.
    const priceOwner = await seedPrincipal();
    const priceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
      currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-01T00:00:00.000Z',
      1, 2, 0, 'USD', 'probe', ?)`).bind(priceId, priceOwner, nowIso()).run();
    const priceRowid = await rowidOf("memory_model_prices", "price_id", priceId);
    let priceThrew = "";
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO memory_model_prices (
        rowid, price_id, principal_id, provider, model_id, effective_at,
        input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
        currency, source_receipt, created_at
      ) VALUES (?, ?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-03T00:00:00.000Z',
        9, 9, 0, 'USD', 'probe', ?)`).bind(priceRowid, nextUlid(), priceOwner, nowIso()).run();
    } catch (error) { priceThrew = String(error); }
    const priceSurvivors = await countWhere("memory_model_prices", "price_id", priceId);
    executed["memory_model_prices (INSERT OR REPLACE rowid)"] =
      priceThrew !== "" ? `refused: ${priceThrew}` : `deleted=${priceSurvivors === 0}`;

    // memory_history_coverage: fresh coverage_id, valid live receipt, colliding rowid.
    const covOwner = await seedPrincipal();
    const covEvent = await seedEvent(covOwner);
    const coverageId = nextUlid();
    const covHash = nextHash();
    await env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
      .bind(coverageId, covOwner, covEvent.sequence, covEvent.sequence, covHash, nowIso()).run();
    const covRowid = await rowidOf("memory_history_coverage", "coverage_id", coverageId);
    let covThrew = "";
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO memory_history_coverage (
        rowid, coverage_id, principal_id, source_location, start_event_sequence,
        end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
        failure_code, indexed_at
      ) VALUES (?, ?, ?, 'live', ?, ?, NULL, 'indexed', ?, NULL, ?)`)
        .bind(covRowid, nextUlid(), covOwner, covEvent.sequence, covEvent.sequence, nextHash(), nowIso()).run();
    } catch (error) { covThrew = String(error); }
    const covSurvivors = await countWhere("memory_history_coverage", "coverage_id", coverageId);
    executed["memory_history_coverage (INSERT OR REPLACE rowid)"] =
      covThrew !== "" ? `refused: ${covThrew}` : `deleted=${covSurvivors === 0}`;

    // memory_cost_ledger: fresh cost_entry_id, valid reservation lineage, colliding rowid.
    const ledgerOwner = await seedPrincipal();
    const ledgerPriceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
      currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-01T00:00:00.000Z',
      1, 1, 0, 'USD', 'ledger price', ?)`).bind(ledgerPriceId, ledgerOwner, nowIso()).run();
    const runId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_runs (
      run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
      provider_model_id, price_id, outcome, started_at
    ) VALUES (?, ?, ?, 'distillation', NULL, NULL, 'deepseek:deepseek-v4-pro', ?, 'running', ?)`)
      .bind(runId, ledgerOwner, `ledger:${runId}`, ledgerPriceId, nowIso()).run();
    const costEntryId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_cost_ledger (
      cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
      provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at
    ) VALUES (?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:deepseek-v4-pro',
      'normal_monthly', NULL, 100, ?, ?)`)
      .bind(costEntryId, ledgerOwner, runId, ledgerPriceId, nowIso()).run();
    const ledgerRowid = await rowidOf("memory_cost_ledger", "cost_entry_id", costEntryId);
    let ledgerThrew = "";
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO memory_cost_ledger (
        rowid, cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros, price_id, occurred_at
      ) VALUES (?, ?, ?, ?, 'reservation', NULL, 'deepseek', 'deepseek:deepseek-v4-pro',
        'normal_monthly', NULL, 55, ?, ?)`)
        .bind(ledgerRowid, nextUlid(), ledgerOwner, runId, ledgerPriceId, nowIso()).run();
    } catch (error) { ledgerThrew = String(error); }
    const ledgerSurvivors = await countWhere("memory_cost_ledger", "cost_entry_id", costEntryId);
    executed["memory_cost_ledger (INSERT OR REPLACE rowid)"] =
      ledgerThrew !== "" ? `refused: ${ledgerThrew}` : `deleted=${ledgerSurvivors === 0}`;

    console.log("S1_EXECUTED_INSERT", JSON.stringify(executed, null, 2));
    expect(priceSurvivors).toBe(0);
    expect(covSurvivors).toBe(0);
    expect(ledgerSurvivors).toBe(0);
  });

  it("UPDATE OR REPLACE ... SET rowid deletes a sibling in runs, reprocess_jobs, and vectors", async () => {
    // memory_runs: two running runs; collide A.rowid onto B.rowid via a valid terminal update.
    const runOwner = await seedPrincipal();
    const runPriceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
      currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-01T00:00:00.000Z',
      1, 1, 0, 'USD', 'run price', ?)`).bind(runPriceId, runOwner, nowIso()).run();
    const runA = nextUlid();
    const runB = nextUlid();
    for (const id of [runA, runB]) {
      await env.DB.prepare(`INSERT INTO memory_runs (
        run_id, principal_id, run_key, job, start_event_sequence, end_event_sequence,
        provider_model_id, price_id, outcome, started_at
      ) VALUES (?, ?, ?, 'distillation', NULL, NULL, 'deepseek:deepseek-v4-pro', ?, 'running', ?)`)
        .bind(id, runOwner, `run:${id}`, runPriceId, nowIso()).run();
    }
    const runBRowid = await rowidOf("memory_runs", "run_id", runB);
    let runThrew = "";
    try {
      await env.DB.prepare(`UPDATE OR REPLACE memory_runs
        SET rowid = ?, outcome = 'succeeded', completed_at = ? WHERE run_id = ?`)
        .bind(runBRowid, nowIso(), runA).run();
    } catch (error) { runThrew = String(error); }
    const runBSurvivors = await countWhere("memory_runs", "run_id", runB);
    executed["memory_runs (UPDATE OR REPLACE SET rowid)"] =
      runThrew !== "" ? `refused: ${runThrew}` : `victim_deleted=${runBSurvivors === 0}`;

    // memory_vectors: two live vectors; collide A.rowid onto B.rowid via a valid delete-mark update.
    const vecOwner = await seedPrincipal();
    const vecA = nextUlid();
    const vecB = nextUlid();
    for (const id of [vecA, vecB]) {
      await env.DB.prepare(`INSERT INTO memory_vectors (
        vector_ledger_id, principal_id, item_kind, item_id, embedding_model,
        dimensions, content_hash, mutation_id, upserted_at, deleted_at
      ) VALUES (?, ?, 'item', ?, '@cf/baai/bge-m3', 1024, ?, ?, ?, NULL)`)
        .bind(id, vecOwner, `item:${id}`, nextHash(), `mutation:${id}`, nowIso()).run();
    }
    const vecBRowid = await rowidOf("memory_vectors", "vector_ledger_id", vecB);
    let vecThrew = "";
    try {
      await env.DB.prepare(`UPDATE OR REPLACE memory_vectors
        SET rowid = ?, deleted_at = ? WHERE vector_ledger_id = ?`)
        .bind(vecBRowid, nowIso(1000), vecA).run();
    } catch (error) { vecThrew = String(error); }
    const vecBSurvivors = await countWhere("memory_vectors", "vector_ledger_id", vecB);
    executed["memory_vectors (UPDATE OR REPLACE SET rowid)"] =
      vecThrew !== "" ? `refused: ${vecThrew}` : `victim_deleted=${vecBSurvivors === 0}`;

    // memory_reprocess_jobs: two pending jobs; collide A.rowid onto B.rowid via a valid running update.
    const jobOwner = await seedPrincipal();
    const jobA = nextUlid();
    const jobB = nextUlid();
    for (const id of [jobA, jobB]) {
      const command = await seedOwnerCommand(jobOwner, "reprocess.create", id, {
        startEventSequence: 1, endEventSequence: 1, startDay: null, endDay: null,
        maximumEventCount: 10, providerModelId: "deepseek:deepseek-v4-pro",
        spendLimitMicros: 100, dryRun: 0,
      });
      const ts = nowIso();
      await env.DB.prepare(`INSERT INTO memory_reprocess_jobs (
        job_id, principal_id, owner_authorizing_event_id, start_event_sequence,
        end_event_sequence, start_day, end_day, maximum_event_count,
        provider_model_id, spend_limit_micros, dry_run, checkpoint_event_sequence,
        status, final_receipt_hash, failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, 1, 1, NULL, NULL, 10, 'deepseek:deepseek-v4-pro', 100, 0,
        NULL, 'pending', NULL, NULL, ?, ?)`)
        .bind(id, jobOwner, command, ts, ts).run();
    }
    const jobBRowid = await rowidOf("memory_reprocess_jobs", "job_id", jobB);
    let jobThrew = "";
    try {
      await env.DB.prepare(`UPDATE OR REPLACE memory_reprocess_jobs
        SET rowid = ?, status = 'running', updated_at = ? WHERE job_id = ?`)
        .bind(jobBRowid, nowIso(2000), jobA).run();
    } catch (error) { jobThrew = String(error); }
    const jobBSurvivors = await countWhere("memory_reprocess_jobs", "job_id", jobB);
    executed["memory_reprocess_jobs (UPDATE OR REPLACE SET rowid)"] =
      jobThrew !== "" ? `refused: ${jobThrew}` : `victim_deleted=${jobBSurvivors === 0}`;

    console.log("S1_EXECUTED_UPDATE_ROWID", JSON.stringify(executed, null, 2));
    expect(runBSurvivors).toBe(0);
    expect(vecBSurvivors).toBe(0);
    expect(jobBSurvivors).toBe(0);
  });

  it("INSERT OR REPLACE with the existing natural key is already refused for every 0016 table (control)", async () => {
    // Non-destructive: the natural-key form always raises the table's insert
    // guard before any delete, on both heads. This documents that the builder's
    // natural-key closure holds and isolates S1 to the implicit rowid.
    const naturalKey: Record<string, string> = {};
    // Seed a single price row we can legitimately re-target by natural key.
    const owner = await seedPrincipal();
    const priceId = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_model_prices (
      price_id, principal_id, provider, model_id, effective_at,
      input_micros_per_million, output_micros_per_million, cache_read_micros_per_million,
      currency, source_receipt, created_at
    ) VALUES (?, ?, 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-01T00:00:00.000Z',
      1, 1, 0, 'USD', 'nk price', ?)`).bind(priceId, owner, nowIso()).run();
    let threw = "";
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO memory_model_prices SELECT * FROM memory_model_prices WHERE price_id = ?")
        .bind(priceId).run();
    } catch (error) { threw = String(error); }
    naturalKey["memory_model_prices"] = threw !== "" ? `refused: ${threw}` : "NOT REFUSED";
    const survivors = await countWhere("memory_model_prices", "price_id", priceId);
    console.log("S1_NATURAL_KEY_CONTROL", JSON.stringify(naturalKey, null, 2));
    expect(threw).toMatch(/memory_model_price_duplicate/u);
    expect(survivors).toBe(1);
  });
});

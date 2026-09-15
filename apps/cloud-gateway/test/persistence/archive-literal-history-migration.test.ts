import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyArchiveLiteralHistoryMigration } from "./migration.js";

const NOW = "2026-09-15T22:00:00.000Z";
const LATER = "2026-09-15T22:01:00.000Z";
const PRINCIPAL_ID = "principal:literal-history-migration";
const JOB_ID = "01k5fsvag00000000000000001";
const OTHER_JOB_ID = "01k5fsvag00000000000000002";
const FORGED_JOB_ID = "01k5fsvag00000000000000005";
const EVENT_ID = "01k5fsvag00000000000000003";
const QUERY_HASH = "1".repeat(64);
const CONTENT_HASH = "2".repeat(64);

const TRIGGERS = [
  "memory_literal_search_hits_delete_forbidden",
  "memory_literal_search_hits_immutable_update",
  "memory_literal_search_hits_insert_guard",
  "memory_literal_search_jobs_delete_forbidden",
  "memory_literal_search_jobs_insert_guard",
  "memory_literal_search_jobs_update_guard",
] as const;

function insertJob(jobId: string, jobKey: string, snapshot = 1): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO memory_literal_search_jobs (
    job_id, principal_id, job_key, query_text, query_hash,
    snapshot_event_sequence, checkpoint_event_sequence,
    scanned_event_count, matched_event_count, status, failure_code,
    created_at, updated_at, completed_at
  ) VALUES (?1, ?2, ?3, 'needle', ?4, ?5, 0, 0, 0, 'pending', NULL, ?6, ?6, NULL)`)
    .bind(jobId, PRINCIPAL_ID, jobKey, QUERY_HASH, snapshot, NOW);
}

async function ensureFixture(): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Literal history owner', ?2, ?2)`)
    .bind(PRINCIPAL_ID, NOW).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?1, 'jarvis.conversation', 'local', ?2, ?3, ?3, ?4, '{}', ?3)`)
    .bind(EVENT_ID, PRINCIPAL_ID, NOW, CONTENT_HASH).run();
  await insertJob(JOB_ID, "primary").run();
  await env.DB.prepare(`UPDATE memory_literal_search_jobs
    SET status = 'running', updated_at = ?1
    WHERE principal_id = ?2 AND job_id = ?3`)
    .bind(LATER, PRINCIPAL_ID, JOB_ID).run();
  await env.DB.prepare(`INSERT INTO memory_literal_search_hits (
    principal_id, job_id, event_sequence, event_id, content_hash, found_at
  ) SELECT ?1, ?2, sequence, event_id, content_hash, ?3
    FROM events WHERE event_id = ?4`)
    .bind(PRINCIPAL_ID, JOB_ID, LATER, EVENT_ID).run();
}

beforeAll(async () => {
  await applyArchiveLiteralHistoryMigration();
  await ensureFixture();
});

describe("0025 archive literal-history migration", () => {
  it("installs only the durable job, provenance receipt, index, and named guards", async () => {
    const tables = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'memory_literal_search_%' ORDER BY name`)
      .all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "memory_literal_search_hits",
      "memory_literal_search_jobs",
    ]);
    const triggers = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'memory_literal_search_%' ORDER BY name`)
      .all<{ name: string; sql: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual(TRIGGERS);
    for (const trigger of triggers.results) {
      expect(trigger.sql).not.toMatch(/\bSELECT\s+CASE\b/iu);
      expect(trigger.sql).toContain("RAISE(ABORT");
    }
    await expect(env.DB.prepare("PRAGMA foreign_key_check").all())
      .resolves.toMatchObject({ results: [] });
  });

  it("memory_literal_search_jobs_insert_guard rejects invalid initial state", async () => {
    await expect(env.DB.prepare(`INSERT INTO memory_literal_search_jobs (
      job_id, principal_id, job_key, query_text, query_hash,
      snapshot_event_sequence, checkpoint_event_sequence,
      scanned_event_count, matched_event_count, status, failure_code,
      created_at, updated_at, completed_at
    ) VALUES (?1, ?2, 'invalid-initial', 'needle', ?3, 1, 1, 1, 0,
      'running', NULL, ?4, ?4, NULL)`)
      .bind(OTHER_JOB_ID, PRINCIPAL_ID, QUERY_HASH, NOW).run())
      .rejects.toThrow(/memory_literal_search_job_initial_state_invalid/u);
  });

  it("memory_literal_search_jobs_update_guard rejects a backwards checkpoint", async () => {
    await env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET checkpoint_event_sequence = 1, scanned_event_count = 1,
        matched_event_count = 1, updated_at = ?1
      WHERE principal_id = ?2 AND job_id = ?3`)
      .bind("2026-09-15T22:01:30.000Z", PRINCIPAL_ID, JOB_ID).run();
    await expect(env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET checkpoint_event_sequence = 0, scanned_event_count = 0, updated_at = ?1
      WHERE principal_id = ?2 AND job_id = ?3`)
      .bind("2026-09-15T22:02:00.000Z", PRINCIPAL_ID, JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_job_transition_invalid/u);
  });

  it("memory_literal_search_jobs_update_guard rejects completion without scanning the snapshot", async () => {
    await insertJob(FORGED_JOB_ID, "forged-completion").run();
    await env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'running', updated_at = ?1
      WHERE principal_id = ?2 AND job_id = ?3`)
      .bind(LATER, PRINCIPAL_ID, FORGED_JOB_ID).run();

    await expect(env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'succeeded', checkpoint_event_sequence = 1,
        completed_at = ?1, updated_at = ?1
      WHERE principal_id = ?2 AND job_id = ?3`)
      .bind("2026-09-15T22:01:30.000Z", PRINCIPAL_ID, FORGED_JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_job_transition_invalid/u);
  });

  it("memory_literal_search_jobs_delete_forbidden rejects durable job deletion", async () => {
    await expect(env.DB.prepare(`DELETE FROM memory_literal_search_jobs
      WHERE principal_id = ?1 AND job_id = ?2`).bind(PRINCIPAL_ID, JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_job_delete_forbidden/u);
  });

  it("memory_literal_search_hits_insert_guard rejects an unverified receipt", async () => {
    await expect(env.DB.prepare(`INSERT INTO memory_literal_search_hits (
      principal_id, job_id, event_sequence, event_id, content_hash, found_at
    ) VALUES (?1, ?2, 1, ?3, ?4, ?5)`)
      .bind(PRINCIPAL_ID, JOB_ID, "01k5fsvag00000000000000004", CONTENT_HASH, LATER).run())
      .rejects.toThrow(/memory_literal_search_hit_receipt_invalid/u);
  });

  it("memory_literal_search_hits_immutable_update rejects receipt mutation", async () => {
    await expect(env.DB.prepare(`UPDATE memory_literal_search_hits SET found_at = ?1
      WHERE principal_id = ?2 AND job_id = ?3`)
      .bind("2026-09-15T22:03:00.000Z", PRINCIPAL_ID, JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_hit_immutable/u);
  });

  it("memory_literal_search_hits_delete_forbidden rejects receipt deletion", async () => {
    await expect(env.DB.prepare(`DELETE FROM memory_literal_search_hits
      WHERE principal_id = ?1 AND job_id = ?2`).bind(PRINCIPAL_ID, JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_hit_delete_forbidden/u);
  });

  it("rejects REPLACE and IGNORE across every job and hit unique key", async () => {
    await insertJob(OTHER_JOB_ID, "secondary").run();
    for (const strategy of ["REPLACE", "IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO memory_literal_search_jobs
        SELECT * FROM memory_literal_search_jobs
        WHERE principal_id = ?1 AND job_id = ?2`).bind(PRINCIPAL_ID, JOB_ID).run())
        .rejects.toThrow(/memory_literal_search_job_initial_state_invalid/u);
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO memory_literal_search_hits
        SELECT * FROM memory_literal_search_hits
        WHERE principal_id = ?1 AND job_id = ?2`).bind(PRINCIPAL_ID, JOB_ID).run())
        .rejects.toThrow(/memory_literal_search_hit_receipt_invalid/u);
    }
    await expect(env.DB.prepare(`UPDATE OR REPLACE memory_literal_search_jobs
      SET job_key = 'secondary' WHERE principal_id = ?1 AND job_id = ?2`)
      .bind(PRINCIPAL_ID, JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_job_transition_invalid/u);
    await expect(env.DB.prepare(`UPDATE OR REPLACE memory_literal_search_hits
      SET event_id = event_id WHERE principal_id = ?1 AND job_id = ?2`)
      .bind(PRINCIPAL_ID, JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_hit_immutable/u);
    const counts = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM memory_literal_search_jobs WHERE principal_id = ?1) AS jobs,
      (SELECT count(*) FROM memory_literal_search_hits WHERE principal_id = ?1) AS hits`)
      .bind(PRINCIPAL_ID).first<{ jobs: number; hits: number }>();
    expect(counts).toEqual({ jobs: 3, hits: 1 });
  });
});

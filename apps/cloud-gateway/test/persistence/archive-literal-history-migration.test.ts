import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyArchiveLiteralHistoryMigration } from "./migration.js";

const NOW = "2026-09-15T22:00:00.000Z";
const LATER = "2026-09-15T22:01:00.000Z";
const PRINCIPAL_ID = "principal:literal-history-migration";
const JOB_ID = "01k5fsvag00000000000000001";
const OTHER_JOB_ID = "01k5fsvag00000000000000002";
const FORGED_JOB_ID = "01k5fsvag00000000000000005";
const DELETE_JOB_ID = "01k5fsvag00000000000000006";
const JUMP_JOB_ID = "01k5fsvag00000000000000009";
const COUNT_JOB_ID = "01k5fsvag0000000000000000a";
const DISABLED_JOB_ID = "01k5fsvag0000000000000000b";
const ARCHIVE_JOB_ID = "01k5fsvag0000000000000000c";
const DISABLED_HIT_JOB_ID = "01k5fsvag0000000000000000k";
const EVENT_ID = "01k5fsvag00000000000000003";
const DISABLED_HIT_EVENT_ID = "01k5fsvag0000000000000000m";
const COVERAGE_ID = "01k5fsvag00000000000000007";
const CHUNK_ID = "01k5fsvag00000000000000008";
const QUERY_HASH = "1".repeat(64);
const CONTENT_HASH = "2".repeat(64);
const OTHER_PRINCIPAL_ID = "principal:literal-history-migration-other";
const DISABLED_HIT_PRINCIPAL_ID = "principal:literal-history-migration-disabled-hit";

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

async function seedArchivedCatalogEvent(
  principalId: string,
  eventId: string,
  hashDigit: string,
): Promise<Readonly<{ sequence: number; segmentId: string; envelopeHash: string }>> {
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'jarvis.conversation', 'local', ?, ?, ?, ?, '{}', ?)`)
    .bind(eventId, principalId, NOW, NOW, CONTENT_HASH, NOW).run();
  const sequence = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<number>("sequence");
  if (sequence === null) throw new Error("literal_history_archived_fixture_missing");
  const segmentId = hashDigit.repeat(64);
  const manifestId = `${hashDigit}${"f".repeat(63)}`;
  const envelopeHash = `${hashDigit}${"e".repeat(63)}`;
  const guard = await env.DB.prepare(`SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'archive_manifests_require_next_range'`)
    .first<{ sql: string }>();
  if (guard === null) throw new Error("literal_history_archive_guard_missing");
  await env.DB.prepare("DROP TRIGGER archive_manifests_require_next_range").run();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO archive_manifests (
        manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at
      ) VALUES (?, ?, ?, 1, 'sealed', ?, ?)`)
        .bind(manifestId, sequence, sequence, NOW, NOW),
      env.DB.prepare(`INSERT INTO archive_segments (
        segment_id, manifest_id, object_key, compressed_sha256,
        compressed_byte_length, uncompressed_byte_length, codec, created_at
      ) VALUES (?, ?, ?, ?, 1, 1, 'jarvis-gzip-ndjson-v1', ?)`)
        .bind(segmentId, manifestId, `migration-test/${segmentId}`, segmentId, NOW),
      env.DB.prepare(`INSERT INTO archive_segment_events (
        event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(sequence, eventId, segmentId, envelopeHash, CONTENT_HASH, NOW),
    ]);
  } finally {
    await env.DB.prepare(guard.sql).run();
  }
  return { sequence, segmentId, envelopeHash };
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
  for (let index = 2; index <= 9; index += 1) {
    const eventId = `01k5fsvag00000000000${String(100 + index).padStart(5, "0")}`;
    await env.DB.prepare(`INSERT INTO events (
      event_id, event_type, source, subject_id, occurred_at, received_at,
      content_hash, envelope_json, created_at
    ) VALUES (?, 'jarvis.conversation', 'local', ?, ?, ?, ?, '{}', ?)`)
      .bind(eventId, PRINCIPAL_ID, NOW, NOW, CONTENT_HASH, NOW).run();
  }
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

  it("memory_literal_search_jobs_update_guard rejects a forged jump beyond one exhaustive step", async () => {
    await insertJob(JUMP_JOB_ID, "forged-step-jump", 9).run();
    await env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'running', updated_at = ?
      WHERE principal_id = ? AND job_id = ?`)
      .bind(LATER, PRINCIPAL_ID, JUMP_JOB_ID).run();

    await expect(env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'succeeded', checkpoint_event_sequence = 9,
        scanned_event_count = 9, matched_event_count = 0,
        completed_at = ?, updated_at = ?
      WHERE principal_id = ? AND job_id = ?`)
      .bind("2026-09-15T22:01:30.000Z", "2026-09-15T22:01:30.000Z", PRINCIPAL_ID, JUMP_JOB_ID)
      .run()).rejects.toThrow(/memory_literal_search_job_transition_invalid/u);
  });

  it("memory_literal_search_jobs_update_guard reconciles matched counts with durable hit receipts", async () => {
    await insertJob(COUNT_JOB_ID, "forged-match-count", 3).run();
    await env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'running', updated_at = ?
      WHERE principal_id = ? AND job_id = ?`)
      .bind(LATER, PRINCIPAL_ID, COUNT_JOB_ID).run();

    await expect(env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET checkpoint_event_sequence = 3, scanned_event_count = 3,
        matched_event_count = 3, updated_at = ?
      WHERE principal_id = ? AND job_id = ?`)
      .bind("2026-09-15T22:01:30.000Z", PRINCIPAL_ID, COUNT_JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_job_transition_invalid/u);
  });

  it("memory_literal_search_jobs_update_guard rechecks an active human principal", async () => {
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'Disabled literal owner', ?, ?)`)
      .bind(OTHER_PRINCIPAL_ID, NOW, NOW).run();
    await env.DB.prepare(`INSERT INTO memory_literal_search_jobs (
      job_id, principal_id, job_key, query_text, query_hash,
      snapshot_event_sequence, checkpoint_event_sequence,
      scanned_event_count, matched_event_count, status, failure_code,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, 'disabled-owner', 'needle', ?, 1, 0, 0, 0,
      'pending', NULL, ?, ?, NULL)`)
      .bind(DISABLED_JOB_ID, OTHER_PRINCIPAL_ID, QUERY_HASH, NOW, NOW).run();
    await env.DB.prepare("UPDATE principals SET status = 'disabled' WHERE principal_id = ?")
      .bind(OTHER_PRINCIPAL_ID).run();

    await expect(env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'running', updated_at = ? WHERE principal_id = ? AND job_id = ?`)
      .bind(LATER, OTHER_PRINCIPAL_ID, DISABLED_JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_job_transition_invalid/u);
  });

  it("memory_literal_search_jobs_delete_forbidden rejects durable job deletion", async () => {
    await insertJob(DELETE_JOB_ID, "delete-guard").run();
    await expect(env.DB.prepare(`DELETE FROM memory_literal_search_jobs
      WHERE principal_id = ?1 AND job_id = ?2`).bind(PRINCIPAL_ID, DELETE_JOB_ID).run())
      .rejects.toThrow(/memory_literal_search_job_delete_forbidden/u);
  });

  it("memory_literal_search_hits_insert_guard rejects an unverified receipt", async () => {
    await expect(env.DB.prepare(`INSERT INTO memory_literal_search_hits (
      principal_id, job_id, event_sequence, event_id, content_hash, found_at
    ) VALUES (?1, ?2, 2, ?3, ?4, ?5)`)
      .bind(PRINCIPAL_ID, JOB_ID, "01k5fsvag00000000000000004", CONTENT_HASH, LATER).run())
      .rejects.toThrow(/memory_literal_search_hit_receipt_invalid/u);
  });

  it("memory_literal_search_hits_insert_guard rejects a receipt for a disabled principal", async () => {
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'Disabled hit owner', ?, ?)`)
      .bind(DISABLED_HIT_PRINCIPAL_ID, NOW, NOW).run();
    await env.DB.prepare(`INSERT INTO events (
      event_id, event_type, source, subject_id, occurred_at, received_at,
      content_hash, envelope_json, created_at
    ) VALUES (?, 'jarvis.conversation', 'local', ?, ?, ?, ?, '{}', ?)`)
      .bind(DISABLED_HIT_EVENT_ID, DISABLED_HIT_PRINCIPAL_ID, NOW, NOW, CONTENT_HASH, NOW).run();
    const eventSequence = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
      .bind(DISABLED_HIT_EVENT_ID).first<number>("sequence");
    if (eventSequence === null) throw new Error("literal_history_disabled_hit_fixture_missing");
    await env.DB.prepare(`INSERT INTO memory_literal_search_jobs (
      job_id, principal_id, job_key, query_text, query_hash,
      snapshot_event_sequence, checkpoint_event_sequence,
      scanned_event_count, matched_event_count, status, failure_code,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, 'disabled-hit-owner', 'needle', ?, ?, 0, 0, 0,
      'pending', NULL, ?, ?, NULL)`)
      .bind(
        DISABLED_HIT_JOB_ID,
        DISABLED_HIT_PRINCIPAL_ID,
        QUERY_HASH,
        eventSequence,
        NOW,
        NOW,
      ).run();
    await env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'running', updated_at = ? WHERE principal_id = ? AND job_id = ?`)
      .bind(LATER, DISABLED_HIT_PRINCIPAL_ID, DISABLED_HIT_JOB_ID).run();
    await env.DB.prepare("UPDATE principals SET status = 'disabled' WHERE principal_id = ?")
      .bind(DISABLED_HIT_PRINCIPAL_ID).run();

    await expect(env.DB.prepare(`INSERT INTO memory_literal_search_hits (
      principal_id, job_id, event_sequence, event_id, content_hash, found_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        DISABLED_HIT_PRINCIPAL_ID,
        DISABLED_HIT_JOB_ID,
        eventSequence,
        DISABLED_HIT_EVENT_ID,
        CONTENT_HASH,
        LATER,
      ).run()).rejects.toThrow(/memory_literal_search_hit_receipt_invalid/u);
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

  it("retains REPLACE and IGNORE protection for every history-chunk rowid alias", async () => {
    await env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'live', 1, 1, NULL, 'indexed', ?, NULL, ?)`)
      .bind(COVERAGE_ID, PRINCIPAL_ID, CONTENT_HASH, NOW).run();
    await env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash,
      created_at, updated_at
    ) VALUES (?, ?, 1, 1, 'needle', ?, 'live', NULL, ?, ?, ?)`)
      .bind(CHUNK_ID, PRINCIPAL_ID, CONTENT_HASH, CONTENT_HASH, NOW, NOW).run();

    for (const strategy of ["REPLACE", "IGNORE"] as const) {
      await expect(env.DB.prepare(`INSERT OR ${strategy} INTO memory_history_chunks
        SELECT * FROM memory_history_chunks WHERE chunk_id = ?`).bind(CHUNK_ID).run())
        .rejects.toThrow(/memory_history_chunk_receipt_invalid/u);
    }
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_history_chunks
      WHERE chunk_id = ?`).bind(CHUNK_ID).first("count")).toBe(1);
  });

  it("memory_history_chunks_insert_guard rejects a suppressed archived-only event", async () => {
    const archivedEventId = "01k5fsvag0000000000000000d";
    const archived = await seedArchivedCatalogEvent(PRINCIPAL_ID, archivedEventId, "4");
    await env.DB.prepare("DELETE FROM events WHERE event_id = ?").bind(archivedEventId).run();
    const archivedCoverageId = "01k5fsvag0000000000000000e";
    await env.DB.prepare(`INSERT INTO memory_history_coverage (
      coverage_id, principal_id, source_location, start_event_sequence,
      end_event_sequence, r2_segment_id, indexing_outcome, content_hash,
      failure_code, indexed_at
    ) VALUES (?, ?, 'archived', ?, ?, ?, 'indexed', ?, NULL, ?)`)
      .bind(
        archivedCoverageId,
        PRINCIPAL_ID,
        archived.sequence,
        archived.sequence,
        archived.segmentId,
        archived.envelopeHash,
        NOW,
      ).run();
    const suppressionId = "01k5fsvag0000000000000000f";
    const suppressionCommandId = "01k5fsvag0000000000000000j";
    const commandEnvelope = JSON.stringify({
      schemaVersion: "1.0",
      eventId: suppressionCommandId,
      eventType: "memory.owner_command",
      source: "memory-control",
      subjectId: PRINCIPAL_ID,
      occurredAt: LATER,
      receivedAt: LATER,
      correlationId: suppressionCommandId,
      contentType: "application/json",
      contentHash: QUERY_HASH,
      payload: {
        operation: "history.suppress",
        targetId: suppressionId,
        targetEventId: archivedEventId,
        startEventSequence: null,
        endEventSequence: null,
        newlyHiddenTurnCount: 1,
        totalCoveredTurnCount: 1,
      },
      redaction: { status: "none", markers: [] },
      producerVersion: "memory-control-v1",
    });
    await env.DB.prepare(`INSERT INTO events (
      event_id, event_type, source, subject_id, occurred_at, received_at,
      content_hash, envelope_json, created_at
    ) VALUES (?, 'memory.owner_command', 'memory-control', ?, ?, ?, ?, ?, ?)`)
      .bind(
        suppressionCommandId,
        PRINCIPAL_ID,
        LATER,
        LATER,
        QUERY_HASH,
        commandEnvelope,
        LATER,
      ).run();
    await env.DB.prepare(`INSERT INTO memory_event_suppressions (
      suppression_id, principal_id, target_event_id, start_event_sequence,
      end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
      source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'archived suppression', 1, 1, ?)`)
      .bind(
        suppressionId,
        PRINCIPAL_ID,
        archivedEventId,
        suppressionCommandId,
        NOW,
      ).run();

    await expect(env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'needle', ?, 'archived', ?, ?, ?, ?)`)
      .bind(
        "01k5fsvag0000000000000000g",
        PRINCIPAL_ID,
        archived.sequence,
        archived.sequence,
        CONTENT_HASH,
        archived.segmentId,
        archived.envelopeHash,
        NOW,
        NOW,
      ).run()).rejects.toThrow(/memory_history_chunk_receipt_invalid/u);
  });

  it("memory_literal_search_hits_insert_guard rejects an archived cross-principal receipt", async () => {
    await env.DB.prepare("UPDATE principals SET status = 'active' WHERE principal_id = ?")
      .bind(OTHER_PRINCIPAL_ID).run();
    const archivedEventId = "01k5fsvag0000000000000000h";
    const archived = await seedArchivedCatalogEvent(OTHER_PRINCIPAL_ID, archivedEventId, "5");
    await insertJob(ARCHIVE_JOB_ID, "cross-principal-archive", archived.sequence).run();
    await env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'running', updated_at = ? WHERE principal_id = ? AND job_id = ?`)
      .bind(LATER, PRINCIPAL_ID, ARCHIVE_JOB_ID).run();

    await expect(env.DB.prepare(`INSERT INTO memory_literal_search_hits (
      principal_id, job_id, event_sequence, event_id, content_hash, found_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        PRINCIPAL_ID,
        ARCHIVE_JOB_ID,
        archived.sequence,
        archivedEventId,
        CONTENT_HASH,
        LATER,
      ).run()).rejects.toThrow(/memory_literal_search_hit_receipt_invalid/u);
  });

  it("rejects REPLACE and IGNORE across every job and hit unique key", async () => {
    await insertJob(OTHER_JOB_ID, "secondary").run();
    const before = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM memory_literal_search_jobs WHERE principal_id = ?1) AS jobs,
      (SELECT count(*) FROM memory_literal_search_hits WHERE principal_id = ?1) AS hits`)
      .bind(PRINCIPAL_ID).first<{ jobs: number; hits: number }>();
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
    const after = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM memory_literal_search_jobs WHERE principal_id = ?1) AS jobs,
      (SELECT count(*) FROM memory_literal_search_hits WHERE principal_id = ?1) AS hits`)
      .bind(PRINCIPAL_ID).first<{ jobs: number; hits: number }>();
    expect(after).toEqual(before);
  });
});

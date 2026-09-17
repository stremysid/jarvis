import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import memoryBackupSql from "../../src/persistence/migrations/0031_memory_backup.sql?raw";
import { clearMemoryBackupDataForTest } from "./migration.js";

const runId = "01k5nm00000000000000000001";
const timestamp = "2026-09-16T23:30:00.000Z";
const later = "2026-09-16T23:31:00.000Z";
const marks = JSON.stringify({
  eventsAfter: 0,
});

const triggerNames = [
  "memory_backup_runs_insert_guard",
  "memory_backup_runs_update_guard",
  "memory_backup_runs_delete_guard",
  "memory_backup_row_ordinals_insert_guard",
  "memory_backup_row_ordinals_update_guard",
  "memory_backup_row_ordinals_delete_guard",
  "memory_backup_table_cuts_insert_guard",
  "memory_backup_table_cuts_update_guard",
  "memory_backup_table_cuts_delete_guard",
  "memory_backup_objects_insert_guard",
  "memory_backup_objects_update_guard",
  "memory_backup_objects_delete_guard",
  "memory_backup_alerts_insert_guard",
  "memory_backup_alerts_update_guard",
  "memory_backup_alerts_delete_guard",
] as const;

async function insertRun(): Promise<void> {
  await env.DB.prepare(`INSERT INTO memory_backup_runs (
    run_date, run_id, status, schema_version, marks_json, current_table_index,
    cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
    manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
    verified_at, abandoned_at, pruned_at
  ) VALUES ('2026-09-16', ?, 'running', '0031_memory_backup.sql', ?, 0,
    NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`)
    .bind(runId, marks, timestamp, timestamp).run();
}

async function insertObject(): Promise<void> {
  await env.DB.prepare(`INSERT INTO memory_backup_table_cuts (
    run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
  ) VALUES (?, 0, 'events', 'sequence', 0, 1, 1)`).bind(runId).run();
  await env.DB.prepare(`UPDATE memory_backup_runs
    SET lease_id = '01k5nm00000000000000000002', lease_expires_at = '2026-09-16T23:32:00.000Z',
      updated_at = ? WHERE run_id = ?`).bind(timestamp, runId).run();
  await env.DB.prepare(`INSERT INTO memory_backup_objects (
    run_id, object_number, table_name, object_key, schema_version,
    row_count, byte_count, first_key, last_key, sha256, verified_at
  ) VALUES (?, 0, 'events', 'memory-backup/test.ndjson', '0031_memory_backup.sql',
    1, 2, 1, 1, ?, ?)`)
    .bind(runId, "a".repeat(64), timestamp).run();
  await env.DB.prepare(`UPDATE memory_backup_runs
    SET cursor_key = 1, next_object_number = 1, lease_id = NULL, lease_expires_at = NULL,
      updated_at = ? WHERE run_id = ?`).bind(later, runId).run();
}

async function proveWholeTriggerIsRequired(
  triggerName: typeof triggerNames[number],
  mutation: () => Promise<unknown>,
  expectedFailure: string,
): Promise<void> {
  await expect(mutation()).rejects.toThrow(expectedFailure);
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
  ).bind(triggerName).first<{ sql: string }>();
  if (trigger === null) throw new Error(`missing trigger ${triggerName}`);
  await env.DB.prepare(`DROP TRIGGER ${triggerName}`).run();
  try {
    await expect(mutation()).resolves.toBeDefined();
  } finally {
    await env.DB.prepare(trigger.sql).run();
  }
}

describe("memory backup migration", () => {
  beforeEach(() => clearMemoryBackupDataForTest());

  it("installs only remote-D1-compatible whole triggers", () => {
    const declared = Array.from(memoryBackupSql.matchAll(
      /^CREATE TRIGGER ([a-z0-9_]+)$/gmu,
    ), (match) => match[1]);
    expect(declared).toEqual(triggerNames);
    for (const name of triggerNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = memoryBackupSql.match(new RegExp(
        `CREATE TRIGGER ${escaped}\\b[\\s\\S]*?\\nEND;`, "u",
      ));
      expect(match?.[0], `${name} must use SELECT RAISE with WHERE`)
        .toMatch(/SELECT\s+RAISE\s*\([^;]+\)\s+WHERE/iu);
      expect(match?.[0]).not.toMatch(/SELECT\s+CASE[^;]+RAISE/iu);
    }
  });

  it("needs the whole run insert trigger to reject a non-running initial state", async () => {
    const mutation = () => env.DB.prepare(`INSERT INTO memory_backup_runs (
      run_date, run_id, status, schema_version, marks_json, current_table_index,
      cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
      manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
      verified_at, abandoned_at, pruned_at
    ) VALUES ('2026-09-16', ?, 'failed', '0031_memory_backup.sql', ?, 0,
      NULL, 0, 0, NULL, NULL, NULL, NULL, 'memory_backup_operation_failed',
      ?, ?, NULL, NULL, NULL)`).bind(runId, marks, timestamp, timestamp).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_runs_insert_guard", mutation, "memory_backup_run_initial_state_invalid",
    );
  });

  it("needs the whole run update trigger to keep the cut marks immutable", async () => {
    await insertRun();
    const changed = JSON.stringify({ eventsAfter: 1 });
    await proveWholeTriggerIsRequired(
      "memory_backup_runs_update_guard",
      () => env.DB.prepare("UPDATE memory_backup_runs SET marks_json = ?, updated_at = ? WHERE run_id = ?")
        .bind(changed, later, runId).run(),
      "memory_backup_run_transition_invalid",
    );
  });

  it("needs the whole run delete trigger to preserve the durable checkpoint", async () => {
    await insertRun();
    await proveWholeTriggerIsRequired(
      "memory_backup_runs_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_backup_runs WHERE run_id = ?").bind(runId).run(),
      "memory_backup_run_delete_forbidden",
    );
  });

  it("needs the whole run update trigger to reject table completion when exported rows exceed the cut", async () => {
    await insertRun();
    await env.DB.prepare(`INSERT INTO memory_backup_table_cuts (
      run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
    ) VALUES (?, 0, 'events', 'sequence', 0, 1, 1)`).bind(runId).run();
    await env.DB.prepare(`UPDATE memory_backup_runs
      SET lease_id = '01k5nm00000000000000000002', lease_expires_at = '2026-09-16T23:32:00.000Z',
        updated_at = ? WHERE run_id = ?`).bind(timestamp, runId).run();
    await env.DB.prepare(`INSERT INTO memory_backup_objects (
      run_id, object_number, table_name, object_key, schema_version,
      row_count, byte_count, first_key, last_key, sha256, verified_at
    ) VALUES (?, 0, 'events', 'memory-backup/short.ndjson', '0031_memory_backup.sql',
      2, 2, 1, 1, ?, ?)`)
      .bind(runId, "a".repeat(64), timestamp).run();
    await env.DB.prepare(`UPDATE memory_backup_runs
      SET cursor_key = 1, next_object_number = 1, lease_id = NULL, lease_expires_at = NULL,
        updated_at = ? WHERE run_id = ?`).bind(later, runId).run();
    await env.DB.prepare(`UPDATE memory_backup_runs
      SET lease_id = '01k5nm00000000000000000003', lease_expires_at = '2026-09-16T23:33:00.000Z',
        updated_at = ? WHERE run_id = ?`).bind(later, runId).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_runs_update_guard",
      () => env.DB.prepare(`UPDATE memory_backup_runs
        SET current_table_index = 1, cursor_key = NULL, lease_id = NULL, lease_expires_at = NULL,
          updated_at = ? WHERE run_id = ?`).bind(later, runId).run(),
      "memory_backup_run_transition_invalid",
    );
  });

  it("needs the whole row-ordinal insert trigger to reject conflict-clause replacement", async () => {
    await env.DB.prepare(`INSERT INTO memory_backup_row_ordinals (table_name, row_key, key_1)
      VALUES ('memory_items', '["first"]', 'first')`).run();
    const mutation = () => env.DB.prepare(`INSERT OR REPLACE INTO memory_backup_row_ordinals
      (table_name, row_key, key_1) VALUES ('memory_items', '["first"]', 'first')`).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_row_ordinals_insert_guard", mutation, "memory_backup_row_ordinal_insert_conflict",
    );
  });

  it("needs the whole row-ordinal update trigger to keep insertion cuts stable", async () => {
    await env.DB.prepare(`INSERT INTO memory_backup_row_ordinals (table_name, row_key, key_1)
      VALUES ('memory_items', '["first"]', 'first')`).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_row_ordinals_update_guard",
      () => env.DB.prepare(`UPDATE memory_backup_row_ordinals
        SET row_key = '["second"]', key_1 = 'second'
        WHERE table_name = 'memory_items'`).run(),
      "memory_backup_row_ordinal_update_forbidden",
    );
  });

  it("needs the whole row-ordinal delete trigger to preserve insertion cuts", async () => {
    await env.DB.prepare(`INSERT INTO memory_backup_row_ordinals (table_name, row_key, key_1)
      VALUES ('memory_items', '["first"]', 'first')`).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_row_ordinals_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_backup_row_ordinals WHERE table_name = 'memory_items'").run(),
      "memory_backup_row_ordinal_delete_forbidden",
    );
  });

  it("needs the whole table-cut insert trigger to keep one ordered cut per table", async () => {
    await insertRun();
    await env.DB.prepare(`INSERT INTO memory_backup_table_cuts (
      run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
    ) VALUES (?, 0, 'events', 'sequence', 0, 1, 1)`).bind(runId).run();
    const mutation = () => env.DB.prepare(`INSERT OR REPLACE INTO memory_backup_table_cuts (
      run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
    ) VALUES (?, 0, 'events', 'sequence', 0, 2, 2)`).bind(runId).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_table_cuts_insert_guard", mutation, "memory_backup_table_cut_insert_invalid",
    );
  });

  it("needs the whole table-cut update trigger to keep expected row counts immutable", async () => {
    await insertRun();
    await env.DB.prepare(`INSERT INTO memory_backup_table_cuts (
      run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
    ) VALUES (?, 0, 'events', 'sequence', 0, 1, 1)`).bind(runId).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_table_cuts_update_guard",
      () => env.DB.prepare("UPDATE memory_backup_table_cuts SET expected_row_count = 2 WHERE run_id = ?")
        .bind(runId).run(),
      "memory_backup_table_cut_update_forbidden",
    );
  });

  it("needs the whole table-cut delete trigger to preserve the restore manifest cut", async () => {
    await insertRun();
    await env.DB.prepare(`INSERT INTO memory_backup_table_cuts (
      run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
    ) VALUES (?, 0, 'events', 'sequence', 0, 1, 1)`).bind(runId).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_table_cuts_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_backup_table_cuts WHERE run_id = ?").bind(runId).run(),
      "memory_backup_table_cut_delete_forbidden",
    );
  });

  it("needs the whole object insert trigger to require a leased matching run step", async () => {
    await insertRun();
    const mutation = () => env.DB.prepare(`INSERT INTO memory_backup_objects (
      run_id, object_number, table_name, object_key, schema_version,
      row_count, byte_count, first_key, last_key, sha256, verified_at
    ) VALUES (?, 0, 'events', 'memory-backup/unleased.ndjson', '0031_memory_backup.sql',
      1, 2, 1, 1, ?, ?)`)
      .bind(runId, "b".repeat(64), timestamp).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_objects_insert_guard", mutation, "memory_backup_object_insert_invalid",
    );
  });

  it("needs the whole object insert trigger to reject the removed no-cut eventsThrough branch", async () => {
    const legacyMarks = JSON.stringify({ eventsAfter: 0, eventsThrough: 1000 });
    await env.DB.prepare(`INSERT INTO memory_backup_runs (
      run_date, run_id, status, schema_version, marks_json, current_table_index,
      cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
      manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
      verified_at, abandoned_at, pruned_at
    ) VALUES ('2026-09-16', ?, 'running', '0031_memory_backup.sql', ?, 0,
      NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`)
      .bind(runId, legacyMarks, timestamp, timestamp).run();
    await env.DB.prepare(`UPDATE memory_backup_runs
      SET lease_id = '01k5nm00000000000000000002', lease_expires_at = '2026-09-16T23:32:00.000Z',
        updated_at = ? WHERE run_id = ?`).bind(timestamp, runId).run();
    const mutation = () => env.DB.prepare(`INSERT INTO memory_backup_objects (
      run_id, object_number, table_name, object_key, schema_version,
      row_count, byte_count, first_key, last_key, sha256, verified_at
    ) VALUES (?, 0, 'events', 'memory-backup/no-cut.ndjson', '0031_memory_backup.sql',
      1, 2, 1, 1, ?, ?)`).bind(runId, "b".repeat(64), timestamp).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_objects_insert_guard", mutation, "memory_backup_object_insert_invalid",
    );
  });

  it("needs the whole object insert trigger to stop replacement of another run's receipt", async () => {
    await insertRun();
    await insertObject();
    const otherRunId = "01k5nm00000000000000000009";
    await env.DB.prepare(`INSERT INTO memory_backup_runs (
      run_date, run_id, status, schema_version, marks_json, current_table_index,
      cursor_key, next_object_number, verified_object_count, lease_id, lease_expires_at,
      manifest_object_key, manifest_sha256, failure_code, started_at, updated_at,
      verified_at, abandoned_at, pruned_at
    ) VALUES ('2026-09-17', ?, 'running', '0031_memory_backup.sql', ?, 0,
      NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`)
      .bind(otherRunId, marks, timestamp, timestamp).run();
    await env.DB.prepare(`INSERT INTO memory_backup_table_cuts (
      run_id, table_index, table_name, key_kind, after_key, through_key, expected_row_count
    ) VALUES (?, 0, 'events', 'sequence', 0, 1, 1)`).bind(otherRunId).run();
    await env.DB.prepare(`UPDATE memory_backup_runs
      SET lease_id = '01k5nm0000000000000000000a', lease_expires_at = '2026-09-16T23:32:00.000Z',
        updated_at = ? WHERE run_id = ?`).bind(timestamp, otherRunId).run();
    const mutation = () => env.DB.prepare(`INSERT OR REPLACE INTO memory_backup_objects (
      run_id, object_number, table_name, object_key, schema_version,
      row_count, byte_count, first_key, last_key, sha256, verified_at
    ) VALUES (?, 0, 'events', 'memory-backup/test.ndjson', '0031_memory_backup.sql',
      1, 2, 1, 1, ?, ?)`)
      .bind(otherRunId, "d".repeat(64), timestamp).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_objects_insert_guard", mutation, "memory_backup_object_insert_invalid",
    );
  });

  it("needs the whole object update trigger to keep verified metadata immutable", async () => {
    await insertRun();
    await insertObject();
    await proveWholeTriggerIsRequired(
      "memory_backup_objects_update_guard",
      () => env.DB.prepare("UPDATE memory_backup_objects SET sha256 = ? WHERE run_id = ?")
        .bind("c".repeat(64), runId).run(),
      "memory_backup_object_update_forbidden",
    );
  });

  it("needs the whole object delete trigger to retain manifest evidence", async () => {
    await insertRun();
    await insertObject();
    await proveWholeTriggerIsRequired(
      "memory_backup_objects_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_backup_objects WHERE run_id = ?").bind(runId).run(),
      "memory_backup_object_delete_forbidden",
    );
  });

  it("needs the whole alert insert trigger to reject conflict-clause replacement", async () => {
    await env.DB.prepare(`INSERT INTO memory_backup_alerts
      (local_date, run_id, failure_code, claimed_at)
      VALUES ('2026-09-16', NULL, 'memory_backup_binding_missing', ?)`)
      .bind(timestamp).run();
    const mutation = () => env.DB.prepare(`INSERT OR REPLACE INTO memory_backup_alerts
      (local_date, run_id, failure_code, claimed_at)
      VALUES ('2026-09-16', NULL, 'memory_backup_operation_failed', ?)`)
      .bind(later).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_alerts_insert_guard", mutation, "memory_backup_alert_insert_conflict",
    );
  });

  it("needs the whole alert update trigger to keep the daily claim immutable", async () => {
    await env.DB.prepare(`INSERT INTO memory_backup_alerts
      (local_date, run_id, failure_code, claimed_at)
      VALUES ('2026-09-16', NULL, 'memory_backup_binding_missing', ?)`)
      .bind(timestamp).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_alerts_update_guard",
      () => env.DB.prepare(`UPDATE memory_backup_alerts
        SET failure_code = 'memory_backup_operation_failed' WHERE local_date = '2026-09-16'`).run(),
      "memory_backup_alert_update_forbidden",
    );
  });

  it("needs the whole alert delete trigger to preserve once-per-day deduplication", async () => {
    await env.DB.prepare(`INSERT INTO memory_backup_alerts
      (local_date, run_id, failure_code, claimed_at)
      VALUES ('2026-09-16', NULL, 'memory_backup_binding_missing', ?)`)
      .bind(timestamp).run();
    await proveWholeTriggerIsRequired(
      "memory_backup_alerts_delete_guard",
      () => env.DB.prepare("DELETE FROM memory_backup_alerts WHERE local_date = '2026-09-16'").run(),
      "memory_backup_alert_delete_forbidden",
    );
  });
});

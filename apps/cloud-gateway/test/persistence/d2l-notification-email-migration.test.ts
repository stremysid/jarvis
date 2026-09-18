import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { applyD2lNotificationEmailMigration } from "./migration.js";

const NOW = "2026-09-17T23:45:00.000Z";
const PRINCIPAL = "principal:d2l-email-migration";

async function addMessage(kind: "assignment_due" | "grade_released", suffix: string): Promise<string> {
  const emailId = newUlid();
  const rawHash = await sha256Hex(suffix);
  await env.DB.prepare(`INSERT INTO d2l_email_messages (
    principal_id, email_id, ingestion_key, raw_sha256, provider_message_id,
    header_names_json, authentication_json, envelope_from_domain, from_domain,
    event_kind, status, quarantine_reason, structured_json, raw_mime_base64,
    received_at, processed_at, verification_notified_at
  ) VALUES (?, ?, ?, ?, ?, '[]', '{}', 'tenant.example', 'notifications.example',
    ?, 'pending', NULL, '{}', '', ?, NULL, NULL)`)
    .bind(PRINCIPAL, emailId, `message-id:${suffix}`, rawHash, `<${suffix}@example.test>`, kind, NOW)
    .run();
  return emailId;
}

async function addGrade(emailId: string, suffix: string): Promise<string> {
  const observationId = newUlid();
  const contentHash = await sha256Hex(suffix);
  await env.DB.prepare(`INSERT INTO d2l_email_grade_observations (
    principal_id, observation_id, email_id, deadline_id, external_id, course, title,
    assigned_grade, max_points, content_hash, observed_at
  ) VALUES (?, ?, ?, NULL, ?, 'Calculus', 'Limits quiz', 18, 20, ?, ?)`)
    .bind(PRINCIPAL, observationId, emailId, `d2l:${suffix}`, contentHash, NOW)
    .run();
  return observationId;
}

async function proveWholeTrigger(
  triggerName: string,
  mutation: () => Promise<unknown>,
  expectedFailure: string,
): Promise<void> {
  const trigger = await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
    .bind(triggerName).first<{ sql: string }>();
  if (trigger === null) throw new Error(`missing trigger ${triggerName}`);
  await expect(mutation()).rejects.toThrow(expectedFailure);
  await env.DB.prepare(`DROP TRIGGER ${triggerName}`).run();
  try {
    await expect(mutation()).resolves.toBeDefined();
  } finally {
    await env.DB.prepare(trigger.sql).run();
  }
}

beforeAll(async () => {
  await applyD2lNotificationEmailMigration();
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'D2L migration owner', ?, ?)`)
    .bind(PRINCIPAL, NOW, NOW).run();
});

describe("D2L notification email migration 0033", () => {
  it("installs every trigger in remote-D1-compatible whole-trigger form", async () => {
    const result = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'd2l_email_%' ORDER BY name`)
      .all<{ name: string; sql: string }>();
    expect(result.results.map(({ name }) => name)).toEqual([
      "d2l_email_grade_observations_delete_guard",
      "d2l_email_grade_observations_insert_guard",
      "d2l_email_grade_observations_update_guard",
      "d2l_email_messages_delete_guard",
      "d2l_email_messages_insert_guard",
      "d2l_email_messages_update_guard",
    ]);
    for (const row of result.results) {
      expect(row.sql, row.name).toMatch(/\bWHEN\b[\s\S]*\bBEGIN\s+SELECT RAISE\(ABORT,/iu);
      expect(row.sql, row.name).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
    }
  });

  it("needs the whole message insert trigger to defeat replacement of a receipt", async () => {
    const emailId = await addMessage("assignment_due", "insert-guard");
    await proveWholeTrigger(
      "d2l_email_messages_insert_guard",
      () => env.DB.prepare(`INSERT OR REPLACE INTO d2l_email_messages
        SELECT * FROM d2l_email_messages WHERE principal_id = ? AND email_id = ?`)
        .bind(PRINCIPAL, emailId).run(),
      "d2l_email_message_insert_conflict",
    );
  });

  it("needs the whole message update trigger to keep retained evidence immutable", async () => {
    const emailId = await addMessage("assignment_due", "update-guard");
    await proveWholeTrigger(
      "d2l_email_messages_update_guard",
      () => env.DB.prepare(`UPDATE d2l_email_messages SET raw_sha256 = ?
        WHERE principal_id = ? AND email_id = ?`).bind("f".repeat(64), PRINCIPAL, emailId).run(),
      "d2l_email_message_update_invalid",
    );
  });

  it("needs the whole message delete trigger to retain quarantine and receipt evidence", async () => {
    const emailId = await addMessage("assignment_due", "delete-guard");
    await proveWholeTrigger(
      "d2l_email_messages_delete_guard",
      () => env.DB.prepare("DELETE FROM d2l_email_messages WHERE principal_id = ? AND email_id = ?")
        .bind(PRINCIPAL, emailId).run(),
      "d2l_email_message_delete_forbidden",
    );
  });

  it("needs the whole grade insert trigger to bind grades to a pending grade email", async () => {
    const emailId = await addMessage("assignment_due", "grade-insert-guard");
    const observationId = newUlid();
    await proveWholeTrigger(
      "d2l_email_grade_observations_insert_guard",
      () => env.DB.prepare(`INSERT INTO d2l_email_grade_observations (
        principal_id, observation_id, email_id, deadline_id, external_id, course, title,
        assigned_grade, max_points, content_hash, observed_at
      ) VALUES (?, ?, ?, NULL, 'd2l:forged-grade', 'Calculus', 'Forged grade', 20, 20, ?, ?)`)
        .bind(PRINCIPAL, observationId, emailId, "c".repeat(64), NOW).run(),
      "d2l_email_grade_observation_insert_invalid",
    );
  });

  it("needs the whole grade update trigger to keep grade history append-only", async () => {
    const emailId = await addMessage("grade_released", "grade-update-message");
    const observationId = await addGrade(emailId, "grade-update");
    await proveWholeTrigger(
      "d2l_email_grade_observations_update_guard",
      () => env.DB.prepare(`UPDATE d2l_email_grade_observations SET assigned_grade = 19
        WHERE principal_id = ? AND observation_id = ?`).bind(PRINCIPAL, observationId).run(),
      "d2l_email_grade_observation_update_forbidden",
    );
  });

  it("refuses INSERT OR REPLACE from replacing a grade receipt", async () => {
    const emailId = await addMessage("grade_released", "grade-replace-message");
    const observationId = await addGrade(emailId, "grade-replace");
    await expect(env.DB.prepare(`INSERT OR REPLACE INTO d2l_email_grade_observations
      SELECT * FROM d2l_email_grade_observations
      WHERE principal_id = ? AND observation_id = ?`).bind(PRINCIPAL, observationId).run())
      .rejects.toThrow("d2l_email_grade_observation_insert_invalid");
  });

  it("needs the whole grade delete trigger to preserve released-grade evidence", async () => {
    const emailId = await addMessage("grade_released", "grade-delete-message");
    const observationId = await addGrade(emailId, "grade-delete");
    await proveWholeTrigger(
      "d2l_email_grade_observations_delete_guard",
      () => env.DB.prepare(`DELETE FROM d2l_email_grade_observations
        WHERE principal_id = ? AND observation_id = ?`).bind(PRINCIPAL, observationId).run(),
      "d2l_email_grade_observation_delete_forbidden",
    );
  });
});

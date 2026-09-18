import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { applyD2lNotificationEmailMigration } from "./migration.js";

/**
 * Migration 0036 is the one that lets every message be read.
 *
 * Two things about it are load-bearing and neither is visible from the
 * application code alone: a receipt written before the migration must not be
 * promoted to proven by the default, and the update guard has to permit
 * exactly one new transition -- clearing a raw body -- without permitting any
 * other rewrite of a receipt that is already evidence.
 */

const NOW = "2026-09-17T23:45:00.000Z";
const PRINCIPAL = "principal:read-everything-migration";

async function addMessage(suffix: string, authenticity?: "verified" | "unverified"): Promise<string> {
  const emailId = newUlid();
  const rawHash = await sha256Hex(suffix);
  const statement = authenticity === undefined
    ? env.DB.prepare(`INSERT INTO d2l_email_messages (
        principal_id, email_id, ingestion_key, raw_sha256, provider_message_id,
        header_names_json, authentication_json, envelope_from_domain, from_domain,
        event_kind, status, quarantine_reason, structured_json, raw_mime_base64,
        received_at, processed_at, verification_notified_at
      ) VALUES (?, ?, ?, ?, ?, '[]', '{}', 'tenant.example', 'notifications.example',
        'unrecognised', 'pending', NULL, '{}', 'cGFkZGluZw==', ?, NULL, NULL)`)
      .bind(PRINCIPAL, emailId, `message-id:${suffix}`, rawHash, `<${suffix}@example.test>`, NOW)
    : env.DB.prepare(`INSERT INTO d2l_email_messages (
        principal_id, email_id, ingestion_key, raw_sha256, provider_message_id,
        header_names_json, authentication_json, envelope_from_domain, from_domain,
        authenticity, event_kind, status, quarantine_reason, structured_json, raw_mime_base64,
        received_at, processed_at, verification_notified_at
      ) VALUES (?, ?, ?, ?, ?, '[]', '{}', 'tenant.example', 'notifications.example',
        ?, 'unrecognised', 'pending', NULL, '{}', 'cGFkZGluZw==', ?, NULL, NULL)`)
      .bind(PRINCIPAL, emailId, `message-id:${suffix}`, rawHash, `<${suffix}@example.test>`, authenticity, NOW);
  await statement.run();
  return emailId;
}

async function authenticityOf(emailId: string): Promise<string | undefined> {
  const row = await env.DB.prepare(
    "SELECT authenticity FROM d2l_email_messages WHERE principal_id = ? AND email_id = ?",
  ).bind(PRINCIPAL, emailId).first<{ authenticity: string }>();
  return row?.authenticity;
}

beforeAll(async () => {
  await applyD2lNotificationEmailMigration();
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'Read-everything migration owner', ?, ?)`)
    .bind(PRINCIPAL, NOW, NOW).run();
});

describe("email read-everything migration 0036", () => {
  it("records a receipt written without a stated provenance as unverified, never as proven", async () => {
    const emailId = await addMessage("default-authenticity");
    expect(await authenticityOf(emailId)).toBe("unverified");
  });

  it("refuses an authenticity value outside the two the application understands", async () => {
    const emailId = newUlid();
    await expect(env.DB.prepare(`INSERT INTO d2l_email_messages (
      principal_id, email_id, ingestion_key, raw_sha256, provider_message_id,
      header_names_json, authentication_json, envelope_from_domain, from_domain,
      authenticity, event_kind, status, quarantine_reason, structured_json, raw_mime_base64,
      received_at, processed_at, verification_notified_at
    ) VALUES (?, ?, ?, ?, ?, '[]', '{}', NULL, NULL,
      'probably', 'unrecognised', 'pending', NULL, '{}', '', ?, NULL, NULL)`)
      .bind(PRINCIPAL, emailId, "message-id:bad-authenticity", await sha256Hex("bad"), "<bad@example.test>", NOW)
      .run()).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("allows a retained raw body to be cleared and refuses every other rewrite of the receipt", async () => {
    const cleared = await addMessage("clear-body");
    await expect(env.DB.prepare(
      "UPDATE d2l_email_messages SET raw_mime_base64 = '' WHERE principal_id = ? AND email_id = ?",
    ).bind(PRINCIPAL, cleared).run()).resolves.toBeDefined();
    const rewritten = await addMessage("clear-body-with-rewrite");
    await expect(env.DB.prepare(`UPDATE d2l_email_messages
      SET raw_mime_base64 = '', raw_sha256 = ? WHERE principal_id = ? AND email_id = ?`)
      .bind("f".repeat(64), PRINCIPAL, rewritten).run())
      .rejects.toThrow("d2l_email_message_update_invalid");
  });

  it("refuses refilling a cleared body under the same hash", async () => {
    const emailId = await addMessage("refill-body");
    await env.DB.prepare("UPDATE d2l_email_messages SET raw_mime_base64 = '' WHERE principal_id = ? AND email_id = ?")
      .bind(PRINCIPAL, emailId).run();
    await expect(env.DB.prepare(`UPDATE d2l_email_messages
      SET raw_mime_base64 = 'ZGlmZmVyZW50' WHERE principal_id = ? AND email_id = ?`)
      .bind(PRINCIPAL, emailId).run())
      .rejects.toThrow("d2l_email_message_update_invalid");
  });

  it("refuses moving a receipt between statuses as a side effect of clearing its body", async () => {
    // Both the status transition and the body clear are individually legal.
    // Together they are not: a state change must not ride along on a prune.
    const emailId = await addMessage("clear-body-status");
    await expect(env.DB.prepare(`UPDATE d2l_email_messages
      SET status = 'ingested', processed_at = ?, raw_mime_base64 = ''
      WHERE principal_id = ? AND email_id = ?`)
      .bind(NOW, PRINCIPAL, emailId).run())
      .rejects.toThrow("d2l_email_message_update_invalid");
  });

  it("still allows a pending receipt to complete with its body intact", async () => {
    const emailId = await addMessage("normal-completion");
    await expect(env.DB.prepare(`UPDATE d2l_email_messages
      SET status = 'quarantined', quarantine_reason = 'authentication_unproven', processed_at = ?
      WHERE principal_id = ? AND email_id = ?`)
      .bind(NOW, PRINCIPAL, emailId).run()).resolves.toBeDefined();
  });

  it("lets the digest find a receipt by the external id the message named", async () => {
    const emailId = newUlid();
    await env.DB.prepare(`INSERT INTO d2l_email_messages (
      principal_id, email_id, ingestion_key, raw_sha256, provider_message_id,
      header_names_json, authentication_json, envelope_from_domain, from_domain,
      authenticity, event_kind, status, quarantine_reason, structured_json, raw_mime_base64,
      received_at, processed_at, verification_notified_at
    ) VALUES (?, ?, ?, ?, ?, '[]', '{}', NULL, NULL,
      'verified', 'assignment_due', 'ingested', NULL, ?, '', ?, ?, NULL)`)
      .bind(
        PRINCIPAL, emailId, "message-id:external-id-lookup", await sha256Hex("external-id-lookup"),
        "<external@example.test>", JSON.stringify({ kind: "assignment_due", externalId: "d2l:lookup-me" }),
        NOW, NOW,
      ).run();
    const row = await env.DB.prepare(`SELECT json_extract(structured_json, '$.externalId') AS external_id,
        authenticity FROM d2l_email_messages
      WHERE principal_id = ? AND json_extract(structured_json, '$.externalId') = ?`)
      .bind(PRINCIPAL, "d2l:lookup-me")
      .first<{ external_id: string; authenticity: string }>();
    expect(row).toEqual({ external_id: "d2l:lookup-me", authenticity: "verified" });
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT authenticity FROM d2l_email_messages
      INDEXED BY d2l_email_messages_source_external_idx
      WHERE principal_id = ? AND json_extract(structured_json, '$.externalId') = ?`)
      .bind(PRINCIPAL, "d2l:lookup-me").all<{ detail: string }>();
    // Forced by name rather than left to the planner: on a table this small
    // the planner prefers the primary key, so an unusable index would go
    // unnoticed until the table grew -- which is exactly when the digest's
    // read would start scanning every message the owner has ever received.
    expect(plan.results.map((entry) => entry.detail).join("\n"))
      .toContain("d2l_email_messages_source_external_idx");
  });

  it("installs the provenance index the digest lookup depends on", async () => {
    const row = await env.DB.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'index' AND name = 'd2l_email_messages_source_external_idx'`)
      .first<{ name: string }>();
    expect(row?.name).toBe("d2l_email_messages_source_external_idx");
  });

  it("keeps the replaced update guard in whole-trigger remote-D1 form", async () => {
    const row = await env.DB.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'd2l_email_messages_update_guard'`)
      .first<{ sql: string }>();
    expect(row?.sql).toMatch(/\bWHEN\b[\s\S]*\bBEGIN\s+SELECT RAISE\(ABORT,/iu);
    expect(row?.sql).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
  });
});

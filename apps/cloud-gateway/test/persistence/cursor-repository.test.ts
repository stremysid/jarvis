import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, createEnvelope, newUlid, sha256Hex, type PersistableEventEnvelopeV1, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { Redactor } from "../../src/security/redaction.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { CursorRepository } from "../../src/persistence/cursor-repository.js";
import { applyFoundationMigration } from "./migration.js";

const timestamp = "2026-08-29T12:00:00.000Z";

async function fixture(label: string): Promise<PersistableEventEnvelopeV1> {
  const token = new Redactor().redact({ text: `api key = ${label}-secret`, channel: "telegram", field: "message.text" });
  if (!token.ok) throw new Error("fixture redaction failed");
  return createEnvelope({
    schemaVersion: "1.0", eventId: newUlid(), eventType: "telegram.update", source: "telegram", subjectId: "principal:test",
    occurredAt: timestamp, receivedAt: timestamp, correlationId: newUlid(), contentType: "application/json", payload: { message: token }, producerVersion: "test",
  });
}

async function hash(label: string): Promise<Sha256Hex> { return sha256Hex(canonicalJson({ label })); }

describe("CursorRepository", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_snapshots"), env.DB.prepare("DELETE FROM consumer_cursors"), env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
    ]);
  });
  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_snapshots"), env.DB.prepare("DELETE FROM consumer_cursors"), env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
    ]);
  });

  async function append(count: number): Promise<void> {
    const events = new EventRepository(env.DB);
    for (let index = 1; index <= count; index += 1) {
      const label = `event-${index}`;
      await events.append({ envelope: await fixture(label), scope: "telegram:update", key: label, requestHash: await hash(label) });
    }
  }

  it("atomically advances a cursor through a durably acknowledged contiguous page", async () => {
    await append(3);
    const cursors = new CursorRepository(env.DB);

    await cursors.advanceContiguous("device:d1", 0, 3);

    expect(await cursors.read("device:d1")).toBe(3);
    await expect(cursors.advanceContiguous("device:d1", 0, 3)).rejects.toThrow("cursor_compare_failed");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_snapshots WHERE consumer_name = 'device:d1'").first<{ count: number }>())?.count).toBe(1);
  });

  it("refuses a cursor range containing a missing event", async () => {
    await append(3);
    await env.DB.prepare("DELETE FROM outbox WHERE event_sequence = 2").run();
    await env.DB.prepare("DELETE FROM idempotency_records WHERE event_sequence = 2").run();
    await env.DB.prepare("DELETE FROM events WHERE sequence = 2").run();
    const cursors = new CursorRepository(env.DB);

    await expect(cursors.advanceContiguous("device:d1", 0, 3)).rejects.toThrow("cursor_range_incomplete");
    expect(await cursors.read("device:d1")).toBe(0);
  });

  it("refuses reverse and stale cursor boundaries", async () => {
    await append(3);
    const cursors = new CursorRepository(env.DB);
    await expect(cursors.advanceContiguous("device:d1", 2, 1)).rejects.toThrow("cursor_range_invalid");
    await cursors.advanceContiguous("device:d1", 0, 2);
    await expect(cursors.advanceContiguous("device:d1", 0, 3)).rejects.toThrow("cursor_compare_failed");
    expect(await cursors.read("device:d1")).toBe(2);
  });

  it("does not let another consumer's receipt or a replayed receipt advance this cursor", async () => {
    await append(3);
    const cursors = new CursorRepository(env.DB);
    await cursors.advanceContiguous("device:other", 0, 2);

    await cursors.advanceContiguous("device:d1", 0, 2);
    await expect(cursors.advanceContiguous("device:d1", 0, 2)).rejects.toThrow("cursor_compare_failed");
    expect(await cursors.read("device:d1")).toBe(2);
    expect(await cursors.read("device:other")).toBe(2);
  });

  it("keeps durable ACK receipts while expiry cleanup removes issued snapshots", async () => {
    await append(2);
    const cursors = new CursorRepository(env.DB);
    await cursors.advanceContiguous("device:d1", 0, 2);
    await env.DB.prepare(
      "INSERT INTO sync_snapshots (snapshot_id, consumer_name, from_sequence, through_sequence, boundary_start_event_id, boundary_end_event_id, event_count, snapshot_kind, expires_at, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, NULL)",
    ).bind("issued:1", "device:d1", 0, 2, (await env.DB.prepare("SELECT event_id FROM events WHERE sequence = 1").first<{ event_id: string }>())?.event_id, (await env.DB.prepare("SELECT event_id FROM events WHERE sequence = 2").first<{ event_id: string }>())?.event_id, 2, "2000-01-01T00:00:00.000Z").run();

    await env.DB.prepare("DELETE FROM sync_snapshots WHERE snapshot_kind = 'issued' AND expires_at < ?").bind("2026-08-30T00:00:00.000Z").run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM sync_snapshots WHERE snapshot_kind = 'issued'").first<{ count: number }>())?.count).toBe(0);
    const receipt = await env.DB.prepare("SELECT expires_at, acknowledged_at FROM sync_snapshots WHERE snapshot_kind = 'ack_receipt'").first<{ expires_at: string | null; acknowledged_at: string | null }>();
    expect(receipt).toEqual({ expires_at: null, acknowledged_at: expect.any(String) });
  });

  it("enforces consumer names by UTF-8 bytes", async () => {
    await append(1);
    const cursors = new CursorRepository(env.DB);
    await expect(cursors.advanceContiguous("é".repeat(65), 0, 1)).rejects.toThrow("consumerName");
  });
});

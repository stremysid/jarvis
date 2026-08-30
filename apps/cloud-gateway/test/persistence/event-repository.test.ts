import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, createEnvelope, newUlid, sha256Hex, type EventEnvelopeV1, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { Redactor } from "../../src/security/redaction.js";
import { EventRepository, IdempotencyConflict } from "../../src/persistence/event-repository.js";
import { applyFoundationMigration } from "./migration.js";

const timestamp = "2026-08-29T12:00:00.000Z";

async function eventFixture(label: string, eventId = newUlid()): Promise<EventEnvelopeV1> {
  const token = new Redactor().redact({
    text: `Authorization: Bearer ${label}-secret`,
    channel: "telegram",
    field: "message.text",
  });
  if (!token.ok) throw new Error("fixture redaction failed");
  return createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType: "telegram.update",
    source: "telegram",
    subjectId: "principal:test",
    occurredAt: timestamp,
    receivedAt: timestamp,
    correlationId: newUlid(),
    contentType: "application/json",
    payload: { message: token },
    producerVersion: "test",
  });
}

async function requestHash(label: string): Promise<Sha256Hex> {
  return sha256Hex(canonicalJson({ label }));
}

describe("EventRepository", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
    ]);
  });

  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
    ]);
  });

  it("commits event, idempotency record, and outbox row together", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("first");
    const hash = await requestHash("first");

    const first = await repository.append({ envelope, scope: "telegram:update", key: "42", requestHash: hash });
    const replay = await repository.append({ envelope, scope: "telegram:update", key: "42", requestHash: hash });

    expect(first).toMatchObject({ eventSequence: 1, replayed: false });
    expect(replay).toMatchObject({ eventSequence: 1, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(1);
    const stored = await env.DB.prepare("SELECT envelope_json FROM events").first<{ envelope_json: string }>();
    expect(stored?.envelope_json).toContain("[REDACTED_AUTHORIZATION]");
    expect(stored?.envelope_json).not.toContain("first-secret");
  });

  it("rolls back all ledger writes when a later batch constraint fails", async () => {
    const repository = new EventRepository(env.DB);
    const eventId = newUlid();
    await repository.append({ envelope: await eventFixture("first", eventId), scope: "telegram:update", key: "42", requestHash: await requestHash("first") });

    await expect(repository.append({
      envelope: await eventFixture("second", eventId),
      scope: "telegram:update",
      key: "43",
      requestHash: await requestHash("second"),
    })).rejects.toThrow();

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE key = '43'").first<{ count: number }>())?.count).toBe(0);
  });

  it("replays the durable event for the same idempotency scope, key, and request hash", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("replay");
    const hash = await requestHash("replay");

    const original = await repository.append({ envelope, scope: "telegram:update", key: "42", requestHash: hash });
    const replay = await repository.append({ envelope: await eventFixture("replacement"), scope: "telegram:update", key: "42", requestHash: hash });

    expect(replay).toEqual({ ...original, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(1);
  });

  it("rejects a reused idempotency key with a different request hash", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("conflict");
    await repository.append({ envelope, scope: "telegram:update", key: "42", requestHash: await requestHash("one") });

    await expect(repository.append({
      envelope,
      scope: "telegram:update",
      key: "42",
      requestHash: await requestHash("two"),
    })).rejects.toBeInstanceOf(IdempotencyConflict);
  });

  it("converges racing duplicate appends on one durable idempotency record", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("race");
    const hash = await requestHash("race");

    const attempts = await Promise.all(Array.from({ length: 8 }, () => repository.append({
      envelope,
      scope: "telegram:update",
      key: "42",
      requestHash: hash,
    })));

    expect(new Set(attempts.map((attempt) => attempt.eventSequence))).toEqual(new Set([1]));
    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
  });

  it("reads a bounded ordered range and rejects corrupted stored envelopes", async () => {
    const repository = new EventRepository(env.DB);
    for (const label of ["one", "two", "three"]) {
      await repository.append({ envelope: await eventFixture(label), scope: "telegram:update", key: label, requestHash: await requestHash(label) });
    }

    const range = await repository.readRange(0, 2);
    expect(range.map((entry) => entry.eventSequence)).toEqual([1, 2]);
    expect(range).toHaveLength(2);
    await env.DB.prepare("UPDATE events SET envelope_json = '{\"invalid\":true}' WHERE sequence = 2").run();
    await expect(repository.readRange(0, 3)).rejects.toThrow("schemaVersion");
  });
});

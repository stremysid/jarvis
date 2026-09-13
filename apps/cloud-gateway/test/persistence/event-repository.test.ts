import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, createEnvelope, newUlid, sha256Hex, type CreateEnvelopeInput, type EventEnvelopeV1, type PersistableEventEnvelopeV1, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { Redactor } from "../../src/security/redaction.js";
import { EventRepository, IdempotencyConflict, type SyncEventReader } from "../../src/persistence/event-repository.js";
import { applyFoundationMigration } from "./migration.js";

const timestamp = "2026-08-29T12:00:00.000Z";

async function eventFixture(label: string, eventId = newUlid()): Promise<PersistableEventEnvelopeV1> {
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

async function oversizedFixture(): Promise<PersistableEventEnvelopeV1> {
  const token = new Redactor().redact({ text: "x".repeat(262144), channel: "telegram", field: "message.text" });
  if (!token.ok) throw new Error("fixture redaction failed");
  return createEnvelope({
    schemaVersion: "1.0", eventId: newUlid(), eventType: "telegram.update", source: "telegram", subjectId: "principal:test",
    occurredAt: timestamp, receivedAt: timestamp, correlationId: newUlid(), contentType: "application/json", payload: { message: token }, producerVersion: "test",
  });
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

  it("admits three callback dependencies but refuses a fourth before any ledger write", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("three callback steps");
    await expect(repository.appendAtomic({
      envelope, scope: "fixture:callback", key: "three", requestHash: await requestHash("three"),
    }, () => Array.from({ length: 3 }, () => env.DB.prepare("SELECT 1"))))
      .resolves.toMatchObject({ replayed: false });
    await expect(repository.appendAtomic({
      envelope: await eventFixture("four callback steps"), scope: "fixture:callback", key: "four", requestHash: await requestHash("four"),
    }, () => Array.from({ length: 4 }, () => env.DB.prepare("SELECT 1"))))
      .rejects.toThrow("event_append_dependency_limit");
    await expect(env.DB.prepare("SELECT count(*) AS count FROM events").first()).resolves.toEqual({ count: 1 });
  });

  it("refuses a hand-built, self-hashed envelope that was not minted by createEnvelope", async () => {
    const repository = new EventRepository(env.DB);
    const payload = { message: "unredacted ingress" };
    const forged = {
      schemaVersion: "1.0" as const,
      eventId: newUlid(),
      eventType: "telegram.update",
      source: "telegram",
      subjectId: "principal:test",
      occurredAt: timestamp,
      receivedAt: timestamp,
      correlationId: newUlid(),
      contentType: "application/json" as const,
      contentHash: await sha256Hex(canonicalJson(payload)),
      payload,
      redaction: { status: "none" as const, markers: [] },
      producerVersion: "test",
    };

    await expect(repository.append({
      envelope: forged as unknown as PersistableEventEnvelopeV1,
      scope: "telegram:update",
      key: "forged",
      requestHash: await requestHash("forged"),
    })).rejects.toThrow("persistable envelope");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
  });

  it("rejects a producer-supplied sequence before an issued envelope or ledger rows exist", async () => {
    const token = new Redactor().redact({ text: "safe producer text", channel: "telegram", field: "message.text" });
    if (!token.ok) throw new Error("fixture redaction failed");
    const producerInput = {
      schemaVersion: "1.0" as const,
      eventId: newUlid(),
      eventSequence: 7,
      eventType: "telegram.update",
      source: "telegram",
      subjectId: "principal:test",
      occurredAt: timestamp,
      receivedAt: timestamp,
      correlationId: newUlid(),
      contentType: "application/json" as const,
      payload: { message: token },
      producerVersion: "test",
    };

    await expect(createEnvelope(producerInput as unknown as CreateEnvelopeInput)).rejects.toThrow("unsupported producer field: eventSequence");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(0);
  });

  it("rejects a forged sequence-bearing copy of an otherwise issued envelope before persistence", async () => {
    const repository = new EventRepository(env.DB);
    const issued = await eventFixture("poisoned-sequence");
    const forged = { ...issued, eventSequence: 7 } as unknown as PersistableEventEnvelopeV1;

    await expect(repository.append({ envelope: forged, scope: "telegram:update", key: "poisoned-sequence", requestHash: await requestHash("poisoned-sequence") })).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>())?.count).toBe(0);
  });

  it("refuses a copy with an unknown top-level field even when its contents validate", async () => {
    const repository = new EventRepository(env.DB);
    const minted = await eventFixture("unknown-field");
    const copied = { ...minted, unexpected: "field" };

    await expect(repository.append({
      envelope: copied as unknown as PersistableEventEnvelopeV1,
      scope: "telegram:update",
      key: "unknown-field",
      requestHash: await requestHash("unknown-field"),
    })).rejects.toThrow("persistable envelope");
  });

  it("does not persist a post-creation mutation attempt", async () => {
    const repository = new EventRepository(env.DB);
    const minted = await eventFixture("immutable");

    expect(Reflect.set(minted.payload as object, "message", "unredacted ingress")).toBe(false);
    await repository.append({ envelope: minted, scope: "telegram:update", key: "immutable", requestHash: await requestHash("immutable") });
    const stored = await env.DB.prepare("SELECT envelope_json FROM events").first<{ envelope_json: string }>();
    expect(stored?.envelope_json).not.toContain("unredacted ingress");
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

  it("resolves a purged idempotent event through the injected verified tiered reader", async () => {
    const live = new EventRepository(env.DB);
    const envelope = await eventFixture("archived-replay");
    const hash = await requestHash("archived-replay");
    const original = await live.append({ envelope, scope: "telegram:update", key: "archived", requestHash: hash });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox WHERE event_sequence = ?").bind(original.eventSequence),
      env.DB.prepare("DELETE FROM events WHERE sequence = ?").bind(original.eventSequence),
    ]);
    const verified: SyncEventReader = {
      latestSequence: async () => original.eventSequence,
      readRange: async () => [{ ...original, replayed: true }],
    };

    const replay = await new EventRepository(env.DB, verified).append({
      envelope: await eventFixture("replacement"),
      scope: "telegram:update",
      key: "archived",
      requestHash: hash,
    });

    expect(replay).toEqual({ ...original, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>())?.count).toBe(1);
  });

  it("fails a purged idempotency replay closed when the verified tier is unavailable", async () => {
    const live = new EventRepository(env.DB);
    const envelope = await eventFixture("archived-unavailable");
    const hash = await requestHash("archived-unavailable");
    const original = await live.append({ envelope, scope: "telegram:update", key: "archived", requestHash: hash });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox WHERE event_sequence = ?").bind(original.eventSequence),
      env.DB.prepare("DELETE FROM events WHERE sequence = ?").bind(original.eventSequence),
    ]);
    const unavailable: SyncEventReader = {
      latestSequence: async () => original.eventSequence,
      readRange: async () => { throw new Error("archive_object_unavailable"); },
    };

    await expect(new EventRepository(env.DB, unavailable).append({
      envelope: await eventFixture("replacement"),
      scope: "telegram:update",
      key: "archived",
      requestHash: hash,
    })).rejects.toThrow("archive_object_unavailable");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
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

  it("rejects a valid stored envelope whose ledger content hash differs", async () => {
    const repository = new EventRepository(env.DB);
    await repository.append({ envelope: await eventFixture("column-range"), scope: "telegram:update", key: "column-range", requestHash: await requestHash("column-range") });
    await env.DB.prepare("UPDATE events SET content_hash = ? WHERE sequence = 1").bind("0".repeat(64)).run();

    await expect(repository.readRange(0, 1)).rejects.toThrow("ledger content hash");
  });

  it("rejects a replay when the durable ledger content hash differs", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("column-replay");
    const hash = await requestHash("column-replay");
    await repository.append({ envelope, scope: "telegram:update", key: "column-replay", requestHash: hash });
    await env.DB.prepare("UPDATE events SET content_hash = ? WHERE sequence = 1").bind("0".repeat(64)).run();

    await expect(repository.append({ envelope, scope: "telegram:update", key: "column-replay", requestHash: hash })).rejects.toThrow("ledger content hash");
  });

  it("enforces UTF-8 scope, key, envelope, request-hash, and range limits before D1 work", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("bounds");

    await expect(repository.append({ envelope, scope: "é".repeat(65), key: "key", requestHash: await requestHash("bounds") })).rejects.toThrow("scope");
    await expect(repository.append({ envelope, scope: "scope", key: "é".repeat(129), requestHash: await requestHash("bounds") })).rejects.toThrow("key");
    await expect(repository.append({ envelope, scope: "scope", key: "bad-hash", requestHash: "g".repeat(64) as Sha256Hex })).rejects.toThrow("requestHash");
    await expect(repository.append({ envelope: await oversizedFixture(), scope: "scope", key: "oversized", requestHash: await requestHash("oversized") })).rejects.toThrow("envelope");
    await expect(repository.readRange(0, 1001)).rejects.toThrow("limit");
  });

  it("appends bounded post dependencies after the event ledger and skips them on replay", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("post-order");
    const hash = await requestHash("post-order");
    let builds = 0;
    const input = { envelope, scope: "test:post-order", key: "one", requestHash: hash };
    const build = (database: D1Database, createdAt: string) => {
      builds += 1;
      return [database.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) SELECT 'principal:post-order', 'service', 'active', e.event_id, ?, ?
        FROM events e
        JOIN outbox o ON o.event_sequence = e.sequence
        WHERE e.event_id = ? AND o.outbox_id = ?`)
        .bind(createdAt, createdAt, envelope.eventId, `event:${envelope.eventId}`)];
    };

    const first = await repository.appendAtomicAfter(input, build);
    const replay = await repository.appendAtomicAfter(input, build);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(builds).toBe(1);
    await expect(env.DB.prepare("SELECT display_name FROM principals WHERE principal_id = 'principal:post-order'").first())
      .resolves.toEqual({ display_name: envelope.eventId });
  });

  it("rejects accessor, sparse, and custom-iterator post dependency arrays without executing them", async () => {
    const repository = new EventRepository(env.DB);
    const variants: Array<{ label: string; dependencies: D1PreparedStatement[]; reads: () => number }> = [];

    let accessorReads = 0;
    const accessor: D1PreparedStatement[] = [];
    Object.defineProperty(accessor, 0, {
      enumerable: true,
      configurable: true,
      get() {
        accessorReads += 1;
        return env.DB.prepare("SELECT 1");
      },
    });
    Object.defineProperty(accessor, "length", { value: 1 });
    variants.push({ label: "accessor", dependencies: accessor, reads: () => accessorReads });

    const sparse = new Array<D1PreparedStatement>(1);
    variants.push({ label: "sparse", dependencies: sparse, reads: () => 0 });

    let iteratorReads = 0;
    const customIterator = [env.DB.prepare("SELECT 1")];
    Object.defineProperty(customIterator, Symbol.iterator, {
      configurable: true,
      value: function* () {
        iteratorReads += 1;
        yield env.DB.prepare("SELECT 2");
      },
    });
    variants.push({ label: "iterator", dependencies: customIterator, reads: () => iteratorReads });

    for (const variant of variants) {
      await expect(repository.appendAtomicAfter({
        envelope: await eventFixture(`post-${variant.label}`),
        scope: "test:post-invalid",
        key: variant.label,
        requestHash: await requestHash(variant.label),
      }, () => variant.dependencies)).rejects.toThrow("event_append_post_dependency_invalid");
      expect(variant.reads()).toBe(0);
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
  });

  it("caps post dependencies at two and converges concurrent exact replays", async () => {
    const repository = new EventRepository(env.DB);
    const envelope = await eventFixture("post-race");
    const input = {
      envelope,
      scope: "test:post-race",
      key: "one",
      requestHash: await requestHash("post-race"),
    };
    const statements = [0, 1, 2].map((index) => env.DB.prepare("SELECT ? AS value").bind(index));

    await expect(repository.appendAtomicAfter(input, () => statements))
      .rejects.toThrow("event_append_post_dependency_limit");

    const attempts = await Promise.all(Array.from({ length: 8 }, () => repository.appendAtomicAfter(
      input,
      (database, createdAt) => [database.prepare(`INSERT INTO principals (
        principal_id, principal_type, status, display_name, created_at, updated_at
      ) VALUES ('principal:post-race', 'service', 'active', 'winner', ?, ?)`)
        .bind(createdAt, createdAt)],
    )));

    expect(new Set(attempts.map((attempt) => attempt.eventSequence))).toEqual(new Set([1]));
    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM principals WHERE principal_id = 'principal:post-race'").first<{ count: number }>())?.count).toBe(1);
  });
});

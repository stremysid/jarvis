import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, createEnvelope, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService, type ArchiveBucket } from "../../src/archive/archival-service.js";
import { encodeArchiveSegment } from "../../src/archive/segment-codec.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { ArchivalWorker } from "../../src/archive/archival-worker.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { appendEvents, markDelivered, resetArchiveFixture, setCreatedAt } from "./archive-fixture.js";

const now = new Date("2026-12-01T00:00:00.000Z");
const exactCutoff = "2026-09-02T00:00:00.000Z";
const oneMillisecondYoung = "2026-09-02T00:00:00.001Z";

function service(bucket: ArchiveBucket = env.ARCHIVE): ArchivalService {
  return new ArchivalService({ database: env.DB, bucket });
}

async function state(): Promise<{ sealed_through: number; circuit_state: string; circuit_reason: string | null }> {
  const row = await env.DB.prepare(
    "SELECT sealed_through, circuit_state, circuit_reason FROM archive_state WHERE singleton = 1",
  ).first<{ sealed_through: number; circuit_state: string; circuit_reason: string | null }>();
  if (row === null) throw new Error("missing archive state");
  return row;
}

async function objectForManifest(manifest: { objectKey: string }): Promise<R2ObjectBody> {
  const object = await env.ARCHIVE.get(manifest.objectKey);
  if (object === null) throw new Error("missing archive object");
  return object;
}

describe.sequential("ArchivalService", () => {
  beforeEach(resetArchiveFixture);

  it("seals verified immutable D1 authority before purging delivered events while retaining pending and failed events", async () => {
    await appendEvents(4);
    for (const sequence of [1, 2, 3, 4]) await setCreatedAt(sequence, exactCutoff);
    await markDelivered(1, 4);
    await env.DB.prepare("UPDATE outbox SET status = 'failed' WHERE event_sequence = 3").run();

    const manifest = await service().archiveEligible(now, 100);

    expect(manifest).toMatchObject({ startSequence: 1, endSequence: 4, eventCount: 4 });
    if (manifest === null) throw new Error("expected manifest");
    expect(manifest.objectKey).toBe(`events/sha256/${manifest.compressedSha256}.ndjson.gz`);
    expect((await objectForManifest(manifest)).size).toBe(manifest.compressedByteLength);
    expect((await service().readArchivedRange(0, 100)).map((event) => event.eventSequence)).toEqual([1, 2, 3, 4]);
    expect((await env.DB.prepare("SELECT sequence FROM events ORDER BY sequence").all<{ sequence: number }>()).results)
      .toEqual([{ sequence: 2 }, { sequence: 3 }]);
    expect((await env.DB.prepare("SELECT event_sequence, status FROM outbox ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 2, status: "pending" }, { event_sequence: 3, status: "failed" }]);
    expect((await env.DB.prepare("SELECT event_sequence FROM archive_purge_receipts ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 1 }, { event_sequence: 4 }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records").first<{ count: number }>())?.count).toBe(4);
    expect(await state()).toEqual({ sealed_through: 4, circuit_state: "closed", circuit_reason: null });
    await expect(env.DB.prepare("DELETE FROM archive_manifests WHERE manifest_id = ?").bind(manifest.manifestId).run())
      .rejects.toThrow("archive_manifest_immutable");
    await expect(env.DB.prepare("UPDATE archive_segment_events SET event_id = 'replacement' WHERE event_sequence = 1").run())
      .rejects.toThrow("archive_coverage_immutable");
  });

  it("treats exact 90-day equality as eligible and stops at the first younger sequence", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, oneMillisecondYoung);

    await expect(service().archiveEligible(now, 100)).resolves.toMatchObject({ startSequence: 1, endSequence: 1, eventCount: 1 });
    await expect(service().archiveEligible(now, 100)).resolves.toBeNull();
    await expect(service().archiveEligible(new Date("2026-12-01T00:00:00.001Z"), 100))
      .resolves.toMatchObject({ startSequence: 2, endSequence: 2, eventCount: 1 });
  });

  it("runs one bounded archive segment per worker invocation", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, exactCutoff);
    const worker = new ArchivalWorker(service());

    await expect(worker.run(now, 1)).resolves.toMatchObject({ startSequence: 1, endSequence: 1 });
    await expect(worker.run(now, 1)).resolves.toMatchObject({ startSequence: 2, endSequence: 2 });
    expect((await service().readArchivedRange(0, 2)).map((event) => event.eventSequence)).toEqual([1, 2]);
    await expect(worker.run(now, 1)).resolves.toBeNull();
  });

  it("uses conditional write-once R2 publication and byte-verifies an existing content-addressed object", async () => {
    const events = await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    const encoded = await encodeArchiveSegment(await events.readRange(0, 1));
    const key = `events/sha256/${encoded.compressedSha256}.ndjson.gz`;
    const original = await env.ARCHIVE.put(key, encoded.compressedBytes, { sha256: encoded.compressedSha256 });
    if (original === null) throw new Error("fixture put failed");
    let putOptions: R2PutOptions | undefined;
    const existingObjectBucket: ArchiveBucket = {
      put: async (...args) => {
        putOptions = args[2];
        return null;
      },
      get: (...args) => env.ARCHIVE.get(...args),
    };

    const manifest = await service(existingObjectBucket).archiveEligible(now, 1);

    expect(manifest?.objectKey).toBe(key);
    expect(putOptions).toEqual({
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: encoded.compressedSha256,
    });
    expect((await env.ARCHIVE.head(key))?.etag).toBe(original.etag);
  });

  it("converges concurrent archivers on one non-overlapping sealed manifest", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, exactCutoff);

    const manifests = await Promise.all([service().archiveEligible(now, 2), service().archiveEligible(now, 2)]);

    expect(manifests[0]).toEqual(manifests[1]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT event_sequence FROM archive_segment_events ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 1 }, { event_sequence: 2 }]);
    expect(await state()).toEqual({ sealed_through: 2, circuit_state: "closed", circuit_reason: null });
  });

  it("converges different-size concurrent selections on the CAS winner without opening or skipping", async () => {
    await appendEvents(3);
    for (const sequence of [1, 2, 3]) await setCreatedAt(sequence, exactCutoff);
    let putCount = 0;
    let releasePuts: (() => void) | undefined;
    const putsReady = new Promise<void>((resolve) => { releasePuts = resolve; });
    const barrierBucket: ArchiveBucket = {
      put: async (...args) => {
        putCount += 1;
        if (putCount === 2) releasePuts?.();
        await putsReady;
        return env.ARCHIVE.put(...args);
      },
      get: (...args) => env.ARCHIVE.get(...args),
    };

    const winners = await Promise.all([
      service(barrierBucket).archiveEligible(now, 1),
      service(barrierBucket).archiveEligible(now, 2),
    ]);

    expect(winners[0]).toEqual(winners[1]);
    await expect(service().archiveEligible(now, 3)).resolves.toMatchObject({ endSequence: 3 });
    expect((await env.DB.prepare("SELECT event_sequence FROM archive_segment_events ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 1 }, { event_sequence: 2 }, { event_sequence: 3 }]);
    expect(await state()).toEqual({ sealed_through: 3, circuit_state: "closed", circuit_reason: null });
  });

  it("leaves a harmless R2 orphan, opens the persistent circuit, and permits zero purge when D1 seal fails", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    await env.DB.exec("CREATE TRIGGER archive_test_fail_seal BEFORE INSERT ON archive_manifests BEGIN SELECT RAISE(ABORT, 'injected_manifest_failure'); END");

    try {
      await expect(service().archiveEligible(now, 1)).rejects.toThrow("injected_manifest_failure");
    } finally {
      await env.DB.exec("DROP TRIGGER archive_test_fail_seal");
    }

    expect((await env.ARCHIVE.list({ prefix: "events/sha256/" })).objects).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_segments").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_segment_events").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect(await state()).toMatchObject({ sealed_through: 0, circuit_state: "open" });
    await expect(service().archiveEligible(now, 1)).rejects.toThrow("archive_circuit_open");
    await expect(env.DB.prepare("UPDATE archive_state SET circuit_state = 'closed', circuit_reason = NULL, circuit_opened_at = NULL WHERE singleton = 1").run())
      .rejects.toThrow("archive_circuit_latched");
  });

  it("rolls the purge batch back atomically and opens the circuit when deletion fails after sealing", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    await env.DB.exec(
      "CREATE TRIGGER archive_test_fail_purge BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'injected_purge_failure'); END",
    );

    try {
      await expect(service().archiveEligible(now, 1)).rejects.toThrow("injected_purge_failure");
    } finally {
      await env.DB.exec("DROP TRIGGER archive_test_fail_purge");
    }

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_segment_events").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT status FROM outbox WHERE event_sequence = 1").first<{ status: string }>())?.status)
      .toBe("delivered");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect(await state()).toMatchObject({ sealed_through: 1, circuit_state: "open" });
  });

  it("opens the circuit without sealing or purging when an existing object fails byte verification", async () => {
    const events = await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    const encoded = await encodeArchiveSegment(await events.readRange(0, 1));
    const key = `events/sha256/${encoded.compressedSha256}.ndjson.gz`;
    await env.ARCHIVE.put(key, "wrong bytes");

    await expect(service().archiveEligible(now, 1)).rejects.toThrow("archive_compressed_hash_mismatch");

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect(await state()).toMatchObject({ sealed_through: 0, circuit_state: "open" });
  });

  it("opens the circuit and permits no purge when immediate post-seal re-verification observes corruption", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    let reads = 0;
    const corruptingBucket: ArchiveBucket = {
      put: (...args) => env.ARCHIVE.put(...args),
      get: async (...args) => {
        reads += 1;
        if (reads === 2) await env.ARCHIVE.put(args[0], "post-seal corruption");
        return env.ARCHIVE.get(...args);
      },
    };

    await expect(service(corruptingBucket).archiveEligible(now, 1)).rejects.toThrow("archive_compressed_hash_mismatch");

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toMatchObject({ sealed_through: 1, circuit_state: "open" });
  });

  it("fails closed and latches the circuit when the next unsealed event has no intact outbox row", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await env.DB.prepare("DELETE FROM outbox WHERE event_sequence = 1").run();

    await expect(service().archiveEligible(now, 1)).rejects.toThrow("archive_outbox_missing");

    expect((await env.ARCHIVE.list({ prefix: "events/sha256/" })).objects).toHaveLength(0);
    expect(await state()).toMatchObject({ sealed_through: 0, circuit_state: "open" });
  });

  it("fails archived reads closed on R2 corruption and permanently prevents archived event-ID reuse", async () => {
    const events = await appendEvents(1);
    const original = (await events.readRange(0, 1))[0]!;
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    const manifest = await service().archiveEligible(now, 1);
    if (manifest === null) throw new Error("expected manifest");

    const verified = new TieredEventReader({
      archive: service(),
      live: new EventRepository(env.DB),
      state: new ArchiveRepository(env.DB),
    });
    const replayed = await new EventRepository(env.DB, verified).append({
      envelope: await createEnvelope({
        schemaVersion: "1.0", eventId: newUlid(), eventType: "telegram.update", source: "telegram", subjectId: "principal:test",
        occurredAt: "2026-08-29T12:00:00.000Z", receivedAt: "2026-08-29T12:00:00.000Z", correlationId: newUlid(),
        contentType: "application/json", payload: { ignoredReplacement: true }, producerVersion: "test",
      }),
      scope: "telegram:update",
      key: "fixture:1",
      requestHash: await sha256Hex(canonicalJson({ index: 1 })),
    });
    expect(replayed).toEqual({ ...original, replayed: true });

    const replacement = await createEnvelope({
      schemaVersion: "1.0", eventId: original.envelope.eventId, eventType: "telegram.update", source: "telegram", subjectId: "principal:test",
      occurredAt: "2026-08-29T12:00:00.000Z", receivedAt: "2026-08-29T12:00:00.000Z", correlationId: newUlid(),
      contentType: "application/json", payload: { replacement: true }, producerVersion: "test",
    });
    await expect(new EventRepository(env.DB).append({
      envelope: replacement, scope: "telegram:update", key: "replacement", requestHash: await sha256Hex(canonicalJson({ replacement: true })),
    })).rejects.toThrow("archived_event_id_reuse");
    await env.ARCHIVE.put(manifest.objectKey, "corrupt after seal");
    await expect(new EventRepository(env.DB, verified).append({
      envelope: await createEnvelope({
        schemaVersion: "1.0", eventId: newUlid(), eventType: "telegram.update", source: "telegram", subjectId: "principal:test",
        occurredAt: "2026-08-29T12:00:00.000Z", receivedAt: "2026-08-29T12:00:00.000Z", correlationId: newUlid(),
        contentType: "application/json", payload: { corruptReplacement: true }, producerVersion: "test",
      }),
      scope: "telegram:update",
      key: "fixture:1",
      requestHash: await sha256Hex(canonicalJson({ index: 1 })),
    })).rejects.toThrow("archive_compressed_hash_mismatch");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toMatchObject({ sealed_through: 1, circuit_state: "open" });
  });
});

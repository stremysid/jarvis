import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ARCHIVE_SEGMENT_LIMITS, encodeArchiveSegment } from "../../src/archive/segment-codec.js";
import { appendEvents, resetArchiveFixture, setCreatedAt } from "./archive-fixture.js";

const now = new Date("2026-12-01T00:00:00.000Z");
const exactCutoff = "2026-09-02T00:00:00.000Z";

function recordingCandidateDatabase(onBind: (values: readonly unknown[]) => void): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM events e")) return statement;
      return {
        bind: (...values: unknown[]) => {
          onBind(values);
          return statement.bind(...values);
        },
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function recordingManifestDatabase(onBind: (values: readonly unknown[]) => void): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM archive_manifests m") || !query.includes("m.end_sequence > ?")) return statement;
      return {
        bind: (...values: unknown[]) => {
          onBind(values);
          return statement.bind(...values);
        },
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function rejectingBatchDatabase(onBatch: () => void): D1Database {
  return {
    prepare: (query: string) => env.DB.prepare(query),
    batch: async () => {
      onBatch();
      throw new Error("oversized_seal_executed");
    },
  } as D1Database;
}

describe.sequential("ArchiveRepository query bounds", () => {
  beforeEach(resetArchiveFixture);

  it("applies the explicit manifest limit even when the terminal covers many physical segments", async () => {
    await appendEvents(3);
    for (const sequence of [1, 2, 3]) await setCreatedAt(sequence, exactCutoff);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    for (let index = 0; index < 3; index += 1) await archive.archiveEligible(now, 1);

    const manifests = await new ArchiveRepository(env.DB).listManifests(0, 3, 1);

    expect(manifests.map((manifest) => manifest.startSequence)).toEqual([1]);
  });

  it("rejects unsafe manifest query bounds before issuing a D1 read", async () => {
    const manifestBindings: unknown[][] = [];
    const repository = new ArchiveRepository(recordingManifestDatabase((values) => manifestBindings.push([...values])));

    await expect(repository.listManifests(-1, 1, 1)).rejects.toThrow("archive_manifest_range_invalid");
    await expect(repository.listManifests(2, 1, 1)).rejects.toThrow("archive_manifest_range_invalid");
    await expect(repository.listManifests(0, 1, 0)).rejects.toThrow("archive_manifest_limit_invalid");
    await expect(repository.listManifests(0, 1, 1001)).rejects.toThrow("archive_manifest_limit_invalid");
    await expect(repository.listManifests(
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
      1,
    )).resolves.toEqual([]);
    expect(manifestBindings).toEqual([[
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      1,
    ]]);
    await expect(repository.selectEligible(now, 1, ARCHIVE_SEGMENT_LIMITS.maxUncompressedBytes + 1))
      .rejects.toThrow("archive_byte_budget_invalid");
  });

  it("byte-bounds the D1 candidate result before all materializes the maxEvents remainder", async () => {
    await appendEvents(3);
    for (const sequence of [1, 2, 3]) await setCreatedAt(sequence, exactCutoff);
    const first = await env.DB.prepare(
      "SELECT length(CAST(envelope_json AS BLOB)) AS bytes FROM events WHERE sequence = 1",
    ).first<{ bytes: number }>();
    if (first === null) throw new Error("missing event fixture");

    const candidate = await new ArchiveRepository(env.DB).selectEligible(now, 3, first.bytes + 1);

    expect(candidate?.events.map((event) => event.eventSequence)).toEqual([1]);
  });

  it("never requests more than one fixed page and stops paging when the byte budget is reached", async () => {
    await appendEvents(33);
    for (let sequence = 1; sequence <= 33; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    const first = await env.DB.prepare(
      "SELECT length(CAST(envelope_json AS BLOB)) AS bytes FROM events WHERE sequence = 1",
    ).first<{ bytes: number }>();
    if (first === null) throw new Error("missing event fixture");
    const pageBindings: unknown[][] = [];

    const candidate = await new ArchiveRepository(recordingCandidateDatabase((values) => pageBindings.push([...values])))
      .selectEligible(now, 1000, first.bytes + 1);

    expect(candidate?.events.map((event) => event.eventSequence)).toEqual([1]);
    expect(pageBindings).toEqual([[1, 32]]);
  });

  it("uses bounded keyset pages until maxEvents is satisfied", async () => {
    await appendEvents(35);
    for (let sequence = 1; sequence <= 35; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    const pageBindings: unknown[][] = [];

    const candidate = await new ArchiveRepository(recordingCandidateDatabase((values) => pageBindings.push([...values])))
      .selectEligible(now, 35, 8 * 1024 * 1024);

    expect(candidate?.events.map((event) => event.eventSequence)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 1),
    );
    expect(pageBindings).toEqual([[1, 32], [33, 3]]);
  });

  it("rejects a direct seal above the 24-event physical cap before executing D1", async () => {
    const events = await appendEvents(25);
    const selected = await events.readRange(0, 25);
    const encoded24 = await encodeArchiveSegment(selected.slice(0, 24));
    const oversizedEncoding = {
      ...encoded24,
      metadata: { ...encoded24.metadata, endSequence: 25, eventCount: 25 },
    };
    let batchCalls = 0;
    const repository = new ArchiveRepository(rejectingBatchDatabase(() => { batchCalls += 1; }));

    await expect(repository.seal(
      { sealedThrough: 0, events: selected },
      oversizedEncoding,
      "events/sha256/oversized.ndjson.gz",
      now.toISOString(),
    )).rejects.toThrow("archive_event_count_limit");
    expect(batchCalls).toBe(0);
  });
});

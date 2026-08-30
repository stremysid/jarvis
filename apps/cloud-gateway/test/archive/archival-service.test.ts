import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, createEnvelope, newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { ArchivalService, type ArchiveBucket } from "../../src/archive/archival-service.js";
import { ARCHIVE_SEGMENT_LIMITS, encodeArchiveSegment } from "../../src/archive/segment-codec.js";
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

function recordingDatabase(onManifestBind: (values: readonly unknown[]) => void): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM archive_manifests m")) return statement;
      return {
        bind: (...values: unknown[]) => {
          onManifestBind(values);
          return statement.bind(...values);
        },
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function manifestLengthDatabase(compressedByteLength: number): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM archive_manifests m")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            all: async <T>() => {
              const result = await bound.all<Record<string, unknown>>();
              return {
                ...result,
                results: result.results.map((row) => ({ ...row, compressed_byte_length: compressedByteLength })) as T[],
              };
            },
          } as D1PreparedStatement;
        },
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function selectionFailureDatabase(error: Error): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM events e")) return statement;
      return {
        bind: () => ({
          all: async () => { throw error; },
        }) as D1PreparedStatement,
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function manifestListFailureDatabase(error: Error): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM archive_manifests m")) return statement;
      return {
        bind: () => ({
          all: async () => { throw error; },
        }) as D1PreparedStatement,
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function selectionInterleavingDatabase(beforeCandidateRead: () => Promise<void>): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM events e")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            all: async <T>() => {
              await beforeCandidateRead();
              return bound.all<T>();
            },
          } as D1PreparedStatement;
        },
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function recordingBatchDatabase(onBatch: (statementCount: number) => void): D1Database {
  return {
    prepare: (query: string) => env.DB.prepare(query),
    batch: (statements: D1PreparedStatement[]) => {
      onBatch(statements.length);
      return env.DB.batch(statements);
    },
  } as D1Database;
}

function queryCountingDatabase(beforeSealBatch: () => Promise<void>): {
  database: D1Database;
  queryCount: () => number;
} {
  let count = 0;
  let interceptedSeal = false;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: async <T>(columnName?: string) => {
        count += 1;
        return columnName === undefined ? statement.first<T>() : statement.first<T>(columnName);
      },
      run: async <T>() => {
        count += 1;
        return statement.run<T>();
      },
      all: async <T>() => {
        count += 1;
        return statement.all<T>();
      },
      raw: async (options?: { columnNames?: boolean }) => {
        count += 1;
        return options?.columnNames === true
          ? statement.raw({ columnNames: true })
          : statement.raw();
      },
    } as D1PreparedStatement;
    originals.set(wrapped as object, statement);
    return wrapped;
  };
  return {
    database: {
      prepare: (query: string) => wrap(env.DB.prepare(query)),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        count += statements.length;
        if (statements.length > 3 && !interceptedSeal) {
          interceptedSeal = true;
          await beforeSealBatch();
        }
        return env.DB.batch<T>(statements.map((statement) => originals.get(statement as object) ?? statement));
      },
    } as D1Database,
    queryCount: () => count,
  };
}

function recordingCoverageDatabase(onBind: (values: readonly unknown[]) => void): D1Database {
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM archive_segment_events") || !query.includes("SELECT event_sequence")) return statement;
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

function postSealCoverageFailureDatabase(error: Error): D1Database {
  let failed = false;
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (failed || !query.includes("FROM archive_segment_events") || !query.includes("WHERE segment_id = ?")) {
        return statement;
      }
      return {
        bind: () => ({
          all: async () => {
            failed = true;
            throw error;
          },
        }) as D1PreparedStatement,
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

function failBucketGet(getNumber: number): ArchiveBucket {
  let reads = 0;
  return {
    put: (...args) => env.ARCHIVE.put(...args),
    get: async (...args) => {
      reads += 1;
      if (reads === getNumber) throw new Error("temporary_r2_read_failure");
      return env.ARCHIVE.get(...args);
    },
  };
}

function stateReadInterleavingDatabase(stateReadNumber: number, beforeRead: () => Promise<void>): D1Database {
  let stateReads = 0;
  return {
    prepare: (query: string) => {
      const statement = env.DB.prepare(query);
      if (!query.includes("FROM archive_state WHERE singleton = 1")) return statement;
      return {
        first: async <T>() => {
          stateReads += 1;
          if (stateReads === stateReadNumber) await beforeRead();
          return statement.first<T>();
        },
      } as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
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
    expect((await service().readArchivedRange(0, 48)).map((event) => event.eventSequence)).toEqual([1, 2, 3, 4]);
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

  it("accepts a 1000-event work request while sealing at most 24 events in a 27-statement batch", async () => {
    await appendEvents(50);
    for (let sequence = 1; sequence <= 50; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    const batchSizes: number[] = [];
    const bounded = new ArchivalService({
      database: recordingBatchDatabase((statementCount) => batchSizes.push(statementCount)),
      bucket: env.ARCHIVE,
    });

    await expect(bounded.archiveEligible(now, 1000)).resolves.toMatchObject({
      startSequence: 1, endSequence: 24, eventCount: 24,
    });
    await expect(bounded.archiveEligible(now, 1000)).resolves.toMatchObject({
      startSequence: 25, endSequence: 48, eventCount: 24,
    });
    await expect(bounded.archiveEligible(now, 1000)).resolves.toMatchObject({
      startSequence: 49, endSequence: 50, eventCount: 2,
    });
    await expect(bounded.archiveEligible(now, 1000)).resolves.toBeNull();

    expect(Math.max(...batchSizes)).toBe(27);
    expect(batchSizes.filter((statementCount) => statementCount > 3)).toEqual([27, 27, 5]);
    expect(await state()).toEqual({ sealed_through: 50, circuit_state: "closed", circuit_reason: null });
  });

  it("keeps a reconciled 24-event seal conflict within the 50-query free-tier budget", async () => {
    await appendEvents(48);
    for (let sequence = 1; sequence <= 48; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    await markDelivered(...Array.from({ length: 48 }, (_, index) => index + 1));
    await service().archiveEligible(now, 1000);
    const counted = queryCountingDatabase(async () => {
      await service().archiveEligible(now, 1000);
    });
    const guarded = new ArchivalService({ database: counted.database, bucket: env.ARCHIVE });

    await expect(guarded.archiveEligible(now, 1000)).resolves.toMatchObject({ startSequence: 25, endSequence: 48 });

    expect(counted.queryCount()).toBe(44);
    expect(counted.queryCount()).toBeLessThanOrEqual(50);
    expect(await state()).toEqual({ sealed_through: 48, circuit_state: "closed", circuit_reason: null });
  });

  it("reconciles one older delivered manifest during a seal conflict within the 50-query budget", async () => {
    await appendEvents(49);
    for (let sequence = 1; sequence <= 49; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    await service().archiveEligible(now, 1);
    await service().archiveEligible(now, 24);
    await markDelivered(1, ...Array.from({ length: 24 }, (_, index) => index + 26));
    const counted = queryCountingDatabase(async () => {
      await service().archiveEligible(now, 24);
    });
    const guarded = new ArchivalService({ database: counted.database, bucket: env.ARCHIVE });

    await expect(guarded.archiveEligible(now, 24)).resolves.toMatchObject({ startSequence: 26, endSequence: 49 });

    expect(counted.queryCount()).toBe(49);
    expect(counted.queryCount()).toBeLessThanOrEqual(50);
    expect((await env.DB.prepare("SELECT sequence FROM events ORDER BY sequence").all()).results)
      .toEqual(Array.from({ length: 24 }, (_, index) => ({ sequence: index + 2 })));
    expect(await state()).toEqual({ sealed_through: 49, circuit_state: "closed", circuit_reason: null });
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

  it("rejects invalid invocation inputs without bucket, manifest, purge, or circuit mutation", async () => {
    let bucketOperations = 0;
    const guarded = service({
      put: async (...args) => {
        bucketOperations += 1;
        return env.ARCHIVE.put(...args);
      },
      get: async (...args) => {
        bucketOperations += 1;
        return env.ARCHIVE.get(...args);
      },
    });

    for (const invalid of [0, 1.5, Number.NaN, 1001]) {
      await expect(guarded.archiveEligible(now, invalid)).rejects.toThrow("archive_limit_invalid");
      expect(await state()).toEqual({ sealed_through: 0, circuit_state: "closed", circuit_reason: null });
    }
    await expect(guarded.archiveEligible(new Date(Number.NaN), 1)).rejects.toThrow("archive_now_invalid");
    expect(bucketOperations).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
  });

  it("seals the largest fitting prefix, remains closed, and drains later prefixes in order", async () => {
    const events = await appendEvents(5);
    for (const sequence of [1, 2, 3, 4, 5]) await setCreatedAt(sequence, exactCutoff);
    const firstTwo = await encodeArchiveSegment(await events.readRange(0, 2));
    const bounded = new ArchivalService({
      database: env.DB,
      bucket: env.ARCHIVE,
      segmentLimits: {
        maxCompressedBytes: ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes,
        maxUncompressedBytes: firstTwo.uncompressedByteLength,
        maxEventCount: ARCHIVE_SEGMENT_LIMITS.maxEventCount,
      },
    });

    await expect(bounded.archiveEligible(now, 5)).resolves.toMatchObject({ startSequence: 1, endSequence: 2, eventCount: 2 });
    await expect(bounded.archiveEligible(now, 5)).resolves.toMatchObject({ startSequence: 3, endSequence: 4, eventCount: 2 });
    await expect(bounded.archiveEligible(now, 5)).resolves.toMatchObject({ startSequence: 5, endSequence: 5, eventCount: 1 });
    await expect(bounded.archiveEligible(now, 5)).resolves.toBeNull();

    expect((await env.DB.prepare("SELECT start_sequence, end_sequence FROM archive_manifests ORDER BY start_sequence").all()).results)
      .toEqual([
        { start_sequence: 1, end_sequence: 2 },
        { start_sequence: 3, end_sequence: 4 },
        { start_sequence: 5, end_sequence: 5 },
      ]);
    expect(await state()).toEqual({ sealed_through: 5, circuit_state: "closed", circuit_reason: null });
  });

  it("returns a non-latching capacity error when one valid event cannot fit", async () => {
    const events = await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    const first = await encodeArchiveSegment(await events.readRange(0, 1));
    let bucketOperations = 0;
    const bounded = new ArchivalService({
      database: env.DB,
      bucket: {
        put: async (...args) => {
          bucketOperations += 1;
          return env.ARCHIVE.put(...args);
        },
        get: async (...args) => {
          bucketOperations += 1;
          return env.ARCHIVE.get(...args);
        },
      },
      segmentLimits: {
        maxCompressedBytes: ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes,
        maxUncompressedBytes: first.uncompressedByteLength - 1,
        maxEventCount: ARCHIVE_SEGMENT_LIMITS.maxEventCount,
      },
    });

    await expect(bounded.archiveEligible(now, 1)).rejects.toThrow("archive_segment_capacity");
    expect(bucketOperations).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toEqual({ sealed_through: 0, circuit_state: "closed", circuit_reason: null });
  });

  it("does not latch the circuit when eligible-event selection has a transient D1 failure", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    let bucketOperations = 0;
    const guarded = new ArchivalService({
      database: selectionFailureDatabase(new Error("temporary_d1_failure")),
      bucket: {
        put: async (...args) => {
          bucketOperations += 1;
          return env.ARCHIVE.put(...args);
        },
        get: async (...args) => {
          bucketOperations += 1;
          return env.ARCHIVE.get(...args);
        },
      },
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("temporary_d1_failure");
    expect(bucketOperations).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toEqual({ sealed_through: 0, circuit_state: "closed", circuit_reason: null });
  });

  it("defers paged selection when a concurrent archiver seals and purges before the first page", async () => {
    await appendEvents(33);
    for (let sequence = 1; sequence <= 33; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    await markDelivered(1, 24);
    let moved = false;
    let guardedPuts = 0;
    const guarded = new ArchivalService({
      database: selectionInterleavingDatabase(async () => {
        if (moved) return;
        moved = true;
        await service().archiveEligible(now, 32);
      }),
      bucket: {
        put: async (...args) => {
          guardedPuts += 1;
          return env.ARCHIVE.put(...args);
        },
        get: (...args) => env.ARCHIVE.get(...args),
      },
    });

    await expect(guarded.archiveEligible(now, 32)).rejects.toThrow("archive_reconciliation_unstable");
    expect(guardedPuts).toBe(0);
    await expect(service().archiveEligible(now, 32)).resolves.toMatchObject({
      startSequence: 25,
      endSequence: 33,
      eventCount: 9,
    });
    expect((await env.DB.prepare(
      "SELECT start_sequence, end_sequence FROM archive_manifests ORDER BY start_sequence",
    ).all()).results).toEqual([
      { start_sequence: 1, end_sequence: 24 },
      { start_sequence: 25, end_sequence: 33 },
    ]);
    expect(await state()).toEqual({ sealed_through: 33, circuit_state: "closed", circuit_reason: null });
  });

  it("bounds repeated selection movement and leaves the circuit retryable", async () => {
    await appendEvents(4);
    for (let sequence = 1; sequence <= 4; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    await markDelivered(1, 2, 3);
    let guardedBucketPuts = 0;
    const guarded = new ArchivalService({
      database: selectionInterleavingDatabase(async () => {
        await service().archiveEligible(now, 1);
      }),
      bucket: {
        put: async (...args) => {
          guardedBucketPuts += 1;
          return env.ARCHIVE.put(...args);
        },
        get: (...args) => env.ARCHIVE.get(...args),
      },
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("archive_selection_unstable");
    expect(guardedBucketPuts).toBe(0);
    expect(await state()).toEqual({ sealed_through: 3, circuit_state: "closed", circuit_reason: null });
    await expect(service().archiveEligible(now, 1)).resolves.toMatchObject({ startSequence: 4, endSequence: 4 });
  });

  it("does not latch the circuit when conditional R2 publication has a transient failure", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    let objectReads = 0;
    const guarded = service({
      put: async () => { throw new Error("temporary_r2_failure"); },
      get: async (...args) => {
        objectReads += 1;
        return env.ARCHIVE.get(...args);
      },
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("temporary_r2_failure");
    expect(objectReads).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect(await state()).toEqual({ sealed_through: 0, circuit_state: "closed", circuit_reason: null });
  });

  it("does not latch the circuit when immediate R2 readback has a transient provider failure", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    const guarded = service({
      put: (...args) => env.ARCHIVE.put(...args),
      get: async () => { throw new Error("temporary_r2_read_failure"); },
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");
    expect((await env.ARCHIVE.list({ prefix: "events/sha256/" })).objects).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect(await state()).toEqual({ sealed_through: 0, circuit_state: "closed", circuit_reason: null });
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

  it("bounds a tiny archived read to its requested terminal and never touches later corrupt segments", async () => {
    await appendEvents(3);
    for (const sequence of [1, 2, 3]) await setCreatedAt(sequence, exactCutoff);
    const worker = new ArchivalWorker(service());
    for (let index = 0; index < 3; index += 1) await worker.run(now, 1);
    const stored = await env.DB.prepare(
      `SELECT s.object_key
       FROM archive_segments s
       JOIN archive_manifests m ON m.manifest_id = s.manifest_id
       ORDER BY m.start_sequence`,
    ).all<{ object_key: string }>();
    const laterKey = stored.results[2]?.object_key;
    if (laterKey === undefined) throw new Error("missing later archive fixture");
    await env.ARCHIVE.put(laterKey, "later corruption");
    const manifestBindings: unknown[][] = [];
    const objectReads: string[] = [];
    const bounded = new ArchivalService({
      database: recordingDatabase((values) => manifestBindings.push([...values])),
      bucket: {
        put: (...args) => env.ARCHIVE.put(...args),
        get: async (...args) => {
          objectReads.push(args[0]);
          return env.ARCHIVE.get(...args);
        },
      },
    });

    expect((await bounded.readArchivedRange(0, 1)).map((event) => event.eventSequence)).toEqual([1]);
    expect(manifestBindings).toEqual([[0, 24, 1, 1]]);
    expect(objectReads).toEqual([stored.results[0]!.object_key]);
    expect(await state()).toEqual({ sealed_through: 3, circuit_state: "closed", circuit_reason: null });
  });

  it("seeks a many-segment tail read and accesses only the terminal manifest object", async () => {
    await appendEvents(48);
    for (let sequence = 1; sequence <= 48; sequence += 1) await setCreatedAt(sequence, exactCutoff);
    for (let index = 0; index < 48; index += 1) await service().archiveEligible(now, 1);
    const stored = await env.DB.prepare(
      `SELECT s.object_key
       FROM archive_segments s
       JOIN archive_manifests m ON m.manifest_id = s.manifest_id
       ORDER BY m.end_sequence`,
    ).all<{ object_key: string }>();
    const manifestBindings: unknown[][] = [];
    const objectReads: string[] = [];
    const reader = new ArchivalService({
      database: recordingDatabase((values) => manifestBindings.push([...values])),
      bucket: {
        put: (...args) => env.ARCHIVE.put(...args),
        get: async (...args) => {
          objectReads.push(args[0]);
          return env.ARCHIVE.get(...args);
        },
      },
    });

    expect((await reader.readArchivedRange(47, 1)).map((event) => event.eventSequence)).toEqual([48]);
    expect(manifestBindings).toEqual([[47, 71, 48, 1]]);
    expect(objectReads).toEqual([stored.results[47]!.object_key]);

    manifestBindings.length = 0;
    objectReads.length = 0;
    expect((await reader.readArchivedRange(0, 48)).map((event) => event.eventSequence)).toEqual(
      Array.from({ length: 48 }, (_, index) => index + 1),
    );
    expect(manifestBindings).toEqual([[0, 71, 48, 48]]);
    expect(objectReads).toEqual(stored.results.map((row) => row.object_key));
  });

  it("verifies a multi-manifest archived range with one bounded coverage query", async () => {
    await appendEvents(3);
    for (const sequence of [1, 2, 3]) await setCreatedAt(sequence, exactCutoff);
    for (let index = 0; index < 3; index += 1) await service().archiveEligible(now, 1);
    const coverageBindings: unknown[][] = [];
    const reader = new ArchivalService({
      database: recordingCoverageDatabase((values) => coverageBindings.push([...values])),
      bucket: env.ARCHIVE,
    });

    expect((await reader.readArchivedRange(0, 3)).map((event) => event.eventSequence)).toEqual([1, 2, 3]);
    expect(coverageBindings).toEqual([[0, 3, 3]]);
  });

  it("rejects oversized R2 metadata before materializing the object body", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await service().archiveEligible(now, 1);
    let bodyReads = 0;
    const oversized = {
      size: ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes + 1,
      body: new ReadableStream<Uint8Array>(),
      arrayBuffer: async () => {
        bodyReads += 1;
        throw new Error("oversized_body_materialized");
      },
    } as R2ObjectBody;
    const guarded = service({
      put: (...args) => env.ARCHIVE.put(...args),
      get: async () => oversized,
    });

    await expect(guarded.readArchivedRange(0, 1)).rejects.toThrow("archive_object_size_mismatch");
    expect(bodyReads).toBe(0);
    expect(await state()).toMatchObject({ sealed_through: 1, circuit_state: "open" });
  });

  it("rejects an under-cap declared/object size mismatch before materializing the body", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    const manifest = await service().archiveEligible(now, 1);
    if (manifest === null) throw new Error("missing archive fixture");
    let bodyReads = 0;
    const mismatched = {
      size: manifest.compressedByteLength + 1,
      body: new ReadableStream<Uint8Array>(),
      arrayBuffer: async () => {
        bodyReads += 1;
        throw new Error("mismatched_body_materialized");
      },
    } as R2ObjectBody;

    await expect(service({ put: (...args) => env.ARCHIVE.put(...args), get: async () => mismatched })
      .readArchivedRange(0, 1)).rejects.toThrow("archive_object_size_mismatch");
    expect(bodyReads).toBe(0);
    expect(await state()).toMatchObject({ sealed_through: 1, circuit_state: "open" });
  });

  it("rejects unsafe declared and object sizes before materializing a body", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    const manifest = await service().archiveEligible(now, 1);
    if (manifest === null) throw new Error("missing archive fixture");
    let bodyReads = 0;
    const body = (size: number): R2ObjectBody => ({
      size,
      body: new ReadableStream<Uint8Array>(),
      arrayBuffer: async () => {
        bodyReads += 1;
        throw new Error("unsafe_body_materialized");
      },
    }) as R2ObjectBody;

    const unsafeDeclared = new ArchivalService({
      database: manifestLengthDatabase(1.5),
      bucket: { put: (...args) => env.ARCHIVE.put(...args), get: async () => body(1.5) },
    });
    await expect(unsafeDeclared.readArchivedRange(0, 1)).rejects.toThrow("archive_manifest_size_invalid");
    expect(bodyReads).toBe(0);

    await resetArchiveFixture();
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await service().archiveEligible(now, 1);
    const tooLargeDeclared = new ArchivalService({
      database: manifestLengthDatabase(ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes + 1),
      bucket: {
        put: (...args) => env.ARCHIVE.put(...args),
        get: async () => body(ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes + 1),
      },
    });
    await expect(tooLargeDeclared.readArchivedRange(0, 1)).rejects.toThrow("archive_compressed_limit");
    expect(bodyReads).toBe(0);

    await resetArchiveFixture();
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await service().archiveEligible(now, 1);
    await expect(service({ put: (...args) => env.ARCHIVE.put(...args), get: async () => body(Number.NaN) })
      .readArchivedRange(0, 1)).rejects.toThrow("archive_object_size_invalid");
    expect(bodyReads).toBe(0);
  });

  it("allows an exact maximum compressed size to reach hash verification", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await service().archiveEligible(now, 1);
    let bodyReads = 0;
    const exactMaximum = {
      size: ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes,
      body: new ReadableStream<Uint8Array>(),
      arrayBuffer: async () => {
        bodyReads += 1;
        return Uint8Array.of(0).buffer;
      },
    } as R2ObjectBody;
    const guarded = new ArchivalService({
      database: manifestLengthDatabase(ARCHIVE_SEGMENT_LIMITS.maxCompressedBytes),
      bucket: { put: (...args) => env.ARCHIVE.put(...args), get: async () => exactMaximum },
    });

    await expect(guarded.readArchivedRange(0, 1)).rejects.toThrow("archive_compressed_hash_mismatch");
    expect(bodyReads).toBe(1);
  });

  it("allows exact compressed-size equality and still hashes equal-size corrupt bytes", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    const manifest = await service().archiveEligible(now, 1);
    if (manifest === null) throw new Error("missing archive fixture");
    let bodyReads = 0;
    const corruptBytes = new Uint8Array(manifest.compressedByteLength);
    const equalSizeCorrupt = {
      size: manifest.compressedByteLength,
      body: new ReadableStream<Uint8Array>(),
      arrayBuffer: async () => {
        bodyReads += 1;
        return corruptBytes.buffer;
      },
    } as R2ObjectBody;

    await expect(service({ put: (...args) => env.ARCHIVE.put(...args), get: async () => equalSizeCorrupt })
      .readArchivedRange(0, 1)).rejects.toThrow("archive_compressed_hash_mismatch");
    expect(bodyReads).toBe(1);
  });

  it("validates archived read inputs before R2 integrity work or circuit mutation", async () => {
    let objectReads = 0;
    const guarded = service({
      put: (...args) => env.ARCHIVE.put(...args),
      get: async (...args) => {
        objectReads += 1;
        return env.ARCHIVE.get(...args);
      },
    });

    await expect(guarded.readArchivedRange(Number.MAX_SAFE_INTEGER, 48)).resolves.toEqual([]);
    await expect(guarded.readArchivedRange(0, 0)).rejects.toThrow("limit must be between 1 and 48");
    await expect(guarded.readArchivedRange(0, 49)).rejects.toThrow("limit must be between 1 and 48");
    expect(objectReads).toBe(0);
    expect(await state()).toEqual({ sealed_through: 0, circuit_state: "closed", circuit_reason: null });
  });

  it("does not latch the circuit when an archived R2 read has a transient provider failure", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await service().archiveEligible(now, 1);
    const guarded = service({
      put: (...args) => env.ARCHIVE.put(...args),
      get: async () => { throw new Error("temporary_archive_r2_read_failure"); },
    });

    await expect(guarded.readArchivedRange(0, 1)).rejects.toThrow("archive_object_read_failed");
    expect(await state()).toEqual({ sealed_through: 1, circuit_state: "closed", circuit_reason: null });
  });

  it("does not latch the circuit when an archived manifest-list query has a transient D1 failure", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await service().archiveEligible(now, 1);
    let bucketOperations = 0;
    const guarded = new ArchivalService({
      database: manifestListFailureDatabase(new Error("temporary_manifest_list_failure")),
      bucket: {
        put: async (...args) => {
          bucketOperations += 1;
          return env.ARCHIVE.put(...args);
        },
        get: async (...args) => {
          bucketOperations += 1;
          return env.ARCHIVE.get(...args);
        },
      },
    });

    await expect(guarded.readArchivedRange(0, 1)).rejects.toThrow("archive_manifest_list_failed");
    expect(bucketOperations).toBe(0);
    expect(await state()).toEqual({ sealed_through: 1, circuit_state: "closed", circuit_reason: null });
  });

  it("does not query manifests when a near-MAX_SAFE cursor is already at or above the seal", async () => {
    const manifestBindings: unknown[][] = [];
    const bounded = new ArchivalService({
      database: recordingDatabase((values) => manifestBindings.push([...values])),
      bucket: env.ARCHIVE,
    });

    await expect(bounded.readArchivedRange(Number.MAX_SAFE_INTEGER, 48)).resolves.toEqual([]);
    expect(manifestBindings).toEqual([]);
    expect(await state()).toEqual({ sealed_through: 0, circuit_state: "closed", circuit_reason: null });
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

  it("keeps a sealed manifest retryable when the second R2 get fails transiently", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);

    await expect(service(failBucketGet(2)).archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(1);
    expect(await state()).toEqual({ sealed_through: 1, circuit_state: "closed", circuit_reason: null });
  });

  it("reconciles and purges the sealed tail before publishing the next segment", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, exactCutoff);
    await markDelivered(1);
    await expect(service(failBucketGet(2)).archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");
    let newPublications = 0;
    const reconciling = service({
      put: async (...args) => {
        newPublications += 1;
        const stillLive = await env.DB.prepare("SELECT 1 AS present FROM events WHERE sequence = 1").first();
        if (stillLive !== null) throw new Error("published_before_reconciliation_purge");
        return env.ARCHIVE.put(...args);
      },
      get: (...args) => env.ARCHIVE.get(...args),
    });

    await expect(reconciling.archiveEligible(now, 1)).resolves.toMatchObject({ startSequence: 2, endSequence: 2 });

    expect(newPublications).toBe(1);
    expect((await env.DB.prepare("SELECT event_sequence FROM archive_purge_receipts ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 1 }]);
    expect(await state()).toEqual({ sealed_through: 2, circuit_state: "closed", circuit_reason: null });
  });

  it("verifies and purges an older delivered manifest after reconciling the current tail", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, exactCutoff);
    const first = await service().archiveEligible(now, 1);
    const tail = await service().archiveEligible(now, 1);
    if (first === null || tail === null) throw new Error("expected two archive manifests");
    await markDelivered(1);
    const objectReads: string[] = [];
    const reconciling = service({
      put: (...args) => env.ARCHIVE.put(...args),
      get: async (...args) => {
        objectReads.push(args[0]);
        return env.ARCHIVE.get(...args);
      },
    });

    await expect(reconciling.archiveEligible(now, 1)).resolves.toBeNull();

    expect(objectReads).toEqual([tail.objectKey, first.objectKey]);
    expect((await env.DB.prepare("SELECT sequence FROM events ORDER BY sequence").all()).results)
      .toEqual([{ sequence: 2 }]);
    expect((await env.DB.prepare("SELECT event_sequence, status FROM outbox ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 2, status: "pending" }]);
    expect((await env.DB.prepare("SELECT event_sequence FROM archive_purge_receipts ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 1 }]);
    expect(await state()).toEqual({ sealed_through: 2, circuit_state: "closed", circuit_reason: null });
  });

  it("opens the circuit without purging when an older delivered manifest is corrupt", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, exactCutoff);
    const first = await service().archiveEligible(now, 1);
    const tail = await service().archiveEligible(now, 1);
    if (first === null || tail === null) throw new Error("expected two archive manifests");
    await markDelivered(1);
    await env.ARCHIVE.put(first.objectKey, "older manifest corruption");

    await expect(service().archiveEligible(now, 1)).rejects.toThrow("archive_object_size_mismatch");

    expect((await env.DB.prepare("SELECT sequence FROM events ORDER BY sequence").all()).results)
      .toEqual([{ sequence: 1 }, { sequence: 2 }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count)
      .toBe(0);
    expect(await state()).toEqual({
      sealed_through: tail.endSequence,
      circuit_state: "open",
      circuit_reason: "archive_object_size_mismatch",
    });
  });

  it.each([
    [2, "before purge"],
    [3, "after purge"],
  ] as const)("defers publication when the reconciled seal advances %s", async (stateReadNumber) => {
    await appendEvents(3);
    for (const sequence of [1, 2, 3]) await setCreatedAt(sequence, exactCutoff);
    await markDelivered(1, 2);
    await service().archiveEligible(now, 1);
    let advanced = false;
    let guardedPuts = 0;
    const guarded = new ArchivalService({
      database: stateReadInterleavingDatabase(stateReadNumber, async () => {
        if (advanced) return;
        advanced = true;
        await expect(service(failBucketGet(3)).archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");
      }),
      bucket: {
        put: async (...args) => {
          guardedPuts += 1;
          return env.ARCHIVE.put(...args);
        },
        get: (...args) => env.ARCHIVE.get(...args),
      },
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("archive_reconciliation_unstable");
    expect(guardedPuts).toBe(0);
    expect(await state()).toEqual({ sealed_through: 2, circuit_state: "closed", circuit_reason: null });

    await expect(service().archiveEligible(now, 1)).resolves.toMatchObject({ startSequence: 3, endSequence: 3 });
    expect((await env.DB.prepare("SELECT event_sequence FROM archive_purge_receipts ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 1 }, { event_sequence: 2 }]);
    expect(await state()).toEqual({ sealed_through: 3, circuit_state: "closed", circuit_reason: null });
  });

  it("defers publication to a bounded retry when the seal advances before selection", async () => {
    await appendEvents(3);
    for (const sequence of [1, 2, 3]) await setCreatedAt(sequence, exactCutoff);
    await markDelivered(1, 2);
    await service().archiveEligible(now, 1);
    let advanced = false;
    let guardedPuts = 0;
    const guarded = new ArchivalService({
      database: stateReadInterleavingDatabase(4, async () => {
        if (advanced) return;
        advanced = true;
        await expect(service(failBucketGet(3)).archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");
      }),
      bucket: {
        put: async (...args) => {
          guardedPuts += 1;
          return env.ARCHIVE.put(...args);
        },
        get: (...args) => env.ARCHIVE.get(...args),
      },
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("archive_reconciliation_unstable");
    expect(guardedPuts).toBe(0);
    expect(await env.DB.prepare("SELECT 1 AS present FROM events WHERE sequence = 2").first()).not.toBeNull();
    expect(await state()).toEqual({ sealed_through: 2, circuit_state: "closed", circuit_reason: null });

    await expect(service().archiveEligible(now, 1)).resolves.toMatchObject({ startSequence: 3, endSequence: 3 });
    expect((await env.DB.prepare("SELECT event_sequence FROM archive_purge_receipts ORDER BY event_sequence").all()).results)
      .toEqual([{ event_sequence: 1 }, { event_sequence: 2 }]);
    expect(await state()).toEqual({ sealed_through: 3, circuit_state: "closed", circuit_reason: null });
  });

  it("keeps a sealed manifest retryable when post-seal coverage D1 is transiently unavailable", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    const guarded = new ArchivalService({
      database: postSealCoverageFailureDatabase(new Error("temporary_coverage_failure")),
      bucket: env.ARCHIVE,
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("archive_coverage_read_failed");

    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toEqual({ sealed_through: 1, circuit_state: "closed", circuit_reason: null });
  });

  it("publishes no new segment while sealed-tail reconciliation is unavailable", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, exactCutoff);
    await markDelivered(1);
    await expect(service(failBucketGet(2)).archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");
    let puts = 0;
    const unavailable = service({
      put: async (...args) => {
        puts += 1;
        return env.ARCHIVE.put(...args);
      },
      get: async () => { throw new Error("temporary_reconciliation_read_failure"); },
    });

    await expect(unavailable.archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");

    expect(puts).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toEqual({ sealed_through: 1, circuit_state: "closed", circuit_reason: null });
  });

  it("latches reconciliation corruption before publishing or purging", async () => {
    await appendEvents(2);
    await setCreatedAt(1, exactCutoff);
    await setCreatedAt(2, exactCutoff);
    await markDelivered(1);
    await expect(service(failBucketGet(2)).archiveEligible(now, 1)).rejects.toThrow("archive_object_read_failed");
    const stored = await env.DB.prepare(
      "SELECT object_key FROM archive_segments WHERE manifest_id = (SELECT manifest_id FROM archive_manifests WHERE end_sequence = 1)",
    ).first<{ object_key: string }>();
    if (stored === null) throw new Error("missing unsettled manifest fixture");
    await env.ARCHIVE.put(stored.object_key, "reconciliation corruption");
    let puts = 0;
    const guarded = service({
      put: async (...args) => {
        puts += 1;
        return env.ARCHIVE.put(...args);
      },
      get: (...args) => env.ARCHIVE.get(...args),
    });

    await expect(guarded.archiveEligible(now, 1)).rejects.toThrow("archive_object_size_mismatch");

    expect(puts).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_purge_receipts").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toMatchObject({ sealed_through: 1, circuit_state: "open" });
  });

  it("opens the circuit without sealing or purging when an existing object fails byte verification", async () => {
    const events = await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await markDelivered(1);
    const encoded = await encodeArchiveSegment(await events.readRange(0, 1));
    const key = `events/sha256/${encoded.compressedSha256}.ndjson.gz`;
    await env.ARCHIVE.put(key, "wrong bytes");

    await expect(service().archiveEligible(now, 1)).rejects.toThrow("archive_object_size_mismatch");

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

    await expect(service(corruptingBucket).archiveEligible(now, 1)).rejects.toThrow("archive_object_size_mismatch");

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

  it("classifies an invalid stored envelope as candidate corruption and latches the circuit", async () => {
    await appendEvents(1);
    await setCreatedAt(1, exactCutoff);
    await env.DB.prepare("UPDATE events SET envelope_json = '{}' WHERE sequence = 1").run();

    await expect(service().archiveEligible(now, 1)).rejects.toThrow("archive_envelope_invalid");

    expect((await env.ARCHIVE.list({ prefix: "events/sha256/" })).objects).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM archive_manifests").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toMatchObject({ sealed_through: 0, circuit_state: "open", circuit_reason: "archive_envelope_invalid" });
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
    })).rejects.toThrow("archive_object_size_mismatch");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>())?.count).toBe(0);
    expect(await state()).toMatchObject({ sealed_through: 1, circuit_state: "open" });
  });
});

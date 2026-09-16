import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createEnvelope,
  newUlid,
  sha256Hex,
  type PersistableEventEnvelopeV1,
  type RedactedJsonValue,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import {
  LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS,
  LITERAL_HISTORY_SEARCH_LIMITS,
  LiteralHistoryError,
  LiteralHistoryService,
} from "../../src/memory/literal-history.js";
import { EventRepository, type AppendedEvent } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { applyArchiveLiteralHistoryMigration } from "../persistence/migration.js";

const OWNER_ID = "principal:literal-history-owner";
const START = Date.parse("2026-09-15T22:00:00.000Z");
const redactor = new Redactor();
const DELETE_GUARDS = [
  "memory_cursors_delete_guard",
  "memory_event_suppression_lifts_immutable_delete",
  "memory_event_suppressions_immutable_delete",
  "memory_history_coverage_immutable_delete",
  "memory_literal_search_hits_delete_forbidden",
  "memory_literal_search_jobs_delete_forbidden",
] as const;

interface TestClock {
  now(): Date;
  advance(milliseconds?: number): string;
}

interface SuppressionFixture {
  readonly suppressionId: Ulid;
  readonly createdAt: string;
}

function queryCountingDatabase(): {
  readonly database: D1Database;
  queryCount(): number;
  reset(): void;
} {
  let count = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: async <T>(columnName?: string) => {
        count += 1;
        return columnName === undefined ? statement.first<T>() : statement.first<T>(columnName);
      },
      run: async <T>() => { count += 1; return statement.run<T>(); },
      all: async <T>() => { count += 1; return statement.all<T>(); },
      raw: async (options?: { columnNames?: boolean }) => {
        count += 1;
        return options?.columnNames === true ? statement.raw({ columnNames: true }) : statement.raw();
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
        return env.DB.batch<T>(statements.map((statement) => originals.get(statement as object) ?? statement));
      },
    } as D1Database,
    queryCount: () => count,
    reset: () => { count = 0; },
  };
}

function clock(): TestClock {
  let milliseconds = START;
  return {
    now: () => new Date(milliseconds),
    advance: (amount = 1_000) => {
      milliseconds += amount;
      return new Date(milliseconds).toISOString();
    },
  };
}

function service(events: EventRepository | TieredEventReader, time: TestClock): LiteralHistoryService {
  return new LiteralHistoryService({
    database: env.DB,
    events,
    archive: new ArchiveRepository(env.DB),
    now: time.now,
    nextId: () => newUlid(time.now()),
  });
}

function redactPayload(value: unknown): RedactedJsonValue {
  if (typeof value === "string") {
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) throw new Error("literal_history_fixture_redaction_failed");
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  if (typeof value !== "object") throw new Error("literal_history_fixture_payload_invalid");
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, redactPayload(child)]),
  );
}

async function appendEnvelope(
  events: EventRepository,
  envelope: PersistableEventEnvelopeV1,
  key: string,
): Promise<AppendedEvent> {
  return events.append({
    envelope,
    scope: "literal-history-test",
    key,
    requestHash: await sha256Hex(canonicalJson({ key })),
  });
}

async function appendConversation(
  events: EventRepository,
  time: TestClock,
  text: string,
  channelCode: 1 | 2 = 2,
  eventType: "conversation.user_committed" | "conversation.assistant_delivered" = "conversation.user_committed",
): Promise<AppendedEvent> {
  const occurredAt = time.advance();
  const eventId = newUlid(new Date(occurredAt));
  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType,
    source: "conversation",
    subjectId: OWNER_ID,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(new Date(Date.parse(occurredAt) + 1)),
    contentType: "application/json",
    payload: redactPayload({
      schemaCode: 1,
      channelCode,
      sensitivityCode: 1,
      historyEligible: true,
      text,
    }),
    producerVersion: "conversation-v1",
  });
  return appendEnvelope(events, envelope, `conversation:${eventId}`);
}

async function appendOwnerCommand(
  events: EventRepository,
  time: TestClock,
  payload: Readonly<Record<string, unknown>>,
): Promise<AppendedEvent> {
  const occurredAt = time.advance();
  const eventId = newUlid(new Date(occurredAt));
  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType: "memory.owner_command",
    source: "memory-control",
    subjectId: OWNER_ID,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: eventId,
    contentType: "application/json",
    payload: redactPayload(payload),
    producerVersion: "memory-control-v1",
  });
  return appendEnvelope(events, envelope, `owner-command:${eventId}`);
}

async function suppressEvent(
  events: EventRepository,
  time: TestClock,
  target: AppendedEvent,
): Promise<SuppressionFixture> {
  const suppressionId = newUlid(new Date(Date.parse(time.advance()) + 1));
  const command = await appendOwnerCommand(events, time, {
    operation: "history.suppress",
    targetId: suppressionId,
    targetEventId: target.envelope.eventId,
    startEventSequence: null,
    endEventSequence: null,
    newlyHiddenTurnCount: 1,
    totalCoveredTurnCount: 1,
  });
  const createdAt = command.envelope.occurredAt;
  await env.DB.prepare(`INSERT INTO memory_event_suppressions (
    suppression_id, principal_id, target_event_id, start_event_sequence,
    end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
    source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
  ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL,
    'owner requested literal-history suppression', 1, 1, ?)`)
    .bind(suppressionId, OWNER_ID, target.envelope.eventId, command.envelope.eventId, createdAt).run();
  return { suppressionId, createdAt };
}

async function liftSuppression(
  events: EventRepository,
  time: TestClock,
  suppression: SuppressionFixture,
): Promise<void> {
  const liftId = newUlid(new Date(Date.parse(time.advance()) + 1));
  const command = await appendOwnerCommand(events, time, {
    operation: "history.lift",
    targetId: liftId,
    suppressionId: suppression.suppressionId,
  });
  await env.DB.prepare(`INSERT INTO memory_event_suppression_lifts (
    lift_id, principal_id, suppression_id, owner_authorizing_event_id,
    correction_transition_id, reason, created_at
  ) VALUES (?, ?, ?, ?, NULL, 'owner restored literal history', ?)`)
    .bind(
      liftId,
      OWNER_ID,
      suppression.suppressionId,
      command.envelope.eventId,
      command.envelope.occurredAt,
    ).run();
}

async function archiveEvent(events: EventRepository, event: AppendedEvent): Promise<{
  readonly archive: ArchivalService;
  readonly manifest: NonNullable<Awaited<ReturnType<ArchivalService["archiveEligible"]>>>;
}> {
  await env.DB.batch([
    env.DB.prepare("UPDATE events SET created_at = ? WHERE sequence = ?")
      .bind("2026-01-01T00:00:00.000Z", event.eventSequence),
    env.DB.prepare(`UPDATE outbox SET status = 'delivered', delivered_at = ?
      WHERE event_sequence = ?`).bind("2026-01-02T00:00:00.000Z", event.eventSequence),
  ]);
  const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
  const manifest = await archive.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 24);
  if (manifest === null) throw new Error("literal_history_archive_fixture_missing");
  return { archive, manifest };
}

async function resetLiteralHistoryFixture(): Promise<void> {
  const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (${DELETE_GUARDS.map(() => "?").join(", ")})`)
    .bind(...DELETE_GUARDS).all<{ name: string; sql: string }>();
  if (guards.results.length !== DELETE_GUARDS.length) {
    throw new Error("literal_history_test_delete_guard_missing");
  }
  for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER ${guard.name}`).run();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memory_literal_search_hits"),
      env.DB.prepare("DELETE FROM memory_literal_search_jobs"),
      env.DB.prepare("DELETE FROM memory_event_suppression_lifts"),
      env.DB.prepare("DELETE FROM memory_event_suppressions"),
      env.DB.prepare("DELETE FROM memory_history_chunks"),
      env.DB.prepare("DELETE FROM memory_history_coverage"),
      env.DB.prepare("DELETE FROM memory_cursors WHERE cursor_name = 'fts_history'"),
    ]);
  } finally {
    for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
  }
  await resetArchiveFixture();
}

beforeAll(async () => {
  await applyArchiveLiteralHistoryMigration();
  const timestamp = new Date(START).toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'Literal history owner', ?, ?)`)
    .bind(OWNER_ID, timestamp, timestamp).run();
});

beforeEach(resetLiteralHistoryFixture);

describe("LiteralHistoryService", () => {
  it("reports an exact missing range until live coverage is complete, then returns exact provenance", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    const first = await appendConversation(events, time, "The quartz notebook is in the blue cabinet.", 1);
    await appendConversation(events, time, "The ordinary notebook is on the desk.");
    const literal = service(events, time);

    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "quartz" }))
      .resolves.toMatchObject({
        status: "incomplete",
        hits: [],
        searchedThroughEventSequence: 0,
        missingRange: { startEventSequence: 1, endEventSequence: 2 },
      });
    await expect(literal.indexNext({
      principalId: OWNER_ID,
      maxEvents: 16,
      maxTextBytes: 262_144,
    })).resolves.toMatchObject({ complete: true, chunksWritten: 2 });

    const found = await literal.searchLiteral({ principalId: OWNER_ID, query: "quartz" });
    expect(found).toEqual({
      status: "hits",
      hits: [{
        eventId: first.envelope.eventId,
        eventSequence: first.eventSequence,
        occurredAt: first.envelope.occurredAt,
        channel: "voice",
        sourceLocation: "live",
        r2SegmentId: null,
        excerpt: "The quartz notebook is in the blue cabinet.",
        excerptHash: await sha256Hex("The quartz notebook is in the blue cabinet."),
      }],
      searchedThroughEventSequence: 2,
    });
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "obsidian" }))
      .resolves.toEqual({ status: "no_hit", hits: [], searchedThroughEventSequence: 2 });
  });

  it("keeps the maximum interactive literal search inside its declared D1 statement budget", async () => {
    const time = clock();
    const live = new EventRepository(env.DB);
    for (let index = 0; index < LITERAL_HISTORY_SEARCH_LIMITS.resultsExamined; index += 1) {
      await appendConversation(live, time, `Budget quartz event ${index}.`);
    }
    await service(live, time).indexNext({
      principalId: OWNER_ID,
      maxEvents: 16,
      maxTextBytes: 262_144,
    });
    const counted = queryCountingDatabase();
    const tiered = new TieredEventReader({
      live: new EventRepository(counted.database),
      archive: new ArchivalService({ database: counted.database, bucket: env.ARCHIVE }),
      state: new ArchiveRepository(counted.database),
    });
    const literal = new LiteralHistoryService({
      database: counted.database,
      events: tiered,
      archive: new ArchiveRepository(counted.database),
      now: time.now,
      nextId: () => newUlid(time.now()),
    });
    counted.reset();

    const result = await literal.searchLiteral({
      principalId: OWNER_ID,
      query: "quartz",
      maxResults: LITERAL_HISTORY_SEARCH_LIMITS.resultsExamined,
    });

    expect(result).toMatchObject({
      status: "hits",
      hits: { length: LITERAL_HISTORY_SEARCH_LIMITS.resultsExamined },
    });
    expect(LITERAL_HISTORY_SEARCH_LIMITS.d1Statements).toBe(62);
    expect(counted.queryCount()).toBeLessThanOrEqual(LITERAL_HISTORY_SEARCH_LIMITS.d1Statements);
  });

  it("advances indexing when the wall clock moves behind the stored cursor timestamp", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    await appendConversation(events, time, "The first clock-floor event.");
    const literal = service(events, time);
    await literal.indexNext({ principalId: OWNER_ID, maxEvents: 1 });
    const firstCursor = await env.DB.prepare(`SELECT updated_at FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'fts_history'`)
      .bind(OWNER_ID).first<string>("updated_at");
    await appendConversation(events, time, "The second clock-floor event.");
    time.advance(-5_000);

    await expect(literal.indexNext({ principalId: OWNER_ID, maxEvents: 1 }))
      .resolves.toMatchObject({ endEventSequence: 2, eventsExamined: 1 });
    const cursor = await env.DB.prepare(`SELECT current_event_sequence, updated_at
      FROM memory_cursors WHERE principal_id = ? AND cursor_name = 'fts_history'`)
      .bind(OWNER_ID).first<{ current_event_sequence: number; updated_at: string }>();
    expect(cursor).toEqual({ current_event_sequence: 2, updated_at: firstCursor });
  });

  it("refuses a no-hit answer when the coverage cursor is ahead of tiered history", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    await env.DB.prepare(`INSERT INTO memory_cursors (
      principal_id, cursor_name, current_event_sequence, updated_at
    ) VALUES (?, 'fts_history', 1, ?)`)
      .bind(OWNER_ID, time.now().toISOString()).run();
    const literal = service(events, time);

    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "absent" }))
      .rejects.toEqual(new LiteralHistoryError("memory_history_corrupt"));
    await expect(literal.indexNext({ principalId: OWNER_ID }))
      .rejects.toEqual(new LiteralHistoryError("memory_history_corrupt"));
  });

  it("keeps the matched token inside a bounded multibyte excerpt", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    await appendConversation(events, time, `${"界".repeat(600)} quartz ${"界".repeat(600)}`);
    const literal = service(events, time);
    await literal.indexNext({ principalId: OWNER_ID, maxEvents: 16, maxTextBytes: 262_144 });

    const result = await literal.searchLiteral({ principalId: OWNER_ID, query: "quartz" });

    expect(result.status).toBe("hits");
    if (result.status !== "hits") throw new Error("literal_history_expected_multibyte_hit");
    expect(result.hits[0]?.excerpt).toContain("quartz");
    expect(new TextEncoder().encode(result.hits[0]?.excerpt).byteLength).toBeLessThanOrEqual(1_024);
  });

  it("keeps an active suppression out of chunks, FTS, and results, then reindexes it after a lift", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    const target = await appendConversation(events, time, "The cobalt phrase must disappear.");
    const suppression = await suppressEvent(events, time, target);
    const literal = service(events, time);

    await literal.indexNext({ principalId: OWNER_ID, maxEvents: 16, maxTextBytes: 262_144 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_history_chunks
      WHERE principal_id = ?`).bind(OWNER_ID).first("count")).toBe(0);
    const coverage = await env.DB.prepare(`SELECT source_location, r2_segment_id, content_hash
      FROM memory_history_coverage WHERE principal_id = ?
        AND start_event_sequence = ? AND end_event_sequence = ?
      ORDER BY indexed_at DESC LIMIT 1`).bind(OWNER_ID, target.eventSequence, target.eventSequence)
      .first<{ source_location: string; r2_segment_id: string | null; content_hash: string }>();
    if (coverage === null) throw new Error("literal_history_suppressed_coverage_missing");
    await expect(env.DB.prepare(`INSERT INTO memory_history_chunks (
      chunk_id, principal_id, start_event_sequence, end_event_sequence, text,
      content_hash, source_location, r2_segment_id, source_receipt_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        newUlid(time.now()),
        OWNER_ID,
        target.eventSequence,
        target.eventSequence,
        "The cobalt phrase must disappear.",
        await sha256Hex("The cobalt phrase must disappear."),
        coverage.source_location,
        coverage.r2_segment_id,
        coverage.content_hash,
        time.now().toISOString(),
        time.now().toISOString(),
      ).run()).rejects.toThrow(/memory_history_chunk_receipt_invalid/u);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_history_fts
      WHERE memory_history_fts MATCH 'cobalt'`).first("count")).toBe(0);
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "cobalt" }))
      .resolves.toEqual({
        status: "no_hit",
        hits: [],
        searchedThroughEventSequence: 2,
      });

    await liftSuppression(events, time, suppression);
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "cobalt" }))
      .resolves.toMatchObject({ status: "incomplete" });
    await expect(literal.indexNext({ principalId: OWNER_ID, maxEvents: 16, maxTextBytes: 262_144 }))
      .resolves.toMatchObject({ refreshed: true, startEventSequence: target.eventSequence, chunksWritten: 1 });
    await literal.indexNext({ principalId: OWNER_ID, maxEvents: 16, maxTextBytes: 262_144 });
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "cobalt" }))
      .resolves.toMatchObject({ status: "hits", hits: [{ eventId: target.envelope.eventId }] });
  });

  it("keeps suppressed text out of exhaustive receipts and requires a new walk after a lift", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    const target = await appendConversation(events, time, "The hidden indigo phrase is exact.");
    const suppression = await suppressEvent(events, time, target);
    const literal = service(events, time);
    const hiddenJobId = newUlid(time.now());
    await literal.createExhaustiveSearch({
      principalId: OWNER_ID,
      jobId: hiddenJobId,
      jobKey: "indigo-hidden",
      query: "indigo",
    });
    await env.DB.prepare(`UPDATE memory_literal_search_jobs
      SET status = 'running', updated_at = ? WHERE principal_id = ? AND job_id = ?`)
      .bind(time.advance(), OWNER_ID, hiddenJobId).run();
    await expect(env.DB.prepare(`INSERT INTO memory_literal_search_hits (
      principal_id, job_id, event_sequence, event_id, content_hash, found_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        OWNER_ID,
        hiddenJobId,
        target.eventSequence,
        target.envelope.eventId,
        target.envelope.contentHash,
        time.now().toISOString(),
      ).run()).rejects.toThrow(/memory_literal_search_hit_receipt_invalid/u);
    await literal.runExhaustiveSearchStep({
      principalId: OWNER_ID,
      jobId: hiddenJobId,
      maxEvents: 16,
      maxTextBytes: 262_144,
    });
    await expect(literal.readExhaustiveSearchResult({ principalId: OWNER_ID, jobId: hiddenJobId }))
      .resolves.toEqual({ status: "no_hit", hits: [], searchedThroughEventSequence: 2 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_literal_search_hits
      WHERE principal_id = ? AND job_id = ?`).bind(OWNER_ID, hiddenJobId).first("count")).toBe(0);

    await liftSuppression(events, time, suppression);
    await expect(literal.readExhaustiveSearchResult({ principalId: OWNER_ID, jobId: hiddenJobId }))
      .resolves.toMatchObject({
        status: "incomplete",
        missingRange: { startEventSequence: 3, endEventSequence: 3 },
      });
    const restoredJobId = newUlid(new Date(time.advance()));
    await literal.createExhaustiveSearch({
      principalId: OWNER_ID,
      jobId: restoredJobId,
      jobKey: "indigo-restored",
      query: "indigo",
    });
    await literal.runExhaustiveSearchStep({
      principalId: OWNER_ID,
      jobId: restoredJobId,
      maxEvents: 16,
      maxTextBytes: 262_144,
    });
    await expect(literal.readExhaustiveSearchResult({ principalId: OWNER_ID, jobId: restoredJobId }))
      .resolves.toMatchObject({ status: "hits", hits: [{ eventId: target.envelope.eventId }] });
  });

  it("reads exact history through the verified R2 tier after the live row is purged", async () => {
    const time = clock();
    const live = new EventRepository(env.DB);
    const target = await appendConversation(live, time, "The archived zircon receipt is exact.");
    const { archive, manifest } = await archiveEvent(live, target);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM events").first("count")).toBe(0);
    const tiered = new TieredEventReader({ live, archive, state: new ArchiveRepository(env.DB) });
    const literal = service(tiered, time);

    await literal.indexNext({ principalId: OWNER_ID, maxEvents: 16, maxTextBytes: 262_144 });
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "zircon" }))
      .resolves.toMatchObject({
        status: "hits",
        hits: [{
          eventId: target.envelope.eventId,
          sourceLocation: "archived",
          r2SegmentId: manifest.compressedSha256,
          excerpt: "The archived zircon receipt is exact.",
        }],
      });
  });

  it("fails one indexing batch when archival wins the source-location race and recovers on retry", async () => {
    const time = clock();
    const live = new EventRepository(env.DB);
    const target = await appendConversation(live, time, "The racing archive receipt is exact.");
    await env.DB.batch([
      env.DB.prepare("UPDATE events SET created_at = ? WHERE sequence = ?")
        .bind("2026-01-01T00:00:00.000Z", target.eventSequence),
      env.DB.prepare(`UPDATE outbox SET status = 'delivered', delivered_at = ?
        WHERE event_sequence = ?`).bind("2026-01-02T00:00:00.000Z", target.eventSequence),
    ]);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    let racePending = true;
    const racingDatabase = {
      prepare: (query: string) => env.DB.prepare(query),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        if (racePending) {
          racePending = false;
          const manifest = await archive.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 24);
          if (manifest === null) throw new Error("literal_history_race_archive_missing");
        }
        return env.DB.batch<T>(statements);
      },
    } as D1Database;
    const racing = new LiteralHistoryService({
      database: racingDatabase,
      events: live,
      archive: new ArchiveRepository(env.DB),
      now: time.now,
      nextId: () => newUlid(time.now()),
    });

    await expect(racing.indexNext({ principalId: OWNER_ID, maxEvents: 1 }))
      .rejects.toEqual(new LiteralHistoryError("memory_history_unavailable"));
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'fts_history'`)
      .bind(OWNER_ID).first("count")).toBe(0);

    const tiered = new TieredEventReader({
      live,
      archive,
      state: new ArchiveRepository(env.DB),
    });
    await expect(service(tiered, time).indexNext({ principalId: OWNER_ID, maxEvents: 1 }))
      .resolves.toMatchObject({
        startEventSequence: target.eventSequence,
        endEventSequence: target.eventSequence,
        chunksWritten: 1,
      });
  });

  it("advances complete literal coverage across every verified R2 segment", async () => {
    const time = clock();
    const live = new EventRepository(env.DB);
    const first = await appendConversation(live, time, "The first archived meteor receipt.");
    const firstArchive = await archiveEvent(live, first);
    const second = await appendConversation(live, time, "The second archived opal receipt.");
    const secondArchive = await archiveEvent(live, second);
    expect(secondArchive.manifest.compressedSha256).not.toBe(firstArchive.manifest.compressedSha256);
    const tiered = new TieredEventReader({
      live,
      archive: secondArchive.archive,
      state: new ArchiveRepository(env.DB),
    });
    const literal = service(tiered, time);

    await expect(literal.indexNext({ principalId: OWNER_ID, maxEvents: 16, maxTextBytes: 262_144 }))
      .resolves.toMatchObject({ endEventSequence: first.eventSequence, complete: false });
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "opal" }))
      .resolves.toMatchObject({
        status: "incomplete",
        missingRange: {
          startEventSequence: second.eventSequence,
          endEventSequence: second.eventSequence,
        },
      });
    await expect(literal.indexNext({ principalId: OWNER_ID, maxEvents: 16, maxTextBytes: 262_144 }))
      .resolves.toMatchObject({ endEventSequence: second.eventSequence, complete: true });
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "meteor" }))
      .resolves.toMatchObject({
        status: "hits",
        hits: [{
          eventId: first.envelope.eventId,
          r2SegmentId: firstArchive.manifest.compressedSha256,
        }],
      });
    await expect(literal.searchLiteral({ principalId: OWNER_ID, query: "opal" }))
      .resolves.toMatchObject({
        status: "hits",
        hits: [{
          eventId: second.envelope.eventId,
          r2SegmentId: secondArchive.manifest.compressedSha256,
        }],
      });
  });

  it("refuses corrupt R2 bytes without advancing literal-history coverage", async () => {
    const time = clock();
    const live = new EventRepository(env.DB);
    const target = await appendConversation(live, time, "The archived garnet receipt must verify.");
    const { archive, manifest } = await archiveEvent(live, target);
    await env.ARCHIVE.put(manifest.objectKey, new TextEncoder().encode("corrupt archive bytes"));
    const tiered = new TieredEventReader({ live, archive, state: new ArchiveRepository(env.DB) });
    const literal = service(tiered, time);

    await expect(literal.indexNext({ principalId: OWNER_ID }))
      .rejects.toEqual(new LiteralHistoryError("memory_history_unavailable"));
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_cursors
      WHERE principal_id = ? AND cursor_name = 'fts_history'`).bind(OWNER_ID).first("count")).toBe(0);
  });

  it("checkpoints and resumes an exhaustive walk in bounded one-event steps", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    await appendConversation(events, time, "First amber entry.");
    await appendConversation(events, time, "Second neutral entry.");
    await appendConversation(events, time, "Third amber entry.");
    const jobId = newUlid(time.now());
    const firstService = service(events, time);
    await firstService.createExhaustiveSearch({
      principalId: OWNER_ID,
      jobId,
      jobKey: "amber-resume",
      query: "amber",
    });

    const first = await firstService.runExhaustiveSearchStep({
      principalId: OWNER_ID,
      jobId,
      maxEvents: 1,
      maxTextBytes: 32_768,
    });
    expect(first.job).toMatchObject({ status: "running", checkpointEventSequence: 1 });
    expect(first.budget).toMatchObject({ eventsExamined: 1 });

    const resumed = service(events, time);
    await resumed.runExhaustiveSearchStep({
      principalId: OWNER_ID,
      jobId,
      maxEvents: 1,
      maxTextBytes: 32_768,
    });
    const final = await resumed.runExhaustiveSearchStep({
      principalId: OWNER_ID,
      jobId,
      maxEvents: 1,
      maxTextBytes: 32_768,
    });
    expect(final.job).toMatchObject({
      status: "succeeded",
      checkpointEventSequence: 3,
      scannedEventCount: 3,
      matchedEventCount: 2,
    });
    await expect(resumed.readExhaustiveSearchResult({ principalId: OWNER_ID, jobId }))
      .resolves.toMatchObject({ status: "hits", hits: [{ eventSequence: 3 }, { eventSequence: 1 }] });
  });

  it("fails an unrecoverable exhaustive step and starts a new attempt for the same job key", async () => {
    const time = clock();
    const live = new EventRepository(env.DB);
    await appendConversation(live, time, "The corrupt walk source exists.");
    const unavailableEvents = {
      latestSequence: () => live.latestSequence(),
      readRange: async () => [],
    };
    const literal = new LiteralHistoryService({
      database: env.DB,
      events: unavailableEvents,
      archive: new ArchiveRepository(env.DB),
      now: time.now,
      nextId: () => newUlid(time.now()),
    });
    const firstJobId = newUlid(time.now());
    await literal.createExhaustiveSearch({
      principalId: OWNER_ID,
      jobId: firstJobId,
      jobKey: "retry-corrupt-walk",
      query: "corrupt",
    });

    await expect(literal.runExhaustiveSearchStep({
      principalId: OWNER_ID,
      jobId: firstJobId,
    })).rejects.toEqual(new LiteralHistoryError("memory_history_corrupt"));
    expect(await env.DB.prepare(`SELECT status, failure_code FROM memory_literal_search_jobs
      WHERE principal_id = ? AND job_id = ?`).bind(OWNER_ID, firstJobId).first())
      .toEqual({ status: "failed", failure_code: "history_step_corrupt" });

    const replacementJobId = newUlid(new Date(time.advance()));
    await expect(literal.createExhaustiveSearch({
      principalId: OWNER_ID,
      jobId: replacementJobId,
      jobKey: "retry-corrupt-walk",
      query: "corrupt",
    })).resolves.toMatchObject({
      jobId: replacementJobId,
      attempt: 2,
      status: "pending",
    });
  });

  it("counts the worst-case exhaustive step inside the declared D1 and CPU budgets", async () => {
    const time = clock();
    const events = new EventRepository(env.DB);
    for (let index = 0; index < LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.eventsExamined; index += 1) {
      await appendConversation(events, time, `Budget needle event ${index}.`);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE events SET created_at = '2026-01-01T00:00:00.000Z'"),
      env.DB.prepare(`UPDATE outbox SET status = 'delivered',
        delivered_at = '2026-01-02T00:00:00.000Z'`),
    ]);
    const archive = new ArchivalService({ database: env.DB, bucket: env.ARCHIVE });
    await expect(archive.archiveEligible(new Date("2026-12-01T00:00:00.000Z"), 24))
      .resolves.not.toBeNull();
    const indexedTiered = new TieredEventReader({
      live: events,
      archive,
      state: new ArchiveRepository(env.DB),
    });
    await service(indexedTiered, time).indexNext({
      principalId: OWNER_ID,
      maxEvents: 16,
      maxTextBytes: 262_144,
    });
    const counted = queryCountingDatabase();
    const countedArchive = new ArchivalService({ database: counted.database, bucket: env.ARCHIVE });
    const tiered = new TieredEventReader({
      live: new EventRepository(counted.database),
      archive: countedArchive,
      state: new ArchiveRepository(counted.database),
    });
    const jobId = newUlid(time.now());
    const literal = new LiteralHistoryService({
      database: counted.database,
      events: tiered,
      archive: new ArchiveRepository(counted.database),
      now: time.now,
      nextId: () => newUlid(time.now()),
    });
    await literal.createExhaustiveSearch({
      principalId: OWNER_ID,
      jobId,
      jobKey: "budget-ceiling",
      query: "needle",
    });
    counted.reset();

    const step = await literal.runExhaustiveSearchStep({
      principalId: OWNER_ID,
      jobId,
      maxEvents: 16,
      maxTextBytes: LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.textBytesExamined,
    });
    expect(step.job.status).toBe("succeeded");
    expect(step.budget.d1Statements).toBe(LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.d1Statements);
    expect(counted.queryCount()).toBeLessThanOrEqual(step.budget.d1Statements);
    expect(step.budget.eventsExamined).toBe(LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.eventsExamined);
    expect(step.budget.textBytesExamined).toBeLessThanOrEqual(
      LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.textBytesExamined,
    );
    await appendConversation(events, time, "A later needle event is outside the snapshot.");
    await expect(literal.readExhaustiveSearchResult({ principalId: OWNER_ID, jobId, maxResults: 8 }))
      .resolves.toMatchObject({
        status: "incomplete",
        searchedThroughEventSequence: LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.eventsExamined,
        missingRange: {
          startEventSequence: LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.eventsExamined + 1,
          endEventSequence: LITERAL_HISTORY_EXHAUSTIVE_STEP_LIMITS.eventsExamined + 1,
        },
      });
  });
});

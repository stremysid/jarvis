import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  newUlid,
  sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  MemoryOwnerControlsService,
  type CorrectMemoryInput,
  type RememberMemoryInput,
} from "../../src/memory/memory-owner-controls.js";
import {
  createMemoryRepositoryForTest,
  MemoryRepository,
} from "../../src/memory/memory-repository.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { encodeArchiveSegment } from "../../src/archive/segment-codec.js";
import { EventRepository, type AppendedEvent } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  MemoryRepositoryError,
  type CanonicalMemoryItem,
  type MemoryControlIntent,
  type MemoryKind,
  type MemoryOwnerTurnInput,
  type MemoryRepositoryErrorCode,
} from "../../src/memory/memory-types.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";

const OWNER_ID = "principal:memory-owner-controls";
let eventClock = Date.now() + 10_000;

interface SeededTurn {
  readonly input: MemoryOwnerTurnInput;
  readonly text: string;
}

async function seedPrincipal(
  principalId: string,
  principalType: "human" | "service",
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, ?, 'active', 'memory controls test', ?, ?)`).bind(
    principalId,
    principalType,
    now,
    now,
  ).run();
}

async function seedTurn(
  text: string,
  options: Readonly<{
    principalId?: string;
    channelCode?: 1 | 2;
    memoryIntent?: MemoryControlIntent | null;
  }> = {},
): Promise<SeededTurn> {
  eventClock += 10;
  const principalId = options.principalId ?? OWNER_ID;
  const eventType = "conversation.user_committed";
  const channelCode = options.channelCode ?? 2;
  const eventId = newUlid(new Date(eventClock));
  const occurredAt = new Date(eventClock).toISOString();
  const payload = {
    schemaCode: 1,
    channelCode,
    sensitivityCode: 1,
    historyEligible: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    eventType,
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(new Date(eventClock + 1)),
    contentType: "application/json",
    contentHash,
    payload,
    redaction: { status: "none", markers: [] },
    producerVersion: "conversation-v1",
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?)`).bind(
    eventId,
    eventType,
    principalId,
    occurredAt,
    occurredAt,
    contentHash,
    canonicalJson(envelope),
    occurredAt,
  ).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_owner_turn_missing");
  return {
    text,
    input: Object.freeze({
      principalId,
      eventId,
      eventSequence: row.sequence,
      occurredAt,
      channel: channelCode === 1 ? "voice" : "telegram",
      memoryIntent: options.memoryIntent === undefined ? "remember" : options.memoryIntent,
      forwarded: false,
      quoted: false,
      pasted: false,
      hasAttachment: false,
      modelGenerated: false,
      toolGenerated: false,
      guest: false,
    }),
  };
}

function rememberInput(turn: SeededTurn, text: string): RememberMemoryInput {
  return Object.freeze({
    ownerTurn: turn.input,
    text,
    kind: "preference",
    sensitivity: "normal",
  });
}

function correctInput(
  turn: SeededTurn,
  text: string,
  supersededItemId: Ulid,
  options: Readonly<{
    kind?: MemoryKind;
    sensitivity?: "normal" | "sensitive";
    sourceExcerpt?: string;
    normalizedFromSource?: boolean;
    ownerTurn?: MemoryOwnerTurnInput;
  }> = {},
): CorrectMemoryInput {
  return Object.freeze({
    ownerTurn: options.ownerTurn ?? turn.input,
    candidateItemIds: Object.freeze([supersededItemId]),
    text,
    kind: options.kind ?? "preference",
    sensitivity: options.sensitivity ?? "normal",
    ...(options.sourceExcerpt === undefined ? {} : { sourceExcerpt: options.sourceExcerpt }),
    ...(options.normalizedFromSource === undefined
      ? {}
      : { normalizedFromSource: options.normalizedFromSource }),
  });
}

/** The exact gate every recall path shares: the retrievable-version view. */
async function retrievableTexts(itemIds: readonly Ulid[]): Promise<readonly string[]> {
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`SELECT text FROM memory_retrievable_item_versions
    WHERE item_id IN (${placeholders}) ORDER BY text`).bind(...itemIds)
    .all<{ text: string }>();
  return rows.results.map((row) => row.text);
}

/**
 * Records which statements share a D1 batch. A batch is the only transaction
 * primitive here, so this is how a test can tell "committed together" from
 * "committed one after the other".
 */
function trackingDatabase(database: D1Database): Readonly<{
  readonly database: D1Database;
  batchesContainingAll(needles: readonly string[]): number;
}> {
  const sqlByStatement = new WeakMap<object, string>();
  const batches: string[][] = [];
  // bind() returns a different statement object from the prepared one, and the
  // repository always binds, so the bound object has to be recorded too.
  const track = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    sqlByStatement.set(statement as object, sql);
    const wrapped = new Proxy(statement as object, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "bind" && typeof value === "function") {
          return (...values: unknown[]) => track(
            (value as (...args: unknown[]) => D1PreparedStatement).apply(target, values),
            sql,
          );
        }
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as D1PreparedStatement;
    // The repository stores and batches the wrapper, so both identities have to
    // resolve to the same SQL.
    sqlByStatement.set(wrapped as object, sql);
    return wrapped;
  };
  const proxy = new Proxy(database as object, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => track((target as D1Database).prepare(sql), sql);
      }
      if (property === "batch") {
        return (statements: readonly D1PreparedStatement[]) => {
          batches.push(statements.map((statement) => sqlByStatement.get(statement as object) ?? ""));
          return (target as D1Database).batch([...statements]);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as D1Database;
  return Object.freeze({
    database: proxy,
    batchesContainingAll: (needles: readonly string[]) => batches.filter((batch) =>
      needles.every((needle) => batch.some((sql) => sql.includes(needle)))).length,
  });
}

async function currentState(itemId: Ulid): Promise<Readonly<{
  lifecycleState: string;
  versionNumber: number;
  text: string;
}>> {
  const row = await env.DB.prepare(`SELECT state.lifecycle_state, version.version_number, version.text
    FROM memory_item_state state
    JOIN memory_item_versions version ON version.principal_id = state.principal_id
      AND version.version_id = state.current_version_id
    WHERE state.item_id = ?`).bind(itemId)
    .first<{ lifecycle_state: string; version_number: number; text: string }>();
  if (row === null) throw new Error("memory_owner_controls_item_missing");
  return Object.freeze({
    lifecycleState: row.lifecycle_state,
    versionNumber: row.version_number,
    text: row.text,
  });
}

async function commitItemFromTurn(
  turn: SeededTurn,
  text: string,
  options: Readonly<{
    lifecycleState?: "active" | "proposed";
    origin?: "authenticated_first_person" | "model";
  }> = {},
): Promise<CanonicalMemoryItem> {
  const repository = new MemoryRepository(env.DB);
  const topics = await repository.bootstrapTopics(OWNER_ID);
  const lifecycleState = options.lifecycleState ?? "active";
  const origin = options.origin ?? "authenticated_first_person";
  const result = await repository.commitInitialItem({
    principalId: OWNER_ID,
    itemId: newUlid(),
    kind: "preference",
    creationEventId: turn.input.eventId,
    creationEventSequence: turn.input.eventSequence,
    version: {
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: origin === "model" ? "inferred" : "stated",
      origin,
      uncertain: origin === "model",
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "memory-owner-controls-test-v1",
      extractorModelId: origin === "model" ? "openai:test-model" : null,
    },
    sources: [{
      sourceId: newUlid(),
      eventId: turn.input.eventId,
      eventSequence: turn.input.eventSequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: turn.input.channel,
      occurredAt: turn.input.occurredAt,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState,
      reason: "test fixture uses a verified source",
      policyVersion: "memory-owner-controls-test-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule",
      confidence: 0.4,
      reason: "test fixture starts in the explicit inbox",
    },
  });
  return result.item;
}

async function expectCode(
  promise: Promise<unknown>,
  code: MemoryRepositoryErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryRepositoryError);
    expect((error as MemoryRepositoryError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return;
  }
  throw new Error(`expected_memory_owner_control_error:${code}`);
}

async function commandCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM events WHERE event_type = 'memory.owner_command'",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

async function archiveAndPurgeTurn(turn: SeededTurn): Promise<void> {
  const stored = await env.DB.prepare(`SELECT envelope_json, content_hash FROM events
    WHERE sequence = ? AND event_id = ?`).bind(turn.input.eventSequence, turn.input.eventId)
    .first<{ envelope_json: string; content_hash: string }>();
  if (stored === null) throw new Error("memory_owner_archive_source_missing");
  const envelope = {
    ...(JSON.parse(stored.envelope_json) as AppendedEvent["envelope"]),
    eventSequence: turn.input.eventSequence,
  };
  const event: AppendedEvent = {
    eventSequence: turn.input.eventSequence,
    envelope,
    replayed: true,
  };
  const encoded = await encodeArchiveSegment([event]);
  const objectKey = `events/sha256/${encoded.compressedSha256}.ndjson.gz`;
  await env.ARCHIVE.put(objectKey, encoded.compressedBytes, {
    sha256: encoded.compressedSha256,
  });
  const guardNames = [
    "archive_manifests_require_next_range",
    "archive_state_advance_guard",
  ] as const;
  const guards = await env.DB.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (?, ?)`)
    .bind(...guardNames).all<{ name: string; sql: string }>();
  if (guards.results.length !== guardNames.length) {
    throw new Error("memory_owner_archive_guard_missing");
  }
  for (const guard of guards.results) await env.DB.prepare(`DROP TRIGGER ${guard.name}`).run();
  const archivedAt = new Date(eventClock + 1_000).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO archive_manifests (
        manifest_id, start_sequence, end_sequence, event_count, status, created_at, sealed_at
      ) VALUES (?, ?, ?, 1, 'sealed', ?, ?)`)
        .bind(
          encoded.compressedSha256,
          turn.input.eventSequence,
          turn.input.eventSequence,
          archivedAt,
          archivedAt,
        ),
      env.DB.prepare(`INSERT INTO archive_segments (
        segment_id, manifest_id, object_key, compressed_sha256,
        compressed_byte_length, uncompressed_byte_length, codec, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'jarvis-gzip-ndjson-v1', ?)`)
        .bind(
          encoded.compressedSha256,
          encoded.compressedSha256,
          objectKey,
          encoded.compressedSha256,
          encoded.compressedBytes.byteLength,
          encoded.uncompressedByteLength,
          archivedAt,
        ),
      env.DB.prepare(`INSERT INTO archive_segment_events (
        event_sequence, event_id, segment_id, envelope_sha256, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          turn.input.eventSequence,
          turn.input.eventId,
          encoded.compressedSha256,
          await sha256Hex(canonicalJson(envelope)),
          stored.content_hash,
          archivedAt,
        ),
      env.DB.prepare(`UPDATE archive_state
        SET sealed_through = ?, updated_at = ? WHERE singleton = 1`)
        .bind(turn.input.eventSequence, archivedAt),
      env.DB.prepare(`INSERT INTO outbox (
        outbox_id, event_sequence, topic, status, attempts,
        available_at, delivered_at, created_at
      ) VALUES (?, ?, 'memory-owner-controls-test', 'delivered', 1, ?, ?, ?)`)
        .bind(newUlid(), turn.input.eventSequence, archivedAt, archivedAt, archivedAt),
    ]);
  } finally {
    for (const guard of guards.results) await env.DB.prepare(guard.sql).run();
  }
  await new ArchiveRepository(env.DB).purgeDelivered({
    manifestId: encoded.compressedSha256,
    startSequence: turn.input.eventSequence,
    endSequence: turn.input.eventSequence,
    eventCount: 1,
    objectKey,
    compressedSha256: encoded.compressedSha256,
    compressedByteLength: encoded.compressedBytes.byteLength,
    uncompressedByteLength: encoded.uncompressedByteLength,
    sealedAt: archivedAt,
  }, archivedAt);
}

beforeAll(async () => {
  await applyMemoryIngressMigration();
  await seedPrincipal(OWNER_ID, "human");
});

describe("MemoryOwnerControlsService", () => {
  it("refuses to promote a model-inferred proposal through the free-text confirm service", async () => {
    const sourceTurn = await seedTurn("I might prefer violet layouts.");
    const proposed = await commitItemFromTurn(sourceTurn, sourceTurn.text, {
      lifecycleState: "proposed",
      origin: "model",
    });
    const confirmTurn = await seedTurn("yes, confirm that", { memoryIntent: "confirm" });

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).confirm({
      ownerTurn: confirmTurn.input,
      candidateItemIds: [proposed.itemId],
      sourceExcerpt: "yes",
    }), "memory_refused");
    await expect(new MemoryRepository(env.DB).readCurrentItem(OWNER_ID, proposed.itemId))
      .resolves.toMatchObject({
        lifecycle: { state: "proposed" },
        version: { basis: "inferred", origin: "model", uncertain: true },
      });
  });

  it("remembers exact text from the authenticated owner's current turn and replays it exactly", async () => {
    const turn = await seedTurn("Please remember that I prefer concise release notes.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const input = rememberInput(turn, "I prefer concise release notes.");

    const first = await service.remember(input);
    await seedTurn("This newer owner turn must not break exact command recovery.");
    const replay = await service.remember(input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.item).toEqual(first.item);
    expect(first.item.lifecycle.actor).toBe("owner");
    expect(first.item.sources).toMatchObject([{
      eventId: turn.input.eventId,
      eventSequence: turn.input.eventSequence,
      excerpt: "I prefer concise release notes.",
      channel: "telegram",
    }]);
    expect(first.item.topicPath.map((entry) => entry.displayName)).toEqual([
      "Memory",
      "Inbox / Needs filing",
    ]);
    expect(first.receipt).toMatch(/^Remembered 1 memory\.[^\n]+ordinary language/u);
    expect(await commandCount()).toBe(1);
    const command = await env.DB.prepare(`SELECT event_id, subject_id,
      json_extract(envelope_json, '$.causationId') AS causation_id,
      json_extract(envelope_json, '$.payload.operation') AS operation,
      json_extract(envelope_json, '$.payload.targetId') AS target_id
      FROM events WHERE event_type = 'memory.owner_command' AND subject_id = ?
      ORDER BY sequence DESC LIMIT 1`).bind(OWNER_ID).first<Record<string, unknown>>();
    expect(command).toMatchObject({
      event_id: first.item.lifecycle.ownerAuthorizingEventId,
      subject_id: OWNER_ID,
      causation_id: turn.input.eventId,
      operation: "item.transition",
      target_id: first.item.lifecycle.transitionId,
    });
  });

  it("refuses remember recovery through a valid command accepted for a different owner turn", async () => {
    const targetTurn = await seedTurn("Please remember that the archive color is amber.");
    const acceptedTurn = await seedTurn("Please remember that the review color is violet.");
    await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(acceptedTurn, "the review color is violet."),
    );
    const unrelatedCommand = await env.DB.prepare(`SELECT event_id FROM events
      WHERE subject_id = ? AND event_type = 'memory.owner_command'
      ORDER BY sequence DESC LIMIT 1`).bind(OWNER_ID).first<{ event_id: Ulid }>();
    if (unrelatedCommand === null) throw new Error("memory_owner_unrelated_command_missing");

    await expectCode(
      new MemoryRepository(env.DB).readAcceptedOwnerTurn(targetTurn.input, unrelatedCommand.event_id),
      "memory_refused",
    );
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_items
      WHERE creation_event_id = ?`).bind(targetTurn.input.eventId).first("count")).toBe(0);
  });

  it("requires the accepted owner command to carry the item transition operation", async () => {
    const turn = await seedTurn("Remember that accepted commands stay operation-bound.");
    await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(turn, "accepted commands stay operation-bound."),
    );
    const command = await env.DB.prepare(`SELECT event_id FROM events
      WHERE subject_id = ? AND event_type = 'memory.owner_command'
      ORDER BY sequence DESC LIMIT 1`).bind(OWNER_ID).first<{ event_id: Ulid }>();
    if (command === null) throw new Error("memory_owner_operation_command_missing");
    await env.DB.prepare(`UPDATE events SET envelope_json = json_set(
      envelope_json, '$.payload.operation', 'item.forget'
    ) WHERE event_id = ?`).bind(command.event_id).run();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_valid_owner_commands
      WHERE event_id = ?`).bind(command.event_id).first("count")).toBe(1);

    await expectCode(
      new MemoryRepository(env.DB).readAcceptedOwnerTurn(turn.input, command.event_id),
      "memory_refused",
    );
  });

  it("suppresses text when a remember replay is no longer the current transition", async () => {
    const turn = await seedTurn("Remember that I prefer dark mode.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const input = rememberInput(turn, "I prefer dark mode.");
    const remembered = await service.remember(input);
    const forgetTurn = await seedTurn(
      "Forget my dark mode preference.",
      { memoryIntent: "forget" },
    );
    await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    const beforeReplay = await commandCount();

    const replay = await service.remember(input);

    expect(replay).toMatchObject({
      replayed: true,
      item: { lifecycle: { state: "forgotten" }, version: { text: null, textHash: null } },
      receipt: "That remember request was already handled; the memory is currently hidden.",
    });
    expect(replay.item.sources[0]?.excerpt).toBeNull();
    expect(replay.item.sources[0]?.excerptHash).toBeNull();
    expect(replay.item.topicPath).toEqual([]);
    expect(JSON.stringify(replay)).not.toContain("I prefer dark mode.");
    expect(await commandCount()).toBe(beforeReplay);
  });

  it("reports a malformed stored owner command as corrupt", async () => {
    const turn = await seedTurn("Remember that I prefer corrupt receipts to be explicit.");
    const input = rememberInput(turn, "I prefer corrupt receipts to be explicit.");
    const events = new EventRepository(env.DB);
    const append = vi.spyOn(events, "append");
    const service = new MemoryOwnerControlsService(
      env.DB,
      env.ARCHIVE,
      new MemoryRepository(env.DB),
      events,
    );
    await service.remember(input);
    const stored = await append.mock.results[0]?.value;
    if (stored === undefined) throw new Error("memory_owner_command_fixture_missing");
    append.mockResolvedValue({
      ...stored,
      envelope: {
        ...stored.envelope,
        payload: { operation: "item.transition", targetId: "not-a-ulid" },
      },
      replayed: true,
    });
    const beforeReplay = await commandCount();

    await expectCode(service.remember(input), "memory_corrupt");

    expect(await commandCount()).toBe(beforeReplay);
  });

  it("preserves a valid command ULID containing a six-digit run", async () => {
    const turn = await seedTurn("Remember that identifier redaction must be deterministic.");
    const transitionId = "01abcde123456fghjkmnpqrstv" as Ulid;
    let issued = false;
    const service = new MemoryOwnerControlsService(
      env.DB,
      env.ARCHIVE,
      new MemoryRepository(env.DB),
      undefined,
      {
        idFactory: (now) => {
          if (!issued) {
            issued = true;
            return transitionId;
          }
          return newUlid(now);
        },
      },
    );

    const result = await service.remember(
      rememberInput(turn, "identifier redaction must be deterministic."),
    );

    expect(result.item.lifecycle.transitionId).toBe(transitionId);
  });

  it.each([
    ["a meaning-flipping negation fragment", "Remember I don't want to move to Boston.", "want to move to Boston"],
    ["a reported-speech fragment", "Remember my brother said Sid failed calculus.", "Sid failed calculus."],
    ["a conditional fragment", "Remember if I get into Waterloo I will move.", "I will move."],
    ["a mid-word fragment", "Remember I prefer teal.", "I prefer tea"],
    ["a condition changed by the preceding sentence", "Remember my plan if Waterloo rejects me. I'll take a gap year.", "I'll take a gap year."],
    ["reported speech changed by the preceding sentence", "Remember what Sam texted me. I'm quitting the team.", "I'm quitting the team."],
    ["a claim retracted by the following sentence", "Remember I failed calculus. Jk.", "I failed calculus."],
  ])("refuses %s before recording a command", async (_label, ownerText, requestedText) => {
    const turn = await seedTurn(ownerText);
    const before = await commandCount();

    await expectCode(
      new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(rememberInput(turn, requestedText)),
      "memory_refused",
    );

    expect(await commandCount()).toBe(before);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_items WHERE creation_event_id = ?",
    ).bind(turn.input.eventId).first()).toEqual({ count: 0 });
  });

  it.each([
    ["an apostrophe lookalike", "Remember, I donʼt use tables.", "I don't use tables."],
    ["a zero-width character", "Remember, I prefer\u200b concise notes.", "I prefer concise notes."],
  ])("normalizes %s only for whole-remainder comparison", async (_label, ownerText, text) => {
    const turn = await seedTurn(ownerText);

    const result = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE)
      .remember(rememberInput(turn, text));

    expect(result.item.version.text).toBe(text);
    expect(result.item.lifecycle.actor).toBe("owner");
    expect(result.item.sources[0]?.excerpt).toBe(ownerText.replace(/^Remember,[ ]?/u, ""));
  });

  it("does not complete an accepted remember command after its source turn is suppressed", async () => {
    const sourceText = "I prefer dark mode. I prefer compact menus.";
    const sourceTurn = await seedTurn(`Remember, ${sourceText}`);
    const sibling = await commitItemFromTurn(sourceTurn, "I prefer compact menus.");
    const input = rememberInput(sourceTurn, sourceText);
    const faultingMemory = createMemoryRepositoryForTest(env.DB, {
      batchFault: (operation) => operation === "commit"
        ? env.DB.prepare("INSERT INTO memory_owner_controls_missing_fault_target(value) VALUES (1)")
        : null,
    });
    const beforeAttempt = await commandCount();

    await expectCode(
      new MemoryOwnerControlsService(env.DB, env.ARCHIVE, faultingMemory).remember(input),
      "memory_unavailable",
    );
    expect(await commandCount()).toBe(beforeAttempt + 1);
    const forgetTurn = await seedTurn(
      "Forget my compact menu preference.",
      { memoryIntent: "forget" },
    );
    await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [sibling.itemId],
    });
    const beforeRetry = await commandCount();

    await expectCode(
      new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(input),
      "memory_refused",
    );

    expect(await commandCount()).toBe(beforeRetry);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_items WHERE creation_event_id = ?",
    ).bind(sourceTurn.input.eventId).first()).toEqual({ count: 1 });
  });

  it("refuses memory text over the canonical byte limit before recording a command", async () => {
    const text = `I prefer ${"x".repeat(4_087)}.`;
    const turn = await seedTurn(`Remember that ${text}`);
    const before = await commandCount();

    await expectCode(
      new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(rememberInput(turn, text)),
      "memory_refused",
    );

    expect(new TextEncoder().encode(text).byteLength).toBe(4_097);
    expect(await commandCount()).toBe(before);
  });

  it("refuses text absent from the owner's turn without recording a command or canonical item", async () => {
    const turn = await seedTurn("Remember that the launch is Tuesday.");
    const before = await commandCount();
    const events = new EventRepository(env.DB);
    const append = vi.spyOn(events, "append");

    await expectCode(
      new MemoryOwnerControlsService(env.DB, env.ARCHIVE, new MemoryRepository(env.DB), events)
        .remember(rememberInput(turn, "The launch is Friday.")),
      "memory_refused",
    );

    expect(append).not.toHaveBeenCalled();
    expect(await commandCount()).toBe(before);
    const row = await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_items WHERE creation_event_id = ?",
    ).bind(turn.input.eventId).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("refuses a superseded owner turn before recording a command", async () => {
    const stale = await seedTurn("Remember that stale turns cannot authorize memory.");
    await seedTurn("This is the owner's newer current turn.");
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(stale, stale.text),
    ), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("refuses an owner turn whose claimed channel differs from its stored channel", async () => {
    const turn = await seedTurn("Remember that I prefer channel-bound controls.");
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember({
      ...rememberInput(turn, "I prefer channel-bound controls."),
      ownerTurn: { ...turn.input, channel: "voice" },
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("accepts a current owner request after an assistant delivery", async () => {
    const now = new Date(eventClock);
    const identityId = `identity:memory-controls:${newUlid(now)}`;
    await env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(
      identityId,
      OWNER_ID,
      `provider:${newUlid(now)}`,
      now.toISOString(),
      now.toISOString(),
    ).run();
    const conversations = new ConversationRepository(env.DB, new EventRepository(env.DB));
    const earlierText = new Redactor().redactText("An earlier turn awaits delivery.");
    if (!earlierText.ok) throw new Error("memory_assistant_fixture_redaction_failed");
    const earlierTurnId = newUlid(now);
    const admission = await conversations.getOrCreateTurn({
      turnId: earlierTurnId,
      sessionId: `session:memory-controls:${earlierTurnId}`,
      principalId: OWNER_ID,
      channel: "telegram",
      userText: earlierText,
      now,
    });
    const modelClaim = await conversations.claimModelTurn({
      turnId: earlierTurnId,
      requestHash: admission.turn.requestHash,
      now,
    });
    if (modelClaim.kind !== "claimed") throw new Error("memory_assistant_fixture_claim_failed");
    conversations.beginModelStream(modelClaim.capability, earlierTurnId, admission.turn.requestHash);
    const assistantText = new Redactor().redactText("I can remember that.");
    if (!assistantText.ok) throw new Error("memory_assistant_fixture_redaction_failed");
    const staged = await conversations.stageAssistantDelivery({
      claim: modelClaim.capability,
      text: assistantText,
      targetIdentityId: identityId,
      replyToMessageId: null,
      now,
    });
    const turn = await seedTurn("Remember that I prefer controls after the reply.");
    const deliveryClaim = await conversations.claimDelivery({
      deliveryId: staged.delivery.deliveryId,
      now: new Date(eventClock + 1),
    });
    if (deliveryClaim.kind !== "claimed") throw new Error("memory_assistant_fixture_lease_failed");
    conversations.beginDelivery(
      deliveryClaim.capability,
      staged.delivery.deliveryId,
      staged.delivery.materialHash,
    );
    const receipt = conversations.mintProviderDeliveryReceipt({
      capability: deliveryClaim.capability,
      providerMessageId: `provider-message:${newUlid()}`,
    });
    await conversations.recordDeliverySuccess({
      capability: deliveryClaim.capability,
      receipt,
      now: new Date(eventClock + 1),
    });

    const result = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(turn, "I prefer controls after the reply."),
    );

    expect(result.item.lifecycle.state).toBe("active");
  });

  it("refuses casual, forwarded, quoted, pasted, attached, model, tool and guest content before command ingress", async () => {
    const turn = await seedTurn("Please remember that my reports should be short.");
    const before = await commandCount();
    const rejectedFlags = [
      { memoryIntent: null },
      { forwarded: true },
      { quoted: true },
      { pasted: true },
      { hasAttachment: true },
      { modelGenerated: true },
      { toolGenerated: true },
      { guest: true },
    ] as const;

    for (const flags of rejectedFlags) {
      await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember({
        ...rememberInput(turn, "my reports should be short"),
        ownerTurn: { ...turn.input, ...flags },
      }), "memory_refused");
    }

    expect(await commandCount()).toBe(before);
  });

  it("treats a casual forget-that turn as conversation rather than a memory control", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer short status updates.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "I prefer short status updates."),
    );
    const casualTurn = await seedTurn("Forget that, let us discuss something else.");
    const before = await commandCount();

    await expectCode(service.forget({
      ownerTurn: { ...casualTurn.input, memoryIntent: null },
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
    expect((await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    )).lifecycle.state).toBe("active");
  });

  it("refuses an operation that does not match the trusted per-operation intent", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer operation-bound controls.");
    const remembered = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(sourceTurn, "I prefer operation-bound controls."),
    );
    const mismatched = await seedTurn("Forget the operation-bound preference.");
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forget({
      ownerTurn: mismatched.input,
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("refuses a second different mutation authorized by one owner event", async () => {
    const turn = await seedTurn("Remember that I prefer one mutation per turn.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(turn, "I prefer one mutation per turn."),
    );
    const before = await commandCount();

    await expectCode(service.forget({
      ownerTurn: { ...turn.input, memoryIntent: "forget" },
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
    expect((await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    )).lifecycle.state).toBe("active");
  });

  it("refuses model-marked turns and non-owner principals before command ingress", async () => {
    const modelTurn = await seedTurn("Remember this generated answer.");
    const guestId = `principal:memory-guest:${newUlid()}`;
    await seedPrincipal(guestId, "service");
    const guest = await seedTurn("Remember this guest claim.", { principalId: guestId });
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember({
      ...rememberInput(modelTurn, modelTurn.text),
      ownerTurn: { ...modelTurn.input, modelGenerated: true },
    }), "memory_refused");
    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(guest, guest.text),
    ), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("refuses an ambiguous target before recording a command or changing memory", async () => {
    const rememberedTurn = await seedTurn("Remember that I prefer deterministic tests.");
    const remembered = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(rememberedTurn, "I prefer deterministic tests."),
    );
    const forgetTurn = await seedTurn(
      "Please forget the testing preference I just mentioned.",
      { memoryIntent: "forget" },
    );
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId, newUlid()],
    }), "memory_ambiguous");

    expect(await commandCount()).toBe(before);
    const current = await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    );
    expect(current.lifecycle.state).toBe("active");
  });

  it("refuses to lift a memory that is not forgotten before recording a command", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer explicit restore state.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "I prefer explicit restore state."),
    );
    const liftTurn = await seedTurn(
      "Restore that preference.",
      { memoryIntent: "lift" },
    );
    const before = await commandCount();

    await expectCode(service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("atomically accepts at most one concurrent mutation for one owner event", async () => {
    const existingTurn = await seedTurn("Remember that I prefer existing controls.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const existing = await service.remember(
      rememberInput(existingTurn, "I prefer existing controls."),
    );
    const sharedTurn = await seedTurn("Remember that I prefer raced controls.");
    const before = await commandCount();

    const attempts = await Promise.allSettled([
      service.remember(rememberInput(sharedTurn, "I prefer raced controls.")),
      service.forget({
        ownerTurn: { ...sharedTurn.input, memoryIntent: "forget" },
        candidateItemIds: [existing.item.itemId],
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "memory_refused" },
    });
    expect(await commandCount()).toBe(before + 1);
  });

  it("explains deterministic provenance without a command or a mutation", async () => {
    const rememberedTurn = await seedTurn("Remember that my summaries use plain language.");
    const remembered = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(rememberedTurn, "my summaries use plain language."),
    );
    const whyTurn = await seedTurn(
      "Why do you remember my summary preference?",
      { memoryIntent: "explain" },
    );
    const before = await commandCount();

    const explanation = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).explain({
      ownerTurn: whyTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });

    expect(explanation).toMatchObject({
      itemId: remembered.item.itemId,
      state: "active",
      uncertain: false,
      topicPath: ["Memory", "Inbox / Needs filing"],
      text: "my summaries use plain language.",
      sources: [{
        eventId: rememberedTurn.input.eventId,
        occurredAt: rememberedTurn.input.occurredAt,
        channel: "telegram",
        excerpt: "my summaries use plain language.",
      }],
    });
    expect(explanation.receipt).toBe("Explained 1 memory from verified evidence; nothing changed.");
    expect(await commandCount()).toBe(before);
    expect((await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    )).lifecycle.transitionId).toBe(remembered.item.lifecycle.transitionId);
  });

  it("forgets and restores one memory with exact suppression counts while retaining raw evidence", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer reports without tables.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "I prefer reports without tables."),
    );
    const forgetTurn = await seedTurn(
      "Please forget my report formatting preference.",
      { memoryIntent: "forget" },
    );

    const forgotten = await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    const forgetReplay = await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });

    expect(forgotten).toMatchObject({
      newlyHiddenTurnCount: 1,
      totalCoveredTurnCount: 1,
      replayed: false,
      itemId: remembered.item.itemId,
      state: "forgotten",
    });
    expect(JSON.stringify(forgotten)).not.toContain("reports without tables");
    expect(forgetReplay.replayed).toBe(true);
    expect(forgotten.receipt).not.toContain("reports without tables");
    const visible = await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_visible_recent_events WHERE event_id = ?",
    ).bind(sourceTurn.input.eventId).first<{ count: number }>();
    const retrievable = await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE item_id = ?",
    ).bind(remembered.item.itemId).first<{ count: number }>();
    const raw = await env.DB.prepare(
      "SELECT count(*) AS count FROM events WHERE event_id = ?",
    ).bind(sourceTurn.input.eventId).first<{ count: number }>();
    expect([visible?.count, retrievable?.count, raw?.count]).toEqual([0, 0, 1]);

    const hiddenWhyTurn = await seedTurn(
      "Why is that report preference hidden?",
      { memoryIntent: "explain" },
    );
    const hidden = await service.explain({
      ownerTurn: hiddenWhyTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    expect(hidden.text).toBeNull();
    expect(hidden.topicPath).toEqual([]);
    expect(hidden.sources[0]?.excerpt).toBeNull();

    const liftTurn = await seedTurn(
      "Use my report formatting preference again.",
      { memoryIntent: "lift" },
    );
    const restored = await service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    const liftReplay = await service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    expect(restored).toMatchObject({
      liftedSuppressionCount: 1,
      replayed: false,
      item: { lifecycle: { state: "active", actor: "owner" } },
    });
    expect(restored.item.version.versionNumber).toBe(2);
    expect(liftReplay.replayed).toBe(true);
    const restoredViews = await Promise.all([
      env.DB.prepare("SELECT count(*) AS count FROM memory_visible_recent_events WHERE event_id = ?")
        .bind(sourceTurn.input.eventId).first<{ count: number }>(),
      env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE item_id = ?")
        .bind(remembered.item.itemId).first<{ count: number }>(),
      env.DB.prepare(`SELECT count(*) AS count FROM memory_event_suppressions suppression
        JOIN memory_event_suppression_lifts lift
          ON lift.principal_id = suppression.principal_id
          AND lift.suppression_id = suppression.suppression_id
        WHERE suppression.principal_id = ? AND suppression.target_event_id = ?`)
        .bind(OWNER_ID, sourceTurn.input.eventId).first<{ count: number }>(),
    ]);
    expect(restoredViews.map((row) => row?.count)).toEqual([1, 1, 1]);
  });

  it("reports sibling memories hidden by a forget and a restore that remains suppressed", async () => {
    const rememberedText = "I prefer dark mode. I prefer compact menus.";
    const sourceTurn = await seedTurn(`Remember, ${rememberedText}`);
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const input = rememberInput(sourceTurn, rememberedText);
    const first = await service.remember(input);
    const sibling = await commitItemFromTurn(sourceTurn, "I prefer compact menus.");
    const forgetFirstTurn = await seedTurn(
      "Forget my dark mode preference.",
      { memoryIntent: "forget" },
    );

    const forgotFirst = await service.forget({
      ownerTurn: forgetFirstTurn.input,
      candidateItemIds: [first.item.itemId],
    });

    expect(forgotFirst.hiddenSiblingItemCount).toBe(1);
    expect(forgotFirst.receipt).toContain("also hid 1 other active memory");
    const explainSiblingTurn = await seedTurn(
      "Why do you remember my compact menu preference?",
      { memoryIntent: "explain" },
    );
    const siblingExplanation = await service.explain({
      ownerTurn: explainSiblingTurn.input,
      candidateItemIds: [sibling.itemId],
    });
    expect(siblingExplanation).toMatchObject({
      state: "active",
      topicPath: [],
      text: null,
      sources: [{ excerpt: null }],
      receipt: "Explained 1 hidden memory without revealing its text; nothing changed.",
    });
    expect(JSON.stringify(siblingExplanation)).not.toContain("I prefer compact menus.");
    const replay = await service.remember(input);
    expect(replay).toMatchObject({
      replayed: true,
      item: {
        topicPath: [],
        version: { text: null, textHash: null },
        sources: [{ excerpt: null, excerptHash: null }],
      },
      receipt: "That remember request was already handled; the memory is currently hidden.",
    });
    expect(JSON.stringify(replay)).not.toContain(rememberedText);

    const forgetSiblingTurn = await seedTurn(
      "Forget my compact menu preference.",
      { memoryIntent: "forget" },
    );
    await service.forget({
      ownerTurn: forgetSiblingTurn.input,
      candidateItemIds: [sibling.itemId],
    });
    const liftFirstTurn = await seedTurn(
      "Restore my dark mode preference.",
      { memoryIntent: "lift" },
    );
    const restored = await service.lift({
      ownerTurn: liftFirstTurn.input,
      candidateItemIds: [first.item.itemId],
    });

    expect(restored.retrievable).toBe(false);
    expect(restored.receipt).toContain("still hidden because another forgotten memory");
    expect(restored.item).toMatchObject({
      topicPath: [],
      version: { text: null, textHash: null },
      sources: [{ excerpt: null, excerptHash: null }],
    });
    expect(JSON.stringify(restored)).not.toContain(rememberedText);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE item_id = ?",
    ).bind(first.item.itemId).first()).toEqual({ count: 0 });
  });

  it("restores a forgotten proposed model memory to proposed rather than promoting it", async () => {
    const sourceTurn = await seedTurn("I might prefer violet layouts.");
    const proposed = await commitItemFromTurn(sourceTurn, sourceTurn.text, {
      lifecycleState: "proposed",
      origin: "model",
    });
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const forgetTurn = await seedTurn(
      "Forget the proposed violet layout preference.",
      { memoryIntent: "forget" },
    );
    await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [proposed.itemId],
    });
    const liftTurn = await seedTurn(
      "Restore the proposed violet layout preference.",
      { memoryIntent: "lift" },
    );

    const restored = await service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [proposed.itemId],
    });

    expect(restored).toMatchObject({
      retrievable: false,
      item: { lifecycle: { state: "proposed" }, version: { origin: "model" } },
    });
    expect(restored.receipt).toContain("Restored 1 memory to proposed");
  });

  it("rolls back a faulted forget batch and completes it on the exact command replay", async () => {
    const sourceTurn = await seedTurn("Remember that transactional memory updates matter.");
    const remembered = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(sourceTurn, "transactional memory updates matter."),
    );
    const forgetTurn = await seedTurn(
      "Forget the transactional memory note.",
      { memoryIntent: "forget" },
    );
    const faultingMemory = createMemoryRepositoryForTest(env.DB, {
      batchFault: (operation) => operation === "forget"
        ? env.DB.prepare("INSERT INTO memory_owner_controls_missing_fault_target(value) VALUES (1)")
        : null,
    });

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE, faultingMemory).forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    }), "memory_unavailable");

    const afterFault = await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    );
    const suppressionCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM memory_event_suppressions WHERE principal_id = ? AND target_event_id = ?`)
      .bind(OWNER_ID, sourceTurn.input.eventId).first<{ count: number }>();
    expect(afterFault.lifecycle.state).toBe("active");
    expect(suppressionCount?.count).toBe(0);

    await seedTurn("This newer turn must not strand an already accepted forget command.");
    const recovered = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    expect(recovered).toMatchObject({ replayed: true, newlyHiddenTurnCount: 1 });
  });

  it("forgets and lifts a memory after its source turn is archived and purged through the default repository", async () => {
    const sourceTurn = await seedTurn("Remember that archived owner controls need real R2 evidence.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "archived owner controls need real R2 evidence."),
    );
    await archiveAndPurgeTurn(sourceTurn);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM events WHERE event_id = ?")
      .bind(sourceTurn.input.eventId).first("count")).toBe(0);

    const forgetTurn = await seedTurn(
      "Forget the archived owner-control preference.",
      { memoryIntent: "forget" },
    );
    await expect(service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    })).resolves.toMatchObject({ state: "forgotten", newlyHiddenTurnCount: 1 });

    const liftTurn = await seedTurn(
      "Restore the archived owner-control preference.",
      { memoryIntent: "lift" },
    );
    await expect(service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [remembered.item.itemId],
    })).resolves.toMatchObject({
      item: { lifecycle: { state: "active" }, version: { basis: "confirmed" } },
    });
  });

  it("supersedes the earlier wording when the owner restates a fact plainly, and recalls only the new one", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const correctionTurn = await seedTurn(
      "my fav subject is now science",
      { memoryIntent: "correct" },
    );

    const corrected = await service.correct(correctInput(
      correctionTurn,
      "my fav subject is now science",
      remembered.item.itemId,
    ));

    expect(corrected.replayed).toBe(false);
    expect(corrected.supersededItemId).toBe(remembered.item.itemId);
    expect(corrected.item.itemId).not.toBe(remembered.item.itemId);
    expect(corrected.item).toMatchObject({
      lifecycle: { state: "active", actor: "owner" },
      version: { text: "my fav subject is now science", basis: "stated", sensitivity: "normal" },
    });
    // Only the new wording is reviewable evidence, and the retired item is
    // retired rather than deleted.
    expect(await retrievableTexts([remembered.item.itemId, corrected.item.itemId]))
      .toEqual(["my fav subject is now science"]);
    expect(await currentState(remembered.item.itemId)).toEqual({
      lifecycleState: "superseded",
      versionNumber: 1,
      text: "my favourite subject is math.",
    });
    const links = await env.DB.prepare(`SELECT source_item_id, target_item_id, link_type
      FROM memory_item_links WHERE principal_id = ? AND target_item_id = ?`)
      .bind(OWNER_ID, remembered.item.itemId)
      .all<{ source_item_id: string; target_item_id: string; link_type: string }>();
    expect(links.results).toEqual([{
      source_item_id: corrected.item.itemId,
      target_item_id: remembered.item.itemId,
      link_type: "supersedes",
    }]);
  });

  it("keeps every superseded version, source and transition in the ledger", async () => {
    const sourceTurn = await seedTurn("Remember that my locker code is 4471.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my locker code is 4471."),
    );
    const correctionTurn = await seedTurn(
      "my locker code is 9982 now",
      { memoryIntent: "correct" },
    );
    await service.correct(correctInput(
      correctionTurn,
      "my locker code is 9982 now",
      remembered.item.itemId,
    ));

    const counts = await Promise.all([
      env.DB.prepare(`SELECT count(*) AS count FROM memory_item_versions
        WHERE item_id = ? AND text = 'my locker code is 4471.'`).bind(remembered.item.itemId)
        .first<{ count: number }>(),
      env.DB.prepare("SELECT count(*) AS count FROM memory_item_sources WHERE item_id = ?")
        .bind(remembered.item.itemId).first<{ count: number }>(),
      env.DB.prepare(`SELECT count(*) AS count FROM memory_item_transitions
        WHERE item_id = ? AND lifecycle_state = 'superseded'`)
        .bind(remembered.item.itemId).first<{ count: number }>(),
      env.DB.prepare("SELECT count(*) AS count FROM events WHERE event_id = ?")
        .bind(sourceTurn.input.eventId).first<{ count: number }>(),
    ]);
    expect(counts.map((row) => row?.count)).toEqual([1, 1, 1, 1]);
    const items = await env.DB.prepare("SELECT count(*) AS count FROM memory_items WHERE item_id = ?")
      .bind(remembered.item.itemId).first<{ count: number }>();
    expect(items?.count).toBe(1);
  });

  it("names the earlier and the current wording in the correction receipt", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const correctionTurn = await seedTurn(
      "my fav subject is now science",
      { memoryIntent: "correct" },
    );

    const corrected = await service.correct(correctInput(
      correctionTurn,
      "my fav subject is now science",
      remembered.item.itemId,
    ));

    expect(corrected.receipt).toContain("my fav subject is now science");
    expect(corrected.receipt).toContain("my favourite subject is math.");
    expect(corrected.receipt).toContain("no longer current");
    expect(corrected.receipt).toContain("in the ledger");
    expect(corrected.supersededText).toBe("my favourite subject is math.");
  });

  it("refuses a correction that claims wording Sid's own message does not contain", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const correctionTurn = await seedTurn(
      "my fav subject is now science",
      { memoryIntent: "correct" },
    );

    await expectCode(service.correct(correctInput(
      correctionTurn,
      "my favourite subject is now chemistry",
      remembered.item.itemId,
    )), "memory_refused");

    // A refused correction changes nothing at all, including the ledger.
    expect(await currentState(remembered.item.itemId)).toMatchObject({
      lifecycleState: "active",
    });
    expect(await retrievableTexts([remembered.item.itemId]))
      .toEqual(["my favourite subject is math."]);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_item_links WHERE target_item_id = ?")
      .bind(remembered.item.itemId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("refuses a correction whose words arrive as forwarded or quoted third-party text", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const correctionTurn = await seedTurn(
      "my fav subject is now science",
      { memoryIntent: "correct" },
    );
    const forwarded = Object.freeze({
      ...correctionTurn.input,
      forwarded: true,
      quoted: true,
    });

    await expectCode(service.correct(correctInput(
      correctionTurn,
      "my fav subject is now science",
      remembered.item.itemId,
      { ownerTurn: forwarded },
    )), "memory_refused");

    expect(await currentState(remembered.item.itemId)).toMatchObject({
      lifecycleState: "active",
      text: "my favourite subject is math.",
    });
  });

  it("refuses to replace a sensitive memory with a normal one", async () => {
    const sourceTurn = await seedTurn("Remember that my portal answer is a phrase.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(Object.freeze({
      ownerTurn: sourceTurn.input,
      text: "my portal answer is a phrase.",
      kind: "fact",
      sensitivity: "sensitive",
    }));
    const correctionTurn = await seedTurn(
      "my portal answer is a different phrase",
      { memoryIntent: "correct" },
    );

    await expectCode(service.correct(correctInput(
      correctionTurn,
      "my portal answer is a different phrase",
      remembered.item.itemId,
      { sensitivity: "normal" },
    )), "memory_refused");
    expect(await currentState(remembered.item.itemId)).toMatchObject({ lifecycleState: "active" });
  });

  it("replaces a sensitive memory when the correction keeps it sensitive", async () => {
    const sourceTurn = await seedTurn("Remember that my portal answer is a phrase.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(Object.freeze({
      ownerTurn: sourceTurn.input,
      text: "my portal answer is a phrase.",
      kind: "fact",
      sensitivity: "sensitive",
    }));
    const correctionTurn = await seedTurn(
      "my portal answer is a different phrase",
      { memoryIntent: "correct" },
    );

    await expect(service.correct(correctInput(
      correctionTurn,
      "my portal answer is a different phrase",
      remembered.item.itemId,
      { sensitivity: "sensitive" },
    ))).resolves.toMatchObject({
      item: { version: { text: "my portal answer is a different phrase", sensitivity: "sensitive" } },
    });
  });

  it("withholds an earlier wording that an active suppression hides", async () => {
    const sharedTurn = await seedTurn("I prefer dark mode. I prefer compact menus.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const hidden = await service.remember(Object.freeze({
      ownerTurn: sharedTurn.input,
      text: "I prefer dark mode.",
      kind: "preference",
      sensitivity: "normal",
      sourceExcerpt: "I prefer dark mode.",
    }));
    const sibling = await commitItemFromTurn(sharedTurn, "I prefer compact menus.");
    const forgetTurn = await seedTurn(
      "Forget my compact menu preference.",
      { memoryIntent: "forget" },
    );
    await service.forget({ ownerTurn: forgetTurn.input, candidateItemIds: [sibling.itemId] });
    // The shared turn is suppressed, so the sibling forget hides this item too
    // even though its own lifecycle state is still active.
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE item_id = ?")
      .bind(hidden.item.itemId).first()).toEqual({ count: 0 });
    const correctionTurn = await seedTurn(
      "I prefer light mode now",
      { memoryIntent: "correct" },
    );

    const corrected = await service.correct(correctInput(
      correctionTurn,
      "I prefer light mode now",
      hidden.item.itemId,
    ));

    expect(corrected.supersededText).toBeNull();
    expect(corrected.receipt).not.toContain("I prefer dark mode.");
    expect(JSON.stringify(corrected)).not.toContain("I prefer dark mode.");
    expect(corrected.receipt).toContain("I prefer light mode now");
    expect(corrected.receipt).toContain("hidden by an active suppression");
    expect(corrected.receipt).toContain("no longer current");
  });

  it("replays one correction without writing a second replacement or a second link", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const correctionTurn = await seedTurn(
      "my fav subject is now science",
      { memoryIntent: "correct" },
    );
    const input = correctInput(
      correctionTurn,
      "my fav subject is now science",
      remembered.item.itemId,
    );
    const commandsBefore = await commandCount();

    const first = await service.correct(input);
    const replay = await service.correct(input);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, supersededItemId: remembered.item.itemId });
    expect(replay.item.itemId).toBe(first.item.itemId);
    expect(await commandCount()).toBe(commandsBefore + 2);
    const counts = await Promise.all([
      env.DB.prepare("SELECT count(*) AS count FROM memory_item_links WHERE target_item_id = ?")
        .bind(remembered.item.itemId).first<{ count: number }>(),
      env.DB.prepare(`SELECT count(*) AS count FROM memory_item_transitions
        WHERE item_id = ? AND lifecycle_state = 'superseded'`)
        .bind(remembered.item.itemId).first<{ count: number }>(),
      env.DB.prepare("SELECT count(*) AS count FROM memory_items WHERE principal_id = ?")
        .bind(OWNER_ID).first<{ count: number }>(),
    ]);
    expect(counts[0]?.count).toBe(1);
    expect(counts[1]?.count).toBe(1);
  });

  it("commits the replacement item, the retirement transition and the edge in one D1 batch", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const remembered = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const correctionTurn = await seedTurn(
      "my fav subject is now science",
      { memoryIntent: "correct" },
    );
    const tracked = trackingDatabase(env.DB);

    await new MemoryOwnerControlsService(tracked.database, env.ARCHIVE).correct(correctInput(
      correctionTurn,
      "my fav subject is now science",
      remembered.item.itemId,
    ));

    // A D1 batch is the only transaction primitive here, so "the replacement is
    // never live without its retirement" can only mean one batch holds all
    // three writes. Split across two, a failure between them leaves two live
    // wordings for one fact.
    expect(tracked.batchesContainingAll([
      "INTO memory_items ",
      "INTO memory_item_transitions ",
      "INTO memory_item_links ",
    ])).toBe(1);
  });

  it("refuses to replace a memory that is no longer current", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const firstTurn = await seedTurn("my fav subject is now science", { memoryIntent: "correct" });
    const first = await service.correct(correctInput(
      firstTurn,
      "my fav subject is now science",
      remembered.item.itemId,
    ));
    const secondTurn = await seedTurn("my fav subject is now history", { memoryIntent: "correct" });

    await expectCode(service.correct(correctInput(
      secondTurn,
      "my fav subject is now history",
      remembered.item.itemId,
    )), "memory_refused");

    // Only one wording is ever current, and the earlier one cannot be replaced
    // twice into a second live fact.
    expect(await currentState(remembered.item.itemId)).toMatchObject({
      lifecycleState: "superseded",
    });
    expect(await retrievableTexts([remembered.item.itemId, first.item.itemId]))
      .toEqual(["my fav subject is now science"]);
  });

  it("rolls back a faulted correction batch so the earlier wording is never replaced alone", async () => {
    const sourceTurn = await seedTurn("Remember that my favourite subject is math.");
    const service = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "my favourite subject is math."),
    );
    const correctionTurn = await seedTurn(
      "my fav subject is now science",
      { memoryIntent: "correct" },
    );
    const faulting = createMemoryRepositoryForTest(env.DB, {
      batchFault: (operation) => operation === "commit"
        ? env.DB.prepare("INSERT INTO memory_owner_controls_missing_fault_target(value) VALUES (1)")
        : null,
    });

    await expectCode(new MemoryOwnerControlsService(env.DB, env.ARCHIVE, faulting).correct(
      correctInput(correctionTurn, "my fav subject is now science", remembered.item.itemId),
    ), "memory_unavailable");

    // The replacement, the retirement transition and the edge land together or
    // not at all; a half-applied correction is the duplicate this path forbids.
    expect(await currentState(remembered.item.itemId)).toMatchObject({ lifecycleState: "active" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_item_links WHERE target_item_id = ?")
      .bind(remembered.item.itemId).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await retrievableTexts([remembered.item.itemId]))
      .toEqual(["my favourite subject is math."]);

    const recovered = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).correct(
      correctInput(correctionTurn, "my fav subject is now science", remembered.item.itemId),
    );
    expect(recovered.replayed).toBe(true);
    expect(await currentState(remembered.item.itemId)).toMatchObject({ lifecycleState: "superseded" });
    expect(await retrievableTexts([remembered.item.itemId, recovered.item.itemId]))
      .toEqual(["my fav subject is now science"]);
  });
});

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  MemoryRepository,
  createMemoryRepositoryForTest,
} from "../../src/memory/memory-repository.js";
import {
  MemoryRepositoryError,
  type CommitInitialMemoryInput,
  type MemoryRepositoryErrorCode,
} from "../../src/memory/memory-types.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";

interface SeededEvent {
  readonly eventId: Ulid;
  readonly sequence: number;
  readonly occurredAt: string;
}

let principalSerial = 20_000;

async function seedPrincipal(): Promise<string> {
  principalSerial += 1;
  const principalId = `principal:memory-fault:${principalSerial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'service', 'active', 'memory fault test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

async function seedEvent(
  principalId: string,
  text = "I prefer deterministic fault probes.",
): Promise<SeededEvent> {
  const eventId = newUlid();
  const occurredAt = new Date().toISOString();
  const payload = {
    schemaCode: 1,
    channelCode: 2,
    sensitivityCode: 1,
    historyEligible: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(),
    contentType: "application/json",
    contentHash,
    payload,
    redaction: { status: "none", markers: [] },
    producerVersion: "conversation-v1",
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'conversation', ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, principalId, occurredAt, occurredAt, contentHash, JSON.stringify(envelope), occurredAt).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_repository_fault_event_missing");
  return { eventId, sequence: row.sequence, occurredAt };
}

async function inputFor(
  principalId: string,
  source: SeededEvent,
  topicId: Ulid,
): Promise<CommitInitialMemoryInput> {
  const text = "I prefer deterministic fault probes.";
  return Object.freeze({
    principalId,
    itemId: newUlid(),
    kind: "preference" as const,
    creationEventId: source.eventId,
    creationEventSequence: source.sequence,
    version: Object.freeze({
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: "stated" as const,
      origin: "authenticated_first_person" as const,
      uncertain: false,
      sensitivity: "normal" as const,
      validFrom: null,
      validTo: null,
      extractorVersion: "memory-policy-v1",
      extractorModelId: null,
    }),
    sources: Object.freeze([Object.freeze({
      sourceId: newUlid(),
      eventId: source.eventId,
      eventSequence: source.sequence,
      sourceLocation: "live" as const,
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "telegram" as const,
      occurredAt: source.occurredAt,
    })]),
    transition: Object.freeze({
      transitionId: newUlid(),
      lifecycleState: "active" as const,
      reason: "deterministic first-person promotion",
      policyVersion: "memory-policy-v1",
    }),
    placement: Object.freeze({
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId,
      filingSource: "rule" as const,
      confidence: 0.5,
      reason: "fault fixture primary filing",
    }),
  });
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
  throw new Error(`expected_memory_repository_error:${code}`);
}

async function itemRowCounts(principalId: string, itemId: Ulid): Promise<readonly number[]> {
  const tables = [
    "memory_items",
    "memory_item_versions",
    "memory_item_sources",
    "memory_item_transitions",
    "memory_item_state",
    "memory_item_placement_events",
    "memory_item_placement_state",
  ] as const;
  const counts: number[] = [];
  for (const table of tables) {
    const row = await env.DB.prepare(`SELECT count(*) AS count FROM ${table}
      WHERE principal_id = ? AND item_id = ?`).bind(principalId, itemId).first<{ count: number }>();
    counts.push(row?.count ?? -1);
  }
  return counts;
}

function clockSequence(values: readonly Date[]): () => Date {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("memory_repository_fault_clock_exhausted");
    return value;
  };
}

beforeAll(async () => {
  await applyMemoryIngressMigration();
});

describe("MemoryRepository fault boundaries", () => {
  it("handles a raced root and inbox retry without creating a second root or duplicate sibling", async () => {
    const principalId = await seedPrincipal();
    const winner = new MemoryRepository(env.DB);
    let injected = false;
    const contender = createMemoryRepositoryForTest(env.DB, {
      beforeBatch: async (operation) => {
        if (operation !== "bootstrap" || injected) return;
        injected = true;
        await winner.bootstrapTopics(principalId);
      },
    });

    const result = await contender.bootstrapTopics(principalId);

    expect(result.replayed).toBe(true);
    const rows = await env.DB.prepare(`SELECT parent_topic_id, normalized_name
      FROM memory_topics WHERE principal_id = ? ORDER BY parent_topic_id NULLS FIRST`)
      .bind(principalId).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.filter((row) => row.parent_topic_id === null)).toHaveLength(1);
    expect(rows.results.filter((row) => row.normalized_name === "inbox / needs filing")).toHaveLength(1);
  });

  it("re-stamps root and inbox topic events after a retry", async () => {
    const principalId = await seedPrincipal();
    const start = Date.now() + 2_000;
    const stamps = [0, 1, 2, 3].map((offset) => new Date(start + offset * 10));
    let failed = false;
    const repository = createMemoryRepositoryForTest(env.DB, {
      clock: clockSequence(stamps),
      beforeBatch: (operation) => {
        if (operation === "bootstrap" && !failed) {
          failed = true;
          throw new Error("synthetic_pre_batch_retry");
        }
      },
    });

    await repository.bootstrapTopics(principalId);

    const rows = await env.DB.prepare(`SELECT occurred_at FROM memory_topic_events
      WHERE principal_id = ? ORDER BY occurred_at`).bind(principalId).all<{ occurred_at: string }>();
    expect(rows.results.map((row) => row.occurred_at)).toEqual([
      stamps[2]?.toISOString(),
      stamps[3]?.toISOString(),
    ]);
  });

  it("re-stamps item, transition and placement writes after a retry", async () => {
    const principalId = await seedPrincipal();
    const source = await seedEvent(principalId);
    const topics = await new MemoryRepository(env.DB).bootstrapTopics(principalId);
    const input = await inputFor(principalId, source, topics.inbox.topicId);
    const start = Date.now() + 3_000;
    const stamps = [0, 1, 2, 3, 4, 5].map((offset) => new Date(start + offset * 10));
    let failed = false;
    const repository = createMemoryRepositoryForTest(env.DB, {
      clock: clockSequence(stamps),
      beforeBatch: (operation) => {
        if (operation === "commit" && !failed) {
          failed = true;
          throw new Error("synthetic_pre_batch_retry");
        }
      },
    });

    const result = await repository.commitInitialItem(input);

    expect(result.item.createdAt).toBe(stamps[3]?.toISOString());
    expect(result.item.lifecycle.occurredAt).toBe(stamps[4]?.toISOString());
    expect(result.item.primaryPlacement.updatedAt).toBe(stamps[5]?.toISOString());
  });

  it("validates every source event for the principal before reaching the write batch", async () => {
    const principalId = await seedPrincipal();
    const source = await seedEvent(principalId);
    const otherPrincipalId = await seedPrincipal();
    const otherSource = await seedEvent(otherPrincipalId);
    const topics = await new MemoryRepository(env.DB).bootstrapTopics(principalId);
    const valid = await inputFor(principalId, source, topics.inbox.topicId);
    const invalid: CommitInitialMemoryInput = {
      ...valid,
      sources: [{
        ...valid.sources[0]!,
        eventId: otherSource.eventId,
        eventSequence: otherSource.sequence,
        occurredAt: otherSource.occurredAt,
      }],
    };
    let batchCalls = 0;
    const repository = createMemoryRepositoryForTest(env.DB, {
      beforeBatch: (operation) => {
        if (operation === "commit") batchCalls += 1;
      },
    });

    await expectCode(repository.commitInitialItem(invalid), "memory_refused");

    expect(batchCalls).toBe(0);
    await expect(itemRowCounts(principalId, valid.itemId)).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses an exact excerpt that is absent from its live source event before reaching the write batch", async () => {
    const principalId = await seedPrincipal();
    const source = await seedEvent(principalId, "What time is practice?");
    const topics = await new MemoryRepository(env.DB).bootstrapTopics(principalId);
    const input = await inputFor(principalId, source, topics.inbox.topicId);
    let batchCalls = 0;
    const repository = createMemoryRepositoryForTest(env.DB, {
      beforeBatch: (operation) => {
        if (operation === "commit") batchCalls += 1;
      },
    });

    await expectCode(repository.commitInitialItem(input), "memory_refused");

    expect(batchCalls).toBe(0);
    await expect(itemRowCounts(principalId, input.itemId)).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("rolls back every initial memory row when a later statement in its D1 batch fails", async () => {
    const principalId = await seedPrincipal();
    const source = await seedEvent(principalId);
    const topics = await new MemoryRepository(env.DB).bootstrapTopics(principalId);
    const input = await inputFor(principalId, source, topics.inbox.topicId);
    const repository = createMemoryRepositoryForTest(env.DB, {
      batchFault: (operation) => operation === "commit"
        ? env.DB.prepare("INSERT INTO memory_repository_missing_fault_target(value) VALUES (1)")
        : null,
    });

    await expectCode(repository.commitInitialItem(input), "memory_unavailable");

    await expect(itemRowCounts(principalId, input.itemId)).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("uses the principal filter even when another principal has the requested item identity", async () => {
    const principalId = await seedPrincipal();
    const source = await seedEvent(principalId);
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const input = await inputFor(principalId, source, topics.inbox.topicId);
    await repository.commitInitialItem(input);
    const otherPrincipalId = await seedPrincipal();

    await expectCode(repository.readCurrentItem(otherPrincipalId, input.itemId), "memory_not_found");
  });
});

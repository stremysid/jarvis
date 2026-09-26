import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  newUlid,
  sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import type { ContextRetriever } from "../../src/conversation/conversation-types.js";
import type { Env } from "../../src/env.js";
import { runMemoryConsolidationJob, type JobEnvironment } from "../../src/jobs/job-table.js";
import {
  LivingMemoryConsolidationWorkflow,
  type LivingMemoryConsolidationOptions,
} from "../../src/memory/living-notes.js";
import { MemoryExtractionBudget } from "../../src/memory/memory-extraction-budget.js";
import { MemoryOwnerControlsService } from "../../src/memory/memory-owner-controls.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import type { MemoryOwnerTurnInput } from "../../src/memory/memory-types.js";
import { DeepSeekJsonProvider } from "../../src/providers/deepseek-provider.js";
import type { ModelCompleteJsonInput, ModelProvider } from "../../src/providers/provider-types.js";
import { applyMemoryLivingNotesMigration } from "../persistence/migration.js";

const MODEL = "deepseek:deepseek-flash";

interface Clock {
  now(): Date;
  advance(milliseconds?: number): Date;
}

interface TestMemory {
  readonly principalId: string;
  readonly clock: Clock;
  readonly repository: MemoryRepository;
  readonly rootTopicId: Ulid;
  readonly inboxTopicId: Ulid;
  readonly priceId: Ulid;
}

interface SeededItem {
  readonly itemId: Ulid;
  readonly versionId: Ulid;
  readonly sourceEventId: Ulid;
  readonly text: string;
}

interface PromptTopic {
  readonly topicId: Ulid;
  readonly name: string;
  readonly profile: boolean;
  readonly sources: readonly Readonly<{
    kind: "item" | "topic_event";
    id: Ulid;
    date: string;
    text: string;
  }>[];
}

class CallbackProvider implements Pick<ModelProvider, "completeJson"> {
  readonly requests: ModelCompleteJsonInput[] = [];

  constructor(private readonly reply: (topics: readonly PromptTopic[], call: number) => unknown) {}

  async completeJson(input: ModelCompleteJsonInput): Promise<unknown> {
    this.requests.push(input);
    const payload = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf("\n") + 1)) as {
      topics: PromptTopic[];
    };
    return this.reply(payload.topics, this.requests.length);
  }
}

function testClock(): Clock {
  let at = Date.now();
  return {
    now: () => new Date(at),
    advance: (milliseconds = 10) => {
      at += milliseconds;
      return new Date(at);
    },
  };
}

async function createTestMemory(monthlyCapUsd = "5"): Promise<TestMemory> {
  const clock = testClock();
  const principalId = `principal:living-notes:${newUlid(clock.now())}`;
  const now = clock.now().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'living notes test', ?, ?)`)
    .bind(principalId, now, now).run();
  const repository = new MemoryRepository(env.DB, { clock: clock.now });
  const topics = await repository.bootstrapTopics(principalId);
  clock.advance();
  const budget = new MemoryExtractionBudget({
    database: env.DB,
    modelId: "deepseek-flash",
    monthlyCapUsd,
    now: clock.now,
  });
  const prepared = await budget.prepare(principalId);
  return {
    principalId,
    clock,
    repository,
    rootTopicId: topics.root.topicId,
    inboxTopicId: topics.inbox.topicId,
    priceId: prepared.priceId,
  };
}

async function seedConversation(
  memory: TestMemory,
  text: string,
  memoryIntent: MemoryOwnerTurnInput["memoryIntent"] = "remember",
): Promise<MemoryOwnerTurnInput> {
  const occurredAt = memory.clock.advance().toISOString();
  const eventId = newUlid(new Date(occurredAt));
  const payload = {
    schemaCode: 1,
    channelCode: 2,
    sensitivityCode: 1,
    historyEligible: true,
    directOwnerText: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: memory.principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(new Date(occurredAt)),
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
    .bind(
      eventId,
      memory.principalId,
      occurredAt,
      occurredAt,
      contentHash,
      canonicalJson(envelope),
      occurredAt,
    ).run();
  const sequence = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<number>("sequence");
  if (sequence === null) throw new Error("living_note_source_event_missing");
  return Object.freeze({
    principalId: memory.principalId,
    eventId,
    eventSequence: sequence,
    occurredAt,
    channel: "telegram" as const,
    memoryIntent,
    forwarded: false,
    quoted: false,
    pasted: false,
    hasAttachment: false,
    modelGenerated: false,
    toolGenerated: false,
    guest: false,
  });
}

async function seedItem(
  memory: TestMemory,
  text: string,
  validTo: string | null = null,
  sensitivity: "normal" | "sensitive" = "normal",
): Promise<SeededItem> {
  const source = await seedConversation(memory, text);
  const itemId = newUlid(memory.clock.advance());
  const versionId = newUlid(memory.clock.now());
  const result = await memory.repository.commitInitialItem({
    principalId: memory.principalId,
    itemId,
    kind: "fact",
    // The fixture states the pair the caller asked for: an end means temporary.
    lifetime: validTo === null ? "durable" : "temporary",
    creationEventId: source.eventId,
    creationEventSequence: source.eventSequence,
    version: {
      versionId,
      text,
      textHash: await sha256Hex(text),
      basis: "stated",
      origin: "authenticated_first_person",
      uncertain: false,
      sensitivity,
      validFrom: null,
      validTo,
      extractorVersion: "living-notes-test-v1",
      extractorModelId: null,
    },
    sources: [{
      sourceId: newUlid(memory.clock.now()),
      eventId: source.eventId,
      eventSequence: source.eventSequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "telegram",
      occurredAt: source.occurredAt,
    }],
    transition: {
      transitionId: newUlid(memory.clock.now()),
      lifecycleState: "active",
      reason: "authenticated first-person test evidence",
      policyVersion: "living-notes-test-v1",
    },
    placement: {
      placementId: newUlid(memory.clock.now()),
      placementEventId: newUlid(memory.clock.now()),
      topicId: memory.inboxTopicId,
      filingSource: "rule",
      confidence: 0.9,
      reason: "living-note test uses the inbox area",
    },
  });
  return {
    itemId,
    versionId,
    sourceEventId: result.item.sources[0]!.eventId,
    text,
  };
}

function notesFor(topics: readonly PromptTopic[]): readonly Readonly<Record<string, unknown>>[] {
  return topics.map((topic) => {
    const citations = topic.sources.map((source) => source.id);
    const facts = topic.sources.map((source) => `- ${source.date}: ${source.text} (item/event ${source.id})`);
    return {
      kind: "note",
      topicId: topic.topicId,
      sourceIds: citations,
      reason: topic.profile ? "Rebuilt the bounded root profile." : "Rewrote a changed living area.",
      markdown: `## Summary\n${topic.name} summary citing ${citations.join(", ")}.\n\n`
        + `## Current facts\n${facts.join("\n")}\n\n## Open items\n- None recorded.\n\n`
        + `## Related areas\n- ${topic.profile ? "Living topic notes" : "About Sid"}.`,
    };
  });
}

function workflow(
  memory: TestMemory,
  provider: Pick<ModelProvider, "completeJson">,
  extra: Partial<LivingMemoryConsolidationOptions> = {},
): LivingMemoryConsolidationWorkflow {
  return new LivingMemoryConsolidationWorkflow({
    database: env.DB,
    provider,
    providerModelId: MODEL,
    priceId: memory.priceId,
    principalId: memory.principalId,
    now: memory.clock.now,
    ...extra,
  });
}

function noBaseContext(): ContextRetriever {
  return { retrieve: async () => Object.freeze([]) };
}

function telegramRetriever(memory: TestMemory): TelegramMemoryRetriever {
  return new TelegramMemoryRetriever({
    database: env.DB,
    archive: env.ARCHIVE,
    baseContext: noBaseContext(),
    now: memory.clock.now,
  });
}

async function recalledText(memory: TestMemory, query: string): Promise<string> {
  const contexts = await telegramRetriever(memory).retrieve({
    principalId: memory.principalId,
    channel: "telegram",
    purpose: "conversation",
    query,
    maxTokens: 16_384,
  });
  return contexts.map(({ text }) => text).join("\n");
}

async function noteHeadVisibility(memory: TestMemory): Promise<readonly string[]> {
  const result = await env.DB.prepare(`SELECT visibility FROM memory_topic_note_heads
    WHERE principal_id = ? ORDER BY topic_id`).bind(memory.principalId).all<{ visibility: string }>();
  return result.results.map(({ visibility }) => visibility);
}

/**
 * Runs `body` with one production trigger removed, restoring it afterwards.
 *
 * The retriever's anti-join and the 0032 redaction triggers enforce the same
 * promise twice. A test for the retriever therefore has to hold the trigger's
 * effect absent, or it re-proves the trigger and leaves the second layer free
 * to rot -- which is exactly what happened before this test existed: neutering
 * the anti-join left every living-notes test green because the trigger had
 * already redacted the head the assertions were reading.
 */
async function withoutTrigger<T>(name: string, body: () => Promise<T>): Promise<T> {
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
  ).bind(name).first<{ sql: string }>();
  if (trigger === null) throw new Error(`missing trigger ${name}`);
  await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  try {
    return await body();
  } finally {
    await env.DB.prepare(trigger.sql).run();
  }
}

/**
 * Hides one conversation turn the way `history.suppress` does: a canonical
 * owner command event and the suppression row that command authorizes.
 *
 * A hand-written suppression would be refused by
 * `memory_event_suppressions_insert_guard`; bypassing the guard would let the
 * test prove a state the product cannot reach.
 */
async function suppressTurnForTest(
  memory: TestMemory,
  targetEventId: Ulid,
  occurredAt: string,
): Promise<void> {
  const suppressionId = newUlid(memory.clock.now());
  const commandEventId = newUlid(memory.clock.now());
  const contentHash = await sha256Hex(canonicalJson({ suppressionId, commandEventId }));
  const envelope = {
    schemaVersion: "1.0",
    eventId: commandEventId,
    correlationId: commandEventId,
    eventType: "memory.owner_command",
    source: "memory-control",
    subjectId: memory.principalId,
    occurredAt,
    receivedAt: occurredAt,
    contentHash,
    producerVersion: "memory-control-v1",
    payload: {
      operation: "history.suppress",
      targetId: suppressionId,
      targetEventId,
      startEventSequence: null,
      endEventSequence: null,
      newlyHiddenTurnCount: 1,
      totalCoveredTurnCount: 1,
    },
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'memory.owner_command', 'memory-control', ?, ?, ?, ?, ?, ?)`)
    .bind(
      commandEventId,
      memory.principalId,
      occurredAt,
      occurredAt,
      contentHash,
      JSON.stringify(envelope),
      occurredAt,
    ).run();
  await env.DB.prepare(`INSERT INTO memory_event_suppressions (
    suppression_id, principal_id, target_event_id, start_event_sequence,
    end_event_sequence, owner_authorizing_event_id, forgotten_transition_id,
    source_id, reason, newly_hidden_turn_count, total_covered_turn_count, created_at
  ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'owner asked Jarvis to forget this turn', 1, 1, ?)`)
    .bind(suppressionId, memory.principalId, targetEventId, commandEventId, occurredAt).run();
}

function delayedDatabase(database: D1Database, milliseconds: number): Readonly<{
  database: D1Database;
  roundTrips(): number;
  livingNoteReads(): number;
}> {
  let roundTrips = 0;
  let livingNoteReads = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const delay = async <T>(operation: () => Promise<T>): Promise<T> => {
    roundTrips += 1;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return operation();
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement as object, {
      get(target, property): unknown {
        if (property === "bind") return (...values: unknown[]) => wrap((target as D1PreparedStatement).bind(...values));
        if (property === "first" || property === "all" || property === "run" || property === "raw") {
          return (...args: unknown[]) => delay(() => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => Promise<unknown>;
            return method.apply(target, args);
          });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
    originals.set(proxy as object, statement);
    return proxy;
  };
  return {
    database: new Proxy(database as object, {
      get(target, property): unknown {
        if (property === "prepare") return (query: string) => {
          if (query.includes("memory_topic_note_heads head")) livingNoteReads += 1;
          return wrap((target as D1Database).prepare(query));
        };
        if (property === "batch") return (statements: D1PreparedStatement[]) => delay(() =>
          (target as D1Database).batch(statements.map((statement) => originals.get(statement as object) ?? statement)));
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database,
    roundTrips: () => roundTrips,
    livingNoteReads: () => livingNoteReads,
  };
}

beforeAll(async () => applyMemoryLivingNotesMigration());

describe("living memory notes", () => {
  it("bootstraps the root and inbox before the first configured nightly run", async () => {
    const clock = testClock();
    const principalId = `principal:living-notes-bootstrap:${newUlid(clock.now())}`;
    const now = clock.now().toISOString();
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'living notes bootstrap test', ?, ?)`)
      .bind(principalId, now, now).run();
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      monthlyCapUsd: "5",
      now: clock.now,
    });
    const prepared = await budget.prepare(principalId);
    const provider = new CallbackProvider((topics) => notesFor(topics));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver): unknown {
        if (property === "OWNER_PRINCIPAL_ID") return principalId;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const result = await runMemoryConsolidationJob({
      env: bindings,
      clock,
      liveClock: clock,
      delivery: { send: async () => undefined },
      fetcher: globalThis.fetch.bind(globalThis),
      memoryConsolidation: {
        provider,
        providerModelId: MODEL,
        prepare: async () => ({
          priceId: prepared.priceId,
          providerModelId: MODEL,
          d1Statements: 0,
        }),
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
      WHERE principal_id = ? AND status = 'active'`).bind(principalId).first("count")).toBe(2);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topic_note_heads
      WHERE principal_id = ? AND visibility = 'current'`).bind(principalId).first("count")).toBe(2);
  });

  it("rewrites changed areas and the bounded root profile once per Toronto night", async () => {
    const memory = await createTestMemory();
    const item = await seedItem(memory, "My favourite drink is jasmine tea.");
    const provider = new CallbackProvider((topics) => notesFor(topics));

    const first = await workflow(memory, provider).runNight();
    const replay = await workflow(memory, provider).runNight();

    expect(first).toMatchObject({
      outcome: "succeeded",
      continuationRequired: false,
      rewrittenNoteCount: 2,
      failureCode: null,
    });
    expect(replay).toMatchObject({ outcome: "succeeded", idempotentReplay: true });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({ purpose: "memory_consolidation" });
    const profilePrompt = JSON.parse(
      provider.requests[1]!.prompt.slice(provider.requests[1]!.prompt.lastIndexOf("\n") + 1),
    ) as { topics: PromptTopic[] };
    expect(profilePrompt.topics).toHaveLength(1);
    expect(profilePrompt.topics[0]?.profile).toBe(true);
    expect(profilePrompt.topics[0]?.sources[0]?.text).toContain("## Summary");
    const notes = await env.DB.prepare(`SELECT topic_id, markdown, token_count
      FROM memory_topic_note_versions WHERE principal_id = ? ORDER BY topic_id`)
      .bind(memory.principalId).all<{ topic_id: string; markdown: string; token_count: number }>();
    expect(notes.results).toHaveLength(2);
    expect(notes.results.every(({ markdown }) => markdown.includes(item.itemId))).toBe(true);
    expect(notes.results.find(({ topic_id }) => topic_id === memory.rootTopicId)?.token_count)
      .toBeLessThanOrEqual(800);
  });

  it("removes a quoted forgotten fact from note recall on the very next turn", async () => {
    const memory = await createTestMemory();
    const item = await seedItem(memory, "My private garden code word is marigold.");
    const provider = new CallbackProvider((topics) => notesFor(topics));
    await workflow(memory, provider).runNight();
    const retriever = new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
      baseContext: noBaseContext(),
      now: memory.clock.now,
    });
    const before = await retriever.retrieve({
      principalId: memory.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "What is my garden code word?",
      maxTokens: 16_384,
    });
    expect(before.map(({ text }) => text).join("\n")).toContain("marigold");

    const forgetTurn = await seedConversation(memory, "Forget my garden code word.", "forget");
    await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forget({
      ownerTurn: forgetTurn,
      candidateItemIds: [item.itemId],
    });
    const after = await retriever.retrieve({
      principalId: memory.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "What is my garden code word?",
      maxTokens: 16_384,
    });

    expect(after.map(({ text }) => text).join("\n")).not.toContain("marigold");
    expect(await env.DB.prepare(`SELECT visibility FROM memory_topic_note_heads
      WHERE principal_id = ? AND topic_id = ?`).bind(memory.principalId, memory.inboxTopicId)
      .first("visibility")).toBe("redacted");
  });

  it("withholds a forgotten fact from note recall even where the redaction trigger has not run", async () => {
    const memory = await createTestMemory();
    const item = await seedItem(memory, "My private garden code word is marigold.");
    await workflow(memory, new CallbackProvider((topics) => notesFor(topics))).runNight();
    const before = await recalledText(memory, "What is my garden code word?");
    expect(before).toContain("marigold");

    // The redaction trigger is the first layer. It is removed here so the
    // retriever's own anti-join is the only thing left standing between the
    // owner and a forgotten fact -- otherwise this test re-proves the trigger.
    await withoutTrigger("memory_topic_notes_redact_for_event_suppression", async () => {
      const forgetTurn = await seedConversation(memory, "Forget my garden code word.", "forget");
      await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forget({
        ownerTurn: forgetTurn,
        candidateItemIds: [item.itemId],
      });

      // Nothing redacted the notes: they are still current and still cite the
      // forgotten item. Only a retrieval-time guard can withhold them now.
      expect(await noteHeadVisibility(memory)).toEqual(["current", "current"]);
      expect(await recalledText(memory, "What is my garden code word?")).not.toContain("marigold");
    });
  });

  it("withholds a note whose cited turn was suppressed while the fact itself stays active", async () => {
    const memory = await createTestMemory();
    const item = await seedItem(memory, "My spare key is under the blue pot.");
    await workflow(memory, new CallbackProvider((topics) => notesFor(topics))).runNight();
    expect(await recalledText(memory, "Where is my spare key?")).toContain("blue pot");

    await withoutTrigger("memory_topic_notes_redact_for_event_suppression", async () => {
      await suppressTurnForTest(memory, item.sourceEventId, memory.clock.advance().toISOString());

      // A suppressed turn must not be recalled even though the derived fact
      // was never forgotten, so no lifecycle or supersession branch can
      // exclude the note -- only the suppression anti-join can.
      expect(await env.DB.prepare(`SELECT lifecycle_state FROM memory_item_state
        WHERE principal_id = ? AND item_id = ?`).bind(memory.principalId, item.itemId)
        .first("lifecycle_state")).toBe("active");
      expect(await noteHeadVisibility(memory)).toEqual(["current", "current"]);
      expect(await recalledText(memory, "Where is my spare key?")).not.toContain("blue pot");
    });
  });

  it("marks a living note that cites a sensitive fact as restricted", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "My therapy appointment is on Tuesday.", null, "sensitive");
    await workflow(memory, new CallbackProvider((topics) => notesFor(topics))).runNight();
    const contexts = await telegramRetriever(memory).retrieve({
      principalId: memory.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "When is my therapy appointment?",
      maxTokens: 16_384,
    });

    // Every note here derives from the sensitive fact, so a note labelled
    // personal would hand derived sensitive text to the model unlabelled.
    const notes = contexts.filter(({ text }) => text.startsWith("Living "));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.map(({ sensitivity }) => sensitivity)).toEqual(notes.map(() => "restricted"));
  });

  it("keeps both contradictory atomic versions and receipts why the newer one supersedes recall", async () => {
    const memory = await createTestMemory();
    const older = await seedItem(memory, "My bicycle is blue.");
    memory.clock.advance(20);
    const newer = await seedItem(memory, "My bicycle is now green.");
    const provider = new CallbackProvider((topics) => {
      const actions = [...notesFor(topics)];
      const items = topics.flatMap(({ sources }) => sources).filter(({ kind }) => kind === "item");
      const old = items.find(({ text }) => text.includes("blue"));
      const current = items.find(({ text }) => text.includes("green"));
      if (old !== undefined && current !== undefined) actions.push({
        kind: "supersession",
        olderItemId: old.id,
        newerItemId: current.id,
        reason: "The newer owner statement changes the bicycle colour from blue to green.",
      });
      return actions;
    });

    const result = await workflow(memory, provider).runNight();

    expect(result).toMatchObject({ outcome: "succeeded", supersessionCount: 1 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_versions
      WHERE principal_id = ? AND item_id IN (?, ?)`)
      .bind(memory.principalId, older.itemId, newer.itemId).first("count")).toBe(2);
    expect(await env.DB.prepare(`SELECT related_id, reason FROM memory_consolidation_change_receipts
      WHERE principal_id = ? AND change_kind = 'supersession' AND subject_id = ?`)
      .bind(memory.principalId, older.itemId).first()).toMatchObject({
      related_id: newer.itemId,
      reason: expect.stringContaining("newer owner statement"),
    });
    const recalled = await new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
      baseContext: noBaseContext(),
      now: memory.clock.now,
    }).retrieve({
      principalId: memory.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "What colour is my bicycle?",
      maxTokens: 16_384,
    });
    const recallText = recalled.map(({ text }) => text).join("\n");
    expect(recallText).toContain("green");
    expect(recallText).not.toContain("blue");
  });

  it("expires a time-bound fact after its explicit date and omits it from the rewritten note", async () => {
    const memory = await createTestMemory();
    const expired = await seedItem(
      memory,
      "My chemistry test is Friday.",
      new Date(memory.clock.now().getTime() - 1).toISOString(),
    );
    const provider = new CallbackProvider((topics) => notesFor(topics));

    const result = await workflow(memory, provider).runNight();

    expect(result).toMatchObject({ outcome: "succeeded", expiryCount: 1 });
    expect(await env.DB.prepare(`SELECT lifecycle_state FROM memory_item_state
      WHERE principal_id = ? AND item_id = ?`).bind(memory.principalId, expired.itemId)
      .first("lifecycle_state")).toBe("expired");
    const currentNotes = await env.DB.prepare(`SELECT version.markdown
      FROM memory_topic_note_heads head JOIN memory_topic_note_versions version
        ON version.principal_id = head.principal_id
        AND version.note_version_id = head.current_note_version_id
      WHERE head.principal_id = ? AND head.visibility = 'current'`)
      .bind(memory.principalId).all<{ markdown: string }>();
    expect(currentNotes.results.map(({ markdown }) => markdown).join("\n"))
      .not.toContain("chemistry test");
    const recalled = await new TelegramMemoryRetriever({
      database: env.DB,
      archive: env.ARCHIVE,
      baseContext: noBaseContext(),
      now: memory.clock.now,
    }).retrieve({
      principalId: memory.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "When is my chemistry test?",
      maxTokens: 16_384,
    });
    expect(recalled.map(({ text }) => text).join("\n")).not.toContain("chemistry test");
  });

  it("merges duplicate living areas and receipts the canonical destination", async () => {
    const memory = await createTestMemory();
    const health = await memory.repository.resolveOrCreateAutomaticTopicPath(
      memory.principalId,
      ["Health"],
      1,
    );
    const fitness = await memory.repository.resolveOrCreateAutomaticTopicPath(
      memory.principalId,
      ["Fitness"],
      1,
    );
    if (health.topic === null || fitness.topic === null) throw new Error("living_note_topic_fixture_failed");
    const provider = new CallbackProvider((topics) => {
      const actions = [...notesFor(topics)];
      const source = topics.find(({ name }) => name === "Health");
      const target = topics.find(({ name }) => name === "Fitness");
      if (source !== undefined && target !== undefined) actions.push({
        kind: "topic_merge",
        sourceTopicId: source.topicId,
        targetTopicId: target.topicId,
        reason: "Health and Fitness are duplicate areas; Fitness is the canonical destination.",
      });
      return actions;
    });

    const result = await workflow(memory, provider).runNight();

    expect(result).toMatchObject({ outcome: "succeeded", topicMergeCount: 1 });
    expect(await env.DB.prepare(`SELECT status, redirect_to_topic_id FROM memory_topics
      WHERE principal_id = ? AND topic_id = ?`).bind(memory.principalId, health.topic.topicId)
      .first()).toEqual({ status: "merged", redirect_to_topic_id: fitness.topic.topicId });
    expect(await env.DB.prepare(`SELECT related_id, reason FROM memory_consolidation_change_receipts
      WHERE principal_id = ? AND change_kind = 'topic_merge' AND subject_id = ?`)
      .bind(memory.principalId, health.topic.topicId).first()).toMatchObject({
      related_id: fitness.topic.topicId,
      reason: expect.stringContaining("canonical destination"),
    });
    const coverage = await env.DB.prepare(`SELECT
        (SELECT count(*) FROM memory_topics topic
          WHERE topic.principal_id = ? AND topic.status = 'active') AS active_topics,
        (SELECT count(*) FROM memory_topics topic
          JOIN memory_topic_note_heads head
            ON head.principal_id = topic.principal_id AND head.topic_id = topic.topic_id
          WHERE topic.principal_id = ? AND topic.status = 'active'
            AND head.visibility = 'current') AS current_notes`)
      .bind(memory.principalId, memory.principalId)
      .first<{ active_topics: number; current_notes: number }>();
    expect(coverage?.current_notes).toBe(coverage?.active_topics);
  });

  it("resumes a model checkpoint after a mid-run failure without replaying its provider call", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "I keep my passport in the blue drawer.");
    const provider = new CallbackProvider((topics) => notesFor(topics));
    let failed = false;
    const first = await workflow(memory, provider, {
      afterActionCommitted: () => {
        if (!failed) {
          failed = true;
          throw new Error("injected_mid_run_failure");
        }
      },
    }).runNight();

    expect(first).toMatchObject({ outcome: "paused", continuationRequired: true });
    expect(provider.requests).toHaveLength(1);

    const resumed = await workflow(memory, provider).runNight();

    expect(resumed).toMatchObject({ outcome: "succeeded", continuationRequired: false });
    expect(resumed.runId).toBe(first.runId);
    expect(provider.requests).toHaveLength(2);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topic_note_receipts
      WHERE principal_id = ? AND run_id = ?`).bind(memory.principalId, first.runId)
      .first("count")).toBe(2);
  });

  it("places the profile first and remains inside 800 ms with one bounded note read at 25 ms per D1 trip", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "My favourite trail is the Bruce Trail.");
    await workflow(memory, new CallbackProvider((topics) => notesFor(topics))).runNight();
    const delayed = delayedDatabase(env.DB, 25);
    let observedRoundTrips = -1;
    const retriever = new TelegramMemoryRetriever({
      database: delayed.database,
      archive: env.ARCHIVE,
      baseContext: noBaseContext(),
      now: memory.clock.now,
      observeRetrieval: ({ d1RoundTrips }) => { observedRoundTrips = d1RoundTrips; },
    });

    const started = performance.now();
    const contexts = await retriever.retrieve({
      principalId: memory.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "What is my favourite trail?",
      maxTokens: 16_384,
    });
    const elapsed = performance.now() - started;

    expect(contexts[0]?.text).toMatch(/^Living profile/u);
    expect(contexts.some(({ text }) => text.startsWith("Living topic note"))).toBe(true);
    expect(elapsed).toBeLessThan(800);
    expect(delayed.livingNoteReads()).toBe(1);
    expect(observedRoundTrips).toBeLessThanOrEqual(10);
    expect(delayed.roundTrips()).toBeLessThanOrEqual(10);
  });

  it("keeps the stable profile prefix on a turn with no matching item candidates", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "My favourite trail is the Bruce Trail.");
    await workflow(memory, new CallbackProvider((topics) => notesFor(topics))).runNight();
    const delayed = delayedDatabase(env.DB, 25);
    const contexts = await new TelegramMemoryRetriever({
      database: delayed.database,
      archive: env.ARCHIVE,
      baseContext: noBaseContext(),
      now: memory.clock.now,
    }).retrieve({
      principalId: memory.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "hello",
      maxTokens: 16_384,
    });

    expect(contexts[0]?.text).toMatch(/^Living profile/u);
    expect(delayed.livingNoteReads()).toBe(1);
    expect(delayed.roundTrips()).toBeLessThanOrEqual(10);
  });

  it("charges consolidation through the existing monthly ledger and records settled spend", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "I prefer concise weekly summaries.");
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      monthlyCapUsd: "5",
      now: memory.clock.now,
    });
    const prepared = await budget.prepare(memory.principalId);
    const requests: Request[] = [];
    const provider = new DeepSeekJsonProvider({
      apiKey: "test-key",
      model: "deepseek-flash",
      budget,
      fetchImplementation: async (_input, init) => {
        requests.push(new Request("https://fixture.invalid", init));
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const prompt = body.messages[1]!.content;
        const payload = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as { topics: PromptTopic[] };
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ proposals: notesFor(payload.topics) }) } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 30,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 100,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await new LivingMemoryConsolidationWorkflow({
      database: env.DB,
      provider,
      providerModelId: MODEL,
      priceId: prepared.priceId,
      principalId: memory.principalId,
      now: memory.clock.now,
    }).runNight();

    expect(result.settledCostMicros).toBeGreaterThan(0);
    expect(requests).toHaveLength(2);
    expect(await env.DB.prepare(`SELECT group_concat(entry_type, ',') AS entries
      FROM memory_cost_ledger WHERE principal_id = ? AND run_id = ? ORDER BY occurred_at`)
      .bind(memory.principalId, result.runId).first("entries"))
      .toBe("reservation,settlement,reservation,settlement");
    expect(await env.DB.prepare(`SELECT settled_cost_micros FROM memory_runs
      WHERE principal_id = ? AND run_id = ?`).bind(memory.principalId, result.runId)
      .first("settled_cost_micros")).toBe(result.settledCostMicros);
  });

  it("stops before the provider when the existing monthly memory cap cannot reserve the run", async () => {
    const memory = await createTestMemory("0.000001");
    await seedItem(memory, "I prefer a budget guard that is load-bearing.");
    const budget = new MemoryExtractionBudget({
      database: env.DB,
      modelId: "deepseek-flash",
      monthlyCapUsd: "0.000001",
      now: memory.clock.now,
    });
    const prepared = await budget.prepare(memory.principalId);
    let calls = 0;
    const provider = new DeepSeekJsonProvider({
      apiKey: "test-key",
      model: "deepseek-flash",
      budget,
      fetchImplementation: async () => {
        calls += 1;
        throw new Error("provider must not be reached");
      },
    });

    const result = await new LivingMemoryConsolidationWorkflow({
      database: env.DB,
      provider,
      providerModelId: MODEL,
      priceId: prepared.priceId,
      principalId: memory.principalId,
      now: memory.clock.now,
    }).runNight();

    expect(result).toMatchObject({ outcome: "budget_blocked", settledCostMicros: 0 });
    expect(calls).toBe(0);
  });

  it("accepts a note whose markdown names none of its source ids and applies it", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "My favourite drink is jasmine tea.");
    const provider = new CallbackProvider((topics) => topics.map((topic) => ({
      kind: "note",
      topicId: topic.topicId,
      sourceIds: topic.sources.map((source) => source.id),
      reason: "Wrote the note in my own words.",
      // The id-shaped token is not a source. Prose is the model's; code does
      // not read ids out of it.
      markdown: `${topic.name}: tea, and a calm morning. Order 01k5nm0000000000000000000z.`,
    })));

    const result = await workflow(memory, provider).runNight();

    expect(result).toMatchObject({
      outcome: "succeeded",
      rewrittenNoteCount: 2,
      failureCode: null,
    });
    const notes = await env.DB.prepare(`SELECT markdown FROM memory_topic_note_versions
      WHERE principal_id = ? ORDER BY topic_id`).bind(memory.principalId)
      .all<{ markdown: string }>();
    expect(notes.results).toHaveLength(2);
    for (const { markdown } of notes.results) {
      expect(markdown).toMatch(/: tea, and a calm morning\. Order 01k5nm0000000000000000000z\.$/u);
    }
  });

  it("still refuses a note whose sourceIds name a source that was not supplied", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "The owner prefers a short nightly summary.");
    const neverSupplied = "01k5nm0000000000000000000v" as Ulid;
    const provider = new CallbackProvider((topics) => topics.map((topic) => ({
      kind: "note",
      topicId: topic.topicId,
      sourceIds: [...topic.sources.map((source) => source.id), neverSupplied],
      reason: "Cited an id that was not in the prompt.",
      markdown: `${topic.name}: a summary.`,
    })));

    const result = await workflow(memory, provider).runNight();

    // The whole step is refused before anything is applied, which is the
    // receipt: no note version lands in the database at all.
    expect(result).toMatchObject({
      outcome: "failed",
      failureCode: "memory_consolidation_provider_output_invalid",
    });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topic_note_versions
      WHERE principal_id = ?`).bind(memory.principalId).first("count")).toBe(0);
  });

  it("reports a failed nightly consolidation phase as a scheduled-job failure", async () => {
    const memory = await createTestMemory();
    await seedItem(memory, "A failed note rewrite must not look like a quiet nightly run.");
    const provider = new CallbackProvider(() => []);
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver): unknown {
        if (property === "OWNER_PRINCIPAL_ID") return memory.principalId;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const context: JobEnvironment = {
      env: bindings,
      clock: memory.clock,
      liveClock: memory.clock,
      delivery: { send: async () => undefined },
      fetcher: globalThis.fetch.bind(globalThis),
      memoryConsolidation: {
        provider,
        providerModelId: MODEL,
        prepare: async () => ({
          priceId: memory.priceId,
          providerModelId: MODEL,
          d1Statements: 0,
        }),
      },
    };
    expect(await runMemoryConsolidationJob(context)).toEqual({
      ok: false,
      failure: "memory_consolidation_provider_output_invalid",
    });
    expect(provider.requests).toHaveLength(1);
  });
});

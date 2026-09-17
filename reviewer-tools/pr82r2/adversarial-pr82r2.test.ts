import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  AUTOMATIC_DISTILLATION_STEP_LIMITS,
  AUTOMATIC_INBOX_REFILE_D1_STATEMENT_CEILING,
  AutomaticMemoryDistillationWorkflow,
} from "../../src/memory/automatic-distillation.js";
import {
  automaticFilingReason,
  createMemoryRepositoryForTest,
  MemoryRepository,
  type AutomaticFilingDecision,
} from "../../src/memory/memory-repository.js";
import type { CommitInitialMemoryInput } from "../../src/memory/memory-types.js";
import { EventRepository, type AppendedEvent } from "../../src/persistence/event-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { Redactor } from "../../src/security/redaction.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

// Narrow adversarial review of PR #82 round 2 (head e4fb760). Every test asserts
// the behaviour the design requires; a failing test is a proven defect.

const MODEL_ID = "openai:fake-memory-distillation-v1";
const INBOX = "Inbox / Needs filing";
const MODEL_TOPIC_REASON = "model-inference automatic filing path";
const redactor = new Redactor();
let serial = 0;
let clock = Date.now() + 1_000;

type FilingRepository = Pick<MemoryRepository,
  | "bootstrapTopics"
  | "commitInitialItem"
  | "resolveOrCreateAutomaticTopicPath"
  | "refileAutomaticInboxItems">;

function nextTimestamp(): string {
  clock = Math.max(Date.now() + 1_000, clock + 10);
  return new Date(clock).toISOString();
}

function redactPayload(value: unknown): RedactedJsonValue {
  if (typeof value === "string") {
    const result = redactor.redactText(value);
    if (!result.ok || result.text !== value) throw new Error("adversarial_fixture_redaction_failed");
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  if (typeof value !== "object") throw new Error("adversarial_fixture_payload_invalid");
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactPayload(child)]));
}

async function principal(): Promise<string> {
  serial += 1;
  const principalId = `principal:adversarial-pr82r2:${serial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'adversarial pr82r2 test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

async function appendConversation(
  events: EventRepository,
  principalId: string,
  text: string,
  directOwnerText = true,
): Promise<AppendedEvent> {
  const now = new Date().toISOString();
  const eventId = newUlid();
  const envelope: PersistableEventEnvelopeV1 = await createEnvelope({
    schemaVersion: "1.0",
    eventId,
    eventType: "conversation.user_committed",
    source: "conversation",
    subjectId: principalId,
    occurredAt: now,
    receivedAt: now,
    correlationId: newUlid(),
    contentType: "application/json",
    payload: redactPayload({
      schemaCode: 1,
      channelCode: 2,
      sensitivityCode: 1,
      historyEligible: true,
      text,
      ...(directOwnerText ? { directOwnerText: true } : {}),
    }),
    producerVersion: "conversation-v1",
  });
  return events.append({
    envelope,
    scope: "adversarial-pr82r2-test",
    key: eventId,
    requestHash: await sha256Hex(canonicalJson([eventId, text])),
  });
}

function proposal(
  sources: readonly AppendedEvent[],
  sourceTexts: readonly string[],
  text: string,
  topicPath: unknown,
  filingConfidence: unknown = 0.9,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    text,
    sourceEventIds: sources.map((event) => event.envelope.eventId),
    sourceExcerpts: sources.map((event, index) => ({
      sourceEventId: event.envelope.eventId,
      excerpt: sourceTexts[index],
    })),
    confidence: 0.95,
    sensitivity: "normal",
    topicPath,
    filingConfidence,
  });
}

function workflow(
  principalId: string,
  provider: FakeModelProvider,
  repository?: FilingRepository,
  database: D1Database = env.DB,
): AutomaticMemoryDistillationWorkflow {
  const archive = new ArchivalService({ database, bucket: env.ARCHIVE });
  return new AutomaticMemoryDistillationWorkflow({
    database,
    events: new TieredEventReader({
      live: new EventRepository(database),
      archive,
      state: new ArchiveRepository(database),
    }),
    repository: repository ?? new MemoryRepository(database, { archivedEventReader: archive }),
    provider,
    providerModelId: MODEL_ID,
    principalId,
    now: () => new Date(),
  });
}

function queryCountingDatabase(
  failRun?: (query: string) => boolean,
): { readonly database: D1Database; queryCount(): number } {
  let count = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values), query),
      first: async <T>(columnName?: string) => {
        count += 1;
        return columnName === undefined ? statement.first<T>() : statement.first<T>(columnName);
      },
      run: async <T>() => {
        count += 1;
        if (failRun?.(query) === true) throw new Error("fixture_d1_write_unavailable");
        return statement.run<T>();
      },
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
      prepare: (query: string) => wrap(env.DB.prepare(query), query),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        count += statements.length;
        return env.DB.batch<T>(statements.map((statement) => originals.get(statement as object) ?? statement));
      },
    } as D1Database,
    queryCount: () => count,
  };
}

async function itemCount(principalId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS count FROM memory_items WHERE principal_id = ?")
    .bind(principalId).first<{ count: number }>();
  return row?.count ?? -1;
}

async function placementOf(principalId: string, itemId: string): Promise<{
  topic_id: string;
  display_name: string;
  reason: string;
}> {
  const row = await env.DB.prepare(`SELECT placement.topic_id, topic.display_name, event.reason
    FROM memory_item_placement_state placement
    JOIN memory_item_placement_events event
      ON event.principal_id = placement.principal_id
      AND event.placement_id = placement.placement_id
      AND event.placement_event_number = placement.last_placement_event_number
    JOIN memory_topics topic
      ON topic.principal_id = placement.principal_id AND topic.topic_id = placement.topic_id
    WHERE placement.principal_id = ? AND placement.item_id = ?
      AND placement.relation = 'primary' AND placement.status = 'active'`)
    .bind(principalId, itemId).first<{ topic_id: string; display_name: string; reason: string }>();
  if (row === null) throw new Error("adversarial_placement_missing");
  return row;
}

async function placementsByText(principalId: string): Promise<Map<string, {
  topic_id: string;
  display_name: string;
  reason: string;
}>> {
  const rows = await env.DB.prepare(`SELECT version.text, placement.topic_id, topic.display_name, event.reason
    FROM memory_item_placement_state placement
    JOIN memory_item_state state
      ON state.principal_id = placement.principal_id AND state.item_id = placement.item_id
    JOIN memory_item_versions version
      ON version.principal_id = state.principal_id AND version.version_id = state.current_version_id
    JOIN memory_item_placement_events event
      ON event.principal_id = placement.principal_id
      AND event.placement_id = placement.placement_id
      AND event.placement_event_number = placement.last_placement_event_number
    JOIN memory_topics topic
      ON topic.principal_id = placement.principal_id AND topic.topic_id = placement.topic_id
    WHERE placement.principal_id = ? AND placement.relation = 'primary' AND placement.status = 'active'`)
    .bind(principalId)
    .all<{ text: string; topic_id: string; display_name: string; reason: string }>();
  return new Map(rows.results.map((row) => [row.text, row]));
}

async function modelTopicCount(principalId: string): Promise<number> {
  return await env.DB.prepare(`SELECT count(*) AS count FROM memory_topic_events
    WHERE principal_id = ? AND reason = ?`).bind(principalId, MODEL_TOPIC_REASON).first<number>("count") ?? -1;
}

async function activeChildren(principalId: string, parentTopicId: string): Promise<number> {
  return await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
    WHERE principal_id = ? AND parent_topic_id = ? AND status = 'active'`)
    .bind(principalId, parentTopicId).first<number>("count") ?? -1;
}

async function createTopic(principalId: string, parentTopicId: string, displayName: string): Promise<Ulid> {
  const topicId = newUlid();
  await env.DB.prepare(`INSERT INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation,
    previous_parent_topic_id, new_parent_topic_id,
    previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 'create', NULL, ?, NULL, NULL, ?, ?, NULL,
    '[]', '[]', '[]', 'adversarial topic create', 'rules', NULL, ?)`)
    .bind(
      newUlid(),
      principalId,
      topicId,
      parentTopicId,
      displayName,
      displayName.normalize("NFC").toLocaleLowerCase("en-US"),
      nextTimestamp(),
    ).run();
  return topicId;
}

async function renameTopic(
  principalId: string,
  topicId: string,
  previousName: string,
  nextName: string,
  pathAlias: string,
): Promise<void> {
  const aliasName = pathAlias.split("/").at(-1) ?? previousName;
  await env.DB.prepare(`INSERT INTO memory_topic_events (
    topic_event_id, principal_id, topic_id, operation,
    previous_parent_topic_id, new_parent_topic_id,
    previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, 'rename', NULL, NULL, ?, ?, ?, ?, NULL,
    '[]', '[]', ?, 'adversarial topic rename', 'rules', NULL, ?)`)
    .bind(
      newUlid(),
      principalId,
      topicId,
      previousName,
      previousName.normalize("NFC").toLocaleLowerCase("en-US"),
      nextName,
      nextName.normalize("NFC").toLocaleLowerCase("en-US"),
      JSON.stringify([{
        aliasId: newUlid(),
        topicId,
        displayName: aliasName,
        normalizedName: aliasName.normalize("NFC").toLocaleLowerCase("en-US"),
        pathAlias,
      }]),
      nextTimestamp(),
    ).run();
}

async function itemInput(
  events: EventRepository,
  principalId: string,
  inboxTopicId: Ulid,
  text: string,
  decision: AutomaticFilingDecision,
  topicPath: readonly string[],
  automaticFiling?: Readonly<{ topicPath: readonly string[]; maximumNewTopics: number; inboxTopicId: Ulid }>,
): Promise<CommitInitialMemoryInput> {
  const event = await appendConversation(events, principalId, text);
  return Object.freeze({
    principalId,
    itemId: newUlid(),
    kind: "fact" as const,
    creationEventId: event.envelope.eventId,
    creationEventSequence: event.eventSequence,
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
      extractorVersion: "automatic-distillation-v1",
      extractorModelId: null,
    }),
    sources: Object.freeze([Object.freeze({
      sourceId: newUlid(),
      eventId: event.envelope.eventId,
      eventSequence: event.eventSequence,
      sourceLocation: "live" as const,
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "telegram" as const,
      occurredAt: event.envelope.occurredAt,
    })]),
    transition: Object.freeze({
      transitionId: newUlid(),
      lifecycleState: "active" as const,
      reason: "exact authenticated first-person evidence",
      policyVersion: "automatic-distillation-v1",
    }),
    placement: Object.freeze({
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: inboxTopicId,
      filingSource: "rule" as const,
      confidence: 0.9,
      reason: automaticFilingReason(decision, topicPath),
    }),
    ...(automaticFiling === undefined ? {} : { automaticFiling }),
  });
}

async function commitInboxItem(
  repository: MemoryRepository,
  events: EventRepository,
  principalId: string,
  inboxTopicId: Ulid,
  text: string,
  decision: AutomaticFilingDecision,
  topicPath: readonly string[],
): Promise<Ulid> {
  const input = await itemInput(events, principalId, inboxTopicId, text, decision, topicPath);
  await repository.commitInitialItem(input);
  return input.itemId;
}

async function storedTextContaining(marker: string): Promise<string[]> {
  const tables = await env.DB.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>();
  const hits: string[] = [];
  for (const table of tables.results) {
    try {
      const rows = await env.DB.prepare(`SELECT * FROM "${table.name}"`).all();
      for (const row of rows.results) {
        if (JSON.stringify(row).includes(marker)) hits.push(table.name);
      }
    } catch {
      // Virtual-table internals that cannot be selected directly are skipped.
    }
  }
  return [...new Set(hits)];
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
});

beforeEach(async () => {
  await resetArchiveFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PR #82 r2: areas and the item commit in one batch", () => {
  it("R1 replays an identical automatic-filing commit exactly after it created the path, even after a rename", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const path = ["Clubs", "Robotics", "Build season", "Drive team"];
    const input = await itemInput(events, principalId, topics.inbox.topicId,
      "I joined the drive team.", "inbox_filing_failure", path,
      { topicPath: path, maximumNewTopics: 6, inboxTopicId: topics.inbox.topicId });

    const first = await repository.commitInitialItem(input);
    const placed = await placementOf(principalId, input.itemId);
    const second = await repository.commitInitialItem(input);
    await renameTopic(principalId, placed.topic_id, "Drive team", "Drivers", "Memory/Clubs/Robotics/Build season/Drive team");
    const third = await repository.commitInitialItem(input);

    expect(first).toMatchObject({ replayed: false, automaticFilingCreatedTopicCount: 4 });
    expect(placed.display_name).toBe("Drive team");
    expect(placed.reason).toContain('"decision":"filed_created"');
    expect(second).toMatchObject({ replayed: true, automaticFilingCreatedTopicCount: 0 });
    expect(third).toMatchObject({ replayed: true, automaticFilingCreatedTopicCount: 0 });
    expect(await modelTopicCount(principalId)).toBe(4);
  });

  it("R2 counts the four areas of a commit whose D1 batch committed but whose response was lost", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const first = "I joined the robotics drive team.";
    const second = "I started the chess ladder.";
    const e1 = await appendConversation(events, principalId, first);
    const e2 = await appendConversation(events, principalId, second);
    let lost = false;
    const lossy = {
      prepare: (query: string) => env.DB.prepare(query),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const result = await env.DB.batch<T>(statements);
        if (!lost && statements.length >= 9) {
          lost = true;
          throw new Error("fixture_response_lost");
        }
        return result;
      },
    } as D1Database;
    const provider = new FakeModelProvider({
      completeJson: [
        proposal([e1], [first], first, ["Clubs", "Robotics", "Build season", "Drive team"]),
        proposal([e2], [second], second, ["Games", "Chess", "Ladder"]),
      ],
    });

    const distillation = workflow(principalId, provider, new MemoryRepository(lossy));
    // The lost response makes this run finalize as failed (pre-existing replay
    // receipt behaviour, unchanged by round 2); the next run must advance.
    await distillation.runNext({ runKey: `r2a:${newUlid()}` });
    const next = await distillation.runNext({ runKey: `r2b:${newUlid()}` });
    const placed = await placementsByText(principalId);

    expect(lost).toBe(true);
    expect(next.outcome).toBe("nothing_new");
    expect(next.cursorEventSequence).toBe(e2.eventSequence);
    expect(placed.get(first)?.display_name).toBe("Drive team");
    // Six-per-run cap: 4 created, so a 3-area path must go to Inbox as inbox_cap.
    expect(placed.get(second)?.display_name).toBe(INBOX);
    expect(placed.get(second)?.reason).toContain('"decision":"inbox_cap"');
    expect(await modelTopicCount(principalId)).toBe(4);
  });

  it("R3 two proposals in one step reuse one new area, count it once, and the cap still bites at six", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const texts = [
      "I joined the robotics club.",
      "I built the robotics arm.",
      "I started the delta project.",
      "I tried the omega puzzle.",
    ];
    const appended: AppendedEvent[] = [];
    for (const text of texts) appended.push(await appendConversation(events, principalId, text));
    const paths = [
      ["Clubs", "Robotics"],
      ["clubs", "ROBOTICS"],
      ["Alpha", "Beta", "Gamma", "Delta"],
      ["Omega"],
    ];
    const provider = new FakeModelProvider({
      completeJson: texts.map((text, index) =>
        proposal([appended[index] as AppendedEvent], [text], text, paths[index])),
    });

    const result = await workflow(principalId, provider).runNext({ runKey: `r3:${newUlid()}` });
    const placed = await placementsByText(principalId);

    expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 4 });
    expect(placed.get(texts[0] ?? "")?.display_name).toBe("Robotics");
    expect(placed.get(texts[1] ?? "")?.topic_id).toBe(placed.get(texts[0] ?? "")?.topic_id);
    expect(placed.get(texts[2] ?? "")?.display_name).toBe("Delta");
    expect(placed.get(texts[3] ?? "")?.reason).toContain('"decision":"inbox_cap"');
    expect(await modelTopicCount(principalId)).toBe(6);
  });

  it("R4 a zero-row child-cap insert at the top of a four-area create falls back to Inbox with no orphan areas", async () => {
    const principalId = await principal();
    const canonical = new MemoryRepository(env.DB);
    const topics = await canonical.bootstrapTopics(principalId);
    for (let index = 0; index < 38; index += 1) {
      const created = await canonical.resolveOrCreateAutomaticTopicPath(principalId, [`Filler ${index}`], 1);
      if (created.topic === null) throw new Error("adversarial_filler_missing");
    }
    const repository = createMemoryRepositoryForTest(env.DB, {
      beforeBatch: async (operation, attempt) => {
        if (operation === "commit" && attempt === 1) {
          await canonical.resolveOrCreateAutomaticTopicPath(principalId, ["Race winner"], 1);
        }
      },
    });
    const events = new EventRepository(env.DB);
    const text = "I kept the deep raced note.";
    const event = await appendConversation(events, principalId, text);

    const result = await workflow(principalId, new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["Deep one", "Deep two", "Deep three", "Deep four"])],
    }), repository).runNext({ runKey: `r4:${newUlid()}` });
    const placed = await placementsByText(principalId);

    expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 1 });
    expect(placed.get(text)?.display_name).toBe(INBOX);
    expect(placed.get(text)?.reason).toContain('"decision":"inbox_cap"');
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topic_events
      WHERE principal_id = ? AND new_display_name LIKE 'Deep %'`).bind(principalId).first("count")).toBe(0);
    expect(await activeChildren(principalId, topics.root.topicId)).toBe(40);
  });

  it("R5 a real in-batch failure on both attempts fails the step and leaves no model areas", async () => {
    const principalId = await principal();
    const repository = createMemoryRepositoryForTest(env.DB, {
      batchFault: (operation) => operation === "commit"
        ? env.DB.prepare("INSERT INTO memory_repository_missing_fault_target(value) VALUES (1)")
        : null,
    });
    const events = new EventRepository(env.DB);
    const text = "I signed up for the physics olympiad.";
    const event = await appendConversation(events, principalId, text);

    const result = await workflow(principalId, new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School", "Physics", "Olympiad"])],
    }), repository).runNext({ runKey: `r5:${newUlid()}` });

    expect(result.outcome).toBe("failed");
    expect(await itemCount(principalId)).toBe(0);
    expect(await modelTopicCount(principalId)).toBe(0);
  });

  it("R6 a failed first batch attempt then a committed retry counts only the committed areas", async () => {
    const principalId = await principal();
    const repository = createMemoryRepositoryForTest(env.DB, {
      batchFault: (operation, attempt) => operation === "commit" && attempt === 1
        ? env.DB.prepare("INSERT INTO memory_repository_missing_fault_target(value) VALUES (1)")
        : null,
    });
    const events = new EventRepository(env.DB);
    const first = "I joined the robotics drive team.";
    const second = "I started the chess ladder.";
    const e1 = await appendConversation(events, principalId, first);
    const e2 = await appendConversation(events, principalId, second);

    const result = await workflow(principalId, new FakeModelProvider({
      completeJson: [
        proposal([e1], [first], first, ["Clubs", "Robotics", "Build season", "Drive team"]),
        proposal([e2], [second], second, ["Games", "Chess", "Ladder"]),
      ],
    }), repository).runNext({ runKey: `r6:${newUlid()}` });
    const placed = await placementsByText(principalId);

    expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 2 });
    expect(placed.get(first)?.display_name).toBe("Drive team");
    expect(placed.get(second)?.reason).toContain('"decision":"inbox_cap"');
    expect(await modelTopicCount(principalId)).toBe(4);
  });
});

describe("PR #82 r2: NFKC matching without a migration", () => {
  it("N1 does not create an area whose full-width '＞' or '／' reads like a path separator", async () => {
    for (const name of ["School ＞ Chemistry", "School／Chemistry"]) {
      const principalId = await principal();
      const repository = new MemoryRepository(env.DB);
      const topics = await repository.bootstrapTopics(principalId);
      const events = new EventRepository(env.DB);
      const text = `I finished the titration lab ${name.length}.`;
      const event = await appendConversation(events, principalId, text);

      await workflow(principalId, new FakeModelProvider({
        completeJson: [proposal([event], [text], text, [name])],
      }), repository).runNext({ runKey: `n1:${newUlid()}` });

      expect(await activeChildren(principalId, topics.root.topicId)).toBe(1);
    }
  });

  it("N2 does not create an invisible twin of an existing area (variation selector, grapheme joiner, Hangul filler)", async () => {
    for (const [existing, variant] of [
      ["Music ❤", "Music ❤️"],
      ["School", "School͏"],
      ["School", "Schoㅤol"],
    ] as const) {
      const principalId = await principal();
      const repository = new MemoryRepository(env.DB);
      const topics = await repository.bootstrapTopics(principalId);
      await repository.resolveOrCreateAutomaticTopicPath(principalId, [existing], 1);
      const events = new EventRepository(env.DB);
      const text = `I noted the twin case ${variant.length}.`;
      const event = await appendConversation(events, principalId, text);

      await workflow(principalId, new FakeModelProvider({
        completeJson: [proposal([event], [text], text, [variant])],
      }), repository).runNext({ runKey: `n2:${newUlid()}` });

      expect({ variant: JSON.stringify(variant), children: await activeChildren(principalId, topics.root.topicId) })
        .toEqual({ variant: JSON.stringify(variant), children: 2 });
    }
  });

  it("N3 always picks the oldest of two pre-existing NFKC-equal siblings and creates no third", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const ligature = await createTopic(principalId, topics.root.topicId, "ﬁnance");
    const plain = await createTopic(principalId, topics.root.topicId, "Finance");
    const events = new EventRepository(env.DB);
    const texts = ["I paid the phone bill.", "I opened a savings account."];

    for (const [index, text] of texts.entries()) {
      const event = await appendConversation(events, principalId, text);
      await workflow(principalId, new FakeModelProvider({
        completeJson: [proposal([event], [text], text, ["ＦＩＮＡＮＣＥ"])],
      }), repository).runNext({ runKey: `n3:${index}:${newUlid()}` });
    }
    const placed = await placementsByText(principalId);

    expect(placed.get(texts[0] ?? "")?.topic_id).toBe(ligature);
    expect(placed.get(texts[1] ?? "")?.topic_id).toBe(ligature);
    expect(plain).not.toBe(ligature);
    expect(await activeChildren(principalId, topics.root.topicId)).toBe(3);
  });

  it("N4 reuses a full-width-created area when the ASCII spelling arrives later", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const wide = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["Ｒｏｂｏｔｉｃｓ"], 1);
    if (wide.topic === null) throw new Error("adversarial_wide_missing");
    const events = new EventRepository(env.DB);
    const text = "I rebuilt the robot gripper.";
    const event = await appendConversation(events, principalId, text);

    await workflow(principalId, new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["robotics"])],
    }), repository).runNext({ runKey: `n4:${newUlid()}` });

    expect((await placementsByText(principalId)).get(text)?.topic_id).toBe(wide.topic.topicId);
    expect(await activeChildren(principalId, topics.root.topicId)).toBe(2);
  });

  it("N5 applies the same NFKC folding to a renamed area's alias", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const chem = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["Chem"], 1);
    if (chem.topic === null) throw new Error("adversarial_chem_missing");
    await renameTopic(principalId, chem.topic.topicId, "Chem", "Chemistry", "Memory/Chem");
    const events = new EventRepository(env.DB);
    const text = "I balanced the redox equation.";
    const event = await appendConversation(events, principalId, text);

    await workflow(principalId, new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["ＣＨＥＭ"])],
    }), repository).runNext({ runKey: `n5:${newUlid()}` });

    expect((await placementsByText(principalId)).get(text)?.topic_id).toBe(chem.topic.topicId);
    expect(await activeChildren(principalId, topics.root.topicId)).toBe(2);
  });
});

describe("PR #82 r2: invalid paths", () => {
  it("I1 never stores or logs a rejected path, including a secret-like one", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
      });
    }
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["Zqxwmarkerfive", ["Zqxwmarkerfive a", "b", "c", "d", "e"]],
      ["Zqxwmarkernewline", ["Family", "Zqxwmarkernewline\nJuly"]],
      ["hunter2hunter2zq", ["Accounts", "password: hunter2hunter2zq"]],
      ["sk-zqxw1234567890abcdefghij", ["Keys", "sk-zqxw1234567890abcdefghij"]],
    ];
    for (const [marker, topicPath] of cases) {
      const principalId = await principal();
      const events = new EventRepository(env.DB);
      const text = `I kept the path privacy fact ${marker.length}.`;
      const event = await appendConversation(events, principalId, text);

      const result = await workflow(principalId, new FakeModelProvider({
        completeJson: [proposal([event], [text], text, topicPath)],
      })).runNext({ runKey: `i1:${newUlid()}` });
      const placed = (await placementsByText(principalId)).get(text);

      expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 1 });
      expect(placed?.display_name).toBe(INBOX);
      expect(placed?.reason).toContain('"decision":"inbox_invalid_path"');
      expect({ marker, tables: await storedTextContaining(marker) }).toEqual({ marker, tables: [] });
      expect(logged.filter((line) => line.includes(marker))).toEqual([]);
    }
  }, 60_000);

  it("I2 non-number filingConfidence values never file, create or skip the Inbox", async () => {
    for (const filingConfidence of [null, true, "0.9", [0.9], { value: 0.9 }]) {
      const principalId = await principal();
      const repository = new MemoryRepository(env.DB);
      const topics = await repository.bootstrapTopics(principalId);
      const events = new EventRepository(env.DB);
      const text = `I kept the filing confidence case ${JSON.stringify(filingConfidence).length}.`;
      const event = await appendConversation(events, principalId, text);

      const result = await workflow(principalId, new FakeModelProvider({
        completeJson: [proposal([event], [text], text, ["Brand new area"], filingConfidence)],
      }), repository).runNext({ runKey: `i2:${newUlid()}` });
      const placed = (await placementsByText(principalId)).get(text);

      expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 1 });
      expect(placed?.topic_id).toBe(topics.inbox.topicId);
      expect(placed?.reason).toContain('"decision":"inbox_low_confidence"');
      expect(await modelTopicCount(principalId)).toBe(0);
    }
  });
});

describe("PR #82 r2: Inbox re-file", () => {
  it("C2 is not starved by one hundred older Inbox items whose areas never appear", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const school = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    if (school.topic === null) throw new Error("adversarial_school_missing");
    for (let index = 0; index < 100; index += 1) {
      await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
        `I capped never area note ${index}.`, "inbox_cap", [`Never area ${index}`]);
    }
    const fileable = await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "I capped the late school note.", "inbox_cap", ["School"]);

    for (let hour = 0; hour < 3; hour += 1) await repository.refileAutomaticInboxItems(principalId);

    expect((await placementOf(principalId, fileable)).display_name).toBe("School");
  }, 120_000);

  it("C3 re-file folds NFKC and case (a full-width path moves) but still never follows an alias", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const school = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    const chem = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["Chem"], 1);
    if (school.topic === null || chem.topic === null) throw new Error("adversarial_refile_fixture_missing");
    await renameTopic(principalId, chem.topic.topicId, "Chem", "Chemistry", "Memory/Chem");
    const wide = await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "I capped the wide school note.", "inbox_cap", ["ＳＣＨＯＯＬ"]);
    const aliased = await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "I capped the chem alias note.", "inbox_cap", ["Chem"]);

    const first = await repository.refileAutomaticInboxItems(principalId);
    const replay = await repository.refileAutomaticInboxItems(principalId);

    expect((await placementOf(principalId, wide)).topic_id).toBe(school.topic.topicId);
    expect((await placementOf(principalId, aliased)).topic_id).toBe(topics.inbox.topicId);
    expect(first.refiledItemCount).toBe(1);
    expect(replay.refiledItemCount).toBe(0);
  });
});

describe("PR #82 r2: D1 budget honesty", () => {
  it("D1 worst filing step: 32 proposals, three alias levels, capped fourth level, stays under the charged budget", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    await repository.bootstrapTopics(principalId);
    const names = ["Area one", "Area two", "Area three"];
    const renamed = ["Renamed one", "Renamed two", "Renamed three"];
    const created = await repository.resolveOrCreateAutomaticTopicPath(principalId, names, 3);
    if (created.topic === null) throw new Error("adversarial_alias_path_missing");
    const ids = created.topic.path.slice(1).map((entry) => entry.topicId);
    for (let index = 0; index < 3; index += 1) {
      const aliasPath = ["Memory", ...renamed.slice(0, index), names[index]].join("/");
      await renameTopic(principalId, ids[index] ?? "", names[index] ?? "", renamed[index] ?? "", aliasPath);
    }
    for (let index = 0; index < 40; index += 1) await createTopic(principalId, ids[2] ?? "", `Full child ${index}`);
    const events = new EventRepository(env.DB);
    const appended: AppendedEvent[] = [];
    const texts: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      texts.push(`I measured worst statement sentence ${index}.`);
      appended.push(await appendConversation(events, principalId, texts[index] ?? ""));
    }
    const proposals: Record<string, unknown>[] = [];
    for (let index = 0; index < 8; index += 1) {
      for (let offset = 0; offset < 4; offset += 1) {
        const sourceIndexes = [...Array(8).keys()].filter((position) =>
          offset === 0 || position === index || position !== (index + offset) % 8);
        proposals.push(proposal(
          sourceIndexes.map((position) => appended[position] as AppendedEvent),
          sourceIndexes.map((position) => texts[position] ?? ""),
          texts[index] ?? "",
          [...names, "New leaf"],
        ));
      }
    }
    const counted = queryCountingDatabase();
    const archive = new ArchivalService({ database: counted.database, bucket: env.ARCHIVE });

    const result = await workflow(
      principalId,
      new FakeModelProvider({ completeJson: proposals }),
      new MemoryRepository(counted.database, { archivedEventReader: archive }),
      counted.database,
    ).runNext({ runKey: `d1:${newUlid()}` });

    expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 32 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_placement_events
      WHERE principal_id = ? AND reason LIKE '%"decision":"inbox_cap"%'`).bind(principalId).first("count")).toBe(32);
    // Measured at e4fb760: 2,225 statements against 3,125 charged (ceiling 3,414).
    expect(counted.queryCount()).toBeLessThanOrEqual(result.budget.d1Statements);
    expect(result.budget.d1Statements).toBeLessThanOrEqual(AUTOMATIC_DISTILLATION_STEP_LIMITS.d1Statements);
  }, 120_000);

  it("D5 the same worst step with every first commit attempt failing stays under the charged budget", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    await repository.bootstrapTopics(principalId);
    const names = ["Area one", "Area two", "Area three"];
    const renamed = ["Renamed one", "Renamed two", "Renamed three"];
    const created = await repository.resolveOrCreateAutomaticTopicPath(principalId, names, 3);
    if (created.topic === null) throw new Error("adversarial_alias_path_missing");
    const ids = created.topic.path.slice(1).map((entry) => entry.topicId);
    for (let index = 0; index < 3; index += 1) {
      const aliasPath = ["Memory", ...renamed.slice(0, index), names[index]].join("/");
      await renameTopic(principalId, ids[index] ?? "", names[index] ?? "", renamed[index] ?? "", aliasPath);
    }
    for (let index = 0; index < 40; index += 1) await createTopic(principalId, ids[2] ?? "", `Full child ${index}`);
    const events = new EventRepository(env.DB);
    const appended: AppendedEvent[] = [];
    const texts: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      texts.push(`I measured retry statement sentence ${index}.`);
      appended.push(await appendConversation(events, principalId, texts[index] ?? ""));
    }
    const proposals: Record<string, unknown>[] = [];
    for (let index = 0; index < 8; index += 1) {
      for (let offset = 0; offset < 4; offset += 1) {
        const sourceIndexes = [...Array(8).keys()].filter((position) =>
          offset === 0 || position === index || position !== (index + offset) % 8);
        proposals.push(proposal(
          sourceIndexes.map((position) => appended[position] as AppendedEvent),
          sourceIndexes.map((position) => texts[position] ?? ""),
          texts[index] ?? "",
          [...names, "New leaf"],
        ));
      }
    }
    const counted = queryCountingDatabase();
    const archive = new ArchivalService({ database: counted.database, bucket: env.ARCHIVE });
    const retrying = createMemoryRepositoryForTest(counted.database, {
      archivedEventReader: archive,
      batchFault: (operation, attempt) => operation === "commit" && attempt === 1
        ? env.DB.prepare("INSERT INTO memory_repository_missing_fault_target(value) VALUES (1)")
        : null,
    });

    const result = await workflow(
      principalId,
      new FakeModelProvider({ completeJson: proposals }),
      retrying,
      counted.database,
    ).runNext({ runKey: `d5:${newUlid()}` });

    expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 32 });
    expect.soft(`D5 measured=${counted.queryCount()} charged=${result.budget.d1Statements}`).toBe("recorded");
    expect(counted.queryCount()).toBeLessThanOrEqual(result.budget.d1Statements);
  }, 120_000);

  it("D2 32 proposals each asking for a new four-area path stay under the charged budget", async () => {
    const principalId = await principal();
    await new MemoryRepository(env.DB).bootstrapTopics(principalId);
    const events = new EventRepository(env.DB);
    const appended: AppendedEvent[] = [];
    const texts: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      texts.push(`I measured create statement sentence ${index}.`);
      appended.push(await appendConversation(events, principalId, texts[index] ?? ""));
    }
    const proposals: Record<string, unknown>[] = [];
    for (let index = 0; index < 32; index += 1) {
      const eventIndex = index % 8;
      const sourceIndexes = [...Array(8).keys()].filter((position) =>
        position === eventIndex || position !== (eventIndex + 1 + (index >> 3)) % 8);
      proposals.push(proposal(
        sourceIndexes.map((position) => appended[position] as AppendedEvent),
        sourceIndexes.map((position) => texts[position] ?? ""),
        texts[eventIndex] ?? "",
        [`Root ${index}`, `Two ${index}`, `Three ${index}`, `Four ${index}`],
      ));
    }
    const counted = queryCountingDatabase();
    const archive = new ArchivalService({ database: counted.database, bucket: env.ARCHIVE });

    const result = await workflow(
      principalId,
      new FakeModelProvider({ completeJson: proposals }),
      new MemoryRepository(counted.database, { archivedEventReader: archive }),
      counted.database,
    ).runNext({ runKey: `d2:${newUlid()}` });

    // Measured at e4fb760: 1,600 statements against 3,125 charged.
    expect(result.outcome).toBe("succeeded");
    expect(await modelTopicCount(principalId)).toBe(4);
    expect(counted.queryCount()).toBeLessThanOrEqual(result.budget.d1Statements);
  }, 120_000);

  it("D3 one re-file pass over 100 four-deep candidates stays within the 424-statement reservation", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const path = ["R one", "R two", "R three", "R four"];
    const target = await repository.resolveOrCreateAutomaticTopicPath(principalId, path, 4);
    if (target.topic === null) throw new Error("adversarial_refile_target_missing");
    for (let index = 0; index < 90; index += 1) {
      await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
        `I capped deep unmovable note ${index}.`, "inbox_cap", ["R one", "R two", "R three", `Missing ${index}`]);
    }
    for (let index = 0; index < 10; index += 1) {
      await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
        `I capped deep movable note ${index}.`, "inbox_filing_failure", path);
    }
    const counted = queryCountingDatabase();

    const result = await new MemoryRepository(counted.database).refileAutomaticInboxItems(principalId);

    // Measured at e4fb760: 414 statements (90 unmovable + 10 moved rows).
    expect(result).toMatchObject({ examinedItemCount: 100, refiledItemCount: 10 });
    expect(counted.queryCount()).toBeLessThanOrEqual(AUTOMATIC_INBOX_REFILE_D1_STATEMENT_CEILING);
  }, 180_000);

  it("D4 a re-file pass whose inserts fail still stays within the 424-statement reservation", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const path = ["S one", "S two", "S three", "S four"];
    const target = await repository.resolveOrCreateAutomaticTopicPath(principalId, path, 4);
    if (target.topic === null) throw new Error("adversarial_refile_target_missing");
    for (let index = 0; index < 100; index += 1) {
      await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
        `I capped deep failing note ${index}.`, "inbox_filing_failure", path);
    }
    const counted = queryCountingDatabase((query) => query.includes("'refile'"));

    const result = await new MemoryRepository(counted.database).refileAutomaticInboxItems(principalId);

    // Measured at e4fb760: 604 statements (100 × resolve 4 + insert 1 + race check 1, plus 4).
    expect(counted.queryCount()).toBeLessThanOrEqual(AUTOMATIC_INBOX_REFILE_D1_STATEMENT_CEILING);
  }, 180_000);
});

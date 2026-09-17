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
  AUTOMATIC_DISTILLATION_STEP_LIMITS,
  AutomaticMemoryDistillationWorkflow,
} from "../../src/memory/automatic-distillation.js";
import {
  automaticFilingReason,
  MemoryRepository,
  type AutomaticFilingDecision,
} from "../../src/memory/memory-repository.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import type { CommitInitialMemoryInput } from "../../src/memory/memory-types.js";
import { EventRepository, type AppendedEvent } from "../../src/persistence/event-repository.js";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { Redactor } from "../../src/security/redaction.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { applyMemoryDistillationMigration } from "../persistence/migration.js";

// Adversarial review of PR #82 (automatic topic filing). Every test asserts the
// behaviour the design requires; a failing test is a proven defect.

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
  const principalId = `principal:adversarial-pr82:${serial}:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'adversarial pr82 test', ?, ?)`)
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
    scope: "adversarial-pr82-test",
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

function queryCountingDatabase(): { readonly database: D1Database; queryCount(): number } {
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
  };
}

async function itemCount(principalId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS count FROM memory_items WHERE principal_id = ?")
    .bind(principalId).first<{ count: number }>();
  return row?.count ?? -1;
}

async function placementOf(principalId: string, itemId: string): Promise<{ topic_id: string; display_name: string }> {
  const row = await env.DB.prepare(`SELECT placement.topic_id, topic.display_name
    FROM memory_item_placement_state placement
    JOIN memory_topics topic
      ON topic.principal_id = placement.principal_id AND topic.topic_id = placement.topic_id
    WHERE placement.principal_id = ? AND placement.item_id = ?
      AND placement.relation = 'primary' AND placement.status = 'active'`)
    .bind(principalId, itemId).first<{ topic_id: string; display_name: string }>();
  if (row === null) throw new Error("adversarial_placement_missing");
  return row;
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

async function commitInboxItem(
  repository: MemoryRepository,
  events: EventRepository,
  principalId: string,
  inboxTopicId: Ulid,
  text: string,
  decision: AutomaticFilingDecision,
  topicPath: readonly string[],
  lifecycle: "active" | "proposed" = "active",
): Promise<Ulid> {
  const event = await appendConversation(events, principalId, text, lifecycle === "active");
  const itemId = newUlid();
  const input: CommitInitialMemoryInput = Object.freeze({
    principalId,
    itemId,
    kind: "fact" as const,
    creationEventId: event.envelope.eventId,
    creationEventSequence: event.eventSequence,
    version: Object.freeze({
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: lifecycle === "active" ? "stated" as const : "inferred" as const,
      origin: lifecycle === "active" ? "authenticated_first_person" as const : "model" as const,
      uncertain: lifecycle !== "active",
      sensitivity: "normal" as const,
      validFrom: null,
      validTo: null,
      extractorVersion: "automatic-distillation-v1",
      extractorModelId: lifecycle === "active" ? null : MODEL_ID,
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
      lifecycleState: lifecycle,
      reason: lifecycle === "active"
        ? "exact authenticated first-person evidence"
        : "model inference awaits owner confirmation",
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
  });
  await repository.commitInitialItem(input);
  return itemId;
}

beforeAll(async () => {
  await applyMemoryDistillationMigration();
});

beforeEach(async () => {
  await resetArchiveFixture();
});

describe("PR #82 adversarial: untrusted topic paths never cost Sid a memory", () => {
  it("A1 keeps a valid first-person memory when the model proposes a five-area path", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const text = "I finished the titration lab.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School", "Chemistry", "Unit 2", "Labs", "Titration"])],
    });

    const result = await workflow(principalId, provider).runNext({ runKey: `a1:${newUlid()}` });

    // The design (section 6.2) says a filing problem never discards the memory.
    expect(result.cursorEventSequence).toBe(event.eventSequence);
    expect(await itemCount(principalId)).toBe(1);
  });

  it("A2 keeps a memory whose schema-valid non-Latin area name is over 64 UTF-8 bytes", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const text = "I finished the equilibrium worksheet.";
    const area = "化学平衡与反应速率第二单元复习笔记和实验报告";
    expect(area.length).toBeLessThanOrEqual(64);
    expect(new TextEncoder().encode(area).byteLength).toBeGreaterThan(64);
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School", area])],
    });

    await workflow(principalId, provider).runNext({ runKey: `a2:${newUlid()}` });

    expect(await itemCount(principalId)).toBe(1);
  });

  it("A3 keeps a memory whose area name contains a six-digit number", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const text = "I escalated the billing ticket.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["Work", "Ticket 482913"])],
    });

    await workflow(principalId, provider).runNext({ runKey: `a3:${newUlid()}` });

    expect(await itemCount(principalId)).toBe(1);
  });

  it("A4 keeps a memory when filingConfidence is missing", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const text = "I booked the dentist appointment.";
    const event = await appendConversation(events, principalId, text);
    const raw = { ...proposal([event], [text], text, ["Health"]) } as Record<string, unknown>;
    delete raw.filingConfidence;
    const provider = new FakeModelProvider({ completeJson: [raw] });

    await workflow(principalId, provider).runNext({ runKey: `a4:${newUlid()}` });

    expect(await itemCount(principalId)).toBe(1);
  });

  it("B1 does not fail the whole step when an area name contains a line separator", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const text = "I started the kinetics unit.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School", "Unit 2"])],
    });

    const result = await workflow(principalId, provider).runNext({ runKey: `b1:${newUlid()}` });

    expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 1 });
  });

  it("B2 does not wedge the cursor on a proposed item whose area name contains a newline", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const text = "Mum says the reunion is in July.";
    const event = await appendConversation(events, principalId, text, false);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["Family", "Reunion\nJuly"])],
    });
    const first = await workflow(principalId, provider).runNext({ runKey: `b2a:${newUlid()}` });
    const second = await workflow(principalId, provider).runNext({ runKey: `b2b:${newUlid()}` });

    // The next hourly run must not re-send (and re-pay for) the same window.
    expect({
      outcomes: [first.outcome, second.outcome],
      failureCode: first.failureCode,
      cursor: second.cursorEventSequence,
      providerCalls: provider.requests.length,
      items: await itemCount(principalId),
    }).toEqual({
      outcomes: ["succeeded", "nothing_new"],
      failureCode: null,
      cursor: event.eventSequence,
      providerCalls: 1,
      items: 1,
    });
  });
});

describe("PR #82 adversarial: tree integrity against model-chosen names", () => {
  it("D1 does not create an area whose name contains the path separator '>'", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    await repository.bootstrapTopics(principalId);
    await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School", "Chemistry"], 6);
    const events = new EventRepository(env.DB);
    const text = "I passed the chemistry quiz.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School > Chemistry"])],
    });

    await workflow(principalId, provider, repository).runNext({ runKey: `d1:${newUlid()}` });

    const separated = await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
      WHERE principal_id = ? AND instr(display_name, '>') > 0`).bind(principalId).first("count");
    expect(separated).toBe(0);
  });

  it("D2 answers 'What do you remember about School > Chemistry?' with a memory the model filed there", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    await repository.bootstrapTopics(principalId);
    await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School", "Chemistry"], 6);
    const events = new EventRepository(env.DB);
    const text = "I aced the chemistry quiz.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School > Chemistry"])],
    });
    await workflow(principalId, provider, repository).runNext({ runKey: `d2:${newUlid()}` });

    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "What do you remember about School > Chemistry?",
      maxTokens: 32_000,
    });

    expect(contexts.map((context) => context.text).filter((line) => line.includes(text))).not.toEqual([]);
  });

  it("D3 does not grow a second School under a model-invented Memory area", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const school = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    if (school.topic === null) throw new Error("adversarial_school_missing");
    const events = new EventRepository(env.DB);
    const text = "I joined the chess club.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["Memory", "School"])],
    });

    await workflow(principalId, provider, repository).runNext({ runKey: `d3:${newUlid()}` });

    const itemId = await env.DB.prepare("SELECT item_id FROM memory_items WHERE principal_id = ?")
      .bind(principalId).first<string>("item_id");
    expect({
      schoolAreas: await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
        WHERE principal_id = ? AND normalized_name = 'school'`).bind(principalId).first("count"),
      placedUnderExistingSchool: itemId === null
        ? false
        : (await placementOf(principalId, itemId)).topic_id === school.topic.topicId,
      rootChildren: await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
        WHERE principal_id = ? AND parent_topic_id = ?`).bind(principalId, topics.root.topicId).first("count"),
    }).toEqual({ schoolAreas: 1, placedUnderExistingSchool: true, rootChildren: 2 });
  });

  it("E1 does not create model areas underneath the Inbox", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const events = new EventRepository(env.DB);
    const text = "I dissected a frog in biology.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, [INBOX, "Biology"])],
    });

    await workflow(principalId, provider, repository).runNext({ runKey: `e1:${newUlid()}` });

    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
      WHERE principal_id = ? AND parent_topic_id = ? AND status = 'active'`)
      .bind(principalId, topics.inbox.topicId).first("count")).toBe(0);
  });

  it("F1 does not create a look-alike sibling for a zero-width-space variant", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    const events = new EventRepository(env.DB);
    const text = "I joined the robotics club.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School​"])],
    });

    await workflow(principalId, provider, repository).runNext({ runKey: `f1:${newUlid()}` });

    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
      WHERE principal_id = ? AND parent_topic_id = ? AND display_name LIKE 'School%'`)
      .bind(principalId, topics.root.topicId).first("count")).toBe(1);
  });

  it("F2 does not create a full-width duplicate of an existing area", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    const events = new EventRepository(env.DB);
    const text = "I joined the debate club.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["ＳＣＨＯＯＬ"])],
    });

    await workflow(principalId, provider, repository).runNext({ runKey: `f2:${newUlid()}` });

    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topics
      WHERE principal_id = ? AND parent_topic_id = ? AND status = 'active'`)
      .bind(principalId, topics.root.topicId).first("count")).toBe(2);
  });

  it("G1 leaves no empty model-created areas when the item commit then fails", async () => {
    const principalId = await principal();
    const canonical = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const text = "I signed up for the physics olympiad.";
    const event = await appendConversation(events, principalId, text);
    const provider = new FakeModelProvider({
      completeJson: [proposal([event], [text], text, ["School", "Physics", "Olympiad"])],
    });
    const failingCommit: FilingRepository = {
      bootstrapTopics: (id) => canonical.bootstrapTopics(id),
      commitInitialItem: async () => { throw new Error("fixture_commit_unavailable"); },
      resolveOrCreateAutomaticTopicPath: (id, path, max) => canonical.resolveOrCreateAutomaticTopicPath(id, path, max),
      refileAutomaticInboxItems: (id) => canonical.refileAutomaticInboxItems(id),
    };

    const result = await workflow(principalId, provider, failingCommit).runNext({ runKey: `g1:${newUlid()}` });

    expect(result.outcome).toBe("failed");
    expect(await itemCount(principalId)).toBe(0);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topic_events
      WHERE principal_id = ? AND reason = ?`).bind(principalId, MODEL_TOPIC_REASON).first("count")).toBe(0);
  });
});

describe("PR #82 adversarial: hourly Inbox re-file", () => {
  it("C1 is not starved by ten older Inbox items whose areas never appear", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const school = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    if (school.topic === null) throw new Error("adversarial_school_missing");
    for (let index = 0; index < 10; index += 1) {
      await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
        `I capped side project note ${index}.`, "inbox_cap", [`Side project ${index}`, "Notes"]);
    }
    const fileable = await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "I capped the school note.", "inbox_cap", ["School"]);

    for (let hour = 0; hour < 3; hour += 1) await repository.refileAutomaticInboxItems(principalId);

    expect((await placementOf(principalId, fileable)).display_name).toBe("School");
  });

  it("S1 never re-files a proposed uncertain item even with a refilable reason", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    const proposed = await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "The owner may like school.", "inbox_cap", ["School"], "proposed");

    const result = await repository.refileAutomaticInboxItems(principalId);

    expect(result.refiledItemCount).toBe(0);
    expect((await placementOf(principalId, proposed)).display_name).toBe(INBOX);
  });

  it("S2 re-files by exact current names only, never through an alias", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    const chemistry = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School", "Chemistry"], 2);
    if (chemistry.topic === null) throw new Error("adversarial_chemistry_missing");
    await renameTopic(principalId, chemistry.topic.topicId, "Chemistry", "Chem", "Memory/School/Chemistry");
    const item = await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "I capped the chemistry note.", "inbox_filing_failure", ["School", "Chemistry"]);

    const result = await repository.refileAutomaticInboxItems(principalId);

    expect(result).toEqual({ examinedItemCount: 1, refiledItemCount: 0, failedItemCount: 0 });
    expect((await placementOf(principalId, item)).display_name).toBe(INBOX);
  });

  it("S3 never re-files onto the Inbox itself or re-files low-confidence decisions", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    const events = new EventRepository(env.DB);
    const topics = await repository.bootstrapTopics(principalId);
    await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "I capped the inbox note.", "inbox_filing_failure", [INBOX]);
    await commitInboxItem(repository, events, principalId, topics.inbox.topicId,
      "I filed the low confidence note.", "inbox_low_confidence", ["School"]);

    const first = await repository.refileAutomaticInboxItems(principalId);
    const second = await repository.refileAutomaticInboxItems(principalId);

    expect(first.refiledItemCount + second.refiledItemCount).toBe(0);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_placement_events
      WHERE principal_id = ? AND operation = 'refile'`).bind(principalId).first("count")).toBe(0);
  });
});

describe("PR #82 adversarial: sound-path checks", () => {
  it("S4 prefers a current sibling name over a newer alias with the same name", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    await repository.bootstrapTopics(principalId);
    const school = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School"], 1);
    if (school.topic === null) throw new Error("adversarial_school_missing");
    const old = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["School", "Chemistry"], 1);
    if (old.topic === null) throw new Error("adversarial_old_missing");
    await renameTopic(principalId, old.topic.topicId, "Chemistry", "Chem", "Memory/School/Chemistry");
    const current = await createTopic(principalId, school.topic.topicId, "Chemistry");
    // Make an alias named "Chemistry" newer than the current "Chemistry" name.
    await renameTopic(principalId, old.topic.topicId, "Chem", "Chem B", "Memory/School/Chemistry");

    const resolved = await repository.resolveOrCreateAutomaticTopicPath(principalId, ["school", "CHEMISTRY"], 0);

    expect(resolved).toMatchObject({ topic: { topicId: current, matchedBy: "current" }, createdTopicCount: 0 });
  });

  it("S5 counts the six-topic creation cap across steps of one hourly workflow", async () => {
    const principalId = await principal();
    const events = new EventRepository(env.DB);
    const appended: AppendedEvent[] = [];
    const texts: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      texts.push(`I noted cap sentence ${index}.`);
      appended.push(await appendConversation(events, principalId, texts[index] ?? ""));
    }
    const first = appended[0];
    const ninth = appended[8];
    if (first === undefined || ninth === undefined) throw new Error("adversarial_events_missing");
    const provider = new FakeModelProvider({
      completeJson: [
        proposal([first], [texts[0] ?? ""], texts[0] ?? "", ["Alpha", "Beta", "Gamma", "Delta"]),
        proposal([ninth], [texts[8] ?? ""], texts[8] ?? "", ["Omega", "Psi", "Chi"]),
      ],
    });
    const distillation = workflow(principalId, provider);

    const step1 = await distillation.runNext({ runKey: `s5:${newUlid()}:0` });
    const step2 = await distillation.runNext({ runKey: `s5:${newUlid()}:1` });

    expect([step1.outcome, step2.outcome]).toEqual(["succeeded", "succeeded"]);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_topic_events
      WHERE principal_id = ? AND reason = ?`).bind(principalId, MODEL_TOPIC_REASON).first("count")).toBe(4);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_placement_events
      WHERE principal_id = ? AND reason LIKE '%"decision":"inbox_cap"%'`).bind(principalId).first("count")).toBe(1);
  });

  it("S6 keeps measured D1 statements under the charged budget for 32 alias-resolved filings", async () => {
    const principalId = await principal();
    const repository = new MemoryRepository(env.DB);
    await repository.bootstrapTopics(principalId);
    const names = ["Area one", "Area two", "Area three", "Area four"];
    const renamed = ["Renamed one", "Renamed two", "Renamed three", "Renamed four"];
    const created = await repository.resolveOrCreateAutomaticTopicPath(principalId, names, 4);
    if (created.topic === null) throw new Error("adversarial_alias_path_missing");
    const ids = created.topic.path.slice(1).map((entry) => entry.topicId);
    for (let index = 0; index < 4; index += 1) {
      const aliasPath = ["Memory", ...renamed.slice(0, index), names[index]].join("/");
      await renameTopic(principalId, ids[index] ?? "", names[index] ?? "", renamed[index] ?? "", aliasPath);
    }
    const events = new EventRepository(env.DB);
    const appended: AppendedEvent[] = [];
    const texts: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      texts.push(`I measured statement sentence ${index}.`);
      appended.push(await appendConversation(events, principalId, texts[index] ?? ""));
    }
    const proposals: Record<string, unknown>[] = [];
    for (let index = 0; index < 8; index += 1) {
      for (let offset = 0; offset < 4; offset += 1) {
        const sourceIndexes = offset === 0 ? [index] : [index, (index + offset) % 8];
        proposals.push(proposal(
          sourceIndexes.map((position) => appended[position] as AppendedEvent),
          sourceIndexes.map((position) => texts[position] ?? ""),
          texts[index] ?? "",
          names,
        ));
      }
    }
    const counted = queryCountingDatabase();
    const archive = new ArchivalService({ database: counted.database, bucket: env.ARCHIVE });
    const distillation = workflow(
      principalId,
      new FakeModelProvider({ completeJson: proposals }),
      new MemoryRepository(counted.database, { archivedEventReader: archive }),
      counted.database,
    );

    const result = await distillation.runNext({ runKey: `s6:${newUlid()}` });

    expect(result).toMatchObject({ outcome: "succeeded", createdItemCount: 32 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM memory_item_placement_state placement
      WHERE placement.principal_id = ? AND placement.topic_id = ?`)
      .bind(principalId, ids[3] ?? "").first("count")).toBe(32);
    expect(counted.queryCount()).toBeLessThanOrEqual(result.budget.d1Statements);
    expect(result.budget.d1Statements).toBeLessThanOrEqual(AUTOMATIC_DISTILLATION_STEP_LIMITS.d1Statements);
  }, 60_000);
});

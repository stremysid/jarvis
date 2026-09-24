import { createOwnerPipelineModels } from "../../src/agent/owner-pipelines.js";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import { GUIDED_ASSIGNMENT_TOOL_DEFINITIONS } from "../../src/school/guided-assignment-tools.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import { readPreviousVoiceAssistant, readVoiceReplyPayload } from "../../src/memory/voice-memory-reference.js";
/**
 * Voice can act, not only talk.
 *
 * At `d0ec419` a phone call had no tool dispatch at all: `ModelAdapterStreamInput`
 * has no `tools` field, so `src/voice/production-runtime.ts` composed a bare
 * `DeepSeekModelAdapter` and `ModelAgentProvider` was reachable from Telegram
 * only. That is a type, not a wiring omission, which is why the fix is an
 * adapter behind `ModelAdapter` rather than a field on the input --
 * `DECISIONS.md`, *"Voice gets tools behind `ModelAdapter`"*.
 *
 * Two things these tests deliberately do NOT do.
 *
 * They do not stub the control-target finder. Every owner-agent test injects a
 * stub (`targets: { async findControlTargets() { return [] } }`), and that stub
 * is why `memory_pin` could throw on every call with a green suite. A test that
 * wants to know whether voice can resolve a memory to act on has to inject the
 * real one, against real rows.
 *
 * They do not assert which tools *need* the finder. That is read from the code,
 * not measured here: nine of the twelve owner tools take no `itemId`.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { OwnerVoiceAgentAdapter, OWNER_VOICE_AGENT_CHANNEL_PROMPT } from "../../src/voice/voice-agent.js";
import { OWNER_ARGUMENT_TOOL_DEFINITIONS } from "../../src/agent/owner-argument-tools.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { D1ToolConfirmationStore } from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "../../src/autonomy/tool-gate.js";
import {
  createVoiceStreamDelivery,
  type VoiceSentReceipt,
} from "../../src/conversation/conversation-types.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import {
  D1MemoryControlTargetFinder,
  type MemoryTargetFinder,
} from "../../src/memory/memory-control-targets.js";
import type { MeaningSearchReader } from "../../src/memory/meaning-search.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { CORE_PROFILE_PREFIX } from "../../src/memory/core-profile.js";
import { recordPendingTelegramMemoryReferences } from "../../src/memory/telegram-memory-reference.js";
import type { RetrievedContext } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
  ModelAgentStreamProvider,
  ModelAgentStreamInput,
  ModelAgentStreamChunk,
  ModelFunctionCall,
} from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyAutonomyToolCapabilitiesMigration, applyNewestRuntimeMigration } from "../persistence/migration.js";
import { DeepSeekAgentProvider } from "../../src/providers/deepseek-provider.js";
import { agentFrame, agentResponse, textResponse, toolFrames } from "../fixtures/deepseek-agent-stream.js";
import { UNRECEIPTED_VOICE_ACTION } from "../../src/school/school-catchup-model.js";
import { GUIDED_ASSIGNMENT_QUESTIONS, WORKED_REPLY } from "../school/tutoring-reply-fixtures.js";

const NOW = new Date("2026-09-17T14:00:00.000Z");
const OWNER = "principal:voice-agent-owner";
let serial = 0;

function stopped(reply: string): ModelAgentCompletion {
  return Object.freeze({
    content: reply,
    toolCalls: Object.freeze([]),
    finishReason: "stop" as const,
  });
}

function called(...toolCalls: readonly ModelFunctionCall[]): ModelAgentCompletion {
  return Object.freeze({ content: null, toolCalls: Object.freeze([...toolCalls]), finishReason: "tool_calls" as const });
}

function tool(id: string, name: string, args: unknown): ModelFunctionCall {
  return Object.freeze({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
}

class FakeAgentProvider implements ModelAgentProvider, ModelAgentStreamProvider {
  readonly requests: ModelAgentCompletionInput[] = [];
  private readonly completions: Array<ModelAgentCompletion | Error>;

  constructor(completions: readonly (ModelAgentCompletion | Error)[]) {
    this.completions = [...completions];
  }

  async completeAgent(): Promise<ModelAgentCompletion> { throw new Error("voice_must_stream"); }

  async *streamAgent(input: ModelAgentStreamInput): AsyncIterable<ModelAgentStreamChunk> {
    this.requests.push(input);
    const completion = this.completions.shift();
    if (completion === undefined) throw new Error("unexpected_agent_call");
    if (completion instanceof Error) throw completion;
    if (completion.content !== null) yield { type: "text", text: completion.content };
    yield { type: "completed", completion };
  }
}

// The schema is applied once and the hook gets room for it: this fixture needs
// the whole memory and conversation schema, which is more than the 10 second
// default allows for on this machine under load.
beforeAll(async () => {
  await applyNewestRuntimeMigration();
  await applyAutonomyToolCapabilitiesMigration();
}, 120_000);

async function seedPrincipal(principalId: string): Promise<void> {
  const now = NOW.toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'Voice agent test', ?2, ?2)`)
    .bind(principalId, now).run();
}

/**
 * One active memory item resting on a real committed turn.
 *
 * The source has to be a durable `conversation.user_committed` event, not a
 * synthetic id: the repository validates every source receipt against the
 * ledger, so a made-up event id is refused rather than stored.
 */
async function activeMemory(principalId: string, text: string): Promise<Ulid> {
  // The turn really says the fact: the repository checks that the stored
  // excerpt is a substring of the durable user event, so a fixture whose turn
  // said something else is refused rather than stored.
  const sessionId = `voice:memory-source:${serial + 1}`;
  await runVoiceTurn({
    text,
    provider: new FakeAgentProvider([stopped("Noted.")]),
    ownerPrincipalId: principalId,
    sessionId,
  });
  return commitActiveMemoryFromVoiceTurn(principalId, sessionId, text);
}

async function commitActiveMemoryFromVoiceTurn(
  principalId: string,
  sessionId: string,
  text: string,
): Promise<Ulid> {
  const source = await env.DB.prepare(`SELECT owner.event_id, owner.sequence, owner.occurred_at
    FROM conversation_turns turn
    JOIN events owner ON owner.event_id = turn.user_event_id
    WHERE turn.principal_id = ?1 AND turn.session_id = ?2 AND turn.channel = 'voice'
    ORDER BY owner.sequence DESC LIMIT 1`).bind(principalId, sessionId).first<{
      event_id: string;
      sequence: number;
      occurred_at: string;
    }>();
  if (source === null) throw new Error("voice_agent_source_missing");
  const repository = new MemoryRepository(env.DB);
  const topics = await repository.bootstrapTopics(principalId);
  const itemId = newUlid();
  await repository.commitInitialItem({
    principalId,
    itemId,
    kind: "fact",
    creationEventId: source.event_id as Ulid,
    creationEventSequence: source.sequence,
    version: {
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: "stated",
      origin: "authenticated_first_person",
      uncertain: false,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "voice-agent-test-v1",
      extractorModelId: null,
    },
    sources: [{
      sourceId: newUlid(),
      eventId: source.event_id as Ulid,
      eventSequence: source.sequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: "voice",
      occurredAt: source.occurred_at,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState: "active",
      reason: "voice agent test",
      policyVersion: "voice-agent-test-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule",
      confidence: 0.9,
      reason: "voice agent test",
    },
  });
  return itemId;
}

function memoryContext(text: string, itemId: Ulid): RetrievedContext {
  return Object.freeze({
    sourceEventId: newUlid(),
    text: `Memory evidence [topic Inbox; item ${itemId}; active; stated]: ${text}`,
    sensitivity: "personal" as const,
  });
}

interface RunVoiceTurnInput {
  readonly text: string;
  readonly provider: ModelAgentProvider & ModelAgentStreamProvider;
  readonly onToken?: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly maxOutputCharacters?: number;
  readonly ownerPrincipalId?: string;
  readonly turnPrincipalId?: string;
  readonly context?: readonly RetrievedContext[];
  readonly targets?: MemoryTargetFinder;
  readonly memorySearch?: MeaningSearchReader;
  /** The call this turn belongs to. Each turn is its own call unless a test says otherwise. */
  readonly sessionId?: string;
  readonly committedItemIds?: readonly Ulid[];
  readonly agentDatabase?: D1Database;
}

async function seedPrincipalOnce(principalId: string): Promise<void> {
  const existing = await env.DB.prepare(`SELECT principal_id FROM principals WHERE principal_id = ?1`)
    .bind(principalId).first<{ principal_id: string }>();
  if (existing === null) await seedPrincipal(principalId);
}

async function runVoiceTurn(input: RunVoiceTurnInput): Promise<string> {
  serial += 1;
  const turnPrincipalId = input.turnPrincipalId ?? input.ownerPrincipalId ?? OWNER;
  await seedPrincipalOnce(turnPrincipalId);
  const events = new EventRepository(env.DB);
  const repository = new ConversationRepository(env.DB, events);
  const model = new OwnerVoiceAgentAdapter({
    provider: input.provider,
    database: input.agentDatabase ?? env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId: input.ownerPrincipalId ?? OWNER,
    targets: input.targets ?? new D1MemoryControlTargetFinder({ database: env.DB, archive: env.ARCHIVE }),
    ...(input.memorySearch === undefined ? {} : { memorySearch: input.memorySearch }),
    directOwnerText: true,
    ...createOwnerPipelineModels(env, { async *stream() { throw new Error("unexpected_pipeline"); } }, new Redactor(), input.ownerPrincipalId ?? OWNER, true, () => NOW),
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW }),
    autonomy: new ToolAutonomyGate(
      new AutonomyService({ repository: new AutonomyRepository(env.DB) }),
      new D1ToolConfirmationStore(env.DB),
    ),
    now: () => NOW,
  });
  const sessionId = input.sessionId ?? `voice:call:${serial}`;
  const turnId = newUlid();
  if (input.committedItemIds !== undefined) {
    recordPendingTelegramMemoryReferences(turnId, input.committedItemIds);
  }
  const pieces: string[] = [];
  // The real delivery helper, not a stand-in: it is what refuses a stream whose
  // pieces do not equal the finished text. Its `finish` returns the minted
  // receipt, which `recordVoiceSent` below then validates and consumes.
  const delivery = createVoiceStreamDelivery({
    sessionId,
    turnId,
    sendToken: async (token) => { pieces.push(token.text); input.onToken?.(token.text); },
    finish: async (finalText): Promise<void> => {
      // The contract `createVoiceStreamDelivery` enforces: what was streamed is
      // exactly what is finished.
      expect(pieces.join("")).toBe(finalText);
    },
  });
  const service = new DefaultConversationService({
    repository,
    model: input.maxOutputCharacters === undefined ? model : {
      stream: (request) => model.stream({ ...request, maxOutputCharacters: input.maxOutputCharacters! }),
    },
    context: { async retrieve() { return input.context ?? Object.freeze([]); } },
    dispatcher: { async dispatch() { throw new Error("unexpected_dispatch"); } },
    redactor: new Redactor(),
    now: () => NOW,
  });
  const result = await service.handleTurn({
    sessionId,
    principalId: turnPrincipalId,
    turnId,
    text: input.text,
    signal: input.signal ?? new AbortController().signal,
    ...delivery,
  });
  if (result.outcome !== "voice_sent") throw new Error(`voice_turn_not_sent:${result.outcome}`);
  return pieces.join("");
}

async function forgetVoiceMemoryOnSession(
  principalId: string,
  sessionId: string,
  itemId: Ulid,
  text: string,
): Promise<void> {
  await runVoiceTurn({
    text: "forget the saved memory",
    sessionId,
    ownerPrincipalId: principalId,
    context: [memoryContext(text, itemId)],
    provider: new FakeAgentProvider([
      called(tool(`forget-${newUlid()}`, "memory_forget", {
        itemIds: [itemId], supportingExcerpt: "forget the saved memory",
      })),
      stopped("Okay."),
    ]),
  });
}

function databaseWithForgottenQueryRows(
  rows: readonly Readonly<{ item_id: Ulid; text: string }>[],
  requireCurrentVersion = false,
): D1Database {
  return new Proxy(env.DB as unknown as object, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("state.lifecycle_state = 'forgotten'")
            && sql.includes("SELECT state.item_id, version.text")) {
            const selected = !requireCurrentVersion
              || sql.includes("version.version_id = state.current_version_id")
              ? rows
              : Array.from({ length: 129 }, (_value, index) => Object.freeze({
                item_id: newUlid(), text: `Historical version ${index}.`,
              }));
            const statement = {
              bind: () => statement,
              all: async () => ({ results: selected }),
            };
            return statement;
          }
          return (target as D1Database).prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

describe("the voice agent adapter", () => {
  async function offerProposedMemory(principalId: string, sessionId: string): Promise<Ulid> {
    const provider = new FakeAgentProvider([
      called(tool("propose", "memory_remember", {
        fact: "I like art", supportingExcerpt: "I draw sometimes", evidenceClass: "stated",
        previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
      })),
      stopped('Should I remember exactly "I like art"?'),
    ]);
    await runVoiceTurn({ text: "I draw sometimes", provider, ownerPrincipalId: principalId, sessionId });
    const item = await env.DB.prepare(`SELECT item.item_id, state.lifecycle_state, version.origin
      FROM memory_items item JOIN memory_item_state state ON state.item_id = item.item_id
      JOIN memory_item_versions version ON version.version_id = state.current_version_id
      WHERE item.principal_id = ?`).bind(principalId)
      .first<{ item_id: Ulid; lifecycle_state: string; origin: string }>();
    expect(item).toMatchObject({ lifecycle_state: "proposed", origin: "model" });
    return item!.item_id;
  }

  it("keeps a staged model memory proposed after spoken yes and points to the shared decision queue", async () => {
    const principalId = `principal:voice-confirm:${serial + 1}`;
    const sessionId = `voice:confirm:${serial + 1}`;
    const itemId = await offerProposedMemory(principalId, sessionId);
    const provider = new FakeAgentProvider([
      called(tool("confirm", "memory_confirm", { itemId, supportingExcerpt: "yes" })),
      stopped("Use the decision queue."),
    ]);
    const reply = await runVoiceTurn({ text: "yes", provider, ownerPrincipalId: principalId, sessionId });
    expect(provider.requests[0]?.systemPrompt).toContain('Should I remember exactly');
    expect(provider.requests[0]?.systemPrompt).toContain(itemId);
    expect(JSON.parse(provider.requests[1]!.toolResults![0]!.content)).toMatchObject({
      status: "pending_confirmation",
      receipt: expect.stringContaining("Open /decisions in Telegram"),
    });
    expect(reply).toContain("Open /decisions in Telegram");
    await expect(new MemoryRepository(env.DB).readCurrentItem(principalId, itemId)).resolves.toMatchObject({
      lifecycle: { state: "proposed" }, version: { basis: "inferred", origin: "model", uncertain: true },
    });
  });

  it("refuses non-affirmative wording as confirmation on the same call", async () => {
    const principalId = `principal:voice-confirm-wording:${serial + 1}`;
    const sessionId = `voice:confirm-wording:${serial + 1}`;
    const itemId = await offerProposedMemory(principalId, sessionId);
    const provider = new FakeAgentProvider([
      called(tool("confirm-wording", "memory_confirm", { itemId, supportingExcerpt: "maybe later" })),
      stopped("Nothing changed."),
    ]);

    await runVoiceTurn({ text: "maybe later", provider, ownerPrincipalId: principalId, sessionId });

    expect(JSON.parse(provider.requests[1]!.toolResults![0]!.content)).toMatchObject({ status: "refused" });
    await expect(new MemoryRepository(env.DB).readCurrentItem(principalId, itemId))
      .resolves.toMatchObject({ lifecycle: { state: "proposed" } });
  });

  it("refuses a spoken yes on another call even when the proposed memory is in context", async () => {
    const principalId = `principal:voice-confirm-other:${serial + 1}`;
    const itemId = await offerProposedMemory(principalId, `voice:earlier:${serial + 1}`);
    const provider = new FakeAgentProvider([
      called(tool("confirm", "memory_confirm", { itemId, supportingExcerpt: "yes" })), stopped("Nothing changed."),
    ]);
    await runVoiceTurn({ text: "yes", provider, ownerPrincipalId: principalId,
      context: [memoryContext("I like art", itemId)], sessionId: `voice:later:${serial + 1}` });
    expect(JSON.parse(provider.requests[1]!.toolResults![0]!.content)).toMatchObject({ status: "refused" });
    await expect(new MemoryRepository(env.DB).readCurrentItem(principalId, itemId))
      .resolves.toMatchObject({ lifecycle: { state: "proposed" } });
  });

  it("does not use a reply sent after the current owner utterance as confirmation evidence", async () => {
    const principalId = `principal:voice-later-reply:${serial + 1}`;
    await offerProposedMemory(principalId, `voice:later-reply:${serial + 1}`);
    const turn = await env.DB.prepare("SELECT turn_id FROM conversation_turns WHERE principal_id = ?")
      .bind(principalId).first<{ turn_id: Ulid }>();
    await expect(readPreviousVoiceAssistant(env.DB, { principalId, correlationId: turn!.turn_id })).resolves.toBeNull();
  });

  it("does not lend voice confirmation references to a Telegram turn with the same session label", async () => {
    const principalId = `principal:voice-label:${serial + 1}`;
    const sessionId = `shared-label:${serial + 1}`;
    await offerProposedMemory(principalId, sessionId);
    const correlationId = newUlid();
    const userText = new Redactor().redactText("yes");
    if (!userText.ok) throw new Error("fixture_redaction_failed");
    await new ConversationRepository(env.DB, new EventRepository(env.DB), { telegramDirectOwnerText: true })
      .getOrCreateTurn({ turnId: correlationId, sessionId, principalId, channel: "telegram", userText, now: NOW });
    await expect(readPreviousVoiceAssistant(env.DB, { principalId, correlationId })).resolves.toBeNull();
  });

  it.each(["no, not that", "yes"])("refuses spoken confirmation %s when its immediate reply provides no staged target", async text => {
    const principalId = `principal:voice-no-target:${serial + 1}`;
    const sessionId = `voice:no-target:${serial + 1}`;
    const itemId = await offerProposedMemory(principalId, sessionId);
    await runVoiceTurn({ text: "What did you mean?", ownerPrincipalId: principalId, sessionId,
      provider: new FakeAgentProvider([stopped('Should I remember exactly "I like art"?')]) });
    const provider = new FakeAgentProvider([
      called(tool("confirm", "memory_confirm", { itemId, supportingExcerpt: text })), stopped("Nothing changed."),
    ]);
    await runVoiceTurn({ text, provider, ownerPrincipalId: principalId, sessionId,
      context: [memoryContext("I like art", itemId)] });
    expect(JSON.parse(provider.requests[1]!.toolResults![0]!.content)).toMatchObject({ status: "refused" });
    await expect(new MemoryRepository(env.DB).readCurrentItem(principalId, itemId))
      .resolves.toMatchObject({ lifecycle: { state: "proposed" } });
  });

  it("keeps the call instructions and pinned profile on a streamed tool follow-up", async () => {
    const principalId = `principal:voice-rewrite:${serial + 1}`;
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    await runVoiceTurn({ text: "pin that", ownerPrincipalId: principalId,
      context: [memoryContext("I take my coffee black.", itemId)],
      provider: new FakeAgentProvider([called(tool("pin", "memory_pin", { itemId })), stopped("Okay.")]) });
    const provider = new FakeAgentProvider([
      called(tool("pin-again", "memory_pin", { itemId })),
      stopped('[[claim {"toolName":"memory_pin","receiptIds":[]}]]I sent the email.[[/claim]]'),
    ]);
    const spoken = await runVoiceTurn({ text: "pin that again", provider, ownerPrincipalId: principalId,
      context: [memoryContext("I take my coffee black.", itemId)] });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.systemPrompt).toContain(OWNER_VOICE_AGENT_CHANNEL_PROMPT);
    expect(provider.requests[1]?.systemPrompt).toContain("I take my coffee black.");
    expect(provider.requests[1]?.tools).toEqual(provider.requests[0]?.tools);
    expect(provider.requests[1]?.toolChoice).toBe("none");
    expect(spoken).toContain(UNRECEIPTED_VOICE_ACTION);
    expect(spoken).not.toContain("I sent the email.");
  });

  it("rejects invalid reference metadata in a settled voice reply", () => {
    const base = { schemaCode: 1, channelCode: 1, sensitivityCode: 1, historyEligible: false, text: "A reply." };
    const id = newUlid();
    expect(readVoiceReplyPayload({ ...base, memoryItemIds: [id] }).itemIds).toEqual([id]);
    for (const payload of [
      { ...base, channelCode: 2 }, { ...base, historyEligible: true }, { ...base, memoryItemIds: [] },
      { ...base, memoryItemIds: ["invalid"] }, { ...base, memoryItemIds: [id, id] },
      { ...base, memoryItemIds: "invalid" }, { ...base, memoryItemIds: Array.from({ length: 9 }, () => newUlid()) },
    ]) expect(() => readVoiceReplyPayload(payload)).toThrow("owner_agent_previous_reply_invalid");
  });

  it("keeps every settled voice assistant reply out of general history", async () => {
    const principalId = `principal:voice-history-ineligible:${serial + 1}`;
    await runVoiceTurn({
      text: "hello",
      provider: new FakeAgentProvider([stopped("A settled reply.")]),
      ownerPrincipalId: principalId,
    });
    const row = await env.DB.prepare(`SELECT envelope_json FROM events
      WHERE subject_id = ?1 AND event_type = 'conversation.assistant_sent'
      ORDER BY sequence DESC LIMIT 1`).bind(principalId).first<{ envelope_json: string }>();
    expect(JSON.parse(row!.envelope_json).payload).toMatchObject({
      channelCode: 1,
      historyEligible: false,
      text: "A settled reply.",
    });
  });

  it("omits a forgotten memory and its id from the next voice prompt", async () => {
    const principalId = `principal:voice-forget-next:${serial + 1}`;
    const itemId = await activeMemory(principalId, "My retired lantern code is amber.");
    const sessionId = `voice:forget-next:${serial + 1}`;
    await runVoiceTurn({
      text: "forget the lantern code",
      provider: new FakeAgentProvider([
        called(tool("forget-next", "memory_forget", {
          itemIds: [itemId], supportingExcerpt: "forget the lantern code",
        })),
        stopped("Done."),
      ]),
      ownerPrincipalId: principalId,
      sessionId,
      context: [memoryContext("My retired lantern code is amber.", itemId)],
    });
    const provider = new FakeAgentProvider([stopped("What would you like to discuss?")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId, sessionId });

    expect(provider.requests[0]?.systemPrompt).toContain("The previous assistant reply could not be verified this turn.");
    expect(provider.requests[0]?.systemPrompt).not.toContain("My retired lantern code is amber.");
    expect(provider.requests[0]?.systemPrompt).not.toContain(itemId);
  });

  it("withholds a voice previous reply when one of two committed item ids was forgotten on another call", async () => {
    const principalId = `principal:voice-previous-id:${serial + 1}`;
    const fact = "My retired locker colour is ultramarine.";
    const otherFact = "My retired bus route colour is ochre.";
    const itemId = await activeMemory(principalId, fact);
    const otherItemId = await activeMemory(principalId, otherFact);
    const replySession = `voice:previous-id:${serial + 1}`;
    await runVoiceTurn({
      text: "Give me a neutral acknowledgement.",
      provider: new FakeAgentProvider([stopped("A neutral reference reply.")]),
      ownerPrincipalId: principalId,
      sessionId: replySession,
      committedItemIds: [itemId, otherItemId],
    });
    await forgetVoiceMemoryOnSession(principalId, `voice:forget-id:${serial + 1}`, itemId, fact);
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId, sessionId: replySession });

    expect(provider.requests[0]?.systemPrompt).toContain("The previous assistant reply could not be verified");
    expect(provider.requests[0]?.systemPrompt).not.toContain("A neutral reference reply.");
    expect(provider.requests[0]?.systemPrompt).not.toContain(itemId);
  });

  it("withholds a voice previous reply that exactly restates a memory forgotten on another call", async () => {
    const principalId = `principal:voice-previous-restatement:${serial + 1}`;
    const fact = "My retired locker colour is vermilion.";
    const itemId = await activeMemory(principalId, fact);
    const replySession = `voice:previous-restatement:${serial + 1}`;
    await runVoiceTurn({ text: "What did I say?", provider: new FakeAgentProvider([stopped(fact)]),
      ownerPrincipalId: principalId, sessionId: replySession });
    await forgetVoiceMemoryOnSession(principalId, `voice:forget-restatement:${serial + 1}`, itemId, fact);
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId, sessionId: replySession });

    expect(provider.requests[0]?.systemPrompt).toContain("The previous assistant reply could not be verified");
    expect(provider.requests[0]?.systemPrompt).not.toContain(fact);
  });

  it("withholds a voice previous reply whose owner turn was forgotten on another call", async () => {
    const principalId = `principal:voice-previous-owner:${serial + 1}`;
    const fact = "My retired locker colour is chartreuse.";
    const replySession = `voice:previous-owner:${serial + 1}`;
    await runVoiceTurn({ text: fact, provider: new FakeAgentProvider([stopped("Thanks for telling me.")]),
      ownerPrincipalId: principalId, sessionId: replySession });
    const itemId = await commitActiveMemoryFromVoiceTurn(principalId, replySession, fact);
    await forgetVoiceMemoryOnSession(principalId, `voice:forget-owner:${serial + 1}`, itemId, fact);
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId, sessionId: replySession });

    expect(provider.requests[0]?.systemPrompt).toContain("The previous assistant reply could not be verified");
    expect(provider.requests[0]?.systemPrompt).not.toContain("Thanks for telling me.");
  });

  it("withholds a voice previous reply whose cited item id was forgotten on another call", async () => {
    const principalId = `principal:voice-previous-cited:${serial + 1}`;
    const fact = "My retired locker colour is cerulean.";
    const sourceSession = `voice:previous-cited-source:${serial + 1}`;
    const replySession = `voice:previous-cited-reply:${serial + 1}`;
    await runVoiceTurn({ text: fact, provider: new FakeAgentProvider([stopped("Thanks for telling me.")]),
      ownerPrincipalId: principalId, sessionId: sourceSession });
    const itemId = await commitActiveMemoryFromVoiceTurn(principalId, sourceSession, fact);
    await runVoiceTurn({ text: "Name only the reference.",
      provider: new FakeAgentProvider([stopped(`The reference is item ${itemId}.`)]),
      ownerPrincipalId: principalId, sessionId: replySession });
    await forgetVoiceMemoryOnSession(principalId, `voice:forget-cited:${serial + 1}`, itemId, fact);
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId, sessionId: replySession });

    expect(provider.requests[0]?.systemPrompt).toContain("The previous assistant reply could not be verified");
    expect(provider.requests[0]?.systemPrompt).not.toContain(itemId);
  });

  it("fails closed when the forgotten visibility query returns 129 items", async () => {
    const principalId = `principal:voice-forgotten-cap:${serial + 1}`;
    const sessionId = `voice:forgotten-cap:${serial + 1}`;
    await runVoiceTurn({ text: "first", provider: new FakeAgentProvider([stopped("A prior reply.")]),
      ownerPrincipalId: principalId, sessionId });
    const rows = Array.from({ length: 129 }, (_value, index) => Object.freeze({
      item_id: newUlid(), text: `Forgotten memory ${index}.`,
    }));
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({
      text: "second",
      provider,
      ownerPrincipalId: principalId,
      sessionId,
      agentDatabase: databaseWithForgottenQueryRows(rows),
    });

    expect(provider.requests[0]?.systemPrompt).toContain("The previous assistant reply could not be verified");
    expect(provider.requests[0]?.systemPrompt).not.toContain("A prior reply.");
  });

  it("counts only the current version of each forgotten item against the visibility cap", async () => {
    const principalId = `principal:voice-forgotten-versions:${serial + 1}`;
    const sessionId = `voice:forgotten-versions:${serial + 1}`;
    await runVoiceTurn({ text: "first", provider: new FakeAgentProvider([stopped("A visible prior reply.")]),
      ownerPrincipalId: principalId, sessionId });
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({
      text: "second",
      provider,
      ownerPrincipalId: principalId,
      sessionId,
      agentDatabase: databaseWithForgottenQueryRows(
        [Object.freeze({ item_id: newUlid(), text: "An unrelated forgotten memory." })],
        true,
      ),
    });

    expect(provider.requests[0]?.systemPrompt).toContain("A visible prior reply.");
    expect(provider.requests[0]?.systemPrompt).not.toContain("could not be verified");
  });

  it("states when the previous voice reply cannot be verified", async () => {
    const principalId = `principal:voice-previous-invalid:${serial + 1}`;
    const sessionId = `voice:previous-invalid:${serial + 1}`;
    await runVoiceTurn({
      text: "first",
      provider: new FakeAgentProvider([stopped("A reply that will be corrupted.")]),
      ownerPrincipalId: principalId,
      sessionId,
    });
    await env.DB.prepare(`UPDATE events SET envelope_json = '{}'
      WHERE event_id = (
        SELECT sent_assistant_event_id FROM conversation_turns
        WHERE principal_id = ?1 AND session_id = ?2 ORDER BY rowid DESC LIMIT 1
      )`).bind(principalId, sessionId).run();
    const provider = new FakeAgentProvider([stopped("Second reply.")]);

    await runVoiceTurn({ text: "second", provider, ownerPrincipalId: principalId, sessionId });

    expect(provider.requests[0]?.systemPrompt).toContain(
      "The previous assistant reply could not be verified this turn. Do not guess what Sid is confirming.",
    );
    expect(provider.requests[0]?.systemPrompt).not.toContain("A reply that will be corrupted.");
  });

  it("withholds Sid's profile, owner call prompt, and owner tools from a guest prompt", async () => {
    const ownerPrincipalId = `principal:voice-private-owner:${serial + 1}`;
    const fact = "Sid's private telescope marker is cobalt.";
    const itemId = await activeMemory(ownerPrincipalId, fact);
    await new MemoryRepository(env.DB).appendPin({
      principalId: ownerPrincipalId,
      itemId,
      pinId: newUlid(),
      pinned: true,
      authorizingEventId: newUlid(),
      occurredAt: NOW.toISOString(),
    });
    const provider = new FakeAgentProvider([stopped("Hello guest.")]);

    await runVoiceTurn({
      text: "hello",
      provider,
      ownerPrincipalId,
      turnPrincipalId: `principal:voice-private-guest:${serial + 1}`,
    });

    expect(provider.requests[0]?.systemPrompt).not.toContain(CORE_PROFILE_PREFIX);
    expect(provider.requests[0]?.systemPrompt).not.toContain(fact);
    expect(provider.requests[0]?.systemPrompt).not.toContain(OWNER_VOICE_AGENT_CHANNEL_PROMPT);
    expect(provider.requests[0]?.systemPrompt).toContain("authenticated guest");
    expect(provider.requests[0]?.systemPrompt).toContain("The guest is not Sid");
    expect(provider.requests[0]?.systemPrompt).toContain("no access to Sid's owner memory");
    expect(provider.requests[0]?.systemPrompt).toContain("Everything you return is spoken aloud");
    expect(provider.requests[0]?.systemPrompt).toContain("no lists, no headings, no markdown, and no emoji");
    expect(provider.requests[0]?.systemPrompt).not.toContain("Sid's private assistant");
    expect(provider.requests[0]?.systemPrompt).not.toContain("Infer what Sid means");
    expect(provider.requests[0]?.systemPrompt).not.toContain("speaking with Sid");
    expect(provider.requests[0]?.systemPrompt).not.toContain("/decisions");
    expect(provider.requests[0]?.systemPrompt).not.toContain("[[claim");
    expect(provider.requests[0]?.tools).toHaveLength(0);
    expect(provider.requests[0]?.toolChoice).toBe("none");
  });

  it("withholds the previous delivered assistant reply block from a second guest voice turn", async () => {
    const ownerPrincipalId = `principal:voice-guest-history-owner:${serial + 1}`;
    const guestPrincipalId = `principal:voice-guest-history-guest:${serial + 1}`;
    const sessionId = `voice:guest-history:${serial + 1}`;
    const provider = new FakeAgentProvider([
      stopped("A guest-only prior reply."),
      stopped("A second guest reply."),
    ]);

    await runVoiceTurn({ text: "first", provider, ownerPrincipalId, turnPrincipalId: guestPrincipalId, sessionId });
    await runVoiceTurn({ text: "second", provider, ownerPrincipalId, turnPrincipalId: guestPrincipalId, sessionId });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.systemPrompt).not.toContain("Previous delivered assistant reply");
    expect(provider.requests[1]?.systemPrompt).not.toContain("A guest-only prior reply.");
  });

  it("refuses a guest voice memory tool without writing owner or guest memory", async () => {
    const ownerPrincipalId = `principal:voice-guest-write-owner:${serial + 1}`;
    const guestPrincipalId = `principal:voice-guest-write-guest:${serial + 1}`;
    const provider = new FakeAgentProvider([
      called(tool("guest-memory", "memory_remember", {
        fact: "The guest likes green tea.",
        supportingExcerpt: "I like green tea.",
        evidenceClass: "stated",
        previousOfferExcerpt: null,
        kind: "preference",
        sensitivity: "normal",
      })),
      stopped("Nothing changed."),
    ]);

    await runVoiceTurn({
      text: "I like green tea.",
      provider,
      ownerPrincipalId,
      turnPrincipalId: guestPrincipalId,
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools).toHaveLength(0);
    expect(provider.requests[0]?.toolChoice).toBe("none");
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: expect.stringContaining("not the owner's own call"),
    });
    for (const principalId of [ownerPrincipalId, guestPrincipalId]) {
      expect(await env.DB.prepare("SELECT count(*) AS count FROM memory_items WHERE principal_id = ?1")
        .bind(principalId).first()).toEqual({ count: 0 });
    }
  });

  it("retrieves the same canonical memory and owner history on either channel", async () => {
    const principalId = `principal:voice-recall:${serial + 1}`;
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const memory = new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE, now: () => NOW });
    const input = { principalId, purpose: "conversation" as const, query: "coffee black", maxTokens: 24000 };
    const telegram = await memory.retrieve({ ...input, channel: "telegram" });
    const voice = await memory.retrieve({ ...input, channel: "voice" });
    expect(voice).toEqual(telegram);
    expect(voice.some(entry => entry.text.includes(itemId))).toBe(true);
    expect(voice.some(entry => entry.text === "I take my coffee black.")).toBe(true);
  });

  it("delivers the first sentence through redaction while the provider still holds the rest of the reply", async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const opening = new Promise<void>((resolve) => { started = resolve; });
    const heard: string[] = [];
    let ended = false;
    const provider = new DeepSeekAgentProvider({
      apiKey: "public-synthetic-stream-key",
      fetchImplementation: async () => new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(agentFrame({ content: "Here is the first sentence. " })));
          started();
          await held;
          controller.enqueue(new TextEncoder().encode(agentFrame({ content: "Here is the rest." }) + agentFrame({}, "stop") + "data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    });
    const turn = runVoiceTurn({ text: "Tell me two things", provider, onToken: (text) => heard.push(text) })
      .then((text) => { ended = true; return text; });
    try {
      await opening;
      await vi.waitFor(() => expect(heard.join("")).toContain("Here is the first sentence."), { timeout: 1_000 });
      expect(ended).toBe(false);
      expect(heard.join("")).not.toContain("Here is the rest.");
    } finally { release(); }
    expect(await turn).toBe("Here is the first sentence. Here is the rest.");
  });

  it("runs a chunked tool call mid-stream exactly once and never speaks a save claim before its receipt", async () => {
    const principalId = `principal:voice-stream-save:${serial + 1}`;
    const heard: string[] = [];
    const fact = "I take my coffee black.";
    const args = JSON.stringify({ fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null, kind: "fact", sensitivity: "normal" });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(agentResponse([
        agentFrame({ content: "I've sa" }), agentFrame({ content: "ved that. Here is some context." }),
        ...toolFrames("memory_remember", args), agentFrame({}, "tool_calls"), "data: [DONE]\n\n",
      ]))
      .mockImplementationOnce(async () => {
        expect(heard.join("")).toContain("Memory:");
        expect(heard.join("")).not.toContain(UNRECEIPTED_VOICE_ACTION);
        return textResponse("I saved your other preference. You can ask me about it later.");
      });
    const spoken = await runVoiceTurn({ text: fact, ownerPrincipalId: principalId,
      provider: new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: fetcher }),
      onToken: (text) => heard.push(text),
    });
    expect(spoken).not.toContain("I've saved that");
    expect(spoken).not.toContain("I saved your other preference");
    expect(spoken).toContain(UNRECEIPTED_VOICE_ACTION);
    expect(spoken).toContain(fact);
    expect(spoken).toContain("You can ask me about it later.");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ stream: true, tool_choice: "none" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE principal_id = ?1").bind(principalId).first<{ count: number }>())?.count).toBe(1);
  });

  it("retains a committed receipt when the follow-up fails without claiming that nothing was saved", async () => {
    const principalId = `principal:voice-stream-failure:${serial + 1}`;
    const fact = "I take my coffee black.";
    const provider = new FakeAgentProvider([
      called(tool("save-before-failure", "memory_remember", { fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null, kind: "fact", sensitivity: "normal" })),
      new Error("synthetic_followup_failure"),
    ]);
    const spoken = await runVoiceTurn({ text: fact, ownerPrincipalId: principalId, provider });
    expect(spoken).toContain("Memory:");
    expect(spoken).toContain("I couldn't finish that reply.");
    expect(spoken).not.toMatch(/nothing (?:changed|was saved)/iu);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE principal_id = ?1").bind(principalId).first<{ count: number }>())?.count).toBe(1);
  });

  it("refuses a second tool round even when an injected provider ignores the no-tools request", async () => {
    const principalId = `principal:voice-stream-repeat:${serial + 1}`;
    const first = "I take my coffee black.";
    const second = "I play piano.";
    const remember = (id: string, fact: string) => tool(id, "memory_remember", {
      fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null, kind: "fact", sensitivity: "normal",
    });
    const provider = new FakeAgentProvider([called(remember("first-action", first)), called(remember("extra-action", second))]);
    const spoken = await runVoiceTurn({ text: `${first} ${second}`, ownerPrincipalId: principalId, provider });
    expect(spoken).toContain("I couldn't finish that reply.");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE principal_id = ?1").bind(principalId).first<{ count: number }>())?.count).toBe(1);
  });

  it("holds an unfinished save claim until a clean stop and checks it before speech", async () => {
    const spoken = await runVoiceTurn({ text: "hello", provider: new FakeAgentProvider([stopped("I've saved that")]) });
    expect(spoken).not.toContain("I've saved that");
    expect(spoken).toContain(UNRECEIPTED_VOICE_ACTION);
  });

  it("bounds an unfinished model reply without releasing its oversized claim", async () => {
    const spoken = await runVoiceTurn({ text: "hello", provider: new FakeAgentProvider([stopped("I've saved " + "x".repeat(4_096))]) });
    expect(spoken).not.toContain("I've saved");
    expect(spoken).toBe("I couldn't finish that reply. Please check any action receipt before trying again.");
  });

  it("bounds expanded refusal text before it exceeds the caller's output allowance", async () => {
    const heard: string[] = [];
    await expect(runVoiceTurn({ text: "hello", provider: new FakeAgentProvider([stopped("Done. Done.")]),
      maxOutputCharacters: 32, onToken: (text) => heard.push(text),
    })).rejects.toThrow("voice_turn_not_sent:failed");
    expect(heard.join("").length).toBeLessThanOrEqual(32);
  });

  it("replaces an incomplete or empty stream instead of flushing its unfinished claim", async () => {
    const provider = new FakeAgentProvider([]);
    provider.streamAgent = async function* () { yield { type: "text", text: "I've saved that" }; };
    const spoken = await runVoiceTurn({ text: "hello", provider });
    expect(spoken).toContain("I couldn't finish that reply.");
    expect(spoken).not.toContain("I've saved that");
    expect(await runVoiceTurn({ text: "hello", provider: new FakeAgentProvider([stopped("")]) }))
      .toBe("I couldn't form a reply. Please try again.");
  });

  it("does not speak a delta returned after the caller cancels", async () => {
    const controller = new AbortController();
    const provider = new FakeAgentProvider([]);
    provider.streamAgent = async function* () {
      controller.abort();
      yield { type: "text", text: "This must not be spoken." };
    };
    const heard: string[] = [];
    await expect(runVoiceTurn({ text: "hello", provider, signal: controller.signal, onToken: (text) => heard.push(text) }))
      .rejects.toThrow("voice_turn_not_sent:cancelled");
    expect(heard).toEqual([]);
  });

  it("does not dispatch a tool if cancellation arrives while the completed stream closes", async () => {
    const principalId = `principal:voice-stream-cancel:${serial + 1}`;
    const controller = new AbortController();
    const fact = "I take my coffee black.";
    const provider = new FakeAgentProvider([]);
    provider.streamAgent = async function* () {
      try { yield { type: "completed", completion: called(tool("cancelled-action", "memory_remember", {
        fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null, kind: "fact", sensitivity: "normal",
      })) }; } finally { controller.abort(); }
    };
    await expect(runVoiceTurn({ text: fact, ownerPrincipalId: principalId, provider, signal: controller.signal }))
      .rejects.toThrow("voice_turn_not_sent:cancelled");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE principal_id = ?1").bind(principalId).first<{ count: number }>())?.count).toBe(0);
  });

  it("does not start the follow-up when the caller cancels after hearing a receipt", async () => {
    const principalId = `principal:voice-stream-cancel-followup:${serial + 1}`;
    const controller = new AbortController();
    const fact = "I take my coffee black.";
    const provider = new FakeAgentProvider([called(tool("saved-before-cancel", "memory_remember", {
      fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null, kind: "fact", sensitivity: "normal",
    })), stopped("This must not start.")]);
    await expect(runVoiceTurn({ text: fact, ownerPrincipalId: principalId, provider, signal: controller.signal,
      onToken: (text) => { if (text.includes("Memory:")) controller.abort(); },
    })).rejects.toThrow("voice_turn_not_sent:cancelled");
    expect(provider.requests).toHaveLength(1);
  });

  it("does not speak a receipt when cancellation arrives during the tool itself", async () => {
    const principalId = `principal:voice-stream-cancel-tool:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const controller = new AbortController();
    const heard: string[] = [];
    const provider = new FakeAgentProvider([called(tool("cancel-during-pin", "memory_pin", { itemId })), stopped("Okay.")]);
    await expect(runVoiceTurn({ text: "pin that", ownerPrincipalId: principalId, provider,
      signal: controller.signal, onToken: (text) => heard.push(text),
      targets: { async findControlTargets() { controller.abort(); return [itemId]; } },
    })).rejects.toThrow("voice_turn_not_sent:cancelled");
    expect(heard).toEqual([]);
    // Cancellation cannot undo a commit already in progress. No speech is
    // sent to the cancelled turn, and the durable pin is not misreported away.
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_item_pins WHERE principal_id = ?1").bind(principalId).first<{ count: number }>())?.count).toBe(1);
  });

  it("delivers every sentence of a worked explanation on an ordinary owner voice turn", async () => {
    const provider = new FakeAgentProvider([stopped(WORKED_REPLY)]);
    await expect(runVoiceTurn({ text: "Explain the homework step by step.", provider })).resolves.toBe(WORKED_REPLY);
    expect(provider.requests).toHaveLength(1);
  });

  it.each(GUIDED_ASSIGNMENT_QUESTIONS)("delivers the guided assignment question over voice: %s", async (reply) => {
    const provider = new FakeAgentProvider([stopped(reply)]);
    await expect(runVoiceTurn({ text: "Ask me one simple question about my assignment.", provider })).resolves.toBe(reply);
    expect(provider.requests).toHaveLength(1);
  });

  it("blocks an undeclared action after a worked object over voice", async () => {
    const provider = new FakeAgentProvider([stopped("I added a function and deployed it.")]);
    await expect(runVoiceTurn({ text: "Explain the function.", provider })).resolves.toContain("I can't confirm that action.");
    expect(provider.requests).toHaveLength(1);
  });

  it("runs a memory tool call over a call and speaks the receipt", async () => {
    const principalId = `principal:voice-pin:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const provider = new FakeAgentProvider([
      called(tool("pin-1", "memory_pin", { itemId })),
      stopped("Okay."),
    ]);

    const spoken = await runVoiceTurn({
      text: "keep that in front of you",
      provider,
      ownerPrincipalId: principalId,
      context: Object.freeze([memoryContext("I take my coffee black.", itemId)]),
    });

    expect(spoken).toContain("Pinned");
    // The receipt is spoken by the channel, so it names the stored wording
    // without the model having to repeat it.
    expect(spoken).toContain("I take my coffee black.");
    const state = await env.DB.prepare(`SELECT lifecycle_state FROM memory_item_state
      WHERE principal_id = ?1 AND item_id = ?2`).bind(principalId, itemId).first<{ lifecycle_state: string }>();
    expect(state?.lifecycle_state).toBe("active");
    const pins = await env.DB.prepare(`SELECT COUNT(*) AS count FROM memory_item_pins
      WHERE principal_id = ?1 AND item_id = ?2`).bind(principalId, itemId).first<{ count: number }>();
    expect(pins?.count).toBe(1);
  });

  it("speaks the follow-up's exact current receipt sentence instead of replacing it", async () => {
    const principalId = `principal:voice-repeat-receipt:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    let repeated = "";
    const provider = new FakeAgentProvider([]);
    provider.streamAgent = async function* (input) {
      const results = input.toolResults ?? [];
      if (results.length === 0) {
        yield { type: "completed", completion: called(tool("repeat-pin", "memory_pin", { itemId })) };
        return;
      }
      const result = JSON.parse(results[0]!.content) as { receipt: string };
      repeated = /^Pinned[^.]+\./u.exec(result.receipt)?.[0] ?? "";
      expect(repeated).not.toBe("");
      yield { type: "text", text: repeated };
      yield { type: "completed", completion: stopped(repeated) };
    };
    const spoken = await runVoiceTurn({ text: "pin that", ownerPrincipalId: principalId, provider,
      context: [memoryContext("I take my coffee black.", itemId)],
    });
    expect(spoken.split(repeated)).toHaveLength(3);
    expect(spoken).not.toContain(UNRECEIPTED_VOICE_ACTION);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_item_pins WHERE principal_id = ?1")
      .bind(principalId).first<{ count: number }>())?.count).toBe(1);
  });

  it("speaks a marked save paraphrase only after its real tool receipt and strips the metadata", async () => {
    const principalId = `principal:voice-marked-save:${serial + 1}`;
    const fact = "I take my coffee black.";
    const provider = new FakeAgentProvider([]);
    provider.streamAgent = async function* (input) {
      const results = input.toolResults ?? [];
      if (results.length === 0) {
        yield { type: "completed", completion: called(tool("marked-save", "memory_remember", {
          fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null, kind: "fact", sensitivity: "normal",
        })) };
        return;
      }
      const result = JSON.parse(results[0]!.content) as { receiptId: string };
      const text = `[[claim ${JSON.stringify({ toolName: "memory_remember", receiptIds: [result.receiptId] })}]]I've logged that.[[/claim]]`;
      for (const character of text) yield { type: "text", text: character };
      yield { type: "completed", completion: stopped(text) };
    };
    const spoken = await runVoiceTurn({ text: fact, ownerPrincipalId: principalId, provider });
    expect(spoken).toContain("I've logged that.");
    expect(spoken.indexOf("Memory:")).toBeLessThan(spoken.indexOf("I've logged that."));
    expect(spoken).not.toContain("[[");
    expect(spoken).not.toContain("receipt:");
    expect(spoken).not.toContain(UNRECEIPTED_VOICE_ACTION);
  });

  it.each([
    ['The file has password = "alpha. bravo charlie" inside. Continue safely.', "bravo charlie"],
    ["The header is Authorization: Digest a1b2c3. d4e5f6g7h8 secret.", "d4e5f6g7h8"],
  ])("never delivers the secret tail from the unsplit reply %s to the caller", async (text, tail) => {
    const provider = new FakeAgentProvider([]);
    provider.streamAgent = async function* () {
      for (const character of text) yield { type: "text", text: character };
      yield { type: "completed", completion: stopped(text) };
    };
    const heard: string[] = [];
    const spoken = await runVoiceTurn({ text: "Explain that fixture", provider, onToken: (part) => heard.push(part) });
    expect(heard.join("")).not.toContain(tail);
    const expected = new Redactor().redactText(text);
    expect(expected.ok && spoken === expected.text).toBe(true);
    expect(spoken).not.toContain("\n");
  });

  it("refuses every tool when the call's principal is not the configured owner", async () => {
    const principalId = `principal:voice-not-owner:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const provider = new FakeAgentProvider([
      called(tool("pin-2", "memory_pin", { itemId })),
      stopped("I could not do that."),
    ]);

    await runVoiceTurn({
      text: "pin that",
      provider,
      ownerPrincipalId: `principal:voice-somebody-else:${serial}`,
      turnPrincipalId: principalId,
      context: Object.freeze([memoryContext("I take my coffee black.", itemId)]),
    });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: "I refused that tool call because this is not the owner's own call. Nothing changed.",
    });
    const pins = await env.DB.prepare(`SELECT COUNT(*) AS count FROM memory_item_pins
      WHERE principal_id = ?1`).bind(principalId).first<{ count: number }>();
    expect(pins?.count).toBe(0);
  });

  it("refuses a tool whose item the real finder cannot resolve, so the tool is not called blind", async () => {
    const principalId = `principal:voice-unresolvable:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const provider = new FakeAgentProvider([
      called(tool("pin-3", "memory_pin", { itemId })),
      stopped("I could not do that."),
    ]);

    // No context naming the item and no previous turn referencing it, so the
    // real finder returns nothing and the eligibility set is empty. This is the
    // path that did not exist on voice at all before the finder came with it.
    const spoken = await runVoiceTurn({
      text: "pin that",
      provider,
      ownerPrincipalId: principalId,
      context: Object.freeze([]),
    });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: "I could not safely apply that tool call, so nothing changed.",
    });
    const pins = await env.DB.prepare(`SELECT COUNT(*) AS count FROM memory_item_pins
      WHERE principal_id = ?1`).bind(principalId).first<{ count: number }>();
    expect(pins?.count).toBe(0);
    expect(spoken).toContain("I could not do that.");
  });

  it("says it cannot search memory when the deployment has no index bound", async () => {
    const principalId = `principal:voice-no-index:${serial + 1}`;
    await seedPrincipal(principalId);
    const provider = new FakeAgentProvider([
      called(tool("search-1", "memory_search", { query: "coffee" })),
      stopped("I cannot look that up."),
    ]);

    await runVoiceTurn({
      text: "what do you know about my coffee?",
      provider,
      ownerPrincipalId: principalId,
      context: Object.freeze([]),
    });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: "I cannot search memory right now: this deployment has no memory index bound, so nothing was searched. "
        + "Tell Sid that rather than answering from memory.",
    });
  });

  it("offers the complete Telegram catalogue, including deadline_record, within the provider tool bound on a call", async () => {
    const principalId = `principal:voice-prompt:${serial + 1}`;
    await seedPrincipal(principalId);
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId });

    const request = provider.requests[0];
    expect(request?.systemPrompt).toContain("You are speaking with Sid on a phone call.");
    expect(request?.systemPrompt).toContain(OWNER_VOICE_AGENT_CHANNEL_PROMPT);
    expect(request?.systemPrompt).toContain("A spoken yes does not confirm a model-inferred memory.");
    expect(request?.systemPrompt).not.toContain("Previous delivered assistant reply on this session");
    expect(request?.tools).toEqual(OWNER_TOOL_DEFINITIONS);
    expect(request?.tools).toHaveLength(18);
    expect(request!.tools.length).toBeLessThanOrEqual(32);
    expect(request?.tools).toEqual(expect.arrayContaining([...GUIDED_ASSIGNMENT_TOOL_DEFINITIONS]));
    expect(request?.tools.map((definition) => definition.name)).toEqual(expect.arrayContaining([
      "memory_remember", "memory_correct", "memory_forget", "memory_restore",
      "memory_confirm", "memory_explain", "memory_search", "memory_pin", "memory_unpin",
      ...OWNER_ARGUMENT_TOOL_DEFINITIONS.map(definition => definition.name),
      "deadline_record",
      "guided_assignment_read", "guided_assignment_save", "guided_assignment_draft",
      "school_d2l_status", "school_collector_revoke",
    ]));
    const telegramRequests: ModelAgentCompletionInput[] = [];
    const telegramProvider: ModelAgentProvider = {
      async completeAgent(input) {
        telegramRequests.push(input);
        return Object.freeze({
          content: JSON.stringify({ reply: "Hello.", claimedActions: [] }),
          toolCalls: Object.freeze([]),
          finishReason: "stop" as const,
        });
      },
    };
    const adapter = new OwnerTelegramAgentAdapter({
      provider: telegramProvider, database: env.DB, archive: env.ARCHIVE,
      ownerPrincipalId: principalId, directOwnerText: true, authorityText: "hello",
      targets: new D1MemoryControlTargetFinder({ database: env.DB, archive: env.ARCHIVE }),
      decisions: new DecisionService({ repository: new DecisionRepository(env.DB) }),
      autonomy: new ToolAutonomyGate(new AutonomyService({ repository: new AutonomyRepository(env.DB) }), new D1ToolConfirmationStore(env.DB)),
      ...createOwnerPipelineModels(env, { async *stream() {} }, new Redactor(), principalId, true, () => NOW),
    });
    for await (const _ of adapter.stream({
      correlationId: newUlid(), principalId, channel: "telegram", userText: "hello",
      context: [], contextTokenBudget: 24000, firstTokenTimeoutMs: 8000, timeoutMs: 20000,
      maxOutputCharacters: 4096,
      reasoningEffort: "low", signal: new AbortController().signal,
    })) { /* Consume the same public ModelAdapter surface on both channels. */ }
    expect(request?.tools).toEqual(telegramRequests[0]?.tools);

  });

  it("resolves an item the context does not name, through the finder it was given", async () => {
    const principalId = `principal:voice-finder:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const provider = new FakeAgentProvider([
      called(tool("pin-4", "memory_pin", { itemId })),
      stopped("Okay."),
    ]);

    // The context names nothing and this session has no previous voice turn, so
    // the only route to the item is the finder the adapter was constructed with.
    // A voice adapter that did not consult it would refuse here instead of
    // pinning, which is the difference this pins down.
    const spoken = await runVoiceTurn({
      text: "keep that one in front of you",
      provider,
      ownerPrincipalId: principalId,
      context: Object.freeze([]),
      targets: { async findControlTargets() { return Object.freeze([itemId]); } },
    });

    expect(spoken).toContain("I take my coffee black.");
    const pins = await env.DB.prepare(`SELECT COUNT(*) AS count FROM memory_item_pins
      WHERE principal_id = ?1 AND item_id = ?2`).bind(principalId, itemId).first<{ count: number }>();
    expect(pins?.count).toBe(1);
  });

  it("refuses a tool that no channel-neutral catalogue gives a call, instead of running it", async () => {
    const principalId = `principal:voice-unknown-tool:${serial + 1}`;
    await seedPrincipal(principalId);
    const provider = new FakeAgentProvider([
      called(tool("unknown-1", "unknown_tool", {})),
      stopped("I could not do that."),
    ]);

    await runVoiceTurn({ text: "update my school work", provider, ownerPrincipalId: principalId });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: "I refused an unknown tool call. Nothing changed.",
    });
  });

  it("can be built without a previous assistant turn, which the confirmation tools then refuse on", async () => {
    const principalId = `principal:voice-no-previous:${serial + 1}`;
    await seedPrincipal(principalId);
    const provider = new FakeAgentProvider([
      called(tool("remember-1", "memory_remember", {
        fact: "I take my coffee black.",
        supportingExcerpt: "I take my coffee black",
        evidenceClass: "confirmed",
        previousOfferExcerpt: "Do you want me to note that?",
        kind: "fact",
        sensitivity: "normal",
      })),
      stopped("I could not do that."),
    ]);

    await runVoiceTurn({
      text: "yes, I take my coffee black",
      provider,
      ownerPrincipalId: principalId,
      context: Object.freeze([]),
    });

    // No previous voice turn exists in this session, so the grounding cannot be
    // proven and the tool refuses rather than writing an ungrounded memory.
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: "I could not safely apply that tool call, so nothing changed.",
    });
  });

  describe("a yes to an offer to note something", () => {
    const OFFER = "Do you want me to note that you take your coffee black?";

    /** Two turns: Jarvis offers on the first, Sid answers "yes" on the second. */
    async function offerThenYes(principalId: string, offerSession: string, answerSession: string) {
      await seedPrincipal(principalId);
      await runVoiceTurn({
        text: "I've started taking my coffee black",
        provider: new FakeAgentProvider([stopped(OFFER)]),
        ownerPrincipalId: principalId,
        sessionId: offerSession,
      });
      const provider = new FakeAgentProvider([
        called(tool("remember-yes", "memory_remember", {
          fact: "I take my coffee black.",
          supportingExcerpt: "I take my coffee black",
          evidenceClass: "confirmed",
          previousOfferExcerpt: OFFER,
          kind: "fact",
          sensitivity: "normal",
        })),
        stopped("Done."),
      ]);
      await runVoiceTurn({
        text: "yes, I take my coffee black",
        provider,
        ownerPrincipalId: principalId,
        sessionId: answerSession,
      });
      const saved = await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE principal_id = ?1")
        .bind(principalId).first<{ count: number }>();
      return {
        toolResult: JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}") as Record<string, unknown>,
        saved: saved?.count ?? -1,
      };
    }

    it("saves it as confirmed when the offer was made earlier on the same call", async () => {
      const principalId = `principal:voice-yes-same-call:${serial + 1}`;
      const call = `voice:call:same:${serial + 1}`;

      const { toolResult, saved } = await offerThenYes(principalId, call, call);

      expect(toolResult).not.toMatchObject({ status: "refused" });
      expect(saved).toBe(1);
    });

    it("does not save it when the offer was made at the end of an earlier call", async () => {
      // Jarvis offers to note something as call A ends; Sid says "yes" on call B.
      // That yes answers nothing Jarvis said on call B, so it cannot ground a
      // confirmed memory -- the offer it would ground on belongs to another call.
      const principalId = `principal:voice-yes-other-call:${serial + 1}`;

      const { toolResult, saved } = await offerThenYes(
        principalId,
        `voice:call:a:${serial + 1}`,
        `voice:call:b:${serial + 1}`,
      );

      expect(toolResult).toMatchObject({
        status: "refused",
        receipt: "I could not safely apply that tool call, so nothing changed.",
      });
      expect(saved).toBe(0);
    });
  });
});

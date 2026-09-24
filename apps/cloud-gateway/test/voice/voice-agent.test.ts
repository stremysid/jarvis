import { createOwnerPipelineModels } from "../../src/agent/owner-pipelines.js";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
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
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { OwnerVoiceAgentAdapter, OWNER_VOICE_AGENT_CHANNEL_PROMPT } from "../../src/voice/voice-agent.js";
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
import type { RetrievedContext } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
  ModelFunctionCall,
} from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyAutonomyToolCapabilitiesMigration, applyNewestRuntimeMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-17T14:00:00.000Z");
const OWNER = "principal:voice-agent-owner";
let serial = 0;

function stopped(reply: string, claimedActions: readonly unknown[] = []): ModelAgentCompletion {
  return Object.freeze({
    content: JSON.stringify({ reply, claimedActions }),
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

class FakeAgentProvider implements ModelAgentProvider {
  readonly requests: ModelAgentCompletionInput[] = [];
  private readonly completions: Array<ModelAgentCompletion | Error>;

  constructor(completions: readonly (ModelAgentCompletion | Error)[]) {
    this.completions = [...completions];
  }

  async completeAgent(input: ModelAgentCompletionInput): Promise<ModelAgentCompletion> {
    this.requests.push(input);
    const completion = this.completions.shift();
    if (completion === undefined) throw new Error("unexpected_agent_call");
    if (completion instanceof Error) throw completion;
    return completion;
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
  await runVoiceTurn({
    text,
    provider: new FakeAgentProvider([stopped("Noted.")]),
    ownerPrincipalId: principalId,
  });
  const source = await env.DB.prepare(`SELECT event_id, sequence, occurred_at FROM events
    WHERE subject_id = ?1 AND event_type = 'conversation.user_committed'
    ORDER BY sequence DESC LIMIT 1`).bind(principalId).first<{
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
  readonly provider: ModelAgentProvider;
  readonly ownerPrincipalId?: string;
  readonly turnPrincipalId?: string;
  readonly context?: readonly RetrievedContext[];
  readonly targets?: MemoryTargetFinder;
  readonly memorySearch?: MeaningSearchReader;
  /** The call this turn belongs to. Each turn is its own call unless a test says otherwise. */
  readonly sessionId?: string;
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
    database: env.DB,
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
  const pieces: string[] = [];
  // The real delivery helper, not a stand-in: it is what refuses a stream whose
  // pieces do not equal the finished text. Its `finish` returns the minted
  // receipt, which `recordVoiceSent` below then validates and consumes.
  const delivery = createVoiceStreamDelivery({
    sessionId,
    turnId,
    sendToken: async (token) => { pieces.push(token.text); },
    finish: async (finalText): Promise<void> => {
      // The contract `createVoiceStreamDelivery` enforces: what was streamed is
      // exactly what is finished.
      expect(pieces.join("")).toBe(finalText);
    },
  });
  const service = new DefaultConversationService({
    repository,
    model,
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
    signal: new AbortController().signal,
    ...delivery,
  });
  if (result.outcome !== "voice_sent") throw new Error(`voice_turn_not_sent:${result.outcome}`);
  return pieces.join("");
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

  it("confirms a staged model memory from a spoken yes on the same call with the real target finder", async () => {
    const principalId = `principal:voice-confirm:${serial + 1}`;
    const sessionId = `voice:confirm:${serial + 1}`;
    const itemId = await offerProposedMemory(principalId, sessionId);
    const provider = new FakeAgentProvider([
      called(tool("confirm", "memory_confirm", { itemId, supportingExcerpt: "yes" })),
      stopped("Here is the result."),
    ]);
    const reply = await runVoiceTurn({ text: "yes", provider, ownerPrincipalId: principalId, sessionId });
    expect(provider.requests[0]?.systemPrompt).toContain('Should I remember exactly');
    expect(provider.requests[0]?.systemPrompt).toContain(itemId);
    expect(JSON.parse(provider.requests[1]!.toolResults![0]!.content)).toMatchObject({ status: "completed" });
    expect(reply).toContain("Confirmed 1 proposed memory");
    await expect(new MemoryRepository(env.DB).readCurrentItem(principalId, itemId)).resolves.toMatchObject({
      lifecycle: { state: "active" }, version: { basis: "confirmed", uncertain: false },
    });
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

  it("keeps the call instructions and pinned profile when rewriting an unsupported action claim", async () => {
    const principalId = `principal:voice-rewrite:${serial + 1}`;
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    await runVoiceTurn({ text: "pin that", ownerPrincipalId: principalId,
      context: [memoryContext("I take my coffee black.", itemId)],
      provider: new FakeAgentProvider([called(tool("pin", "memory_pin", { itemId })), stopped("")]) });
    const provider = new FakeAgentProvider([
      stopped("I sent the email.", [{ sentence: "I sent the email.", receiptIds: [] }]),
      stopped("I can draft the email."),
    ]);
    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.systemPrompt).toContain(OWNER_VOICE_AGENT_CHANNEL_PROMPT);
    expect(provider.requests[1]?.systemPrompt).toContain("I take my coffee black.");
    expect(provider.requests[1]?.tools).toEqual(provider.requests[0]?.tools);
  });

  it("rejects invalid reference metadata in a settled voice reply", () => {
    const base = { schemaCode: 1, channelCode: 1, sensitivityCode: 1, historyEligible: false, text: "A reply." };
    const id = newUlid();
    expect(readVoiceReplyPayload({ ...base, memoryItemIds: [id] }).itemIds).toEqual([id]);
    for (const payload of [
      { ...base, channelCode: 2 }, { ...base, memoryItemIds: [] },
      { ...base, memoryItemIds: ["invalid"] }, { ...base, memoryItemIds: [id, id] },
      { ...base, memoryItemIds: "invalid" }, { ...base, memoryItemIds: Array.from({ length: 9 }, () => newUlid()) },
    ]) expect(() => readVoiceReplyPayload(payload)).toThrow("owner_agent_previous_reply_invalid");
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

  it("runs a memory tool call over a call and speaks the receipt", async () => {
    const principalId = `principal:voice-pin:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const provider = new FakeAgentProvider([
      called(tool("pin-1", "memory_pin", { itemId })),
      stopped("Pinned.", [{ sentence: "Pinned.", receiptIds: ["receipt:pin-1"] }]),
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

  it("offers tools that deep-equal Telegram and tells the model it is speaking on a call", async () => {
    const principalId = `principal:voice-prompt:${serial + 1}`;
    await seedPrincipal(principalId);
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId });

    const request = provider.requests[0];
    expect(request?.systemPrompt).toContain("You are speaking with Sid on a phone call.");
    expect(request?.systemPrompt).toContain(OWNER_VOICE_AGENT_CHANNEL_PROMPT);
    expect(request?.systemPrompt).not.toContain("Previous delivered assistant reply on this session");
    expect(request?.tools).toEqual(OWNER_TOOL_DEFINITIONS);
    const telegramProvider = new FakeAgentProvider([stopped("Hello.")]);
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
    expect(request?.tools).toEqual(telegramProvider.requests[0]?.tools);

  });

  it("resolves an item the context does not name, through the finder it was given", async () => {
    const principalId = `principal:voice-finder:${serial + 1}`;
    await seedPrincipal(principalId);
    const itemId = await activeMemory(principalId, "I take my coffee black.");
    const provider = new FakeAgentProvider([
      called(tool("pin-4", "memory_pin", { itemId })),
      stopped("Pinned.", [{ sentence: "Pinned.", receiptIds: ["receipt:pin-4"] }]),
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

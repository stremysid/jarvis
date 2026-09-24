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

describe("the voice agent adapter", () => {
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
          controller.enqueue(new TextEncoder().encode(agentFrame({ content: "Here is the first sentence." })));
          started();
          await held;
          controller.enqueue(new TextEncoder().encode(agentFrame({ content: " Here is the rest." }) + agentFrame({}, "stop") + "data: [DONE]\n\n"));
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
    expect(await turn).toBe("Here is the first sentence.\nHere is the rest.\n");
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
    expect(spoken).toBe("I couldn't finish that reply. Please check any action receipt before trying again.\n");
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
      .toBe("I couldn't form a reply. Please try again.\n");
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

  it("offers the memory and school tools and tells the model it is speaking on a call", async () => {
    const principalId = `principal:voice-prompt:${serial + 1}`;
    await seedPrincipal(principalId);
    const provider = new FakeAgentProvider([stopped("Hello.")]);

    await runVoiceTurn({ text: "hello", provider, ownerPrincipalId: principalId });

    const request = provider.requests[0];
    expect(request?.systemPrompt).toContain("You are speaking with Sid on a phone call.");
    expect(request?.systemPrompt).toContain(OWNER_VOICE_AGENT_CHANNEL_PROMPT);
    expect(request?.tools.map((definition) => definition.name)).toEqual([
      "memory_remember", "memory_correct", "memory_forget", "memory_restore",
      "memory_confirm", "memory_explain", "memory_search", "memory_pin", "memory_unpin",
      "school_d2l_status", "school_collector_revoke",
    ]);
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
    // A school pipeline tool: it exists on Telegram and not on a call, so the
    // turn must refuse it rather than dispatch something with no adapter behind it.
    const provider = new FakeAgentProvider([
      called(tool("school-1", "school_update", {})),
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

/**
 * `history_search` through the real owner agents on both channels.
 *
 * History is written by real turns -- a Telegram turn and a phone-call turn for
 * the same owner -- so the events searched are the ones `ConversationRepository`
 * actually stores, including the call reply `recordVoiceSent` writes as
 * `conversation.assistant_sent`. The index is then built by the same
 * `LiteralHistoryService.indexNext` the hourly job runs, and each channel's
 * agent is asked to search. Calls and Telegram must get the same tool and the
 * same answer (Sid's rule 3).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";
import { ArchivalService } from "../../src/archive/archival-service.js";
import { ArchiveRepository } from "../../src/archive/archive-repository.js";
import { TieredEventReader } from "../../src/archive/tiered-event-reader.js";
import { capabilityForTool } from "../../src/autonomy/tool-capabilities.js";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { createVoiceStreamDelivery } from "../../src/conversation/conversation-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { buildTelegramConversationRepository, telegramTurnRedactor } from "../../src/index.js";
import { composeHistorySearchPage, HISTORY_SEARCH_PREFIX } from "../../src/memory/history-search.js";
import { LiteralHistoryService, type HistorySearchPage } from "../../src/memory/literal-history.js";
import { MEMORY_TOOL_DEFINITIONS } from "../../src/memory/memory-tools.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { AGENT_MAX_TOOLS } from "../../src/providers/deepseek-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentStreamChunk,
  ModelAgentStreamInput,
  ModelFunctionCall,
  TelegramSendMessageInput,
} from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { voiceSessionAudience } from "../../src/voice/production-runtime.js";
import { OwnerVoiceAgentAdapter } from "../../src/voice/voice-agent.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-24T14:00:00.000Z");
let serial = 7_300_000;
/** Every Telegram message the owner turns delivered, newest last. */
const telegramSent: string[] = [];
/** What the last call turn spoke, token by token. */
let callSpoken = "";

interface Owner {
  readonly principalId: string;
  readonly identityId: string;
  readonly subject: string;
}

interface ToolResult {
  readonly status: string;
  readonly receiptId: string | null;
  readonly receipt: string;
}

async function owner(): Promise<Owner> {
  const principalId = `principal:history-search:${newUlid()}`;
  const identityId = `identity:history-search:${newUlid()}`;
  const subject = String(++serial);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals VALUES (?, 'human', 'active', 'History search owner', ?, ?)")
      .bind(principalId, NOW.toISOString(), NOW.toISOString()),
    env.DB.prepare(`INSERT INTO channel_identities
      (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`)
      .bind(identityId, principalId, subject, NOW.toISOString(), NOW.toISOString()),
  ]);
  return Object.freeze({ principalId, identityId, subject });
}

/** One Telegram turn; the model calls `call` first when given, then replies `reply`. */
async function telegramTurn(who: Owner, text: string, reply: string, call?: ModelFunctionCall, direct = true) {
  const requests: ModelAgentCompletionInput[] = [];
  const repository = buildTelegramConversationRepository(env.DB, new EventRepository(env.DB), {
    principalId: who.principalId, isDirectText: direct, isMemoryControlAuthoritative: direct,
  }, who.principalId);
  const fallback = { async *stream() { yield { index: 0, text: "No action." }; } };
  const model = new OwnerTelegramAgentAdapter({
    database: env.DB, archive: env.ARCHIVE, ownerPrincipalId: who.principalId, authorityText: text,
    directOwnerText: direct, directPipelineText: direct, autonomy: await testToolGate(env.DB), now: () => NOW,
    turnReceivedAt: NOW.toISOString(),
    targets: { async findControlTargets() { return []; } },
    decisions: { async raise() { throw new Error("unexpected_decision"); } },
    schoolModel: fallback, universityModel: fallback, studyCoachModel: fallback,
    provider: {
      async completeAgent(input: ModelAgentCompletionInput): Promise<ModelAgentCompletion> {
        requests.push(input);
        return requests.length === 1 && call !== undefined
          ? { content: null, toolCalls: [call], finishReason: "tool_calls" }
          : { content: JSON.stringify({ reply, claimedActions: [] }), toolCalls: [], finishReason: "stop" };
      },
    },
  });
  const service = new DefaultConversationService({
    // The reader production picks for this principal: the owner's, since #197.
    repository, model, context: { async retrieve() { return []; } },
    redactor: telegramTurnRedactor(who.principalId, who.principalId), now: () => NOW,
    dispatcher: new DefaultOutboxDispatcher({
      repository, identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", { async sendMessage(input: TelegramSendMessageInput) {
        telegramSent.push(input.text);
        return { providerMessageId: String(++serial) };
      } }]]),
      circuitBreaker: new ProviderCircuitBreaker(), now: () => NOW,
    }),
  });
  const result = await service.handleTurn({
    sessionId: `telegram:${who.subject}`, principalId: who.principalId, turnId: newUlid(), text,
    signal: new AbortController().signal, channel: "telegram", kind: "outbox",
    targetIdentityId: who.identityId, replyToMessageId: 1,
  });
  expect(result.outcome).toBe("telegram_delivered");
  return requests;
}

/** One phone-call turn for the same owner, through the real voice agent. */
async function callTurn(who: Owner, text: string, reply: string, call?: ModelFunctionCall) {
  const requests: ModelAgentStreamInput[] = [];
  const fallback = { async *stream() { yield { index: 0, text: "No action." }; } };
  const model = new OwnerVoiceAgentAdapter({
    schoolModel: fallback, universityModel: fallback, studyCoachModel: fallback,
    database: env.DB, archive: env.ARCHIVE, ownerPrincipalId: who.principalId, directOwnerText: true,
    autonomy: await testToolGate(env.DB), now: () => NOW,
    targets: { async findControlTargets() { return []; } },
    decisions: { async raise() { throw new Error("unexpected_decision"); } },
    provider: {
      async completeAgent(): Promise<ModelAgentCompletion> { throw new Error("history_search_call_must_stream"); },
      async *streamAgent(input: ModelAgentStreamInput): AsyncIterable<ModelAgentStreamChunk> {
        requests.push(input);
        if (requests.length === 1 && call !== undefined) {
          yield { type: "completed", completion: { content: null, toolCalls: [call], finishReason: "tool_calls" } };
          return;
        }
        yield { type: "text", text: reply };
        yield { type: "completed", completion: { content: reply, toolCalls: [], finishReason: "stop" } };
      },
    },
  });
  const repository = new ConversationRepository(env.DB, new EventRepository(env.DB));
  const service = new DefaultConversationService({
    // An owner call session's reader, as production-runtime chooses it.
    repository, model, context: { async retrieve() { return []; } },
    redactor: new Redactor(voiceSessionAudience({ accessKind: "owner" })), now: () => NOW,
    dispatcher: { async dispatch() { throw new Error("unexpected_telegram_dispatch"); } },
  });
  const turnId = newUlid();
  const sessionId = `voice:history-search:${turnId}`;
  callSpoken = "";
  const delivery = createVoiceStreamDelivery({
    sessionId, turnId, sendToken: async (token) => { callSpoken += token.text; }, finish: async () => {},
  });
  const result = await service.handleTurn({
    sessionId, principalId: who.principalId, turnId, text, signal: new AbortController().signal, ...delivery,
  });
  expect(result.outcome).toBe("voice_sent");
  return requests;
}

/** The hourly job's indexer, run to completion for this owner. */
async function indexHistory(who: Owner): Promise<void> {
  const state = new ArchiveRepository(env.DB);
  const history = new LiteralHistoryService({
    database: env.DB,
    events: new TieredEventReader({
      live: new EventRepository(env.DB),
      archive: new ArchivalService({ database: env.DB, bucket: env.ARCHIVE }),
      state,
    }),
    archive: state,
    now: () => NOW,
    nextId: () => newUlid(NOW),
  });
  for (let step = 0; step < 32; step += 1) {
    const result = await history.indexNext({ principalId: who.principalId, maxEvents: 16, maxTextBytes: 262_144 });
    if (result.complete) return;
  }
  throw new Error("history_search_index_incomplete");
}

function searchCall(id: string, args: Readonly<Record<string, unknown>>): ModelFunctionCall {
  return { id, name: "history_search", arguments: JSON.stringify(args) };
}

function toolResult(requests: readonly { toolResults?: readonly { content: string }[] }[]): ToolResult {
  return JSON.parse(requests[1]?.toolResults?.[0]?.content ?? "{}") as ToolResult;
}

function hitLines(receipt: string): readonly string[] {
  return receipt.split("\n").filter((line) => line.startsWith("- "));
}

async function storedEventId(principalId: string, eventType: string, text: string): Promise<Ulid> {
  const rows = await env.DB.prepare(`SELECT event_id, envelope_json FROM events
    WHERE subject_id = ? AND event_type = ? ORDER BY sequence ASC`)
    .bind(principalId, eventType).all<{ event_id: string; envelope_json: string }>();
  const row = rows.results.find((candidate) =>
    (JSON.parse(candidate.envelope_json) as { payload: { text: string } }).payload.text === text);
  if (row === undefined) throw new Error(`history_search_event_missing:${eventType}`);
  return row.event_id as Ulid;
}

beforeAll(async () => {
  await applyNewestRuntimeMigration();
});

describe("the history_search tool definition", () => {
  it("is offered with one identical definition to Telegram and to calls, within the provider's tool cap", async () => {
    // #174 made one owner catalogue for both channels; this checks what each
    // channel actually sends the model, not only the shared list.
    const shared = MEMORY_TOOL_DEFINITIONS.filter((definition) => definition.name === "history_search");
    const who = await owner();
    const telegram = (await telegramTurn(who, "hello", "Hi."))[0]?.tools ?? [];
    const call = (await callTurn(who, "hello", "Hi."))[0]?.tools ?? [];

    expect(shared).toHaveLength(1);
    expect(OWNER_TOOL_DEFINITIONS.filter((definition) => definition.name === "history_search")).toEqual(shared);
    expect(telegram.filter((definition) => definition.name === "history_search")).toEqual(shared);
    expect(call.filter((definition) => definition.name === "history_search")).toEqual(shared);
    expect(OWNER_TOOL_DEFINITIONS.length).toBeLessThanOrEqual(AGENT_MAX_TOOLS);
    expect(telegram.length).toBeLessThanOrEqual(AGENT_MAX_TOOLS);
    expect(call.length).toBeLessThanOrEqual(AGENT_MAX_TOOLS);
    expect(AGENT_MAX_TOOLS).toBe(64);
  });

  it("is classified as a memory read, so the tier gate permits it without a tap", () => {
    expect(capabilityForTool("history_search")).toBe("memory.read");
  });
});

describe("history_search through the owner agents", () => {
  it("finds a Telegram message, a call utterance and a call reply from both a Telegram turn and a call, with identical hits", async () => {
    const who = await owner();
    await telegramTurn(who, "My cobalt folder has the chemistry lab notes.", "Noted.");
    await callTurn(who, "Remember the cobalt folder goes in my backpack.", "I will remind you to pack the cobalt folder.");
    await indexHistory(who);

    const fromTelegram = toolResult(await telegramTurn(
      who, "what did we say about the cobalt folder?", "Here is what I found.",
      searchCall("history-telegram", { query: "cobalt folder" }),
    ));
    const fromCall = toolResult(await callTurn(
      who, "what did we say about the cobalt folder?", "Here is what I found.",
      searchCall("history-call", { query: "cobalt folder" }),
    ));

    for (const result of [fromTelegram, fromCall]) {
      expect(result.status).toBe("completed");
      // Looking is not an action, so there is nothing to receipt.
      expect(result.receiptId).toBeNull();
      expect(result.receipt).toContain(HISTORY_SEARCH_PREFIX);
    }
    const lines = hitLines(fromTelegram.receipt);
    expect(hitLines(fromCall.receipt)).toEqual(lines);
    const telegramMessage = await storedEventId(
      who.principalId, "conversation.user_committed", "My cobalt folder has the chemistry lab notes.",
    );
    const callUtterance = await storedEventId(
      who.principalId, "conversation.user_committed", "Remember the cobalt folder goes in my backpack.",
    );
    const callReply = await storedEventId(
      who.principalId, "conversation.assistant_sent", "I will remind you to pack the cobalt folder.",
    );
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringContaining(`Telegram, Sid said: "My cobalt folder has the chemistry lab notes."  [event ${telegramMessage}]`),
      expect.stringContaining(`call, Sid said: "Remember the cobalt folder goes in my backpack."  [event ${callUtterance}]`),
      expect.stringContaining(`call, Jarvis said: "I will remind you to pack the cobalt folder."  [event ${callReply}]`),
    ]));
    // The search turns themselves are newer than the index, and the result says so.
    expect(fromCall.receipt).toContain("Index coverage: incomplete.");
  });

  it("puts what Jarvis said on a call into the next Telegram turn's recent context", async () => {
    const who = await owner();
    await callTurn(who, "What is on for tonight?", "Chemistry revision at seven.");

    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE, now: () => NOW })
      .retrieve({ principalId: who.principalId, channel: "telegram", purpose: "conversation", query: "tonight", maxTokens: 24_000 });

    expect(contexts.map((context) => context.text)).toEqual(expect.arrayContaining([
      "What is on for tonight?",
      "Chemistry revision at seven.",
    ]));
  });

  it("refuses history_search on Telegram when the turn is not Sid's direct text", async () => {
    const who = await owner();
    await telegramTurn(who, "The cobalt folder is in my locker.", "Noted.");
    await indexHistory(who);

    const result = toolResult(await telegramTurn(
      who, "what about the cobalt folder?", "I cannot search that here.",
      searchCall("history-indirect", { query: "cobalt" }), false,
    ));

    expect(result.status).toBe("refused");
    expect(result.receipt).not.toContain("cobalt folder is in my locker");
  });

  it("flags more results and serves the next page when asked", async () => {
    const who = await owner();
    for (const letter of ["a", "b", "c", "d", "e", "f"]) {
      await telegramTurn(who, `Peach reminder ${letter}.`, "Noted.");
    }
    await indexHistory(who);

    const first = toolResult(await telegramTurn(
      who, "find the peach reminders", "Found them.", searchCall("history-page-1", { query: "peach", speaker: "sid" }),
    ));
    const second = toolResult(await telegramTurn(
      who, "and the rest", "Found the rest.", searchCall("history-page-2", { query: "peach", speaker: "sid", page: 2 }),
    ));

    expect(hitLines(first.receipt)).toHaveLength(5);
    expect(first.receipt).toContain("More results: yes. Call history_search again with the same query and page 2.");
    expect(hitLines(second.receipt)).toHaveLength(1);
    expect(second.receipt).toContain("More results: no.");
    expect(new Set([...hitLines(first.receipt), ...hitLines(second.receipt)]).size).toBe(6);
  });

  it("reads the conversation around a hit on a call and on Telegram, with the same messages", async () => {
    const who = await owner();
    await callTurn(who, "Which binder do I need for history class?", "Bring the lime binder.");
    await indexHistory(who);
    const reply = await storedEventId(who.principalId, "conversation.assistant_sent", "Bring the lime binder.");

    const fromCall = toolResult(await callTurn(
      who, "what was that about the binder?", "You asked which binder.",
      searchCall("history-around-call", { aroundEventId: reply, window: 1 }),
    ));
    const fromTelegram = toolResult(await telegramTurn(
      who, "what was that about the binder?", "You asked which binder.",
      searchCall("history-around-telegram", { aroundEventId: reply, window: 1 }),
    ));

    for (const result of [fromCall, fromTelegram]) {
      expect(result.status).toBe("completed");
      const lines = result.receipt.split("\n").slice(1);
      expect(lines[0]).toContain('call, Sid said: "Which binder do I need for history class?"');
      expect(lines[1]).toMatch(/^>> .*call, Jarvis said: "Bring the lime binder\."/u);
    }
    // One message each side: both reads end at the call's search question, so they match exactly.
    expect(fromTelegram.receipt).toBe(fromCall.receipt);
  });

  it("names the event id, not the query, when an around read is refused", async () => {
    const who = await owner();

    const result = toolResult(await telegramTurn(
      who, "what came before that?", "I could not read that.",
      searchCall("history-around-bad-id", { aroundEventId: "not-an-event-id" }),
    ));

    expect(result.status).toBe("refused");
    expect(result.receipt).toContain("aroundEventId is not a valid event id");
    expect(result.receipt).not.toContain("the query has no letters or digits");
  });

  it("gives Sid his own code back unredacted from history_search, on a call and on Telegram", async () => {
    // #197: toward Sid nothing of his is hidden. A guest turn gets no owner
    // tools at all, so history_search never runs for one.
    const who = await owner();
    await telegramTurn(who, "My gym locker code is 4417.", "Noted.");
    await indexHistory(who);

    const fromCall = toolResult(await callTurn(
      who, "what was my gym locker code?", "Your gym locker code is 4417.",
      searchCall("history-code-call", { query: "gym locker code" }),
    ));
    const spokenOnCall = callSpoken;
    const fromTelegram = toolResult(await telegramTurn(
      who, "what was my gym locker code?", "Your gym locker code is 4417.",
      searchCall("history-code-telegram", { query: "gym locker code" }),
    ));

    for (const result of [fromCall, fromTelegram]) {
      expect(result.status).toBe("completed");
      expect(result.receipt).toContain('Sid said: "My gym locker code is 4417."');
    }
    expect(telegramSent.at(-1)).toContain("Your gym locker code is 4417.");
    expect(spokenOnCall).toContain("Your gym locker code is 4417.");
  });

  it("returns a named failure rather than an empty result when the query has nothing to search for", async () => {
    const who = await owner();

    const result = toolResult(await telegramTurn(
      who, "search for that", "I could not search that.", searchCall("history-empty", { query: "?!" }),
    ));

    expect(result.status).toBe("refused");
    expect(result.receipt).toContain("Nothing was searched.");
    expect(result.receipt).not.toContain("No indexed message matched.");
  });
});

describe("the history_search page text", () => {
  const empty: HistorySearchPage = Object.freeze({
    hits: [], offset: 0, moreResults: false, nextOffset: null,
    searchedThroughEventSequence: 40, missingRange: null, missingReason: null,
  });

  it("says the newest messages are unsearched only when the missing range is the unindexed tail", () => {
    const tail = composeHistorySearchPage("teal", 1, {
      ...empty, missingRange: { startEventSequence: 41, endEventSequence: 44 }, missingReason: "not_indexed_yet",
    });
    const refresh = composeHistorySearchPage("teal", 1, {
      ...empty, searchedThroughEventSequence: 44,
      missingRange: { startEventSequence: 12, endEventSequence: 12 }, missingReason: "being_reindexed",
    });

    expect(tail).toContain("Events #41 to #44 are not indexed yet");
    expect(tail).toContain("The newest messages, including this conversation, are always in that range");
    expect(refresh).toContain("Event #12 is waiting to be re-indexed by the hourly job");
    expect(refresh).not.toContain("The newest messages");
  });

  it("does not blame the speaker filter alone when a page with more results shows no message", () => {
    const text = composeHistorySearchPage("teal", 2, { ...empty, moreResults: true, nextOffset: 10 });

    expect(text).toContain("its matches were forgotten or were said by the other speaker");
    expect(text).toContain("More results: yes. Call history_search again with the same query and page 3.");
  });
});

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { classifyTelegramUpdate } from "../../src/channels/telegram/telegram-types.js";
import { TelegramRateLimiter } from "../../src/channels/telegram/telegram-rate-limit.js";
import {
  handleTelegramWebhook,
  type AcceptedTelegramButtonTap,
} from "../../src/channels/telegram/telegram-webhook.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import type { AnswerDecisionResult, DecisionItem } from "../../src/decisions/decision-types.js";
import { encodeDecisionCallbackData } from "../../src/decisions/telegram-keyboard.js";
import {
  answerFromTap,
  buildTelegramConversationRepository,
  confirmedTelegramForgetRoute,
  ownerAgentTurnTimeoutMs,
  ownerTelegramToolAuthority,
} from "../../src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken, RetrievedContext } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { MemoryOwnerControlsService } from "../../src/memory/memory-owner-controls.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
  ModelFunctionCall,
  TelegramProvider,
  TelegramSendMessageInput,
  TelegramSendMessageResult,
} from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-17T14:00:00.000Z");
let serial = 0;
let callbackSerial = 200_000;

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

class ReceiptModel implements ModelAdapter {
  readonly inputs: ModelAdapterStreamInput[] = [];

  constructor(private readonly receipt: string) {}

  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.inputs.push(input);
    yield Object.freeze({ index: 0, text: this.receipt });
  }
}

interface OwnerHarness {
  readonly principalId: string;
  readonly identityId: string;
  readonly providerSubject: string;
  readonly sessionId: string;
  readonly telegram: FakeTelegramProvider | NumericTelegramProvider;
}

class StructuredReceiptModel implements ModelAdapter {
  constructor(private readonly tokens: readonly Readonly<{
    text: string;
    toolOutcome?: "saved" | "not_saved";
  }>[]) {}

  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    for await (const token of this.streamOwnerTool(input)) {
      yield Object.freeze({ index: token.index, text: token.text });
    }
  }

  async *streamOwnerTool(_input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    for (const [index, token] of this.tokens.entries()) {
      yield Object.freeze({ index, ...token });
    }
  }
}

class NumericTelegramProvider implements TelegramProvider {
  readonly requests: TelegramSendMessageInput[] = [];

  async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
    this.requests.push(Object.freeze({ ...input }));
    return Object.freeze({ providerMessageId: String(1_000 + this.requests.length) });
  }
}

async function ownerHarness(label: string, telegram: FakeTelegramProvider | NumericTelegramProvider = new FakeTelegramProvider()): Promise<OwnerHarness> {
  serial += 1;
  const principalId = `principal:owner-agent:${label}:${serial}`;
  const identityId = `identity:owner-agent:${label}:${serial}`;
  const providerSubject = String(7_000_000 + serial);
  const now = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'Owner agent test', ?2, ?2)`).bind(principalId, now),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?1, ?2, 'telegram', ?3, 'active', ?4, ?4)`)
      .bind(identityId, principalId, providerSubject, now),
  ]);
  return Object.freeze({
    principalId,
    identityId,
    providerSubject,
    sessionId: `telegram:${providerSubject}`,
    telegram,
  });
}

async function runTurn(input: {
  readonly harness: OwnerHarness;
  readonly text: string;
  readonly provider: ModelAgentProvider;
  readonly directOwnerText?: boolean;
  readonly durableDirectOwnerText?: boolean;
  readonly directPipelineText?: boolean;
  readonly turnTimeoutMs?: number;
  readonly turnReceivedAt?: string;
  readonly now?: () => Date;
  readonly beforeModel?: () => void;
  readonly context?: readonly RetrievedContext[];
  readonly school?: ModelAdapter;
  readonly university?: ModelAdapter;
  readonly study?: ModelAdapter;
  readonly configuredOwnerPrincipalId?: string;
  readonly replyToBotMessageId?: number | null;
}): Promise<string> {
  const directOwnerText = input.directOwnerText ?? true;
  const durableDirectOwnerText = input.durableDirectOwnerText ?? directOwnerText;
  const events = new EventRepository(env.DB);
  const repository = buildTelegramConversationRepository(env.DB, events, {
    principalId: input.harness.principalId,
    isDirectText: durableDirectOwnerText,
    isMemoryControlAuthoritative: durableDirectOwnerText,
  }, input.harness.principalId);
  const fallback = new ReceiptModel("No saved action.");
  const model = new OwnerTelegramAgentAdapter({
    provider: input.provider,
    database: env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId: input.configuredOwnerPrincipalId ?? input.harness.principalId,
    directOwnerText,
    directPipelineText: input.directPipelineText,
    authorityText: input.text,
    replyToBotMessageId: input.replyToBotMessageId,
    targets: { async findControlTargets() { return Object.freeze([]); } },
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW }),
    schoolModel: input.school ?? fallback,
    universityModel: input.university ?? fallback,
    studyCoachModel: input.study ?? fallback,
    turnTimeoutMs: input.turnTimeoutMs,
    turnReceivedAt: input.turnReceivedAt,
    now: input.now,
  });
  const service = new DefaultConversationService({
    repository,
    model,
    context: { async retrieve() {
      input.beforeModel?.();
      return input.context ?? Object.freeze([]);
    } },
    dispatcher: new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", input.harness.telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => NOW,
    }),
    redactor: new Redactor(),
    now: () => NOW,
  });
  await expect(service.handleTurn({
    sessionId: input.harness.sessionId,
    principalId: input.harness.principalId,
    turnId: newUlid(),
    text: input.text,
    signal: new AbortController().signal,
    channel: "telegram",
    kind: "outbox",
    targetIdentityId: input.harness.identityId,
    replyToMessageId: serial,
  })).resolves.toMatchObject({ outcome: "telegram_delivered" });
  return input.harness.telegram.requests.at(-1)?.text ?? "";
}

async function memoryRows(principalId: string): Promise<readonly Readonly<{
  item_id: string;
  text: string;
  basis: string;
  lifecycle_state: string;
  excerpt: string;
}>[]> {
  const rows = await env.DB.prepare(`SELECT item.item_id, version.text, version.basis,
      state.lifecycle_state, source.excerpt
    FROM memory_items item
    JOIN memory_item_state state ON state.principal_id = item.principal_id AND state.item_id = item.item_id
    JOIN memory_item_versions version ON version.principal_id = state.principal_id
      AND version.version_id = state.current_version_id
    JOIN memory_item_sources source ON source.principal_id = version.principal_id
      AND source.version_id = version.version_id
    WHERE item.principal_id = ?1
    ORDER BY item.created_at, item.item_id`).bind(principalId).all<{
      item_id: string;
      text: string;
      basis: string;
      lifecycle_state: string;
      excerpt: string;
    }>();
  return rows.results;
}

function memoryContext(row: Awaited<ReturnType<typeof memoryRows>>[number]): RetrievedContext {
  return Object.freeze({
    sourceEventId: newUlid(),
    text: `Memory evidence [topic Preferences; item ${row.item_id}; active; stated]: ${row.text}`,
    sensitivity: "personal" as const,
  });
}

async function proposedMemory(harness: OwnerHarness): Promise<Ulid> {
  await runTurn({
    harness,
    text: "maybe I like art",
    provider: new FakeAgentProvider([stopped("Want me to note it?")]),
  });
  const source = await env.DB.prepare(`SELECT event_id, sequence, occurred_at FROM events
    WHERE subject_id = ?1 AND event_type = 'conversation.user_committed'
    ORDER BY sequence DESC LIMIT 1`).bind(harness.principalId).first<{
      event_id: string;
      sequence: number;
      occurred_at: string;
    }>();
  if (source === null) throw new Error("owner_agent_source_missing");
  const repository = new MemoryRepository(env.DB);
  const topics = await repository.bootstrapTopics(harness.principalId);
  const itemId = newUlid();
  await repository.commitInitialItem({
    principalId: harness.principalId,
    itemId,
    kind: "preference",
    creationEventId: source.event_id as Ulid,
    creationEventSequence: source.sequence,
    version: {
      versionId: newUlid(),
      text: "I like art",
      textHash: await sha256Hex("I like art"),
      basis: "inferred",
      origin: "model",
      uncertain: true,
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "owner-agent-test-v1",
      extractorModelId: "openai:owner-agent-test",
    },
    sources: [{
      sourceId: newUlid(),
      eventId: source.event_id as Ulid,
      eventSequence: source.sequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: "maybe I like art",
      excerptHash: await sha256Hex("maybe I like art"),
      channel: "telegram",
      occurredAt: source.occurred_at,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState: "proposed",
      reason: "test model inference",
      policyVersion: "owner-agent-test-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule",
      confidence: 0.4,
      reason: "test pending filing",
    },
  });
  return itemId;
}

async function acceptCallbackTap(
  harness: OwnerHarness,
  callbackData: string,
  suffix: string,
): Promise<AcceptedTelegramButtonTap> {
  const accepted: { value: AcceptedTelegramButtonTap | null } = { value: null };
  callbackSerial += 1;
  const response = await handleTelegramWebhook(new Request("https://jarvis.test/telegram", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "test-secret" },
    body: JSON.stringify({
      update_id: callbackSerial,
      callback_query: {
        id: `callback-${serial}-${suffix}`,
        from: { id: Number(harness.providerSubject) },
        message: { message_id: serial, chat: { id: Number(harness.providerSubject) } },
        data: callbackData,
      },
    }),
  }), {
    webhookSecret: "test-secret",
    policy: {
      async authenticateTelegram() {
        return Object.freeze({ principalId: harness.principalId, identityState: "active" as const });
      },
    },
    redactor: new Redactor(),
    events: new EventRepository(env.DB),
    limiter: new TelegramRateLimiter(),
    now: () => new Date(NOW.getTime() + Number(suffix) * 1_000),
    onCallback: (tap) => { accepted.value = tap; },
  });
  expect(response.status).toBe(200);
  if (accepted.value === null) throw new Error("owner_agent_callback_not_accepted");
  return accepted.value;
}

async function prepareConfirmedForget(label: string): Promise<Readonly<{
  harness: OwnerHarness;
  ids: readonly string[];
  decisionId: string;
  tap: AcceptedTelegramButtonTap;
  decisions: DecisionService;
}>> {
  const harness = await ownerHarness(label);
  for (const [index, fact] of ["I like analysis", "I like mechanics"].entries()) {
    await runTurn({
      harness,
      text: `remember ${fact}`,
      provider: new FakeAgentProvider([
        called(tool(`${label}-seed-${index}`, "memory_remember", {
          fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null,
          kind: "preference", sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: [`receipt:${label}-seed-${index}`] }]),
      ]),
    });
  }
  const rows = await memoryRows(harness.principalId);
  const ids = rows.map((row) => row.item_id);
  await runTurn({
    harness,
    text: "forget both subjects",
    context: rows.map(memoryContext),
    provider: new FakeAgentProvider([
      called(tool(`${label}-many`, "memory_forget", { itemIds: ids })),
      stopped("Use the button."),
    ]),
  });
  const callbackData = harness.telegram.requests.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
  if (callbackData === undefined) throw new Error("owner_agent_callback_missing");
  const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW });
  const decision = (await decisions.queue(harness.principalId))[0];
  if (decision === undefined) throw new Error("owner_agent_decision_missing");
  const tap = await acceptCallbackTap(harness, callbackData, "4");
  return Object.freeze({ harness, ids, decisionId: decision.decisionId, tap, decisions });
}

function overrideConfirmedForgetDecisionRead(
  database: D1Database,
  overrides: Readonly<Record<string, unknown>>,
): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
      if (property === "first") return async <T>() => {
        const row = await target.first<Record<string, unknown>>();
        return row === null ? null : { ...row, ...overrides } as T;
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => sql.includes("SELECT item.decision_id")
        ? wrap(target.prepare(sql))
        : target.prepare(sql);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

beforeAll(applyMemoryIngressMigration);

describe("owner Telegram agent", () => {
  it.each([
    ["memory authority", { isDirectText: true, isPrivateHumanText: true, isMemoryControlAuthoritative: false }, { directOwnerText: false, directPipelineText: true }],
    ["private-text authority", { isDirectText: true, isPrivateHumanText: false, isMemoryControlAuthoritative: true }, { directOwnerText: true, directPipelineText: false }],
    ["direct-text authority", { isDirectText: false, isPrivateHumanText: true, isMemoryControlAuthoritative: true }, { directOwnerText: true, directPipelineText: false }],
  ] as const)("preserves production index authority wiring for %s (R05/R06)", (_label, accepted, expected) => {
    expect(ownerTelegramToolAuthority(accepted)).toEqual(expected);
  });

  it("anchors the agent budget to webhook arrival and reserves post-agent time", () => {
    expect(ownerAgentTurnTimeoutMs("2026-09-17T14:00:00.000Z", new Date("2026-09-17T14:00:03.250Z")))
      .toBe(16_750);
    expect(ownerAgentTurnTimeoutMs("2026-09-17T14:00:00.000Z", new Date("2026-09-17T14:00:30.000Z")))
      .toBe(1);
  });

  it("recomputes the arrival-anchored budget when the agent stream starts", async () => {
    const harness = await ownerHarness("late-bound-budget");
    const arrival = "2026-09-17T14:00:00.000Z";
    let now = new Date(arrival);
    const clock = vi.fn(() => now);
    const provider = new FakeAgentProvider([stopped("Still inside the deadline.")]);

    await runTurn({
      harness,
      text: "budget check",
      provider,
      turnReceivedAt: arrival,
      now: clock,
      beforeModel: () => { now = new Date("2026-09-17T14:00:03.300Z"); },
    });

    expect(clock).toHaveBeenCalledOnce();
    expect(provider.requests[0]?.timeoutMs).toBe(16_700);
  });

  it("answers an ordinary turn with exactly one model call", async () => {
    const harness = await ownerHarness("ordinary");
    const provider = new FakeAgentProvider([stopped("Hey Sid.")]);

    await expect(runTurn({ harness, text: "yo", provider })).resolves.toBe("Hey Sid.");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.toolChoice).toBe("auto");
  });

  it.each([
    ["external action", "I emailed Ms. Lee about your extension.", "I emailed"],
    ["passive completion", "Your application has been submitted for you.", "has been submitted"],
    ["Brightspace check", "I checked Brightspace just now.", "I checked Brightspace"],
    ["secret request", "Send me your password here.", "Send me your password"],
  ] as const)("applies the deterministic %s guard to unlisted ordinary-agent claims", async (_label, claim, unsafe) => {
    const harness = await ownerHarness(`guard-${_label.replaceAll(" ", "-")}`);
    const provider = new FakeAgentProvider([stopped(claim)]);

    const reply = await runTurn({ harness, text: "help", provider });

    expect(reply).not.toContain(unsafe);
    expect(provider.requests).toHaveLength(1);
  });

  it("stores Sid's misspelled remember request as stated evidence with the exact excerpt", async () => {
    const harness = await ownerHarness("misspelled-remember");
    const provider = new FakeAgentProvider([
      called(tool("remember-1", "memory_remember", {
        fact: "Sid's favourite subject is math",
        supportingExcerpt: "my fav subject is math",
        evidenceClass: "stated",
        previousOfferExcerpt: null,
        kind: "preference",
        sensitivity: "normal",
      })),
      stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:remember-1"] }]),
    ]);

    const reply = await runTurn({ harness, text: "Remeber that my fav subject is math", provider });

    expect(reply).toContain("Remembered 1 memory.");
    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([{
      text: "Sid's favourite subject is math",
      basis: "stated",
      lifecycle_state: "active",
      excerpt: "my fav subject is math",
    }]);
    expect(provider.requests).toHaveLength(2);
  });

  it.each([
    ["negation mismatch", "remember I don't like math", "Sid likes math", "like math"],
    ["one-word unrelated evidence", "ok", "Sid's locker combination is 12-34-56", "ok"],
  ] as const)("stores failed grounding as uncertain model inference with Sid's exact excerpt: %s", async (
    label, text, fact, excerpt,
  ) => {
    const harness = await ownerHarness(`uncertain-${label.replaceAll(" ", "-")}`);
    const provider = new FakeAgentProvider([
      called(tool(`uncertain-${label}`, "memory_remember", {
        fact, supportingExcerpt: excerpt, evidenceClass: "stated", previousOfferExcerpt: null,
        kind: "fact", sensitivity: "normal",
      })),
      stopped("Noted.", [{ sentence: "Noted.", receiptIds: [`receipt:uncertain-${label}`] }]),
    ]);

    const reply = await runTurn({ harness, text, provider });

    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([{
      text: fact,
      basis: "inferred",
      lifecycle_state: "proposed",
      excerpt,
    }]);
    expect(reply).toContain(JSON.stringify(excerpt));
    expect(reply).not.toContain(`Memory: ${JSON.stringify(fact)}`);
  });

  it.each([
    ["typo", "remmber my go-to snack is mango", "my go-to snack is mango"],
    ["slang", "yo keep this in ur head: blue folder has receipts", "blue folder has receipts"],
  ] as const)("grounds a %s memory tool call in Sid's exact current words", async (label, message, excerpt) => {
    const harness = await ownerHarness(`grounded-${label}`);
    const provider = new FakeAgentProvider([
      called(tool(`grounded-${label}`, "memory_remember", {
        fact: excerpt,
        supportingExcerpt: excerpt,
        evidenceClass: "stated",
        previousOfferExcerpt: null,
        kind: "fact",
        sensitivity: "normal",
      })),
      stopped("Done.", [{ sentence: "Done.", receiptIds: [`receipt:grounded-${label}`] }]),
    ]);

    await runTurn({ harness, text: message, provider });

    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([{
      text: excerpt,
      basis: "stated",
      excerpt,
    }]);
  });

  it("treats Math as a confirmed answer to Jarvis's immediately previous offer and does not call school", async () => {
    const harness = await ownerHarness("confirmed-answer");
    await runTurn({
      harness,
      text: "i did best in something today",
      provider: new FakeAgentProvider([stopped("Want me to note it?")]),
    });
    const school = new ReceiptModel("School updated 1 course.");
    const provider = new FakeAgentProvider([
      called(tool("remember-2", "memory_remember", {
        fact: "Sid's favourite subject is math",
        supportingExcerpt: "Math",
        evidenceClass: "confirmed",
        previousOfferExcerpt: "Want me to note it?",
        kind: "preference",
        sensitivity: "normal",
      })),
      stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:remember-2"] }]),
    ]);

    await runTurn({ harness, text: "Math", provider, school });

    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([{
      text: "Sid's favourite subject is math",
      basis: "confirmed",
      lifecycle_state: "active",
      excerpt: "Math",
    }]);
    expect(school.inputs).toHaveLength(0);
  });

  it("requires a complete question sentence from the immediately previous delivered reply for confirmed evidence", async () => {
    const harness = await ownerHarness("confirmed-question");
    await runTurn({ harness, text: "hey", provider: new FakeAgentProvider([stopped("Hey Sid, what's up?")]) });
    const provider = new FakeAgentProvider([
      called(tool("bad-confirmed", "memory_remember", {
        fact: "Sid's favourite subject is math",
        supportingExcerpt: "Math",
        evidenceClass: "confirmed",
        previousOfferExcerpt: "e",
        kind: "preference",
        sensitivity: "normal",
      })),
      stopped("Nothing changed."),
    ]);

    await runTurn({ harness, text: "Math", provider });

    await expect(memoryRows(harness.principalId)).resolves.toEqual([]);
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
  });

  it.each([
    ["question ending (R13)", "Want me to note it.", "Want me to note it."],
    ["sentence boundary (R14)", "Prefix Want me to note it? suffix", "Want me to note it?"],
    ["question uniqueness (R15)", "Want me to note it? Want me to note it?", "Want me to note it?"],
  ] as const)("rejects confirmed evidence when the previous offer violates %s", async (_label, previous, excerpt) => {
    const harness = await ownerHarness(`confirmed-shape-${serial}`);
    await runTurn({ harness, text: "hello", provider: new FakeAgentProvider([stopped(previous)]) });
    const provider = new FakeAgentProvider([
      called(tool(`confirmed-shape-${serial}`, "memory_remember", {
        fact: "Sid's favourite subject is math", supportingExcerpt: "Math", evidenceClass: "confirmed",
        previousOfferExcerpt: excerpt, kind: "preference", sensitivity: "normal",
      })),
      stopped("Nothing changed."),
    ]);

    await runTurn({ harness, text: "Math", provider });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(memoryRows(harness.principalId)).resolves.toEqual([]);
  });

  it("requires stated evidence to omit previousOfferExcerpt (R41)", async () => {
    const harness = await ownerHarness("stated-no-offer");
    const provider = new FakeAgentProvider([
      called(tool("stated-no-offer", "memory_remember", {
        fact: "I like math", supportingExcerpt: "I like math", evidenceClass: "stated",
        previousOfferExcerpt: "Want me to note it?", kind: "preference", sensitivity: "normal",
      })),
      stopped("Nothing changed."),
    ]);

    await runTurn({ harness, text: "remember I like math", provider });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(memoryRows(harness.principalId)).resolves.toEqual([]);
  });

  it.each([
    [1_001, true],
    [999, false],
  ] as const)("accepts a swipe confirmation only for the latest delivered Jarvis message: %s", async (
    replyToBotMessageId, accepted,
  ) => {
    const harness = await ownerHarness(`swipe-target-${replyToBotMessageId}`, new NumericTelegramProvider());
    await runTurn({ harness, text: "hello", provider: new FakeAgentProvider([stopped("Want me to note it?")]) });
    const provider = new FakeAgentProvider([
      called(tool(`swipe-target-${replyToBotMessageId}`, "memory_remember", {
        fact: "Sid's favourite subject is math", supportingExcerpt: "Math", evidenceClass: "confirmed",
        previousOfferExcerpt: "Want me to note it?", kind: "preference", sensitivity: "normal",
      })),
      stopped(accepted ? "Saved." : "Nothing changed.", accepted
        ? [{ sentence: "Saved.", receiptIds: [`receipt:swipe-target-${replyToBotMessageId}`] }]
        : []),
    ]);

    await runTurn({ harness, text: "Math", provider, replyToBotMessageId });

    expect(await memoryRows(harness.principalId)).toHaveLength(accepted ? 1 : 0);
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: accepted ? "completed" : "refused",
    });
  });

  it.each([
    ["school_update", "school"],
    ["university_update", "university"],
    ["study_coach", "study"],
  ] as const)("hands %s to its validated pipeline after the agent chooses it", async (toolName, selected) => {
    const harness = await ownerHarness(selected);
    const school = new ReceiptModel("Updated 1 school record.");
    const university = new ReceiptModel("Updated 1 university record.");
    const study = new ReceiptModel("Saved 1 study check-in.");
    const provider = new FakeAgentProvider([
      called(tool(`${selected}-1`, toolName, {})),
      stopped("Done.", [{ sentence: "Done.", receiptIds: [`receipt:${selected}-1`] }]),
    ]);

    const reply = await runTurn({
      harness,
      text: `owner message for ${selected}`,
      provider,
      school,
      university,
      study,
    });

    expect(reply).toContain(selected === "school" ? "Updated 1 school record."
      : selected === "university" ? "Updated 1 university record."
        : "Saved 1 study check-in.");
    expect({ school: school.inputs.length, university: university.inputs.length, study: study.inputs.length })
      .toEqual({ school: selected === "school" ? 1 : 0, university: selected === "university" ? 1 : 0, study: selected === "study" ? 1 : 0 });
  });

  it("keeps pipeline authority separate from the narrow memory authority", async () => {
    const harness = await ownerHarness("pipeline-authority");
    const school = new ReceiptModel("Saved your school plan update.");
    const provider = new FakeAgentProvider([
      called(tool("pipeline-authority", "school_update", {})),
      stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:pipeline-authority"] }]),
    ]);

    await runTurn({
      harness,
      text: "math test moved to friday\nenglish essay due monday",
      provider,
      school,
      directOwnerText: false,
      directPipelineText: true,
    });

    expect(school.inputs).toHaveLength(1);
  });

  it("refuses a pipeline tool when the direct private-text recheck is false", async () => {
    const harness = await ownerHarness("pipeline-not-direct");
    const school = new ReceiptModel("Saved your school plan update.");
    const provider = new FakeAgentProvider([
      called(tool("pipeline-not-direct", "school_update", {})),
      stopped("Nothing changed."),
    ]);

    await runTurn({ harness, text: "essay due monday", provider, school, directPipelineText: false });

    expect(school.inputs).toHaveLength(0);
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
  });

  it("does not issue a receipt id when a selected pipeline saves nothing", async () => {
    const harness = await ownerHarness("pipeline-not-saved");
    const school = new ReceiptModel("I couldn't validate that as a school update, so I didn't save it.");
    const provider = new FakeAgentProvider([
      called(tool("pipeline-not-saved", "school_update", {})),
      stopped("I've added the essay.", [{
        sentence: "I've added the essay.", receiptIds: ["receipt:pipeline-not-saved"],
      }]),
    ]);

    const reply = await runTurn({ harness, text: "essay due maybe", provider, school });

    expect(reply).not.toContain("I've added the essay");
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "not_saved",
      receiptId: null,
    });
  });

  it("rejects conflicting structured pipeline outcomes (R18)", async () => {
    const harness = await ownerHarness("conflicting-outcomes");
    const school = new StructuredReceiptModel([
      { text: "Saved the plan.", toolOutcome: "saved" },
      { text: " Nothing changed.", toolOutcome: "not_saved" },
    ]);
    const provider = new FakeAgentProvider([
      called(tool("conflicting-outcomes", "school_update", {})),
      stopped("Nothing changed."),
    ]);

    const reply = await runTurn({ harness, text: "plan school", provider, school });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receiptId: null,
    });
    expect(reply).not.toContain("Done");
  });

  it("treats an unsignalled structured school reply as not saved (R40)", async () => {
    const harness = await ownerHarness("unsignalled-school");
    const school = new StructuredReceiptModel([{ text: "Updated deadlines usually arrive within a day." }]);
    const claim = "I've added the essay to your school tracker.";
    const provider = new FakeAgentProvider([
      called(tool("unsignalled-school", "school_update", {})),
      stopped(claim, [{ sentence: claim, receiptIds: ["receipt:unsignalled-school"] }]),
    ]);

    const reply = await runTurn({ harness, text: "essay due monday maybe", provider, school });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "not_saved",
      receiptId: null,
    });
    expect(reply).not.toContain(claim);
  });

  it("refuses a memory tool when directOwnerText is false (R01)", async () => {
    const harness = await ownerHarness("not-direct");
    const provider = new FakeAgentProvider([
      called(tool("remember-refused", "memory_remember", {
        fact: "my code is 12",
        supportingExcerpt: "my code is 12",
        evidenceClass: "stated",
        previousOfferExcerpt: null,
        kind: "fact",
        sensitivity: "sensitive",
      })),
      stopped("I left it unchanged."),
    ]);

    await runTurn({ harness, text: "remember my code is 12", provider, directOwnerText: false });

    await expect(memoryRows(harness.principalId)).resolves.toEqual([]);
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: "I refused that memory tool call because this is not Sid's direct current Telegram text. Nothing changed.",
    });
  });

  it.each([
    ["memory", "memory_remember", {
      fact: "I like calculus", supportingExcerpt: "I like calculus", evidenceClass: "stated",
      previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
    }],
    ["pipeline", "school_update", {}],
  ] as const)("rechecks the durable current owner turn before a %s tool executes", async (label, name, args) => {
    const harness = await ownerHarness(`durable-${label}`);
    const school = new ReceiptModel("Saved your school plan update.");
    const requests: ModelAgentCompletionInput[] = [];
    const provider: ModelAgentProvider = {
      async completeAgent(input) {
        requests.push(input);
        if (requests.length === 1) {
          if (label === "pipeline") {
            await env.DB.prepare(`UPDATE events SET envelope_json = replace(
                envelope_json, '"text":"essay due monday"', '"text":"tampered"'
              ) WHERE event_id = (
                SELECT user_event_id FROM conversation_turns WHERE turn_id = ?1
              )`).bind(input.correlationId).run();
          }
          return called(tool(`durable-${label}`, name, args));
        }
        return stopped("Nothing changed.");
      },
    };

    await runTurn({
      harness,
      text: label === "memory" ? "remember I like calculus" : "essay due monday",
      provider,
      school,
      durableDirectOwnerText: label !== "memory",
      directPipelineText: true,
    });

    expect(JSON.parse(requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    expect(school.inputs).toHaveLength(0);
    await expect(memoryRows(harness.principalId)).resolves.toEqual([]);
  });

  it("refuses a tool when the current Telegram principal is a guest", async () => {
    const harness = await ownerHarness("guest");
    const provider = new FakeAgentProvider([
      called(tool("guest-refused", "memory_remember", {
        fact: "I like calculus",
        supportingExcerpt: "I like calculus",
        evidenceClass: "stated",
        previousOfferExcerpt: null,
        kind: "preference",
        sensitivity: "normal",
      })),
      stopped("I changed nothing."),
    ]);

    await runTurn({
      harness,
      text: "remember I like calculus",
      provider,
      configuredOwnerPrincipalId: "principal:actual-owner",
    });

    await expect(memoryRows(harness.principalId)).resolves.toEqual([]);
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
  });

  it("confirms a proposed model inference only after Jarvis quoted the stored fact", async () => {
    const harness = await ownerHarness("confirm");
    const itemId = await proposedMemory(harness);
    await runTurn({
      harness,
      text: "what uncertain memory do you have?",
      provider: new FakeAgentProvider([stopped('I have an uncertain memory: "I like art". Is that correct?')]),
    });
    const provider = new FakeAgentProvider([
      called(tool("confirm-1", "memory_confirm", { itemId, supportingExcerpt: "yes, that's right" })),
      stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:confirm-1"] }]),
    ]);

    const reply = await runTurn({
      harness,
      text: "yes, that's right",
      provider,
      context: [memoryContext({
        item_id: itemId,
        text: "I like art",
        basis: "inferred",
        lifecycle_state: "proposed",
        excerpt: "maybe I like art",
      })],
    });

    expect(reply).toContain("Confirmed 1 proposed memory");
    await expect(new MemoryRepository(env.DB).readCurrentItem(harness.principalId, itemId))
      .resolves.toMatchObject({
        lifecycle: { state: "active" },
        version: { basis: "confirmed", uncertain: false },
        sources: expect.arrayContaining([expect.objectContaining({ excerpt: "yes, that's right" })]),
      });
  });

  it.each([
    ["a bare acknowledgement", "ok", "ok"],
    ["a substring without word boundaries", "yesterday was fine", "yes"],
  ] as const)("does not confirm a quoted proposal from %s", async (_label, text, excerpt) => {
    const harness = await ownerHarness(`confirm-negative-${excerpt}`);
    const itemId = await proposedMemory(harness);
    await runTurn({
      harness,
      text: "what uncertain memory do you have?",
      provider: new FakeAgentProvider([stopped('I have an uncertain memory: "I like art". Is that correct?')]),
    });
    const provider = new FakeAgentProvider([
      called(tool(`confirm-negative-${excerpt}`, "memory_confirm", {
        itemId,
        supportingExcerpt: excerpt,
      })),
      stopped("Nothing changed."),
    ]);

    await runTurn({
      harness,
      text,
      provider,
      context: [memoryContext({
        item_id: itemId,
        text: "I like art",
        basis: "inferred",
        lifecycle_state: "proposed",
        excerpt: "maybe I like art",
      })],
    });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(new MemoryRepository(env.DB).readCurrentItem(harness.principalId, itemId))
      .resolves.toMatchObject({ lifecycle: { state: "proposed" } });
  });

  it("does not let retrieved context alone make a model inference confirmable", async () => {
    const harness = await ownerHarness("confirm-context-only");
    const itemId = await proposedMemory(harness);
    const provider = new FakeAgentProvider([
      called(tool("confirm-context-only", "memory_confirm", {
        itemId,
        supportingExcerpt: "confirm I like art",
      })),
      stopped("Nothing changed."),
    ]);

    await runTurn({
      harness,
      text: "confirm I like art",
      provider,
      context: [memoryContext({
        item_id: itemId,
        text: "I like art",
        basis: "inferred",
        lifecycle_state: "proposed",
        excerpt: "maybe I like art",
      })],
    });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(new MemoryRepository(env.DB).readCurrentItem(harness.principalId, itemId))
      .resolves.toMatchObject({ lifecycle: { state: "proposed" } });
  });

  it("requires control intent before forget, restore, or explain reaches owner controls", async () => {
    const harness = await ownerHarness("control-intent");
    await runTurn({
      harness,
      text: "remember I like calculus",
      provider: new FakeAgentProvider([
        called(tool("control-intent-seed", "memory_remember", {
          fact: "I like calculus", supportingExcerpt: "I like calculus", evidenceClass: "stated",
          previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:control-intent-seed"] }]),
      ]),
    });
    const row = (await memoryRows(harness.principalId))[0]!;
    const forget = vi.spyOn(MemoryOwnerControlsService.prototype, "forget");
    const lift = vi.spyOn(MemoryOwnerControlsService.prototype, "lift");
    const explain = vi.spyOn(MemoryOwnerControlsService.prototype, "explain");
    try {
      for (const call of [
        tool("control-intent-forget", "memory_forget", { itemIds: [row.item_id], supportingExcerpt: "hi" }),
        tool("control-intent-restore", "memory_restore", { itemId: row.item_id, supportingExcerpt: "hi" }),
        tool("control-intent-explain", "memory_explain", { itemId: row.item_id, supportingExcerpt: "hi" }),
      ]) {
        await runTurn({
          harness,
          text: "hi",
          context: [memoryContext(row)],
          provider: new FakeAgentProvider([called(call), stopped("Hi Sid.")]),
        });
      }
      expect(forget).not.toHaveBeenCalled();
      expect(lift).not.toHaveBeenCalled();
      expect(explain).not.toHaveBeenCalled();
    } finally {
      forget.mockRestore();
      lift.mockRestore();
      explain.mockRestore();
    }
  });

  it("refuses agent-level memory confirmation when its excerpt is absent from Sid's current text", async () => {
    const harness = await ownerHarness("confirm-ungrounded");
    const itemId = await proposedMemory(harness);
    const confirm = vi.spyOn(MemoryOwnerControlsService.prototype, "confirm");
    const provider = new FakeAgentProvider([
      called(tool("confirm-ungrounded", "memory_confirm", { itemId, supportingExcerpt: "yes" })),
      stopped("Nothing changed."),
    ]);

    await runTurn({
      harness,
      text: "no",
      provider,
      context: [memoryContext({
        item_id: itemId,
        text: "I like art",
        basis: "inferred",
        lifecycle_state: "proposed",
        excerpt: "maybe I like art",
      })],
    });

    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(new MemoryRepository(env.DB).readCurrentItem(harness.principalId, itemId))
      .resolves.toMatchObject({ lifecycle: { state: "proposed" } });
  });

  it("forgets, restores and explains one eligible owner memory through receipts", async () => {
    const harness = await ownerHarness("memory-cycle");
    await runTurn({
      harness,
      text: "remember I like calculus",
      provider: new FakeAgentProvider([
        called(tool("cycle-seed", "memory_remember", {
          fact: "I like calculus",
          supportingExcerpt: "I like calculus",
          evidenceClass: "stated",
          previousOfferExcerpt: null,
          kind: "preference",
          sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:cycle-seed"] }]),
      ]),
    });
    const row = (await memoryRows(harness.principalId))[0]!;
    const context = [memoryContext(row)];

    const forgot = await runTurn({
      harness,
      text: "forget that",
      context,
      provider: new FakeAgentProvider([
        called(tool("cycle-forget", "memory_forget", {
          itemIds: [row.item_id], supportingExcerpt: "forget that",
        })),
        stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:cycle-forget"] }]),
      ]),
    });
    expect(forgot).toContain("Forgot 1 memory");
    const restored = await runTurn({
      harness,
      text: "use it again",
      context,
      provider: new FakeAgentProvider([
        called(tool("cycle-restore", "memory_restore", {
          itemId: row.item_id, supportingExcerpt: "use it again",
        })),
        stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:cycle-restore"] }]),
      ]),
    });
    expect(restored).toContain("Restored 1 memory");
    const explained = await runTurn({
      harness,
      text: "why do you remember that?",
      context,
      provider: new FakeAgentProvider([
        called(tool("cycle-explain", "memory_explain", {
          itemId: row.item_id, supportingExcerpt: "why do you remember that?",
        })),
        stopped("There is the evidence.", [{ sentence: "There is the evidence.", receiptIds: ["receipt:cycle-explain"] }]),
      ]),
    });
    expect(explained).toContain("Evidence for 1 memory");
  });

  it("requires Sid's current words to ground a single forget, restore, or explain", async () => {
    const harness = await ownerHarness("single-grounding");
    await runTurn({
      harness,
      text: "remember I like calculus",
      provider: new FakeAgentProvider([
        called(tool("grounding-seed", "memory_remember", {
          fact: "I like calculus", supportingExcerpt: "I like calculus", evidenceClass: "stated",
          previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:grounding-seed"] }]),
      ]),
    });
    const row = (await memoryRows(harness.principalId))[0]!;
    for (const [name, args] of [
      ["memory_forget", { itemIds: [row.item_id] }],
      ["memory_restore", { itemId: row.item_id }],
      ["memory_explain", { itemId: row.item_id }],
    ] as const) {
      const provider = new FakeAgentProvider([
        called(tool(`ungrounded-${name}`, name, args)),
        stopped("Nothing changed."),
      ]);
      await runTurn({ harness, text: "hi", provider, context: [memoryContext(row)] });
      expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    }
    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([{ lifecycle_state: "active" }]);
  });

  it("requires a word-bounded control excerpt for a single forget (R09)", async () => {
    const harness = await ownerHarness("forget-word-boundary");
    await runTurn({
      harness,
      text: "remember I like calculus",
      provider: new FakeAgentProvider([
        called(tool("forget-word-boundary-seed", "memory_remember", {
          fact: "I like calculus", supportingExcerpt: "I like calculus", evidenceClass: "stated",
          previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:forget-word-boundary-seed"] }]),
      ]),
    });
    const row = (await memoryRows(harness.principalId))[0]!;
    const provider = new FakeAgentProvider([
      called(tool("forget-word-boundary", "memory_forget", {
        itemIds: [row.item_id], supportingExcerpt: "forget",
      })),
      stopped("Nothing changed."),
    ]);

    await runTurn({ harness, text: "forgetting calculus", provider, context: [memoryContext(row)] });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([{ lifecycle_state: "active" }]);
  });

  it("requires current owner grounding before restoring one memory (R11)", async () => {
    const harness = await ownerHarness("restore-grounding");
    await runTurn({
      harness,
      text: "remember I like calculus",
      provider: new FakeAgentProvider([
        called(tool("restore-grounding-seed", "memory_remember", {
          fact: "I like calculus", supportingExcerpt: "I like calculus", evidenceClass: "stated",
          previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:restore-grounding-seed"] }]),
      ]),
    });
    const active = (await memoryRows(harness.principalId))[0]!;
    await runTurn({
      harness,
      text: "forget calculus",
      context: [memoryContext(active)],
      provider: new FakeAgentProvider([
        called(tool("restore-grounding-forget", "memory_forget", {
          itemIds: [active.item_id], supportingExcerpt: "forget calculus",
        })),
        stopped("Forgot.", [{ sentence: "Forgot.", receiptIds: ["receipt:restore-grounding-forget"] }]),
      ]),
    });
    const forgotten = (await memoryRows(harness.principalId))[0]!;
    const provider = new FakeAgentProvider([
      called(tool("restore-grounding", "memory_restore", {
        itemId: forgotten.item_id, supportingExcerpt: "restore",
      })),
      stopped("Nothing changed."),
    ]);

    await runTurn({ harness, text: "hello", provider, context: [memoryContext(forgotten)] });

    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([{ lifecycle_state: "forgotten" }]);
  });

  it("does not let a forgotten normalized memory block a fresh active remember (R30)", async () => {
    const harness = await ownerHarness("forgotten-dedupe-filter");
    await runTurn({
      harness,
      text: "remember Sid likes chemistry",
      provider: new FakeAgentProvider([
        called(tool("forgotten-dedupe-seed", "memory_remember", {
          fact: "Sid likes chemistry", supportingExcerpt: "Sid likes chemistry", evidenceClass: "stated",
          previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:forgotten-dedupe-seed"] }]),
      ]),
    });
    const active = (await memoryRows(harness.principalId))[0]!;
    await runTurn({
      harness,
      text: "forget chemistry",
      context: [memoryContext(active)],
      provider: new FakeAgentProvider([
        called(tool("forgotten-dedupe-forget", "memory_forget", {
          itemIds: [active.item_id], supportingExcerpt: "forget chemistry",
        })),
        stopped("Forgot.", [{ sentence: "Forgot.", receiptIds: ["receipt:forgotten-dedupe-forget"] }]),
      ]),
    });

    await runTurn({
      harness,
      text: "remember SID LIKES CHEMISTRY!",
      provider: new FakeAgentProvider([
        called(tool("forgotten-dedupe-new", "memory_remember", {
          fact: "SID LIKES CHEMISTRY!", supportingExcerpt: "SID LIKES CHEMISTRY!", evidenceClass: "stated",
          previousOfferExcerpt: null, kind: "fact", sensitivity: "sensitive",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:forgotten-dedupe-new"] }]),
      ]),
    });

    const rows = await memoryRows(harness.principalId);
    expect(new Set(rows.map((row) => row.item_id)).size).toBe(2);
    expect(rows.map((row) => row.lifecycle_state).sort()).toEqual(["active", "forgotten"]);
  });

  it("delivers the saved receipt when the follow-up fails and a resend does not duplicate the memory", async () => {
    const harness = await ownerHarness("post-commit-fallback");
    const args = {
      fact: "I like chemistry", supportingExcerpt: "I like chemistry", evidenceClass: "stated",
      previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
    } as const;

    const first = await runTurn({
      harness,
      text: "remember I like chemistry",
      provider: new FakeAgentProvider([
        called(tool("post-commit-first", "memory_remember", args)),
        new Error("deepseek timeout"),
      ]),
    });
    const second = await runTurn({
      harness,
      text: "remember I like chemistry",
      provider: new FakeAgentProvider([
        called(tool("post-commit-second", "memory_remember", {
          ...args,
          fact: "I LIKE chemistry.",
          kind: "fact",
          sensitivity: "sensitive",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:post-commit-second"] }]),
      ]),
    });

    expect(first).toContain("Remembered 1 memory");
    expect(first).toContain("couldn't write a longer reply");
    expect(second).toContain("did not add a duplicate");
    const rows = await memoryRows(harness.principalId);
    expect(new Set(rows.map((row) => row.item_id)).size).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it("falls back to the saved receipt when an honesty-repair call fails", async () => {
    const harness = await ownerHarness("repair-fallback");
    const claim = "I emailed your teacher.";
    const reply = await runTurn({
      harness,
      text: "remember I like chemistry",
      provider: new FakeAgentProvider([
        called(tool("repair-fallback", "memory_remember", {
          fact: "I like chemistry", supportingExcerpt: "I like chemistry", evidenceClass: "stated",
          previousOfferExcerpt: null, kind: "preference", sensitivity: "normal",
        })),
        stopped(claim, [{ sentence: claim, receiptIds: [] }]),
        new Error("repair unavailable"),
      ]),
    });

    expect(reply).toContain("Remembered 1 memory");
    expect(reply).toContain("couldn't write a longer reply");
    expect(reply).not.toContain("emailed your teacher");
  });

  it("runs a parameterless pipeline with empty-string arguments and truncates its saved receipt", async () => {
    const harness = await ownerHarness("pipeline-shapes");
    const school = new ReceiptModel(`Saved your school plan. ${"Math practice; ".repeat(400)}`);
    const provider = new FakeAgentProvider([
      called(tool("pipeline-shapes", "school_update", "")),
      stopped(""),
    ]);

    const reply = await runTurn({ harness, text: "plan my week", provider, school });

    expect(school.inputs).toHaveLength(1);
    expect(reply).toContain("Saved your school plan");
    expect(reply).not.toContain("nothing changed");
    expect(reply.length).toBeLessThanOrEqual(4_096);
  });

  it("keeps the follow-up suffix inside the Telegram UTF-16 bound (R42)", async () => {
    const harness = await ownerHarness("pipeline-suffix-bound");
    const school = new ReceiptModel(`Saved your school plan. ${"📚 plan; ".repeat(800)}`);
    const provider = new FakeAgentProvider([
      called(tool("pipeline-suffix-bound", "school_update", {})),
      stopped("Short follow-up."),
    ]);

    const reply = await runTurn({ harness, text: "plan my week", provider, school });

    expect(reply.length).toBeLessThanOrEqual(4_096);
    expect(reply.endsWith("Short follow-up.")).toBe(true);
  });

  it("truncates a Telegram reply without leaving a lone UTF-16 surrogate", async () => {
    const harness = await ownerHarness("surrogate-bound");
    const reply = `${"a".repeat(4_095)}${"\u{1f4da}".repeat(10)}`;

    const delivered = await runTurn({
      harness,
      text: "long reply",
      provider: new FakeAgentProvider([stopped(reply)]),
    });

    const last = delivered.charCodeAt(delivered.length - 1);
    expect(delivered.length).toBeLessThanOrEqual(4_096);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(delivered).not.toContain("�");
  });

  it("applies the deterministic action guard after a completed tool (R26)", async () => {
    const harness = await ownerHarness("tool-path-guard");
    const school = new ReceiptModel("Saved your school plan update.");
    const falseClaim = "I emailed Ms. Lee about the plan.";

    const reply = await runTurn({
      harness,
      text: "plan my week",
      school,
      provider: new FakeAgentProvider([
        called(tool("tool-path-guard", "school_update", {})),
        stopped(falseClaim),
      ]),
    });

    expect(reply).toContain("Saved your school plan update.");
    expect(reply).not.toContain(falseClaim);
    expect(reply).not.toContain("Lee about the plan");
    expect(reply).toContain("can't confirm that action");
  });

  it("uses the post-execute deadline branch before a second provider call starts (R21)", async () => {
    const harness = await ownerHarness("whole-turn-deadline");
    let calls = 0;
    let secondCallStarted = false;
    const provider: ModelAgentProvider = {
      async completeAgent() {
        calls += 1;
        if (calls === 1) {
          return called(tool("deadline-school", "school_update", {}));
        }
        secondCallStarted = true;
        return stopped("This call must not start.");
      },
    };
    const school: ModelAdapter = {
      async *stream(input) {
        yield Object.freeze({ index: 0, text: "Saved your school plan.", toolOutcome: "saved" as const });
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const reply = await runTurn({
      harness,
      text: "plan biology",
      provider,
      school,
      turnTimeoutMs: 40,
    });

    expect(secondCallStarted).toBe(false);
    expect(reply).toContain("Saved your school plan");
    expect(reply).toContain("couldn't write a longer reply");
  });

  it("uses deadline text after the first provider call is aborted by the turn deadline", async () => {
    const harness = await ownerHarness("first-call-deadline");
    let firstCallStarted = false;
    let firstCallAborted = false;
    const provider: ModelAgentProvider = {
      async completeAgent(input) {
        firstCallStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => {
            firstCallAborted = true;
            reject(new Error("aborted"));
          };
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      },
    };

    const reply = await runTurn({ harness, text: "hello", provider, turnTimeoutMs: 20 });

    expect({ firstCallStarted, firstCallAborted }).toEqual({ firstCallStarted: true, firstCallAborted: true });
    expect(reply).toBe("I couldn't finish that turn before the deadline. Nothing changed.");
  });

  it("does not misreport an immediate first-call provider error as a deadline (R22)", async () => {
    const fallback = new ReceiptModel("Nothing changed.");
    const model = new OwnerTelegramAgentAdapter({
      provider: new FakeAgentProvider([new Error("provider unavailable")]),
      database: env.DB,
      archive: env.ARCHIVE,
      ownerPrincipalId: "principal:owner",
      directOwnerText: true,
      directPipelineText: true,
      authorityText: "hello",
      targets: { async findControlTargets() { return Object.freeze([]); } },
      decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW }),
      schoolModel: fallback,
      universityModel: fallback,
      studyCoachModel: fallback,
      turnTimeoutMs: 5_000,
    });
    const collect = async (): Promise<void> => {
      for await (const _token of model.stream({
        correlationId: newUlid(),
        principalId: "principal:owner",
        channel: "telegram",
        userText: "hello",
        context: Object.freeze([]),
        reasoningEffort: "low",
        firstTokenTimeoutMs: 1_000,
        timeoutMs: 5_000,
        contextTokenBudget: 1_000,
        maxOutputCharacters: 4_096,
        signal: new AbortController().signal,
      })) { /* no token is expected */ }
    };

    await expect(collect()).rejects.toThrow("provider unavailable");
  });

  it("refuses memory ids that are absent from context or owned by somebody else", async () => {
    const owner = await ownerHarness("id-owner");
    await runTurn({
      harness: owner,
      text: "remember I like geometry",
      provider: new FakeAgentProvider([
        called(tool("id-seed", "memory_remember", {
          fact: "I like geometry",
          supportingExcerpt: "I like geometry",
          evidenceClass: "stated",
          previousOfferExcerpt: null,
          kind: "preference",
          sensitivity: "normal",
        })),
        stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:id-seed"] }]),
      ]),
    });
    const row = (await memoryRows(owner.principalId))[0]!;
    const notEligible = new FakeAgentProvider([
      called(tool("id-missing", "memory_forget", { itemIds: [row.item_id] })),
      stopped("Nothing changed."),
    ]);
    await runTurn({ harness: owner, text: "forget a hidden id", provider: notEligible });
    expect(JSON.parse(notEligible.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });

    const other = await ownerHarness("id-other");
    const wrongOwner = new FakeAgentProvider([
      called(tool("id-owner-mismatch", "memory_forget", { itemIds: [row.item_id] })),
      stopped("Nothing changed."),
    ]);
    await runTurn({ harness: other, text: "forget that", provider: wrongOwner, context: [memoryContext(row)] });
    expect(JSON.parse(wrongOwner.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    await expect(new MemoryRepository(env.DB).readCurrentItem(owner.principalId, row.item_id as Ulid))
      .resolves.toMatchObject({ lifecycle: { state: "active" } });
  });

  it("returns a durable one-tap decision instead of forgetting several items", async () => {
    const harness = await ownerHarness("multi-forget");
    for (const [index, fact] of ["I like math", "I like physics"].entries()) {
      await runTurn({
        harness,
        text: `remember ${fact}`,
        provider: new FakeAgentProvider([
          called(tool(`seed-${index}`, "memory_remember", {
            fact,
            supportingExcerpt: fact,
            evidenceClass: "stated",
            previousOfferExcerpt: null,
            kind: "preference",
            sensitivity: "normal",
          })),
          stopped("Saved.", [{ sentence: "Saved.", receiptIds: [`receipt:seed-${index}`] }]),
        ]),
      });
    }
    const before = await memoryRows(harness.principalId);
    const ids = before.map((row) => row.item_id);
    const provider = new FakeAgentProvider([
      called(tool("forget-many", "memory_forget", { itemIds: ids })),
      stopped("I forgot both memories.", [{
        sentence: "I forgot both memories.",
        receiptIds: ["receipt:forget-many"],
      }]),
      stopped("Use the button."),
    ]);

    const reply = await runTurn({
      harness,
      text: "forget both of those",
      provider,
      context: before.map(memoryContext),
    });

    expect(reply).toContain("Nothing changed. Tap Confirm forget 2");
    expect(harness.telegram.requests.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.text)
      .toBe("Confirm forget 2");
    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([
      { lifecycle_state: "active" },
      { lifecycle_state: "active" },
    ]);
    const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW });
    const queue = await decisions.queue(harness.principalId);
    expect(queue).toMatchObject([{
        origin: "telegram-memory-forget",
        originReference: ids.join(","),
        status: "delivered",
      }]);

    const callbackData = harness.telegram.requests.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    if (callbackData === undefined) throw new Error("owner_agent_callback_missing");
    const acceptedTap: { value: AcceptedTelegramButtonTap | null } = { value: null };
    const callbackResponse = await handleTelegramWebhook(new Request("https://jarvis.test/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({
        update_id: 90_000 + serial,
        callback_query: {
          id: `callback-${serial}`,
          from: { id: Number(harness.providerSubject) },
          message: { message_id: serial, chat: { id: Number(harness.providerSubject) } },
          data: callbackData,
        },
      }),
    }), {
      webhookSecret: "test-secret",
      policy: {
        async authenticateTelegram() {
          return Object.freeze({ principalId: harness.principalId, identityState: "active" as const });
        },
      },
      redactor: new Redactor(),
      events: new EventRepository(env.DB),
      limiter: new TelegramRateLimiter(),
      now: () => new Date(NOW.getTime() + 1_000),
      onCallback: (tap) => { acceptedTap.value = tap; },
    });
    expect(callbackResponse.status).toBe(200);
    if (acceptedTap.value === null) throw new Error("owner_agent_callback_not_accepted");
    const answer = await decisions.answer({
      decisionId: queue[0]!.decisionId,
      answeredByIdentityId: harness.identityId,
      optionKey: "confirm",
    });
    if (answer.outcome !== "recorded") throw new Error("owner_agent_callback_not_recorded");
    const receipts = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forgetConfirmedDecision({
      principalId: harness.principalId,
      callbackEventId: acceptedTap.value.eventId as Ulid,
      decisionId: answer.routing.decisionId as Ulid,
      itemIds: ids as Ulid[],
    });
    expect(receipts).toHaveLength(2);
    const replay = await new MemoryOwnerControlsService(env.DB, env.ARCHIVE).forgetConfirmedDecision({
      principalId: harness.principalId,
      callbackEventId: acceptedTap.value.eventId as Ulid,
      decisionId: answer.routing.decisionId as Ulid,
      itemIds: ids as Ulid[],
    });
    expect(replay).toHaveLength(2);
    expect(replay.every((receipt) => receipt.replayed)).toBe(true);
    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([
      { lifecycle_state: "forgotten" },
      { lifecycle_state: "forgotten" },
    ]);
  });

  it("answerFromTap skips already-forgotten items and re-runs an already-answered confirm idempotently", async () => {
    const harness = await ownerHarness("answer-from-tap");
    for (const [index, fact] of ["I like algebra", "I like physics"].entries()) {
      await runTurn({
        harness,
        text: `remember ${fact}`,
        provider: new FakeAgentProvider([
          called(tool(`tap-seed-${index}`, "memory_remember", {
            fact, supportingExcerpt: fact, evidenceClass: "stated", previousOfferExcerpt: null,
            kind: "preference", sensitivity: "normal",
          })),
          stopped("Saved.", [{ sentence: "Saved.", receiptIds: [`receipt:tap-seed-${index}`] }]),
        ]),
      });
    }
    const before = await memoryRows(harness.principalId);
    const ids = before.map((row) => row.item_id);
    await runTurn({
      harness,
      text: "forget both",
      context: before.map(memoryContext),
      provider: new FakeAgentProvider([
        called(tool("tap-forget-many", "memory_forget", { itemIds: ids })),
        stopped("Use the button."),
      ]),
    });
    const callbackData = harness.telegram.requests.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    if (callbackData === undefined) throw new Error("owner_agent_callback_missing");

    await runTurn({
      harness,
      text: "forget the algebra one",
      context: [memoryContext(before[0]!)],
      provider: new FakeAgentProvider([
        called(tool("tap-forget-one", "memory_forget", {
          itemIds: [ids[0]], supportingExcerpt: "forget the algebra one",
        })),
        stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:tap-forget-one"] }]),
      ]),
    });

    const sent: string[] = [];
    const firstTap = await acceptCallbackTap(harness, callbackData, "1");
    await answerFromTap(env, firstTap, async (_chatId, text) => { sent.push(text); });
    await expect(memoryRows(harness.principalId)).resolves.toMatchObject([
      { lifecycle_state: "forgotten" },
      { lifecycle_state: "forgotten" },
    ]);
    expect(sent[0]).toContain("already forgotten");
    expect(sent[0]).toContain("Forgot 1 memory");

    const secondTap = await acceptCallbackTap(harness, callbackData, "2");
    await answerFromTap(env, secondTap, async (_chatId, text) => { sent.push(text); });
    expect(sent[1]).toContain("already forgotten");
    expect(sent[1]).not.toBe("That one is already answered.");
  });

  it("answerFromTap always reports a confirmed-forget execution failure", async () => {
    const harness = await ownerHarness("answer-from-tap-failure");
    const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW });
    const decision = await decisions.raise({
      principalId: harness.principalId,
      origin: "telegram-memory-forget",
      originReference: newUlid(),
      urgency: "normal",
      question: "Forget this memory?",
      choices: [{ key: "confirm", label: "Confirm forget" }],
    });
    await decisions.markDelivered(decision.decisionId);
    const tap = await acceptCallbackTap(
      harness,
      encodeDecisionCallbackData(decision.decisionId as Ulid, "confirm"),
      "3",
    );
    const sent: string[] = [];

    await answerFromTap(env, tap, async (_chatId, text) => { sent.push(text); });

    expect(sent).toEqual(["I couldn't finish that confirmed memory change. Tap Confirm again to retry safely."]);
  });

  it.each([
    ["identity (R31)", { identityId: "identity:other" }],
    ["principal (R32)", { principalId: "principal:other" }],
    ["origin (R33)", { origin: "other-origin" }],
    ["option (R34)", { optionKey: "explain" }],
  ] as const)("does not replay a confirmed forget with mismatched %s", (_label, override) => {
    const result: AnswerDecisionResult = {
      outcome: "already_answered",
      standing: {
        responseId: newUlid(),
        decisionId: "decision:replay",
        optionKey: "optionKey" in override ? override.optionKey : "confirm",
        freeText: null,
        answeredByIdentityId: "identity:owner",
        respondedAt: NOW.toISOString(),
      },
    };
    const item: DecisionItem = {
      decisionId: "decision:replay",
      principalId: "principal:owner",
      origin: "origin" in override ? override.origin : "telegram-memory-forget",
      originReference: `${newUlid()},${newUlid()}`,
      urgency: "normal",
      question: "Forget both memories?",
      detail: null,
      status: "answered",
      rank: 0,
      expiresAt: null,
      createdAt: NOW.toISOString(),
      deliveredAt: NOW.toISOString(),
      resolvedAt: NOW.toISOString(),
      options: Object.freeze([]),
    };

    expect(confirmedTelegramForgetRoute(
      result,
      "identityId" in override ? override.identityId : "identity:owner",
      "principalId" in override ? override.principalId : "principal:owner",
      item,
    )).toBeNull();
  });

  it("rejects confirmed forget when callback data, item set, answered-confirm state, or principal differs", async () => {
    const first = await prepareConfirmedForget("confirm-guards-a");
    const controls = new MemoryOwnerControlsService(env.DB, env.ARCHIVE);
    const base = {
      principalId: first.harness.principalId,
      callbackEventId: first.tap.eventId as Ulid,
      decisionId: first.decisionId as Ulid,
      itemIds: first.ids as Ulid[],
    };

    await expect(controls.forgetConfirmedDecision(base)).rejects.toThrow("memory_refused");
    const answer = await first.decisions.answer({
      decisionId: first.decisionId,
      answeredByIdentityId: first.harness.identityId,
      optionKey: "confirm",
    });
    expect(answer.outcome).toBe("recorded");
    await expect(new MemoryOwnerControlsService(
      overrideConfirmedForgetDecisionRead(env.DB, { status: "delivered" }),
      env.ARCHIVE,
    ).forgetConfirmedDecision(base)).rejects.toThrow("memory_refused");
    await expect(new MemoryOwnerControlsService(
      overrideConfirmedForgetDecisionRead(env.DB, { identity_principal_id: "principal:somebody-else" }),
      env.ARCHIVE,
    ).forgetConfirmedDecision(base)).rejects.toThrow("memory_refused");
    await expect(new MemoryOwnerControlsService(
      overrideConfirmedForgetDecisionRead(env.DB, { principal_id: "principal:somebody-else" }),
      env.ARCHIVE,
    ).forgetConfirmedDecision(base)).rejects.toThrow("memory_refused");
    await expect(controls.forgetConfirmedDecision({
      ...base,
      itemIds: [...base.itemIds].reverse(),
    })).rejects.toThrow("memory_refused");
    await expect(controls.forgetConfirmedDecision({
      ...base,
      principalId: "principal:not-the-owner",
    })).rejects.toThrow("memory_refused");
    const wrongTap = await acceptCallbackTap(
      first.harness,
      encodeDecisionCallbackData(newUlid(), "confirm"),
      "5",
    );
    await expect(controls.forgetConfirmedDecision({
      ...base,
      callbackEventId: wrongTap.eventId as Ulid,
    })).rejects.toThrow("memory_refused");

    const second = await prepareConfirmedForget("confirm-guards-b");
    const nonConfirm = await second.decisions.answer({
      decisionId: second.decisionId,
      answeredByIdentityId: second.harness.identityId,
      optionKey: "explain",
    });
    expect(nonConfirm.outcome).toBe("recorded");
    await expect(controls.forgetConfirmedDecision({
      principalId: second.harness.principalId,
      callbackEventId: second.tap.eventId as Ulid,
      decisionId: second.decisionId as Ulid,
      itemIds: second.ids as Ulid[],
    })).rejects.toThrow("memory_refused");
  });

  it.each([
    ["malformed", tool("bad-json", "memory_remember", "{")],
    ["oversized", tool("too-large", "memory_remember", JSON.stringify({ fact: "a".repeat(4_096) }))],
    ["unknown", tool("unknown", "made_up_tool", {})],
  ] as const)("refuses %s tool output without breaking the reply", async (_label, call) => {
    const harness = await ownerHarness(`refusal-${_label}`);
    const provider = new FakeAgentProvider([called(call), stopped("I changed nothing.")]);

    await expect(runTurn({ harness, text: "hello", provider })).resolves.toBe("I changed nothing.");
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
  });

  it("refuses repeated over-cap calls without executing either", async () => {
    const harness = await ownerHarness("over-cap");
    const args = {
      fact: "one fact",
      supportingExcerpt: "one fact",
      evidenceClass: "stated",
      previousOfferExcerpt: null,
      kind: "fact",
      sensitivity: "normal",
    };
    const provider = new FakeAgentProvider([
      called(tool("too-many-1", "memory_remember", args), tool("too-many-2", "memory_remember", args)),
      stopped("Nothing changed."),
    ]);

    await runTurn({ harness, text: "one fact", provider });

    await expect(memoryRows(harness.principalId)).resolves.toEqual([]);
    expect(provider.requests[1]?.toolResults).toHaveLength(2);
  });

  it("rewrites an unsupported action claim once and removes it deterministically if still unsupported", async () => {
    const harness = await ownerHarness("honesty");
    const claim = [{ sentence: "I sent the email.", receiptIds: [] }];
    const provider = new FakeAgentProvider([
      stopped("I sent the email. Here is a draft.", claim),
      stopped("I sent the email. Here is a draft.", claim),
    ]);

    await expect(runTurn({ harness, text: "email them", provider }))
      .resolves.toBe("Here is a draft.\n\nI did not complete the unreceipted action.");
    expect(provider.requests).toHaveLength(2);
  });

  it("keeps the deterministic honesty fallback once and within Telegram's character limit", async () => {
    const harness = await ownerHarness("honesty-limit");
    const action = "I submitted the form.";
    const draft = `${action} ${"Review this draft sentence. ".repeat(190)}`;
    const claims = [{ sentence: action, receiptIds: [] }];
    const provider = new FakeAgentProvider([
      stopped(draft, claims),
      stopped(draft, claims),
    ]);

    const reply = await runTurn({ harness, text: "help with the form", provider });

    expect(reply.length).toBeLessThanOrEqual(4_096);
    expect(reply.endsWith("I did not complete the unreceipted action.")).toBe(true);
    expect(reply.match(/I did not complete the unreceipted action\./gu)).toHaveLength(1);
  });
});

describe("direct owner Telegram classification", () => {
  it("keeps a private reply to Jarvis's own bot message authoritative for memory confirmation", () => {
    const classified = classifyTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 10, is_bot: false },
        chat: { id: 10, type: "private" },
        text: "Math",
        reply_to_message: {
          message_id: 1,
          from: { id: 99, is_bot: true },
          chat: { id: 10, type: "private" },
          date: 1,
          text: "Want me to note it?",
        },
      },
    });

    expect(classified.kind).toBe("text");
    if (classified.kind === "text") {
      expect(classified.value).toMatchObject({
        isDirectText: true,
        isPrivateHumanText: true,
        isMemoryControlAuthoritative: true,
        replyToBotMessageId: 1,
        replyToBotText: "Want me to note it?",
      });
    }
  });

  it.each([
    ["forwarded", { forward_origin: { type: "user", sender_user: { id: 9 } } }],
    ["quoted", { quote: { text: "remember this" } }],
    ["captioned", { photo: [{ file_id: "a", file_unique_id: "b", width: 1, height: 1 }], caption: "remember" }],
    ["edited", { edited: true }],
    ["group", { chat: { id: -100, type: "supergroup" } }],
    ["bot", { from: { id: 10, is_bot: true } }],
  ] as const)("does not grant tool authority to %s input", (_label, extra) => {
    const base = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 10, is_bot: false },
        chat: { id: 10, type: "private" },
        text: "remember this",
      },
    } as Record<string, unknown>;
    if (_label === "edited") {
      const classified = classifyTelegramUpdate({
        update_id: 1,
        edited_message: (base.message as object),
      });
      expect(classified.kind).toBe("rejected");
      return;
    }
    const message = { ...(base.message as object), ...extra } as Record<string, unknown>;
    if ("chat" in extra) message.chat = extra.chat;
    if ("from" in extra) message.from = extra.from;
    const classified = classifyTelegramUpdate({ update_id: 1, message });
    if (_label === "captioned") expect(classified.kind).toBe("rejected");
    else {
      expect(classified.kind).toBe("text");
      if (classified.kind === "text") expect(classified.value.isMemoryControlAuthoritative).toBe(false);
    }
  });
});

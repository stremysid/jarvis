import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
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
import { buildTelegramConversationRepository } from "../../src/index.js";
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
} from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-17T14:00:00.000Z");
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

  constructor(private readonly completions: ModelAgentCompletion[]) {}

  async completeAgent(input: ModelAgentCompletionInput): Promise<ModelAgentCompletion> {
    this.requests.push(input);
    const completion = this.completions.shift();
    if (completion === undefined) throw new Error("unexpected_agent_call");
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
  readonly telegram: FakeTelegramProvider;
}

async function ownerHarness(label: string): Promise<OwnerHarness> {
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
    telegram: new FakeTelegramProvider(),
  });
}

async function runTurn(input: {
  readonly harness: OwnerHarness;
  readonly text: string;
  readonly provider: FakeAgentProvider;
  readonly directOwnerText?: boolean;
  readonly context?: readonly RetrievedContext[];
  readonly school?: ReceiptModel;
  readonly university?: ReceiptModel;
  readonly study?: ReceiptModel;
  readonly configuredOwnerPrincipalId?: string;
}): Promise<string> {
  const directOwnerText = input.directOwnerText ?? true;
  const events = new EventRepository(env.DB);
  const repository = buildTelegramConversationRepository(env.DB, events, {
    principalId: input.harness.principalId,
    isDirectText: directOwnerText,
    isMemoryControlAuthoritative: directOwnerText,
  }, input.harness.principalId);
  const fallback = new ReceiptModel("No saved action.");
  const model = new OwnerTelegramAgentAdapter({
    provider: input.provider,
    database: env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId: input.configuredOwnerPrincipalId ?? input.harness.principalId,
    directOwnerText,
    authorityText: input.text,
    targets: { async findControlTargets() { return Object.freeze([]); } },
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW }),
    schoolModel: input.school ?? fallback,
    universityModel: input.university ?? fallback,
    studyCoachModel: input.study ?? fallback,
  });
  const service = new DefaultConversationService({
    repository,
    model,
    context: { async retrieve() { return input.context ?? Object.freeze([]); } },
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

beforeAll(applyMemoryIngressMigration);

describe("owner Telegram agent", () => {
  it("answers an ordinary turn with exactly one model call", async () => {
    const harness = await ownerHarness("ordinary");
    const provider = new FakeAgentProvider([stopped("Hey Sid.")]);

    await expect(runTurn({ harness, text: "yo", provider })).resolves.toBe("Hey Sid.");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.toolChoice).toBe("auto");
  });

  it("stores Sid's misspelled remember request as stated evidence with the exact excerpt", async () => {
    const harness = await ownerHarness("misspelled-remember");
    const provider = new FakeAgentProvider([
      called(tool("remember-1", "memory_remember", {
        fact: "my fav subject is math",
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
      text: "my fav subject is math",
      basis: "stated",
      lifecycle_state: "active",
      excerpt: "my fav subject is math",
    }]);
    expect(provider.requests).toHaveLength(2);
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
        fact: "Math",
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
      text: "Math",
      basis: "confirmed",
      lifecycle_state: "active",
      excerpt: "Math",
    }]);
    expect(school.inputs).toHaveLength(0);
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

  it("refuses a tool for model-authored or otherwise non-direct text", async () => {
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
    expect(JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
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

  it("confirms a proposed memory only from Sid's grounded current excerpt", async () => {
    const harness = await ownerHarness("confirm");
    const itemId = await proposedMemory(harness);
    const provider = new FakeAgentProvider([
      called(tool("confirm-1", "memory_confirm", { itemId, supportingExcerpt: "yes" })),
      stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:confirm-1"] }]),
    ]);

    const reply = await runTurn({
      harness,
      text: "yes",
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
        sources: expect.arrayContaining([expect.objectContaining({ excerpt: "yes" })]),
      });
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
        called(tool("cycle-forget", "memory_forget", { itemIds: [row.item_id] })),
        stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:cycle-forget"] }]),
      ]),
    });
    expect(forgot).toContain("Forgot 1 memory");
    const restored = await runTurn({
      harness,
      text: "use it again",
      context,
      provider: new FakeAgentProvider([
        called(tool("cycle-restore", "memory_restore", { itemId: row.item_id })),
        stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:cycle-restore"] }]),
      ]),
    });
    expect(restored).toContain("Restored 1 memory");
    const explained = await runTurn({
      harness,
      text: "why do you remember that?",
      context,
      provider: new FakeAgentProvider([
        called(tool("cycle-explain", "memory_explain", { itemId: row.item_id })),
        stopped("There is the evidence.", [{ sentence: "There is the evidence.", receiptIds: ["receipt:cycle-explain"] }]),
      ]),
    });
    expect(explained).toContain("Evidence for 1 memory");
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

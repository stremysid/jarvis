import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { classifyTelegramUpdate } from "../../src/channels/telegram/telegram-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import {
  buildTelegramConversationRepository,
  ownerAgentTurnTimeoutMs,
  ownerTelegramToolAuthority,
} from "../../src/index.js";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken, RetrievedContext } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
  ModelFunctionCall,
} from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { guardReplyClaims, SchoolCatchupModelAdapter } from "../../src/school/school-catchup-model.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { StudyCoachModelAdapter } from "../../src/school/study-coach-model.js";
import { StudyCoachRepository } from "../../src/school/study-coach-repository.js";
import { BrightspaceIcalClient } from "../../src/deadlines/brightspace-ical-client.js";
import { TelegramMemoryRetriever } from "../../src/memory/telegram-memory-retriever.js";
import {
  applyArchiveLiteralHistoryMigration,
  applyMemoryDistillationMigration,
  applyMemoryIngressMigration,
  applyStudyCoachWeakSpotsMigration,
  applyUniversityApplicationDetailsMigration,
} from "../persistence/migration.js";

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
  constructor(private readonly completions: Array<ModelAgentCompletion | Error>) {}
  async completeAgent(input: ModelAgentCompletionInput): Promise<ModelAgentCompletion> {
    this.requests.push(input);
    const next = this.completions.shift();
    if (next === undefined) throw new Error("unexpected_agent_call");
    if (next instanceof Error) throw next;
    return next;
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

/** A production-shaped adapter: it has streamOwnerTool but signals no outcome. */
class SilentStructuredModel implements ModelAdapter {
  constructor(private readonly text: string) {}
  async *stream(): AsyncIterable<ModelToken> {
    yield Object.freeze({ index: 0, text: this.text });
  }
  async *streamOwnerTool(): AsyncIterable<ModelToken> {
    yield Object.freeze({ index: 0, text: this.text });
  }
}

class SequenceModel implements ModelAdapter {
  readonly requests: ModelAdapterStreamInput[] = [];
  constructor(private readonly replies: readonly string[]) {}
  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    this.requests.push(input);
    yield Object.freeze({ index: 0, text: this.replies[this.requests.length - 1] ?? "Fallback." });
  }
}

interface Harness {
  readonly principalId: string;
  readonly identityId: string;
  readonly providerSubject: string;
  readonly sessionId: string;
  readonly telegram: FakeTelegramProvider;
}

async function harness(label: string): Promise<Harness> {
  serial += 1;
  const principalId = `principal:adv86r3:${label}:${serial}`;
  const identityId = `identity:adv86r3:${label}:${serial}`;
  const providerSubject = String(8_700_000 + serial);
  const now = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'Adversarial r3', ?2, ?2)`).bind(principalId, now),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?1, ?2, 'telegram', ?3, 'active', ?4, ?4)`).bind(identityId, principalId, providerSubject, now),
  ]);
  return Object.freeze({
    principalId, identityId, providerSubject, sessionId: `telegram:${providerSubject}`,
    telegram: new FakeTelegramProvider(),
  });
}

async function turn(input: {
  readonly h: Harness;
  readonly text: string;
  readonly provider: ModelAgentProvider;
  readonly directOwnerText?: boolean;
  readonly context?: readonly RetrievedContext[];
  readonly school?: ModelAdapter;
  readonly study?: ModelAdapter;
  readonly turnTimeoutMs?: number;
  readonly replyToBotMessageId?: number | null;
}): Promise<Readonly<{ outcome: string; text: string; sent: number }>> {
  const direct = input.directOwnerText ?? true;
  const before = input.h.telegram.requests.length;
  const repository = buildTelegramConversationRepository(env.DB, new EventRepository(env.DB), {
    principalId: input.h.principalId, isDirectText: direct, isMemoryControlAuthoritative: direct,
  }, input.h.principalId);
  const fallback = new ReceiptModel("No saved action.");
  const model = new OwnerTelegramAgentAdapter({
    provider: input.provider,
    database: env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId: input.h.principalId,
    directOwnerText: direct,
    directPipelineText: true,
    authorityText: input.text,
    ...(input.replyToBotMessageId === undefined ? {} : { replyToBotMessageId: input.replyToBotMessageId }),
    targets: { async findControlTargets() { return Object.freeze([]); } },
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW }),
    schoolModel: input.school ?? fallback,
    universityModel: fallback,
    studyCoachModel: input.study ?? fallback,
    turnTimeoutMs: input.turnTimeoutMs,
  });
  const service = new DefaultConversationService({
    repository,
    model,
    context: { async retrieve() { return input.context ?? Object.freeze([]); } },
    dispatcher: new DefaultOutboxDispatcher({
      repository,
      identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", input.h.telegram]]),
      circuitBreaker: new ProviderCircuitBreaker(),
      now: () => NOW,
    }),
    redactor: new Redactor(),
    now: () => NOW,
  });
  const result = await service.handleTurn({
    sessionId: input.h.sessionId,
    principalId: input.h.principalId,
    turnId: newUlid(),
    text: input.text,
    signal: new AbortController().signal,
    channel: "telegram",
    kind: "outbox",
    targetIdentityId: input.h.identityId,
    replyToMessageId: serial,
  });
  return Object.freeze({
    outcome: result.outcome,
    text: input.h.telegram.requests.at(-1)?.text ?? "",
    sent: input.h.telegram.requests.length - before,
  });
}

interface StoredRow {
  item_id: string;
  text: string;
  basis: string;
  origin: string;
  uncertain: number;
  lifecycle_state: string;
  sources: number;
}

async function items(principalId: string): Promise<StoredRow[]> {
  const result = await env.DB.prepare(`SELECT item.item_id, version.text, version.basis, version.origin,
      version.uncertain, state.lifecycle_state,
      (SELECT COUNT(*) FROM memory_item_sources s
        WHERE s.principal_id = version.principal_id AND s.version_id = version.version_id) AS sources
    FROM memory_items item
    JOIN memory_item_state state ON state.principal_id = item.principal_id AND state.item_id = item.item_id
    JOIN memory_item_versions version ON version.principal_id = state.principal_id
      AND version.version_id = state.current_version_id
    WHERE item.principal_id = ?1 ORDER BY item.created_at, item.item_id`).bind(principalId)
    .all<StoredRow>();
  return result.results;
}

function rememberArgs(fact: string, excerpt: string, extra: Record<string, unknown> = {}) {
  return {
    fact, supportingExcerpt: excerpt, evidenceClass: "stated", previousOfferExcerpt: null,
    kind: "preference", sensitivity: "normal", ...extra,
  };
}

function evidence(itemId: string, text: string, state = "active"): RetrievedContext {
  return Object.freeze({
    sourceEventId: newUlid(),
    text: `Memory evidence [topic Preferences; item ${itemId}; ${state}; stated]: ${text}`,
    sensitivity: "personal" as const,
  });
}

function uncertainEvidence(itemId: string, text: string): RetrievedContext {
  return Object.freeze({
    sourceEventId: newUlid(),
    text: `Uncertain Memory evidence [topic Inbox; item ${itemId}; proposed; inferred]: ${text}`,
    sensitivity: "personal" as const,
  });
}

/** Plants the contradictory fact exactly as round 3 stores it. */
async function plantInferred(h: Harness): Promise<StoredRow> {
  await turn({
    h, text: "remember I don't like math",
    provider: new FakeAgentProvider([
      called(tool("p1", "memory_remember", rememberArgs("Sid likes math", "like math"))),
      stopped("Noted.", [{ sentence: "Noted.", receiptIds: ["receipt:p1"] }]),
    ]),
  });
  const stored = await items(h.principalId);
  expect(stored).toHaveLength(1);
  return stored[0]!;
}

beforeAll(async () => {
  await applyMemoryIngressMigration();
  await applyStudyCoachWeakSpotsMigration();
  await applyUniversityApplicationDetailsMigration();
  await applyMemoryDistillationMigration();
  await applyArchiveLiteralHistoryMigration();
});

// ---------------------------------------------------------------------------
describe("R3 B1: 'Done' only after a receipted completion", () => {
  it("B1a says Done after the deadline when a tool really completed with a receipt", async () => {
    const h = await harness("b1a");
    const school = new ReceiptModel("Saved your school plan. Today: Chemistry lab (40 min).");
    const result = await turn({
      h, text: "plan chem", school,
      provider: new FakeAgentProvider([
        called(tool("b1a", "school_update", {})),
        new Error("follow-up down"),
      ]),
    });
    console.log("B1a", JSON.stringify(result.text));
    expect(result.text).toContain("Saved your school plan");
    expect(result.text).toContain("Done —");
  });

  it("B1b never says Done when a refused memory tool is followed by a failed follow-up", async () => {
    const h = await harness("b1b");
    const result = await turn({
      h, text: "remember I like chemistry",
      provider: new FakeAgentProvider([
        called(tool("b1b", "memory_remember", rememberArgs("I like chemistry", "not in the message"))),
        new Error("deepseek timeout"),
      ]),
    });
    console.log("B1b", JSON.stringify(result.text));
    expect(await items(h.principalId)).toHaveLength(0);
    expect(result.text).not.toMatch(/\bDone\b/u);
    expect(result.text).toMatch(/nothing was saved/iu);
  });

  it("B1c never says Done when a not-saved school result is followed by a failed follow-up", async () => {
    const h = await harness("b1c");
    const school = new SilentStructuredModel("I couldn't update your school plan.");
    const result = await turn({
      h, text: "move my bio test to friday", school,
      provider: new FakeAgentProvider([
        called(tool("b1c", "school_update", {})),
        new Error("deepseek timeout"),
      ]),
    });
    console.log("B1c", JSON.stringify(result.text));
    expect(result.text).not.toMatch(/\bDone\b/u);
    expect(result.text).toMatch(/nothing was saved/iu);
  });

  it("B1d never says Done when the deadline hits inside a pipeline that saved nothing", async () => {
    const h = await harness("b1d");
    const school: ModelAdapter = {
      async *stream(input) {
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield Object.freeze({ index: 0, text: "unreachable" });
      },
    };
    const result = await turn({
      h, text: "plan my week", school, turnTimeoutMs: 50,
      provider: new FakeAgentProvider([called(tool("b1d", "school_update", {}))]),
    });
    console.log("B1d", JSON.stringify(result.text));
    expect(result.text).not.toMatch(/\bDone\b/u);
    expect(result.text).toMatch(/Nothing changed|nothing was saved/iu);
  });

  it("B1e never says Done when the honest repair fails with no receipt", async () => {
    const h = await harness("b1e");
    const result = await turn({
      h, text: "get me a tutor",
      provider: new FakeAgentProvider([
        stopped("I booked your tutor.", [{ sentence: "I booked your tutor.", receiptIds: [] }]),
        new Error("repair down"),
      ]),
    });
    console.log("B1e", JSON.stringify(result.text));
    expect(result.text).not.toMatch(/\bDone\b/u);
  });
});

// ---------------------------------------------------------------------------
describe("R3 B2: no unsignalled path mints a receipt", () => {
  it("B2a an ordinary reply from the real school adapter yields not_saved and the claim is dropped", async () => {
    const h = await harness("b2a");
    const base = new SequenceModel(["sorry, not json", "Updated deadlines usually show up in D2L within a day."]);
    const school = new SchoolCatchupModelAdapter({
      model: base, repository: new SchoolCatchupRepository(env.DB), redactor: new Redactor(),
      timeZone: "America/Toronto", now: () => NOW, ownerPrincipalId: h.principalId,
      ownerTurnAuthoritative: true, agentSelectedScope: "school", fixedActionReceipts: true,
    });
    const claim = "I've added the essay to your school tracker.";
    const provider = new FakeAgentProvider([
      called(tool("b2a", "school_update", {})),
      stopped(claim, [{ sentence: claim, receiptIds: ["receipt:b2a"] }]),
    ]);
    const result = await turn({ h, text: "english essay due monday i think", school, provider });
    const status = JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}") as { status?: string };
    console.log("B2a", JSON.stringify({ status, text: result.text }));
    expect(status.status).toBe("not_saved");
    expect(result.text).not.toContain(claim);
  });

  it("B2b the real study adapter's fallback path yields not_saved", async () => {
    const h = await harness("b2b");
    const study = new StudyCoachModelAdapter({
      fallbackModel: new ReceiptModel("Saved your study plan for tonight."),
      practiceModel: new ReceiptModel("{}"),
      repository: new StudyCoachRepository(env.DB),
      redactor: new Redactor(),
      ownerPrincipalId: h.principalId,
      ownerTurnAuthoritative: true,
      timeZone: "America/Toronto",
      now: () => NOW,
    });
    const provider = new FakeAgentProvider([
      called(tool("b2b", "study_coach", {})),
      stopped("Logged.", [{ sentence: "Logged.", receiptIds: ["receipt:b2b"] }]),
    ]);
    await turn({ h, text: "how should i study tonight", study, provider });
    const status = JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}") as { status?: string };
    console.log("B2b", JSON.stringify(status));
    expect(status.status).toBe("not_saved");
  });

  it("B2c wording never decides the outcome for an adapter that can signal", async () => {
    const h = await harness("b2c");
    const school = new SilentStructuredModel("Saved your school plan. Today: Chemistry lab (40 min).");
    const provider = new FakeAgentProvider([
      called(tool("b2c", "school_update", {})),
      stopped("Done.", [{ sentence: "Done.", receiptIds: ["receipt:b2c"] }]),
    ]);
    await turn({ h, text: "plan chem", school, provider });
    const status = JSON.parse(provider.requests[1]?.toolResults?.[0]?.content ?? "{}") as {
      status?: string; receiptId?: unknown;
    };
    console.log("B2c", JSON.stringify(status));
    expect(status.status).toBe("not_saved");
    expect(status.receiptId ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("R3 B3: a failed-grounding memory must never reach Sid as fact", () => {
  it("B3a stores a failed-grounding remember as proposed, uncertain, model-inferred", async () => {
    const h = await harness("b3a");
    const row = await plantInferred(h);
    console.log("B3a", JSON.stringify(row));
    expect(row.lifecycle_state).toBe("proposed");
    expect(row.uncertain).toBe(1);
    expect(row.origin).toBe("model");
  });

  it("B3b a proposed uncertain memory's fabricated text must not reach Sid's retrieval context", async () => {
    const h = await harness("b3b");
    const row = await plantInferred(h);
    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId: h.principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "do i like math",
      maxTokens: 32_000,
    });
    const texts = contexts.map((context) => context.text);
    console.log("B3b", JSON.stringify(texts));
    expect(texts.some((text) => text.includes(row.text))).toBe(false);
  });

  it("B3c a proposed uncertain memory must not be promotable without Sid confirming that exact fact", async () => {
    const h = await harness("b3c");
    const row = await plantInferred(h);
    // Sid says only "ok". He is not shown, and does not repeat, the fabricated fact.
    await turn({
      h, text: "ok",
      context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("b3c", "memory_confirm", { itemId: row.item_id, supportingExcerpt: "ok" })),
        stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:b3c"] }]),
      ]),
    });
    const after = (await items(h.principalId))[0]!;
    console.log("B3c", JSON.stringify(after));
    expect(after.lifecycle_state).not.toBe("active");
    expect(after.origin).not.toBe("authenticated_first_person");
  });

  it("B3d grounding still refuses negation flips, unrelated excerpts and one-word excerpts as authoritative", async () => {
    const cases = [
      { label: "negation", text: "remember I don't like math", fact: "Sid likes math", excerpt: "like math" },
      { label: "one-word", text: "ok", fact: "Sid's locker combination is 12-34-56", excerpt: "ok" },
      { label: "unrelated", text: "my chem lab is due friday", fact: "Sid wants to apply to Waterloo", excerpt: "chem lab is due friday" },
    ];
    const bases: string[] = [];
    for (const item of cases) {
      const h = await harness(`b3d-${item.label}`);
      await turn({
        h, text: item.text,
        provider: new FakeAgentProvider([
          called(tool(`b3d${item.label}`, "memory_remember", rememberArgs(item.fact, item.excerpt))),
          stopped("Noted.", [{ sentence: "Noted.", receiptIds: [`receipt:b3d${item.label}`] }]),
        ]),
      });
      const stored = await items(h.principalId);
      bases.push(`${item.label}:${stored.map((row) => `${row.basis}/${row.lifecycle_state}`).join(",") || "none"}`);
    }
    console.log("B3d", JSON.stringify(bases));
    expect(bases.every((entry) => !/:(stated|confirmed)\//u.test(entry))).toBe(true);
  });

  it("B3e a confirmed memory still needs an offer-shaped or fact-sharing question", async () => {
    const h = await harness("b3e");
    await turn({ h, text: "hey", provider: new FakeAgentProvider([stopped("Hey Sid, what's up?")]) });
    await turn({
      h, text: "Math",
      provider: new FakeAgentProvider([
        called(tool("b3e", "memory_remember", rememberArgs("Sid's favourite subject is math", "Math", {
          evidenceClass: "confirmed", previousOfferExcerpt: "Hey Sid, what's up?",
        }))),
        stopped("Noted.", [{ sentence: "Noted.", receiptIds: ["receipt:b3e"] }]),
      ]),
    });
    const stored = await items(h.principalId);
    console.log("B3e", JSON.stringify(stored));
    expect(stored.filter((row) => row.basis === "confirmed")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("R3 B4: deadline anchored at webhook arrival", () => {
  it("B4a anchors the agent budget at arrival and reserves at least 5 s of the 30 s waitUntil window", () => {
    const arrival = new Date("2026-09-17T14:00:00.000Z");
    const fresh = ownerAgentTurnTimeoutMs(arrival.toISOString(), arrival);
    const late = ownerAgentTurnTimeoutMs(arrival.toISOString(), new Date(arrival.getTime() + 6_000));
    const veryLate = ownerAgentTurnTimeoutMs(arrival.toISOString(), new Date(arrival.getTime() + 60_000));
    console.log("B4a", JSON.stringify({ fresh, late, veryLate }));
    expect(fresh).toBeLessThanOrEqual(25_000);
    expect(fresh + 5_000).toBeLessThanOrEqual(30_000);
    expect(late).toBe(fresh - 6_000);
    expect(veryLate).toBeGreaterThanOrEqual(1);
  });

  it("B4b cancellation reaches the Brightspace refresh", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const client = new BrightspaceIcalClient({
      feedUrl: "https://d2l.test/feed.ics",
      timeZone: "America/Toronto",
      signal: controller.signal,
      fetchImplementation: (async (_url: unknown, init?: RequestInit) => {
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
          setTimeout(resolve, 2_000);
        });
        throw new Error("aborted");
      }) as unknown as typeof fetch,
    });
    const collected = client.collectDeadlines().catch(() => "failed");
    controller.abort();
    await collected;
    console.log("B4b", JSON.stringify({ sawAbort }));
    expect(sawAbort).toBe(true);
  });

  it("B4c the pre-agent stages are inside the anchored budget, not added to it", () => {
    // The agent is constructed, and its budget computed, before the turn's
    // commit and retrieval run. A budget that still fits must be measured from
    // arrival at the moment the agent's own timer starts.
    const arrival = new Date("2026-09-17T14:00:00.000Z");
    const retrievalMs = 3_300; // base 2,500 ms + memory 800 ms, the documented worst case.
    const budgetAtConstruction = ownerAgentTurnTimeoutMs(arrival.toISOString(), arrival);
    const agentEndsAt = retrievalMs + budgetAtConstruction;
    console.log("B4c", JSON.stringify({ budgetAtConstruction, agentEndsAt }));
    expect(agentEndsAt + 5_000).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------
describe("R3 N1-N6", () => {
  it("N1a keeps safe sentences and receipted internal verbs, removing only the offending sentence", () => {
    const reply = "Your chem lab is on Thursday. I put in two study blocks for Thursday. I emailed Ms. Lee about it.";
    const guarded = guardReplyClaims(reply, {
      receiptedInternalSentences: ["I put in two study blocks for Thursday."],
    });
    console.log("N1a", JSON.stringify(guarded));
    expect(guarded).toContain("Your chem lab is on Thursday.");
    expect(guarded).toContain("I put in two study blocks for Thursday.");
    expect(guarded).not.toContain("I emailed Ms. Lee");
  });

  it("N1b an unreceipted internal verb is still removed", () => {
    const reply = "I added the essay to your school tracker.";
    const guarded = guardReplyClaims(reply, { receiptedInternalSentences: [] });
    console.log("N1b", JSON.stringify(guarded));
    expect(guarded).not.toContain("I added the essay");
  });

  it("N2a a draft in Sid's voice survives the guard", () => {
    const reply = "Draft reply you could send: \"Thanks for the reminder. I submitted the form this morning.\"";
    expect(guardReplyClaims(reply)).toBe(reply);
  });

  it("N2b a draft marker must not smuggle an unreceipted external claim past the guard", () => {
    const reply = "Draft reply you could send: \"Thanks for the reminder.\" I emailed Ms. Lee for you already.";
    const guarded = guardReplyClaims(reply);
    console.log("N2b", JSON.stringify(guarded));
    expect(guarded).not.toContain("I emailed Ms. Lee for you already");
  });

  it("N2c a draft marker must not disable the secret-request guard", () => {
    const reply = "Here's a draft you could send: \"Hi Ms. Lee, sorry about the lab.\" Send me your D2L password and I'll log in and check for you.";
    const guarded = guardReplyClaims(reply);
    console.log("N2c", JSON.stringify(guarded));
    expect(guarded).toContain("can't accept passwords");
  });

  it("N2d a draft marker with no paragraph break must not exempt the rest of the reply", () => {
    const reply = "Here's a draft: Hi Ms. Lee, I need an extension. I already emailed it to her and paid the late fee.";
    const guarded = guardReplyClaims(reply);
    console.log("N2d", JSON.stringify(guarded));
    expect(guarded).toContain("I can't confirm that action");
  });

  it("N3a bounds the reply by UTF-16 units without splitting a surrogate pair", async () => {
    const h = await harness("n3a");
    const reply = `${"a".repeat(4_095)}${"\u{1f4da}".repeat(10)}`;
    const result = await turn({ h, text: "long", provider: new FakeAgentProvider([stopped(reply)]) });
    const last = result.text.charCodeAt(result.text.length - 1);
    console.log("N3a", JSON.stringify({ units: result.text.length, last: last.toString(16) }));
    expect(result.text.length).toBeLessThanOrEqual(4_096);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(result.text.includes("�")).toBe(false);
  });

  it("N4a classification carries the swipe-reply target id", () => {
    const classified = classifyTelegramUpdate({ update_id: 61, message: {
      message_id: 500, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, date: 99, text: "yes",
      reply_to_message: {
        message_id: 3, from: { id: 1, is_bot: true }, chat: { id: 42, type: "private" }, date: 1,
        text: "Want me to note that your chem lab is due Friday?",
      },
    } });
    expect(classified.kind).toBe("text");
    if (classified.kind !== "text") return;
    console.log("N4a", JSON.stringify(classified.value));
    expect(classified.value.replyToBotMessageId).toBe(3);
    expect(classified.value.replyToBotText).toContain("chem lab");
  });

  it("N4b a swipe reply to an old Jarvis message cannot drive a memory write", async () => {
    const h = await harness("n4b");
    await turn({ h, text: "my fav subject is kinda obvious lol",
      provider: new FakeAgentProvider([stopped("Which subject is it? Want me to note it?")]) });
    await turn({
      h, text: "Math", replyToBotMessageId: 999_001,
      provider: new FakeAgentProvider([
        called(tool("n4b", "memory_remember", rememberArgs("Sid's favourite subject is math", "Math", {
          evidenceClass: "confirmed", previousOfferExcerpt: "Want me to note it?",
        }))),
        stopped("Noted.", [{ sentence: "Noted.", receiptIds: ["receipt:n4b"] }]),
      ]),
    });
    const stored = await items(h.principalId);
    console.log("N4b", JSON.stringify(stored));
    expect(stored).toHaveLength(0);
  });

  it("N5a a single forget, restore or explain needs a control intent in Sid's words", async () => {
    const h = await harness("n5a");
    await turn({ h, text: "remember I like calculus", provider: new FakeAgentProvider([
      called(tool("n5s", "memory_remember", rememberArgs("Sid likes calculus", "I like calculus"))),
      stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:n5s"] }]),
    ]) });
    const row = (await items(h.principalId))[0]!;
    for (const call of [
      tool("n5f", "memory_forget", { itemIds: [row.item_id], supportingExcerpt: "hi" }),
      tool("n5r", "memory_restore", { itemId: row.item_id, supportingExcerpt: "hi" }),
      tool("n5e", "memory_explain", { itemId: row.item_id, supportingExcerpt: "hi" }),
    ]) {
      await turn({
        h, text: "hi", context: [evidence(row.item_id, row.text)],
        provider: new FakeAgentProvider([called(call), stopped("Hi Sid.")]),
      });
    }
    const after = (await items(h.principalId))[0]!;
    console.log("N5a", JSON.stringify(after));
    expect(after.lifecycle_state).toBe("active");
  });

  it("N5b memory_confirm must also require a control intent, not any substring", async () => {
    const h = await harness("n5b");
    const row = await plantInferred(h);
    await turn({
      h, text: "hi", context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("n5b", "memory_confirm", { itemId: row.item_id, supportingExcerpt: "hi" })),
        stopped("Hi Sid."),
      ]),
    });
    const after = (await items(h.principalId))[0]!;
    console.log("N5b", JSON.stringify(after));
    expect(after.lifecycle_state).toBe("proposed");
  });

  it("N6 a normalised dedupe hit keeps one item and appends the new wording as a source", async () => {
    const h = await harness("n6");
    await turn({ h, text: "remember I like chemistry", provider: new FakeAgentProvider([
      called(tool("n6a", "memory_remember", rememberArgs("Sid likes chemistry", "I like chemistry"))),
      new Error("deepseek timeout"),
    ]) });
    await turn({ h, text: "remember I like chemistry", provider: new FakeAgentProvider([
      called(tool("n6b", "memory_remember", rememberArgs("Sid likes chemistry.", "I like chemistry"))),
      stopped("Saved.", [{ sentence: "Saved.", receiptIds: ["receipt:n6b"] }]),
    ]) });
    const stored = await items(h.principalId);
    console.log("N6", JSON.stringify(stored));
    expect(stored.filter((row) => row.lifecycle_state === "active")).toHaveLength(1);
    expect(stored[0]?.sources).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("R3 authority wiring", () => {
  it("W1 ownerTelegramToolAuthority never widens memory authority beyond the classifier", () => {
    const narrow = ownerTelegramToolAuthority({
      isDirectText: true, isPrivateHumanText: true, isMemoryControlAuthoritative: false,
    });
    const wide = ownerTelegramToolAuthority({
      isDirectText: true, isPrivateHumanText: true, isMemoryControlAuthoritative: true,
    });
    const group = ownerTelegramToolAuthority({
      isDirectText: true, isPrivateHumanText: false, isMemoryControlAuthoritative: false,
    });
    console.log("W1", JSON.stringify({ narrow, wide, group }));
    expect(narrow.directOwnerText).toBe(false);
    expect(narrow.directPipelineText).toBe(true);
    expect(wide.directOwnerText).toBe(true);
    expect(group.directPipelineText).toBe(false);
  });
});

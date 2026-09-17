import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
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
import { guardReplyClaims, guardSchoolReply } from "../../src/school/school-catchup-model.js";
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
  constructor(private readonly receipt: string) {}
  async *stream(): AsyncIterable<ModelToken> {
    yield Object.freeze({ index: 0, text: this.receipt });
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
  const principalId = `principal:adv86r5:${label}:${serial}`;
  const identityId = `identity:adv86r5:${label}:${serial}`;
  const providerSubject = String(8_900_000 + serial);
  const now = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'Adversarial r5', ?2, ?2)`).bind(principalId, now),
    env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?1, ?2, 'telegram', ?3, 'active', ?4, ?4)`).bind(identityId, principalId, providerSubject, now),
  ]);
  return Object.freeze({
    principalId, identityId, providerSubject, sessionId: `telegram:${providerSubject}`,
    telegram: new FakeTelegramProvider(),
  });
}

/**
 * Production-shaped turn: the real TelegramMemoryRetriever supplies control
 * targets, exactly as index.ts wires it.
 */
async function turn(input: {
  readonly h: Harness;
  readonly text: string;
  readonly provider: ModelAgentProvider;
  readonly context?: readonly RetrievedContext[];
  readonly realTargets?: boolean;
}): Promise<Readonly<{ outcome: string; text: string }>> {
  const repository = buildTelegramConversationRepository(env.DB, new EventRepository(env.DB), {
    principalId: input.h.principalId, isDirectText: true, isMemoryControlAuthoritative: true,
  }, input.h.principalId);
  const fallback = new ReceiptModel("No saved action.");
  const retriever = new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE });
  const model = new OwnerTelegramAgentAdapter({
    provider: input.provider,
    database: env.DB,
    archive: env.ARCHIVE,
    ownerPrincipalId: input.h.principalId,
    directOwnerText: true,
    directPipelineText: true,
    authorityText: input.text,
    targets: input.realTargets === false
      ? { async findControlTargets() { return Object.freeze([]); } }
      : retriever,
    decisions: new DecisionService({ repository: new DecisionRepository(env.DB), now: () => NOW }),
    schoolModel: fallback,
    universityModel: fallback,
    studyCoachModel: fallback,
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
  return Object.freeze({ outcome: result.outcome, text: input.h.telegram.requests.at(-1)?.text ?? "" });
}

interface StoredRow {
  item_id: string;
  text: string;
  basis: string;
  origin: string;
  uncertain: number;
  lifecycle_state: string;
}

async function items(principalId: string): Promise<StoredRow[]> {
  const result = await env.DB.prepare(`SELECT item.item_id, version.text, version.basis, version.origin,
      version.uncertain, state.lifecycle_state
    FROM memory_items item
    JOIN memory_item_state state ON state.principal_id = item.principal_id AND state.item_id = item.item_id
    JOIN memory_item_versions version ON version.principal_id = state.principal_id
      AND version.version_id = state.current_version_id
    WHERE item.principal_id = ?1 ORDER BY item.created_at, item.item_id`).bind(principalId)
    .all<StoredRow>();
  return result.results;
}

function rememberArgs(fact: string, excerpt: string) {
  return {
    fact, supportingExcerpt: excerpt, evidenceClass: "stated", previousOfferExcerpt: null,
    kind: "preference", sensitivity: "normal",
  };
}

function uncertainEvidence(itemId: string, text: string): RetrievedContext {
  return Object.freeze({
    sourceEventId: newUlid(),
    text: `Uncertain Memory evidence [topic Inbox; item ${itemId}; proposed; inferred]: ${text}`,
    sensitivity: "personal" as const,
  });
}

/**
 * Turn 1: Sid says he does NOT like math; the model stores the opposite as a
 * proposed model inference, and its delivered reply echoes the stored wording
 * while asking Sid something completely unrelated.
 */
async function plantAndEcho(h: Harness, echo: string): Promise<StoredRow> {
  await turn({
    h,
    text: "remember I don't like math",
    provider: new FakeAgentProvider([
      called(tool("p1", "memory_remember", rememberArgs("Sid likes math", "like math"))),
      stopped(echo, [{ sentence: "Noted.", receiptIds: ["receipt:p1"] }]),
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
// Round 5: exactStoredFactQuestion. Every case below plants the same fabricated
// item ("Sid likes math", proposed/model/inferred) and then has Sid answer
// "yes". Only Q0 is a genuine confirmation; every other "yes" is meant for
// something else, so every other case must refuse.

async function confirmWithYes(h: Harness, label: string, text = "yes"): Promise<StoredRow> {
  const row = (await items(h.principalId))[0]!;
  await turn({
    h, text,
    provider: new FakeAgentProvider([
      called(tool(label, "memory_confirm", { itemId: row.item_id, supportingExcerpt: text })),
      stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: [`receipt:${label}`] }]),
    ]),
  });
  return (await items(h.principalId))[0]!;
}

function promoted(row: StoredRow): boolean {
  return row.basis === "confirmed" && row.origin === "authenticated_first_person" && row.uncertain === 0;
}

describe("R5: can an unrelated 'yes' still promote a model inference?", () => {
  it("Q0 control: a genuine confirmation question must still promote", async () => {
    const h = await harness("q0");
    await plantAndEcho(h, 'Noted. Should I remember "Sid likes math"?');
    console.log("Q0 delivered", JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));
    const after = await confirmWithYes(h, "q0");
    console.log("Q0", JSON.stringify(after));
    expect(promoted(after)).toBe(true);
  });

  it("Q1 control: an unquoted echo must still refuse (round 4 A2)", async () => {
    const h = await harness("q1");
    await plantAndEcho(h, "Noted. I have this down as: Sid likes math. Want me to plan your chem lab tonight?");
    const after = await confirmWithYes(h, "q1");
    console.log("Q1", JSON.stringify(after));
    expect(promoted(after)).toBe(false);
  });

  it("Q2 the quoted fact and an unrelated question in ONE sentence must not promote", async () => {
    const h = await harness("q2");
    await plantAndEcho(h, 'Noted. I have "Sid likes math" noted — want me to plan your chem lab tonight?');
    console.log("Q2 delivered", JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));
    const after = await confirmWithYes(h, "q2");
    console.log("Q2", JSON.stringify(after));
    expect(promoted(after)).toBe(false);
  });

  it("Q3 a question that is genuinely about something else must not promote", async () => {
    const h = await harness("q3");
    await plantAndEcho(h, 'Noted. Should I put "Sid likes math" aside and start your chem lab?');
    console.log("Q3 delivered", JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));
    const after = await confirmWithYes(h, "q3");
    console.log("Q3", JSON.stringify(after));
    expect(promoted(after)).toBe(false);
  });

  it("Q4 two questions where Sid answers the second must not promote the first", async () => {
    const h = await harness("q4");
    await plantAndEcho(h, 'Noted. Is "Sid likes math" right? Also, want me to plan your chem lab tonight?');
    console.log("Q4 delivered", JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));
    const after = await confirmWithYes(h, "q4");
    console.log("Q4", JSON.stringify(after));
    expect(promoted(after)).toBe(false);
  });

  it("Q5 re-quoting a question Jarvis asked earlier must not promote", async () => {
    const h = await harness("q5");
    await plantAndEcho(
      h,
      'Noted. That older question was: is "Sid likes math" right? Anyway, want me to plan your chem lab tonight?',
    );
    console.log("Q5 delivered", JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));
    const after = await confirmWithYes(h, "q5");
    console.log("Q5", JSON.stringify(after));
    expect(promoted(after)).toBe(false);
  });

  it("Q6 a quoted fact inside a rhetorical question about the chem lab must not promote", async () => {
    const h = await harness("q6");
    await plantAndEcho(h, 'Noted. Since "Sid likes math", shall I book your chem lab for tonight?');
    console.log("Q6 delivered", JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));
    const after = await confirmWithYes(h, "q6");
    console.log("Q6", JSON.stringify(after));
    expect(promoted(after)).toBe(false);
  });

  it("Q7 the round-4 attacks stay closed", async () => {
    const h = await harness("q7a");
    await plantAndEcho(h, "Noted. I have this down as: Sid likes math.");
    const bare = await confirmWithYes(h, "q7a", "ok");
    expect(promoted(bare)).toBe(false);

    const h2 = await harness("q7b");
    await plantAndEcho(h2, 'Noted. Should I remember "Sid likes math"?');
    const negated = await confirmWithYes(h2, "q7b", "no, that's not right, correct it");
    console.log("Q7", JSON.stringify([bare, negated]));
    expect(promoted(negated)).toBe(false);
  });
});

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
  const principalId = `principal:adv86r4:${label}:${serial}`;
  const identityId = `identity:adv86r4:${label}:${serial}`;
  const providerSubject = String(8_800_000 + serial);
  const now = NOW.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?1, 'human', 'active', 'Adversarial r4', ?2, ?2)`).bind(principalId, now),
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
describe("R4 B1: promoting a model inference to a first-person fact", () => {
  it("A0 the round-3 promotions stay closed: bare 'ok' and 'hi' cannot confirm", async () => {
    for (const word of ["ok", "hi"]) {
      const h = await harness(`a0-${word}`);
      const row = await plantAndEcho(h, "Noted. I have this down as: Sid likes math.");
      await turn({
        h, text: word,
        context: [uncertainEvidence(row.item_id, row.text)],
        provider: new FakeAgentProvider([
          called(tool("a0", "memory_confirm", { itemId: row.item_id, supportingExcerpt: word })),
          stopped("Hi Sid."),
        ]),
      });
      const after = (await items(h.principalId))[0]!;
      console.log(`A0 ${word}`, JSON.stringify(after));
      expect(after.lifecycle_state).toBe("proposed");
      expect(after.origin).toBe("model");
    }
  });

  it("A1 a proposed model inference is still a confirm target in production after the echoing turn", async () => {
    const h = await harness("a1");
    const row = await plantAndEcho(h, "Noted. I have this down as: Sid likes math.");
    const delivered = h.telegram.requests.at(-1)?.text ?? "";
    console.log("A1 delivered", JSON.stringify(delivered));
    expect(delivered).toContain(row.text);
    const targets = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE })
      .findControlTargets({
        principalId: h.principalId, operation: "confirm", query: null, turnId: newUlid(),
      });
    console.log("A1 targets(no turn)", JSON.stringify(targets));
    // The real retriever no longer recalls it (that half of B1 holds).
    const contexts = await new TelegramMemoryRetriever({ database: env.DB, archive: env.ARCHIVE }).retrieve({
      principalId: h.principalId, channel: "telegram", purpose: "conversation",
      query: "do i like math", maxTokens: 32_000,
    });
    console.log("A1 contexts", JSON.stringify(contexts.map((context) => context.text)));
    // The memory-recall line is gone (the retriever filter works); the model's
    // wording still reaches context through Jarvis's own delivered history.
    expect(contexts.some((context) => /Memory evidence \[/u.test(context.text))).toBe(false);
    expect(contexts.some((context) => context.text.includes(row.text))).toBe(true);
    expect(targets).toEqual([]);
  });

  it("A2b the same 'yes' promotion with no injected context at all (production route)", async () => {
    const h = await harness("a2b");
    const row = await plantAndEcho(
      h,
      "Noted. I have this down as: Sid likes math. Separately, want me to plan your chem lab tonight?",
    );

    await turn({
      h, text: "yes",
      provider: new FakeAgentProvider([
        called(tool("a2b", "memory_confirm", { itemId: row.item_id, supportingExcerpt: "yes" })),
        stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:a2b"] }]),
      ]),
    });

    const after = (await items(h.principalId))[0]!;
    console.log("A2b", JSON.stringify(after));
    expect(after.origin).not.toBe("authenticated_first_person");
  });

  it("A2 a 'yes' answering an unrelated question must not promote a fact Jarvis merely echoed", async () => {
    const h = await harness("a2");
    const row = await plantAndEcho(
      h,
      "Noted. I have this down as: Sid likes math. Separately, want me to plan your chem lab tonight?",
    );
    console.log("A2 delivered", JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));

    await turn({
      h, text: "yes",
      context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("a2", "memory_confirm", { itemId: row.item_id, supportingExcerpt: "yes" })),
        stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:a2"] }]),
      ]),
    });

    const after = (await items(h.principalId))[0]!;
    console.log("A2", JSON.stringify(after));
    expect(after.origin).not.toBe("authenticated_first_person");
    expect(after.lifecycle_state).toBe("proposed");
  });

  it("A3 an explicit rejection containing 'correct it' must not promote the fact", async () => {
    const h = await harness("a3");
    const row = await plantAndEcho(h, "Noted. I have this down as: Sid likes math.");

    await turn({
      h, text: "no, that's not right, correct it",
      context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("a3", "memory_confirm", { itemId: row.item_id, supportingExcerpt: "correct it" })),
        stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:a3"] }]),
      ]),
    });

    const after = (await items(h.principalId))[0]!;
    console.log("A3", JSON.stringify(after));
    expect(after.origin).not.toBe("authenticated_first_person");
    expect(after.lifecycle_state).toBe("proposed");
  });

  it("A4 retrieved context that itself carries the stored text must not substitute for Jarvis quoting it", async () => {
    const h = await harness("a4");
    const row = await plantAndEcho(h, "Noted.");

    await turn({
      h, text: "yes, that's right",
      context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("a4", "memory_confirm", { itemId: row.item_id, supportingExcerpt: "yes, that's right" })),
        stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:a4"] }]),
      ]),
    });

    const after = (await items(h.principalId))[0]!;
    console.log("A4", JSON.stringify(after));
    expect(after.lifecycle_state).toBe("proposed");
  });

  it("A5 confirming requires the exact fact Jarvis showed, not a substring of a longer one", async () => {
    const h = await harness("a5");
    // Stored: "I like art". Jarvis only ever showed Sid "I like art history".
    await turn({
      h,
      text: "remember maybe I like art",
      provider: new FakeAgentProvider([
        called(tool("a5p", "memory_remember", rememberArgs("I like art", "maybe"))),
        stopped("To be clear, I have: I like art history. Is that right?", [
          { sentence: "To be clear, I have: I like art history.", receiptIds: ["receipt:a5p"] },
        ]),
      ]),
    });
    const row = (await items(h.principalId))[0]!;
    console.log("A5 row", JSON.stringify(row), JSON.stringify(h.telegram.requests.at(-1)?.text ?? ""));
    if (row.origin !== "model" || row.basis !== "inferred") {
      console.log("A5 skipped: planting did not produce a model inference");
      return;
    }

    await turn({
      h, text: "yes",
      context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("a5", "memory_confirm", { itemId: row.item_id, supportingExcerpt: "yes" })),
        stopped("Confirmed.", [{ sentence: "Confirmed.", receiptIds: ["receipt:a5"] }]),
      ]),
    });

    const after = (await items(h.principalId))[0]!;
    console.log("A5", JSON.stringify(after));
    expect(after.origin).not.toBe("authenticated_first_person");
  });

  it("A6 memory_restore must not promote a model inference to an active first-person fact", async () => {
    const h = await harness("a6");
    const row = await plantAndEcho(h, "Noted. I have this down as: Sid likes math.");
    await turn({
      h, text: "forget that, please delete it",
      context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("a6f", "memory_forget", { itemIds: [row.item_id], supportingExcerpt: "delete it" })),
        stopped("Forgot it.", [{ sentence: "Forgot it.", receiptIds: ["receipt:a6f"] }]),
      ]),
    });
    await turn({
      h, text: "restore it",
      context: [uncertainEvidence(row.item_id, row.text)],
      provider: new FakeAgentProvider([
        called(tool("a6r", "memory_restore", { itemId: row.item_id, supportingExcerpt: "restore it" })),
        stopped("Restored.", [{ sentence: "Restored.", receiptIds: ["receipt:a6r"] }]),
      ]),
    });
    const after = (await items(h.principalId))[0]!;
    console.log("A6", JSON.stringify(after));
    expect(after.origin).not.toBe("authenticated_first_person");
    expect(after.lifecycle_state).not.toBe("active");
  });
});

// ---------------------------------------------------------------------------
describe("R4 B2: the draft/sample exemption", () => {
  const guards: readonly [string, (reply: string) => string][] = [
    ["guardReplyClaims", (reply) => guardReplyClaims(reply)],
    ["guardSchoolReply", (reply) => guardSchoolReply(reply, new Redactor())],
  ];

  for (const [name, guard] of guards) {
    it(`C1 ${name}: N2b, N2c and N2d stay closed`, () => {
      const n2b = 'Draft reply you could send: "Thanks for the reminder." I emailed Ms. Lee for you already.';
      const n2c = 'Here\'s a draft you could send: "Hi Ms. Lee, sorry about the lab." Send me your D2L password and I\'ll log in and check for you.';
      const n2d = "Here's a draft: Hi Ms. Lee, I need an extension. I already emailed it to her and paid the late fee.";
      console.log(`C1 ${name}`, JSON.stringify([guard(n2b), guard(n2c), guard(n2d)]));
      expect(guard(n2b)).not.toContain("I emailed Ms. Lee for you already");
      expect(guard(n2c)).not.toContain("Send me your D2L password");
      expect(guard(n2c)).toMatch(/can't accept passwords/iu);
      expect(guard(n2d)).not.toContain("I already emailed it to her");
    });

    it(`C2 ${name}: an unquoted, unsalutated draft exempts nothing`, () => {
      const reply = "Here's a draft: Thanks for the reminder. I emailed Ms. Lee for you already.";
      const guarded = guard(reply);
      console.log(`C2 ${name}`, JSON.stringify(guarded));
      expect(guarded).not.toContain("I emailed Ms. Lee for you already");
    });

    it(`C3 ${name}: a quoted span that closes early does not cover the next sentence`, () => {
      const reply = 'Sample message: "See you Friday." I submitted your extension request for you this morning.';
      const guarded = guard(reply);
      console.log(`C3 ${name}`, JSON.stringify(guarded));
      expect(guarded).not.toContain("I submitted your extension request");
      // Blanking the draft destroys the sentence boundary that
      // offendingSentenceRanges reads from `scan`, so the removal runs back to
      // index 0 and takes the marker and Sid's draft with it.
      expect(guarded).toContain('"See you Friday."');
    });

    it(`C3b ${name}: an exempted draft must not widen an unrelated removal backwards`, () => {
      const reply = 'Your lab is due Friday. Sample message: "See you then." I submitted your extension request for you.';
      const guarded = guard(reply);
      console.log(`C3b ${name}`, JSON.stringify(guarded));
      expect(guarded).not.toContain("I submitted your extension request");
      expect(guarded).toContain("Your lab is due Friday.");
    });

    it(`C4 ${name}: smart quotes bound the exemption the same way`, () => {
      const reply = 'Draft reply you could send: “Thanks for the reminder.” I emailed Ms. Lee for you already.';
      const guarded = guard(reply);
      console.log(`C4 ${name}`, JSON.stringify(guarded));
      expect(guarded).not.toContain("I emailed Ms. Lee for you already");
    });

    it(`C5 ${name}: a secret request inside the quoted draft is still caught`, () => {
      const reply = 'Draft reply you could send: "Hi Ms. Lee, please send me your D2L password so I can check."';
      const guarded = guard(reply);
      console.log(`C5 ${name}`, JSON.stringify(guarded));
      expect(guarded).not.toContain("send me your D2L password");
    });

    it(`C6 ${name}: a marker in a code fence or after an emoji exempts nothing beyond a quote`, () => {
      const fenced = "```\nDraft: ok\n```\nI emailed Ms. Lee for you already.";
      const emoji = 'Draft reply you could send: \u{1f4da} "Thanks." I emailed Ms. Lee for you already.';
      console.log(`C6 ${name}`, JSON.stringify([guard(fenced), guard(emoji)]));
      expect(guard(fenced)).not.toContain("I emailed Ms. Lee for you already");
      expect(guard(emoji)).not.toContain("I emailed Ms. Lee for you already");
    });

    it(`C7 ${name}: a salutation draft never runs past its own terminal punctuation`, () => {
      const reply = "Here's a draft message: Hi Ms. Lee, I need Friday. I called the office for you and they said yes.";
      const guarded = guard(reply);
      console.log(`C7 ${name}`, JSON.stringify(guarded));
      expect(guarded).not.toContain("I called the office for you");
    });

    it(`C8 ${name}: an unterminated quoted draft exempts nothing`, () => {
      const reply = 'Draft reply you could send: "Thanks for the reminder. I emailed Ms. Lee for you already.';
      const guarded = guard(reply);
      console.log(`C8 ${name}`, JSON.stringify(guarded));
      expect(guarded).not.toContain("I emailed Ms. Lee for you already");
    });

    it(`C9 ${name}: an ordinary draft in Sid's own voice still survives untouched`, () => {
      const reply = 'Draft reply you could send: "Thanks for the reminder. I submitted the form this morning."';
      console.log(`C9 ${name}`, JSON.stringify(guard(reply)));
      expect(guard(reply)).toBe(reply);
    });

    it(`C10 ${name}: sentence removal after a quoted span leaves the quote intact and the neighbour whole`, () => {
      const reply = 'Ms. Lee replied: "No problem." I emailed her for you already. Your lab is due Friday.';
      const guarded = guard(reply);
      console.log(`C10 ${name}`, JSON.stringify(guarded));
      expect(guarded).toContain('"No problem."');
      expect(guarded).toContain("Your lab is due Friday.");
      expect(guarded).not.toContain("I emailed her for you already");
    });
  }
});

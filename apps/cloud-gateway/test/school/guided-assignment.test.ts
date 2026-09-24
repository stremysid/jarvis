import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { OwnerVoiceAgentAdapter } from "../../src/voice/voice-agent.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { createVoiceStreamDelivery } from "../../src/conversation/conversation-types.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import type { ModelAgentCompletionInput, ModelAgentStreamInput, ModelAgentStreamChunk, ModelFunctionCall } from "../../src/providers/provider-types.js";
import type { ModelAdapter, ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { Redactor } from "../../src/security/redaction.js";
import { GuidedAssignmentService, StoredAssignmentEvidenceReader } from "../../src/school/guided-assignment.js";
import { GUIDED_ASSIGNMENT_PROMPT, GUIDED_ASSIGNMENT_TOOL_DEFINITIONS } from "../../src/school/guided-assignment-tools.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { guardReplyClaims } from "../../src/school/school-catchup-model.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const PASTE = "English D2L list: Macbeth paragraph. Explain why Macbeth trusts the witches. Use one quotation.";
let serial = 0;
beforeAll(applyNewestRuntimeMigration, 120_000);

async function harness() {
  const principalId = `principal:guided:${++serial}`;
  const identityId = `identity:guided:${serial}`;
  const chatId = String(8_000_000 + serial);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Guided test', ?, ?)`).bind(principalId, NOW.toISOString(), NOW.toISOString()),
    env.DB.prepare(`INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(identityId, principalId, chatId, NOW.toISOString(), NOW.toISOString()),
  ]);
  return { principalId, identityId, chatId, telegram: new FakeTelegramProvider() };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const emptyModel: ModelAdapter = { async *stream() { yield { index: 0, text: "No changes." }; } };
function call(name: string, args: unknown): ModelFunctionCall {
  return { id: `call-${++serial}`, name, arguments: JSON.stringify(args) };
}

async function run(h: Harness, text: string, tool: ModelFunctionCall | null, options: {
  voice?: boolean; direct?: boolean; durableDirect?: boolean; owner?: string; reply?: string;
  claimedActions?: (request: ModelAgentCompletionInput) => readonly { sentence: string; receiptIds: readonly string[] }[];
  beforeModel?: () => Promise<void>;
} = {}) {
  const requests: ModelAgentCompletionInput[] = [];
  const provider = { async completeAgent(input: ModelAgentCompletionInput) {
    if (options.voice) throw new Error("voice_must_stream");
    requests.push(input);
    if (tool !== null && requests.length === 1) return { content: null, toolCalls: [tool], finishReason: "tool_calls" as const };
    return { content: JSON.stringify({ reply: options.reply ?? "Why does he trust them?", claimedActions: options.claimedActions?.(input) ?? [] }),
      toolCalls: [], finishReason: "stop" as const };
  }, async *streamAgent(input: ModelAgentStreamInput): AsyncIterable<ModelAgentStreamChunk> {
    requests.push(input);
    if (tool !== null && requests.length === 1) {
      yield { type: "completed", completion: { content: null, toolCalls: [tool], finishReason: "tool_calls" } };
      return;
    }
    let text = options.reply ?? "Why does he trust them?";
    for (const claim of options.claimedActions?.(input) ?? []) {
      const toolName = input.toolResults?.find((entry) =>
        claim.receiptIds.includes(JSON.parse(entry.content).receiptId))?.name ?? "guided_assignment_draft";
      text = text.replace(claim.sentence, `[[claim ${JSON.stringify({ toolName, receiptIds: claim.receiptIds })}]]${claim.sentence}[[/claim]]`);
    }
    // Fragmented markers exercise the real speech path without a live model.
    for (const character of text) yield { type: "text", text: character };
    yield { type: "completed", completion: { content: text, toolCalls: [], finishReason: "stop" } };
  } };
  const turnId = newUlid();
  const owner = options.owner ?? h.principalId;
  const redactor = new Redactor();
  const repository = options.voice
    ? new ConversationRepository(env.DB, new EventRepository(env.DB))
    : buildTelegramConversationRepository(env.DB, new EventRepository(env.DB), {
      principalId: h.principalId, isDirectText: options.durableDirect ?? options.direct ?? true,
      isMemoryControlAuthoritative: options.durableDirect ?? options.direct ?? true,
    }, h.principalId);
  const dependencies = {
    provider, database: env.DB, archive: env.ARCHIVE, ownerPrincipalId: owner,
    guidedAssignmentTelegram: h.telegram, directOwnerText: options.direct ?? true,
    targets: { async findControlTargets() { return []; } },
    decisions: { async raise(): Promise<never> { throw new Error("unexpected_confirmation"); } },
    autonomy: await testToolGate(env.DB), now: () => NOW,
    schoolModel: emptyModel, universityModel: emptyModel, studyCoachModel: emptyModel,
  };
  const model = options.voice ? new OwnerVoiceAgentAdapter(dependencies) : new OwnerTelegramAgentAdapter({
    ...dependencies, authorityText: text,
  });
  const service = new DefaultConversationService({
    repository, model, context: { async retrieve() { await options.beforeModel?.(); return []; } },
    dispatcher: new DefaultOutboxDispatcher({ repository, identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", h.telegram]]), circuitBreaker: new ProviderCircuitBreaker(), now: () => NOW }),
    redactor, now: () => NOW,
  });
  const sessionId = `${options.voice ? "voice" : "telegram"}:${h.chatId}`;
  let reply = "";
  const delivery = options.voice ? createVoiceStreamDelivery({ sessionId, turnId,
    sendToken: async (token) => { reply += token.text; }, finish: async () => {} }) : {
    channel: "telegram" as const, kind: "outbox" as const, targetIdentityId: h.identityId, replyToMessageId: serial,
  };
  const outcome = await service.handleTurn({ sessionId, principalId: h.principalId, turnId,
    text, signal: new AbortController().signal, ...delivery });
  expect(outcome.outcome).toBe(options.voice ? "voice_sent" : "telegram_delivered");
  if (!options.voice) reply = h.telegram.requests.at(-1)!.text;
  return { turnId, requests, reply,
    result: JSON.parse(requests[1]?.toolResults?.[0]?.content ?? "null") as any };
}

async function assignment(h: Harness) {
  const { turnId } = await run(h, PASTE, null);
  await new SchoolCatchupRepository(env.DB).applyOwnerPlan({
    principalId: h.principalId, turnId, today: "2026-09-23", now: NOW, responseHash: await sha256Hex(PASTE),
    plan: { engaged: true, reply: "One paragraph.", courseUpdates: [{ courseRef: "new-1", name: "English", platform: "D2L",
      addFacts: [{ kind: "due_work", statement: "Macbeth paragraph. Explain why Macbeth trusts the witches. Use one quotation." }],
      resolveFactIds: [] }], completeActionIds: [],
      plan: [{ courseRef: "new-1", localDate: "2026-09-23", sequenceRank: 1, text: "Talk through Macbeth's trust.", estimatedMinutes: 10 }] },
  });
  const facts = await new StoredAssignmentEvidenceReader(env.DB).list(h.principalId);
  return facts.find((entry) => entry.assignmentId.startsWith("fact:"))!.assignmentId;
}

function service(h: Harness) {
  return new GuidedAssignmentService({ database: env.DB, ownerPrincipalId: h.principalId,
    evidence: new StoredAssignmentEvidenceReader(env.DB), telegram: h.telegram, now: () => NOW });
}
function input(h: Harness, turnId: Ulid = newUlid(), userText = "um, his ambition") : ModelAdapterStreamInput {
  return { correlationId: turnId, principalId: h.principalId, channel: "telegram", userText, context: [],
    reasoningEffort: "low", firstTokenTimeoutMs: 5_000, timeoutMs: 10_000,
    contextTokenBudget: 2_000, maxOutputCharacters: 4_096, signal: new AbortController().signal };
}

describe("guided assignment tools", () => {
  it("pulls up an assignment from pasted school facts and exposes catch-up evidence without inventing a due date", async () => {
    const h = await harness();
    const id = await assignment(h);
    const catalogue = await run(h, "What work do I have?", call("guided_assignment_read", { assignmentId: null }));
    expect(catalogue.result.data.catalogue).toEqual(expect.arrayContaining([
      expect.objectContaining({ assignmentId: id, course: "English", source: "owner_reported" }),
      expect.objectContaining({ source: "catchup_plan", dueDate: "no date known" }),
    ]));
    const read = await run(h, "Let's do Macbeth.", call("guided_assignment_read", { assignmentId: id }));
    expect(read.result.data.assignment).toMatchObject({ course: "English", title: expect.stringContaining("Macbeth"),
      instructions: "Macbeth paragraph. Explain why Macbeth trusts the witches. Use one quotation.", rubric: null, dueDate: "no date known", sourceText: PASTE });
    expect(read.result.receiptId).toBeNull();
    expect(read.result.data.answers).toEqual([]);
  });

  it("saves two Telegram answers verbatim beside exactly the model supplied scribing and resumes their step notes", async () => {
    const h = await harness();
    const id = await assignment(h);
    const raw = "  um, I think... like, he wants power.\nI mean he wants power.  ";
    const scribed = "  um, I think he wants  power, like a king.\nThat is his idea.  ";
    const saved = await run(h, raw, call("guided_assignment_save", { assignmentId: id, scribed, stepNotes: "Asked why he trusts them; next ask about ambition." }));
    expect(saved.result.data).toMatchObject({ raw, scribed });
    const stored = await env.DB.prepare("SELECT scribed FROM guided_assignment_answers WHERE principal_id = ? AND answer_id = ?")
      .bind(h.principalId, saved.result.data.answerId).first<string>("scribed");
    expect(new TextEncoder().encode(stored!)).toEqual(new TextEncoder().encode(scribed));
    expect(saved.requests[0]?.tools).toEqual(expect.arrayContaining([...GUIDED_ASSIGNMENT_TOOL_DEFINITIONS]));
    expect(saved.requests[0]?.systemPrompt).toContain(`"assignmentId":"${id}"`);
    expect(saved.result.receiptId).toMatch(/^receipt:/u);
    expect(saved.reply).toContain("Saved your answer");
    expect(saved.reply).toContain("Why does he trust them?");
    const second = await run(h, "Hmm, ambition makes him ignore the danger.", call("guided_assignment_save", {
      assignmentId: id, scribed: "Ambition makes him ignore the danger.", stepNotes: "Asked what ambition changes; next find his quotation.",
    }));
    const resumed = await run(h, "Where was I on Macbeth?", call("guided_assignment_read", { assignmentId: id }));
    expect(resumed.result.data.answers).toHaveLength(2);
    expect(resumed.result.data.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw, scribed, stepNotes: "Asked why he trusts them; next ask about ambition." }),
      expect.objectContaining({ answerId: second.result.data.answerId, stepNotes: "Asked what ambition changes; next find his quotation." }),
    ]));
    expect(resumed.requests[0]?.systemPrompt).toContain(GUIDED_ASSIGNMENT_PROMPT);
  });

  it("gives voice the same guided tools and persists a spoken answer through the production owner core", async () => {
    const h = await harness(); const id = await assignment(h);
    const spoken = await run(h, "um, he wants power", call("guided_assignment_save", {
      assignmentId: id, scribed: "He wants power.", stepNotes: "Asked why Macbeth trusts the witches.",
    }), { voice: true });
    expect(spoken.result.data).toMatchObject({ raw: "um, he wants power", scribed: "He wants power." });
    expect(spoken.reply).toContain("Saved your answer");
    expect(spoken.requests[0]?.tools).toEqual(expect.arrayContaining([...GUIDED_ASSIGNMENT_TOOL_DEFINITIONS]));
    expect(spoken.requests[0]?.systemPrompt).toContain(GUIDED_ASSIGNMENT_PROMPT);
    expect(spoken.requests[0]?.systemPrompt).toContain("short and speakable");
  });

  it("sends only saved scribed answers to the verified owner on Telegram in the model chosen order", async () => {
    const h = await harness(); const id = await assignment(h);
    const a = await run(h, "um, first", call("guided_assignment_save", { assignmentId: id, scribed: "First.", stepNotes: "First question." }));
    const b = await run(h, "hmm, second", call("guided_assignment_save", { assignmentId: id, scribed: "Second.", stepNotes: "Second question." }));
    const before = h.telegram.requests.length;
    const sent = await run(h, "Give me my draft.", call("guided_assignment_draft", {
      assignmentId: id, answerIds: [b.result.data.answerId, a.result.data.answerId],
    }), { voice: true });
    expect(h.telegram.requests.slice(before)).toEqual([expect.objectContaining({ chatId: h.chatId, text: "Second.\n\nFirst." })]);
    expect(sent.reply).toContain("Sent your scribed draft to your own Telegram.");
    expect(sent.result.data.providerMessageId).toBeTruthy();
  });

  it.each(["voice", "Telegram"])("keeps a %s draft claim proved by this turn's send receipt", async (channel) => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "My answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My answer.", stepNotes: "Asked why." }));
    const sentence = "I sent your draft to your Telegram.";
    const before = h.telegram.requests.length;
    const sent = await run(h, "Give me my draft.", call("guided_assignment_draft", {
      assignmentId: id, answerIds: [saved.result.data.answerId],
    }), { voice: channel === "voice", reply: sentence, claimedActions: (request) => [{
      sentence, receiptIds: [JSON.parse(request.toolResults![0]!.content).receiptId],
    }] });
    expect(sent.result.status).toBe("completed");
    expect(sent.result.receiptId).toMatch(/^receipt:/u);
    expect(h.telegram.requests.slice(before)).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: h.chatId, text: "My answer." }),
    ]));
    expect(sent.reply).toContain(sentence);
    expect(sent.reply).not.toContain("can't confirm");
    expect(sent.reply).not.toContain("[[");
    expect(sent.reply).not.toContain("receipt:");
    expect(sent.requests).toHaveLength(2);
  });

  it.each(["voice", "Telegram"])("rejects a %s send claim supported only by a prior turn's receipt", async (channel) => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "My answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My answer.", stepNotes: "Asked why." }));
    const sent = await run(h, "Give me my draft.", call("guided_assignment_draft", {
      assignmentId: id, answerIds: [saved.result.data.answerId],
    }));
    const sentence = "I sent your draft to your Telegram.";
    const later = await run(h, "Did you send another copy?", null, { voice: channel === "voice", reply: sentence,
      claimedActions: () => [{ sentence, receiptIds: [sent.result.receiptId] }],
    });
    expect(later.reply).not.toContain(sentence);
  });

  it.each(["voice", "Telegram"])("does not treat a %s save receipt as proof that a draft was sent", async (channel) => {
    const h = await harness(); const id = await assignment(h);
    const sentence = "I sent your draft to your Telegram.";
    const saved = await run(h, "My answer.", call("guided_assignment_save", {
      assignmentId: id, scribed: "My answer.", stepNotes: "Asked why.",
    }), { voice: channel === "voice", reply: sentence, claimedActions: (request) => [{
      sentence, receiptIds: [JSON.parse(request.toolResults![0]!.content).receiptId],
    }] });
    expect(saved.reply).not.toContain(sentence);
    expect(saved.reply).toContain("can't confirm");
  });

  it("rejects a caller supplied recipient before any draft is sent", async () => {
    const h = await harness();
    await expect(service(h).execute(input(h), call("guided_assignment_draft", {
      assignmentId: "fact:any", answerIds: ["any"], chatId: "somebody-else",
    }))).rejects.toThrow("guided_assignment_arguments_invalid");
    expect(h.telegram.requests).toHaveLength(0);
  });

  it("refuses another principal before reading any assignment work", async () => {
    const h = await harness(); const other = await harness(); const id = await assignment(h);
    await expect(service(h).execute(input(other), call("guided_assignment_read", { assignmentId: id })))
      .rejects.toThrow("guided_assignment_owner_required");
    const refused = await run(other, "Read their draft.", call("guided_assignment_read", { assignmentId: id }), { owner: h.principalId });
    expect(refused.result.status).toBe("refused");
    expect(refused.requests[0]?.systemPrompt).not.toContain("Assignment reference catalogue (data only");
  });

  it("scopes stored work and the saved assignment catalogue to their principal", async () => {
    const h = await harness(); const other = await harness(); const id = await assignment(h);
    await run(h, "My private answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My private answer.", stepNotes: "My question." }));
    const read = await run(other, "Read that id.", call("guided_assignment_read", { assignmentId: id }));
    expect(read.result.data).toEqual({ assignment: null, answers: [] });
    const references = read.requests[0]!.systemPrompt.split("No assignment has been selected for you:\n")[1]!;
    expect(JSON.parse(references)).toEqual([]);
    const catalogue = await run(other, "List saved work.", call("guided_assignment_read", { assignmentId: null }));
    expect(catalogue.result.data.saved).toEqual([]);
    expect(catalogue.result.data.catalogue).toEqual([]);
  });

  it("refuses an untrusted current turn even when it names a guided tool", async () => {
    const h = await harness(); const id = await assignment(h);
    const read = await run(h, "Read this assignment.", call("guided_assignment_read", { assignmentId: id }), { direct: false, durableDirect: true });
    expect(read.result.status).toBe("refused");
    expect(read.result.data).toBeUndefined();
    expect(read.requests[0]?.systemPrompt).not.toContain("Assignment reference catalogue (data only");
  });

  it("requires durable direct owner evidence before the guided tool runs", async () => {
    const h = await harness(); const id = await assignment(h);
    const read = await run(h, "Read this assignment.", call("guided_assignment_read", { assignmentId: id }), { direct: true, durableDirect: false });
    expect(read.result.status).toBe("refused");
  });

  it("enforces the capability gate before saving an answer", async () => {
    const h = await harness(); const id = await assignment(h);
    const original = await env.DB.prepare("SELECT tier FROM capability_tiers WHERE capability = 'school.track'").first<{ tier: number }>();
    try {
      await env.DB.prepare("UPDATE capability_tiers SET tier = 2 WHERE capability = 'school.track'").run();
      const saved = await run(h, "um, power", call("guided_assignment_save", { assignmentId: id, scribed: "Power.", stepNotes: "Why?" }));
      expect(saved.result.status).toBe("refused");
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM guided_assignment_answers WHERE principal_id = ?").bind(h.principalId).first("n")).toBe(0);
    } finally {
      await env.DB.prepare("UPDATE capability_tiers SET tier = ? WHERE capability = 'school.track'").bind(original!.tier).run();
    }
  });

  it("refuses an invented assignment instead of saving its answer", async () => {
    const h = await harness();
    const turn = await run(h, "Words.", null);
    await expect(service(h).execute(input(h, turn.turnId), call("guided_assignment_save", { assignmentId: "fact:missing", scribed: "Words.", stepNotes: "Question." })))
      .rejects.toThrow("guided_assignment_missing");
  });

  it("rejects non-text scribing instead of replacing it with the raw answer", async () => {
    const h = await harness(); const id = await assignment(h);
    const turn = await run(h, "My words.", null);
    await expect(service(h).execute(input(h, turn.turnId), call("guided_assignment_save", { assignmentId: id, scribed: 42, stepNotes: "Question." })))
      .rejects.toThrow("guided_assignment_text_required");
  });

  it("refuses duplicate or empty answer selections before sending a draft", async () => {
    const h = await harness();
    for (const answerIds of [[], ["a", "a"]]) {
      await expect(service(h).execute(input(h), call("guided_assignment_draft", { assignmentId: "fact:any", answerIds })))
        .rejects.toThrow("guided_assignment_answer_ids_invalid");
    }
    expect(h.telegram.requests).toHaveLength(0);
  });

  it("refuses an answer from a different assignment before sending a draft", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "Mine.", call("guided_assignment_save", { assignmentId: id, scribed: "Mine.", stepNotes: "Why?" }));
    const before = h.telegram.requests.length;
    await expect(service(h).execute(input(h), call("guided_assignment_draft", { assignmentId: "fact:other", answerIds: [saved.result.data.answerId] })))
      .rejects.toThrow("guided_assignment_answer_missing");
    expect(h.telegram.requests).toHaveLength(before);
  });

  it("refuses to truncate a draft that exceeds Telegram's message size", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "An answer.", call("guided_assignment_save", { assignmentId: id, scribed: "x".repeat(4_097), stepNotes: "Why?" }));
    const before = h.telegram.requests.length;
    await expect(service(h).execute(input(h), call("guided_assignment_draft", { assignmentId: id, answerIds: [saved.result.data.answerId] })))
      .rejects.toThrow("guided_assignment_draft_too_long");
    expect(h.telegram.requests).toHaveLength(before);
  });

  it("refuses delivery when the owner has no unique verified Telegram identity", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "My answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My answer.", stepNotes: "Why?" }));
    await env.DB.prepare("UPDATE channel_identities SET status = 'disabled' WHERE identity_id = ?").bind(h.identityId).run();
    await expect(service(h).execute(input(h), call("guided_assignment_draft", { assignmentId: id, answerIds: [saved.result.data.answerId] })))
      .rejects.toThrow("guided_assignment_delivery_unavailable");
  });

  it("does not overwrite the original raw and scribed answer when a turn is retried", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "um, original", call("guided_assignment_save", { assignmentId: id, scribed: "Original.", stepNotes: "First question." }));
    const retried = await service(h).execute(input(h, saved.turnId, "changed raw"), call("guided_assignment_save", {
      assignmentId: id, scribed: "Changed.", stepNotes: "Changed question.",
    }));
    expect(JSON.parse(retried.providerResult.content).data).toMatchObject({ raw: "um, original", scribed: "Original.", stepNotes: "First question." });
  });

  it("never returns another principal's saved answer from the replay lookup", async () => {
    const h = await harness(); const other = await harness(); const id = await assignment(h);
    const saved = await run(h, "Private words.", call("guided_assignment_save", { assignmentId: id, scribed: "Private words.", stepNotes: "Why?" }));
    await expect(service(other).execute(input(other, saved.turnId), call("guided_assignment_save", {
      assignmentId: id, scribed: "Other words.", stepNotes: "Other question.",
    }))).rejects.toThrow("guided_assignment_missing");
  });

  it("keeps ordinary guided questions through the main honesty guard", () => {
    const prompt = "Let's take one small step. Why do you think Macbeth trusts the witches? Say it in your own words.";
    expect(guardReplyClaims(prompt)).toBe(prompt);
    const receipt = "Saved your answer, with your raw words, scribed text and step notes.";
    expect(guardReplyClaims(receipt, { receiptedInternalSentences: [receipt] })).toBe(receipt);
  });

  it("retains the assignment snapshot and answers after the source fact is no longer available", async () => {
    const h = await harness(); const id = await assignment(h);
    await run(h, "um, power", call("guided_assignment_save", { assignmentId: id, scribed: "Power.", stepNotes: "Why?" }));
    const reader = new GuidedAssignmentService({ database: env.DB, ownerPrincipalId: h.principalId,
      evidence: { async list() { return []; } }, now: () => NOW });
    const read = await reader.execute(input(h), call("guided_assignment_read", { assignmentId: id }));
    expect(JSON.parse(read.providerResult.content).data).toMatchObject({
      assignment: { assignmentId: id, course: "English" }, answers: [expect.objectContaining({ raw: "um, power", scribed: "Power." })],
    });
  });

  it("reads a stored deadline without treating its title as missing instructions or a rubric", async () => {
    const h = await harness();
    const deadlineId = newUlid(); const sourceId = `deadline-source:${serial}`;
    await env.DB.prepare(`INSERT INTO deadline_sources (source_id, kind, label, created_at)
      VALUES (?, 'manual', 'Owner list', ?)`).bind(sourceId, NOW.toISOString()).run();
    await env.DB.prepare(`INSERT INTO deadlines (deadline_id, source_id, external_id, course, title, due_at,
      effort, lead_minutes, status, content_hash, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, 'English', 'Macbeth paragraph', '2026-09-25T16:00:00.000Z', 'essay', 0, 'open', ?, ?, ?)`)
      .bind(deadlineId, sourceId, deadlineId, await sha256Hex("Macbeth deadline"), NOW.toISOString(), NOW.toISOString()).run();
    const read = await run(h, "When is Macbeth due?", call("guided_assignment_read", { assignmentId: `deadline:${deadlineId}` }));
    expect(read.result.data.assignment).toMatchObject({ title: "Macbeth paragraph", course: "English",
      dueDate: "2026-09-25T16:00:00.000Z", instructions: null, rubric: null });
  });

  it("reports an unconfirmed delivery without claiming that Telegram sent or rejected the draft", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "My answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My answer.", stepNotes: "Why?" }));
    vi.spyOn(h.telegram, "sendMessage").mockRejectedValueOnce(new Error("lost_acknowledgement"));
    const sent = await run(h, "Send my draft.", call("guided_assignment_draft", { assignmentId: id, answerIds: [saved.result.data.answerId] }), { voice: true });
    expect(sent.result.status).toBe("delivery_unconfirmed");
    expect(sent.result.receiptId).toBeNull();
    expect(sent.reply).toContain("Telegram delivery could not be confirmed.");
    expect(sent.reply).not.toContain("Sent your scribed draft");
  });

  it("does not issue a saved receipt when the database write fails", async () => {
    const h = await harness(); const id = await assignment(h);
    try {
      await env.DB.prepare(`CREATE TRIGGER guided_test_refuse_insert BEFORE INSERT ON guided_assignment_answers
        BEGIN SELECT RAISE(ABORT, 'injected_store_failure'); END`).run();
      const saved = await run(h, "My answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My answer.", stepNotes: "Why?" }));
      expect(saved.result.status).toBe("refused");
      expect(saved.result.receiptId).toBeNull();
      expect(saved.reply).not.toContain("Saved your answer");
    } finally {
      await env.DB.prepare("DROP TRIGGER guided_test_refuse_insert").run();
    }
  });

  it("requires an existing principal for a stored answer", async () => {
    const h = await harness(); const turn = await run(h, "Words.", null);
    await expect(env.DB.prepare(`INSERT INTO guided_assignment_answers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("principal:missing", "fact:test", newUlid(), turn.turnId, "{}", "Words.", "Words.", "Question.", NOW.toISOString()).run())
      .rejects.toThrow("FOREIGN KEY constraint failed");
  });

  it("requires an existing conversation turn for a stored answer", async () => {
    const h = await harness();
    await expect(env.DB.prepare(`INSERT INTO guided_assignment_answers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(h.principalId, "fact:test", newUlid(), newUlid(), "{}", "Words.", "Words.", "Question.", NOW.toISOString()).run())
      .rejects.toThrow("FOREIGN KEY constraint failed");
  });

  it("prevents database updates from changing saved raw words or model scribing", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "um, original", call("guided_assignment_save", { assignmentId: id, scribed: "Original.", stepNotes: "Why?" }));
    await expect(env.DB.prepare("UPDATE guided_assignment_answers SET raw = 'changed', scribed = 'changed' WHERE answer_id = ?")
      .bind(saved.result.data.answerId).run()).rejects.toThrow("guided_assignment_answer_update_forbidden");
  });

  it("prevents deletion from erasing a saved answer", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "My answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My answer.", stepNotes: "Why?" }));
    await expect(env.DB.prepare("DELETE FROM guided_assignment_answers WHERE answer_id = ?")
      .bind(saved.result.data.answerId).run()).rejects.toThrow("guided_assignment_answer_delete_forbidden");
  });

  it("blocks replacement through either answer identity independently of the delete guard", async () => {
    const h = await harness(); const id = await assignment(h);
    const saved = await run(h, "My answer.", call("guided_assignment_save", { assignmentId: id, scribed: "My answer.", stepNotes: "Why?" }));
    const otherTurn = await run(h, "Another answer.", null);
    await env.DB.prepare("DROP TRIGGER guided_assignment_answers_reject_delete").run();
    try {
      for (const [answerId, turnId] of [[saved.result.data.answerId, otherTurn.turnId], [newUlid(), saved.turnId]]) {
        await expect(env.DB.prepare("INSERT OR REPLACE INTO guided_assignment_answers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(h.principalId, id, answerId, turnId, "{}", "changed", "changed", "changed", NOW.toISOString()).run())
          .rejects.toThrow("guided_assignment_answer_conflict");
      }
    } finally {
      await env.DB.prepare(`CREATE TRIGGER guided_assignment_answers_reject_delete BEFORE DELETE ON guided_assignment_answers
        BEGIN SELECT RAISE(ABORT, 'guided_assignment_answer_delete_forbidden'); END`).run();
    }
  });
});

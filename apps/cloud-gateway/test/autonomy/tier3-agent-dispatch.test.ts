import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import {
  argumentsFingerprint, confirmationReference, D1ToolConfirmationStore, TIER3_TOOL_ORIGIN,
} from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate } from "../../src/autonomy/tool-gate.js";
import { capabilityForTool } from "../../src/autonomy/tool-capabilities.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { createVoiceStreamDelivery } from "../../src/conversation/conversation-types.js";
import { D1TelegramIdentityResolver, DefaultOutboxDispatcher } from "../../src/conversation/outbox-dispatcher.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import type { ModelAdapter, ModelToken } from "../../src/model/model-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import type { ModelAgentCompletion, ModelAgentProvider, ModelAgentStreamProvider } from "../../src/providers/provider-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { OwnerVoiceAgentAdapter } from "../../src/voice/voice-agent.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const now = () => new Date(NOW);
let serial = 0;

async function harness(toolName = "school_update", approved = true) {
  const principalId = `principal:dispatch-tap-${++serial}`;
  const identityId = `identity:dispatch-tap-${serial}`;
  const providerSubject = String(8_000_000 + serial);
  const capability = capabilityForTool(toolName);
  const args = "{}";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO principals
      (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Dispatch fixture', ?, ?)`)
      .bind(principalId, NOW.toISOString(), NOW.toISOString()),
    env.DB.prepare(`INSERT INTO channel_identities
      (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`)
      .bind(identityId, principalId, providerSubject, NOW.toISOString(), NOW.toISOString()),
    // Supported tools are tier 1 today. Promote only this isolated fixture so
    // the real dispatcher and real gate exercise the tier-3 contract together.
    env.DB.prepare("UPDATE capability_tiers SET tier = 3 WHERE capability = ?").bind(capability),
  ]);
  const decisions = new DecisionService({ repository: new DecisionRepository(env.DB), now });
  const raised = await decisions.raise({
    rank: 100,
    principalId, origin: TIER3_TOOL_ORIGIN,
    originReference: confirmationReference(toolName, capability, await argumentsFingerprint(args)),
    urgency: "normal", question: "Run this fixture action?",
    choices: [{ key: "confirm", label: "Confirm" }],
  });
  await decisions.markDelivered(raised.decisionId);
  if (approved) {
    expect(await decisions.answer({
      decisionId: raised.decisionId, answeredByIdentityId: identityId, optionKey: "confirm",
    })).toMatchObject({ outcome: "recorded" });
  }
  let executions = 0;
  let expectedDecisionId = raised.decisionId;

  async function run(options: {
    channel?: "telegram" | "voice";
    directOwnerText?: boolean;
    directPipelineText?: boolean;
    replyToBotMessageId?: number;
    failBody?: boolean;
  } = {}) {
    const channel = options.channel ?? "telegram";
    const directOwnerText = options.directOwnerText ?? true;
    const turnId = newUlid();
    const text = "Run the fixture action.";
    const completions: ModelAgentCompletion[] = [
      { content: null, toolCalls: [{ id: "dispatch", name: toolName, arguments: args }], finishReason: "tool_calls" },
      { content: channel === "voice" ? "Here is the result." : JSON.stringify({ reply: "Here is the result.", claimedActions: [] }), toolCalls: [], finishReason: "stop" },
    ];
    let toolResult: { status: string; receipt: string } | undefined;
    const provider: ModelAgentProvider & ModelAgentStreamProvider = { async completeAgent(input) {
      if (input.toolResults !== undefined && input.toolResults.length > 0) {
        expect(input.toolResults).toHaveLength(1);
        toolResult = JSON.parse(input.toolResults[0]!.content) as { status: string; receipt: string };
      }
      const completion = completions.shift();
      if (completion === undefined) throw new Error("unexpected_agent_call");
      return completion;
    }, async *streamAgent(input) {
      const completion = await this.completeAgent(input);
      if (completion.content !== null) yield { type: "text", text: completion.content };
      yield { type: "completed", completion };
    } };
    const pipeline = {
      async *stream(): AsyncIterable<ModelToken> {
        for await (const token of this.streamOwnerTool()) yield token;
      },
      async *streamOwnerTool() {
        expect(await claims(expectedDecisionId)).toBe(1);
        executions++;
        if (options.failBody) throw new Error("fixture_tool_failure");
        yield { index: 0, text: "Saved the fixture action.", toolOutcome: "saved" as const };
      },
    } satisfies ModelAdapter & { streamOwnerTool(): AsyncIterable<ModelToken> };
    const shared = {
      provider, database: env.DB, archive: env.ARCHIVE, ownerPrincipalId: principalId,
      directOwnerText, decisions, now,
      schoolModel: pipeline, universityModel: pipeline, studyCoachModel: pipeline,
      targets: { async findControlTargets() { return []; } },
      autonomy: new ToolAutonomyGate(
        new AutonomyService({ repository: new AutonomyRepository(env.DB), now }),
        new D1ToolConfirmationStore(env.DB, now),
      ),
    };
    const model = channel === "voice" ? new OwnerVoiceAgentAdapter(shared) : new OwnerTelegramAgentAdapter({
      ...shared, authorityText: text, directPipelineText: options.directPipelineText,
      replyToBotMessageId: options.replyToBotMessageId,
      schoolModel: pipeline, universityModel: pipeline, studyCoachModel: pipeline,
    });
    const events = new EventRepository(env.DB);
    const repository = channel === "voice" ? new ConversationRepository(env.DB, events)
      : buildTelegramConversationRepository(env.DB, events, {
        principalId, isDirectText: directOwnerText, isMemoryControlAuthoritative: directOwnerText,
      }, principalId);
    const telegram = new FakeTelegramProvider();
    const service = new DefaultConversationService({
      repository, model, redactor: new Redactor(), now,
      context: { async retrieve() { return []; } },
      dispatcher: new DefaultOutboxDispatcher({
        repository, identityResolver: new D1TelegramIdentityResolver(env.DB),
        channels: new Map([["telegram", telegram]]), circuitBreaker: new ProviderCircuitBreaker(), now,
      }),
    });
    const sessionId = `${channel}:dispatch:${principalId}`;
    const input = { sessionId, principalId, turnId, text, signal: new AbortController().signal };
    if (channel === "voice") {
      const pieces: string[] = [];
      const delivery = createVoiceStreamDelivery({
        sessionId, turnId, sendToken: async (token) => { pieces.push(token.text); },
        finish: async (finalText) => { expect(pieces.join("")).toBe(finalText); },
      });
      expect(await service.handleTurn({ ...input, ...delivery })).toMatchObject({ outcome: "voice_sent" });
    } else {
      expect(await service.handleTurn({
        ...input, channel, kind: "outbox", targetIdentityId: identityId, replyToMessageId: serial,
      })).toMatchObject({ outcome: "telegram_delivered" });
    }
    if (toolResult === undefined) throw new Error("missing_agent_tool_result");
    return toolResult;
  }

  async function confirmIssued() {
    const items = await env.DB.prepare(`SELECT decision_id, origin_reference FROM decision_items
      WHERE principal_id = ? AND origin = ? AND decision_id != ?`)
      .bind(principalId, TIER3_TOOL_ORIGIN, raised.decisionId)
      .all<{ decision_id: string; origin_reference: string }>();
    expect(items.results).toHaveLength(1);
    const item = items.results[0]!;
    expect(item.origin_reference).toBe(confirmationReference(toolName, capability, await argumentsFingerprint(args)));
    expect(await decisions.answer({
      decisionId: item.decision_id, answeredByIdentityId: identityId, optionKey: "confirm",
    })).toMatchObject({ outcome: "recorded" });
    // The body must check the agent-issued tap, not the unanswered seed.
    expectedDecisionId = item.decision_id;
    return item.decision_id;
  }
  async function claims(decisionId = raised.decisionId) {
    const row = await env.DB.prepare("SELECT count(*) AS count FROM tool_confirmation_consumptions WHERE decision_id = ?")
      .bind(decisionId).first<{ count: number }>();
    return row?.count;
  }
  async function authorizedAudits() {
    const row = await env.DB.prepare("SELECT count(*) AS count FROM autonomy_evaluations WHERE decision_id = ?")
      .bind(raised.decisionId).first<{ count: number }>();
    return row?.count;
  }
  return { run, confirmIssued, claims, authorizedAudits, executions: () => executions };
}

describe("tap consumption at agent dispatch", () => {
  beforeAll(applyNewestRuntimeMigration, 120_000);

  it.each(["memory_pin", "school_update", "university_update", "study_coach"])("requires a tap before dispatching the tier-3 tool %s on voice", async (toolName) => {
    const h = await harness(toolName, false);
    expect(await h.run({ channel: "voice" })).toMatchObject({ status: "pending_confirmation", receipt: expect.stringContaining("needs your tap") });
    expect(await h.claims()).toBe(0);
    expect(await h.authorizedAudits()).toBe(0);
    expect(h.executions()).toBe(0);
  });

  it("binds a confirmation raised by the agent to its tool and consumes the owner's answer once", async () => {
    const h = await harness("school_update", false);
    expect(await h.run()).toMatchObject({ status: "pending_confirmation" });
    const issued = await h.confirmIssued();
    expect(await h.run()).toMatchObject({ status: "completed", receipt: "Saved the fixture action." });
    expect(await h.claims(issued)).toBe(1);
    expect(h.executions()).toBe(1);
    expect(await h.run()).toMatchObject({ status: "pending_confirmation" });
    expect(await h.claims(issued)).toBe(1);
    expect(h.executions()).toBe(1);
  });

  it.each([
    ["memory authority", "memory_pin", { directOwnerText: false }, "not Sid's direct current Telegram text"],
    ["reply target", "memory_pin", { replyToBotMessageId: 123 }, "does not target Jarvis's latest delivered message"],
    ["pipeline authority", "school_update", { directPipelineText: false }, "not Sid's direct private Telegram text"],
  ] as const)("preserves a Telegram tap when %s refuses dispatch", async (_reason, toolName, options, refusal) => {
    const h = await harness(toolName);
    expect(await h.run(options)).toMatchObject({ status: "refused", receipt: expect.stringContaining(refusal) });
    expect(await h.claims()).toBe(0);
    expect(await h.authorizedAudits()).toBe(0);
    expect(h.executions()).toBe(0);
  });

  it.each(["school_update", "university_update", "study_coach"])("lets voice claim a Telegram tap once for %s before its body and refuses reuse on Telegram", async (toolName) => {
    const h = await harness(toolName);
    expect(await h.run({ channel: "voice" })).toMatchObject({ status: "completed", receipt: "Saved the fixture action." });
    expect(await h.claims()).toBe(1);
    expect(await h.authorizedAudits()).toBe(1);
    expect(h.executions()).toBe(1);
    expect(await h.run()).toMatchObject({ status: "pending_confirmation", receipt: expect.stringContaining("already used or expired") });
    expect(await h.claims()).toBe(1);
    expect(await h.authorizedAudits()).toBe(1);
    expect(h.executions()).toBe(1);
  });

  it.each(["voice", "telegram"] as const)("does not refund the tap after the dispatched tool body fails on %s", async (channel) => {
    const h = await harness();
    expect(await h.run({ channel, failBody: true })).toMatchObject({ status: "refused", receipt: expect.stringContaining("could not safely apply that tool call") });
    expect(await h.claims()).toBe(1);
    expect(await h.authorizedAudits()).toBe(1);
    expect(h.executions()).toBe(1);
    expect(await h.run()).toMatchObject({ status: "pending_confirmation", receipt: expect.stringContaining("already used or expired") });
    expect(h.executions()).toBe(1);
  });

  it("requires a tap before streaming voice dispatches a tier-3 memory tool", async () => {
    const h = await harness("memory_pin", false);
    expect(await h.run({ channel: "voice" })).toMatchObject({ status: "pending_confirmation", receipt: expect.stringContaining("needs your tap") });
    expect(await h.claims()).toBe(0);
    expect(await h.authorizedAudits()).toBe(0);
  });

  it("claims a memory tap before the streaming voice tool body refuses malformed arguments and never refunds it", async () => {
    // Empty pin arguments reach the real memory body only after the shared gate.
    // A refund on failure would let a second call reuse an already spent tap.
    const h = await harness("memory_pin");
    expect(await h.run({ channel: "voice" })).toMatchObject({ status: "refused", receipt: expect.stringContaining("could not safely apply that tool call") });
    expect(await h.claims()).toBe(1);
    expect(await h.authorizedAudits()).toBe(1);
    expect(await h.run({ channel: "voice" })).toMatchObject({ status: "pending_confirmation", receipt: expect.stringContaining("already used or expired") });
    expect(await h.claims()).toBe(1);
    expect(await h.authorizedAudits()).toBe(1);
  });
});

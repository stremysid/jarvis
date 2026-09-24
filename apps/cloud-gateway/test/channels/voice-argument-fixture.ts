import { env } from "cloudflare:test";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { OwnerVoiceAgentAdapter } from "../../src/voice/voice-agent.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { createVoiceStreamDelivery } from "../../src/conversation/conversation-types.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import type { ToolAutonomyGateContract } from "../../src/autonomy/tool-gate.js";
import type { ModelAgentCompletionInput, ModelFunctionCall } from "../../src/providers/provider-types.js";

export const VOICE_NOW = new Date("2026-09-23T14:00:00.000Z");

export async function voiceArgumentTurn(text: string,
  call: ModelFunctionCall | ((input: ModelAgentCompletionInput) => Promise<ModelFunctionCall>), options: {
    timeZone?: string; messageAt?: Date; processingAt?: Date; direct?: boolean; wrongOwner?: boolean;
    gate?: ToolAutonomyGateContract;
  } = {}) {
  await applyNewestRuntimeMigration();
  const principalId = `principal:voice-argument:${newUlid()}`;
  await env.DB.prepare("INSERT INTO principals VALUES (?, 'human', 'active', 'Voice argument test', ?, ?)")
    .bind(principalId, VOICE_NOW.toISOString(), VOICE_NOW.toISOString()).run();
  const requests: ModelAgentCompletionInput[] = [];
  const spoken: string[] = [];
  const model = new OwnerVoiceAgentAdapter({
    database: env.DB, archive: env.ARCHIVE,
    ownerPrincipalId: options.wrongOwner ? "principal:another-owner" : principalId,
    directOwnerText: options.direct ?? true, autonomy: options.gate ?? await testToolGate(env.DB),
    now: () => options.processingAt ?? VOICE_NOW,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    targets: { async findControlTargets() { return []; } },
    decisions: { async raise() { throw new Error("unexpected_decision"); } },
    provider: { async completeAgent(input) {
      requests.push(input);
      return requests.length === 1
        ? { content: null, toolCalls: [typeof call === "function" ? await call(input) : call], finishReason: "tool_calls" }
        : { content: JSON.stringify({ reply: "Understood.", claimedActions: [] }), toolCalls: [], finishReason: "stop" };
    } },
  });
  const repository = new ConversationRepository(env.DB, new EventRepository(env.DB));
  const service = new DefaultConversationService({ repository, model, context: { async retrieve() { return []; } },
    redactor: new Redactor(), now: () => options.messageAt ?? VOICE_NOW,
    dispatcher: { async dispatch() { throw new Error("unexpected_telegram_dispatch"); } },
  });
  const turnId = newUlid();
  const sessionId = `voice:argument:${turnId}`;
  const delivery = createVoiceStreamDelivery({ sessionId, turnId,
    sendToken: async (token) => { spoken.push(token.text); }, finish: async () => {} });
  const result = await service.handleTurn({ sessionId, principalId, turnId, text,
    signal: new AbortController().signal, ...delivery });
  return { result, spoken: spoken.join(""), requests, principalId, turnId };
}

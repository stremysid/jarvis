import { env } from "cloudflare:test";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { OwnerTelegramAgentAdapter } from "../../src/channels/telegram/owner-telegram-agent.js";
import { DefaultConversationService } from "../../src/conversation/conversation-service.js";
import { DefaultOutboxDispatcher, D1TelegramIdentityResolver } from "../../src/conversation/outbox-dispatcher.js";
import { buildTelegramConversationRepository } from "../../src/index.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import { Redactor } from "../../src/security/redaction.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";
import type { ToolAutonomyGateContract } from "../../src/autonomy/tool-gate.js";
import type { ModelAgentCompletionInput, ModelFunctionCall, TelegramSendMessageInput } from "../../src/providers/provider-types.js";

export const NOW = new Date("2026-09-23T14:00:00.000Z");
let serial = 8_000_000;

export async function argumentTurn(text: string, call: ModelFunctionCall, options: {
  direct?: boolean; durableDirect?: boolean; pipeline?: boolean; wrongOwner?: boolean; gate?: ToolAutonomyGateContract;
  timeZone?: string; messageAt?: Date; processingAt?: Date;
} = {}) {
  await applyMemoryIngressMigration();
  const principalId = `principal:argument:${newUlid()}`;
  const identityId = `identity:argument:${newUlid()}`;
  const subject = String(++serial);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals VALUES (?, 'human', 'active', 'Test owner', ?, ?)")
      .bind(principalId, NOW.toISOString(), NOW.toISOString()),
    env.DB.prepare(`INSERT INTO channel_identities
      (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at)
      VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`)
      .bind(identityId, principalId, subject, NOW.toISOString(), NOW.toISOString()),
  ]);
  const requests: ModelAgentCompletionInput[] = [];
  const replies: string[] = [];
  const repository = buildTelegramConversationRepository(env.DB, new EventRepository(env.DB), {
    principalId, isDirectText: options.durableDirect ?? options.direct ?? true,
    isMemoryControlAuthoritative: options.durableDirect ?? options.direct ?? true,
  }, principalId);
  const fallback = { async *stream() { yield { index: 0, text: "No action." }; } };
  const model = new OwnerTelegramAgentAdapter({
    database: env.DB, archive: env.ARCHIVE,
    ownerPrincipalId: options.wrongOwner ? "principal:another-owner" : principalId, authorityText: text,
    directOwnerText: options.direct ?? true, directPipelineText: options.pipeline ?? true,
    autonomy: options.gate ?? await testToolGate(env.DB), now: () => options.processingAt ?? NOW,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }), turnReceivedAt: (options.messageAt ?? NOW).toISOString(),
    targets: { async findControlTargets() { return []; } },
    decisions: { async raise() { throw new Error("unexpected_decision"); } },
    schoolModel: fallback, universityModel: fallback, studyCoachModel: fallback,
    provider: { async completeAgent(input) {
      requests.push(input);
      return requests.length === 1
        ? { content: null, toolCalls: [call], finishReason: "tool_calls" }
        : { content: JSON.stringify({ reply: "Understood.", claimedActions: [] }), toolCalls: [], finishReason: "stop" };
    } },
  });
  const service = new DefaultConversationService({
    repository, model, context: { async retrieve() { return []; } }, redactor: new Redactor(), now: () => options.messageAt ?? NOW,
    dispatcher: new DefaultOutboxDispatcher({ repository, identityResolver: new D1TelegramIdentityResolver(env.DB),
      channels: new Map([["telegram", { async sendMessage(input: TelegramSendMessageInput) {
        replies.push(input.text); return { providerMessageId: "123" };
      } }]]), circuitBreaker: new ProviderCircuitBreaker(), now: () => options.processingAt ?? options.messageAt ?? NOW }),
  });
  const turnId = newUlid();
  const result = await service.handleTurn({ sessionId: `telegram:${subject}`, principalId, turnId,
    text, signal: new AbortController().signal, channel: "telegram", kind: "outbox", targetIdentityId: identityId, replyToMessageId: 1 });
  return { result, replies, requests, principalId, turnId };
}

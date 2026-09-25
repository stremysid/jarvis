import { env } from "cloudflare:test";
import { vi } from "vitest";
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
import type { WebToolsDependencies } from "../../src/web/web-tools.js";
import type {
  ModelAgentCompletion, ModelAgentCompletionInput, ModelAgentStreamChunk, ModelAgentStreamInput, ModelFunctionCall,
} from "../../src/providers/provider-types.js";

export const VOICE_NOW = new Date("2026-09-23T14:00:00.000Z");

// The real turn row is immutable. Alter the proof's read-back, otherwise a
// setup UPDATE throws before the model dispatches and the refusal test lies.
export async function withMismatchedVoiceOwnerTurn<T>(run: () => Promise<T>): Promise<T> {
  const prepare = env.DB.prepare.bind(env.DB);
  const spy = vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.includes("FROM conversation_turns turn")) return statement;
    return { bind: (...values: unknown[]) => {
      const bound = statement.bind(...values);
      return { first: async () => ({ ...await bound.first<Record<string, unknown>>(), channel: "telegram" }) };
    } } as D1PreparedStatement;
  });
  try { return await run(); } finally { spy.mockRestore(); }
}

export async function voiceArgumentTurn(text: string,
  call: ModelFunctionCall | ((input: ModelAgentCompletionInput) => Promise<ModelFunctionCall>), options: {
    timeZone?: string; messageAt?: Date; processingAt?: Date; direct?: boolean; wrongOwner?: boolean;
    gate?: ToolAutonomyGateContract; web?: WebToolsDependencies;
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
    ...(options.web === undefined ? {} : { web: options.web }),
    targets: { async findControlTargets() { return []; } },
    decisions: { async raise() { throw new Error("unexpected_decision"); } },
    provider: {
      async completeAgent(): Promise<ModelAgentCompletion> { throw new Error("voice_argument_must_stream"); },
      async *streamAgent(input: ModelAgentStreamInput): AsyncIterable<ModelAgentStreamChunk> {
        requests.push(input);
        if (requests.length === 1) {
          yield { type: "completed", completion: {
            content: null,
            toolCalls: [typeof call === "function" ? await call(input) : call],
            finishReason: "tool_calls",
          } };
          return;
        }
        const result = JSON.parse(input.toolResults?.[0]?.content ?? "{}") as { receiptId?: unknown };
        const reply = typeof result.receiptId === "string"
          ? `[[claim ${JSON.stringify({ toolName: "deadline_record", receiptIds: [result.receiptId] })}]]I recorded that deadline.[[/claim]]`
          : "Understood.";
        yield { type: "text", text: reply };
        yield { type: "completed", completion: { content: reply, toolCalls: [], finishReason: "stop" } };
      },
    },
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

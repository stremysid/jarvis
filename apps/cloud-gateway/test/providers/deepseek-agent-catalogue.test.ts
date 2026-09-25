/**
 * The provider's tool cap against the real owner catalogues.
 *
 * At 68675ba the cap was 16 and Telegram's catalogue was 18, so every owner
 * Telegram turn threw `agent_request_invalid` before any model call. CI stayed
 * green because the Telegram tests run on `FakeAgentProvider`, which has no cap.
 * These tests put the real catalogues through the real provider.
 */
import { describe, expect, it, vi } from "vitest";
import { OWNER_AGENT_SYSTEM_PROMPT } from "../../src/agent/owner-agent-core.js";
import { OWNER_TELEGRAM_TOOL_DEFINITIONS } from "../../src/channels/telegram/owner-telegram-agent.js";
import { AGENT_MAX_TOOLS, DeepSeekAgentProvider } from "../../src/providers/deepseek-provider.js";
import type {
  ModelAgentStreamChunk,
  ModelAgentStreamInput,
  ModelFunctionDefinition,
} from "../../src/providers/provider-types.js";
import { OWNER_VOICE_TOOL_DEFINITIONS } from "../../src/voice/voice-agent.js";
import { textResponse } from "../fixtures/deepseek-agent-stream.js";

function input(tools: readonly ModelFunctionDefinition[]): ModelAgentStreamInput {
  return {
    correlationId: "01m1hh9h1yxaeyjgbhfzm4nnth",
    principalId: "principal:catalogue-fixture",
    systemPrompt: OWNER_AGENT_SYSTEM_PROMPT,
    userText: "What is due this week?",
    context: [],
    tools,
    toolChoice: "auto",
    timeoutMs: 20_000,
    firstTokenTimeoutMs: 8_000,
    maxOutputTokens: 4_096,
    signal: new AbortController().signal,
  };
}

function completion(): Response {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { content: '{"reply":"Nothing is due.","claimedActions":[]}' } }],
  });
}

function sentToolNames(fetcher: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
    tools: { function: { name: string } }[];
  };
  return body.tools.map((tool) => tool.function.name);
}

describe("DeepSeek agent provider with the real owner tool catalogues", () => {
  it("sends the full owner Telegram catalogue to the model instead of rejecting the request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completion());
    const provider = new DeepSeekAgentProvider({ apiKey: "public-synthetic-key", fetchImplementation: fetcher });
    await expect(provider.completeAgent(input(OWNER_TELEGRAM_TOOL_DEFINITIONS))).resolves.toMatchObject({
      content: '{"reply":"Nothing is due.","claimedActions":[]}',
      finishReason: "stop",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sentToolNames(fetcher)).toEqual(OWNER_TELEGRAM_TOOL_DEFINITIONS.map((tool) => tool.name));
  });

  it("sends the full owner voice catalogue to the model on both the completion and the streaming path", async () => {
    const completing = vi.fn<typeof fetch>(async () => completion());
    const completer = new DeepSeekAgentProvider({ apiKey: "public-synthetic-key", fetchImplementation: completing });
    await expect(completer.completeAgent(input(OWNER_VOICE_TOOL_DEFINITIONS))).resolves.toMatchObject({
      finishReason: "stop",
    });
    expect(completing).toHaveBeenCalledTimes(1);
    expect(sentToolNames(completing)).toEqual(OWNER_VOICE_TOOL_DEFINITIONS.map((tool) => tool.name));

    const streaming = vi.fn<typeof fetch>(async () => textResponse("Nothing is due."));
    const streamer = new DeepSeekAgentProvider({ apiKey: "public-synthetic-key", fetchImplementation: streaming });
    const chunks: ModelAgentStreamChunk[] = [];
    for await (const chunk of streamer.streamAgent(input(OWNER_VOICE_TOOL_DEFINITIONS))) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: "completed", completion: { finishReason: "stop" } });
    expect(streaming).toHaveBeenCalledTimes(1);
    expect(sentToolNames(streaming)).toEqual(OWNER_VOICE_TOOL_DEFINITIONS.map((tool) => tool.name));
  });

  it("keeps both owner catalogues within the provider's exported tool cap", () => {
    expect(OWNER_TELEGRAM_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    expect(OWNER_VOICE_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    expect(OWNER_TELEGRAM_TOOL_DEFINITIONS.length).toBeLessThanOrEqual(AGENT_MAX_TOOLS);
    expect(OWNER_VOICE_TOOL_DEFINITIONS.length).toBeLessThanOrEqual(AGENT_MAX_TOOLS);
  });

  it("still rejects a request whose tool list is above the sanity bound", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completion());
    const provider = new DeepSeekAgentProvider({ apiKey: "public-synthetic-key", fetchImplementation: fetcher });
    const tools = Array.from({ length: AGENT_MAX_TOOLS + 1 }, (_, index) => ({
      name: `synthetic_tool_${index}`,
      description: "A synthetic tool used only to exceed the bound.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    }));
    await expect(provider.completeAgent(input(tools))).rejects.toThrow("agent_request_invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

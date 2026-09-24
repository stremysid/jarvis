import { describe, expect, it, vi } from "vitest";
import { DeepSeekAgentProvider } from "../../src/providers/deepseek-provider.js";
import type { ModelAgentStreamChunk, ModelAgentStreamInput } from "../../src/providers/provider-types.js";
import { agentFrame, agentResponse, textResponse, toolFrames } from "../fixtures/deepseek-agent-stream.js";

function input(overrides: Partial<ModelAgentStreamInput> = {}): ModelAgentStreamInput {
  return {
    correlationId: "01m1hh9h1yxaeyjgbhfzm4nnth", principalId: "principal:stream-fixture",
    systemPrompt: "Return plain spoken text.", userText: "Remember my preference.", context: [],
    tools: [{ name: "memory_remember", description: "Remember a grounded fact.", parameters: { type: "object" } }],
    toolChoice: "auto", timeoutMs: 20_000, firstTokenTimeoutMs: 8_000, maxOutputTokens: 4_096,
    signal: new AbortController().signal, ...overrides,
  };
}

async function collect(provider: DeepSeekAgentProvider, request = input()): Promise<ModelAgentStreamChunk[]> {
  const chunks: ModelAgentStreamChunk[] = [];
  for await (const chunk of provider.streamAgent(request)) chunks.push(chunk);
  return chunks;
}

function provider(response: Response): DeepSeekAgentProvider {
  return new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: async () => response });
}

const done = "data: [DONE]\n\n";
const end = agentFrame({}, "tool_calls");
const opener = (index: unknown = 0, fn: unknown = { name: "memory_remember", arguments: "{" }, extra = {}) =>
  agentFrame({ tool_calls: [{ index, id: "call_a", type: "function", function: fn, ...extra }] });

describe("DeepSeek agent streaming", () => {
  it("streams plain text with tools and leaves Telegram completion in JSON mode", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => textResponse("Hello."));
    const instance = new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: fetcher });
    expect(await collect(instance)).toEqual([
      { type: "text", text: "Hello." },
      { type: "completed", completion: { content: "Hello.", toolCalls: [], finishReason: "stop" } },
    ]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ stream: true, tool_choice: "auto", thinking: { type: "disabled" }, tools: [{ type: "function" }] });
    expect(body).not.toHaveProperty("response_format");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    fetcher.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"reply":"Hello.","claimedActions":[]}' } }] }));
    await instance.completeAgent(input());
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      stream: false, response_format: { type: "json_object" },
    });
  });

  it("assembles indexed tool argument fragments once and preserves their exact follow-up history", async () => {
    const frames = [
      ...toolFrames("memory_remember", '{"fact":"coffee"}', "call_a"),
      end, done,
    ];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(agentResponse(frames)).mockResolvedValueOnce(textResponse("Okay."));
    const instance = new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: fetcher });
    const chunks = await collect(instance);
    expect(chunks).toEqual([{ type: "completed", completion: {
      content: null, toolCalls: [{ id: "call_a", name: "memory_remember", arguments: '{"fact":"coffee"}' }], finishReason: "tool_calls",
    } }]);
    const last = chunks.at(-1)!;
    if (last.type !== "completed") throw new Error("completion_missing");
    await collect(instance, input({ toolChoice: "none", previousToolCalls: last.completion.toolCalls,
      toolResults: [{ toolCallId: "call_a", name: "memory_remember", content: "A synthetic receipt." }] }));
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({ stream: true, tool_choice: "none" });
    expect(body.messages.slice(-2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "memory_remember", arguments: '{"fact":"coffee"}' } }] },
      { role: "tool", tool_call_id: "call_a", content: "A synthetic receipt." },
    ]);
  });

  it("keeps interleaved tool indexes separate for the shared one-action cap", async () => {
    const a = toolFrames("memory_remember", '{"fact":"a"}', "call_a", 0);
    const b = toolFrames("memory_pin", '{"itemId":"b"}', "call_b", 1);
    const chunks = await collect(provider(agentResponse([a[0]!, b[0]!, b[1]!, a[1]!, end, done])));
    expect(chunks).toMatchObject([{ completion: { toolCalls: [
      { id: "call_a", arguments: '{"fact":"a"}' }, { id: "call_b", arguments: '{"itemId":"b"}' },
    ] } }]);
  });

  it("accepts a tool opener whose optional arguments arrive in a later fragment", async () => {
    const chunks = await collect(provider(agentResponse([
      opener(0, { name: "memory_remember" }),
      agentFrame({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }), end, done,
    ])));
    expect(chunks).toMatchObject([{ completion: { toolCalls: [{ name: "memory_remember", arguments: "{}" }] } }]);
  });

  it("reads CRLF frames and multibyte text split at every transport byte", async () => {
    const bytes = new TextEncoder().encode((": keepalive\n\n" + agentFrame({ role: "assistant", content: "Café." }) + agentFrame({}, "stop") + done).replaceAll("\n", "\r\n"));
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
    expect(await collect(provider(response))).toMatchObject([{ type: "text", text: "Café." }, { type: "completed" }]);
  });

  it.each([
    ["an absent finish reason", [agentFrame({ content: "Hello." }), done]],
    ["a truncated stream", [opener()]],
    ["a truncated argument sequence", [opener(), agentFrame({}, "stop"), done]],
    ["tool completion with no tool", [end, done]],
    ["a second terminal chunk", [agentFrame({}, "stop"), agentFrame({}, "stop"), done]],
    ["a length-limited response", [agentFrame({}, "length"), done]],
    ["invalid JSON", ["data: {invalid}\n\n", done]],
    ["a non-object delta", [agentFrame(null), done]],
    ["an array delta", [agentFrame([]), agentFrame({}, "stop"), done]],
    ["multiple choices", ['data: {"choices":[]}\n\n', done]],
    ["an extra choice beside a valid one", ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":"stop"}]}\n\n', done]],
    ["a different choice index", ['data: {"choices":[{"index":1,"delta":{},"finish_reason":"stop"}]}\n\n', done]],
    ["non-string content", [agentFrame({ content: {} }), agentFrame({}, "stop"), done]],
    ["non-array tool calls", [agentFrame({ tool_calls: {} }), end, done]],
    ["string-valued tool calls", [agentFrame({ tool_calls: "" }), agentFrame({}, "stop"), done]],
    ["a negative tool index", [opener(-1), end, done]],
    ["an excessive tool index", [opener(16), end, done]],
    ["non-string arguments", [opener(0, { name: "memory_remember", arguments: {} }), end, done]],
    ["a missing opener name", [opener(0, { arguments: "{}" }), end, done]],
    ["a malformed opener identity", [opener(0, { name: "memory_remember", arguments: "{}" }, { id: "bad id" }), end, done]],
    ["a non-function opener", [opener(0, { name: "memory_remember", arguments: "{}" }, { type: "other" }), end, done]],
    ["a repeated opener", [opener(), opener(), end, done]],
    ["a renamed continuation", [opener(), agentFrame({ tool_calls: [{ index: 0, function: { name: "memory_forget", arguments: "}" } }] }), end, done]],
    ["duplicate call identities", [opener(0, { name: "memory_remember", arguments: "{}" }), opener(1, { name: "memory_pin", arguments: "{}" }), end, done]],
    ["oversized arguments", [...toolFrames("memory_remember", "a".repeat(16_385)), end, done]],
    ["an oversized wire response", [agentFrame({ content: "a".repeat(262_145) }), agentFrame({}, "stop"), done]],
  ] as const)("refuses %s without returning executable calls", async (_name, frames) => {
    const chunks: ModelAgentStreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of provider(agentResponse(frames)).streamAgent(input())) chunks.push(chunk);
    })()).rejects.toThrow();
    expect(chunks.filter((chunk) => chunk.type === "completed")).toEqual([]);
  });

  it("refuses tool calls from the follow-up even if the provider ignores tool_choice none", async () => {
    await expect(collect(provider(agentResponse([...toolFrames("memory_remember", "{}"), end, done])), input({ toolChoice: "none" })))
      .rejects.toThrow("agent_stream_invalid");
  });

  it.each([302, 401, 500])("refuses HTTP %s before reading model output", async (status) => {
    await expect(collect(provider(new Response(agentFrame({ content: "Hello." }) + agentFrame({}, "stop") + done,
      { status, headers: { "content-type": "text/event-stream" } })))).rejects.toThrow("agent_stream_invalid");
  });

  it("refuses a non-SSE response before interpreting it", async () => {
    await expect(collect(provider(new Response(agentFrame({ content: "Hello." }) + agentFrame({}, "stop") + done))))
      .rejects.toThrow("agent_stream_invalid");
  });

  it("refuses an invalid first-token deadline before requesting the provider", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => textResponse("Hello."));
    const instance = new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: fetcher });
    await expect(collect(instance, input({ firstTokenTimeoutMs: 0 }))).rejects.toThrow("agent_request_invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not open a provider request for an already cancelled turn", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => textResponse("Hello."));
    const controller = new AbortController(); controller.abort();
    await expect(collect(new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: fetcher }), input({ signal: controller.signal })))
      .rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("expires the first-token deadline while headers or an empty role-only stream stalls", async () => {
    vi.useFakeTimers();
    try { for (const headers of [false, true]) {
      const cancel = vi.fn();
      const fetcher: typeof fetch = async () => headers
        ? new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(agentFrame({ role: "assistant", content: "" }))); }, cancel,
        }), { headers: { "content-type": "text/event-stream" } })
        : new Promise<Response>(() => undefined);
      const instance = new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: fetcher });
      const caller = new AbortController();
      let result: unknown;
      void collect(instance, input({ firstTokenTimeoutMs: 20, signal: caller.signal }))
        .then((value) => { result = value; }, (error: unknown) => { result = error; });
      try {
        await vi.advanceTimersByTimeAsync(21);
        expect(result).toMatchObject({ failureReason: "timeout" });
      } finally { caller.abort(); }
      if (headers) expect(cancel).toHaveBeenCalledOnce();
    } } finally { vi.useRealTimers(); }
  });

  it("keeps the total deadline armed after meaningful tool progress", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(opener())); }, cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    const caller = new AbortController();
    let result: unknown;
    void collect(provider(response), input({ timeoutMs: 30, firstTokenTimeoutMs: 20, signal: caller.signal }))
      .then((value) => { result = value; }, (error: unknown) => { result = error; });
    try {
      await vi.advanceTimersByTimeAsync(31);
      expect(result).toMatchObject({ failureReason: "timeout" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally { caller.abort(); vi.useRealTimers(); }
  });

  it.each(["tool", "text"])("clears the first-token timer after meaningful %s progress", async (kind) => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode(kind === "tool" ? opener() : agentFrame({ content: "Hello." })));
    } }), { headers: { "content-type": "text/event-stream" } });
    let settled = false;
    const result = collect(provider(response), input({ timeoutMs: 100, firstTokenTimeoutMs: 10 }))
      .then((chunks) => { settled = true; return chunks; }, (error: unknown) => { settled = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(false);
      controller.enqueue(new TextEncoder().encode(kind === "tool"
        ? agentFrame({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }) + end + done
        : agentFrame({}, "stop") + done));
      controller.close();
      expect(await result).toEqual(expect.arrayContaining([expect.objectContaining({ type: "completed" })]));
    } finally { vi.useRealTimers(); }
  });

  it("interrupts a stalled body read when the caller cancels", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => { opened = resolve; });
    const cancel = vi.fn();
    const instance = new DeepSeekAgentProvider({ apiKey: "public-synthetic-stream-key", fetchImplementation: async () => {
      opened();
      return new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-type": "text/event-stream" } });
    } });
    let result: unknown;
    void collect(instance, input({ signal: controller.signal })).then((value) => { result = value; }, (error: unknown) => { result = error; });
    await opening;
    try {
      await vi.advanceTimersByTimeAsync(5);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ failureReason: "timeout" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("cancels the body and releases the reader when the consumer stops after one sentence", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(agentFrame({ content: "Hello." }))); }, cancel,
    });
    for await (const _chunk of provider(new Response(body, { headers: { "content-type": "text/event-stream" } })).streamAgent(input())) break;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

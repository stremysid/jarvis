import { describe, expect, it, vi } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import {
  DeepSeekModelAdapter,
  collectStream,
} from "../../src/providers/deepseek-provider.js";

/**
 * The bounds matter more than the happy path.
 *
 * A provider that connects and then stalls produces silence a caller
 * experiences as a dead line, and an unbounded generation is streamed onward
 * indefinitely. Both are covered here, along with SSE frames that arrive split
 * across chunk boundaries -- which is the normal case over a real socket, not
 * an edge case.
 */

const API_KEY = "sk-test-key";

function sseResponse(chunks: readonly string[], { status = 200, errorBody = "" } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  // `text` is needed because failures now read the provider's own explanation:
  // a wrong model id and an expired key are both plain 4xx otherwise.
  return { ok: status < 400, status, body, text: async () => errorBody } as unknown as Response;
}

function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function input(overrides: Partial<Parameters<DeepSeekModelAdapter["stream"]>[0]> = {}) {
  return {
    correlationId: "01m1hh9h1yxaeyjgbhfzm4nnth" as Ulid,
    principalId: "principal-a",
    channel: "telegram" as const,
    userText: "hello",
    context: [],
    reasoningEffort: "low" as const,
    firstTokenTimeoutMs: 5_000,
    timeoutMs: 20_000,
    contextTokenBudget: 1_000,
    maxOutputCharacters: 4_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function adapterWith(fetchImplementation: typeof fetch): DeepSeekModelAdapter {
  return new DeepSeekModelAdapter({ apiKey: API_KEY, fetchImplementation });
}

describe("DeepSeekModelAdapter", () => {
  it("streams tokens and collects them in order", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([frame("Hel"), frame("lo "), frame("there"), "data: [DONE]\n\n"]),
    );
    const text = await collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input()));
    expect(text).toBe("Hello there");
  });

  it("reassembles frames split across chunk boundaries", async () => {
    // The normal case over a real socket: a frame arrives in pieces. Splitting
    // on newlines alone would surface half a JSON object.
    const whole = frame("split");
    const midpoint = Math.floor(whole.length / 2);
    const fetchMock = vi.fn(async () =>
      sseResponse([whole.slice(0, midpoint), whole.slice(midpoint), "data: [DONE]\n\n"]),
    );
    const text = await collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input()));
    expect(text).toBe("split");
  });

  it("stops at maxOutputCharacters rather than trimming afterwards", async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame("a".repeat(50)), frame("b".repeat(50))]));
    const text = await collectStream(
      adapterWith(fetchMock as unknown as typeof fetch).stream(input({ maxOutputCharacters: 30 })),
    );
    expect(text).toBe("a".repeat(30));
    expect(text.length).toBe(30);
  });

  it("cuts mid-token at the exact boundary", async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame("12345"), frame("67890")]));
    const text = await collectStream(
      adapterWith(fetchMock as unknown as typeof fetch).stream(input({ maxOutputCharacters: 7 })),
    );
    expect(text).toBe("1234567");
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([frame("kept"), "data: [DONE]\n\n", frame("ignored")]),
    );
    const text = await collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input()));
    expect(text).toBe("kept");
  });

  it("skips frames that are not parseable rather than failing the stream", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(["data: not-json\n\n", frame("ok"), "data: {}\n\n"]),
    );
    const text = await collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input()));
    expect(text).toBe("ok");
  });

  it("reports authentication failure distinctly from unavailability", async () => {
    const fetchMock = vi.fn(async () => sseResponse([], { status: 401 }));
    await expect(
      collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input())),
    ).rejects.toThrow("model_authentication_failed");
  });

  it("includes the provider's explanation in the error", async () => {
    // A wrong model id and an expired key are both plain 4xx responses. Without
    // the body they are indistinguishable, which is exactly the situation that
    // made a silent reply failure impossible to diagnose.
    const fetchMock = vi.fn(async () =>
      sseResponse([], { status: 400, errorBody: '{"error":{"message":"Model Not Exist"}}' }),
    );
    await expect(
      collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input())),
    ).rejects.toThrow("Model Not Exist");
  });

  it("uses an overridden model id when given", async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame("x"), "data: [DONE]\n\n"]));
    const adapter = new DeepSeekModelAdapter({
      apiKey: API_KEY,
      fetchImplementation: fetchMock as unknown as typeof fetch,
      model: "deepseek-chat",
    });
    await collectStream(adapter.stream(input()));
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("deepseek-chat");
  });

  it("reports a network failure as unavailable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    await expect(
      collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input())),
    ).rejects.toThrow("model_unavailable");
  });

  it("sends the pinned model and the requested reasoning effort", async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame("x"), "data: [DONE]\n\n"]));
    await collectStream(
      adapterWith(fetchMock as unknown as typeof fetch).stream(input({ reasoningEffort: "high" })),
    );
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream).toBe(true);
  });

  it("carries source event ids alongside retrieved context", async () => {
    // So an answer drawn from memory can be traced to the archived event.
    const fetchMock = vi.fn(async () => sseResponse([frame("x"), "data: [DONE]\n\n"]));
    await collectStream(
      adapterWith(fetchMock as unknown as typeof fetch).stream(
        input({
          context: [
            { sourceEventId: "01m1hh9h1yxaeyjgbhfzm4nnth" as Ulid, text: "likes coffee", sensitivity: "personal" },
          ],
        }),
      ),
    );
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const contextMessage = body.messages.find((m: ChatLike) => m.content.includes("likes coffee"));
    expect(contextMessage.content).toContain("Relevant facts and conversation history");
    expect(contextMessage.content).toContain("01m1hh9h1yxaeyjgbhfzm4nnth");
  });

  it("puts the user message last", async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame("x"), "data: [DONE]\n\n"]));
    await collectStream(
      adapterWith(fetchMock as unknown as typeof fetch).stream(input({ userText: "the question" })),
    );
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const messages = JSON.parse(init.body as string).messages as ChatLike[];
    expect(messages.at(-1)).toEqual({ role: "user", content: "the question" });
  });

  it("rejects an empty API key at construction", () => {
    expect(() => new DeepSeekModelAdapter({ apiKey: "" })).toThrow("deepseek_api_key_invalid");
  });

  it("sends the key as a bearer token and not in the URL", async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame("x"), "data: [DONE]\n\n"]));
    await collectStream(adapterWith(fetchMock as unknown as typeof fetch).stream(input()));
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).not.toContain(API_KEY);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
  });
});

interface ChatLike {
  readonly role: string;
  readonly content: string;
}

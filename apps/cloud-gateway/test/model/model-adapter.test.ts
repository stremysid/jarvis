import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultModelAdapter,
  type ModelAdapterStreamInput,
  type ModelToken,
} from "../../src/model/model-adapter.js";
import type {
  ModelChunk,
  ModelCompleteJsonInput,
  ModelProvider,
  ModelStreamTextInput,
} from "../../src/providers/provider-types.js";

const TOKEN = Object.freeze({ type: "token" as const, index: 0, text: "hello" });
const COMPLETED = Object.freeze({ type: "completed" as const });

interface IteratorHarness {
  readonly iterable: AsyncIterable<ModelChunk>;
  readonly nextCalls: () => number;
  readonly returnCalls: () => number;
}

function harnessFromNext(nextValue: () => Promise<IteratorResult<unknown>>): IteratorHarness {
  let nextCalls = 0;
  let returnCalls = 0;
  const iterator: AsyncIterator<unknown> = {
    next: async () => {
      nextCalls += 1;
      return nextValue();
    },
    return: async () => {
      returnCalls += 1;
      return { done: true, value: undefined };
    },
  };
  return {
    iterable: {
      [Symbol.asyncIterator]: () => iterator as AsyncIterator<ModelChunk>,
    },
    nextCalls: () => nextCalls,
    returnCalls: () => returnCalls,
  };
}

function scriptedHarness(chunks: readonly unknown[]): IteratorHarness {
  let offset = 0;
  return harnessFromNext(async () => offset < chunks.length
    ? { done: false, value: chunks[offset++] }
    : { done: true, value: undefined });
}

class TestModelProvider implements ModelProvider {
  readonly requests: ModelStreamTextInput[] = [];

  constructor(private readonly makeIterable: (input: ModelStreamTextInput) => AsyncIterable<ModelChunk>) {}

  streamText(input: ModelStreamTextInput): AsyncIterable<ModelChunk> {
    this.requests.push(input);
    return this.makeIterable(input);
  }

  async completeJson(_input: ModelCompleteJsonInput): Promise<unknown> {
    return {};
  }
}

function input(overrides: Partial<ModelAdapterStreamInput> = {}): ModelAdapterStreamInput {
  return {
    correlationId: "01k3s6k8000000000000000003",
    principalId: "principal:sid",
    channel: "voice",
    userText: "hello",
    context: [{
      sourceEventId: "01k3s6k8000000000000000004",
      text: "remembered",
      sensitivity: "personal",
    }],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 8_000,
    timeoutMs: 30_000,
    contextTokenBudget: 32_000,
    maxOutputCharacters: 65_536,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DefaultModelAdapter provider protocol", () => {
  it("passes captured policy to the provider and consumes completed without yielding it", async () => {
    const harness = scriptedHarness([
      { type: "token", index: 0, text: "hel" },
      { type: "token", index: 1, text: "lo" },
      COMPLETED,
    ]);
    const provider = new TestModelProvider(() => harness.iterable);
    const adapter = new DefaultModelAdapter(provider);

    const values = await collect(adapter.stream(input({ reasoningEffort: "max" })));

    expect(values).toEqual<ModelToken[]>([
      { index: 0, text: "hel" },
      { index: 1, text: "lo" },
    ]);
    expect(values.every(Object.isFrozen)).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      correlationId: "01k3s6k8000000000000000003",
      principalId: "principal:sid",
      channel: "voice",
      userText: "hello",
      reasoningEffort: "max",
      timeoutMs: 30_000,
      contextTokenBudget: 32_000,
      context: [{ sourceEventId: "01k3s6k8000000000000000004", text: "remembered", sensitivity: "personal" }],
    });
    expect(harness.nextCalls()).toBe(4);
    expect(harness.returnCalls()).toBe(0);
  });

  it.each([
    ["an index gap", [{ type: "token", index: 1, text: "bad" }, COMPLETED]],
    ["a duplicate index", [TOKEN, { type: "token", index: 0, text: "again" }, COMPLETED]],
    ["missing completed", [TOKEN]],
    ["duplicate completed", [TOKEN, COMPLETED, COMPLETED]],
    ["a token after completed", [TOKEN, COMPLETED, { type: "token", index: 1, text: "late" }]],
    ["completed before output", [COMPLETED]],
    ["an empty token", [{ type: "token", index: 0, text: "" }, COMPLETED]],
    ["a decomposed token", [{ type: "token", index: 0, text: "e\u0301" }, COMPLETED]],
    ["a completion payload", [TOKEN, { type: "completed", text: "not allowed" }]],
    ["an extra token field", [{ type: "token", index: 0, text: "ok", raw: "not allowed" }, COMPLETED]],
  ])("rejects %s and closes the provider iterator", async (_name, chunks) => {
    const harness = scriptedHarness(chunks);
    const adapter = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable));

    await expect(collect(adapter.stream(input()))).rejects.toMatchObject({ code: "model_protocol_invalid" });
    expect(harness.returnCalls()).toBe(1);
  });

  it("rejects accessor-shaped provider chunks without invoking the accessor", async () => {
    let reads = 0;
    const chunk = Object.defineProperty({ type: "token", index: 0 }, "text", {
      enumerable: true,
      get() {
        reads += 1;
        return "secret";
      },
    });
    const harness = scriptedHarness([chunk]);
    const adapter = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable));

    await expect(collect(adapter.stream(input()))).rejects.toMatchObject({ code: "model_protocol_invalid" });
    expect(reads).toBe(0);
    expect(harness.returnCalls()).toBe(1);
  });

  it("snapshots a mutable provider chunk before yielding it", async () => {
    const raw = { type: "token" as const, index: 0, text: "safe" };
    const harness = scriptedHarness([raw, COMPLETED]);
    const adapter = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable));
    const iterator = adapter.stream(input())[Symbol.asyncIterator]();

    const first = await iterator.next();
    raw.text = "changed";

    expect(first).toEqual({ done: false, value: { index: 0, text: "safe" } });
    expect(Object.isFrozen(first.value)).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("aborts before forwarding the token that crosses the output bound", async () => {
    const harness = scriptedHarness([
      { type: "token", index: 0, text: "ab" },
      { type: "token", index: 1, text: "cd" },
      COMPLETED,
    ]);
    const adapter = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable));
    const iterator = adapter.stream(input({ maxOutputCharacters: 3 }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { index: 0, text: "ab" } });
    await expect(iterator.next()).rejects.toMatchObject({ code: "model_output_limit" });
    expect(harness.returnCalls()).toBe(1);
  });

  it("enforces the independent 64 KiB UTF-8 output ceiling", async () => {
    const oversized = "😀".repeat(16_385);
    const harness = scriptedHarness([{ type: "token", index: 0, text: oversized }, COMPLETED]);
    const adapter = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable));

    await expect(collect(adapter.stream(input({ maxOutputCharacters: 65_536 }))))
      .rejects.toMatchObject({ code: "model_output_limit" });
    expect(harness.returnCalls()).toBe(1);
  });

  it("maps an iterator exception to a fixed safe error and closes once", async () => {
    const harness = harnessFromNext(async () => { throw new Error("raw provider secret"); });
    const adapter = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable));

    let observed: unknown;
    try {
      await collect(adapter.stream(input()));
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({ code: "model_provider_failure", message: "model_provider_failure" });
    expect(String(observed)).not.toContain("raw provider secret");
    expect(harness.returnCalls()).toBe(1);
  });

  it("closes the provider iterator once when its consumer stops early", async () => {
    const harness = scriptedHarness([TOKEN, { type: "token", index: 1, text: "later" }, COMPLETED]);
    const adapter = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable));
    const iterator = adapter.stream(input())[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { text: "hello" } });
    await iterator.return?.();

    expect(harness.returnCalls()).toBe(1);
  });
});

describe("DefaultModelAdapter deadlines and abort", () => {
  it("enforces the first-token deadline from the provider attempt", async () => {
    vi.useFakeTimers();
    const harness = harnessFromNext(() => new Promise<IteratorResult<unknown>>(() => undefined));
    let providerSignal: AbortSignal | undefined;
    const provider = new TestModelProvider((request) => {
      providerSignal = request.signal;
      return harness.iterable;
    });
    const pending = collect(new DefaultModelAdapter(provider).stream(input({ firstTokenTimeoutMs: 10, timeoutMs: 50 })));
    const rejection = expect(pending).rejects.toMatchObject({ code: "model_first_token_timeout" });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.returnCalls()).toBe(1);
  });

  it("keeps the total deadline running after the first token", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const harness = harnessFromNext(async () => {
      calls += 1;
      if (calls === 1) return { done: false, value: TOKEN };
      return new Promise<IteratorResult<unknown>>(() => undefined);
    });
    const iterator = new DefaultModelAdapter(new TestModelProvider(() => harness.iterable))
      .stream(input({ firstTokenTimeoutMs: 20, timeoutMs: 30 }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { text: "hello" } });
    const pending = iterator.next();
    const rejection = expect(pending).rejects.toMatchObject({ code: "model_total_timeout" });
    await vi.advanceTimersByTimeAsync(30);

    await rejection;
    expect(harness.returnCalls()).toBe(1);
  });

  it("performs no provider work when the captured caller signal is already aborted", async () => {
    const controller = new AbortController();
    const harness = scriptedHarness([TOKEN, COMPLETED]);
    const provider = new TestModelProvider(() => harness.iterable);
    const stream = new DefaultModelAdapter(provider).stream(input({ signal: controller.signal }));
    controller.abort();

    await expect(collect(stream)).rejects.toMatchObject({ code: "model_aborted" });
    expect(provider.requests).toHaveLength(0);
    expect(harness.returnCalls()).toBe(0);
  });

  it("links a live caller abort to an active provider iterator", async () => {
    const controller = new AbortController();
    const harness = harnessFromNext(() => new Promise<IteratorResult<unknown>>(() => undefined));
    let providerSignal: AbortSignal | undefined;
    const provider = new TestModelProvider((request) => {
      providerSignal = request.signal;
      return harness.iterable;
    });
    const pending = collect(new DefaultModelAdapter(provider).stream(input({ signal: controller.signal })));
    await Promise.resolve();

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "model_aborted" });
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.returnCalls()).toBe(1);
  });
});

describe("DefaultModelAdapter capture boundary", () => {
  it("captures input and indexed context before returning its iterable while retaining the original live signal", async () => {
    const original = new AbortController();
    const replacement = new AbortController();
    const harness = scriptedHarness([TOKEN, COMPLETED]);
    const provider = new TestModelProvider(() => harness.iterable);
    const adapter = new DefaultModelAdapter(provider);
    const request = input({ signal: original.signal });

    const stream = adapter.stream(request);
    (request as { userText: string }).userText = "mutated";
    (request.context as { text: string }[])[0]!.text = "mutated";
    (request as { reasoningEffort: "none" }).reasoningEffort = "none";
    (request as { signal: AbortSignal }).signal = replacement.signal;

    await expect(collect(stream)).resolves.toEqual([{ index: 0, text: "hello" }]);
    expect(provider.requests[0]).toMatchObject({
      userText: "hello",
      reasoningEffort: "low",
      context: [{ text: "remembered" }],
    });
    expect(original.signal.aborted).toBe(false);
    expect(replacement.signal.aborted).toBe(false);
  });

  it("rejects accessor inputs synchronously without invoking them", () => {
    let reads = 0;
    const request = input() as Record<string, unknown>;
    Object.defineProperty(request, "userText", {
      enumerable: true,
      get() {
        reads += 1;
        return "secret";
      },
    });
    const provider = new TestModelProvider(() => scriptedHarness([TOKEN, COMPLETED]).iterable);

    expect(() => new DefaultModelAdapter(provider).stream(request as unknown as ModelAdapterStreamInput))
      .toThrow(expect.objectContaining({ code: "model_input_invalid" }));
    expect(reads).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects sparse or accessor context entries before provider work", () => {
    let reads = 0;
    const sparse = new Array(1) as ModelAdapterStreamInput["context"];
    const accessor = [{
      sourceEventId: "01k3s6k8000000000000000004",
      sensitivity: "personal",
      get text() {
        reads += 1;
        return "secret";
      },
    }];
    const provider = new TestModelProvider(() => scriptedHarness([TOKEN, COMPLETED]).iterable);
    const adapter = new DefaultModelAdapter(provider);

    expect(() => adapter.stream(input({ context: sparse }))).toThrow(expect.objectContaining({ code: "model_context_invalid" }));
    expect(() => adapter.stream(input({ context: accessor }))).toThrow(expect.objectContaining({ code: "model_context_invalid" }));
    expect(reads).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects structural AbortSignal lookalikes and policy values looser than the foundation caps", () => {
    const provider = new TestModelProvider(() => scriptedHarness([TOKEN, COMPLETED]).iterable);
    const adapter = new DefaultModelAdapter(provider);

    expect(() => adapter.stream(input({ signal: { aborted: false } as AbortSignal })))
      .toThrow(expect.objectContaining({ code: "model_input_invalid" }));
    expect(() => adapter.stream(input({ firstTokenTimeoutMs: 8_001 })))
      .toThrow(expect.objectContaining({ code: "model_input_invalid" }));
    expect(() => adapter.stream(input({ timeoutMs: 30_001 })))
      .toThrow(expect.objectContaining({ code: "model_input_invalid" }));
    expect(() => adapter.stream(input({ contextTokenBudget: 32_001 })))
      .toThrow(expect.objectContaining({ code: "model_input_invalid" }));
    expect(() => adapter.stream(input({ maxOutputCharacters: 65_537 })))
      .toThrow(expect.objectContaining({ code: "model_input_invalid" }));
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects context that exceeds its declared conservative UTF-8 budget", () => {
    const provider = new TestModelProvider(() => scriptedHarness([TOKEN, COMPLETED]).iterable);
    const adapter = new DefaultModelAdapter(provider);

    expect(() => adapter.stream(input({
      context: [{ sourceEventId: "01k3s6k8000000000000000004", text: "é", sensitivity: "restricted" }],
      contextTokenBudget: 1,
    }))).toThrow(expect.objectContaining({ code: "model_context_invalid" }));
    expect(provider.requests).toHaveLength(0);
  });
});

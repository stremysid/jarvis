import { describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import {
  ModelAdapterError,
  modelProviderNotStartedError,
  type ModelAdapter,
  type ModelAdapterStreamInput,
  type ModelToken,
} from "../../src/model/model-adapter.js";
import { PreAdmissionModelAdapter } from "../../src/model/pre-admission-model-adapter.js";

function input(channel: "voice" | "telegram" = "voice"): ModelAdapterStreamInput {
  return {
    correlationId: newUlid(),
    principalId: "principal:test",
    channel,
    userText: "hello",
    context: [],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 1_000,
    timeoutMs: 2_000,
    contextTokenBudget: 1_000,
    maxOutputCharacters: 1_000,
    signal: new AbortController().signal,
  };
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<ModelToken[]> {
  const tokens: ModelToken[] = [];
  for await (const token of stream) tokens.push(token);
  return tokens;
}

function adapter(
  onStream: (input: ModelAdapterStreamInput) => AsyncIterable<ModelToken>,
): ModelAdapter {
  return { stream: onStream };
}

describe("PreAdmissionModelAdapter", () => {
  it.each(["disabled", "ready", "readiness_circuit_open"] as const)(
    "routes Telegram directly before reading Hermes state or its adapter (%s)",
    async (state) => {
      let stateCalls = 0;
      let hermesCalls = 0;
      let directCalls = 0;
      const direct = adapter(async function* () {
        directCalls += 1;
        yield Object.freeze({ index: 0, text: "direct" });
      });
      const hermes = adapter(async function* () {
        hermesCalls += 1;
        yield Object.freeze({ index: 0, text: "hermes" });
      });
      const selected = new PreAdmissionModelAdapter({
        direct,
        hermes,
        hermesState: () => { stateCalls += 1; return state; },
      });

      await expect(collect(selected.stream(input("telegram")))).resolves.toEqual([{ index: 0, text: "direct" }]);
      expect({ stateCalls, hermesCalls, directCalls }).toEqual({ stateCalls: 0, hermesCalls: 0, directCalls: 1 });
    },
  );

  it.each([
    ["disabled", () => "disabled"],
    ["open", () => "readiness_circuit_open"],
    ["invalid", () => "untrusted" as never],
    ["throwing", () => { throw new Error("untrusted"); }],
  ] as const)("uses direct for voice when Hermes state is %s", async (_name, hermesState) => {
    let hermesCalls = 0;
    let directCalls = 0;
    const selected = new PreAdmissionModelAdapter({
      direct: adapter(async function* () { directCalls += 1; yield Object.freeze({ index: 0, text: "direct" }); }),
      hermes: adapter(async function* () { hermesCalls += 1; yield Object.freeze({ index: 0, text: "hermes" }); }),
      hermesState,
    });

    await expect(collect(selected.stream(input()))).resolves.toEqual([{ index: 0, text: "direct" }]);
    expect({ hermesCalls, directCalls }).toEqual({ hermesCalls: 0, directCalls: 1 });
  });

  it("uses Hermes for ready voice and never eagerly constructs direct", async () => {
    let directCalls = 0;
    let hermesCalls = 0;
    const selected = new PreAdmissionModelAdapter({
      direct: adapter(async function* () { directCalls += 1; yield Object.freeze({ index: 0, text: "direct" }); }),
      hermes: adapter(async function* () { hermesCalls += 1; yield Object.freeze({ index: 0, text: "hermes" }); }),
      hermesState: () => "ready",
    });

    const stream = selected.stream(input());
    expect({ directCalls, hermesCalls }).toEqual({ directCalls: 0, hermesCalls: 0 });
    await expect(collect(stream)).resolves.toEqual([{ index: 0, text: "hermes" }]);
    expect({ directCalls, hermesCalls }).toEqual({ directCalls: 0, hermesCalls: 1 });
  });

  it("closes only a nominal pre-token Hermes iterator before direct fallback with the frozen input", async () => {
    let hermesInput: Readonly<ModelAdapterStreamInput> | undefined;
    let directInput: Readonly<ModelAdapterStreamInput> | undefined;
    let closeCalls = 0;
    const selected = new PreAdmissionModelAdapter({
      direct: adapter(async function* (received) {
        directInput = received;
        yield Object.freeze({ index: 0, text: "direct" });
      }),
      hermes: adapter((received) => {
        hermesInput = received;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<ModelToken>> { throw modelProviderNotStartedError(); },
              async return(): Promise<IteratorResult<ModelToken>> { closeCalls += 1; return { done: true, value: undefined }; },
            };
          },
        };
      }),
      hermesState: () => "ready",
    });

    await expect(collect(selected.stream(input()))).resolves.toEqual([{ index: 0, text: "direct" }]);
    expect(closeCalls).toBe(1);
    expect(directInput).toBe(hermesInput);
    expect(directInput).toMatchObject({ correlationId: hermesInput?.correlationId });
    expect(Object.isFrozen(directInput)).toBe(true);
  });

  it("falls back when Hermes rejects with the nominal marker before creating an iterator", async () => {
    let directCalls = 0;
    const selected = new PreAdmissionModelAdapter({
      direct: adapter(async function* () { directCalls += 1; yield Object.freeze({ index: 0, text: "direct" }); }),
      hermes: adapter(() => { throw modelProviderNotStartedError(); }),
      hermesState: () => "ready",
    });

    await expect(collect(selected.stream(input()))).resolves.toEqual([{ index: 0, text: "direct" }]);
    expect(directCalls).toBe(1);
  });

  it.each([
    "model_provider_failure",
    "model_admission_unknown",
    "model_cancel_unknown",
    "model_first_token_timeout",
    "model_protocol_invalid",
  ] as const)("never falls back for a nonnominal pre-token Hermes %s", async (code) => {
    let directCalls = 0;
    const selected = new PreAdmissionModelAdapter({
      direct: adapter(async function* () { directCalls += 1; yield Object.freeze({ index: 0, text: "direct" }); }),
      hermes: adapter(async function* () { throw new ModelAdapterError(code); }),
      hermesState: () => "ready",
    });

    await expect(collect(selected.stream(input()))).rejects.toMatchObject({ code });
    expect(directCalls).toBe(0);
  });

  it("never falls back after a Hermes token, even if its later error is nominal", async () => {
    let directCalls = 0;
    const selected = new PreAdmissionModelAdapter({
      direct: adapter(async function* () { directCalls += 1; yield Object.freeze({ index: 0, text: "direct" }); }),
      hermes: adapter(async function* () {
        yield Object.freeze({ index: 0, text: "hermes" });
        throw modelProviderNotStartedError();
      }),
      hermesState: () => "ready",
    });

    const iterator = selected.stream(input())[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { index: 0, text: "hermes" } });
    await expect(iterator.next()).rejects.toMatchObject({ code: "model_provider_failure" });
    expect(directCalls).toBe(0);
  });
});

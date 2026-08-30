import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { FakeTwilioProvider } from "../../src/providers/fake-twilio-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import {
  ProviderCircuitOpenError,
  ProviderFailure,
  ProviderIdempotencyConflictError,
  type ModelChunk,
  type ModelStreamTextInput,
  type TelegramSendMessageInput,
  type TwilioCreateCallInput,
} from "../../src/providers/provider-types.js";

const callbackEvents = ["initiated", "ringing", "answered", "completed"] as const;

function twilioCall(overrides: Partial<TwilioCreateCallInput> = {}): TwilioCreateCallInput {
  return {
    commandId: "01k3s6k8000000000000000000",
    toE164: "+14165550123",
    twimlUrl: new URL("https://jarvis.example/voice/outbound/01k3s6k8000000000000000000"),
    statusCallbackUrl: new URL("https://jarvis.example/voice/status"),
    statusCallbackEvents: callbackEvents,
    idempotencyKey: "attempt:01k3s6k8000000000000000001",
    ...overrides,
  };
}

function telegramMessage(overrides: Partial<TelegramSendMessageInput> = {}): TelegramSendMessageInput {
  return {
    chatId: "chat:44",
    text: "Jarvis is online.",
    replyToMessageId: 9,
    idempotencyKey: "delivery:01k3s6k8000000000000000002",
    ...overrides,
  };
}

function modelStreamInput(overrides: Partial<ModelStreamTextInput> = {}): ModelStreamTextInput {
  return {
    correlationId: "01k3s6k8000000000000000003",
    principalId: "principal:sid",
    channel: "voice",
    userText: "hello",
    context: [{ sourceEventId: "01k3s6k8000000000000000004", text: "remembered", sensitivity: "personal" }],
    timeoutMs: 30_000,
    contextTokenBudget: 32_000,
    reasoningEffort: "low",
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

describe("FakeTwilioProvider", () => {
  it("returns one deterministic call for a replayed normalized idempotency request", async () => {
    const fake = new FakeTwilioProvider();
    const firstInput = twilioCall();
    const secondInput = twilioCall({
      twimlUrl: new URL("https://jarvis.example/voice/outbound/01k3s6k8000000000000000000"),
      statusCallbackUrl: new URL("https://jarvis.example/voice/status"),
    });

    const one = await fake.createCall(firstInput);
    const two = await fake.createCall(secondInput);

    expect(one).toEqual({ callSid: "CA00000000000000000000000000000001" });
    expect(two).toEqual(one);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      commandId: firstInput.commandId,
      toE164: "+14165550123",
      statusCallbackEvents: callbackEvents,
      idempotencyKey: firstInput.idempotencyKey,
    });
  });

  it("throws a typed stable conflict when one key is reused for changed material", async () => {
    const fake = new FakeTwilioProvider();
    await fake.createCall(twilioCall());

    const conflict = fake.createCall(twilioCall({ toE164: "+14165550124" }));

    await expect(conflict).rejects.toBeInstanceOf(ProviderIdempotencyConflictError);
    await expect(conflict).rejects.toMatchObject({ code: "provider_idempotency_conflict" });
    expect(fake.requests).toHaveLength(1);
  });

  it("coalesces concurrent retries of the same in-flight attempt", async () => {
    vi.useFakeTimers();
    const fake = new FakeTwilioProvider();
    fake.delayNext(25);

    const one = fake.createCall(twilioCall());
    const two = fake.createCall(twilioCall());
    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25);

    await expect(Promise.all([one, two])).resolves.toEqual([
      { callSid: "CA00000000000000000000000000000001" },
      { callSid: "CA00000000000000000000000000000001" },
    ]);
    expect(fake.requests).toHaveLength(1);
  });

  it("rejects changed material while the original idempotent attempt is still in flight", async () => {
    vi.useFakeTimers();
    const fake = new FakeTwilioProvider();
    fake.delayNext(25);
    const original = fake.createCall(twilioCall());

    const conflict = fake.createCall(twilioCall({ toE164: "+14165550124" }));

    await expect(conflict).rejects.toMatchObject({ code: "provider_idempotency_conflict" });
    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25);
    await expect(original).resolves.toEqual({ callSid: "CA00000000000000000000000000000001" });
  });

  it("does not let a failed attempt poison its idempotency key", async () => {
    const fake = new FakeTwilioProvider();
    const injected = new Error("injected test failure");
    fake.failNext(injected);

    await expect(fake.createCall(twilioCall())).rejects.toBe(injected);
    await expect(fake.createCall(twilioCall())).resolves.toEqual({ callSid: "CA00000000000000000000000000000002" });
    await expect(fake.createCall(twilioCall())).resolves.toEqual({ callSid: "CA00000000000000000000000000000002" });
    expect(fake.requests).toHaveLength(2);
  });

  it("consumes queued failures only for a new provider attempt", async () => {
    const fake = new FakeTwilioProvider();
    const first = twilioCall();
    await fake.createCall(first);
    fake.failNext(new Error("new attempt only"));

    await expect(fake.createCall(first)).resolves.toEqual({ callSid: "CA00000000000000000000000000000001" });
    await expect(fake.createCall(twilioCall({ idempotencyKey: "attempt:new" }))).rejects.toThrow("new attempt only");
    expect(fake.requests).toHaveLength(2);
  });

  it("keeps immutable request snapshots isolated from caller and observer mutation", async () => {
    const fake = new FakeTwilioProvider();
    const input = twilioCall();
    await fake.createCall(input);
    input.twimlUrl.pathname = "/changed-by-caller";

    const observed = fake.requests;
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(Object.isFrozen(observed[0]?.statusCallbackEvents)).toBe(true);
    observed[0]!.twimlUrl.pathname = "/changed-by-observer";

    expect(fake.requests[0]?.twimlUrl.toString()).toBe("https://jarvis.example/voice/outbound/01k3s6k8000000000000000000");
  });
});

describe("FakeTelegramProvider", () => {
  it("returns one deterministic message for an NFC-equivalent replay", async () => {
    const fake = new FakeTelegramProvider();
    const one = await fake.sendMessage(telegramMessage({ text: "caf\u00e9" }));
    const two = await fake.sendMessage(telegramMessage({ text: "cafe\u0301" }));

    expect(one).toEqual({ providerMessageId: "telegram-message-00000001" });
    expect(two).toEqual(one);
    expect(fake.requests).toHaveLength(1);
  });

  it("rejects changed material for a reused key without dispatching it", async () => {
    const fake = new FakeTelegramProvider();
    await fake.sendMessage(telegramMessage());

    const conflict = fake.sendMessage(telegramMessage({ replyToMessageId: 10 }));

    await expect(conflict).rejects.toBeInstanceOf(ProviderIdempotencyConflictError);
    await expect(conflict).rejects.toMatchObject({ code: "provider_idempotency_conflict" });
    expect(fake.requests).toHaveLength(1);
  });

  it("consumes a queued failure once and permits a successful retry of the same key", async () => {
    const fake = new FakeTelegramProvider();
    fake.failNext(new Error("telegram unavailable"));

    await expect(fake.sendMessage(telegramMessage())).rejects.toThrow("telegram unavailable");
    await expect(fake.sendMessage(telegramMessage())).resolves.toEqual({ providerMessageId: "telegram-message-00000002" });
    await expect(fake.sendMessage(telegramMessage())).resolves.toEqual({ providerMessageId: "telegram-message-00000002" });
    expect(fake.requests).toHaveLength(2);
  });

  it("delays exactly one new attempt and coalesces its concurrent replay", async () => {
    vi.useFakeTimers();
    const fake = new FakeTelegramProvider();
    fake.delayNext(40);
    const one = fake.sendMessage(telegramMessage());
    const two = fake.sendMessage(telegramMessage());

    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    await expect(Promise.all([one, two])).resolves.toEqual([
      { providerMessageId: "telegram-message-00000001" },
      { providerMessageId: "telegram-message-00000001" },
    ]);
  });

  it("exposes frozen snapshots and preserves an omitted reply id", async () => {
    const fake = new FakeTelegramProvider();
    const input = telegramMessage({ replyToMessageId: undefined });
    await fake.sendMessage(input);
    input.text = "changed by caller";

    const requests = fake.requests;
    expect(Object.isFrozen(requests)).toBe(true);
    expect(Object.isFrozen(requests[0])).toBe(true);
    expect(requests[0]).toEqual({
      chatId: "chat:44",
      text: "Jarvis is online.",
      idempotencyKey: "delivery:01k3s6k8000000000000000002",
    });
  });
});

describe("FakeModelProvider", () => {
  it("streams deterministic indexed token chunks followed by completed", async () => {
    const fake = new FakeModelProvider({ streamText: "abcdef", streamTokenCount: 3 });

    await expect(collect(fake.streamText(modelStreamInput()))).resolves.toEqual<ModelChunk[]>([
      { type: "token", index: 0, text: "ab" },
      { type: "token", index: 1, text: "cd" },
      { type: "token", index: 2, text: "ef" },
      { type: "completed" },
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ operation: "streamText", userText: "hello", reasoningEffort: "low" });
  });

  it("returns cloned deterministic JSON only within the declared output bound", async () => {
    const configured = { proposals: [{ text: "coffee", confidence: 1 }] };
    const fake = new FakeModelProvider({ completeJson: configured, completeJsonTokenCount: 4 });
    configured.proposals[0]!.text = "mutated after construction";
    const input = {
      correlationId: "01k3s6k8000000000000000005",
      principalId: "principal:sid",
      purpose: "memory_distillation" as const,
      prompt: "distill",
      timeoutMs: 30_000,
      maxOutputTokens: 4,
      reasoningEffort: "high" as const,
    };

    const first = await fake.completeJson(input) as { proposals: { text: string; confidence: number }[] };
    first.proposals[0]!.text = "mutated by observer";
    await expect(fake.completeJson(input)).resolves.toEqual({ proposals: [{ text: "coffee", confidence: 1 }] });
    await expect(fake.completeJson({ ...input, maxOutputTokens: 3 })).rejects.toMatchObject({
      code: "provider_permanent_failure",
      category: "output_limit",
    });
    expect(fake.requests).toHaveLength(3);
  });

  it("consumes a queued failure once for one new model attempt", async () => {
    const fake = new FakeModelProvider({ streamText: "ok", streamTokenCount: 1 });
    fake.failNext(ProviderFailure.transient("timeout"));

    await expect(collect(fake.streamText(modelStreamInput()))).rejects.toMatchObject({
      code: "provider_transient_failure",
      category: "timeout",
    });
    await expect(collect(fake.streamText(modelStreamInput()))).resolves.toEqual([
      { type: "token", index: 0, text: "ok" },
      { type: "completed" },
    ]);
    expect(fake.requests).toHaveLength(2);
  });

  it("honors AbortSignal during a queued model delay and consumes the delay once", async () => {
    vi.useFakeTimers();
    const fake = new FakeModelProvider({ streamText: "response", streamTokenCount: 2 });
    const controller = new AbortController();
    fake.delayNext(1_000);

    const pending = collect(fake.streamText(modelStreamInput({ signal: controller.signal })));
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(collect(fake.streamText(modelStreamInput()))).resolves.toHaveLength(3);
    expect(fake.requests).toHaveLength(2);
  });

  it("keeps model request history as frozen deep snapshots", async () => {
    const fake = new FakeModelProvider();
    const input = modelStreamInput();
    await collect(fake.streamText(input));
    (input.context as { sourceEventId: string; text: string; sensitivity: "personal" }[])[0]!.text = "changed";
    input.userText = "changed";

    const requests = fake.requests;
    expect(Object.isFrozen(requests)).toBe(true);
    expect(Object.isFrozen(requests[0])).toBe(true);
    expect(Object.isFrozen(requests[0]?.context)).toBe(true);
    expect(Object.isFrozen(requests[0]?.context?.[0])).toBe(true);
    expect(requests[0]).toMatchObject({ userText: "hello", context: [{ text: "remembered" }] });
  });

  it("does not let a later caller abort mutate an earlier request snapshot", async () => {
    const fake = new FakeModelProvider();
    const controller = new AbortController();
    await collect(fake.streamText(modelStreamInput({ signal: controller.signal })));
    expect(fake.requests[0]?.signal.aborted).toBe(false);

    controller.abort();

    expect(fake.requests[0]?.signal.aborted).toBe(false);
  });
});

describe("ProviderCircuitBreaker", () => {
  const voiceOperation = "model.voice.streamText" as const;
  const telegramOperation = "telegram.sendMessage" as const;
  const epoch = new Date("2026-08-30T12:00:00.000Z");
  const at = (milliseconds: number) => new Date(epoch.getTime() + milliseconds);

  function recordTransientFailures(breaker: ProviderCircuitBreaker, operation = voiceOperation, count = 5, start = 0): void {
    for (let index = 0; index < count; index += 1) {
      breaker.recordFailure(operation, ProviderFailure.transient("temporarily_unavailable"), at(start + index));
    }
  }

  it("opens after five qualifying failures within the rolling 60-second window", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker, voiceOperation, 4);
    expect(breaker.allow(voiceOperation, at(4))).toBe(true);

    breaker.recordFailure(voiceOperation, ProviderFailure.transient("timeout"), at(5));

    expect(breaker.allow(voiceOperation, at(6))).toBe(false);
    expect(() => breaker.assertAllowed(voiceOperation, at(6))).toThrow(ProviderCircuitOpenError);
    try {
      breaker.assertAllowed(voiceOperation, at(6));
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_circuit_open", category: "voice_provider_unavailable" });
    }
  });

  it("expires failures outside the rolling 60-second window", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker, voiceOperation, 4, 0);
    breaker.recordFailure(voiceOperation, ProviderFailure.transient("timeout"), at(60_004));

    expect(breaker.allow(voiceOperation, at(60_005))).toBe(true);
  });

  it("isolates failure state by provider operation", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);

    expect(breaker.allow(voiceOperation, at(10))).toBe(false);
    expect(breaker.allow(telegramOperation, at(10))).toBe(true);
  });

  it("synchronously reserves exactly one half-open probe after 30 seconds", async () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);

    const results = await Promise.all([
      Promise.resolve().then(() => breaker.allow(voiceOperation, at(30_004))),
      Promise.resolve().then(() => breaker.allow(voiceOperation, at(30_004))),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(() => breaker.assertAllowed(voiceOperation, at(30_004))).toThrow(ProviderCircuitOpenError);
  });

  it("closes only after the reserved recovery probe succeeds", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);
    breaker.recordSuccess(voiceOperation);
    expect(breaker.allow(voiceOperation, at(20_000))).toBe(false);

    expect(breaker.allow(voiceOperation, at(30_004))).toBe(true);
    breaker.recordSuccess(voiceOperation);

    expect(breaker.allow(voiceOperation, at(30_005))).toBe(true);
  });

  it("reopens and restarts the recovery delay when the probe fails", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);
    expect(breaker.allow(voiceOperation, at(30_004))).toBe(true);

    breaker.recordFailure(voiceOperation, ProviderFailure.transient("rate_limited"), at(30_005));

    expect(breaker.allow(voiceOperation, at(60_004))).toBe(false);
    expect(breaker.allow(voiceOperation, at(60_005))).toBe(true);
  });

  it("releases an excluded half-open outcome without counting it or restarting recovery", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);
    expect(breaker.allow(voiceOperation, at(30_004))).toBe(true);

    breaker.recordFailure(voiceOperation, ProviderFailure.authentication(), at(30_005));

    expect(breaker.allow(voiceOperation, at(30_005))).toBe(true);
    expect(breaker.allow(voiceOperation, at(30_005))).toBe(false);
    breaker.recordSuccess(voiceOperation);
    expect(breaker.allow(voiceOperation, at(30_006))).toBe(true);
  });

  it("never counts authentication, policy, permanent, or untyped failures", () => {
    const breaker = new ProviderCircuitBreaker();
    const excluded = [
      ProviderFailure.authentication(),
      ProviderFailure.policyDenied(),
      ProviderFailure.permanent("invalid_request"),
      new Error("timeout words do not classify an error"),
    ];

    for (let index = 0; index < 20; index += 1) {
      breaker.recordFailure(voiceOperation, excluded[index % excluded.length]!, at(index));
    }

    expect(breaker.allow(voiceOperation, at(21))).toBe(true);
  });
});

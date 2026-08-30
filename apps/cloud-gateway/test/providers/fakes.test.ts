import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeModelProvider } from "../../src/providers/fake-model-provider.js";
import { FakeTelegramProvider } from "../../src/providers/fake-telegram-provider.js";
import { FakeTwilioProvider } from "../../src/providers/fake-twilio-provider.js";
import { ProviderCircuitBreaker } from "../../src/providers/provider-circuit-breaker.js";
import {
  ProviderCircuitOpenError,
  ProviderDispatchUnknownError,
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
    attemptId: "01k3s6k8000000000000000001",
    toE164: "+14165550123",
    twimlUrl: new URL("https://jarvis.example/voice/outbound/01k3s6k8000000000000000001"),
    statusCallbackUrl: new URL("https://jarvis.example/voice/status/01k3s6k8000000000000000001"),
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
  it("records an accepted response-loss attempt while direct replay remains a distinct POST", async () => {
    const fake = new FakeTwilioProvider();
    fake.acceptAndLoseNextResponse();

    let firstError: unknown;
    try {
      await fake.createCall(twilioCall());
    } catch (error) {
      firstError = error;
    }

    expect(firstError).toBeInstanceOf(ProviderDispatchUnknownError);
    await expect(fake.createCall(twilioCall())).resolves.toEqual({ callSid: "CA00000000000000000000000000000002" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.acceptedCalls.map(({ callSid }) => callSid)).toEqual([
      "CA00000000000000000000000000000001",
      "CA00000000000000000000000000000002",
    ]);
  });

  it("returns no parsed webhook values while its signature control is false", async () => {
    const fake = new FakeTwilioProvider();
    const exactUrl = "https://jarvis.example/voice/status";
    const rawBody = new TextEncoder().encode("CallSid=CA123&Future=value");
    const signature = await fake.signWebhook(exactUrl, rawBody);
    const request = (body = rawBody, contentType = "application/x-www-form-urlencoded") => new Request(exactUrl, {
      method: "POST",
      headers: { "content-type": contentType, "x-twilio-signature": signature },
      body,
    });
    const webSocketUrl = "wss://jarvis.example/voice/relay/x";
    const webSocketSignature = await fake.signWebSocket(webSocketUrl);
    const webSocketRequest = () => new Request("https://internal.invalid/relay", {
      headers: { "x-twilio-signature": webSocketSignature },
    });
    fake.signatureValid = false;

    await expect(fake.verifyWebhook({ exactUrl, request: request() })).resolves.toBeNull();
    await expect(fake.verifyWebSocket({ exactUrl: webSocketUrl, request: webSocketRequest() })).resolves.toBe(false);

    fake.signatureValid = true;
    const verified = await fake.verifyWebhook({ exactUrl, request: request() });
    expect(verified?.get("CallSid")).toBe("CA123");
    expect(verified?.entries()).toEqual([["CallSid", "CA123"], ["Future", "value"]]);
    await expect(fake.verifyWebSocket({ exactUrl: webSocketUrl, request: webSocketRequest() })).resolves.toBe(true);

    await expect(fake.verifyWebhook({
      exactUrl,
      request: request(new TextEncoder().encode("CallSid=%GG")),
    })).resolves.toBeNull();
    await expect(fake.verifyWebhook({
      exactUrl,
      request: request(rawBody, "application/json"),
    })).resolves.toBeNull();
    await expect(fake.verifyWebhook({
      exactUrl,
      request: request(new TextEncoder().encode(`CallSid=${"x".repeat(65_529)}`)),
    })).resolves.toBeNull();
  });

  it("models each replay as a distinct non-idempotent Calls POST", async () => {
    const fake = new FakeTwilioProvider();
    const firstInput = twilioCall();
    const secondInput = twilioCall({
      twimlUrl: new URL("https://jarvis.example/voice/outbound/01k3s6k8000000000000000001"),
      statusCallbackUrl: new URL("https://jarvis.example/voice/status/01k3s6k8000000000000000001"),
    });

    const one = await fake.createCall(firstInput);
    const two = await fake.createCall(secondInput);

    expect(one).toEqual({ callSid: "CA00000000000000000000000000000001" });
    expect(two).toEqual({ callSid: "CA00000000000000000000000000000002" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toMatchObject({
      commandId: firstInput.commandId,
      toE164: "+14165550123",
      statusCallbackEvents: callbackEvents,
      idempotencyKey: firstInput.idempotencyKey,
    });
  });

  it("keeps idempotency keys as correlation only and does not suppress changed replays", async () => {
    const fake = new FakeTwilioProvider();
    await fake.createCall(twilioCall());

    await expect(fake.createCall(twilioCall({ toE164: "+14165550124" }))).resolves.toEqual({
      callSid: "CA00000000000000000000000000000002",
    });
    expect(fake.requests).toHaveLength(2);
  });

  it("models concurrent invocations as two independent provider attempts", async () => {
    vi.useFakeTimers();
    const fake = new FakeTwilioProvider();
    fake.delayNext(25);

    const one = fake.createCall(twilioCall());
    const two = fake.createCall(twilioCall());
    expect(fake.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(25);

    await expect(Promise.all([one, two])).resolves.toEqual([
      { callSid: "CA00000000000000000000000000000001" },
      { callSid: "CA00000000000000000000000000000002" },
    ]);
    expect(fake.requests).toHaveLength(2);
  });

  it("does not locally reject changed material while another attempt is in flight", async () => {
    vi.useFakeTimers();
    const fake = new FakeTwilioProvider();
    fake.delayNext(25);
    const original = fake.createCall(twilioCall());

    const second = fake.createCall(twilioCall({ toE164: "+14165550124" }));

    expect(fake.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(25);
    await expect(original).resolves.toEqual({ callSid: "CA00000000000000000000000000000001" });
    await expect(second).resolves.toEqual({ callSid: "CA00000000000000000000000000000002" });
  });

  it("keeps every retry as a distinct attempt after a safe failure", async () => {
    const fake = new FakeTwilioProvider();
    const injected = new Error("injected test failure");
    fake.failNext(injected);

    await expect(fake.createCall(twilioCall())).rejects.toBe(injected);
    await expect(fake.createCall(twilioCall())).resolves.toEqual({ callSid: "CA00000000000000000000000000000002" });
    await expect(fake.createCall(twilioCall())).resolves.toEqual({ callSid: "CA00000000000000000000000000000003" });
    expect(fake.requests).toHaveLength(3);
  });

  it("does not bind correlation material after a failed call attempt", async () => {
    const fake = new FakeTwilioProvider();
    const original = twilioCall();
    fake.failNext(new Error("provider rejected first attempt"));
    await expect(fake.createCall(original)).rejects.toThrow("provider rejected first attempt");

    await expect(fake.createCall(twilioCall({ toE164: "+14165550124" }))).resolves.toEqual({
      callSid: "CA00000000000000000000000000000002",
    });
    await expect(fake.createCall(original)).resolves.toEqual({ callSid: "CA00000000000000000000000000000003" });
    expect(fake.requests).toHaveLength(3);
  });

  it("consumes queued failures on the next provider attempt even when correlation repeats", async () => {
    const fake = new FakeTwilioProvider();
    const first = twilioCall();
    await fake.createCall(first);
    fake.failNext(new Error("new attempt only"));

    await expect(fake.createCall(first)).rejects.toThrow("new attempt only");
    await expect(fake.createCall(twilioCall({ idempotencyKey: "attempt:new" }))).resolves.toEqual({
      callSid: "CA00000000000000000000000000000003",
    });
    expect(fake.requests).toHaveLength(3);
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

    expect(fake.requests[0]?.twimlUrl.toString()).toBe("https://jarvis.example/voice/outbound/01k3s6k8000000000000000001");
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

  it("keeps the first normalized material permanently bound after a failed message attempt", async () => {
    const fake = new FakeTelegramProvider();
    const original = telegramMessage();
    fake.failNext(new Error("provider rejected first attempt"));
    await expect(fake.sendMessage(original)).rejects.toThrow("provider rejected first attempt");

    await expect(fake.sendMessage(telegramMessage({ text: "changed message" }))).rejects.toMatchObject({
      code: "provider_idempotency_conflict",
    });
    await expect(fake.sendMessage(original)).resolves.toEqual({ providerMessageId: "telegram-message-00000002" });
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

  it("assigns queued controls when streams are invoked even if they are consumed in reverse", async () => {
    vi.useFakeTimers();
    const fake = new FakeModelProvider({ streamText: "ok", streamTokenCount: 1 });
    fake.failNext(ProviderFailure.transient("timeout"));
    fake.delayNext(50);

    const first = fake.streamText(modelStreamInput({ userText: "first invocation" }));
    const second = fake.streamText(modelStreamInput({ userText: "second invocation" }));
    const beforeIteration = fake.requests;
    const secondResult = collect(second);
    const firstResult = collect(first);
    const outcomes = Promise.allSettled([firstResult, secondResult]);
    await vi.advanceTimersByTimeAsync(50);

    expect(beforeIteration.map((request) => request.userText)).toEqual(["first invocation", "second invocation"]);
    await expect(outcomes).resolves.toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "provider_transient_failure", category: "timeout" }) }),
      { status: "fulfilled", value: [{ type: "token", index: 0, text: "ok" }, { type: "completed" }] },
    ]);
  });

  it("captures input and the original live signal before the first iterator step", async () => {
    const fake = new FakeModelProvider();
    const originalController = new AbortController();
    const replacementController = new AbortController();
    const input = modelStreamInput({ signal: originalController.signal });

    const stream = fake.streamText(input);
    input.userText = "mutated before iteration";
    (input.context as { sourceEventId: string; text: string; sensitivity: "personal" }[])[0]!.text = "mutated context";
    input.signal = replacementController.signal;
    originalController.abort();

    await expect(collect(stream)).rejects.toMatchObject({ name: "AbortError" });
    expect(replacementController.signal.aborted).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ userText: "hello", context: [{ text: "remembered" }] });
    expect(fake.requests[0]?.signal.aborted).toBe(false);
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

  function requirePermit(breaker: ProviderCircuitBreaker, operation = voiceOperation, now = epoch) {
    const permit = breaker.acquire(operation, now);
    if (permit === null) throw new Error("test expected provider permit");
    return permit;
  }

  function recordTransientFailures(breaker: ProviderCircuitBreaker, operation = voiceOperation, count = 5, start = 0): void {
    for (let index = 0; index < count; index += 1) {
      const permit = requirePermit(breaker, operation, at(start + index));
      breaker.recordFailure(permit, ProviderFailure.transient("temporarily_unavailable"), at(start + index));
    }
  }

  it("opens after five qualifying failures within the rolling 60-second window", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker, voiceOperation, 4);
    const allowed = requirePermit(breaker, voiceOperation, at(4));
    breaker.recordSuccess(allowed);

    const fifth = requirePermit(breaker, voiceOperation, at(5));
    breaker.recordFailure(fifth, ProviderFailure.transient("timeout"), at(5));

    expect(breaker.acquire(voiceOperation, at(6))).toBeNull();
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
    const permit = requirePermit(breaker, voiceOperation, at(60_004));
    breaker.recordFailure(permit, ProviderFailure.transient("timeout"), at(60_004));

    expect(breaker.acquire(voiceOperation, at(60_005))).not.toBeNull();
  });

  it("isolates failure state by provider operation", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);

    expect(breaker.acquire(voiceOperation, at(10))).toBeNull();
    expect(breaker.acquire(telegramOperation, at(10))).not.toBeNull();
  });

  it("synchronously reserves exactly one half-open probe after 30 seconds", async () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);

    const results = await Promise.all([
      Promise.resolve().then(() => breaker.acquire(voiceOperation, at(30_004))),
      Promise.resolve().then(() => breaker.acquire(voiceOperation, at(30_004))),
    ]);

    expect(results.filter((permit) => permit !== null)).toHaveLength(1);
    expect(() => breaker.assertAllowed(voiceOperation, at(30_004))).toThrow(ProviderCircuitOpenError);
  });

  it("does not let a stale pre-open success close a pending recovery probe", () => {
    const breaker = new ProviderCircuitBreaker();
    const stale = requirePermit(breaker, voiceOperation, at(-1));
    recordTransientFailures(breaker);
    const probe = requirePermit(breaker, voiceOperation, at(30_004));

    breaker.recordSuccess(stale);

    expect(breaker.acquire(voiceOperation, at(30_005))).toBeNull();
    breaker.recordSuccess(probe);
    expect(breaker.acquire(voiceOperation, at(30_006))).not.toBeNull();
  });

  it("does not let a stale pre-open failure reopen or release a pending recovery probe", () => {
    const breaker = new ProviderCircuitBreaker();
    const stale = requirePermit(breaker, voiceOperation, at(-1));
    recordTransientFailures(breaker);
    const probe = requirePermit(breaker, voiceOperation, at(30_004));

    breaker.recordFailure(stale, ProviderFailure.transient("timeout"), at(30_005));

    expect(breaker.acquire(voiceOperation, at(30_005))).toBeNull();
    breaker.recordSuccess(probe);
    expect(breaker.acquire(voiceOperation, at(30_006))).not.toBeNull();
  });

  it("does not count a stale ordinary failure after a probe closes into a fresh generation", () => {
    const breaker = new ProviderCircuitBreaker();
    const stale = requirePermit(breaker, voiceOperation, at(-1));
    recordTransientFailures(breaker);
    const probe = requirePermit(breaker, voiceOperation, at(30_004));
    breaker.recordSuccess(probe);

    breaker.recordFailure(stale, ProviderFailure.transient("timeout"), at(30_005));
    recordTransientFailures(breaker, voiceOperation, 4, 30_006);

    expect(breaker.acquire(voiceOperation, at(30_011))).not.toBeNull();
  });

  it("returns an operation-bound permit from assertAllowed and rejects foreign or forged permits", () => {
    const breaker = new ProviderCircuitBreaker();
    const other = new ProviderCircuitBreaker();
    const permit = breaker.assertAllowed(telegramOperation, epoch);

    expect(permit).toMatchObject({ operation: telegramOperation });
    expect(() => other.recordSuccess(permit)).toThrowError(expect.objectContaining({ code: "provider_permit_invalid" }));
    expect(() => breaker.recordSuccess({ operation: voiceOperation } as never)).toThrowError(expect.objectContaining({ code: "provider_permit_invalid" }));

    breaker.recordSuccess(permit);
    expect(breaker.acquire(telegramOperation, at(1))).not.toBeNull();
  });

  it("consumes each permit once and rejects duplicate outcomes", () => {
    const breaker = new ProviderCircuitBreaker();
    const permit = requirePermit(breaker);
    breaker.recordSuccess(permit);

    expect(() => breaker.recordSuccess(permit)).toThrowError(expect.objectContaining({ code: "provider_permit_consumed" }));
    expect(() => breaker.recordFailure(permit, ProviderFailure.transient("timeout"), at(1))).toThrowError(expect.objectContaining({ code: "provider_permit_consumed" }));
  });

  it("reopens and restarts the recovery delay when the probe fails", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);
    const probe = requirePermit(breaker, voiceOperation, at(30_004));

    breaker.recordFailure(probe, ProviderFailure.transient("rate_limited"), at(30_005));

    expect(breaker.acquire(voiceOperation, at(60_004))).toBeNull();
    expect(breaker.acquire(voiceOperation, at(60_005))).not.toBeNull();
  });

  it("releases an excluded half-open outcome without counting it or restarting recovery", () => {
    const breaker = new ProviderCircuitBreaker();
    recordTransientFailures(breaker);
    const probe = requirePermit(breaker, voiceOperation, at(30_004));

    breaker.recordFailure(probe, ProviderFailure.authentication(), at(30_005));

    const replacement = requirePermit(breaker, voiceOperation, at(30_005));
    expect(breaker.acquire(voiceOperation, at(30_005))).toBeNull();
    breaker.recordSuccess(replacement);
    expect(breaker.acquire(voiceOperation, at(30_006))).not.toBeNull();
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
      const permit = requirePermit(breaker, voiceOperation, at(index));
      breaker.recordFailure(permit, excluded[index % excluded.length]!, at(index));
    }

    expect(breaker.acquire(voiceOperation, at(21))).not.toBeNull();
  });
});

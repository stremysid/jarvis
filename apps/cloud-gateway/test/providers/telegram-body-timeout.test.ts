import { describe, expect, it, vi } from "vitest";
import { TelegramRestProvider } from "../../src/providers/telegram-provider.js";

const BOT_TOKEN = `00000:${"x".repeat(30)}`;

function fetchWithStalledBody(state: { started: boolean; aborted: boolean }): typeof fetch {
  return ((_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) throw new Error("missing_abort_signal");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => {
        state.started = true;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            state.aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
    } as unknown as Response);
  }) as typeof fetch;
}

describe("Telegram response body deadline", () => {
  it.each([
    ["sendMessage", (provider: TelegramRestProvider) => provider.sendMessage({ chatId: "test-chat", text: "hello", idempotencyKey: "test-key" })],
    ["sendChatAction", (provider: TelegramRestProvider) => provider.sendChatAction({ chatId: "test-chat", action: "typing" })],
  ])("times out when %s receives headers but its body stalls", async (_method, call) => {
    vi.useFakeTimers();
    try {
      const state = { started: false, aborted: false };
      const provider = new TelegramRestProvider({
        botToken: BOT_TOKEN,
        fetchImplementation: fetchWithStalledBody(state),
        timeoutMs: 25,
      });
      const outcome = call(provider).then(() => "resolved", (error: unknown) => error);
      await Promise.resolve();
      expect(state.started).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(24);
      expect(state.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ code: "provider_transient_failure", category: "timeout" });
      expect(state.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

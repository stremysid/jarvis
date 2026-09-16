import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_TYPING_REPEAT_MS,
  TelegramRestProvider,
  withTelegramTyping,
} from "../../src/providers/telegram-provider.js";

const TOKEN = "8123456789:AAHrandomlookingsecretvaluethatislongenough";

function response(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("Telegram typing indicator", () => {
  it("sends the action without chat text or idempotency metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(200, { ok: true, result: true }));
    const provider = new TelegramRestProvider({ botToken: TOKEN, fetchImplementation: fetcher });
    await provider.sendChatAction({ chatId: "123", action: "typing" });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendChatAction`);
    expect(init?.body).toBe(JSON.stringify({ chat_id: "123", action: "typing" }));
  });

  it("starts before turn work, repeats at four seconds, and stops after settlement", async () => {
    expect(TELEGRAM_TYPING_REPEAT_MS).toBe(4_000);
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const sender = { async sendChatAction() { order.push("typing"); } };
      let settle!: (value: string) => void;
      const turn = new Promise<string>((resolve) => { settle = resolve; });
      const pending = withTelegramTyping(sender, "123", async () => {
        order.push("model");
        return turn;
      });

      expect(order).toEqual(["typing", "model"]);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(order).toEqual(["typing", "model"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(order).toEqual(["typing", "model", "typing"]);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(order).toEqual(["typing", "model", "typing", "typing"]);
      settle("telegram_delivered");
      await expect(pending).resolves.toBe("telegram_delivered");
      await vi.advanceTimersByTimeAsync(8_000);
      expect(order).toEqual(["typing", "model", "typing", "typing"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["telegram_delivered", "failed", "cancelled", "model_outcome_unknown", "delivery_unknown"])(
    "stops when a turn settles as %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const sendChatAction = vi.fn(async () => undefined);
        await expect(withTelegramTyping({ sendChatAction }, "123", async () => outcome)).resolves.toBe(outcome);
        await vi.advanceTimersByTimeAsync(8_000);
        expect(sendChatAction).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("ignores action failures and preserves successful and failed turn outcomes", async () => {
    const sender = { async sendChatAction(): Promise<never> { throw new Error("telegram unavailable"); } };
    await expect(withTelegramTyping(sender, "123", async () => "telegram_delivered"))
      .resolves.toBe("telegram_delivered");
    await expect(withTelegramTyping(sender, "123", async () => { throw new Error("model failed"); }))
      .rejects.toThrow("model failed");
  });
});

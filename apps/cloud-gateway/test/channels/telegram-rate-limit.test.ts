import { describe, expect, it } from "vitest";
import {
  DAY_LIMIT,
  MINUTE_LIMIT,
  TelegramRateLimiter,
} from "../../src/channels/telegram/telegram-rate-limit.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

describe("Telegram rate limiting", () => {
  it("admits up to the minute limit and refuses the next", () => {
    const limiter = new TelegramRateLimiter();
    for (let index = 0; index < MINUTE_LIMIT; index += 1) {
      expect(limiter.admit("principal-1", 1_000 + index).allowed).toBe(true);
    }
    expect(limiter.admit("principal-1", 2_000)).toEqual({ allowed: false, window: "minute" });
  });

  it("recovers as the minute window slides", () => {
    const limiter = new TelegramRateLimiter();
    for (let index = 0; index < MINUTE_LIMIT; index += 1) limiter.admit("principal-1", 1_000);
    expect(limiter.admit("principal-1", 1_000).allowed).toBe(false);
    // One millisecond past the oldest entry leaving the window.
    expect(limiter.admit("principal-1", 1_000 + MINUTE + 1).allowed).toBe(true);
  });

  it("does not admit a burst across a fixed-window boundary", () => {
    // The reason for sliding windows: a fixed minute bucket would allow the
    // full limit at 59.999s and the full limit again at 60.000s.
    const limiter = new TelegramRateLimiter();
    for (let index = 0; index < MINUTE_LIMIT; index += 1) limiter.admit("principal-1", MINUTE - 1);
    expect(limiter.admit("principal-1", MINUTE).allowed).toBe(false);
  });

  it("enforces the daily limit independently of the minute limit", () => {
    const limiter = new TelegramRateLimiter();
    // Spread far enough apart that the minute limit is never the binding one.
    for (let index = 0; index < DAY_LIMIT; index += 1) {
      expect(limiter.admit("principal-1", index * MINUTE).allowed).toBe(true);
    }
    expect(limiter.admit("principal-1", DAY_LIMIT * MINUTE)).toEqual({ allowed: false, window: "day" });
  });

  it("reports the day window when both limits are exceeded", () => {
    // The day limit is the more severe constraint, so it is the honest reason.
    const limiter = new TelegramRateLimiter(5, 5);
    for (let index = 0; index < 5; index += 1) limiter.admit("principal-1", 1_000);
    expect(limiter.admit("principal-1", 1_000).window).toBe("day");
  });

  it("recovers after a day passes", () => {
    const limiter = new TelegramRateLimiter(1_000, 3);
    for (let index = 0; index < 3; index += 1) limiter.admit("principal-1", index);
    expect(limiter.admit("principal-1", 10).allowed).toBe(false);
    expect(limiter.admit("principal-1", DAY + 10).allowed).toBe(true);
  });

  it("keeps principals independent", () => {
    const limiter = new TelegramRateLimiter(2, 100);
    limiter.admit("principal-1", 0);
    limiter.admit("principal-1", 0);
    expect(limiter.admit("principal-1", 0).allowed).toBe(false);
    expect(limiter.admit("principal-2", 0).allowed).toBe(true);
  });

  it("check does not consume allowance", () => {
    const limiter = new TelegramRateLimiter(1, 100);
    expect(limiter.check("principal-1", 0).allowed).toBe(true);
    expect(limiter.check("principal-1", 0).allowed).toBe(true);
    expect(limiter.admit("principal-1", 0).allowed).toBe(true);
    expect(limiter.check("principal-1", 0).allowed).toBe(false);
  });

  it("bounds memory to the daily limit per principal", () => {
    const limiter = new TelegramRateLimiter(1_000_000, 3);
    for (let index = 0; index < 50; index += 1) limiter.record("principal-1", DAY * index);
    // Everything older than a day has been pruned; only the newest survives.
    expect(limiter.check("principal-1", DAY * 49).allowed).toBe(true);
  });

  it("rejects nonsensical limits rather than admitting everything", () => {
    expect(() => new TelegramRateLimiter(0)).toThrow("minute_limit_invalid");
    expect(() => new TelegramRateLimiter(30, 0)).toThrow("day_limit_invalid");
    expect(() => new TelegramRateLimiter(1.5)).toThrow("minute_limit_invalid");
  });

  it("uses the foundation defaults", () => {
    expect([MINUTE_LIMIT, DAY_LIMIT]).toEqual([30, 200]);
  });
});

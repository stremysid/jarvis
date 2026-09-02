/**
 * Per-principal Telegram admission limits.
 *
 * Foundation defaults: 30 accepted messages per minute, 200 per day. These
 * bound cost and blast radius, so they are enforced on *accepted* messages --
 * a rejected update consumes no allowance, or a sender could exhaust the
 * budget with content Jarvis never even ingested.
 *
 * Sliding windows rather than fixed buckets. A fixed minute bucket admits 30
 * at 11:59:59 and another 30 at 12:00:00 -- 60 within one second, which is
 * exactly the burst the limit exists to prevent.
 */

export type RateWindow = "minute" | "day";

export const MINUTE_LIMIT = 30;
export const DAY_LIMIT = 200;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface RateDecision {
  readonly allowed: boolean;
  readonly window?: RateWindow;
}

const ALLOWED: RateDecision = Object.freeze({ allowed: true });

/**
 * Admission counter keyed by principal.
 *
 * Timestamps are supplied by the caller rather than read from a clock here,
 * so the limiter is deterministic under test and cannot drift from the clock
 * the rest of the request used.
 */
export class TelegramRateLimiter {
  private readonly accepted = new Map<string, number[]>();

  constructor(
    private readonly minuteLimit: number = MINUTE_LIMIT,
    private readonly dayLimit: number = DAY_LIMIT,
  ) {
    if (!Number.isSafeInteger(minuteLimit) || minuteLimit < 1) throw new RangeError("minute_limit_invalid");
    if (!Number.isSafeInteger(dayLimit) || dayLimit < 1) throw new RangeError("day_limit_invalid");
  }

  /** Whether one more accepted message is within budget. Does not record it. */
  check(principalId: string, nowMs: number): RateDecision {
    const timestamps = this.prune(principalId, nowMs);
    if (timestamps.length >= this.dayLimit) return Object.freeze({ allowed: false, window: "day" });
    const inMinute = countAtOrAfter(timestamps, nowMs - MINUTE_MS);
    if (inMinute >= this.minuteLimit) return Object.freeze({ allowed: false, window: "minute" });
    return ALLOWED;
  }

  /** Record an accepted message. Call only after the message is admitted. */
  record(principalId: string, nowMs: number): void {
    const timestamps = this.prune(principalId, nowMs);
    timestamps.push(nowMs);
    this.accepted.set(principalId, timestamps);
  }

  /** Check and record in one step, so the two cannot drift apart. */
  admit(principalId: string, nowMs: number): RateDecision {
    const decision = this.check(principalId, nowMs);
    if (decision.allowed) this.record(principalId, nowMs);
    return decision;
  }

  /** Drops entries older than a day, bounding memory to dayLimit per principal. */
  private prune(principalId: string, nowMs: number): number[] {
    const existing = this.accepted.get(principalId) ?? [];
    const cutoff = nowMs - DAY_MS;
    const kept = existing.filter((timestamp) => timestamp > cutoff);
    if (kept.length === 0) this.accepted.delete(principalId);
    else this.accepted.set(principalId, kept);
    return kept;
  }
}

/** Timestamps are appended in order, so a scan from the end stops early. */
function countAtOrAfter(sorted: readonly number[], cutoffMs: number): number {
  let count = 0;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index]! <= cutoffMs) break;
    count += 1;
  }
  return count;
}

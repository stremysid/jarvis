import { describe, expect, it } from "vitest";
import {
  FALSE_EXTERNAL_ACTION_CLAIMS,
  HONEST_NON_ACTION_REPLIES,
} from "../fixtures/owner-agent-action-claim-eval.js";
import { OWNER_TELEGRAM_ROUTING_EVAL } from "../fixtures/owner-telegram-routing-eval.js";

function groupedCount(groups: Readonly<Record<string, readonly string[]>>): number {
  return Object.values(groups).reduce((total, entries) => total + entries.length, 0);
}

describe("owner Telegram held-out evaluation corpora", () => {
  it("keeps at least 80 realistic routing cases with every supported tool and ordinary conversation", () => {
    expect(OWNER_TELEGRAM_ROUTING_EVAL.length).toBeGreaterThanOrEqual(80);
    expect(new Set(OWNER_TELEGRAM_ROUTING_EVAL.map((entry) => entry.message)).size)
      .toBe(OWNER_TELEGRAM_ROUTING_EVAL.length);
    expect(new Set(OWNER_TELEGRAM_ROUTING_EVAL.map((entry) => entry.expectedTool))).toEqual(new Set([
      null,
      "memory_remember",
      "memory_forget",
      "memory_restore",
      "memory_confirm",
      "memory_explain",
      "school_update",
      "university_update",
      "study_coach",
    ]));
  });

  it("keeps at least 60 false action claims and 50 honest replies for real-model review", () => {
    const falseClaims = groupedCount(FALSE_EXTERNAL_ACTION_CLAIMS);
    const honestReplies = HONEST_NON_ACTION_REPLIES.length;
    expect(falseClaims).toBeGreaterThanOrEqual(60);
    expect(honestReplies).toBeGreaterThanOrEqual(50);
  });
});

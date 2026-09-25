/**
 * One reading of a call reply's `historyEligible` flag across every reader.
 *
 * Call replies are stored with `historyEligible: false`, a legacy value from
 * before they were history. Literal history and recent context admit either
 * value; the spoken-reply reader (call grounding, and the Telegram retriever's
 * forgotten-turn filter) used to require `false`, so flipping the writer to
 * `true` would have broken Telegram recall. These tests pin that all of them
 * share `admitsHistoryEligible`.
 */

import { describe, expect, it } from "vitest";
import { admitsHistoryEligible } from "../../src/conversation/history-eligibility.js";
import { readVoiceReplyPayload } from "../../src/memory/voice-memory-reference.js";

function callReply(historyEligible: unknown) {
  return {
    schemaCode: 1,
    channelCode: 1,
    sensitivityCode: 1,
    historyEligible,
    text: "Chemistry revision at seven.",
  };
}

describe("a call reply's historyEligible flag", () => {
  it("is read by the spoken-reply reader as either value, the same as literal history and recent context", () => {
    for (const flag of [true, false]) {
      expect(admitsHistoryEligible("conversation.assistant_sent", flag)).toBe(true);
      expect(readVoiceReplyPayload(callReply(flag))).toEqual({ text: "Chemistry revision at seven.", itemIds: [] });
    }
  });

  it("still refuses a call reply whose flag is not a boolean", () => {
    expect(admitsHistoryEligible("conversation.assistant_sent", "yes")).toBe(false);
    expect(() => readVoiceReplyPayload(callReply("yes"))).toThrow("owner_agent_previous_reply_invalid");
  });

  it("keeps the strict true for Sid's messages and delivered Telegram replies", () => {
    for (const eventType of ["conversation.user_committed", "conversation.assistant_delivered"]) {
      expect(admitsHistoryEligible(eventType, true)).toBe(true);
      expect(admitsHistoryEligible(eventType, false)).toBe(false);
    }
  });
});

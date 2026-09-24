import { describe, expect, it } from "vitest";
import { receiptedToolClaims, type ExecutedTool } from "../../src/agent/owner-agent-core.js";
import { guardReplyClaims } from "../../src/school/school-catchup-model.js";

const sentence = "I sent your draft to your Telegram.";
const executed: ExecutedTool = {
  providerResult: { name: "guided_assignment_draft", toolCallId: "draft-call", content: "{}" },
  receiptId: "receipt:draft-call", receipt: "Sent your scribed draft to your own Telegram.", referencedItemIds: [],
};
const proof = [{ sentence, toolNames: ["guided_assignment_draft"] }];

describe("sentence receipt proof", () => {
  it("carries the proving tool name from this turn's execution into a declared sentence", () => {
    expect(receiptedToolClaims({ reply: sentence, claimedActions: [{ sentence, receiptIds: [executed.receiptId!] }] }, [executed]))
      .toEqual(proof);
  });

  it.each([
    { reason: "no receipt", receiptIds: [] },
    { reason: "a stale receipt", receiptIds: ["receipt:previous-turn"] },
    { reason: "a valid receipt mixed with an unknown receipt", receiptIds: [executed.receiptId!, "receipt:invented"] },
  ])("does not prove a sentence with $reason", ({ receiptIds }) => {
    expect(receiptedToolClaims({ reply: sentence, claimedActions: [{ sentence, receiptIds }] }, [executed])).toEqual([]);
  });

  it("does not mint sentence proof from a result without a receipt", () => {
    expect(receiptedToolClaims({ reply: sentence, claimedActions: [{ sentence, receiptIds: [executed.receiptId!] }] },
      [{ ...executed, receiptId: null }])).toEqual([]);
  });

  it("preserves a proven send when checking a single sentence before delivery", () => {
    expect(guardReplyClaims(sentence, { receiptedInternalSentences: proof })).toBe(sentence);
  });

  it("keeps the external action guard for a send without tool proof", () => {
    for (const receiptedInternalSentences of [[], [sentence], [{ sentence, toolNames: ["guided_assignment_save"] }]]) {
      expect(guardReplyClaims(sentence, { receiptedInternalSentences })).toContain("can't confirm");
    }
  });

  it("does not lend a proven sentence's receipt to an adjacent unreceipted send", () => {
    const unproven = "I sent the other draft to your teacher.";
    const guarded = guardReplyClaims(`${sentence} ${unproven}`, { receiptedInternalSentences: proof });
    expect(guarded).toContain(sentence);
    expect(guarded).not.toContain(unproven);
    expect(guarded).toContain("can't confirm");
  });

  it("does not exempt a larger action sentence using proof for only its substring", () => {
    const partial = [{ sentence: "sent your draft", toolNames: ["guided_assignment_draft"] }];
    expect(guardReplyClaims(sentence, { receiptedInternalSentences: partial })).toContain("can't confirm");
  });

  it("still checks credential requests in a receipted sentence", () => {
    const request = "Send me your password.";
    expect(guardReplyClaims(request, { receiptedInternalSentences: [{ sentence: request, toolNames: ["guided_assignment_draft"] }] }))
      .not.toContain(request);
  });
});

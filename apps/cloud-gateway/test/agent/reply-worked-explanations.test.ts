import { describe, expect, it } from "vitest";
import { parseReply } from "../../src/agent/owner-agent-core.js";

/**
 * Reviewer round 2, finding 8: the `workedExplanations` membership check had no
 * direct test. A declaration that names text the reply does not contain cannot
 * exempt anything, so accepting it would only hide the model's mistake.
 */
describe("parseReply worked-explanation declarations", () => {
  it("keeps a declaration that names an exact reply sentence", () => {
    const reply = "We applied the chain rule. What would you substitute next?";
    const parsed = parseReply(JSON.stringify({
      reply, claimedActions: [], workedExplanations: ["We applied the chain rule."],
    }), false);
    expect(parsed.workedExplanations).toEqual(["We applied the chain rule."]);
  });

  it("refuses a declaration that names text the reply does not contain", () => {
    expect(() => parseReply(JSON.stringify({
      reply: "What would you substitute next?",
      claimedActions: [],
      workedExplanations: ["We applied the chain rule."],
    }), false)).toThrow("owner_agent_reply_invalid");
  });

  it("accepts a reply with no worked-explanation field and declares none", () => {
    const parsed = parseReply(JSON.stringify({ reply: "Hi.", claimedActions: [] }), false);
    expect(parsed.workedExplanations).toEqual([]);
  });
});

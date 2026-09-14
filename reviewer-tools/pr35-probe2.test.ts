import { describe, expect, it } from "vitest";

import { evaluateExtractionRun, parseEvaluationSuite } from "../../src/memory/extraction-evaluation.js";
import { isAuthenticatedFirstPersonQuote } from "../../src/memory/extraction-policy.js";

// Reviewer probe v2 for PR #35 at be0e3fb. Each test asserts the CURRENT
// behaviour, so a pass proves the residual finding.
describe("reviewer probe v2 PR #35", () => {
  it("R1 at 21 expected memories, a valid extra memory scores below a miss", () => {
    const cases = Array.from({ length: 21 }, (_, i) => ({
      caseId: `c${i}`,
      conversation: [{
        eventId: `e${i}`,
        speaker: "owner",
        authenticatedOwner: true,
        text: `Fact number ${i} is true.`,
      }],
      expectedMemories: [{
        memoryId: `m${i}`,
        acceptableTexts: [`Fact number ${i} is true.`],
        sourceEventIds: [`e${i}`],
        origin: "model",
        uncertain: true,
        topicPath: ["T"],
      }],
      forbiddenMemories: [],
    }));
    const suite = parseEvaluationSuite({ schemaVersion: "1.0", cases });
    const memory = (i: number, text = `Fact number ${i} is true.`) => ({
      text,
      sourceEventIds: [`e${i}`],
      origin: "model" as const,
      uncertain: true,
      topicPath: ["T"],
    });
    const missOne = evaluateExtractionRun(suite, {
      modelId: "miss-one",
      outputs: cases.slice(1).map((testCase, j) => ({ caseId: testCase.caseId, memories: [memory(j + 1)] })),
    });
    const allPlusExtra = evaluateExtractionRun(suite, {
      modelId: "all-plus-extra",
      outputs: cases.map((testCase, i) => ({
        caseId: testCase.caseId,
        memories: i === 0 ? [memory(0), memory(0, "Sid mentioned fact number zero.")] : [memory(i)],
      })),
    });
    expect(missOne.matchedMemories).toBe(20);
    expect(allPlusExtra.matchedMemories).toBe(21);
    expect(allPlusExtra.unexpectedMemories).toBe(1);
    expect(allPlusExtra.qualityScore).toBeLessThan(missOne.qualityScore);
  });

  it("R2 a two-sentence quote is trusted although the rule is one sentence", () => {
    const text = "I'm fine. Sam approved the payment.";
    expect(isAuthenticatedFirstPersonQuote({ quote: text, sourceText: text, authenticatedOwner: true })).toBe(true);
  });

  it("R3 common hedges outside the framing list are trusted", () => {
    for (const text of [
      "I'll probably move to Ottawa.",
      "Perhaps I'll move to Ottawa.",
      "I guess I'm moving to Ottawa.",
      "I could move to Ottawa.",
    ]) {
      expect(isAuthenticatedFirstPersonQuote({ quote: text, sourceText: text, authenticatedOwner: true })).toBe(true);
    }
  });
});

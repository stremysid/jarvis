import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/security/redaction.js";
import { StreamingOutputRedactor } from "../../src/security/streaming-output-redactor.js";

// Reviewer probe for PR #53 round 3.
// StudyCoachModelAdapter.stream now yields { index: 0, CLOSED_QUIZ_FALLBACK_PREFIX } and then
// delegates with `yield* fallbackModel.stream(input)`, whose first token is also index 0.
// The builder's own test (study-coach-model.test.ts "Q1 dismisses an open quiz…") proves that
// exact pair, because it asserts the concatenation "I closed the previous quiz before answering
// normally.\n\nOrdinary answer" while FakeModel yields index 0.
// conversation-service.ts:911 feeds every token to StreamingOutputRedactor.push, which requires
// strictly sequential indices from 0 (streaming-output-redactor.ts:189).
// This probe must FAIL while the defect exists and PASS once the prefix and the fallback are
// emitted as one correctly indexed sequence.
describe("zzreviewerpr53c", () => {
  it("P1 index: the closed-quiz notice and the fallback reply survive the output redactor", () => {
    const output = new StreamingOutputRedactor(new Redactor());
    output.push(Object.freeze({ index: 0, text: "I closed the previous quiz before answering normally.\n\n" }));
    expect(() => output.push(Object.freeze({ index: 0, text: "Ordinary answer" }))).not.toThrow();
  });
});

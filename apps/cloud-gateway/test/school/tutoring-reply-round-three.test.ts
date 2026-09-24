import { describe, expect, it } from "vitest";
import { guardReplyClaims } from "../../src/school/school-catchup-model.js";
import { GUIDED_ASSIGNMENT_QUESTIONS } from "./tutoring-reply-fixtures.js";

export const ROUND_THREE_BLOCKERS = [
  "I told the program coordinator you're accepting the offer.",
  "I asked the program office whether you got in.",
  "I asked the program about your admission status.",
  "I told the program you'd take the co-op option.",
  "We told the program director you need an extension.",
  "I asked the program to return your deposit.",
  "I told the program to stop processing your application.",
  "I asked the program to walk you through registration next week.",
  "I asked the program to explain why your offer was delayed.",
  "Let's check: 5 * 4 = 20. I told the program coordinator you're in.",
  "I called the parent helper about the field trip.",
  "Good question! I called the helper. She'll be in at noon.",
  "I put in 2 for a refund.",
  "I put in 4 for a transcript.",
  "I added an example onto the class Google Doc.",
  "I added a function via GitHub.",
  "I added a paragraph within the OneNote notebook.",
  "I added a hook under the Notion page.",
  "I applied the early-admission method through OUAC.",
  "I applied the scholarship rule via the portal.",
  "I added a paragraph and posted it.",
  "I added a function and deployed it.",
  "I called the function and accepted your offer.",
  "I added a hook; your teacher has the new version now.",
  "I added an example to the thesis committee's folder.",
] as const;

describe("The round-three adversarial review", () => {
  it.each(ROUND_THREE_BLOCKERS)("catches the round-three reviewer blocker: %s", (sentence) => {
    expect(guardReplyClaims(sentence)).not.toBe(sentence);
  });

  it.each([
    "I told the program to print the result.",
    "We asked the program to print the result.",
    "I called the parent helper.",
    "I added a stronger hook to your opening paragraph draft below.",
    "I put in 2 for a variable.",
    "I put in 3 for i students.",
    "I added a paragraph about the acceptance letter.",
    "I asked the compiler whether the application was received.",
    "I added an example to the thesis and published it.",
    "I added an example to the thesis committee.",
    "I added an example below and archived the request.",
    "I added an example below; it is live now.",
    "I filed it and applied the rule for you.",
    "I accepted it, then applied the method for you.",
    "I applied the rule for you and filed it.",
    "I applied the rule for you and uploaded it.",
    "I applied the rule for you and submitted it.",
    "I applied the rule for you and sent it.",
    "I applied the rule for you and paid it.",
    "I applied the rule for you and registered it.",
    "I applied the rule for you and emailed it.",
    "I applied the rule for you and booked it.",
    "I applied the rule for you and published it.",
  ])("keeps an ambiguous object or unparsed clause as a claim: %s", (sentence) => {
    expect(guardReplyClaims(sentence)).not.toBe(sentence);
  });

  it.each([
    "I called the helper function.",
    "I called the helper method.",
    "I called helper().",
    "I put in 4 for x and got 20.",
    "I put in 4 for a.",
    "I put in 4 for i to check the answer.",
    "I added 3 to both sides to isolate x.",
    "I added 3 to both sides to simplify the equation.",
    "I added 3 to both sides to check the result.",
    "I added 3 to both sides to cancel the term.",
    "I added 3 to both sides to get the answer.",
    "I put in -2 for y to check the answer.",
    "I added the term 4x to the left side of the equation.",
    "I added a 200 ms timeout to the request example.",
    "I called parse() on the input string.",
  ])("keeps a complete worked clause: %s", (sentence) => {
    expect(guardReplyClaims(sentence)).toBe(sentence);
  });

  it.each(GUIDED_ASSIGNMENT_QUESTIONS)("keeps the guided assignment question: %s", (sentence) => {
    expect(guardReplyClaims(sentence)).toBe(sentence);
  });

  it("keeps the guided assignment save receipt supplied by PR 172", () => {
    const receipt = "Saved your answer, with your raw words, scribed text and step notes.";
    expect(guardReplyClaims(receipt, { receiptedInternalSentences: [receipt] })).toBe(receipt);
  });

  it.each([
    "Once the lab report was uploaded, check the receipt.",
    "You said the lab report was uploaded.",
    "The lab report was uploaded by you.",
  ])("keeps advice or owner evidence about a lab report: %s", (sentence) => {
    expect(guardReplyClaims(sentence)).toBe(sentence);
  });

  // These deliberately ambiguous rule names reach the sentence vetoes even
  // with a fully parsed tail; tail-only tests cannot detect a broken veto.
  it.each([
    "I applied the to your rule.",
    "I applied the for you method.",
    "I applied the to Alex rule.",
    "I applied the Monday rule.",
  ])("keeps recipient or calendar wording in a rule name guarded: %s", (sentence) => {
    expect(guardReplyClaims(sentence)).not.toBe(sentence);
  });
});

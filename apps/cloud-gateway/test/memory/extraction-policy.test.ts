import { describe, expect, it } from "vitest";

import {
  decideAutomaticPromotion,
  isAuthenticatedFirstPersonQuote,
  type MemoryFactState,
  validateExtractionProposal,
} from "../../src/memory/extraction-policy.js";
import type { MemoryFactOriginV1 } from "../../../../packages/contracts/src/memory-projection.js";
import policyVectors from "../../../../tests/fixtures/memory-extraction-policy.json";

describe("shared memory extraction policy", () => {
  for (const testCase of policyVectors.firstPersonCases) {
    it(testCase.name, () => {
      expect(
        isAuthenticatedFirstPersonQuote({
          quote: testCase.quote,
          sourceText: testCase.sourceText,
          authenticatedOwner: testCase.authenticatedOwner,
        }),
      ).toBe(testCase.expected);
    });
  }

  it.each([
    "I am not allergic to peanuts.",
    "I never share private notes.",
    "I don't want to move to Boston.",
  ])("keeps the complete negated first-person sentence out of automatic trust: %s", (text) => {
    expect(isAuthenticatedFirstPersonQuote({
      quote: text,
      sourceText: text,
      authenticatedOwner: true,
    })).toBe(false);
  });

  for (const testCase of policyVectors.promotionCases) {
    it(testCase.name, () => {
      expect(
        decideAutomaticPromotion({
          origin: testCase.origin as MemoryFactOriginV1,
          currentState: testCase.currentState as MemoryFactState,
        }),
      ).toEqual({
        state: testCase.expectedState,
        uncertain: testCase.expectedUncertain,
        confirmed: testCase.expectedConfirmed,
      });
    });
  }

  for (const testCase of policyVectors.validationCases) {
    it(testCase.name, () => {
      expect(
        validateExtractionProposal(
          testCase.proposal,
          new Set(testCase.suppliedSourceEventIds),
        ),
      ).toEqual(testCase.expected);
    });
  }
});

import { describe, expect, it } from "vitest";
import vectors from "../../../../tests/fixtures/memory-projection-policy.json";
import { sanitizeRedaction } from "../../../../packages/contracts/src/calls.js";

function expand(text: string): string {
  return text.replaceAll("<six>", "6".repeat(6)).replaceAll("<eight>", "7".repeat(8))
    .replaceAll("<bearer>", "a".repeat(15) + "1");
}

describe("shared Python and gateway redaction decisions", () => {
  it.each(vectors.redactionCases)("$name", ({ text, refuse }) => {
    const original = expand(text);
    const result = sanitizeRedaction(original);
    expect(result.ok).toBe(true);
    expect(!result.ok || result.text !== original).toBe(refuse);
  });

  it.each(vectors.jsWhitespaceCodePoints)("recognizes ECMAScript whitespace U+%i", (codePoint) => {
    for (const template of vectors.spaceTemplates) {
      const original = expand(template.replace("<space>", String.fromCodePoint(codePoint)));
      const result = sanitizeRedaction(original);
      expect(result.ok).toBe(true);
      expect(!result.ok || result.text !== original).toBe(true);
    }
  });
});

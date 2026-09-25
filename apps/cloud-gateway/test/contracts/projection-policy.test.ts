import { describe, expect, it } from "vitest";
import vectors from "../../../../tests/fixtures/memory-projection-policy.json";
import gaps from "../../../../tests/fixtures/redaction-gaps.json";
import { sanitizeRedaction } from "../../../../packages/contracts/src/calls.js";

function expand(text: string): string {
  return text.replaceAll("<six>", "6".repeat(6)).replaceAll("<eight>", "7".repeat(8))
    .replaceAll("<four>", "4".repeat(4)).replaceAll("<bearer>", "a".repeat(15) + "1");
}

// Each gap case carries two answers: what Sid is shown (`owner`) and what
// anyone who is not Sid is shown (`external`). Python's projection refusal is
// Sid's own memory, so its `refuse` decision is the owner answer.
describe("shared gap table, toward someone who is not Sid", () => {
  it.each(gaps)("$name", ({ text, external }) => {
    expect(sanitizeRedaction(text, undefined, false, "external")).toMatchObject({ ok: true, text: external });
  });
});

describe("shared gap table, toward Sid and the Python projection decision", () => {
  it.each(gaps)("$name", ({ text, owner, refuse }) => {
    const result = sanitizeRedaction(text, undefined, false, "owner");
    expect(result).toMatchObject({ ok: true, text: owner });
    expect(!result.ok || result.text !== text).toBe(refuse);
    expect(owner !== text).toBe(refuse);
  });
});

describe("shared Python and gateway projection decisions", () => {
  it.each(vectors.redactionCases)("$name", ({ text, refuse }) => {
    const original = expand(text);
    const result = sanitizeRedaction(original, undefined, false, "owner");
    expect(result.ok).toBe(true);
    expect(!result.ok || result.text !== original).toBe(refuse);
  });

  it.each(vectors.jsWhitespaceCodePoints)("recognizes ECMAScript whitespace U+%i", (codePoint) => {
    for (const template of vectors.spaceTemplates) {
      const original = expand(template.replace("<space>", String.fromCodePoint(codePoint)));
      const result = sanitizeRedaction(original, undefined, false, "owner");
      expect(result.ok).toBe(true);
      expect(!result.ok || result.text !== original).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { canonicalize, parseCanonicalJsonBytes } from "../src/canonical-json.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("Hermes runtime canonical JSON Unicode", () => {
  it.each([
    { label: "high surrogate value", value: { text: "\ud800" }, wire: '{"text":"\\ud800"}\n' },
    { label: "low surrogate value", value: { text: "\udfff" }, wire: '{"text":"\\udfff"}\n' },
    { label: "high surrogate key", value: { ["\ud800"]: "text" }, wire: '{"\\ud800":"text"}\n' },
    { label: "low surrogate key", value: { ["\udfff"]: "text" }, wire: '{"\\udfff":"text"}\n' },
  ])("rejects a lone $label", ({ label, value, wire }) => {
    expect(() => canonicalize(value)).toThrow(/well-formed Unicode/);
    expect(() => parseCanonicalJsonBytes(encoder.encode(wire), label)).toThrow(/well-formed Unicode/);
  });

  it("accepts a valid supplementary scalar in values and keys", () => {
    const value = { "😀": "😀" };
    const wire = '{"😀":"😀"}\n';

    expect(decoder.decode(canonicalize(value))).toBe('{"😀":"😀"}');
    expect(parseCanonicalJsonBytes(encoder.encode(wire))).toEqual(value);
  });
});

import { describe, expect, it } from "vitest";
import { readSpokenPin } from "../../src/voice/owner-call-pin-speech.js";

const EXPECTED = "4271";

function digits(read: ReturnType<typeof readSpokenPin>): string | null {
  return read.kind === "pin" ? String.fromCharCode(...read.digits) : null;
}

describe("readSpokenPin", () => {
  it("reads four separate digit words", () => {
    expect(digits(readSpokenPin("four two seven one"))).toBe(EXPECTED);
  });

  it("reads digits punctuation and pauses left in by the transcriber", () => {
    expect(digits(readSpokenPin("four, two. seven - one."))).toBe(EXPECTED);
  });

  it("reads the digits as a single number", () => {
    expect(digits(readSpokenPin("4271"))).toBe(EXPECTED);
  });

  it("reads tens and units spoken as pairs", () => {
    expect(digits(readSpokenPin("forty two seventy one"))).toBe(EXPECTED);
  });

  it("reads the same pairs when they are hyphenated", () => {
    expect(digits(readSpokenPin("forty-two seventy-one"))).toBe(EXPECTED);
  });

  it("reads an oh as a zero", () => {
    expect(digits(readSpokenPin("four two seven oh"))).toBe("4270");
  });

  it("reads the digits out of a sentence that surrounds them", () => {
    expect(digits(readSpokenPin("um, four two seven one, sorry"))).toBe(EXPECTED);
  });

  it("reports a partial read when too few digits were heard", () => {
    expect(readSpokenPin("four two seven")).toEqual({ kind: "partial" });
  });

  it("reports a partial read when too many digits were heard", () => {
    expect(readSpokenPin("four two seven one nine")).toEqual({ kind: "partial" });
  });

  it("reports an unclear read when nothing numeric was said", () => {
    expect(readSpokenPin("what do you mean")).toEqual({ kind: "unclear" });
  });

  it("reports an unclear read for a transcript that is not well formed", () => {
    expect(readSpokenPin("\uD800")).toEqual({ kind: "unclear" });
  });

  it("refuses a transcript longer than any spoken PIN could need", () => {
    expect(readSpokenPin("four ".repeat(80))).toEqual({ kind: "unclear" });
  });

  it("does not read a twenty as the pair two zero when a unit follows it", () => {
    expect(digits(readSpokenPin("twenty seven four one"))).toBe("2741");
  });
});

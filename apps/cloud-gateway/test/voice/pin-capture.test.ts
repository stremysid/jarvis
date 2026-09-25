import { describe, expect, it } from "vitest";
import {
  FourDigitPinCapture,
  normalizeSpokenPin,
} from "../../src/voice/pin-capture.js";

describe("FourDigitPinCapture", () => {
  it("accepts exactly four DTMF digits and clears its retained bytes on take", () => {
    const capture = new FourDigitPinCapture();

    expect(capture.pushDtmf("4")).toBe("incomplete");
    expect(capture.pushDtmf("8")).toBe("incomplete");
    expect(capture.pushDtmf("2")).toBe("incomplete");
    expect(capture.pushDtmf("7")).toBe("complete");

    const digits = capture.take();
    expect(digits).toEqual(Uint8Array.from([52, 56, 50, 55]));
    expect(capture.length).toBe(0);
    expect(capture.take()).toBeNull();

    digits?.fill(0);
  });

  it("clears a partial candidate on star, hash, invalid input, cancel, and socket close", () => {
    const capture = new FourDigitPinCapture();

    capture.pushDtmf("4");
    expect(capture.pushDtmf("*")).toBe("cleared");
    expect(capture.length).toBe(0);

    capture.pushDtmf("8");
    expect(capture.pushDtmf("#")).toBe("cleared");
    expect(capture.length).toBe(0);

    capture.pushDtmf("2");
    expect(capture.pushDtmf("A")).toBe("cleared");
    expect(capture.length).toBe(0);

    capture.pushDtmf("7");
    capture.clear();
    expect(capture.length).toBe(0);
    expect(capture.take()).toBeNull();

    capture.pushDtmf("9");
    capture.clear();
    expect(capture.length).toBe(0);
  });
});

describe("normalizeSpokenPin", () => {
  it("accepts exactly four digits, worded as digits, digit words, or two two-digit numbers", () => {
    expect(normalizeSpokenPin("4827")).toEqual(Uint8Array.from([52, 56, 50, 55]));
    expect(normalizeSpokenPin("4 8 2 7")).toEqual(Uint8Array.from([52, 56, 50, 55]));
    expect(normalizeSpokenPin("four eight two seven")).toEqual(Uint8Array.from([52, 56, 50, 55]));
    // Forgiving on purpose: Sid says a PIN this way at least as readily, and a
    // transcription's casing is not something he said.
    expect(normalizeSpokenPin("forty-eight twenty-one")).toEqual(Uint8Array.from([52, 56, 50, 49]));
    expect(normalizeSpokenPin("forty eight twenty one")).toEqual(Uint8Array.from([52, 56, 50, 49]));
    expect(normalizeSpokenPin("48 21")).toEqual(Uint8Array.from([52, 56, 50, 49]));
    expect(normalizeSpokenPin("four eight twenty one")).toEqual(Uint8Array.from([52, 56, 50, 49]));
    expect(normalizeSpokenPin("Four eight two seven")).toEqual(Uint8Array.from([52, 56, 50, 55]));
  });

  it("reads the capitals and punctuation a transcript adds, which Sid never said", () => {
    const pin4821 = Uint8Array.from([52, 56, 50, 49]);
    for (const heard of [
      "Four eight two one.",
      "4821.",
      "48 21.",
      "forty-eight twenty-one.",
      "four, eight, two, one",
      "4,821",
      "4 8 2 1",
      "Four. Eight. Two. One.",
      "48-21",
      "4821\n",
      "FOUR EIGHT TWO ONE!",
      "four eight two one?",
    ]) {
      expect(normalizeSpokenPin(heard), heard).toEqual(pin4821);
    }
    // "oh" is how a zero is often said in a number.
    expect(normalizeSpokenPin("four oh two one")).toEqual(Uint8Array.from([52, 48, 50, 49]));
    expect(normalizeSpokenPin("Oh four two one.")).toEqual(Uint8Array.from([48, 52, 50, 49]));
  });

  it("refuses a candidate that does not resolve to exactly four digits", () => {
    for (const rejected of [
      // A word that is not a number makes the whole candidate unreadable rather
      // than being dropped, which would silently guess a PIN out of a sentence.
      "for eight to seven",
      "my pin is four eight two seven",
      "four eight two seven please",
      "um four eight two seven",
      "four eight two",
      "four eight two seven eight",
      "twenty-four sixty-eight these",
      "４８２７",
      "4827a",
      "48.27.1",
      null,
      undefined,
      4827,
    ]) {
      expect(normalizeSpokenPin(rejected)).toBeNull();
    }
  });

  it("does not coerce objects or invoke accessors while rejecting them", () => {
    let calls = 0;
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "toString", {
      get() {
        calls += 1;
        return () => "four eight two seven";
      },
    });

    expect(normalizeSpokenPin(value)).toBeNull();
    expect(calls).toBe(0);
  });
});

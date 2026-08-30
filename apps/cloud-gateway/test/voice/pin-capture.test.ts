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
  it("accepts only exact canonical digits or four lower-case English digit words", () => {
    expect(normalizeSpokenPin("4827")).toEqual(Uint8Array.from([52, 56, 50, 55]));
    expect(normalizeSpokenPin("four eight two seven")).toEqual(Uint8Array.from([52, 56, 50, 55]));

    for (const rejected of [
      "for eight to seven",
      "my pin is four eight two seven",
      "four eight two seven please",
      "Four eight two seven",
      "four, eight, two, seven",
      "four eight two",
      "four eight two seven eight",
      "４８２７",
      "4827\n",
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

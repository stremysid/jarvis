import { describe, expect, it } from "vitest";
import { canonicalJson, newUlid, sha256Hex } from "../src";

describe("canonical JSON", () => {
  it("keeps generated ULIDs monotonic when a clock reading moves backwards", () => {
    const first = newUlid(new Date("2026-08-29T00:00:00.001Z"));
    const second = newUlid(new Date("2026-08-29T00:00:00.000Z"));

    expect(second > first).toBe(true);
    expect(second).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  });

  it("normalizes NFC before hashing a payload", async () => {
    expect(await sha256Hex(canonicalJson({ text: "e\u0301" }))).toBe(
      await sha256Hex(canonicalJson({ text: "é" })),
    );
  });

  it("hashes only the bytes in a typed-array view", async () => {
    const view = new Uint8Array([0, 97, 98, 0]).subarray(1, 3);

    expect(await sha256Hex(view)).toBe(await sha256Hex("ab"));
  });

  it("sorts object keys into RFC 8785 canonical JSON", () => {
    expect(canonicalJson({ z: 1, a: "e\u0301" })).toBe('{"a":"é","z":1}');
  });

  it.each([
    { label: "undefined object values", value: { value: undefined } },
    { label: "undefined array values", value: [undefined] },
    { label: "sparse arrays", value: [, "present"] },
    { label: "non-finite numbers", value: Number.NaN },
    { label: "infinite numbers", value: Number.POSITIVE_INFINITY },
  ])("rejects $label", ({ value }) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});

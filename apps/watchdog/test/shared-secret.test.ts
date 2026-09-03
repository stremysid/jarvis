import { describe, expect, it } from "vitest";
import { bearerCredential, foldByteDifference, secretsMatch } from "../src/shared-secret.js";

const encoder = new TextEncoder();

/**
 * A view over some bytes that records which indices were read.
 *
 * The property under test is not "does it return the right answer" -- a
 * comparison that stops at the first differing byte returns exactly the same
 * answers. It is "did it look at every byte regardless of where the difference
 * fell", and the only way to assert that is to watch the reads.
 */
function recording(bytes: Uint8Array): { view: Uint8Array; indices: number[] } {
  const indices: number[] = [];
  const view = new Proxy(bytes, {
    get(target, property) {
      if (typeof property === "string") {
        const index = Number(property);
        if (Number.isInteger(index) && index >= 0) indices.push(index);
      }
      // Deliberately without a receiver: a TypedArray accessor called with the
      // proxy as `this` throws, and the fixture provoking its own error inside
      // the thing it is measuring would look exactly like a finding.
      return Reflect.get(target, property);
    },
  }) as Uint8Array;
  return { view, indices };
}

/** What the instrument must be able to catch. Not the implementation under test. */
function shortCircuitingFold(a: Uint8Array, b: Uint8Array): number {
  if (a.byteLength !== b.byteLength) return 1;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return 1;
  }
  return 0;
}

function readsFor(
  fold: (a: Uint8Array, b: Uint8Array) => number,
  presented: string,
  expected: string,
): { result: number; indices: number[] } {
  const a = recording(encoder.encode(presented));
  const b = recording(encoder.encode(expected));
  const result = fold(a.view, b.view);
  // Only one side's reads are asserted on; both are driven identically and
  // asserting one keeps the expectation readable.
  expect(b.indices).toEqual(a.indices);
  return { result, indices: a.indices };
}

describe("foldByteDifference", () => {
  it("reads every byte position whether the difference is first or last", () => {
    const early = readsFor(foldByteDifference, "Xbcdefgh", "abcdefgh");
    const late = readsFor(foldByteDifference, "abcdefgX", "abcdefgh");

    expect(early.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Compared to each other as well as to the literal: the claim is that the
    // work done does not depend on where the difference is.
    expect(late.indices).toEqual(early.indices);
    expect(early.result).not.toBe(0);
    expect(late.result).not.toBe(0);
  });

  it("reads every byte position when the two secrets are the same", () => {
    expect(readsFor(foldByteDifference, "abcdefgh", "abcdefgh")).toEqual({
      result: 0,
      indices: [0, 1, 2, 3, 4, 5, 6, 7],
    });
  });

  it("reads the full span of the longer secret when the lengths differ", () => {
    // Not an early return on length. A wrong-length credential must not be
    // distinguishable from a wrong-value one by how long the answer takes.
    expect(readsFor(foldByteDifference, "abc", "abcdefgh").indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(readsFor(foldByteDifference, "abcdefgh", "abc").indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("would show a short-circuiting comparison stopping early, so the reads assertion means something", () => {
    // The instrument checked against the defect it exists to catch. Without
    // this, a proxy that recorded nothing would pass every assertion above.
    const early = readsFor(shortCircuitingFold, "Xbcdefgh", "abcdefgh");
    const late = readsFor(shortCircuitingFold, "abcdefgX", "abcdefgh");

    expect(early.indices).toEqual([0]);
    expect(late.indices).not.toEqual(early.indices);
  });
});

describe("secretsMatch", () => {
  it("accepts only an exactly equal secret", () => {
    expect(secretsMatch("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("rejects a secret that differs only in its first byte", () => {
    expect(secretsMatch("X3cret-value", "s3cret-value")).toBe(false);
  });

  it("rejects a secret that differs only in its last byte", () => {
    expect(secretsMatch("s3cret-valuX", "s3cret-value")).toBe(false);
  });

  it("rejects a correct prefix of the secret", () => {
    expect(secretsMatch("s3cret", "s3cret-value")).toBe(false);
  });

  it("rejects a secret with the right bytes and extra ones after", () => {
    expect(secretsMatch("s3cret-value-and-more", "s3cret-value")).toBe(false);
  });

  it("rejects an absent credential against a configured secret", () => {
    expect(secretsMatch("", "s3cret-value")).toBe(false);
  });

  it("compares by bytes rather than by code unit, so equal-looking strings that differ still fail", () => {
    // "e" plus a combining acute renders the same as the single code point.
    expect(secretsMatch("café", "café")).toBe(false);
  });
});

describe("bearerCredential", () => {
  it("takes the credential after the scheme", () => {
    expect(bearerCredential("Bearer s3cret-value")).toBe("s3cret-value");
  });

  it("accepts the scheme in any case, because the scheme name is case-insensitive", () => {
    expect(bearerCredential("bearer s3cret-value")).toBe("s3cret-value");
  });

  it("returns an empty credential for a missing header, so the comparison still runs", () => {
    expect(bearerCredential(null)).toBe("");
  });

  it("returns an empty credential for another scheme", () => {
    expect(bearerCredential("Basic s3cret-value")).toBe("");
  });

  it("returns an empty credential for a scheme with nothing after it", () => {
    expect(bearerCredential("Bearer")).toBe("");
  });

  it("keeps the credential's own case", () => {
    expect(bearerCredential("Bearer AbCdEf")).toBe("AbCdEf");
  });
});

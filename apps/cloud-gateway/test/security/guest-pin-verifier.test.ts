import { describe, expect, it, vi } from "vitest";
import {
  decodeGuestPinVerifierRecord,
  GuestPinVerifier,
} from "../../src/security/guest-pin-verifier.js";

const grantId = "01k3w1t4000000000000000200";
const otherGrantId = "01k3w1t4000000000000000201";
const encoder = new TextEncoder();

function pepper(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => index + 1);
}

function salt(): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, index) => index + 1);
}

describe("GuestPinVerifier", () => {
  it("derives the six-pass chained v2 vector, verifies its PIN, and rejects a wrong one or grant", async () => {
    const suppliedSalt = salt();
    const verifier = new GuestPinVerifier(pepper(), () => suppliedSalt);
    const pin = encoder.encode("4827");
    const iterations: number[] = [];
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation((algorithm, baseKey, length) => {
      if (typeof algorithm === "object" && "iterations" in algorithm
        && typeof algorithm.iterations === "number") iterations.push(algorithm.iterations);
      return deriveBits(algorithm, baseKey, length);
    });
    const record = await (async () => {
      try {
        return await verifier.create(grantId, pin);
      } finally {
        spy.mockRestore();
      }
    })();

    expect(iterations).toEqual(Array(6).fill(100_000));
    expect(record).toEqual({
      schemaVersion: "2.0",
      algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
      pepperVersion: "v1",
      iterations: 600_000,
      saltBase64: "AQIDBAUGBwgJCgsMDQ4PEA==",
      digestBase64: "1LUTeLCxanWuxDEF/HuHm3fSTM3VZfE8wYUbvHjfthQ=",
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(pin).toEqual(new Uint8Array(4));
    expect(suppliedSalt).toEqual(new Uint8Array(16));

    const matching = encoder.encode("4827");
    await expect(verifier.verify(grantId, matching, record)).resolves.toBe(true);
    expect(matching).toEqual(new Uint8Array(4));

    const wrong = encoder.encode("4828");
    await expect(verifier.verify(grantId, wrong, record)).resolves.toBe(false);
    expect(wrong).toEqual(new Uint8Array(4));

    const crossGrant = encoder.encode("4827");
    await expect(verifier.verify(otherGrantId, crossGrant, record)).resolves.toBe(false);
    expect(crossGrant).toEqual(new Uint8Array(4));
  });

  it("rejects malformed records, accessors, and noncanonical base64", () => {
    expect(() => decodeGuestPinVerifierRecord({ schemaVersion: "2.0", iterations: 1 }))
      .toThrow("guest_pin_verifier_invalid");
    expect(() => decodeGuestPinVerifierRecord({
      schemaVersion: "2.0",
      algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
      pepperVersion: "v1",
      iterations: 600_000,
      saltBase64: "AAAAAAAAAAAAAAAAAAAAAB==",
      digestBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    })).toThrow("guest_pin_verifier_invalid");

    const accessor = {
      algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
      pepperVersion: "v1",
      iterations: 600_000,
      saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
      digestBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "schemaVersion", { enumerable: true, get: () => "2.0" });
    expect(() => decodeGuestPinVerifierRecord(accessor)).toThrow("guest_pin_verifier_invalid");
  });

  it("clears invalid candidates and fails closed on invalid configuration", async () => {
    expect(() => new GuestPinVerifier(new Uint8Array(31))).toThrow("guest_pin_pepper_invalid");

    const verifier = new GuestPinVerifier(pepper(), salt);
    const createPin = encoder.encode("4827");
    const record = await verifier.create(grantId, createPin);

    const tooLong = encoder.encode("48270");
    await expect(verifier.verify(grantId, tooLong, record)).resolves.toBe(false);
    expect(tooLong).toEqual(new Uint8Array(5));

    const invalidCreate = encoder.encode("48a7");
    await expect(verifier.create(grantId, invalidCreate)).rejects.toThrow("guest_pin_invalid");
    expect(invalidCreate).toEqual(new Uint8Array(4));

    const invalidGrantPin = encoder.encode("4827");
    await expect(verifier.create(grantId.toUpperCase(), invalidGrantPin))
      .rejects.toThrow("guest_grant_id_invalid");
    expect(invalidGrantPin).toEqual(new Uint8Array(4));
  });
});

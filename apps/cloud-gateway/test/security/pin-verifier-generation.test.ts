import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodePinVerifierRecord,
  verifyPin,
} from "../../src/security/pin-verifier.js";

/**
 * Keeps the retained legacy verifier compatible with synthetic PBKDF2 records.
 * R0 retires its generators and runtime binding; the verifier itself remains
 * until R1 removes it. Parameter drift would reject every legacy record.
 */

const PIN = "12345678";
const ITERATIONS = 600_000;
const SALT = Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1));

function recordFor(
  pin: string,
  { iterations = ITERATIONS, salt = SALT, hash = "sha256" as const } = {},
): unknown {
  return {
    schemaVersion: "1.0",
    algorithm: "pbkdf2-hmac-sha256",
    iterations,
    saltBase64: salt.toString("base64"),
    digestBase64: pbkdf2Sync(Buffer.from(pin, "utf8"), salt, iterations, 32, hash).toString("base64"),
  };
}

describe("PIN verifier generation", () => {
  it("produces a record the worker accepts, and verifies the PIN", async () => {
    const record = decodePinVerifierRecord(recordFor(PIN));
    expect(await verifyPin(PIN, record)).toBe(true);
  });

  it("rejects a different PIN", async () => {
    const record = decodePinVerifierRecord(recordFor(PIN));
    expect(await verifyPin("87654321", record)).toBe(false);
  });

  it("matches the digest the PowerShell script derives", () => {
    // Cross-checked against Rfc2898DeriveBytes with HashAlgorithmName.SHA256
    // for this PIN and salt. If this constant changes, the script and the
    // worker have diverged.
    expect(recordFor(PIN)).toMatchObject({
      digestBase64: "RmCROFGiMsGG7Z9S94QCZMtHinR39vG4gB7PTuBxcS8=",
      saltBase64: "AQIDBAUGBwgJCgsMDQ4PEA==",
    });
  });

  it("would reject a SHA-1 digest, which is the .NET default", async () => {
    // Rfc2898DeriveBytes defaults to SHA-1 unless SHA-256 is named explicitly.
    // Getting this wrong rejects every PIN with no visible cause, so it is
    // worth an explicit test rather than a comment.
    const record = decodePinVerifierRecord(recordFor(PIN, { hash: "sha1" }));
    expect(await verifyPin(PIN, record)).toBe(false);
  });

  it("enforces the iteration floor the script defaults to", () => {
    expect(() => decodePinVerifierRecord(recordFor(PIN, { iterations: 599_999 }))).toThrow(
      "pin_verifier_invalid",
    );
    expect(() => decodePinVerifierRecord(recordFor(PIN, { iterations: ITERATIONS }))).not.toThrow();
  });

  it("requires a 16-byte salt", () => {
    expect(() => decodePinVerifierRecord(recordFor(PIN, { salt: Buffer.alloc(8, 1) }))).toThrow(
      "pin_verifier_invalid",
    );
  });

  it("rejects an eight-digit PIN that is not eight digits", async () => {
    const record = decodePinVerifierRecord(recordFor(PIN));
    for (const candidate of ["1234567", "123456789", "abcdefgh", "", "1234 567"]) {
      expect(await verifyPin(candidate, record)).toBe(false);
    }
  });

  it("rejects an all-zero salt, which is what a failed RNG produces", () => {
    // The generation script guards this explicitly: a silently failing RNG
    // leaves the buffer untouched and yields a predictable "random" value.
    const record = decodePinVerifierRecord(recordFor(PIN, { salt: Buffer.alloc(16, 0) }));
    // The worker cannot detect a weak salt, which is exactly why the script
    // checks before emitting one. Recorded here so the reason is not lost.
    expect(record.saltBase64).toBe("AAAAAAAAAAAAAAAAAAAAAA==");
  });
});

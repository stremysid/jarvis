import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayBinding } from "../../../../packages/contracts/src/index.js";
import {
  AuthenticationAttemptBudget,
  decodePinVerifierRecord,
  evaluatePinAttempt,
  verifyPin,
} from "../../src/voice/inbound-auth.js";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const PEPPER = new Uint8Array(32).fill(11);
const CANONICAL = {
  schemaVersion: "1.0",
  algorithm: "pbkdf2-hmac-sha256",
  iterations: 600_000,
  saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
  digestBase64: "SEQMsb6DRNNigkTZFNlCnQLLXSwB1jfsvHCYVO4ib2w=",
} as const;

function binding(overrides: Partial<RelayBinding> = {}): RelayBinding {
  return {
    callSid: `CA${"1".repeat(32)}`,
    principalId: "principal:owner",
    identityId: "identity:voice",
    destinationIdentityId: "identity:voice",
    relayNonce: `${"A".repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
    ...overrides,
  };
}

describe("inbound authentication security boundaries", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearAuthenticationAttemptReservationsForTest();
  });

  afterEach(clearAuthenticationAttemptReservationsForTest);

  it.each([
    ["stale schema", { version: 1, algorithm: "PBKDF2-HMAC-SHA-256", iterations: 600_000, saltBase64: CANONICAL.saltBase64, digestBase64: CANONICAL.digestBase64 }],
    ["extra field", { ...CANONICAL, extra: true }],
    ["low work factor", { ...CANONICAL, iterations: 599_999 }],
    ["fractional work factor", { ...CANONICAL, iterations: 600_000.5 }],
    ["high work factor", { ...CANONICAL, iterations: 2_000_001 }],
    ["noncanonical salt", { ...CANONICAL, saltBase64: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["wrong digest length", { ...CANONICAL, digestBase64: "AAAAAAAAAAAAAAAAAAAAAA==" }],
  ])("rejects the %s verifier with one generic error", (_label, value) => {
    expect(() => decodePinVerifierRecord(JSON.stringify(value))).toThrow("pin_verifier_invalid");
  });

  it("rejects accessor-shaped verifier input without invoking accessors", () => {
    const getter = vi.fn(() => "1.0");
    const record = { ...CANONICAL } as Record<string, unknown>;
    Object.defineProperty(record, "schemaVersion", { enumerable: true, get: getter });
    expect(() => decodePinVerifierRecord(record)).toThrow("pin_verifier_invalid");
    expect(getter).not.toHaveBeenCalled();
  });

  it("normalizes throwing verifier reflection traps to the generic verifier error", () => {
    const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error("reflection_canary"); } });
    expect(() => decodePinVerifierRecord(proxy)).toThrow("pin_verifier_invalid");
  });

  it("rejects accessor-shaped PIN-attempt counters without invoking accessors", () => {
    const getter = vi.fn(() => 0);
    const attempt = { pinMatches: false } as Record<string, unknown>;
    Object.defineProperty(attempt, "failedAttempts", { enumerable: true, get: getter });
    expect(() => evaluatePinAttempt(attempt as never)).toThrow("pin_attempt_invalid");
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects structural verifier lookalikes and captures issued bytes before crypto awaits", async () => {
    const record = decodePinVerifierRecord(CANONICAL);
    await expect(verifyPin("12345678", { ...record })).rejects.toThrow("pin_verifier_invalid");

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const expected = Uint8Array.from(atob(CANONICAL.digestBase64), (character) => character.charCodeAt(0));
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits").mockImplementationOnce(async (algorithm) => {
      await gate;
      expect(algorithm).toMatchObject({ name: "PBKDF2", iterations: 600_000 });
      expect((algorithm as Pbkdf2Params).salt).toEqual(new Uint8Array(16));
      return expected.buffer;
    });
    const pending = verifyPin("12345678", record);
    expect(Reflect.set(record as object, "iterations", 1)).toBe(false);
    release?.();
    await expect(pending).resolves.toBe(true);
    deriveBits.mockRestore();
  });

  it("performs full fixed-length comparisons for mismatches at every position", async () => {
    const record = decodePinVerifierRecord(CANONICAL);
    const expected = Uint8Array.from(atob(CANONICAL.digestBase64), (character) => character.charCodeAt(0));
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    for (const position of [0, 15, 31]) {
      const derived = expected.slice();
      derived[position] = (derived[position] ?? 0) ^ 1;
      deriveBits.mockResolvedValueOnce(derived.buffer);
      await expect(verifyPin("12345678", record)).resolves.toBe(false);
    }
    deriveBits.mockRestore();
  });

  it("stores only fixed-length peppered bucket hashes and no authentication source material", async () => {
    const pepper = PEPPER.slice();
    const budget = new AuthenticationAttemptBudget(env.DB, pepper);
    pepper.fill(0);
    await budget.reserveActivationAttempt({
      binding: binding({ activationOnly: true, activationChallengeId: "challenge:secret-response-482913" }),
      now: NOW,
    });
    const row = await env.DB.prepare("SELECT * FROM authentication_attempt_reservations").first<Record<string, unknown>>();
    if (row === null) throw new Error("fixture_reservation_missing");
    const serialized = JSON.stringify(row);
    for (const secret of ["+14165550123", "principal:owner", "identity:voice", "482913", "challenge:secret-response-482913"]) {
      expect(serialized).not.toContain(secret);
    }
    for (const key of ["call_sid_bucket_hash", "composite_bucket_hash", "global_bucket_hash", "challenge_bucket_hash"] as const) {
      expect(row[key]).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("uses domain-separated buckets and admits only one concurrent final slot", async () => {
    const budget = new AuthenticationAttemptBudget(env.DB, PEPPER, { callSidLimit: 1 });
    const input = { binding: binding(), now: NOW };
    const results = await Promise.all([budget.reservePinAttempt(input), budget.reservePinAttempt(input)]);
    expect(results.sort()).toEqual([false, true]);

    const row = await env.DB.prepare(`SELECT call_sid_bucket_hash, composite_bucket_hash,
      global_bucket_hash FROM authentication_attempt_reservations`).first<Record<string, string>>();
    expect(new Set(Object.values(row ?? {})).size).toBe(3);
  });
});

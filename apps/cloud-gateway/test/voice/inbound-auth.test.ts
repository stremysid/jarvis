import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayBinding, Ulid } from "../../../../packages/contracts/src/index.js";
import {
  AuthenticationAttemptBudget,
  PinAuthenticationService,
  decodePinVerifierRecord,
  evaluatePinAttempt,
  verifyPin,
  type PinAuthenticationProof,
} from "../../src/voice/inbound-auth.js";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const FIVE_MINUTES = new Date("2026-08-30T12:05:00.000Z");
const PEPPER = new Uint8Array(32).fill(7);
const SESSION_ID = "01k3wceg000000000000000001" as Ulid;
const CALL_1 = `CA${"1".repeat(32)}`;
const CALL_2 = `CA${"2".repeat(32)}`;
const PIN_RECORD_JSON = JSON.stringify({
  schemaVersion: "1.0",
  algorithm: "pbkdf2-hmac-sha256",
  iterations: 600_000,
  saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
  digestBase64: "SEQMsb6DRNNigkTZFNlCnQLLXSwB1jfsvHCYVO4ib2w=",
});

function binding(overrides: Partial<RelayBinding> = {}): RelayBinding {
  return {
    callSid: CALL_1,
    principalId: "principal:owner",
    identityId: "identity:voice",
    destinationIdentityId: "identity:voice",
    relayNonce: `${"A".repeat(42)}A`,
    direction: "inbound",
    activationOnly: false,
    activationChallengeId: null,
    ...overrides,
  };
}

describe("inbound PIN authentication", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearAuthenticationAttemptReservationsForTest();
  });

  afterEach(clearAuthenticationAttemptReservationsForTest);

  it("decodes the deployed canonical record and verifies only the exact eight-digit PIN", async () => {
    const record = decodePinVerifierRecord(PIN_RECORD_JSON);
    expect(Object.isFrozen(record)).toBe(true);
    expect(await verifyPin("12345678", record)).toBe(true);
    await expect(verifyPin("1234567", record)).resolves.toBe(false);
    await expect(verifyPin("123456789", record)).resolves.toBe(false);
    await expect(verifyPin("１２３４５６７８", record)).resolves.toBe(false);
    await expect(verifyPin(new String("12345678"), record)).resolves.toBe(false);
    await expect(verifyPin("87654321", record)).resolves.toBe(false);
  });

  it("strictly evaluates completed candidates and terminates only the third bad candidate", () => {
    expect(evaluatePinAttempt({ failedAttempts: 0, pinMatches: false })).toEqual({ nextFailedAttempts: 1, terminateCall: false });
    expect(evaluatePinAttempt({ failedAttempts: 2, pinMatches: false })).toEqual({ nextFailedAttempts: 3, terminateCall: true });
    expect(evaluatePinAttempt({ failedAttempts: 2, pinMatches: true })).toEqual({ nextFailedAttempts: 0, terminateCall: false });
    for (const failedAttempts of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => evaluatePinAttempt({ failedAttempts, pinMatches: false })).toThrow("pin_attempt_invalid");
    }
  });

  it("reserves every shared PIN scope before invoking the expensive verifier", async () => {
    const budget = new AuthenticationAttemptBudget(env.DB, PEPPER, { callSidLimit: 1 });
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    const service = new PinAuthenticationService(budget, decodePinVerifierRecord(PIN_RECORD_JSON));

    const proof = await service.authenticate({ pinDigits: "12345678", sessionId: SESSION_ID, binding: binding(), now: NOW });
    expect(deriveBits).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(proof)).toBe(true);
    await expect(service.authenticate({ pinDigits: "12345678", sessionId: SESSION_ID, binding: binding(), now: NOW }))
      .rejects.toThrow("authentication_budget_exhausted");
    expect(deriveBits).toHaveBeenCalledTimes(1);
  });

  it("enforces the CallSid, composite, and global limits across new CallSids", async () => {
    const perCall = new AuthenticationAttemptBudget(env.DB, PEPPER);
    for (let index = 0; index < 3; index += 1) {
      await expect(perCall.reservePinAttempt({ binding: binding(), now: NOW })).resolves.toBe(true);
    }
    await expect(perCall.reservePinAttempt({ binding: binding(), now: NOW })).resolves.toBe(false);

    await clearAuthenticationAttemptReservationsForTest();
    const composite = new AuthenticationAttemptBudget(env.DB, PEPPER);
    for (let index = 0; index < 6; index += 1) {
      const callSid = `CA${String(index + 10).padStart(32, "0")}`;
      await expect(composite.reservePinAttempt({ binding: binding({ callSid }), now: NOW })).resolves.toBe(true);
    }
    await expect(composite.reservePinAttempt({ binding: binding({ callSid: CALL_2 }), now: NOW })).resolves.toBe(false);

    await clearAuthenticationAttemptReservationsForTest();
    const global = new AuthenticationAttemptBudget(env.DB, PEPPER);
    for (let index = 0; index < 30; index += 1) {
      const callSid = `CA${String(index + 100).padStart(32, "0")}`;
      await expect(global.reservePinAttempt({
        binding: binding({
          callSid,
          principalId: `principal:${index}`,
          identityId: `identity:${index}`,
          destinationIdentityId: `identity:${index}`,
        }),
        now: NOW,
      })).resolves.toBe(true);
    }
    await expect(global.reservePinAttempt({ binding: binding({ callSid: CALL_2, principalId: "principal:last" }), now: NOW })).resolves.toBe(false);
  });

  it("expires reservations at the exact five-minute boundary without locking identities", async () => {
    const budget = new AuthenticationAttemptBudget(env.DB, PEPPER, { callSidLimit: 1 });
    await expect(budget.reservePinAttempt({ binding: binding(), now: NOW })).resolves.toBe(true);
    await expect(budget.reservePinAttempt({ binding: binding(), now: new Date(FIVE_MINUTES.valueOf() - 1) })).resolves.toBe(false);
    await expect(budget.reservePinAttempt({ binding: binding(), now: FIVE_MINUTES })).resolves.toBe(true);
    const columns = await env.DB.prepare("PRAGMA table_info(authentication_attempt_reservations)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toContain("identity_status");
  });

  it("atomically limits activation attempts by challenge in addition to shared scopes", async () => {
    const budget = new AuthenticationAttemptBudget(env.DB, PEPPER);
    const activationBinding = binding({ activationOnly: true, activationChallengeId: "challenge:phone" });
    for (let index = 0; index < 3; index += 1) {
      await expect(budget.reserveActivationAttempt({
        binding: { ...activationBinding, callSid: `CA${String(index + 400).padStart(32, "0")}` },
        now: NOW,
      })).resolves.toBe(true);
    }
    await expect(budget.reserveActivationAttempt({
      binding: { ...activationBinding, callSid: `CA${String(403).padStart(32, "0")}` },
      now: NOW,
    })).resolves.toBe(false);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM authentication_attempt_reservations").first<{ count: number }>())?.count).toBe(3);
  });

  it("returns null for a completed bad PIN but mints a nominal bound proof only on success", async () => {
    const record = decodePinVerifierRecord(PIN_RECORD_JSON);
    const budget = new AuthenticationAttemptBudget(env.DB, PEPPER);
    const service = new PinAuthenticationService(budget, record);
    await expect(service.authenticate({ pinDigits: "87654321", sessionId: SESSION_ID, binding: binding(), now: NOW })).resolves.toBeNull();
    const proof = await service.authenticate({ pinDigits: "12345678", sessionId: SESSION_ID, binding: binding(), now: NOW });
    if (proof === null) throw new Error("fixture_proof_missing");
    expect(service.snapshotProof(proof)).toMatchObject({
      proofId: expect.any(String),
      authenticated: true,
      sessionId: SESSION_ID,
      callSid: CALL_1,
      principalId: "principal:owner",
      identityId: "identity:voice",
      direction: "inbound",
      activationChallengeId: null,
    });
    expect(() => service.snapshotProof({ ...proof })).toThrow("pin_authentication_proof_invalid");
    const foreign = new PinAuthenticationService(budget, record);
    expect(() => foreign.snapshotProof(proof)).toThrow("pin_authentication_proof_invalid");
    expect(JSON.stringify(proof)).not.toContain("12345678");
  });

  it("binds an activation proof to the exact challenge without verifier or digit fields", async () => {
    const budget = new AuthenticationAttemptBudget(env.DB, PEPPER);
    const service = new PinAuthenticationService(budget, decodePinVerifierRecord(PIN_RECORD_JSON));
    const proof = await service.authenticate({
      pinDigits: "12345678",
      sessionId: SESSION_ID,
      binding: binding({ activationOnly: true, activationChallengeId: "challenge:phone" }),
      now: NOW,
    });
    if (proof === null) throw new Error("fixture_proof_missing");
    expect(service.snapshotProof(proof)).toBe(proof);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.keys(proof).sort()).toEqual([
      "activationChallengeId",
      "authenticated",
      "callSid",
      "direction",
      "identityId",
      "principalId",
      "proofId",
      "sessionId",
    ]);
    expect(proof.activationChallengeId).toBe("challenge:phone");
    expect(JSON.stringify(proof)).not.toMatch(/12345678|digest|iterations|salt|verifier/iu);
  });

  it("does not expose a structural compile-time proof mint", () => {
    const structural = {
      proofId: "pin-proof:forged",
      authenticated: true as const,
      sessionId: SESSION_ID,
      callSid: CALL_1,
      principalId: "principal:owner",
      identityId: "identity:voice",
      direction: "inbound" as const,
      activationChallengeId: null,
    };
    // @ts-expect-error The module-private nominal member prevents structural proof minting.
    const forged: PinAuthenticationProof = structural;
    expect(forged).toBe(structural);
  });

  it("rejects prototype-spoofed budget authorities without invoking them", () => {
    const reservePinAttempt = vi.fn(async () => true);
    const forged = Object.assign(Object.create(AuthenticationAttemptBudget.prototype), { reservePinAttempt });
    expect(() => new PinAuthenticationService(forged, decodePinVerifierRecord(PIN_RECORD_JSON)))
      .toThrow("pin_authentication_configuration_invalid");
    expect(reservePinAttempt).not.toHaveBeenCalled();
  });

  it("keeps its verifier and budget authorities in runtime-private fields", async () => {
    const record = decodePinVerifierRecord(PIN_RECORD_JSON);
    const budget = new AuthenticationAttemptBudget(env.DB, PEPPER, { callSidLimit: 1 });
    const service = new PinAuthenticationService(budget, record);
    Object.assign(service as object, {
      budgets: { reservePinAttempt: async () => true },
      verifier: decodePinVerifierRecord(JSON.stringify({
        schemaVersion: "1.0",
        algorithm: "pbkdf2-hmac-sha256",
        iterations: 600_000,
        saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
        digestBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      })),
    });
    await expect(service.authenticate({ pinDigits: "12345678", sessionId: SESSION_ID, binding: binding(), now: NOW }))
      .resolves.toMatchObject({ authenticated: true });
    await expect(service.authenticate({ pinDigits: "12345678", sessionId: SESSION_ID, binding: binding(), now: NOW }))
      .rejects.toThrow("authentication_budget_exhausted");
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelayBinding } from "../../../../packages/contracts/src/index.js";
import {
  AuthenticationAttemptBudget,
  evaluatePinAttempt,
} from "../../src/voice/inbound-auth.js";
import {
  applyFoundationMigration,
  clearAuthenticationAttemptReservationsForTest,
} from "../persistence/migration.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const FIVE_MINUTES = new Date("2026-08-30T12:05:00.000Z");
const PEPPER = new Uint8Array(32).fill(7);
const CALL_1 = `CA${"1".repeat(32)}`;
const CALL_2 = `CA${"2".repeat(32)}`;

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
    accessKind: "owner",
    guestGrantId: null,
    guestGrantVersion: null,
    accessDocumentHash: null,
    ...overrides,
  };
}

describe("voice authentication attempt budget", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearAuthenticationAttemptReservationsForTest();
  });

  afterEach(clearAuthenticationAttemptReservationsForTest);

  it("strictly evaluates completed candidates and terminates only the third bad candidate", () => {
    expect(evaluatePinAttempt({ failedAttempts: 0, pinMatches: false })).toEqual({ nextFailedAttempts: 1, terminateCall: false });
    expect(evaluatePinAttempt({ failedAttempts: 2, pinMatches: false })).toEqual({ nextFailedAttempts: 3, terminateCall: true });
    expect(evaluatePinAttempt({ failedAttempts: 2, pinMatches: true })).toEqual({ nextFailedAttempts: 0, terminateCall: false });
    for (const failedAttempts of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => evaluatePinAttempt({ failedAttempts, pinMatches: false })).toThrow("pin_attempt_invalid");
    }
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
});

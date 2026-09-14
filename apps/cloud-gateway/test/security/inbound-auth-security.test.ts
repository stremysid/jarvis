import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const PEPPER = new Uint8Array(32).fill(11);

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

describe("voice authentication attempt budget security boundaries", () => {
  beforeEach(async () => {
    await applyFoundationMigration();
    await clearAuthenticationAttemptReservationsForTest();
  });

  afterEach(clearAuthenticationAttemptReservationsForTest);

  it("rejects accessor-shaped PIN-attempt counters without invoking accessors", () => {
    const getter = vi.fn(() => 0);
    const attempt = { pinMatches: false } as Record<string, unknown>;
    Object.defineProperty(attempt, "failedAttempts", { enumerable: true, get: getter });
    expect(() => evaluatePinAttempt(attempt as never)).toThrow("pin_attempt_invalid");
    expect(getter).not.toHaveBeenCalled();
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

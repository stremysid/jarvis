import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  OWNER_STEP_UP_HANDOFF_DATA,
  OWNER_STEP_UP_REJECTED,
  OWNER_STEP_UP_VERIFIED,
} from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { FAKE_OWNER_PASSPHRASE } from "./voice-access-system.js";
import { createFakeCallingSystem } from "./voice-call-system.js";

async function authorityCount(sessionId: string): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
  ).bind(sessionId).first<{ count: number }>())?.count ?? 0;
}

describe("owner call passphrase step-up", () => {
  it.each(["inbound", "outbound"] as const)("commits the exact success receipt before admitting an %s owner", async (direction) => {
    const system = await createFakeCallingSystem();
    try {
      if (direction === "inbound") expect((await system.inbound()).status).toBe(200);
      else {
        const dispatched = await system.dispatch();
        expect(dispatched.status, JSON.stringify(dispatched)).toBe("dispatched");
        expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
      }
      const call = await system.openRelay();
      await call.setup();
      expect(await call.phase()).toBe("pre_auth");
      expect(await authorityCount(call.sessionId)).toBe(0);
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.phase()).toBe("active");
      expect(await authorityCount(call.sessionId)).toBe(1);
      expect(await env.DB.prepare(
        "SELECT verified_at FROM owner_call_step_up_successes WHERE session_id = ?",
      ).bind(call.sessionId).first()).not.toBeNull();
      expect(call.frames().some((frame) => frame.token === OWNER_STEP_UP_VERIFIED)).toBe(true);
      expect(call.authorityCountsAtVerified()).toEqual([1]);
      expect(await call.modelRequests()).toEqual([]);
    } finally { await system.cleanup(); }
  });

  it("writes every mismatch ordinal durably before rejecting the third candidate and ends with handoff data", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      for (const candidate of [
        "ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity",
      ]) await call.prompt(candidate);
      expect(await call.phase()).toBe("rejected");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(3);
      expect(await authorityCount(call.sessionId)).toBe(0);
      expect(call.frames().some((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toBe(true);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
      expect(call.stepUpAlerts()).toEqual([{
        ownerPrincipalId: "principal:owner",
        alertClass: "rejected",
        direction: "inbound",
        attestationClass: "absent",
      }]);
      expect(JSON.stringify(call.stepUpAlerts())).not.toMatch(/ablaze|abrasion|active|activist|activity/iu);
      const callback = await system.sendRelayEnded(call.callSid, "ended", call.providerSessionId, OWNER_STEP_UP_HANDOFF_DATA);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("<Hangup/>");
    } finally { await system.cleanup(); }
  });

  it("preserves mismatch ordinals across a Durable Object hibernation boundary", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("ablaze abrasion active");
      await call.prompt("ablaze abrasion activist");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(2);

      await call.hibernate();
      await call.prompt("ablaze abrasion activity");

      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(3);
      expect(await call.phase()).toBe("rejected");
      expect(await authorityCount(call.sessionId)).toBe(0);
    } finally { await system.cleanup(); }
  });

  it("does not carry a rejected call's three attempts into a later owner call", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const attacked = await system.openRelay();
      await attacked.setup();
      for (const candidate of [
        "ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity",
      ]) await attacked.prompt(candidate);
      expect(await attacked.phase()).toBe("rejected");

      expect((await system.inbound()).status).toBe(200);
      const later = await system.openRelay();
      await later.setup();
      await later.prompt(FAKE_OWNER_PASSPHRASE);

      expect(await later.phase()).toBe("active");
      expect(await authorityCount(later.sessionId)).toBe(1);
      expect(await system.ownerStepUpAttempts(later.sessionId)).toBe(1);
    } finally { await system.cleanup(); }
  });

  it("reserves one outbound-owner slot when two inbound owner relays are waiting in pre-auth", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const first = await system.openRelay();
      await first.setup();
      expect((await system.inbound()).status).toBe(200);
      const second = await system.openRelay();
      await second.setup();
      expect(await first.phase()).toBe("pre_auth");
      expect(await second.phase()).toBe("pre_auth");

      const dispatched = await system.dispatch();
      expect(dispatched.status, JSON.stringify(dispatched)).toBe("dispatched");
      expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM call_sessions
        WHERE phase NOT IN ('completed', 'rejected', 'failed', 'expired')`).first())
        .toEqual({ count: 3 });
    } finally { await system.cleanup(); }
  });

  it("expires through the persisted 60-second alarm after hibernation", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.hibernate();
      system.advanceTime(60_001);
      await call.fireAlarm();

      expect(await call.phase()).toBe("rejected");
      expect(await authorityCount(call.sessionId)).toBe(0);
      expect(call.frames()).toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
    } finally { await system.cleanup(); }
  });

  it("caps non-candidate assembly re-prompts durably without spending mismatch attempts", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        await call.prompt("ablaze");
        await call.hibernate();
        system.advanceTime(1_501);
        await call.fireAlarm();
      }

      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      expect(await call.phase()).toBe("rejected");
      expect((await env.DB.prepare(
        "SELECT count(*) AS count FROM owner_call_step_up_reprompts WHERE session_id = ?",
      ).bind(call.sessionId).first<{ count: number }>())?.count).toBe(3);
    } finally { await system.cleanup(); }
  });

  it.each([
    "ablaze abrasion",
    "please ablaze abrasion abrasive",
    "ablaze abrasion 123",
    "ablaze abrasion abrasive active",
  ])("treats %j as a non-candidate without spending a mismatch attempt", async (candidate) => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt(candidate);
      if (candidate === "ablaze abrasion") {
        system.advanceTime(1_501);
        await call.fireAlarm();
      }

      expect(await call.phase()).toBe("pre_auth");
      expect(await system.ownerStepUpAttempts(call.sessionId)).toBe(0);
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM owner_call_step_up_reprompts
        WHERE session_id = ?`).bind(call.sessionId).first()).toEqual({ count: 1 });
    } finally { await system.cleanup(); }
  });

  it("commits the durable attempt ordinal before starting the 600,000-round verifier", async () => {
    const system = await createFakeCallingSystem();
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    const reservationsAtKdf: number[] = [];
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (algorithm, baseKey, length) => {
      reservationsAtKdf.push((await env.DB.prepare(
        "SELECT count(*) AS count FROM owner_call_step_up_attempts",
      ).first<{ count: number }>())?.count ?? -1);
      return deriveBits(algorithm, baseKey, length);
    });
    try {
      const call = await (async () => {
        expect((await system.inbound()).status).toBe(200);
        const opened = await system.openRelay();
        await opened.setup();
        return opened;
      })();
      await call.prompt("ablaze abrasion active");
      expect(reservationsAtKdf).toEqual([1]);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "PBKDF2", iterations: 600_000 });
    } finally {
      spy.mockRestore();
      await system.cleanup();
    }
  });

  it("measures both 600,000-round admission and repeat-suppression KDF paths", async () => {
    const system = await createFakeCallingSystem();
    const iterations: number[] = [];
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation((algorithm, baseKey, length) => {
      if (typeof algorithm === "object" && "iterations" in algorithm
        && typeof algorithm.iterations === "number") iterations.push(algorithm.iterations);
      return deriveBits(algorithm, baseKey, length);
    });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      const admissionStart = performance.now();
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      const admissionMs = performance.now() - admissionStart;
      system.advanceTime(2_001);
      const repeatStart = performance.now();
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      const repeatMs = performance.now() - repeatStart;

      expect(iterations).toEqual([600_000, 600_000]);
      expect(admissionMs).toBeGreaterThan(0);
      expect(repeatMs).toBeGreaterThan(0);
      console.info("owner_step_up_kdf_latency_evidence", JSON.stringify({
        admissionMs: Math.round(admissionMs), repeatMs: Math.round(repeatMs), iterations,
      }));
    } finally {
      spy.mockRestore();
      await system.cleanup();
    }
  });
});

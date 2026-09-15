import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
      const callback = await system.sendRelayEnded(call.callSid, "ended", call.providerSessionId, OWNER_STEP_UP_HANDOFF_DATA);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("<Hangup/>");
    } finally { await system.cleanup(); }
  });
});

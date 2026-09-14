import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR33 PROBE ONLY. The contract never sends DTMF during owner step-up.
describe("PR33 probe gap 6: keypad digits bypass the spoken phrase", () => {
  it.each(["inbound", "outbound"] as const)("admits an %s owner from four keypad digits", async (direction) => {
    const system = await createFakeCallingSystem();
    try {
      if (direction === "inbound") {
        expect((await system.inbound()).status).toBe(200);
      } else {
        await expect(system.dispatch()).resolves.toMatchObject({ status: "dispatched" });
        expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
      }
      const call = await system.openRelay();
      await call.setup();
      await call.pin(Uint8Array.from("4827", (character) => character.charCodeAt(0)));
      const authorities = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
      ).bind(call.sessionId).first<{ count: number }>();
      expect({ phase: await call.phase(), ownerAuthorities: authorities?.count, modelRequests: (await call.modelRequests()).length })
        .toEqual({ phase: "active", ownerAuthorities: 1, modelRequests: 0 });
    } finally {
      await system.cleanup();
    }
  });
});

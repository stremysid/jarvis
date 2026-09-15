import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR40 PROBE ONLY (gap 6b). The contract's keypad case is inbound-only.
describe("PR40 probe gap 6b: outbound-only keypad bypass", () => {
  it("admits an outbound owner from keypad 4827 while inbound stays gated", async () => {
    const results: Record<string, unknown> = {};
    for (const direction of ["inbound", "outbound"] as const) {
      const system = await createFakeCallingSystem();
      try {
        if (direction === "inbound") expect((await system.inbound()).status).toBe(200);
        else {
          expect((await system.dispatch()).status).toBe("dispatched");
          expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
        }
        const call = await system.openRelay();
        await call.setup();
        await call.pin(Uint8Array.from([52, 56, 50, 55]));
        results[direction] = {
          phase: await call.phase(),
          ownerAuthorities: (await env.DB.prepare(
            "SELECT count(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
          ).bind(call.sessionId).first<{ count: number }>())?.count,
          modelRequests: (await call.modelRequests()).length,
        };
      } finally { await system.cleanup(); }
    }
    expect(results).toEqual({
      inbound: { phase: "pre_auth", ownerAuthorities: 0, modelRequests: 0 },
      outbound: { phase: "active", ownerAuthorities: 1, modelRequests: 0 },
    });
  }, 60_000);
});

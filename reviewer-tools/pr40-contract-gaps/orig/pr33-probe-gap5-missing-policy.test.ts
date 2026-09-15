import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR33 PROBE ONLY. voice-call-system.ts:212 replaces a missing policy with "passphrase_always",
// so the contract's `undefined` case never reaches the implementation's missing-configuration branch.
describe("PR33 probe gap 5: a genuinely missing policy is never delivered by the contract harness", () => {
  it("waives the owner phrase for exact Passed-A when the policy port is absent", async () => {
    const system = await createFakeCallingSystem({ ownerCallerIdPolicyUnset: true } as never);
    try {
      expect((await system.inbound(undefined, "TN-Validation-Passed-A")).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      const authorities = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
      ).bind(call.sessionId).first<{ count: number }>();
      expect({ phase: await call.phase(), ownerAuthorities: authorities?.count })
        .toEqual({ phase: "active", ownerAuthorities: 1 });
    } finally {
      await system.cleanup();
    }
  });
});

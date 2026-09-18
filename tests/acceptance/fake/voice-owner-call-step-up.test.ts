import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OwnerPassphraseVerifier } from "../../../apps/cloud-gateway/src/security/owner-passphrase-verifier.js";
import { OwnerCallStepUpService } from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { FAKE_OWNER_PASSPHRASE_PEPPER } from "./voice-access-system.js";
import { createFakeCallingSystem } from "./voice-call-system.js";

/**
 * The always-on admission step-up this file used to cover was removed on
 * 2026-09-17. Sid's decision was that an ordinary owner call asks for nothing
 * and the credential attaches to the sensitive action instead, so the
 * twenty-three admission, refusal-alert, alarm and hibernation tests that
 * lived here were deleted rather than rewritten: they described a call path
 * that no longer exists, and the replacement contract is covered by
 * voice-owner-passphrase-security.test.ts here plus the owner sensitive-action
 * suites in apps/cloud-gateway/test. What is left is the durable binding
 * evidence, which the inbound and outbound routes still write even though
 * nothing consults it at admission any more.
 */
describe("owner call step-up binding after the gate moved", () => {
  it.each(["inbound", "outbound"] as const)(
    "records the durable step-up binding for an %s owner call and admits it into conversation",
    async (direction) => {
      const system = await createFakeCallingSystem();
      try {
        if (direction === "inbound") {
          expect((await system.inbound()).status).toBe(200);
        } else {
          const dispatched = await system.dispatch();
          expect(dispatched.status, JSON.stringify(dispatched)).toBe("dispatched");
          expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
        }
        const call = await system.openRelay();
        await call.setup();

        expect(await call.phase()).toBe("active");
        await expect(env.DB.prepare(`SELECT direction, requirement, attestation_class, policy
          FROM owner_call_step_up_bindings WHERE session_id = ?`).bind(call.sessionId).first()).resolves.toEqual({
          direction,
          requirement: "required",
          attestation_class: direction === "inbound" ? "absent" : "not_applicable",
          policy: "passphrase_always",
        });
        // The binding row is written; nothing spends it at admission, so the
        // window, attempt, success and refusal stores all stay empty.
        for (const table of [
          "owner_call_step_up_windows", "owner_call_step_up_attempts",
          "owner_call_step_up_successes", "owner_call_step_up_rejections",
        ]) {
          await expect(env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE session_id = ?`)
            .bind(call.sessionId).first()).resolves.toEqual({ count: 0 });
        }
        expect(call.frames().map((frame) => frame.token).join("\n")).not.toMatch(/passphrase|four digit/iu);
      } finally {
        await system.cleanup();
      }
    },
    20_000,
  );

  it("refuses an outbound owner call while two owner conversations are already live", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const first = await system.openRelay();
      await first.setup();
      expect((await system.inbound()).status).toBe(200);
      const second = await system.openRelay();
      await second.setup();
      expect(await first.phase()).toBe("active");
      expect(await second.phase()).toBe("active");

      // Dialling claims the attempt, and the call that would follow it is
      // refused by the owner's two-live-session capacity. Nothing waits in
      // pre-auth for a credential any more, so the carve-out that used to let
      // a third call through while two owners waited has no waiting state
      // left to fire on. The owner is genuinely in two conversations here.
      expect((await system.dispatch()).status).toBe("dispatched");
      expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(403);
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM call_sessions
        WHERE phase NOT IN ('completed', 'rejected', 'failed', 'expired')`).first())
        .toEqual({ count: 2 });
      expect(system.initializations()).toEqual([]);
    } finally {
      await system.cleanup();
    }
  }, 20_000);
  it("accepts the binding it already recorded and refuses a different one for the same call", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();

      const service = new OwnerCallStepUpService(
        env.DB, new OwnerPassphraseVerifier(FAKE_OWNER_PASSPHRASE_PEPPER(), "v1"),
      );
      const recorded = await service.binding(call.sessionId);
      if (recorded === null) throw new Error("fixture_binding_missing");
      await expect(service.bind(recorded)).resolves.toEqual(recorded);
      await expect(service.bind(Object.freeze({ ...recorded, policy: "waive_on_passed_a" as const })))
        .rejects.toThrow("owner_step_up_binding_conflict");
      await expect(env.DB.prepare("SELECT policy FROM owner_call_step_up_bindings WHERE session_id = ?")
        .bind(call.sessionId).first()).resolves.toEqual({ policy: "passphrase_always" });
    } finally {
      await system.cleanup();
    }
  }, 20_000);
});
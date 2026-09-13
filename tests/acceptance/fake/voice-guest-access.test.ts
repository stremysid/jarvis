import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { GuestPinVerifier } from "../../../apps/cloud-gateway/src/security/guest-pin-verifier.js";
import { createFakeCallingSystem } from "./voice-call-system.js";
import { FAKE_GUEST_PEPPER, FAKE_PIN_A, FAKE_PIN_B, seedFakeGuest } from "./voice-access-system.js";

describe("fake voice guest access", () => {
  it("activates a pending guest with their bound PIN and never puts its digits in model input or durable conversation", async () => {
    const system = await createFakeCallingSystem();
    try {
      const guest = await seedFakeGuest("a");
      const response = await system.inbound(guest.caller);
      expect(response.status).toBe(200);
      const twiml = await response.text();
      const call = await system.openRelay();
      await call.setup();
      await expect(call.phase()).resolves.toBe("pre_auth");
      await call.prompt("This speech is not authentication.");
      await expect(call.modelRequests()).resolves.toHaveLength(0);
      await expect(call.turns()).resolves.toHaveLength(0);
      await call.pin(FAKE_PIN_A());
      await expect(call.phase()).resolves.toBe("active");
      await expect(system.pinAttempts()).resolves.toBe(1);
      await expect(env.DB.prepare("SELECT status, activated_at FROM voice_access_grants WHERE grant_id = ?")
        .bind(guest.grantId).first()).resolves.toEqual({ status: "active", activated_at: "2026-08-30T12:00:00.000Z" });
      await expect(env.DB.prepare("SELECT status, verified_at FROM channel_identities WHERE identity_id = ?")
        .bind(guest.identityId).first()).resolves.toEqual({ status: "active", verified_at: "2026-08-30T12:00:00.000Z" });
      await expect(env.DB.prepare("SELECT authority_kind, grant_id, grant_version FROM call_session_authorities WHERE session_id = ?")
        .bind(call.sessionId).first()).resolves.toEqual({ authority_kind: "guest", grant_id: guest.grantId, grant_version: 1 });
      await call.prompt("Please remember my preference for chamomile tea.");
      expect((await call.modelRequests()).map((request) => request.principalId)).toEqual([guest.principalId]);
      await expect(call.turns()).resolves.toEqual([
        { state: "voice_sent", sent_assistant_event_id: expect.any(String), delivered_assistant_event_id: null },
      ]);
      const artifacts = [twiml, JSON.stringify(call.frames()), JSON.stringify(await call.modelRequests()),
        JSON.stringify((await env.DB.prepare("SELECT envelope_json FROM events").all()).results),
        JSON.stringify((await env.DB.prepare("SELECT * FROM conversation_turns").all()).results)];
      const syntheticDigits = String.fromCharCode(...FAKE_PIN_A());
      for (const artifact of artifacts) expect(artifact).not.toContain(syntheticDigits);
    } finally { await system.cleanup(); }
  });

  it("refuses another guest's PIN without activating that guest or reusing the first call's authority", async () => {
    const system = await createFakeCallingSystem();
    try {
      const firstGuest = await seedFakeGuest("a");
      const secondGuest = await seedFakeGuest("b");
      expect((await system.inbound(firstGuest.caller)).status).toBe(200);
      const first = await system.openRelay();
      await first.setup();
      await first.pin(FAKE_PIN_A());
      await expect(first.phase()).resolves.toBe("active");
      expect((await system.inbound(secondGuest.caller)).status).toBe(200);
      const second = await system.openRelay();
      await second.setup();
      await second.pin(FAKE_PIN_A());
      await expect(second.phase()).resolves.toBe("pre_auth");
      await expect(env.DB.prepare("SELECT status FROM voice_access_grants WHERE grant_id = ?")
        .bind(secondGuest.grantId).first()).resolves.toEqual({ status: "pending" });
      await expect(env.DB.prepare("SELECT count(*) AS count FROM call_session_authorities WHERE session_id = ?")
        .bind(second.sessionId).first()).resolves.toEqual({ count: 0 });
      await second.prompt("Please use the other caller's memory.");
      await expect(second.modelRequests()).resolves.toHaveLength(0);
      await expect(second.turns()).resolves.toHaveLength(0);
      await second.pin(FAKE_PIN_B());
      await expect(second.phase()).resolves.toBe("active");
      await second.prompt("A brief answer please.");
      expect((await second.modelRequests()).map((request) => request.principalId)).toEqual([secondGuest.principalId]);
    } finally { await system.cleanup(); }
  });

  it("keeps the owner's and two guests' conversation context separate", async () => {
    const system = await createFakeCallingSystem();
    try {
      const firstGuest = await seedFakeGuest("a");
      const secondGuest = await seedFakeGuest("b");
      await system.inbound();
      const owner = await system.openRelay();
      await owner.setup();
      await owner.prompt("My private jasmine memory belongs only to the owner.");
      await owner.close();
      await system.inbound(firstGuest.caller);
      const first = await system.openRelay();
      await first.setup();
      await first.pin(FAKE_PIN_A());
      await first.prompt("My private chamomile memory belongs only to the first guest.");
      expect(JSON.stringify(await first.modelRequests())).not.toContain("private jasmine memory");
      await first.close();
      await system.inbound(secondGuest.caller);
      const second = await system.openRelay();
      await second.setup();
      await second.pin(FAKE_PIN_B());
      await second.prompt("Recall jasmine and chamomile memory.");
      const request = (await second.modelRequests())[0];
      expect(request?.principalId).toBe(secondGuest.principalId);
      expect(request?.context).toEqual([{ text: "Recall jasmine and chamomile memory." }]);
      await second.prompt("Recall my previous request about memory.");
      const next = (await second.modelRequests())[1];
      expect(next?.context.map((item) => item.text)).toContain("Recall jasmine and chamomile memory.");
      expect(JSON.stringify(next?.context)).not.toContain("private jasmine memory");
      expect(JSON.stringify(next?.context)).not.toContain("private chamomile memory");
    } finally { await system.cleanup(); }
  });

  it("refuses conversation when a valid guest PIN grants no conversation capability", async () => {
    const system = await createFakeCallingSystem();
    try {
      const guest = await seedFakeGuest("a", []);
      expect((await system.inbound(guest.caller)).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.pin(FAKE_PIN_A());
      await expect(call.phase()).resolves.toBe("active");
      await call.prompt("Please answer despite the missing permission.");
      await vi.waitFor(() => expect(call.closeCodes()).toContain(1011));
      await expect(call.modelRequests()).resolves.toHaveLength(0);
      await expect(call.turns()).resolves.toHaveLength(0);
    } finally { await system.cleanup(); }
  });

  it.each(["revocation", "PIN rotation"] as const)("refuses the next turn after %s without depending on a disabled identity", async (change) => {
    const system = await createFakeCallingSystem();
    try {
      const guest = await seedFakeGuest("a");
      await system.inbound(guest.caller);
      const call = await system.openRelay();
      await call.setup();
      await call.pin(FAKE_PIN_A());
      await call.prompt("This authorized turn should succeed.");
      await expect(call.modelRequests()).resolves.toHaveLength(1);
      const changedAt = "2026-08-30T12:00:00.001Z";
      if (change === "revocation") {
        await env.DB.prepare(`UPDATE voice_access_grants SET grant_version = 2, status = 'revoked', updated_at = ?, revoked_at = ?
          WHERE grant_id = ? AND grant_version = 1`).bind(changedAt, changedAt, guest.grantId).run();
      } else {
        const rotated = await new GuestPinVerifier(FAKE_GUEST_PEPPER()).create(guest.grantId, FAKE_PIN_B());
        await env.DB.prepare(`UPDATE voice_access_grants SET grant_version = 2, pin_salt_base64 = ?, pin_digest_base64 = ?, updated_at = ?
          WHERE grant_id = ? AND grant_version = 1`).bind(rotated.saltBase64, rotated.digestBase64, changedAt, guest.grantId).run();
      }
      await expect(env.DB.prepare("SELECT status FROM channel_identities WHERE identity_id = ?")
        .bind(guest.identityId).first()).resolves.toEqual({ status: "active" });
      await call.prompt("This stale-authority turn must be refused.");
      await vi.waitFor(() => expect(call.closeCodes()).toContain(1011));
      await expect(call.modelRequests()).resolves.toHaveLength(1);
      await expect(call.turns()).resolves.toHaveLength(1);
    } finally { await system.cleanup(); }
  });

  it("refuses an unknown caller and an active identity whose guest grant was revoked before PIN or model work", async () => {
    const system = await createFakeCallingSystem();
    try {
      const guest = await seedFakeGuest("a");
      // A known identity alone is not a grant. The second caller has no identity.
      await env.DB.prepare("UPDATE channel_identities SET status = 'active', verified_at = ? WHERE identity_id = ?")
        .bind("2026-08-30T12:00:00.000Z", guest.identityId).run();
      await env.DB.prepare(`UPDATE voice_access_grants SET grant_version = 2, status = 'revoked', updated_at = ?, revoked_at = ?
        WHERE grant_id = ?`).bind("2026-08-30T12:00:00.001Z", "2026-08-30T12:00:00.001Z", guest.grantId).run();
      for (const caller of [guest.caller, "+14165550112"]) {
        const response = await system.inbound(caller);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("ConversationRelay");
      }
      await expect(env.DB.prepare("SELECT count(*) AS count FROM call_sessions").first()).resolves.toEqual({ count: 0 });
      await expect(system.pinAttempts()).resolves.toBe(0);
      await expect(system.conversationTurnCount()).resolves.toBe(0);
    } finally { await system.cleanup(); }
  });
});

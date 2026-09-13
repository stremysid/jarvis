import { describe, expect, it, vi } from "vitest";
import { createFakeCallingSystem, createFakeOutboundCallingSystem } from "./voice-call-system.js";

describe("fake voice call path", () => {
  it("admits the owner without a PIN and preserves two turns across an interruption", async () => {
    const system = await createFakeCallingSystem({ manualModel: true });
    try {
      const inbound = await system.inbound();
      expect(inbound.status).toBe(200);
      const twiml = await inbound.text();
      expect(twiml).toContain("<ConversationRelay");
      expect(twiml).not.toContain("principal:owner");
      expect(twiml).not.toContain(system.destination);

      const call = await system.openRelay();
      expect(call.upgradeStatus).toBe(101);
      await call.setup();
      await expect(call.phase()).resolves.toBe("active");
      await expect(system.pinAttempts()).resolves.toBe(0);
      expect(call.frames()).toEqual([]);

      const interrupted = call.prompt("Remember the jasmine tea preference.");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(1));
      // The real streaming redactor releases complete lines, not an open tail.
      await call.emitToken("This response must stop when the caller interrupts.\n");
      await vi.waitFor(() => expect(call.frames().some((frame) => frame.last === false)).toBe(true));
      const started = performance.now();
      await call.interrupt();
      await interrupted;
      expect(performance.now() - started).toBeLessThanOrEqual(1_500);
      await expect(call.turns()).resolves.toEqual([
        { state: "cancelled", sent_assistant_event_id: null, delivered_assistant_event_id: null },
      ]);
      const countAfterInterrupt = call.frames().length;
      await expect(call.emitToken("Late output must not resume.")).rejects.toThrow("fake_model_manual_stream_inactive");
      expect(call.frames()).toHaveLength(countAfterInterrupt);

      const next = call.prompt("Recall the jasmine tea preference.");
      await vi.waitFor(async () => expect(await call.modelRequests()).toHaveLength(2));
      await call.emitToken("The preference is jasmine tea.");
      await call.completeModel();
      await next;
      expect((await call.modelRequests()).map((request) => request.principalId)).toEqual([
        "principal:owner", "principal:owner",
      ]);
      await expect(call.turns()).resolves.toEqual([
        { state: "cancelled", sent_assistant_event_id: null, delivered_assistant_event_id: null },
        { state: "voice_sent", sent_assistant_event_id: expect.any(String), delivered_assistant_event_id: null },
      ]);
      expect(call.frames().at(-1)).toEqual({ type: "text", token: "", last: true });
      await call.close();
      await expect(call.phase()).resolves.toBe("completed");
      await expect(system.pinAttempts()).resolves.toBe(0);
    } finally {
      await system.cleanup();
    }
  });

  it("reconciles an accepted-but-lost dispatch and claims signed outbound TwiML without Task 6 activation", async () => {
    const system = await createFakeOutboundCallingSystem({ loseDispatchResponse: true });
    try {
      const dispatch = await system.dispatch();
      expect(dispatch).toEqual({ status: "provider_dispatch_unknown", attemptId: system.attemptId });
      expect(system.twilioRequests()).toHaveLength(1);

      const callSid = system.acceptedCallSid();
      const status = await system.sendStatus(callSid, "ringing", 0);
      expect(status.status).toBe(204);
      await expect(system.dispatchIntent()).resolves.toMatchObject({
        kind: "existing",
        state: "dispatched",
        callSid,
      });

      const twiml = await system.claimOutboundTwiML(callSid);
      expect(twiml.status).toBe(200);
      expect(twiml.headers.get("cache-control")).toBe("no-store");
      const body = await twiml.text();
      expect(body).toContain(`url="wss://jarvis.example/voice/relay/${system.attemptId}"`);
      expect(body).toContain("action=\"https://jarvis.example/voice/relay-ended\"");
      expect(body).not.toContain("user_requested");
      expect(body).not.toContain("principal:owner");
      expect(body).not.toContain(system.destination);
      expect(system.initializations()).toHaveLength(1);
      expect(system.initializations()[0]).toMatchObject({
        sessionId: system.attemptId,
        relaySetupExpiresAt: null,
        preAuthentication: { voicemailMessage: "Jarvis called for Sid. No private message was left." },
      });
    } finally {
      await system.cleanup();
    }
  });
});

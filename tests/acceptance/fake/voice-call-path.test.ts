import { describe, expect, it } from "vitest";
import { createFakeOutboundCallingSystem } from "./voice-call-system.js";

describe("fake voice call path", () => {
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

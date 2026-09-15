import { describe, expect, it } from "vitest";
import {
  OWNER_STEP_UP_REJECTED,
  OWNER_STEP_UP_RETRY_PROMPT,
} from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR40 PROBE ONLY (gap 2b). D1 still caps attempts at three, but the core's exhaustion decision
// is in memory. After a hibernation wake the third mismatch terminalizes the D1 row while the
// live call is never told, never ended and never alerted, even after the 60 s window alarm.
describe("PR40 probe gap 2b: post-wake exhaustion is silent", () => {
  it("leaves an exhausted inbound owner call connected, unannounced and unalerted", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("ablaze abrasion active");
      await call.prompt("ablaze abrasion activist");
      await call.hibernate();
      await call.prompt("ablaze abrasion activity");
      const afterThird = {
        attempts: await system.ownerStepUpAttempts(call.sessionId),
        phase: await call.phase(),
        lastSpoken: call.frames().at(-1),
        rejectedSpoken: call.frames().some((frame) => frame.token === OWNER_STEP_UP_REJECTED),
        endFrame: call.frames().some((frame) => (frame as { type: string }).type === "end"),
        alerts: call.stepUpAlerts().length,
        closeCodes: call.closeCodes(),
      };
      system.advanceTime(60_001);
      await call.fireAlarm();
      expect({
        afterThird,
        afterAlarm: {
          endFrame: call.frames().some((frame) => (frame as { type: string }).type === "end"),
          alerts: call.stepUpAlerts().length,
          closeCodes: call.closeCodes(),
        },
      }).toEqual({
        afterThird: {
          attempts: 3,
          phase: "rejected",
          lastSpoken: expect.objectContaining({ token: OWNER_STEP_UP_RETRY_PROMPT }),
          rejectedSpoken: false,
          endFrame: false,
          alerts: 0,
          closeCodes: [],
        },
        afterAlarm: { endFrame: false, alerts: 0, closeCodes: [] },
      });
    } finally { await system.cleanup(); }
  }, 60_000);
});

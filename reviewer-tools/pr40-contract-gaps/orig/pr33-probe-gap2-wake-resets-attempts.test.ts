import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR33 PROBE ONLY. A hibernating Durable Object is reconstructed on the next frame:
// CallSession.#cores is empty, so a fresh CallSessionCore starts with zeroed in-memory counters.
describe("PR33 probe gap 2: the three-attempt limit is not durable", () => {
  it.each(["inbound", "outbound"] as const)(
    "an %s owner call accepts eight complete wrong candidates when the object wakes between pairs",
    async (direction) => {
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
        const phases: Array<string | undefined> = [];
        const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
        for (let index = 0; index < words.length; index += 1) {
          await call.prompt(`synthetic wrong ${words[index]}`);
          phases.push(await call.phase());
          if (index % 2 === 1) await call.simulateHibernationWake();
        }
        expect({
          phases,
          closeCodes: call.closeCodes(),
          durableReservations: await system.pinAttempts(),
        }).toEqual({
          phases: Array(8).fill("pre_auth"),
          closeCodes: [],
          durableReservations: 0,
        });
      } finally {
        await system.cleanup();
      }
    },
  );
});

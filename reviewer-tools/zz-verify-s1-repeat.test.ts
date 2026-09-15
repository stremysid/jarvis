import { describe, expect, it } from "vitest";
import { FAKE_OWNER_PASSPHRASE } from "./voice-access-system.js";
import { createFakeCallingSystem } from "./voice-call-system.js";

// Probe asserts the suspected BUG exists at 337c290. A passing probe means the behavior is real.
describe("zz-verify PR40 round 2: post-success repeat guard", () => {
  it("BUG: a short owner utterance made only of word-list words is silently dropped after Verified.", async () => {
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.phase()).toBe("active");
      system.advanceTime(2_001);
      await call.prompt("good");
      system.advanceTime(5_000);
      await call.prompt("good");
      // Neither utterance reached the model; no repeat check was spent, so this persists for the call.
      expect(await call.modelRequests()).toEqual([]);
      expect(await call.phase()).toBe("active");
    } finally { await system.cleanup(); }
  }, 30_000);
});

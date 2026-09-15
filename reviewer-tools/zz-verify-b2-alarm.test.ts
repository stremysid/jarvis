import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

const KEY = "call-session.owner-step-up-alarm.v1";

// Probes assert the suspected BUG exists at 337c290. A passing probe means the hole is real.
describe("zz-verify PR40 round 2: alarm key handling", () => {
  it.each([false, true])("BUG: an assembly alarm re-arms the window, then alarm() deletes the key (hibernate=%s)", async (hibernate) => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      expect(await call.durableStorage()).toHaveProperty(KEY);
      await call.prompt("ablaze");
      if (hibernate) await call.hibernate();
      system.advanceTime(1_501);
      await call.fireAlarm();
      // One re-prompt was spent and the call is still in pre_auth.
      expect(await call.phase()).toBe("pre_auth");
      expect((await env.DB.prepare(
        "SELECT count(*) AS count FROM owner_call_step_up_reprompts WHERE session_id = ?",
      ).bind(call.sessionId).first<{ count: number }>())?.count).toBe(1);
      // Handler re-armed the window alarm, but alarm() deleted the key afterwards.
      const storage = await call.durableStorage();
      expect(storage).not.toHaveProperty(KEY);

      // Caller stays silent past the 60 s deadline. The scheduled alarm fires, finds no key, clears itself.
      system.advanceTime(60_000);
      await call.fireAlarm();
      expect(await call.phase()).toBe("pre_auth");
      expect(await env.DB.prepare(
        "SELECT reason FROM owner_call_step_up_rejections WHERE session_id = ?",
      ).bind(call.sessionId).first()).toBeNull();
    } finally { await system.cleanup(); }
  }, 30_000);

  it("BUG: #resolveCore 'unavailable' after eviction skips handling and still deletes the key", async () => {
    const system = await createFakeCallingSystem({ now: new Date("2099-01-01T00:00:00.000Z") });
    let renamed = false;
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.hibernate();
      expect(await call.durableStorage()).toHaveProperty(KEY);
      system.advanceTime(60_001);
      await env.DB.prepare("ALTER TABLE call_sessions RENAME TO call_sessions_unavailable").run();
      renamed = true;
      await call.fireAlarm(); // returns normally: no runtime retry
      await env.DB.prepare("ALTER TABLE call_sessions_unavailable RENAME TO call_sessions").run();
      renamed = false;
      expect(await call.durableStorage()).not.toHaveProperty(KEY);
      await call.fireAlarm();
      expect(await call.phase()).toBe("pre_auth");
    } finally {
      if (renamed) await env.DB.prepare("ALTER TABLE call_sessions_unavailable RENAME TO call_sessions").run();
      await system.cleanup();
    }
  }, 30_000);
});

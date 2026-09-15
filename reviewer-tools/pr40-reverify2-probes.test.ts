// PR #40 round-3 adversarial probes at 07e1464. Each test asserts that a suspected
// hole EXISTS, so a PASS means the behaviour is real.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  OWNER_STEP_UP_HANDOFF_DATA,
  OWNER_STEP_UP_REJECTED,
  OwnerCallStepUpService,
} from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { FAKE_OWNER_PASSPHRASE } from "./voice-access-system.js";
import { createFakeCallingSystem } from "./voice-call-system.js";

const NOW = new Date("2099-01-01T00:00:00.000Z");
const KEY = "call-session.owner-step-up-alarm.v1";
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

async function reprompts(sessionId: string): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS count FROM owner_call_step_up_reprompts WHERE session_id = ?",
  ).bind(sessionId).first<{ count: number }>())?.count ?? -1;
}

describe("PR40 reverify2 probes", () => {
  it.each([false, true])(
    "P1: a deadline rejection interrupted after the durable expire is never completed on retry (hibernate=%s)",
    async (hibernate) => {
      const system = await createFakeCallingSystem({ now: NOW });
      const original = OwnerCallStepUpService.prototype.expire;
      let failOnce = true;
      const spy = vi.spyOn(OwnerCallStepUpService.prototype, "expire").mockImplementation(
        async function (this: OwnerCallStepUpService, sessionId, now) {
          await original.call(this, sessionId, now);
          // Stands in for the next D1 read (getCallSession) failing transiently.
          if (failOnce) { failOnce = false; throw new Error("probe_transient_after_expire"); }
        },
      );
      try {
        expect((await system.inbound()).status).toBe(200);
        const call = await system.openRelay();
        await call.setup();
        system.advanceTime(60_001);

        await expect(call.fireAlarm()).rejects.toThrow("probe_transient_after_expire");
        expect(await call.phase()).toBe("rejected");
        expect(await call.durableStorage()).toHaveProperty(KEY);
        if (hibernate) await call.hibernate();

        await call.fireAlarm(); // the runtime retry
        await settle();
        // BUG: the retry sees rejectionReason (or a terminal session) and only clears.
        expect(await call.durableStorage()).not.toHaveProperty(KEY);
        expect(call.frames().filter((frame) => frame.token === OWNER_STEP_UP_REJECTED)).toHaveLength(0);
        expect(call.frames()).not.toContainEqual({ type: "end", handoffData: OWNER_STEP_UP_HANDOFF_DATA });
        expect(call.stepUpAlerts()).toHaveLength(0);
        expect(call.closeCodes()).toEqual([]); // relay still open, caller not hung up
      } finally {
        spy.mockRestore();
        await system.cleanup();
      }
    },
    30_000,
  );

  it("P5: a split phrase repeat after the 3.5 s fragment window reaches the model", async () => {
    const system = await createFakeCallingSystem({ now: NOW });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt(FAKE_OWNER_PASSPHRASE);
      expect(await call.phase()).toBe("active");
      system.advanceTime(4_000);
      const [first, second] = FAKE_OWNER_PASSPHRASE.split(" ");
      await call.prompt(`${first} ${second}`);
      expect((await call.modelRequests()).map((request) => request.userText)).toContain(`${first} ${second}`);
    } finally { await system.cleanup(); }
  }, 30_000);

  it("P7: after a pre_auth hang-up the deadline alarm keeps its key and throws instead of clearing", async () => {
    const system = await createFakeCallingSystem({ now: NOW });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.close();
      expect(await call.phase()).toBe("failed");
      expect(await call.durableStorage()).toHaveProperty(KEY);
      system.advanceTime(60_001);
      const outcome = await call.fireAlarm().then(() => "resolved", (error: unknown) => String(error));
      expect(outcome).toContain("owner_step_up_alarm_runtime_unavailable");
      expect(await call.durableStorage()).toHaveProperty(KEY);
    } finally { await system.cleanup(); }
  }, 30_000);

  it("P6: one late fragment followed by the pending assembly alarm spends two re-prompts", async () => {
    const system = await createFakeCallingSystem({ now: NOW });
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      await call.prompt("ablaze");
      system.advanceTime(1_600);
      await call.prompt("abrasion"); // late-fragment branch: re-prompt 1, key still "assembly"
      expect(await reprompts(call.sessionId)).toBe(1);
      expect(await call.durableStorage()).toMatchObject({ [KEY]: expect.objectContaining({ kind: "assembly" }) });
      await call.fireAlarm(); // the already-scheduled assembly alarm
      expect(await reprompts(call.sessionId)).toBe(2);
      expect(await call.phase()).toBe("pre_auth");
    } finally { await system.cleanup(); }
  }, 30_000);
});

// PR #40 round-4 adversarial probes at 623c64a. Q1 asserts that a suspected
// hole EXISTS (PASS = real). Q4/Q5 are observations: they end in a REPORT
// assertion that intentionally fails and prints the measured values.
import { describe, expect, it, vi } from "vitest";
import {
  OWNER_STEP_UP_HANDOFF_DATA,
  OWNER_STEP_UP_REJECTED,
  OwnerCallStepUpService,
} from "../../../apps/cloud-gateway/src/voice/owner-call-step-up.js";
import { createFakeCallingSystem } from "./voice-call-system.js";

const NOW = new Date("2099-01-01T00:00:00.000Z");
const KEY = "call-session.owner-step-up-alarm.v1";
const settle = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const within = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, v: `threw:${String(e)}` })),
    settle(ms).then(() => ({ ok: false as const, v: `${label}:timeout` }))]);

describe("PR40 reverify3 probes", () => {
  it("Q1: a frame-path deadline rejection racing the deadline alarm refuses and alerts twice", async () => {
    const system = await createFakeCallingSystem({ now: NOW });
    const original = OwnerCallStepUpService.prototype.binding;
    let calls = 0;
    let armed = false;
    let announce!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(OwnerCallStepUpService.prototype, "binding").mockImplementation(
      async function (this: OwnerCallStepUpService, sessionId) {
        if (armed) {
          calls += 1;
          if (calls === 1) { announce(); await gate; }
        }
        return original.call(this, sessionId);
      },
    );
    const stages: string[] = [];
    let report = "";
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      armed = true;
      const frame = call.prompt("hello there");
      void frame.catch(() => undefined);
      stages.push(`reached=${(await within(started, 5_000, "binding")).v ?? "yes"}`);
      const alarm = call.fireAlarm();
      void alarm.catch(() => undefined);
      stages.push(`alarmWhileBlocked=${JSON.stringify(await within(alarm, 5_000, "alarm"))}`);
      release();
      stages.push(`frame=${JSON.stringify(await within(frame, 5_000, "frame"))}`);
      stages.push(`alarmAfter=${JSON.stringify(await within(alarm, 5_000, "alarm2"))}`);
      const refusals = call.frames().filter((f) => f.token === OWNER_STEP_UP_REJECTED).length;
      const ends = call.frames().filter((f) => f.type === "end" && f.handoffData === OWNER_STEP_UP_HANDOFF_DATA).length;
      report = `${stages.join(" | ")} | refusals=${refusals} ends=${ends} alerts=${call.stepUpAlerts().length} bindingCalls=${calls} closeCodes=${JSON.stringify(call.closeCodes())} phase=${await call.phase()}`;
      expect(call.stepUpAlerts().length, report).toBe(2);
      expect(refusals, report).toBe(2);
    } finally {
      release();
      spy.mockRestore();
      await within(system.cleanup(), 5_000, "cleanup");
    }
  }, 60_000);

  it("Q4: hang-up after eviction on an interrupted rejection: observe alert and retries", async () => {
    const system = await createFakeCallingSystem({ now: NOW });
    const expire = OwnerCallStepUpService.prototype.expire;
    const fault = vi.spyOn(OwnerCallStepUpService.prototype, "expire").mockImplementationOnce(
      async function (this: OwnerCallStepUpService, sessionId, now) {
        await expire.call(this, sessionId, now);
        throw new Error("probe_after_expire_commit");
      },
    );
    let report = "";
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      await expect(call.fireAlarm()).rejects.toThrow("probe_after_expire_commit");
      await call.hibernate();
      await call.close();
      await settle();
      const keyAfterClose = KEY in await call.durableStorage();
      const r1 = await within(call.fireAlarm({ retryCount: 1, isRetry: true, scheduledTime: NOW.valueOf() + 60_000 }), 8_000, "r1");
      const r5 = await within(call.fireAlarm({ retryCount: 5, isRetry: true, scheduledTime: NOW.valueOf() + 60_000 }), 8_000, "r5");
      report = `keyAfterClose=${keyAfterClose} r1=${JSON.stringify(r1)} r5=${JSON.stringify(r5)} alerts=${call.stepUpAlerts().length} refusals=${call.frames().filter((f) => f.token === OWNER_STEP_UP_REJECTED).length} keyEnd=${KEY in await call.durableStorage()}`;
    } finally { fault.mockRestore(); await within(system.cleanup(), 5_000, "cleanup"); }
    expect("REPORT " + report).toBe("");
  }, 60_000);

  it("Q5: a frame after eviction on an interrupted rejection: observe close, refusal and alert", async () => {
    const system = await createFakeCallingSystem({ now: NOW });
    const expire = OwnerCallStepUpService.prototype.expire;
    const fault = vi.spyOn(OwnerCallStepUpService.prototype, "expire").mockImplementationOnce(
      async function (this: OwnerCallStepUpService, sessionId, now) {
        await expire.call(this, sessionId, now);
        throw new Error("probe_after_expire_commit");
      },
    );
    let report = "";
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      system.advanceTime(60_001);
      await expect(call.fireAlarm()).rejects.toThrow("probe_after_expire_commit");
      await call.hibernate();
      await call.prompt("hello there");
      await settle();
      const codes = JSON.stringify(call.closeCodes());
      const r1 = await within(call.fireAlarm({ retryCount: 1, isRetry: true, scheduledTime: NOW.valueOf() + 60_000 }), 8_000, "r1");
      await settle();
      report = `closeCodesAfterFrame=${codes} r1=${JSON.stringify(r1)} refusals=${call.frames().filter((f) => f.token === OWNER_STEP_UP_REJECTED).length} alerts=${call.stepUpAlerts().length} keyEnd=${KEY in await call.durableStorage()}`;
    } finally { fault.mockRestore(); await within(system.cleanup(), 5_000, "cleanup"); }
    expect("REPORT " + report).toBe("");
  }, 60_000);
});

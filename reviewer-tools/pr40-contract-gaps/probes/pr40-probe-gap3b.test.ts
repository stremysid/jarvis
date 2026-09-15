import { describe, expect, it, vi } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR40 PROBE ONLY (gap 3b). Wrong candidates leak on the mismatch and rejection path,
// which the contract never sweeps.
const WRONG = ["ablaze abrasion active", "ablaze abrasion activist", "ablaze abrasion activity"];

function text(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return [...item.entries()];
    if (ArrayBuffer.isView(item)) return new TextDecoder().decode(item as Uint8Array);
    return item;
  });
}

describe("PR40 probe gap 3b: mismatch-path leaks", () => {
  it("wrong candidates reach logs, spoken frames and Durable Object KV and SQLite", async () => {
    const logs: unknown[][] = [];
    const spies = (["debug", "info", "log", "warn", "error"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); }));
    const system = await createFakeCallingSystem();
    try {
      expect((await system.inbound()).status).toBe(200);
      const call = await system.openRelay();
      await call.setup();
      for (const wrong of WRONG) await call.prompt(wrong);
      expect({
        phase: await call.phase(),
        logsCarryEveryCandidate: WRONG.every((wrong) => text(logs).includes(wrong)),
        framesEchoFirstTwo: WRONG.slice(0, 2).every((wrong) => text(call.frames()).includes(wrong)),
        durableKv: text(await call.durableStorage()).includes(WRONG[2]),
        durableSql: text(await call.durableSqlStorage()).includes(WRONG[2]),
      }).toEqual({
        phase: "rejected",
        logsCarryEveryCandidate: true,
        framesEchoFirstTwo: true,
        durableKv: true,
        durableSql: true,
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
      await system.cleanup();
    }
  }, 60_000);
});

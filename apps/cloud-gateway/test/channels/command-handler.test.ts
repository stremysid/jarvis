import { describe, expect, it, vi } from "vitest";
import { runCommand, type CommandContext } from "../../src/channels/telegram/command-handler.js";

/**
 * Two properties, and both are about honesty rather than function.
 *
 * A subsystem that is not configured must not read as a subsystem with
 * nothing to report. "Not set up yet" and "all quiet" are different facts and
 * the owner acts differently on each.
 *
 * A command that changes state reports the state it REACHED, never the state
 * it was asked for. The next thing the owner does is act on that answer.
 *
 * Only the mechanical commands remain here: `/status`, `/queue` and `/digest`
 * are model tools now (see `owner-command-tools.test.ts`).
 */

const NOW = new Date("2026-09-02T11:30:00.000Z");

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return { principalId: "principal-a", now: () => NOW, ...overrides };
}

async function text(...args: Parameters<typeof runCommand>): Promise<string> {
  return (await runCommand(...args)).map((reply) => reply.text).join("\n");
}

describe("a subsystem that is not configured", () => {
  it.each([
    ["exam", "Quiet hours"],
    ["shadow", "Autonomy"],
    ["call", "Calling"],
  ] as const)("says %s is not configured rather than reporting nothing", async (name, label) => {
    expect(await text(name, "on", context())).toBe(`${label} is not configured on this deployment.`);
  });
});

describe("calling", () => {
  it("invokes the port bound to the accepted event without accepting a destination from the command", async () => {
    const request = vi.fn(async () => "Call request accepted for your verified phone.");
    expect(await text("call", "check in --confirm", context({ calls: { request } })))
      .toBe("Call request accepted for your verified phone.");
    expect(request).toHaveBeenCalledExactlyOnceWith();
  });

  it("contains a raising call port without echoing a private provider error", async () => {
    const reply = await text("call", "check in --confirm", context({ calls: {
      request: async () => { throw new Error("private fixture provider body"); },
    } }));
    expect(reply).toBe("Could not confirm whether the call was placed. Check your phone before trying again.");
    expect(reply).not.toContain("private fixture");
  });
});

describe("shadow mode", () => {
  const mode = (current: "shadow" | "live") => ({
    readMode: async () => ({ mode: current, enteredAt: "2026-09-01T00:00:00.000Z" }),
    setMode: vi.fn(async (next: "shadow" | "live") => ({ mode: next, enteredAt: NOW.toISOString() })),
  });

  it("turns shadow mode on", async () => {
    const autonomy = mode("live");
    const said = await text("shadow", "on", context({ autonomy }));
    expect(autonomy.setMode).toHaveBeenCalledWith("shadow", NOW.toISOString());
    expect(said).toContain("Shadow mode on");
  });

  it("turns it off, and says tier 3 still asks", async () => {
    const autonomy = mode("shadow");
    const said = await text("shadow", "off", context({ autonomy }));
    expect(autonomy.setMode).toHaveBeenCalledWith("live", NOW.toISOString());
    expect(said).toContain("tier 3 still asks first");
  });

  it.each(["of", "maybe", "", "true"])("refuses %s and reports the current state", async (argument) => {
    // The one that matters. "/shadow of" must not disable the gate that keeps
    // tier-2 actions from running.
    const autonomy = mode("shadow");
    const said = await text("shadow", argument, context({ autonomy }));

    expect(autonomy.setMode).not.toHaveBeenCalled();
    expect(said).toContain("Shadow mode is on");
  });

  it("reports the state it reached, not the one it was asked for", async () => {
    // A write that silently did something else must not be reported as
    // success. The owner's next action depends on this sentence.
    const said = await text(
      "shadow",
      "off",
      context({
        autonomy: {
          readMode: async () => ({ mode: "shadow" as const, enteredAt: "" }),
          setMode: async () => ({ mode: "shadow" as const, enteredAt: "" }),
        },
      }),
    );
    expect(said).toContain("Shadow mode on");
    expect(said).not.toContain("Shadow mode off");
  });
});

describe("exam mode", () => {
  it("opens a manual window and says what still gets through", async () => {
    const open = vi.fn(async () => undefined);
    const said = await text(
      "exam",
      "on",
      context({ quietWindows: { open, closeManual: async () => 0 } }),
    );

    expect(open).toHaveBeenCalledWith("manual", NOW, new Date("2026-09-03T11:30:00.000Z"));
    expect(said).toContain("payment-critical still come through");
  });

  it("says plainly when there was nothing open to close", async () => {
    const said = await text(
      "exam",
      "off",
      context({ quietWindows: { open: async () => undefined, closeManual: async () => 0 } }),
    );
    expect(said).toBe("No manual quiet window was open.");
  });

  it("reports how many it closed", async () => {
    const said = await text(
      "exam",
      "off",
      context({ quietWindows: { open: async () => undefined, closeManual: async () => 2 } }),
    );
    expect(said).toContain("Closed 2");
  });
});

describe("a handler that throws", () => {
  it("answers with the failure instead of going silent", async () => {
    // The owner typed something and is waiting. Silence reads exactly like a
    // bot that has stopped working.
    const said = await text(
      "exam",
      "on",
      context({
        quietWindows: {
          open: async () => { throw new Error("D1 unavailable"); },
          closeManual: async () => 0,
        },
      }),
    );
    expect(said).toBe("That failed: D1 unavailable");
  });
});

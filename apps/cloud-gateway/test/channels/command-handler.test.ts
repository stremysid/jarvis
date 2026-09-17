import { describe, expect, it, vi } from "vitest";
import { runCommand, type CommandContext } from "../../src/channels/telegram/command-handler.js";
import type { DecisionItem } from "../../src/decisions/decision-types.js";

/**
 * Two properties, and both are about honesty rather than function.
 *
 * A subsystem that is not configured must not read as a subsystem with
 * nothing to report. "Not set up yet" and "all quiet" are different facts and
 * the owner acts differently on each.
 *
 * A command that changes state reports the state it REACHED, never the state
 * it was asked for. The next thing the owner does is act on that answer.
 */

const NOW = new Date("2026-09-02T11:30:00.000Z");

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return { principalId: "principal-a", now: () => NOW, ...overrides };
}

function decision(overrides: Partial<DecisionItem> = {}): DecisionItem {
  return {
    decisionId: "01k5d8s0m00000000000000001",
    principalId: "principal-a",
    origin: "projects",
    originReference: null,
    urgency: "normal",
    question: "Approve the vendor quote?",
    detail: null,
    status: "open",
    rank: 100,
    expiresAt: null,
    createdAt: NOW.toISOString(),
    deliveredAt: null,
    resolvedAt: null,
    options: [
      { optionKey: "yes", label: "Yes", ordinal: 0, kind: "choice" },
      { optionKey: "no", label: "No", ordinal: 1, kind: "choice" },
      { optionKey: "other", label: "Other", ordinal: 2, kind: "free_text" },
      { optionKey: "explain", label: "Explain more", ordinal: 3, kind: "explain" },
    ],
    ...overrides,
  } as DecisionItem;
}

async function text(...args: Parameters<typeof runCommand>): Promise<string> {
  return (await runCommand(...args)).map((reply) => reply.text).join("\n");
}

describe("help", () => {
  it("lists every command", async () => {
    const help = await text("help", "", context());
    for (const name of ["/status", "/queue", "/digest", "/exam", "/shadow", "/vault", "/call", "/disable-owner-step-up"]) {
      expect(help).toContain(name);
    }
  });
});

describe("a subsystem that is not configured", () => {
  it.each([
    ["queue", "The decision queue"],
    ["digest", "The digest"],
    ["exam", "Quiet hours"],
    ["shadow", "Autonomy"],
    ["call", "Calling"],
  ] as const)("says %s is not configured rather than reporting nothing", async (name, label) => {
    // The failure this prevents: an owner reading "Nothing waiting on you"
    // from a deployment where the decision queue was never wired up.
    expect(await text(name, "on", context())).toBe(`${label} is not configured on this deployment.`);
  });

  it("distinguishes an empty queue from an absent one", async () => {
    const empty = await text("queue", "", context({ decisions: { queue: async () => [] } }));
    expect(empty).toBe("Nothing waiting on you.");
    expect(empty).not.toContain("not configured");
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

describe("owner call step-up disable", () => {
  it("requires the exact confirmation and does not invoke the bound receipt port otherwise", async () => {
    const disable = vi.fn(async () => "disabled" as const);
    for (const argument of ["", "confirm", "--confirm later", "--confirm\ndo not disable"]) {
      expect(await text("disable-owner-step-up", argument, context({ ownerStepUp: { disable } })))
        .toBe("Use /disable-owner-step-up --confirm exactly to disable spoken owner-call step-up.");
    }
    expect(disable).not.toHaveBeenCalled();
  });

  it("reports that only a device-signed CLI generate can re-enable a committed disable", async () => {
    const disable = vi.fn(async () => "disabled" as const);
    const reply = await text("disable-owner-step-up", "--confirm", context({ ownerStepUp: { disable } }));
    expect(disable).toHaveBeenCalledExactlyOnceWith();
    expect(reply).toBe("Owner call step-up disabled. A new device-signed CLI generate is required to re-enable it.");
  });

  it("directs a non-private disable request to the owner's private chat", async () => {
    const disable = vi.fn(async () => "private_chat_required" as const);
    expect(await text("disable-owner-step-up", "--confirm", context({ ownerStepUp: { disable } })))
      .toBe("Use /disable-owner-step-up --confirm in your private chat with Jarvis.");
  });

  it("contains disable failures without exposing their private detail", async () => {
    const reply = await text("disable-owner-step-up", "--confirm", context({ ownerStepUp: {
      disable: async () => { throw new Error("private D1 body"); },
    } }));
    expect(reply).toBe("Owner call step-up could not be disabled. Its current state is unchanged or could not be confirmed.");
    expect(reply).not.toContain("private");
  });
});

describe("status", () => {
  it("reports never-run separately from failed", async () => {
    // A fresh deployment and a broken one both have nothing recent to show.
    // Collapsing them means the first alarming morning looks like day one.
    const reported = await text(
      "status",
      "",
      context({
        autonomy: {
          readMode: async () => ({ mode: "shadow" as const, enteredAt: "2026-09-01T00:00:00.000Z" }),
          setMode: async () => ({ mode: "shadow" as const, enteredAt: "" }),
        },
        scheduler: {
          recent: async (job) =>
            job === "poll"
              ? [{
                runKey: "2026-09-02T11",
                startedAt: "2026-09-02T11:00:00.000Z",
                finishedAt: "2026-09-02T11:00:04.000Z",
                failure: "GitHub returned 503",
              }]
              : job === "drain"
                ? [{
                  runKey: "2026-09-02T11:25",
                  startedAt: "2026-09-02T11:25:00.000Z",
                  finishedAt: "2026-09-02T11:25:01.000Z",
                  failure: null,
                }]
                : [],
        },
      }),
    );

    expect(reported).toContain("Autonomy: shadow since 2026-09-01");
    expect(reported).toContain("drain: ok at 11:25");
    expect(reported).toContain("poll: FAILED at 11:00 -- GitHub returned 503");
    expect(reported).toContain("digest: never run");
  });

  it("reports a run that started and never finished", async () => {
    const reported = await text(
      "status",
      "",
      context({
        scheduler: {
          recent: async (job) =>
            job === "digest"
              ? [{
                runKey: "2026-09-02",
                startedAt: "2026-09-02T11:30:00.000Z",
                finishedAt: null,
                failure: null,
              }]
              : [],
        },
      }),
    );
    expect(reported).toContain("digest: started 11:30, never finished");
  });

  it("shows stale meaning-index coverage in status", async () => {
    const reported = await text("status", "", context({
      memoryMeaningCoverage: {
        read: async () => ({ eligible: 12, indexed: 9, missing: 3 }),
      },
    }));

    expect(reported).toContain("Memory meaning: 9/12 indexed (3 missing)");
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

describe("the queue", () => {
  it("sends one message per decision, each with its own buttons", async () => {
    // A single message cannot carry several keyboards, and a tap has to name
    // which question it answered.
    const replies = await runCommand(
      "queue",
      "",
      context({
        decisions: {
          queue: async () => [
            decision(),
            decision({ decisionId: "01k5d8s0m00000000000000002", urgency: "urgent", question: "Vendor wants to reschedule" }),
          ],
        },
      }),
    );

    expect(replies).toHaveLength(2);
    expect(replies[0]?.keyboard).toBeDefined();
    expect(replies[0]?.decisionId).toBe("01k5d8s0m00000000000000001");
    expect(replies[1]?.text).toBe("! Vendor wants to reschedule");
  });
});

describe("the vault", () => {
  it("says where it actually lives rather than failing", async () => {
    // It is on the owner's machine, not in this Worker. Telling them the
    // command to run is more use than a generic refusal.
    expect(await text("vault", "pricing", context())).toContain("jarvis vault search");
  });
});

describe("a handler that throws", () => {
  it("answers with the failure instead of going silent", async () => {
    // The owner typed something and is waiting. Silence reads exactly like a
    // bot that has stopped working.
    const said = await text(
      "queue",
      "",
      context({
        decisions: {
          queue: async () => {
            throw new Error("D1 unavailable");
          },
        },
      }),
    );
    expect(said).toBe("That failed: D1 unavailable");
  });
});

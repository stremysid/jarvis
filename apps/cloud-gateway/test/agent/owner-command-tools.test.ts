import { describe, expect, it, vi } from "vitest";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import {
  DECISION_QUEUE_TOOL_NAME,
  OWNER_STATUS_TOOL_NAME,
  OWNER_COMMAND_TOOL_DEFINITIONS,
  RUN_DIGEST_TOOL_NAME,
  VAULT_SEARCH_EVIDENCE,
  VAULT_SEARCH_TOOL_NAME,
  ownerCommandTool,
} from "../../src/agent/owner-command-tools.js";
import { formatOwnerStatus, type OwnerCommandCapabilities } from "../../src/agent/owner-command-capabilities.js";
import { capabilityForTool, isToolClassified } from "../../src/autonomy/tool-capabilities.js";
import type { DecisionItem } from "../../src/decisions/decision-types.js";
import type { ModelFunctionCall } from "../../src/providers/provider-types.js";

const NOW = new Date("2026-09-02T11:30:00.000Z");

function call(name: string, args: Readonly<Record<string, unknown>> = {}): ModelFunctionCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(args) };
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
    ],
    ...overrides,
  } as DecisionItem;
}

function capabilities(overrides: Partial<OwnerCommandCapabilities> = {}): OwnerCommandCapabilities {
  return {
    status: async () => "Autonomy: live since 2026-09-01",
    queue: async () => [],
    digest: async () => "Today's digest.",
    ...overrides,
  };
}

async function run(
  name: string,
  caps: OwnerCommandCapabilities | undefined,
  args: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly status: string; readonly receiptId: string | null; readonly receipt: string | null; readonly content: string }> {
  const tool = ownerCommandTool(caps, call(name, args));
  if (tool === null) throw new Error("tool not resolved");
  const executed = await tool();
  return {
    status: JSON.parse(executed.providerResult.content).status,
    receiptId: executed.receiptId,
    receipt: executed.receipt,
    content: JSON.parse(executed.providerResult.content).receipt as string,
  };
}

describe("the three reporting command tools", () => {
  it("puts all three in the shared catalogue, so Telegram and a call offer the same set", () => {
    const names = OWNER_TOOL_DEFINITIONS.map((definition) => definition.name);
    for (const name of [OWNER_STATUS_TOOL_NAME, DECISION_QUEUE_TOOL_NAME, RUN_DIGEST_TOOL_NAME]) {
      expect(names).toContain(name);
      expect(OWNER_COMMAND_TOOL_DEFINITIONS.map((definition) => definition.name)).toContain(name);
    }
  });

  it("classifies each as notify.owner rather than leaving it unregistered", () => {
    for (const name of [OWNER_STATUS_TOOL_NAME, DECISION_QUEUE_TOOL_NAME, RUN_DIGEST_TOOL_NAME]) {
      expect(isToolClassified(name)).toBe(true);
      expect(capabilityForTool(name)).toBe("notify.owner");
    }
  });

  it("resolves only the three names, and leaves every other tool to the core", () => {
    expect(ownerCommandTool(capabilities(), call("memory_search"))).toBeNull();
    for (const name of [OWNER_STATUS_TOOL_NAME, DECISION_QUEUE_TOOL_NAME, RUN_DIGEST_TOOL_NAME]) {
      expect(ownerCommandTool(capabilities(), call(name))).not.toBeNull();
    }
  });

  it("mints no receipt for a read, so no claim can rest on it", async () => {
    const result = await run(OWNER_STATUS_TOOL_NAME, capabilities());
    expect(result.status).toBe("completed");
    expect(result.receiptId).toBeNull();
    expect(result.receipt).toBeNull();
    expect(result.content).toContain("Autonomy: live");
  });

  it("returns the status text the capability produced", async () => {
    const status = vi.fn(async () => "Autonomy: shadow since 2026-09-01");
    expect((await run(OWNER_STATUS_TOOL_NAME, capabilities({ status }))).content)
      .toBe("Autonomy: shadow since 2026-09-01");
    expect(status).toHaveBeenCalledOnce();
  });

  it("reads the queue and reports an empty one plainly", async () => {
    const empty = await run(DECISION_QUEUE_TOOL_NAME, capabilities());
    expect(empty.content).toBe("Nothing is waiting on the owner.");

    const withItems = await run(DECISION_QUEUE_TOOL_NAME, capabilities({
      queue: async () => [
        decision(),
        decision({ decisionId: "01k5d8s0m00000000000000002", urgency: "urgent", question: "Vendor wants to reschedule" }),
      ],
    }));
    expect(withItems.content).toContain("! Vendor wants to reschedule");
    expect(withItems.content).toContain("- Approve the vendor quote? [Yes, No]");
  });

  it("returns the digest text without sending it", async () => {
    const digest = vi.fn(async () => "Today: Chemistry quiz at 9am.");
    expect((await run(RUN_DIGEST_TOOL_NAME, capabilities({ digest }))).content)
      .toBe("Today: Chemistry quiz at 9am.");
  });

  it("refuses visibly when the channel has no capabilities wired", async () => {
    const result = await run(OWNER_STATUS_TOOL_NAME, undefined);
    expect(result.status).toBe("refused");
    expect(result.content).toContain("not configured");
  });

  it("refuses arguments it does not accept rather than ignoring them", async () => {
    const result = await run(OWNER_STATUS_TOOL_NAME, capabilities(), { verbose: true });
    expect(result.status).toBe("refused");
    expect(result.content).toContain("Nothing changed");
  });

  it("turns a failing read into a receipt rather than an unhandled rejection", async () => {
    const result = await run(RUN_DIGEST_TOOL_NAME, capabilities({
      digest: async () => { throw new Error("D1 unavailable"); },
    }));
    expect(result.status).toBe("refused");
    expect(result.content).toContain("D1 unavailable");
  });
});

describe("the vault answer", () => {
  it("is in the shared catalogue and classified, so Telegram and a call both offer it", () => {
    expect(OWNER_TOOL_DEFINITIONS.map((definition) => definition.name)).toContain(VAULT_SEARCH_TOOL_NAME);
    expect(OWNER_COMMAND_TOOL_DEFINITIONS.map((definition) => definition.name)).toContain(VAULT_SEARCH_TOOL_NAME);
    expect(isToolClassified(VAULT_SEARCH_TOOL_NAME)).toBe(true);
    expect(capabilityForTool(VAULT_SEARCH_TOOL_NAME)).toBe("memory.read");
  });

  it("returns the one true fact about the vault, with no receipt to claim", async () => {
    const result = await run(VAULT_SEARCH_TOOL_NAME, capabilities(), { query: "macbeth quotes" });
    expect(result.status).toBe("completed");
    expect(result.receiptId).toBeNull();
    expect(result.content).toBe(VAULT_SEARCH_EVIDENCE);
    expect(result.content).toContain("jarvis vault search");
  });

  it("answers even when the deployment has no reporting capabilities wired", async () => {
    // The sentence is a constant, so it does not depend on env bindings.
    const result = await run(VAULT_SEARCH_TOOL_NAME, undefined, { query: "macbeth" });
    expect(result.status).toBe("completed");
    expect(result.content).toBe(VAULT_SEARCH_EVIDENCE);
  });

  it("refuses a missing, empty, oversized or unknown query instead of inventing one", async () => {
    for (const args of [{}, { query: "" }, { query: "x".repeat(257) }, { query: "ok", extra: true }]) {
      const result = await run(VAULT_SEARCH_TOOL_NAME, capabilities(), args);
      expect(result.status).toBe("refused");
      expect(result.content).toContain("Nothing changed");
    }
  });
});

describe("formatOwnerStatus", () => {
  const ALL_JOBS = ["drain", "poll", "digest", "retro", "backup"] as const;

  it("reports never-run separately from failed", () => {
    const reported = formatOwnerStatus({
      mode: { mode: "shadow", enteredAt: "2026-09-01T00:00:00.000Z" },
      jobs: ALL_JOBS.map((job) => ({
        job,
        last: job === "poll"
          ? {
            runKey: "2026-09-02T11",
            startedAt: "2026-09-02T11:00:00.000Z",
            finishedAt: "2026-09-02T11:00:04.000Z",
            failure: "GitHub returned 503",
            detail: null,
            completion: "ok" as const,
          }
          : job === "drain"
            ? {
              runKey: "2026-09-02T11:25",
              startedAt: "2026-09-02T11:25:00.000Z",
              finishedAt: "2026-09-02T11:25:01.000Z",
              failure: null,
              detail: null,
              completion: "ok" as const,
            }
            : null,
      })),
      coverage: { eligible: 12, indexed: 9, missing: 3 },
    });

    expect(reported).toContain("Autonomy: shadow since 2026-09-01");
    expect(reported).toContain("drain: ok at 11:25");
    expect(reported).toContain("poll: FAILED at 11:00 -- GitHub returned 503");
    expect(reported).toContain("digest: never run");
    expect(reported).toContain("Memory meaning: 9/12 indexed (3 missing)");
  });

  it("shows the detail a run reported even though the run succeeded", () => {
    const reported = formatOwnerStatus({
      mode: { mode: "live", enteredAt: "2026-09-01T00:00:00.000Z" },
      jobs: [{
        job: "poll",
        last: {
          runKey: "2026-09-02T11",
          startedAt: "2026-09-02T11:00:00.000Z",
          finishedAt: "2026-09-02T11:00:04.000Z",
          failure: null,
          detail: "12 archived; Classroom not configured; 6 polled",
          completion: "degraded",
        },
      }],
      coverage: { eligible: 0, indexed: 0, missing: 0 },
    });
    expect(reported).toContain("poll: ok with caveat at 11:00 -- 12 archived; Classroom not configured; 6 polled");
  });

  it("reports the nightly backup, which a hardcoded three-job list never showed", () => {
    const reported = formatOwnerStatus({
      mode: { mode: "live", enteredAt: "2026-09-01T00:00:00.000Z" },
      jobs: [{
        job: "backup",
        last: {
          runKey: "2026-09-06",
          startedAt: "2026-09-06T23:30:00.000Z",
          finishedAt: "2026-09-06T23:31:00.000Z",
          failure: "memory_backup_binding_missing",
          detail: null,
          completion: "ok",
        },
      }],
      coverage: { eligible: 0, indexed: 0, missing: 0 },
    });
    expect(reported).toContain("backup: FAILED at 23:30 -- memory_backup_binding_missing");
  });

  it("reports a job that reached the end without running as not set up rather than ok", () => {
    const reported = formatOwnerStatus({
      mode: { mode: "live", enteredAt: "2026-09-01T00:00:00.000Z" },
      jobs: [{
        job: "backup",
        last: {
          runKey: "2026-09-06",
          startedAt: "2026-09-06T23:30:00.000Z",
          finishedAt: "2026-09-06T23:31:00.000Z",
          failure: null,
          detail: "Memory consolidation not configured",
          completion: "not_measured",
        },
      }],
      coverage: { eligible: 0, indexed: 0, missing: 0 },
    });
    expect(reported).toContain("backup: NOT SET UP at 23:31 -- Memory consolidation not configured");
    expect(reported).not.toContain("backup: ok");
  });

  it("reports a run that started and never finished", () => {
    const reported = formatOwnerStatus({
      mode: { mode: "live", enteredAt: "2026-09-01T00:00:00.000Z" },
      jobs: [{
        job: "digest",
        last: {
          runKey: "2026-09-02",
          startedAt: "2026-09-02T11:30:00.000Z",
          finishedAt: null,
          failure: null,
          detail: null,
          completion: "ok",
        },
      }],
      coverage: { eligible: 0, indexed: 0, missing: 0 },
    });
    expect(reported).toContain("digest: started 11:30, never finished");
  });
});

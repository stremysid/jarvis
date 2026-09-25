import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutonomyRepository } from "../../src/autonomy/autonomy-repository.js";
import { AutonomyService } from "../../src/autonomy/autonomy-service.js";
import { D1ToolConfirmationStore } from "../../src/autonomy/tool-confirmations.js";
import { ToolAutonomyGate, type ToolChannelAuthorizationRequest } from "../../src/autonomy/tool-gate.js";
import { applyAutonomyToolCapabilitiesMigration } from "../persistence/migration.js";

const PRINCIPAL = "principal:owner";
const TIER3_TOOL = "send_email";
const TIER1_TOOL = "memory_search";
const ARGUMENTS = JSON.stringify({ to: "someone@example.test", body: "hello" });

function gateWithChannel(authorize: (request: ToolChannelAuthorizationRequest) => Promise<string | null>) {
  return new ToolAutonomyGate(
    new AutonomyService({ repository: new AutonomyRepository(env.DB) }),
    new D1ToolConfirmationStore(env.DB),
    { authorizeToolCall: authorize },
  );
}

describe("the tier-3 gate's channel authorization", () => {
  beforeEach(async () => {
    await applyAutonomyToolCapabilitiesMigration();
    await env.DB.prepare("DELETE FROM tool_confirmation_consumptions").run();
    await env.DB.prepare("DELETE FROM decision_responses").run();
  });

  it("authorizes a tier-3 call through the channel when no standing tap can be spent", async () => {
    const authorize = vi.fn(async () => "pin-authorization-1");
    const decision = await gateWithChannel(authorize).evaluateToolCall({
      toolName: TIER3_TOOL, principalId: PRINCIPAL, arguments: ARGUMENTS,
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({ verdict: "permit", confirmedBy: "pin-authorization-1" });
    expect(decision.receipt).toContain("confirmed by your PIN on this call");
    // The authorization is carried onto the second evaluation exactly as a tap
    // is, so the audit row names what answered the policy question.
    expect(decision.evaluation).toMatchObject({
      outcome: "requires_confirmation", decisionId: "pin-authorization-1",
    });
  });

  it("never asks the channel for a call the tier policy already permits", async () => {
    const authorize = vi.fn(async () => "pin-authorization-1");
    const decision = await gateWithChannel(authorize).evaluateToolCall({
      toolName: TIER1_TOOL, principalId: PRINCIPAL, arguments: JSON.stringify({ query: "anything" }),
    });
    expect(decision.verdict).toBe("permit");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("falls back to the tap route when the channel declines to authorize", async () => {
    const decision = await gateWithChannel(async () => null).evaluateToolCall({
      toolName: TIER3_TOOL, principalId: PRINCIPAL, arguments: ARGUMENTS,
    });
    expect(decision).toMatchObject({ verdict: "confirm", confirmedBy: null });
    expect(decision.receipt).toContain("needs your tap");
  });

  it("refuses rather than running when the channel throws", async () => {
    const gate = gateWithChannel(async () => { throw new Error("pin prompt unavailable"); });
    await expect(gate.evaluateToolCall({
      toolName: TIER3_TOOL, principalId: PRINCIPAL, arguments: ARGUMENTS,
    })).rejects.toThrow("pin prompt unavailable");
  });

  it("still refuses a tier-3 call when no channel authorization is wired at all", async () => {
    const gate = new ToolAutonomyGate(
      new AutonomyService({ repository: new AutonomyRepository(env.DB) }),
      new D1ToolConfirmationStore(env.DB),
    );
    const decision = await gate.evaluateToolCall({
      toolName: TIER3_TOOL, principalId: PRINCIPAL, arguments: ARGUMENTS,
    });
    expect(decision).toMatchObject({ verdict: "confirm", confirmedBy: null });
  });
});

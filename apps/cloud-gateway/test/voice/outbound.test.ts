import { describe, expect, it, vi } from "vitest";
import type { OutboundCallCommand, Ulid } from "../../../../packages/contracts/src/index.js";
import type { OutboundCallDispatchResult } from "../../src/calls/outbound-call-dispatcher.js";
import {
  dispatchOutboundCall,
  type OutboundDispatchDependencies,
} from "../../src/voice/outbound.js";

const COMMAND_ID = "01k3wceg000000000000000010" as Ulid;
const ATTEMPT_ID = "01k3wceg000000000000000011" as Ulid;

function command(): OutboundCallCommand {
  return {
    commandId: COMMAND_ID,
    principalId: "principal:owner",
    purposeCode: "user_requested",
    destinationIdentityId: "identity:voice",
    urgency: "normal",
    authorizationExpiresAt: "2026-08-30T12:10:00.000Z",
    idempotencyKey: "call:test",
    issuedBy: "local_cli",
  };
}

function dispatched(): OutboundCallDispatchResult {
  return { status: "dispatched", callSid: `CA${"1".repeat(32)}`, attemptId: ATTEMPT_ID };
}

describe("outbound initial-authorization adapter", () => {
  it("denies an untrusted issuer before the durable dispatcher can allocate or invoke a provider", async () => {
    const evaluateOutboundCall = vi.fn(async () => ({ decision: "deny" as const, reason: "invalid_origin" as const }));
    const dispatch = vi.fn(async () => dispatched());

    await expect(dispatchOutboundCall({ ...command(), issuedBy: "model" }, {
      policy: { evaluateOutboundCall },
      dispatcher: { dispatch },
    })).rejects.toThrow("invalid_origin");

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("captures the exact command and dependency methods before the first await", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const evaluateOutboundCall = vi.fn(async () => {
      await gate;
      return { decision: "allow" as const, reason: "allowed" as const };
    });
    const firstDispatch = vi.fn(async (input: OutboundCallCommand) => {
      expect(input).toEqual(command());
      expect(Object.isFrozen(input)).toBe(true);
      return dispatched();
    });
    const secondDispatch = vi.fn(async () => { throw new Error("mutated_dispatcher"); });
    const mutableCommand = command();
    const mutableDependencies: OutboundDispatchDependencies = {
      policy: { evaluateOutboundCall },
      dispatcher: { dispatch: firstDispatch },
    };

    const pending = dispatchOutboundCall(mutableCommand, mutableDependencies);
    mutableCommand.destinationIdentityId = "identity:mutated";
    mutableDependencies.dispatcher = { dispatch: secondDispatch };
    release?.();

    await expect(pending).resolves.toEqual(dispatched());
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(secondDispatch).not.toHaveBeenCalled();
  });

  it("returns the Task 3 dispatcher's final-time denial without performing a second policy recheck", async () => {
    const finalDenial: OutboundCallDispatchResult = {
      status: "denied",
      reason: "kill_switch_enabled",
      checkedAt: "2026-08-30T12:00:01.000Z",
      checkId: "01k3wceg000000000000000012" as Ulid,
      attemptId: ATTEMPT_ID,
    };
    const evaluateOutboundCall = vi.fn(async () => ({ decision: "allow" as const, reason: "allowed" as const }));
    const dispatch = vi.fn(async () => finalDenial);

    await expect(dispatchOutboundCall(command(), {
      policy: { evaluateOutboundCall },
      dispatcher: { dispatch },
    })).resolves.toEqual(finalDenial);

    expect(evaluateOutboundCall).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects accessor-shaped commands synchronously without invoking the accessor or either authority", async () => {
    const issuedBy = vi.fn(() => "local_cli");
    const malformed = { ...command() } as Record<string, unknown>;
    Object.defineProperty(malformed, "issuedBy", { enumerable: true, get: issuedBy });
    const evaluateOutboundCall = vi.fn(async () => ({ decision: "allow" as const, reason: "allowed" as const }));
    const dispatch = vi.fn(async () => dispatched());

    await expect(dispatchOutboundCall(malformed, {
      policy: { evaluateOutboundCall },
      dispatcher: { dispatch },
    })).rejects.toThrow("invalid_request");

    expect(issuedBy).not.toHaveBeenCalled();
    expect(evaluateOutboundCall).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

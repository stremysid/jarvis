import { describe, expect, it } from "vitest";
import type { CallPhase, TranscriptState } from "../../../../packages/contracts/src/index.js";
import { canPersistTurn, transitionCall } from "../../src/voice/call-state.js";

const callPhases = [
  "created",
  "connecting",
  "pre_auth",
  "authenticated",
  "active",
  "ending",
  "completed",
  "rejected",
  "failed",
  "expired",
] as const satisfies readonly CallPhase[];

const allowedEdges = new Set<string>([
  "created:connecting",
  "created:rejected",
  "created:failed",
  "created:expired",
  "connecting:pre_auth",
  "connecting:rejected",
  "connecting:failed",
  "connecting:expired",
  "pre_auth:authenticated",
  "pre_auth:rejected",
  "pre_auth:failed",
  "pre_auth:expired",
  "authenticated:active",
  "authenticated:ending",
  "authenticated:failed",
  "authenticated:expired",
  "active:ending",
  "active:failed",
  "active:expired",
  "ending:completed",
  "ending:failed",
]);

const transitionCases = callPhases.flatMap((current) =>
  callPhases.map((next) => [current, next, allowedEdges.has(`${current}:${next}`)] as const),
);

describe("call state", () => {
  it.each(transitionCases)("applies the transition matrix for %s -> %s", (current, next, isAllowed) => {
    if (isAllowed) {
      expect(transitionCall(current, next)).toBe(next);
      return;
    }

    expect(() => transitionCall(current, next)).toThrowError(/^invalid_call_transition$/);
  });

  it.each([
    ["unknown current", "unknown" as CallPhase, "created" as CallPhase],
    ["unknown next", "created" as CallPhase, "unknown" as CallPhase],
  ])("rejects a runtime-invalid phase in %s", (_label, current, next) => {
    expect(() => transitionCall(current, next)).toThrowError(/^invalid_call_transition$/);
  });

  it.each([
    ["committed", "user", false, true],
    ["committed", "user", true, true],
    ["committed", "assistant", false, false],
    ["committed", "assistant", true, true],
    ["partial", "user", false, false],
    ["partial", "user", true, false],
    ["partial", "assistant", false, false],
    ["partial", "assistant", true, false],
    ["cancelled", "user", false, false],
    ["cancelled", "user", true, false],
    ["cancelled", "assistant", false, false],
    ["cancelled", "assistant", true, false],
  ] satisfies readonly (readonly [TranscriptState, "user" | "assistant", boolean, boolean])[])(
    "for %s %s text with delivered=%s returns %s",
    (state, direction, delivered, expected) => {
      expect(canPersistTurn(state, direction, delivered)).toBe(expected);
    },
  );
});

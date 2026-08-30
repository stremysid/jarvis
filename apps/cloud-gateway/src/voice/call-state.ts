import type { CallPhase, TranscriptState } from "../../../../packages/contracts/src/index.js";

function phases(...values: CallPhase[]): readonly CallPhase[] {
  return Object.freeze(values);
}

const allowed = Object.freeze({
  created: phases("connecting", "rejected", "failed", "expired"),
  connecting: phases("pre_auth", "rejected", "failed", "expired"),
  pre_auth: phases("authenticated", "rejected", "failed", "expired"),
  authenticated: phases("active", "ending", "failed", "expired"),
  active: phases("ending", "failed", "expired"),
  ending: phases("completed", "failed"),
  completed: phases(),
  rejected: phases(),
  failed: phases(),
  expired: phases(),
} satisfies Record<CallPhase, readonly CallPhase[]>);

function isCallPhase(value: unknown): value is CallPhase {
  return typeof value === "string" && Object.hasOwn(allowed, value);
}

export function transitionCall(current: CallPhase, next: CallPhase): CallPhase {
  if (!isCallPhase(current) || !isCallPhase(next) || !allowed[current].includes(next)) {
    throw new Error("invalid_call_transition");
  }
  return next;
}

export function canPersistTurn(
  state: TranscriptState,
  direction: "user" | "assistant",
  delivered: boolean,
): boolean {
  return state === "committed" && (direction === "user" || delivered);
}

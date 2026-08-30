import type { OutboundCallCommand } from "../../../../packages/contracts/src/index.js";

export interface OutboundCallRequest extends OutboundCallCommand {}

export type PolicyReason =
  | "allowed"
  | "invalid_origin"
  | "invalid_purpose"
  | "destination_not_verified"
  | "authorization_expired"
  | "quiet_hours"
  | "daily_limit"
  | "concurrency_limit"
  | "retry_limit"
  | "kill_switch_enabled"
  | "policy_command_conflict"
  | "authorization_missing"
  | "authorization_denied"
  | "audit_persistence_failed";

export interface PolicyDecision {
  decision: "allow" | "deny";
  reason: PolicyReason;
}

export interface DispatchPolicyCheck extends PolicyDecision {
  checkedAt: string;
}

export interface PolicyEngineContract {
  evaluateOutboundCall(request: OutboundCallRequest): Promise<PolicyDecision>;
  recheckOutboundDispatch(request: OutboundCallRequest): Promise<DispatchPolicyCheck>;
}

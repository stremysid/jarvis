import type { OutboundCallCommand, Ulid } from "../../../../packages/contracts/src/index.js";

export interface OutboundCallRequest extends OutboundCallCommand {}

export type PolicyReason =
  | "allowed"
  | "invalid_request"
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
  | "audit_persistence_failed"
  | "invalid_dispatch_attempt";

export interface PolicyDecision {
  decision: "allow" | "deny";
  reason: PolicyReason;
}

export interface DispatchPolicyCheck extends PolicyDecision {
  checkedAt: string;
  /** Fresh event identity for this individual persisted recheck. */
  checkId?: Ulid;
  /** Stable audited attempt identity supplied by the dispatcher. */
  attemptId?: Ulid;
  /** Active verified transport destination; present only on an audited allow. */
  destinationE164?: string;
  /** Canonical command identity captured by the same validated request and audit. */
  commandId?: Ulid;
}

export interface PolicyEngineContract {
  evaluateOutboundCall(request: OutboundCallRequest): Promise<PolicyDecision>;
  recheckOutboundDispatch(request: OutboundCallRequest, attemptId: Ulid): Promise<DispatchPolicyCheck>;
}

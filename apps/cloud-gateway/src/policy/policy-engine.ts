import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { EventRepositoryContract } from "../persistence/event-repository.js";
import { TransactionRunner } from "../persistence/transaction.js";
import { PolicyAudit } from "./policy-audit.js";
import type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract, PolicyReason } from "./policy-types.js";

export type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract, PolicyReason } from "./policy-types.js";

export interface MutablePolicyContext {
  killSwitch: boolean;
  now(): Date;
  isQuietHours(now: Date): boolean;
  activeOutboundCalls(principalId: string): number | Promise<number>;
  outboundCallsForUtcPolicyDay(principalId: string, utcDay: string): number | Promise<number>;
  retryCount(commandId: string): number | Promise<number>;
  nextAuditId(): string;
}

interface StoredDecision { input_hash: string; outcome: "allow" | "deny"; reason_code: PolicyReason; }

function denied(reason: Exclude<PolicyReason, "allowed">): PolicyDecision { return { decision: "deny", reason }; }

function utcDay(now: Date): string { return now.toISOString().slice(0, 10); }

function validExpiry(value: unknown, now: Date): boolean {
  if (typeof value !== "string") return false;
  const expires = new Date(value);
  return !Number.isNaN(expires.valueOf()) && expires.toISOString() === value && expires.valueOf() > now.valueOf();
}

/** Immutable outbound authorization plus per-submission mutable-guard rechecks. */
export class PolicyEngine implements PolicyEngineContract {
  private readonly transactions: TransactionRunner;
  private readonly audit: PolicyAudit;

  constructor(private readonly deps: { database: D1Database; events: EventRepositoryContract; context: MutablePolicyContext; policyVersion?: string }) {
    this.transactions = new TransactionRunner(deps.database);
    this.audit = new PolicyAudit(deps.events, deps.context);
  }

  async evaluateOutboundCall(request: OutboundCallRequest): Promise<PolicyDecision> {
    const inputHash = await this.hashCommand(request);
    const existing = await this.readDecision(request.commandId);
    if (existing !== null) return existing.input_hash === inputHash ? this.fromStored(existing) : denied("policy_command_conflict");

    const result = await this.evaluateNew(request);
    try {
      await this.transactions.batch([this.deps.database.prepare(
        "INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(request.commandId, request.principalId, this.deps.policyVersion ?? "v1", inputHash, result.decision, result.reason, this.isoNow())]);
      return result;
    } catch (error) {
      const raced = await this.readDecision(request.commandId);
      if (raced !== null) return raced.input_hash === inputHash ? this.fromStored(raced) : denied("policy_command_conflict");
      throw error;
    }
  }

  async recheckOutboundDispatch(request: OutboundCallRequest): Promise<DispatchPolicyCheck> {
    const checkedAt = this.isoNow();
    const inputHash = await this.hashCommand(request);
    const stored = await this.readDecision(request.commandId);
    let result: PolicyDecision;
    if (stored === null) result = denied("authorization_missing");
    else if (stored.input_hash !== inputHash) result = denied("policy_command_conflict");
    else if (stored.outcome !== "allow") result = denied("authorization_denied");
    else result = await this.recheckMutable(request);

    const check: DispatchPolicyCheck = { ...result, checkedAt };
    try {
      await this.audit.appendDispatchCheck({ principalId: request.principalId, commandId: request.commandId, inputHash, check });
      return check;
    } catch {
      return { decision: "deny", reason: "audit_persistence_failed", checkedAt };
    }
  }

  private async evaluateNew(request: OutboundCallRequest): Promise<PolicyDecision> {
    if (request.issuedBy !== "telegram_call_command" && request.issuedBy !== "local_cli") return denied("invalid_origin");
    if (request.purposeCode !== "smoke" && request.purposeCode !== "user_requested") return denied("invalid_purpose");
    if (!await this.verifiedDestination(request.principalId, request.destinationIdentityId)) return denied("destination_not_verified");
    return this.recheckMutable(request);
  }

  private async recheckMutable(request: OutboundCallRequest): Promise<PolicyDecision> {
    const now = this.deps.context.now();
    if (this.deps.context.killSwitch) return denied("kill_switch_enabled");
    if (!validExpiry(request.authorizationExpiresAt, now)) return denied("authorization_expired");
    if (this.deps.context.isQuietHours(now)) return denied("quiet_hours");
    if (await this.deps.context.activeOutboundCalls(request.principalId) >= 2) return denied("concurrency_limit");
    if (await this.deps.context.outboundCallsForUtcPolicyDay(request.principalId, utcDay(now)) >= 6) return denied("daily_limit");
    if (await this.deps.context.retryCount(request.commandId) > 1) return denied("retry_limit");
    return { decision: "allow", reason: "allowed" };
  }

  private async verifiedDestination(principalId: string, identityId: string): Promise<boolean> {
    const row = await this.deps.database.prepare(
      "SELECT 1 AS verified FROM channel_identities WHERE identity_id = ? AND principal_id = ? AND channel = 'voice' AND status = 'active' AND verified_at IS NOT NULL",
    ).bind(identityId, principalId).first<{ verified: number }>();
    return row?.verified === 1;
  }

  private async hashCommand(request: OutboundCallRequest): Promise<string> {
    try { return await sha256Hex(canonicalJson(request)); }
    catch { return sha256Hex(canonicalJson({ commandId: request.commandId, malformed: true })); }
  }

  private async readDecision(commandId: string): Promise<StoredDecision | null> {
    return this.deps.database.prepare("SELECT input_hash, outcome, reason_code FROM policy_decisions WHERE decision_id = ?").bind(commandId).first<StoredDecision>();
  }

  private fromStored(stored: StoredDecision): PolicyDecision { return { decision: stored.outcome, reason: stored.reason_code }; }
  private isoNow(): string { return this.deps.context.now().toISOString(); }
}

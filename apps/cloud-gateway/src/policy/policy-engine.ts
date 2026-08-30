import { canonicalJson, sha256Hex, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { EventRepositoryContract } from "../persistence/event-repository.js";
import { TransactionRunner } from "../persistence/transaction.js";
import { PolicyAudit } from "./policy-audit.js";
import type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract, PolicyReason } from "./policy-types.js";

export type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract, PolicyReason } from "./policy-types.js";
export interface TrustedOrigin { principalId: string; issuedBy: "telegram_call_command" | "local_cli"; commandHash: Sha256Hex; }
export interface MutablePolicyContext {
  killSwitch: boolean;
  now(): Date;
  isQuietHours(now: Date): boolean;
  activeOutboundCalls(principalId: string): number | Promise<number>;
  outboundCallsForUtcPolicyDay(principalId: string, utcDay: string): number | Promise<number>;
  retryCount(commandId: string): number | Promise<number>;
  authenticatedOrigin(commandId: string): TrustedOrigin | null | Promise<TrustedOrigin | null>;
  dispatchAttemptId(commandId: string): string;
}

interface StoredDecision { input_hash: string; outcome: "allow" | "deny"; reason_code: PolicyReason; }
const FIELDS = ["commandId", "principalId", "purposeCode", "destinationIdentityId", "urgency", "authorizationExpiresAt", "idempotencyKey", "issuedBy"] as const;
const FIELD_SET = new Set<string>(FIELDS);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const encoder = new TextEncoder();

function denied(reason: Exclude<PolicyReason, "allowed">): PolicyDecision { return { decision: "deny", reason }; }
function utcDay(now: Date): string { return now.toISOString().slice(0, 10); }
function isSafeText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC") && encoder.encode(value).byteLength <= maximumBytes;
}
function isCanonicalTimestamp(value: unknown): value is string {
  if (!isSafeText(value, 32) || !UTC_MS.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}
function isUlid(value: unknown): value is Ulid { return typeof value === "string" && ULID.test(value); }
function isSha256Hex(value: unknown): value is Sha256Hex { return typeof value === "string" && SHA256.test(value); }

/** Rejects accessor, inherited, symbol, extra, non-enumerable, and malformed request values before hashing. */
function validateRequest(value: unknown): OutboundCallRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || keys.some((key) => typeof key !== "string" || !FIELD_SET.has(key))) return null;
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return null;
    record[key] = descriptor.value;
  }
  if (!isUlid(record.commandId) || !isSafeText(record.principalId, 256) || !isSafeText(record.destinationIdentityId, 256) || !isSafeText(record.idempotencyKey, 256)) return null;
  if (!isSafeText(record.purposeCode, 64)) return null;
  if (record.urgency !== "normal" && record.urgency !== "urgent") return null;
  if (!isSafeText(record.issuedBy, 64) || !isCanonicalTimestamp(record.authorizationExpiresAt)) return null;
  return record as unknown as OutboundCallRequest;
}

function validExpiry(value: string, now: Date): boolean { return new Date(value).valueOf() > now.valueOf(); }

/** Immutable outbound authorization plus authenticated, dispatch-time mutable-guard rechecks. */
export class PolicyEngine implements PolicyEngineContract {
  private readonly transactions: TransactionRunner;
  private readonly audit: PolicyAudit;
  constructor(private readonly deps: { database: D1Database; events: EventRepositoryContract; context: MutablePolicyContext; policyVersion?: string }) {
    this.transactions = new TransactionRunner(deps.database);
    this.audit = new PolicyAudit(deps.events);
  }

  async evaluateOutboundCall(input: OutboundCallRequest): Promise<PolicyDecision> {
    const request = validateRequest(input);
    if (request === null) return denied("invalid_request");
    const inputHash = await sha256Hex(canonicalJson(request));
    const existing = await this.readDecision(request.commandId);
    if (existing !== null && existing.input_hash !== inputHash) return denied("policy_command_conflict");
    if (!await this.hasTrustedOrigin(request, inputHash)) return existing === null
      ? this.persistDecision(request, inputHash, denied("invalid_origin"), false)
      : denied("invalid_origin");
    if (existing !== null) return this.fromStored(existing);
    return this.persistDecision(request, inputHash, await this.evaluateNew(request, this.now()), true);
  }

  async recheckOutboundDispatch(input: OutboundCallRequest): Promise<DispatchPolicyCheck> {
    const request = validateRequest(input);
    const checkedAt = this.now().toISOString();
    if (request === null) return { ...denied("invalid_request"), checkedAt };
    const inputHash = await sha256Hex(canonicalJson(request));
    const stored = await this.readDecision(request.commandId);
    let result: PolicyDecision;
    if (stored === null) result = denied("authorization_missing");
    else if (stored.input_hash !== inputHash) result = denied("policy_command_conflict");
    else if (stored.outcome !== "allow") result = denied("authorization_denied");
    else if (!await this.hasTrustedOrigin(request, inputHash)) result = denied("invalid_origin");
    else if (!await this.verifiedDestination(request.principalId, request.destinationIdentityId)) result = denied("destination_not_verified");
    else result = await this.recheckMutable(request, new Date(checkedAt));
    const check: DispatchPolicyCheck = { ...result, checkedAt };
    let attemptId: string;
    try { attemptId = this.deps.context.dispatchAttemptId(request.commandId); }
    catch { return { decision: "deny", reason: "invalid_dispatch_attempt", checkedAt }; }
    if (!isUlid(attemptId)) return { decision: "deny", reason: "invalid_dispatch_attempt", checkedAt };
    try {
      await this.audit.appendDispatchCheck({ attemptId, principalId: request.principalId, commandId: request.commandId, inputHash, check });
      return check;
    } catch { return { decision: "deny", reason: "audit_persistence_failed", checkedAt }; }
  }

  private async persistDecision(request: OutboundCallRequest, inputHash: string, result: PolicyDecision, replayOnRace: boolean): Promise<PolicyDecision> {
    try {
      await this.transactions.batch([this.deps.database.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(request.commandId, request.principalId, this.deps.policyVersion ?? "v1", inputHash, result.decision, result.reason, this.now().toISOString())]);
      return result;
    } catch (error) {
      const raced = await this.readDecision(request.commandId);
      if (raced !== null) return raced.input_hash !== inputHash ? denied("policy_command_conflict") : replayOnRace ? this.fromStored(raced) : denied("invalid_origin");
      throw error;
    }
  }

  private async evaluateNew(request: OutboundCallRequest, now: Date): Promise<PolicyDecision> {
    if (request.purposeCode !== "smoke" && request.purposeCode !== "user_requested") return denied("invalid_purpose");
    if (!await this.verifiedDestination(request.principalId, request.destinationIdentityId)) return denied("destination_not_verified");
    return this.recheckMutable(request, now);
  }
  private async recheckMutable(request: OutboundCallRequest, now: Date): Promise<PolicyDecision> {
    if (this.deps.context.killSwitch) return denied("kill_switch_enabled");
    if (!validExpiry(request.authorizationExpiresAt, now)) return denied("authorization_expired");
    if (this.deps.context.isQuietHours(now)) return denied("quiet_hours");
    if (await this.deps.context.activeOutboundCalls(request.principalId) >= 2) return denied("concurrency_limit");
    if (await this.deps.context.outboundCallsForUtcPolicyDay(request.principalId, utcDay(now)) >= 6) return denied("daily_limit");
    if (await this.deps.context.retryCount(request.commandId) > 1) return denied("retry_limit");
    return { decision: "allow", reason: "allowed" };
  }
  private async hasTrustedOrigin(request: OutboundCallRequest, inputHash: Sha256Hex): Promise<boolean> {
    const origin = await this.deps.context.authenticatedOrigin(request.commandId);
    return origin !== null && isSha256Hex(origin.commandHash) && origin.commandHash === inputHash
      && origin.principalId === request.principalId && origin.issuedBy === request.issuedBy
      && (origin.issuedBy === "telegram_call_command" || origin.issuedBy === "local_cli");
  }
  private async verifiedDestination(principalId: string, identityId: string): Promise<boolean> {
    const row = await this.deps.database.prepare("SELECT 1 AS verified FROM channel_identities WHERE identity_id = ? AND principal_id = ? AND channel = 'voice' AND status = 'active' AND verified_at IS NOT NULL")
      .bind(identityId, principalId).first<{ verified: number }>();
    return row?.verified === 1;
  }
  private async readDecision(commandId: string): Promise<StoredDecision | null> { return this.deps.database.prepare("SELECT input_hash, outcome, reason_code FROM policy_decisions WHERE decision_id = ?").bind(commandId).first<StoredDecision>(); }
  private fromStored(stored: StoredDecision): PolicyDecision { return { decision: stored.outcome, reason: stored.reason_code }; }
  private now(): Date { return this.deps.context.now(); }
}

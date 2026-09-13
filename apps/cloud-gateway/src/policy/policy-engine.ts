import { canonicalJson, newUlid, sha256Hex, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { EventRepositoryContract } from "../persistence/event-repository.js";
import { TransactionRunner } from "../persistence/transaction.js";
import { PolicyAudit } from "./policy-audit.js";
import type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract, PolicyReason } from "./policy-types.js";
import { outboundControlDecision, snapshotOutboundControls, type OutboundControls, type OutboundControlSource } from "./outbound-controls.js";

export type { DispatchPolicyCheck, OutboundCallRequest, PolicyDecision, PolicyEngineContract, PolicyReason } from "./policy-types.js";
export interface TrustedOrigin { principalId: string; issuedBy: "telegram_call_command" | "local_cli"; commandHash: Sha256Hex; }
export interface MutablePolicyContext {
  killSwitch: boolean;
  now(): Date;
  isQuietHours(now: Date): boolean;
  activeOutboundCalls(principalId: string): number | Promise<number>;
  outboundCallsForUtcPolicyDay(principalId: string, utcDay: string): number | Promise<number>;
  authenticatedOrigin(commandId: string): TrustedOrigin | null | Promise<TrustedOrigin | null>;
}

/** Production reads immutable stored controls; component tests may retain synchronous ports. */
export interface StoredPolicyContext extends OutboundControlSource,
  Pick<MutablePolicyContext, "now" | "activeOutboundCalls" | "outboundCallsForUtcPolicyDay" | "authenticatedOrigin"> {}

interface StoredDecision { input_hash: string; outcome: "allow" | "deny"; reason_code: PolicyReason; }
interface PolicyClockSample { readonly epochMs: number; readonly iso: string; readonly utcDay: string; }
const FIELDS = ["commandId", "principalId", "purposeCode", "destinationIdentityId", "urgency", "authorizationExpiresAt", "idempotencyKey", "issuedBy"] as const;
const FIELD_SET = new Set<string>(FIELDS);
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const E164 = /^\+[1-9][0-9]{1,14}$/;
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_POLICY_DAY_STABILITY_PASSES = 3;
const encoder = new TextEncoder();

function denied(reason: Exclude<PolicyReason, "allowed">): PolicyDecision { return { decision: "deny", reason }; }
function sampleClock(value: Date): PolicyClockSample {
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { throw new TypeError("policy_clock_invalid"); }
  if (!Number.isFinite(epochMs)) throw new TypeError("policy_clock_invalid");
  const iso = new Date(epochMs).toISOString();
  return Object.freeze({ epochMs, iso, utcDay: iso.slice(0, 10) });
}
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
function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Rejects accessor, inherited, symbol, extra, non-enumerable, and malformed values, then freezes an owned snapshot. */
export function snapshotOutboundCallRequest(value: unknown): Readonly<OutboundCallRequest> | null {
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
  return Object.freeze({
    commandId: record.commandId,
    principalId: record.principalId,
    purposeCode: record.purposeCode,
    destinationIdentityId: record.destinationIdentityId,
    urgency: record.urgency,
    authorizationExpiresAt: record.authorizationExpiresAt,
    idempotencyKey: record.idempotencyKey,
    issuedBy: record.issuedBy,
  }) as Readonly<OutboundCallRequest>;
}

function validExpiry(value: string, now: PolicyClockSample): boolean { return new Date(value).valueOf() > now.epochMs; }

/** Immutable outbound authorization plus authenticated, dispatch-time mutable-guard rechecks. */
export class PolicyEngine implements PolicyEngineContract {
  private readonly transactions: TransactionRunner;
  private readonly audit: PolicyAudit;
  constructor(private readonly deps: {
    database: D1Database;
    events: EventRepositoryContract;
    context: MutablePolicyContext | StoredPolicyContext;
    policyVersion?: string;
    newUlid?: () => Ulid;
  }) {
    this.transactions = new TransactionRunner(deps.database);
    this.audit = new PolicyAudit(deps.events);
  }

  async evaluateOutboundCall(input: OutboundCallRequest): Promise<PolicyDecision> {
    const request = snapshotOutboundCallRequest(input);
    if (request === null) return denied("invalid_request");
    const inputHash = await sha256Hex(canonicalJson(request));
    const existing = await this.readDecision(request.commandId);
    if (existing !== null && existing.input_hash !== inputHash) return denied("policy_command_conflict");
    if (!await this.hasTrustedOrigin(request, inputHash)) return existing === null
      ? this.persistDecision(request, inputHash, denied("invalid_origin"), false)
      : denied("invalid_origin");
    if (existing !== null) return this.fromStored(existing);
    return this.persistDecision(request, inputHash, await this.evaluateNew(request), true);
  }

  async recheckOutboundDispatch(input: OutboundCallRequest, attemptId: Ulid): Promise<DispatchPolicyCheck> {
    const request = snapshotOutboundCallRequest(input);
    if (request === null) return { ...denied("invalid_request"), checkedAt: this.sampleNow().iso };
    if (!isUlid(attemptId)) return { ...denied("invalid_dispatch_attempt"), checkedAt: this.sampleNow().iso };
    const inputHash = await sha256Hex(canonicalJson(request));
    const stored = await this.readDecision(request.commandId);
    let result: PolicyDecision;
    let destinationE164: string | null = null;
    let checkedAt: string | null = null;
    if (stored === null) result = denied("authorization_missing");
    else if (stored.input_hash !== inputHash) result = denied("policy_command_conflict");
    else if (stored.outcome !== "allow") result = denied("authorization_denied");
    else if (!await this.hasTrustedOrigin(request, inputHash)) result = denied("invalid_origin");
    else {
      destinationE164 = await this.resolveVoiceAccessDestination(request.principalId, request.destinationIdentityId);
      if (destinationE164 === null) result = denied("destination_not_verified");
      else {
        const mutable = await this.recheckMutableForDispatch(request);
        result = mutable.result;
        checkedAt = mutable.checkedAt;
      }
    }
    const auditedAt = checkedAt ?? this.sampleNow().iso;
    const check: DispatchPolicyCheck = { ...result, checkedAt: auditedAt };
    let checkId: Ulid;
    try { checkId = (this.deps.newUlid ?? newUlid)(); }
    catch { return { decision: "deny", reason: "invalid_dispatch_attempt", checkedAt: auditedAt, attemptId }; }
    if (!isUlid(checkId)) return { decision: "deny", reason: "invalid_dispatch_attempt", checkedAt: auditedAt, attemptId };
    try {
      await this.audit.appendDispatchCheck({ checkId, attemptId, principalId: request.principalId, commandId: request.commandId, inputHash, check });
      return result.decision === "allow" && destinationE164 !== null
        ? { ...check, checkId, attemptId, destinationE164, commandId: request.commandId }
        : { ...check, checkId, attemptId };
    } catch { return { decision: "deny", reason: "audit_persistence_failed", checkedAt: auditedAt, attemptId }; }
  }

  private async persistDecision(request: OutboundCallRequest, inputHash: string, result: PolicyDecision, replayOnRace: boolean): Promise<PolicyDecision> {
    try {
      await this.transactions.batch([this.deps.database.prepare("INSERT INTO policy_decisions (decision_id, principal_id, policy_version, input_hash, outcome, reason_code, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(request.commandId, request.principalId, this.deps.policyVersion ?? "v1", inputHash, result.decision, result.reason, this.sampleNow().iso)]);
      return result;
    } catch (error) {
      const raced = await this.readDecision(request.commandId);
      if (raced !== null) return raced.input_hash !== inputHash ? denied("policy_command_conflict") : replayOnRace ? this.fromStored(raced) : denied("invalid_origin");
      throw error;
    }
  }

  private async evaluateNew(request: OutboundCallRequest): Promise<PolicyDecision> {
    if (request.purposeCode !== "smoke" && request.purposeCode !== "user_requested") return denied("invalid_purpose");
    if (!await this.verifiedDestination(request.principalId, request.destinationIdentityId)) return denied("destination_not_verified");
    return (await this.recheckMutableForDispatch(request)).result;
  }
  private async recheckMutableForDispatch(request: OutboundCallRequest): Promise<{ result: PolicyDecision; checkedAt: string }> {
    let controls = await this.readStoredControls();
    const initialNow = this.sampleNow();
    const initialSynchronous = this.recheckSynchronousMutable(request, initialNow, controls);
    if (initialSynchronous.decision === "deny") {
      return { result: initialSynchronous, checkedAt: initialNow.iso };
    }
    const activeCalls: unknown = await this.deps.context.activeOutboundCalls(request.principalId);
    if (!isNonNegativeCount(activeCalls)) {
      return { result: denied("invalid_dispatch_attempt"), checkedAt: this.sampleNow().iso };
    }
    const retries = await this.retryCount(request.commandId);
    let candidateDay = this.sampleNow().utcDay;
    let lastNow = initialNow;
    for (let pass = 0; pass < MAX_POLICY_DAY_STABILITY_PASSES; pass += 1) {
      const dailyCalls: unknown = await this.deps.context.outboundCallsForUtcPolicyDay(request.principalId, candidateDay);
      controls = await this.readStoredControls();
      const finalNow = this.sampleNow();
      lastNow = finalNow;
      if (!isNonNegativeCount(dailyCalls)) {
        return { result: denied("invalid_dispatch_attempt"), checkedAt: finalNow.iso };
      }
      const finalDay = finalNow.utcDay;
      if (finalDay !== candidateDay) {
        candidateDay = finalDay;
        continue;
      }
      let result = this.recheckSynchronousMutable(request, finalNow, controls);
      if (result.decision === "allow" && activeCalls >= 2) result = denied("concurrency_limit");
      if (result.decision === "allow" && dailyCalls >= 6) result = denied("daily_limit");
      if (result.decision === "allow" && retries > 1) result = denied("retry_limit");
      return { result, checkedAt: finalNow.iso };
    }
    const finalSynchronous = this.recheckSynchronousMutable(request, lastNow, controls);
    return {
      result: finalSynchronous.decision === "deny" ? finalSynchronous : denied("invalid_dispatch_attempt"),
      checkedAt: lastNow.iso,
    };
  }
  private async readStoredControls(): Promise<Readonly<OutboundControls> | undefined> {
    return "readControls" in this.deps.context ? snapshotOutboundControls(await this.deps.context.readControls()) : undefined;
  }
  private recheckSynchronousMutable(request: OutboundCallRequest, now: PolicyClockSample, controls?: Readonly<OutboundControls>): PolicyDecision {
    const context = this.deps.context;
    if ("readControls" in context) {
      if (controls === undefined) return denied("invalid_dispatch_attempt");
      if (!validExpiry(request.authorizationExpiresAt, now)) return denied("authorization_expired");
      return outboundControlDecision(controls, now.iso);
    }
    const killSwitch: unknown = context.killSwitch;
    if (typeof killSwitch !== "boolean") return denied("invalid_dispatch_attempt");
    if (killSwitch) return denied("kill_switch_enabled");
    if (!validExpiry(request.authorizationExpiresAt, now)) return denied("authorization_expired");
    const quietHours: unknown = context.isQuietHours(new Date(now.epochMs));
    if (typeof quietHours !== "boolean") return denied("invalid_dispatch_attempt");
    if (quietHours) return denied("quiet_hours");
    return { decision: "allow", reason: "allowed" };
  }
  private async hasTrustedOrigin(request: OutboundCallRequest, inputHash: Sha256Hex): Promise<boolean> {
    const origin = await this.deps.context.authenticatedOrigin(request.commandId);
    return origin !== null && isSha256Hex(origin.commandHash) && origin.commandHash === inputHash
      && origin.principalId === request.principalId && origin.issuedBy === request.issuedBy
      && (origin.issuedBy === "telegram_call_command" || origin.issuedBy === "local_cli");
  }
  private async verifiedDestination(principalId: string, identityId: string): Promise<boolean> {
    return await this.resolveVoiceAccessDestination(principalId, identityId) !== null;
  }
  private async resolveVoiceAccessDestination(principalId: string, identityId: string): Promise<string | null> {
    const row = await this.deps.database.prepare(`SELECT destination.provider_subject
      FROM voice_owner_identity owner
      JOIN principals actor ON actor.principal_id = owner.principal_id
      JOIN channel_identities owner_identity
        ON owner_identity.identity_id = owner.identity_id
        AND owner_identity.principal_id = owner.principal_id
      JOIN channel_identities destination ON destination.identity_id = ?2
      JOIN principals destination_principal
        ON destination_principal.principal_id = destination.principal_id
      WHERE owner.principal_id = ?1
        AND actor.principal_type = 'human'
        AND actor.status = 'active'
        AND owner_identity.channel = 'voice'
        AND owner_identity.status = 'active'
        AND owner_identity.verified_at IS NOT NULL
        AND destination_principal.principal_type = 'human'
        AND destination_principal.status = 'active'
        AND destination.channel = 'voice'
        AND (
          (
            destination.identity_id = owner.identity_id
            AND destination.principal_id = owner.principal_id
            AND destination.status = 'active'
            AND destination.verified_at IS NOT NULL
          )
          OR
          (
            destination.status IN ('pending', 'active')
            AND EXISTS (
              SELECT 1 FROM voice_access_grants grant_row
              WHERE grant_row.identity_id = destination.identity_id
                AND grant_row.principal_id = destination.principal_id
                AND grant_row.status IN ('pending', 'active')
            )
          )
        )`)
      .bind(principalId, identityId).first<{ provider_subject: string }>();
    return typeof row?.provider_subject === "string" && E164.test(row.provider_subject)
      ? row.provider_subject
      : null;
  }
  private async retryCount(commandId: Ulid): Promise<number> {
    const row = await this.deps.database.prepare("SELECT COUNT(*) AS count FROM outbound_call_attempts WHERE command_id = ?")
      .bind(commandId).first<{ count: number }>();
    const count = row?.count ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("outbound_retry_count_invalid");
    return Math.max(count - 1, 0);
  }
  private async readDecision(commandId: string): Promise<StoredDecision | null> { return this.deps.database.prepare("SELECT input_hash, outcome, reason_code FROM policy_decisions WHERE decision_id = ?").bind(commandId).first<StoredDecision>(); }
  private fromStored(stored: StoredDecision): PolicyDecision { return { decision: stored.outcome, reason: stored.reason_code }; }
  private now(): Date { return this.deps.context.now(); }
  private sampleNow(): PolicyClockSample { return sampleClock(this.now()); }
}

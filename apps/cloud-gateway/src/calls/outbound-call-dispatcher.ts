import { newUlid, type OutboundCallCommand, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  AttemptAllocationRaceError,
  type CallRepository,
  type DispatchIntent,
  type ProviderDispatchClaim,
} from "../persistence/call-repository.js";
import {
  ProviderFailure,
  snapshotProviderFailure,
  TWILIO_STATUS_CALLBACK_EVENTS,
  type ProviderFailureCode,
  type TwilioProvider,
} from "../providers/provider-types.js";
import {
  snapshotOutboundCallRequest,
} from "../policy/policy-engine.js";
import type { PolicyEngineContract, PolicyReason } from "../policy/policy-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const E164 = /^\+[1-9][0-9]{1,14}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_ALLOCATION_PASSES = 3;
const POLICY_CHECK_FIELDS = new Set([
  "decision",
  "reason",
  "checkedAt",
  "checkId",
  "attemptId",
  "destinationE164",
  "commandId",
]);
const POLICY_REASONS = new Set<PolicyReason>([
  "allowed",
  "invalid_request",
  "invalid_origin",
  "invalid_purpose",
  "destination_not_verified",
  "authorization_expired",
  "quiet_hours",
  "daily_limit",
  "concurrency_limit",
  "retry_limit",
  "kill_switch_enabled",
  "policy_command_conflict",
  "authorization_missing",
  "authorization_denied",
  "audit_persistence_failed",
  "invalid_dispatch_attempt",
]);

interface DispatchPolicyCheckSnapshot {
  readonly decision: "allow" | "deny";
  readonly reason: PolicyReason;
  readonly checkedAt: string;
  readonly checkId?: Ulid;
  readonly attemptId?: Ulid;
  readonly destinationE164?: string;
  readonly commandId?: Ulid;
}

export type OutboundCallDispatchResult =
  | { status: "denied"; reason: PolicyReason; checkedAt: string; checkId: Ulid | null; attemptId: Ulid | null }
  | { status: "dispatched"; callSid: string; attemptId: Ulid }
  | { status: "rejected"; attemptId: Ulid; failureCode: ProviderFailureCode; retryEligible: boolean }
  | { status: "provider_dispatch_unknown"; attemptId: Ulid };

function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID.test(value);
}

function isCallSid(value: unknown): value is string {
  return typeof value === "string" && CALL_SID.test(value);
}

function snapshotDateIso(value: Date): string {
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { throw new TypeError("dispatch_clock_invalid"); }
  if (!Number.isFinite(epochMs)) throw new TypeError("dispatch_clock_invalid");
  return new Date(epochMs).toISOString();
}

function snapshotDispatchPolicyCheck(value: unknown): DispatchPolicyCheckSnapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string" || !POLICY_CHECK_FIELDS.has(key))
    || !Object.hasOwn(descriptors, "decision")
    || !Object.hasOwn(descriptors, "reason")
    || !Object.hasOwn(descriptors, "checkedAt")
  ) {
    return null;
  }
  for (const key of keys) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
  }
  const decision: unknown = descriptors.decision?.value;
  const reason: unknown = descriptors.reason?.value;
  const checkedAt: unknown = descriptors.checkedAt?.value;
  const checkId: unknown = descriptors.checkId?.value;
  const attemptId: unknown = descriptors.attemptId?.value;
  const destinationE164: unknown = descriptors.destinationE164?.value;
  const commandId: unknown = descriptors.commandId?.value;
  if (decision !== "allow" && decision !== "deny") return null;
  if (typeof reason !== "string" || !POLICY_REASONS.has(reason as PolicyReason)) return null;
  if ((decision === "allow") !== (reason === "allowed")) return null;
  if (
    typeof checkedAt !== "string"
    || !UTC_MILLISECONDS.test(checkedAt)
    || Number.isNaN(new Date(checkedAt).valueOf())
    || new Date(checkedAt).toISOString() !== checkedAt
  ) {
    return null;
  }
  if (checkId !== undefined && !isUlid(checkId)) return null;
  if (attemptId !== undefined && !isUlid(attemptId)) return null;
  if (commandId !== undefined && !isUlid(commandId)) return null;
  if (destinationE164 !== undefined && (typeof destinationE164 !== "string" || !E164.test(destinationE164))) return null;
  return Object.freeze({
    decision,
    reason: reason as PolicyReason,
    checkedAt,
    checkId,
    attemptId,
    destinationE164,
    commandId,
  });
}

function isExplicitRejection(error: unknown): error is ProviderFailure {
  const failure = snapshotProviderFailure(error);
  return failure !== null && (
    (failure.code === "provider_transient_failure" && failure.category === "rate_limited")
    || (failure.code === "provider_authentication_failure" && failure.category === "authentication")
    || (failure.code === "provider_permanent_failure" && failure.category === "invalid_request")
  );
}

/** Claims durable dispatch ownership before the sole non-idempotent Twilio POST. */
export class OutboundCallDispatcher {
  private readonly publicBaseUrl: URL;
  private readonly newAttemptId: () => Ulid;
  private readonly now: () => Date;

  constructor(private readonly deps: {
    policy: PolicyEngineContract;
    twilio: TwilioProvider;
    repository: CallRepository;
    publicBaseUrl: URL;
    newAttemptId?: () => Ulid;
    now?: () => Date;
  }) {
    const baseUrl = new URL(deps.publicBaseUrl.toString());
    if (
      baseUrl.protocol !== "https:"
      || baseUrl.username !== ""
      || baseUrl.password !== ""
      || baseUrl.search !== ""
      || baseUrl.hash !== ""
    ) {
      throw new TypeError("invalid_call_base_url");
    }
    this.publicBaseUrl = baseUrl;
    this.newAttemptId = deps.newAttemptId ?? newUlid;
    this.now = deps.now ?? (() => new Date());
  }

  async dispatch(input: OutboundCallCommand): Promise<OutboundCallDispatchResult> {
    const request = snapshotOutboundCallRequest(input);
    if (request === null) {
      return {
        status: "denied",
        reason: "invalid_request",
        checkedAt: snapshotDateIso(this.now()),
        checkId: null,
        attemptId: null,
      };
    }

    let racedAttempt: Readonly<{ attemptId: Ulid; attemptOrdinal: 0 | 1 }> | null = null;
    for (let pass = 0; pass < MAX_ALLOCATION_PASSES; pass += 1) {
      const intent = await this.deps.repository.resolveDispatchIntent(request.commandId);
      let attemptId: Ulid;
      let allocationOrdinal: 0 | 1;

      if (racedAttempt !== null) {
        attemptId = racedAttempt.attemptId;
        allocationOrdinal = racedAttempt.attemptOrdinal;
        racedAttempt = null;
      } else if (intent.kind === "allocate") {
        const candidate = this.newAttemptId();
        if (!isUlid(candidate)) {
          return this.invalidDispatchResult(snapshotDateIso(this.now()), null, null);
        }
        attemptId = candidate;
        allocationOrdinal = intent.attemptOrdinal;
      } else {
        attemptId = intent.attempt.attemptId;
        if (intent.state !== "ready") return this.resolveExistingIntent(intent);
        allocationOrdinal = intent.attempt.attemptOrdinal;
      }

      const check = snapshotDispatchPolicyCheck(await this.deps.policy.recheckOutboundDispatch(request, attemptId));
      if (check === null) {
        return this.invalidDispatchResult(snapshotDateIso(this.now()), null, attemptId);
      }
      if (check.decision !== "allow") {
        return {
          status: "denied",
          reason: check.reason,
          checkedAt: check.checkedAt,
          checkId: isUlid(check.checkId) ? check.checkId : null,
          attemptId,
        };
      }
      if (!this.isAuditedAllow(check, request.commandId, attemptId)) {
        return this.invalidDispatchResult(check.checkedAt, isUlid(check.checkId) ? check.checkId : null, attemptId);
      }

      try {
        await this.deps.repository.getOrCreateExpectedCall({
          attemptId,
          commandId: request.commandId,
          principalId: request.principalId,
          destinationIdentityId: request.destinationIdentityId,
          idempotencyKey: request.idempotencyKey,
          authorizationExpiresAt: request.authorizationExpiresAt,
          now: this.now(),
          attemptOrdinal: allocationOrdinal,
        });
      } catch (error) {
        if (error instanceof AttemptAllocationRaceError) {
          racedAttempt = Object.freeze({
            attemptId: error.currentAttemptId,
            attemptOrdinal: error.attemptOrdinal,
          });
          continue;
        }
        throw error;
      }

      const claimObservedAtIso = snapshotDateIso(this.now());
      const claim = await this.deps.repository.claimProviderDispatch({ attemptId, now: new Date(claimObservedAtIso) });
      const claimKind = claim.kind;
      if (claimKind === "authorization_expired") {
        return this.deniedAtClaim("authorization_expired", claimObservedAtIso, attemptId);
      }
      if (claimKind === "relay_nonce_expired") {
        return this.deniedAtClaim("invalid_dispatch_attempt", claimObservedAtIso, attemptId);
      }
      if (claimKind !== "claimed") return this.resolveClaimResult(attemptId, claim);
      const capability = claim.capability;

      const twimlUrl = new URL(`/voice/outbound/${attemptId}`, this.publicBaseUrl);
      const statusCallbackUrl = new URL(`/voice/status/${attemptId}`, this.publicBaseUrl);
      try {
        // This is the final synchronous authority check before POST. No await belongs
        // between it and createCall; external policy state cannot be atomically coupled to Twilio.
        this.deps.repository.beginProviderDispatch(capability, attemptId);
      } catch {
        return { status: "provider_dispatch_unknown", attemptId };
      }
      try {
        const providerResult = await this.deps.twilio.createCall({
          commandId: request.commandId,
          attemptId,
          toE164: check.destinationE164,
          twimlUrl,
          statusCallbackUrl,
          statusCallbackEvents: TWILIO_STATUS_CALLBACK_EVENTS,
          idempotencyKey: attemptId,
        });
        const callSid = providerResult.callSid;
        if (!isCallSid(callSid)) {
          try {
            await this.deps.repository.recordProviderDispatchUnknown({ claim: capability, now: this.now() });
          } catch {
            // The capability is already consumed or persistence is uncertain; no second result write is permitted.
          }
          return { status: "provider_dispatch_unknown", attemptId };
        }
        try {
          await this.deps.repository.recordProviderDispatchSuccess({ claim: capability, callSid, now: this.now() });
        } catch {
          return { status: "provider_dispatch_unknown", attemptId };
        }
        return { status: "dispatched", callSid, attemptId };
      } catch (error) {
        if (isExplicitRejection(error)) {
          try {
            await this.deps.repository.recordProviderDispatchRejection({ claim: capability, failure: error, now: this.now() });
            const stored = await this.deps.repository.claimProviderDispatch({ attemptId, now: this.now() });
            return this.resolveClaimResult(attemptId, stored);
          } catch {
            return { status: "provider_dispatch_unknown", attemptId };
          }
        }
        try {
          await this.deps.repository.recordProviderDispatchUnknown({ claim: capability, now: this.now() });
        } catch {
          // Unknown is the only safe externally visible result after any thrown or unsupported provider outcome.
        }
        return { status: "provider_dispatch_unknown", attemptId };
      }
    }
    throw new Error("outbound_attempt_allocation_race_limit");
  }

  private isAuditedAllow(check: DispatchPolicyCheckSnapshot, commandId: Ulid, attemptId: Ulid): check is DispatchPolicyCheckSnapshot & {
    checkId: Ulid;
    attemptId: Ulid;
    commandId: Ulid;
    destinationE164: string;
  } {
    return isUlid(check.checkId)
      && check.attemptId === attemptId
      && check.commandId === commandId
      && typeof check.destinationE164 === "string"
      && E164.test(check.destinationE164);
  }

  private invalidDispatchResult(checkedAt: string, checkId: Ulid | null, attemptId: Ulid | null): OutboundCallDispatchResult {
    return { status: "denied", reason: "invalid_dispatch_attempt", checkedAt, checkId, attemptId };
  }

  private deniedAtClaim(reason: "authorization_expired" | "invalid_dispatch_attempt", observedAt: string, attemptId: Ulid): OutboundCallDispatchResult {
    return { status: "denied", reason, checkedAt: observedAt, checkId: null, attemptId };
  }

  private async resolveExistingIntent(intent: Extract<DispatchIntent, { kind: "existing" }>): Promise<OutboundCallDispatchResult> {
    const attemptId = intent.attempt.attemptId;
    if (intent.state === "dispatched" && intent.callSid !== null) {
      return { status: "dispatched", callSid: intent.callSid, attemptId };
    }
    if (intent.state === "rejected" && intent.failureCode !== null) {
      return { status: "rejected", attemptId, failureCode: intent.failureCode, retryEligible: intent.retryEligible };
    }
    if (intent.state === "provider_dispatch_unknown") return { status: "provider_dispatch_unknown", attemptId };
    if (intent.state === "claimed") {
      return this.resolveClaimedRecovery(attemptId);
    }
    throw new Error("outbound_dispatch_intent_invalid");
  }

  private async resolveClaimedRecovery(attemptId: Ulid): Promise<OutboundCallDispatchResult> {
    const claim = await this.deps.repository.claimProviderDispatch({ attemptId, now: this.now() });
    return this.resolveClaimResult(attemptId, claim);
  }

  private resolveClaimResult(attemptId: Ulid, claim: ProviderDispatchClaim): OutboundCallDispatchResult {
    if (claim.kind === "dispatched") return { status: "dispatched", callSid: claim.callSid, attemptId };
    if (claim.kind === "rejected") {
      return { status: "rejected", attemptId, failureCode: claim.failureCode, retryEligible: claim.retryEligible };
    }
    if (claim.kind === "provider_dispatch_unknown") return { status: "provider_dispatch_unknown", attemptId };
    throw new Error("provider_dispatch_claim_unexpected");
  }
}

import { newUlid, type OutboundCallCommand, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  AttemptAllocationRaceError,
  type CallRepository,
  type DispatchIntent,
  type ProviderDispatchClaim,
} from "../persistence/call-repository.js";
import {
  ProviderFailure,
  TWILIO_STATUS_CALLBACK_EVENTS,
  type ProviderFailureCode,
  type TwilioProvider,
} from "../providers/provider-types.js";
import {
  snapshotOutboundCallRequest,
} from "../policy/policy-engine.js";
import type { DispatchPolicyCheck, PolicyEngineContract, PolicyReason } from "../policy/policy-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const E164 = /^\+[1-9][0-9]{1,14}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const MAX_ALLOCATION_PASSES = 3;

export type OutboundCallDispatchResult =
  | { status: "denied"; reason: PolicyReason; checkedAt: string; checkId: Ulid | null; attemptId: Ulid | null }
  | { status: "dispatched"; callSid: string; attemptId: Ulid }
  | { status: "rejected"; attemptId: Ulid; failureCode: ProviderFailureCode; retryEligible: boolean }
  | { status: "provider_dispatch_unknown"; attemptId: Ulid };

function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID.test(value);
}

function isExplicitRejection(error: unknown): error is ProviderFailure {
  return error instanceof ProviderFailure && (
    (error.code === "provider_transient_failure" && error.category === "rate_limited")
    || (error.code === "provider_authentication_failure" && error.category === "authentication")
    || (error.code === "provider_permanent_failure" && error.category === "invalid_request")
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
        checkedAt: this.now().toISOString(),
        checkId: null,
        attemptId: null,
      };
    }

    let racedAttemptId: Ulid | null = null;
    for (let pass = 0; pass < MAX_ALLOCATION_PASSES; pass += 1) {
      const intent = await this.deps.repository.resolveDispatchIntent(request.commandId);
      let attemptId: Ulid;
      let allocationOrdinal: 0 | 1 | undefined;
      const forceRacedAudit = racedAttemptId !== null;

      if (racedAttemptId !== null) {
        attemptId = racedAttemptId;
        racedAttemptId = null;
      } else if (intent.kind === "allocate") {
        const candidate = this.newAttemptId();
        if (!isUlid(candidate)) {
          return this.invalidDispatchResult(this.now().toISOString(), null, null);
        }
        attemptId = candidate;
        allocationOrdinal = intent.attemptOrdinal;
      } else {
        attemptId = intent.attempt.attemptId;
        if (intent.state !== "ready") return this.resolveExistingIntent(intent);
      }

      const check = await this.deps.policy.recheckOutboundDispatch(request, attemptId);
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
          now: this.now(),
          attemptOrdinal: allocationOrdinal,
        });
      } catch (error) {
        if (error instanceof AttemptAllocationRaceError) {
          racedAttemptId = error.currentAttemptId;
          continue;
        }
        throw error;
      }

      const claim = await this.deps.repository.claimProviderDispatch({ attemptId, now: this.now() });
      if (claim.kind !== "claimed") return this.resolveClaimResult(attemptId, claim);

      const twimlUrl = new URL(`/voice/outbound/${attemptId}`, this.publicBaseUrl);
      const statusCallbackUrl = new URL(`/voice/status/${attemptId}`, this.publicBaseUrl);
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
        if (!CALL_SID.test(providerResult.callSid)) {
          try {
            await this.deps.repository.recordProviderDispatchUnknown({ claim: claim.capability, now: this.now() });
          } catch {
            // The capability is already consumed or persistence is uncertain; no second result write is permitted.
          }
          return { status: "provider_dispatch_unknown", attemptId };
        }
        try {
          await this.deps.repository.recordProviderDispatchSuccess({ claim: claim.capability, callSid: providerResult.callSid, now: this.now() });
        } catch {
          return { status: "provider_dispatch_unknown", attemptId };
        }
        return { status: "dispatched", callSid: providerResult.callSid, attemptId };
      } catch (error) {
        if (isExplicitRejection(error)) {
          try {
            await this.deps.repository.recordProviderDispatchRejection({ claim: claim.capability, failure: error, now: this.now() });
            const stored = await this.deps.repository.claimProviderDispatch({ attemptId, now: this.now() });
            return this.resolveClaimResult(attemptId, stored);
          } catch {
            return { status: "provider_dispatch_unknown", attemptId };
          }
        }
        try {
          await this.deps.repository.recordProviderDispatchUnknown({ claim: claim.capability, now: this.now() });
        } catch {
          // Unknown is the only safe externally visible result after any thrown or unsupported provider outcome.
        }
        return { status: "provider_dispatch_unknown", attemptId };
      } finally {
        if (forceRacedAudit) racedAttemptId = null;
      }
    }
    throw new Error("outbound_attempt_allocation_race_limit");
  }

  private isAuditedAllow(check: DispatchPolicyCheck, commandId: Ulid, attemptId: Ulid): check is DispatchPolicyCheck & {
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

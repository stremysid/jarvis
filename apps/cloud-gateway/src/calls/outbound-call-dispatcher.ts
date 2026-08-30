import type { OutboundCallCommand } from "../../../../packages/contracts/src/index.js";
import {
  TWILIO_STATUS_CALLBACK_EVENTS,
  type TwilioProvider,
} from "../providers/provider-types.js";
import type { PolicyEngineContract, PolicyReason } from "../policy/policy-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const E164 = /^\+[1-9][0-9]{1,14}$/;

export type OutboundCallDispatchResult =
  | { status: "denied"; reason: PolicyReason; checkedAt: string }
  | { status: "dispatched"; callSid: string; checkedAt: string; attemptId: string };

/** Rechecks current policy before constructing the provider request. */
export class OutboundCallDispatcher {
  private readonly publicBaseUrl: URL;

  constructor(private readonly deps: { policy: PolicyEngineContract; twilio: TwilioProvider; publicBaseUrl: URL }) {
    const baseUrl = new URL(deps.publicBaseUrl.toString());
    if (baseUrl.protocol !== "https:" || baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.search !== "" || baseUrl.hash !== "") {
      throw new TypeError("invalid_call_base_url");
    }
    this.publicBaseUrl = baseUrl;
  }

  async dispatch(command: OutboundCallCommand): Promise<OutboundCallDispatchResult> {
    const check = await this.deps.policy.recheckOutboundDispatch(command);
    if (check.decision !== "allow") {
      return { status: "denied", reason: check.reason, checkedAt: check.checkedAt };
    }
    if (typeof check.attemptId !== "string" || !ULID.test(check.attemptId)) {
      return { status: "denied", reason: "invalid_dispatch_attempt", checkedAt: check.checkedAt };
    }
    if (typeof check.commandId !== "string" || !ULID.test(check.commandId)) {
      return { status: "denied", reason: "invalid_dispatch_attempt", checkedAt: check.checkedAt };
    }
    if (typeof check.destinationE164 !== "string" || !E164.test(check.destinationE164)) {
      return { status: "denied", reason: "destination_not_verified", checkedAt: check.checkedAt };
    }

    const result = await this.deps.twilio.createCall({
      commandId: check.commandId,
      attemptId: check.attemptId,
      toE164: check.destinationE164,
      twimlUrl: new URL(`/voice/outbound/${encodeURIComponent(check.attemptId)}`, this.publicBaseUrl),
      statusCallbackUrl: new URL(`/voice/status/${encodeURIComponent(check.attemptId)}`, this.publicBaseUrl),
      statusCallbackEvents: TWILIO_STATUS_CALLBACK_EVENTS,
      idempotencyKey: check.attemptId,
    });
    return {
      status: "dispatched",
      callSid: result.callSid,
      checkedAt: check.checkedAt,
      attemptId: check.attemptId,
    };
  }
}

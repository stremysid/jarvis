import { describe, expect, it } from "vitest";
import type { OutboundCallCommand } from "../../../../packages/contracts/src/index.js";
import { OutboundCallDispatcher } from "../../src/calls/outbound-call-dispatcher.js";
import { FakeTwilioProvider } from "../../src/providers/fake-twilio-provider.js";
import type {
  DispatchPolicyCheck,
  OutboundCallRequest,
  PolicyDecision,
  PolicyEngineContract,
} from "../../src/policy/policy-types.js";

const checkedAt = "2026-08-30T12:00:00.000Z";
const attemptId = "01k3s6k8000000000000000009";
const destinationE164 = "+14165550123";
const auditedCommandId = "01k3s6k8000000000000000000";

function command(): OutboundCallCommand {
  return {
    commandId: "01k3s6k8000000000000000000" as OutboundCallCommand["commandId"],
    principalId: "principal:owner",
    purposeCode: "user_requested",
    destinationIdentityId: "identity:voice",
    urgency: "normal",
    authorizationExpiresAt: "2026-08-30T12:05:00.000Z",
    idempotencyKey: "call:test",
    issuedBy: "telegram_call_command",
  };
}

class RecordingPolicy implements PolicyEngineContract {
  readonly rechecks: OutboundCallRequest[] = [];

  constructor(private readonly result: DispatchPolicyCheck) {}

  async evaluateOutboundCall(): Promise<PolicyDecision> {
    return { decision: "deny", reason: "authorization_missing" };
  }

  async recheckOutboundDispatch(request: OutboundCallRequest): Promise<DispatchPolicyCheck> {
    this.rechecks.push(request);
    return this.result;
  }
}

function dispatcher(policy: PolicyEngineContract, twilio: FakeTwilioProvider) {
  return new OutboundCallDispatcher({
    policy,
    twilio,
    publicBaseUrl: new URL("https://jarvis.example/"),
  });
}

describe("OutboundCallDispatcher", () => {
  it("returns the fresh policy denial without making a Twilio request", async () => {
    const policy = new RecordingPolicy({
      decision: "deny",
      reason: "authorization_denied",
      checkedAt,
      attemptId,
    });
    const twilio = new FakeTwilioProvider();
    const subject = dispatcher(policy, twilio);

    await expect(subject.dispatch(command())).resolves.toEqual({
      status: "denied",
      reason: "authorization_denied",
      checkedAt,
    });
    expect(policy.rechecks).toEqual([command()]);
    expect(twilio.requests).toHaveLength(0);
  });

  it("uses only the policy-resolved destination and trusted derived URLs for provider submission", async () => {
    const policy = new RecordingPolicy({
      decision: "allow",
      reason: "allowed",
      checkedAt,
      attemptId,
      destinationE164,
      commandId: auditedCommandId,
    });
    const twilio = new FakeTwilioProvider();
    const subject = dispatcher(policy, twilio);
    const untrusted = { ...command(), toE164: "+14165550999", twimlUrl: "https://attacker.invalid" };

    await expect(subject.dispatch(untrusted as never)).resolves.toEqual({
      status: "dispatched",
      callSid: "CA00000000000000000000000000000001",
      checkedAt,
      attemptId,
    });
    expect(twilio.requests).toEqual([
      expect.objectContaining({
        commandId: command().commandId,
        toE164: destinationE164,
        twimlUrl: new URL("https://jarvis.example/voice/outbound/01k3s6k8000000000000000000"),
        statusCallbackUrl: new URL("https://jarvis.example/voice/status"),
        idempotencyKey: attemptId,
        statusCallbackEvents: ["initiated", "ringing", "answered", "completed"],
      }),
    ]);
  });

  it("fails closed when an allow result has no audited attempt identity", async () => {
    const policy = new RecordingPolicy({
      decision: "allow",
      reason: "allowed",
      checkedAt,
      destinationE164,
      commandId: auditedCommandId,
    });
    const twilio = new FakeTwilioProvider();
    const subject = dispatcher(policy, twilio);

    await expect(subject.dispatch(command())).resolves.toEqual({
      status: "denied",
      reason: "invalid_dispatch_attempt",
      checkedAt,
    });
    expect(twilio.requests).toHaveLength(0);
  });

  it("fails closed when policy cannot resolve an active verified destination", async () => {
    const policy = new RecordingPolicy({
      decision: "allow",
      reason: "allowed",
      checkedAt,
      attemptId,
      commandId: auditedCommandId,
    });
    const twilio = new FakeTwilioProvider();
    const subject = dispatcher(policy, twilio);

    await expect(subject.dispatch(command())).resolves.toEqual({
      status: "denied",
      reason: "destination_not_verified",
      checkedAt,
    });
    expect(twilio.requests).toHaveLength(0);
  });

  it("does not mistake one audited attempt identity for provider idempotency", async () => {
    const policy = new RecordingPolicy({
      decision: "allow",
      reason: "allowed",
      checkedAt,
      attemptId,
      destinationE164,
      commandId: auditedCommandId,
    });
    const twilio = new FakeTwilioProvider();
    const subject = dispatcher(policy, twilio);

    const results = await Promise.all([subject.dispatch(command()), subject.dispatch(command())]);

    expect(results).toEqual([
      expect.objectContaining({ status: "dispatched", attemptId, callSid: "CA00000000000000000000000000000001" }),
      expect.objectContaining({ status: "dispatched", attemptId, callSid: "CA00000000000000000000000000000002" }),
    ]);
    expect(twilio.requests).toHaveLength(2);
  });

  it("fails closed when an allow result has no audited command identity", async () => {
    const policy = new RecordingPolicy({
      decision: "allow",
      reason: "allowed",
      checkedAt,
      attemptId,
      destinationE164,
    });
    const twilio = new FakeTwilioProvider();
    const subject = dispatcher(policy, twilio);

    await expect(subject.dispatch(command())).resolves.toEqual({
      status: "denied",
      reason: "invalid_dispatch_attempt",
      checkedAt,
    });
    expect(twilio.requests).toHaveLength(0);
  });

  it("never rereads caller-owned command identity after the audited recheck", async () => {
    const original = command();
    const mutated = "01k3s6k8000000000000000008";
    const policy: PolicyEngineContract = {
      evaluateOutboundCall: async () => ({ decision: "allow", reason: "allowed" }),
      recheckOutboundDispatch: async (input) => {
        (input as { commandId: string }).commandId = mutated;
        return {
          decision: "allow",
          reason: "allowed",
          checkedAt,
          attemptId,
          destinationE164,
          commandId: auditedCommandId,
        };
      },
    };
    const twilio = new FakeTwilioProvider();
    const subject = dispatcher(policy, twilio);

    await expect(subject.dispatch(original)).resolves.toMatchObject({ status: "dispatched" });
    expect(original.commandId).toBe(mutated);
    expect(twilio.requests[0]).toMatchObject({
      commandId: auditedCommandId,
      twimlUrl: new URL(`https://jarvis.example/voice/outbound/${auditedCommandId}`),
    });
  });
});

import { canonicalJson, createEnvelope, sha256Hex, type Sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { EventRepositoryContract } from "../persistence/event-repository.js";
import { Redactor } from "../security/redaction.js";
import type { DispatchPolicyCheck } from "./policy-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const encoder = new TextEncoder();

function exactUtf8(value: string): readonly number[] {
  return Object.freeze([...encoder.encode(value)]);
}

/** Appends only canonical policy metadata; it never accepts destination or ingress text. */
export class PolicyAudit {
  constructor(private readonly events: EventRepositoryContract) {}

  async appendDispatchCheck(input: {
    checkId: Ulid;
    attemptId: Ulid;
    principalId: string;
    commandId: Ulid;
    inputHash: Sha256Hex;
    check: DispatchPolicyCheck;
  }): Promise<void> {
    const checkId = input.checkId;
    const attemptId = input.attemptId;
    const principalId = input.principalId;
    const commandId = input.commandId;
    const inputHash = input.inputHash;
    const check = input.check;
    const decisionValue = check.decision;
    const reasonValue = check.reason;
    const checkedAtValue = check.checkedAt;
    if (!ULID.test(checkId) || !ULID.test(attemptId) || !ULID.test(commandId) || !SHA256.test(inputHash)) {
      throw new TypeError("policy_audit_linkage_invalid");
    }
    const checkedAtDate = new Date(checkedAtValue);
    if (
      !UTC_MILLISECONDS.test(checkedAtValue)
      || Number.isNaN(checkedAtDate.valueOf())
      || checkedAtDate.toISOString() !== checkedAtValue
    ) {
      throw new TypeError("policy_audit_timestamp_invalid");
    }
    const redactor = new Redactor();
    const decision = redactor.redactText(decisionValue);
    const reason = redactor.redactText(reasonValue);
    const checkedAt = redactor.redactText(checkedAtValue);
    if (!decision.ok || !reason.ok || !checkedAt.ok) throw new Error("policy_audit_redaction_failed");
    const payload = {
      linkage: {
        checkIdUtf8: exactUtf8(checkId),
        attemptIdUtf8: exactUtf8(attemptId),
        commandIdUtf8: exactUtf8(commandId),
        inputHashUtf8: exactUtf8(inputHash),
      },
      result: { decision, reason, checkedAt },
    } as const;
    const envelope = await createEnvelope({
      schemaVersion: "1.0", eventId: checkId, eventType: "policy.dispatch_checked", source: "policy", subjectId: principalId,
      occurredAt: checkedAtValue, receivedAt: checkedAtValue, correlationId: attemptId, causationId: commandId,
      contentType: "application/json", payload, producerVersion: "policy-v1",
    });
    const checkHash = canonicalJson({
      checkId,
      attemptId,
      commandId,
      inputHash,
      decision: decisionValue,
      reason: reasonValue,
      checkedAt: checkedAtValue,
    });
    await this.events.append({ envelope, scope: "policy:dispatch-check", key: checkId, requestHash: await sha256Hex(checkHash) });
  }
}

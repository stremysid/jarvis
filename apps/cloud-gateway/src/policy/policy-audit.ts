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
    if (!ULID.test(input.checkId) || !ULID.test(input.attemptId) || !ULID.test(input.commandId) || !SHA256.test(input.inputHash)) {
      throw new TypeError("policy_audit_linkage_invalid");
    }
    if (!UTC_MILLISECONDS.test(input.check.checkedAt) || new Date(input.check.checkedAt).toISOString() !== input.check.checkedAt) {
      throw new TypeError("policy_audit_timestamp_invalid");
    }
    const redactor = new Redactor();
    const decision = redactor.redactText(input.check.decision);
    const reason = redactor.redactText(input.check.reason);
    const checkedAt = redactor.redactText(input.check.checkedAt);
    if (!decision.ok || !reason.ok || !checkedAt.ok) throw new Error("policy_audit_redaction_failed");
    const payload = {
      linkage: {
        checkIdUtf8: exactUtf8(input.checkId),
        attemptIdUtf8: exactUtf8(input.attemptId),
        commandIdUtf8: exactUtf8(input.commandId),
        inputHashUtf8: exactUtf8(input.inputHash),
      },
      result: { decision, reason, checkedAt },
    } as const;
    const envelope = await createEnvelope({
      schemaVersion: "1.0", eventId: input.checkId, eventType: "policy.dispatch_checked", source: "policy", subjectId: input.principalId,
      occurredAt: input.check.checkedAt, receivedAt: input.check.checkedAt, correlationId: input.attemptId, causationId: input.commandId,
      contentType: "application/json", payload, producerVersion: "policy-v1",
    });
    const checkHash = canonicalJson({
      checkId: input.checkId,
      attemptId: input.attemptId,
      commandId: input.commandId,
      inputHash: input.inputHash,
      decision: input.check.decision,
      reason: input.check.reason,
      checkedAt: input.check.checkedAt,
    });
    await this.events.append({ envelope, scope: "policy:dispatch-check", key: input.checkId, requestHash: await sha256Hex(checkHash) });
  }
}

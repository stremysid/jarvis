import { canonicalJson, createEnvelope, sha256Hex } from "../../../../packages/contracts/src/index.js";
import type { EventRepositoryContract } from "../persistence/event-repository.js";
import { Redactor } from "../security/redaction.js";
import type { DispatchPolicyCheck } from "./policy-types.js";

export interface PolicyAuditClock {
  nextAuditId(): string;
}

/** Appends only canonical policy metadata; it never accepts destination or ingress text. */
export class PolicyAudit {
  constructor(private readonly events: EventRepositoryContract, private readonly clock: PolicyAuditClock) {}

  async appendDispatchCheck(input: { principalId: string; commandId: string; inputHash: string; check: DispatchPolicyCheck }): Promise<void> {
    const auditId = this.clock.nextAuditId();
    const payload = canonicalJson({ commandId: input.commandId, inputHash: input.inputHash, decision: input.check.decision, reason: input.check.reason, checkedAt: input.check.checkedAt });
    const audit = new Redactor().redactText(payload);
    if (!audit.ok) throw new Error("policy_audit_redaction_failed");
    const envelope = await createEnvelope({
      schemaVersion: "1.0", eventId: auditId as never, eventType: "policy.dispatch_checked", source: "policy", subjectId: input.principalId,
      occurredAt: input.check.checkedAt, receivedAt: input.check.checkedAt, correlationId: auditId as never, contentType: "application/json",
      payload: { audit }, producerVersion: "policy-v1",
    });
    await this.events.append({ envelope, scope: "policy:dispatch-check", key: auditId, requestHash: await sha256Hex(payload) });
  }
}

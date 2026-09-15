// Adversarial probes against the exact 407af7d validator.
import { validateEvidence, auditVoiceEvidence } from "./voice-smoke.ts";
import {
  inboundEvidence, unauthorizedEvidence, outboundAnswerEvidence, outboundNoAnswerEvidence,
  ownerStepUpRefusedEvidence, failureEvidence, AUDIT_TIME, completeSet,
} from "./fixtures.mjs";

let index = 0;
function probeRecord(label, record) {
  index += 1;
  try {
    validateEvidence(record);
    console.log(`P${String(index).padStart(2, "0")} ACCEPTED  record  ${label}`);
  } catch (error) {
    console.log(`P${String(index).padStart(2, "0")} REJECTED  record  ${label}  (${error.message})`);
  }
}
function probeAudit(label, records, auditTime = AUDIT_TIME) {
  index += 1;
  try {
    auditVoiceEvidence(records, auditTime);
    console.log(`P${String(index).padStart(2, "0")} ACCEPTED  audit   ${label}`);
  } catch (error) {
    console.log(`P${String(index).padStart(2, "0")} REJECTED  audit   ${label}  (${error.message})`);
  }
}

const waivedInbound = {
  ...inboundEvidence,
  authenticationMode: "owner_attested_waiver",
  ownerStepUpOutcome: "waived_passed_a",
  ownerStepUpPromptCount: 0,
  ownerStepUpAttemptCount: 0,
  callerIdAttestation: "passed_a",
  ownerCallerIdPolicy: "waive_on_passed_a",
};

console.log("--- baseline: the legitimate six-record set must still pass ---");
probeAudit("legitimate six-record set (fixtures)", completeSet);
probeRecord("legitimate inbound", inboundEvidence);
probeRecord("legitimate outbound-answer", outboundAnswerEvidence);
probeRecord("legitimate outbound-no-answer", outboundNoAnswerEvidence);
probeRecord("legitimate owner-step-up-refused", ownerStepUpRefusedEvidence);

console.log("\n--- B1: waiver and mixed policy at the release audit ---");
probeRecord("waived inbound record (per-record validator)", waivedInbound);
probeAudit("round-1 mixed-policy set (waived inbound + passphrase_always refusal)", [
  waivedInbound, unauthorizedEvidence, outboundAnswerEvidence, outboundNoAnswerEvidence,
  { ...ownerStepUpRefusedEvidence, callerIdAttestation: "passed_a" }, failureEvidence,
]);
probeAudit("waived inbound substituted into an otherwise legitimate set", [
  waivedInbound, ...completeSet.slice(1),
]);
probeAudit("refusal record under waive_on_passed_a (policy disagreement)", [
  inboundEvidence, unauthorizedEvidence, outboundAnswerEvidence, outboundNoAnswerEvidence,
  { ...ownerStepUpRefusedEvidence, ownerCallerIdPolicy: "waive_on_passed_a" }, failureEvidence,
]);
probeAudit("whole owner path recorded under waive_on_passed_a", [
  { ...inboundEvidence, ownerCallerIdPolicy: "waive_on_passed_a" },
  unauthorizedEvidence,
  { ...outboundAnswerEvidence, ownerCallerIdPolicy: "waive_on_passed_a" },
  { ...outboundNoAnswerEvidence, ownerCallerIdPolicy: "waive_on_passed_a" },
  { ...ownerStepUpRefusedEvidence, ownerCallerIdPolicy: "waive_on_passed_a" },
  failureEvidence,
]);
probeAudit("seventh waiver-style record appended (7 records)", [...completeSet, waivedInbound]);
probeAudit("waiver record replaces the failure record (still 6)", [
  inboundEvidence, unauthorizedEvidence, outboundAnswerEvidence, outboundNoAnswerEvidence,
  ownerStepUpRefusedEvidence, { ...waivedInbound, correlationId: "01j0000000000000000000000h" },
]);
probeAudit("inbound refused outcome instead of verified", [
  { ...inboundEvidence, ownerStepUpOutcome: "refused", ownerAuthorityGranted: false },
  ...completeSet.slice(1),
]);

console.log("\n--- F1 rules: do records breaking them still validate? ---");
probeRecord("V03 outbound-answer attestation 'absent'", { ...outboundAnswerEvidence, callerIdAttestation: "absent" });
probeRecord("V03b outbound-answer attestation 'passed_a'", { ...outboundAnswerEvidence, callerIdAttestation: "passed_a" });
probeRecord("V11 refusal terminalState 'completed'", { ...ownerStepUpRefusedEvidence, terminalState: "completed" });
probeRecord("V12 refusal authenticatedTurns 1", { ...ownerStepUpRefusedEvidence, authenticatedTurns: 1 });
probeRecord("V22 no-answer promptCount 1", { ...outboundNoAnswerEvidence, ownerStepUpPromptCount: 1 });
probeRecord("V22b no-answer attemptCount 1", { ...outboundNoAnswerEvidence, ownerStepUpAttemptCount: 1 });
probeRecord("V25 schemaVersion 1.2 with 1.3 fields", { ...inboundEvidence, schemaVersion: "1.2" });

console.log("\n--- L-items ---");
probeRecord("L1 refusal prompts 4 with 1 reprompt (legitimate)", {
  ...ownerStepUpRefusedEvidence, ownerStepUpPromptCount: 4, ownerStepUpRepromptCount: 1,
});
probeRecord("L1b refusal prompts 5 with 2 reprompts (legitimate)", {
  ...ownerStepUpRefusedEvidence, ownerStepUpPromptCount: 5, ownerStepUpRepromptCount: 2,
});
probeRecord("L1c refusal reason deadline_expired", {
  ...ownerStepUpRefusedEvidence, ownerStepUpRejectionReason: "deadline_expired",
});
probeRecord("L1d refusal reason reprompts_exhausted", {
  ...ownerStepUpRefusedEvidence, ownerStepUpRejectionReason: "reprompts_exhausted",
});
probeRecord("L1e refusal prompts 3 with 1 reprompt (inconsistent)", {
  ...ownerStepUpRefusedEvidence, ownerStepUpRepromptCount: 1,
});
probeRecord("L2 verified prompts 1 attempts 3", {
  ...inboundEvidence, ownerStepUpPromptCount: 1, ownerStepUpAttemptCount: 3,
});
probeRecord("L2b verified prompts 5 attempts 1", {
  ...inboundEvidence, ownerStepUpPromptCount: 5, ownerStepUpAttemptCount: 1,
});
probeRecord("L2c verified prompts 3 attempts 1 (legitimate: 2 reprompts)", {
  ...inboundEvidence, ownerStepUpPromptCount: 3, ownerStepUpAttemptCount: 1,
});
probeRecord("L2d verified prompts 5 attempts 3 (legitimate max)", {
  ...inboundEvidence, ownerStepUpPromptCount: 5, ownerStepUpAttemptCount: 3,
});
probeAudit("L3 all six share one correlation ID", completeSet.map((r) => ({ ...r, correlationId: inboundEvidence.correlationId })));
probeAudit("L3b refusal reuses the inbound event ID", [
  inboundEvidence, unauthorizedEvidence, outboundAnswerEvidence, outboundNoAnswerEvidence,
  { ...ownerStepUpRefusedEvidence, eventIds: [inboundEvidence.eventIds[0]] }, failureEvidence,
]);
probeRecord("L4 refusal lasting 3 hours", {
  ...ownerStepUpRefusedEvidence, endedAt: "2026-08-29T16:00:00.000Z",
});
probeRecord("L4b refusal lasting 4m59s (legitimate slow call)", {
  ...ownerStepUpRefusedEvidence, endedAt: "2026-08-29T13:04:59.000Z",
});
probeRecord("L4c refusal lasting 5m01s", {
  ...ownerStepUpRefusedEvidence, endedAt: "2026-08-29T13:05:01.000Z",
});
probeAudit("L4d whole set dated 2099", completeSet.map((r) => ({
  ...r, startedAt: "2099-01-01T00:00:00.000Z", endedAt: "2099-01-01T00:01:00.000Z",
})));
probeAudit("L4e inbound 3h-long call at audit (no duration bound on inbound)", [
  { ...inboundEvidence, endedAt: "2026-08-29T15:00:00.000Z" }, ...completeSet.slice(1),
]);
probeRecord("L5 no-answer claiming refused", { ...outboundNoAnswerEvidence, ownerStepUpOutcome: "refused" });
probeRecord("L5b no-answer claiming waive_on_passed_a policy", {
  ...outboundNoAnswerEvidence, ownerCallerIdPolicy: "waive_on_passed_a",
});
probeRecord("L5c outbound waived_passed_a outcome", {
  ...outboundAnswerEvidence, ownerStepUpOutcome: "waived_passed_a",
  authenticationMode: "owner_attested_waiver", callerIdAttestation: "passed_a",
  ownerCallerIdPolicy: "waive_on_passed_a", ownerStepUpPromptCount: 0, ownerStepUpAttemptCount: 0,
});
probeRecord("L5d inbound attestation not_applicable", { ...inboundEvidence, callerIdAttestation: "not_applicable" });
probeRecord("L5e refusal attestation not_applicable", { ...ownerStepUpRefusedEvidence, callerIdAttestation: "not_applicable" });
probeRecord("L5f inbound not_started outcome", {
  ...inboundEvidence, ownerStepUpOutcome: "not_started", ownerAuthorityGranted: false,
});

console.log("\n--- clock skew and audit-time regressions ---");
const realish = completeSet.map((r) => ({ ...r }));
probeAudit("audit clock 1 second behind the last call's startedAt", realish,
  new Date(Date.parse(ownerStepUpRefusedEvidence.startedAt) - 1_000));
probeAudit("audit clock exactly at the last call's startedAt", realish,
  new Date(Date.parse(ownerStepUpRefusedEvidence.startedAt)));
probeAudit("invalid audit time", completeSet, new Date("nonsense"));

// Given a survivor mutation's name, try the record/set that guard was the only thing blocking.
// ACCEPTED means the guard is load-bearing and unpinned; REJECTED means another checked path implies it.
import { validateEvidence, auditVoiceEvidence } from "./voice-smoke.ts";
import {
  inboundEvidence, unauthorizedEvidence, outboundAnswerEvidence, outboundNoAnswerEvidence,
  ownerStepUpRefusedEvidence, failureEvidence, AUDIT_TIME, completeSet,
} from "./fixtures.mjs";

const waivedInbound = {
  ...inboundEvidence,
  authenticationMode: "owner_attested_waiver",
  ownerStepUpOutcome: "waived_passed_a",
  ownerStepUpPromptCount: 0,
  ownerStepUpAttemptCount: 0,
  callerIdAttestation: "passed_a",
  ownerCallerIdPolicy: "waive_on_passed_a",
};

const RECORD_CASES = {
  "V04-waiver-inbound-only": {
    label: "outbound-answer claiming the Passed-A waiver",
    record: {
      ...outboundAnswerEvidence,
      ownerStepUpOutcome: "waived_passed_a",
      authenticationMode: "owner_attested_waiver",
      callerIdAttestation: "passed_a",
      ownerCallerIdPolicy: "waive_on_passed_a",
      ownerStepUpPromptCount: 0,
      ownerStepUpAttemptCount: 0,
    },
  },
  "V05-waiver-needs-authority": {
    label: "waived inbound with no owner authority granted",
    record: { ...waivedInbound, ownerAuthorityGranted: false },
  },
  "V08-verified-prompt-min-1": {
    label: "verified inbound with zero prompts and one attempt",
    record: { ...inboundEvidence, ownerStepUpPromptCount: 0, ownerStepUpAttemptCount: 1 },
  },
  "V13-refused-outcome-verified": {
    label: "refusal record claiming outcome verified",
    record: { ...ownerStepUpRefusedEvidence, ownerStepUpOutcome: "verified" },
  },
  "V13-refused-outcome-not-started": {
    label: "refusal record claiming outcome not_started",
    record: { ...ownerStepUpRefusedEvidence, ownerStepUpOutcome: "not_started" },
  },
  "V13-refused-outcome-waived": {
    label: "refusal record claiming outcome waived_passed_a",
    record: {
      ...ownerStepUpRefusedEvidence, ownerStepUpOutcome: "waived_passed_a",
      authenticationMode: "owner_attested_waiver", callerIdAttestation: "passed_a",
      ownerCallerIdPolicy: "waive_on_passed_a",
    },
  },
  "V22-no-answer-zero-prompts": {
    label: "outbound no-answer with two step-up prompts and attempts",
    record: { ...outboundNoAnswerEvidence, ownerStepUpPromptCount: 2, ownerStepUpAttemptCount: 2 },
  },
  "N-inbound-attestation-not-applicable": {
    label: "inbound record using the outbound-only not_applicable attestation",
    record: { ...inboundEvidence, callerIdAttestation: "not_applicable" },
  },
  "N-not-started-no-authority": {
    label: "ANSWERED outbound call granted owner authority with outcome not_started and zero step-up",
    record: {
      ...outboundAnswerEvidence,
      ownerStepUpOutcome: "not_started",
      ownerStepUpPromptCount: 0,
      ownerStepUpAttemptCount: 0,
    },
  },
  "N-not-started-outbound-only": {
    label: "inbound refusal record claiming not_started",
    record: { ...ownerStepUpRefusedEvidence, ownerStepUpOutcome: "not_started" },
  },
  "N-not-started-policy": {
    label: "outbound no-answer claiming the waiver policy",
    record: { ...outboundNoAnswerEvidence, ownerCallerIdPolicy: "waive_on_passed_a" },
  },
  "N-not-started-zero-counts": {
    label: "outbound no-answer with one prompt",
    record: { ...outboundNoAnswerEvidence, ownerStepUpPromptCount: 1 },
  },
};

const duplicateAndMissing = [
  inboundEvidence,
  { ...inboundEvidence, correlationId: "01j0000000000000000000000e", eventIds: ["01j0000000000000000000000f"],
    conversationTurnResult: { ...inboundEvidence.conversationTurnResult,
      committedUserEventId: "01j0000000000000000000000f", sentAssistantEventId: "01j0000000000000000000000f" } },
  unauthorizedEvidence, outboundAnswerEvidence, outboundNoAnswerEvidence, failureEvidence,
];

const AUDIT_CASES = {
  "A-audit-inbound-verified": {
    label: "release set whose inbound record is a Passed-A waiver",
    records: [waivedInbound, ...completeSet.slice(1)], time: AUDIT_TIME,
  },
  "A-audit-finite-audit-time": {
    label: "release set audited with an invalid audit time and a 2099 record",
    records: completeSet.map((r) => ({ ...r, startedAt: "2099-01-01T00:00:00.000Z", endedAt: "2099-01-01T00:01:00.000Z" })),
    time: new Date("nonsense"),
  },
  "A-audit-per-scenario-loop": {
    label: "six records covering only five scenarios (duplicate plus missing)",
    records: duplicateAndMissing, time: AUDIT_TIME,
  },
  "A-audit-scenario-set-size": {
    label: "six records covering only five scenarios (duplicate plus missing)",
    records: duplicateAndMissing, time: AUDIT_TIME,
  },
};

const name = process.argv[2];
if (Object.hasOwn(RECORD_CASES, name)) {
  const { label, record } = RECORD_CASES[name];
  try {
    validateEvidence(record);
    console.log(`ACCEPTED  ${label}`);
  } catch (error) {
    console.log(`REJECTED  ${label}  (${error.message})`);
  }
} else if (Object.hasOwn(AUDIT_CASES, name)) {
  const { label, records, time } = AUDIT_CASES[name];
  try {
    auditVoiceEvidence(records, time);
    console.log(`ACCEPTED  ${label}`);
  } catch (error) {
    console.log(`REJECTED  ${label}  (${error.message})`);
  }
} else {
  console.log(`no case named ${name}`);
  process.exitCode = 1;
}

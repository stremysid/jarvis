import { describe, expect, it } from "vitest";
import type {
  ConversationFailureCategory,
  ConversationFailureCode,
  ConversationTurnResult,
} from "../../../apps/cloud-gateway/src/conversation/conversation-types.js";
import {
  LIVE_VOICE_SMOKE_CONFIRMATION,
  auditVoiceEvidence,
  cleanupVoiceEvidence,
  formatRunResult,
  parseSmokeArguments,
  runVoiceSmoke,
  validateEvidence,
  type EvidenceStore,
  type VoiceSmokeDriver,
} from "./voice-smoke.js";

const inboundConversationTurn = {
  outcome: "voice_sent",
  committedUserEventId: "01j00000000000000000000001",
  sentAssistantEventId: "01j00000000000000000000004",
  deliveryId: null,
  deliveredAssistantEventId: null,
} as const satisfies ConversationTurnResult;

const inboundEvidence = {
  schemaVersion: "1.3",
  generatorVersion: "0.1.0",
  status: "passed",
  scenario: "inbound",
  manifestKey: "inbound_call",
  commitSha: "a".repeat(40),
  correlationId: "01j00000000000000000000000",
  startedAt: "2026-08-29T12:00:00.000Z",
  endedAt: "2026-08-29T12:01:00.000Z",
  terminalState: "completed",
  eventIds: [inboundConversationTurn.committedUserEventId, inboundConversationTurn.sentAssistantEventId],
  authenticatedTurns: 20,
  authenticationMode: "owner_passphrase",
  ownerStepUpOutcome: "verified",
  ownerStepUpPromptCount: 1,
  ownerStepUpAttemptCount: 1,
  callerIdAttestation: "passed_a",
  ownerCallerIdPolicy: "passphrase_always",
  ownerAuthorityGranted: true,
  ownerStepUpBeforeFirstModelTurn: true,
  interruptions: 1,
  firstAudibleMs: Array<number>(20).fill(3_000),
  interruptionStopMs: [900],
  persistenceVerified: true,
  recallVerified: true,
  cleanHangup: true,
  sttProvider: "Deepgram",
  sttModel: "nova-3-general",
  ttsProvider: "Google",
  ttsVoice: "en-US-Journey-O",
  signedWssHandshake: "exact-configured-url",
  dtmfDelivery: "verified",
  statusCallbackSchema: "verified",
  relayEndedCallbackSchema: "verified",
  assistantOutputEvidence: "sent_to_provider_only",
  assistantHistoryCommitted: false,
  conversationTurnResult: inboundConversationTurn,
} as const;

const commonEvidence = {
  schemaVersion: "1.3",
  generatorVersion: "0.1.0",
  status: "passed",
  commitSha: "a".repeat(40),
  correlationId: "01j00000000000000000000002",
  startedAt: "2026-08-29T13:00:00.000Z",
  endedAt: "2026-08-29T13:01:00.000Z",
  eventIds: ["01j00000000000000000000003"],
} as const;

const unauthorizedEvidence = {
  ...commonEvidence,
  scenario: "unauthorized-caller",
  manifestKey: "unauthorized_caller",
  terminalState: "rejected",
  authenticatedTurns: 0,
  authenticationAttempts: 0,
  conversationRelaySessions: 0,
  pinPromptCount: 0,
  pinAttemptCount: 0,
  modelRequests: 0,
  personalContextReads: 0,
} as const;

const outboundAnswerEvidence = {
  ...commonEvidence,
  scenario: "outbound-answer",
  manifestKey: "outbound_answer",
  terminalState: "completed",
  authenticatedTurns: 1,
  authenticationMode: "owner_passphrase",
  ownerStepUpOutcome: "verified",
  ownerStepUpPromptCount: 1,
  ownerStepUpAttemptCount: 1,
  callerIdAttestation: "absent",
  ownerCallerIdPolicy: "waive_on_passed_a",
  ownerAuthorityGranted: true,
  ownerStepUpBeforeFirstModelTurn: true,
  recipientAuthenticated: true,
  neutralGreetingBeforeAuthentication: true,
  purposeDisclosedAfterAuthentication: true,
  sttProvider: "Deepgram",
  sttModel: "nova-3-general",
  ttsProvider: "Google",
  ttsVoice: "en-US-Journey-O",
  signedWssHandshake: "exact-configured-url",
  dtmfDelivery: "verified",
  statusCallbackSchema: "verified",
  relayEndedCallbackSchema: "verified",
  assistantOutputEvidence: "sent_to_provider_only",
  assistantHistoryCommitted: false,
  eventIds: [...commonEvidence.eventIds, "01j00000000000000000000005"],
  conversationTurnResult: {
    outcome: "voice_sent",
    committedUserEventId: commonEvidence.eventIds[0],
    sentAssistantEventId: "01j00000000000000000000005",
    deliveryId: null,
    deliveredAssistantEventId: null,
  } as const satisfies ConversationTurnResult,
} as const;

const outboundNoAnswerEvidence = {
  ...commonEvidence,
  scenario: "outbound-no-answer",
  manifestKey: "outbound_no_answer",
  terminalState: "no-answer",
  authenticationMode: "owner_passphrase",
  ownerStepUpOutcome: "refused",
  ownerStepUpPromptCount: 0,
  ownerStepUpAttemptCount: 0,
  callerIdAttestation: "absent",
  ownerCallerIdPolicy: "passphrase_always",
  ownerAuthorityGranted: false,
  callAttempts: 1,
  recipientAuthenticated: false,
  purposeDisclosed: false,
  privateMessageLeft: false,
  modelRequests: 0,
  personalContextReads: 0,
  statusCallbackSchema: "verified",
} as const;

const ownerStepUpRefusedEvidence = {
  ...commonEvidence,
  scenario: "owner-step-up-refused",
  manifestKey: "owner_step_up_refused",
  correlationId: "01j00000000000000000000006",
  terminalState: "rejected",
  eventIds: ["01j00000000000000000000007"],
  authenticatedTurns: 0,
  authenticationMode: "owner_passphrase",
  ownerStepUpOutcome: "refused",
  ownerStepUpPromptCount: 3,
  ownerStepUpAttemptCount: 3,
  callerIdAttestation: "other",
  ownerCallerIdPolicy: "waive_on_passed_a",
  ownerAuthorityGranted: false,
  modelRequests: 0,
  personalContextReads: 0,
  fixedRefusalSentToProvider: true,
  cleanEndFrameSent: true,
  rejectionRowCount: 1,
  ownerAlertCount: 1,
} as const;

const failureEvidence = {
  ...commonEvidence,
  scenario: "failure-callbacks",
  manifestKey: "voice_failure_callbacks",
  terminalState: "failed",
  modelFailureHandled: true,
  websocketFailureHandled: true,
  callbackFailureHandled: true,
  unauthorizedCallbackCreated: false,
  statusCallbackSchema: "verified",
  relayEndedCallbackSchema: "verified",
  safeErrorCategories: ["model_unavailable", "relay_closed", "callback_rejected"],
  conversationTurnResult: {
    outcome: "failed",
    committedUserEventId: commonEvidence.eventIds[0],
    sentAssistantEventId: null,
    deliveryId: null,
    deliveredAssistantEventId: null,
  } as const satisfies ConversationTurnResult,
  modelFailureCode: "model_failed" as const satisfies ConversationFailureCode,
  modelFailureCategory: "provider" as const satisfies ConversationFailureCategory,
} as const;

const OWNER_STEP_UP_FIELDS = [
  "ownerStepUpOutcome",
  "ownerStepUpPromptCount",
  "ownerStepUpAttemptCount",
  "callerIdAttestation",
  "ownerCallerIdPolicy",
  "ownerAuthorityGranted",
  "ownerStepUpBeforeFirstModelTurn",
] as const;

function legacyOwnerEvidence(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const legacy = { ...value };
  for (const field of OWNER_STEP_UP_FIELDS) delete legacy[field];
  return {
    ...legacy,
    schemaVersion: "1.2",
    authenticationMode: "owner_identity_pin_free",
    pinPromptCount: 0,
    pinAttemptCount: 0,
  };
}

function legacyOutboundNoAnswerEvidence(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const legacy = { ...value };
  for (const field of OWNER_STEP_UP_FIELDS) delete legacy[field];
  delete legacy.authenticationMode;
  delete legacy.modelRequests;
  delete legacy.personalContextReads;
  return { ...legacy, schemaVersion: "1.2" };
}

describe("validateEvidence", () => {
  it("accepts a complete redacted inbound release sample", () => {
    expect(validateEvidence(inboundEvidence)).toBe(true);
  });

  it("rejects provider identifiers and transcript or authentication fields", () => {
    for (const unsafe of [
      { ...inboundEvidence, callSid: "synthetic-provider-id" },
      { ...inboundEvidence, transcript: "synthetic-text" },
      { ...inboundEvidence, pin: "synthetic-auth-input" },
      { ...inboundEvidence, guestPin: "0000" },
      { ...inboundEvidence, livePin: "0000" },
      { ...inboundEvidence, accessId: "access:synthetic" },
      { ...inboundEvidence, accessGrantId: "access-grant:synthetic" },
      { ...inboundEvidence, phoneNumber: "+15555550123" },
      { ...inboundEvidence, from: "+15555550123" },
      { ...inboundEvidence, to: "+15555550124" },
      { ...inboundEvidence, authorization: "synthetic-auth" },
    ]) {
      expect(() => validateEvidence(unsafe)).toThrow(/^unsafe_or_incomplete_evidence$/u);
    }
  });

  it("rejects an inbound sample whose p95 first-audible latency exceeds 4000 ms", () => {
    const slow = {
      ...inboundEvidence,
      firstAudibleMs: [...Array<number>(18).fill(3_000), 4_001, 4_001],
    };

    expect(() => validateEvidence(slow)).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("accepts unauthorized-caller evidence only when no auth, model, or context traffic occurred", () => {
    expect(validateEvidence(unauthorizedEvidence)).toBe(true);
    expect(() => validateEvidence({ ...unauthorizedEvidence, modelRequests: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...unauthorizedEvidence, conversationRelaySessions: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...unauthorizedEvidence, pinPromptCount: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...unauthorizedEvidence, pinAttemptCount: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("accepts an authenticated outbound-answer contract with conservative playback evidence", () => {
    expect(validateEvidence(outboundAnswerEvidence)).toBe(true);
    expect(() => validateEvidence({ ...outboundAnswerEvidence, assistantHistoryCommitted: true })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("requires a verified owner step-up before inbound and outbound authority", () => {
    for (const evidence of [inboundEvidence, outboundAnswerEvidence]) {
      expect(validateEvidence(evidence)).toBe(true);
      expect(() => validateEvidence({ ...evidence, ownerStepUpOutcome: "refused" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
      expect(() => validateEvidence({ ...evidence, ownerAuthorityGranted: false })).toThrow(/^unsafe_or_incomplete_evidence$/u);
      expect(() => validateEvidence({ ...evidence, ownerStepUpBeforeFirstModelTurn: false })).toThrow(/^unsafe_or_incomplete_evidence$/u);
      expect(() => validateEvidence({ ...evidence, authenticationMode: "owner_identity_pin_free" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
      expect(() => validateEvidence({ ...evidence, ownerStepUpPromptCount: 0 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
      expect(() => validateEvidence({ ...evidence, ownerStepUpAttemptCount: 0 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    }
    expect(validateEvidence({ ...inboundEvidence, ownerStepUpPromptCount: 2, ownerStepUpAttemptCount: 2 })).toBe(true);
  });

  it("accepts only the explicit inbound Passed-A waiver while its policy is on", () => {
    const waived = {
      ...inboundEvidence,
      authenticationMode: "owner_attested_waiver",
      ownerStepUpOutcome: "waived_passed_a",
      ownerStepUpPromptCount: 0,
      ownerStepUpAttemptCount: 0,
      callerIdAttestation: "passed_a",
      ownerCallerIdPolicy: "waive_on_passed_a",
    };

    expect(validateEvidence(waived)).toBe(true);
    expect(() => validateEvidence({ ...waived, ownerCallerIdPolicy: "passphrase_always" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...waived, callerIdAttestation: "other" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...waived, authenticationMode: "owner_passphrase" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...waived, ownerStepUpPromptCount: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...waived, ownerStepUpAttemptCount: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...inboundEvidence, ownerCallerIdPolicy: "waive_on_passed_a" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({
      ...outboundAnswerEvidence,
      authenticationMode: "owner_attested_waiver",
      ownerStepUpOutcome: "waived_passed_a",
      ownerStepUpPromptCount: 0,
      ownerStepUpAttemptCount: 0,
      callerIdAttestation: "passed_a",
    })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("rejects the retired 1.2 PIN-free owner contract", () => {
    expect(() => validateEvidence(legacyOwnerEvidence(inboundEvidence))).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("requires Task 5 voice_sent evidence without inventing delivery acknowledgement", () => {
    expect(validateEvidence(inboundEvidence)).toBe(true);
    expect(() => validateEvidence({
      ...inboundEvidence,
      conversationTurnResult: {
        ...inboundEvidence.conversationTurnResult,
        outcome: "telegram_delivered",
      },
    })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({
      ...inboundEvidence,
      conversationTurnResult: {
        ...inboundEvidence.conversationTurnResult,
        deliveredAssistantEventId: "01j00000000000000000000006",
      },
    })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("accepts a private outbound no-answer result and rejects purpose disclosure", () => {
    expect(validateEvidence(outboundNoAnswerEvidence)).toBe(true);
    expect(() => validateEvidence({ ...outboundNoAnswerEvidence, purposeDisclosed: true })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...outboundNoAnswerEvidence, ownerStepUpOutcome: "verified" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...outboundNoAnswerEvidence, ownerAuthorityGranted: true })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...outboundNoAnswerEvidence, modelRequests: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...outboundNoAnswerEvidence, personalContextReads: 1 })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("requires the fixed refusal, clean end, rejection row, and one alert for refused owner step-up", () => {
    expect(validateEvidence(ownerStepUpRefusedEvidence)).toBe(true);
    for (const unsafe of [
      { ...ownerStepUpRefusedEvidence, ownerStepUpPromptCount: 2 },
      { ...ownerStepUpRefusedEvidence, ownerStepUpAttemptCount: 2 },
      { ...ownerStepUpRefusedEvidence, authenticationMode: "owner_attested_waiver" },
      { ...ownerStepUpRefusedEvidence, ownerAuthorityGranted: true },
      { ...ownerStepUpRefusedEvidence, fixedRefusalSentToProvider: false },
      { ...ownerStepUpRefusedEvidence, cleanEndFrameSent: false },
      { ...ownerStepUpRefusedEvidence, rejectionRowCount: 0 },
      { ...ownerStepUpRefusedEvidence, rejectionRowCount: 2 },
      { ...ownerStepUpRefusedEvidence, ownerAlertCount: 0 },
      { ...ownerStepUpRefusedEvidence, ownerAlertCount: 2 },
      { ...ownerStepUpRefusedEvidence, modelRequests: 1 },
      { ...ownerStepUpRefusedEvidence, personalContextReads: 1 },
      {
        ...ownerStepUpRefusedEvidence,
        callerIdAttestation: "passed_a",
        ownerCallerIdPolicy: "waive_on_passed_a",
      },
    ]) expect(() => validateEvidence(unsafe)).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("accepts safe failure evidence only when no new callback was authorized", () => {
    expect(validateEvidence(failureEvidence)).toBe(true);
    expect(() => validateEvidence({ ...failureEvidence, unauthorizedCallbackCreated: true })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...failureEvidence, modelFailureCode: "model_outcome_unknown" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence({ ...failureEvidence, modelFailureCategory: "ambiguous" })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("normalizes accessor and proxy failures to the public evidence error", () => {
    const accessor = { ...inboundEvidence } as Record<string, unknown>;
    Object.defineProperty(accessor, "commitSha", { enumerable: true, get: () => { throw new Error("sensitive"); } });
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("sensitive"); } });

    expect(() => validateEvidence(accessor)).toThrow(/^unsafe_or_incomplete_evidence$/u);
    expect(() => validateEvidence(hostile)).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });
});

class MemoryEvidenceStore implements EvidenceStore {
  readonly files = new Map<string, string>();
  failCommit = false;

  async exists(name: string): Promise<boolean> {
    return this.files.has(name);
  }

  async writeTemporary(name: string, contents: string): Promise<void> {
    this.files.set(name, contents);
  }

  async commitTemporary(temporaryName: string, finalName: string): Promise<void> {
    if (this.failCommit) throw new Error("sensitive storage detail");
    const contents = this.files.get(temporaryName);
    if (contents === undefined) throw new Error("missing temporary file");
    this.files.set(finalName, contents);
    this.files.delete(temporaryName);
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
}

const completeGate = {
  executeLive: true,
  confirmation: LIVE_VOICE_SMOKE_CONFIRMATION ?? "I_AUTHORIZE_PAID_VOICE_SMOKE",
  doctorExitCode: 0,
  configuration: {
    JARVIS_CLOUD_BASE_URL: "synthetic-present",
    JARVIS_DEVICE_ID: "synthetic-present",
    JARVIS_DEVICE_KEY_PATH: "synthetic-present",
    JARVIS_PRINCIPAL_ID: "synthetic-present",
    OWNER_VOICE_IDENTITY_ID: "synthetic-owner-identity",
  },
  secretPresence: {
    DEEPSEEK_API_KEY: true,
    GUEST_PIN_PEPPER_V1: true,
    OWNER_PASSPHRASE_PEPPER_V1: true,
    TWILIO_ACCOUNT_SID: true,
    TWILIO_API_KEY_SECRET: true,
    TWILIO_API_KEY_SID: true,
    TWILIO_AUTH_TOKEN: true,
  },
} as const;

describe("runVoiceSmoke", () => {
  it("skips by default without calling a live driver or writing evidence", async () => {
    const store = new MemoryEvidenceStore();
    const result = await runVoiceSmoke({ ...completeGate, executeLive: false, scenario: "inbound" }, {
      driver: { run: async () => { throw new Error("live driver must not run"); } },
      store,
    });

    expect(result).toEqual({ status: "skipped", reason: "live_execution_not_authorized" });
    expect([...store.files]).toEqual([]);
  });

  it("reports missing configuration and secret names without returning their values", async () => {
    const store = new MemoryEvidenceStore();
    const result = await runVoiceSmoke({
      ...completeGate,
      scenario: "inbound",
      configuration: { JARVIS_CLOUD_BASE_URL: "synthetic-present" },
      secretPresence: { TWILIO_ACCOUNT_SID: true },
    }, {
      driver: { run: async () => { throw new Error("live driver must not run"); } },
      store,
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "missing_required_prerequisites",
      missingConfiguration: ["JARVIS_DEVICE_ID", "JARVIS_DEVICE_KEY_PATH", "JARVIS_PRINCIPAL_ID", "OWNER_VOICE_IDENTITY_ID"],
      missingSecrets: ["DEEPSEEK_API_KEY", "GUEST_PIN_PEPPER_V1", "OWNER_PASSPHRASE_PEPPER_V1", "TWILIO_API_KEY_SECRET", "TWILIO_API_KEY_SID", "TWILIO_AUTH_TOKEN"],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-present");
    expect(JSON.stringify(result)).not.toContain("PIN_VERIFIER_JSON");
    expect(JSON.stringify(result)).not.toContain("DEFAULT_GUEST_PIN");
    expect([...store.files]).toEqual([]);
  });

  it("requires only the owner identity configuration name without interpreting or returning its value", async () => {
    const store = new MemoryEvidenceStore();
    const opaqueOwnerIdentity = Object.freeze({ marker: "synthetic-owner-value-must-not-return" });
    const result = await runVoiceSmoke({
      ...completeGate,
      scenario: "inbound",
      configuration: { ...completeGate.configuration, OWNER_VOICE_IDENTITY_ID: opaqueOwnerIdentity },
    }, { store });

    expect(result).toEqual({ status: "blocked", reason: "live_driver_unavailable" });
    expect(JSON.stringify(result)).not.toContain(opaqueOwnerIdentity.marker);
    expect([...store.files]).toEqual([]);
  });

  it("persists validated fake evidence atomically after every live gate passes", async () => {
    const store = new MemoryEvidenceStore();
    const result = await runVoiceSmoke({ ...completeGate, scenario: "inbound" }, {
      driver: { run: async () => inboundEvidence },
      store,
    });

    expect(result).toEqual({
      status: "passed",
      evidencePath: "tests/acceptance/live/evidence/inbound.json",
    });
    expect([...store.files.keys()]).toEqual(["inbound.json"]);
    expect(JSON.parse(store.files.get("inbound.json") ?? "null")).toEqual(inboundEvidence);
  });

  it("refuses before invoking the paid driver when scenario evidence is already retained", async () => {
    const store = new MemoryEvidenceStore();
    store.files.set("inbound.json", "retained\n");
    let executions = 0;

    const result = await runVoiceSmoke({ ...completeGate, scenario: "inbound" }, {
      driver: {
        run: async () => {
          executions += 1;
          return inboundEvidence;
        },
      },
      store,
    });

    expect(result).toEqual({ status: "blocked", reason: "evidence_already_retained" });
    expect(executions).toBe(0);
    expect([...store.files]).toEqual([["inbound.json", "retained\n"]]);
  });

  it("reports an unavailable evidence store without invoking the paid driver when the existence check fails", async () => {
    let executions = 0;
    const store: EvidenceStore = {
      exists: async () => { throw new Error("private storage failure"); },
      writeTemporary: async () => undefined,
      commitTemporary: async () => undefined,
      remove: async () => undefined,
    };

    const result = await runVoiceSmoke({ ...completeGate, scenario: "inbound" }, {
      driver: {
        run: async () => {
          executions += 1;
          return inboundEvidence;
        },
      },
      store,
    });

    expect(result).toEqual({ status: "blocked", reason: "evidence_store_unavailable" });
    expect(executions).toBe(0);
  });

  it("removes its temporary evidence and normalizes commit failures", async () => {
    const store = new MemoryEvidenceStore();
    store.failCommit = true;

    await expect(runVoiceSmoke({ ...completeGate, scenario: "inbound" }, {
      driver: { run: async () => inboundEvidence },
      store,
    })).rejects.toThrow(/^evidence_write_failed$/u);
    expect([...store.files]).toEqual([]);
  });

  it("blocks an explicitly requested run when no live driver is installed", async () => {
    const store = new MemoryEvidenceStore();
    const result = await runVoiceSmoke({ ...completeGate, scenario: "inbound" }, { store });

    expect(result).toEqual({ status: "blocked", reason: "live_driver_unavailable" });
    expect([...store.files]).toEqual([]);
  });
});

describe("offline evidence lifecycle", () => {
  it("accepts exactly one validated passed record for every blocking voice scenario", () => {
    expect(auditVoiceEvidence([
      inboundEvidence,
      unauthorizedEvidence,
      outboundAnswerEvidence,
      outboundNoAnswerEvidence,
      ownerStepUpRefusedEvidence,
      failureEvidence,
    ])).toBe(true);
  });

  it("rejects the complete former five-record PIN-free release set", () => {
    expect(() => auditVoiceEvidence([
      legacyOwnerEvidence(inboundEvidence),
      { ...unauthorizedEvidence, schemaVersion: "1.2" },
      legacyOwnerEvidence(outboundAnswerEvidence),
      legacyOutboundNoAnswerEvidence(outboundNoAnswerEvidence),
      { ...failureEvidence, schemaVersion: "1.2" },
    ])).toThrow(/^release_voice_evidence_incomplete$/u);
  });

  it("rejects a release audit with missing or duplicate scenario evidence", () => {
    expect(() => auditVoiceEvidence([
      inboundEvidence,
      unauthorizedEvidence,
      outboundAnswerEvidence,
      outboundNoAnswerEvidence,
      failureEvidence,
    ])).toThrow(/^release_voice_evidence_incomplete$/u);
    expect(() => auditVoiceEvidence([
      inboundEvidence,
      inboundEvidence,
      unauthorizedEvidence,
      outboundAnswerEvidence,
      outboundNoAnswerEvidence,
      ownerStepUpRefusedEvidence,
      failureEvidence,
    ])).toThrow(/^release_voice_evidence_incomplete$/u);
    expect(() => auditVoiceEvidence([
      inboundEvidence,
      inboundEvidence,
      unauthorizedEvidence,
      outboundAnswerEvidence,
      outboundNoAnswerEvidence,
      failureEvidence,
    ])).toThrow(/^release_voice_evidence_incomplete$/u);
  });

  it("rejects a release audit whose scenarios come from different commits", () => {
    expect(() => auditVoiceEvidence([
      inboundEvidence,
      unauthorizedEvidence,
      outboundAnswerEvidence,
      outboundNoAnswerEvidence,
      ownerStepUpRefusedEvidence,
      { ...failureEvidence, commitSha: "b".repeat(40) },
    ])).toThrow(/^release_voice_evidence_incomplete$/u);
  });

  it("cleanup removes only the six generated final evidence names", async () => {
    const store = new MemoryEvidenceStore();
    for (const name of [
      "inbound.json",
      "unauthorized-caller.json",
      "outbound-answer.json",
      "outbound-no-answer.json",
      "owner-step-up-refused.json",
      "failure-callbacks.json",
      "operator-notes.txt",
    ]) store.files.set(name, "synthetic");

    await cleanupVoiceEvidence(store);

    expect([...store.files]).toEqual([["operator-notes.txt", "synthetic"]]);
  });
});

describe("safe command contract", () => {
  it("passes an injected live driver, evidence store, doctor result, and boolean secret presence into the gate", async () => {
    const cli = await import("./voice-smoke-cli.mjs");
    const store = new MemoryEvidenceStore();
    const driver: VoiceSmokeDriver = { run: async () => inboundEvidence };
    const stdout: string[] = [];
    const gateDependencies: unknown[] = [];
    const gateInputs: unknown[] = [];

    const exitCode = await cli.runSmokeCommand([
      "--scenario", "inbound", "--execute-live", "--confirm-live", LIVE_VOICE_SMOKE_CONFIRMATION,
    ], {
      environment: completeGate.configuration,
      secretPresence: completeGate.secretPresence,
      doctorExitCode: 0,
      driver,
      store,
      runGate: async (input: unknown, dependencies: unknown) => {
        gateInputs.push(input);
        gateDependencies.push(dependencies);
        return runVoiceSmoke(input as typeof completeGate & { scenario: "inbound" }, dependencies as { driver: VoiceSmokeDriver; store: EvidenceStore });
      },
      writeStdout: (value: string) => { stdout.push(value); },
    });

    expect(exitCode).toBe(0);
    expect(gateInputs).toEqual([{
      ...completeGate,
      scenario: "inbound",
      configuration: { ...completeGate.configuration, OWNER_VOICE_IDENTITY_ID: true },
    }]);
    expect(gateDependencies).toEqual([{ driver, store }]);
    expect(stdout).toEqual(['{"status":"passed","evidencePath":"tests/acceptance/live/evidence/inbound.json"}\n']);
    expect([...store.files.keys()]).toEqual(["inbound.json"]);
  });

  it("reports a live-driver failure distinctly without emitting the adapter's private error", async () => {
    const cli = await import("./voice-smoke-cli.mjs");
    const privateMessage = "private provider response and account identifier";
    const stdout: string[] = [];

    const exitCode = await cli.runSmokeCommand([
      "--scenario", "inbound", "--execute-live", "--confirm-live", LIVE_VOICE_SMOKE_CONFIRMATION,
    ], {
      environment: completeGate.configuration,
      secretPresence: completeGate.secretPresence,
      doctorExitCode: 0,
      driver: { run: async () => { throw new Error(privateMessage); } },
      store: new MemoryEvidenceStore(),
      writeStdout: (value: string) => { stdout.push(value); },
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual(['{"status":"blocked","reason":"live_smoke_failed"}\n']);
    expect(stdout.join("")).not.toContain(privateMessage);
  });

  it("reports local evidence persistence failure distinctly from invalid arguments", async () => {
    const cli = await import("./voice-smoke-cli.mjs");
    const store = new MemoryEvidenceStore();
    store.failCommit = true;
    const stdout: string[] = [];

    const exitCode = await cli.runSmokeCommand([
      "--scenario", "inbound", "--execute-live", "--confirm-live", LIVE_VOICE_SMOKE_CONFIRMATION,
    ], {
      environment: completeGate.configuration,
      secretPresence: completeGate.secretPresence,
      doctorExitCode: 0,
      driver: { run: async () => inboundEvidence },
      store,
      writeStdout: (value: string) => { stdout.push(value); },
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual(['{"status":"blocked","reason":"evidence_write_failed"}\n']);
  });

  it("passes only an owner presence sentinel to the gate and never emits the raw identity", async () => {
    const priorExitCode = process.exitCode;
    const priorStderrWrite = process.stderr.write;
    process.exitCode = undefined;
    try {
      const cli = await import("./voice-smoke-cli.mjs");
      const rawOwnerIdentity = "synthetic-owner-identity-must-never-cross-cli-boundary";
      const stdout: string[] = [];
      const stderr: string[] = [];
      process.stderr.write = ((value: unknown) => {
        stderr.push(String(value));
        return true;
      }) as typeof process.stderr.write;
      const gateInputs: unknown[] = [];
      const environment = {
        JARVIS_CLOUD_BASE_URL: "synthetic-cloud-url",
        JARVIS_DEVICE_ID: "synthetic-device-id",
        JARVIS_DEVICE_KEY_PATH: "synthetic-device-key-path",
        JARVIS_PRINCIPAL_ID: "synthetic-principal-id",
        OWNER_VOICE_IDENTITY_ID: rawOwnerIdentity,
      };

      const exitCode = await cli.runSmokeCommand(["--scenario", "inbound"], {
        environment,
        runGate: async (input: unknown) => {
          gateInputs.push(input);
          throw new Error(`private failure: ${rawOwnerIdentity}`);
        },
        writeStdout: (value: string) => { stdout.push(value); },
      });

      expect(exitCode).toBe(2);
      expect(gateInputs).toEqual([{
        scenario: "inbound",
        executeLive: false,
        configuration: {
          JARVIS_CLOUD_BASE_URL: "synthetic-cloud-url",
          JARVIS_DEVICE_ID: "synthetic-device-id",
          JARVIS_DEVICE_KEY_PATH: "synthetic-device-key-path",
          JARVIS_PRINCIPAL_ID: "synthetic-principal-id",
          OWNER_VOICE_IDENTITY_ID: true,
        },
        secretPresence: {},
      }]);
      expect(stdout).toEqual(['{"status":"blocked","reason":"invalid_smoke_arguments"}\n']);
      expect(stderr).toEqual([]);
      expect(JSON.stringify({ gateInputs, stdout, stderr })).not.toContain(rawOwnerIdentity);
    } finally {
      process.stderr.write = priorStderrWrite;
      process.exitCode = priorExitCode;
    }
  });

  it("parses a developer smoke as non-live by default", () => {
    expect(parseSmokeArguments(["--scenario", "inbound"])).toEqual({
      scenario: "inbound",
      executeLive: false,
    });
    expect(parseSmokeArguments(["--", "--scenario", "inbound"])).toEqual({
      scenario: "inbound",
      executeLive: false,
    });
    expect(parseSmokeArguments(["--scenario", "owner-step-up-refused"])).toEqual({
      scenario: "owner-step-up-refused",
      executeLive: false,
    });
  });

  it("requires an exact scenario and rejects unknown or duplicate flags", () => {
    for (const arguments_ of [
      [],
      ["--scenario", "other"],
      ["--scenario", "inbound", "--unknown"],
      ["--scenario", "inbound", "--scenario", "outbound-answer"],
    ]) expect(() => parseSmokeArguments(arguments_)).toThrow(/^invalid_smoke_arguments$/u);
  });

  it("parses explicit live execution and confirmation without exposing configuration", () => {
    expect(parseSmokeArguments([
      "--scenario",
      "outbound-answer",
      "--execute-live",
      "--confirm-live",
      "I_AUTHORIZE_PAID_VOICE_SMOKE",
    ])).toEqual({
      scenario: "outbound-answer",
      executeLive: true,
      confirmation: "I_AUTHORIZE_PAID_VOICE_SMOKE",
    });
  });

  it("formats only the safe run result as one JSON line", () => {
    expect(formatRunResult({
      status: "skipped",
      reason: "missing_required_prerequisites",
      missingConfiguration: ["JARVIS_DEVICE_ID"],
      missingSecrets: ["TWILIO_AUTH_TOKEN"],
    })).toBe('{"status":"skipped","reason":"missing_required_prerequisites","missingConfiguration":["JARVIS_DEVICE_ID"],"missingSecrets":["TWILIO_AUTH_TOKEN"]}\n');
  });
});

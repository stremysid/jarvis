import { describe, expect, it } from "vitest";
import {
  LIVE_VOICE_SMOKE_CONFIRMATION,
  REQUIRED_LIVE_CONFIGURATION,
  REQUIRED_LIVE_SECRETS,
  auditVoiceEvidence,
  cleanupVoiceEvidence,
  formatRunResult,
  parseSmokeArguments,
  runVoiceSmoke,
  validateEvidence,
  type EvidenceStore,
} from "./voice-smoke.js";

const inboundEvidence = {
  schemaVersion: "1.0",
  generatorVersion: "0.1.0",
  status: "passed",
  scenario: "inbound",
  manifestKey: "inbound_call",
  commitSha: "a".repeat(40),
  correlationId: "01j00000000000000000000000",
  startedAt: "2026-08-29T12:00:00.000Z",
  endedAt: "2026-08-29T12:01:00.000Z",
  terminalState: "completed",
  eventIds: ["01j00000000000000000000001"],
  authenticatedTurns: 20,
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
} as const;

const commonEvidence = {
  schemaVersion: "1.0",
  generatorVersion: "0.1.0",
  status: "passed",
  commitSha: "b".repeat(40),
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
  modelRequests: 0,
  personalContextReads: 0,
} as const;

const outboundAnswerEvidence = {
  ...commonEvidence,
  scenario: "outbound-answer",
  manifestKey: "outbound_answer",
  terminalState: "completed",
  authenticatedTurns: 1,
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
} as const;

const outboundNoAnswerEvidence = {
  ...commonEvidence,
  scenario: "outbound-no-answer",
  manifestKey: "outbound_no_answer",
  terminalState: "no-answer",
  callAttempts: 1,
  recipientAuthenticated: false,
  purposeDisclosed: false,
  privateMessageLeft: false,
  statusCallbackSchema: "verified",
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
} as const;

describe("validateEvidence", () => {
  it("accepts a complete redacted inbound release sample", () => {
    expect(validateEvidence(inboundEvidence)).toBe(true);
  });

  it("rejects provider identifiers and transcript or authentication fields", () => {
    for (const unsafe of [
      { ...inboundEvidence, callSid: "synthetic-provider-id" },
      { ...inboundEvidence, transcript: "synthetic-text" },
      { ...inboundEvidence, pin: "synthetic-auth-input" },
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
  });

  it("accepts an authenticated outbound-answer contract with conservative playback evidence", () => {
    expect(validateEvidence(outboundAnswerEvidence)).toBe(true);
    expect(() => validateEvidence({ ...outboundAnswerEvidence, assistantHistoryCommitted: true })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("accepts a private outbound no-answer result and rejects purpose disclosure", () => {
    expect(validateEvidence(outboundNoAnswerEvidence)).toBe(true);
    expect(() => validateEvidence({ ...outboundNoAnswerEvidence, purposeDisclosed: true })).toThrow(/^unsafe_or_incomplete_evidence$/u);
  });

  it("accepts safe failure evidence only when no new callback was authorized", () => {
    expect(validateEvidence(failureEvidence)).toBe(true);
    expect(() => validateEvidence({ ...failureEvidence, unauthorizedCallbackCreated: true })).toThrow(/^unsafe_or_incomplete_evidence$/u);
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
  configuration: Object.fromEntries((REQUIRED_LIVE_CONFIGURATION ?? [
    "JARVIS_CLOUD_BASE_URL",
    "JARVIS_DEVICE_ID",
    "JARVIS_DEVICE_KEY_PATH",
    "JARVIS_PRINCIPAL_ID",
  ]).map((name) => [name, "synthetic-present"])),
  secretPresence: Object.fromEntries((REQUIRED_LIVE_SECRETS ?? [
    "DEEPSEEK_API_KEY",
    "PIN_VERIFIER_JSON",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_API_KEY_SECRET",
    "TWILIO_API_KEY_SID",
    "TWILIO_AUTH_TOKEN",
  ]).map((name) => [name, true])),
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
      missingConfiguration: ["JARVIS_DEVICE_ID", "JARVIS_DEVICE_KEY_PATH", "JARVIS_PRINCIPAL_ID"],
      missingSecrets: ["DEEPSEEK_API_KEY", "PIN_VERIFIER_JSON", "TWILIO_API_KEY_SECRET", "TWILIO_API_KEY_SID", "TWILIO_AUTH_TOKEN"],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-present");
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
      failureEvidence,
    ])).toBe(true);
  });

  it("rejects a release audit with missing or duplicate scenario evidence", () => {
    expect(() => auditVoiceEvidence([
      inboundEvidence,
      unauthorizedEvidence,
      outboundAnswerEvidence,
      outboundNoAnswerEvidence,
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

  it("cleanup removes only the five generated final evidence names", async () => {
    const store = new MemoryEvidenceStore();
    for (const name of [
      "inbound.json",
      "unauthorized-caller.json",
      "outbound-answer.json",
      "outbound-no-answer.json",
      "failure-callbacks.json",
      "operator-notes.txt",
    ]) store.files.set(name, "synthetic");

    await cleanupVoiceEvidence(store);

    expect([...store.files]).toEqual([["operator-notes.txt", "synthetic"]]);
  });
});

describe("safe command contract", () => {
  it("parses a developer smoke as non-live by default", () => {
    expect(parseSmokeArguments(["--scenario", "inbound"])).toEqual({
      scenario: "inbound",
      executeLive: false,
    });
    expect(parseSmokeArguments(["--", "--scenario", "inbound"])).toEqual({
      scenario: "inbound",
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

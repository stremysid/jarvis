import {
  validateEvidence,
  type VoiceSmokeDriver,
  type VoiceSmokeScenario,
} from "./voice-smoke.js";

export interface LiveSmokePreflightProof {
  readonly schemaVersion: "1.0";
  readonly operatorAuthorized: true;
  readonly readiness: "ready";
  readonly fakeGatePassed: true;
  readonly deployedCommitSha: string;
}

export interface LiveSmokeExecutionRequest {
  readonly scenario: VoiceSmokeScenario;
  readonly deployedCommitSha: string;
}

export interface LiveSmokeExecutionReceipt {
  readonly schemaVersion: "1.0";
  readonly scenario: VoiceSmokeScenario;
  readonly correlationId: string;
}

export interface LiveSmokeEvidenceRequest extends LiveSmokeExecutionRequest {
  readonly correlationId: string;
}

export interface LiveSmokeScenarioDriverAdapter {
  readonly preflight: (scenario: VoiceSmokeScenario) => Promise<unknown>;
  readonly execute: (request: Readonly<LiveSmokeExecutionRequest>) => Promise<unknown>;
}

export interface EnrolledOperatorEvidenceQueryAdapter {
  readonly queryEvidence: (request: Readonly<LiveSmokeEvidenceRequest>) => Promise<unknown>;
}

export type LiveVoiceSmokeAdapters = LiveSmokeScenarioDriverAdapter & EnrolledOperatorEvidenceQueryAdapter;

const PREFLIGHT_FIELDS = ["schemaVersion", "operatorAuthorized", "readiness", "fakeGatePassed", "deployedCommitSha"] as const;
const RECEIPT_FIELDS = ["schemaVersion", "scenario", "correlationId"] as const;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;

function exactDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) throw new Error();
  const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
    copied[field] = descriptor.value;
  }
  return copied;
}

function dataField(value: unknown, field: string): unknown {
  if (value === null || typeof value !== "object") throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function validatePreflight(value: unknown): LiveSmokePreflightProof {
  const proof = exactDataRecord(value, PREFLIGHT_FIELDS);
  if (
    proof.schemaVersion !== "1.0"
    || proof.operatorAuthorized !== true
    || proof.readiness !== "ready"
    || proof.fakeGatePassed !== true
    || typeof proof.deployedCommitSha !== "string"
    || !COMMIT_SHA.test(proof.deployedCommitSha)
  ) throw new Error();
  return Object.freeze({
    schemaVersion: "1.0",
    operatorAuthorized: true,
    readiness: "ready",
    fakeGatePassed: true,
    deployedCommitSha: proof.deployedCommitSha,
  });
}

function validateReceipt(value: unknown, scenario: VoiceSmokeScenario): LiveSmokeExecutionReceipt {
  const receipt = exactDataRecord(value, RECEIPT_FIELDS);
  if (
    receipt.schemaVersion !== "1.0"
    || receipt.scenario !== scenario
    || typeof receipt.correlationId !== "string"
    || !ULID.test(receipt.correlationId)
  ) throw new Error();
  return Object.freeze({
    schemaVersion: "1.0",
    scenario,
    correlationId: receipt.correlationId,
  });
}

function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotEvidence(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error();
  const snapshot: unknown = JSON.parse(serialized);
  validateEvidence(snapshot);
  return freezeJson(snapshot);
}

/**
 * Orders the release-owned adapters without receiving credentials itself.
 * `runVoiceSmoke` invokes this only after the paid-action gates have passed.
 */
export function createVoiceSmokeDriver(adapters: Readonly<LiveVoiceSmokeAdapters>): VoiceSmokeDriver {
  const preflight = adapters.preflight;
  const execute = adapters.execute;
  const queryEvidence = adapters.queryEvidence;
  if (typeof preflight !== "function" || typeof execute !== "function" || typeof queryEvidence !== "function") {
    throw new TypeError("live_smoke_adapters_invalid");
  }

  return Object.freeze({
    async run(scenario: VoiceSmokeScenario): Promise<unknown> {
      let proof: LiveSmokePreflightProof;
      try {
        proof = validatePreflight(await preflight(scenario));
      } catch {
        throw new Error("live_smoke_preflight_failed");
      }

      const executionRequest = Object.freeze({
        scenario,
        deployedCommitSha: proof.deployedCommitSha,
      });
      let receipt: LiveSmokeExecutionReceipt;
      try {
        receipt = validateReceipt(await execute(executionRequest), scenario);
      } catch {
        throw new Error("live_smoke_execution_failed");
      }

      const evidenceRequest = Object.freeze({
        scenario,
        deployedCommitSha: proof.deployedCommitSha,
        correlationId: receipt.correlationId,
      });
      try {
        const evidence = snapshotEvidence(await queryEvidence(evidenceRequest));
        if (
          dataField(evidence, "scenario") !== scenario
          || dataField(evidence, "commitSha") !== proof.deployedCommitSha
          || dataField(evidence, "correlationId") !== receipt.correlationId
        ) throw new Error();
        return evidence;
      } catch {
        throw new Error("live_smoke_evidence_failed");
      }
    },
  });
}

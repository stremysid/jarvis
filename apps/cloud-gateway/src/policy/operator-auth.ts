import type { SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import type { DeviceRepository } from "../persistence/device-repository.js";
import { DeviceRequestVerifier, isVerifiedDeviceRequest } from "../sync/signed-request.js";

export interface ReadinessIntentV1 {
  readonly schemaVersion: "1.0";
  readonly intent: "readiness";
}

export interface OperatorAuthorizationRequest {
  readonly signedRequest: SignedRequestV1;
  readonly body: unknown;
  readonly rawBody: Uint8Array;
  readonly verificationTime: Date;
}

export interface OperatorAuthorizationResult {
  readonly operatorId: string;
}

interface CurrentHumanDeviceRepository {
  isCurrentHumanDevice: DeviceRepository["isCurrentHumanDevice"];
}

const AUTHORIZATION_FIELDS = ["signedRequest", "body", "rawBody", "verificationTime"] as const;
const INTENT_FIELDS = ["schemaVersion", "intent"] as const;
const encoder = new TextEncoder();

function exactDataValues(value: unknown, fields: readonly string[], error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(error);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) throw new TypeError(error);
  const descriptors: Record<string, PropertyDescriptor> = Object.create(null) as Record<string, PropertyDescriptor>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    descriptors[field] = descriptor;
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) result[field] = descriptors[field]?.value;
  return result;
}

function validateReadinessIntent(value: unknown): ReadinessIntentV1 {
  const intent = exactDataValues(value, INTENT_FIELDS, "readiness_intent_invalid");
  if (intent.schemaVersion !== "1.0" || intent.intent !== "readiness") throw new TypeError("readiness_intent_invalid");
  return Object.freeze({ schemaVersion: "1.0", intent: "readiness" });
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC")
    && !value.includes("\n") && !value.includes("\r") && encoder.encode(value).byteLength <= 256;
}

/** Converts all signed-request and current-operator failures into one authorization boundary error. */
export class OperatorAuthorizer {
  constructor(private readonly deps: {
    verifier: DeviceRequestVerifier;
    devices: CurrentHumanDeviceRepository;
  }) {}

  async requireEnrolledOperator(input: unknown): Promise<Readonly<OperatorAuthorizationResult>> {
    try {
      const authorization = exactDataValues(input, AUTHORIZATION_FIELDS, "operator_request_invalid");
      const verified = await this.deps.verifier.verify(
        authorization.signedRequest as SignedRequestV1,
        "POST",
        "/health/readiness",
        authorization.body,
        authorization.rawBody as Uint8Array,
        authorization.verificationTime as Date,
        validateReadinessIntent,
      );
      if (!isVerifiedDeviceRequest(verified) || !isOpaqueId(verified.principalId)) throw new Error("operator_proof_invalid");
      if (await this.deps.devices.isCurrentHumanDevice(verified) !== true) throw new Error("operator_device_invalid");
      return Object.freeze({ operatorId: verified.principalId });
    } catch {
      throw new Error("operator_not_authorized");
    }
  }
}

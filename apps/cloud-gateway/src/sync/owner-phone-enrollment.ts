import type { SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import {
  DeviceRepository,
  type OwnerPhoneEnrollmentSnapshotRow,
} from "../persistence/device-repository.js";
import {
  generateIdentityChallengeResponse,
  IdentityChallengeResponseSigner,
} from "./identity-challenge.js";
import { DeviceRequestVerifier, type VerifiedDeviceRequest } from "./signed-request.js";

export const OWNER_PHONE_ENROLLMENT_PATH = "/identity/owner-phone-enrollment";

export type OwnerPhoneEnrollmentState = "absent" | "pending" | "expired" | "active" | "conflict";

export type OwnerPhoneEnrollmentBodyV1 =
  | { readonly schemaVersion: "1.0"; readonly operation: "preflight" | "status" }
  | { readonly schemaVersion: "1.0"; readonly operation: "begin"; readonly phoneNumber: string };

export type OwnerPhoneEnrollmentResult =
  | { readonly schemaVersion: "1.0"; readonly deviceKeyMatches: true }
  | {
    readonly schemaVersion: "1.0";
    readonly deviceKeyMatches: true;
    readonly enrollmentState: OwnerPhoneEnrollmentState;
  }
  | {
    readonly schemaVersion: "1.0";
    readonly deviceKeyMatches: true;
    readonly enrollmentState: "pending";
    readonly challengeId: string;
    readonly response: string;
    readonly expiresAt: string;
  };

const FIVE_MINUTES_MS = 300_000;
const RESPONSE = /^\d{6}$/u;
const E164 = /^\+[1-9]\d{7,14}$/u;
const BASE_FIELDS = new Set(["schemaVersion", "operation"]);
const BEGIN_FIELDS = new Set(["schemaVersion", "operation", "phoneNumber"]);
const encoder = new TextEncoder();

function safeAtom(value: unknown, maximumBytes = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && value === value.normalize("NFC") && !value.includes("\n") && !value.includes("\r")
    && encoder.encode(value).byteLength <= maximumBytes;
}

function exactRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("owner_phone_enrollment_body_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    throw new TypeError("owner_phone_enrollment_body_invalid");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("owner_phone_enrollment_body_invalid");
    }
    result[field] = descriptor.value;
  }
  return result;
}

function validateBody(value: unknown): OwnerPhoneEnrollmentBodyV1 {
  const operation = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "operation")?.value
    : undefined;
  const record = exactRecord(value, operation === "begin" ? BEGIN_FIELDS : BASE_FIELDS);
  if (record.schemaVersion !== "1.0"
    || record.operation !== "preflight" && record.operation !== "status" && record.operation !== "begin") {
    throw new TypeError("owner_phone_enrollment_body_invalid");
  }
  if (record.operation === "begin" && (typeof record.phoneNumber !== "string" || !E164.test(record.phoneNumber))) {
    throw new TypeError("owner_phone_enrollment_body_invalid");
  }
  return record as OwnerPhoneEnrollmentBodyV1;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("owner_phone_enrollment_time_invalid");
  return value;
}

function publicState(
  row: OwnerPhoneEnrollmentSnapshotRow,
  verified: VerifiedDeviceRequest,
  ownerIdentityId: string,
  now: Date,
): OwnerPhoneEnrollmentState {
  const identityMissing = row.identity_id === null;
  const ownerMissing = row.owner_identity_id === null && row.owner_principal_id === null;
  if (identityMissing && ownerMissing) return "absent";
  const exactIdentity = row.identity_id === ownerIdentityId
    && row.identity_principal_id === verified.principalId
    && row.identity_channel === "voice"
    && row.enrolled_by_device_id === verified.deviceId;
  const exactOwner = row.owner_identity_id === ownerIdentityId
    && row.owner_principal_id === verified.principalId;
  if (!exactIdentity || !exactOwner) return "conflict";
  if (row.identity_status === "active" && row.identity_verified_at !== null) return "active";
  if (row.identity_status !== "pending" || row.identity_verified_at !== null) return "conflict";
  return row.challenge_expires_at !== null && row.challenge_expires_at > now.toISOString() ? "pending" : "expired";
}

/** Device-signed owner phone bootstrap. It does not call a provider. */
export class OwnerPhoneEnrollmentService {
  private readonly repository: DeviceRepository;
  private readonly signer: IdentityChallengeResponseSigner;

  constructor(private readonly deps: {
    database: D1Database;
    verifier: DeviceRequestVerifier;
    ownerIdentityId: string;
    hmacPepper: Uint8Array;
    hmacKeyVersion: string;
    now?: () => Date;
    challengeId?: () => string;
    response?: () => string;
    beforeBootstrap?: () => void | Promise<void>;
    faultStatement?: D1PreparedStatement;
  }) {
    if (!safeAtom(deps.ownerIdentityId)) throw new TypeError("owner_phone_enrollment_configuration_invalid");
    this.repository = new DeviceRepository(deps.database);
    this.signer = new IdentityChallengeResponseSigner(deps.hmacPepper, deps.hmacKeyVersion);
  }

  async execute(
    request: SignedRequestV1,
    suppliedBody: unknown,
    rawBody: Uint8Array,
  ): Promise<OwnerPhoneEnrollmentResult> {
    const now = requireNow((this.deps.now ?? (() => new Date()))());
    // The validator deliberately does no phone work. Device authentication
    // completes first; only then is the authoritative body interpreted.
    const verified = await this.deps.verifier.verify(
      request, "POST", OWNER_PHONE_ENROLLMENT_PATH, suppliedBody, rawBody, now, (value) => value,
    );
    const body = validateBody(verified.body);
    const current = await this.readCurrent(verified, now);
    if (body.operation === "preflight") {
      return Object.freeze({ schemaVersion: "1.0" as const, deviceKeyMatches: true as const });
    }
    if (body.operation === "status") return this.stateResult(current.state);
    if (body.operation !== "begin") throw new TypeError("owner_phone_enrollment_body_invalid");
    if (current.state === "conflict" || current.row.provider_subject !== null
      && current.row.provider_subject !== body.phoneNumber) {
      return this.stateResult("conflict");
    }
    if (current.state === "active") return this.stateResult("active");

    const challengeId = (this.deps.challengeId ?? (() => `challenge:${crypto.randomUUID()}`))();
    const response = (this.deps.response ?? generateIdentityChallengeResponse)();
    if (!safeAtom(challengeId) || !RESPONSE.test(response)) throw new TypeError("identity_challenge_generation_invalid");
    const expiresAt = new Date(now.valueOf() + FIVE_MINUTES_MS).toISOString();
    const responseHmac = await this.signer.sign({
      challengeId,
      principalId: verified.principalId,
      channel: "voice",
      identityId: this.deps.ownerIdentityId,
      response,
      initiatingDeviceId: verified.deviceId,
      initiatingKeyId: verified.keyId,
      initiatingKeyFingerprint: verified.keyFingerprint,
      initiatingKeyGeneration: verified.keyGeneration,
    });
    await this.deps.beforeBootstrap?.();
    const created = await this.repository.createOwnerPhoneEnrollmentChallenge({
      challengeId,
      verified,
      identityId: this.deps.ownerIdentityId,
      channel: "voice",
      phoneNumber: body.phoneNumber,
      responseHmac,
      hmacKeyVersion: this.signer.keyVersion,
      expiresAt,
      createdAt: now.toISOString(),
      ...(this.deps.faultStatement === undefined ? {} : { faultStatement: this.deps.faultStatement }),
    });
    if (!created) {
      const after = await this.readCurrent(verified, now);
      if (after.state === "active" || after.state === "conflict") return this.stateResult(after.state);
      throw new Error("owner_phone_enrollment_state_changed");
    }
    const after = await this.readCurrent(verified, now);
    if (after.state !== "pending" || after.row.challenge_expires_at !== expiresAt) {
      throw new Error("owner_phone_enrollment_state_changed");
    }
    return Object.freeze({
      schemaVersion: "1.0" as const,
      deviceKeyMatches: true as const,
      enrollmentState: "pending" as const,
      challengeId,
      response,
      expiresAt,
    });
  }

  private async readCurrent(
    verified: VerifiedDeviceRequest,
    now: Date,
  ): Promise<{ readonly row: OwnerPhoneEnrollmentSnapshotRow; readonly state: OwnerPhoneEnrollmentState }> {
    const row = await this.repository.readOwnerPhoneEnrollment(
      verified, this.deps.ownerIdentityId, this.signer.keyVersion,
    );
    if (row === null) throw new Error("owner_phone_device_mismatch");
    return Object.freeze({ row, state: publicState(row, verified, this.deps.ownerIdentityId, now) });
  }

  private stateResult(state: OwnerPhoneEnrollmentState): OwnerPhoneEnrollmentResult {
    return Object.freeze({
      schemaVersion: "1.0" as const,
      deviceKeyMatches: true as const,
      enrollmentState: state,
    });
  }
}

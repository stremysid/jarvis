import { newUlid, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import {
  OwnerCallPinRepository,
  OwnerCallPinStateChangedError,
} from "../persistence/owner-call-pin-repository.js";
import {
  generateOwnerCallPin,
  ownerCallPinDigits,
  OwnerCallPinVerifier,
  type OwnerCallPinVerifierRecordV1,
} from "../security/owner-call-pin-verifier.js";
import { DeviceRequestVerifier } from "./signed-request.js";

export const OWNER_CALL_PIN_PATH = "/identity/owner-call-pin";

export type OwnerCallPinBodyV1 =
  | { readonly schemaVersion: "1.0"; readonly operation: "status" }
  | {
    readonly schemaVersion: "1.0";
    readonly operation: "generate";
    readonly expectedPinVersion: number | null;
  };

export type OwnerCallPinResultV1 =
  | {
    readonly schemaVersion: "1.0";
    readonly deviceKeyMatches: true;
    readonly pinVersion: number | null;
    readonly pinStatus: "active" | null;
  }
  | {
    readonly schemaVersion: "1.0";
    readonly deviceKeyMatches: true;
    readonly pinVersion: number;
    readonly pinStatus: "active";
    readonly pin: string;
  };

const BASE_FIELDS = new Set(["schemaVersion", "operation"]);
const GENERATE_FIELDS = new Set(["schemaVersion", "operation", "expectedPinVersion"]);

function exactRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("owner_call_pin_body_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    throw new TypeError("owner_call_pin_body_invalid");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("owner_call_pin_body_invalid");
    }
    result[field] = descriptor.value;
  }
  return result;
}

function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_646;
}

function validateBody(value: unknown): OwnerCallPinBodyV1 {
  const operation = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "operation")?.value
    : undefined;
  const record = exactRecord(value, operation === "generate" ? GENERATE_FIELDS : BASE_FIELDS);
  if (record.schemaVersion !== "1.0" || record.operation !== "status" && record.operation !== "generate") {
    throw new TypeError("owner_call_pin_body_invalid");
  }
  if (record.operation === "generate"
    && record.expectedPinVersion !== null && !version(record.expectedPinVersion)) {
    throw new TypeError("owner_call_pin_body_invalid");
  }
  return record as OwnerCallPinBodyV1;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("owner_call_pin_time_invalid");
  return value;
}

/**
 * Device-signed generation without a client-supplied salt.
 *
 * The passphrase request carries a `requestSalt` the Worker validates and
 * never reads, so it is not copied here: the verifier's salt is drawn inside
 * the verifier, and a second salt in the body would be decoration. Plaintext
 * exists only in this request and its response, exactly as the phrase does.
 */
export class OwnerCallPinService {
  private readonly repository: OwnerCallPinRepository;
  private readonly pinVerifier: OwnerCallPinVerifier;

  constructor(private readonly deps: {
    database: D1Database;
    verifier: DeviceRequestVerifier;
    ownerPrincipalId: string;
    ownerIdentityId: string;
    pepper: Uint8Array;
    now?: () => Date;
    randomSample?: () => number;
    commitId?: () => string;
    beforeCommit?: () => void | Promise<void>;
    faultStatement?: D1PreparedStatement;
  }) {
    this.repository = new OwnerCallPinRepository(deps.database);
    this.pinVerifier = new OwnerCallPinVerifier(deps.pepper);
  }

  async execute(
    request: SignedRequestV1,
    suppliedBody: unknown,
    rawBody: Uint8Array,
  ): Promise<OwnerCallPinResultV1> {
    const now = requireNow((this.deps.now ?? (() => new Date()))());
    const verified = await this.deps.verifier.verify(
      request, "POST", OWNER_CALL_PIN_PATH, suppliedBody, rawBody, now, (value) => value,
    );
    const body = validateBody(verified.body);
    const status = await this.repository.readStatus(
      verified, this.deps.ownerPrincipalId, this.deps.ownerIdentityId,
    );
    if (status === null) throw new Error("owner_call_pin_owner_mismatch");
    if (body.operation === "status") {
      return Object.freeze({
        schemaVersion: "1.0" as const,
        deviceKeyMatches: true as const,
        pinVersion: status.pinVersion,
        pinStatus: status.status,
      });
    }
    if (status.pinVersion !== body.expectedPinVersion) {
      throw new OwnerCallPinStateChangedError();
    }
    const newVersion = body.expectedPinVersion === null ? 1 : body.expectedPinVersion + 1;
    const pin = generateOwnerCallPin(this.deps.randomSample);
    const digits = ownerCallPinDigits(pin);
    let record: OwnerCallPinVerifierRecordV1;
    try {
      record = await this.pinVerifier.create(this.deps.ownerIdentityId, newVersion, digits);
    } finally {
      digits.fill(0);
    }
    await this.deps.beforeCommit?.();
    await this.repository.rotate({
      verified,
      ownerPrincipalId: this.deps.ownerPrincipalId,
      ownerIdentityId: this.deps.ownerIdentityId,
      expectedPinVersion: body.expectedPinVersion,
      record,
      commitId: (this.deps.commitId ?? newUlid)(),
      committedAt: now.toISOString(),
      ...(this.deps.faultStatement === undefined ? {} : { faultStatement: this.deps.faultStatement }),
    });
    return Object.freeze({
      schemaVersion: "1.0" as const,
      deviceKeyMatches: true as const,
      pinVersion: newVersion,
      pinStatus: "active" as const,
      pin,
    });
  }
}

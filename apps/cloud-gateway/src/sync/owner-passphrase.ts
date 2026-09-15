import { newUlid, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import {
  OwnerPassphraseRepository,
  OwnerPassphraseStateChangedError,
} from "../persistence/owner-passphrase-repository.js";
import {
  generateOwnerPassphrase,
  OwnerPassphraseVerifier,
} from "../security/owner-passphrase-verifier.js";
import { OWNER_PASSPHRASE_WORD_LIST_VERSION } from "../security/owner-passphrase-word-list.js";
import { decodeCanonicalBase64Url, DeviceRequestVerifier } from "./signed-request.js";

export const OWNER_PASSPHRASE_PATH = "/identity/owner-passphrase";

export type OwnerPassphraseBodyV1 =
  | { readonly schemaVersion: "1.0"; readonly operation: "status" }
  | {
    readonly schemaVersion: "1.0";
    readonly operation: "generate";
    readonly expectedVerifierVersion: number | null;
    readonly requestSalt: string;
  };

export type OwnerPassphraseResultV1 =
  | {
    readonly schemaVersion: "1.0";
    readonly deviceKeyMatches: true;
    readonly verifierVersion: number | null;
    readonly verifierStatus: "active" | "disabled" | null;
  }
  | {
    readonly schemaVersion: "1.0";
    readonly deviceKeyMatches: true;
    readonly verifierVersion: number;
    readonly verifierStatus: "active";
    readonly wordListVersion: typeof OWNER_PASSPHRASE_WORD_LIST_VERSION;
    readonly phrase: string;
  };

const BASE_FIELDS = new Set(["schemaVersion", "operation"]);
const GENERATE_FIELDS = new Set(["schemaVersion", "operation", "expectedVerifierVersion", "requestSalt"]);

function exactRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("owner_passphrase_body_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    throw new TypeError("owner_passphrase_body_invalid");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("owner_passphrase_body_invalid");
    }
    result[field] = descriptor.value;
  }
  return result;
}

function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_646;
}

function validateBody(value: unknown): OwnerPassphraseBodyV1 {
  const operation = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "operation")?.value
    : undefined;
  const record = exactRecord(value, operation === "generate" ? GENERATE_FIELDS : BASE_FIELDS);
  if (record.schemaVersion !== "1.0" || record.operation !== "status" && record.operation !== "generate") {
    throw new TypeError("owner_passphrase_body_invalid");
  }
  if (record.operation === "generate") {
    if (record.expectedVerifierVersion !== null && !version(record.expectedVerifierVersion)) {
      throw new TypeError("owner_passphrase_body_invalid");
    }
    decodeCanonicalBase64Url(record.requestSalt, 32, "owner_passphrase_body_invalid");
  }
  return record as OwnerPassphraseBodyV1;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("owner_passphrase_time_invalid");
  return value;
}

/** Device-signed generation. Plaintext exists only in this request and its response. */
export class OwnerPassphraseService {
  private readonly repository: OwnerPassphraseRepository;
  private readonly passphraseVerifier: OwnerPassphraseVerifier;

  constructor(private readonly deps: {
    database: D1Database;
    verifier: DeviceRequestVerifier;
    ownerPrincipalId: string;
    ownerIdentityId: string;
    pepper: Uint8Array;
    now?: () => Date;
    randomIndex?: () => number;
    randomSalt?: () => Uint8Array;
    commitId?: () => string;
    beforeCommit?: () => void | Promise<void>;
    faultStatement?: D1PreparedStatement;
  }) {
    this.repository = new OwnerPassphraseRepository(deps.database);
    this.passphraseVerifier = new OwnerPassphraseVerifier(deps.pepper, "v1", deps.randomSalt);
  }

  async execute(
    request: SignedRequestV1,
    suppliedBody: unknown,
    rawBody: Uint8Array,
  ): Promise<OwnerPassphraseResultV1> {
    const now = requireNow((this.deps.now ?? (() => new Date()))());
    const verified = await this.deps.verifier.verify(
      request, "POST", OWNER_PASSPHRASE_PATH, suppliedBody, rawBody, now, (value) => value,
    );
    const body = validateBody(verified.body);
    const status = await this.repository.readStatus(
      verified, this.deps.ownerPrincipalId, this.deps.ownerIdentityId,
    );
    if (status === null) throw new Error("owner_passphrase_owner_mismatch");
    if (body.operation === "status") {
      return Object.freeze({
        schemaVersion: "1.0" as const,
        deviceKeyMatches: true as const,
        verifierVersion: status.verifierVersion,
        verifierStatus: status.status,
      });
    }
    if (status.verifierVersion !== body.expectedVerifierVersion) {
      throw new OwnerPassphraseStateChangedError();
    }
    const newVersion = body.expectedVerifierVersion === null ? 1 : body.expectedVerifierVersion + 1;
    const phrase = generateOwnerPassphrase(this.deps.randomIndex);
    const record = await this.passphraseVerifier.create(this.deps.ownerIdentityId, newVersion, phrase);
    await this.deps.beforeCommit?.();
    await this.repository.rotate({
      verified,
      ownerPrincipalId: this.deps.ownerPrincipalId,
      ownerIdentityId: this.deps.ownerIdentityId,
      expectedVerifierVersion: body.expectedVerifierVersion,
      record,
      commitId: (this.deps.commitId ?? newUlid)(),
      committedAt: now.toISOString(),
      ...(this.deps.faultStatement === undefined ? {} : { faultStatement: this.deps.faultStatement }),
    });
    return Object.freeze({
      schemaVersion: "1.0" as const,
      deviceKeyMatches: true as const,
      verifierVersion: newVersion,
      verifierStatus: "active" as const,
      wordListVersion: OWNER_PASSPHRASE_WORD_LIST_VERSION,
      phrase,
    });
  }
}

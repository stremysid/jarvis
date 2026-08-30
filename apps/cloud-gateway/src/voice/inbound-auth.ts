import { canonicalJson, newUlid, type CallDirection, type RelayBinding, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  decodePinVerifierRecord,
  verifyPin,
  type PinVerifierRecordV1,
} from "../security/pin-verifier.js";

export { decodePinVerifierRecord, verifyPin } from "../security/pin-verifier.js";
export type { PinVerifierRecordV1 } from "../security/pin-verifier.js";

export interface AuthenticationBudgetOptions {
  readonly callSidLimit?: number;
  readonly compositeLimit?: number;
  readonly globalLimit?: number;
  readonly challengeLimit?: number;
  readonly windowMs?: number;
}

const PIN_AUTHENTICATION_PROOF = Symbol("jarvis.pin-authentication-proof");

export interface PinAuthenticationProof {
  readonly [PIN_AUTHENTICATION_PROOF]: true;
  readonly proofId: string;
  readonly authenticated: true;
  readonly sessionId: Ulid;
  readonly callSid: string;
  readonly principalId: string;
  readonly identityId: string;
  readonly direction: CallDirection;
  readonly activationChallengeId: string | null;
}

interface BindingSnapshot {
  readonly callSid: string;
  readonly principalId: string;
  readonly identityId: string;
  readonly destinationIdentityId: string;
  readonly relayNonce: string;
  readonly direction: CallDirection;
  readonly activationOnly: boolean;
  readonly activationChallengeId: string | null;
  readonly accessKind: "owner" | "guest";
  readonly guestGrantId: string | null;
  readonly guestGrantVersion: number | null;
  readonly accessDocumentHash: string | null;
}

const MAXIMUM_LIMITS = Object.freeze({
  callSidLimit: 3,
  compositeLimit: 6,
  globalLimit: 30,
  challengeLimit: 3,
  windowMs: 300_000,
});
const BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce",
  "direction", "activationOnly", "activationChallengeId",
  "accessKind", "guestGrantId", "guestGrantVersion", "accessDocumentHash",
]);
const AUTH_INPUT_FIELDS = new Set(["pinDigits", "sessionId", "binding", "now"]);
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const encoder = new TextEncoder();
const issuedBudgets = new WeakSet<object>();

function exactDataRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  let prototype: object | null;
  try { prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null; }
  catch { throw new TypeError(error); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) {
    throw new TypeError(error);
  }
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch { throw new TypeError(error); }
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    throw new TypeError(error);
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { throw new TypeError(error); }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    captured[field] = descriptor.value;
  }
  return captured;
}

function safeAtom(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.isWellFormed()
    && value === value.normalize("NFC")
    && !value.includes("\n")
    && !value.includes("\r")
    && encoder.encode(value).byteLength <= 256;
}

function snapshotBinding(value: unknown): BindingSnapshot {
  const input = exactDataRecord(value, BINDING_FIELDS, "relay_binding_invalid");
  if (
    typeof input.callSid !== "string"
    || !CALL_SID.test(input.callSid)
    || !safeAtom(input.principalId)
    || !safeAtom(input.identityId)
    || !safeAtom(input.destinationIdentityId)
    || typeof input.relayNonce !== "string"
    || !RELAY_NONCE.test(input.relayNonce)
    || input.direction !== "inbound" && input.direction !== "outbound"
    || typeof input.activationOnly !== "boolean"
    || input.activationChallengeId !== null && !safeAtom(input.activationChallengeId)
    || (input.direction === "inbound" && input.identityId !== input.destinationIdentityId)
    || (input.activationOnly
      ? input.direction !== "inbound" || input.activationChallengeId === null
      : input.activationChallengeId !== null)
    || !validAccessBinding(input)
  ) {
    throw new TypeError("relay_binding_invalid");
  }
  return Object.freeze({
    callSid: input.callSid,
    principalId: input.principalId,
    identityId: input.identityId,
    destinationIdentityId: input.destinationIdentityId,
    relayNonce: input.relayNonce,
    direction: input.direction,
    activationOnly: input.activationOnly,
    activationChallengeId: input.activationChallengeId,
    accessKind: input.accessKind as "owner" | "guest",
    guestGrantId: input.guestGrantId as string | null,
    guestGrantVersion: input.guestGrantVersion as number | null,
    accessDocumentHash: input.accessDocumentHash as string | null,
  });
}

function validAccessBinding(input: Record<string, unknown>): boolean {
  if (input.accessKind === "owner") {
    return input.guestGrantId === null
      && input.guestGrantVersion === null
      && input.accessDocumentHash === null;
  }
  return input.accessKind === "guest"
    && typeof input.guestGrantId === "string"
    && ULID.test(input.guestGrantId)
    && Number.isSafeInteger(input.guestGrantVersion)
    && (input.guestGrantVersion as number) > 0
    && typeof input.accessDocumentHash === "string"
    && /^[0-9a-f]{64}$/u.test(input.accessDocumentHash)
    && input.activationOnly === false
    && input.activationChallengeId === null;
}

function requireDate(value: unknown, error: string): { readonly iso: string; readonly epochMs: number } {
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { throw new TypeError(error); }
  if (!Number.isFinite(epochMs)) throw new TypeError(error);
  return Object.freeze({ iso: new Date(epochMs).toISOString(), epochMs });
}

function requireLimit(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new RangeError(`${label}_invalid`);
  }
  return value as number;
}

function optionsSnapshot(value: AuthenticationBudgetOptions | undefined): Required<AuthenticationBudgetOptions> {
  if (value === undefined) return MAXIMUM_LIMITS;
  let prototype: object | null;
  try { prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null; }
  catch { throw new TypeError("authentication_budget_options_invalid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) {
    throw new TypeError("authentication_budget_options_invalid");
  }
  const allowed = new Set(Object.keys(MAXIMUM_LIMITS));
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("authentication_budget_options_invalid");
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !("value" in descriptor)) throw new TypeError("authentication_budget_options_invalid");
    captured[key] = descriptor?.value ?? MAXIMUM_LIMITS[key as keyof typeof MAXIMUM_LIMITS];
  }
  return Object.freeze({
    callSidLimit: requireLimit(captured.callSidLimit, MAXIMUM_LIMITS.callSidLimit, "call_sid_limit"),
    compositeLimit: requireLimit(captured.compositeLimit, MAXIMUM_LIMITS.compositeLimit, "composite_limit"),
    globalLimit: requireLimit(captured.globalLimit, MAXIMUM_LIMITS.globalLimit, "global_limit"),
    challengeLimit: requireLimit(captured.challengeLimit, MAXIMUM_LIMITS.challengeLimit, "challenge_limit"),
    windowMs: requireLimit(captured.windowMs, MAXIMUM_LIMITS.windowMs, "authentication_window"),
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Append-only, atomic multi-scope reservation authority for completed authentication candidates. */
export class AuthenticationAttemptBudget {
  readonly #database: D1Database;
  readonly #limits: Required<AuthenticationBudgetOptions>;
  readonly #key: Promise<CryptoKey>;

  constructor(database: D1Database, pepper: Uint8Array, options?: AuthenticationBudgetOptions) {
    if (typeof database !== "object" || database === null || !(pepper instanceof Uint8Array) || pepper.byteLength !== 32) {
      throw new TypeError("authentication_budget_configuration_invalid");
    }
    this.#database = database;
    this.#limits = optionsSnapshot(options);
    const copiedPepper = pepper.slice();
    this.#key = (async () => {
      try {
        return await crypto.subtle.importKey("raw", copiedPepper, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      } finally {
        copiedPepper.fill(0);
      }
    })();
    issuedBudgets.add(this);
    Object.freeze(this);
  }

  reservePinAttempt(input: { readonly binding: RelayBinding; readonly now: Date }): Promise<boolean> {
    return this.#reserve("pin", input);
  }

  reserveActivationAttempt(input: { readonly binding: RelayBinding; readonly now: Date }): Promise<boolean> {
    return this.#reserve("activation", input);
  }

  async #hash(scope: string, facts: readonly unknown[]): Promise<string> {
    const payload = encoder.encode(canonicalJson(["jarvis.authentication-budget", "1.0", scope, ...facts]));
    return hex(new Uint8Array(await crypto.subtle.sign("HMAC", await this.#key, payload)));
  }

  async #reserve(
    kind: "pin" | "activation",
    rawInput: { readonly binding: RelayBinding; readonly now: Date },
  ): Promise<boolean> {
    const input = exactDataRecord(rawInput, new Set(["binding", "now"]), "authentication_reservation_invalid");
    const binding = snapshotBinding(input.binding);
    const now = requireDate(input.now, "authentication_reservation_time_invalid");
    if (kind === "activation" && (!binding.activationOnly || binding.activationChallengeId === null)) {
      throw new TypeError("authentication_reservation_invalid");
    }
    const challengeId = kind === "activation" ? binding.activationChallengeId : null;
    const [callHash, compositeHash, globalHash, challengeHash] = await Promise.all([
      this.#hash("call-sid", [binding.callSid]),
      this.#hash("principal-identity-direction", [binding.principalId, binding.identityId, binding.direction]),
      this.#hash("global", []),
      challengeId === null ? Promise.resolve(null) : this.#hash("activation-challenge", [challengeId]),
    ]);
    const reservationId = newUlid();
    const expiresAt = new Date(now.epochMs + this.#limits.windowMs).toISOString();
    const row = await this.#database.prepare(`INSERT INTO authentication_attempt_reservations (
      reservation_id, attempt_kind, call_sid_bucket_hash, composite_bucket_hash,
      global_bucket_hash, challenge_bucket_hash, created_at, expires_at
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE (SELECT COUNT(*) FROM authentication_attempt_reservations
      WHERE call_sid_bucket_hash = ?9 AND expires_at > ?10) < ?11
      AND (SELECT COUNT(*) FROM authentication_attempt_reservations
        WHERE composite_bucket_hash = ?12 AND expires_at > ?13) < ?14
      AND (SELECT COUNT(*) FROM authentication_attempt_reservations
        WHERE global_bucket_hash = ?15 AND expires_at > ?16) < ?17
      AND (?18 IS NULL OR (
        SELECT COUNT(*) FROM authentication_attempt_reservations
        WHERE challenge_bucket_hash = ?19 AND expires_at > ?20
      ) < ?21)
    RETURNING reservation_id`)
      .bind(
        reservationId, kind, callHash, compositeHash, globalHash, challengeHash, now.iso, expiresAt,
        callHash, now.iso, this.#limits.callSidLimit,
        compositeHash, now.iso, this.#limits.compositeLimit,
        globalHash, now.iso, this.#limits.globalLimit,
        challengeHash, challengeHash, now.iso, this.#limits.challengeLimit,
      )
      .first<{ reservation_id: string }>();
    return row?.reservation_id === reservationId;
  }
}

const reservePinAttemptFromIssuedBudget = AuthenticationAttemptBudget.prototype.reservePinAttempt;

/** Mints instance-local nominal proof only after a reserved, successful PBKDF2 verification. */
export class PinAuthenticationService {
  readonly #proofs = new WeakMap<object, PinAuthenticationProof>();
  readonly #reservePinAttempt: AuthenticationAttemptBudget["reservePinAttempt"];
  readonly #verifier: PinVerifierRecordV1;

  constructor(
    budgets: AuthenticationAttemptBudget,
    verifier: PinVerifierRecordV1,
  ) {
    if (!issuedBudgets.has(budgets)) {
      throw new TypeError("pin_authentication_configuration_invalid");
    }
    this.#reservePinAttempt = (input) => reservePinAttemptFromIssuedBudget.call(budgets, input);
    this.#verifier = verifier;
  }

  async authenticate(rawInput: {
    readonly pinDigits: unknown;
    readonly sessionId: Ulid;
    readonly binding: RelayBinding;
    readonly now: Date;
  }): Promise<PinAuthenticationProof | null> {
    const input = exactDataRecord(rawInput, AUTH_INPUT_FIELDS, "pin_authentication_input_invalid");
    const pinDigits = input.pinDigits;
    const sessionId = input.sessionId;
    const binding = snapshotBinding(input.binding);
    const now = input.now;
    if (typeof sessionId !== "string" || !ULID.test(sessionId)) throw new TypeError("pin_authentication_input_invalid");
    const reserved = await this.#reservePinAttempt({ binding, now: now as Date });
    if (!reserved) throw new Error("authentication_budget_exhausted");
    if (!await verifyPin(pinDigits, this.#verifier)) return null;
    const proof: PinAuthenticationProof = Object.freeze({
      [PIN_AUTHENTICATION_PROOF]: true as const,
      proofId: `pin-proof:${crypto.randomUUID()}`,
      authenticated: true,
      sessionId: sessionId as Ulid,
      callSid: binding.callSid,
      principalId: binding.principalId,
      identityId: binding.identityId,
      direction: binding.direction,
      activationChallengeId: binding.activationChallengeId,
    });
    this.#proofs.set(proof, proof);
    return proof;
  }

  snapshotProof(value: unknown): PinAuthenticationProof {
    const proof = value !== null && typeof value === "object" ? this.#proofs.get(value) : undefined;
    if (proof === undefined || proof !== value || !Object.isFrozen(value)) {
      throw new TypeError("pin_authentication_proof_invalid");
    }
    return proof;
  }
}

export function evaluatePinAttempt(input: {
  readonly failedAttempts: number;
  readonly pinMatches: boolean;
}): { readonly nextFailedAttempts: number; readonly terminateCall: boolean } {
  const captured = exactDataRecord(input, new Set(["failedAttempts", "pinMatches"]), "pin_attempt_invalid");
  const failedAttempts = captured.failedAttempts;
  const pinMatches = captured.pinMatches;
  if (
    !Number.isSafeInteger(failedAttempts)
    || (failedAttempts as number) < 0
    || typeof pinMatches !== "boolean"
    || (!pinMatches && failedAttempts === Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError("pin_attempt_invalid");
  }
  if (pinMatches) return Object.freeze({ nextFailedAttempts: 0, terminateCall: false });
  const nextFailedAttempts = (failedAttempts as number) + 1;
  return Object.freeze({ nextFailedAttempts, terminateCall: nextFailedAttempts >= 3 });
}

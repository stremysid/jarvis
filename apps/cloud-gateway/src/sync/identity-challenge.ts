import { canonicalJson, type Sha256Hex, type SignedRequestV1 } from "../../../../packages/contracts/src/index.js";
import { DeviceRepository, type IdentityChallengeRow, type StoredIdentityChannel } from "../persistence/device-repository.js";
import { DeviceRequestVerifier, type VerifiedDeviceRequest } from "./signed-request.js";

export type IdentityChallengeChannel = "phone" | "telegram";

export interface IdentityChallengeBeginBodyV1 {
  readonly schemaVersion: "1.0";
  readonly channel: IdentityChallengeChannel;
  readonly identityId: string;
}

export interface IdentityChallengeBeginResult {
  readonly challengeId: string;
  readonly response: string;
  readonly expiresAt: string;
}

export interface AuthoritativePinAuthentication {
  readonly proofId: string;
  readonly authenticated: boolean;
}

export interface ChannelObservationInput {
  readonly challengeId: string;
  readonly providerRequestId: string;
  readonly channel: IdentityChallengeChannel;
  readonly principalId: string;
  readonly identityId: string;
  readonly response: string;
  readonly initiatingDeviceId: string;
  readonly initiatingKeyId: string;
  readonly initiatingKeyFingerprint: string;
  readonly initiatingKeyGeneration: number;
  readonly pinAuthentication: AuthoritativePinAuthentication | null;
}

export interface VerifiedChannelObservation extends Readonly<ChannelObservationInput> {}

const BEGIN_PATH = "/identity/challenge/begin";
const FIVE_MINUTES_MS = 300_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESPONSE = /^\d{6}$/u;
const BEGIN_FIELDS = new Set(["schemaVersion", "channel", "identityId"]);
const OBSERVATION_FIELDS = new Set([
  "challengeId", "providerRequestId", "channel", "principalId", "identityId", "response", "initiatingDeviceId",
  "initiatingKeyId", "initiatingKeyFingerprint", "initiatingKeyGeneration", "pinAuthentication",
]);
const encoder = new TextEncoder();

function exactRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(error);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) throw new TypeError(error);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(error);
    result[field] = descriptor.value;
  }
  return result;
}

function safeAtom(value: unknown, maximumBytes = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC")
    && !value.includes("\n") && !value.includes("\r") && encoder.encode(value).byteLength <= maximumBytes;
}

function validateBeginBody(value: unknown): IdentityChallengeBeginBodyV1 {
  const record = exactRecord(value, BEGIN_FIELDS, "identity_challenge_body_invalid");
  if (record.schemaVersion !== "1.0" || record.channel !== "phone" && record.channel !== "telegram" || !safeAtom(record.identityId)) {
    throw new TypeError("identity_challenge_body_invalid");
  }
  return record as unknown as IdentityChallengeBeginBodyV1;
}

function publicChannel(channel: StoredIdentityChannel): IdentityChallengeChannel {
  return channel === "voice" ? "phone" : channel;
}

function storedChannel(channel: IdentityChallengeChannel): StoredIdentityChannel {
  return channel === "phone" ? "voice" : channel;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError("identity_challenge_time_invalid");
  return value;
}

function freezeObservation(input: ChannelObservationInput): VerifiedChannelObservation {
  const pinAuthentication = input.pinAuthentication === null ? null : Object.freeze({ ...input.pinAuthentication });
  return Object.freeze({ ...input, pinAuthentication });
}

/** Mints opaque observations only for the adapter authority injected into the service. */
export class VerifiedChannelObservationAuthority {
  private readonly issued = new WeakSet<object>();

  issue(rawInput: ChannelObservationInput): VerifiedChannelObservation {
    const input = exactRecord(rawInput, OBSERVATION_FIELDS, "channel_observation_invalid");
    for (const field of ["challengeId", "providerRequestId", "principalId", "identityId", "initiatingDeviceId", "initiatingKeyId"] as const) {
      if (!safeAtom(input[field])) throw new TypeError("channel_observation_invalid");
    }
    if (input.channel !== "phone" && input.channel !== "telegram" || typeof input.response !== "string" || !RESPONSE.test(input.response)
      || typeof input.initiatingKeyFingerprint !== "string" || !SHA256.test(input.initiatingKeyFingerprint)
      || !Number.isSafeInteger(input.initiatingKeyGeneration) || (input.initiatingKeyGeneration as number) <= 0) {
      throw new TypeError("channel_observation_invalid");
    }
    let pinAuthentication: AuthoritativePinAuthentication | null = null;
    if (input.pinAuthentication !== null) {
      const pin = exactRecord(input.pinAuthentication, new Set(["proofId", "authenticated"]), "channel_observation_invalid");
      if (!safeAtom(pin.proofId) || typeof pin.authenticated !== "boolean") throw new TypeError("channel_observation_invalid");
      pinAuthentication = { proofId: pin.proofId, authenticated: pin.authenticated };
    }
    if (input.channel === "telegram" && pinAuthentication !== null) throw new TypeError("channel_observation_invalid");
    const observation = freezeObservation({
      challengeId: input.challengeId as string,
      providerRequestId: input.providerRequestId as string,
      channel: input.channel,
      principalId: input.principalId as string,
      identityId: input.identityId as string,
      response: input.response,
      initiatingDeviceId: input.initiatingDeviceId as string,
      initiatingKeyId: input.initiatingKeyId as string,
      initiatingKeyFingerprint: input.initiatingKeyFingerprint,
      initiatingKeyGeneration: input.initiatingKeyGeneration as number,
      pinAuthentication,
    });
    this.issued.add(observation);
    return observation;
  }

  isIssued(value: unknown): value is VerifiedChannelObservation {
    return value !== null && typeof value === "object" && this.issued.has(value);
  }
}

function defaultResponse(): string {
  const maximum = 4_294_000_000;
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while ((bytes[0] ?? maximum) >= maximum);
  return String((bytes[0] ?? 0) % 1_000_000).padStart(6, "0");
}

function hex(bytes: Uint8Array): Sha256Hex {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") as Sha256Hex;
}

function fromHex(value: string): Uint8Array {
  if (!SHA256.test(value)) throw new TypeError("identity_challenge_digest_invalid");
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

/** Begins signed enrollment challenges and consumes trusted adapter observations atomically. */
export class IdentityChallengeService {
  private readonly repository: DeviceRepository;
  private readonly hmacKey: Promise<CryptoKey>;

  constructor(private readonly deps: {
    database: D1Database;
    verifier: DeviceRequestVerifier;
    observations: VerifiedChannelObservationAuthority;
    hmacPepper: Uint8Array;
    hmacKeyVersion: string;
    now?: () => Date;
    challengeId?: () => string;
    response?: () => string;
    beforeChallengeInsert?: () => void | Promise<void>;
    beforeConfirmation?: () => void | Promise<void>;
  }) {
    if (!(deps.hmacPepper instanceof Uint8Array) || deps.hmacPepper.byteLength !== 32 || !safeAtom(deps.hmacKeyVersion, 64)) {
      throw new TypeError("identity_challenge_hmac_configuration_invalid");
    }
    this.repository = new DeviceRepository(deps.database);
    const pepper = new Uint8Array(deps.hmacPepper);
    this.hmacKey = crypto.subtle.importKey("raw", pepper, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  async begin(
    request: SignedRequestV1,
    body: IdentityChallengeBeginBodyV1,
    rawBody: Uint8Array,
  ): Promise<IdentityChallengeBeginResult> {
    const now = requireNow((this.deps.now ?? (() => new Date()))());
    const verified = await this.deps.verifier.verify(request, "POST", BEGIN_PATH, body, rawBody, now, validateBeginBody);
    const challengeId = (this.deps.challengeId ?? (() => `challenge:${crypto.randomUUID()}`))();
    const response = (this.deps.response ?? defaultResponse)();
    if (!safeAtom(challengeId) || !RESPONSE.test(response)) throw new TypeError("identity_challenge_generation_invalid");
    const channel = storedChannel(verified.body.channel);
    const expiresAt = new Date(now.valueOf() + FIVE_MINUTES_MS).toISOString();
    const responseHmac = await this.challengeHmac({
      challengeId, principalId: verified.principalId, channel, identityId: verified.body.identityId, response,
      initiatingDeviceId: verified.deviceId, initiatingKeyId: verified.keyId,
      initiatingKeyFingerprint: verified.keyFingerprint, initiatingKeyGeneration: verified.keyGeneration,
    });
    await this.deps.beforeChallengeInsert?.();
    const created = await this.repository.createIdentityChallenge({
      challengeId, verified, identityId: verified.body.identityId, channel, responseHmac,
      hmacKeyVersion: this.deps.hmacKeyVersion, expiresAt, createdAt: now.toISOString(),
    });
    if (!created) throw new Error("identity_challenge_not_pending");
    return Object.freeze({ challengeId, response, expiresAt });
  }

  async confirm(observation: VerifiedChannelObservation): Promise<{ readonly identityId: string; readonly state: "active" }> {
    if (!this.deps.observations.isIssued(observation)) throw new Error("channel_observation_untrusted");
    const now = requireNow((this.deps.now ?? (() => new Date()))());
    const row = await this.repository.readIdentityChallenge(observation.challengeId);
    this.checkChallengeState(row, observation, now);
    if (row === null) throw new Error("identity_challenge_not_found");
    if (row.channel === "voice" && observation.pinAuthentication?.authenticated !== true) throw new Error("phone_pin_required");
    if (row.hmac_key_version !== this.deps.hmacKeyVersion) throw new Error("identity_challenge_hmac_key_unavailable");
    const input = this.hmacInput({
      challengeId: row.challenge_id, principalId: row.principal_id, channel: row.channel, identityId: row.identity_id,
      response: observation.response, initiatingDeviceId: row.initiating_device_id, initiatingKeyId: row.initiating_key_id,
      initiatingKeyFingerprint: row.initiating_key_fingerprint, initiatingKeyGeneration: row.initiating_key_generation,
    });
    if (!await crypto.subtle.verify("HMAC", await this.hmacKey, fromHex(row.response_hmac), input)) throw new Error("identity_challenge_mismatch");
    await this.deps.beforeConfirmation?.();
    try {
      const consumed = await this.repository.consumeIdentityChallenge({
        challengeId: row.challenge_id, principalId: row.principal_id, identityId: row.identity_id, channel: row.channel,
        initiatingDeviceId: row.initiating_device_id, initiatingKeyId: row.initiating_key_id,
        initiatingKeyFingerprint: row.initiating_key_fingerprint, initiatingKeyGeneration: row.initiating_key_generation,
        responseHmac: row.response_hmac, hmacKeyVersion: row.hmac_key_version, now: now.toISOString(),
      });
      if (!consumed) throw new Error(await this.confirmationFailure(row.challenge_id, now));
    } catch (error) {
      if (error instanceof Error && error.message.includes("identity_challenge_state_changed")) throw new Error("identity_challenge_state_changed");
      throw error;
    }
    return Object.freeze({ identityId: row.identity_id, state: "active" as const });
  }

  private checkChallengeState(row: IdentityChallengeRow | null, observation: VerifiedChannelObservation, now: Date): void {
    if (row === null) throw new Error("identity_challenge_not_found");
    if (row.consumed_at !== null) throw new Error("identity_challenge_consumed");
    if (row.expires_at <= now.toISOString()) throw new Error("identity_challenge_expired");
    if (observation.principalId !== row.principal_id || observation.identityId !== row.identity_id
      || storedChannel(observation.channel) !== row.channel || observation.initiatingDeviceId !== row.initiating_device_id
      || observation.initiatingKeyId !== row.initiating_key_id || observation.initiatingKeyFingerprint !== row.initiating_key_fingerprint
      || observation.initiatingKeyGeneration !== row.initiating_key_generation) {
      throw new Error("identity_challenge_mismatch");
    }
    if (row.identity_status !== "pending" || row.identity_verified_at !== null || row.principal_status !== "active"
      || row.device_status !== "active" || row.current_key_id !== row.initiating_key_id
      || row.current_key_fingerprint !== row.initiating_key_fingerprint || row.current_key_generation !== row.initiating_key_generation) {
      throw new Error("identity_challenge_state_changed");
    }
    if (observation.channel !== publicChannel(row.channel)) throw new Error("identity_challenge_mismatch");
  }

  private async confirmationFailure(challengeId: string, now: Date): Promise<string> {
    const current = await this.repository.readIdentityChallenge(challengeId);
    if (current?.consumed_at !== null && current?.consumed_at !== undefined) return "identity_challenge_consumed";
    if (current !== null && current.expires_at <= now.toISOString()) return "identity_challenge_expired";
    return "identity_challenge_state_changed";
  }

  private hmacInput(input: {
    challengeId: string; principalId: string; channel: StoredIdentityChannel; identityId: string; response: string;
    initiatingDeviceId: string; initiatingKeyId: string; initiatingKeyFingerprint: string; initiatingKeyGeneration: number;
  }): Uint8Array {
    return encoder.encode(canonicalJson({ domain: "jarvis.identity-challenge.v1", ...input }));
  }

  private async challengeHmac(input: {
    challengeId: string; principalId: string; channel: StoredIdentityChannel; identityId: string; response: string;
    initiatingDeviceId: string; initiatingKeyId: string; initiatingKeyFingerprint: string; initiatingKeyGeneration: number;
  }): Promise<Sha256Hex> {
    return hex(new Uint8Array(await crypto.subtle.sign("HMAC", await this.hmacKey, this.hmacInput(input))));
  }
}

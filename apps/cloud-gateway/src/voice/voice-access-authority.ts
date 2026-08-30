import {
  canonicalJson,
  GUEST_CAPABILITY_IDS,
  newUlid,
  sha256Hex,
  type CallDirection,
  type GuestCapabilityId,
  type RelayBinding,
  type Sha256Hex,
  type Ulid,
  type VoiceResourceScopesV1,
} from "../../../../packages/contracts/src/index.js";
import {
  type PersistedCallAuthority,
  VoiceAccessRepository,
} from "../persistence/voice-access-repository.js";
import { CapabilityRegistry } from "./capability-registry.js";

export interface OwnerCallAuthority {
  readonly authorityId: string;
  readonly kind: "owner";
  readonly sessionId: Ulid;
  readonly principalId: string;
  readonly identityId: string;
  readonly expiresAt: string;
}

export interface GuestCallAuthority {
  readonly authorityId: string;
  readonly kind: "guest";
  readonly sessionId: Ulid;
  readonly principalId: string;
  readonly identityId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly accessDocumentHash: Sha256Hex;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly resourceScopes: VoiceResourceScopesV1;
  readonly expiresAt: string;
}

export type VoiceCallAuthority = OwnerCallAuthority | GuestCallAuthority;

export interface GuestPinAuthenticationProof {
  readonly proofId: string;
  readonly authenticated: true;
  readonly sessionId: Ulid;
  readonly callSid: string;
  readonly relayNonce: string;
  readonly direction: CallDirection;
  readonly principalId: string;
  readonly identityId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly accessDocumentHash: Sha256Hex;
  readonly authenticatedAt: string;
}

export interface IssueGuestPinProofInput {
  readonly sessionId: Ulid;
  readonly callSid: string;
  readonly relayNonce: string;
  readonly direction: CallDirection;
  readonly principalId: string;
  readonly identityId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly accessDocumentHash: Sha256Hex;
  readonly authenticatedAt: Date;
}

interface IssuedAuthority {
  readonly value: VoiceCallAuthority;
  readonly persisted: PersistedCallAuthority;
}

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SAFE_ATOM = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const PROOF_FIELDS = new Set([
  "sessionId", "callSid", "relayNonce", "direction", "principalId", "identityId",
  "grantId", "grantVersion", "accessDocumentHash", "authenticatedAt",
]);
const MINT_OWNER_FIELDS = new Set(["sessionId", "binding", "now"]);
const MINT_GUEST_FIELDS = new Set(["sessionId", "binding", "pinProof", "now"]);
const BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce", "direction",
  "activationOnly", "activationChallengeId", "accessKind", "guestGrantId", "guestGrantVersion",
  "accessDocumentHash",
]);
const GUEST_CAPABILITIES = new Set<string>(GUEST_CAPABILITY_IDS);

function invalidAuthority(): never {
  throw new TypeError("call_authority_invalid");
}

function invalidProof(): never {
  throw new TypeError("guest_pin_authentication_proof_invalid");
}

function captureExact(value: unknown, fields: ReadonlySet<string>, invalid: () => never): Record<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
    keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : [];
  } catch {
    invalid();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) invalid();
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) invalid();
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      invalid();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    captured[field] = descriptor.value;
  }
  return captured;
}

function safeAtom(value: unknown): value is string {
  return typeof value === "string"
    && value.isWellFormed()
    && value === value.normalize("NFC")
    && SAFE_ATOM.test(value);
}

function dateIso(value: unknown, invalid: () => never): string {
  let epochMs: number;
  try {
    epochMs = Date.prototype.getTime.call(value);
  } catch {
    invalid();
  }
  if (!Number.isFinite(epochMs)) invalid();
  return new Date(epochMs).toISOString();
}

function proofInput(value: unknown): Omit<GuestPinAuthenticationProof, "proofId" | "authenticated"> {
  const captured = captureExact(value, PROOF_FIELDS, invalidProof);
  if (
    typeof captured.sessionId !== "string" || !ULID.test(captured.sessionId)
    || typeof captured.callSid !== "string" || !CALL_SID.test(captured.callSid)
    || typeof captured.relayNonce !== "string" || !RELAY_NONCE.test(captured.relayNonce)
    || (captured.direction !== "inbound" && captured.direction !== "outbound")
    || !safeAtom(captured.principalId) || !safeAtom(captured.identityId)
    || typeof captured.grantId !== "string" || !ULID.test(captured.grantId)
    || !Number.isSafeInteger(captured.grantVersion) || (captured.grantVersion as number) <= 0
    || typeof captured.accessDocumentHash !== "string" || !HASH.test(captured.accessDocumentHash)
  ) {
    invalidProof();
  }
  return Object.freeze({
    sessionId: captured.sessionId as Ulid,
    callSid: captured.callSid,
    relayNonce: captured.relayNonce,
    direction: captured.direction,
    principalId: captured.principalId,
    identityId: captured.identityId,
    grantId: captured.grantId,
    grantVersion: captured.grantVersion as number,
    accessDocumentHash: captured.accessDocumentHash as Sha256Hex,
    authenticatedAt: dateIso(captured.authenticatedAt, invalidProof),
  });
}

function relayBinding(value: unknown): RelayBinding {
  const captured = captureExact(value, BINDING_FIELDS, invalidAuthority);
  if (
    typeof captured.callSid !== "string" || !CALL_SID.test(captured.callSid)
    || !safeAtom(captured.principalId) || !safeAtom(captured.identityId) || !safeAtom(captured.destinationIdentityId)
    || typeof captured.relayNonce !== "string" || !RELAY_NONCE.test(captured.relayNonce)
    || (captured.direction !== "inbound" && captured.direction !== "outbound")
    || typeof captured.activationOnly !== "boolean"
    || (captured.activationChallengeId !== null && !safeAtom(captured.activationChallengeId))
    || (captured.accessKind !== "owner" && captured.accessKind !== "guest")
  ) {
    invalidAuthority();
  }
  if (captured.accessKind === "owner") {
    if (captured.guestGrantId !== null || captured.guestGrantVersion !== null || captured.accessDocumentHash !== null) {
      invalidAuthority();
    }
  } else if (
    typeof captured.guestGrantId !== "string" || !ULID.test(captured.guestGrantId)
    || !Number.isSafeInteger(captured.guestGrantVersion) || (captured.guestGrantVersion as number) <= 0
    || typeof captured.accessDocumentHash !== "string" || !HASH.test(captured.accessDocumentHash)
    || captured.activationOnly || captured.activationChallengeId !== null
  ) {
    invalidAuthority();
  }
  return Object.freeze({
    callSid: captured.callSid,
    principalId: captured.principalId,
    identityId: captured.identityId,
    destinationIdentityId: captured.destinationIdentityId,
    relayNonce: captured.relayNonce,
    direction: captured.direction,
    activationOnly: captured.activationOnly,
    activationChallengeId: captured.activationChallengeId,
    accessKind: captured.accessKind,
    guestGrantId: captured.guestGrantId as string | null,
    guestGrantVersion: captured.guestGrantVersion as number | null,
    accessDocumentHash: captured.accessDocumentHash as string | null,
  });
}

/** Trusted authentication components hold this issuer; untrusted values never do. */
export class GuestPinProofIssuer {
  readonly #issued = new WeakMap<object, GuestPinAuthenticationProof>();

  issue(input: IssueGuestPinProofInput): GuestPinAuthenticationProof {
    const captured = proofInput(input);
    const proof: GuestPinAuthenticationProof = Object.freeze({
      proofId: `guest-pin-proof:${crypto.randomUUID()}`,
      authenticated: true,
      ...captured,
    });
    this.#issued.set(proof, proof);
    return proof;
  }

  snapshot(value: unknown): GuestPinAuthenticationProof {
    const proof = value !== null && typeof value === "object" ? this.#issued.get(value) : undefined;
    if (proof === undefined || proof !== value || !Object.isFrozen(value)) invalidProof();
    return proof;
  }
}

export class VoiceAccessAuthorityService {
  readonly #repository: VoiceAccessRepository;
  readonly #registry: CapabilityRegistry;
  readonly #proofs: GuestPinProofIssuer;
  readonly #issued = new WeakMap<object, IssuedAuthority>();

  constructor(
    repository: VoiceAccessRepository,
    registry: CapabilityRegistry,
    proofs: GuestPinProofIssuer = new GuestPinProofIssuer(),
  ) {
    if (!(repository instanceof VoiceAccessRepository) || !(registry instanceof CapabilityRegistry)
      || !(proofs instanceof GuestPinProofIssuer)) {
      throw new TypeError("voice_access_authority_configuration_invalid");
    }
    this.#repository = repository;
    this.#registry = registry;
    this.#proofs = proofs;
  }

  #remember<T extends VoiceCallAuthority>(value: T, persisted: PersistedCallAuthority): T {
    const issued: IssuedAuthority = Object.freeze({ value, persisted });
    this.#issued.set(value, issued);
    return value;
  }

  async mintOwner(input: {
    sessionId: Ulid;
    binding: RelayBinding;
    now: Date;
  }): Promise<OwnerCallAuthority> {
    const captured = captureExact(input, MINT_OWNER_FIELDS, invalidAuthority);
    if (typeof captured.sessionId !== "string" || !ULID.test(captured.sessionId)) invalidAuthority();
    const binding = relayBinding(captured.binding);
    if (binding.accessKind !== "owner") invalidAuthority();
    dateIso(captured.now, invalidAuthority);
    const persisted = await this.#repository.mintOwnerAuthority({
      sessionId: captured.sessionId as Ulid,
      binding,
      now: captured.now as Date,
    });
    const authority: OwnerCallAuthority = Object.freeze({
      authorityId: `call-authority:${crypto.randomUUID()}`,
      kind: "owner",
      sessionId: persisted.sessionId,
      principalId: persisted.principalId,
      identityId: persisted.identityId,
      expiresAt: persisted.expiresAt,
    });
    return this.#remember(authority, persisted);
  }

  async mintGuest(input: {
    sessionId: Ulid;
    binding: RelayBinding;
    pinProof: GuestPinAuthenticationProof;
    now: Date;
  }): Promise<GuestCallAuthority> {
    const captured = captureExact(input, MINT_GUEST_FIELDS, invalidAuthority);
    if (typeof captured.sessionId !== "string" || !ULID.test(captured.sessionId)) invalidAuthority();
    const binding = relayBinding(captured.binding);
    if (binding.accessKind !== "guest" || binding.guestGrantId === null || binding.guestGrantVersion === null
      || binding.accessDocumentHash === null) {
      invalidAuthority();
    }
    const nowIso = dateIso(captured.now, invalidAuthority);
    const proof = this.#proofs.snapshot(captured.pinProof);
    if (
      proof.sessionId !== captured.sessionId || proof.callSid !== binding.callSid
      || proof.relayNonce !== binding.relayNonce || proof.direction !== binding.direction
      || proof.principalId !== binding.principalId || proof.identityId !== binding.identityId
      || proof.grantId !== binding.guestGrantId || proof.grantVersion !== binding.guestGrantVersion
      || proof.accessDocumentHash !== binding.accessDocumentHash || proof.authenticatedAt > nowIso
    ) {
      invalidProof();
    }
    const activationRequestHash = await sha256Hex(canonicalJson([
      "jarvis.voice-access.activation", "1.0", captured.sessionId, proof.proofId,
      proof.grantId, proof.grantVersion, proof.accessDocumentHash,
    ]));
    const persisted = await this.#repository.mintGuestAuthority({
      sessionId: captured.sessionId as Ulid,
      binding,
      activationEventId: newUlid(captured.now as Date),
      activationRequestHash,
      now: captured.now as Date,
    });
    const grant = await this.#repository.getGuestGrant(proof.grantId);
    if (
      grant === null || grant.status !== "active" || grant.grantVersion !== proof.grantVersion
      || grant.accessDocumentHash !== proof.accessDocumentHash
    ) {
      throw new Error("call_authority_stale");
    }
    const authority: GuestCallAuthority = Object.freeze({
      authorityId: `call-authority:${crypto.randomUUID()}`,
      kind: "guest",
      sessionId: persisted.sessionId,
      principalId: persisted.principalId,
      identityId: persisted.identityId,
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      accessDocumentHash: grant.accessDocumentHash,
      capabilityIds: grant.capabilityIds,
      resourceScopes: grant.resourceScopes,
      expiresAt: persisted.expiresAt,
    });
    return this.#remember(authority, persisted);
  }

  snapshot(value: unknown): VoiceCallAuthority {
    const issued = value !== null && typeof value === "object" ? this.#issued.get(value) : undefined;
    if (issued === undefined || issued.value !== value || !Object.isFrozen(value)) invalidAuthority();
    return issued.value;
  }

  async authorize(value: unknown, capabilityId: string, now: Date): Promise<VoiceCallAuthority> {
    const authority = this.snapshot(value);
    const issued = this.#issued.get(authority);
    if (issued === undefined) invalidAuthority();
    const nowIso = dateIso(now, invalidAuthority);
    if (authority.expiresAt <= nowIso) throw new Error("call_authority_expired");
    if (typeof capabilityId !== "string") throw new TypeError("capability_unknown");
    if (authority.kind === "owner") {
      if (!this.#registry.isInstalled(capabilityId)) throw new Error("capability_not_installed");
    } else {
      if (!GUEST_CAPABILITIES.has(capabilityId)) {
        this.#registry.resolve([capabilityId]);
        throw new Error("capability_not_grantable");
      }
      this.#registry.resolve([capabilityId]);
      if (!authority.capabilityIds.includes(capabilityId as GuestCapabilityId)) throw new Error("capability_denied");
    }
    await this.#repository.requireCurrentAuthority(issued.persisted, now);
    return authority;
  }

  invalidate(value: unknown): void {
    if (value !== null && typeof value === "object") this.#issued.delete(value);
  }
}

import {
  canonicalJson,
  GUEST_CAPABILITY_IDS,
  sha256Hex,
  type GuestCapabilityId,
  type RelayBinding,
  type Sha256Hex,
  type Ulid,
  type VoiceResourceScopesV1,
} from "../../../../packages/contracts/src/index.js";
import {
  decodeGuestPinVerifierRecord,
  type GuestPinVerifierRecordV2,
} from "../security/guest-pin-verifier.js";
import { TransactionRunner } from "./transaction.js";

export type VoiceAccessCandidate =
  | Readonly<{
    kind: "owner";
    principalId: string;
    identityId: string;
    activationChallengeId: string | null;
  }>
  | Readonly<{
    kind: "guest";
    principalId: string;
    identityId: string;
    grantId: string;
    grantVersion: number;
    accessDocumentHash: Sha256Hex;
    status: "pending" | "active";
    pinVerifier: GuestPinVerifierRecordV2;
  }>;

export interface PersistedCallAuthority {
  readonly sessionId: Ulid;
  readonly kind: "owner" | "guest";
  readonly principalId: string;
  readonly identityId: string;
  readonly grantId: string | null;
  readonly grantVersion: number | null;
  readonly accessDocumentHash: Sha256Hex | null;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

export interface GuestGrantSnapshot {
  readonly grantId: string;
  readonly principalId: string;
  readonly identityId: string;
  readonly providerE164: string;
  readonly grantVersion: number;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly resourceScopes: VoiceResourceScopesV1;
  readonly accessDocumentHash: Sha256Hex;
  readonly status: "pending" | "active" | "revoked";
  readonly pinVerifier: GuestPinVerifierRecordV2;
  readonly createdByIdentityId: string;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

export interface MaskedGuestGrant {
  readonly identityId: string;
  readonly status: "pending" | "active" | "revoked";
  readonly grantVersion: number;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly maskedNumber: string;
}

export interface CreateGuestGrantInput {
  readonly mutationId: Ulid;
  readonly requestHash: Sha256Hex;
  readonly ownerAuthority: PersistedCallAuthority;
  readonly ownerIdentityId: string;
  readonly grantId: string;
  readonly guestPrincipalId: string;
  readonly guestIdentityId: string;
  readonly providerE164: string;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly resourceScopes: VoiceResourceScopesV1;
  readonly accessDocumentHash: Sha256Hex;
  readonly pinVerifier: GuestPinVerifierRecordV2;
  readonly now: Date;
}

export interface ReplaceGuestPermissionsInput {
  readonly mutationId: Ulid;
  readonly requestHash: Sha256Hex;
  readonly ownerAuthority: PersistedCallAuthority;
  readonly ownerIdentityId: string;
  readonly grantId: string;
  readonly expectedGrantVersion: number;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly resourceScopes: VoiceResourceScopesV1;
  readonly accessDocumentHash: Sha256Hex;
  readonly now: Date;
}

export interface RotateGuestPinInput {
  readonly mutationId: Ulid;
  readonly requestHash: Sha256Hex;
  readonly ownerAuthority: PersistedCallAuthority;
  readonly ownerIdentityId: string;
  readonly grantId: string;
  readonly expectedGrantVersion: number;
  readonly pinVerifier: GuestPinVerifierRecordV2;
  readonly now: Date;
}

export interface RevokeGuestGrantInput {
  readonly mutationId: Ulid;
  readonly requestHash: Sha256Hex;
  readonly ownerAuthority: PersistedCallAuthority;
  readonly ownerIdentityId: string;
  readonly grantId: string;
  readonly expectedGrantVersion: number;
  readonly now: Date;
}

export interface MintOwnerAuthorityInput {
  readonly sessionId: Ulid;
  readonly binding: RelayBinding;
  readonly now: Date;
}

export interface MintGuestAuthorityInput {
  readonly sessionId: Ulid;
  readonly binding: RelayBinding;
  readonly activationEventId: Ulid;
  readonly activationRequestHash: Sha256Hex;
  readonly now: Date;
}

export interface VoiceAccessDocumentVerificationInput {
  readonly providerE164: string;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly resourceScopes: VoiceResourceScopesV1;
  readonly accessDocumentHash: Sha256Hex;
}

export type VoiceAccessDocumentVerifier = (
  document: VoiceAccessDocumentVerificationInput,
) => boolean | Promise<boolean>;

export interface VoiceAccessRepositoryHooks {
  readonly beforeEventWrite?: () => void | Promise<void>;
  readonly batchFault?: (
    operation: "create" | "replace" | "rotate" | "revoke" | "activate",
  ) => D1PreparedStatement | null;
  readonly accessDocumentVerifier?: VoiceAccessDocumentVerifier;
}

interface GrantRow {
  grant_id: string;
  principal_id: string;
  identity_id: string;
  provider_subject: string;
  grant_version: number;
  capability_ids_json: string;
  resource_scopes_json: string;
  access_document_hash: string;
  pin_schema_version: string;
  pin_algorithm: string;
  pin_pepper_version: string;
  pin_iterations: number;
  pin_salt_base64: string;
  pin_digest_base64: string;
  status: string;
  created_by_identity_id: string;
  created_at: string;
  activated_at: string | null;
  updated_at: string;
  revoked_at: string | null;
}

interface IdentityRow {
  principal_id: string;
  identity_id: string;
  provider_subject: string;
  identity_status: string;
  verified_at: string | null;
  principal_status: string;
  owner_principal_id: string | null;
  owner_identity_id: string | null;
}

interface ConfiguredOwnerRow {
  principal_id: string;
  identity_id: string;
  principal_type: string;
  principal_status: string;
  identity_status: string;
  verified_at: string | null;
}

interface ChallengeRow {
  challenge_id: string;
}

interface EventRow {
  event_id: string;
  grant_id: string;
  event_type: string;
  request_hash: string;
}

interface AuthorityRow {
  session_id: string;
  authority_kind: string;
  principal_id: string;
  identity_id: string;
  grant_id: string | null;
  grant_version: number | null;
  access_document_hash: string | null;
  authenticated_at: string;
  expires_at: string;
  provider_connected_at: string | null;
  phase: string;
  call_sid: string;
  destination_identity_id: string;
  relay_nonce: string;
  direction: string;
  activation_only: number;
  activation_challenge_id: string | null;
  access_kind: string | null;
  session_grant_id: string | null;
  session_grant_version: number | null;
  session_access_document_hash: string | null;
  owner_principal_id: string | null;
  owner_identity_id: string | null;
  principal_status: string;
  identity_status: string;
  verified_at: string | null;
  current_grant_version: number | null;
  current_access_document_hash: string | null;
  current_grant_status: string | null;
  step_up_requirement: string | null;
  step_up_attestation_class: string | null;
  step_up_policy: string | null;
  step_up_success_version: number | null;
  current_owner_verifier_version: number | null;
  current_owner_head_status: string | null;
  current_owner_verifier_status: string | null;
}

interface SessionLineageRow {
  session_id: string;
  call_sid: string;
  principal_id: string;
  identity_id: string;
  destination_identity_id: string;
  relay_nonce: string;
  direction: string;
  activation_only: number;
  activation_challenge_id: string | null;
  phase: string;
  created_at: string;
  access_kind: string | null;
  guest_grant_id: string | null;
  guest_grant_version: number | null;
  access_document_hash: string | null;
  provider_connected_at: string | null;
}

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const TERMINAL_PHASES = new Set(["completed", "rejected", "failed", "expired"]);
const GUEST_CAPABILITIES = new Set<string>(GUEST_CAPABILITY_IDS);
const RESOURCE_CAPABILITIES = new Set<GuestCapabilityId>([
  "calendar.read",
  "calendar.manage",
  "files.read",
  "files.write",
  "pc.control",
]);
const CAPABILITY_ORDER = new Map(GUEST_CAPABILITY_IDS.map((value, index) => [value, index]));
const SCOPE_FIELDS = new Set(["schemaVersion", "calendarConnectionIds", "fileRootIds", "pcActionIds"]);
const AUTHORITY_FIELDS = new Set([
  "sessionId", "kind", "principalId", "identityId", "grantId", "grantVersion",
  "accessDocumentHash", "authenticatedAt", "expiresAt",
]);
const BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce", "direction",
  "activationOnly", "activationChallengeId", "accessKind", "guestGrantId", "guestGrantVersion",
  "accessDocumentHash",
]);

function invalidInput(): never {
  throw new TypeError("voice_access_input_invalid");
}

function captureExact(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
    keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : [];
  } catch {
    invalidInput();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) {
    invalidInput();
  }
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    invalidInput();
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      invalidInput();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidInput();
    captured[field] = descriptor.value;
  }
  return captured;
}

function safeId(value: unknown): value is string {
  return typeof value === "string"
    && value.isWellFormed()
    && value === value.normalize("NFC")
    && SAFE_ID.test(value);
}

function dateIso(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) invalidInput();
  return value.toISOString();
}

function providerAuthorityDeadline(value: string | null): string | null {
  if (value === null) return null;
  const connectedAt = new Date(value);
  if (!Number.isFinite(connectedAt.valueOf()) || connectedAt.toISOString() !== value) return null;
  return new Date(connectedAt.valueOf() + 1_800_000).toISOString();
}

function hash(value: unknown): Sha256Hex {
  if (typeof value !== "string" || !HASH.test(value)) invalidInput();
  return value as Sha256Hex;
}

function ulid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) invalidInput();
  return value as Ulid;
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidInput();
  return value as number;
}

function captureStringArray(value: unknown, validate: (item: string) => boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) invalidInput();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidInput();
    const item = descriptor.value;
    if (typeof item !== "string" || !item.isWellFormed() || item !== item.normalize("NFC") || !validate(item)) {
      invalidInput();
    }
    result.push(item);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "length" && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)))) {
    invalidInput();
  }
  return result;
}

function capabilities(value: unknown): readonly GuestCapabilityId[] {
  const result = captureStringArray(value, (item) => GUEST_CAPABILITIES.has(item)) as GuestCapabilityId[];
  if (new Set(result).size !== result.length) invalidInput();
  for (let index = 1; index < result.length; index += 1) {
    const previous = CAPABILITY_ORDER.get(result[index - 1] ?? "") ?? -1;
    const current = CAPABILITY_ORDER.get(result[index] ?? "") ?? -1;
    if (previous >= current) invalidInput();
  }
  return Object.freeze([...result]);
}

function scopes(value: unknown): VoiceResourceScopesV1 {
  const captured = captureExact(value, SCOPE_FIELDS);
  if (captured.schemaVersion !== "1.0") invalidInput();
  const captureIds = (input: unknown) => Object.freeze(captureStringArray(input, (item) =>
    /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(item) && !item.includes("*") && !item.includes("/") && !item.includes("\\"),
  ));
  const calendarConnectionIds = captureIds(captured.calendarConnectionIds);
  const fileRootIds = captureIds(captured.fileRootIds);
  const pcActionIds = captureIds(captured.pcActionIds);
  const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();
  if (
    JSON.stringify(calendarConnectionIds) !== JSON.stringify(sortedUnique(calendarConnectionIds))
    || JSON.stringify(fileRootIds) !== JSON.stringify(sortedUnique(fileRootIds))
    || JSON.stringify(pcActionIds) !== JSON.stringify(sortedUnique(pcActionIds))
  ) {
    invalidInput();
  }
  return Object.freeze({ schemaVersion: "1.0", calendarConnectionIds, fileRootIds, pcActionIds });
}

function verifier(value: unknown): GuestPinVerifierRecordV2 {
  try {
    return decodeGuestPinVerifierRecord(value);
  } catch {
    invalidInput();
  }
}

function persistedAuthority(value: unknown): PersistedCallAuthority {
  const captured = captureExact(value, AUTHORITY_FIELDS);
  const sessionId = ulid(captured.sessionId);
  if (captured.kind !== "owner" && captured.kind !== "guest") invalidInput();
  if (!safeId(captured.principalId) || !safeId(captured.identityId)) invalidInput();
  if (typeof captured.authenticatedAt !== "string" || typeof captured.expiresAt !== "string") invalidInput();
  const authenticatedAt = new Date(captured.authenticatedAt);
  const expiresAt = new Date(captured.expiresAt);
  if (
    !Number.isFinite(authenticatedAt.valueOf()) || authenticatedAt.toISOString() !== captured.authenticatedAt
    || !Number.isFinite(expiresAt.valueOf()) || expiresAt.toISOString() !== captured.expiresAt
    || expiresAt <= authenticatedAt
  ) {
    invalidInput();
  }
  if (captured.kind === "owner") {
    if (captured.grantId !== null || captured.grantVersion !== null || captured.accessDocumentHash !== null) invalidInput();
  } else {
    ulid(captured.grantId);
    positiveVersion(captured.grantVersion);
    hash(captured.accessDocumentHash);
  }
  return Object.freeze({
    sessionId,
    kind: captured.kind,
    principalId: captured.principalId,
    identityId: captured.identityId,
    grantId: captured.grantId as string | null,
    grantVersion: captured.grantVersion as number | null,
    accessDocumentHash: captured.accessDocumentHash as Sha256Hex | null,
    authenticatedAt: captured.authenticatedAt,
    expiresAt: captured.expiresAt,
  });
}

function binding(value: unknown): RelayBinding {
  const captured = captureExact(value, BINDING_FIELDS);
  if (
    typeof captured.callSid !== "string" || !CALL_SID.test(captured.callSid)
    || !safeId(captured.principalId) || !safeId(captured.identityId) || !safeId(captured.destinationIdentityId)
    || typeof captured.relayNonce !== "string" || !RELAY_NONCE.test(captured.relayNonce)
    || (captured.direction !== "inbound" && captured.direction !== "outbound")
    || typeof captured.activationOnly !== "boolean"
    || (captured.activationChallengeId !== null && !safeId(captured.activationChallengeId))
    || (captured.accessKind !== "owner" && captured.accessKind !== "guest")
  ) {
    invalidInput();
  }
  if (captured.accessKind === "owner") {
    if (captured.guestGrantId !== null || captured.guestGrantVersion !== null || captured.accessDocumentHash !== null) {
      invalidInput();
    }
  } else {
    ulid(captured.guestGrantId);
    positiveVersion(captured.guestGrantVersion);
    hash(captured.accessDocumentHash);
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("voice_access_data_invalid");
  }
}

function decodeGrantRow(row: GrantRow): GuestGrantSnapshot {
  if (
    !ULID.test(row.grant_id) || !safeId(row.principal_id) || !safeId(row.identity_id)
    || !E164.test(row.provider_subject) || !Number.isSafeInteger(row.grant_version) || row.grant_version <= 0
    || !HASH.test(row.access_document_hash)
    || !["pending", "active", "revoked"].includes(row.status)
    || !safeId(row.created_by_identity_id)
  ) {
    throw new Error("voice_access_data_invalid");
  }
  let capabilityIds: readonly GuestCapabilityId[];
  let resourceScopes: VoiceResourceScopesV1;
  let pinVerifier: GuestPinVerifierRecordV2;
  try {
    capabilityIds = capabilities(parseJson(row.capability_ids_json));
    resourceScopes = scopes(parseJson(row.resource_scopes_json));
    pinVerifier = decodeGuestPinVerifierRecord({
      schemaVersion: row.pin_schema_version,
      algorithm: row.pin_algorithm,
      pepperVersion: row.pin_pepper_version,
      iterations: row.pin_iterations,
      saltBase64: row.pin_salt_base64,
      digestBase64: row.pin_digest_base64,
    });
  } catch {
    throw new Error("voice_access_data_invalid");
  }
  return Object.freeze({
    grantId: row.grant_id,
    principalId: row.principal_id,
    identityId: row.identity_id,
    providerE164: row.provider_subject,
    grantVersion: row.grant_version,
    capabilityIds,
    resourceScopes,
    accessDocumentHash: row.access_document_hash as Sha256Hex,
    status: row.status as "pending" | "active" | "revoked",
    pinVerifier,
    createdByIdentityId: row.created_by_identity_id,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  });
}

function maskNumber(value: string): string {
  if (!E164.test(value)) throw new Error("voice_access_data_invalid");
  const visiblePrefix = value.slice(0, Math.min(2, value.length - 4));
  return `${visiblePrefix}${"*".repeat(value.length - visiblePrefix.length - 4)}${value.slice(-4)}`;
}

function issueAuthority(row: Pick<AuthorityRow,
  "session_id" | "authority_kind" | "principal_id" | "identity_id" | "grant_id" | "grant_version"
  | "access_document_hash" | "authenticated_at" | "expires_at"
>): PersistedCallAuthority {
  if (!ULID.test(row.session_id) || (row.authority_kind !== "owner" && row.authority_kind !== "guest")) {
    throw new Error("call_authority_invalid");
  }
  return Object.freeze({
    sessionId: row.session_id as Ulid,
    kind: row.authority_kind,
    principalId: row.principal_id,
    identityId: row.identity_id,
    grantId: row.grant_id,
    grantVersion: row.grant_version,
    accessDocumentHash: row.access_document_hash as Sha256Hex | null,
    authenticatedAt: row.authenticated_at,
    expiresAt: row.expires_at,
  });
}

const GRANT_SELECT = `SELECT
  grant_row.grant_id, grant_row.principal_id, grant_row.identity_id, identity.provider_subject,
  grant_row.grant_version, grant_row.capability_ids_json, grant_row.resource_scopes_json,
  grant_row.access_document_hash, grant_row.pin_schema_version, grant_row.pin_algorithm,
  grant_row.pin_pepper_version, grant_row.pin_iterations, grant_row.pin_salt_base64,
  grant_row.pin_digest_base64, grant_row.status, grant_row.created_by_identity_id,
  grant_row.created_at, grant_row.activated_at, grant_row.updated_at, grant_row.revoked_at
FROM voice_access_grants grant_row
JOIN channel_identities identity ON identity.identity_id = grant_row.identity_id`;

const AUTHORITY_SELECT = `SELECT
  authority.session_id, authority.authority_kind, authority.principal_id, authority.identity_id,
  authority.grant_id, authority.grant_version, authority.access_document_hash,
  authority.authenticated_at, authority.expires_at,
  session.provider_connected_at,
  session.phase, session.call_sid, session.destination_identity_id, session.relay_nonce,
  session.direction, session.activation_only, session.activation_challenge_id,
  session.access_kind, session.guest_grant_id AS session_grant_id,
  session.guest_grant_version AS session_grant_version,
  session.access_document_hash AS session_access_document_hash,
  owner.principal_id AS owner_principal_id, owner.identity_id AS owner_identity_id,
  principal.status AS principal_status, identity.status AS identity_status, identity.verified_at,
  current_grant.grant_version AS current_grant_version,
  current_grant.access_document_hash AS current_access_document_hash,
  current_grant.status AS current_grant_status,
  step_up.requirement AS step_up_requirement,
  step_up.attestation_class AS step_up_attestation_class,
  step_up.policy AS step_up_policy,
  step_up_success.verifier_version AS step_up_success_version,
  owner_head.verifier_version AS current_owner_verifier_version,
  owner_head.status AS current_owner_head_status,
  owner_verifier.status AS current_owner_verifier_status
FROM call_session_authorities authority
JOIN call_sessions session ON session.session_id = authority.session_id
JOIN principals principal ON principal.principal_id = authority.principal_id
JOIN channel_identities identity ON identity.identity_id = authority.identity_id
LEFT JOIN voice_owner_identity owner ON owner.singleton_id = 1
LEFT JOIN voice_access_grants current_grant ON current_grant.grant_id = authority.grant_id
LEFT JOIN owner_call_step_up_bindings step_up ON step_up.session_id = authority.session_id
LEFT JOIN owner_call_step_up_successes step_up_success ON step_up_success.session_id = authority.session_id
LEFT JOIN owner_passphrase_heads owner_head ON owner_head.singleton_id = 1
LEFT JOIN owner_passphrase_verifiers owner_verifier
  ON owner_verifier.owner_identity_id = owner_head.owner_identity_id
  AND owner_verifier.verifier_version = owner_head.verifier_version`;

const OWNER_MUTATION_AUTHORITY_GUARD = `EXISTS (
  SELECT 1
  FROM call_session_authorities mutation_authority
  JOIN call_sessions mutation_session
    ON mutation_session.session_id = mutation_authority.session_id
    AND mutation_session.principal_id = mutation_authority.principal_id
    AND mutation_session.identity_id = mutation_authority.identity_id
  JOIN voice_owner_identity mutation_owner
    ON mutation_owner.singleton_id = 1
    AND mutation_owner.principal_id = mutation_authority.principal_id
    AND mutation_owner.identity_id = mutation_authority.identity_id
  JOIN principals mutation_principal
    ON mutation_principal.principal_id = mutation_authority.principal_id
  JOIN channel_identities mutation_identity
    ON mutation_identity.identity_id = mutation_authority.identity_id
    AND mutation_identity.principal_id = mutation_authority.principal_id
    AND mutation_identity.channel = 'voice'
  WHERE mutation_authority.session_id = ?
    AND mutation_authority.authority_kind = 'owner'
    AND mutation_authority.principal_id = ?
    AND mutation_authority.identity_id = ?
    AND mutation_authority.grant_id IS NULL
    AND mutation_authority.grant_version IS NULL
    AND mutation_authority.access_document_hash IS NULL
    AND mutation_authority.authenticated_at = ?
    AND mutation_authority.expires_at = ?
    AND mutation_authority.expires_at > ?
    AND mutation_session.phase IN ('authenticated', 'active')
    AND mutation_session.access_kind = 'owner'
    AND mutation_session.guest_grant_id IS NULL
    AND mutation_session.guest_grant_version IS NULL
    AND mutation_session.access_document_hash IS NULL
    AND mutation_session.provider_session_id IS NOT NULL
    AND mutation_session.provider_connected_at IS NOT NULL
    AND mutation_authority.authenticated_at >= mutation_session.provider_connected_at
    AND mutation_authority.expires_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', mutation_session.provider_connected_at, '+1800 seconds'
    )
    AND mutation_owner.identity_id = ?
    AND mutation_principal.principal_type = 'human'
    AND mutation_principal.status = 'active'
    AND mutation_identity.status = 'active'
    AND mutation_identity.verified_at IS NOT NULL
)`;

function ownerMutationGuardBindings(
  authority: PersistedCallAuthority,
  ownerIdentityId: string,
  nowIso: string,
) {
  return [
    authority.sessionId,
    authority.principalId,
    authority.identityId,
    authority.authenticatedAt,
    authority.expiresAt,
    nowIso,
    ownerIdentityId,
  ] as const;
}

export class VoiceAccessRepository {
  readonly #database: D1Database;
  readonly #transactions: TransactionRunner;
  readonly #beforeEventWrite: (() => void | Promise<void>) | undefined;
  readonly #batchFault: VoiceAccessRepositoryHooks["batchFault"];
  readonly #accessDocumentVerifier: VoiceAccessDocumentVerifier | undefined;
  readonly #issuedAuthorities = new WeakSet<object>();

  constructor(database: D1Database, hooks: Readonly<VoiceAccessRepositoryHooks> = {}) {
    if (database === null || typeof database !== "object") invalidInput();
    const allowedHookFields = new Set(["beforeEventWrite", "batchFault", "accessDocumentVerifier"]);
    let beforeEventWrite: (() => void | Promise<void>) | undefined;
    let batchFault: VoiceAccessRepositoryHooks["batchFault"];
    let accessDocumentVerifier: VoiceAccessDocumentVerifier | undefined;
    const hookKeys = Reflect.ownKeys(hooks);
    if (hookKeys.length > 0) {
      if (hookKeys.some((key) => typeof key !== "string" || !allowedHookFields.has(key))) invalidInput();
      const captured = captureExact(hooks, new Set(hookKeys as string[]));
      if (captured.beforeEventWrite !== undefined && typeof captured.beforeEventWrite !== "function") invalidInput();
      if (captured.batchFault !== undefined && typeof captured.batchFault !== "function") invalidInput();
      if (captured.accessDocumentVerifier !== undefined && typeof captured.accessDocumentVerifier !== "function") invalidInput();
      beforeEventWrite = captured.beforeEventWrite as (() => void | Promise<void>) | undefined;
      batchFault = captured.batchFault as VoiceAccessRepositoryHooks["batchFault"];
      accessDocumentVerifier = captured.accessDocumentVerifier as VoiceAccessDocumentVerifier | undefined;
    }
    this.#database = database;
    this.#transactions = new TransactionRunner(database);
    this.#beforeEventWrite = beforeEventWrite;
    this.#batchFault = batchFault;
    this.#accessDocumentVerifier = accessDocumentVerifier;
  }

  #faultStatement(operation: "create" | "replace" | "rotate" | "revoke" | "activate"): D1PreparedStatement | null {
    const statement = this.#batchFault?.(operation) ?? null;
    if (statement !== null && typeof statement !== "object") invalidInput();
    return statement;
  }

  async #verifyAccessDocument(document: VoiceAccessDocumentVerificationInput): Promise<void> {
    const computedHash = await sha256Hex(canonicalJson({
      capabilityIds: document.capabilityIds,
      resourceScopes: document.resourceScopes,
    }));
    if (computedHash !== document.accessDocumentHash) throw new Error("voice_access_document_invalid");
    const hasResourceScope = document.resourceScopes.calendarConnectionIds.length > 0
      || document.resourceScopes.fileRootIds.length > 0
      || document.resourceScopes.pcActionIds.length > 0;
    const requiresTargetVerification = hasResourceScope
      || document.capabilityIds.some((capability) => RESOURCE_CAPABILITIES.has(capability));
    if (this.#accessDocumentVerifier === undefined) {
      if (requiresTargetVerification) throw new Error("voice_access_document_invalid");
      return;
    }
    try {
      if (await this.#accessDocumentVerifier(Object.freeze({ ...document })) !== true) {
        throw new Error("voice_access_document_invalid");
      }
    } catch {
      throw new Error("voice_access_document_invalid");
    }
  }

  async #grant(grantId: string): Promise<GuestGrantSnapshot | null> {
    const row = await this.#database.prepare(`${GRANT_SELECT} WHERE grant_row.grant_id = ?`).bind(grantId).first<GrantRow>();
    if (row === null) return null;
    const grant = decodeGrantRow(row);
    await this.#verifyAccessDocument(grant);
    return grant;
  }

  async getGuestGrant(grantIdValue: string): Promise<GuestGrantSnapshot | null> {
    const grantId = ulid(grantIdValue);
    return this.#grant(grantId);
  }

  async getGuestGrantByProviderE164(providerE164Value: string): Promise<GuestGrantSnapshot | null> {
    if (typeof providerE164Value !== "string" || !E164.test(providerE164Value)) invalidInput();
    const row = await this.#database.prepare(`${GRANT_SELECT}
      WHERE identity.channel = 'voice' AND identity.provider_subject = ?
      ORDER BY grant_row.grant_version DESC LIMIT 1`)
      .bind(providerE164Value).first<GrantRow>();
    if (row === null) return null;
    const grant = decodeGrantRow(row);
    await this.#verifyAccessDocument(grant);
    return grant;
  }

  async #configuredOwner(ownerIdentityId: string): Promise<ConfiguredOwnerRow | null> {
    const row = await this.#database.prepare(`SELECT
      owner.principal_id, owner.identity_id, principal.principal_type,
      principal.status AS principal_status, identity.status AS identity_status, identity.verified_at
    FROM voice_owner_identity owner
    JOIN principals principal ON principal.principal_id = owner.principal_id
    JOIN channel_identities identity
      ON identity.identity_id = owner.identity_id
      AND identity.principal_id = owner.principal_id
      AND identity.channel = 'voice'
    WHERE owner.singleton_id = 1 AND owner.identity_id = ?`)
      .bind(ownerIdentityId).first<ConfiguredOwnerRow>();
    if (
      row === null || row.identity_id !== ownerIdentityId || row.principal_type !== "human"
      || row.principal_status !== "active"
      || !(
        row.identity_status === "active" && row.verified_at !== null
        || row.identity_status === "pending" && row.verified_at === null
      )
    ) {
      return null;
    }
    return row;
  }

  async #eventReplay(
    eventId: Ulid,
    requestHash: Sha256Hex,
    grantId: string,
    eventType: string,
  ): Promise<GuestGrantSnapshot | null> {
    const row = await this.#database.prepare(
      "SELECT event_id, grant_id, event_type, request_hash FROM voice_access_grant_events WHERE event_id = ?",
    ).bind(eventId).first<EventRow>();
    if (row === null) return null;
    if (row.request_hash !== requestHash || row.grant_id !== grantId || row.event_type !== eventType) {
      throw new Error("voice_access_mutation_conflict");
    }
    const snapshot = await this.#grant(grantId);
    if (snapshot === null) throw new Error("voice_access_data_invalid");
    return snapshot;
  }

  async #requireOwnerAuthority(
    value: unknown,
    ownerIdentityIdValue: unknown,
    nowValue: unknown,
  ): Promise<PersistedCallAuthority> {
    if (value === null || typeof value !== "object" || !this.#issuedAuthorities.has(value)) {
      throw new Error("owner_authority_required");
    }
    const authority = persistedAuthority(value);
    const ownerIdentityId = ownerIdentityIdValue;
    const nowIso = dateIso(nowValue);
    if (authority.kind !== "owner" || !safeId(ownerIdentityId)) throw new Error("owner_authority_required");
    const row = await this.#database.prepare(`${AUTHORITY_SELECT} WHERE authority.session_id = ?`)
      .bind(authority.sessionId).first<AuthorityRow>();
    if (
      row === null || row.authority_kind !== "owner"
      || row.principal_id !== authority.principalId || row.identity_id !== authority.identityId
      || row.grant_id !== null || row.grant_version !== null || row.access_document_hash !== null
      || row.authenticated_at !== authority.authenticatedAt || row.expires_at !== authority.expiresAt
      || row.owner_identity_id !== ownerIdentityId || row.owner_identity_id !== authority.identityId
      || row.owner_principal_id !== authority.principalId
      || row.principal_status !== "active" || row.identity_status !== "active" || row.verified_at === null
      || TERMINAL_PHASES.has(row.phase) || !["authenticated", "active"].includes(row.phase)
      || row.expires_at <= nowIso
    ) {
      throw new Error("owner_authority_required");
    }
    return authority;
  }

  async resolveInboundCandidate(input: {
    providerE164: string;
    ownerIdentityId: string;
    challengeHmacKeyVersion: string;
    now: Date;
  }): Promise<VoiceAccessCandidate | null> {
    const captured = captureExact(input, new Set(["providerE164", "ownerIdentityId", "challengeHmacKeyVersion", "now"]));
    if (
      typeof captured.providerE164 !== "string" || !E164.test(captured.providerE164)
      || !safeId(captured.ownerIdentityId) || !safeId(captured.challengeHmacKeyVersion)
    ) {
      invalidInput();
    }
    const nowIso = dateIso(captured.now);
    const configuredOwner = await this.#configuredOwner(captured.ownerIdentityId as string);
    if (configuredOwner === null) return null;
    const identity = await this.#database.prepare(`SELECT
      principal.principal_id, identity.identity_id, identity.provider_subject,
      identity.status AS identity_status, identity.verified_at,
      principal.status AS principal_status,
      owner.principal_id AS owner_principal_id, owner.identity_id AS owner_identity_id
    FROM channel_identities identity
    JOIN principals principal ON principal.principal_id = identity.principal_id
    LEFT JOIN voice_owner_identity owner ON owner.singleton_id = 1
    WHERE identity.channel = 'voice' AND identity.provider_subject = ?`)
      .bind(captured.providerE164).first<IdentityRow>();
    if (identity === null || identity.principal_status !== "active") return null;

    if (identity.identity_id === captured.ownerIdentityId) {
      if (
        identity.owner_identity_id !== configuredOwner.identity_id
        || identity.owner_principal_id !== configuredOwner.principal_id
        || identity.principal_id !== configuredOwner.principal_id
      ) return null;
      if (identity.identity_status === "active" && identity.verified_at !== null) {
        return Object.freeze({
          kind: "owner",
          principalId: identity.principal_id,
          identityId: identity.identity_id,
          activationChallengeId: null,
        });
      }
      if (identity.identity_status !== "pending" || identity.verified_at !== null) return null;
      const challenge = await this.#database.prepare(`SELECT challenge.challenge_id
        FROM identity_challenges challenge
        JOIN device_keys device
          ON device.device_id = challenge.initiating_device_id
          AND device.principal_id = challenge.principal_id
        WHERE challenge.principal_id = ? AND challenge.identity_id = ? AND challenge.channel = 'voice'
          AND challenge.consumed_at IS NULL AND challenge.created_at <= ? AND challenge.expires_at > ?
          AND challenge.hmac_key_version = ?
          AND device.key_id = challenge.initiating_key_id
          AND device.key_fingerprint = challenge.initiating_key_fingerprint
          AND device.key_generation = challenge.initiating_key_generation
          AND device.status = 'active'
        ORDER BY challenge.created_at DESC, challenge.challenge_id DESC LIMIT 1`)
        .bind(identity.principal_id, identity.identity_id, nowIso, nowIso, captured.challengeHmacKeyVersion)
        .first<ChallengeRow>();
      if (challenge === null) return null;
      return Object.freeze({
        kind: "owner",
        principalId: identity.principal_id,
        identityId: identity.identity_id,
        activationChallengeId: challenge.challenge_id,
      });
    }

    if (configuredOwner.identity_status !== "active" || configuredOwner.verified_at === null) return null;
    if (!["pending", "active"].includes(identity.identity_status)) return null;
    const row = await this.#database.prepare(`${GRANT_SELECT}
      WHERE grant_row.identity_id = ? AND grant_row.principal_id = ? AND grant_row.status IN ('pending', 'active')
      ORDER BY grant_row.grant_version DESC LIMIT 1`)
      .bind(identity.identity_id, identity.principal_id).first<GrantRow>();
    if (row === null) return null;
    const grant = decodeGrantRow(row);
    await this.#verifyAccessDocument(grant);
    return Object.freeze({
      kind: "guest",
      principalId: grant.principalId,
      identityId: grant.identityId,
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      accessDocumentHash: grant.accessDocumentHash,
      status: grant.status as "pending" | "active",
      pinVerifier: grant.pinVerifier,
    });
  }

  async resolveIdentityCandidate(input: {
    identityId: string;
    ownerIdentityId: string;
    now: Date;
  }): Promise<VoiceAccessCandidate | null> {
    const captured = captureExact(input, new Set(["identityId", "ownerIdentityId", "now"]));
    if (!safeId(captured.identityId) || !safeId(captured.ownerIdentityId)) invalidInput();
    dateIso(captured.now);
    const configuredOwner = await this.#configuredOwner(captured.ownerIdentityId as string);
    if (configuredOwner === null) return null;
    const identity = await this.#database.prepare(`SELECT
      principal.principal_id, identity.identity_id, identity.provider_subject,
      identity.status AS identity_status, identity.verified_at,
      principal.status AS principal_status,
      owner.principal_id AS owner_principal_id, owner.identity_id AS owner_identity_id
    FROM channel_identities identity
    JOIN principals principal ON principal.principal_id = identity.principal_id
    LEFT JOIN voice_owner_identity owner ON owner.singleton_id = 1
    WHERE identity.channel = 'voice' AND identity.identity_id = ?`)
      .bind(captured.identityId).first<IdentityRow>();
    if (identity === null || identity.principal_status !== "active") return null;
    if (identity.identity_id === captured.ownerIdentityId) {
      if (
        identity.owner_identity_id !== configuredOwner.identity_id
        || identity.owner_principal_id !== configuredOwner.principal_id
        || identity.principal_id !== configuredOwner.principal_id
        || identity.identity_status !== "active" || identity.verified_at === null
      ) {
        return null;
      }
      return Object.freeze({
        kind: "owner",
        principalId: identity.principal_id,
        identityId: identity.identity_id,
        activationChallengeId: null,
      });
    }
    if (configuredOwner.identity_status !== "active" || configuredOwner.verified_at === null) return null;
    if (!["pending", "active"].includes(identity.identity_status)) return null;
    const row = await this.#database.prepare(`${GRANT_SELECT}
      WHERE grant_row.identity_id = ? AND grant_row.principal_id = ? AND grant_row.status IN ('pending', 'active')
      ORDER BY grant_row.grant_version DESC LIMIT 1`)
      .bind(identity.identity_id, identity.principal_id).first<GrantRow>();
    if (row === null) return null;
    const grant = decodeGrantRow(row);
    await this.#verifyAccessDocument(grant);
    return Object.freeze({
      kind: "guest",
      principalId: grant.principalId,
      identityId: grant.identityId,
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      accessDocumentHash: grant.accessDocumentHash,
      status: grant.status as "pending" | "active",
      pinVerifier: grant.pinVerifier,
    });
  }

  async createGuestGrant(input: CreateGuestGrantInput): Promise<GuestGrantSnapshot> {
    const fields = new Set([
      "mutationId", "requestHash", "ownerAuthority", "ownerIdentityId", "grantId", "guestPrincipalId",
      "guestIdentityId", "providerE164", "capabilityIds", "resourceScopes", "accessDocumentHash",
      "pinVerifier", "now",
    ]);
    const captured = captureExact(input, fields);
    const mutationId = ulid(captured.mutationId);
    const requestHash = hash(captured.requestHash);
    const grantId = ulid(captured.grantId);
    if (
      !safeId(captured.ownerIdentityId) || !safeId(captured.guestPrincipalId) || !safeId(captured.guestIdentityId)
      || typeof captured.providerE164 !== "string" || !E164.test(captured.providerE164)
      || captured.guestIdentityId === captured.ownerIdentityId
    ) {
      invalidInput();
    }
    const nowIso = dateIso(captured.now);
    const capabilityIds = capabilities(captured.capabilityIds);
    const resourceScopes = scopes(captured.resourceScopes);
    const accessDocumentHash = hash(captured.accessDocumentHash);
    const pinVerifier = verifier(captured.pinVerifier);
    await this.#verifyAccessDocument({
      providerE164: captured.providerE164,
      capabilityIds,
      resourceScopes,
      accessDocumentHash,
    });
    const ownerAuthority = await this.#requireOwnerAuthority(
      captured.ownerAuthority,
      captured.ownerIdentityId,
      captured.now,
    );
    const ownerGuard = ownerMutationGuardBindings(
      ownerAuthority,
      captured.ownerIdentityId as string,
      nowIso,
    );
    const replay = await this.#eventReplay(mutationId, requestHash, grantId, "created");
    if (replay !== null) return replay;
    await this.#beforeEventWrite?.();
    const statements = [
      this.#database.prepare(`INSERT INTO principals
        (principal_id, principal_type, status, display_name, created_at, updated_at)
        SELECT ?, 'human', 'active', 'voice guest', ?, ? WHERE ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(captured.guestPrincipalId, nowIso, nowIso, ...ownerGuard),
      this.#database.prepare(`INSERT INTO channel_identities
        (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id)
        SELECT ?, ?, 'voice', ?, 'pending', NULL, ?, NULL WHERE ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(captured.guestIdentityId, captured.guestPrincipalId, captured.providerE164, nowIso, ...ownerGuard),
      this.#database.prepare(`INSERT INTO voice_access_grants (
        grant_id, principal_id, identity_id, grant_version, capability_ids_json, resource_scopes_json,
        access_document_hash, pin_schema_version, pin_algorithm, pin_pepper_version, pin_iterations,
        pin_salt_base64, pin_digest_base64, status, created_by_identity_id, created_at,
        activated_at, updated_at, revoked_at
      ) SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, NULL
        WHERE ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(
          grantId, captured.guestPrincipalId, captured.guestIdentityId,
          JSON.stringify(capabilityIds), JSON.stringify(resourceScopes), accessDocumentHash,
          pinVerifier.schemaVersion, pinVerifier.algorithm, pinVerifier.pepperVersion, pinVerifier.iterations,
          pinVerifier.saltBase64, pinVerifier.digestBase64, captured.ownerIdentityId, nowIso, nowIso,
          ...ownerGuard,
        ),
      this.#database.prepare(`INSERT INTO voice_access_grant_events (
        event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
        capability_ids_json, access_document_hash, created_at
      ) SELECT ?, ?, 1, 'created', ?, ?, ?, ?, ? WHERE ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(
          mutationId,
          grantId,
          captured.ownerIdentityId,
          requestHash,
          JSON.stringify(capabilityIds),
          accessDocumentHash,
          nowIso,
          ...ownerGuard,
        ),
    ];
    const fault = this.#faultStatement("create");
    const eventResultIndex = fault === null ? 3 : 4;
    if (fault !== null) statements.splice(3, 0, fault);
    const results = await this.#transactions.batch(statements);
    if ([0, 1, 2, eventResultIndex].some((index) => (results[index]?.meta.changes ?? 0) !== 1)) {
      await this.#requireOwnerAuthority(ownerAuthority, captured.ownerIdentityId, captured.now);
      throw new Error("voice_access_write_failed");
    }
    const created = await this.#grant(grantId);
    if (created === null) throw new Error("voice_access_write_failed");
    return created;
  }

  async replacePermissions(input: ReplaceGuestPermissionsInput): Promise<GuestGrantSnapshot> {
    const captured = captureExact(input, new Set([
      "mutationId", "requestHash", "ownerAuthority", "ownerIdentityId", "grantId", "expectedGrantVersion",
      "capabilityIds", "resourceScopes", "accessDocumentHash", "now",
    ]));
    const mutationId = ulid(captured.mutationId);
    const requestHash = hash(captured.requestHash);
    const grantId = ulid(captured.grantId);
    const expectedVersion = positiveVersion(captured.expectedGrantVersion);
    if (!safeId(captured.ownerIdentityId)) invalidInput();
    const nowIso = dateIso(captured.now);
    const capabilityIds = capabilities(captured.capabilityIds);
    const resourceScopes = scopes(captured.resourceScopes);
    const accessDocumentHash = hash(captured.accessDocumentHash);
    const ownerAuthority = await this.#requireOwnerAuthority(
      captured.ownerAuthority,
      captured.ownerIdentityId,
      captured.now,
    );
    const ownerGuard = ownerMutationGuardBindings(
      ownerAuthority,
      captured.ownerIdentityId as string,
      nowIso,
    );
    const replay = await this.#eventReplay(mutationId, requestHash, grantId, "permissions_replaced");
    if (replay !== null) return replay;
    const current = await this.#grant(grantId);
    if (current === null || current.status === "revoked" || current.grantVersion !== expectedVersion) {
      throw new Error("voice_access_grant_stale");
    }
    await this.#verifyAccessDocument({
      providerE164: current.providerE164,
      capabilityIds,
      resourceScopes,
      accessDocumentHash,
    });
    const nextVersion = expectedVersion + 1;
    await this.#beforeEventWrite?.();
    const statements = [
      this.#database.prepare(`UPDATE voice_access_grants
        SET grant_version = ?, capability_ids_json = ?, resource_scopes_json = ?, access_document_hash = ?, updated_at = ?
        WHERE grant_id = ? AND grant_version = ? AND status IN ('pending', 'active')
          AND ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(
          nextVersion,
          JSON.stringify(capabilityIds),
          JSON.stringify(resourceScopes),
          accessDocumentHash,
          nowIso,
          grantId,
          expectedVersion,
          ...ownerGuard,
        ),
      this.#database.prepare(`INSERT INTO voice_access_grant_events (
        event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
        capability_ids_json, access_document_hash, created_at
      ) SELECT ?, ?, ?, 'permissions_replaced', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM voice_access_grants WHERE grant_id = ? AND grant_version = ?
          AND access_document_hash = ? AND status IN ('pending', 'active'))
          AND ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(
          mutationId, grantId, nextVersion, captured.ownerIdentityId, requestHash,
          JSON.stringify(capabilityIds), accessDocumentHash, nowIso,
          grantId, nextVersion, accessDocumentHash,
          ...ownerGuard,
        ),
    ];
    const fault = this.#faultStatement("replace");
    const eventResultIndex = fault === null ? 1 : 2;
    if (fault !== null) statements.splice(1, 0, fault);
    const results = await this.#transactions.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[eventResultIndex]?.meta.changes ?? 0) !== 1) {
      await this.#requireOwnerAuthority(ownerAuthority, captured.ownerIdentityId, captured.now);
      throw new Error("voice_access_grant_stale");
    }
    const updated = await this.#grant(grantId);
    if (updated === null) throw new Error("voice_access_write_failed");
    return updated;
  }

  async rotatePin(input: RotateGuestPinInput): Promise<GuestGrantSnapshot> {
    const captured = captureExact(input, new Set([
      "mutationId", "requestHash", "ownerAuthority", "ownerIdentityId", "grantId", "expectedGrantVersion",
      "pinVerifier", "now",
    ]));
    const mutationId = ulid(captured.mutationId);
    const requestHash = hash(captured.requestHash);
    const grantId = ulid(captured.grantId);
    const expectedVersion = positiveVersion(captured.expectedGrantVersion);
    if (!safeId(captured.ownerIdentityId)) invalidInput();
    const nowIso = dateIso(captured.now);
    const pinVerifier = verifier(captured.pinVerifier);
    const ownerAuthority = await this.#requireOwnerAuthority(
      captured.ownerAuthority,
      captured.ownerIdentityId,
      captured.now,
    );
    const ownerGuard = ownerMutationGuardBindings(
      ownerAuthority,
      captured.ownerIdentityId as string,
      nowIso,
    );
    const replay = await this.#eventReplay(mutationId, requestHash, grantId, "pin_rotated");
    if (replay !== null) return replay;
    const current = await this.#grant(grantId);
    if (current === null || current.status === "revoked" || current.grantVersion !== expectedVersion) {
      throw new Error("voice_access_grant_stale");
    }
    const nextVersion = expectedVersion + 1;
    await this.#beforeEventWrite?.();
    const statements = [
      this.#database.prepare(`UPDATE voice_access_grants
        SET grant_version = ?, pin_salt_base64 = ?, pin_digest_base64 = ?, updated_at = ?
        WHERE grant_id = ? AND grant_version = ? AND status IN ('pending', 'active')
          AND ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(
          nextVersion,
          pinVerifier.saltBase64,
          pinVerifier.digestBase64,
          nowIso,
          grantId,
          expectedVersion,
          ...ownerGuard,
        ),
      this.#database.prepare(`INSERT INTO voice_access_grant_events (
        event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
        capability_ids_json, access_document_hash, created_at
      ) SELECT ?, ?, ?, 'pin_rotated', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM voice_access_grants WHERE grant_id = ? AND grant_version = ?
          AND pin_salt_base64 = ? AND pin_digest_base64 = ? AND status IN ('pending', 'active'))
          AND ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(
          mutationId, grantId, nextVersion, captured.ownerIdentityId, requestHash,
          JSON.stringify(current.capabilityIds), current.accessDocumentHash, nowIso,
          grantId, nextVersion, pinVerifier.saltBase64, pinVerifier.digestBase64,
          ...ownerGuard,
        ),
    ];
    const fault = this.#faultStatement("rotate");
    const eventResultIndex = fault === null ? 1 : 2;
    if (fault !== null) statements.splice(1, 0, fault);
    const results = await this.#transactions.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[eventResultIndex]?.meta.changes ?? 0) !== 1) {
      await this.#requireOwnerAuthority(ownerAuthority, captured.ownerIdentityId, captured.now);
      throw new Error("voice_access_grant_stale");
    }
    const updated = await this.#grant(grantId);
    if (updated === null) throw new Error("voice_access_write_failed");
    return updated;
  }

  async revokeGrant(input: RevokeGuestGrantInput): Promise<GuestGrantSnapshot> {
    const captured = captureExact(input, new Set([
      "mutationId", "requestHash", "ownerAuthority", "ownerIdentityId", "grantId", "expectedGrantVersion", "now",
    ]));
    const mutationId = ulid(captured.mutationId);
    const requestHash = hash(captured.requestHash);
    const grantId = ulid(captured.grantId);
    const expectedVersion = positiveVersion(captured.expectedGrantVersion);
    if (!safeId(captured.ownerIdentityId)) invalidInput();
    const nowIso = dateIso(captured.now);
    const ownerAuthority = await this.#requireOwnerAuthority(
      captured.ownerAuthority,
      captured.ownerIdentityId,
      captured.now,
    );
    const ownerGuard = ownerMutationGuardBindings(
      ownerAuthority,
      captured.ownerIdentityId as string,
      nowIso,
    );
    const replay = await this.#eventReplay(mutationId, requestHash, grantId, "revoked");
    if (replay !== null) return replay;
    const current = await this.#grant(grantId);
    if (current === null || current.status === "revoked" || current.grantVersion !== expectedVersion) {
      throw new Error("voice_access_grant_stale");
    }
    const nextVersion = expectedVersion + 1;
    await this.#beforeEventWrite?.();
    const statements = [
      this.#database.prepare(`UPDATE voice_access_grants
        SET grant_version = ?, status = 'revoked', updated_at = ?, revoked_at = ?
        WHERE grant_id = ? AND grant_version = ? AND status IN ('pending', 'active')
          AND ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(nextVersion, nowIso, nowIso, grantId, expectedVersion, ...ownerGuard),
      this.#database.prepare(`UPDATE channel_identities SET status = 'disabled'
        WHERE identity_id = ? AND principal_id = ? AND channel = 'voice' AND status IN ('pending', 'active')
          AND ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(current.identityId, current.principalId, ...ownerGuard),
      this.#database.prepare(`INSERT INTO voice_access_grant_events (
        event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
        capability_ids_json, access_document_hash, created_at
      ) SELECT ?, ?, ?, 'revoked', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM voice_access_grants WHERE grant_id = ? AND grant_version = ? AND status = 'revoked')
          AND ${OWNER_MUTATION_AUTHORITY_GUARD}`)
        .bind(
          mutationId, grantId, nextVersion, captured.ownerIdentityId, requestHash,
          JSON.stringify(current.capabilityIds), current.accessDocumentHash, nowIso, grantId, nextVersion,
          ...ownerGuard,
        ),
    ];
    const fault = this.#faultStatement("revoke");
    const eventResultIndex = fault === null ? 2 : 3;
    if (fault !== null) statements.splice(2, 0, fault);
    const results = await this.#transactions.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1
      || (results[eventResultIndex]?.meta.changes ?? 0) !== 1) {
      await this.#requireOwnerAuthority(ownerAuthority, captured.ownerIdentityId, captured.now);
      throw new Error("voice_access_grant_stale");
    }
    const updated = await this.#grant(grantId);
    if (updated === null) throw new Error("voice_access_write_failed");
    return updated;
  }

  async listGuests(input: {
    ownerAuthority: PersistedCallAuthority;
    ownerIdentityId: string;
    now: Date;
  }): Promise<readonly MaskedGuestGrant[]> {
    const captured = captureExact(input, new Set(["ownerAuthority", "ownerIdentityId", "now"]));
    await this.#requireOwnerAuthority(captured.ownerAuthority, captured.ownerIdentityId, captured.now);
    const rows = await this.#database.prepare(`${GRANT_SELECT}
      WHERE grant_row.status IN ('pending', 'active')
      ORDER BY grant_row.created_at, grant_row.grant_id`)
      .all<GrantRow>();
    return Object.freeze(await Promise.all(rows.results.map(async (row) => {
      const grant = decodeGrantRow(row);
      await this.#verifyAccessDocument(grant);
      return Object.freeze({
        identityId: grant.identityId,
        status: grant.status,
        grantVersion: grant.grantVersion,
        capabilityIds: grant.capabilityIds,
        maskedNumber: maskNumber(grant.providerE164),
      });
    })));
  }

  async #session(sessionId: Ulid): Promise<SessionLineageRow | null> {
    return this.#database.prepare(`SELECT session_id, call_sid, principal_id, identity_id,
      destination_identity_id, relay_nonce, direction, activation_only, activation_challenge_id,
      phase, created_at, access_kind, guest_grant_id, guest_grant_version, access_document_hash,
      provider_connected_at
      FROM call_sessions WHERE session_id = ?`).bind(sessionId).first<SessionLineageRow>();
  }

  #bindingMatchesSession(value: RelayBinding, row: SessionLineageRow): boolean {
    return value.callSid === row.call_sid
      && value.principalId === row.principal_id
      && value.identityId === row.identity_id
      && value.destinationIdentityId === row.destination_identity_id
      && value.relayNonce === row.relay_nonce
      && value.direction === row.direction
      && Number(value.activationOnly) === row.activation_only
      && value.activationChallengeId === row.activation_challenge_id
      && value.accessKind === row.access_kind
      && value.guestGrantId === row.guest_grant_id
      && value.guestGrantVersion === row.guest_grant_version
      && value.accessDocumentHash === row.access_document_hash;
  }

  async #existingAuthority(sessionId: Ulid): Promise<AuthorityRow | null> {
    return this.#database.prepare(`${AUTHORITY_SELECT} WHERE authority.session_id = ?`)
      .bind(sessionId).first<AuthorityRow>();
  }

  #nominalAuthority(row: AuthorityRow): PersistedCallAuthority {
    const authority = issueAuthority(row);
    this.#issuedAuthorities.add(authority);
    return authority;
  }

  #authorityMatchesBinding(row: AuthorityRow, relayBinding: RelayBinding, nowIso: string): boolean {
    const providerDeadline = providerAuthorityDeadline(row.provider_connected_at);
    if (
      row.session_id === ""
      || row.call_sid !== relayBinding.callSid
      || row.principal_id !== relayBinding.principalId
      || row.identity_id !== relayBinding.identityId
      || row.destination_identity_id !== relayBinding.destinationIdentityId
      || row.relay_nonce !== relayBinding.relayNonce
      || row.direction !== relayBinding.direction
      || Number(relayBinding.activationOnly) !== row.activation_only
      || row.activation_challenge_id !== relayBinding.activationChallengeId
      || row.access_kind !== relayBinding.accessKind
      || row.session_grant_id !== relayBinding.guestGrantId
      || row.session_grant_version !== relayBinding.guestGrantVersion
      || row.session_access_document_hash !== relayBinding.accessDocumentHash
      || row.authority_kind !== relayBinding.accessKind
      || !["authenticated", "active"].includes(row.phase)
      || TERMINAL_PHASES.has(row.phase)
      || row.expires_at <= nowIso
      || providerDeadline === null
      || row.authenticated_at < row.provider_connected_at!
      || row.expires_at !== providerDeadline
      || row.principal_status !== "active"
      || row.identity_status !== "active"
      || row.verified_at === null
    ) {
      return false;
    }
    if (row.authority_kind === "owner") {
      const stepUpCurrent = row.step_up_requirement === "waived_passed_a"
        && row.direction === "inbound"
        && row.step_up_attestation_class === "passed_a"
        && row.step_up_policy === "waive_on_passed_a"
        || row.step_up_requirement === "required"
        && row.step_up_success_version !== null
        && row.step_up_success_version === row.current_owner_verifier_version
        && row.current_owner_head_status === "active"
        && row.current_owner_verifier_status === "active";
      return stepUpCurrent && row.grant_id === null
        && row.grant_version === null
        && row.access_document_hash === null
        && row.owner_principal_id === row.principal_id
        && row.owner_identity_id === row.identity_id;
    }
    return row.grant_id === relayBinding.guestGrantId
      && row.grant_version === relayBinding.guestGrantVersion
      && row.access_document_hash === relayBinding.accessDocumentHash
      && row.current_grant_status === "active"
      && row.current_grant_version === row.grant_version
      && row.current_access_document_hash === row.access_document_hash;
  }

  async rehydrateAuthority(input: {
    sessionId: Ulid;
    binding: RelayBinding;
    now: Date;
  }): Promise<PersistedCallAuthority> {
    const captured = captureExact(input, new Set(["sessionId", "binding", "now"]));
    const sessionId = ulid(captured.sessionId);
    const relayBinding = binding(captured.binding);
    const nowIso = dateIso(captured.now);
    const row = await this.#existingAuthority(sessionId);
    if (row !== null && row.expires_at <= nowIso) throw new Error("call_authority_expired");
    if (row === null || !this.#authorityMatchesBinding(row, relayBinding, nowIso)) {
      throw new Error("call_authority_invalid");
    }
    return this.#nominalAuthority(row);
  }

  async mintOwnerAuthority(input: MintOwnerAuthorityInput): Promise<PersistedCallAuthority> {
    const captured = captureExact(input, new Set(["sessionId", "binding", "now"]));
    const sessionId = ulid(captured.sessionId);
    const relayBinding = binding(captured.binding);
    const nowIso = dateIso(captured.now);
    if (relayBinding.accessKind !== "owner") throw new Error("call_authority_invalid");
    const existing = await this.#existingAuthority(sessionId);
    if (existing !== null) {
      if (!this.#authorityMatchesBinding(existing, relayBinding, nowIso)) {
        throw new Error("call_authority_invalid");
      }
      return this.#nominalAuthority(existing);
    }
    const session = await this.#session(sessionId);
    if (session === null || session.phase !== "pre_auth" || !this.#bindingMatchesSession(relayBinding, session)) {
      throw new Error("call_authority_invalid");
    }
    const expiresAt = providerAuthorityDeadline(session.provider_connected_at);
    if (expiresAt === null || session.provider_connected_at === null || nowIso < session.provider_connected_at) {
      throw new Error("call_authority_invalid");
    }
    if (nowIso >= expiresAt) throw new Error("call_authority_expired");
    await this.#transactions.batch([
      this.#database.prepare(`INSERT INTO call_session_authorities (
        session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
        access_document_hash, authenticated_at, expires_at
      ) VALUES (?, 'owner', ?, ?, NULL, NULL, NULL, ?, ?)`)
        .bind(sessionId, relayBinding.principalId, relayBinding.identityId, nowIso, expiresAt),
      this.#database.prepare("UPDATE call_sessions SET phase = 'authenticated', updated_at = ? WHERE session_id = ? AND phase = 'pre_auth'")
        .bind(nowIso, sessionId),
    ]);
    const row = await this.#existingAuthority(sessionId);
    if (row === null || row.phase !== "authenticated") throw new Error("call_authority_write_failed");
    return this.#nominalAuthority(row);
  }

  /** Per-session guest attempt ordinal, committed before the PIN KDF starts. */
  async reserveGuestPinAttempt(sessionId: Ulid, now: Date): Promise<number> {
    const capturedSessionId = ulid(sessionId);
    const attemptedAt = dateIso(now);
    const count = await this.#database.prepare(
      "SELECT count(*) AS count FROM guest_call_pin_attempts WHERE session_id = ?",
    ).bind(capturedSessionId).first<{ count: number }>();
    const ordinal = (count?.count ?? 0) + 1;
    if (ordinal > 3) throw new Error("authentication_budget_exhausted");
    await this.#database.prepare(`INSERT INTO guest_call_pin_attempts (session_id, attempt_ordinal, attempted_at)
      VALUES (?, ?, ?)`).bind(capturedSessionId, ordinal, attemptedAt).run();
    return ordinal;
  }

  async mintGuestAuthority(input: MintGuestAuthorityInput): Promise<PersistedCallAuthority> {
    const captured = captureExact(input, new Set([
      "sessionId", "binding", "activationEventId", "activationRequestHash", "now",
    ]));
    const sessionId = ulid(captured.sessionId);
    const relayBinding = binding(captured.binding);
    const activationEventId = ulid(captured.activationEventId);
    const activationRequestHash = hash(captured.activationRequestHash);
    const nowIso = dateIso(captured.now);
    if (relayBinding.accessKind !== "guest" || relayBinding.guestGrantId === null) {
      throw new Error("call_authority_invalid");
    }
    const existing = await this.#existingAuthority(sessionId);
    if (existing !== null) {
      if (!this.#authorityMatchesBinding(existing, relayBinding, nowIso)) {
        throw new Error("call_authority_invalid");
      }
      return this.#nominalAuthority(existing);
    }
    const session = await this.#session(sessionId);
    const current = await this.#grant(relayBinding.guestGrantId);
    if (
      session === null || session.phase !== "pre_auth" || !this.#bindingMatchesSession(relayBinding, session)
      || current === null || current.status === "revoked"
      || current.principalId !== relayBinding.principalId || current.identityId !== relayBinding.identityId
      || current.grantVersion !== relayBinding.guestGrantVersion
      || current.accessDocumentHash !== relayBinding.accessDocumentHash
    ) {
      throw new Error("call_authority_stale");
    }
    const expiresAt = session === null ? null : providerAuthorityDeadline(session.provider_connected_at);
    if (
      expiresAt === null || session === null || session.provider_connected_at === null
      || nowIso < session.provider_connected_at
    ) throw new Error("call_authority_invalid");
    if (nowIso >= expiresAt) throw new Error("call_authority_expired");
    const statements: D1PreparedStatement[] = [];
    if (current.status === "pending") {
      const replay = await this.#eventReplay(activationEventId, activationRequestHash, current.grantId, "activated");
      if (replay !== null && replay.status !== "active") throw new Error("voice_access_mutation_conflict");
      if (replay === null) {
        await this.#beforeEventWrite?.();
        statements.push(
          this.#database.prepare(`UPDATE voice_access_grants
            SET status = 'active', activated_at = ?, updated_at = ?
            WHERE grant_id = ? AND grant_version = ? AND access_document_hash = ? AND status = 'pending'`)
            .bind(nowIso, nowIso, current.grantId, current.grantVersion, current.accessDocumentHash),
          this.#database.prepare(`UPDATE channel_identities
            SET status = 'active', verified_at = ?
            WHERE identity_id = ? AND principal_id = ? AND channel = 'voice' AND status = 'pending' AND verified_at IS NULL`)
            .bind(nowIso, current.identityId, current.principalId),
          this.#database.prepare(`INSERT INTO voice_access_grant_events (
            event_id, grant_id, grant_version, event_type, owner_identity_id, request_hash,
            capability_ids_json, access_document_hash, created_at
          ) SELECT ?, ?, ?, 'activated', created_by_identity_id, ?, capability_ids_json, access_document_hash, ?
            FROM voice_access_grants WHERE grant_id = ? AND grant_version = ? AND status = 'active'`)
            .bind(
              activationEventId, current.grantId, current.grantVersion, activationRequestHash,
              nowIso, current.grantId, current.grantVersion,
            ),
        );
        const fault = this.#faultStatement("activate");
        if (fault !== null) statements.push(fault);
      }
    }
    statements.push(
      this.#database.prepare(`INSERT INTO call_session_authorities (
        session_id, authority_kind, principal_id, identity_id, grant_id, grant_version,
        access_document_hash, authenticated_at, expires_at
      ) VALUES (?, 'guest', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          sessionId, relayBinding.principalId, relayBinding.identityId, relayBinding.guestGrantId,
          relayBinding.guestGrantVersion, relayBinding.accessDocumentHash, nowIso, expiresAt,
        ),
      this.#database.prepare("UPDATE call_sessions SET phase = 'authenticated', updated_at = ? WHERE session_id = ? AND phase = 'pre_auth'")
        .bind(nowIso, sessionId),
    );
    await this.#transactions.batch(statements);
    const row = await this.#existingAuthority(sessionId);
    if (row === null || row.phase !== "authenticated") throw new Error("call_authority_write_failed");
    return this.#nominalAuthority(row);
  }

  async requireCurrentAuthority(input: PersistedCallAuthority, now: Date = new Date()): Promise<PersistedCallAuthority> {
    if (input === null || typeof input !== "object" || !this.#issuedAuthorities.has(input)) {
      throw new Error("call_authority_invalid");
    }
    const authority = persistedAuthority(input);
    const nowIso = dateIso(now);
    if (authority.expiresAt <= nowIso) throw new Error("call_authority_expired");
    const row = await this.#existingAuthority(authority.sessionId);
    if (
      row === null || row.authority_kind !== authority.kind
      || row.principal_id !== authority.principalId || row.identity_id !== authority.identityId
      || row.grant_id !== authority.grantId || row.grant_version !== authority.grantVersion
      || row.access_document_hash !== authority.accessDocumentHash
      || row.authenticated_at !== authority.authenticatedAt || row.expires_at !== authority.expiresAt
      || !["authenticated", "active"].includes(row.phase) || TERMINAL_PHASES.has(row.phase)
      || row.principal_status !== "active" || row.identity_status !== "active" || row.verified_at === null
    ) {
      throw new Error("call_authority_stale");
    }
    if (authority.kind === "owner") {
      const stepUpCurrent = row.step_up_requirement === "waived_passed_a"
        && row.direction === "inbound"
        && row.step_up_attestation_class === "passed_a"
        && row.step_up_policy === "waive_on_passed_a"
        || row.step_up_requirement === "required"
        && row.step_up_success_version !== null
        && row.step_up_success_version === row.current_owner_verifier_version
        && row.current_owner_head_status === "active"
        && row.current_owner_verifier_status === "active";
      if (!stepUpCurrent || row.owner_principal_id !== authority.principalId || row.owner_identity_id !== authority.identityId) {
        throw new Error("call_authority_stale");
      }
    } else if (
      row.current_grant_status !== "active"
      || row.current_grant_version !== authority.grantVersion
      || row.current_access_document_hash !== authority.accessDocumentHash
    ) {
      throw new Error("call_authority_stale");
    }
    return input;
  }

  /** Waived caller-ID authority cannot change access grants without a phrase success receipt. */
  async requireOwnerStepUpVerified(input: PersistedCallAuthority): Promise<void> {
    if (input === null || typeof input !== "object" || !this.#issuedAuthorities.has(input) || input.kind !== "owner") {
      throw new Error("call_authority_invalid");
    }
    const row = await this.#database.prepare(`SELECT success.session_id
      FROM owner_call_step_up_successes success
      JOIN owner_passphrase_heads head ON head.singleton_id = 1
        AND head.owner_principal_id = success.owner_principal_id
        AND head.owner_identity_id = success.owner_identity_id
        AND head.verifier_version = success.verifier_version AND head.status = 'active'
      JOIN owner_passphrase_verifiers verifier
        ON verifier.owner_identity_id = head.owner_identity_id
        AND verifier.verifier_version = head.verifier_version AND verifier.status = 'active'
      WHERE success.session_id = ? AND success.owner_principal_id = ? AND success.owner_identity_id = ?`)
      .bind(input.sessionId, input.principalId, input.identityId).first<{ session_id: string }>();
    if (row === null) throw new Error("owner_step_up_required");
  }
}

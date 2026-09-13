import {
  canonicalJson,
  isPersistableEventEnvelope,
  newUlid,
  sha256Hex,
  type CallDirection,
  type CallPhase,
  type ExpectedOutboundCall,
  type PersistableEventEnvelopeV1,
  type RelayBinding,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { ProviderFailure, snapshotProviderFailure, type ProviderFailureCode } from "../providers/provider-types.js";
import { transitionCall } from "../voice/call-state.js";
import {
  EventRepository,
  type AppendedEvent,
} from "./event-repository.js";
import {
  VoiceAccessRepository,
  type VoiceAccessCandidate,
} from "./voice-access-repository.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const SESSION_ID = /^VX[0-9A-Fa-f]{32}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CALLBACK_SOURCE = "call-progress-events";
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_TEXT_BYTES = 256;
const encoder = new TextEncoder();
const TERMINAL_PHASES = Object.freeze(["completed", "rejected", "failed", "expired"] as const);
function terminalStatusEvent(attemptColumn: "outbound_call_attempts.attempt_id" | "a.attempt_id"): string {
  // Archive purge removes the envelope but retains its receipt. Missing live
  // status evidence must not reopen an old provider call for relay admission.
  return `SELECT 1 FROM provider_events callback
  LEFT JOIN events event ON event.event_id = callback.event_id
  WHERE callback.endpoint_kind = 'status'
    AND callback.attempt_id = ${attemptColumn}
    AND (event.event_id IS NULL OR json_extract(event.envelope_json, '$.payload.callStatus')
      IN ('completed', 'busy', 'failed', 'no-answer', 'canceled'))`;
}
const RELAY_BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce",
  "direction", "activationOnly", "activationChallengeId",
  "accessKind", "guestGrantId", "guestGrantVersion", "accessDocumentHash",
]);

const callSessionAdmissionErrors = new WeakSet<object>();

export function callSessionAdmissionFailure(
  code: "inbound_session_rejected" | "call_session_capacity" | "call_session_conflict" | "call_session_expired",
): Error {
  const error = new Error(code);
  callSessionAdmissionErrors.add(error);
  return error;
}

export function isCallSessionAdmissionError(error: unknown): boolean {
  return error !== null && typeof error === "object" && callSessionAdmissionErrors.has(error);
}

export type ProviderDispatchState = "ready" | "claimed" | "dispatched" | "rejected" | "provider_dispatch_unknown";

declare const dispatchClaimBrand: unique symbol;
export interface ProviderDispatchClaimCapability {
  readonly attemptId: Ulid;
  readonly [dispatchClaimBrand]: true;
}

/** Only `claimed` carries POST authority; an expired ready attempt remains unchanged and capability-free. */
export type ProviderDispatchClaim =
  | { kind: "claimed"; capability: ProviderDispatchClaimCapability }
  | { kind: "authorization_expired" }
  | { kind: "relay_nonce_expired" }
  | { kind: "dispatched"; callSid: string }
  | { kind: "rejected"; failureCode: ProviderFailureCode; retryEligible: boolean }
  | { kind: "provider_dispatch_unknown" };

export interface StoredOutboundCallAttempt extends ExpectedOutboundCall {
  attemptId: Ulid;
  attemptOrdinal: 0 | 1;
}

export type DispatchIntent =
  | { kind: "allocate"; attemptOrdinal: 0 | 1 }
  | {
    kind: "existing";
    attempt: StoredOutboundCallAttempt;
    state: ProviderDispatchState;
    callSid: string | null;
    failureCode: ProviderFailureCode | null;
    retryEligible: boolean;
  };

export type ProviderEventInput =
  | {
    endpointKind: "status";
    attemptId: Ulid;
    callSid: string;
    callbackSource: string;
    sequenceNumber: number;
    requestHash: Sha256Hex;
    envelope: PersistableEventEnvelopeV1;
  }
  | {
    endpointKind: "relay_ended";
    callSid: string;
    sessionId: string;
    requestHash: Sha256Hex;
    envelope: PersistableEventEnvelopeV1;
  };

interface StoredAttemptRow {
  attempt_id: string;
  command_id: string;
  attempt_ordinal: number;
  principal_id: string;
  destination_identity_id: string;
  command_idempotency_key: string;
  relay_nonce: string;
  nonce_expires_at: string;
  authorization_expires_at: string;
  provider_dispatch_state: ProviderDispatchState;
  provider_failure_code: ProviderFailureCode | null;
  provider_failure_category: string | null;
  provider_call_sid: string | null;
  retry_eligible: number;
}

interface StoredCallSessionRow {
  session_id: string;
  call_sid: string;
  expected_attempt_id: string | null;
  principal_id: string;
  identity_id: string;
  destination_identity_id: string;
  direction: CallDirection;
  activation_only: number;
  activation_challenge_id: string | null;
  activation_hmac_key_version: string | null;
  access_kind: "owner" | "guest" | null;
  guest_grant_id: string | null;
  guest_grant_version: number | null;
  access_document_hash: string | null;
  relay_nonce: string;
  nonce_expires_at: string;
  relay_setup_expires_at: string | null;
  provider_session_id: string | null;
  provider_connected_at: string | null;
  phase: CallPhase;
  created_at: string;
  updated_at: string;
  identity_provider_subject?: string;
}

export interface StoredCallSession {
  readonly sessionId: Ulid;
  readonly callSid: string;
  readonly expectedAttemptId: Ulid | null;
  readonly direction: CallDirection;
  readonly phase: CallPhase;
  readonly nonceExpiresAt: string;
  readonly relaySetupExpiresAt: string | null;
  readonly providerSessionId: string | null;
  readonly providerConnectedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly binding: RelayBinding;
}

export interface ExpectedCallInput {
  attemptId: Ulid;
  commandId: Ulid;
  principalId: string;
  destinationIdentityId: string;
  idempotencyKey: string;
  authorizationExpiresAt: string;
  now: Date;
  /** Internal allocation proof supplied by the dispatcher and retained across race recovery. */
  attemptOrdinal: 0 | 1;
}

type ExpectedCallSnapshot = Readonly<
  Omit<ExpectedCallInput, "now">
  & { nowIso: string }
>;

export class AttemptAllocationRaceError extends Error {
  constructor(readonly currentAttemptId: Ulid, readonly attemptOrdinal: 0 | 1) {
    super("outbound_attempt_allocation_race");
    this.name = "AttemptAllocationRaceError";
  }
}

export function createRelayNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID.test(value);
}

function isCallSid(value: unknown): value is string {
  return typeof value === "string" && CALL_SID.test(value);
}

function isProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

function isCallPhase(value: unknown): value is CallPhase {
  return value === "created" || value === "connecting" || value === "pre_auth"
    || value === "authenticated" || value === "active" || value === "ending"
    || value === "completed" || value === "rejected" || value === "failed" || value === "expired";
}

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

function snapshotRelayBinding(value: unknown): Readonly<RelayBinding> {
  const input = exactDataRecord(value, RELAY_BINDING_FIELDS, "relay_binding_invalid");
  if (
    !isCallSid(input.callSid)
    || typeof input.relayNonce !== "string"
    || !RELAY_NONCE.test(input.relayNonce)
    || input.direction !== "inbound" && input.direction !== "outbound"
    || typeof input.activationOnly !== "boolean"
    || input.activationChallengeId !== null && typeof input.activationChallengeId !== "string"
    || input.accessKind !== "owner" && input.accessKind !== "guest"
  ) {
    throw new TypeError("relay_binding_invalid");
  }
  for (const field of ["principalId", "identityId", "destinationIdentityId"] as const) {
    requireSafeText(input[field], field.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`));
  }
  if (
    input.direction === "inbound" && input.identityId !== input.destinationIdentityId
    || input.activationOnly && (input.direction !== "inbound" || input.activationChallengeId === null)
    || !input.activationOnly && input.activationChallengeId !== null
    || !validAccessBinding(input)
  ) {
    throw new TypeError("relay_binding_invalid");
  }
  return Object.freeze({
    callSid: input.callSid,
    principalId: input.principalId as string,
    identityId: input.identityId as string,
    destinationIdentityId: input.destinationIdentityId as string,
    relayNonce: input.relayNonce,
    direction: input.direction,
    activationOnly: input.activationOnly,
    activationChallengeId: input.activationChallengeId,
    accessKind: input.accessKind,
    guestGrantId: input.guestGrantId as string | null,
    guestGrantVersion: input.guestGrantVersion as number | null,
    accessDocumentHash: input.accessDocumentHash as string | null,
  });
}

function validAccessBinding(input: Readonly<Record<string, unknown>>): boolean {
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
    && HASH.test(input.accessDocumentHash)
    && input.activationOnly === false
    && input.activationChallengeId === null;
}

function accessBindingFromCandidate(candidate: VoiceAccessCandidate): Pick<
RelayBinding,
"accessKind" | "guestGrantId" | "guestGrantVersion" | "accessDocumentHash"
> {
  return candidate.kind === "owner"
    ? Object.freeze({
      accessKind: "owner" as const,
      guestGrantId: null,
      guestGrantVersion: null,
      accessDocumentHash: null,
    })
    : Object.freeze({
      accessKind: "guest" as const,
      guestGrantId: candidate.grantId,
      guestGrantVersion: candidate.grantVersion,
      accessDocumentHash: candidate.accessDocumentHash,
    });
}

function requireDate(value: Date, label: string): string {
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { throw new TypeError(`${label}_invalid`); }
  if (!Number.isFinite(epochMs)) throw new TypeError(`${label}_invalid`);
  return new Date(epochMs).toISOString();
}

function requireCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value)) throw new TypeError(`${label}_invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(`${label}_invalid`);
  return value;
}

function requireSafeText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || !value.isWellFormed()
    || value !== value.normalize("NFC")
    || encoder.encode(value).byteLength > MAX_TEXT_BYTES
  ) {
    throw new TypeError(`${label}_invalid`);
  }
}

function snapshotExpectedCallInput(input: ExpectedCallInput): ExpectedCallSnapshot {
  const attemptId = input.attemptId;
  const commandId = input.commandId;
  const principalId = input.principalId;
  const destinationIdentityId = input.destinationIdentityId;
  const idempotencyKey = input.idempotencyKey;
  const authorizationExpiresAt = input.authorizationExpiresAt;
  const attemptOrdinal = input.attemptOrdinal;
  const now = input.now;
  if (!isUlid(attemptId) || !isUlid(commandId)) throw new TypeError("outbound_attempt_identity_invalid");
  requireSafeText(principalId, "principal_id");
  requireSafeText(destinationIdentityId, "destination_identity_id");
  requireSafeText(idempotencyKey, "command_idempotency_key");
  if (attemptOrdinal !== 0 && attemptOrdinal !== 1) {
    throw new TypeError("outbound_attempt_ordinal_invalid");
  }
  return Object.freeze({
    attemptId,
    commandId,
    principalId,
    destinationIdentityId,
    idempotencyKey,
    authorizationExpiresAt: requireCanonicalTimestamp(authorizationExpiresAt, "authorization_expires_at"),
    attemptOrdinal,
    nowIso: requireDate(now, "outbound_attempt_now"),
  });
}

function explicitRejection(failure: ProviderFailure): {
  code: "provider_transient_failure" | "provider_authentication_failure" | "provider_permanent_failure";
  category: "rate_limited" | "authentication" | "invalid_request";
} | null {
  const facts = snapshotProviderFailure(failure);
  if (facts?.code === "provider_transient_failure" && facts.category === "rate_limited") {
    return { code: facts.code, category: facts.category };
  }
  if (facts?.code === "provider_authentication_failure" && facts.category === "authentication") {
    return { code: facts.code, category: facts.category };
  }
  if (facts?.code === "provider_permanent_failure" && facts.category === "invalid_request") {
    return { code: facts.code, category: facts.category };
  }
  return null;
}

/** Calling persistence with atomic allocation, provider claims, and callback receipt dependencies. */
export class CallRepository {
  private readonly issuedClaims = new WeakSet<object>();
  private readonly begunClaims = new WeakSet<object>();
  private readonly settledClaims = new WeakSet<object>();

  constructor(
    private readonly database: D1Database,
    private readonly events: EventRepository,
    private readonly nonceFactory: () => string = createRelayNonce,
    private readonly nonceTtlMs = 300_000,
    private readonly sessionIdFactory: () => Ulid = newUlid,
    private readonly voiceAccessRepository: VoiceAccessRepository = new VoiceAccessRepository(database),
  ) {
    if (!Number.isSafeInteger(nonceTtlMs) || nonceTtlMs <= 0 || nonceTtlMs > 300_000) {
      throw new RangeError("relay_nonce_ttl_invalid");
    }
    if (!(voiceAccessRepository instanceof VoiceAccessRepository)) {
      throw new TypeError("voice_access_repository_invalid");
    }
  }

  async resolveDispatchIntent(commandId: Ulid): Promise<DispatchIntent> {
    if (!isUlid(commandId)) throw new TypeError("command_id_invalid");
    const rows = await this.readAttemptsForCommand(commandId);
    if (rows.length === 0) return { kind: "allocate", attemptOrdinal: 0 };
    const first = rows[0];
    if (rows.length === 1 && first !== undefined && this.isRetryEligibleFirstAttempt(first)) {
      return { kind: "allocate", attemptOrdinal: 1 };
    }
    const current = rows.at(-1);
    if (current === undefined) throw new Error("outbound_attempt_state_invalid");
    return this.toExistingIntent(current);
  }

  async getOrCreateExpectedCall(input: ExpectedCallInput): Promise<StoredOutboundCallAttempt> {
    const snapshot = snapshotExpectedCallInput(input);
    const stored = await this.readAttempt(snapshot.attemptId);
    if (stored !== null) return this.requireMatchingLineage(stored, snapshot);

    const relayNonce = this.nonceFactory();
    if (!RELAY_NONCE.test(relayNonce)) throw new TypeError("relay_nonce_invalid");
    const nonceExpiresAt = new Date(new Date(snapshot.nowIso).valueOf() + this.nonceTtlMs).toISOString();
    let insertError: unknown;
    try {
      await this.insertEligibleAttempt(snapshot, relayNonce, nonceExpiresAt);
    } catch (error) {
      insertError = error;
    }

    const inserted = await this.readAttempt(snapshot.attemptId);
    if (inserted !== null) return this.requireMatchingLineage(inserted, snapshot);
    throw await this.classifyAttemptInsertFailure(snapshot.commandId, snapshot.attemptOrdinal, insertError);
  }

  /** Claims an unexpired ready attempt, while a previously claimed attempt always recovers to unknown. */
  async claimProviderDispatch(input: { attemptId: Ulid; now: Date }): Promise<ProviderDispatchClaim> {
    const attemptId = input.attemptId;
    const now = input.now;
    if (!isUlid(attemptId)) throw new TypeError("attempt_id_invalid");
    const observedAt = requireDate(now, "provider_dispatch_claim_now");
    const row = await this.updateDispatchClaim(attemptId, observedAt);
    if (row?.provider_dispatch_state === "claimed") {
      const capability = Object.freeze({ attemptId }) as ProviderDispatchClaimCapability;
      this.issuedClaims.add(capability);
      return { kind: "claimed", capability };
    }
    if (row?.provider_dispatch_state === "provider_dispatch_unknown") return { kind: "provider_dispatch_unknown" };
    const stored = await this.readAttempt(attemptId);
    if (
      stored?.provider_dispatch_state === "ready"
      && stored.authorization_expires_at <= observedAt
    ) {
      return { kind: "authorization_expired" };
    }
    if (
      stored?.provider_dispatch_state === "ready"
      && stored.nonce_expires_at <= observedAt
    ) {
      return { kind: "relay_nonce_expired" };
    }
    if (stored?.provider_dispatch_state === "claimed") {
      const recovered = await this.updateDispatchClaim(attemptId, observedAt);
      if (recovered?.provider_dispatch_state === "provider_dispatch_unknown") {
        return { kind: "provider_dispatch_unknown" };
      }
      const afterRecovery = await this.readAttempt(attemptId);
      const recoveredTerminal = afterRecovery === null ? null : this.dispatchResultFromRow(afterRecovery);
      if (recoveredTerminal !== null) return recoveredTerminal;
      throw new Error("dispatch_claim_invariant");
    }
    const terminal = stored === null ? null : this.dispatchResultFromRow(stored);
    if (terminal === null) throw new Error("dispatch_claim_invariant");
    return terminal;
  }

  /** Atomically binds one-shot in-memory POST authority to the dispatcher's audited attempt. */
  beginProviderDispatch(claim: ProviderDispatchClaimCapability, expectedAttemptId: Ulid): void {
    if (
      !isUlid(expectedAttemptId)
      || !this.issuedClaims.has(claim)
      || claim.attemptId !== expectedAttemptId
      || this.begunClaims.has(claim)
      || this.settledClaims.has(claim)
    ) {
      throw new Error("provider_dispatch_claim_invalid");
    }
    this.begunClaims.add(claim);
  }

  async recordProviderDispatchSuccess(input: { claim: ProviderDispatchClaimCapability; callSid: string; now: Date }): Promise<void> {
    const claim = input.claim;
    const callSid = input.callSid;
    const now = input.now;
    const attemptId = claim.attemptId;
    this.settleBegunClaim(claim);
    if (!isCallSid(callSid)) throw new TypeError("provider_call_sid_invalid");
    const resolvedAt = requireDate(now, "provider_dispatch_success_now");
    await this.resolveSuccess(attemptId, callSid, resolvedAt);
  }

  async recordProviderDispatchRejection(input: { claim: ProviderDispatchClaimCapability; failure: ProviderFailure; now: Date }): Promise<void> {
    const claim = input.claim;
    const failure = input.failure;
    const now = input.now;
    const attemptId = claim.attemptId;
    this.settleBegunClaim(claim);
    const rejection = explicitRejection(failure);
    if (rejection === null) throw new TypeError("provider_dispatch_rejection_invalid");
    const resolvedAt = requireDate(now, "provider_dispatch_rejection_now");
    await this.resolveExplicitRejection(attemptId, rejection, resolvedAt);
  }

  async recordProviderDispatchUnknown(input: { claim: ProviderDispatchClaimCapability; now: Date }): Promise<void> {
    const claim = input.claim;
    const now = input.now;
    const attemptId = claim.attemptId;
    this.settleBegunClaim(claim);
    const resolvedAt = requireDate(now, "provider_dispatch_unknown_now");
    await this.resolveUnknown(attemptId, resolvedAt);
  }

  async claimExpectedCall(input: {
    attemptId: Ulid;
    callSid: string;
    observedDestinationIdentityId: string;
    ownerIdentityId: string;
    now: Date;
  }): Promise<RelayBinding | null> {
    const attemptId = input.attemptId;
    const callSid = input.callSid;
    const observedDestinationIdentityId = input.observedDestinationIdentityId;
    const ownerIdentityId = input.ownerIdentityId;
    const now = input.now;
    if (!isUlid(attemptId)) throw new TypeError("attempt_id_invalid");
    if (!isCallSid(callSid)) throw new TypeError("call_sid_invalid");
    requireSafeText(observedDestinationIdentityId, "destination_identity_id");
    requireSafeText(ownerIdentityId, "owner_identity_id");
    const observedAt = requireDate(now, "relay_claim_now");
    const candidate = await this.voiceAccessRepository.resolveIdentityCandidate({
      identityId: observedDestinationIdentityId,
      ownerIdentityId,
      now: new Date(observedAt),
    });
    if (candidate === null) return null;
    const access = accessBindingFromCandidate(candidate);
    const row = await this.database.prepare(`UPDATE outbound_call_attempts
      SET relay_call_sid = COALESCE(relay_call_sid, ?1),
          relay_claimed_at = COALESCE(relay_claimed_at, ?2),
          provider_call_sid = COALESCE(provider_call_sid, ?3),
          provider_dispatch_state = 'dispatched',
          provider_dispatch_resolved_at = COALESCE(provider_dispatch_resolved_at, ?4)
      WHERE attempt_id = ?5
        AND (relay_call_sid IS NULL OR relay_call_sid = ?6)
        AND destination_identity_id = ?7
        AND ((relay_call_sid IS NULL AND nonce_expires_at > ?8) OR relay_call_sid = ?9)
        AND provider_dispatch_state IN ('claimed', 'dispatched', 'provider_dispatch_unknown')
        AND (provider_call_sid IS NULL OR provider_call_sid = ?10)
        AND NOT EXISTS (${terminalStatusEvent("outbound_call_attempts.attempt_id")})
        AND EXISTS (
          SELECT 1 FROM voice_owner_identity owner
          WHERE owner.identity_id = ?11 AND owner.principal_id = outbound_call_attempts.principal_id
        )
        AND EXISTS (
          SELECT 1
          FROM channel_identities destination
          WHERE destination.identity_id = outbound_call_attempts.destination_identity_id
            AND destination.principal_id = ?12
            AND destination.channel = 'voice'
            AND (
              (
                ?13 = 'owner'
                AND destination.identity_id = ?11
                AND destination.status = 'active'
                AND destination.verified_at IS NOT NULL
              )
              OR
              (
                ?13 = 'guest'
                AND destination.status IN ('pending', 'active')
                AND EXISTS (
                  SELECT 1 FROM voice_access_grants grant_row
                  WHERE grant_row.grant_id = ?14
                    AND grant_row.grant_version = ?15
                    AND grant_row.access_document_hash = ?16
                    AND grant_row.principal_id = destination.principal_id
                    AND grant_row.identity_id = destination.identity_id
                    AND grant_row.status IN ('pending', 'active')
                )
              )
            )
        )
      RETURNING destination_identity_id, relay_nonce`)
      .bind(
        callSid,
        observedAt,
        callSid,
        observedAt,
        attemptId,
        callSid,
        observedDestinationIdentityId,
        observedAt,
        callSid,
        callSid,
        ownerIdentityId,
        candidate.principalId,
        access.accessKind,
        access.guestGrantId,
        access.guestGrantVersion,
        access.accessDocumentHash,
      )
      .first<{ destination_identity_id: string; relay_nonce: string }>();
    return row === null ? null : Object.freeze({
      callSid,
      principalId: candidate.principalId,
      identityId: row.destination_identity_id,
      destinationIdentityId: row.destination_identity_id,
      relayNonce: row.relay_nonce,
      direction: "outbound",
      activationOnly: false,
      activationChallengeId: null,
      ...access,
    });
  }

  async getOrCreateInboundSession(input: {
    callSid: string;
    callerE164: string;
    ownerIdentityId: string;
    currentChallengeHmacKeyVersion: string;
    now: Date;
  }): Promise<StoredCallSession> {
    const captured = exactDataRecord(
      input,
      new Set(["callSid", "callerE164", "ownerIdentityId", "currentChallengeHmacKeyVersion", "now"]),
      "inbound_session_input_invalid",
    );
    const callSid = captured.callSid;
    const callerE164 = captured.callerE164;
    const ownerIdentityId = captured.ownerIdentityId;
    const currentChallengeHmacKeyVersion = captured.currentChallengeHmacKeyVersion;
    if (!isCallSid(callSid) || typeof callerE164 !== "string" || !E164.test(callerE164)) {
      throw new TypeError("inbound_session_input_invalid");
    }
    requireSafeText(ownerIdentityId, "owner_identity_id");
    requireSafeText(currentChallengeHmacKeyVersion, "challenge_hmac_key_version");
    const nowIso = requireDate(captured.now as Date, "inbound_session_now");
    let candidate: Awaited<ReturnType<VoiceAccessRepository["resolveInboundCandidate"]>>;
    try {
      candidate = await this.voiceAccessRepository.resolveInboundCandidate({
        providerE164: callerE164,
        ownerIdentityId: ownerIdentityId as string,
        challengeHmacKeyVersion: currentChallengeHmacKeyVersion as string,
        now: new Date(nowIso),
      });
    } catch {
      throw callSessionAdmissionFailure("inbound_session_rejected");
    }
    const existing = await this.readCallSessionByCallSid(callSid);
    if (existing !== null) {
      return this.requireInboundSessionReplay(existing, callerE164, currentChallengeHmacKeyVersion as string, nowIso, candidate);
    }
    if (candidate === null) throw callSessionAdmissionFailure("inbound_session_rejected");

    const sessionId = this.sessionIdFactory();
    const relayNonce = this.nonceFactory();
    if (!isUlid(sessionId) || !RELAY_NONCE.test(relayNonce)) throw new TypeError("call_session_identifier_invalid");
    const activationChallengeId = candidate.kind === "owner" ? candidate.activationChallengeId : null;
    const activationOnly = activationChallengeId !== null;
    let relaySetupExpiresAt = new Date(new Date(nowIso).valueOf() + 300_000).toISOString();
    if (activationChallengeId !== null) {
      const challenge = await this.database.prepare("SELECT expires_at FROM identity_challenges WHERE challenge_id = ?")
        .bind(activationChallengeId).first<{ expires_at: string }>();
      if (challenge === null) throw callSessionAdmissionFailure("inbound_session_rejected");
      const challengeExpiresAt = requireCanonicalTimestamp(challenge.expires_at, "challenge_expires_at");
      if (challengeExpiresAt < relaySetupExpiresAt) relaySetupExpiresAt = challengeExpiresAt;
    }
    const access = accessBindingFromCandidate(candidate);
    let insertError: unknown;
    try {
      await this.database.prepare(`INSERT INTO call_sessions (
        session_id, call_sid, expected_attempt_id, principal_id, identity_id,
        destination_identity_id, direction, activation_only, activation_challenge_id,
        activation_hmac_key_version, relay_nonce, nonce_expires_at,
        relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
        access_kind, guest_grant_id, guest_grant_version, access_document_hash
      )
      SELECT ?1, ?2, NULL, ?3, ?4, ?4, 'inbound', ?5, ?6, ?7,
        ?8, ?9, ?9, NULL, 'created', ?10, ?10, ?11, ?12, ?13, ?14
      WHERE (
        SELECT COUNT(*) FROM call_sessions s
        WHERE s.principal_id = ?3
          AND s.phase NOT IN ('completed', 'rejected', 'failed', 'expired')
          AND NOT (
            s.direction = 'inbound'
            AND s.provider_session_id IS NULL
            AND s.relay_setup_expires_at <= ?10
          )
      ) < 2
        AND (
          ?11 != 'guest'
          OR EXISTS (
            SELECT 1
            FROM voice_owner_identity owner
            JOIN principals owner_principal ON owner_principal.principal_id = owner.principal_id
            JOIN channel_identities owner_identity
              ON owner_identity.identity_id = owner.identity_id
              AND owner_identity.principal_id = owner.principal_id
              AND owner_identity.channel = 'voice'
            WHERE owner.singleton_id = 1
              AND owner_principal.principal_type = 'human'
              AND owner_principal.status = 'active'
              AND owner_identity.status = 'active'
              AND owner_identity.verified_at IS NOT NULL
          )
        )`)
        .bind(
          sessionId,
          callSid,
          candidate.principalId,
          candidate.identityId,
          activationOnly ? 1 : 0,
          activationChallengeId,
          activationOnly ? currentChallengeHmacKeyVersion : null,
          relayNonce,
          relaySetupExpiresAt,
          nowIso,
          access.accessKind,
          access.guestGrantId,
          access.guestGrantVersion,
          access.accessDocumentHash,
        )
        .run();
    } catch (error) {
      insertError = error;
    }
    const stored = await this.readCallSessionByCallSid(callSid);
    if (stored !== null) {
      return this.requireInboundSessionReplay(stored, callerE164, currentChallengeHmacKeyVersion as string, nowIso, candidate);
    }
    const active = await this.countActiveSessions({ principalId: candidate.principalId, now: new Date(nowIso) });
    if (active >= 2) throw callSessionAdmissionFailure("call_session_capacity");
    if (insertError instanceof Error && /UNIQUE constraint failed: call_sessions\.call_sid/u.test(insertError.message)) {
      throw callSessionAdmissionFailure("call_session_conflict");
    }
    throw callSessionAdmissionFailure("inbound_session_rejected");
  }

  async getOrCreateOutboundSession(input: {
    attemptId: Ulid;
    binding: RelayBinding;
    now: Date;
  }): Promise<StoredCallSession> {
    const captured = exactDataRecord(input, new Set(["attemptId", "binding", "now"]), "outbound_session_input_invalid");
    const attemptId = captured.attemptId;
    const binding = snapshotRelayBinding(captured.binding);
    const nowIso = requireDate(captured.now as Date, "outbound_session_now");
    if (!isUlid(attemptId) || binding.direction !== "outbound" || binding.activationOnly) {
      throw new TypeError("outbound_session_input_invalid");
    }
    const existing = await this.readCallSessionById(attemptId);
    if (existing !== null) return this.requireOutboundSessionReplay(existing, attemptId, binding);
    let insertError: unknown;
    try {
      await this.database.prepare(`INSERT INTO call_sessions (
        session_id, call_sid, expected_attempt_id, principal_id, identity_id,
        destination_identity_id, direction, activation_only, activation_challenge_id,
        activation_hmac_key_version, relay_nonce, nonce_expires_at,
        relay_setup_expires_at, provider_session_id, phase, created_at, updated_at,
        access_kind, guest_grant_id, guest_grant_version, access_document_hash
      )
      SELECT a.attempt_id, a.relay_call_sid, a.attempt_id, ?4,
        a.destination_identity_id, a.destination_identity_id, 'outbound', 0,
        NULL, NULL, a.relay_nonce, a.nonce_expires_at, NULL, NULL, 'created', ?1, ?1,
        ?8, ?9, ?10, ?11
      FROM outbound_call_attempts a
      WHERE a.attempt_id = ?2
        AND a.relay_call_sid = ?3
        AND a.destination_identity_id = ?5
        AND a.destination_identity_id = ?6
        AND a.relay_nonce = ?7
        AND a.provider_dispatch_state = 'dispatched'
        AND NOT EXISTS (${terminalStatusEvent("a.attempt_id")})
        AND (
          SELECT COUNT(*) FROM call_sessions s
          WHERE s.principal_id = ?4
            AND s.phase NOT IN ('completed', 'rejected', 'failed', 'expired')
            AND NOT (
              s.direction = 'inbound'
              AND s.provider_session_id IS NULL
              AND s.relay_setup_expires_at <= ?1
            )
        ) < 2`)
        .bind(
          nowIso,
          attemptId,
          binding.callSid,
          binding.principalId,
          binding.identityId,
          binding.destinationIdentityId,
          binding.relayNonce,
          binding.accessKind,
          binding.guestGrantId,
          binding.guestGrantVersion,
          binding.accessDocumentHash,
        )
        .run();
    } catch (error) {
      insertError = error;
    }
    const stored = await this.readCallSessionById(attemptId);
    if (stored !== null) return this.requireOutboundSessionReplay(stored, attemptId, binding);
    const active = await this.countActiveSessions({ principalId: binding.principalId, now: new Date(nowIso) });
    if (active >= 2) throw callSessionAdmissionFailure("call_session_capacity");
    if (insertError instanceof Error && /UNIQUE constraint failed/u.test(insertError.message)) {
      throw callSessionAdmissionFailure("call_session_conflict");
    }
    throw callSessionAdmissionFailure("call_session_conflict");
  }

  async bindRelaySession(input: {
    sessionId: Ulid;
    callSid: string;
    providerSessionId: string;
    relayNonce: string;
    direction: "inbound" | "outbound";
    now: Date;
  }): Promise<StoredCallSession> {
    const captured = exactDataRecord(
      input,
      new Set(["sessionId", "callSid", "providerSessionId", "relayNonce", "direction", "now"]),
      "call_session_bind_input_invalid",
    );
    const sessionId = captured.sessionId;
    const callSid = captured.callSid;
    const providerSessionId = captured.providerSessionId;
    const relayNonce = captured.relayNonce;
    const direction = captured.direction;
    if (
      !isUlid(sessionId)
      || !isCallSid(callSid)
      || !isProviderSessionId(providerSessionId)
      || typeof relayNonce !== "string"
      || !RELAY_NONCE.test(relayNonce)
      || direction !== "inbound" && direction !== "outbound"
    ) {
      throw new TypeError("call_session_bind_input_invalid");
    }
    const nowIso = requireDate(captured.now as Date, "call_session_bind_now");
    const row = await this.database.prepare(`UPDATE call_sessions AS s
      SET provider_session_id = ?1, provider_connected_at = COALESCE(provider_connected_at, ?2), updated_at = ?2
      WHERE s.session_id = ?3
        AND s.call_sid = ?4
        AND s.relay_nonce = ?5
        AND s.direction = ?6
        AND s.phase NOT IN ('completed', 'rejected', 'failed', 'expired')
        AND s.updated_at <= ?2
        AND (
          s.provider_session_id = ?1
          OR (
            s.provider_session_id IS NULL
            AND (
              (s.direction = 'inbound' AND s.relay_setup_expires_at > ?2)
              OR (s.direction = 'outbound' AND s.nonce_expires_at > ?2)
            )
          )
        )
        AND EXISTS (
          SELECT 1
          FROM principals p
          JOIN channel_identities i ON i.principal_id = p.principal_id
          WHERE p.principal_id = s.principal_id
            AND p.principal_type = 'human'
            AND p.status = 'active'
            AND i.identity_id = s.identity_id
            AND i.channel = 'voice'
            AND (
              (
                s.access_kind = 'owner'
                AND s.guest_grant_id IS NULL
                AND s.guest_grant_version IS NULL
                AND s.access_document_hash IS NULL
                AND EXISTS (
                  SELECT 1 FROM voice_owner_identity owner
                  WHERE owner.principal_id = s.principal_id
                    AND owner.identity_id = s.identity_id
                )
                AND (
                  (
                    s.activation_only = 0
                    AND i.status = 'active'
                    AND i.verified_at IS NOT NULL
                  )
                  OR
                  (
                    s.activation_only = 1
                    AND i.status = 'pending'
                    AND i.verified_at IS NULL
                    AND EXISTS (
                      SELECT 1
                      FROM identity_challenges c
                      JOIN device_keys d
                        ON d.device_id = c.initiating_device_id
                        AND d.principal_id = c.principal_id
                      WHERE c.challenge_id = s.activation_challenge_id
                        AND c.principal_id = s.principal_id
                        AND c.identity_id = s.identity_id
                        AND c.channel = 'voice'
                        AND c.consumed_at IS NULL
                        AND strftime('%Y-%m-%dT%H:%M:%fZ', c.expires_at) IS c.expires_at
                        AND strftime('%Y-%m-%dT%H:%M:%fZ', c.created_at) IS c.created_at
                        AND c.created_at <= ?2
                        AND c.expires_at > ?2
                        AND c.hmac_key_version = s.activation_hmac_key_version
                        AND d.key_id = c.initiating_key_id
                        AND d.key_fingerprint = c.initiating_key_fingerprint
                        AND d.key_generation = c.initiating_key_generation
                        AND d.status = 'active'
                    )
                  )
                )
              )
              OR
              (
                s.access_kind = 'guest'
                AND s.activation_only = 0
                AND s.activation_challenge_id IS NULL
                AND s.activation_hmac_key_version IS NULL
                AND i.status IN ('pending', 'active')
                AND EXISTS (
                  SELECT 1 FROM voice_access_grants grant_row
                  WHERE grant_row.grant_id = s.guest_grant_id
                    AND grant_row.grant_version = s.guest_grant_version
                    AND grant_row.access_document_hash = s.access_document_hash
                    AND grant_row.principal_id = s.principal_id
                    AND grant_row.identity_id = s.identity_id
                    AND grant_row.status IN ('pending', 'active')
                )
                AND EXISTS (
                  SELECT 1
                  FROM voice_owner_identity owner
                  JOIN principals owner_principal ON owner_principal.principal_id = owner.principal_id
                  JOIN channel_identities owner_identity
                    ON owner_identity.identity_id = owner.identity_id
                    AND owner_identity.principal_id = owner.principal_id
                    AND owner_identity.channel = 'voice'
                  WHERE owner.singleton_id = 1
                    AND owner_principal.principal_type = 'human'
                    AND owner_principal.status = 'active'
                    AND owner_identity.status = 'active'
                    AND owner_identity.verified_at IS NOT NULL
                )
              )
            )
        )
      RETURNING *`)
      .bind(providerSessionId, nowIso, sessionId, callSid, relayNonce, direction)
      .first<StoredCallSessionRow>();
    if (row === null) throw new Error("call_session_bind_conflict");
    return this.toStoredCallSession(row);
  }

  async transitionCallSession(input: {
    sessionId: Ulid;
    expectedPhase: CallPhase;
    nextPhase: CallPhase;
    now: Date;
  }): Promise<StoredCallSession> {
    const captured = exactDataRecord(
      input,
      new Set(["sessionId", "expectedPhase", "nextPhase", "now"]),
      "call_session_transition_input_invalid",
    );
    const sessionId = captured.sessionId;
    const expectedPhase = captured.expectedPhase;
    const nextPhase = captured.nextPhase;
    if (!isUlid(sessionId) || !isCallPhase(expectedPhase) || !isCallPhase(nextPhase)) {
      throw new TypeError("call_session_transition_input_invalid");
    }
    transitionCall(expectedPhase, nextPhase);
    const nowIso = requireDate(captured.now as Date, "call_session_transition_now");
    const row = await this.database.prepare(`UPDATE call_sessions
      SET phase = ?1, updated_at = ?2
      WHERE session_id = ?3 AND phase = ?4 AND updated_at <= ?2
      RETURNING *`)
      .bind(nextPhase, nowIso, sessionId, expectedPhase)
      .first<StoredCallSessionRow>();
    if (row === null) throw new Error("call_session_transition_conflict");
    return this.toStoredCallSession(row);
  }

  async countActiveSessions(input: {
    principalId: string;
    direction?: "inbound" | "outbound";
    now: Date;
  }): Promise<number> {
    const fields = Object.prototype.hasOwnProperty.call(input, "direction")
      ? new Set(["principalId", "direction", "now"])
      : new Set(["principalId", "now"]);
    const captured = exactDataRecord(input, fields, "call_session_count_input_invalid");
    requireSafeText(captured.principalId, "principal_id");
    if (captured.direction !== undefined && captured.direction !== "inbound" && captured.direction !== "outbound") {
      throw new TypeError("call_session_count_input_invalid");
    }
    const nowIso = requireDate(captured.now as Date, "call_session_count_now");
    const row = await this.database.prepare(`SELECT COUNT(*) AS count
      FROM call_sessions
      WHERE principal_id = ?1
        AND (?2 IS NULL OR direction = ?2)
        AND phase NOT IN ('completed', 'rejected', 'failed', 'expired')
        AND NOT (
          direction = 'inbound'
          AND provider_session_id IS NULL
          AND relay_setup_expires_at <= ?3
        )`)
      .bind(captured.principalId, captured.direction ?? null, nowIso)
      .first<{ count: number }>();
    const count = row?.count;
    if (!Number.isSafeInteger(count) || (count ?? -1) < 0) throw new Error("call_session_count_invalid");
    return count as number;
  }

  async appendProviderEvent(input: ProviderEventInput): Promise<AppendedEvent> {
    const endpointKind: unknown = input.endpointKind;
    const callSid = input.callSid;
    const envelope = input.envelope;
    const requestHash = input.requestHash;
    if (!isCallSid(callSid)) throw new TypeError("provider_event_call_sid_invalid");
    if (!isPersistableEventEnvelope(envelope) || envelope.eventSequence !== undefined) {
      throw new TypeError("provider_event_envelope_invalid");
    }

    if (endpointKind === "status") {
      const status = input as Extract<ProviderEventInput, { endpointKind: "status" }>;
      const attemptId = status.attemptId;
      const callbackSource = status.callbackSource;
      const sequenceNumber = status.sequenceNumber;
      if (!isUlid(attemptId)) throw new TypeError("provider_event_attempt_id_invalid");
      if (callbackSource !== CALLBACK_SOURCE) throw new TypeError("provider_event_callback_source_invalid");
      if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) {
        throw new TypeError("provider_event_sequence_invalid");
      }
      const dedupeKey = await sha256Hex(canonicalJson([
        "status",
        attemptId,
        callSid,
        callbackSource,
        sequenceNumber,
      ]));
      return this.events.appendAtomic({
        envelope,
        scope: "provider:callback",
        key: dedupeKey,
        requestHash,
      }, (database) => [database.prepare(`INSERT INTO provider_events (
        dedupe_key, endpoint_kind, event_id, attempt_id, call_sid, callback_source,
        sequence_number, session_id, received_at
      ) VALUES (?1, 'status', ?2, ?3, ?4, ?5, ?6, NULL, ?7)`)
        .bind(
          dedupeKey,
          envelope.eventId,
          attemptId,
          callSid,
          callbackSource,
          sequenceNumber,
          envelope.receivedAt,
        ), ...this.terminalCallbackTransitions(database, envelope, "status", attemptId, callSid)]);
    }

    if (endpointKind !== "relay_ended") throw new TypeError("provider_event_endpoint_kind_invalid");
    const relayEnded = input as Extract<ProviderEventInput, { endpointKind: "relay_ended" }>;
    const sessionId = relayEnded.sessionId;
    if (!SESSION_ID.test(sessionId)) throw new TypeError("provider_event_session_id_invalid");
    const dedupeKey = await sha256Hex(canonicalJson(["relay_ended", callSid, sessionId]));
    return this.events.appendAtomic({
      envelope,
      scope: "provider:callback",
      key: dedupeKey,
      requestHash,
    }, (database) => [database.prepare(`INSERT INTO provider_events (
      dedupe_key, endpoint_kind, event_id, attempt_id, call_sid, callback_source,
      sequence_number, session_id, received_at
    ) VALUES (?1, 'relay_ended', ?2, NULL, ?3, NULL, NULL, ?4, ?5)`)
      .bind(dedupeKey, envelope.eventId, callSid, sessionId, envelope.receivedAt),
      ...this.terminalCallbackTransitions(database, envelope, "relay_ended", sessionId, callSid)]);
  }

  private terminalCallbackTransitions(
    database: D1Database,
    envelope: PersistableEventEnvelopeV1,
    endpoint: "status" | "relay_ended",
    providerIdentity: string,
    callSid: string,
  ): readonly D1PreparedStatement[] {
    const payload = envelope.payload as Readonly<Record<string, unknown>>;
    const status = payload[endpoint === "status" ? "callStatus" : "sessionStatus"];
    const complete = endpoint === "relay_ended" ? status === "completed" || status === "ended" : status === "completed";
    const failed = endpoint === "relay_ended" ? status === "failed"
      : typeof status === "string" && ["busy", "failed", "no-answer", "canceled"].includes(status);
    if (!complete && !failed) return [];
    const binding = endpoint === "status"
      ? "session_id = ?1 AND expected_attempt_id = ?1 AND direction = 'outbound' AND call_sid = ?2"
      : "provider_session_id = ?1 AND call_sid = ?2";
    // Preserve terminal causes and use the schema's ending step. Authority
    // reads become invalid in the same transaction that records the callback.
    const first = database.prepare(`UPDATE call_sessions SET
      phase = CASE WHEN ?4 = 1 THEN 'failed'
        WHEN phase IN ('created', 'connecting', 'pre_auth') THEN 'rejected'
        ELSE 'ending' END,
      updated_at = MAX(updated_at, ?3)
      WHERE ${binding} AND phase NOT IN ('completed', 'rejected', 'failed', 'expired')`)
      .bind(providerIdentity, callSid, envelope.receivedAt, failed ? 1 : 0);
    if (failed) return [first];
    return [first, database.prepare(`UPDATE call_sessions
      SET phase = 'completed', updated_at = MAX(updated_at, ?3)
      WHERE ${binding} AND phase = 'ending'`).bind(providerIdentity, callSid, envelope.receivedAt)];
  }

  /** Read-only hydration seam for the named relay-session Durable Object. */
  async getCallSession(sessionId: Ulid): Promise<StoredCallSession | null> {
    if (!isUlid(sessionId)) throw new TypeError("call_session_id_invalid");
    const row = await this.readCallSessionById(sessionId);
    return row === null ? null : this.toStoredCallSession(row);
  }

  private readCallSessionById(sessionId: string): Promise<StoredCallSessionRow | null> {
    return this.database.prepare(`SELECT s.*, i.provider_subject AS identity_provider_subject
      FROM call_sessions s
      JOIN channel_identities i ON i.identity_id = s.identity_id
      WHERE s.session_id = ?1`)
      .bind(sessionId)
      .first<StoredCallSessionRow>();
  }

  private readCallSessionByCallSid(callSid: string): Promise<StoredCallSessionRow | null> {
    return this.database.prepare(`SELECT s.*, i.provider_subject AS identity_provider_subject
      FROM call_sessions s
      JOIN channel_identities i ON i.identity_id = s.identity_id
      WHERE s.call_sid = ?1`)
      .bind(callSid)
      .first<StoredCallSessionRow>();
  }

  private async requireInboundSessionReplay(
    row: StoredCallSessionRow,
    callerE164: string,
    currentChallengeHmacKeyVersion: string,
    nowIso: string,
    candidate: VoiceAccessCandidate | null,
  ): Promise<StoredCallSession> {
    if (
      row.direction !== "inbound"
      || row.identity_provider_subject !== callerE164
      || (row.activation_only === 1 && row.activation_hmac_key_version !== currentChallengeHmacKeyVersion)
    ) {
      throw callSessionAdmissionFailure("call_session_conflict");
    }
    if ((TERMINAL_PHASES as readonly CallPhase[]).includes(row.phase)) {
      throw callSessionAdmissionFailure(row.phase === "expired" ? "call_session_expired" : "call_session_conflict");
    }
    if (
      row.provider_session_id === null
      && row.relay_setup_expires_at !== null
      && row.relay_setup_expires_at <= nowIso
    ) {
      if (row.phase === "created") {
        await this.database.prepare(`UPDATE call_sessions
          SET phase = 'expired', updated_at = ?1
          WHERE session_id = ?2 AND phase = 'created' AND provider_session_id IS NULL
            AND relay_setup_expires_at <= ?1 AND updated_at <= ?1`)
          .bind(nowIso, row.session_id)
          .run();
      }
      throw callSessionAdmissionFailure("call_session_expired");
    }
    if (candidate === null || !this.inboundCandidateMatchesRow(row, candidate, currentChallengeHmacKeyVersion)) {
      throw callSessionAdmissionFailure("inbound_session_rejected");
    }
    return this.toStoredCallSession(row);
  }

  private async requireOutboundSessionReplay(
    row: StoredCallSessionRow,
    attemptId: Ulid,
    binding: Readonly<RelayBinding>,
  ): Promise<StoredCallSession> {
    if (
      row.direction !== "outbound"
      || row.session_id !== attemptId
      || row.expected_attempt_id !== attemptId
      || row.call_sid !== binding.callSid
      || row.principal_id !== binding.principalId
      || row.identity_id !== binding.identityId
      || row.destination_identity_id !== binding.destinationIdentityId
      || row.relay_nonce !== binding.relayNonce
      || row.activation_only !== 0
      || row.activation_challenge_id !== null
      || row.access_kind !== binding.accessKind
      || row.guest_grant_id !== binding.guestGrantId
      || row.guest_grant_version !== binding.guestGrantVersion
      || row.access_document_hash !== binding.accessDocumentHash
      || (TERMINAL_PHASES as readonly CallPhase[]).includes(row.phase)
      || !await this.isCurrentAccessBinding(binding)
    ) {
      throw callSessionAdmissionFailure("call_session_conflict");
    }
    return this.toStoredCallSession(row);
  }

  private inboundCandidateMatchesRow(
    row: StoredCallSessionRow,
    candidate: VoiceAccessCandidate,
    currentChallengeHmacKeyVersion: string,
  ): boolean {
    if (
      row.principal_id !== candidate.principalId
      || row.identity_id !== candidate.identityId
      || row.destination_identity_id !== candidate.identityId
    ) {
      return false;
    }
    if (candidate.kind === "guest") {
      return row.access_kind === "guest"
        && row.guest_grant_id === candidate.grantId
        && row.guest_grant_version === candidate.grantVersion
        && row.access_document_hash === candidate.accessDocumentHash
        && row.activation_only === 0
        && row.activation_challenge_id === null
        && row.activation_hmac_key_version === null;
    }
    return row.access_kind === "owner"
      && row.guest_grant_id === null
      && row.guest_grant_version === null
      && row.access_document_hash === null
      && row.activation_only === (candidate.activationChallengeId === null ? 0 : 1)
      && row.activation_challenge_id === candidate.activationChallengeId
      && row.activation_hmac_key_version === (candidate.activationChallengeId === null ? null : currentChallengeHmacKeyVersion);
  }

  private async isCurrentAccessBinding(binding: Readonly<RelayBinding>): Promise<boolean> {
    const row = await this.database.prepare(`SELECT 1 AS eligible
      FROM principals principal
      JOIN channel_identities identity
        ON identity.identity_id = ?1 AND identity.principal_id = principal.principal_id
      WHERE principal.principal_id = ?2
        AND principal.principal_type = 'human'
        AND principal.status = 'active'
        AND identity.channel = 'voice'
        AND (
          (
            ?3 = 'owner'
            AND identity.status = 'active'
            AND identity.verified_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM voice_owner_identity owner
              WHERE owner.principal_id = principal.principal_id
                AND owner.identity_id = identity.identity_id
            )
          )
          OR
          (
            ?3 = 'guest'
            AND identity.status IN ('pending', 'active')
            AND EXISTS (
              SELECT 1 FROM voice_access_grants grant_row
              WHERE grant_row.grant_id = ?4
                AND grant_row.grant_version = ?5
                AND grant_row.access_document_hash = ?6
                AND grant_row.principal_id = principal.principal_id
                AND grant_row.identity_id = identity.identity_id
                AND grant_row.status IN ('pending', 'active')
            )
          )
        )`)
      .bind(
        binding.identityId,
        binding.principalId,
        binding.accessKind,
        binding.guestGrantId,
        binding.guestGrantVersion,
        binding.accessDocumentHash,
      )
      .first<{ eligible: number }>();
    return row?.eligible === 1;
  }

  private toStoredCallSession(row: StoredCallSessionRow): StoredCallSession {
    if (
      !isUlid(row.session_id)
      || !isCallSid(row.call_sid)
      || row.expected_attempt_id !== null && !isUlid(row.expected_attempt_id)
      || row.direction !== "inbound" && row.direction !== "outbound"
      || row.activation_only !== 0 && row.activation_only !== 1
      || !RELAY_NONCE.test(row.relay_nonce)
      || row.provider_session_id !== null && !isProviderSessionId(row.provider_session_id)
      || (row.provider_session_id === null) !== (row.provider_connected_at === null)
      || !isCallPhase(row.phase)
    ) {
      throw new Error("call_session_row_invalid");
    }
    const nonceExpiresAt = requireCanonicalTimestamp(row.nonce_expires_at, "call_session_nonce_expires_at");
    const relaySetupExpiresAt = row.relay_setup_expires_at === null
      ? null
      : requireCanonicalTimestamp(row.relay_setup_expires_at, "call_session_relay_setup_expires_at");
    const providerConnectedAt = row.provider_connected_at === null
      ? null
      : requireCanonicalTimestamp(row.provider_connected_at, "call_session_provider_connected_at");
    const createdAt = requireCanonicalTimestamp(row.created_at, "call_session_created_at");
    const updatedAt = requireCanonicalTimestamp(row.updated_at, "call_session_updated_at");
    const binding = snapshotRelayBinding({
      callSid: row.call_sid,
      principalId: row.principal_id,
      identityId: row.identity_id,
      destinationIdentityId: row.destination_identity_id,
      relayNonce: row.relay_nonce,
      direction: row.direction,
      activationOnly: row.activation_only === 1,
      activationChallengeId: row.activation_challenge_id,
      accessKind: row.access_kind,
      guestGrantId: row.guest_grant_id,
      guestGrantVersion: row.guest_grant_version,
      accessDocumentHash: row.access_document_hash,
    });
    return Object.freeze({
      sessionId: row.session_id,
      callSid: row.call_sid,
      expectedAttemptId: row.expected_attempt_id,
      direction: row.direction,
      phase: row.phase,
      nonceExpiresAt,
      relaySetupExpiresAt,
      providerSessionId: row.provider_session_id,
      providerConnectedAt,
      createdAt,
      updatedAt,
      binding,
    });
  }

  private async readAttempt(attemptId: Ulid): Promise<StoredAttemptRow | null> {
    return this.database.prepare(`SELECT attempt_id, command_id, attempt_ordinal, principal_id,
      destination_identity_id, command_idempotency_key, relay_nonce, nonce_expires_at, authorization_expires_at,
      provider_dispatch_state, provider_failure_code, provider_failure_category, provider_call_sid, retry_eligible
      FROM outbound_call_attempts WHERE attempt_id = ?1`)
      .bind(attemptId)
      .first<StoredAttemptRow>();
  }

  private updateDispatchClaim(attemptId: Ulid, observedAt: string): Promise<{ provider_dispatch_state: ProviderDispatchState } | null> {
    return this.database.prepare(`UPDATE outbound_call_attempts
      SET provider_dispatch_state = CASE provider_dispatch_state WHEN 'ready' THEN 'claimed' ELSE 'provider_dispatch_unknown' END,
          provider_dispatch_claimed_at = COALESCE(provider_dispatch_claimed_at, ?1),
          provider_dispatch_resolved_at = CASE WHEN provider_dispatch_state = 'claimed' THEN ?2 ELSE provider_dispatch_resolved_at END
      WHERE attempt_id = ?3 AND provider_dispatch_state IN ('ready', 'claimed')
        AND (provider_dispatch_state = 'claimed' OR (
          nonce_expires_at > ?4 AND authorization_expires_at > ?4
        ))
      RETURNING provider_dispatch_state`)
      .bind(observedAt, observedAt, attemptId, observedAt)
      .first<{ provider_dispatch_state: ProviderDispatchState }>();
  }

  private async readAttemptsForCommand(commandId: Ulid): Promise<StoredAttemptRow[]> {
    const result = await this.database.prepare(`SELECT attempt_id, command_id, attempt_ordinal, principal_id,
      destination_identity_id, command_idempotency_key, relay_nonce, nonce_expires_at, authorization_expires_at,
      provider_dispatch_state, provider_failure_code, provider_failure_category, provider_call_sid, retry_eligible
      FROM outbound_call_attempts WHERE command_id = ?1 ORDER BY attempt_ordinal ASC`)
      .bind(commandId)
      .all<StoredAttemptRow>();
    return result.results;
  }

  private toStoredAttempt(row: StoredAttemptRow): StoredOutboundCallAttempt {
    if (!isUlid(row.attempt_id) || !isUlid(row.command_id) || (row.attempt_ordinal !== 0 && row.attempt_ordinal !== 1)) {
      throw new Error("outbound_attempt_row_invalid");
    }
    return Object.freeze({
      attemptId: row.attempt_id,
      commandId: row.command_id,
      attemptOrdinal: row.attempt_ordinal,
      principalId: row.principal_id,
      destinationIdentityId: row.destination_identity_id,
      relayNonce: row.relay_nonce,
      nonceExpiresAt: row.nonce_expires_at,
      authorizationExpiresAt: row.authorization_expires_at,
      idempotencyKey: row.command_idempotency_key,
    });
  }

  private toExistingIntent(row: StoredAttemptRow): Extract<DispatchIntent, { kind: "existing" }> {
    return Object.freeze({
      kind: "existing",
      attempt: this.toStoredAttempt(row),
      state: row.provider_dispatch_state,
      callSid: row.provider_call_sid,
      failureCode: row.provider_failure_code,
      retryEligible: row.retry_eligible === 1,
    });
  }

  private requireMatchingLineage(
    row: StoredAttemptRow,
    input: ExpectedCallSnapshot,
  ): StoredOutboundCallAttempt {
    if (
      row.command_id !== input.commandId
      || row.principal_id !== input.principalId
      || row.destination_identity_id !== input.destinationIdentityId
      || row.command_idempotency_key !== input.idempotencyKey
      || row.authorization_expires_at !== input.authorizationExpiresAt
      || row.attempt_ordinal !== input.attemptOrdinal
    ) {
      throw new Error("outbound_attempt_conflict");
    }
    return this.toStoredAttempt(row);
  }

  private async insertEligibleAttempt(
    input: ExpectedCallSnapshot,
    relayNonce: string,
    nonceExpiresAt: string,
  ): Promise<void> {
    await this.database.prepare(`INSERT INTO outbound_call_attempts (
      attempt_id, command_id, attempt_ordinal, principal_id, destination_identity_id,
      command_idempotency_key, relay_nonce, nonce_expires_at, authorization_expires_at, provider_dispatch_state,
      retry_eligible, created_at
    )
    SELECT ?1, p.decision_id,
      CASE COUNT(a.attempt_id) WHEN 0 THEN 0 ELSE 1 END,
      ?2, ?3, ?4, ?5, ?6, ?7, 'ready', 0, ?8
    FROM policy_decisions p
    LEFT JOIN outbound_call_attempts a ON a.command_id = p.decision_id
    WHERE p.decision_id = ?9 AND p.principal_id = ?10 AND p.outcome = 'allow'
    GROUP BY p.decision_id, p.principal_id
    HAVING (
      COUNT(a.attempt_id) = 0
      OR (
        COUNT(a.attempt_id) = 1
        AND SUM(CASE WHEN a.attempt_ordinal = 0
          AND a.provider_dispatch_state = 'rejected'
          AND a.retry_eligible = 1
          AND a.principal_id = ?2
          AND a.destination_identity_id = ?3
          AND a.command_idempotency_key = ?4
          AND a.authorization_expires_at = ?7
          THEN 1 ELSE 0 END) = 1
      )
    )
      AND ?11 = CASE COUNT(a.attempt_id) WHEN 0 THEN 0 ELSE 1 END`)
      .bind(
        input.attemptId,
        input.principalId,
        input.destinationIdentityId,
        input.idempotencyKey,
        relayNonce,
        nonceExpiresAt,
        input.authorizationExpiresAt,
        input.nowIso,
        input.commandId,
        input.principalId,
        input.attemptOrdinal,
      )
      .run();
  }

  private async classifyAttemptInsertFailure(
    commandId: Ulid,
    expectedOrdinal: 0 | 1,
    insertError: unknown,
  ): Promise<Error> {
    const rows = await this.readAttemptsForCommand(commandId);
    const winner = rows.find((row) => row.attempt_ordinal === expectedOrdinal);
    if (winner !== undefined && isUlid(winner.attempt_id)) {
      return new AttemptAllocationRaceError(winner.attempt_id, expectedOrdinal);
    }
    if (rows.length >= 2) return new Error("outbound_retry_limit");
    const first = rows[0];
    if (first !== undefined && !this.isRetryEligibleFirstAttempt(first)) return new Error("outbound_retry_not_eligible");
    if (insertError instanceof Error) return insertError;
    return new Error("outbound_attempt_conflict");
  }

  private isRetryEligibleFirstAttempt(row: StoredAttemptRow): boolean {
    return row.attempt_ordinal === 0
      && row.provider_dispatch_state === "rejected"
      && row.provider_failure_code === "provider_transient_failure"
      && row.provider_failure_category === "rate_limited"
      && row.retry_eligible === 1;
  }

  private dispatchResultFromRow(row: StoredAttemptRow): Exclude<ProviderDispatchClaim, { kind: "claimed" } | { kind: "authorization_expired" } | { kind: "relay_nonce_expired" }> | null {
    if (row.provider_dispatch_state === "dispatched") {
      if (row.provider_call_sid === null) throw new Error("provider_dispatch_result_invalid");
      return { kind: "dispatched", callSid: row.provider_call_sid };
    }
    if (row.provider_dispatch_state === "rejected") {
      if (row.provider_failure_code === null) throw new Error("provider_dispatch_result_invalid");
      return { kind: "rejected", failureCode: row.provider_failure_code, retryEligible: row.retry_eligible === 1 };
    }
    if (row.provider_dispatch_state === "provider_dispatch_unknown") return { kind: "provider_dispatch_unknown" };
    return null;
  }

  private settleBegunClaim(claim: ProviderDispatchClaimCapability): void {
    if (
      !this.issuedClaims.has(claim)
      || !this.begunClaims.has(claim)
      || this.settledClaims.has(claim)
    ) {
      throw new Error("provider_dispatch_claim_invalid");
    }
    this.settledClaims.add(claim);
  }

  private async resolveSuccess(attemptId: Ulid, callSid: string, resolvedAt: string): Promise<void> {
    const result = await this.database.prepare(`UPDATE outbound_call_attempts
      SET provider_dispatch_state = 'dispatched',
          provider_call_sid = ?1,
          provider_dispatch_resolved_at = ?2
      WHERE attempt_id = ?3
        AND provider_dispatch_state IN ('claimed', 'provider_dispatch_unknown')
        AND (provider_call_sid IS NULL OR provider_call_sid = ?4)
        AND (relay_call_sid IS NULL OR relay_call_sid = ?5)`)
      .bind(callSid, resolvedAt, attemptId, callSid, callSid)
      .run();
    if ((result.meta.changes ?? 0) === 1) return;
    const row = await this.readAttempt(attemptId);
    if (row?.provider_dispatch_state === "dispatched" && row.provider_call_sid === callSid) return;
    throw new Error("provider_dispatch_result_conflict");
  }

  private async resolveExplicitRejection(
    attemptId: Ulid,
    rejection: {
      code: "provider_transient_failure" | "provider_authentication_failure" | "provider_permanent_failure";
      category: "rate_limited" | "authentication" | "invalid_request";
    },
    resolvedAt: string,
  ): Promise<void> {
    const result = await this.database.prepare(`UPDATE outbound_call_attempts
      SET provider_dispatch_state = 'rejected',
          provider_failure_code = ?1,
          provider_failure_category = ?2,
          retry_eligible = CASE WHEN attempt_ordinal = 0
            AND ?1 = 'provider_transient_failure'
            AND ?2 = 'rate_limited' THEN 1 ELSE 0 END,
          provider_dispatch_resolved_at = ?3
      WHERE attempt_id = ?4
        AND provider_dispatch_state IN ('claimed', 'provider_dispatch_unknown')
        AND provider_call_sid IS NULL
        AND relay_call_sid IS NULL`)
      .bind(rejection.code, rejection.category, resolvedAt, attemptId)
      .run();
    if ((result.meta.changes ?? 0) === 1) return;
    const row = await this.readAttempt(attemptId);
    if (row?.provider_dispatch_state === "dispatched") return;
    throw new Error("provider_dispatch_result_conflict");
  }

  private async resolveUnknown(attemptId: Ulid, resolvedAt: string): Promise<void> {
    const result = await this.database.prepare(`UPDATE outbound_call_attempts
      SET provider_dispatch_state = 'provider_dispatch_unknown',
          provider_dispatch_resolved_at = ?1
      WHERE attempt_id = ?2 AND provider_dispatch_state = 'claimed'`)
      .bind(resolvedAt, attemptId)
      .run();
    if ((result.meta.changes ?? 0) === 1) return;
    const row = await this.readAttempt(attemptId);
    if (row?.provider_dispatch_state === "provider_dispatch_unknown" || row?.provider_dispatch_state === "dispatched") return;
    throw new Error("provider_dispatch_result_conflict");
  }
}

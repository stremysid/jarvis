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

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const SESSION_ID = /^VX[0-9A-Fa-f]{32}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const CALLBACK_SOURCE = "call-progress-events";
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_TEXT_BYTES = 256;
const encoder = new TextEncoder();
const TERMINAL_PHASES = Object.freeze(["completed", "rejected", "failed", "expired"] as const);
const RELAY_BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce",
  "direction", "activationOnly", "activationChallengeId",
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
  relay_nonce: string;
  nonce_expires_at: string;
  relay_setup_expires_at: string | null;
  provider_session_id: string | null;
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
  ) {
    if (!Number.isSafeInteger(nonceTtlMs) || nonceTtlMs <= 0 || nonceTtlMs > 300_000) {
      throw new RangeError("relay_nonce_ttl_invalid");
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
    now: Date;
  }): Promise<RelayBinding | null> {
    const attemptId = input.attemptId;
    const callSid = input.callSid;
    const observedDestinationIdentityId = input.observedDestinationIdentityId;
    const now = input.now;
    if (!isUlid(attemptId)) throw new TypeError("attempt_id_invalid");
    if (!isCallSid(callSid)) throw new TypeError("call_sid_invalid");
    requireSafeText(observedDestinationIdentityId, "destination_identity_id");
    const observedAt = requireDate(now, "relay_claim_now");
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
      RETURNING principal_id, destination_identity_id, relay_nonce`)
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
      )
      .first<{ principal_id: string; destination_identity_id: string; relay_nonce: string }>();
    return row === null ? null : Object.freeze({
      callSid,
      principalId: row.principal_id,
      identityId: row.destination_identity_id,
      destinationIdentityId: row.destination_identity_id,
      relayNonce: row.relay_nonce,
      direction: "outbound",
      activationOnly: false,
      activationChallengeId: null,
    });
  }

  async getOrCreateInboundSession(input: {
    callSid: string;
    callerE164: string;
    currentChallengeHmacKeyVersion: string;
    now: Date;
  }): Promise<StoredCallSession> {
    const captured = exactDataRecord(
      input,
      new Set(["callSid", "callerE164", "currentChallengeHmacKeyVersion", "now"]),
      "inbound_session_input_invalid",
    );
    const callSid = captured.callSid;
    const callerE164 = captured.callerE164;
    const currentChallengeHmacKeyVersion = captured.currentChallengeHmacKeyVersion;
    if (!isCallSid(callSid) || typeof callerE164 !== "string" || !E164.test(callerE164)) {
      throw new TypeError("inbound_session_input_invalid");
    }
    requireSafeText(currentChallengeHmacKeyVersion, "challenge_hmac_key_version");
    const nowIso = requireDate(captured.now as Date, "inbound_session_now");
    const replay = await this.readEligibleInboundSessionReplay(
      callSid,
      callerE164,
      currentChallengeHmacKeyVersion,
      nowIso,
    );
    if (replay !== null) return replay;
    const existing = await this.readCallSessionByCallSid(callSid);
    if (existing !== null) {
      return this.rejectInboundSessionReplay(existing, callerE164, currentChallengeHmacKeyVersion, nowIso);
    }

    const sessionId = this.sessionIdFactory();
    const relayNonce = this.nonceFactory();
    if (!isUlid(sessionId) || !RELAY_NONCE.test(relayNonce)) throw new TypeError("call_session_identifier_invalid");
    const relaySetupExpiresAt = new Date(new Date(nowIso).valueOf() + 300_000).toISOString();
    let insertError: unknown;
    try {
      await this.database.prepare(`WITH candidates AS (
        SELECT p.principal_id, i.identity_id, 0 AS activation_only,
          NULL AS activation_challenge_id, NULL AS activation_hmac_key_version,
          ?4 AS relay_setup_expires_at, '' AS challenge_created_at
        FROM principals p
        JOIN channel_identities i ON i.principal_id = p.principal_id
        WHERE p.principal_type = 'human'
          AND p.status = 'active'
          AND i.channel = 'voice'
          AND i.provider_subject = ?1
          AND i.status = 'active'
          AND i.verified_at IS NOT NULL
        UNION ALL
        SELECT p.principal_id, i.identity_id, 1 AS activation_only,
          c.challenge_id, c.hmac_key_version,
          CASE WHEN c.expires_at < ?4 THEN c.expires_at ELSE ?4 END,
          c.created_at
        FROM principals p
        JOIN channel_identities i ON i.principal_id = p.principal_id
        JOIN identity_challenges c
          ON c.principal_id = p.principal_id
          AND c.identity_id = i.identity_id
        JOIN device_keys d
          ON d.device_id = c.initiating_device_id
          AND d.principal_id = c.principal_id
        WHERE p.principal_type = 'human'
          AND p.status = 'active'
          AND i.channel = 'voice'
          AND i.provider_subject = ?1
          AND i.status = 'pending'
          AND i.verified_at IS NULL
          AND c.channel = 'voice'
          AND c.consumed_at IS NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', c.expires_at) IS c.expires_at
          AND strftime('%Y-%m-%dT%H:%M:%fZ', c.created_at) IS c.created_at
          AND c.created_at <= ?3
          AND c.expires_at > ?3
          AND c.hmac_key_version = ?2
          AND d.key_id = c.initiating_key_id
          AND d.key_fingerprint = c.initiating_key_fingerprint
          AND d.key_generation = c.initiating_key_generation
          AND d.status = 'active'
      ), candidate AS (
        SELECT * FROM candidates
        ORDER BY activation_only ASC, challenge_created_at DESC, activation_challenge_id DESC
        LIMIT 1
      )
      INSERT INTO call_sessions (
        session_id, call_sid, expected_attempt_id, principal_id, identity_id,
        destination_identity_id, direction, activation_only, activation_challenge_id,
        activation_hmac_key_version, relay_nonce, nonce_expires_at,
        relay_setup_expires_at, provider_session_id, phase, created_at, updated_at
      )
      SELECT ?5, ?6, NULL, c.principal_id, c.identity_id, c.identity_id,
        'inbound', c.activation_only, c.activation_challenge_id,
        c.activation_hmac_key_version, ?7, c.relay_setup_expires_at,
        c.relay_setup_expires_at, NULL, 'created', ?3, ?3
      FROM candidate c
      WHERE (
        SELECT COUNT(*) FROM call_sessions s
        WHERE s.principal_id = c.principal_id
          AND s.phase NOT IN ('completed', 'rejected', 'failed', 'expired')
          AND NOT (
            s.direction = 'inbound'
            AND s.provider_session_id IS NULL
            AND s.relay_setup_expires_at <= ?3
          )
      ) < 2`)
        .bind(
          callerE164,
          currentChallengeHmacKeyVersion,
          nowIso,
          relaySetupExpiresAt,
          sessionId,
          callSid,
          relayNonce,
        )
        .run();
    } catch (error) {
      insertError = error;
    }
    const insertedReplay = await this.readEligibleInboundSessionReplay(
      callSid,
      callerE164,
      currentChallengeHmacKeyVersion,
      nowIso,
    );
    if (insertedReplay !== null) return insertedReplay;
    const stored = await this.readCallSessionByCallSid(callSid);
    if (stored !== null) {
      return this.rejectInboundSessionReplay(stored, callerE164, currentChallengeHmacKeyVersion, nowIso);
    }
    if (await this.hasEligibleInboundCandidate(callerE164, currentChallengeHmacKeyVersion, nowIso)) {
      const active = await this.countActiveSessionsForPrincipalAtCaller(callerE164, nowIso);
      if (active >= 2) throw callSessionAdmissionFailure("call_session_capacity");
    }
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
        relay_setup_expires_at, provider_session_id, phase, created_at, updated_at
      )
      SELECT a.attempt_id, a.relay_call_sid, a.attempt_id, a.principal_id,
        a.destination_identity_id, a.destination_identity_id, 'outbound', 0,
        NULL, NULL, a.relay_nonce, a.nonce_expires_at, NULL, NULL, 'created', ?1, ?1
      FROM outbound_call_attempts a
      WHERE a.attempt_id = ?2
        AND a.relay_call_sid = ?3
        AND a.principal_id = ?4
        AND a.destination_identity_id = ?5
        AND a.destination_identity_id = ?6
        AND a.relay_nonce = ?7
        AND a.provider_dispatch_state = 'dispatched'
        AND (
          SELECT COUNT(*) FROM call_sessions s
          WHERE s.principal_id = a.principal_id
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
      SET provider_session_id = ?1, updated_at = ?2
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
        )]);
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
      .bind(dedupeKey, envelope.eventId, callSid, sessionId, envelope.receivedAt)]);
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

  private async readEligibleInboundSessionReplay(
    callSid: string,
    callerE164: string,
    currentChallengeHmacKeyVersion: string,
    nowIso: string,
  ): Promise<StoredCallSession | null> {
    const row = await this.database.prepare(`SELECT s.*, i.provider_subject AS identity_provider_subject
      FROM call_sessions s
      JOIN principals p ON p.principal_id = s.principal_id
      JOIN channel_identities i ON i.identity_id = s.identity_id
        AND i.principal_id = p.principal_id
      WHERE s.call_sid = ?1
        AND s.direction = 'inbound'
        AND i.provider_subject = ?2
        AND p.principal_type = 'human'
        AND p.status = 'active'
        AND i.channel = 'voice'
        AND s.phase NOT IN ('completed', 'rejected', 'failed', 'expired')
        AND (s.provider_session_id IS NOT NULL OR s.relay_setup_expires_at > ?3)
        AND (
          (
            s.activation_only = 0
            AND i.status = 'active'
            AND i.verified_at IS NOT NULL
          )
          OR
          (
            s.activation_only = 1
            AND s.activation_hmac_key_version = ?4
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
                AND c.created_at <= ?3
                AND c.expires_at > ?3
                AND c.hmac_key_version = s.activation_hmac_key_version
                AND d.key_id = c.initiating_key_id
                AND d.key_fingerprint = c.initiating_key_fingerprint
                AND d.key_generation = c.initiating_key_generation
                AND d.status = 'active'
            )
          )
        )`)
      .bind(callSid, callerE164, nowIso, currentChallengeHmacKeyVersion)
      .first<StoredCallSessionRow>();
    return row === null ? null : this.toStoredCallSession(row);
  }

  private async rejectInboundSessionReplay(
    row: StoredCallSessionRow,
    callerE164: string,
    currentChallengeHmacKeyVersion: string,
    nowIso: string,
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
    throw callSessionAdmissionFailure("inbound_session_rejected");
  }

  private requireOutboundSessionReplay(
    row: StoredCallSessionRow,
    attemptId: Ulid,
    binding: Readonly<RelayBinding>,
  ): StoredCallSession {
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
    ) {
      throw callSessionAdmissionFailure("call_session_conflict");
    }
    return this.toStoredCallSession(row);
  }

  private async hasEligibleInboundCandidate(
    callerE164: string,
    currentChallengeHmacKeyVersion: string,
    nowIso: string,
  ): Promise<boolean> {
    const row = await this.database.prepare(`SELECT 1 AS eligible
      FROM principals p
      JOIN channel_identities i ON i.principal_id = p.principal_id
      WHERE p.principal_type = 'human'
        AND p.status = 'active'
        AND i.channel = 'voice'
        AND i.provider_subject = ?1
        AND (
          (i.status = 'active' AND i.verified_at IS NOT NULL)
          OR (
            i.status = 'pending'
            AND i.verified_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM identity_challenges c
              JOIN device_keys d
                ON d.device_id = c.initiating_device_id
                AND d.principal_id = c.principal_id
              WHERE c.principal_id = p.principal_id
                AND c.identity_id = i.identity_id
                AND c.channel = 'voice'
                AND c.consumed_at IS NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', c.expires_at) IS c.expires_at
                AND strftime('%Y-%m-%dT%H:%M:%fZ', c.created_at) IS c.created_at
                AND c.created_at <= ?2
                AND c.expires_at > ?2
                AND c.hmac_key_version = ?3
                AND d.key_id = c.initiating_key_id
                AND d.key_fingerprint = c.initiating_key_fingerprint
                AND d.key_generation = c.initiating_key_generation
                AND d.status = 'active'
            )
          )
        )
      LIMIT 1`)
      .bind(callerE164, nowIso, currentChallengeHmacKeyVersion)
      .first<{ eligible: number }>();
    return row?.eligible === 1;
  }

  private async countActiveSessionsForPrincipalAtCaller(callerE164: string, nowIso: string): Promise<number> {
    const row = await this.database.prepare(`SELECT COUNT(*) AS count
      FROM call_sessions s
      WHERE s.principal_id = (
          SELECT i.principal_id FROM channel_identities i
          WHERE i.channel = 'voice' AND i.provider_subject = ?1
          LIMIT 1
        )
        AND s.phase NOT IN ('completed', 'rejected', 'failed', 'expired')
        AND NOT (
          s.direction = 'inbound'
          AND s.provider_session_id IS NULL
          AND s.relay_setup_expires_at <= ?2
        )`)
      .bind(callerE164, nowIso)
      .first<{ count: number }>();
    return Number.isSafeInteger(row?.count) ? row?.count ?? 0 : 0;
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
      || !isCallPhase(row.phase)
    ) {
      throw new Error("call_session_row_invalid");
    }
    const nonceExpiresAt = requireCanonicalTimestamp(row.nonce_expires_at, "call_session_nonce_expires_at");
    const relaySetupExpiresAt = row.relay_setup_expires_at === null
      ? null
      : requireCanonicalTimestamp(row.relay_setup_expires_at, "call_session_relay_setup_expires_at");
    const createdAt = requireCanonicalTimestamp(row.created_at, "call_session_created_at");
    const updatedAt = requireCanonicalTimestamp(row.updated_at, "call_session_updated_at");
    const binding: RelayBinding = Object.freeze({
      callSid: row.call_sid,
      principalId: row.principal_id,
      identityId: row.identity_id,
      destinationIdentityId: row.destination_identity_id,
      relayNonce: row.relay_nonce,
      direction: row.direction,
      activationOnly: row.activation_only === 1,
      activationChallengeId: row.activation_challenge_id,
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

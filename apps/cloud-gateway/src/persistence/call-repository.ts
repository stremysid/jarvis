import {
  canonicalJson,
  isPersistableEventEnvelope,
  sha256Hex,
  type ExpectedOutboundCall,
  type PersistableEventEnvelopeV1,
  type RelayBinding,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { ProviderFailure, snapshotProviderFailure, type ProviderFailureCode } from "../providers/provider-types.js";
import {
  EventRepository,
  type AppendedEvent,
} from "./event-repository.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const SESSION_ID = /^VX[0-9A-Fa-f]{32}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CALLBACK_SOURCE = "call-progress-events";
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_TEXT_BYTES = 256;
const encoder = new TextEncoder();

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
  ) {
    if (!Number.isSafeInteger(nonceTtlMs) || nonceTtlMs <= 0) throw new RangeError("relay_nonce_ttl_invalid");
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

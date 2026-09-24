import { DurableObject } from "cloudflare:workers";
import { newUlid, type CallPhase, type RelayBinding, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../env.js";
import type { CapacityGuard } from "../archive/capacity-guard.js";
import {
  createVoiceStreamDelivery,
  type ConversationService,
  type ModelToken,
} from "../conversation/conversation-types.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import { parseRelayEvent, type RelayEvent } from "../providers/conversation-relay.js";
import {
  CallRepository,
  type StoredCallSession,
} from "../persistence/call-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import { VoiceAccessRepository } from "../persistence/voice-access-repository.js";
import { GuestPinVerifier } from "../security/guest-pin-verifier.js";
import { ownerPassphraseFragmentWordCount } from "../security/owner-passphrase-verifier.js";
import {
  IdentityChallengeService,
  VerifiedChannelObservationAuthority,
} from "../sync/identity-challenge.js";
import {
  AuthenticationAttemptBudget,
  evaluatePinAttempt,
} from "./inbound-auth.js";
import { parseOwnerAccessIntent, type OwnerAccessDraft } from "./owner-access-intent.js";
import { OwnerAccessService, type OwnerPinSelection, type PreparedOwnerAccessProposal } from "./owner-access-service.js";
import { FourDigitPinCapture, normalizeSpokenPin } from "./pin-capture.js";
import { createProductionCallSessionCore } from "./production-runtime.js";
import {
  GuestPinProofIssuer,
  type GuestPinAuthenticationProof,
  type VoiceCallAuthority,
  VoiceAccessAuthorityService,
} from "./voice-access-authority.js";
import {
  OUTBOUND_VOICEMAIL_MESSAGE,
  type OutboundPreAuthenticationContract,
  type OutboundSessionInitialization,
} from "./outbound.js";
import {
  OWNER_STEP_UP_ASSEMBLY_MS,
  OWNER_STEP_UP_FORMAT_PROMPT,
  OWNER_STEP_UP_HANDOFF_DATA,
  OWNER_STEP_UP_PROMPT,
  OWNER_STEP_UP_REJECTED,
  OWNER_STEP_UP_RETRY_PROMPT,
  OWNER_STEP_UP_VERIFIED,
  type OwnerCallStepUpService,
  type OwnerStepUpAlertSink,
} from "./owner-call-step-up.js";

type RelaySetupEvent = Extract<RelayEvent, { type: "setup" }>;
type RelayDtmfEvent = Extract<RelayEvent, { type: "dtmf" }>;

const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const ACCOUNT_SID = /^AC[0-9A-Fa-f]{32}$/u;
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const ACTIVATION_RESPONSE = /^\d{6}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_RELAY_FRAME_BYTES = 64 * 1024;
const INITIALIZATION_KEY = "call-session.initialization.v1";
const TERMINATION_KEY = "call-session.termination.v1";
const OWNER_STEP_UP_ALARM_KEY = "call-session.owner-step-up-alarm.v1";
interface StoredOwnerStepUpAlarm {
  readonly sessionId: Ulid;
  readonly lifecycleGeneration: 1;
  readonly kind: "window" | "assembly";
  readonly deadlineAt: string;
}
const BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce",
  "direction", "activationOnly", "activationChallengeId",
  "accessKind", "guestGrantId", "guestGrantVersion", "accessDocumentHash",
]);
const ACTIVATION_DEPENDENCY_FIELDS = new Set([
  "database", "budgets", "observations", "challenges",
]);
const ACTIVATION_INPUT_FIELDS = new Set(["sessionId", "binding", "response", "now"]);
const PRE_AUTHENTICATION_FIELDS = new Set(["voicemailMessage"]);
const INBOUND_INITIALIZATION_FIELDS = new Set(["sessionId", "binding", "relaySetupExpiresAt"]);
const OUTBOUND_INITIALIZATION_FIELDS = new Set([
  "sessionId", "binding", "relaySetupExpiresAt", "preAuthentication",
]);
const SOCKET_ATTACHMENT_FIELDS = new Set(["sessionId"]);
const TERMINATION_FIELDS = new Set(["sessionId", "phase", "reason"]);
const TERMINATION_RECORD_FIELDS = new Set([
  "sessionId", "phase", "reason", "callSid", "providerSessionId", "durablePhase", "cleanupState",
]);
const GUEST_AUTHENTICATION_DEPENDENCY_FIELDS = new Set(["repository", "budgets", "verifier", "proofs"]);
const GUEST_AUTHENTICATION_INPUT_FIELDS = new Set(["pinDigits", "sessionId", "binding", "now"]);
const encoder = new TextEncoder();

const reserveActivationAttempt = AuthenticationAttemptBudget.prototype.reserveActivationAttempt;
const issueObservation = VerifiedChannelObservationAuthority.prototype.issue;
const confirmIdentityChallenge = IdentityChallengeService.prototype.confirm;
const reserveGuestPinAttempt = AuthenticationAttemptBudget.prototype.reservePinAttempt;

function exactDataRecord(value: unknown, fields: ReadonlySet<string>, error: string): Record<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
    keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : [];
  } catch {
    throw new TypeError(error);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || prototype !== Object.prototype
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))
  ) {
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

function snapshotBinding(value: unknown): RelayBinding {
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
    || input.direction === "inbound" && input.identityId !== input.destinationIdentityId
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
    accessKind: input.accessKind,
    guestGrantId: input.guestGrantId as string | null,
    guestGrantVersion: input.guestGrantVersion as number | null,
    accessDocumentHash: input.accessDocumentHash as string | null,
  }) as RelayBinding;
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

function snapshotDate(value: unknown): Date {
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { throw new TypeError("phone_activation_time_invalid"); }
  if (!Number.isFinite(epochMs)) throw new TypeError("phone_activation_time_invalid");
  return new Date(epochMs);
}

export interface InboundCallSessionInitialization {
  readonly sessionId: Ulid;
  readonly binding: RelayBinding;
  readonly relaySetupExpiresAt: string;
}

export type CallSessionInitialization = InboundCallSessionInitialization | OutboundSessionInitialization;

export type CallSessionTerminalPhase = "completed" | "failed";

export interface CallSessionTermination {
  readonly sessionId: Ulid;
  readonly phase: CallSessionTerminalPhase;
  readonly reason: "provider_callback";
}

export interface CallSessionTerminationResult {
  readonly sessionId: Ulid;
  readonly terminalPhase: CallSessionTerminalPhase;
  readonly invalidated: boolean;
  readonly outcome: "applied" | "replayed" | "recovered";
}

export type CallSessionTerminationErrorCode =
  | "call_session_object_mismatch"
  | "call_session_termination_uninitialized"
  | "call_session_termination_binding_mismatch"
  | "call_session_termination_state_conflict"
  | "call_session_termination_conflict"
  | "call_session_termination_corrupt"
  | "call_session_termination_cleanup_failed";

export class CallSessionTerminationError extends Error {
  constructor(readonly code: CallSessionTerminationErrorCode) {
    super(code);
    this.name = "CallSessionTerminationError";
  }
}

type DurableCallSessionTerminalPhase = Extract<CallPhase, "completed" | "rejected" | "failed" | "expired">;

interface StoredCallSessionTermination extends CallSessionTermination {
  readonly callSid: string;
  readonly providerSessionId: string | null;
  readonly durablePhase: DurableCallSessionTerminalPhase;
  readonly cleanupState: "pending" | "complete";
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function snapshotPreAuthentication(value: unknown): OutboundPreAuthenticationContract {
  const input = exactDataRecord(
    value,
    PRE_AUTHENTICATION_FIELDS,
    "call_session_initialization_invalid",
  );
  if (input.voicemailMessage !== OUTBOUND_VOICEMAIL_MESSAGE) {
    throw new TypeError("call_session_initialization_invalid");
  }
  return Object.freeze({ voicemailMessage: OUTBOUND_VOICEMAIL_MESSAGE });
}

function snapshotInitialization(value: unknown): Readonly<CallSessionInitialization> {
  let keys: readonly PropertyKey[];
  try { keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : []; }
  catch { throw new TypeError("call_session_initialization_invalid"); }
  const outbound = keys.includes("preAuthentication");
  const input = exactDataRecord(
    value,
    outbound ? OUTBOUND_INITIALIZATION_FIELDS : INBOUND_INITIALIZATION_FIELDS,
    "call_session_initialization_invalid",
  );
  if (typeof input.sessionId !== "string" || !ULID.test(input.sessionId)) {
    throw new TypeError("call_session_initialization_invalid");
  }
  const sessionId = input.sessionId as Ulid;
  const binding = snapshotBinding(input.binding);
  if (outbound) {
    if (binding.direction !== "outbound" || input.relaySetupExpiresAt !== null) {
      throw new TypeError("call_session_initialization_invalid");
    }
    return Object.freeze({
      sessionId,
      binding,
      relaySetupExpiresAt: null,
      preAuthentication: snapshotPreAuthentication(input.preAuthentication),
    });
  }
  if (binding.direction !== "inbound" || !canonicalTimestamp(input.relaySetupExpiresAt)) {
    throw new TypeError("call_session_initialization_invalid");
  }
  return Object.freeze({ sessionId, binding, relaySetupExpiresAt: input.relaySetupExpiresAt });
}

function sameBinding(left: RelayBinding, right: RelayBinding): boolean {
  return left.callSid === right.callSid
    && left.principalId === right.principalId
    && left.identityId === right.identityId
    && left.destinationIdentityId === right.destinationIdentityId
    && left.relayNonce === right.relayNonce
    && left.direction === right.direction
    && left.activationOnly === right.activationOnly
    && left.activationChallengeId === right.activationChallengeId
    && left.accessKind === right.accessKind
    && left.guestGrantId === right.guestGrantId
    && left.guestGrantVersion === right.guestGrantVersion
    && left.accessDocumentHash === right.accessDocumentHash;
}

function sameInitialization(
  left: Readonly<CallSessionInitialization>,
  right: Readonly<CallSessionInitialization>,
): boolean {
  const leftPreAuthentication = "preAuthentication" in left ? left.preAuthentication : null;
  const rightPreAuthentication = "preAuthentication" in right ? right.preAuthentication : null;
  return left.sessionId === right.sessionId
    && sameBinding(left.binding, right.binding)
    && left.relaySetupExpiresAt === right.relaySetupExpiresAt
    && leftPreAuthentication?.voicemailMessage === rightPreAuthentication?.voicemailMessage;
}

function initializationMatchesSession(
  initialization: Readonly<CallSessionInitialization>,
  session: Readonly<StoredCallSession>,
): boolean {
  return initialization.sessionId === session.sessionId
    && sameBinding(initialization.binding, session.binding)
    && initialization.relaySetupExpiresAt === session.relaySetupExpiresAt;
}

function snapshotSocketSessionId(socket: WebSocket): Ulid | null {
  let attachment: unknown;
  try { attachment = socket.deserializeAttachment(); }
  catch { return null; }
  try {
    const input = exactDataRecord(attachment, SOCKET_ATTACHMENT_FIELDS, "relay_socket_attachment_invalid");
    return typeof input.sessionId === "string" && ULID.test(input.sessionId)
      ? input.sessionId as Ulid
      : null;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try { socket.close(code, reason); }
  catch { /* A failed close cannot grant relay authority. */ }
}

function fixedResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

interface PhoneActivationChallengeConfirmerSetup {
  readonly database: D1Database;
  readonly budgets: AuthenticationAttemptBudget;
  readonly observations: VerifiedChannelObservationAuthority;
  readonly challenges: IdentityChallengeService;
}

/** Binds the signed local challenge to the exact relay session before confirming it. */
export class PhoneActivationChallengeConfirmer {
  readonly #database: D1Database;
  readonly #repository: DeviceRepository;
  readonly #budgets: AuthenticationAttemptBudget;
  readonly #observations: VerifiedChannelObservationAuthority;
  readonly #challenges: IdentityChallengeService;

  constructor(rawInput: PhoneActivationChallengeConfirmerSetup) {
    const input = exactDataRecord(
      rawInput,
      ACTIVATION_DEPENDENCY_FIELDS,
      "phone_activation_configuration_invalid",
    );
    if (
      input.database === null
      || typeof input.database !== "object"
      || !(input.budgets instanceof AuthenticationAttemptBudget)
      || !(input.observations instanceof VerifiedChannelObservationAuthority)
      || !(input.challenges instanceof IdentityChallengeService)
    ) {
      throw new TypeError("phone_activation_configuration_invalid");
    }
    this.#database = input.database as D1Database;
    this.#repository = new DeviceRepository(input.database as D1Database);
    this.#budgets = input.budgets;
    this.#observations = input.observations;
    this.#challenges = input.challenges;
  }

  async confirm(rawInput: {
    readonly sessionId: Ulid;
    readonly binding: RelayBinding;
    readonly response: string;
    readonly now: Date;
  }): Promise<{ readonly identityId: string; readonly state: "active" }> {
    const input = exactDataRecord(rawInput, ACTIVATION_INPUT_FIELDS, "phone_activation_input_invalid");
    const sessionId = input.sessionId;
    const binding = snapshotBinding(input.binding);
    const response = input.response;
    const now = snapshotDate(input.now);
    if (typeof sessionId !== "string" || !ULID.test(sessionId)
      || typeof response !== "string" || !ACTIVATION_RESPONSE.test(response)) {
      throw new TypeError("phone_activation_input_invalid");
    }
    if (!binding.activationOnly || binding.activationChallengeId === null || binding.accessKind !== "owner") {
      throw new TypeError("phone_activation_input_invalid");
    }
    const session = await this.#database.prepare(`SELECT 1 AS valid
      FROM call_sessions
      WHERE session_id = ? AND call_sid = ? AND principal_id = ? AND identity_id = ?
        AND destination_identity_id = ? AND relay_nonce = ? AND direction = ?
        AND activation_only = 1 AND activation_challenge_id = ? AND access_kind = 'owner'
        AND guest_grant_id IS NULL AND guest_grant_version IS NULL AND access_document_hash IS NULL
        AND provider_session_id IS NOT NULL AND phase = 'pre_auth'`)
      .bind(
        sessionId,
        binding.callSid,
        binding.principalId,
        binding.identityId,
        binding.destinationIdentityId,
        binding.relayNonce,
        binding.direction,
        binding.activationChallengeId,
      )
      .first<{ valid: number }>();
    if (session?.valid !== 1) throw new Error("phone_activation_session_invalid");
    if (!await reserveActivationAttempt.call(this.#budgets, { binding, now })) {
      throw new Error("authentication_budget_exhausted");
    }
    const challenge = await this.#repository.readIdentityChallenge(binding.activationChallengeId);
    if (challenge === null
      || challenge.challenge_id !== binding.activationChallengeId
      || challenge.principal_id !== binding.principalId
      || challenge.identity_id !== binding.identityId
      || challenge.channel !== "voice") {
      throw new Error("identity_challenge_mismatch");
    }
    const observation = issueObservation.call(this.#observations, {
      challengeId: challenge.challenge_id,
      providerRequestId: `voice:call-session:${sessionId}`,
      channel: "phone",
      principalId: binding.principalId,
      identityId: binding.identityId,
      response,
      initiatingDeviceId: challenge.initiating_device_id,
      initiatingKeyId: challenge.initiating_key_id,
      initiatingKeyFingerprint: challenge.initiating_key_fingerprint,
      initiatingKeyGeneration: challenge.initiating_key_generation,
    });
    return confirmIdentityChallenge.call(this.#challenges, observation);
  }
}

export interface CallSessionRelay {
  close(code: number): void;
  sendNeutralText(text: string): Promise<void>;
  sendToken(token: ModelToken): Promise<void>;
  finish(finalText: string): Promise<void>;
  cancelOutput(): Promise<void>;
  end?(handoffData: string): Promise<void>;
}

function snapshotTermination(value: unknown): Readonly<CallSessionTermination> {
  const captured = exactDataRecord(value, TERMINATION_FIELDS, "call_session_termination_invalid");
  if (
    typeof captured.sessionId !== "string" || !ULID.test(captured.sessionId)
    || captured.phase !== "completed" && captured.phase !== "failed"
    || captured.reason !== "provider_callback"
  ) throw new TypeError("call_session_termination_invalid");
  return Object.freeze({
    sessionId: captured.sessionId as Ulid,
    phase: captured.phase,
    reason: captured.reason,
  });
}

function terminationFailure(code: CallSessionTerminationErrorCode): CallSessionTerminationError {
  return new CallSessionTerminationError(code);
}

function sameTermination(
  left: Readonly<CallSessionTermination>,
  right: Readonly<CallSessionTermination>,
): boolean {
  return left.sessionId === right.sessionId
    && left.phase === right.phase
    && left.reason === right.reason;
}

function snapshotTerminationRecord(value: unknown): Readonly<StoredCallSessionTermination> {
  const captured = exactDataRecord(value, TERMINATION_RECORD_FIELDS, "call_session_termination_corrupt");
  if (
    typeof captured.sessionId !== "string" || !ULID.test(captured.sessionId)
    || captured.phase !== "completed" && captured.phase !== "failed"
    || captured.reason !== "provider_callback"
    || typeof captured.callSid !== "string" || !CALL_SID.test(captured.callSid)
    || captured.providerSessionId !== null
      && (typeof captured.providerSessionId !== "string" || !/^VX[0-9A-Fa-f]{32}$/u.test(captured.providerSessionId))
    || captured.durablePhase !== "completed" && captured.durablePhase !== "rejected"
      && captured.durablePhase !== "failed" && captured.durablePhase !== "expired"
    || captured.cleanupState !== "pending" && captured.cleanupState !== "complete"
  ) {
    throw terminationFailure("call_session_termination_corrupt");
  }
  return Object.freeze({
    sessionId: captured.sessionId as Ulid,
    phase: captured.phase,
    reason: captured.reason,
    callSid: captured.callSid,
    providerSessionId: captured.providerSessionId,
    durablePhase: captured.durablePhase,
    cleanupState: captured.cleanupState,
  });
}

export interface GuestCallAuthenticationSetup {
  readonly repository: VoiceAccessRepository;
  readonly budgets: AuthenticationAttemptBudget;
  readonly verifier: GuestPinVerifier;
  readonly proofs: GuestPinProofIssuer;
}

/** Reserves the Task 4 budget, verifies only the bound grant, and issues one nominal proof. */
export class GuestCallAuthentication {
  readonly #repository: VoiceAccessRepository;
  readonly #budgets: AuthenticationAttemptBudget;
  readonly #verifier: GuestPinVerifier;
  readonly #proofs: GuestPinProofIssuer;

  constructor(value: GuestCallAuthenticationSetup) {
    const input = exactDataRecord(
      value,
      GUEST_AUTHENTICATION_DEPENDENCY_FIELDS,
      "guest_call_authentication_configuration_invalid",
    );
    if (
      !(input.repository instanceof VoiceAccessRepository)
      || !(input.budgets instanceof AuthenticationAttemptBudget)
      || !(input.verifier instanceof GuestPinVerifier)
      || !(input.proofs instanceof GuestPinProofIssuer)
    ) {
      throw new TypeError("guest_call_authentication_configuration_invalid");
    }
    this.#repository = input.repository;
    this.#budgets = input.budgets;
    this.#verifier = input.verifier;
    this.#proofs = input.proofs;
  }

  async authenticate(value: {
    readonly pinDigits: Uint8Array;
    readonly sessionId: Ulid;
    readonly binding: RelayBinding;
    readonly now: Date;
  }): Promise<Readonly<{ proof: GuestPinAuthenticationProof | null; attemptOrdinal: number }>> {
    const input = exactDataRecord(
      value,
      GUEST_AUTHENTICATION_INPUT_FIELDS,
      "guest_call_authentication_input_invalid",
    );
    if (typeof input.sessionId !== "string" || !ULID.test(input.sessionId)) {
      throw new TypeError("guest_call_authentication_input_invalid");
    }
    const binding = snapshotBinding(input.binding);
    const now = snapshotDate(input.now);
    const pinDigits = input.pinDigits;
    if (
      !(pinDigits instanceof Uint8Array)
      || pinDigits.byteLength !== 4
      || binding.accessKind !== "guest"
      || binding.guestGrantId === null
      || binding.guestGrantVersion === null
      || binding.accessDocumentHash === null
    ) {
      if (pinDigits instanceof Uint8Array) pinDigits.fill(0);
      throw new TypeError("guest_call_authentication_input_invalid");
    }
    const reserved = await reserveGuestPinAttempt.call(this.#budgets, { binding, now });
    if (!reserved) {
      pinDigits.fill(0);
      throw new Error("authentication_budget_exhausted");
    }
    const attemptOrdinal = await this.#repository.reserveGuestPinAttempt(input.sessionId as Ulid, now);
    const grant = await this.#repository.getGuestGrant(binding.guestGrantId);
    if (
      grant === null
      || !["pending", "active"].includes(grant.status)
      || grant.principalId !== binding.principalId
      || grant.identityId !== binding.identityId
      || grant.grantVersion !== binding.guestGrantVersion
      || grant.accessDocumentHash !== binding.accessDocumentHash
    ) {
      pinDigits.fill(0);
      throw new Error("call_authority_stale");
    }
    if (!await this.#verifier.verify(grant.grantId, pinDigits, grant.pinVerifier)) {
      return Object.freeze({ proof: null, attemptOrdinal });
    }
    const proof = this.#proofs.issue({
      sessionId: input.sessionId as Ulid,
      callSid: binding.callSid,
      relayNonce: binding.relayNonce,
      direction: binding.direction,
      principalId: binding.principalId,
      identityId: binding.identityId,
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      accessDocumentHash: grant.accessDocumentHash,
      authenticatedAt: now,
    });
    return Object.freeze({ proof, attemptOrdinal });
  }
}

type CallInteraction =
  | Readonly<{ kind: "owner_step_up" }>
  | Readonly<{ kind: "owner_enrollment" }>
  | Readonly<{ kind: "guest_pin" }>
  | Readonly<{ kind: "conversation" }>
  | Readonly<{ kind: "owner_access_pin"; proposal: PreparedOwnerAccessProposal }>
  | Readonly<{
    kind: "owner_access_confirmation";
    proposal: PreparedOwnerAccessProposal;
    pinSelection: OwnerPinSelection | null;
  }>;

export interface CallSessionCoreSetup {
  readonly capacity: Pick<CapacityGuard, "assertAcceptingNewTurn">;
  readonly session: StoredCallSession;
  readonly expectedAccountSid: string;
  readonly repository: CallRepository;
  readonly authority?: VoiceAccessAuthorityService | null;
  readonly guestAuthentication?: GuestCallAuthentication | null;
  readonly activation?: PhoneActivationChallengeConfirmer | null;
  readonly ownerAccess?: OwnerAccessService | null;
  readonly ownerStepUp?: OwnerCallStepUpService | null;
  readonly ownerStepUpAlerts?: OwnerStepUpAlertSink | null;
  readonly ownerStepUpAlarm?: OwnerStepUpAlarmPort | null;
  readonly conversation?: ConversationService | null;
  readonly preAuthentication?: OutboundPreAuthenticationContract;
  readonly relay: CallSessionRelay;
  readonly newTurnId?: () => Ulid;
  readonly now: () => Date;
}

export interface OwnerStepUpAlarmPort {
  arm(input: Readonly<{
    sessionId: Ulid;
    lifecycleGeneration: 1;
    kind: "window" | "assembly";
    deadlineAt: string;
  }>): Promise<void>;
  clear(): Promise<void>;
}

class TurnInProgressError extends Error {
  constructor() {
    super("turn_in_progress");
  }
}

/**
 * Dependency-independent portion of the per-call state machine.
 * Conversation streaming and the Durable Object wrapper are added only after
 * the committed Task 5 delivery/sanitizer contract is available.
 */
export class CallSessionCore {
  #session: StoredCallSession;
  readonly #expectedAccountSid: string;
  readonly #repository: CallRepository;
  readonly #authorityService: VoiceAccessAuthorityService | null;
  readonly #guestAuthentication: GuestCallAuthentication | null;
  readonly #activation: PhoneActivationChallengeConfirmer | null;
  readonly #ownerAccess: OwnerAccessService | null;
  readonly #ownerStepUp: OwnerCallStepUpService | null;
  readonly #ownerStepUpAlerts: OwnerStepUpAlertSink | null;
  readonly #ownerStepUpAlarm: OwnerStepUpAlarmPort | null;
  readonly #conversation: ConversationService | null;
  readonly #assertCapacity: () => Promise<void>;
  readonly #preAuthentication: OutboundPreAuthenticationContract | null;
  readonly #relay: CallSessionCoreSetup["relay"];
  readonly #newTurnId: () => Ulid;
  readonly #now: () => Date;
  #relaySetupVerified: boolean;
  #setupHandledInThisInstance = false;
  readonly #guestPin = new FourDigitPinCapture();
  readonly #ownerAccessPin = new FourDigitPinCapture();
  #activationDigits = "";
  #activationAttempted = false;
  #ownerStepUpFragments: string[] = [];
  #ownerStepUpFragmentStartedAt: number | null = null;
  #ownerRepeatFragments: string[] = [];
  #ownerRepeatFragmentStartedAt: number | null = null;
  #ownerStepUpDeadlineAt: string | null = null;
  #ownerStepUpVerificationInFlight = false;
  #ownerStepUpRepromptInFlight = false;
  #ownerStepUpRejection: Promise<void> | null = null;
  #activeTurnAbort: AbortController | null = null;
  #lastSentAssistantEventId: Ulid | null = null;
  #socketClosed = false;
  #authority: VoiceCallAuthority | null = null;
  #interaction: CallInteraction;
  #lifecycleGeneration = 0;
  #terminationCleanupComplete = false;
  #terminationCleanupInFlight: Promise<void> | null = null;

  constructor(input: CallSessionCoreSetup) {
    const capacity = input.capacity;
    const assertCapacity = capacity?.assertAcceptingNewTurn;
    if (
      typeof assertCapacity !== "function"
      || !(input.repository instanceof CallRepository)
      || input.authority !== undefined && input.authority !== null
        && !(input.authority instanceof VoiceAccessAuthorityService)
      || input.guestAuthentication !== undefined && input.guestAuthentication !== null
        && !(input.guestAuthentication instanceof GuestCallAuthentication)
      || input.activation !== undefined && input.activation !== null
        && !(input.activation instanceof PhoneActivationChallengeConfirmer)
      || input.ownerAccess !== undefined && input.ownerAccess !== null
        && !(input.ownerAccess instanceof OwnerAccessService)
      || input.ownerStepUp !== undefined && input.ownerStepUp !== null
        && typeof input.ownerStepUp.verifyCandidate !== "function"
      || input.ownerStepUpAlerts !== undefined && input.ownerStepUpAlerts !== null
        && typeof input.ownerStepUpAlerts.alert !== "function"
      || input.ownerStepUpAlarm !== undefined && input.ownerStepUpAlarm !== null
        && (typeof input.ownerStepUpAlarm.arm !== "function" || typeof input.ownerStepUpAlarm.clear !== "function")
      || typeof input.expectedAccountSid !== "string"
      || !ACCOUNT_SID.test(input.expectedAccountSid)
    ) {
      throw new TypeError("call_session_configuration_invalid");
    }
    this.#session = input.session;
    this.#expectedAccountSid = input.expectedAccountSid;
    this.#repository = input.repository;
    this.#authorityService = input.authority ?? null;
    this.#guestAuthentication = input.guestAuthentication ?? null;
    this.#activation = input.activation ?? null;
    this.#ownerAccess = input.ownerAccess ?? null;
    this.#ownerStepUp = input.ownerStepUp ?? null;
    this.#ownerStepUpAlerts = input.ownerStepUpAlerts ?? null;
    this.#ownerStepUpAlarm = input.ownerStepUpAlarm ?? null;
    this.#conversation = input.conversation ?? null;
    this.#assertCapacity = assertCapacity.bind(capacity);
    this.#preAuthentication = input.preAuthentication === undefined
      ? null
      : snapshotPreAuthentication(input.preAuthentication);
    if (this.#preAuthentication !== null && input.session.direction !== "outbound") {
      throw new TypeError("call_session_pre_authentication_invalid");
    }
    this.#relay = input.relay;
    this.#newTurnId = input.newTurnId ?? newUlid;
    this.#now = input.now;
    this.#relaySetupVerified = input.session.providerSessionId !== null;
    this.#interaction = Object.freeze({
      kind: input.session.phase === "authenticated" || input.session.phase === "active"
        ? "conversation"
        : input.session.binding.accessKind === "guest"
        ? "guest_pin"
        : input.session.binding.activationOnly
          ? "owner_enrollment"
          : "owner_step_up",
    }) as CallInteraction;
  }

  get phase(): StoredCallSession["phase"] {
    return this.#session.phase;
  }

  get canResumeRejectedOwnerStepUp(): boolean {
    return this.#session.phase === "rejected" && this.#interaction.kind === "owner_step_up";
  }

  validateRelaySetup(actual: RelaySetupEvent): void {
    if (
      this.#session.phase !== "created"
      || this.#session.providerSessionId !== null
      || actual.accountSid !== this.#expectedAccountSid
      || actual.callSid !== this.#session.callSid
      || actual.relayNonce !== this.#session.binding.relayNonce
      || actual.direction !== this.#session.direction
    ) {
      throw new Error("relay_binding_rejected");
    }
  }

  async handleRelayEvent(event: RelayEvent): Promise<void> {
    if (this.#socketClosed) return;
    if (event.type === "setup") {
      await this.#handleRelaySetup(event);
      return;
    }
    if (!this.#relaySetupVerified) throw new Error("relay_setup_required");
    if (this.#session.phase === "created" || this.#session.phase === "connecting") {
      await this.#resumeBoundPreAuthentication(this.#now());
    }
    await this.#rehydrateAuthority(this.#now());
    switch (event.type) {
      case "dtmf":
        await this.#handleDtmf(event);
        return;
      case "prompt":
        await this.#handlePrompt(event);
        return;
      case "interrupt":
        this.#clearOwnerStepUpFragments();
        this.#clearOwnerRepeatFragments();
        if (this.#interaction.kind === "owner_step_up" && this.#ownerStepUp !== null) {
          const observedAt = this.#now();
          const state = await this.#ownerStepUp.reconcileState(this.#session.sessionId, observedAt);
          if (state.rejectionReason !== null) {
            await this.#rejectOwnerStepUp(observedAt, true);
            return;
          }
          this.#ownerStepUpDeadlineAt = state.deadlineAt;
          if (this.#ownerStepUpDeadlineAt !== null) {
            await this.#ownerStepUpAlarm?.arm({
              sessionId: this.#session.sessionId, lifecycleGeneration: 1,
              kind: "window", deadlineAt: this.#ownerStepUpDeadlineAt,
            });
          }
        }
        await this.#cancelCurrentOutput();
        return;
      case "error":
        await this.handleSocketClose("provider_error");
        return;
    }
  }

  async #handleRelaySetup(event: RelaySetupEvent): Promise<void> {
    if (this.#setupHandledInThisInstance) {
      this.#clearAuthenticationState();
      this.#relay.close(1008);
      throw new Error("relay_setup_replayed");
    }

    const alreadyBound = this.#relaySetupVerified;
    const observedAt = this.#now();
    try {
      if (alreadyBound) this.#validateBoundRelaySetup(event);
      else this.validateRelaySetup(event);
      this.#session = await this.#repository.bindRelaySession({
        sessionId: this.#session.sessionId,
        callSid: event.callSid,
        providerSessionId: event.sessionId,
        relayNonce: event.relayNonce,
        direction: event.direction,
        now: observedAt,
      });
    } catch {
      this.#clearAuthenticationState();
      this.#relay.close(1008);
      throw new Error("relay_binding_rejected");
    }
    this.#relaySetupVerified = true;
    await this.#resumeBoundPreAuthentication(observedAt);
    this.#setupHandledInThisInstance = true;
  }

  #validateBoundRelaySetup(actual: RelaySetupEvent): void {
    if (
      this.#session.providerSessionId === null
      || actual.sessionId !== this.#session.providerSessionId
      || this.#session.phase !== "created" && this.#session.phase !== "connecting"
        && this.#session.phase !== "pre_auth"
      || actual.accountSid !== this.#expectedAccountSid
      || actual.callSid !== this.#session.callSid
      || actual.relayNonce !== this.#session.binding.relayNonce
      || actual.direction !== this.#session.direction
    ) {
      throw new Error("relay_binding_rejected");
    }
  }

  async #resumeBoundPreAuthentication(observedAt: Date): Promise<void> {
    let enteredPreAuthentication = false;
    if (this.#session.phase === "created") {
      this.#session = await this.#repository.transitionCallSession({
        sessionId: this.#session.sessionId,
        expectedPhase: "created",
        nextPhase: "connecting",
        now: observedAt,
      });
    }
    if (this.#session.phase === "connecting") {
      this.#session = await this.#repository.transitionCallSession({
        sessionId: this.#session.sessionId,
        expectedPhase: "connecting",
        nextPhase: "pre_auth",
        now: observedAt,
      });
      enteredPreAuthentication = true;
    }
    if (enteredPreAuthentication && this.#preAuthentication !== null) {
      await this.#relay.sendNeutralText(this.#preAuthentication.voicemailMessage);
    }
    if (this.#session.phase === "pre_auth") {
      if (this.#session.binding.activationOnly) {
        this.#interaction = Object.freeze({ kind: "owner_enrollment" });
        if (enteredPreAuthentication) {
          await this.#relay.sendNeutralText(
            "Enter the one-time phone enrollment challenge shown in your local Jarvis CLI.",
          );
        }
      } else if (this.#authorityService !== null && this.#session.binding.accessKind === "owner") {
        if (this.#ownerStepUp === null || this.#ownerStepUpAlarm === null) {
          throw new Error("owner_step_up_unavailable");
        }
        const binding = await this.#ownerStepUp.binding(this.#session.sessionId);
        if (binding === null) throw new Error("owner_step_up_binding_missing");
        if (binding.requirement === "waived_passed_a") {
          try {
            await this.#ownerStepUp.assertWaiverAvailable(this.#session.sessionId);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "owner_step_up_unavailable") throw error;
            this.#interaction = Object.freeze({ kind: "owner_step_up" });
            const state = await this.#ownerStepUp.reconcileState(this.#session.sessionId, observedAt);
            if (state.rejectionReason === null) throw error;
            await this.#rejectOwnerStepUp(observedAt, true);
            return;
          }
          await this.#mintWaivedOwner(observedAt);
        } else if (binding.requirement === "required") {
          let window;
          try { window = await this.#ownerStepUp.begin(this.#session.sessionId, observedAt); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "owner_step_up_disabled") throw error;
            this.#interaction = Object.freeze({ kind: "owner_step_up" });
            await this.#rejectOwnerStepUp(observedAt, true);
            return;
          }
          this.#ownerStepUpDeadlineAt = window.deadlineAt;
          this.#interaction = Object.freeze({ kind: "owner_step_up" });
          await this.#ownerStepUpAlarm.arm({
            sessionId: this.#session.sessionId, lifecycleGeneration: 1,
            kind: "window", deadlineAt: window.deadlineAt,
          });
          if (enteredPreAuthentication) await this.#relay.sendNeutralText(OWNER_STEP_UP_PROMPT);
        } else {
          throw new Error("owner_step_up_binding_invalid");
        }
      } else if (this.#authorityService !== null && this.#session.binding.accessKind === "guest") {
        this.#interaction = Object.freeze({ kind: "guest_pin" });
        if (enteredPreAuthentication) await this.#relay.sendNeutralText("Enter your four digit PIN.");
      }
    }
  }

  async #mintWaivedOwner(observedAt: Date): Promise<void> {
    if (this.#authorityService === null) throw new Error("owner_authority_unavailable");
    this.#authority = await this.#authorityService.mintOwner({
      sessionId: this.#session.sessionId,
      binding: this.#session.binding,
      now: observedAt,
    });
    const authenticated = await this.#repository.getCallSession(this.#session.sessionId);
    if (authenticated === null || authenticated.phase !== "authenticated") throw new Error("call_authority_write_failed");
    this.#session = authenticated;
    await this.#transition("active", observedAt);
    this.#interaction = Object.freeze({ kind: "conversation" });
  }

  async #rehydrateAuthority(observedAt: Date): Promise<void> {
    if (
      this.#authority !== null
      || this.#authorityService === null
      || this.#session.binding.activationOnly
      || this.#session.phase !== "authenticated" && this.#session.phase !== "active"
    ) return;
    try {
      this.#authority = await this.#authorityService.rehydrate({
        sessionId: this.#session.sessionId,
        binding: this.#session.binding,
        now: observedAt,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "call_authority_expired") {
        await this.#transition("expired", observedAt);
      }
      throw error;
    }
    this.#interaction = Object.freeze({ kind: "conversation" });
  }

  #clearAuthenticationState(): void {
    this.#guestPin.clear();
    this.#activationDigits = "";
  }

  #clearOwnerAccessState(): void {
    const interaction = this.#interaction;
    if (interaction.kind === "owner_access_confirmation" && interaction.pinSelection?.kind === "explicit") {
      interaction.pinSelection.digits.fill(0);
    }
    if (interaction.kind === "owner_access_pin" || interaction.kind === "owner_access_confirmation") {
      this.#ownerAccess?.invalidate(interaction.proposal);
      this.#interaction = Object.freeze({ kind: "conversation" });
    }
    this.#ownerAccessPin.clear();
  }

  async #beginOwnerAccess(draft: OwnerAccessDraft, observedAt: Date): Promise<void> {
    if (this.#ownerAccess === null || this.#authorityService === null || this.#authority?.kind !== "owner") {
      throw new Error("owner_access_unavailable");
    }
    this.#clearOwnerAccessState();
    await this.#authorityService.authorize(this.#authority, "access.manage", observedAt);
    const proposal = await this.#ownerAccess.prepare({
      ownerAuthority: this.#authority,
      sessionId: this.#session.sessionId,
      draft,
      now: observedAt,
    });
    if (proposal.operation === "add" || proposal.operation === "rotate_pin") {
      this.#interaction = Object.freeze({ kind: "owner_access_pin", proposal });
      await this.#relay.sendNeutralText(
        `Enter four digits or say use the default for ${proposal.maskedTarget ?? "the caller"}.`,
      );
      return;
    }
    this.#interaction = Object.freeze({
      kind: "owner_access_confirmation",
      proposal,
      pinSelection: null,
    });
    await this.#relay.sendNeutralText("Say confirm to apply this access change, or cancel.");
  }

  async #captureOwnerAccessPin(event: Extract<RelayEvent, { type: "prompt" }>): Promise<void> {
    if (this.#interaction.kind !== "owner_access_pin") return;
    let pinSelection: OwnerPinSelection;
    if (event.text === "use the default") {
      pinSelection = Object.freeze({ kind: "default" });
    } else {
      const digits = normalizeSpokenPin(event.text);
      if (digits === null) {
        await this.#relay.sendNeutralText("Use the keypad, say exactly four digits, or say use the default.");
        return;
      }
      pinSelection = Object.freeze({ kind: "explicit", digits });
    }
    this.#interaction = Object.freeze({
      kind: "owner_access_confirmation",
      proposal: this.#interaction.proposal,
      pinSelection,
    });
    await this.#relay.sendNeutralText("Say confirm to apply this access change, or cancel.");
  }

  async #confirmOwnerAccess(text: string, observedAt: Date): Promise<void> {
    if (this.#interaction.kind !== "owner_access_confirmation") return;
    if (text === "cancel") {
      this.#clearOwnerAccessState();
      await this.#relay.sendNeutralText("Access change cancelled.");
      return;
    }
    if (text !== "confirm") {
      await this.#relay.sendNeutralText("Say confirm to apply this access change, or cancel.");
      return;
    }
    if (this.#ownerAccess === null || this.#authority?.kind !== "owner") {
      this.#clearOwnerAccessState();
      throw new Error("owner_access_unavailable");
    }
    const interaction = this.#interaction;
    try {
      const result = await this.#ownerAccess.execute({
        proposal: interaction.proposal,
        ownerAuthority: this.#authority,
        pinSelection: interaction.pinSelection,
        now: observedAt,
      });
      await this.#relay.sendNeutralText(result.speech);
    } finally {
      this.#clearOwnerAccessState();
    }
  }

  #ownsLiveTurn(lifecycleGeneration: number, controller: AbortController): boolean {
    return lifecycleGeneration === this.#lifecycleGeneration
      && !this.#socketClosed
      && this.#session.phase === "active"
      && this.#activeTurnAbort === controller;
  }

  #isActiveTurn(lifecycleGeneration: number, controller: AbortController): boolean {
    return this.#ownsLiveTurn(lifecycleGeneration, controller) && !controller.signal.aborted;
  }

  #requireActiveTurn(lifecycleGeneration: number, controller: AbortController): void {
    if (!this.#isActiveTurn(lifecycleGeneration, controller)) throw new Error("call_session_terminal");
  }

  async #awaitAdmission(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => { interrupt = resolve; });
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      if (signal.aborted) interrupt();
      // Source/auth ports need not support cancellation. Retire this admission
      // promptly so a replacement prompt can proceed; race still observes a
      // late rejection, and no continuation may allocate a turn after interruption.
      await Promise.race([work, interrupted]);
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
  }

  #clearOwnerStepUpFragments(): void {
    this.#ownerStepUpFragments = [];
    this.#ownerStepUpFragmentStartedAt = null;
  }

  #clearOwnerRepeatFragments(): void {
    this.#ownerRepeatFragments = [];
    this.#ownerRepeatFragmentStartedAt = null;
  }

  async #guardOwnerRepeat(text: string, observedAt: Date): Promise<string | null> {
    if (this.#ownerStepUp === null) return text;
    const status = await this.#ownerStepUp.repeatStatus(this.#session.sessionId, observedAt);
    if (status === "guard") {
      this.#clearOwnerRepeatFragments();
      return ownerPassphraseFragmentWordCount(text) === null ? text : null;
    }
    // `spent` means this call's step-up text was already repeated once and the
    // repeat-check row exists. Returning `text` here handed the repeated
    // passphrase to the conversation service, which stores it as a turn and
    // sends it to the model -- the one thing this filter exists to prevent.
    // `spent` therefore continues into verifyRepeat rather than leaving here.
    if (status !== "fragment" && status !== "available" && status !== "spent") {
      this.#clearOwnerRepeatFragments();
      return text;
    }
    if (
      this.#ownerRepeatFragmentStartedAt !== null
      && observedAt.valueOf() - this.#ownerRepeatFragmentStartedAt > OWNER_STEP_UP_ASSEMBLY_MS
    ) this.#clearOwnerRepeatFragments();

    const wordCount = ownerPassphraseFragmentWordCount(text);
    if (wordCount === null) {
      this.#clearOwnerRepeatFragments();
      return text;
    }
    if (status === "available" && wordCount < 3) {
      this.#clearOwnerRepeatFragments();
      return text;
    }
    if (this.#ownerRepeatFragmentStartedAt === null) {
      if (wordCount === 3) {
        return await this.#ownerStepUp.verifyRepeat(this.#session.sessionId, text, observedAt) === "suppress"
          ? null : text;
      }
      this.#ownerRepeatFragmentStartedAt = observedAt.valueOf();
      this.#ownerRepeatFragments = [text];
      return null;
    }

    const candidate = [...this.#ownerRepeatFragments, text].join(" ");
    const combinedWords = ownerPassphraseFragmentWordCount(candidate);
    if (combinedWords === null) {
      this.#clearOwnerRepeatFragments();
      if (wordCount === 3) {
        return await this.#ownerStepUp.verifyRepeat(this.#session.sessionId, text, observedAt) === "suppress"
          ? null : text;
      }
      this.#ownerRepeatFragmentStartedAt = observedAt.valueOf();
      this.#ownerRepeatFragments = [text];
      return null;
    }
    if (combinedWords < 3) {
      this.#ownerRepeatFragments.push(text);
      return null;
    }
    this.#clearOwnerRepeatFragments();
    return await this.#ownerStepUp.verifyRepeat(this.#session.sessionId, candidate, observedAt) === "suppress"
      ? null : candidate;
  }

  #isFixedStepUpEcho(text: string): boolean {
    return text === OWNER_STEP_UP_PROMPT || text === OWNER_STEP_UP_RETRY_PROMPT
      || text === OWNER_STEP_UP_FORMAT_PROMPT || text === OWNER_STEP_UP_VERIFIED
      || text === OWNER_STEP_UP_REJECTED;
  }

  async #rejectOwnerStepUp(observedAt: Date, alreadyDurable = false): Promise<void> {
    let delivery = this.#ownerStepUpRejection;
    if (delivery === null) {
      delivery = this.#deliverOwnerStepUpRejection(observedAt, alreadyDurable);
      this.#ownerStepUpRejection = delivery;
      try {
        await delivery;
      } catch (error) {
        if (this.#ownerStepUpRejection === delivery) this.#ownerStepUpRejection = null;
        throw error;
      }
    } else {
      await delivery;
    }
    // Delivery and alarm acknowledgement are separate. A failed final clear
    // may be retried without speaking, ending, or alerting a second time.
    await this.#ownerStepUpAlarm?.clear();
  }

  async #deliverOwnerStepUpRejection(observedAt: Date, alreadyDurable: boolean): Promise<void> {
    if (this.#ownerStepUp === null) throw new Error("owner_step_up_unavailable");
    if (!alreadyDurable) await this.#ownerStepUp.expire(this.#session.sessionId, observedAt);
    const rejected = await this.#repository.getCallSession(this.#session.sessionId);
    if (rejected === null || rejected.phase !== "rejected") throw new Error("owner_step_up_rejection_failed");
    // Read everything required for the alert before completing the in-memory
    // rejection. A failed read must leave the durable alarm available to retry.
    const binding = await this.#ownerStepUp.binding(this.#session.sessionId);
    this.#session = rejected;
    this.#clearOwnerStepUpFragments();
    if (await this.#ownerStepUp.rejectionDelivered(this.#session.sessionId)) {
      try { this.#relay.close(1008); }
      catch { /* The provider may already have closed after the prior end frame. */ }
      return;
    }
    try { await this.#relay.sendNeutralText(OWNER_STEP_UP_REJECTED); }
    catch { /* A disconnected caller must not prevent the owner's alert. */ }
    try {
      if (this.#relay.end === undefined) throw new Error("relay_end_unavailable");
      await this.#relay.end(OWNER_STEP_UP_HANDOFF_DATA);
    }
    catch {
      try { this.#relay.close(1008); }
      catch { /* The relay may already have closed during verification. */ }
    }
    if (binding !== null && this.#ownerStepUpAlerts !== null) {
      await this.#ownerStepUpAlerts.alert({
        ownerPrincipalId: binding.ownerPrincipalId,
        alertClass: "rejected",
        direction: binding.direction,
        attestationClass: binding.attestationClass,
        now: observedAt,
      });
    }
    await this.#ownerStepUp.recordRejectionDelivered(this.#session.sessionId, observedAt);
  }

  async #completeOwnerStepUp(candidate: string, observedAt: Date): Promise<void> {
    if (this.#ownerStepUp === null || this.#authorityService === null || this.#ownerStepUpVerificationInFlight) return;
    this.#ownerStepUpVerificationInFlight = true;
    try {
      const outcome = await this.#ownerStepUp.verifyCandidate(this.#session.sessionId, candidate, observedAt);
      candidate = "";
      if (outcome === "not_candidate") {
        const reprompt = await this.#ownerStepUp.recordReprompt(this.#session.sessionId, observedAt);
        if (reprompt === "rejected") await this.#rejectOwnerStepUp(observedAt, true);
        else if (reprompt === "expired") await this.#rejectOwnerStepUp(observedAt);
        else await this.#relay.sendNeutralText(OWNER_STEP_UP_FORMAT_PROMPT);
        return;
      }
      if (outcome === "expired") {
        await this.#rejectOwnerStepUp(observedAt);
        return;
      }
      if (outcome === "rejected") {
        await this.#rejectOwnerStepUp(observedAt, true);
        return;
      }
      if (outcome === "mismatched") {
        await this.#relay.sendNeutralText(OWNER_STEP_UP_RETRY_PROMPT);
        return;
      }

      // The match trigger has already committed the receipt, authority and authenticated phase.
      const authenticated = await this.#repository.getCallSession(this.#session.sessionId);
      if (authenticated === null || authenticated.phase !== "authenticated") throw new Error("owner_step_up_commit_missing");
      this.#session = authenticated;
      this.#authority = await this.#authorityService.rehydrate({
        sessionId: this.#session.sessionId, binding: this.#session.binding, now: observedAt,
      });
      await this.#transition("active", observedAt);
      this.#interaction = Object.freeze({ kind: "conversation" });
      await this.#ownerStepUpAlarm?.clear();
      await this.#relay.sendNeutralText(OWNER_STEP_UP_VERIFIED);
    } finally {
      candidate = "";
      this.#ownerStepUpVerificationInFlight = false;
    }
  }

  async #handleOwnerStepUpPrompt(event: Extract<RelayEvent, { type: "prompt" }>): Promise<void> {
    if (!event.final || this.#isFixedStepUpEcho(event.text) || this.#ownerStepUpVerificationInFlight) return;
    const observedAt = this.#now();
    const state = await this.#ownerStepUp!.reconcileState(this.#session.sessionId, observedAt);
    if (state.rejectionReason !== null) {
      await this.#rejectOwnerStepUp(observedAt, true);
      return;
    }
    this.#ownerStepUpDeadlineAt = state.deadlineAt;
    if (this.#ownerStepUpDeadlineAt !== null && observedAt.toISOString() >= this.#ownerStepUpDeadlineAt) {
      await this.#rejectOwnerStepUp(observedAt);
      return;
    }
    if (this.#ownerStepUpFragmentStartedAt === null) this.#ownerStepUpFragmentStartedAt = observedAt.valueOf();
    if (observedAt.valueOf() - this.#ownerStepUpFragmentStartedAt > OWNER_STEP_UP_ASSEMBLY_MS) {
      this.#clearOwnerStepUpFragments();
      if (this.#ownerStepUpRepromptInFlight) return;
      this.#ownerStepUpRepromptInFlight = true;
      try {
        // Replace the stale assembly alarm before the durable reprompt write.
        // A late alarm delivered during that write therefore observes only
        // the window deadline and cannot consume a second reprompt.
        if (this.#ownerStepUpDeadlineAt !== null) await this.#ownerStepUpAlarm?.arm({
          sessionId: this.#session.sessionId, lifecycleGeneration: 1, kind: "window", deadlineAt: this.#ownerStepUpDeadlineAt,
        });
        const reprompt = await this.#ownerStepUp!.recordReprompt(this.#session.sessionId, observedAt);
        if (reprompt !== "reprompt") await this.#rejectOwnerStepUp(observedAt, reprompt === "rejected");
        else {
          await this.#relay.sendNeutralText(OWNER_STEP_UP_FORMAT_PROMPT);
        }
      } finally {
        this.#ownerStepUpRepromptInFlight = false;
      }
      return;
    }
    this.#ownerStepUpFragments.push(event.text);
    const candidate = this.#ownerStepUpFragments.join(" ");
    const tokenCount = candidate.split(" ").filter(Boolean).length;
    if (tokenCount < 3) {
      await this.#ownerStepUpAlarm?.arm({
        sessionId: this.#session.sessionId, lifecycleGeneration: 1, kind: "assembly",
        deadlineAt: new Date(this.#ownerStepUpFragmentStartedAt + OWNER_STEP_UP_ASSEMBLY_MS).toISOString(),
      });
      return;
    }
    this.#clearOwnerStepUpFragments();
    if (this.#ownerStepUpDeadlineAt !== null) {
      await this.#ownerStepUpAlarm?.arm({
        sessionId: this.#session.sessionId, lifecycleGeneration: 1, kind: "window",
        deadlineAt: this.#ownerStepUpDeadlineAt,
      });
    }
    await this.#completeOwnerStepUp(candidate, observedAt);
  }

  async handleOwnerStepUpAlarm(kind: "window" | "assembly", lifecycleGeneration: 1): Promise<void> {
    if (lifecycleGeneration !== 1 || this.#session.phase !== "pre_auth" && this.#session.phase !== "rejected"
      || this.#interaction.kind !== "owner_step_up") {
      await this.#ownerStepUpAlarm?.clear();
      return;
    }
    const observedAt = this.#now();
    const state = await this.#ownerStepUp!.reconcileState(this.#session.sessionId, observedAt);
    if (state.rejectionReason !== null) {
      // expire() may have committed immediately before the previous invocation
      // failed. The durable verdict does not prove that refusal/end/alert ran.
      await this.#rejectOwnerStepUp(observedAt, true);
      return;
    }
    if (state.deadlineAt === null) {
      await this.#ownerStepUpAlarm?.clear();
      return;
    }
    this.#ownerStepUpDeadlineAt = state.deadlineAt;
    if (observedAt.toISOString() >= state.deadlineAt) {
      await this.#rejectOwnerStepUp(observedAt);
      return;
    }
    if (kind === "window") {
      await this.#ownerStepUpAlarm?.arm({
        sessionId: this.#session.sessionId, lifecycleGeneration: 1,
        kind: "window", deadlineAt: state.deadlineAt,
      });
      return;
    }
    if (this.#ownerStepUpRepromptInFlight) {
      if (this.#ownerStepUpDeadlineAt !== null) await this.#ownerStepUpAlarm?.arm({
        sessionId: this.#session.sessionId, lifecycleGeneration: 1,
        kind: "window", deadlineAt: this.#ownerStepUpDeadlineAt,
      });
      return;
    }
    this.#clearOwnerStepUpFragments();
    this.#ownerStepUpRepromptInFlight = true;
    try {
      const outcome = await this.#ownerStepUp!.recordReprompt(this.#session.sessionId, observedAt);
      if (outcome !== "reprompt") {
        await this.#rejectOwnerStepUp(observedAt, outcome === "rejected");
        return;
      }
      await this.#relay.sendNeutralText(OWNER_STEP_UP_FORMAT_PROMPT);
      if (this.#ownerStepUpDeadlineAt !== null) await this.#ownerStepUpAlarm?.arm({
        sessionId: this.#session.sessionId, lifecycleGeneration: 1, kind: "window", deadlineAt: this.#ownerStepUpDeadlineAt,
      });
    } finally {
      this.#ownerStepUpRepromptInFlight = false;
    }
  }

  async #handlePrompt(event: Extract<RelayEvent, { type: "prompt" }>): Promise<void> {
    if (this.#interaction.kind === "owner_step_up" && this.#session.phase === "pre_auth") {
      await this.#handleOwnerStepUpPrompt(event);
      return;
    }
    if (
      this.#authorityService !== null
      && this.#interaction.kind === "guest_pin"
      && this.#session.phase === "pre_auth"
    ) {
      if (!event.final) return;
      const candidate = normalizeSpokenPin(event.text);
      if (candidate === null) {
        await this.#relay.sendNeutralText("Use the keypad to enter four digits.");
        return;
      }
      await this.#authenticateGuest(candidate);
      return;
    }
    if (!event.final || this.#session.phase !== "active" || event.text.length === 0) return;
    if (this.#isFixedStepUpEcho(event.text)) return;
    const promptText = this.#authority?.kind === "owner"
      ? await this.#guardOwnerRepeat(event.text, this.#now())
      : event.text;
    if (promptText === null) {
      await this.#relay.sendNeutralText("I'm ready for your request.");
      return;
    }
    if (event.language !== "en-US") throw new Error("turn_language_unsupported");
    if (Array.from(promptText).length > 8_000 || encoder.encode(promptText).byteLength > 65_536) {
      throw new Error("turn_too_large");
    }
    if (this.#activeTurnAbort !== null) throw new TurnInProgressError();
    if (this.#authority?.kind === "owner" && this.#ownerAccess !== null) {
      const draft = parseOwnerAccessIntent(promptText);
      if (draft !== null) {
        await this.#beginOwnerAccess(draft, this.#now());
        return;
      }
      if (this.#interaction.kind === "owner_access_pin") {
        await this.#captureOwnerAccessPin({ ...event, text: promptText });
        return;
      }
      if (this.#interaction.kind === "owner_access_confirmation") {
        await this.#confirmOwnerAccess(promptText, this.#now());
        return;
      }
    }

    if (this.#conversation === null) throw new Error("conversation_unavailable");
    const lifecycleGeneration = this.#lifecycleGeneration;
    const controller = new AbortController();
    // Collection can await network I/O. Reserve ownership first so interruption
    // and a competing prompt cannot slip past a turn that has not reached the model.
    this.#activeTurnAbort = controller;
    try {
      await this.#awaitAdmission(this.#assertCapacity(), controller.signal);
      if (!this.#ownsLiveTurn(lifecycleGeneration, controller)) throw new Error("call_session_terminal");
      if (controller.signal.aborted) return;
      // A grant may have been revoked while telemetry was being collected.
      if (this.#authorityService !== null) {
        await this.#awaitAdmission(this.#authorityService.authorize(this.#authority, "conversation.basic", this.#now()), controller.signal);
      }
      if (!this.#ownsLiveTurn(lifecycleGeneration, controller)) throw new Error("call_session_terminal");
      if (controller.signal.aborted) return;
      const turnId = this.#newTurnId();
      const delivery = createVoiceStreamDelivery({
        sessionId: this.#session.sessionId,
        turnId,
        sendToken: async (token) => {
          this.#requireActiveTurn(lifecycleGeneration, controller);
          await this.#relay.sendToken(token);
        },
        finish: async (finalText) => {
          this.#requireActiveTurn(lifecycleGeneration, controller);
          await this.#relay.finish(finalText);
        },
      });
      const result = await this.#conversation.handleTurn({
        sessionId: this.#session.sessionId,
        principalId: this.#session.binding.principalId,
        turnId,
        text: promptText,
        signal: controller.signal,
        ...delivery,
      });
      // Output callbacks enforce the abort fence. A response already finished
      // before interruption may still be awaiting its durable receipt here.
      if (!this.#ownsLiveTurn(lifecycleGeneration, controller)) {
        if (
          result.outcome === "voice_sent"
          || result.sentAssistantEventId !== null
          || result.deliveredAssistantEventId !== null
          || result.deliveryId !== null
        ) {
          throw new Error("call_session_terminal");
        }
        return;
      }
      if (result.deliveredAssistantEventId !== null || result.deliveryId !== null) {
        throw new Error("conversation_voice_result_invalid");
      }
      if (result.outcome === "voice_sent") {
        if (result.sentAssistantEventId === null) throw new Error("conversation_voice_result_invalid");
        if (!controller.signal.aborted) this.#lastSentAssistantEventId = result.sentAssistantEventId;
      } else if (result.sentAssistantEventId !== null) {
        throw new Error("conversation_voice_result_invalid");
      }
    } finally {
      if (this.#activeTurnAbort === controller) this.#activeTurnAbort = null;
    }
  }

  async #handleDtmf(event: RelayDtmfEvent): Promise<void> {
    if (
      this.#authorityService !== null
      && this.#interaction.kind === "guest_pin"
      && this.#session.phase === "pre_auth"
    ) {
      const status = this.#guestPin.pushDtmf(event.digit);
      if (status !== "complete") return;
      const candidate = this.#guestPin.take();
      if (candidate === null) throw new Error("guest_pin_capture_failed");
      await this.#authenticateGuest(candidate);
      return;
    }
    if (this.#session.phase === "active" && this.#interaction.kind === "owner_access_pin") {
      const status = this.#ownerAccessPin.pushDtmf(event.digit);
      if (status !== "complete") return;
      const digits = this.#ownerAccessPin.take();
      if (digits === null) throw new Error("owner_access_pin_capture_failed");
      this.#interaction = Object.freeze({
        kind: "owner_access_confirmation",
        proposal: this.#interaction.proposal,
        pinSelection: Object.freeze({ kind: "explicit", digits }),
      });
      await this.#relay.sendNeutralText("Say confirm to apply this access change, or cancel.");
      return;
    }
    if (
      this.#session.phase === "pre_auth"
      && this.#interaction.kind === "owner_enrollment"
      && this.#session.binding.activationOnly
    ) {
      await this.#handleActivationDtmf(event);
      return;
    }
  }

  async #authenticateGuest(candidate: Uint8Array): Promise<void> {
    const observedAt = this.#now();
    try {
      if (this.#guestAuthentication === null || this.#authorityService === null) {
        throw new Error("guest_authentication_unavailable");
      }
      let result: Readonly<{ proof: GuestPinAuthenticationProof | null; attemptOrdinal: number }>;
      try {
        result = await this.#guestAuthentication.authenticate({
          pinDigits: candidate,
          sessionId: this.#session.sessionId,
          binding: this.#session.binding,
          now: observedAt,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "authentication_budget_exhausted") throw error;
        await this.#rejectGuest(observedAt);
        return;
      }
      if (result.proof === null) {
        const decision = evaluatePinAttempt({ failedAttempts: result.attemptOrdinal - 1, pinMatches: false });
        if (decision.terminateCall) await this.#rejectGuest(observedAt);
        return;
      }
      this.#authority = await this.#authorityService.mintGuest({
        sessionId: this.#session.sessionId,
        binding: this.#session.binding,
        pinProof: result.proof,
        now: observedAt,
      });
      const authenticated = await this.#repository.getCallSession(this.#session.sessionId);
      if (authenticated === null || authenticated.phase !== "authenticated") {
        throw new Error("call_authority_write_failed");
      }
      this.#session = authenticated;
      await this.#transition("active", observedAt);
      this.#interaction = Object.freeze({ kind: "conversation" });
    } finally {
      candidate.fill(0);
      this.#guestPin.clear();
    }
  }

  async #rejectGuest(observedAt: Date): Promise<void> {
    await this.#transition("rejected", observedAt);
    try {
      await this.#relay.sendNeutralText("I couldn't verify access. Goodbye.");
    } finally {
      // A failed final send must still release the rejected caller's relay.
      this.#relay.close(1008);
    }
  }

  async #handleActivationDtmf(event: RelayDtmfEvent): Promise<void> {
    if (this.#activationAttempted) return;
    if (event.digit === "*" || event.digit === "#") {
      this.#activationDigits = "";
      return;
    }
    if (!/^\d$/u.test(event.digit)) {
      this.#activationDigits = "";
      return;
    }
    this.#activationDigits += event.digit;
    if (this.#activationDigits.length < 6) return;

    const response = this.#activationDigits;
    this.#activationDigits = "";
    this.#activationAttempted = true;
    const observedAt = this.#now();
    if (this.#activation === null) {
      await this.#transition("failed", observedAt);
      await this.#relay.sendNeutralText("Phone verification could not be completed.");
      return;
    }
    try {
      await this.#activation.confirm({
        sessionId: this.#session.sessionId,
        binding: this.#session.binding,
        response,
        now: observedAt,
      });
    } catch {
      await this.#transition("failed", observedAt);
      await this.#relay.sendNeutralText("Phone verification could not be completed.");
      return;
    }
    await this.#transition("authenticated", observedAt);
    await this.#transition("ending", observedAt);
    await this.#transition("completed", observedAt);
    await this.#relay.sendNeutralText("Phone verification complete. Please call again to use Jarvis.");
  }

  async #cancelCurrentOutput(): Promise<void> {
    this.#activeTurnAbort?.abort();
    await this.#relay.cancelOutput();
    this.#lastSentAssistantEventId = null;
    this.#clearOwnerAccessState();
  }

  async handleSocketClose(reason: "socket_closed" | "provider_error" = "socket_closed"): Promise<void> {
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    let terminalized = false;
    try {
      await this.#cancelCurrentOutput();
      this.#activationDigits = "";
      const observedAt = this.#now();
      if (this.#session.phase === "completed" || this.#session.phase === "rejected"
        || this.#session.phase === "failed" || this.#session.phase === "expired") {
        terminalized = true;
        return;
      }
      if (reason === "provider_error") {
        await this.#transition("failed", observedAt);
        terminalized = true;
        return;
      }
      if (this.#session.phase === "active"
        || this.#session.phase === "authenticated" && !this.#session.binding.activationOnly) {
        await this.#transition("ending", observedAt);
        await this.#transition("completed", observedAt);
        terminalized = true;
        return;
      }
      if (this.#session.phase === "ending") {
        await this.#transition("completed", observedAt);
        terminalized = true;
        return;
      }
      await this.#transition("failed", observedAt);
      terminalized = true;
    } finally {
      if (terminalized) {
        try { await this.#ownerStepUpAlarm?.clear(); }
        catch { /* The durable terminal phase is authoritative; a stale alarm may retry its own clear. */ }
      }
    }
  }

  async terminate(phase: DurableCallSessionTerminalPhase): Promise<void> {
    if (!TERMINAL_PHASES.has(phase)) throw new TypeError("call_session_termination_invalid");
    if (this.#terminationCleanupComplete) return;
    if (this.#terminationCleanupInFlight !== null) return this.#terminationCleanupInFlight;
    const cleanup = this.#terminateOnce(phase);
    this.#terminationCleanupInFlight = cleanup;
    try { await cleanup; }
    finally {
      if (this.#terminationCleanupInFlight === cleanup) this.#terminationCleanupInFlight = null;
    }
  }

  async #terminateOnce(phase: DurableCallSessionTerminalPhase): Promise<void> {
    this.#lifecycleGeneration += 1;
    this.#socketClosed = true;
    this.#activeTurnAbort?.abort();
    this.#activeTurnAbort = null;
    this.#lastSentAssistantEventId = null;
    this.#clearOwnerStepUpFragments();
    this.#clearOwnerRepeatFragments();
    this.#activationDigits = "";
    this.#activationAttempted = false;
    this.#clearOwnerAccessState();
    this.#clearAuthenticationState();
    this.#authorityService?.invalidate(this.#authority);
    this.#authority = null;
    this.#session = Object.freeze({ ...this.#session, phase });
    await this.#relay.cancelOutput();
    this.#terminationCleanupComplete = true;
  }

  async #transition(nextPhase: StoredCallSession["phase"], now: Date): Promise<void> {
    this.#session = await this.#repository.transitionCallSession({
      sessionId: this.#session.sessionId,
      expectedPhase: this.#session.phase,
      nextPhase,
      now,
    });
    if (TERMINAL_PHASES.has(nextPhase)) {
      this.#lifecycleGeneration += 1;
      this.#clearOwnerStepUpFragments();
      this.#clearOwnerRepeatFragments();
      this.#authorityService?.invalidate(this.#authority);
      this.#authority = null;
      this.#clearOwnerAccessState();
      this.#clearAuthenticationState();
    }
  }
}

export interface CallSessionRuntimeInput {
  readonly initialization: Readonly<CallSessionInitialization>;
  readonly session: Readonly<StoredCallSession>;
  readonly relay: CallSessionRelay;
  readonly ownerStepUpAlarm: OwnerStepUpAlarmPort;
}

/** Tests may replace the production graph through this trusted in-process adapter. */
export type CallSessionRuntimeFactory = (input: CallSessionRuntimeInput) => CallSessionCore;

function socketRelay(socket: WebSocket, markPolicyClosed: () => void): CallSessionRelay {
  const send = (value: unknown): Promise<void> => {
    socket.send(JSON.stringify(value));
    return Promise.resolve();
  };
  return Object.freeze({
    close(code: number): void {
      markPolicyClosed();
      closeSocket(socket, code, "relay policy violation");
    },
    sendNeutralText(text: string): Promise<void> {
      return send(Object.freeze({ type: "text", token: text, last: true }));
    },
    sendToken(token: ModelToken): Promise<void> {
      return send(Object.freeze({ type: "text", token: token.text, last: false }));
    },
    finish(_finalText: string): Promise<void> {
      return send(Object.freeze({ type: "text", token: "", last: true }));
    },
    cancelOutput(): Promise<void> {
      return Promise.resolve();
    },
    end(handoffData: string): Promise<void> {
      return send(Object.freeze({ type: "end", handoffData }));
    },
  });
}

const TERMINAL_PHASES = new Set(["completed", "rejected", "failed", "expired"]);

/** Hibernation-safe per-session storage and WebSocket boundary. */
export class CallSession extends DurableObject<Env> {
  readonly #runtimeFactory: CallSessionRuntimeFactory | null;
  readonly #cores = new Map<WebSocket, CallSessionCore>();
  readonly #policyClosedSockets = new WeakSet<WebSocket>();
  #terminationInFlight: Readonly<{
    termination: Readonly<CallSessionTermination>;
    promise: Promise<CallSessionTerminationResult>;
  }> | null = null;

  constructor(
    state: DurableObjectState,
    env: Env,
    runtimeFactory: CallSessionRuntimeFactory | null = (input) => createProductionCallSessionCore(env, input),
  ) {
    super(state, env);
    this.#runtimeFactory = runtimeFactory;
  }

  async initialize(value: CallSessionInitialization): Promise<void> {
    const initialization = snapshotInitialization(value);
    if (this.ctx.id.name !== initialization.sessionId) {
      throw new Error("call_session_object_mismatch");
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<unknown>(INITIALIZATION_KEY);
      if (existing === undefined) {
        await transaction.put(INITIALIZATION_KEY, initialization);
        return;
      }
      let stored: Readonly<CallSessionInitialization>;
      try { stored = snapshotInitialization(existing); }
      catch { throw new Error("call_session_initialization_corrupt"); }
      if (!sameInitialization(stored, initialization)) {
        throw new Error("call_session_initialization_conflict");
      }
    });
  }

  async #armOwnerStepUpAlarm(input: StoredOwnerStepUpAlarm): Promise<void> {
    if (input.sessionId !== this.ctx.id.name || !canonicalTimestamp(input.deadlineAt)) {
      throw new Error("owner_step_up_alarm_invalid");
    }
    await this.ctx.storage.put(OWNER_STEP_UP_ALARM_KEY, input);
    await this.ctx.storage.setAlarm(new Date(input.deadlineAt));
  }

  async #clearOwnerStepUpAlarm(): Promise<void> {
    await this.ctx.storage.delete(OWNER_STEP_UP_ALARM_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    try { await this.#handleOwnerStepUpAlarm(); }
    catch (error) {
      // Cloudflare retries an alarm at most six times. Close before the final
      // retry rather than leaving a silent call open through a long D1 outage.
      if ((alarmInfo?.retryCount ?? 0) < 5) throw error;
      for (const socket of this.ctx.getWebSockets()) closeSocket(socket, 1011, "relay runtime unavailable");
      await this.#clearOwnerStepUpAlarm();
    }
  }

  async #handleOwnerStepUpAlarm(): Promise<void> {
    const stored = await this.ctx.storage.get<StoredOwnerStepUpAlarm>(OWNER_STEP_UP_ALARM_KEY);
    if (stored === undefined || stored.sessionId !== this.ctx.id.name || stored.lifecycleGeneration !== 1
      || stored.kind !== "window" && stored.kind !== "assembly" || !canonicalTimestamp(stored.deadlineAt)) {
      await this.#clearOwnerStepUpAlarm();
      return;
    }
    const sockets = this.ctx.getWebSockets();
    let handled = false;
    for (const socket of sockets) {
      const resolved = await this.#resolveCore(socket, true);
      if (resolved.kind === "unavailable") throw new Error("owner_step_up_alarm_runtime_unavailable");
      if (resolved.kind === "mismatch") {
        closeSocket(socket, 1008, "relay session mismatch");
        await this.#clearOwnerStepUpAlarm();
        handled = true;
        continue;
      }
      if (resolved.kind === "ready") {
        await resolved.core.handleOwnerStepUpAlarm(stored.kind, 1);
        handled = true;
      }
    }
    if (!handled) throw new Error("owner_step_up_alarm_runtime_unavailable");
  }

  async terminate(value: CallSessionTermination): Promise<CallSessionTerminationResult> {
    const termination = snapshotTermination(value);
    if (this.ctx.id.name !== termination.sessionId) {
      throw terminationFailure("call_session_object_mismatch");
    }
    if (this.#terminationInFlight !== null) {
      if (!sameTermination(this.#terminationInFlight.termination, termination)) {
        throw terminationFailure("call_session_termination_conflict");
      }
      return this.#terminationInFlight.promise;
    }
    const promise = this.#terminateOnce(termination);
    this.#terminationInFlight = Object.freeze({ termination, promise });
    try { return await promise; }
    finally {
      if (this.#terminationInFlight?.promise === promise) this.#terminationInFlight = null;
    }
  }

  async #terminateOnce(
    termination: Readonly<CallSessionTermination>,
  ): Promise<CallSessionTerminationResult> {
    const initialization = await this.#readInitialization();
    if (initialization === null) throw terminationFailure("call_session_termination_uninitialized");
    const repository = new CallRepository(this.env.DB, new EventRepository(this.env.DB));
    let session = await repository.getCallSession(termination.sessionId);
    this.#requireExactTerminationSession(initialization, session);

    const storedValue = await this.ctx.storage.get<unknown>(TERMINATION_KEY);
    let record: Readonly<StoredCallSessionTermination>;
    let outcome: CallSessionTerminationResult["outcome"];
    if (storedValue === undefined) {
      const durablePhase = await this.#terminalizeDurableSession(
        repository,
        initialization,
        session as StoredCallSession,
        termination.phase,
      );
      session = await repository.getCallSession(termination.sessionId);
      this.#requireExactTerminationSession(initialization, session);
      if (session?.phase !== durablePhase) throw terminationFailure("call_session_termination_state_conflict");
      record = Object.freeze({
        ...termination,
        callSid: session.callSid,
        providerSessionId: session.providerSessionId,
        durablePhase,
        cleanupState: "pending",
      });
      await this.ctx.storage.transaction(async (transaction) => {
        const existing = await transaction.get<unknown>(TERMINATION_KEY);
        if (existing !== undefined) {
          const concurrent = snapshotTerminationRecord(existing);
          if (!sameTermination(concurrent, termination)) {
            throw terminationFailure("call_session_termination_conflict");
          }
          record = concurrent;
          return;
        }
        await transaction.put(TERMINATION_KEY, record);
      });
      outcome = record.cleanupState === "pending" ? "applied" : "replayed";
    } else {
      record = snapshotTerminationRecord(storedValue);
      if (!sameTermination(record, termination)) {
        throw terminationFailure("call_session_termination_conflict");
      }
      outcome = record.cleanupState === "complete" ? "replayed" : "recovered";
    }

    this.#requireTerminationRecordMatchesSession(record, session as StoredCallSession);
    if (record.cleanupState === "complete") {
      return this.#terminationResult(termination, false, "replayed");
    }

    let cleanupFailed = false;
    for (const core of new Set(this.#cores.values())) {
      try { await core.terminate(record.durablePhase); }
      catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw terminationFailure("call_session_termination_cleanup_failed");

    this.#cores.clear();
    await this.#clearOwnerStepUpAlarm();
    for (const socket of this.ctx.getWebSockets()) closeSocket(socket, 1000, "call ended");
    await this.ctx.storage.transaction(async (transaction) => {
      const currentValue = await transaction.get<unknown>(TERMINATION_KEY);
      if (currentValue === undefined) throw terminationFailure("call_session_termination_corrupt");
      const current = snapshotTerminationRecord(currentValue);
      if (!sameTermination(current, termination)
        || current.callSid !== record.callSid
        || current.providerSessionId !== record.providerSessionId
        || current.durablePhase !== record.durablePhase) {
        throw terminationFailure("call_session_termination_conflict");
      }
      if (current.cleanupState === "pending") {
        await transaction.put(TERMINATION_KEY, Object.freeze({ ...current, cleanupState: "complete" }));
      }
    });
    return this.#terminationResult(termination, outcome === "applied", outcome);
  }

  #terminationResult(
    termination: Readonly<CallSessionTermination>,
    invalidated: boolean,
    outcome: CallSessionTerminationResult["outcome"],
  ): CallSessionTerminationResult {
    return Object.freeze({
      sessionId: termination.sessionId,
      terminalPhase: termination.phase,
      invalidated,
      outcome,
    });
  }

  #requireExactTerminationSession(
    initialization: Readonly<CallSessionInitialization>,
    session: Readonly<StoredCallSession> | null,
  ): asserts session is Readonly<StoredCallSession> {
    if (
      session === null
      || !initializationMatchesSession(initialization, session)
      || (session.providerSessionId === null) !== (session.providerConnectedAt === null)
      // Before setup there is no provider-session binding to invent. Only an
      // already-terminal D1 session may receive cleanup with a null pair.
      || session.providerSessionId === null && !TERMINAL_PHASES.has(session.phase)
    ) {
      throw terminationFailure("call_session_termination_binding_mismatch");
    }
  }

  #requireTerminationRecordMatchesSession(
    record: Readonly<StoredCallSessionTermination>,
    session: Readonly<StoredCallSession>,
  ): void {
    if (
      record.callSid !== session.callSid
      || record.providerSessionId !== session.providerSessionId
      || record.durablePhase !== session.phase
      || !TERMINAL_PHASES.has(session.phase)
    ) {
      throw terminationFailure("call_session_termination_state_conflict");
    }
  }

  async #terminalizeDurableSession(
    repository: CallRepository,
    initialization: Readonly<CallSessionInitialization>,
    initial: StoredCallSession,
    requestedPhase: CallSessionTerminalPhase,
  ): Promise<DurableCallSessionTerminalPhase> {
    let current = initial;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (TERMINAL_PHASES.has(current.phase)) {
        if ((current.phase === "completed" || current.phase === "failed") && current.phase !== requestedPhase) {
          throw terminationFailure("call_session_termination_state_conflict");
        }
        return current.phase as DurableCallSessionTerminalPhase;
      }
      let nextPhase: CallPhase;
      if (requestedPhase === "failed") {
        nextPhase = "failed";
      } else if (current.phase === "active" || current.phase === "authenticated") {
        nextPhase = "ending";
      } else if (current.phase === "ending") {
        nextPhase = "completed";
      } else if (current.phase === "created" || current.phase === "connecting" || current.phase === "pre_auth") {
        nextPhase = "rejected";
      } else {
        throw terminationFailure("call_session_termination_state_conflict");
      }
      const transitionAt = new Date(Math.max(Date.now(), new Date(current.updatedAt).valueOf()));
      try {
        current = await repository.transitionCallSession({
          sessionId: current.sessionId,
          expectedPhase: current.phase,
          nextPhase,
          now: transitionAt,
        });
      } catch {
        const refreshed = await repository.getCallSession(current.sessionId);
        this.#requireExactTerminationSession(initialization, refreshed);
        current = refreshed;
      }
    }
    throw terminationFailure("call_session_termination_state_conflict");
  }

  override async fetch(request: Request): Promise<Response> {
    const initialization = await this.#readInitialization();
    if (initialization === null) return fixedResponse("Not implemented", 501);
    if (await this.ctx.storage.get(TERMINATION_KEY) !== undefined) return fixedResponse("call ended", 410);
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return fixedResponse("upgrade required", 426);
    }
    if (this.ctx.getWebSockets().length !== 0) return fixedResponse("relay conflict", 409);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(Object.freeze({ sessionId: initialization.sessionId }));
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    if (typeof frame !== "string") {
      closeSocket(socket, 1003, "binary frame unsupported");
      return;
    }
    if (encoder.encode(frame).byteLength > MAX_RELAY_FRAME_BYTES) {
      closeSocket(socket, 1009, "relay frame too large");
      return;
    }
    let event: RelayEvent;
    try { event = parseRelayEvent(frame); }
    catch {
      closeSocket(socket, 1007, "invalid relay frame");
      return;
    }

    const resolved = await this.#resolveCore(socket, true);
    if (resolved.kind === "mismatch") {
      closeSocket(socket, 1008, "relay session mismatch");
      return;
    }
    if (resolved.kind === "unavailable") {
      closeSocket(socket, 1011, "relay runtime unavailable");
      return;
    }
    try {
      if (resolved.core.phase === "rejected") {
        await resolved.core.handleOwnerStepUpAlarm("window", 1);
        return;
      }
      await resolved.core.handleRelayEvent(event);
    } catch (error) {
      // There is no prompt queue. Drop overlap without ending the current call.
      if (error instanceof TurnInProgressError) return;
      if (!this.#policyClosedSockets.has(socket)) {
        closeSocket(socket, 1011, "relay processing failed");
      }
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const resolved = await this.#resolveCore(socket, true);
    if (resolved.kind === "ready") {
      if (resolved.core.phase === "rejected") await resolved.core.handleOwnerStepUpAlarm("window", 1);
      else await resolved.core.handleSocketClose("socket_closed");
    }
    this.#cores.delete(socket);
  }

  override async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    const resolved = await this.#resolveCore(socket, true);
    if (resolved.kind === "ready") {
      if (resolved.core.phase === "rejected") await resolved.core.handleOwnerStepUpAlarm("window", 1);
      else await resolved.core.handleSocketClose("provider_error");
    }
    this.#cores.delete(socket);
  }

  async #readInitialization(): Promise<Readonly<CallSessionInitialization> | null> {
    const value = await this.ctx.storage.get<unknown>(INITIALIZATION_KEY);
    if (value === undefined) return null;
    try { return snapshotInitialization(value); }
    catch { throw new Error("call_session_initialization_corrupt"); }
  }

  async #resolveCore(socket: WebSocket, resumeRejected = false): Promise<
    | { readonly kind: "ready"; readonly core: CallSessionCore }
    | { readonly kind: "mismatch" }
    | { readonly kind: "unavailable" }
  > {
    const cached = this.#cores.get(socket);
    if (cached !== undefined) {
      if (cached.phase === "rejected" && (!resumeRejected || !cached.canResumeRejectedOwnerStepUp)) {
        return { kind: "mismatch" };
      }
      return { kind: "ready", core: cached };
    }
    const socketSessionId = snapshotSocketSessionId(socket);
    const initialization = await this.#readInitialization();
    if (await this.ctx.storage.get(TERMINATION_KEY) !== undefined) return { kind: "mismatch" };
    if (socketSessionId === null || initialization === null || socketSessionId !== initialization.sessionId) {
      return { kind: "mismatch" };
    }
    let session: StoredCallSession | null;
    try {
      session = await new CallRepository(this.env.DB, new EventRepository(this.env.DB))
        .getCallSession(initialization.sessionId);
    } catch {
      return { kind: "unavailable" };
    }
    if (session === null || !initializationMatchesSession(initialization, session)
      || TERMINAL_PHASES.has(session.phase) && !(resumeRejected && session.phase === "rejected")) {
      return { kind: "mismatch" };
    }
    if (session.phase === "rejected") {
      let binding: { session_id: string } | null;
      try {
        binding = await this.env.DB.prepare(`SELECT binding.session_id
          FROM owner_call_step_up_bindings binding
          JOIN call_sessions session ON session.session_id = binding.session_id
          WHERE binding.session_id = ? AND (
              binding.requirement = 'required'
              OR binding.requirement = 'waived_passed_a' AND EXISTS (
                SELECT 1 FROM owner_call_step_up_disabled_rejections disabled
                WHERE disabled.session_id = binding.session_id
              )
            )
            AND session.access_kind = 'owner' AND session.activation_only = 0`)
          .bind(session.sessionId).first<{ session_id: string }>();
      } catch {
        return { kind: "unavailable" };
      }
      if (binding === null) return { kind: "mismatch" };
    }
    if (this.#runtimeFactory === null) return { kind: "unavailable" };
    let core: CallSessionCore;
    try {
      core = this.#runtimeFactory(Object.freeze({
        initialization,
        session,
        relay: socketRelay(socket, () => this.#policyClosedSockets.add(socket)),
        ownerStepUpAlarm: Object.freeze({
          arm: (input: StoredOwnerStepUpAlarm) => this.#armOwnerStepUpAlarm(input),
          clear: () => this.#clearOwnerStepUpAlarm(),
        }),
      }));
    } catch {
      return { kind: "unavailable" };
    }
    if (!(core instanceof CallSessionCore)) return { kind: "unavailable" };
    if (session.phase === "rejected" && !core.canResumeRejectedOwnerStepUp) return { kind: "mismatch" };
    this.#cores.set(socket, core);
    return { kind: "ready", core };
  }
}

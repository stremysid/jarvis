import { DurableObject } from "cloudflare:workers";
import { newUlid, type RelayBinding, type Ulid } from "../../../../packages/contracts/src/index.js";
import type { Env } from "../env.js";
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
import {
  IdentityChallengeService,
  VerifiedChannelObservationAuthority,
} from "../sync/identity-challenge.js";
import {
  AuthenticationAttemptBudget,
  PinAuthenticationService,
  evaluatePinAttempt,
  type PinAuthenticationProof,
} from "./inbound-auth.js";
import {
  OUTBOUND_VOICEMAIL_MESSAGE,
  type OutboundPreAuthenticationContract,
  type OutboundSessionInitialization,
} from "./outbound.js";

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
const BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce",
  "direction", "activationOnly", "activationChallengeId",
  "accessKind", "guestGrantId", "guestGrantVersion", "accessDocumentHash",
]);
const ACTIVATION_DEPENDENCY_FIELDS = new Set([
  "database", "authentication", "budgets", "observations", "challenges",
]);
const ACTIVATION_INPUT_FIELDS = new Set(["sessionId", "binding", "pinProof", "response", "now"]);
const PRE_AUTHENTICATION_FIELDS = new Set(["voicemailMessage"]);
const INBOUND_INITIALIZATION_FIELDS = new Set(["sessionId", "binding", "relaySetupExpiresAt"]);
const OUTBOUND_INITIALIZATION_FIELDS = new Set([
  "sessionId", "binding", "relaySetupExpiresAt", "preAuthentication",
]);
const SOCKET_ATTACHMENT_FIELDS = new Set(["sessionId"]);
const encoder = new TextEncoder();

const snapshotPinProof = PinAuthenticationService.prototype.snapshotProof;
const reserveActivationAttempt = AuthenticationAttemptBudget.prototype.reserveActivationAttempt;
const issueObservation = VerifiedChannelObservationAuthority.prototype.issue;
const confirmIdentityChallenge = IdentityChallengeService.prototype.confirm;

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
  readonly authentication: PinAuthenticationService;
  readonly budgets: AuthenticationAttemptBudget;
  readonly observations: VerifiedChannelObservationAuthority;
  readonly challenges: IdentityChallengeService;
}

/** Bridges a nominal PIN proof into the real Task 4 phone-observation authority. */
export class PhoneActivationChallengeConfirmer {
  readonly #repository: DeviceRepository;
  readonly #authentication: PinAuthenticationService;
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
      || !(input.authentication instanceof PinAuthenticationService)
      || !(input.budgets instanceof AuthenticationAttemptBudget)
      || !(input.observations instanceof VerifiedChannelObservationAuthority)
      || !(input.challenges instanceof IdentityChallengeService)
    ) {
      throw new TypeError("phone_activation_configuration_invalid");
    }
    this.#repository = new DeviceRepository(input.database as D1Database);
    this.#authentication = input.authentication;
    this.#budgets = input.budgets;
    this.#observations = input.observations;
    this.#challenges = input.challenges;
  }

  async confirm(rawInput: {
    readonly sessionId: Ulid;
    readonly binding: RelayBinding;
    readonly pinProof: PinAuthenticationProof;
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
    const proof = snapshotPinProof.call(this.#authentication, input.pinProof);
    if (
      proof.sessionId !== sessionId
      || proof.callSid !== binding.callSid
      || proof.principalId !== binding.principalId
      || proof.identityId !== binding.identityId
      || proof.direction !== binding.direction
      || proof.activationChallengeId !== binding.activationChallengeId
      || !binding.activationOnly
      || binding.activationChallengeId === null
    ) {
      throw new TypeError("pin_authentication_proof_invalid");
    }
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
}

export interface CallSessionCoreSetup {
  readonly session: StoredCallSession;
  readonly expectedAccountSid: string;
  readonly repository: CallRepository;
  readonly authentication: PinAuthenticationService;
  readonly activation?: PhoneActivationChallengeConfirmer | null;
  readonly conversation?: ConversationService | null;
  readonly preAuthentication?: OutboundPreAuthenticationContract;
  readonly relay: CallSessionRelay;
  readonly newTurnId?: () => Ulid;
  readonly now: () => Date;
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
  readonly #authentication: PinAuthenticationService;
  readonly #activation: PhoneActivationChallengeConfirmer | null;
  readonly #conversation: ConversationService | null;
  readonly #preAuthentication: OutboundPreAuthenticationContract | null;
  readonly #relay: CallSessionCoreSetup["relay"];
  readonly #newTurnId: () => Ulid;
  readonly #now: () => Date;
  #relaySetupVerified: boolean;
  #setupHandledInThisInstance = false;
  #pinDigits = "";
  #activationDigits = "";
  #pinProof: PinAuthenticationProof | null = null;
  #activationAttempted = false;
  #failedPinAttempts = 0;
  #activeTurnAbort: AbortController | null = null;
  #lastSentAssistantEventId: Ulid | null = null;
  #socketClosed = false;

  constructor(input: CallSessionCoreSetup) {
    if (
      !(input.repository instanceof CallRepository)
      || !(input.authentication instanceof PinAuthenticationService)
      || input.activation !== undefined && input.activation !== null
        && !(input.activation instanceof PhoneActivationChallengeConfirmer)
      || typeof input.expectedAccountSid !== "string"
      || !ACCOUNT_SID.test(input.expectedAccountSid)
    ) {
      throw new TypeError("call_session_configuration_invalid");
    }
    this.#session = input.session;
    this.#expectedAccountSid = input.expectedAccountSid;
    this.#repository = input.repository;
    this.#authentication = input.authentication;
    this.#activation = input.activation ?? null;
    this.#conversation = input.conversation ?? null;
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
  }

  get phase(): StoredCallSession["phase"] {
    return this.#session.phase;
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
    if (event.type === "setup") {
      await this.#handleRelaySetup(event);
      return;
    }
    if (!this.#relaySetupVerified) throw new Error("relay_setup_required");
    if (this.#socketClosed) return;
    if (this.#session.phase === "created" || this.#session.phase === "connecting") {
      await this.#resumeBoundPreAuthentication(this.#now());
    }
    switch (event.type) {
      case "dtmf":
        await this.#handleDtmf(event);
        return;
      case "prompt":
        await this.#handlePrompt(event);
        return;
      case "interrupt":
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
  }

  #clearAuthenticationState(): void {
    this.#pinDigits = "";
    this.#activationDigits = "";
    this.#pinProof = null;
  }

  async #handlePrompt(event: Extract<RelayEvent, { type: "prompt" }>): Promise<void> {
    if (!event.final || this.#session.phase !== "active" || event.text.length === 0) return;
    if (event.language !== "en-US") throw new Error("turn_language_unsupported");
    if (Array.from(event.text).length > 8_000 || encoder.encode(event.text).byteLength > 65_536) {
      throw new Error("turn_too_large");
    }
    if (this.#activeTurnAbort !== null) throw new Error("turn_in_progress");
    if (this.#conversation === null) throw new Error("conversation_unavailable");

    const turnId = this.#newTurnId();
    const controller = new AbortController();
    this.#activeTurnAbort = controller;
    const delivery = createVoiceStreamDelivery({
      sessionId: this.#session.sessionId,
      turnId,
      sendToken: (token) => this.#relay.sendToken(token),
      finish: (finalText) => this.#relay.finish(finalText),
    });
    try {
      const result = await this.#conversation.handleTurn({
        sessionId: this.#session.sessionId,
        principalId: this.#session.binding.principalId,
        turnId,
        text: event.text,
        signal: controller.signal,
        ...delivery,
      });
      if (result.deliveredAssistantEventId !== null || result.deliveryId !== null) {
        throw new Error("conversation_voice_result_invalid");
      }
      if (result.outcome === "voice_sent") {
        if (result.sentAssistantEventId === null) throw new Error("conversation_voice_result_invalid");
        this.#lastSentAssistantEventId = result.sentAssistantEventId;
      } else if (result.sentAssistantEventId !== null) {
        throw new Error("conversation_voice_result_invalid");
      }
    } finally {
      if (this.#activeTurnAbort === controller) this.#activeTurnAbort = null;
    }
  }

  async #handleDtmf(event: RelayDtmfEvent): Promise<void> {
    if (this.#session.phase === "authenticated" && this.#session.binding.activationOnly) {
      await this.#handleActivationDtmf(event);
      return;
    }
    if (this.#session.phase !== "pre_auth") return;
    if (event.digit === "*" || event.digit === "#") {
      this.#pinDigits = "";
      return;
    }
    if (!/^\d$/u.test(event.digit)) {
      this.#pinDigits = "";
      return;
    }
    this.#pinDigits += event.digit;
    if (this.#pinDigits.length < 8) return;

    const candidate = this.#pinDigits;
    this.#pinDigits = "";
    const observedAt = this.#now();
    let proof;
    try {
      proof = await this.#authentication.authenticate({
        pinDigits: candidate,
        sessionId: this.#session.sessionId,
        binding: this.#session.binding,
        now: observedAt,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "authentication_budget_exhausted") throw error;
      await this.#transition("rejected", observedAt);
      return;
    }

    if (proof === null) {
      const result = evaluatePinAttempt({ failedAttempts: this.#failedPinAttempts, pinMatches: false });
      this.#failedPinAttempts = result.nextFailedAttempts;
      if (result.terminateCall) await this.#transition("rejected", observedAt);
      return;
    }

    const authenticated = this.#authentication.snapshotProof(proof);
    if (
      authenticated.sessionId !== this.#session.sessionId
      || authenticated.callSid !== this.#session.callSid
      || authenticated.principalId !== this.#session.binding.principalId
      || authenticated.identityId !== this.#session.binding.identityId
      || authenticated.direction !== this.#session.direction
      || authenticated.activationChallengeId !== this.#session.binding.activationChallengeId
    ) {
      throw new Error("pin_authentication_proof_invalid");
    }
    this.#failedPinAttempts = 0;
    await this.#transition("authenticated", observedAt);
    if (!this.#session.binding.activationOnly) {
      await this.#transition("active", observedAt);
      return;
    }
    if (this.#activation === null) {
      await this.#transition("failed", observedAt);
      return;
    }
    this.#pinProof = proof;
    await this.#relay.sendNeutralText(
      "Enter the one-time phone enrollment challenge shown in your local Jarvis CLI.",
    );
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
    const proof = this.#pinProof;
    this.#activationDigits = "";
    this.#pinProof = null;
    this.#activationAttempted = true;
    const observedAt = this.#now();
    if (this.#activation === null || proof === null) {
      await this.#transition("failed", observedAt);
      await this.#relay.sendNeutralText("Phone verification could not be completed.");
      return;
    }
    try {
      await this.#activation.confirm({
        sessionId: this.#session.sessionId,
        binding: this.#session.binding,
        pinProof: proof,
        response,
        now: observedAt,
      });
    } catch {
      await this.#transition("failed", observedAt);
      await this.#relay.sendNeutralText("Phone verification could not be completed.");
      return;
    }
    await this.#transition("ending", observedAt);
    await this.#transition("completed", observedAt);
    await this.#relay.sendNeutralText("Phone verification complete. Please call again to use Jarvis.");
  }

  async #cancelCurrentOutput(): Promise<void> {
    this.#activeTurnAbort?.abort();
    await this.#relay.cancelOutput();
    this.#lastSentAssistantEventId = null;
  }

  async handleSocketClose(reason: "socket_closed" | "provider_error" = "socket_closed"): Promise<void> {
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    await this.#cancelCurrentOutput();
    this.#pinDigits = "";
    this.#activationDigits = "";
    this.#pinProof = null;
    const observedAt = this.#now();
    if (this.#session.phase === "completed" || this.#session.phase === "rejected"
      || this.#session.phase === "failed" || this.#session.phase === "expired") return;
    if (reason === "provider_error") {
      await this.#transition("failed", observedAt);
      return;
    }
    if (this.#session.phase === "active"
      || this.#session.phase === "authenticated" && !this.#session.binding.activationOnly) {
      await this.#transition("ending", observedAt);
      await this.#transition("completed", observedAt);
      return;
    }
    if (this.#session.phase === "ending") {
      await this.#transition("completed", observedAt);
      return;
    }
    await this.#transition("failed", observedAt);
  }

  async #transition(nextPhase: StoredCallSession["phase"], now: Date): Promise<void> {
    this.#session = await this.#repository.transitionCallSession({
      sessionId: this.#session.sessionId,
      expectedPhase: this.#session.phase,
      nextPhase,
      now,
    });
  }
}

export interface CallSessionRuntimeInput {
  readonly initialization: Readonly<CallSessionInitialization>;
  readonly session: Readonly<StoredCallSession>;
  readonly relay: CallSessionRelay;
}

/** Task 8 supplies trusted provider/account/model construction through this in-process adapter. */
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
  });
}

const TERMINAL_PHASES = new Set(["completed", "rejected", "failed", "expired"]);

/** Hibernation-safe per-session storage and WebSocket boundary. */
export class CallSession extends DurableObject<Env> {
  readonly #runtimeFactory: CallSessionRuntimeFactory | null;
  readonly #cores = new WeakMap<WebSocket, CallSessionCore>();
  readonly #policyClosedSockets = new WeakSet<WebSocket>();

  constructor(
    state: DurableObjectState,
    env: Env,
    runtimeFactory: CallSessionRuntimeFactory | null = null,
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

  override async fetch(request: Request): Promise<Response> {
    const initialization = await this.#readInitialization();
    if (initialization === null) return fixedResponse("Not implemented", 501);
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

    const resolved = await this.#resolveCore(socket);
    if (resolved.kind === "mismatch") {
      closeSocket(socket, 1008, "relay session mismatch");
      return;
    }
    if (resolved.kind === "unavailable") {
      closeSocket(socket, 1011, "relay runtime unavailable");
      return;
    }
    try {
      await resolved.core.handleRelayEvent(event);
    } catch {
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
    const resolved = await this.#resolveCore(socket);
    if (resolved.kind === "ready") await resolved.core.handleSocketClose("socket_closed");
    this.#cores.delete(socket);
  }

  override async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    const resolved = await this.#resolveCore(socket);
    if (resolved.kind === "ready") await resolved.core.handleSocketClose("provider_error");
    this.#cores.delete(socket);
  }

  async #readInitialization(): Promise<Readonly<CallSessionInitialization> | null> {
    const value = await this.ctx.storage.get<unknown>(INITIALIZATION_KEY);
    if (value === undefined) return null;
    try { return snapshotInitialization(value); }
    catch { throw new Error("call_session_initialization_corrupt"); }
  }

  async #resolveCore(socket: WebSocket): Promise<
    | { readonly kind: "ready"; readonly core: CallSessionCore }
    | { readonly kind: "mismatch" }
    | { readonly kind: "unavailable" }
  > {
    const cached = this.#cores.get(socket);
    if (cached !== undefined) return { kind: "ready", core: cached };
    const socketSessionId = snapshotSocketSessionId(socket);
    const initialization = await this.#readInitialization();
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
      || TERMINAL_PHASES.has(session.phase)) {
      return { kind: "mismatch" };
    }
    if (this.#runtimeFactory === null) return { kind: "unavailable" };
    let core: CallSessionCore;
    try {
      core = this.#runtimeFactory(Object.freeze({
        initialization,
        session,
        relay: socketRelay(socket, () => this.#policyClosedSockets.add(socket)),
      }));
    } catch {
      return { kind: "unavailable" };
    }
    if (!(core instanceof CallSessionCore)) return { kind: "unavailable" };
    this.#cores.set(socket, core);
    return { kind: "ready", core };
  }
}

import type { OutboundCallCommand, RelayBinding, Ulid } from "../../../../packages/contracts/src/index.js";
import { twilioCleanupUrl } from "../providers/twilio-cleanup-url.js";
import type {
  OutboundCallDispatcher,
  OutboundCallDispatchResult,
} from "../calls/outbound-call-dispatcher.js";
import {
  isCallSessionAdmissionError,
  type CallRepository,
  type StoredCallSession,
} from "../persistence/call-repository.js";
import type { TwilioRequestVerifier } from "../providers/provider-types.js";
import { snapshotVerifiedTwilioFormPairs } from "../providers/twilio-verifier.js";
import { snapshotOutboundCallRequest } from "../policy/policy-engine.js";
import type { PolicyDecision, PolicyEngineContract, PolicyReason } from "../policy/policy-types.js";
import { snapshotTrustedPublicOrigin } from "../security/trusted-public-origin.js";
import { renderConversationRelayTwiML } from "./twiml.js";
import type { OwnerCallStepUpService } from "./owner-call-step-up.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const PROVIDER_SESSION_ID = /^VX[0-9A-Fa-f]{32}$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NONTERMINAL_PHASES = new Set(["created", "connecting", "pre_auth", "authenticated", "active", "ending"]);
const POLICY_REASONS = new Set<PolicyReason>([
  "allowed",
  "invalid_request",
  "invalid_origin",
  "invalid_purpose",
  "destination_not_verified",
  "authorization_expired",
  "quiet_hours",
  "daily_limit",
  "concurrency_limit",
  "retry_limit",
  "kill_switch_enabled",
  "policy_command_conflict",
  "authorization_missing",
  "authorization_denied",
  "audit_persistence_failed",
  "invalid_dispatch_attempt",
]);
const BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce",
  "direction", "activationOnly", "activationChallengeId",
  "accessKind", "guestGrantId", "guestGrantVersion", "accessDocumentHash",
]);
const SESSION_FIELDS = new Set([
  "sessionId", "callSid", "expectedAttemptId", "direction", "phase", "nonceExpiresAt",
  "relaySetupExpiresAt", "providerSessionId", "providerConnectedAt", "createdAt", "updatedAt", "binding",
]);
const DISPATCH_DEPENDENCY_FIELDS = new Set(["policy", "dispatcher"]);
const TWIML_DEPENDENCY_FIELDS = new Set([
  "twilio", "publicOrigin", "ownerIdentityId", "recipients", "calls", "ownerStepUp", "initializeSession", "now",
]);

export const OUTBOUND_VOICEMAIL_MESSAGE = "Jarvis called for Sid. No private message was left." as const;

export interface OutboundDispatchDependencies {
  policy: Pick<PolicyEngineContract, "evaluateOutboundCall">;
  dispatcher: Pick<OutboundCallDispatcher, "dispatch">;
}

/**
 * Translates the provider-observed destination into an active, verified,
 * canonical voice identity. This lookup does not grant relay or provider-call
 * authority; CallRepository retains the exact durable claim.
 */
export interface OutboundRecipientIdentityLookup {
  resolveActiveVerifiedVoiceIdentityId(providerE164: string): Promise<string | null>;
}

export interface OutboundPreAuthenticationContract {
  readonly voicemailMessage: typeof OUTBOUND_VOICEMAIL_MESSAGE;
}

export interface OutboundSessionInitialization {
  readonly sessionId: Ulid;
  readonly binding: RelayBinding;
  readonly relaySetupExpiresAt: null;
  readonly preAuthentication: OutboundPreAuthenticationContract;
}

/**
 * Task 6 integration prerequisite: its CallSession initializer adapter must
 * persist/consume this immutable neutral initial-utterance contract. A bound
 * owner relay moves active after setup; this contract does not identify
 * voicemail. Task 7 deliberately does not emulate the DO.
 */
export interface OutboundSessionInitializer {
  initialize(input: OutboundSessionInitialization): Promise<void>;
}

export interface OutboundTwiMLDependencies {
  twilio: TwilioRequestVerifier;
  publicOrigin: URL;
  ownerIdentityId: string;
  recipients: OutboundRecipientIdentityLookup;
  calls: Pick<CallRepository, "claimExpectedCall" | "getOrCreateOutboundSession">;
  ownerStepUp: Pick<OwnerCallStepUpService, "bind">;
  initializeSession: OutboundSessionInitializer["initialize"];
  now?: () => Date;
}

interface CapturedMethod {
  readonly receiver: object;
  readonly method: (...args: unknown[]) => unknown;
}

function exactDataRecord(value: unknown, fields: ReadonlySet<string>, optional?: string): Record<string, unknown> | null {
  let prototype: object | null;
  try { prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null; }
  catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) return null;
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch { return null; }
  const minimum = optional === undefined ? fields.size : fields.size - 1;
  if (
    keys.length < minimum
    || keys.length > fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))
    || keys.length === minimum && optional !== undefined && keys.includes(optional)
  ) {
    return null;
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { return null; }
    if (descriptor === undefined) {
      if (field === optional) continue;
      return null;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }
  return captured;
}

function snapshotMethod(value: unknown, name: string): CapturedMethod | null {
  if (value === null || typeof value !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) {
      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== null) descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    }
  } catch {
    return null;
  }
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
  return Object.freeze({ receiver: value, method: descriptor.value as (...args: unknown[]) => unknown });
}

function safeAtom(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.isWellFormed()
    && value === value.normalize("NFC")
    && !value.includes("\r")
    && !value.includes("\n");
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function capturedDate(now: () => Date): Date | null {
  let value: Date;
  try { value = now(); }
  catch { return null; }
  let epochMs: number;
  try { epochMs = Date.prototype.getTime.call(value); }
  catch { return null; }
  return Number.isFinite(epochMs) ? new Date(epochMs) : null;
}

function snapshotPolicyDecision(value: unknown): PolicyDecision | null {
  const decision = exactDataRecord(value, new Set(["decision", "reason"]));
  if (
    decision === null
    || decision.decision !== "allow" && decision.decision !== "deny"
    || typeof decision.reason !== "string"
    || !POLICY_REASONS.has(decision.reason as PolicyReason)
    || (decision.decision === "allow") !== (decision.reason === "allowed")
  ) {
    return null;
  }
  return Object.freeze({ decision: decision.decision, reason: decision.reason as PolicyReason });
}

function snapshotBinding(value: unknown, callSid: string, identityId: string): Readonly<RelayBinding> | null {
  const binding = exactDataRecord(value, BINDING_FIELDS);
  if (
    binding === null
    || binding.callSid !== callSid
    || !safeAtom(binding.principalId)
    || binding.identityId !== identityId
    || binding.destinationIdentityId !== identityId
    || typeof binding.relayNonce !== "string"
    || !RELAY_NONCE.test(binding.relayNonce)
    || binding.direction !== "outbound"
    || binding.activationOnly !== false
    || binding.activationChallengeId !== null
    || !validAccessBinding(binding)
  ) {
    return null;
  }
  return Object.freeze({
    callSid,
    principalId: binding.principalId,
    identityId,
    destinationIdentityId: identityId,
    relayNonce: binding.relayNonce,
    direction: "outbound",
    activationOnly: false,
    activationChallengeId: null,
    accessKind: binding.accessKind as "owner" | "guest",
    guestGrantId: binding.guestGrantId as string | null,
    guestGrantVersion: binding.guestGrantVersion as number | null,
    accessDocumentHash: binding.accessDocumentHash as string | null,
  });
}

function validAccessBinding(binding: Record<string, unknown>): boolean {
  if (binding.accessKind === "owner") {
    return binding.guestGrantId === null
      && binding.guestGrantVersion === null
      && binding.accessDocumentHash === null;
  }
  return binding.accessKind === "guest"
    && typeof binding.guestGrantId === "string"
    && ULID.test(binding.guestGrantId)
    && Number.isSafeInteger(binding.guestGrantVersion)
    && (binding.guestGrantVersion as number) > 0
    && typeof binding.accessDocumentHash === "string"
    && /^[0-9a-f]{64}$/u.test(binding.accessDocumentHash);
}

function sameBinding(left: Readonly<RelayBinding>, right: Readonly<RelayBinding>): boolean {
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

function snapshotOutboundSession(
  value: unknown,
  attemptId: Ulid,
  expectedBinding: Readonly<RelayBinding>,
): Readonly<StoredCallSession> | null {
  const session = exactDataRecord(value, SESSION_FIELDS);
  if (session === null) return null;
  const binding = snapshotBinding(session.binding, expectedBinding.callSid, expectedBinding.destinationIdentityId);
  if (
    binding === null
    || !sameBinding(binding, expectedBinding)
    || session.sessionId !== attemptId
    || session.callSid !== expectedBinding.callSid
    || session.expectedAttemptId !== attemptId
    || session.direction !== "outbound"
    || typeof session.phase !== "string"
    || !NONTERMINAL_PHASES.has(session.phase)
    || !canonicalTimestamp(session.nonceExpiresAt)
    || session.relaySetupExpiresAt !== null
    || session.providerSessionId !== null && (typeof session.providerSessionId !== "string" || !PROVIDER_SESSION_ID.test(session.providerSessionId))
    || (session.providerSessionId === null) !== (session.providerConnectedAt === null)
    || session.providerConnectedAt !== null && !canonicalTimestamp(session.providerConnectedAt)
    || !canonicalTimestamp(session.createdAt)
    || !canonicalTimestamp(session.updatedAt)
    || session.updatedAt < session.createdAt
  ) {
    return null;
  }
  return Object.freeze({
    sessionId: attemptId,
    callSid: expectedBinding.callSid,
    expectedAttemptId: attemptId,
    direction: "outbound",
    phase: session.phase as StoredCallSession["phase"],
    nonceExpiresAt: session.nonceExpiresAt,
    relaySetupExpiresAt: null,
    providerSessionId: session.providerSessionId as string | null,
    providerConnectedAt: session.providerConnectedAt as string | null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    binding,
  });
}

function neutral(body: "forbidden" | "unavailable", status: 403 | 503): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

/** Performs immutable initial authorization, then delegates all attempt authority to Task 3. */
export async function dispatchOutboundCall(
  command: unknown,
  deps: OutboundDispatchDependencies,
): Promise<OutboundCallDispatchResult> {
  const request = snapshotOutboundCallRequest(command);
  if (request === null) throw new Error("invalid_request");
  const captured = exactDataRecord(deps, DISPATCH_DEPENDENCY_FIELDS);
  const policy = captured === null ? null : snapshotMethod(captured.policy, "evaluateOutboundCall");
  const dispatcher = captured === null ? null : snapshotMethod(captured.dispatcher, "dispatch");
  if (policy === null || dispatcher === null) throw new Error("invalid_dependencies");

  const decision = snapshotPolicyDecision(await policy.method.call(policy.receiver, request));
  if (decision === null) throw new Error("invalid_policy_decision");
  if (decision.decision === "deny") throw new Error(decision.reason);
  return dispatcher.method.call(dispatcher.receiver, request) as Promise<OutboundCallDispatchResult>;
}

/** Claims one signed outbound TwiML request without accepting nonce or identity authority from it. */
export async function claimOutboundTwiML(
  request: Request,
  attemptId: Ulid,
  deps: OutboundTwiMLDependencies,
): Promise<Response> {
  if (typeof attemptId !== "string" || !ULID.test(attemptId)) return neutral("forbidden", 403);
  const captured = exactDataRecord(deps, TWIML_DEPENDENCY_FIELDS, "now");
  const verifier = captured === null ? null : snapshotMethod(captured.twilio, "verifyWebhook");
  const recipientLookup = captured === null ? null : snapshotMethod(captured.recipients, "resolveActiveVerifiedVoiceIdentityId");
  const expectedCallClaim = captured === null ? null : snapshotMethod(captured.calls, "claimExpectedCall");
  const outboundSession = captured === null ? null : snapshotMethod(captured.calls, "getOrCreateOutboundSession");
  const ownerStepUp = captured === null ? null : snapshotMethod(captured.ownerStepUp, "bind");
  const initializeSession = captured?.initializeSession;
  const now = (captured?.now ?? (() => new Date())) as (() => Date) | unknown;
  const trustedOrigin = snapshotTrustedPublicOrigin(captured?.publicOrigin);
  if (
    verifier === null
    || recipientLookup === null
    || expectedCallClaim === null
    || outboundSession === null
    || ownerStepUp === null
    || typeof initializeSession !== "function"
    || typeof now !== "function"
    || trustedOrigin === null
    || !safeAtom(captured?.ownerIdentityId)
  ) {
    return neutral("unavailable", 503);
  }

  const exactOutboundUrl = `${trustedOrigin.origin}/voice/outbound/${attemptId}`;
  let form: Awaited<ReturnType<TwilioRequestVerifier["verifyWebhook"]>>;
  try {
    form = await verifier.method.call(verifier.receiver, { request, exactUrl: exactOutboundUrl }) as Awaited<ReturnType<TwilioRequestVerifier["verifyWebhook"]>>;
  } catch {
    return neutral("unavailable", 503);
  }
  const pairs = snapshotVerifiedTwilioFormPairs(form);
  if (pairs === null) return neutral("forbidden", 403);
  const values = (name: string): readonly string[] => pairs
    .filter(([candidate]) => candidate === name)
    .map(([, value]) => value);
  const callSidValues = values("CallSid");
  const destinationValues = values("To");
  const callSid = callSidValues[0];
  const destination = destinationValues[0];
  if (
    callSidValues.length !== 1
    || destinationValues.length !== 1
    || typeof callSid !== "string"
    || !CALL_SID.test(callSid)
    || typeof destination !== "string"
    || !E164.test(destination)
  ) {
    return neutral("forbidden", 403);
  }

  let observedIdentity: unknown;
  try {
    observedIdentity = await recipientLookup.method.call(recipientLookup.receiver, destination);
  } catch {
    return neutral("unavailable", 503);
  }
  if (!safeAtom(observedIdentity)) return neutral("forbidden", 403);
  const observedAt = capturedDate(now as () => Date);
  if (observedAt === null) return neutral("unavailable", 503);

  let claimed: RelayBinding | null;
  try {
    claimed = await expectedCallClaim.method.call(expectedCallClaim.receiver, {
      attemptId,
      callSid,
      observedDestinationIdentityId: observedIdentity,
      ownerIdentityId: captured.ownerIdentityId,
      now: observedAt,
    }) as RelayBinding | null;
  } catch {
    return neutral("unavailable", 503);
  }
  const binding = snapshotBinding(claimed, callSid, observedIdentity);
  if (binding === null) return neutral("forbidden", 403);

  let stored: StoredCallSession;
  try {
    stored = await outboundSession.method.call(outboundSession.receiver, {
      attemptId,
      binding,
      now: observedAt,
    }) as StoredCallSession;
  } catch (error) {
    return isCallSessionAdmissionError(error)
      ? neutral("forbidden", 403)
      : neutral("unavailable", 503);
  }
  const session = snapshotOutboundSession(stored, attemptId, binding);
  if (session === null) return neutral("unavailable", 503);

  try {
    await ownerStepUp.method.call(ownerStepUp.receiver, Object.freeze({
      sessionId: session.sessionId,
      callSid: session.callSid,
      ownerPrincipalId: session.binding.principalId,
      ownerIdentityId: session.binding.identityId,
      direction: "outbound" as const,
      lifecycleGeneration: 1 as const,
      requirement: "required" as const,
      attestationClass: "not_applicable" as const,
      policy: "passphrase_always" as const,
      createdAt: observedAt.toISOString(),
    }));
  } catch {
    return neutral("unavailable", 503);
  }

  let body: string;
  try {
    const sessionUrl = new URL(`/voice/relay/${attemptId}`, trustedOrigin.origin);
    sessionUrl.protocol = "wss:";
    body = renderConversationRelayTwiML({
      publicOrigin: new URL(`${trustedOrigin.origin}/`),
      sessionUrl,
      actionUrl: twilioCleanupUrl("/voice/relay-ended", trustedOrigin.origin),
      relayNonce: session.binding.relayNonce,
      voiceConfig: {
        language: "en-US",
        transcriptionProvider: "Deepgram",
        speechModel: "nova-3-general",
        ttsProvider: "Google",
        voice: "en-US-Journey-O",
      },
    });
  } catch {
    return neutral("unavailable", 503);
  }

  const preAuthentication = Object.freeze({ voicemailMessage: OUTBOUND_VOICEMAIL_MESSAGE });
  const initialization: OutboundSessionInitialization = Object.freeze({
    sessionId: attemptId,
    binding: session.binding,
    relaySetupExpiresAt: null,
    preAuthentication,
  });
  try {
    await initializeSession(initialization);
  } catch {
    return neutral("unavailable", 503);
  }

  // A terminal callback can commit while initialization is in flight. The
  // replay read revalidates terminal state and access before issuing TwiML.
  try {
    await outboundSession.method.call(outboundSession.receiver, {
      attemptId, binding, now: observedAt,
    });
  } catch (error) {
    return isCallSessionAdmissionError(error) ? neutral("forbidden", 403) : neutral("unavailable", 503);
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/xml; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

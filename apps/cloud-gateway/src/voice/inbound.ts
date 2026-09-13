import type { RelayBinding, Ulid } from "../../../../packages/contracts/src/index.js";
import { twilioCleanupUrl } from "../providers/twilio-cleanup-url.js";
import {
  isCallSessionAdmissionError,
  type StoredCallSession,
} from "../persistence/call-repository.js";
import type { TwilioRequestVerifier } from "../providers/provider-types.js";
import { snapshotVerifiedTwilioFormPairs } from "../providers/twilio-verifier.js";
import {
  isTrustedFixedUrl,
  snapshotTrustedPublicOrigin,
  snapshotUrl,
} from "../security/trusted-public-origin.js";
import { renderConversationRelayTwiML } from "./twiml.js";

export interface InboundVoiceDependencies {
  twilio: TwilioRequestVerifier;
  exactInboundWebhookUrl: string;
  publicOrigin: URL;
  expectedInboundE164: string;
  ownerIdentityId: string;
  currentChallengeHmacKeyVersion: string;
  sessions: {
    getOrCreateInboundSession(input: {
      callSid: string;
      callerE164: string;
      ownerIdentityId: string;
      currentChallengeHmacKeyVersion: string;
      now: Date;
    }): Promise<StoredCallSession>;
  };
  initializeSession(input: {
    sessionId: Ulid;
    binding: RelayBinding;
    relaySetupExpiresAt: string | null;
  }): Promise<void>;
  now?: () => Date;
}

interface SessionSnapshot {
  readonly sessionId: Ulid;
  readonly callSid: string;
  readonly relaySetupExpiresAt: string;
  readonly binding: RelayBinding;
}

const E164 = /^\+[1-9][0-9]{7,14}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const RELAY_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const PROVIDER_SESSION_ID = /^VX[0-9A-Fa-f]{32}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NONTERMINAL_PHASES = new Set(["created", "connecting", "pre_auth", "authenticated", "active", "ending"]);
const SESSION_FIELDS = new Set([
  "sessionId", "callSid", "expectedAttemptId", "direction", "phase", "nonceExpiresAt",
  "relaySetupExpiresAt", "providerSessionId", "providerConnectedAt", "createdAt", "updatedAt", "binding",
]);
const BINDING_FIELDS = new Set([
  "callSid", "principalId", "identityId", "destinationIdentityId", "relayNonce",
  "direction", "activationOnly", "activationChallengeId",
  "accessKind", "guestGrantId", "guestGrantVersion", "accessDocumentHash",
]);
const DEPENDENCY_FIELDS = new Set([
  "twilio", "exactInboundWebhookUrl", "publicOrigin", "expectedInboundE164",
  "ownerIdentityId", "currentChallengeHmacKeyVersion", "sessions", "initializeSession", "now",
]);

function neutral(body: "forbidden" | "unavailable", status: 403 | 503): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

function exactDataRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> | null {
  let prototype: object | null;
  try { prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null; }
  catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) {
    return null;
  }
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch { return null; }
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) return null;
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { return null; }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }
  return captured;
}

function snapshotDependencies(value: unknown): Record<string, unknown> | null {
  let prototype: object | null;
  try { prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null; }
  catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) return null;
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch { return null; }
  if (
    keys.length !== DEPENDENCY_FIELDS.size && keys.length !== DEPENDENCY_FIELDS.size - 1
    || keys.some((key) => typeof key !== "string" || !DEPENDENCY_FIELDS.has(key))
    || keys.length === DEPENDENCY_FIELDS.size - 1 && keys.includes("now")
  ) {
    return null;
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of DEPENDENCY_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); }
    catch { return null; }
    if (descriptor === undefined) {
      if (field === "now") continue;
      return null;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }
  return captured;
}

function snapshotMethod(value: unknown, name: string): { readonly receiver: object; readonly method: (...args: never[]) => unknown } | null {
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
  return Object.freeze({ receiver: value, method: descriptor.value as (...args: never[]) => unknown });
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
    && /^[0-9a-f]{64}$/u.test(binding.accessDocumentHash)
    && binding.activationOnly === false
    && binding.activationChallengeId === null;
}

function snapshotSession(value: unknown, expectedCallSid: string, observedAt: string): SessionSnapshot | null {
  const session = exactDataRecord(value, SESSION_FIELDS);
  if (session === null) return null;
  const binding = exactDataRecord(session.binding, BINDING_FIELDS);
  if (
    binding === null
    || typeof session.sessionId !== "string"
    || !ULID.test(session.sessionId)
    || session.callSid !== expectedCallSid
    || session.expectedAttemptId !== null
    || session.direction !== "inbound"
    || typeof session.phase !== "string"
    || !NONTERMINAL_PHASES.has(session.phase)
    || !canonicalTimestamp(session.nonceExpiresAt)
    || !canonicalTimestamp(session.relaySetupExpiresAt)
    || session.nonceExpiresAt !== session.relaySetupExpiresAt
    || session.providerSessionId !== null && (typeof session.providerSessionId !== "string" || !PROVIDER_SESSION_ID.test(session.providerSessionId))
    || (session.providerSessionId === null) !== (session.providerConnectedAt === null)
    || session.providerConnectedAt !== null && !canonicalTimestamp(session.providerConnectedAt)
    || !canonicalTimestamp(session.createdAt)
    || !canonicalTimestamp(session.updatedAt)
    || session.updatedAt < session.createdAt
    || session.relaySetupExpiresAt <= session.createdAt
    || session.providerSessionId === null && session.relaySetupExpiresAt <= observedAt
    || new Date(session.relaySetupExpiresAt).valueOf() - new Date(session.createdAt).valueOf() > 300_000
    || binding.callSid !== expectedCallSid
    || !safeAtom(binding.principalId)
    || !safeAtom(binding.identityId)
    || binding.destinationIdentityId !== binding.identityId
    || typeof binding.relayNonce !== "string"
    || !RELAY_NONCE.test(binding.relayNonce)
    || binding.direction !== "inbound"
    || typeof binding.activationOnly !== "boolean"
    || binding.activationChallengeId !== null && !safeAtom(binding.activationChallengeId)
    || (binding.activationOnly ? binding.activationChallengeId === null : binding.activationChallengeId !== null)
    || !validAccessBinding(binding)
  ) {
    return null;
  }
  const frozenBinding: RelayBinding = Object.freeze({
    callSid: expectedCallSid,
    principalId: binding.principalId,
    identityId: binding.identityId,
    destinationIdentityId: binding.destinationIdentityId,
    relayNonce: binding.relayNonce,
    direction: "inbound",
    activationOnly: binding.activationOnly,
    activationChallengeId: binding.activationChallengeId,
    accessKind: binding.accessKind as "owner" | "guest",
    guestGrantId: binding.guestGrantId as string | null,
    guestGrantVersion: binding.guestGrantVersion as number | null,
    accessDocumentHash: binding.accessDocumentHash as string | null,
  });
  return Object.freeze({
    sessionId: session.sessionId as Ulid,
    callSid: expectedCallSid,
    relaySetupExpiresAt: session.relaySetupExpiresAt,
    binding: frozenBinding,
  });
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

/** Direct, dependency-injected signed ingress. Route construction remains a later task. */
export async function handleInboundVoiceWebhook(
  request: Request,
  deps: InboundVoiceDependencies,
): Promise<Response> {
  let verifyWebhook: TwilioRequestVerifier["verifyWebhook"];
  let verifierThis: TwilioRequestVerifier;
  let getOrCreateInboundSession: InboundVoiceDependencies["sessions"]["getOrCreateInboundSession"];
  let sessionsThis: InboundVoiceDependencies["sessions"];
  let initializeSession: InboundVoiceDependencies["initializeSession"];
  let exactInboundWebhookUrl: string;
  let expectedInboundE164: string;
  let ownerIdentityId: string;
  let currentChallengeHmacKeyVersion: string;
  let now: () => Date;
  let trustedOrigin: ReturnType<typeof snapshotTrustedPublicOrigin>;
  const captured = snapshotDependencies(deps);
  if (captured === null) return neutral("unavailable", 503);
  const verifier = snapshotMethod(captured.twilio, "verifyWebhook");
  const sessionRepository = snapshotMethod(captured.sessions, "getOrCreateInboundSession");
  verifierThis = verifier?.receiver as TwilioRequestVerifier;
  verifyWebhook = verifier?.method as TwilioRequestVerifier["verifyWebhook"];
  sessionsThis = sessionRepository?.receiver as InboundVoiceDependencies["sessions"];
  getOrCreateInboundSession = sessionRepository?.method as InboundVoiceDependencies["sessions"]["getOrCreateInboundSession"];
  initializeSession = captured.initializeSession as InboundVoiceDependencies["initializeSession"];
  exactInboundWebhookUrl = captured.exactInboundWebhookUrl as string;
  expectedInboundE164 = captured.expectedInboundE164 as string;
  ownerIdentityId = captured.ownerIdentityId as string;
  currentChallengeHmacKeyVersion = captured.currentChallengeHmacKeyVersion as string;
  now = (captured.now ?? (() => new Date())) as () => Date;
  trustedOrigin = snapshotTrustedPublicOrigin(captured.publicOrigin);
  let inboundUrl: ReturnType<typeof snapshotUrl> = null;
  try {
    const parsedInboundUrl = new URL(exactInboundWebhookUrl);
    if (parsedInboundUrl.toString() === exactInboundWebhookUrl) inboundUrl = snapshotUrl(parsedInboundUrl);
  } catch {
    inboundUrl = null;
  }
  if (
    typeof verifyWebhook !== "function"
    || typeof getOrCreateInboundSession !== "function"
    || typeof initializeSession !== "function"
    || typeof now !== "function"
    || trustedOrigin === null
    || !isTrustedFixedUrl(inboundUrl, trustedOrigin, "https:", "/voice/inbound")
    || typeof expectedInboundE164 !== "string"
    || !E164.test(expectedInboundE164)
    || !safeAtom(ownerIdentityId)
    || !safeAtom(currentChallengeHmacKeyVersion)
  ) {
    return neutral("unavailable", 503);
  }

  let form: Awaited<ReturnType<TwilioRequestVerifier["verifyWebhook"]>>;
  try {
    form = await verifyWebhook.call(verifierThis, { request, exactUrl: exactInboundWebhookUrl });
  } catch {
    return neutral("unavailable", 503);
  }
  const pairs = snapshotVerifiedTwilioFormPairs(form);
  if (pairs === null) return neutral("forbidden", 403);
  const values = (name: string): readonly string[] => pairs
    .filter(([candidate]) => candidate === name)
    .map(([, value]) => value);
  const fromValues = values("From");
  const toValues = values("To");
  const callSidValues = values("CallSid");
  const callerE164 = fromValues[0];
  const calledE164 = toValues[0];
  const callSid = callSidValues[0];
  if (
    fromValues.length !== 1
    || toValues.length !== 1
    || callSidValues.length !== 1
    || callerE164 === undefined
    || calledE164 === undefined
    || callSid === undefined
    || !E164.test(callerE164)
    || !E164.test(calledE164)
    || calledE164 !== expectedInboundE164
    || !CALL_SID.test(callSid)
  ) {
    return neutral("forbidden", 403);
  }
  const observedAt = capturedDate(now);
  if (observedAt === null) return neutral("unavailable", 503);

  let stored: StoredCallSession;
  try {
    stored = await getOrCreateInboundSession.call(sessionsThis, {
      callSid,
      callerE164,
      ownerIdentityId,
      currentChallengeHmacKeyVersion,
      now: observedAt,
    });
  } catch (error) {
    return isCallSessionAdmissionError(error)
      ? neutral("forbidden", 403)
      : neutral("unavailable", 503);
  }
  const session = snapshotSession(stored, callSid, observedAt.toISOString());
  if (session === null) return neutral("unavailable", 503);

  let body: string;
  try {
    const sessionUrl = new URL(`/voice/relay/${session.sessionId}`, trustedOrigin.origin);
    sessionUrl.protocol = "wss:";
    const actionUrl = twilioCleanupUrl("/voice/relay-ended", trustedOrigin.origin);
    body = renderConversationRelayTwiML({
      publicOrigin: new URL(`${trustedOrigin.origin}/`),
      sessionUrl,
      actionUrl,
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

  try {
    await initializeSession({
      sessionId: session.sessionId,
      binding: session.binding,
      relaySetupExpiresAt: session.relaySetupExpiresAt,
    });
  } catch {
    return neutral("unavailable", 503);
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/xml; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

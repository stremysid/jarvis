import {
  canonicalJson,
  sha256Hex,
  type Sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  snapshotVerifiedTwilioFormPairs,
  type VerifiedTwilioForm,
  type VerifiedTwilioFormPair,
} from "../providers/twilio-verifier.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const PROVIDER_SESSION_ID = /^VX[0-9A-Fa-f]{32}$/u;
const CANONICAL_SEQUENCE = /^(?:0|[1-9][0-9]*)$/u;
const CALL_STATUSES = new Set([
  "queued", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled",
]);
const SESSION_STATUSES = new Set(["ended", "failed", "completed"]);

export interface TwilioStatusCallbackRecord {
  readonly endpointKind: "status";
  readonly attemptId: Ulid;
  readonly callSid: string;
  readonly callbackSource: "call-progress-events";
  readonly sequenceNumber: number;
  readonly callStatus: string;
  readonly requestHash: Sha256Hex;
}

export interface TwilioRelayEndedCallbackRecord {
  readonly endpointKind: "relay_ended";
  readonly callSid: string;
  readonly sessionId: string;
  readonly sessionStatus: string;
  readonly sessionDurationSeconds: number;
  readonly requestHash: Sha256Hex;
}

export type TwilioCallbackRecord = TwilioStatusCallbackRecord | TwilioRelayEndedCallbackRecord;

export interface TwilioCallbackRecorder {
  record(input: TwilioCallbackRecord): Promise<void>;
}

function neutral(body: "forbidden" | "unavailable", status: 403 | 503): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

function singletonValue(pairs: readonly VerifiedTwilioFormPair[], name: string): string | null {
  let found: string | null = null;
  for (const [candidate, value] of pairs) {
    if (candidate !== name) continue;
    if (found !== null) return null;
    found = value;
  }
  return found;
}

function sortPairs(pairs: readonly VerifiedTwilioFormPair[]): readonly VerifiedTwilioFormPair[] {
  return [...pairs].sort(([leftName, leftValue], [rightName, rightValue]) => (
    leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
  ));
}

function captureRecorder(value: unknown): { readonly receiver: object; readonly method: TwilioCallbackRecorder["record"] } | null {
  if (value === null || typeof value !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "record");
    if (descriptor === undefined) {
      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== null) descriptor = Object.getOwnPropertyDescriptor(prototype, "record");
    }
  } catch {
    return null;
  }
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
    ? Object.freeze({ receiver: value, method: descriptor.value as TwilioCallbackRecorder["record"] })
    : null;
}

export async function handleTwilioStatusCallback(
  attemptId: Ulid,
  form: VerifiedTwilioForm,
  recorder: TwilioCallbackRecorder,
): Promise<Response> {
  const pairs = snapshotVerifiedTwilioFormPairs(form);
  if (pairs === null || typeof attemptId !== "string" || !ULID.test(attemptId)) return neutral("forbidden", 403);
  const callSid = singletonValue(pairs, "CallSid");
  const callbackSource = singletonValue(pairs, "CallbackSource");
  const rawSequence = singletonValue(pairs, "SequenceNumber");
  const callStatus = singletonValue(pairs, "CallStatus");
  if (
    typeof callSid !== "string"
    || !CALL_SID.test(callSid)
    || callbackSource !== "call-progress-events"
    || typeof rawSequence !== "string"
    || !CANONICAL_SEQUENCE.test(rawSequence)
    || typeof callStatus !== "string"
    || !CALL_STATUSES.has(callStatus)
  ) {
    return neutral("forbidden", 403);
  }
  const sequenceNumber = Number(rawSequence);
  if (!Number.isSafeInteger(sequenceNumber)) return neutral("forbidden", 403);
  const capturedRecorder = captureRecorder(recorder);
  if (capturedRecorder === null) return neutral("unavailable", 503);
  const requestHash = await sha256Hex(canonicalJson(sortPairs(pairs)));
  const record = Object.freeze({
    endpointKind: "status",
    attemptId,
    callSid,
    callbackSource,
    sequenceNumber,
    callStatus,
    requestHash,
  } satisfies TwilioStatusCallbackRecord);
  try {
    await capturedRecorder.method.call(capturedRecorder.receiver, record);
  } catch {
    return neutral("unavailable", 503);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function handleTwilioRelayEndedCallback(
  form: VerifiedTwilioForm,
  recorder: TwilioCallbackRecorder,
): Promise<Response> {
  const pairs = snapshotVerifiedTwilioFormPairs(form);
  if (pairs === null) return neutral("forbidden", 403);
  const callSid = singletonValue(pairs, "CallSid");
  const sessionId = singletonValue(pairs, "SessionId");
  const sessionStatus = singletonValue(pairs, "SessionStatus");
  const rawDuration = singletonValue(pairs, "SessionDuration");
  if (
    typeof callSid !== "string"
    || !CALL_SID.test(callSid)
    || typeof sessionId !== "string"
    || !PROVIDER_SESSION_ID.test(sessionId)
    || typeof sessionStatus !== "string"
    || !SESSION_STATUSES.has(sessionStatus)
    || typeof rawDuration !== "string"
    || !CANONICAL_SEQUENCE.test(rawDuration)
  ) {
    return neutral("forbidden", 403);
  }
  const sessionDurationSeconds = Number(rawDuration);
  if (!Number.isSafeInteger(sessionDurationSeconds)) return neutral("forbidden", 403);
  const capturedRecorder = captureRecorder(recorder);
  if (capturedRecorder === null) return neutral("unavailable", 503);
  const requestHash = await sha256Hex(canonicalJson(sortPairs(pairs)));
  const record = Object.freeze({
    endpointKind: "relay_ended",
    callSid,
    sessionId,
    sessionStatus,
    sessionDurationSeconds,
    requestHash,
  } satisfies TwilioRelayEndedCallbackRecord);
  try {
    await capturedRecorder.method.call(capturedRecorder.receiver, record);
  } catch {
    return neutral("unavailable", 503);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

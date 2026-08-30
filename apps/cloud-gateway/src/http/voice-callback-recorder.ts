import {
  createEnvelope,
  newUlid,
  type PersistableEventEnvelopeV1,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import type { CallRepository } from "../persistence/call-repository.js";
import { Redactor } from "../security/redaction.js";
import type {
  TwilioCallbackRecord,
  TwilioCallbackRecorder,
  TwilioRelayEndedCallbackRecord,
  TwilioStatusCallbackRecord,
} from "./voice-callbacks.js";

const PRODUCER_VERSION = "jarvis-cloud-gateway/voice-callback-v1";
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const CALL_SID = /^CA[0-9A-Fa-f]{32}$/u;
const PROVIDER_SESSION_ID = /^VX[0-9A-Fa-f]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CALL_STATUSES = new Set(["queued", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled"]);
const SESSION_STATUSES = new Set(["ended", "failed", "completed"]);
const STATUS_FIELDS = new Set([
  "endpointKind", "attemptId", "callSid", "callbackSource", "sequenceNumber", "callStatus", "requestHash",
]);
const RELAY_FIELDS = new Set([
  "endpointKind", "callSid", "sessionId", "sessionStatus", "sessionDurationSeconds", "requestHash",
]);

interface CallbackContextRow {
  principal_id: string;
  correlation_id: string;
}

export interface D1TwilioCallbackRecorderDependencies {
  database: D1Database;
  calls: Pick<CallRepository, "appendProviderEvent">;
  now?: () => Date;
  newEventId?: () => Ulid;
}

function exactRecord(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) return null;
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }
  return captured;
}

function snapshotCallbackRecord(value: unknown): TwilioCallbackRecord | null {
  let endpointDescriptor: PropertyDescriptor | undefined;
  try { endpointDescriptor = value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "endpointKind") : undefined; }
  catch { return null; }
  if (endpointDescriptor === undefined || !("value" in endpointDescriptor)) return null;
  if (endpointDescriptor.value === "status") {
    const status = exactRecord(value, STATUS_FIELDS);
    if (
      status === null
      || typeof status.attemptId !== "string"
      || !ULID.test(status.attemptId)
      || typeof status.callSid !== "string"
      || !CALL_SID.test(status.callSid)
      || status.callbackSource !== "call-progress-events"
      || !Number.isSafeInteger(status.sequenceNumber)
      || (status.sequenceNumber as number) < 0
      || typeof status.callStatus !== "string"
      || !CALL_STATUSES.has(status.callStatus)
      || typeof status.requestHash !== "string"
      || !SHA256.test(status.requestHash)
    ) return null;
    return Object.freeze({
      endpointKind: "status",
      attemptId: status.attemptId as Ulid,
      callSid: status.callSid,
      callbackSource: "call-progress-events",
      sequenceNumber: status.sequenceNumber as number,
      callStatus: status.callStatus,
      requestHash: status.requestHash as TwilioStatusCallbackRecord["requestHash"],
    });
  }
  if (endpointDescriptor.value === "relay_ended") {
    const relay = exactRecord(value, RELAY_FIELDS);
    if (
      relay === null
      || typeof relay.callSid !== "string"
      || !CALL_SID.test(relay.callSid)
      || typeof relay.sessionId !== "string"
      || !PROVIDER_SESSION_ID.test(relay.sessionId)
      || typeof relay.sessionStatus !== "string"
      || !SESSION_STATUSES.has(relay.sessionStatus)
      || !Number.isSafeInteger(relay.sessionDurationSeconds)
      || (relay.sessionDurationSeconds as number) < 0
      || typeof relay.requestHash !== "string"
      || !SHA256.test(relay.requestHash)
    ) return null;
    return Object.freeze({
      endpointKind: "relay_ended",
      callSid: relay.callSid,
      sessionId: relay.sessionId,
      sessionStatus: relay.sessionStatus,
      sessionDurationSeconds: relay.sessionDurationSeconds as number,
      requestHash: relay.requestHash as TwilioRelayEndedCallbackRecord["requestHash"],
    });
  }
  return null;
}

function captureAppendProviderEvent(value: unknown): {
  readonly receiver: object;
  readonly method: CallRepository["appendProviderEvent"];
} | null {
  if (value === null || typeof value !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "appendProviderEvent");
    if (descriptor === undefined) {
      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== null) descriptor = Object.getOwnPropertyDescriptor(prototype, "appendProviderEvent");
    }
  } catch {
    return null;
  }
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
    ? Object.freeze({ receiver: value, method: descriptor.value as CallRepository["appendProviderEvent"] })
    : null;
}

/** Creates safe callback envelopes and delegates atomic reconciliation to CallRepository. */
export class D1TwilioCallbackRecorder implements TwilioCallbackRecorder {
  private readonly database: D1Database;
  private readonly appendProviderEvent: {
    readonly receiver: object;
    readonly method: CallRepository["appendProviderEvent"];
  };
  private readonly now: () => Date;
  private readonly newEventId: () => Ulid;
  private readonly redactor = new Redactor();

  constructor(deps: D1TwilioCallbackRecorderDependencies) {
    const appendProviderEvent = captureAppendProviderEvent(deps.calls);
    if (appendProviderEvent === null) throw new TypeError("callback_repository_invalid");
    this.database = deps.database;
    this.appendProviderEvent = appendProviderEvent;
    this.now = deps.now ?? (() => new Date());
    this.newEventId = deps.newEventId ?? newUlid;
  }

  async record(input: TwilioCallbackRecord): Promise<void> {
    const snapshot = snapshotCallbackRecord(input);
    if (snapshot === null) throw new TypeError("callback_record_invalid");
    if (snapshot.endpointKind === "status") {
      await this.recordStatus(snapshot);
      return;
    }
    if (snapshot.endpointKind === "relay_ended") {
      await this.recordRelayEnded(snapshot);
      return;
    }
    throw new TypeError("callback_endpoint_invalid");
  }

  private async recordStatus(input: TwilioStatusCallbackRecord): Promise<void> {
    const context = await this.database.prepare(`SELECT principal_id, command_id AS correlation_id
      FROM outbound_call_attempts
      WHERE attempt_id = ?1`)
      .bind(input.attemptId)
      .first<CallbackContextRow>();
    const envelope = await this.envelope(
      context,
      "provider.call_status",
      input.callStatus,
      { sequenceNumber: input.sequenceNumber },
    );
    await this.appendProviderEvent.method.call(this.appendProviderEvent.receiver, {
      endpointKind: "status",
      attemptId: input.attemptId,
      callSid: input.callSid,
      callbackSource: input.callbackSource,
      sequenceNumber: input.sequenceNumber,
      requestHash: input.requestHash,
      envelope,
    });
  }

  private async recordRelayEnded(input: TwilioRelayEndedCallbackRecord): Promise<void> {
    const context = await this.database.prepare(`SELECT principal_id, session_id AS correlation_id
      FROM call_sessions
      WHERE call_sid = ?1 AND provider_session_id = ?2`)
      .bind(input.callSid, input.sessionId)
      .first<CallbackContextRow>();
    const envelope = await this.envelope(
      context,
      "provider.relay_ended",
      input.sessionStatus,
      { sessionDurationSeconds: input.sessionDurationSeconds },
    );
    await this.appendProviderEvent.method.call(this.appendProviderEvent.receiver, {
      endpointKind: "relay_ended",
      callSid: input.callSid,
      sessionId: input.sessionId,
      requestHash: input.requestHash,
      envelope,
    });
  }

  private async envelope(
    context: CallbackContextRow | null,
    eventType: "provider.call_status" | "provider.relay_ended",
    lifecycleStatus: string,
    numericPayload: Readonly<Record<string, number>>,
  ): Promise<PersistableEventEnvelopeV1> {
    if (
      context === null
      || typeof context.principal_id !== "string"
      || context.principal_id.length === 0
      || typeof context.correlation_id !== "string"
    ) {
      throw new Error("callback_context_missing");
    }
    const status = this.redactor.redactText(lifecycleStatus);
    if (!status.ok) throw new Error("callback_status_redaction_failed");
    const observedAt = this.snapshotNow();
    const statusKey = eventType === "provider.call_status" ? "callStatus" : "sessionStatus";
    return createEnvelope({
      schemaVersion: "1.0",
      eventId: this.newEventId(),
      eventType,
      source: "twilio",
      subjectId: context.principal_id,
      occurredAt: observedAt,
      receivedAt: observedAt,
      correlationId: context.correlation_id as Ulid,
      contentType: "application/json",
      payload: { [statusKey]: status, ...numericPayload },
      producerVersion: PRODUCER_VERSION,
    });
  }

  private snapshotNow(): string {
    const value = this.now();
    const epoch = Date.prototype.getTime.call(value) as number;
    if (!Number.isFinite(epoch)) throw new TypeError("callback_clock_invalid");
    return new Date(epoch).toISOString();
  }
}

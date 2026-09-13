import { canonicalJson, sha256Hex, validateEnvelope, type OutboundCallCommand, type Ulid } from "../../../../../packages/contracts/src/index.js";
import type { TrustedOrigin } from "../../policy/policy-engine.js";
import { dispatchOutboundCall, type OutboundDispatchDependencies } from "../../voice/outbound.js";
import { parseCommand } from "./telegram-commands.js";
import { ACCEPTED_EVENT, IDEMPOTENCY_SCOPE, PRODUCER_VERSION, type AcceptedTelegramUpdate } from "./telegram-webhook.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const CALL_PAYLOAD_FIELDS = new Set(["updateId", "principalId", "chatId", "messageId", "text"]);
const CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const INVALID_REQUEST_REPLY = "Use /call <reason> --confirm on one line to call your verified phone.";
const CONFIRMATION_REPLY = "To confirm, send the same /call command with --confirm at the end. It will call your verified phone.";
const UNKNOWN_OUTCOME_REPLY = "Could not confirm whether the call was placed. Check your phone before trying again.";

class CallCommandRefusal extends Error {
  constructor(readonly code: "not_owner" | "invalid_request" | "confirmation_required" | "origin_unavailable") {
    super(code);
  }
}

interface AcceptedEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly source: string;
  readonly subject_id: string;
  readonly occurred_at: string;
  readonly received_at: string;
  readonly content_hash: string;
  readonly envelope_json: string;
  readonly update_key: string;
}

function requireConfirmation(argument: string): void {
  if (argument.length === 0 || argument.length > 256 || CONTROLS.test(argument)) {
    throw new CallCommandRefusal("invalid_request");
  }
  const confirmed = argument.endsWith(" --confirm");
  const reason = (confirmed ? argument.slice(0, -10) : argument).trim();
  if (reason.length === 0 || reason.includes("--")) throw new CallCommandRefusal("invalid_request");
  if (!confirmed) throw new CallCommandRefusal("confirmation_required");
}

/**
 * A confirmed Telegram event is the durable command origin. Both construction
 * and policy rechecks reconstruct the same command, so a replay cannot renew
 * its expiry or substitute a recipient. Old events without receipt-time
 * principal attribution deliberately confer no calling authority.
 */
export class D1TelegramCallCommands {
  constructor(private readonly deps: {
    database: D1Database;
    ownerPrincipalId: string;
    ownerVoiceIdentityId: string;
    botUsername: string | null;
  }) { this.deps = Object.freeze({ ...deps }); }

  async commandFor(accepted: Pick<AcceptedTelegramUpdate, "eventId" | "principalId">): Promise<Readonly<OutboundCallCommand>> {
    if (accepted.principalId !== this.deps.ownerPrincipalId) throw new CallCommandRefusal("not_owner");
    return this.reconstruct(accepted.eventId);
  }

  async authenticatedOrigin(commandId: string): Promise<TrustedOrigin | null> {
    try {
      const command = await this.reconstruct(commandId);
      return Object.freeze({ principalId: command.principalId, issuedBy: "telegram_call_command",
        commandHash: await sha256Hex(canonicalJson(command)) });
    } catch (error) {
      if (error instanceof CallCommandRefusal) return null;
      throw error;
    }
  }

  async request(accepted: Pick<AcceptedTelegramUpdate, "eventId" | "principalId">, dispatch: OutboundDispatchDependencies): Promise<string> {
    try {
      const result = await dispatchOutboundCall(await this.commandFor(accepted), dispatch);
      switch (result.status) {
        case "dispatched": return "Call request accepted for your verified phone.";
        case "provider_dispatch_unknown": return "Call acknowledgement is pending. Check your phone before sending another request.";
        case "rejected": return "The phone provider rejected the call request.";
        case "denied": return "The call request was refused by the calling policy.";
      }
    } catch (error) {
      if (error instanceof CallCommandRefusal) {
        if (error.code === "not_owner") return "Only the owner can request a call.";
        if (error.code === "confirmation_required") return CONFIRMATION_REPLY;
        if (error.code === "invalid_request") return INVALID_REQUEST_REPLY;
        return "The original call authorization is unavailable. Send a new confirmed /call request if you still want a call.";
      }
      if (error instanceof Error && ["authorization_expired", "quiet_hours", "kill_switch_enabled", "daily_limit",
        "concurrency_limit", "retry_limit", "destination_not_verified", "invalid_origin", "policy_command_conflict"].includes(error.message)) {
        return "The call request was refused by the calling policy.";
      }
      // A provider or storage error can include private values and cannot
      // establish that no call was placed. Never echo it or promise a retry.
      return UNKNOWN_OUTCOME_REPLY;
    }
  }

  private async reconstruct(commandId: string): Promise<Readonly<OutboundCallCommand>> {
    if (!ULID.test(commandId)) throw new CallCommandRefusal("origin_unavailable");
    const row = await this.deps.database.prepare(`SELECT event.event_id, event.event_type, event.source, event.subject_id,
      event.occurred_at, event.received_at, event.content_hash, event.envelope_json, receipt.key AS update_key
      FROM events event
      JOIN idempotency_records receipt ON receipt.event_sequence = event.sequence AND receipt.scope = ?2
      JOIN channel_identities identity ON event.subject_id = 'telegram:user:' || identity.provider_subject
      JOIN principals principal ON principal.principal_id = identity.principal_id
      JOIN voice_owner_identity owner ON owner.principal_id = principal.principal_id AND owner.identity_id = ?4
      WHERE event.event_id = ?1 AND identity.channel = 'telegram' AND identity.status = 'active'
        AND identity.verified_at IS NOT NULL AND principal.status = 'active' AND principal.principal_type = 'human'
        AND principal.principal_id = ?3`)
      .bind(commandId, IDEMPOTENCY_SCOPE, this.deps.ownerPrincipalId, this.deps.ownerVoiceIdentityId).first<AcceptedEventRow>();
    if (row === null) throw new CallCommandRefusal("origin_unavailable");
    let envelope;
    try { envelope = await validateEnvelope(JSON.parse(row.envelope_json)); }
    catch { throw new CallCommandRefusal("origin_unavailable"); }
    if (envelope.eventId !== commandId || row.event_id !== commandId || envelope.correlationId !== commandId
      || envelope.eventType !== ACCEPTED_EVENT || row.event_type !== ACCEPTED_EVENT
      || envelope.source !== "channel:telegram" || row.source !== envelope.source
      || envelope.producerVersion !== PRODUCER_VERSION || envelope.subjectId !== row.subject_id
      || envelope.contentHash !== row.content_hash || envelope.receivedAt !== row.received_at
      || envelope.occurredAt !== row.occurred_at || envelope.occurredAt !== envelope.receivedAt) {
      throw new CallCommandRefusal("origin_unavailable");
    }
    const payload = envelope.payload as Record<string, unknown>;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== CALL_PAYLOAD_FIELDS.size || Object.keys(payload).some((key) => !CALL_PAYLOAD_FIELDS.has(key))
      || payload.principalId !== this.deps.ownerPrincipalId
      || !Number.isSafeInteger(payload.updateId) || (payload.updateId as number) < 0 || String(payload.updateId) !== row.update_key
      || !Number.isSafeInteger(payload.messageId) || (payload.messageId as number) <= 0
      || typeof payload.chatId !== "string" || payload.chatId.length === 0 || payload.chatId.length > 128
      || typeof payload.text !== "string") {
      throw new CallCommandRefusal("origin_unavailable");
    }
    const parsed = parseCommand(payload.text, this.deps.botUsername);
    if (parsed.kind !== "command" || parsed.name !== "call") throw new CallCommandRefusal("invalid_request");
    requireConfirmation(parsed.argument);
    return Object.freeze({ commandId: commandId as Ulid, principalId: this.deps.ownerPrincipalId,
      purposeCode: "user_requested", destinationIdentityId: this.deps.ownerVoiceIdentityId, urgency: "normal",
      authorizationExpiresAt: new Date(new Date(envelope.receivedAt).valueOf() + 300_000).toISOString(),
      idempotencyKey: `telegram-call:${payload.chatId}:${payload.messageId}`, issuedBy: "telegram_call_command" });
  }
}

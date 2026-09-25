import { validateEnvelope, type Ulid } from "../../../../packages/contracts/src/index.js";
import { CONVERSATION_EVENT_PRODUCER_VERSION, CONVERSATION_EVENT_SOURCE } from "../conversation/conversation-repository.js";
import { readHistoryPayloadEnvelope } from "./telegram-memory-controls.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
interface PreviousVoiceAssistantRow {
  readonly causation_id: unknown;
  readonly event_id: unknown;
  readonly subject_id: unknown;
  readonly content_hash: unknown;
  readonly envelope_json: unknown;
}

export interface VoiceReplyPayload {
  readonly text: string;
  readonly itemIds: readonly Ulid[];
}

export interface PreviousVoiceAssistant extends VoiceReplyPayload {
  readonly eventId: Ulid;
}

function safeUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new TypeError("owner_agent_item_id_invalid");
  return value as Ulid;
}

/** Read only references committed with the reply whose relay receipt was settled. */
export function readVoiceReplyPayload(value: unknown): VoiceReplyPayload {
  const { memoryItemIds, ...history } = value as Record<string, unknown>;
  const text = readHistoryPayloadEnvelope(history, "owner_agent_previous_reply_invalid");
  if (history.channelCode !== 1 || history.historyEligible !== false || memoryItemIds !== undefined && (
    !Array.isArray(memoryItemIds) || memoryItemIds.length === 0 || memoryItemIds.length > 8
    || memoryItemIds.some(id => typeof id !== "string" || !ULID.test(id))
    || new Set(memoryItemIds).size !== memoryItemIds.length
  )) throw new TypeError("owner_agent_previous_reply_invalid");
  return Object.freeze({ text, itemIds: Object.freeze([...(memoryItemIds ?? []) as Ulid[]]) });
}

/** A spoken answer is grounded only in an earlier settled reply on this call. */
export async function readPreviousVoiceAssistant(database: D1Database, input: Readonly<{
  correlationId: Ulid; principalId: string;
}>): Promise<PreviousVoiceAssistant | null> {
  const row = await database.prepare(`SELECT previous.user_event_id AS causation_id,
      sent.event_id, sent.subject_id, sent.content_hash, sent.envelope_json
    FROM conversation_turns current
    JOIN events current_user ON current_user.event_id = current.user_event_id
    JOIN conversation_turns previous
      ON previous.session_id = current.session_id
      AND previous.principal_id = current.principal_id
      AND previous.channel = 'voice'
      AND previous.state = 'voice_sent'
    JOIN events sent ON sent.event_id = previous.sent_assistant_event_id
    WHERE current.turn_id = ?1 AND current.principal_id = ?2
      AND current.channel = 'voice' AND sent.sequence < current_user.sequence
      AND sent.subject_id = ?2
      AND sent.event_type = 'conversation.assistant_sent'
      AND sent.source = ?3
    ORDER BY sent.sequence DESC LIMIT 1`)
    .bind(input.correlationId, input.principalId, CONVERSATION_EVENT_SOURCE).first<PreviousVoiceAssistantRow>();
  if (row === null || typeof row.envelope_json !== "string") return null;
  let decoded: unknown;
  try { decoded = JSON.parse(row.envelope_json) as unknown; }
  catch { throw new TypeError("owner_agent_previous_reply_invalid"); }
  const envelope = await validateEnvelope(decoded);
  const eventId = safeUlid(row.event_id);
  if (envelope.eventId !== eventId || envelope.subjectId !== input.principalId
    || envelope.causationId !== safeUlid(row.causation_id)
    || envelope.eventType !== "conversation.assistant_sent"
    || envelope.source !== CONVERSATION_EVENT_SOURCE
    || envelope.producerVersion !== CONVERSATION_EVENT_PRODUCER_VERSION
    || envelope.contentHash !== row.content_hash) {
    throw new TypeError("owner_agent_previous_reply_invalid");
  }
  return Object.freeze({
    eventId,
    ...readVoiceReplyPayload(envelope.payload),
  });
}

/**
 * Records conversation turns in the form the context retriever reads back.
 *
 * The webhook already archives a `telegram.update.received` event, but that is
 * a channel-level record keyed by Telegram user id. Conversation history is a
 * separate concern keyed by *principal*, so it survives a channel changing and
 * so voice and Telegram share one history rather than two disjoint ones.
 *
 * The retriever validates source, producer version, subject and payload shape
 * strictly, and throws rather than skipping when an event does not conform.
 * One malformed turn would therefore break retrieval for every later message,
 * which is why these events are constructed in exactly one place.
 */

import {
  createEnvelope,
  newUlid,
  sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import { isIssuedRedaction, type RedactionResult } from "../../../../packages/contracts/src/calls.js";
import type { AppendedEvent, EventAppendInput } from "../persistence/event-repository.js";
import {
  CONVERSATION_EVENT_PRODUCER_VERSION,
  CONVERSATION_EVENT_SOURCE,
} from "./conversation-repository.js";

export const USER_COMMITTED = "conversation.user_committed";
export const ASSISTANT_DELIVERED = "conversation.assistant_delivered";

/** voice = 1, telegram = 2, matching the conversation repository. */
export const CHANNEL_CODE = Object.freeze({ voice: 1, telegram: 2 } as const);

export type TurnRole = "user" | "assistant";

export interface TurnRecorderDependencies {
  readonly events: { append(input: EventAppendInput): Promise<AppendedEvent> };
  readonly redactor: {
    redact(input: { text: string; channel: "voice" | "telegram"; field: string }): RedactionResult;
  };
  readonly now?: () => Date;
  readonly ulid?: (now: Date) => Ulid;
}

export interface RecordTurnInput {
  readonly principalId: string;
  readonly channel: "voice" | "telegram";
  readonly role: TurnRole;
  readonly text: string;
  /** Idempotency key, so a redelivered message cannot double the history. */
  readonly turnKey: string;
}

function isoMilliseconds(moment: Date): string {
  return moment.toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

/**
 * Record one turn. Returns false when the text could not be redacted.
 *
 * A failed redaction is not stored at all: the design forbids persisting or
 * forwarding content the redactor could not process, and a turn absent from
 * history is far better than one that leaks.
 */
export async function recordTurn(
  dependencies: TurnRecorderDependencies,
  input: RecordTurnInput,
): Promise<boolean> {
  const redacted = dependencies.redactor.redact({
    text: input.text,
    channel: input.channel,
    field: "text",
  });
  if (!isIssuedRedaction(redacted)) return false;

  const now = (dependencies.now ?? (() => new Date()))();
  const identifier = (dependencies.ulid ?? newUlid)(now);
  const timestamp = isoMilliseconds(now);
  const eventType = input.role === "user" ? USER_COMMITTED : ASSISTANT_DELIVERED;

  const envelope = await createEnvelope({
    schemaVersion: "1.0",
    eventId: identifier,
    eventType,
    // Both must match what the retriever expects, or it rejects the event and
    // with it all history for this principal.
    source: CONVERSATION_EVENT_SOURCE,
    producerVersion: CONVERSATION_EVENT_PRODUCER_VERSION,
    // Keyed by principal, not by channel identity: history follows the person.
    subjectId: input.principalId,
    occurredAt: timestamp,
    receivedAt: timestamp,
    correlationId: identifier,
    contentType: "application/json",
    payload: {
      schemaCode: 1,
      channelCode: CHANNEL_CODE[input.channel],
      sensitivityCode: 1,
      historyEligible: true,
      text: redacted as unknown as Record<string, unknown>,
    } as never,
  });

  await dependencies.events.append({
    envelope,
    scope: "conversation.turn",
    key: input.turnKey,
    requestHash: await sha256Hex(`${input.turnKey}:${eventType}`),
  });
  return true;
}

/**
 * The one reading of a conversation payload's `historyEligible` flag, shared by
 * every reader of Jarvis's call replies (`conversation.assistant_sent`).
 *
 * Call replies are history (#198). Every call reply stored before that carries
 * `historyEligible: false`, which recorded the old "a spoken reply is not recall
 * history" policy and says nothing about the text. So for `assistant_sent` the
 * flag is a legacy field: either boolean is admitted, and no reader derives any
 * behaviour from its value. Every other event type keeps the strict `true`.
 *
 * Why one function. Before this, literal history and recent context admitted
 * either value while the spoken-reply reader (`readVoiceReplyPayload`, used by
 * call grounding and by the Telegram retriever's forgotten-turn filter) required
 * `false`. Flipping the writer to `true`, as plan #122 section 3.3 proposed,
 * would then have silently broken Telegram recall with
 * `telegram_memory_suppression_invalid`. With one predicate the readers cannot
 * drift apart again.
 */
export const CALL_REPLY_EVENT_TYPE = "conversation.assistant_sent";

export function admitsHistoryEligible(eventType: string, historyEligible: unknown): boolean {
  return eventType === CALL_REPLY_EVENT_TYPE
    ? typeof historyEligible === "boolean"
    : historyEligible === true;
}

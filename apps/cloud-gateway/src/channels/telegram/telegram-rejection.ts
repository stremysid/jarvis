/**
 * Deterministic, minimal rejections.
 *
 * A rejection is persisted as an event, so its payload is the one place where
 * declined content could leak into the permanent record. The payload is built
 * from exactly two primitives -- the update id and a fixed reason -- so there
 * is no path by which a file id, caption, or media descriptor can reach it.
 * That is a structural guarantee, not a filtering one.
 *
 * The reply text is fixed per reason so a sender learns nothing from the
 * wording about why one message was refused and another accepted.
 */

import type { TelegramRejectionReason } from "./telegram-types.js";

export interface TelegramRejectionPayload {
  readonly updateId: number;
  readonly reason: TelegramRejectionReason;
}

const REPLIES: Readonly<Record<TelegramRejectionReason, string>> = Object.freeze({
  malformed: "Jarvis accepts text messages only.",
  unsupported_content: "Jarvis accepts text messages only.",
  message_too_large: "That message is too long for Jarvis to accept.",
  unauthorized: "Jarvis accepts text messages only.",
  rate_limited: "Jarvis is at its message limit right now. Try again shortly.",
});

/**
 * Build the event payload for a rejected update.
 *
 * Takes primitives rather than the update, so the original body is not in
 * scope here and cannot be copied into the payload by mistake.
 */
export function buildRejectionPayload(
  updateId: number,
  reason: TelegramRejectionReason,
): TelegramRejectionPayload {
  return Object.freeze({ updateId, reason });
}

/**
 * The reply sent back to Telegram.
 *
 * Unauthorized and malformed share the neutral wording deliberately: an
 * unallowlisted sender must not be able to tell that they are unallowlisted,
 * only that Jarvis does not answer them.
 */
export function rejectionReply(reason: TelegramRejectionReason): string {
  return REPLIES[reason];
}

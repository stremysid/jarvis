import type { Ulid } from "../../../../../packages/contracts/src/index.js";
import type { TelegramInlineKeyboardMarkup } from "../../decisions/telegram-keyboard.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const MAX_PENDING_TURNS = 256;

export interface PendingTelegramReplyMarkup {
  readonly decisionId: Ulid;
  readonly replyMarkup: TelegramInlineKeyboardMarkup;
}

const pending = new Map<Ulid, PendingTelegramReplyMarkup>();

/** Carries one already validated keyboard into the durable assistant outbox item. */
export function recordPendingTelegramReplyMarkup(
  turnId: Ulid,
  value: PendingTelegramReplyMarkup,
): void {
  if (!ULID.test(turnId) || !ULID.test(value.decisionId)) {
    throw new TypeError("telegram_reply_markup_invalid");
  }
  if (!pending.has(turnId) && pending.size >= MAX_PENDING_TURNS) {
    const oldest = pending.keys().next().value as Ulid | undefined;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(turnId, Object.freeze({
    decisionId: value.decisionId,
    replyMarkup: value.replyMarkup,
  }));
}

export function takePendingTelegramReplyMarkup(turnId: Ulid): PendingTelegramReplyMarkup | null {
  const value = pending.get(turnId) ?? null;
  pending.delete(turnId);
  return value;
}

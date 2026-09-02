/**
 * Telegram ingress types and update classification.
 *
 * Jarvis accepts text and nothing else. The classifier therefore reads only
 * the handful of fields it needs and copies nothing else forward: a rejected
 * update must leave no trace of the media that caused it -- no file id, no
 * caption, no dimensions -- because that metadata is content we declined to
 * ingest and have no authority to retain.
 */

const encoder = new TextEncoder();

/** Foundation default: 32 KiB of UTF-8 per accepted message. */
export const MAX_TEXT_BYTES = 32_768;

export type TelegramRejectionReason =
  | "malformed"
  | "unsupported_content"
  | "message_too_large"
  | "unauthorized"
  | "rate_limited";

export interface AcceptedTelegramText {
  readonly updateId: number;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly messageId: number;
  readonly text: string;
}

export type TelegramClassification =
  | { readonly kind: "text"; readonly value: AcceptedTelegramText }
  | { readonly kind: "rejected"; readonly updateId: number; readonly reason: TelegramRejectionReason };

/**
 * Any of these makes an update non-text, whether or not `text` is also set.
 * Listed explicitly rather than inferred, so a new Telegram attachment type
 * is rejected as unknown content rather than quietly accepted.
 */
const ATTACHMENT_KEYS = [
  "photo", "document", "audio", "video", "voice", "video_note", "animation",
  "sticker", "contact", "location", "venue", "poll", "dice", "game", "invoice",
  "successful_payment", "story", "paid_media", "caption",
] as const;

/** Update ids and message ids are positive integers; ids are decimal strings. */
const PROVIDER_SUBJECT = /^[1-9]\d{0,19}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Telegram sends numeric ids; normalise to a decimal string without precision loss. */
function subjectId(value: unknown): string | null {
  if (typeof value === "string") return PROVIDER_SUBJECT.test(value) ? value : null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  const rendered = String(value);
  return PROVIDER_SUBJECT.test(rendered) ? rendered : null;
}

/** Chat ids may be negative for groups, so they are not PROVIDER_SUBJECT. */
function chatId(value: unknown): string | null {
  if (typeof value === "string") return /^-?[1-9]\d{0,19}$/u.test(value) ? value : null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) return null;
  return String(value);
}

function wellFormedText(value: unknown): string | null {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  const normalized = value.normalize("NFC");
  if (normalized.length === 0) return null;
  return normalized;
}

/**
 * Classify one raw webhook body.
 *
 * Returns only what an accepted text update needs, or an update id and a
 * reason. Nothing else from the payload survives this function.
 */
export function classifyTelegramUpdate(raw: unknown): TelegramClassification {
  if (!isPlainObject(raw)) return { kind: "rejected", updateId: 0, reason: "malformed" };

  const updateId = positiveInteger(raw.update_id);
  if (updateId === null) return { kind: "rejected", updateId: 0, reason: "malformed" };

  // Only `message` is handled. edited_message, channel_post, callback_query and
  // the rest are content Jarvis does not accept, not errors.
  const message = raw.message;
  if (!isPlainObject(message)) return { kind: "rejected", updateId, reason: "unsupported_content" };

  const from = message.from;
  const chat = message.chat;
  if (!isPlainObject(from) || !isPlainObject(chat)) {
    return { kind: "rejected", updateId, reason: "malformed" };
  }

  const telegramUserId = subjectId(from.id);
  const resolvedChatId = chatId(chat.id);
  const messageId = positiveInteger(message.message_id);
  if (telegramUserId === null || resolvedChatId === null || messageId === null) {
    return { kind: "rejected", updateId, reason: "malformed" };
  }

  // Text must be the ONLY content. Checking for `text` alone is not enough:
  // Telegram permits an attachment alongside it, and ingesting the text while
  // silently dropping the attachment would misrepresent what was sent.
  if (ATTACHMENT_KEYS.some((key) => key in message)) {
    return { kind: "rejected", updateId, reason: "unsupported_content" };
  }
  if (!("text" in message)) return { kind: "rejected", updateId, reason: "unsupported_content" };
  const text = wellFormedText(message.text);
  if (text === null) return { kind: "rejected", updateId, reason: "unsupported_content" };
  if (encoder.encode(text).byteLength > MAX_TEXT_BYTES) {
    return { kind: "rejected", updateId, reason: "message_too_large" };
  }

  return {
    kind: "text",
    value: Object.freeze({ updateId, telegramUserId, chatId: resolvedChatId, messageId, text }),
  };
}

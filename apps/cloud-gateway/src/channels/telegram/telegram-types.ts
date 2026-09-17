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
  /** False when Telegram identifies the text as forwarded or externally borrowed. */
  readonly isDirectText: boolean;
  /** True only for a human-authored message in the sender's private chat. */
  readonly isPrivateHumanText: boolean;
  /** Narrower authority used only by plain-speech memory controls. */
  readonly isMemoryControlAuthoritative: boolean;
}

/**
 * A tap on an inline-keyboard button.
 *
 * Carried separately from text rather than flattened into it, because the two
 * differ in what they authorise. Text is a message to answer; a tap is an
 * answer to a question Jarvis asked, and it resolves a decision. Collapsing
 * them would let a typed message that happened to look like callback data
 * resolve a decision, which is precisely the confusion the decision queue's
 * append-only response row exists to prevent.
 *
 * `data` is untrusted: it is whatever arrived in the update, bounded but not
 * yet parsed. Only `parseDecisionCallbackData` decides whether it means
 * anything.
 */
export interface AcceptedTelegramCallback {
  readonly updateId: number;
  readonly telegramUserId: string;
  readonly chatId: string;
  /** Telegram requires this to be answered, or the client spins. */
  readonly callbackQueryId: string;
  /** The message carrying the keyboard, so the reply can edit it. */
  readonly messageId: number;
  readonly data: string;
}

/** Callback data is capped at 64 bytes by Telegram; anything longer is not ours. */
export const MAX_CALLBACK_DATA_BYTES = 64;

export type TelegramClassification =
  | { readonly kind: "text"; readonly value: AcceptedTelegramText }
  | { readonly kind: "callback"; readonly value: AcceptedTelegramCallback }
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

const BORROWED_TEXT_KEYS = [
  "forward_origin", "forward_from", "forward_from_chat", "forward_sender_name",
  "forward_date", "is_automatic_forward", "external_reply", "via_bot",
] as const;
const QUOTED_TEXT_KEYS = ["quote"] as const;
const UNTRUSTED_CONTROL_ENTITY_TYPES = new Set([
  "blockquote", "expandable_blockquote", "code", "pre",
]);

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

function containsQuotedOrPastedControlContent(message: Record<string, unknown>, text: string): boolean {
  if (QUOTED_TEXT_KEYS.some((key) => key in message) || /[\r\n\v\f\u0085\u2028\u2029]/u.test(text)) return true;
  if ("reply_to_message" in message) {
    const replied = message.reply_to_message;
    const from = isPlainObject(replied) ? replied.from : null;
    // In a private bot chat, a Telegram reply to the bot is the UI's durable
    // pointer to Jarvis's question. The agent still verifies the exact prior
    // delivered question before a confirmed memory can be stored.
    if (!isPlainObject(from) || from.is_bot !== true) return true;
  }
  if (!("entities" in message)) return false;
  const entities = message.entities;
  if (!Array.isArray(entities)) return true;
  return entities.some((entity) => {
    if (!isPlainObject(entity) || typeof entity.type !== "string") return true;
    return UNTRUSTED_CONTROL_ENTITY_TYPES.has(entity.type);
  });
}

/**
 * Classify a callback_query, or reject it.
 *
 * Deliberately narrow. A tap resolves a decision, so the fields that decide
 * WHOSE tap it was and WHICH question it answers are the only ones read, and
 * nothing else survives -- not the keyboard, not the message text the button
 * was attached to, not `chat_instance`.
 *
 * `game_short_name` is a callback that is not a button tap at all. Accepting
 * it would hand a value to the decision parser that never came from a
 * keyboard Jarvis built.
 */
function classifyCallbackQuery(raw: unknown, updateId: number): TelegramClassification {
  if (!isPlainObject(raw)) return { kind: "rejected", updateId, reason: "malformed" };
  if ("game_short_name" in raw) return { kind: "rejected", updateId, reason: "unsupported_content" };

  const from = raw.from;
  if (!isPlainObject(from)) return { kind: "rejected", updateId, reason: "malformed" };
  const telegramUserId = subjectId(from.id);

  // The id Telegram wants answered. Without it the sender's client shows a
  // spinner until it times out, so an unanswerable callback is not something
  // to accept and quietly drop.
  const callbackQueryId = typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 64
    ? raw.id
    : null;

  // The message the keyboard is attached to. Absent when it is too old for
  // Telegram to still have it, in which case the tap cannot be acted on --
  // there is nothing to edit and no chat to answer in.
  const message = raw.message;
  if (!isPlainObject(message)) return { kind: "rejected", updateId, reason: "unsupported_content" };
  const chat = message.chat;
  if (!isPlainObject(chat)) return { kind: "rejected", updateId, reason: "malformed" };
  const resolvedChatId = chatId(chat.id);
  const messageId = positiveInteger(message.message_id);

  if (telegramUserId === null || callbackQueryId === null || resolvedChatId === null || messageId === null) {
    return { kind: "rejected", updateId, reason: "malformed" };
  }

  const data = raw.data;
  if (typeof data !== "string" || !data.isWellFormed() || data.length === 0) {
    return { kind: "rejected", updateId, reason: "unsupported_content" };
  }
  // Telegram's own cap. Longer than this did not come from a keyboard
  // Telegram accepted from us, so it is not a tap on one of our buttons.
  if (encoder.encode(data).byteLength > MAX_CALLBACK_DATA_BYTES) {
    return { kind: "rejected", updateId, reason: "unsupported_content" };
  }

  return {
    kind: "callback",
    value: Object.freeze({
      updateId,
      telegramUserId,
      chatId: resolvedChatId,
      callbackQueryId,
      messageId,
      data,
    }),
  };
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

  // A tap on a decision button. Handled before `message` because a
  // callback_query update carries no top-level `message` of its own -- the
  // message it names is the one the keyboard is attached to.
  if ("callback_query" in raw) return classifyCallbackQuery(raw.callback_query, updateId);

  // Only `message` and `callback_query` are handled. edited_message,
  // channel_post and the rest are content Jarvis does not accept, not errors.
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

  const isDirectText = !BORROWED_TEXT_KEYS.some((key) => key in message);
  const privateHumanText = (chat.type === "private"
    || chat.type === undefined && resolvedChatId === telegramUserId)
    && from.is_bot !== true;
  const isDirectOwnerText = privateHumanText && isDirectText
    && !containsQuotedOrPastedControlContent(message, text);
  return {
    kind: "text",
    value: Object.freeze({
      updateId,
      telegramUserId,
      chatId: resolvedChatId,
      messageId,
      text,
      isDirectText,
      isPrivateHumanText: privateHumanText,
      isMemoryControlAuthoritative: isDirectOwnerText,
    }),
  };
}

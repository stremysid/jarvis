/**
 * The owner's side of a decision: an inline keyboard, and the tap that comes back.
 *
 * Telegram allows at most 64 bytes of callback data per button, and it is the
 * only thing that returns with the tap -- there is no room for the question,
 * the origin, or anything else the queue knows. So the encoding carries the
 * two identifiers that let the item be found again and nothing more, and it is
 * bounded by construction rather than by hoping the pieces stay short:
 *
 *   d1:<26-character ULID>:<option key, at most 32 characters>
 *
 * That is 3 + 26 + 1 + 32 = 62 bytes at its longest, because the schema caps
 * `decision_options.option_key` at 32 characters and the option-key alphabet
 * is one byte per character. The scheme prefix is versioned so a later format
 * is a different prefix rather than a string that both parsers half-recognise.
 *
 * Parsing is a total function over untrusted input: a callback that does not
 * match this grammar exactly is rejected, never repaired. The data arrives
 * from an update anyone can send, and a parser that guessed at a missing field
 * would be guessing which of the owner's questions to answer.
 */

import {
  EXPLAIN_OPTION_KEY,
  FREE_TEXT_OPTION_KEY,
  type DecisionItem,
} from "./decision-types.js";

/** Telegram's own limit on `callback_data`, in bytes of UTF-8. */
export const MAX_CALLBACK_DATA_BYTES = 64;

export const DECISION_CALLBACK_SCHEME = "d1";

/**
 * The ULID and option-key shapes are spelled out here rather than composed
 * from the shared constants: this grammar is what a Telegram client will send
 * back weeks after the keyboard was built, so it is pinned literally and any
 * change to it is visible as a change to this line.
 */
const CALLBACK_DATA = /^d1:([0-7][0-9a-hjkmnp-tv-z]{25}):([a-z0-9_-]{1,32})$/u;

const encoder = new TextEncoder();

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

export interface DecisionCallback {
  readonly decisionId: string;
  readonly optionKey: string;
}

/**
 * Reject anything that is not exactly this grammar.
 *
 * Returned rather than thrown because malformed callback data is an ordinary
 * event on a public webhook -- a stale keyboard, another feature's buttons,
 * somebody probing -- and not a fault in this process.
 */
export function parseDecisionCallbackData(data: unknown): DecisionCallback | null {
  if (typeof data !== "string") return null;
  const match = CALLBACK_DATA.exec(data);
  if (match === null) return null;
  const decisionId = match[1];
  const optionKey = match[2];
  if (decisionId === undefined || optionKey === undefined) return null;
  return Object.freeze({ decisionId, optionKey });
}

/**
 * Build the callback data for one button, or refuse to.
 *
 * The byte cap is checked on the finished string rather than argued from the
 * lengths of its parts, so a future id format that no longer fits is caught
 * here -- where the failure is one unbuilt button -- rather than by Telegram,
 * where the whole message is rejected and the question is never asked at all.
 */
export function encodeDecisionCallbackData(decisionId: string, optionKey: string): string {
  const data = `${DECISION_CALLBACK_SCHEME}:${decisionId}:${optionKey}`;
  if (encoder.encode(data).byteLength > MAX_CALLBACK_DATA_BYTES || parseDecisionCallbackData(data) === null) {
    throw new TypeError("decision_callback_data_invalid");
  }
  return data;
}

/**
 * One button per row.
 *
 * Telegram lays several buttons across a row by squeezing their labels, and
 * these labels are sentences rather than words. A question that has to be read
 * twice on a phone is one the owner defers, which is the failure this whole
 * queue exists to prevent.
 *
 * The escapes are required here as well as added by the service. This is the
 * last point before the owner sees the message, and it is the only one that
 * sees the item as it will actually be rendered: an item that reached here
 * without a way out -- composed by hand, edited in storage, read back from a
 * row someone else wrote -- must not go out as a forced pick.
 */
export function buildDecisionKeyboard(item: DecisionItem): TelegramInlineKeyboardMarkup {
  const ordered = [...item.options].sort((left, right) => left.ordinal - right.ordinal);
  if (!ordered.some((option) => option.kind === "free_text" && option.optionKey === FREE_TEXT_OPTION_KEY)
    || !ordered.some((option) => option.kind === "explain" && option.optionKey === EXPLAIN_OPTION_KEY)) {
    throw new TypeError("decision_keyboard_missing_escape");
  }
  const rows = ordered.map((option) => Object.freeze([Object.freeze({
    text: option.label,
    callback_data: encodeDecisionCallbackData(item.decisionId, option.optionKey),
  })]));
  return Object.freeze({ inline_keyboard: Object.freeze(rows) });
}

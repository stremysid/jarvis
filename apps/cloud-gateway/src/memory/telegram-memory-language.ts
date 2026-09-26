const CONTROL_OR_QUOTE_MARKERS = /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const OUTER_QUOTE = /^(?:[>"'`]|\u201c|\u2018|\u00ab)/u;

function plainCurrentTurn(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || CONTROL_OR_QUOTE_MARKERS.test(value)
    || OUTER_QUOTE.test(value)) return null;
  const trimmed = value.trim();
  return trimmed === value && trimmed.length <= 4_096 ? trimmed : null;
}

/** The named area after a whole-question form; path components use `>` only. */
export function parseTelegramMemoryAreaQuestion(value: unknown): readonly string[] | null {
  const text = plainCurrentTurn(value);
  if (text === null) return null;
  const match = /^(?:what[ \t]+do[ \t]+you|tell[ \t]+me[ \t]+what[ \t]+you)[ \t]+remember[ \t]+about[ \t]+(.+?)[?]?$/iu.exec(text);
  if (match === null) return null;
  const area = match[1]?.trim();
  if (area === undefined || area.length === 0) return null;
  const parts = area.split(/[ \t]*>[ \t]*/u).map((part) => part.trim());
  if (parts.length === 0 || parts.length > 63 || parts.some((part) => part.length === 0)) return null;
  return Object.freeze(["Memory", ...parts]);
}

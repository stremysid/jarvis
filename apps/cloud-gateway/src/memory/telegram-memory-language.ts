export type TelegramMemoryControl =
  | Readonly<{ intent: "remember"; memoryText: string }>
  | Readonly<{ intent: "forget" | "lift" | "explain"; targetQuery: string | null }>;

const REMEMBER_PREFIXES = [
  /^(?:please[ \t]+)?remember(?:[ \t]*,[ \t]*|[ \t]+)that:[ \t]*/iu,
  /^(?:please[ \t]+)?remember(?:[ \t]*,[ \t]*|[ \t]+)that[ \t]+/iu,
  /^(?:please[ \t]+)?remember:[ \t]*/iu,
  /^(?:please[ \t]+)?remember(?:[ \t]*,[ \t]*|[ \t]+)/iu,
] as const;
const CONTROL_OR_QUOTE_MARKERS = /[\r\n\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const OUTER_QUOTE = /^(?:[>"'`]|\u201c|\u2018|\u00ab)/u;

function plainCurrentTurn(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value !== value.normalize("NFC") || CONTROL_OR_QUOTE_MARKERS.test(value)
    || OUTER_QUOTE.test(value)) return null;
  const trimmed = value.trim();
  return trimmed === value && trimmed.length <= 4_096 ? trimmed : null;
}

function target(match: RegExpExecArray): string | null {
  const value = match[1]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * Recognises only a whole, single-line owner utterance. Embedded examples,
 * quoted blocks and pasted multi-line material remain conversation data.
 */
export function parseTelegramMemoryControl(value: unknown): TelegramMemoryControl | null {
  const text = plainCurrentTurn(value);
  if (text === null || text.startsWith("/")) return null;

  for (const prefix of REMEMBER_PREFIXES) {
    const match = prefix.exec(text);
    if (match === null) continue;
    const memoryText = text.slice(match[0].length).trim();
    return memoryText.length === 0 ? null : Object.freeze({ intent: "remember", memoryText });
  }

  let match = /^(?:please[ \t]+)?forget[ \t]+(?:that|this)[ \t]+memory[.!?]?$/iu.exec(text);
  if (match !== null) return Object.freeze({ intent: "forget", targetQuery: null });
  match = /^(?:please[ \t]+)?forget[ \t]+(?:the[ \t]+)?memory[ \t]+(?:about|that[ \t]+says)[ \t]+(.+?)[.!?]?$/iu.exec(text);
  if (match !== null) return Object.freeze({ intent: "forget", targetQuery: target(match) });

  match = /^(?:please[ \t]+)?use[ \t]+(?:that|this)[ \t]+memory[ \t]+again[.!?]?$/iu.exec(text);
  if (match !== null) return Object.freeze({ intent: "lift", targetQuery: null });
  match = /^(?:please[ \t]+)?use[ \t]+(?:the[ \t]+)?memory[ \t]+(?:about|that[ \t]+says)[ \t]+(.+?)[ \t]+again[.!?]?$/iu.exec(text);
  if (match !== null) return Object.freeze({ intent: "lift", targetQuery: target(match) });

  if (/^why[ \t]+do[ \t]+you[ \t]+think[ \t]+that\?$/iu.test(text)) {
    return Object.freeze({ intent: "explain", targetQuery: null });
  }
  match = /^why[ \t]+do[ \t]+you[ \t]+remember[ \t]+(?:that[ \t]+)?(.+?)\?$/iu.exec(text);
  if (match !== null) return Object.freeze({ intent: "explain", targetQuery: target(match) });
  return null;
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

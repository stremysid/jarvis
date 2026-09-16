
export type MemoryFactState = "proposed" | "active" | "superseded";

export interface FirstPersonQuoteInput {
  readonly quote: string;
  readonly sourceText: string;
  readonly authenticatedOwner: boolean;
}

export interface AutomaticPromotionInput {
  readonly origin: MemoryFactOriginV1;
  readonly currentState: MemoryFactState;
}

export interface AutomaticPromotionDecision {
  readonly state: MemoryFactState;
  readonly uncertain: boolean;
  /** Automatic promotion is evidence classification, never owner confirmation. */
  readonly confirmed: false;
}

export interface ValidatedExtractionProposal {
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly confidence: number;
  readonly sensitivity: MemoryFactSensitivityV1;
  /** Untrusted extraction output always enters through the model boundary. */
  readonly origin: "model";
  readonly uncertain: true;
}

const AUTO_PROMOTABLE_ORIGINS: ReadonlySet<MemoryFactOriginV1> = new Set([
  "authenticated_first_person",
  "deterministic_observation",
]);

const FORBIDDEN_PROPOSAL_KEYS = new Set([
  "tool",
  "tool_call",
  "function",
  "function_call",
  "action",
  "command",
  "state",
]);

const FIRST_PERSON_TOKEN = /(?<![A-Za-z0-9_])(?:i(?:['’](?:m|ve|d|ll))?|me|my|mine|myself)(?![A-Za-z0-9_])/iu;
const FIRST_PERSON_UNTRUSTED_FRAMING = [
  /(?<![A-Za-z0-9_])(?:if|unless|whether|when)(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])(?:maybe|might|probably|perhaps|could)(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])would(?!\s+(?:like|love|prefer|rather)(?![A-Za-z0-9_]))(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])i['’]d(?!\s+(?:like|love|prefer|rather)(?![A-Za-z0-9_]))(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])i\s+(?:think|guess|suppose)(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])i\s+(?:do\s+not|don['’]t)\s+know(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])not\s+sure(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])(?:says|said|told)(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])(?:not|never)(?![A-Za-z0-9_])/iu,
  /n['’]t(?![A-Za-z0-9_])/iu,
] as const;
const SENTENCE_PUNCTUATION: ReadonlySet<string> = new Set([".", "!", "?"]);
const ASCII_WHITESPACE = new Set([" ", "\t", "\r", "\n", "\f", "\v"]);
// Unknown interior periods fail closed to model/uncertain; this small list
// preserves ordinary owner statements such as "I am renovating St. Remy."
const PERIOD_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "dr",
  "jr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sr",
  "st",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function previousNonWhitespace(text: string, offset: number): number {
  let index = offset - 1;
  while (index >= 0 && ASCII_WHITESPACE.has(text[index] ?? "")) index -= 1;
  return index;
}

function isAllowedInteriorPeriod(text: string, offset: number): boolean {
  const previous = text[offset - 1];
  const next = text[offset + 1];
  if (previous !== undefined && next !== undefined && /\d/u.test(previous) && /\d/u.test(next)) {
    return true;
  }
  const precedingWord = /([A-Za-z]+)$/u.exec(text.slice(0, offset))?.[1];
  return precedingWord !== undefined && PERIOD_ABBREVIATIONS.has(precedingWord.toLowerCase());
}

function containsSecondSentence(quote: string, quoteHasTerminator: boolean): boolean {
  const bodyEnd = quoteHasTerminator ? quote.length - 1 : quote.length;
  for (let offset = 0; offset < bodyEnd; offset += 1) {
    const character = quote[offset];
    if (character === "!" || character === "?") return true;
    if (character === "." && !isAllowedInteriorPeriod(quote, offset)) return true;
  }
  return false;
}

function wholeSentenceMatch(sourceText: string, quote: string, offset: number): boolean {
  const end = offset + quote.length;
  const before = previousNonWhitespace(sourceText, offset);
  if (before >= 0 && !SENTENCE_PUNCTUATION.has(sourceText[before] ?? "")) return false;

  const immediateBefore = sourceText[offset - 1];
  const immediateAfter = sourceText[end];
  if (immediateBefore !== undefined && /[A-Za-z0-9_]/u.test(immediateBefore)) return false;
  if (immediateAfter !== undefined && /[A-Za-z0-9_]/u.test(immediateAfter)) return false;

  const quoteTerminator = quote.at(-1);
  let terminator: string | undefined;
  if (quoteTerminator !== undefined && SENTENCE_PUNCTUATION.has(quoteTerminator)) {
    terminator = quoteTerminator;
    if (immediateAfter !== undefined && !ASCII_WHITESPACE.has(immediateAfter)) return false;
  } else if (immediateAfter === undefined) {
    terminator = undefined;
  } else if (SENTENCE_PUNCTUATION.has(immediateAfter)) {
    terminator = immediateAfter;
  } else {
    return false;
  }

  if (containsSecondSentence(quote, quoteTerminator !== undefined
    && SENTENCE_PUNCTUATION.has(quoteTerminator))) return false;
  if (terminator === "?" || quote.includes("?")) return false;
  return !FIRST_PERSON_UNTRUSTED_FRAMING.some((pattern) => pattern.test(quote));
}

/**
 * Classify only one complete, unframed sentence that is both verbatim and
 * attributable to the owner. A model paraphrase, question, conditional,
 * hedge, negation, or report of speech cannot manufacture the trusted origin.
 */
export function isAuthenticatedFirstPersonQuote(input: FirstPersonQuoteInput): boolean {
  if (!input.authenticatedOwner) return false;
  const quote = input.quote.normalize("NFC").replace(/^ +| +$/gu, "");
  const sourceText = input.sourceText.normalize("NFC");
  if (quote.length === 0 || hasFactTextControls(quote)) return false;
  if (!FIRST_PERSON_TOKEN.test(quote)) return false;

  let offset = sourceText.indexOf(quote);
  while (offset !== -1) {
    if (wholeSentenceMatch(sourceText, quote, offset)) return true;
    offset = sourceText.indexOf(quote, offset + 1);
  }
  return false;
}

/** Apply the same closed promotion allowlist as the Python local agent. */
export function decideAutomaticPromotion(
  input: AutomaticPromotionInput,
): AutomaticPromotionDecision {
  const state = input.currentState !== "proposed"
    ? input.currentState
    : AUTO_PROMOTABLE_ORIGINS.has(input.origin)
      ? "active"
      : "proposed";

  return Object.freeze({
    state,
    uncertain: input.origin === "model",
    confirmed: false,
  });
}

/**
 * Validate one untrusted extraction result.
 *
 * The model may suggest wording and sources, but it cannot set its own origin,
 * certainty, or lifecycle state. Those fields are assigned at this boundary.
 */
export function validateExtractionProposal(
  value: unknown,
  supplied: ReadonlySet<string>,
): ValidatedExtractionProposal | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => FORBIDDEN_PROPOSAL_KEYS.has(key))) return null;

  const { text, sourceEventIds, confidence } = value;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  if (new TextEncoder().encode(text).byteLength > MAX_MEMORY_FACT_BYTES) return null;
  if (hasFactTextControls(text)) return null;
  const checked = sanitizeRedaction(text);
  if (!checked.ok || checked.text !== text) return null;

  if (!Array.isArray(sourceEventIds)
    || sourceEventIds.length === 0
    || sourceEventIds.length > MAX_MEMORY_FACT_SOURCES) return null;
  if (sourceEventIds.some((id) => typeof id !== "string" || !supplied.has(id))) return null;

  const score = confidence === undefined ? 1 : confidence;
  if (typeof score !== "number"
    || !Number.isFinite(score)
    || score < 0
    || score > 1) return null;

  return Object.freeze({
    text: text.trim(),
    sourceEventIds: Object.freeze([...(sourceEventIds as string[])]),
    confidence: score,
    sensitivity: value.sensitivity === "sensitive" ? "sensitive" : "normal",
    origin: "model",
    uncertain: true,
  });
}

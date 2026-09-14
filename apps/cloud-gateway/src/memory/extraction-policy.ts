import { sanitizeRedaction } from "../../../../packages/contracts/src/calls.js";
import {
  hasFactTextControls,
  MAX_MEMORY_FACT_BYTES,
  MAX_MEMORY_FACT_SOURCES,
  type MemoryFactOriginV1,
  type MemoryFactSensitivityV1,
} from "../../../../packages/contracts/src/memory-projection.js";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Classify only evidence that is both verbatim and attributable to the owner.
 * A model paraphrase cannot manufacture the trusted origin.
 */
export function isAuthenticatedFirstPersonQuote(input: FirstPersonQuoteInput): boolean {
  if (!input.authenticatedOwner) return false;
  const quote = input.quote.normalize("NFC").replace(/^ +| +$/gu, "");
  const sourceText = input.sourceText.normalize("NFC");
  if (quote.length === 0 || hasFactTextControls(quote)) return false;
  return sourceText.includes(quote) && FIRST_PERSON_TOKEN.test(quote);
}

/** Apply the same closed promotion allowlist as the Python local agent. */
export function decideAutomaticPromotion(
  input: AutomaticPromotionInput,
): AutomaticPromotionDecision {
  const state = input.currentState === "superseded"
    ? "superseded"
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

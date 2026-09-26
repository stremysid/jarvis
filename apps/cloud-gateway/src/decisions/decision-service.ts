import { newUlid } from "../../../../packages/contracts/src/index.js";
import {
  DECISION_OPTION_KEY,
  EXPLAIN_OPTION_KEY,
  EXPLAIN_OPTION_LABEL,
  FREE_TEXT_OPTION_KEY,
  FREE_TEXT_OPTION_LABEL,
  MAX_DECISION_CHOICES,
  RESERVED_OPTION_KEYS,
  type AnswerDecisionInput,
  type AnswerDecisionResult,
  type DecisionItem,
  type DecisionOption,
  type DecisionRepositoryContract,
  type RaiseDecisionInput,
} from "./decision-types.js";

/**
 * The queue's rules, above the rules the schema already keeps.
 *
 * The division is deliberate. This service validates the shape of what it is
 * handed -- lengths, alphabets, required fields, keys that collide with a
 * reserved one -- so a malformed call fails at the call site with a name for
 * what was wrong. It does not restate the schema's state rules: whether an
 * item was already answered, whether an option belongs to it, whether a
 * resolved item can be reopened. Those describe things the owner and the
 * subsystems really do, the database refuses them structurally, and a second
 * copy of the rule here would eventually disagree with the first.
 *
 * SQLite's length() counts characters rather than bytes, so every cap below is
 * in characters and lines up exactly with the CHECK it shadows. Changing one to
 * bytes would let a call pass here and fail in SQL, or the reverse.
 */

const MAX_IDENTIFIER_CHARACTERS = 256;
const MAX_ORIGIN_CHARACTERS = 64;
const MAX_QUESTION_CHARACTERS = 2_048;
const MAX_DETAIL_CHARACTERS = 8_192;
const MAX_LABEL_CHARACTERS = 64;
const MAX_OPTION_KEY_CHARACTERS = 32;
const MAX_FREE_TEXT_CHARACTERS = 4_096;
const MAX_TIMESTAMP_CHARACTERS = 32;

/**
 * Text is normalised on the way in, not merely accepted. Two spellings of the
 * same word would otherwise both be stored, and the later comparison that
 * matters -- did the owner answer this question -- would turn on an encoding
 * nobody chose.
 */
function requiredText(value: unknown, error: string, maxCharacters: number): string {
  if (typeof value !== "string" || !value.isWellFormed()) throw new TypeError(error);
  const normalized = value.normalize("NFC");
  if (normalized.length === 0 || normalized.length > maxCharacters) throw new TypeError(error);
  return normalized;
}

function optionalText(value: unknown, error: string, maxCharacters: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) throw new TypeError(error);
  const normalized = value.normalize("NFC");
  if (normalized.length > maxCharacters) throw new TypeError(error);
  return normalized.length === 0 ? null : normalized;
}

function optionalTimestamp(value: unknown, error: string): string | null {
  const text = optionalText(value, error, MAX_TIMESTAMP_CHARACTERS);
  if (text === null) return null;
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== text) throw new TypeError(error);
  return text;
}

export interface DecisionServiceDependencies {
  readonly repository: DecisionRepositoryContract;
  readonly now?: () => Date;
}

export class DecisionService {
  readonly #repository: DecisionRepositoryContract;
  readonly #clock: () => Date;

  constructor(dependencies: DecisionServiceDependencies) {
    const repository = dependencies?.repository;
    if (repository === null || typeof repository !== "object") throw new TypeError("decision_dependency_invalid");
    const clock = dependencies.now ?? (() => new Date());
    if (typeof clock !== "function") throw new TypeError("decision_dependency_invalid");
    this.#repository = repository;
    this.#clock = clock;
  }

  /**
   * Raise a question, always with a way out of it.
   *
   * The free-text and explain options are appended here rather than asked of
   * the caller, because a caller that forgets them produces a question the
   * owner can only answer wrongly, and nothing downstream can tell that
   * question apart from one whose author genuinely meant to offer three
   * choices. They go last so they never push the real choices off the first
   * screen of a phone.
   */
  async raise(input: RaiseDecisionInput): Promise<DecisionItem> {
    if (input === null || typeof input !== "object") throw new TypeError("decision_raise_input_invalid");
    const now = this.#instant();
    const choices = input.choices ?? [];
    if (!Array.isArray(choices) || choices.length > MAX_DECISION_CHOICES) {
      throw new TypeError("decision_choices_invalid");
    }
    const options: DecisionOption[] = [];
    const seen = new Set<string>();
    for (const choice of choices) {
      const key = requiredText(choice?.key, "decision_choice_key_invalid", MAX_OPTION_KEY_CHARACTERS);
      if (!DECISION_OPTION_KEY.test(key) || seen.has(key)) throw new TypeError("decision_choice_key_invalid");
      // A choice under a reserved key would take the escape's place rather
      // than sit beside it, and the question would lose the escape silently.
      if (RESERVED_OPTION_KEYS.has(key)) throw new TypeError("decision_choice_key_reserved");
      seen.add(key);
      options.push(Object.freeze({
        optionKey: key,
        label: requiredText(choice?.label, "decision_choice_label_invalid", MAX_LABEL_CHARACTERS),
        ordinal: options.length,
        kind: "choice",
      }));
    }
    options.push(Object.freeze({
      optionKey: FREE_TEXT_OPTION_KEY,
      label: FREE_TEXT_OPTION_LABEL,
      ordinal: options.length,
      kind: "free_text",
    }));
    options.push(Object.freeze({
      optionKey: EXPLAIN_OPTION_KEY,
      label: EXPLAIN_OPTION_LABEL,
      ordinal: options.length,
      kind: "explain",
    }));

    const urgency = input.urgency;
    if (urgency !== "urgent" && urgency !== "normal") throw new TypeError("decision_urgency_invalid");
    // Required, never defaulted. The queue orders by rank, so a missing rank
    // would let code choose the owner's priority silently; the caller states it.
    const rank = input.rank;
    if (!Number.isSafeInteger(rank) || rank < 0) throw new TypeError("decision_rank_invalid");

    const decisionId = newUlid(now.date);
    await this.#repository.raise({
      decisionId,
      principalId: requiredText(input.principalId, "decision_principal_invalid", MAX_IDENTIFIER_CHARACTERS),
      origin: requiredText(input.origin, "decision_origin_invalid", MAX_ORIGIN_CHARACTERS),
      originReference: optionalText(input.originReference, "decision_origin_reference_invalid", MAX_IDENTIFIER_CHARACTERS),
      urgency,
      question: requiredText(input.question, "decision_question_invalid", MAX_QUESTION_CHARACTERS),
      detail: optionalText(input.detail, "decision_detail_invalid", MAX_DETAIL_CHARACTERS),
      rank,
      expiresAt: optionalTimestamp(input.expiresAt, "decision_expires_at_invalid"),
      createdAt: now.iso,
      options: Object.freeze(options),
    });
    // Read back rather than return the composed item: what the owner will be
    // shown is what the database holds, and this is the one place the two are
    // cheap to compare.
    const stored = await this.#repository.readItem(decisionId);
    if (stored === null) throw new Error("decision_raise_lost");
    return stored;
  }

  /** Everything still owed an answer, urgent first, then by rank, then oldest first. */
  async queue(principalId: string): Promise<readonly DecisionItem[]> {
    return this.#repository.listOpenQueue({
      principalId: requiredText(principalId, "decision_principal_invalid", MAX_IDENTIFIER_CHARACTERS),
      now: this.#instant().iso,
    });
  }

  /** Records that the owner was actually asked; false if the item was already sent or resolved. */
  async markDelivered(decisionId: string): Promise<boolean> {
    return this.#repository.markDelivered({
      decisionId: requiredText(decisionId, "decision_id_invalid", MAX_IDENTIFIER_CHARACTERS),
      now: this.#instant().iso,
    });
  }

  /**
   * Record the owner's answer and hand back what the blocked origin needs.
   *
   * The identity is taken on trust as authenticated -- this queue is not where
   * a Telegram update is verified -- but it is written onto the response row
   * and checked against the item's principal, so an answer that arrives from
   * somebody else's verified account is refused rather than recorded as the
   * owner's.
   */
  async answer(input: AnswerDecisionInput): Promise<AnswerDecisionResult> {
    if (input === null || typeof input !== "object") throw new TypeError("decision_answer_input_invalid");
    const optionKey = optionalText(input.optionKey, "decision_option_key_invalid", MAX_OPTION_KEY_CHARACTERS);
    const freeText = optionalText(input.freeText, "decision_free_text_invalid", MAX_FREE_TEXT_CHARACTERS);
    // Neither tapped nor typed is not an answer to anything.
    if (optionKey === null && freeText === null) throw new TypeError("decision_answer_empty");
    const now = this.#instant();
    return this.#repository.recordResponse({
      responseId: newUlid(now.date),
      decisionId: requiredText(input.decisionId, "decision_id_invalid", MAX_IDENTIFIER_CHARACTERS),
      answeredByIdentityId: requiredText(
        input.answeredByIdentityId,
        "decision_identity_invalid",
        MAX_IDENTIFIER_CHARACTERS,
      ),
      optionKey,
      freeText,
      now: now.iso,
    });
  }

  /**
   * One reading of the injected clock, in both the forms this module needs.
   * Sampled through Date.prototype so a clock that returns something
   * Date-shaped fails here rather than writing an "Invalid Date" timestamp
   * that no later query can order.
   */
  #instant(): { readonly date: Date; readonly iso: string } {
    const value = this.#clock();
    let epoch: number;
    try { epoch = Date.prototype.getTime.call(value); }
    catch { throw new TypeError("decision_clock_invalid"); }
    if (!Number.isFinite(epoch)) throw new TypeError("decision_clock_invalid");
    const date = new Date(epoch);
    return Object.freeze({ date, iso: date.toISOString() });
  }
}

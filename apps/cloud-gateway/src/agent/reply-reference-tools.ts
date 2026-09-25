import type { ModelFunctionDefinition } from "../providers/provider-types.js";

/**
 * The most memory items one reply may declare as its references.
 *
 * It is the store's own bound (`telegram-memory-reference.ts`), so it is a
 * storage fact rather than a relevance rule: a declaration that runs past it is
 * refused back to the model, never trimmed, because code must not choose which
 * of the model's references survive.
 */
export const MAX_DECLARED_REFERENCES = 8;

export const DECLARE_MEMORY_REFERENCES_TOOL_NAME = "declare_memory_references";

/**
 * The one tool that lets the model say which memories its reply relied on.
 *
 * Which memory a reply is about is the model's judgment, so code does not pick
 * it and does not fall back to recency: a turn whose model never calls this
 * records no references. The description carries the instruction, and code only
 * checks that every id was shown to the model this turn and that the list fits.
 */
export const REPLY_REFERENCE_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  Object.freeze({
    name: DECLARE_MEMORY_REFERENCES_TOOL_NAME,
    description: "Declare which stored memory items your reply relies on, so Sid's later \"forget that\" or \"that's wrong\" reaches them. Call this once, after the memory_search, memory_explain or history_search results you are using and before you answer. Pass the item ids exactly as they appear in this turn's memory results or context. At most eight unique ids, and only ids you were shown this turn. If you do not call it, the turn keeps no memory references and a later \"forget that\" cannot name what you said.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["itemIds"],
      properties: {
        itemIds: Object.freeze({
          type: "array",
          minItems: 1,
          maxItems: MAX_DECLARED_REFERENCES,
          items: Object.freeze({ type: "string" }),
          description: "The memory item ids this reply uses, from this turn's memory results or context. One to eight, with no repeats.",
        }),
      },
    }),
  }),
]);

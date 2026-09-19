import type { ModelFunctionDefinition } from "../providers/provider-types.js";

/**
 * The memory tools, defined once for every channel.
 *
 * These live here rather than in the Telegram adapter because Phase 1's tools
 * landed on Telegram on 2026-09-16 and the voice path was composed on
 * 2026-09-13, and nobody went back: a phone call today can talk and cannot act,
 * with zero tool dispatch under `src/voice`. A tool defined inside a channel
 * adapter is a tool the other channel will not get, so the definition belongs
 * where both can import it and only the *dispatch* is per-channel.
 *
 * The descriptions are the product. `docs/plan/2026-09-19-jarvis-roadmap.md`
 * says most of the "feels like a real person" quality comes from the system
 * prompt and these strings rather than from code, and it asks for three things
 * in each: what the tool does, when it is useful with a short example, and what
 * each input means. None of the six had an example or an input explanation
 * before this, and no parameter carried a `description` at all.
 */
export const MEMORY_TOOL_NAMES = Object.freeze([
  "memory_remember",
  "memory_correct",
  "memory_forget",
  "memory_restore",
  "memory_confirm",
  "memory_explain",
] as const);

export type MemoryToolName = typeof MEMORY_TOOL_NAMES[number];

export const MEMORY_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  Object.freeze({
    name: "memory_remember",
    description: "Remember one fact Sid states now, or one direct answer he gives to your immediately previous offer to note it. Use it the moment he says something that will still be true and useful later. Not for one-off states (\"I'm tired today\"), not for things he asked you to do, and not for anything he is quoting or relaying from somebody else -- \"Mum texted me. I am moving to Calgary\" states nothing about Sid. Example: he says \"I hate mornings\", so you remember that he hates mornings.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["fact", "supportingExcerpt", "evidenceClass", "previousOfferExcerpt", "kind", "sensitivity"],
      properties: {
        fact: { type: "string", minLength: 1, maxLength: 4096, description: "The fact in Sid's own words, one sentence. Do not tidy or summarise his phrasing." },
        supportingExcerpt: { type: "string", minLength: 1, maxLength: 4096, description: "The exact words from Sid's current message that carry the fact. Copied, never paraphrased." },
        evidenceClass: { enum: ["stated", "confirmed"], description: "stated when Sid said it plainly; confirmed only when he is confirming wording you offered first." },
        previousOfferExcerpt: { type: ["string", "null"], maxLength: 4096, description: "The words of your immediately previous offer, when evidenceClass is confirmed. Pass null otherwise." },
        kind: { enum: ["fact", "preference", "plan", "decision", "relationship"], description: "What sort of thing it is about Sid: a fact about him, a preference, a plan, a decision he made, or a relationship." },
        sensitivity: { enum: ["normal", "sensitive"], description: "sensitive for anything you would not repeat in front of someone else." },
      },
    }),
  }),
  Object.freeze({
    name: "memory_correct",
    description: "Replace one memory whose wording is now wrong, when Sid says the thing changed. Example: he once said his favourite subject was chemistry and now says \"actually it's physics\", so you pass the chemistry memory's id and the new wording. The old wording stops being current and stays in the history; it is never overwritten. Do not use memory_remember for a change like this, because that leaves both versions current and neither can be trusted.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["itemId", "newFact", "supportingExcerpt", "kind", "sensitivity"],
      properties: {
        itemId: { type: "string", description: "The id of the memory being replaced, from the item ids in your context." },
        newFact: { type: "string", minLength: 1, maxLength: 4096, description: "The new wording, drawn from Sid's current message." },
        supportingExcerpt: { type: "string", minLength: 1, maxLength: 4096, description: "The exact words from his current message that carry the new wording." },
        kind: { enum: ["fact", "preference", "plan", "decision", "relationship"], description: "What sort of thing it is about Sid." },
        sensitivity: { enum: ["normal", "sensitive"], description: "sensitive for anything you would not repeat in front of someone else." },
      },
    }),
  }),
  Object.freeze({
    name: "memory_forget",
    description: "Stop using a memory and hide the conversation it came from. Use it when Sid says to forget something, or says a fact about him is not true and he does not want it kept. If more than one memory could be meant, pass every candidate id and leave the excerpt out: you will be asked to confirm instead of anything changing. Example: \"forget that I hate mornings\" with the id of that memory.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["itemIds"],
      properties: {
        itemIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" }, description: "One to eight memory ids from your context. Pass all of them when you are not certain which is meant." },
        supportingExcerpt: { type: "string", minLength: 1, maxLength: 4096, description: "Sid's exact words, when one memory is clearly meant. Omit it when you are passing several candidates so he is asked instead." },
      },
    }),
  }),
  Object.freeze({
    name: "memory_restore",
    description: "Bring back a memory that was forgotten, when Sid says he wants it used again. Example: \"actually, do remember that I hate mornings\". It comes back as unconfirmed, so it is not treated as settled until he agrees to it again.",
    parameters: Object.freeze({
      type: "object", additionalProperties: false, required: ["itemId", "supportingExcerpt"],
      properties: {
        itemId: { type: "string", description: "The id of the forgotten memory, from the item ids in your context." },
        supportingExcerpt: { type: "string", minLength: 1, maxLength: 4096, description: "His exact words asking for it back, copied." },
      },
    }),
  }),
  Object.freeze({
    name: "memory_confirm",
    description: "Mark a memory you inferred as confirmed once Sid agrees with the exact stored wording. Example: you proposed \"Sid dislikes long status updates\" and he answers \"yes, that's right\". A guess of yours is never promoted from your own words alone: you show the stored wording and he answers, or he taps the keyboard.",
    parameters: Object.freeze({
      type: "object", additionalProperties: false, required: ["itemId", "supportingExcerpt"],
      properties: {
        itemId: { type: "string", description: "The id of the proposed memory, from the item ids in your context." },
        supportingExcerpt: { type: "string", minLength: 1, maxLength: 4096, description: "His exact confirmation words, copied." },
      },
    }),
  }),
  Object.freeze({
    name: "memory_explain",
    description: "Show where a memory came from: its wording, when it was recorded, and which of Sid's messages it rests on. Use it when he asks how you know something about him. Read-only -- nothing changes. Example: \"why do you think I hate mornings?\"",
    parameters: Object.freeze({
      type: "object", additionalProperties: false, required: ["itemId", "supportingExcerpt"],
      properties: {
        itemId: { type: "string", description: "The id of the memory being asked about, from the item ids in your context." },
        supportingExcerpt: { type: "string", minLength: 1, maxLength: 4096, description: "His exact words asking about it, copied." },
      },
    }),
  }),
]);

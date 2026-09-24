/**
 * Which capability each tool call is an instance of.
 *
 * The tier itself is NOT here and must never be. It lives in `capability_tiers`
 * so that a refactor cannot quietly lower one, and so that every change to one
 * is a schema event somebody reviews. This file only answers "which registered
 * capability is this tool", which is a naming decision that has to live beside
 * the tool definitions.
 *
 * A tool with no entry is not defaulted to anything. It is passed through to
 * `AutonomyService.evaluate` as its own name, which is unregistered, which is
 * denied. Adding a tool without classifying it therefore fails closed and
 * loudly -- the receipt says the capability was never registered -- rather than
 * silently running at a tier nobody chose.
 */

/**
 * The tool names the owner agent can actually dispatch today, each mapped to a
 * registered capability.
 *
 * All nine are tier 1, and that is a deliberate classification rather than a
 * convenient one. The tier registry exists to govern actions that reach
 * *outside* the owner's own authenticated conversation -- device actions,
 * money, third parties, deletion, production -- and the tier-2 exemplars seeded
 * by `0008_autonomy.sql` are all device actions (`write.project_file`,
 * `write.calendar`, `open.application`, `vehicle.precondition`). The roadmap
 * scopes tier-2 shadow gating to "that device". These nine operate only on the
 * owner's own conversational state, are reachable only from his own first-party
 * authenticated turn (enforced upstream in `executeCall`), and are reversible
 * within that store.
 *
 * The consequence of classifying them tier 2 instead: production runs in the
 * shadow mode that `0008_autonomy.sql` seeds, and `decideOutcome` withholds
 * every tier-2 action in shadow. The school, university, study and memory tools
 * Sid is using today would stop executing. A safety change must not disable the
 * features it is protecting, so the honest tier for an owner-requested,
 * owner-scoped, reversible operation is the observing one -- and the owner, not
 * this file, decides if he wants them stricter.
 *
 * Note `memory_forget` is tier 1 and not the tier-3 `delete.data`: forget is
 * hiding by transition and suppression, never erasure, and its own receipt says
 * the original conversation remains retained.
 */
const OWNER_TOOL_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  memory_remember: "memory.write",
  // Correcting a memory supersedes one stored wording with another in the same
  // ledger, so it is a memory write and not a capability of its own. It shares
  // `memory.write`'s tier-1 row, which is why classifying it needed no
  // migration -- and why leaving it out denied a tool the agent dispatches.
  memory_correct: "memory.write",
  memory_forget: "memory.write",
  memory_restore: "memory.write",
  memory_confirm: "memory.write",
  memory_explain: "memory.read",
  // Read-only, and the only memory tool that neither names an item nor knows
  // which one it wants: it asks the index a question. It shares
  // `memory.read`'s tier-1 row with `memory_explain`, so classifying it needed
  // no migration -- and, because `tool-classification.test.ts` derives the
  // dispatchable set from the definitions, leaving it out would have failed a
  // named test rather than silently refusing every search in production.
  memory_search: "memory.read",
  // Pinning changes a stored preference rather than an item's existence, so it is
  // a memory write like the rest and shares `memory.write`'s tier-1 row. That is
  // the whole reason these two needed no migration: `0035` already seeds the tier.
  memory_pin: "memory.write",
  memory_unpin: "memory.write",
  school_update: "school.track",
  university_update: "university.track",
  study_coach: "study.coach",
});

/**
 * Capabilities reserved for the hands the roadmap adds next, mapped from the
 * tool names those hands are expected to expose.
 *
 * These are classified BEFORE the tools exist, which is the whole point: the
 * gate is only a backstop if a new hand inherits a classification rather than
 * arriving unregistered. `email` reaches a third party and is tier 3.
 * `tesla_precondition` is the reversible vehicle action `0008` already seeds as
 * tier 2. `tesla_unlock` moves the car and is tier 3.
 *
 * A model cannot reach any of these through the agent today -- they are absent
 * from `OWNER_TOOL_DEFINITIONS`, so an attempt falls through to the
 * unknown-tool refusal. Listing them here means the tier question is already
 * answered when the tool is finally defined, instead of being answered in a
 * hurry at the same time as the integration.
 */
const RESERVED_TOOL_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  send_email: "contact.third_party",
  tesla_precondition: "vehicle.precondition",
  tesla_unlock: "vehicle.unlock",
});

const TOOL_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  ...OWNER_TOOL_CAPABILITIES,
  ...RESERVED_TOOL_CAPABILITIES,
});

/**
 * The capability a tool call is an instance of, or the tool name itself when
 * nobody has classified it.
 *
 * Returning the raw name is what makes an unclassified tool get denied: the
 * name is not a registry key, so `readCapabilityTier` finds nothing, so the
 * outcome is `denied_unknown_capability`. Inventing a fallback capability here
 * would be the guess this whole design exists to refuse.
 */
export function capabilityForTool(toolName: string): string {
  return TOOL_CAPABILITIES[toolName] ?? toolName;
}

/** Whether a tool has been classified. Exported for the tests and the receipt. */
export function isToolClassified(toolName: string): boolean {
  return Object.hasOwn(TOOL_CAPABILITIES, toolName);
}

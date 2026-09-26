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
 * The original conversational tools are tier 1, a deliberate classification rather than a
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
 * Note `memory_forget` is `memory.write` and not `delete.data`: forget is
 * hiding by transition and suppression, never erasure, and its own receipt says
 * the original conversation remains retained.
 * Collector revocation has its own registry entry because it disables a
 * credential rather than changing conversational state. It is tier 1 since
 * `0051`: it is not one of the five actions Sid wants asked about.
 *
 * Tier 3 -- the tap on Telegram, the PIN on a call -- belongs to exactly five
 * capabilities, one per action Sid named on 2026-09-24: `spend.money`,
 * `send.email`, `place.call`, `submit.school_work` and
 * `contact.third_party`. `five-confirmed-actions.test.ts` pins that set against the
 * migrated database, so mapping a tool here to a capability outside it can
 * never make the tool ask, and adding a sixth tier-3 row fails a named test.
 */
const OWNER_TOOL_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  // Tier 1: reading the inbox changes nothing and reaches nobody. The rows
  // exist so this is a deliberate classification rather than a missing entry,
  // which the gate would deny as an unregistered capability.
  email_inbox_list: "email.read",
  email_inbox_read: "email.read",
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
  // Read-only like memory_search: it searches the owner's own stored
  // conversation and changes nothing, so it shares `memory.read`'s tier-1 row
  // and needs no migration.
  history_search: "memory.read",
  // The model's own declaration of which memories its reply relied on. It
  // selects nothing and changes no memory; it records the turn's reference set,
  // so it shares `memory.read`'s tier-1 row and needs no migration.
  declare_memory_references: "memory.read",
  // Pinning changes a stored preference rather than an item's existence, so it is
  // a memory write like the rest and shares `memory.write`'s tier-1 row. That is
  // the whole reason these two needed no migration: `0035` already seeds the tier.
  memory_pin: "memory.write",
  memory_unpin: "memory.write",
  school_update: "school.track",
  deadline_record: "school.track",
  // Reading Sid's own stored deadlines is owner-scoped and changes nothing, so
  // it shares school.track's tier-1 row and needs no migration.
  deadline_list: "school.track",
  guided_assignment_read: "school.track",
  guided_assignment_save: "school.track",
  guided_assignment_draft: "school.track",
  // Sid deliberately ungated this evidence read: no tier gate and no tap. Direct-text
  // authority still applies. https://github.com/stremysid/jarvis/pull/175#issuecomment-5816467523
  school_d2l_status: "school.track",
  // Read-only raw Classroom evidence for the model's own missing-work judgment.
  // It shares school_d2l_status's ungated tier-1 row: it reads Sid's own
  // school store, changes nothing and reaches nobody.
  school_work_evidence: "school.track",
  school_collector_revoke: "school.collector.revoke",
  reminder_schedule: "notify.owner",
  reminder_list: "notify.owner",
  reminder_cancel: "notify.owner",
  university_update: "university.track",
  study_coach: "study.coach",
  // Reads of the public web. Tier 1 in 0049_web_tools.sql: they send nothing as
  // Sid and change nothing outside the gateway's own receipt table.
  web_read: "read.web",
  web_search: "read.web",
});

/**
 * Capabilities reserved for the hands the roadmap adds next, mapped from the
 * tool names those hands are expected to expose.
 *
 * These are classified BEFORE the tools exist, which is the whole point: the
 * gate is only a backstop if a new hand inherits a classification rather than
 * arriving unregistered. `send_email` is `send.email`, one of Sid's five, so
 * tier 3 whoever it is addressed to. `tesla_precondition` and `tesla_unlock`
 * are the vehicle actions `0008` seeds, both tier 2 since `0051`: neither is
 * one of the five, so neither asks.
 *
 * A model cannot reach any of these through the agent today -- they are absent
 * from `OWNER_TOOL_DEFINITIONS`, so an attempt falls through to the
 * unknown-tool refusal. Listing them here means the tier question is already
 * answered when the tool is finally defined, instead of being answered in a
 * hurry at the same time as the integration.
 */
const RESERVED_TOOL_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  // `send_email` is the sending hand, not the inbox read above. Sending an
  // email is one of Sid's five, so it has its own tier-3 row whoever it is to.
  send_email: "send.email",
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
